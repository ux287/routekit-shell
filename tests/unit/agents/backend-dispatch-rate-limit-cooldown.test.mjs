/**
 * backlog.feat.claude-cli-rate-limit-event: resetsAt-sized rate-limit cool-down in
 * packages/mcp-rks/src/agents/executors/backend-dispatch.mjs (cooldownMsFor,
 * MAX_RATE_LIMIT_COOLDOWN_MS, openCooldown duration).
 *
 * Unit tier. Deterministic: probeCache, runCli, now, env, executeApi and the telemetry collector
 * (config._testCollector) are all injected. No claude binary is started, no subprocess is created
 * and no LLM is called. The file does not quote the globally mocked telemetry specifier.
 *
 * resetsAt is epoch SECONDS: inferred from one observed claude 2.1.302 rate_limit_event line, not
 * documented. The runCli doubles return backendFailure.resetsAt, the shape the executor returns after
 * this story for an ASSUMED "rejected" status (third-party-reported, not observed locally; allowed and
 * allowed_warning failures carry no resetsAt).
 *
 * Kept separate from backend-dispatch.test.mjs so backlog.feat.claude-cli-oneshot-backend can
 * relocate it together with the cool-down if that story moves it into llm/claude-cli/gate.mjs.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createBackendDispatcher,
  cooldownMsFor,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MS,
  COOLDOWN_REASONS,
} from '../../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const READY = Object.freeze({ ready: true, authMethod: 'claude.ai', version: '2.1.302', reason: null });
const API_OK = Object.freeze({ ok: true, answer: 'from-api', telemetryId: 'tid-api' });

const NOW = 1_792_350_000_000; // epoch ms, 90 minutes before RESETS_AT
const RESETS_AT = 1792355400; // epoch SECONDS: five_hour resetsAt of the observed line
const SEVEN_DAY_RESETS_AT = 1792526400; // seven_day resetsAt of the same line, about 49 h after NOW
const IN_WINDOW_MS = RESETS_AT * 1000 - NOW;

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

function probeStub(result = READY) {
  const stub = { result };
  stub.get = vi.fn(async () => stub.result);
  stub.invalidate = vi.fn();
  return stub;
}

function setup({ runCli, probe = probeStub(), cooldownMs } = {}) {
  let t = NOW;
  const now = () => t;
  const advance = (ms) => {
    t += ms;
  };
  const collector = recorder();
  const opts = { probeCache: probe, runCli, now, env: {} };
  if (cooldownMs !== undefined) opts.cooldownMs = cooldownMs;
  const dispatcher = createBackendDispatcher(opts);
  const config = { name: 'research', projectId: 'proj-rl', model: MODEL, prompt: 'P', _testCollector: collector };
  const executeApi = vi.fn(async () => API_OK);
  const run = () => dispatcher.execute(config, { executeApi, systemText: 'S' });
  return { dispatcher, collector, executeApi, probe, run, advance };
}

const failingCli = (backendFailure) =>
  vi.fn(async () => ({ ok: false, error: `cli failed: ${backendFailure.reason}`, backendFailure }));
const fallbackEvents = (collector) => collector.events.filter((e) => e.event.endsWith('.backend_fallback'));

describe('constants', () => {
  it('MAX_RATE_LIMIT_COOLDOWN_MS is 6 hours; the default cool-down and COOLDOWN_REASONS are unchanged', () => {
    expect(MAX_RATE_LIMIT_COOLDOWN_MS).toBe(6 * 60 * 60_000);
    expect(DEFAULT_COOLDOWN_MS).toBe(15 * 60_000);
    expect([...COOLDOWN_REASONS].sort()).toEqual(['auth', 'rate_limit', 'unavailable']);
    expect(Object.isFrozen(COOLDOWN_REASONS)).toBe(true);
  });

  it('the fixture clock places the observed five_hour reset 90 minutes ahead', () => {
    expect(IN_WINDOW_MS).toBe(90 * 60_000);
  });
});

describe('cooldownMsFor', () => {
  it('a future resetsAt on rate_limit sizes the cool-down to the time remaining', () => {
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: RESETS_AT }, NOW)).toBe(IN_WINDOW_MS);
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: NOW / 1000 + 1 }, NOW)).toBe(1000);
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: NOW / 1000 + 60 }, NOW, 15 * 60_000)).toBe(60_000);
  });

  it('caps at MAX_RATE_LIMIT_COOLDOWN_MS', () => {
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: SEVEN_DAY_RESETS_AT }, NOW)).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
    const atCap = (NOW + MAX_RATE_LIMIT_COOLDOWN_MS) / 1000;
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: atCap }, NOW)).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: atCap + 1 }, NOW)).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
    expect(cooldownMsFor({ reason: 'rate_limit', resetsAt: atCap - 1 }, NOW)).toBe(MAX_RATE_LIMIT_COOLDOWN_MS - 1000);
  });

  it.each([
    ['rate_limit without resetsAt', { reason: 'rate_limit' }],
    ['rate_limit with a null resetsAt', { reason: 'rate_limit', resetsAt: null }],
    ['rate_limit with a NaN resetsAt', { reason: 'rate_limit', resetsAt: Number.NaN }],
    ['rate_limit with an Infinity resetsAt', { reason: 'rate_limit', resetsAt: Infinity }],
    ['rate_limit with a string resetsAt', { reason: 'rate_limit', resetsAt: String(RESETS_AT) }],
    ['rate_limit with a past resetsAt', { reason: 'rate_limit', resetsAt: NOW / 1000 - 60 }],
    ['rate_limit with resetsAt equal to now', { reason: 'rate_limit', resetsAt: NOW / 1000 }],
    ['auth with a future resetsAt', { reason: 'auth', resetsAt: RESETS_AT }],
    ['unavailable with a future resetsAt', { reason: 'unavailable', resetsAt: RESETS_AT }],
    ['a null failure', null],
    ['an undefined failure', undefined],
  ])('%s returns the default', (_label, failure) => {
    expect(cooldownMsFor(failure, NOW)).toBe(DEFAULT_COOLDOWN_MS);
    expect(cooldownMsFor(failure, NOW, 60_000)).toBe(60_000);
  });
});

describe('dispatcher: resetsAt-sized rate-limit cool-down', () => {
  it('rate_limit with a future resetsAt cools down until resetsAt; fallback shapes are unchanged', async () => {
    const runCli = failingCli({ reason: 'rate_limit', resetsAt: RESETS_AT });
    const s = setup({ runCli });
    const result = await s.run();
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: NOW + IN_WINDOW_MS, cooldownReason: 'rate_limit', inFlight: 0 });
    expect(result).toEqual({ ...API_OK, backendFallback: { from: 'claude-cli', reason: 'rate_limit' } });
    expect(s.executeApi.mock.calls[0][0]._backendFallback).toEqual({ from: 'claude-cli', reason: 'rate_limit' });
    const ev = fallbackEvents(s.collector);
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toEqual({ from: 'claude-cli', to: 'anthropic', reason: 'rate_limit', model: MODEL });

    s.advance(DEFAULT_COOLDOWN_MS); // past the 15-minute default, still inside the sized window
    expect((await s.run()).backendFallback).toEqual({ from: 'claude-cli', reason: 'cooldown', detail: 'rate_limit' });
    s.advance(IN_WINDOW_MS - DEFAULT_COOLDOWN_MS - 1);
    expect((await s.run()).backendFallback.reason).toBe('cooldown');
    expect(runCli).toHaveBeenCalledTimes(1);
    s.advance(1);
    await s.run();
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it('a resetsAt sooner than the default shortens the cool-down', async () => {
    const s = setup({ runCli: failingCli({ reason: 'rate_limit', resetsAt: NOW / 1000 + 60 }) });
    await s.run();
    expect(s.dispatcher.state().cooldownUntil).toBe(NOW + 60_000);
  });

  it('a resetsAt beyond the cap is clamped to MAX_RATE_LIMIT_COOLDOWN_MS', async () => {
    const s = setup({ runCli: failingCli({ reason: 'rate_limit', resetsAt: SEVEN_DAY_RESETS_AT }) });
    await s.run();
    expect(s.dispatcher.state().cooldownUntil).toBe(NOW + MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it('rate_limit without resetsAt keeps the 15-minute default, or the injected cooldownMs', async () => {
    const d = setup({ runCli: failingCli({ reason: 'rate_limit' }) });
    await d.run();
    expect(d.dispatcher.state()).toEqual({ cooldownUntil: NOW + DEFAULT_COOLDOWN_MS, cooldownReason: 'rate_limit', inFlight: 0 });
    const i = setup({ runCli: failingCli({ reason: 'rate_limit' }), cooldownMs: 60_000 });
    await i.run();
    expect(i.dispatcher.state().cooldownUntil).toBe(NOW + 60_000);
  });

  it('a past resetsAt falls back to cooldownMs', async () => {
    const s = setup({ runCli: failingCli({ reason: 'rate_limit', resetsAt: NOW / 1000 - 60 }), cooldownMs: 60_000 });
    await s.run();
    expect(s.dispatcher.state().cooldownUntil).toBe(NOW + 60_000);
  });

  it('auth with a resetsAt is not sized: cooldownMs applies and the probe is invalidated', async () => {
    const s = setup({ runCli: failingCli({ reason: 'auth', resetsAt: RESETS_AT }), cooldownMs: 60_000 });
    const result = await s.run();
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: NOW + 60_000, cooldownReason: 'auth', inFlight: 0 });
    expect(s.probe.invalidate).toHaveBeenCalledTimes(1);
    expect(result.backendFallback).toEqual({ from: 'claude-cli', reason: 'auth' });
  });

  it('a non-cool-down reason carrying resetsAt opens no cool-down', async () => {
    const s = setup({ runCli: failingCli({ reason: 'overloaded', resetsAt: RESETS_AT }) });
    await s.run();
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
  });

  it('the probe-unavailable cool-down keeps cooldownMs', async () => {
    const s = setup({
      runCli: failingCli({ reason: 'rate_limit', resetsAt: RESETS_AT }),
      probe: probeStub({ ready: false, reason: 'not_installed' }),
      cooldownMs: 60_000,
    });
    await s.run();
    expect(s.dispatcher.state()).toEqual({ cooldownUntil: NOW + 60_000, cooldownReason: 'unavailable', inFlight: 0 });
  });
});
