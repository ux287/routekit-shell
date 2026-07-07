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
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

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
  const result = await _executeAgent(config);

  // Model escalation: if agent failed and fallbackModel is set, retry with better model
  const { fallbackModel, model = DEFAULT_MODEL, _isEscalation } = config;
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
    return escalatedResult;
  }

  return result;
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
      collector.emit(`agent.${name}.${event}`, projectId, { telemetryId, ...data });
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

    try {
      while (turns < maxTurns) {
        turns++;

        const response = await client.messages.create({
          model,
          max_tokens: DEFAULT_MAX_TOKENS,
          // Stable system prefix cached (ephemeral). Only billing changes — output is identical.
          system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
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
      return redactValueSecretsOnly({ ...validated, telemetryId });
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
  return redactValueSecretsOnly({ ok: true, ...parsed, telemetryId });
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
