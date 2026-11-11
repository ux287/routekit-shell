/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC9 (one-shot path).
 * gate, spawnImpl, apiBackend, env and collector are injected, as in
 * claude-cli-oneshot-backend.test.mjs. Every child is a scripted EventEmitter from an INJECTED spawn
 * implementation: the real claude binary never runs, no API is called. Every case passes its env
 * explicitly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createClaudeCliGate } from '../../packages/mcp-rks/src/llm/claude-cli/gate.mjs';
import { createClaudeCliOneShotBackend, MAX_STDIN_BYTES } from '../../packages/mcp-rks/src/llm/claude-cli/oneshot.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const NOW = 1_800_000_000_000;
const jl = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const INIT = { type: 'system', subtype: 'init', mcp_servers: [] };
const FAILED = { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' };
const RATE_LIMITED = jl(INIT, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: NOW / 1000 + 600 } }, FAILED);

function recorder(order = null) {
  const events = [];
  return { events, emit: (event, projectId, data) => { order?.push(`event:${event}`); events.push({ event, projectId, data }); }, flush: async () => {} };
}
function scriptedSpawn(script = {}) {
  const calls = [];
  const impl = (binary, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = (sig) => { setImmediate(() => child.emit('close', null, sig)); return true; };
    calls.push({ binary, args, opts });
    if (!script.hang) {
      setImmediate(() => {
        child.stdout.emit('data', script.stdout ?? '');
        child.emit('close', script.exitCode ?? 0, null);
      });
    }
    return child;
  };
  return { impl, calls };
}
const probeOf = (result) => ({ get: vi.fn(async () => result), invalidate: vi.fn() });
const READY = () => probeOf({ ready: true, authMethod: 'claude.ai', version: '2.1.302' });

function setup({ script, probe, gateOpts = {}, env = {}, timeoutMs = 5_000, order = null } = {}) {
  const probeCache = probe ?? READY();
  const gate = createClaudeCliGate({ probeCache, now: () => NOW, ...gateOpts });
  const spawn = scriptedSpawn(script);
  const collector = recorder(order);
  const apiResult = { content: 'from api', usage: null, usageEmitted: true };
  const apiBackend = {
    id: 'anthropic',
    complete: vi.fn(async () => { order?.push('complete:entered'); return apiResult; }),
    createMessage: vi.fn(),
  };
  const backend = createClaudeCliOneShotBackend({ apiBackend, caller: 'planner', gate, env, spawnImpl: spawn.impl, collector, now: () => NOW, timeoutMs });
  const ofType = (t) => collector.events.filter((e) => e.event === t);
  return { backend, gate, probeCache, spawn, collector, apiBackend, apiResult, ofType };
}
const REQUEST = () => ({ model: MODEL, prompt: 'PROMPT', systemPrompt: 'SYS', context: { projectId: 'proj-1' } });

const SCENARIOS = {
  'not-ready probe': () => ({ probe: probeOf({ ready: false, reason: 'auth_status_failed' }) }),
  cooldown: () => ({ before: (s) => s.gate.openCooldown('rate_limit', 60_000) }),
  busy: () => ({ gateOpts: { maxConcurrent: 1 }, before: (s) => s.gate.tryAcquire() }),
  input_too_large: () => ({ request: { prompt: 'x'.repeat(MAX_STDIN_BYTES + 1) } }),
  timeout: () => ({ script: { hang: true }, timeoutMs: 5 }),
  'cli failure': () => ({ script: { stdout: jl(INIT), exitCode: 1 } }),
};
const NO_KEY_ENVS = [['env {}', () => ({})], ['OPENAI-only env, anthropic apiBackend', () => ({ OPENAI_API_KEY: 'sk-openai-test-not-real' })]];

let errSpy;
afterEach(() => {
  errSpy?.mockRestore();
  errSpy = null;
});
const errLines = () => errSpy.mock.calls.map((c) => String(c[0]));

describe('one-shot, no key for apiBackend provider (AC9)', () => {
  for (const [envLabel, envOf] of NO_KEY_ENVS) {
    it.each(Object.keys(SCENARIOS))(`${envLabel}: %s never calls apiBackend.complete; structured refusal, llm.backend_refused, no llm.backend_fallback, no fell-back line`, async (name) => {
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const opts = SCENARIOS[name]();
      const s = setup({ ...opts, env: envOf() });
      opts.before?.(s);
      const res = await s.backend.complete({ ...REQUEST(), ...(opts.request || {}) });
      expect(s.apiBackend.complete).not.toHaveBeenCalled();
      expect(res.ok).toBe(false);
      expect(res.fallback).toBe('none');
      expect(res.reason).toBe('subscription_unavailable');
      expect(typeof res.message).toBe('string');
      expect('backendFallback' in res).toBe(false);
      if (name === 'not-ready probe') expect(res.probeReason).toBe('auth_status_failed');
      expect(s.ofType('llm.backend_refused')).toHaveLength(1);
      expect(s.ofType('llm.backend_refused')[0].data).toMatchObject({ caller: 'planner', from: 'claude-cli', fallback: 'none' });
      expect(s.ofType('llm.backend_fallback')).toHaveLength(0);
      expect(errLines().filter((l) => l.includes('fell back to'))).toEqual([]);
    });
  }

  it('a not-ready probe opens no unavailable cool-down and invalidates the probe cache', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ probe: probeOf({ ready: false, reason: 'not_subscription_auth' }) });
    await s.backend.complete(REQUEST());
    expect(s.gate.inCooldown()).toBe(false);
    expect(s.gate.state().cooldownReason).toBeNull();
    expect(s.probeCache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('rate_limit keeps its cooldownMsFor cool-down and the refusal carries retryAfter', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup({ script: { stdout: RATE_LIMITED, exitCode: 1 } });
    const res = await s.backend.complete(REQUEST());
    expect(s.gate.state()).toMatchObject({ cooldownUntil: NOW + 600_000, cooldownReason: 'rate_limit' });
    expect(res.cause).toBe('rate_limit');
    expect(res.retryAfter).toBe(new Date(NOW + 600_000).toISOString());
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
  });
});

describe('one-shot, keyed (AC9)', () => {
  it('llm.backend_fallback and the fell-back line come only after apiBackend.complete is entered, with to = apiBackend.id', async () => {
    const order = [];
    errSpy = vi.spyOn(console, 'error').mockImplementation((line) => { order.push(`console:${line}`); });
    const s = setup({ probe: probeOf({ ready: false, reason: 'binary_not_found' }), env: { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' }, order });
    const res = await s.backend.complete(REQUEST());
    expect(s.apiBackend.complete).toHaveBeenCalledTimes(1);
    expect(res).toStrictEqual({ ...s.apiResult, backendFallback: { from: 'claude-cli', to: 'anthropic', reason: 'unavailable' } });
    const fb = s.ofType('llm.backend_fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0].data.to).toBe(s.apiBackend.id);
    expect(s.ofType('llm.backend_refused')).toHaveLength(0);
    const entered = order.indexOf('complete:entered');
    const event = order.indexOf('event:llm.backend_fallback');
    const line = order.findIndex((o) => o.startsWith('console:') && o.includes('fell back to anthropic'));
    expect(entered).toBeGreaterThanOrEqual(0);
    expect(entered).toBeLessThan(event);
    expect(entered).toBeLessThan(line);
    // Keyed behaviour unchanged: the not-ready probe still opens the unavailable cool-down.
    expect(s.gate.state().cooldownReason).toBe('unavailable');
  });
});
