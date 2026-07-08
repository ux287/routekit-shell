/**
 * Agent Runner
 *
 * General-purpose agent execution engine that runs inside the MCP server.
 * Agents call tools as local functions (no hooks, no MCP round-trip).
 *
 * Architecture: AD #2 (MCP tool wrapping agent logic),
 *               AD #3 (contract enforcement via Zod),
 *               AD #4 (fresh context per invocation),
 *               AD #5 (structured failure + telemetry)
 */

import crypto from 'crypto';
import { zodToJsonSchema } from './zod-to-json-schema.mjs';
import { ensureTelemetryStorage } from '../server/telemetry/index.mjs';
import { redactValueSecretsOnly, redactStringSecretsOnly } from '../server/telemetry/redact.mjs';

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Ceiling only — billed on tokens actually generated, not reserved. Raised 4096→8192 so a
// large-but-valid JSON output no longer truncates → invalid_json → a full fallback-model
// escalation (the escalation double-spend this ceiling was causing).
// See backlog.feat.escalation-same-model-retry.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Deterministic, byte-stable self-escalation instruction appended to the system prompt of every
 * fallback-enabled agent running its PRIMARY model. Tells the agent to emit a top-level
 * `"escalate": true` in its JSON ONLY when genuinely low-confidence, so runAgent can re-run it
 * once on the stronger fallback model. Must remain a single fixed string (no per-call IDs /
 * timestamps) appended at a fixed position so the ephemeral system-prompt cache prefix stays
 * valid. See backlog.feat.planner-self-escalation-signal.
 */
const SELF_ESCALATION_INSTRUCTION =
  '\n\nSELF-ESCALATION: If you are genuinely low-confidence in your output — the requirements are ambiguous or underspecified, the output is high-stakes or hard to reverse, or a more capable model would materially improve the result — add "escalate": true to your JSON output so a stronger model can take over. Otherwise omit it or set it false. Do not escalate for routine, well-specified tasks — unnecessary escalation wastes the cheaper-model savings.';

/**
 * Strip the internal `_selfEscalate` control marker from a result before it leaves runAgent, so no
 * caller ever observes it. Returns a new object without the key (or the value unchanged when it is
 * absent / not an object). See backlog.feat.planner-self-escalation-signal.
 */
const stripSelfEscalate = (r) => {
  if (r && typeof r === 'object' && '_selfEscalate' in r) {
    const { _selfEscalate, ...rest } = r;
    return rest;
  }
  return r;
};

/**
 * Run an agent with automatic model escalation on failure.
 *
 * If the agent fails and a fallbackModel is configured (different from the
 * primary model), the runner retries the entire invocation with the fallback.
 * This handles max_turns_exceeded, timeouts, and parse errors transparently —
 * the caller only sees the final result.
 *
 * @param {object} config
 * @param {string} config.name - Agent name (e.g., "product-owner")
 * @param {string} config.prompt - System prompt for the agent
 * @param {string} config.userMessage - User message to send
 * @param {Array} config.tools - Tools available to the agent
 * @param {import('zod').ZodType} config.inputSchema - Input validation schema
 * @param {import('zod').ZodType} config.outputSchema - Output validation schema
 * @param {object} config.rawInput - Raw input to validate
 * @param {string} [config.model] - Model to use
 * @param {string} [config.fallbackModel] - Model to escalate to on failure
 * @param {number} [config.maxTurns] - Max tool-use round trips
 * @param {number} [config.timeoutMs] - Overall timeout
 * @param {string} config.projectId - For telemetry
 * @param {string} [config.projectRoot] - Project root path (for telemetry storage)
 * @returns {Promise<object>} Validated result (never throws)
 */
export async function runAgent(config) {
  let result = await _executeAgent(config);

  const { fallbackModel, model = DEFAULT_MODEL, _isEscalation, _sameModelRetried } = config;

  // Same-model retry (cheap) BEFORE model escalation, for transient parse/validation failures.
  // A one-off invalid_json or output_validation_failed is usually fixed by re-running the SAME
  // (cheaper) model — far cheaper than a full fallback-model re-run that (proven in practice)
  // often still fails. Gated by _sameModelRetried so it fires AT MOST once and cannot recurse.
  // NOT for timeout (a retry would just time out) or max_turns (a stronger model genuinely
  // helps there — those fall straight through to escalation below).
  // See backlog.feat.escalation-same-model-retry.
  const isRetryableFailure = !result.ok && (
    result.error === 'Agent output is not valid JSON' ||
    (typeof result.error === 'string' && result.error.startsWith('Output validation failed:'))
  );
  if (isRetryableFailure && !_isEscalation && !_sameModelRetried) {
    const retryResult = await _executeAgent({ ...config, _sameModelRetried: true });
    // Adopt the retry result whether ok or not: an ok retry must fall through to the self-escalation
    // branch below (it can carry _selfEscalate); a failed retry falls through to model escalation.
    // See backlog.feat.planner-self-escalation-signal.
    result = retryResult;
  }

  // Model escalation: if agent failed and fallbackModel is set, retry with better model
  if (!result.ok && fallbackModel && model !== fallbackModel && !_isEscalation) {
    // Emit escalation telemetry
    let collector;
    try {
      collector = config.projectRoot ? ensureTelemetryStorage(config.projectRoot) : { emit: () => {} };
    } catch { collector = { emit: () => {} }; }
    try {
      collector.emit(`agent.${config.name}.escalation`, config.projectId, {
        from: model,
        to: fallbackModel,
        originalError: result.error,
        originalTelemetryId: result.telemetryId,
      });
    } catch { /* best-effort */ }

    const escalatedResult = await _executeAgent({
      ...config,
      model: fallbackModel,
      _isEscalation: true,
      ...(result.error?.startsWith('Agent exceeded max turns') && result._messages
        ? { _resumeMessages: result._messages }
        : {}),
    });
    escalatedResult._escalated = {
      from: model,
      to: fallbackModel,
      originalError: result.error,
    };
    return stripSelfEscalate(escalatedResult);
  }

  // Self-escalation (quality signal): an OK result whose LLM emitted escalate:true re-runs once on
  // the stronger fallback model. Mirrors the failure-escalation branch above but gates on
  // result.ok + the internal _selfEscalate marker. Mutually exclusive with the failure branch
  // (that one requires !result.ok). The escalated run carries _isEscalation:true, so its own gate
  // (!_isEscalation) prevents a re-entrant loop even if it re-emits escalate:true.
  // See backlog.feat.planner-self-escalation-signal.
  if (result.ok && result._selfEscalate && fallbackModel && model !== fallbackModel && !_isEscalation) {
    let collector;
    if (config._testCollector) {
      collector = config._testCollector;
    } else {
      try {
        collector = config.projectRoot ? ensureTelemetryStorage(config.projectRoot) : { emit: () => {} };
      } catch { collector = { emit: () => {} }; }
    }
    try {
      collector.emit(`agent.${config.name}.self_escalation`, config.projectId, {
        from: model,
        to: fallbackModel,
        reason: 'self_signal',
      });
    } catch { /* best-effort */ }

    const escalated = await _executeAgent({ ...config, model: fallbackModel, _isEscalation: true });
    return stripSelfEscalate(escalated);
  }

  return stripSelfEscalate(result);
}

/**
 * Conversation-prefix caching (multi-turn tool-use loop).
 *
 * Anthropic caches by PREFIX MATCH and READS at the cache_control breakpoints present in the
 * CURRENT request (each walking backward at most 20 content blocks). The static system+last-tool
 * prefix these agents send is small — below Haiku 4.5's 4096-token minimum cacheable prefix — so
 * marking only that prefix creates NO cache entry (verified live: cacheCreate:0 on a 40k-token,
 * 7-turn research run). The ~40k tokens actually re-sent each turn are the GROWING transcript
 * (assistant turns + tool_result RAG snippets). To cache that, mark the last content block of the
 * most-recently-appended turn each round: turn N then reads the turns 1..N-1 prefix and writes the
 * extended prefix.
 *
 * Invariants:
 *  - Anthropic allows a MAX of 4 cache_control breakpoints; the static prefix already uses up to 2
 *    (system + last tool). Keep a SLIDING WINDOW of at most the 2 most-recent conversation markers
 *    (current-turn boundary + previous-turn boundary — the read anchor that matches last turn's
 *    write, and stays inside the 20-block lookback even when a turn appends many tool blocks). Strip
 *    older markers first so the total never exceeds 4.
 *  - The initial user message has string content; convert it to block form so a breakpoint can
 *    attach. The conversion is IDEMPOTENT (guarded on `typeof content === 'string'`) — on the
 *    _resumeMessages escalation path messages[0] arrives already block-form, and a naive re-wrap
 *    would double-wrap it and corrupt the bytes the model receives.
 *  - cache_control is a breakpoint marker, not cached content — toggling it turn to turn does not
 *    invalidate the prefix, and the text the model receives is unchanged (billing-only).
 *
 * See backlog.fix.conversation-prefix-caching.
 */
function applyConversationCacheBreakpoints(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  // 1. Clean slate: strip conversation markers from every prior boundary (bounds the count).
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && block.cache_control) delete block.cache_control;
      }
    }
  }

  // 2. Mark the current-turn boundary (last message) and the previous-turn boundary (last-2, since
  //    each turn appends exactly assistant + tool_result). At most 2 conversation breakpoints.
  const lastIdx = messages.length - 1;
  for (const idx of [lastIdx, lastIdx - 2]) {
    if (idx < 0) continue;
    const msg = messages[idx];
    if (!msg) continue;
    // Idempotent string -> block conversion: only wrap when still a string (never re-wrap an
    // already-block message, e.g. messages[0] resumed via _resumeMessages on an escalated run).
    if (typeof msg.content === 'string') {
      msg.content = [{ type: 'text', text: msg.content }];
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (lastBlock && typeof lastBlock === 'object') {
        lastBlock.cache_control = { type: 'ephemeral' };
      }
    }
  }
}

/**
 * Core agent execution — called by runAgent directly and on escalation.
 */
async function _executeAgent(config) {
  const {
    name,
    prompt,
    userMessage,
    tools = [],
    inputSchema,
    outputSchema,
    rawInput,
    model = DEFAULT_MODEL,
    maxTurns = DEFAULT_MAX_TURNS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    projectId,
    projectRoot,
    shortCircuit,
    _testCollector,
    _testClient,
  } = config;

  const telemetryId = crypto.randomUUID();
  const startTime = Date.now();

  // Set up telemetry (best-effort)
  let collector;
  if (_testCollector) {
    collector = _testCollector;
  } else {
    try {
      collector = projectRoot ? ensureTelemetryStorage(projectRoot) : { emit: () => {} };
    } catch {
      collector = { emit: () => {} };
    }
  }

  const emitTelemetry = (event, data) => {
    try {
      // Tag every SDK-path agent event with the model actually used for THIS invocation
      // (the fallback model on an escalated run — _executeAgent is re-invoked with
      // model: fallbackModel). Makes the model-mix flip + per-model cost verifiable from
      // telemetry, which previously only the HTTP-path llm.token_usage carried.
      // `...data` still wins where a call site sets model explicitly (e.g. 'started').
      // See backlog.fix.agent-telemetry-tag-model.
      collector.emit(`agent.${name}.${event}`, projectId, { telemetryId, model, ...data });
    } catch { /* best-effort */ }
  };

  emitTelemetry('started', { model, maxTurns, toolCount: tools.length, inputSummary: (userMessage || '').slice(0, 200) });

  try {
    // 1. Validate input
    const input = inputSchema.parse(rawInput);

    // 1b. Short-circuit: agent provides a fast path for known-simple requests
    //     (e.g., verbatim file reads that don't need LLM processing)
    if (typeof shortCircuit === 'function') {
      try {
        const shortResult = await shortCircuit(input);
        if (shortResult != null) {
          const durationMs = Date.now() - startTime;
          if (outputSchema) {
            try {
              const validated = outputSchema.parse(shortResult);
              emitTelemetry('complete', { turns: 0, durationMs, shortCircuit: true, outputSummary: JSON.stringify(shortResult).slice(0, 200) });
              try { await collector.flush(); } catch { /* best-effort */ }
              return { ...validated, telemetryId };
            } catch { /* validation failed, fall through to LLM */ }
          } else {
            emitTelemetry('complete', { turns: 0, durationMs, shortCircuit: true, outputSummary: JSON.stringify(shortResult).slice(0, 200) });
            try { await collector.flush(); } catch { /* best-effort */ }
            return { ok: true, ...shortResult, telemetryId };
          }
        }
      } catch { /* short-circuit error, fall through to LLM */ }
    }

    // 2. Create Anthropic client (lazy-loaded to avoid CI import failures)
    let client;
    if (_testClient) {
      client = _testClient;
    } else {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic();
    }

    // 3. Convert tools to Anthropic format. Mark the LAST tool with cache_control so the
    // stable tools prefix is cached (Anthropic prompt caching → ~90% input savings on repeat
    // turns of the multi-turn loop and back-to-back same-agent calls, 5-min TTL). The system
    // block below carries a second breakpoint for the tools+system prefix.
    // See backlog.feat.llm-prompt-caching.
    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }));
    if (anthropicTools.length > 0) {
      anthropicTools[anthropicTools.length - 1].cache_control = { type: 'ephemeral' };
    }

    // Build tool lookup for dispatch
    const toolMap = new Map(tools.map(t => [t.name, t]));

    // 4. Agent loop
    const messages = config._resumeMessages
      ? [...config._resumeMessages]
      : [{ role: 'user', content: userMessage }];
    let turns = 0;
    const tokenAccum = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Self-escalation prompt injection: for a fallback-enabled agent on its PRIMARY model, append
    // the deterministic escalate instruction to the system prompt. Non-mutating (config.prompt is
    // never touched — only this local systemText), byte-stable (same bytes every run → prompt-cache
    // safe), and gated by !_isEscalation so the fallback/self-escalation re-run gets the raw prompt.
    // See backlog.feat.planner-self-escalation-signal.
    const systemText = (config.fallbackModel && model !== config.fallbackModel && !config._isEscalation)
      ? prompt + SELF_ESCALATION_INSTRUCTION
      : prompt;

    try {
      while (turns < maxTurns) {
        turns++;

        // Conversation-prefix caching: mark the growing transcript so multi-turn tool-use agents
        // actually hit the cache. Sliding window keeps total breakpoints <= 4 and is idempotent on
        // the resumed messages[0]. See backlog.fix.conversation-prefix-caching.
        applyConversationCacheBreakpoints(messages);

        const response = await client.messages.create({
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          // Stable system prefix cached (ephemeral). Only billing changes — output is identical.
          system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
          messages,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        });

        tokenAccum.in += response.usage?.input_tokens ?? 0;
        tokenAccum.out += response.usage?.output_tokens ?? 0;
        tokenAccum.cacheRead += response.usage?.cache_read_input_tokens ?? 0;
        tokenAccum.cacheCreate += response.usage?.cache_creation_input_tokens ?? 0;

        // Check for tool use
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          // Agent is done — extract final text
          clearTimeout(timeout);
          const textBlock = response.content.find(b => b.type === 'text');
          const rawText = textBlock?.text?.trim() || '';

          try { await collector.flush(); } catch { /* best-effort */ }
          return finalizeResult({
            name, rawText, outputSchema, telemetryId, emitTelemetry, startTime, turns, tokens: tokenAccum,
          });
        }

        // Execute tools locally and build tool_result messages
        const assistantContent = response.content;
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          const tool = toolMap.get(toolUse.name);
          if (!tool) {
            emitTelemetry('tool_call', { tool: toolUse.name, ok: false, error: 'unknown_tool' });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }),
              is_error: true,
            });
            continue;
          }

          const toolStart = Date.now();
          try {
            const result = await tool.execute(toolUse.input);
            const toolExtras = {};
            if (toolUse.name === 'read_file') {
              toolExtras.path = toolUse.input.path;
            } else if (toolUse.name === 'rag_query') {
              toolExtras.query = toolUse.input.q;
              toolExtras.hitCount = Array.isArray(result?.matches) ? result.matches.length : undefined;
            }
            emitTelemetry('tool_call', { tool: toolUse.name, ok: true, durationMs: Date.now() - toolStart, ...toolExtras });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            const toolExtras = {};
            if (toolUse.name === 'read_file') {
              toolExtras.path = toolUse.input.path;
            } else if (toolUse.name === 'rag_query') {
              toolExtras.query = toolUse.input.q;
            }
            emitTelemetry('tool_call', { tool: toolUse.name, ok: false, error: err.message, durationMs: Date.now() - toolStart, ...toolExtras });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: err.message }),
              is_error: true,
            });
          }
        }

        // Append assistant response and tool results for next turn
        messages.push({ role: 'assistant', content: assistantContent });
        messages.push({ role: 'user', content: toolResults });
      }

      // Max turns exceeded — graceful degradation (backlog.feat.agent-turn-ceiling-graceful-degradation).
      // Instead of discarding all work, route the last assistant text through the SAME finalizeResult
      // path and stamp truncated:true. A usable partial → ok:true+truncated (the runAgent escalation
      // gate is `!result.ok`, so it does NOT fire — the caller consumes the partial). An empty or
      // unparseable partial → ok:false with the max-turns error + _messages, so the existing
      // escalation/_resumeMessages path fires exactly as before.
      clearTimeout(timeout);
      emitTelemetry('failed', { error: 'max_turns_exceeded', turns, durationMs: Date.now() - startTime, tokens: tokenAccum });
      try { await collector.flush(); } catch { /* best-effort */ }
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      const partialText = Array.isArray(lastAssistant?.content)
        ? lastAssistant.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim()
        : (typeof lastAssistant?.content === 'string' ? lastAssistant.content.trim() : '');
      // Suppress finalizeResult's own telemetry — the single max_turns_exceeded emit above is the
      // canonical signal for this invocation; here we only want its parse/validate logic.
      const partial = finalizeResult({
        name, rawText: partialText, outputSchema, telemetryId, emitTelemetry: () => {}, startTime, turns, tokens: tokenAccum,
      });
      return {
        ...partial,
        truncated: true,
        _messages: messages,
        ...(partial.ok ? {} : { error: `Agent exceeded max turns (${maxTurns})` }),
      };

    } catch (err) {
      clearTimeout(timeout);
      throw err; // Re-throw to be caught by outer catch
    }

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err.name === 'AbortError'
      ? `Agent timed out after ${timeoutMs}ms`
      : err.message;

    emitTelemetry('failed', { error: errorMessage, durationMs });
    try { await collector.flush(); } catch { /* best-effort */ }

    return {
      ok: false,
      error: errorMessage,
      telemetryId,
    };
  }
}

/**
 * Scan for the FIRST complete, parseable JSON object/array in `s`, restarting from each
 * candidate opening brace/bracket. The scan is string-literal/escape aware so a `}`/`]`
 * inside a JSON string value does not close the structure early. Returns the parsed value,
 * or undefined if none parses. See backlog.fix.research-agent-output-contract-reliability.
 */
function scanFirstJson(s) {
  if (typeof s !== 'string') return undefined;
  for (let startIdx = 0; startIdx < s.length; startIdx++) {
    const opener = s[startIdx];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = startIdx; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(startIdx, i + 1)); }
          catch { break; } // not valid from this start — try the next opener
        }
      }
    }
  }
  return undefined;
}

/**
 * Extract a JSON value from agent output that may be pure JSON, wrapped in a ```json markdown
 * fence (framing-tolerant), surrounded by prose, wrapped in XML/HTML tags, or contain MULTIPLE
 * blocks. Always yields the FIRST complete JSON object — fixing the prior bug where a naive
 * indexOf('{')..lastIndexOf('}') slice spanned across blocks and produced invalid JSON, losing
 * a successful run to a spurious invalid_json failure. Returns undefined only when no valid JSON
 * can be extracted (the genuine invalid_json case, which still drives the failure/escalation path).
 * @see backlog.fix.research-agent-output-contract-reliability
 */
export function extractJsonFromText(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // 1. Whole text is valid JSON.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // 2. First markdown-fenced block (```json ... ``` or ``` ... ```), tolerant of framing.
  const fence = trimmed.match(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i);
  if (fence) {
    const v = scanFirstJson(fence[1]);
    if (v !== undefined) return v;
  }
  // 3. XML/HTML-tag-stripped (LLMs that wrap JSON in <result>/<invoke> tags).
  const stripped = trimmed.replace(/<[^>]+>/g, '');
  if (stripped !== trimmed) {
    const v = scanFirstJson(stripped);
    if (v !== undefined) return v;
  }
  // 4. First balanced JSON object/array anywhere in the prose.
  return scanFirstJson(trimmed);
}

/**
 * Parse and validate the agent's final text output.
 *
 * SECURITY: every value this function hands back to the caller/transcript (answer, parsed
 * output incl. sources[].snippet, the invalid_json rawText, and the output_validation_failed
 * `partial` branch) is scrubbed through redactValueSecretsOnly — a secret arriving via a RAG
 * snippet must never survive into the returned object. The outputSummary in the emitted
 * telemetry is likewise scrubbed (defense in depth with the storage.write() redaction gate).
 * A "redact values" instruction to the agent is NOT a control; this is. Exported for the
 * output-redaction witness (mirrors the extractJsonFromText export). See
 * backlog.security.agent-env-secret-leak-redaction.
 */
export function finalizeResult({ name, rawText, outputSchema, telemetryId, emitTelemetry, startTime, turns, tokens }) {
  const durationMs = Date.now() - startTime;

  if (!rawText) {
    emitTelemetry('failed', { error: 'empty_response', turns, durationMs, tokens });
    return redactValueSecretsOnly({ ok: false, error: 'Agent returned empty response', telemetryId });
  }

  const safeSummary = redactStringSecretsOnly(rawText.slice(0, 200));

  // Extract JSON tolerantly: pure JSON, ```json fences, surrounding prose, XML wrappers, or
  // multiple blocks — always the FIRST complete object (string-aware balanced scan). undefined
  // means genuinely no JSON, which preserves the invalid_json failure + escalation path.
  // See backlog.fix.research-agent-output-contract-reliability.
  const parsed = extractJsonFromText(rawText);

  // Read + strip the `escalate` CONTROL signal BEFORE any outputSchema.parse / return: capture the
  // agent's low-confidence flag, then delete it so a strict Zod schema never sees the unknown field
  // and it never leaks into answer/partial/no-schema returns. Surfaced to runAgent only via the
  // internal `_selfEscalate` marker on OK results. See backlog.feat.planner-self-escalation-signal.
  let wantsEscalate = false;
  if (parsed !== null && typeof parsed === 'object') {
    wantsEscalate = parsed.escalate === true;
    delete parsed.escalate;
  }

  if (parsed === undefined) {
    if (outputSchema) {
      emitTelemetry('failed', { error: 'invalid_json', turns, durationMs, tokens });
      return redactValueSecretsOnly({ ok: false, error: 'Agent output is not valid JSON', rawText, telemetryId });
    }
    // No schema — return raw text as answer
    emitTelemetry('complete', { turns, durationMs, outputSummary: safeSummary, tokens });
    return redactValueSecretsOnly({ ok: true, answer: rawText, telemetryId });
  }

  // Validate against output schema if provided
  if (outputSchema) {
    try {
      // LLMs often return explicit null instead of omitting keys.
      // Zod .optional() allows undefined but not null, so strip nulls first.
      const sanitized = stripNulls(parsed);
      const validated = outputSchema.parse(sanitized);
      emitTelemetry('complete', { turns, durationMs, validated: true, outputSummary: safeSummary, tokens });
      const okResult = { ...validated, telemetryId };
      if (wantsEscalate) okResult._selfEscalate = true;
      return redactValueSecretsOnly(okResult);
    } catch (err) {
      emitTelemetry('failed', { error: 'output_validation_failed', zodError: err.message, turns, durationMs, tokens });
      return redactValueSecretsOnly({
        ok: false,
        error: `Output validation failed: ${err.message}`,
        partial: parsed,
        telemetryId,
      });
    }
  }

  // No schema — return parsed JSON as-is
  emitTelemetry('complete', { turns, durationMs, outputSummary: safeSummary, tokens });
  const okResult = { ok: true, ...parsed, telemetryId };
  if (wantsEscalate) okResult._selfEscalate = true;
  return redactValueSecretsOnly(okResult);
}

/**
 * Recursively replace null values with undefined so Zod .optional() accepts them.
 * LLMs frequently emit {"field": null} instead of omitting the key.
 */
function stripNulls(obj) {
  if (obj === null) return undefined;
  if (Array.isArray(obj)) return obj.map(stripNulls);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null) {
        out[k] = typeof v === 'object' ? stripNulls(v) : v;
      }
      // null values are simply omitted (become undefined via missing key)
    }
    return out;
  }
  return obj;
}
