/**
 * Backend dispatch for runAgent (backlog.feat.agent-backend-selection-research)
 *
 * Decision D1 (research.2026.10.15.claude-p-subscription-backend, sec. 8): when the subscription
 * backend is unavailable or rate-limited, run the same invocation on the API, flag it visibly
 * (result.backendFallback, fallbackFrom/fallbackReason on the API run's events, and one
 * agent.<name>.backend_fallback event) and open a cool-down so the next calls go straight to
 * the API instead of hitting the limit again.
 *
 * Capability failures (invalid JSON, validation, max turns) carry no backendFailure and are
 * returned unchanged: runAgent's same-model retry and escalation handle them, on claude-cli.
 */
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { createProbeCache } from '../../llm/claude-cli/probe.mjs';
import { runClaudeCliAgent } from './claude-cli.mjs';

export const CLAUDE_CLI_SUPPORTED_AGENTS = Object.freeze(['research']);
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
// Upper bound on a resetsAt-sized rate-limit cool-down (design choice; next attempt re-detects).
export const MAX_RATE_LIMIT_COOLDOWN_MS = 6 * 60 * 60_000;

// resetsAt is epoch SECONDS (inferred from one captured claude 2.1.302 line).
export function cooldownMsFor(failure, nowMs, defaultMs = DEFAULT_COOLDOWN_MS) {
  if (failure?.reason !== 'rate_limit' || !Number.isFinite(failure.resetsAt)) return defaultMs;
  const ms = failure.resetsAt * 1000 - nowMs;
  return ms > 0 ? Math.min(ms, MAX_RATE_LIMIT_COOLDOWN_MS) : defaultMs;
}
export const DEFAULT_MAX_CONCURRENT = 2;
export const COOLDOWN_REASONS = Object.freeze(['rate_limit', 'auth', 'unavailable']);

function collectorFor(config) {
  if (config._testCollector) return config._testCollector;
  try {
    return config.projectRoot ? ensureTelemetryStorage(config.projectRoot) : { emit: () => {} };
  } catch {
    return { emit: () => {} };
  }
}

export function createBackendDispatcher({
  probeCache = createProbeCache(),
  runCli = runClaudeCliAgent,
  now = Date.now,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  env = process.env,
} = {}) {
  let cooldownUntil = 0;
  let cooldownReason = null;
  let inFlight = 0;

  const openCooldown = (reason, durationMs = cooldownMs) => {
    cooldownUntil = now() + durationMs;
    cooldownReason = reason;
  };

  async function execute(config, { executeApi, systemText }) {
    const fallback = async (reason, detail) => {
      try {
        collectorFor(config).emit(`agent.${config.name}.backend_fallback`, config.projectId, {
          from: 'claude-cli', to: 'anthropic', reason, ...(detail ? { detail } : {}), model: config.model,
        });
      } catch { /* best-effort */ }
      const result = await executeApi({ ...config, _backendFallback: { from: 'claude-cli', reason } });
      return { ...result, backendFallback: { from: 'claude-cli', reason, ...(detail ? { detail } : {}) } };
    };

    // Recursion guard: inside the rks-agent-tools server process nothing may spawn claude.
    if (env.RKS_AGENT_TOOLS_SERVER === '1') return executeApi(config);
    if (!CLAUDE_CLI_SUPPORTED_AGENTS.includes(config.name)) return fallback('agent_not_supported');
    if (now() < cooldownUntil) return fallback('cooldown', cooldownReason);

    const probe = await probeCache.get({ parentEnv: env });
    if (!probe || probe.ready !== true) {
      openCooldown('unavailable');
      return fallback('unavailable', probe?.reason || 'probe_failed');
    }
    if (inFlight >= maxConcurrent) return fallback('busy');

    inFlight++;
    let result;
    try {
      result = await runCli({ ...config, systemText }, { probeResult: probe, env });
    } catch (err) {
      result = { ok: false, error: err?.message || String(err), backendFailure: { reason: 'executor_error' } };
    } finally {
      inFlight--;
    }

    const failure = result && result.ok === false ? result.backendFailure : null;
    if (failure) {
      if (COOLDOWN_REASONS.includes(failure.reason)) openCooldown(failure.reason, cooldownMsFor(failure, now(), cooldownMs));
      if (failure.reason === 'auth') probeCache.invalidate();
      return fallback(failure.reason);
    }
    return result;
  }

  return { execute, state: () => ({ cooldownUntil, cooldownReason, inFlight }) };
}

let _defaultDispatcher = null;

/** Process-wide dispatcher, so cool-down and concurrency are shared by every runAgent call. */
export function getDefaultBackendDispatcher() {
  if (!_defaultDispatcher) _defaultDispatcher = createBackendDispatcher();
  return _defaultDispatcher;
}

export function resetDefaultBackendDispatcher() {
  _defaultDispatcher = null;
}
