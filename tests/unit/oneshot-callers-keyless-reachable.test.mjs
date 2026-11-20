/**
 * backlog.feat.oneshot-callers-keyless-reachable (AC1-AC5, AC7).
 * Hermetic: no claude binary, no API, no network. The probe is a fake gate, spawn is a throwing
 * spawnImpl, telemetry goes to an injected collector, and loadEnv is stubbed so a developer .env
 * key cannot flip a no-key case. No '@routekit/telemetry' import (see the VERDICTS triage test).
 * The reviewer (server/review.mjs runReview) cases live in tests/unit/llm-backend-reviewer-parity.test.mjs,
 * which already carries that module's project/RAG/child_process harness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ env: {}, resolveImpl: null, actualResolve: null, contextRoot: null }));

// external-research resolves its project root through loadContext; a temp root keeps the real
// registry, the repo's .env and its fetch policy out of these cases.
vi.mock('../../packages/mcp-rks/src/server/project.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadContext: vi.fn(async () => ({ record: { root: h.contextRoot } })) };
});

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadEnv: vi.fn(() => ({ ...h.env })) };
});

// The caller-level seam: the claude-cli vs non-claude-cli outcome is chosen ONLY by the id of the
// backend resolveBackend returns. By default it delegates to the real implementation.
vi.mock('../../packages/mcp-rks/src/llm/backend.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  h.actualResolve = actual.resolveBackend;
  return { ...actual, resolveBackend: vi.fn((opts) => (h.resolveImpl ? h.resolveImpl(opts) : actual.resolveBackend(opts))) };
});

const { createAnthropicBackend } = await import('../../packages/mcp-rks/src/llm/backend.mjs');
const { createClaudeCliOneShotBackend, ONESHOT_SELECTION_KEYS } = await import('../../packages/mcp-rks/src/llm/claude-cli/oneshot.mjs');
const { runLlmPlanner } = await import('../../packages/mcp-rks/src/llm/planner.mjs');
const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');
const { runExternalResearch } = await import('../../packages/mcp-rks/src/agents/external-research.mjs');
const { runReviewerMode } = await import('../../packages/mcp-rks/src/llm/reviewer.mjs');

const NO_KEY_ENV = Object.freeze({ provider: null, model: 'claude-sonnet-test', anthropicKey: null, openaiKey: null });
const CLEARED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ROUTEKIT_LLM_PROVIDER', 'BRAVE_SEARCH_API_KEY', 'RKS_SUBSCRIPTION_CREDENTIAL', 'RKS_SKIP_LLM'];
const NOT_READY = Object.freeze({ ready: false, authMethod: null, version: null, reason: 'binary_not_found' });

const roots = [];
function rootWith(agentKeys) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rks-oneshot-keyless-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  const body = agentKeys.map((k) => `  ${k}:\n    backend: claude-cli\n`).join('');
  fs.writeFileSync(path.join(root, '.rks', 'agents.yaml'), `agents:\n${body}`);
  return root;
}

function fakeOneShot(content) {
  return {
    id: 'claude-cli',
    fallbackBackend: { id: 'anthropic' },
    capabilities: Object.freeze({ toolUse: false, vision: false, promptCacheControl: false, perTurnUsage: false }),
    createMessage: vi.fn(async () => { throw new Error('createMessage must not be called'); }),
    complete: vi.fn(async () => ({ content, usage: null, usageEmitted: true })),
  };
}
function fakeApiOnly() {
  return {
    id: 'anthropic',
    capabilities: Object.freeze({ toolUse: true, vision: true, promptCacheControl: true, perTurnUsage: true }),
    createMessage: vi.fn(async () => { throw new Error('API must not be called'); }),
    complete: vi.fn(async () => { throw new Error('API must not be called'); }),
  };
}

/** A gate whose probe is not ready: the one-shot must refuse before any spawn. */
function notReadyGate() {
  return {
    now: () => Date.now(),
    cooldownMs: 60_000,
    inCooldown: () => false,
    state: () => ({ cooldownUntil: null }),
    openCooldown: vi.fn(),
    tryAcquire: vi.fn(() => true),
    release: vi.fn(),
    probeCache: { get: vi.fn(async () => NOT_READY), invalidate: vi.fn(), probedAt: () => null },
  };
}
function refusingOneShot(caller, collector, spawnImpl) {
  const apiBackend = createAnthropicBackend({ env: NO_KEY_ENV });
  vi.spyOn(apiBackend, 'complete');
  const backend = createClaudeCliOneShotBackend({
    apiBackend, caller, gate: notReadyGate(), env: {}, spawnImpl, timeoutMs: 5_000, collector,
  });
  vi.spyOn(backend, 'complete');
  return { backend, apiBackend };
}
function expectRefused(outcome, collector, spawnImpl, apiBackend, backend) {
  const text = JSON.stringify(outcome);
  expect(text).toContain('subscription_unavailable');
  const events = collector.emit.mock.calls.map((c) => c[0]);
  expect(events.filter((e) => e === 'llm.backend_refused')).toHaveLength(1);
  expect(events).not.toContain('llm.backend_fallback');
  expect(spawnImpl).not.toHaveBeenCalled();
  expect(apiBackend.complete).not.toHaveBeenCalled();
  // The caller does not retry or reprompt a refusal.
  expect(backend.complete).toHaveBeenCalledTimes(1);
}

let saved;
beforeEach(() => {
  saved = Object.fromEntries(CLEARED.map((k) => [k, process.env[k]]));
  for (const k of CLEARED) delete process.env[k];
  vi.stubEnv('RKS_RESEARCH_BACKEND', '');
  h.env = { ...NO_KEY_ENV };
  h.resolveImpl = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('resolveBackend with no API key (AC3)', () => {
  it.each(Object.keys(ONESHOT_SELECTION_KEYS))('%s opted in to claude-cli resolves the one-shot instead of throwing', (caller) => {
    const projectRoot = rootWith([ONESHOT_SELECTION_KEYS[caller]]);
    const backend = h.actualResolve({ env: NO_KEY_ENV, caller, projectRoot });
    expect(backend.id).toBe('claude-cli');
    expect(backend.fallbackBackend.id).toBe('anthropic');
  });

  it('a caller that is not opted in still throws the Unsupported provider error for a null provider', () => {
    expect(() => h.actualResolve({ env: NO_KEY_ENV, caller: 'planner', projectRoot: rootWith(['research']) }))
      .toThrow(new Error('Unsupported provider: null'));
    expect(() => h.actualResolve({ env: NO_KEY_ENV, caller: 'visual', projectRoot: rootWith(['llm-planner']) }))
      .toThrow(new Error('Unsupported provider: null'));
  });

  it('an explicit unsupported provider still throws, even for an opted-in caller', () => {
    expect(() => h.actualResolve({ env: { ...NO_KEY_ENV, provider: 'google' }, caller: 'planner', projectRoot: rootWith(['llm-planner']) }))
      .toThrow(new Error('Unsupported provider: google'));
  });
});

describe('planner (AC1, AC2, AC4)', () => {
  const PLAN = JSON.stringify({ planSummary: 'keyless plan', steps: [] });
  const run = () => runLlmPlanner({ requirements: 'r', fullRequirements: 'r', context: '', editableTargets: [], contextualRefs: [], useReplay: false });

  it('no key + claude-cli: reaches the one-shot and never returns no_api_key', async () => {
    const backend = fakeOneShot(PLAN);
    h.resolveImpl = () => backend;
    const result = await run();
    expect(result?.error).not.toBe('no_api_key');
    expect(backend.complete).toHaveBeenCalled();
  });

  it('no key + not claude-cli: no_api_key exactly as today, no backend call', async () => {
    const api = fakeApiOnly();
    h.resolveImpl = () => api;
    const result = await run();
    expect(result).toMatchObject({
      status: 'error',
      error: 'no_api_key',
      errorMessage: 'No API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env',
      actions: [],
    });
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('guard placement: no key and a resolveBackend that throws resolves to no_api_key and does not throw', async () => {
    h.resolveImpl = () => { throw new Error('Unsupported provider: null'); };
    await expect(run()).resolves.toMatchObject({ status: 'error', error: 'no_api_key', actions: [] });
    h.resolveImpl = null;
    h.env = { ...NO_KEY_ENV, provider: 'google' }; // the real resolveBackend throws for it
    await expect(run()).resolves.toMatchObject({ status: 'error', error: 'no_api_key', actions: [] });
  });

  it('no key + a claude-cli one-shot that cannot run: structured refusal, never a fallback', async () => {
    const collector = { emit: vi.fn() };
    const spawnImpl = vi.fn(() => { throw new Error('must not spawn'); });
    const { backend, apiBackend } = refusingOneShot('planner', collector, spawnImpl);
    h.resolveImpl = () => backend;
    const result = await run();
    expectRefused(result, collector, spawnImpl, apiBackend, backend);
    expect(result).toMatchObject({
      status: 'error',
      error: 'subscription_unavailable',
      reason: 'subscription_unavailable',
      fallback: 'none',
      probeReason: 'binary_not_found',
      actions: [],
    });
    expect(result.errorMessage).toContain('could not run on the Claude subscription');
  });
});

describe('qa-agent (AC1, AC2, AC4)', () => {
  const args = { plan: 'p', tddApplicable: 'weak', testCode: 't', implementationCode: 'i', projectId: null };

  it('no key + claude-cli: reaches the one-shot and does not fail on the API key', async () => {
    const backend = fakeOneShot(JSON.stringify({ verdict: 'pass', exploitableGaps: [] }));
    h.resolveImpl = () => backend;
    const res = await runQaAgentReview(args);
    expect(backend.complete).toHaveBeenCalled();
    expect(String(res?.error ?? '')).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(res).toMatchObject({ ok: true, verdict: 'pass', blocked: false });
  });

  it('no key + not claude-cli: ok false, blocked false, error names ANTHROPIC_API_KEY and no secret-shaped value', async () => {
    const api = fakeApiOnly();
    h.resolveImpl = () => api;
    const res = await runQaAgentReview(args);
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(false);
    expect(res.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(res.error).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/);
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('no key + a claude-cli one-shot that cannot run: structured refusal, never a fallback, never ok:true', async () => {
    const collector = { emit: vi.fn() };
    const spawnImpl = vi.fn(() => { throw new Error('must not spawn'); });
    const { backend, apiBackend } = refusingOneShot('qa-agent', collector, spawnImpl);
    h.resolveImpl = () => backend;
    const res = await runQaAgentReview(args);
    expectRefused(res, collector, spawnImpl, apiBackend, backend);
    expect(res).toMatchObject({
      ok: false,
      blocked: false,
      reason: 'subscription_unavailable',
      fallback: 'none',
      probeReason: 'binary_not_found',
    });
    expect(res.error).toContain('could not run on the Claude subscription');
    expect(res).not.toHaveProperty('verdict');
  });
});

describe('external-research synthesis (AC1, AC2, AC4)', () => {
  const input = { projectId: 'routekit-shell-core', query: 'keyless synthesis query' };
  const searchFn = vi.fn(async () => [{ title: 't', url: 'https://example.test/a', snippet: 's' }]);
  const settle = (p) => p.catch((e) => ({ thrown: e?.message }));
  // An injected collector, so no agent.external-research telemetry is written under the repo.
  const erDeps = (extra) => ({ collector: { emit: vi.fn() }, ...extra });
  beforeEach(() => { h.contextRoot = rootWith([]); });

  it('no key + claude-cli: the default synthesis reaches the one-shot', async () => {
    const backend = fakeOneShot('A synthesized answer.');
    h.resolveImpl = () => backend;
    const out = await settle(runExternalResearch(input, erDeps({ searchFn })));
    expect(backend.complete).toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('No ANTHROPIC_API_KEY configured for synthesis.');
    expect(out.ok).toBe(true);
  });

  it('no key + not claude-cli: the synthesis key error as today', async () => {
    h.resolveImpl = () => fakeApiOnly();
    const out = await settle(runExternalResearch(input, erDeps({ searchFn })));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('No ANTHROPIC_API_KEY configured for synthesis.');
    expect(out).not.toHaveProperty('reason');
  });

  it('the Brave key is still required separately', async () => {
    h.resolveImpl = () => fakeOneShot('unused');
    const out = await settle(runExternalResearch(input, erDeps({ synthesizeFn: async () => 'unused' })));
    expect(JSON.stringify(out)).toContain('BRAVE_SEARCH_API_KEY');
  });

  it('no key + a claude-cli one-shot that cannot run: structured refusal, never a fallback, never an ok empty answer', async () => {
    const collector = { emit: vi.fn() };
    const spawnImpl = vi.fn(() => { throw new Error('must not spawn'); });
    const { backend, apiBackend } = refusingOneShot('external-research', collector, spawnImpl);
    h.resolveImpl = () => backend;
    const out = await settle(runExternalResearch(input, erDeps({ searchFn })));
    expectRefused(out, collector, spawnImpl, apiBackend, backend);
    expect(out).toMatchObject({
      ok: false,
      answer: '',
      sources: [],
      reason: 'subscription_unavailable',
      fallback: 'none',
      probeReason: 'binary_not_found',
    });
    expect(typeof out.telemetryId).toBe('string');
    expect(out.error).toContain('could not run on the Claude subscription');
  });
});

describe('llm/reviewer.mjs completeness check (AC5)', () => {
  function fixture() {
    const root = rootWith([]);
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const a = 1;\n');
    const storyContent = '### a.mjs\n@@SEARCH\nexport const a = 1;\n@@REPLACE\nexport const a = 2;\n@@END\n';
    return { projectRoot: root, storyContent, targetFiles: [{ path: 'a.mjs', op: 'edit' }] };
  }

  it('no key: reports the check as skipped with a reason instead of null', async () => {
    const res = await runReviewerMode({ ...fixture(), checkCompleteness: true });
    expect(res.completenessCheck).toMatchObject({ checked: false, skipped: 'no_api_key' });
    expect(String(res.completenessCheck.reason || '')).not.toBe('');
  });

  it('with a key: the existing value is unchanged', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-real');
    const res = await runReviewerMode({ ...fixture(), checkCompleteness: true });
    expect(res.completenessCheck).toEqual({ checked: false, reason: 'LLM completeness check not yet implemented' });
  });

  it('checkCompleteness false: null, as today', async () => {
    const res = await runReviewerMode({ ...fixture(), checkCompleteness: false });
    expect(res.completenessCheck).toBeNull();
  });
});
