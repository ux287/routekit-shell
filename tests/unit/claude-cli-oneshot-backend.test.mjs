/**
 * backlog.feat.claude-cli-oneshot-backend: the text-only claude -p LLMBackend (llm/claude-cli/oneshot.mjs).
 * Every child is a scripted EventEmitter returned by an INJECTED spawn implementation; the probe,
 * gate, clock, API backend and telemetry collector are injected. Never runs the real claude binary
 * and contains no spawn-family call.
 * ASSUMED SHAPES: stream fixtures follow one observed claude 2.1.302 run plus the headless docs.
 * The unverified items (an empty mcp config accepted, the mcp_servers value it reports, --max-turns 2
 * being enough, subscription concurrency) are pinned only as rks argv and handling, not CLI behaviour.
 * Tier: npm run test:unit
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { generateCostReport } from '@routekit/telemetry/cost-report';
import { createClaudeCliGate, DEFAULT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS } from '../../packages/mcp-rks/src/llm/claude-cli/gate.mjs';
import { createClaudeCliOneShotBackend, ONESHOT_MAX_TURNS, MAX_STDIN_BYTES } from '../../packages/mcp-rks/src/llm/claude-cli/oneshot.mjs';
import { DEFAULT_LLM_TIMEOUT_MS, callAnthropicChat } from '../../packages/mcp-rks/src/llm/clients.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const NOW = 1_800_000_000_000;
const jl = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const INIT = { type: 'system', subtype: 'init', mcp_servers: [] };
const SUCCESS = {
  type: 'result', subtype: 'success', is_error: false, result: '  hello world  ', total_cost_usd: 0.0123,
  modelUsage: { [MODEL]: { inputTokens: 572, outputTokens: 12, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } },
};
const TOKENS = { in: 572, out: 12, cacheRead: 3, cacheCreate: 4 };
const FAILED = { type: 'result', subtype: 'error_during_execution', is_error: true, result: '' };
const RL_EVENT = (status, resetsAt) => ({ type: 'rate_limit_event', rate_limit_info: { status, ...(resetsAt != null ? { resetsAt } : {}) } });
const RETRY = (error) => ({ type: 'system', subtype: 'api_retry', error });

function recorder() {
  const events = [];
  return { events, emit: (event, projectId, data) => { events.push({ event, projectId, data }); }, flush: async () => {} };
}

function scriptedSpawn(script = {}) {
  const calls = [];
  const impl = (binary, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const call = { binary, args, opts, stdin: null, kills: [], files: {} };
    child.stdin = { end: (s) => { call.stdin = s; } };
    child.kill = (sig) => { call.kills.push(sig); setImmediate(() => child.emit('close', null, sig)); return true; };
    for (const flag of ['--system-prompt-file', '--mcp-config']) {
      const i = args.indexOf(flag);
      if (i !== -1) call.files[flag] = fs.readFileSync(args[i + 1], 'utf8');
    }
    calls.push(call);
    if (script.throws) throw script.throws;
    if (!script.hang) {
      setImmediate(() => {
        if (script.error) { child.emit('error', script.error); return; }
        child.stdout.emit('data', script.stdout ?? jl(INIT, SUCCESS));
        child.emit('close', script.exitCode ?? 0, null);
      });
    }
    return child;
  };
  return { impl, calls };
}

const probeOf = (result) => ({ get: vi.fn(async () => result), invalidate: vi.fn() });
const READY = () => probeOf({ ready: true, authMethod: 'claude.ai', version: '2.1.302' });

// timeoutMs: null omits the option, so the backend's own default applies.
// The API fallback runs only with the apiBackend provider key (backlog.feat.keyless-backend-aware-credential-presence):
// keyed-fallback cases pass ANTHROPIC_API_KEY explicitly. No-key refusals: claude-cli-oneshot-subscription-refusal.test.mjs.
const KEYED_ENV = Object.freeze({ ANTHROPIC_API_KEY: 'sk-ant-test-not-real' });
function setup({ script, probe, gateOpts = {}, env = { ...KEYED_ENV }, timeoutMs = 5_000, caller = 'planner' } = {}) {
  const probeCache = probe ?? READY();
  const gate = createClaudeCliGate({ probeCache, now: () => NOW, ...gateOpts });
  const spawn = scriptedSpawn(script);
  const collector = recorder();
  const apiResult = { content: 'from api', usage: null, usageEmitted: true };
  const apiBackend = { id: 'anthropic', complete: vi.fn(async () => apiResult), createMessage: vi.fn() };
  const backend = createClaudeCliOneShotBackend({
    apiBackend, caller, gate, env, spawnImpl: spawn.impl, collector, now: () => NOW,
    ...(timeoutMs === null ? {} : { timeoutMs }),
  });
  const ofType = (t) => collector.events.filter((e) => e.event === t);
  return { backend, gate, probeCache, spawn, collector, apiBackend, apiResult, ofType };
}
const REQUEST = () => ({
  model: MODEL, prompt: 'PROMPT', systemPrompt: 'SYS', maxTokens: 16000,
  context: { projectId: 'proj-1', problemId: 'backlog.x', sessionId: 'sess-1' },
});

const FALLBACKS = {
  unavailable: () => ({ probe: probeOf({ ready: false }) }),
  cooldown: () => ({ before: (s) => s.gate.openCooldown('rate_limit', 60_000) }),
  busy: () => ({ gateOpts: { maxConcurrent: 1 }, before: (s) => s.gate.tryAcquire() }),
  spawn_failed: () => ({ script: { throws: new Error('spawn ENOENT') } }),
  timeout: () => ({ script: { hang: true }, timeoutMs: 5 }),
  rate_limit: () => ({ script: { stdout: jl(INIT, RL_EVENT('rejected', NOW / 1000 + 600), FAILED), exitCode: 1 } }),
  auth: () => ({ script: { stdout: jl(INIT, RETRY('authentication_failed'), FAILED), exitCode: 1 } }),
  overloaded: () => ({ script: { stdout: jl(INIT, RETRY('overloaded'), FAILED), exitCode: 1 } }),
  model_unavailable: () => ({ script: { stdout: jl(INIT, RETRY('model_not_found'), FAILED), exitCode: 1 } }),
  cli_error: () => ({ script: { stdout: jl(INIT), exitCode: 1 } }),
  unexpected_mcp_servers: () => ({ script: { stdout: jl({ ...INIT, mcp_servers: [{ name: 'stray', status: 'connected' }] }, SUCCESS) } }),
  input_too_large: () => ({ request: { prompt: 'x'.repeat(MAX_STDIN_BYTES + 1) } }),
};
async function runScenario(reason) {
  const opts = FALLBACKS[reason]();
  const s = setup(opts);
  opts.before?.(s);
  const req = { ...REQUEST(), ...(opts.request || {}) };
  const res = await s.backend.complete(req);
  return { s, req, res };
}

const tempRoots = [];
function makeRoot(events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-oneshot-cost-'));
  tempRoots.push(root);
  const dir = path.join(root, '.rks', 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events-2026-01-01.jsonl'), events.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
  return root;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('argv, scratch files, stdin and env', () => {
  it('argv is exactly the observed flag set with --max-turns 2, --model and a fresh --session-id', async () => {
    const { backend, spawn } = setup();
    await backend.complete(REQUEST());
    const [call] = spawn.calls;
    expect(ONESHOT_MAX_TURNS).toBe(2);
    expect(call.binary).toBe('claude');
    expect(call.args).toStrictEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', MODEL, '--max-turns', '2',
      '--system-prompt-file', expect.any(String), '--tools', '', '--strict-mcp-config', '--mcp-config', expect.any(String),
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--disable-slash-commands', '--no-session-persistence',
      '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(call.args).not.toContain('--allowedTools');
    expect(call.args).not.toContain('--json-schema');
  });

  it('writes an empty mcp config and the system prompt into a scratch cwd that is removed afterwards, and pipes the prompt on stdin', async () => {
    const { backend, spawn } = setup();
    await backend.complete(REQUEST());
    const [call] = spawn.calls;
    expect(JSON.parse(call.files['--mcp-config'])).toStrictEqual({ mcpServers: {} });
    expect(call.files['--system-prompt-file']).toBe('SYS');
    expect(call.stdin).toBe('PROMPT');
    for (const flag of ['--system-prompt-file', '--mcp-config']) {
      expect(path.dirname(call.args[call.args.indexOf(flag) + 1])).toBe(call.opts.cwd);
    }
    expect(fs.existsSync(call.opts.cwd)).toBe(false);
  });

  it('uses a fresh --session-id per call and RKS_CLAUDE_BIN when set', async () => {
    const a = setup();
    await a.backend.complete(REQUEST());
    await a.backend.complete(REQUEST());
    const ids = a.spawn.calls.map((c) => c.args[c.args.indexOf('--session-id') + 1]);
    expect(ids[0]).not.toBe(ids[1]);
    const b = setup({ env: { ...KEYED_ENV, RKS_CLAUDE_BIN: '/opt/claude/bin/claude' } });
    await b.backend.complete(REQUEST());
    expect(b.spawn.calls[0].binary).toBe('/opt/claude/bin/claude');
  });

  it('with no systemPrompt the system prompt file carries the HTTP transport default', async () => {
    const { backend, spawn } = setup();
    const { systemPrompt, ...req } = REQUEST();
    await backend.complete(req);
    expect(spawn.calls[0].files['--system-prompt-file']).toContain('You are the RouteKit planner');
  });

  it('the default system prompt is the exact text the real Anthropic HTTP transport sends', async () => {
    const { backend, spawn } = setup();
    const { systemPrompt, ...req } = REQUEST();
    await backend.complete(req);
    // Real clients.mjs transport, stubbed fetch, no usage in the reply (so nothing is emitted).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'x' }] }), text: async () => '',
    });
    await callAnthropicChat({ client: { apiKey: 'k', baseURL: 'https://api.anthropic.invalid' }, model: MODEL, prompt: 'p' });
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body).system[0].text;
    expect(spawn.calls[0].files['--system-prompt-file']).toBe(sent);
  });

  it('an SDK-transport request with no systemPrompt (qa-agent) writes an empty system prompt file', async () => {
    const { backend, spawn } = setup({ caller: 'qa-agent' });
    const { systemPrompt, ...req } = REQUEST();
    await backend.complete({ ...req, transport: 'sdk' });
    expect(spawn.calls[0].files['--system-prompt-file']).toBe('');
  });

  it('strips API and Claude Code credential keys from the child env even when the parent has ANTHROPIC_API_KEY', async () => {
    const { backend, spawn } = setup({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'https://api.anthropic.test', CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_SIMPLE: '1', PATH: '/usr/bin', HOME: '/home/u',
      },
    });
    await backend.complete(REQUEST());
    const childEnv = spawn.calls[0].opts.env;
    const leaked = Object.keys(childEnv).filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_USE_')
      || k === 'CLAUDE_CODE_OAUTH_TOKEN' || k === 'CLAUDE_CODE_SIMPLE');
    expect(leaked).toEqual([]);
    expect(childEnv.PATH).toBe('/usr/bin');
  });
});

describe('success', () => {
  it('returns the result text and emits exactly one subscription-billed llm.token_usage', async () => {
    const s = setup();
    const res = await s.backend.complete(REQUEST());
    expect(res).toMatchObject({ content: 'hello world', usage: TOKENS, usageEmitted: true });
    const usage = s.ofType('llm.token_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].projectId).toBe('proj-1');
    expect(usage[0].data).toMatchObject({
      clientName: 'claude-cli', model: MODEL, caller: 'planner', tokens: TOKENS, backend: 'claude-cli', billing: 'subscription',
      costUsdEstimate: 0.0123, claudeVersion: '2.1.302', authMethod: 'claude.ai', problemId: 'backlog.x', sessionId: 'sess-1',
    });
    expect(s.ofType('llm.backend_fallback')).toHaveLength(0);
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
    expect(s.gate.state().inFlight).toBe(0);
  });

  it('a system/init with no mcp_servers key is treated as zero servers', async () => {
    const s = setup({ script: { stdout: jl({ type: 'system', subtype: 'init' }, SUCCESS) } });
    expect((await s.backend.complete(REQUEST())).content).toBe('hello world');
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
  });

  it.each(['allowed', 'allowed_warning'])('a %s rate_limit_event on a successful run neither falls back nor cools down', async (status) => {
    const s = setup({ script: { stdout: jl(INIT, RL_EVENT(status, NOW / 1000 + 600), SUCCESS) } });
    expect((await s.backend.complete(REQUEST())).content).toBe('hello world');
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
    expect(s.gate.inCooldown()).toBe(false);
  });
});

describe('fallback (D1)', () => {
  it.each(Object.keys(FALLBACKS))('%s: the identical request goes to the API backend with one llm.backend_fallback', async (reason) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { s, req, res } = await runScenario(reason);
    expect(s.apiBackend.complete).toHaveBeenCalledTimes(1);
    expect(s.apiBackend.complete.mock.calls[0][0]).toBe(req);
    // R9: the degradation is volunteered in the return value and in one log line.
    expect(res).toStrictEqual({ ...s.apiResult, backendFallback: { from: 'claude-cli', to: 'anthropic', reason } });
    expect(errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('fell back') && l.includes(reason))).toHaveLength(1);
    const fb = s.ofType('llm.backend_fallback');
    expect(fb).toHaveLength(1);
    expect(fb[0].data).toMatchObject({ caller: 'planner', from: 'claude-cli', to: 'anthropic', reason });
    expect(s.collector.events.filter((e) => e.data?.billing === 'subscription')).toHaveLength(0);
    expect(s.gate.state().inFlight).toBe(reason === 'busy' ? 1 : 0);
  });

  it.each([
    ['rate_limit', true], ['auth', true], ['unavailable', true],
    ['overloaded', false], ['model_unavailable', false], ['cli_error', false], ['spawn_failed', false],
    ['timeout', false], ['unexpected_mcp_servers', false], ['input_too_large', false],
  ])('%s opens the shared cool-down: %s', async (reason, opens) => {
    const { s } = await runScenario(reason);
    expect(s.gate.inCooldown()).toBe(opens);
    if (opens) expect(s.gate.state().cooldownReason).toBe(reason);
    expect(s.probeCache.invalidate).toHaveBeenCalledTimes(reason === 'auth' ? 1 : 0);
  });

  it('a ready probe without subscription auth is unavailable', async () => {
    const s = setup({ probe: probeOf({ ready: true, authMethod: 'api_key', version: '2.1.302' }) });
    await s.backend.complete(REQUEST());
    expect(s.spawn.calls).toHaveLength(0);
    expect(s.ofType('llm.backend_fallback')[0].data.reason).toBe('unavailable');
  });

  it.each([
    ['resetsAt in 10 minutes', jl(INIT, RL_EVENT('rejected', NOW / 1000 + 600), FAILED), NOW + 600_000],
    ['resetsAt beyond the cap', jl(INIT, RL_EVENT('rejected', NOW / 1000 + 24 * 3600), FAILED), NOW + MAX_RATE_LIMIT_COOLDOWN_MS],
    ['api_retry rate_limit without an event', jl(INIT, RETRY('rate_limit'), FAILED), NOW + DEFAULT_COOLDOWN_MS],
  ])('rate_limit cool-down is sized by cooldownMsFor: %s', async (_label, stdout, until) => {
    const s = setup({ script: { stdout, exitCode: 1 } });
    await s.backend.complete(REQUEST());
    expect(s.gate.state()).toMatchObject({ cooldownUntil: until, cooldownReason: 'rate_limit' });
  });

  it('input_too_large counts UTF-8 bytes, not characters, and never spawns', async () => {
    expect(MAX_STDIN_BYTES).toBe(10 * 1024 * 1024);
    const prompt = 'é'.repeat(MAX_STDIN_BYTES / 2 + 1);
    expect(prompt.length).toBeLessThan(MAX_STDIN_BYTES);
    const s = setup();
    await s.backend.complete({ ...REQUEST(), prompt });
    expect(s.spawn.calls).toHaveLength(0);
    expect(s.ofType('llm.backend_fallback')[0].data.reason).toBe('input_too_large');
  });

  it('with no timeoutMs the child is interrupted at DEFAULT_LLM_TIMEOUT_MS, not before', async () => {
    vi.useFakeTimers();
    const s = setup({ script: { hang: true }, timeoutMs: null });
    const pending = s.backend.complete(REQUEST());
    await vi.advanceTimersByTimeAsync(DEFAULT_LLM_TIMEOUT_MS - 1);
    expect(s.spawn.calls).toHaveLength(1);
    expect(s.spawn.calls[0].kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.spawn.calls[0].kills[0]).toBe('SIGINT');
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(s.ofType('llm.backend_fallback')[0].data.reason).toBe('timeout');
  });
});

describe('outcomes that do not fall back', () => {
  it('an abort while the child runs sends SIGINT and rejects; no fallback', async () => {
    const s = setup({ script: { hang: true }, timeoutMs: 60_000 });
    const ac = new AbortController();
    const pending = s.backend.complete({ ...REQUEST(), signal: ac.signal });
    await vi.waitFor(() => expect(s.spawn.calls).toHaveLength(1));
    ac.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(s.spawn.calls[0].kills[0]).toBe('SIGINT');
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
    expect(s.ofType('llm.backend_fallback')).toHaveLength(0);
    expect(s.gate.state().inFlight).toBe(0);
  });

  it('an already-aborted signal rejects without spawning', async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(s.backend.complete({ ...REQUEST(), signal: ac.signal })).rejects.toThrow(/abort/i);
    expect(s.spawn.calls).toHaveLength(0);
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
  });

  it('an empty result text rejects without falling back or cooling down', async () => {
    const s = setup({ script: { stdout: jl(INIT, { ...SUCCESS, result: '   ' }) } });
    await expect(s.backend.complete(REQUEST())).rejects.toThrow();
    expect(s.apiBackend.complete).not.toHaveBeenCalled();
    expect(s.ofType('llm.backend_fallback')).toHaveLength(0);
    expect(s.gate.inCooldown()).toBe(false);
  });

  it('is text-only: capabilities are all false and createMessage throws BackendCapabilityError', async () => {
    const s = setup();
    expect(s.backend.id).toBe('claude-cli');
    expect(s.backend.capabilities).toStrictEqual({ toolUse: false, vision: false, promptCacheControl: false, perTurnUsage: false });
    const call = Promise.resolve().then(() => s.backend.createMessage({ model: MODEL, messages: [{ role: 'user', content: 'x' }] }));
    await expect(call).rejects.toMatchObject({ name: 'BackendCapabilityError' });
    expect(s.spawn.calls).toHaveLength(0);
    expect(s.apiBackend.createMessage).not.toHaveBeenCalled();
  });
});

describe('cost report (existing billingOf, no cost-report.mjs change)', () => {
  it('keeps the claude-cli event out of API dollars and reports it on the subscription side', async () => {
    const s = setup();
    await s.backend.complete(REQUEST());
    const [usage] = s.ofType('llm.token_usage');
    const TS = '2026-01-01T00:00:00.000Z';
    const apiEvent = { id: 'ev-api', type: 'llm.token_usage', timestamp: TS, payload: { clientName: 'anthropic-http', model: 'claude-sonnet-4-6', tokens: { in: 1000, out: 500, cacheRead: 0, cacheCreate: 0 } } };
    const subEvent = { id: 'ev-sub', type: 'llm.token_usage', timestamp: TS, payload: usage.data };
    const apiOnly = generateCostReport(makeRoot([apiEvent]));
    const { subscription, ...rest } = generateCostReport(makeRoot([apiEvent, subEvent]));
    expect(rest).toEqual(apiOnly);
    expect(subscription.calls).toBe(1);
    expect(subscription.tokens).toEqual(TOKENS);
  });
});
