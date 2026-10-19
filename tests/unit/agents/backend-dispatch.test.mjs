/**
 * backlog.feat.agent-backend-selection-research: createBackendDispatcher (decision D1).
 *
 * Unit tier (vitest.config.unit.mjs collects tests/unit/**). Deterministic: probeCache, runCli,
 * now, env, executeApi and the telemetry collector (config._testCollector) are all injected. No
 * claude binary is started, no subprocess is created and no LLM is called. The file does not quote
 * the globally mocked telemetry specifier.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createBackendDispatcher,
  getDefaultBackendDispatcher,
  resetDefaultBackendDispatcher,
  CLAUDE_CLI_SUPPORTED_AGENTS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_CONCURRENT,
  COOLDOWN_REASONS,
} from '../../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const SYSTEM_TEXT = 'system text built by the runner';
const READY = Object.freeze({ ready: true, authMethod: 'claude.ai', version: '2.0.0', reason: null });
const CLI_OK = Object.freeze({ ok: true, answer: 'from-cli', telemetryId: 'tid-cli' });
const API_OK = Object.freeze({ ok: true, answer: 'from-api', telemetryId: 'tid-api' });

// Every backendFailure.reason executors/claude-cli.mjs can return, and whether D1 opens the cool-down.
const CLI_FAILURES = [
  ['rate_limit', true],
  ['auth', true],
  ['unavailable', true],
  ['timeout', false],
  ['cli_error', false],
  ['spawn_failed', false],
  ['tools_unavailable', false],
  ['unexpected_mcp_servers', false],
  ['overloaded', false],
  ['model_unavailable', false],
  ['executor_error', false],
];

function recorder() {
  const events = [];
  return {
    events,
    emit: (event, projectId, data) => {
      events.push({ event, projectId, data });
    },
    flush: async () => {},
  };
}

function manualClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function probeStub(result = READY) {
  const stub = { result };
  stub.get = vi.fn(async () => stub.result);
  stub.invalidate = vi.fn();
  return stub;
}

function setup({ probe = probeStub(), runCli, env = {}, now = manualClock(), cooldownMs, maxConcurrent, name = 'research' } = {}) {
  const collector = recorder();
  const cli = runCli || vi.fn(async () => CLI_OK);
  const opts = { probeCache: probe, runCli: cli, now, env };
  if (cooldownMs !== undefined) opts.cooldownMs = cooldownMs;
  if (maxConcurrent !== undefined) opts.maxConcurrent = maxConcurrent;
  const dispatcher = createBackendDispatcher(opts);
  const config = { name, projectId: 'proj-d', model: MODEL, prompt: 'P', _testCollector: collector };
  const executeApi = vi.fn(async () => API_OK);
  const run = (cfg = config) => dispatcher.execute(cfg, { executeApi, systemText: SYSTEM_TEXT });
  return { dispatcher, config, collector, executeApi, runCli: cli, probe, now, env, run };
}

const fallbackEvents = (collector) => collector.events.filter((e) => e.event.endsWith('.backend_fallback'));

async function settle(pred) {
  for (let i = 0; i < 100 && !pred(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  expect(pred()).toBe(true);
}

function pendingRunCli() {
  const pending = [];
  const runCli = vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  return { runCli, pending };
}

describe('constants', () => {
  it('research is the only supported agent; cool-down 15 minutes; cap 2; three reasons open the cool-down', () => {
    expect([...CLAUDE_CLI_SUPPORTED_AGENTS]).toEqual(['research']);
    expect(Object.isFrozen(CLAUDE_CLI_SUPPORTED_AGENTS)).toBe(true);
    expect(DEFAULT_COOLDOWN_MS).toBe(15 * 60_000);
    expect(DEFAULT_MAX_CONCURRENT).toBe(2);
    expect([...COOLDOWN_REASONS].sort()).toEqual(['auth', 'rate_limit', 'unavailable']);
  });
});

describe('success on claude-cli', () => {
  it('returns the executor result unchanged, never calls the API and emits no fallback event', async () => {
    const s = setup();
    const retrieval = { record: () => {}, consume: () => null };
    const cfg = { ...s.config, _retrieval: retrieval, _outputSchemaZod: { marker: true } };
    const result = await s.run(cfg);
    expect(result).toBe(CLI_OK);
    expect(s.executeApi).not.toHaveBeenCalled();
    expect(fallbackEvents(s.collector)).toEqual([]);
    expect(s.probe.get).toHaveBeenCalledTimes(1);
    expect(s.probe.get).toHaveBeenCalledWith({ parentEnv: s.env });
    expect(s.runCli).toHaveBeenCalledTimes(1);
    const [cliConfig, cliDeps] = s.runCli.mock.calls[0];
    expect(cliConfig).toEqual({ ...cfg, systemText: SYSTEM_TEXT });
    expect(cliConfig._retrieval).toBe(retrieval);
    expect(cliDeps.probeResult).toBe(READY);
    expect(cliDeps.env).toBe(s.env);
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
  });
});

describe('recursion guard', () => {
  it('inside the rks-agent-tools server process runs the API with no fallback flag and never probes', async () => {
    const s = setup({ env: { RKS_AGENT_TOOLS_SERVER: '1' } });
    const result = await s.run();
    expect(s.executeApi).toHaveBeenCalledTimes(1);
    expect(s.executeApi.mock.calls[0][0]).toBe(s.config);
    expect(result).toBe(API_OK);
    expect('backendFallback' in result).toBe(false);
    expect(s.probe.get).not.toHaveBeenCalled();
    expect(s.runCli).not.toHaveBeenCalled();
    expect(fallbackEvents(s.collector)).toEqual([]);
  });
});

describe('unsupported agent', () => {
  it('a non-research agent runs on the API with reason agent_not_supported, without probing', async () => {
    const s = setup({ name: 'product-owner' });
    const result = await s.run();
    expect(s.probe.get).not.toHaveBeenCalled();
    expect(s.runCli).not.toHaveBeenCalled();
    expect(s.executeApi).toHaveBeenCalledTimes(1);
    expect(s.executeApi.mock.calls[0][0]).toEqual({
      ...s.config,
      _backendFallback: { from: 'claude-cli', reason: 'agent_not_supported' },
    });
    expect(result).toEqual({ ...API_OK, backendFallback: { from: 'claude-cli', reason: 'agent_not_supported' } });
    const ev = fallbackEvents(s.collector);
    expect(ev).toHaveLength(1);
    expect(ev[0].event).toBe('agent.product-owner.backend_fallback');
    expect(ev[0].projectId).toBe('proj-d');
    expect(ev[0].data).toEqual({ from: 'claude-cli', to: 'anthropic', reason: 'agent_not_supported', model: MODEL });
  });
});

describe('probe gate and cool-down', () => {
  it('probe not ready: API with reason unavailable and the probe reason as detail; opens the cool-down', async () => {
    const s = setup({ probe: probeStub({ ready: false, reason: 'not_installed' }), cooldownMs: 60_000 });
    const result = await s.run();
    expect(s.runCli).not.toHaveBeenCalled();
    expect(result.backendFallback).toEqual({ from: 'claude-cli', reason: 'unavailable', detail: 'not_installed' });
    expect(s.executeApi.mock.calls[0][0]._backendFallback).toEqual({ from: 'claude-cli', reason: 'unavailable' });
    expect(fallbackEvents(s.collector)[0].data).toEqual({
      from: 'claude-cli', to: 'anthropic', reason: 'unavailable', detail: 'not_installed', model: MODEL,
    });
    expect(s.dispatcher.state()).toMatchObject({ cooldownUntil: s.now() + 60_000, cooldownReason: 'unavailable' });
  });

  it('within cooldownMs a call neither probes nor runs the executor and reports cooldown; at cooldownMs the executor runs again', async () => {
    const probe = probeStub({ ready: false, reason: 'not_installed' });
    const s = setup({ probe, cooldownMs: 60_000 });
    await s.run();
    s.now.advance(59_999);
    const second = await s.run();
    expect(probe.get).toHaveBeenCalledTimes(1);
    expect(s.runCli).not.toHaveBeenCalled();
    expect(second.backendFallback).toEqual({ from: 'claude-cli', reason: 'cooldown', detail: 'unavailable' });
    s.now.advance(1);
    probe.result = READY;
    const third = await s.run();
    expect(probe.get).toHaveBeenCalledTimes(2);
    expect(s.runCli).toHaveBeenCalledTimes(1);
    expect(third).toBe(CLI_OK);
    expect(fallbackEvents(s.collector).map((e) => e.data.reason)).toEqual(['unavailable', 'cooldown']);
  });

  it('a missing probe result falls back with detail probe_failed', async () => {
    const s = setup({ probe: probeStub(null) });
    const result = await s.run();
    expect(result.backendFallback).toEqual({ from: 'claude-cli', reason: 'unavailable', detail: 'probe_failed' });
  });

  it('the default cool-down is 15 minutes', async () => {
    const probe = probeStub({ ready: false, reason: 'not_subscription_auth' });
    const s = setup({ probe });
    await s.run();
    s.now.advance(15 * 60_000 - 1);
    expect((await s.run()).backendFallback.reason).toBe('cooldown');
    expect(probe.get).toHaveBeenCalledTimes(1);
    s.now.advance(1);
    expect((await s.run()).backendFallback.reason).toBe('unavailable');
    expect(probe.get).toHaveBeenCalledTimes(2);
  });
});

describe('executor transport failures (backendFailure) fall back to the API', () => {
  it.each(CLI_FAILURES)('%s falls back with the visible flag (opens cool-down: %s)', async (reason, opens) => {
    const runCli = vi.fn(async () => ({ ok: false, error: `cli failed: ${reason}`, backendFailure: { reason } }));
    const s = setup({ runCli, cooldownMs: 60_000 });
    const result = await s.run();
    expect(s.executeApi).toHaveBeenCalledTimes(1);
    expect(s.executeApi.mock.calls[0][0]._backendFallback).toEqual({ from: 'claude-cli', reason });
    expect(result).toEqual({ ...API_OK, backendFallback: { from: 'claude-cli', reason } });
    const ev = fallbackEvents(s.collector);
    expect(ev).toHaveLength(1);
    expect(ev[0].event).toBe('agent.research.backend_fallback');
    expect(ev[0].data).toEqual({ from: 'claude-cli', to: 'anthropic', reason, model: MODEL });
    expect(s.dispatcher.state().cooldownUntil > 0).toBe(opens);
    expect(s.probe.invalidate).toHaveBeenCalledTimes(reason === 'auth' ? 1 : 0);
    expect(s.dispatcher.state().inFlight).toBe(0);

    const next = await s.run();
    if (opens) {
      expect(next.backendFallback).toEqual({ from: 'claude-cli', reason: 'cooldown', detail: reason });
      expect(runCli).toHaveBeenCalledTimes(1);
    } else {
      expect(next.backendFallback).toEqual({ from: 'claude-cli', reason });
      expect(runCli).toHaveBeenCalledTimes(2);
    }
  });

  it('an executor throw falls back with reason executor_error and does not open the cool-down', async () => {
    const runCli = vi.fn(async () => {
      throw new Error('kaboom');
    });
    const s = setup({ runCli });
    const result = await s.run();
    expect(result.backendFallback).toEqual({ from: 'claude-cli', reason: 'executor_error' });
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
  });
});

describe('capability failures are returned unchanged', () => {
  it.each([
    'Agent exceeded max turns (12)',
    'Agent output is not valid JSON',
    'Output validation failed: answer: Required',
  ])('%s is returned as-is with no API call, no fallback event and no cool-down', async (error) => {
    const failure = { ok: false, error, telemetryId: 'tid-cap' };
    const s = setup({ runCli: vi.fn(async () => failure) });
    const result = await s.run();
    expect(result).toBe(failure);
    expect(s.executeApi).not.toHaveBeenCalled();
    expect(fallbackEvents(s.collector)).toEqual([]);
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
  });
});

describe('concurrency cap', () => {
  it('with maxConcurrent 1 and one run pending, a second call runs on the API with reason busy; inFlight returns to 0', async () => {
    const { runCli, pending } = pendingRunCli();
    const s = setup({ runCli, maxConcurrent: 1 });
    const first = s.run();
    await settle(() => pending.length === 1);
    expect(s.dispatcher.state().inFlight).toBe(1);
    const second = await s.run();
    expect(second.backendFallback).toEqual({ from: 'claude-cli', reason: 'busy' });
    expect(runCli).toHaveBeenCalledTimes(1);
    pending[0].resolve(CLI_OK);
    expect(await first).toBe(CLI_OK);
    expect(s.dispatcher.state().inFlight).toBe(0);
  });

  it('inFlight returns to 0 when the pending run rejects', async () => {
    const { runCli, pending } = pendingRunCli();
    const s = setup({ runCli, maxConcurrent: 1 });
    const first = s.run();
    await settle(() => pending.length === 1);
    pending[0].reject(new Error('child died'));
    const result = await first;
    expect(result.backendFallback).toEqual({ from: 'claude-cli', reason: 'executor_error' });
    expect(s.dispatcher.state().inFlight).toBe(0);
  });

  it('the default cap admits two concurrent claude-cli runs and sends the third to the API', async () => {
    const { runCli, pending } = pendingRunCli();
    const s = setup({ runCli });
    const a = s.run();
    const b = s.run();
    await settle(() => pending.length === 2);
    const c = await s.run();
    expect(c.backendFallback).toEqual({ from: 'claude-cli', reason: 'busy' });
    expect(runCli).toHaveBeenCalledTimes(2);
    pending.forEach((p) => p.resolve(CLI_OK));
    await Promise.all([a, b]);
    expect(s.dispatcher.state().inFlight).toBe(0);
  });
});

describe('telemetry is best-effort', () => {
  it('a throwing collector does not stop the fallback', async () => {
    const s = setup({ name: 'planner' });
    const cfg = {
      ...s.config,
      _testCollector: {
        emit: () => {
          throw new Error('disk full');
        },
      },
    };
    const result = await s.run(cfg);
    expect(result.backendFallback.reason).toBe('agent_not_supported');
    expect(s.executeApi).toHaveBeenCalledTimes(1);
  });

  it('with no collector and no projectRoot the fallback still runs', async () => {
    const s = setup({ name: 'planner' });
    const { _testCollector, ...bare } = s.config;
    const result = await s.run(bare);
    expect(result.backendFallback.reason).toBe('agent_not_supported');
  });
});

describe('process-wide default dispatcher', () => {
  it('getDefaultBackendDispatcher returns one shared instance until reset', () => {
    resetDefaultBackendDispatcher();
    const a = getDefaultBackendDispatcher();
    expect(typeof a.execute).toBe('function');
    expect(getDefaultBackendDispatcher()).toBe(a);
    resetDefaultBackendDispatcher();
    expect(getDefaultBackendDispatcher()).not.toBe(a);
    resetDefaultBackendDispatcher();
  });
});
