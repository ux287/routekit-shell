/**
 * Transport-generic claude -p helpers shared by the research agent executor and the one-shot
 * backend (llm/claude-cli/oneshot.mjs). Moved out of the executor, which re-exports these names.
 * parseStreamJson, summarizeRateLimit and isRateLimited move in the form
 * backlog.feat.claude-cli-rate-limit-event left them.
 * NOTE: no comment in this file may name the executor module file, the dispatcher module or the
 * agent tools MCP server module by file name: the tripwire test for that server is a substring
 * scan over every src file, comments included.
 */
import { spawn } from 'child_process';

export const KILL_GRACE_MS = 5_000;
export const MAX_STDOUT_CHARS = 20 * 1024 * 1024;
export const MAX_STDERR_CHARS = 64 * 1024;
export const AUTH_RETRY_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error']);
export const OVERLOAD_RETRY_ERRORS = new Set(['overloaded', 'server_error']);

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

/**
 * Spawn the child; resolves (never rejects) to { stdout, stderr, timedOut, aborted, exitCode, signal,
 * spawnError }. An optional AbortSignal interrupts the child the same way the timeout does (SIGINT,
 * then SIGTERM after killGraceMs) and sets aborted; an already-aborted signal resolves without
 * spawning. Callers that pass no signal (the research executor) see the previous behaviour plus
 * aborted:false.
 */
export function runChild({
  spawnImpl = spawn, binary, args, cwd, env, input, timeoutMs, signal = null,
  killGraceMs = KILL_GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let onAbort = null;
    let settled = false;
    let timer = null;
    let killTimer = null;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      if (killTimer) clearTimer(killTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, timedOut, aborted, exitCode: null, signal: null, spawnError: null, ...extra });
    };
    if (signal?.aborted) {
      aborted = true;
      finish({});
      return;
    }
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
    child.on('close', (code, exitSignal) => finish({ exitCode: code, signal: exitSignal }));
    const interrupt = () => {
      try { child.kill('SIGINT'); } catch { /* already gone */ }
      if (!killTimer) {
        killTimer = setTimer(() => {
          try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }, killGraceMs);
      }
    };
    if (signal) {
      onAbort = () => { aborted = true; interrupt(); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimer(() => {
      timedOut = true;
      interrupt();
    }, timeoutMs);
    try {
      child.stdin?.end(input || '');
    } catch { /* child closed stdin */ }
  });
}
