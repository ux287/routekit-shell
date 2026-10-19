/**
 * claude -p executor for rks agents (backlog.feat.agent-backend-selection-research; filed
 * originally as backlog.feat.claude-cli-executor, absorbed 2026-10-17)
 *
 * Runs ONE whole agent invocation as a `claude -p` child billed to the user's Claude
 * subscription, as a drop-in for runner.mjs _executeAgent (same result shape). rks keeps control:
 *  - prompt: config.systemText (built by runner.mjs with its own self-escalation rule) replaces
 *    Claude Code's default system prompt via --system-prompt-file;
 *  - model: --model <resolved id>; no --fallback-model (rks owns escalation);
 *  - tools: --tools "" + --strict-mcp-config with ONLY the rks-agent-tools server;
 *  - output: --json-schema from the Zod source, then rks's own finalizeResult validation;
 *  - cost record: modelUsage -> { in, out, cacheRead, cacheCreate } on the terminal event, tagged
 *    backend:'claude-cli', billing:'subscription'.
 * Refuses unless the caller passes a ready claude.ai probe result (llm/claude-cli/probe.mjs),
 * and spawns with that probe's stripped environment, so the child can never bill the API.
 * Degradations the run survives (unparseable stream lines, a dropped --json-schema) are reported
 * on the terminal event and on result.backendMeta, never swallowed (evidence-bound reporting R9).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { finalizeResult } from '../runner.mjs';
import { zodToJsonSchema } from '../zod-to-json-schema.mjs';
import { buildSubscriptionEnv, SUBSCRIPTION_AUTH_METHODS } from '../../llm/claude-cli/probe.mjs';
import { AGENT_TOOLS_SERVER_NAME, READ_ONLY_TOOLS } from '../agent-tools-mcp-server.mjs';

export const DEFAULT_CLI_TIMEOUT_MS = 180_000;
export const KILL_GRACE_MS = 5_000;
export const CLI_BACKEND = 'claude-cli';
const MAX_STDOUT_CHARS = 20 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const AGENT_TOOLS_SERVER_PATH = fileURLToPath(new URL('../agent-tools-mcp-server.mjs', import.meta.url));
const KNOWN_OUTCOMES = new Set(['healthy', 'thin_results', 'no_results', 'retrieval_failed']);
const AUTH_RETRY_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error']);
const OVERLOAD_RETRY_ERRORS = new Set(['overloaded', 'server_error']);

/** Billing label derived from an observed probe result; null unless the probe saw subscription auth. */
export function billingForProbe(probe) {
  return probe && probe.ready === true && SUBSCRIPTION_AUTH_METHODS.includes(probe.authMethod) ? 'subscription' : null;
}

/** Fixed, byte-stable notice appended to the system prompt (D3: read-only tool set). */
export function buildToolsNotice(agent) {
  const names = (READ_ONLY_TOOLS[agent] || []).map((n) => `mcp__${AGENT_TOOLS_SERVER_NAME}__${n}`);
  return `\n\nTOOLS IN THIS SESSION: only ${names.join(', ')} are available. They are the tools named above, under the mcp__${AGENT_TOOLS_SERVER_NAME}__ prefix. Note-writing tools are not available in this session.`;
}

/**
 * stdio MCP config for the rks-agent-tools server. --backend and --billing are the launcher flags
 * backlog.feat.agent-tools-mcp-server reads to tag its tool_call events; each is emitted only when
 * a value is supplied, so the server omits the tag rather than asserting one it did not observe.
 */
export function buildMcpConfig({
  agent, projectId, projectRoot, telemetryId, model, outcomesFile, backend, billing,
  nodePath = process.execPath, serverPath = AGENT_TOOLS_SERVER_PATH,
}) {
  const args = [
    serverPath,
    '--agent', agent,
    '--project', projectId,
    '--root', projectRoot,
    '--telemetry-id', telemetryId,
    '--model', model,
    '--outcomes-file', outcomesFile,
  ];
  if (backend) args.push('--backend', backend);
  if (billing) args.push('--billing', billing);
  return {
    mcpServers: {
      [AGENT_TOOLS_SERVER_NAME]: {
        type: 'stdio',
        command: nodePath,
        args,
        env: { RKS_AGENT_TOOLS_SERVER: '1' },
      },
    },
  };
}

export function buildClaudeArgs({ model, maxTurns, systemPromptFile, mcpConfigFile, jsonSchema, sessionId }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--max-turns', String(maxTurns),
    '--system-prompt-file', systemPromptFile,
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigFile,
    '--allowedTools', `mcp__${AGENT_TOOLS_SERVER_NAME}`,
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--session-id', sessionId,
  ];
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  return args;
}

export function parseStreamJson(stdout) {
  const out = { init: null, retries: [], result: null, rateLimit: null, malformedLines: 0 };
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      out.malformedLines++;
      continue;
    }
    if (ev?.type === 'system' && ev.subtype === 'init') out.init = ev;
    else if (ev?.type === 'system' && ev.subtype === 'api_retry') out.retries.push(ev);
    else if (ev?.type === 'result') out.result = ev;
    // Latest rate_limit_event wins. Held in memory only; telemetry goes through summarizeRateLimit.
    else if (ev?.type === 'rate_limit_event' && ev.rate_limit_info && typeof ev.rate_limit_info === 'object') out.rateLimit = ev.rate_limit_info;
  }
  return out;
}

export function mapUsage(result) {
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
  const perModel = result && result.modelUsage && typeof result.modelUsage === 'object'
    ? Object.values(result.modelUsage)
    : [];
  if (perModel.length > 0) {
    for (const m of perModel) {
      tokens.in += Number(m?.inputTokens) || 0;
      tokens.out += Number(m?.outputTokens) || 0;
      tokens.cacheRead += Number(m?.cacheReadInputTokens) || 0;
      tokens.cacheCreate += Number(m?.cacheCreationInputTokens) || 0;
    }
    return tokens;
  }
  const u = result?.usage || {};
  tokens.in = Number(u.input_tokens) || 0;
  tokens.out = Number(u.output_tokens) || 0;
  tokens.cacheRead = Number(u.cache_read_input_tokens) || 0;
  tokens.cacheCreate = Number(u.cache_creation_input_tokens) || 0;
  return tokens;
}

/** null = the run succeeded at the transport level. capability:true = no API fallback. */
// Whitelist projection of rate_limit_info for telemetry. Never carries uuid/session_id/account fields.
export function summarizeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {};
  if (typeof info.status === 'string') out.status = info.status;
  if (typeof info.rateLimitType === 'string') out.rateLimitType = info.rateLimitType;
  if (Number.isFinite(info.resetsAt)) out.resetsAt = info.resetsAt;
  const fiveHour = info.unifiedWindows?.five_hour?.utilization;
  const sevenDay = info.unifiedWindows?.seven_day?.utilization;
  if (Number.isFinite(fiveHour)) out.fiveHourUtilization = fiveHour;
  if (Number.isFinite(sevenDay)) out.sevenDayUtilization = sevenDay;
  return Object.keys(out).length > 0 ? out : null;
}

// Only "allowed" is observed locally (claude 2.1.302). "allowed_warning" (>= 90% utilization, requests
// still succeed) and "rejected" are third-party-reported. Only "rejected" is limited; allowed,
// allowed_warning and unknown statuses fall through to the existing auth/overloaded/cli_error checks.
export function isRateLimited(info) {
  return Boolean(info && typeof info === 'object' && info.status === 'rejected');
}

export function classifyCliFailure({ spawnError, timedOut, exitCode, stream, maxTurns, timeoutMs }) {
  if (spawnError) return { reason: 'spawn_failed', error: `claude-cli spawn failed: ${spawnError.message || spawnError}` };
  if (timedOut) return { reason: 'timeout', error: `Agent timed out after ${timeoutMs}ms` };
  const servers = Array.isArray(stream?.init?.mcp_servers) ? stream.init.mcp_servers : null;
  if (servers) {
    const ours = servers.find((s) => s?.name === AGENT_TOOLS_SERVER_NAME);
    if (!ours || ours.status !== 'connected') {
      return { reason: 'tools_unavailable', error: `claude-cli: ${AGENT_TOOLS_SERVER_NAME} MCP server not connected (${ours ? ours.status : 'absent'})` };
    }
    const others = servers.filter((s) => s?.name !== AGENT_TOOLS_SERVER_NAME).map((s) => s?.name);
    if (others.length > 0) {
      return { reason: 'unexpected_mcp_servers', error: `claude-cli: unexpected MCP servers loaded: ${others.join(', ')}` };
    }
  }
  const result = stream?.result;
  if (result && result.subtype === 'error_max_turns') {
    return { reason: 'max_turns', capability: true, error: `Agent exceeded max turns (${maxTurns})` };
  }
  if (!result || result.is_error === true || exitCode !== 0) {
    const detail = String(result?.result ?? '').slice(0, 300);
    const retryErrors = (stream?.retries || []).map((r) => r?.error).filter(Boolean);
    const limitedInfo = isRateLimited(stream?.rateLimit) ? stream.rateLimit : null;
    if (limitedInfo || retryErrors.includes('rate_limit') || /usage limit|rate limit|limit reached/i.test(detail)) {
      const resetsAt = limitedInfo && Number.isFinite(limitedInfo.resetsAt) ? limitedInfo.resetsAt : null;
      return { reason: 'rate_limit', error: `claude-cli rate_limit: ${detail || 'rate limited'}`, ...(resetsAt !== null ? { resetsAt } : {}) };
    }
    if (retryErrors.some((e) => AUTH_RETRY_ERRORS.has(e))) return { reason: 'auth', error: `claude-cli authentication failed: ${detail}` };
    if (retryErrors.some((e) => OVERLOAD_RETRY_ERRORS.has(e))) return { reason: 'overloaded', error: `claude-cli overloaded: ${detail}` };
    if (retryErrors.includes('model_not_found')) return { reason: 'model_unavailable', error: `claude-cli model unavailable: ${detail}` };
    return { reason: 'cli_error', error: `claude-cli exited ${exitCode}${detail ? `: ${detail}` : ''}` };
  }
  return null;
}

export function readOutcomes(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const outcome = JSON.parse(line)?.outcome;
      if (KNOWN_OUTCOMES.has(outcome)) out.push(outcome);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/** Spawn the child; resolves (never rejects) to { stdout, stderr, timedOut, exitCode, signal, spawnError }. */
export function runChild({
  spawnImpl = spawn, binary, args, cwd, env, input, timeoutMs,
  killGraceMs = KILL_GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      if (killTimer) clearTimer(killTimer);
      resolve({ stdout, stderr, timedOut, exitCode: null, signal: null, spawnError: null, ...extra });
    };
    let child;
    try {
      child = spawnImpl(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ spawnError: err });
      return;
    }
    child.stdout?.on('data', (d) => { if (stdout.length < MAX_STDOUT_CHARS) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < MAX_STDERR_CHARS) stderr += d; });
    child.on('error', (err) => finish({ spawnError: err }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
    timer = setTimer(() => {
      timedOut = true;
      try { child.kill('SIGINT'); } catch { /* already gone */ }
      killTimer = setTimer(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }, killGraceMs);
    }, timeoutMs);
    try {
      child.stdin?.end(input || '');
    } catch { /* child closed stdin */ }
  });
}

export async function runClaudeCliAgent(config, deps = {}) {
  const {
    name, userMessage, inputSchema, outputSchema, rawInput, shortCircuit,
    model, maxTurns = 10, projectId, problemId, projectRoot, prompt, systemText,
    _outputSchemaZod, _retrieval, _testCollector,
  } = config;
  const probe = deps.probeResult;
  const billing = billingForProbe(probe);
  if (!billing) {
    return {
      ok: false,
      error: 'claude-cli refused: subscription auth not verified',
      backendFailure: { reason: 'unavailable' },
    };
  }

  const parentEnv = deps.env || process.env;
  const binary = deps.binary || parentEnv.RKS_CLAUDE_BIN || 'claude';
  const timeoutMs = deps.timeoutMs || DEFAULT_CLI_TIMEOUT_MS;
  const telemetryId = crypto.randomUUID();
  const startTime = Date.now();

  let collector = _testCollector || deps.collector;
  if (!collector) {
    try {
      collector = projectRoot ? ensureTelemetryStorage(projectRoot) : { emit: () => {} };
    } catch {
      collector = { emit: () => {} };
    }
  }
  const flush = async () => { try { await collector.flush?.(); } catch { /* best-effort */ } };
  const baseTags = {
    telemetryId,
    model,
    backend: CLI_BACKEND,
    billing,
    claudeVersion: probe.version,
    authMethod: probe.authMethod,
    ...(typeof problemId === 'string' && problemId ? { problemId } : {}),
  };
  let runMeta = {};
  const emitTelemetry = (event, data) => {
    try { collector.emit(`agent.${name}.${event}`, projectId, { ...baseTags, ...runMeta, ...data }); } catch { /* best-effort */ }
  };

  emitTelemetry('started', { maxTurns, inputSummary: (userMessage || '').slice(0, 200) });

  // Input validation + short-circuit: parity with _executeAgent (runner.mjs).
  let input;
  try {
    input = inputSchema.parse(rawInput);
  } catch (err) {
    emitTelemetry('failed', { error: err.message, durationMs: Date.now() - startTime });
    await flush();
    return { ok: false, error: err.message, telemetryId };
  }
  if (typeof shortCircuit === 'function') {
    try {
      const sc = await shortCircuit(input);
      if (sc != null) {
        const validated = outputSchema ? outputSchema.parse(sc) : { ok: true, ...sc };
        emitTelemetry('complete', { turns: 0, durationMs: Date.now() - startTime, shortCircuit: true, outputSummary: JSON.stringify(sc).slice(0, 200) });
        await flush();
        return { ...validated, telemetryId };
      }
    } catch { /* fall through to the CLI run, as _executeAgent falls through to the LLM */ }
  }

  let scratch = null;
  let backendMeta = null;
  try {
    scratch = fs.mkdtempSync(path.join(deps.tmpdir || os.tmpdir(), 'rks-claude-cli-'));
    const systemPromptFile = path.join(scratch, 'system-prompt.txt');
    const mcpConfigFile = path.join(scratch, 'mcp-config.json');
    const outcomesFile = path.join(scratch, 'retrieval-outcomes.jsonl');
    fs.writeFileSync(systemPromptFile, `${systemText ?? prompt ?? ''}${buildToolsNotice(name)}`, 'utf8');
    fs.writeFileSync(mcpConfigFile, JSON.stringify(buildMcpConfig({
      agent: name, projectId, projectRoot, telemetryId, model, outcomesFile,
      backend: CLI_BACKEND, billing,
      ...(deps.serverPath ? { serverPath: deps.serverPath } : {}),
    })), 'utf8');

    let jsonSchema = null;
    let jsonSchemaError = null;
    const zodSource = _outputSchemaZod || (outputSchema && outputSchema._def ? outputSchema : null);
    if (zodSource) {
      try {
        jsonSchema = zodToJsonSchema(zodSource);
      } catch (err) {
        jsonSchema = null;
        jsonSchemaError = String(err?.message || err).slice(0, 200);
      }
    }
    backendMeta = { malformedLines: 0, jsonSchemaDropped: jsonSchemaError !== null };
    const args = buildClaudeArgs({ model, maxTurns, systemPromptFile, mcpConfigFile, jsonSchema, sessionId: crypto.randomUUID() });
    const { env } = buildSubscriptionEnv(parentEnv);
    const run = await runChild({ spawnImpl: deps.spawn || spawn, binary, args, cwd: scratch, env, input: userMessage, timeoutMs });

    const stream = parseStreamJson(run.stdout);
    backendMeta = { malformedLines: stream.malformedLines, jsonSchemaDropped: jsonSchemaError !== null };
    const tokens = mapUsage(stream.result);
    const hasTokens = tokens.in + tokens.out + tokens.cacheRead + tokens.cacheCreate > 0;
    const r = stream.result || {};
    runMeta = {
      ...(r.num_turns != null ? { numTurns: r.num_turns } : {}),
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.total_cost_usd != null ? { costUsdEstimate: r.total_cost_usd } : {}),
      ...(r.duration_api_ms != null ? { durationApiMs: r.duration_api_ms } : {}),
      ...(stream.retries.length > 0 ? { apiRetries: stream.retries.length } : {}),
      // R9: degradations the run survived are volunteered on the terminal event.
      ...(stream.malformedLines > 0 ? { malformedLines: stream.malformedLines } : {}),
      ...(jsonSchemaError !== null ? { jsonSchemaDropped: true, jsonSchemaError } : {}),
      ...(summarizeRateLimit(stream.rateLimit) ? { rateLimit: summarizeRateLimit(stream.rateLimit) } : {}),
    };

    const failure = classifyCliFailure({ spawnError: run.spawnError, timedOut: run.timedOut, exitCode: run.exitCode, stream, maxTurns, timeoutMs });
    if (failure) {
      emitTelemetry('failed', { error: failure.reason, durationMs: Date.now() - startTime, ...(hasTokens ? { tokens } : {}) });
      await flush();
      return {
        ok: false,
        error: failure.error,
        telemetryId,
        backendMeta,
        ...(failure.capability ? {} : { backendFailure: { reason: failure.reason, ...(failure.resetsAt != null ? { resetsAt: failure.resetsAt } : {}) } }),
      };
    }

    // Replay the tools server's rag_query outcomes BEFORE the parse that consumes the record.
    if (_retrieval && typeof _retrieval.record === 'function') {
      for (const outcome of readOutcomes(outcomesFile)) _retrieval.record(outcome);
    }
    const so = r.structured_output;
    const rawText = so !== undefined && so !== null ? JSON.stringify(so) : String(r.result ?? '').trim();
    const finalized = finalizeResult({
      name, rawText, outputSchema, telemetryId, emitTelemetry, startTime, turns: r.num_turns ?? 0, tokens,
    });
    await flush();
    return { ...finalized, backendMeta };
  } catch (err) {
    const message = err?.message || String(err);
    emitTelemetry('failed', { error: message, durationMs: Date.now() - startTime });
    await flush();
    return {
      ok: false,
      error: `claude-cli executor error: ${message}`,
      telemetryId,
      ...(backendMeta ? { backendMeta } : {}),
      backendFailure: { reason: 'executor_error' },
    };
  } finally {
    if (scratch && !deps.keepScratch) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
