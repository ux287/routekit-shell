/**
 * backlog.feat.agent-backend-selection-research: backend selection in runAgent and config.mjs,
 * the research config hand-off, and D1 end to end through runAgent.
 *
 * Unit tier. Deterministic: agents.yaml lives in a temp project root, env is stubbed per test, the
 * dispatcher (config._backendDispatcher) and the collector (config._testCollector) are injected,
 * and API-path runs complete through shortCircuit or an injected _testClient. No claude binary, no
 * subprocess, no LLM call. ANTHROPIC_API_KEY is stubbed empty so any unexpected SDK path fails at
 * the credential guard instead of calling out.
 *
 * The vitest guard: runAgent takes the API path under vitest unless a _backendDispatcher is
 * injected. Every dispatch assertion injects one, no dispatch test injects _testClient, and the
 * opt-in block asserts process.env.VITEST is set, so the guard is not what makes them pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runAgent } from '../../../packages/mcp-rks/src/agents/runner.mjs';
import {
  AGENT_BACKENDS,
  resolveAgentBackend,
  loadAgentConfig,
  clearConfigCache,
} from '../../../packages/mcp-rks/src/agents/config.mjs';
import { createResearchAgent, ResearchOutputSchema } from '../../../packages/mcp-rks/src/agents/research.mjs';
import { createBackendDispatcher } from '../../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';
const PROMPT = 'You are the backend-selection test prompt.';
const STARTED_KEYS = ['inputSummary', 'maxTurns', 'model', 'telemetryId', 'toolCount'];
const SHORT_COMPLETE_KEYS = ['durationMs', 'model', 'outputSummary', 'shortCircuit', 'telemetryId', 'turns'];
const LLM_COMPLETE_KEYS = ['durationMs', 'model', 'outputSummary', 'telemetryId', 'tokens', 'turns'];

const roots = [];
function writeYaml(root, yaml) {
  fs.writeFileSync(path.join(root, '.rks', 'agents.yaml'), yaml, 'utf8');
}
function projectRoot(yaml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-backend-sel-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  if (yaml !== undefined) writeYaml(root, yaml);
  return root;
}
function yamlFor(agent, props) {
  const lines = Object.entries(props).map(([k, v]) => `    ${k}: ${v}`);
  return ['agents:', `  ${agent}:`, ...lines, ''].join('\n');
}
const OPT_IN = yamlFor('research', { model: HAIKU, backend: 'claude-cli' });

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

function baseConfig(root, extra = {}) {
  return {
    name: 'research',
    prompt: PROMPT,
    userMessage: 'question',
    tools: [],
    inputSchema: z.object({ q: z.string() }),
    rawInput: { q: 'question' },
    projectId: 'proj-sel',
    projectRoot: root,
    model: HAIKU,
    ...extra,
  };
}

const shortCircuitSpy = () => vi.fn(async () => ({ answer: 'from-api-path' }));

function spyDispatcher(script = () => ({ ok: true, answer: 'from-dispatcher', telemetryId: 'tid-d' })) {
  const calls = [];
  const execute = vi.fn(async (config, opts) => {
    calls.push({ config, opts });
    return script(calls.length, config, opts);
  });
  return { execute, calls };
}

const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
function capturingClient(text = '{"ok":true,"answer":"llm"}') {
  const systems = [];
  const create = vi.fn(async (args) => {
    systems.push(args.system[args.system.length - 1].text);
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
  });
  return { client: { messages: { create } }, create, systems };
}

const sortedKeys = (o) => Object.keys(o).sort();
const ofType = (collector, suffix) => collector.events.filter((e) => e.event === `agent.research.${suffix}`);

beforeEach(() => {
  for (const key of ['RKS_RESEARCH_BACKEND', 'RKS_PO_BACKEND', 'RKS_PLANNER_BACKEND', 'RKS_RESEARCH_MODEL', 'ANTHROPIC_API_KEY']) {
    vi.stubEnv(key, '');
  }
  clearConfigCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  clearConfigCache();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('resolveAgentBackend (config.mjs)', () => {
  it('AGENT_BACKENDS is anthropic and claude-cli', () => {
    expect([...AGENT_BACKENDS]).toEqual(['anthropic', 'claude-cli']);
  });

  it('defaults to anthropic with no agents.yaml, with no backend key, and with no projectRoot', () => {
    expect(resolveAgentBackend('research', projectRoot())).toBe('anthropic');
    expect(resolveAgentBackend('research', projectRoot(yamlFor('research', { model: HAIKU })))).toBe('anthropic');
    expect(resolveAgentBackend('research', undefined)).toBe('anthropic');
  });

  it('agents.yaml backend claude-cli selects claude-cli; an unknown value such as gpt resolves to anthropic', () => {
    expect(resolveAgentBackend('research', projectRoot(OPT_IN))).toBe('claude-cli');
    expect(resolveAgentBackend('research', projectRoot(yamlFor('research', { backend: 'gpt' })))).toBe('anthropic');
  });

  it('the yaml value is per agent: another agent opted in does not opt research in', () => {
    const root = projectRoot(yamlFor('planner', { backend: 'claude-cli' }));
    expect(resolveAgentBackend('research', root)).toBe('anthropic');
    expect(resolveAgentBackend('planner', root)).toBe('claude-cli');
  });

  it('RKS_RESEARCH_BACKEND beats agents.yaml in both directions; an unknown env value resolves to anthropic', () => {
    const optedIn = projectRoot(OPT_IN);
    const optedOut = projectRoot(yamlFor('research', { backend: 'anthropic' }));
    vi.stubEnv('RKS_RESEARCH_BACKEND', 'claude-cli');
    expect(resolveAgentBackend('research', optedOut)).toBe('claude-cli');
    vi.stubEnv('RKS_RESEARCH_BACKEND', 'anthropic');
    expect(resolveAgentBackend('research', optedIn)).toBe('anthropic');
    vi.stubEnv('RKS_RESEARCH_BACKEND', 'gpt');
    expect(resolveAgentBackend('research', optedIn)).toBe('anthropic');
  });

  it('the env name is the ENV_MODEL_MAP name with _MODEL replaced by _BACKEND (product-owner reads RKS_PO_BACKEND)', () => {
    const root = projectRoot();
    expect(resolveAgentBackend('product-owner', root)).toBe('anthropic');
    vi.stubEnv('RKS_PO_BACKEND', 'claude-cli');
    expect(resolveAgentBackend('product-owner', root)).toBe('claude-cli');
  });

  it('is read uncached: an agents.yaml rewrite changes the next result with no clearConfigCache, while loadAgentConfig keeps its cached parse', () => {
    const root = projectRoot(yamlFor('research', { model: 'model-before' }));
    expect(loadAgentConfig('research', root).model).toBe('model-before');
    expect(resolveAgentBackend('research', root)).toBe('anthropic');
    writeYaml(root, yamlFor('research', { model: 'model-after', backend: 'claude-cli' }));
    expect(resolveAgentBackend('research', root)).toBe('claude-cli');
    // Positive control: the cached reader did not see the rewrite, so the uncached read is what changed.
    expect(loadAgentConfig('research', root).model).toBe('model-before');
    writeYaml(root, yamlFor('research', { model: 'model-after' }));
    expect(resolveAgentBackend('research', root)).toBe('anthropic');
  });
});

describe('no opt-in: runAgent behaves exactly as before', () => {
  it.each([
    ['no agents.yaml', undefined],
    ['agents.yaml without backend', yamlFor('research', { model: HAIKU })],
    ['agents.yaml with an unknown backend', yamlFor('research', { backend: 'gpt' })],
  ])('%s: dispatcher never called, events are the current ones with no fallback fields', async (_label, yaml) => {
    const dispatcher = spyDispatcher();
    const collector = recorder();
    const shortCircuit = shortCircuitSpy();
    const result = await runAgent(baseConfig(projectRoot(yaml), {
      shortCircuit, _backendDispatcher: dispatcher, _testCollector: collector,
    }));
    expect(dispatcher.execute).not.toHaveBeenCalled();
    expect(shortCircuit).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.answer).toBe('from-api-path');
    expect('backendFallback' in result).toBe(false);
    expect(collector.events.map((e) => e.event)).toEqual(['agent.research.started', 'agent.research.complete']);
    expect(sortedKeys(collector.events[0].data)).toEqual(STARTED_KEYS);
    expect(sortedKeys(collector.events[1].data)).toEqual(SHORT_COMPLETE_KEYS);
    for (const e of collector.events) {
      expect('fallbackFrom' in e.data).toBe(false);
      expect('fallbackReason' in e.data).toBe(false);
    }
  });

  it('an LLM run on the API path emits the same started and complete payload keys as before', async () => {
    const { client, create } = capturingClient();
    const collector = recorder();
    const result = await runAgent(baseConfig(projectRoot(), { _testClient: client, _testCollector: collector }));
    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sortedKeys(ofType(collector, 'started')[0].data)).toEqual(STARTED_KEYS);
    expect(sortedKeys(ofType(collector, 'complete')[0].data)).toEqual(LLM_COMPLETE_KEYS);
  });
});

describe('opt-in: every runAgent attempt goes through the dispatcher', () => {
  beforeEach(() => {
    // Running under vitest: the injected dispatcher, not the vitest guard, decides the path here.
    expect(process.env.VITEST).toBeTruthy();
  });

  it('first attempt: one dispatcher call with the primary model; the API path does not run', async () => {
    const dispatcher = spyDispatcher();
    const collector = recorder();
    const shortCircuit = shortCircuitSpy();
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), {
      shortCircuit, _backendDispatcher: dispatcher, _testCollector: collector,
    }));
    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(dispatcher.calls[0].config.model).toBe(HAIKU);
    expect(dispatcher.calls[0].config.name).toBe('research');
    expect(typeof dispatcher.calls[0].opts.executeApi).toBe('function');
    expect(result.answer).toBe('from-dispatcher');
    expect(shortCircuit).not.toHaveBeenCalled();
    expect(ofType(collector, 'started')).toEqual([]);
  });

  it('same-model retry after invalid JSON is a second dispatcher call on the same model', async () => {
    const dispatcher = spyDispatcher((n) => (n === 1
      ? { ok: false, error: 'Agent output is not valid JSON', telemetryId: 't1' }
      : { ok: true, answer: 'retried', telemetryId: 't2' }));
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), { _backendDispatcher: dispatcher, _testCollector: recorder() }));
    expect(dispatcher.execute).toHaveBeenCalledTimes(2);
    expect(dispatcher.calls.map((c) => c.config.model)).toEqual([HAIKU, HAIKU]);
    expect(dispatcher.calls[1].config._sameModelRetried).toBe(true);
    expect(result.answer).toBe('retried');
  });

  it('failure escalation is a second dispatcher call on the fallback model', async () => {
    const dispatcher = spyDispatcher((n) => (n === 1
      ? { ok: false, error: 'Agent exceeded max turns (7)', telemetryId: 't1' }
      : { ok: true, answer: 'escalated', telemetryId: 't2' }));
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), {
      fallbackModel: SONNET, _backendDispatcher: dispatcher, _testCollector: recorder(),
    }));
    expect(dispatcher.calls.map((c) => c.config.model)).toEqual([HAIKU, SONNET]);
    expect(dispatcher.calls[1].config._isEscalation).toBe(true);
    expect(result.answer).toBe('escalated');
    expect(result._escalated).toEqual({ from: HAIKU, to: SONNET, originalError: 'Agent exceeded max turns (7)' });
  });

  it('self-escalation is a second dispatcher call on the fallback model; the marker never reaches the caller', async () => {
    const collector = recorder();
    const dispatcher = spyDispatcher((n) => (n === 1
      ? { ok: true, answer: 'weak', telemetryId: 't1', _selfEscalate: true }
      : { ok: true, answer: 'strong', telemetryId: 't2' }));
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), {
      fallbackModel: SONNET, _backendDispatcher: dispatcher, _testCollector: collector,
    }));
    expect(dispatcher.calls.map((c) => c.config.model)).toEqual([HAIKU, SONNET]);
    expect(result.answer).toBe('strong');
    expect('_selfEscalate' in result).toBe(false);
    expect(ofType(collector, 'self_escalation')).toHaveLength(1);
  });

  it('systemText equals the API-path system prompt on the primary model and the raw prompt on the escalated run', async () => {
    const { client, systems } = capturingClient();
    await runAgent(baseConfig(projectRoot(), { fallbackModel: SONNET, _testClient: client, _testCollector: recorder() }));
    const apiSystem = systems[0];
    expect(apiSystem.startsWith(PROMPT)).toBe(true);
    expect(apiSystem.length).toBeGreaterThan(PROMPT.length);

    const dispatcher = spyDispatcher((n) => (n === 1
      ? { ok: true, answer: 'weak', telemetryId: 't1', _selfEscalate: true }
      : { ok: true, answer: 'strong', telemetryId: 't2' }));
    await runAgent(baseConfig(projectRoot(OPT_IN), {
      fallbackModel: SONNET, _backendDispatcher: dispatcher, _testCollector: recorder(),
    }));
    expect(dispatcher.calls[0].opts.systemText).toBe(apiSystem);
    expect(dispatcher.calls[1].opts.systemText).toBe(PROMPT);
  });

  it('an agent with no fallbackModel gets the raw prompt as systemText', async () => {
    const dispatcher = spyDispatcher();
    await runAgent(baseConfig(projectRoot(OPT_IN), { _backendDispatcher: dispatcher, _testCollector: recorder() }));
    expect(dispatcher.calls[0].opts.systemText).toBe(PROMPT);
  });
});

describe('test-safety guards', () => {
  it('an injected _testClient takes the API path even with backend claude-cli and an injected dispatcher', async () => {
    const root = projectRoot(OPT_IN);
    expect(resolveAgentBackend('research', root)).toBe('claude-cli');
    const dispatcher = spyDispatcher();
    const { client, create } = capturingClient();
    const result = await runAgent(baseConfig(root, { _testClient: client, _backendDispatcher: dispatcher, _testCollector: recorder() }));
    expect(dispatcher.execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('llm');
  });

  it('under vitest with no injected dispatcher an opted-in agent runs the API path', async () => {
    expect(process.env.VITEST).toBeTruthy();
    const root = projectRoot(OPT_IN);
    expect(resolveAgentBackend('research', root)).toBe('claude-cli');
    const shortCircuit = shortCircuitSpy();
    const collector = recorder();
    const result = await runAgent(baseConfig(root, { shortCircuit, _testCollector: collector }));
    expect(shortCircuit).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('from-api-path');
    expect('backendFallback' in result).toBe(false);
    expect(collector.events.map((e) => e.event)).toEqual(['agent.research.started', 'agent.research.complete']);
  });
});

describe('an agents.yaml flip takes effect on the next runAgent call (no restart)', () => {
  it('off, on, off across three calls on one project root, with no clearConfigCache', async () => {
    const root = projectRoot(yamlFor('research', { model: HAIKU }));
    const dispatcher = spyDispatcher();
    const run = () => runAgent(baseConfig(root, {
      shortCircuit: shortCircuitSpy(), _backendDispatcher: dispatcher, _testCollector: recorder(),
    }));
    expect((await run()).answer).toBe('from-api-path');
    expect(dispatcher.execute).toHaveBeenCalledTimes(0);
    writeYaml(root, OPT_IN);
    expect((await run()).answer).toBe('from-dispatcher');
    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    writeYaml(root, yamlFor('research', { model: HAIKU }));
    expect((await run()).answer).toBe('from-api-path');
    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
  });
});

describe('D1 end to end: runAgent with the real dispatcher falls back to the API visibly', () => {
  // Adds, inside the dispatcher (after the _testClient guard), a client that fails the test if the
  // in-process API path ever reached the model.
  function guarded(real) {
    const create = vi.fn(async () => {
      throw new Error('LLM must not be called in this test');
    });
    const dispatcher = { execute: (config, opts) => real.execute({ ...config, _testClient: { messages: { create } } }, opts) };
    return { dispatcher, create };
  }

  // backlog.feat.keyless-backend-aware-credential-presence (AC7): with ANTHROPIC_API_KEY stubbed empty
  // there is no API fallback, so a not-ready probe is refused, not routed to the API path.
  it('probe not ready, no ANTHROPIC_API_KEY: a structured refusal and one backend_refused event; no API run, no backend_fallback', async () => {
    const runCli = vi.fn();
    const probeCache = { get: vi.fn(async () => ({ ready: false, reason: 'not_installed' })), invalidate: vi.fn() };
    const { dispatcher, create } = guarded(createBackendDispatcher({ probeCache, runCli, env: {}, now: () => 5_000 }));
    const collector = recorder();
    const shortCircuit = shortCircuitSpy();
    const result = await runAgent(baseConfig(projectRoot(OPT_IN), {
      shortCircuit, _backendDispatcher: dispatcher, _testCollector: collector,
    }));
    expect(runCli).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(shortCircuit).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'subscription_unavailable', probeReason: 'not_installed', fallback: 'none' });
    expect(result.error).toMatch(/claude \/login/);
    expect('backendFallback' in result).toBe(false);
    expect(collector.events.map((e) => e.event)).toEqual(['agent.research.backend_refused']);
    expect(collector.events[0].data).toMatchObject({ from: 'claude-cli', reason: 'unavailable', probeReason: 'not_installed', fallback: 'none' });
    // No 15-minute lockout: the probe cache is invalidated so a fixed login is seen on the next call.
    expect(probeCache.invalidate).toHaveBeenCalledTimes(1);
    for (const e of collector.events) expect('billing' in e.data).toBe(false);
  });

  it('rate_limit opens the cool-down; the next runAgent reports cooldown without running the executor', async () => {
    const runCli = vi.fn(async () => ({ ok: false, error: 'rate limited', backendFailure: { reason: 'rate_limit' } }));
    const probeCache = { get: vi.fn(async () => ({ ready: true, authMethod: 'claude.ai', reason: null })), invalidate: vi.fn() };
    let t = 10_000;
    // Keyed: this case asserts the API fallback, which needs ANTHROPIC_API_KEY.
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' };
    const { dispatcher, create } = guarded(createBackendDispatcher({ probeCache, runCli, env, now: () => t, cooldownMs: 60_000 }));
    const root = projectRoot(OPT_IN);
    const run = (collector) => runAgent(baseConfig(root, {
      shortCircuit: shortCircuitSpy(), _backendDispatcher: dispatcher, _testCollector: collector,
    }));

    const c1 = recorder();
    const first = await run(c1);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][0].systemText).toBe(PROMPT);
    expect(first.backendFallback).toEqual({ from: 'claude-cli', reason: 'rate_limit' });
    expect(ofType(c1, 'started')[0].data.fallbackReason).toBe('rate_limit');

    t += 30_000;
    const c2 = recorder();
    const second = await run(c2);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(second.backendFallback).toEqual({ from: 'claude-cli', reason: 'cooldown', detail: 'rate_limit' });
    expect(ofType(c2, 'backend_fallback')).toHaveLength(1);
    expect(ofType(c2, 'complete')[0].data.fallbackReason).toBe('cooldown');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('research config hands the executor its Zod schema and retrieval record (research.mjs)', () => {
  const modelOut = { ok: true, answer: 'a', sources: [{ file: 'a.mjs' }], confidence: 0.6 };

  it('createResearchAgent returns _outputSchemaZod === ResearchOutputSchema and a _retrieval with record and consume', () => {
    const agent = createResearchAgent({ projectId: 'proj-sel', query: 'q', projectRoot: projectRoot() });
    expect(agent._outputSchemaZod).toBe(ResearchOutputSchema);
    expect(typeof agent._retrieval.record).toBe('function');
    expect(typeof agent._retrieval.consume).toBe('function');
  });

  it('_retrieval is the record the output schema consumes: an outcome recorded through it sets failureCategory', () => {
    const agent = createResearchAgent({ projectId: 'proj-sel', query: 'q', projectRoot: projectRoot() });
    agent._retrieval.record('no_results');
    expect(agent.outputSchema.parse(modelOut).failureCategory).toBe('no_results');
    expect(agent.outputSchema.parse(modelOut).failureCategory).toBeUndefined();
  });

  it('runAgent passes _retrieval and _outputSchemaZod to the dispatcher by identity', async () => {
    const root = projectRoot(OPT_IN);
    const agent = createResearchAgent({ projectId: 'proj-sel', query: 'q', projectRoot: root });
    const dispatcher = spyDispatcher();
    await runAgent({ ...agent, _backendDispatcher: dispatcher, _testCollector: recorder() });
    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    expect(dispatcher.calls[0].config._retrieval).toBe(agent._retrieval);
    expect(dispatcher.calls[0].config._outputSchemaZod).toBe(ResearchOutputSchema);
  });
});
