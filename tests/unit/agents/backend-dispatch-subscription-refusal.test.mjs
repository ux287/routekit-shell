/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC7, AC8, AC9 (research dispatcher).
 * probeCache, runCli, now, env, executeApi and config._testCollector are injected, as in
 * backend-dispatch.test.mjs. No claude binary, no subprocess, no API call. Every case passes its env
 * explicitly, so the runner's own ANTHROPIC_API_KEY / RKS_SUBSCRIPTION_CREDENTIAL cannot matter.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBackendDispatcher } from '../../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const NOW = 1_800_000_000_000;
const READY = Object.freeze({ ready: true, authMethod: 'claude.ai', version: '2.1.302', reason: null });
const CLI_OK = Object.freeze({ ok: true, answer: 'from-cli' });
const API_OK = Object.freeze({ ok: true, answer: 'from-api' });
const PROBE_REASONS = [
  'binary_not_found', 'version_failed', 'version_unparseable', 'version_too_old',
  'auth_status_failed', 'auth_status_unparseable', 'not_subscription_auth', 'probe_error',
];
const NO_KEY_ENVS = [['no key at all', () => ({})], ['OPENAI-only', () => ({ OPENAI_API_KEY: 'sk-openai-test-not-real' })]];

function recorder(order = null) {
  const events = [];
  return {
    events,
    emit: (event, projectId, data) => { order?.push(`event:${event}`); events.push({ event, projectId, data }); },
    flush: async () => {},
  };
}
function probeStub(result = READY) {
  const stub = { result };
  stub.get = vi.fn(async () => stub.result);
  stub.invalidate = vi.fn();
  return stub;
}
function setup({ probe = probeStub(), runCli, env = {}, maxConcurrent, name = 'research', order = null } = {}) {
  let t = NOW;
  const now = () => t;
  const collector = recorder(order);
  const cli = runCli || vi.fn(async () => CLI_OK);
  const dispatcher = createBackendDispatcher({ probeCache: probe, runCli: cli, now, env, ...(maxConcurrent ? { maxConcurrent } : {}) });
  const config = { name, projectId: 'proj-sub', model: MODEL, prompt: 'P', _testCollector: collector };
  const executeApi = vi.fn(async () => { order?.push('executeApi:entered'); return API_OK; });
  const run = (cfg = config) => dispatcher.execute(cfg, { executeApi, systemText: 'S' });
  return { dispatcher, config, collector, executeApi, runCli: cli, probe, run, advance: (ms) => { t += ms; } };
}
const ofSuffix = (c, suffix) => c.events.filter((e) => e.event.endsWith(`.${suffix}`));

function expectRefusal(result, s) {
  expect(result.ok).toBe(false);
  expect(result.fallback).toBe('none');
  expect(result.reason).toBe('subscription_unavailable');
  expect(typeof result.error).toBe('string');
  expect('backendFallback' in result).toBe(false);
  expect(s.executeApi).not.toHaveBeenCalled();
  expect(ofSuffix(s.collector, 'backend_fallback')).toEqual([]);
}

describe('no API key: structured refusal (AC7)', () => {
  for (const [label, envOf] of NO_KEY_ENVS) {
    it.each(PROBE_REASONS)(`${label}: probe reason %s -> subscription_unavailable with probeReason, fallback none, a fix message; executeApi not called`, async (probeReason) => {
      const s = setup({ probe: probeStub({ ready: false, reason: probeReason }), env: envOf() });
      const result = await s.run();
      expectRefusal(result, s);
      expect(result.probeReason).toBe(probeReason);
      expect(result.message).toMatch(/claude \/login|2\.1\.293/);
      expect(s.runCli).not.toHaveBeenCalled();
      const refused = ofSuffix(s.collector, 'backend_refused');
      expect(refused).toHaveLength(1);
      expect(refused[0].event).toBe('agent.research.backend_refused');
      expect(refused[0].data).toMatchObject({ reason: 'unavailable', probeReason, fallback: 'none' });
    });
  }

  it('the busy path refuses with fallback none and never calls executeApi', async () => {
    const pending = [];
    const runCli = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const s = setup({ runCli, maxConcurrent: 1 });
    const first = s.run();
    for (let i = 0; i < 50 && pending.length === 0; i++) await new Promise((r) => setImmediate(r));
    expect(pending).toHaveLength(1);
    const second = await s.run();
    expectRefusal(second, s);
    expect(second.cause).toBe('busy');
    expect(ofSuffix(s.collector, 'backend_refused')).toHaveLength(1);
    pending[0](CLI_OK);
    expect(await first).toBe(CLI_OK);
  });

  it('the agent_not_supported path refuses without probing', async () => {
    const s = setup({ name: 'product-owner' });
    const result = await s.run();
    expectRefusal(result, s);
    expect(result.cause).toBe('agent_not_supported');
    expect(s.probe.get).not.toHaveBeenCalled();
    const refused = ofSuffix(s.collector, 'backend_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].event).toBe('agent.product-owner.backend_refused');
    expect('probeReason' in refused[0].data).toBe(false);
  });

  it('a cool-down hit refuses and carries retryAfter', async () => {
    const s = setup({ runCli: vi.fn(async () => ({ ok: false, error: 'limited', backendFailure: { reason: 'rate_limit' } })) });
    await s.run();
    const second = await s.run();
    expectRefusal(second, s);
    expect(second.cause).toBe('cooldown');
    expect(typeof second.retryAfter).toBe('string');
    expect(s.runCli).toHaveBeenCalledTimes(1);
  });

  it.each(['auth', 'cli_error', 'timeout', 'unavailable'])('a runCli backendFailure %s refuses with fallback none', async (reason) => {
    const s = setup({ runCli: vi.fn(async () => ({ ok: false, error: `cli ${reason}`, backendFailure: { reason } })) });
    const result = await s.run();
    expectRefusal(result, s);
    expect(result.cause).toBe(reason);
    expect(ofSuffix(s.collector, 'backend_refused')).toHaveLength(1);
    // Only rate_limit opens a cool-down with no key; auth/unavailable invalidate the probe instead.
    expect(s.dispatcher.state().cooldownReason).toBeNull();
    expect(s.probe.invalidate).toHaveBeenCalledTimes(reason === 'auth' || reason === 'unavailable' ? 1 : 0);
  });
});

describe('no API key: cool-down (AC8)', () => {
  it('a not-ready probe opens no cool-down and invalidates the cache; a call right after the login is fixed re-probes and succeeds', async () => {
    const probe = probeStub({ ready: false, reason: 'not_subscription_auth' });
    const s = setup({ probe });
    const first = await s.run();
    expectRefusal(first, s);
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
    expect(probe.invalidate).toHaveBeenCalledTimes(1);
    probe.result = READY; // the user ran claude /login
    const second = await s.run();
    expect(probe.get).toHaveBeenCalledTimes(2);
    expect(s.runCli).toHaveBeenCalledTimes(1);
    expect(second).toBe(CLI_OK);
  });

  it('rate_limit keeps its cooldownMsFor-sized cool-down (resetsAt honoured); the refusal carries retryAfter; a call inside it is refused', async () => {
    const resetsAt = NOW / 1000 + 600;
    const s = setup({ runCli: vi.fn(async () => ({ ok: false, error: 'limited', backendFailure: { reason: 'rate_limit', resetsAt } })) });
    const first = await s.run();
    expectRefusal(first, s);
    expect(s.dispatcher.state()).toMatchObject({ cooldownUntil: NOW + 600_000, cooldownReason: 'rate_limit' });
    expect(first.retryAfter).toBe(new Date(NOW + 600_000).toISOString());
    s.advance(300_000);
    const inside = await s.run();
    expectRefusal(inside, s);
    expect(inside.cause).toBe('cooldown');
    expect(inside.retryAfter).toBe(new Date(NOW + 600_000).toISOString());
    expect(s.runCli).toHaveBeenCalledTimes(1);
  });
});

describe('keyed fallback (AC9)', () => {
  it('with ANTHROPIC_API_KEY: executeApi called, backendFallback on the result, one backend_fallback emitted only after executeApi was entered, to from the backend that ran', async () => {
    const order = [];
    const s = setup({ probe: probeStub({ ready: false, reason: 'binary_not_found' }), env: { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' }, order });
    s.executeApi.backendId = 'anthropic-test-backend';
    const result = await s.run();
    expect(s.executeApi).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ...API_OK, backendFallback: { from: 'claude-cli', reason: 'unavailable', detail: 'binary_not_found' } });
    const fb = ofSuffix(s.collector, 'backend_fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0].event).toBe('agent.research.backend_fallback');
    expect(fb[0].data.to).toBe('anthropic-test-backend');
    expect(ofSuffix(s.collector, 'backend_refused')).toEqual([]);
    expect(order.indexOf('executeApi:entered')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('executeApi:entered')).toBeLessThan(order.indexOf('event:agent.research.backend_fallback'));
    // Keyed behaviour unchanged: the not-ready probe still opens the 'unavailable' cool-down.
    expect(s.dispatcher.state().cooldownReason).toBe('unavailable');
  });

  it('without a backendId the event names the default API backend, anthropic', async () => {
    const s = setup({ name: 'planner', env: { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' } });
    await s.run();
    expect(ofSuffix(s.collector, 'backend_fallback')[0].data.to).toBe('anthropic');
  });
});
