/**
 * backlog.feat.claude-cli-oneshot-backend: the shared claude -p transport (llm/claude-cli/transport.mjs)
 * and the process-wide gate (llm/claude-cli/gate.mjs). Re-export identity, gate semantics, and one
 * cool-down shared by the research dispatcher and the one-shot backend.
 * Deterministic: injected clock, probe stub, API stub, collector and a scripted EventEmitter child
 * from an INJECTED spawn implementation. Never runs the real claude binary; no spawn-family call.
 * Tier: npm run test:unit
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import * as transport from '../../packages/mcp-rks/src/llm/claude-cli/transport.mjs';
import * as gateMod from '../../packages/mcp-rks/src/llm/claude-cli/gate.mjs';
import * as executor from '../../packages/mcp-rks/src/agents/executors/claude-cli.mjs';
import * as dispatch from '../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';
import { createClaudeCliOneShotBackend } from '../../packages/mcp-rks/src/llm/claude-cli/oneshot.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = 'claude-haiku-4-5-20251001';
const NOW = 1_800_000_000_000;
const jl = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const RATE_LIMITED = jl(
  { type: 'system', subtype: 'init', mcp_servers: [] },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: NOW / 1000 + 600 } },
  { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' },
);

function recorder() {
  const events = [];
  return { events, emit: (event, projectId, data) => { events.push({ event, projectId, data }); }, flush: async () => {} };
}
function probeStub(result = { ready: true, authMethod: 'claude.ai', version: '2.1.302' }) {
  return { get: vi.fn(async () => result), invalidate: vi.fn() };
}
function apiStub() {
  return { id: 'anthropic', complete: vi.fn(async () => ({ content: 'api', usage: null, usageEmitted: true })), createMessage: vi.fn() };
}
function scriptedChild(stdout, exitCode = 0) {
  const calls = [];
  const impl = (binary, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => true;
    calls.push({ binary, args, opts });
    setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', exitCode, null); });
    return child;
  };
  return { impl, calls };
}
const researchConfig = () => ({ name: 'research', projectId: 'proj-gate', model: MODEL, prompt: 'P', _testCollector: recorder() });
const REQUEST = () => ({ model: MODEL, prompt: 'hi', context: { projectId: 'proj-gate' } });
// The cool-down fallbacks below reach the API only with ANTHROPIC_API_KEY
// (backlog.feat.keyless-backend-aware-credential-presence), so each passes one explicitly.
const keyed = () => ({ ANTHROPIC_API_KEY: 'sk-ant-test-not-real' });

afterEach(() => {
  vi.unstubAllEnvs();
  gateMod.resetDefaultClaudeCliGate();
  dispatch.resetDefaultBackendDispatcher();
});

describe('transport.mjs is the single home of the moved helpers', () => {
  it('exports the moved helpers and the executor re-exports the identical functions', () => {
    for (const name of ['runChild', 'parseStreamJson', 'mapUsage', 'isRateLimited', 'summarizeRateLimit']) {
      expect(typeof transport[name], name).toBe('function');
      expect(executor[name], name).toBe(transport[name]);
    }
  });

  it('parseStreamJson is the post-rate-limit form', () => {
    expect(transport.parseStreamJson('')).toStrictEqual({ init: null, retries: [], result: null, rateLimit: null, malformedLines: 0 });
    expect(transport.parseStreamJson(RATE_LIMITED).rateLimit).toEqual({ status: 'rejected', resetsAt: NOW / 1000 + 600 });
  });
});

describe('gate.mjs', () => {
  it('owns the cool-down sizing exports and backend-dispatch re-exports the identical values', () => {
    for (const name of ['cooldownMsFor', 'DEFAULT_COOLDOWN_MS', 'MAX_RATE_LIMIT_COOLDOWN_MS', 'COOLDOWN_REASONS']) {
      expect(gateMod[name], name).toBeDefined();
      expect(dispatch[name], name).toBe(gateMod[name]);
    }
  });

  it('getDefaultClaudeCliGate is a lazy singleton, reset yields a new one, and construction never probes', () => {
    const a = gateMod.getDefaultClaudeCliGate();
    expect(gateMod.getDefaultClaudeCliGate()).toBe(a);
    gateMod.resetDefaultClaudeCliGate();
    expect(gateMod.getDefaultClaudeCliGate()).not.toBe(a);
    const probe = probeStub();
    gateMod.createClaudeCliGate({ probeCache: probe });
    expect(probe.get).not.toHaveBeenCalled();
  });

  it('cool-down follows the injected clock and state() keeps its shape', () => {
    let t = NOW;
    const g = gateMod.createClaudeCliGate({ probeCache: probeStub(), now: () => t });
    expect(g.state()).toStrictEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
    g.openCooldown('rate_limit', 60_000);
    expect(g.inCooldown()).toBe(true);
    expect(g.state()).toStrictEqual({ cooldownUntil: NOW + 60_000, cooldownReason: 'rate_limit', inFlight: 0 });
    t = NOW + 60_000;
    expect(g.inCooldown()).toBe(false);
  });

  it('tryAcquire honours maxConcurrent and release never goes below zero', () => {
    const g = gateMod.createClaudeCliGate({ probeCache: probeStub(), maxConcurrent: 1 });
    expect(g.tryAcquire()).toBe(true);
    expect(g.tryAcquire()).toBe(false);
    g.release();
    g.release();
    expect(g.state().inFlight).toBe(0);
  });
});

describe('one gate, two paths', () => {
  function dispatcherOn(gate, runCli) {
    const d = dispatch.createBackendDispatcher({ gate, runCli, env: keyed() });
    const executeApi = vi.fn(async () => ({ ok: true, answer: 'api' }));
    return { d, executeApi, run: () => d.execute(researchConfig(), { executeApi, systemText: 'S' }) };
  }

  it('a rate limit seen by the research dispatcher makes the one-shot fall back with cooldown', async () => {
    const gate = gateMod.createClaudeCliGate({ probeCache: probeStub(), now: () => NOW });
    const runCli = vi.fn(async () => ({ ok: false, error: 'rate limited', backendFailure: { reason: 'rate_limit' } }));
    await dispatcherOn(gate, runCli).run();
    expect(gate.inCooldown()).toBe(true);
    const child = scriptedChild('');
    const collector = recorder();
    const api = apiStub();
    const oneshot = createClaudeCliOneShotBackend({ apiBackend: api, caller: 'planner', gate, env: keyed(), spawnImpl: child.impl, collector, now: () => NOW });
    await oneshot.complete(REQUEST());
    expect(child.calls).toHaveLength(0);
    expect(api.complete).toHaveBeenCalledTimes(1);
    expect(collector.events.filter((e) => e.event === 'llm.backend_fallback').map((e) => e.data.reason)).toEqual(['cooldown']);
  });

  it('a rate limit seen by the one-shot makes the research dispatcher fall back with cooldown, sized by resetsAt', async () => {
    const gate = gateMod.createClaudeCliGate({ probeCache: probeStub(), now: () => NOW });
    const child = scriptedChild(RATE_LIMITED, 1);
    const oneshot = createClaudeCliOneShotBackend({ apiBackend: apiStub(), caller: 'planner', gate, env: keyed(), spawnImpl: child.impl, collector: recorder(), now: () => NOW });
    await oneshot.complete(REQUEST());
    expect(gate.state().cooldownUntil).toBe(NOW + 600_000);
    const runCli = vi.fn();
    const { run, executeApi } = dispatcherOn(gate, runCli);
    const res = await run();
    expect(runCli).not.toHaveBeenCalled();
    expect(executeApi).toHaveBeenCalledTimes(1);
    expect(res.backendFallback.reason).toBe('cooldown');
  });

  it('dispatchers built with injected parameters and no gate keep private cool-down state', async () => {
    const runCli = vi.fn(async () => ({ ok: false, error: 'rate limited', backendFailure: { reason: 'rate_limit' } }));
    const executeApi = vi.fn(async () => ({ ok: true }));
    const a = dispatch.createBackendDispatcher({ probeCache: probeStub(), runCli, now: () => NOW, env: keyed() });
    const b = dispatch.createBackendDispatcher({ probeCache: probeStub(), runCli, now: () => NOW, env: keyed() });
    await a.execute(researchConfig(), { executeApi, systemText: 'S' });
    expect(a.state().cooldownReason).toBe('rate_limit');
    expect(b.state()).toStrictEqual({ cooldownUntil: 0, cooldownReason: null, inFlight: 0 });
    expect(gateMod.getDefaultClaudeCliGate().inCooldown()).toBe(false);
  });

  it('the default dispatcher and a one-shot built without a gate share getDefaultClaudeCliGate()', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-not-real'); // the default dispatcher reads process.env
    gateMod.getDefaultClaudeCliGate().openCooldown('rate_limit', 60_000);
    const executeApi = vi.fn(async () => ({ ok: true }));
    const res = await dispatch.getDefaultBackendDispatcher().execute(researchConfig(), { executeApi, systemText: 'S' });
    expect(res.backendFallback.reason).toBe('cooldown');
    const child = scriptedChild('');
    const collector = recorder();
    await createClaudeCliOneShotBackend({ apiBackend: apiStub(), caller: 'planner', env: keyed(), spawnImpl: child.impl, collector }).complete(REQUEST());
    expect(child.calls).toHaveLength(0);
    expect(collector.events.find((e) => e.event === 'llm.backend_fallback').data.reason).toBe('cooldown');
  });
});

describe('tripwire needles', () => {
  it('no new module mentions the server, the executor module or the dispatcher, comments included', () => {
    // Positive control: the scan reads real source and finds a needle where one is known to be.
    expect(fs.readFileSync(path.join(REPO, 'packages/mcp-rks/src/agents/executors/backend-dispatch.mjs'), 'utf8')).toContain('claude-cli.mjs');
    for (const rel of [
      'packages/mcp-rks/src/llm/claude-cli/transport.mjs',
      'packages/mcp-rks/src/llm/claude-cli/gate.mjs',
      'packages/mcp-rks/src/llm/claude-cli/oneshot.mjs',
      'packages/mcp-rks/src/llm/backend.mjs',
    ]) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      for (const needle of ['agent-tools-mcp-server', 'claude-cli.mjs', 'backend-dispatch']) {
        expect(src.includes(needle), `${rel} mentions ${needle}`).toBe(false);
      }
    }
  });
});
