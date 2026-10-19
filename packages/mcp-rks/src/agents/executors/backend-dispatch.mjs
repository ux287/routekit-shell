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
import { createClaudeCliGate, getDefaultClaudeCliGate, cooldownMsFor, COOLDOWN_REASONS } from '../../llm/claude-cli/gate.mjs';
import { runClaudeCliAgent } from './claude-cli.mjs';

export const CLAUDE_CLI_SUPPORTED_AGENTS = Object.freeze(['research']);
// The cool-down sizing rule and limits moved to llm/claude-cli/gate.mjs (shared with the one-shot
// backend); re-exported under their original names so existing importers resolve identical values.
export {
  DEFAULT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS, cooldownMsFor, DEFAULT_MAX_CONCURRENT, COOLDOWN_REASONS,
} from '../../llm/claude-cli/gate.mjs';

function collectorFor(config) {
  if (config._testCollector) return config._testCollector;
  try {
    return config.projectRoot ? ensureTelemetryStorage(config.projectRoot) : { emit: () => {} };
  } catch {
    return { emit: () => {} };
  }
}

/**
 * gate: an injected claude -p gate (llm/claude-cli/gate.mjs). Without one the dispatcher builds a
 * PRIVATE gate from probeCache/now/cooldownMs/maxConcurrent (each defaulting as before), so
 * dispatchers built with injected parameters never share cool-down state. Only
 * getDefaultBackendDispatcher() passes the process-wide default gate, which the one-shot backend
 * also uses. With a gate injected, the clock, default cool-down, concurrency and probe cache are the
 * gate's.
 */
export function createBackendDispatcher({
  gate = null,
  probeCache,
  runCli = runClaudeCliAgent,
  now,
  cooldownMs,
  maxConcurrent,
  env = process.env,
} = {}) {
  const g = gate || createClaudeCliGate({
    ...(probeCache ? { probeCache } : {}),
    ...(now ? { now } : {}),
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
  });

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
    if (g.inCooldown()) return fallback('cooldown', g.cooldownReason());

    const probe = await g.probeCache.get({ parentEnv: env });
    if (!probe || probe.ready !== true) {
      g.openCooldown('unavailable');
      return fallback('unavailable', probe?.reason || 'probe_failed');
    }
    if (!g.tryAcquire()) return fallback('busy');

    let result;
    try {
      result = await runCli({ ...config, systemText }, { probeResult: probe, env });
    } catch (err) {
      result = { ok: false, error: err?.message || String(err), backendFailure: { reason: 'executor_error' } };
    } finally {
      g.release();
    }

    const failure = result && result.ok === false ? result.backendFailure : null;
    if (failure) {
      if (COOLDOWN_REASONS.includes(failure.reason)) g.openCooldown(failure.reason, cooldownMsFor(failure, g.now(), g.cooldownMs));
      if (failure.reason === 'auth') g.probeCache.invalidate();
      return fallback(failure.reason);
    }
    return result;
  }

  return { execute, state: () => g.state() };
}

let _defaultDispatcher = null;

/** Process-wide dispatcher, so cool-down and concurrency are shared by every runAgent call. */
export function getDefaultBackendDispatcher() {
  if (!_defaultDispatcher) _defaultDispatcher = createBackendDispatcher({ gate: getDefaultClaudeCliGate() });
  return _defaultDispatcher;
}

export function resetDefaultBackendDispatcher() {
  _defaultDispatcher = null;
}
