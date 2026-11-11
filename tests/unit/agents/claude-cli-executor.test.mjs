/**
 * Unit tests for packages/mcp-rks/src/agents/executors/claude-cli.mjs (runClaudeCliAgent and its
 * pure helpers). backlog.feat.agent-backend-selection-research; filed originally as
 * backlog.feat.claude-cli-executor.
 *
 * DETERMINISM. No real claude binary is started and no subscription is needed. The child process
 * is a scripted EventEmitter returned by an INJECTED spawn implementation; env, tmpdir,
 * probeResult and the telemetry collector are injected as well. This file starts no subprocess,
 * so the subprocess-timeout convention is satisfied vacuously, and it contains no spawn-family
 * call text (unit-tier-purity rule A), no module-registry reset (rule B) and no telemetry-package
 * specifier (telemetry-global-mock-triage): the executor's collector is injected.
 *
 * ASSUMED SHAPES. Every stream-json fixture below is shaped from the Claude Code headless and
 * cli-reference docs and has NOT been confirmed against an installed binary: the result message
 * field names, the modelUsage keys, the error_max_turns subtype, the api_retry error categories
 * and the system/init mcp_servers list (including whether a stdio server reads 'connected' at
 * init). These tests pin the executor's OWN parsing contract against those assumed shapes.
 * Behaviours only a real binary can show (server-level --allowedTools admission under dontAsk,
 * --mcp-config env merge semantics, rate-limit message text) are deliberately NOT asserted here;
 * they are enable-time verification items in the story, not vitest assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  runClaudeCliAgent,
  runChild,
  buildClaudeArgs,
  buildMcpConfig,
  buildToolsNotice,
  billingForProbe,
  parseStreamJson,
  mapUsage,
  classifyCliFailure,
  readOutcomes,
  DEFAULT_CLI_TIMEOUT_MS,
  CLI_BACKEND,
} from '../../../packages/mcp-rks/src/agents/executors/claude-cli.mjs';
import { buildSubscriptionEnv } from '../../../packages/mcp-rks/src/llm/claude-cli/probe.mjs';
import { AGENT_TOOLS_SERVER_NAME, READ_ONLY_TOOLS } from '../../../packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs';
import { zodToJsonSchema } from '../../../packages/mcp-rks/src/agents/zod-to-json-schema.mjs';

// ---------------------------------------------------------------------------
// Fixtures. ASSUMED SHAPES (docs-derived, unverified against a real binary).
// ---------------------------------------------------------------------------

const READY_PROBE = Object.freeze({
  ready: true,
  authMethod: 'claude.ai',
  version: '2.1.300',
  binary: 'claude',
  reason: null,
  strippedEnvKeys: [],
});

const SECRET = 'test-secret-value-do-not-leak-7f3a';
const TEST_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  ANTHROPIC_API_KEY: SECRET,
  ANTHROPIC_AUTH_TOKEN: `${SECRET}-auth`,
  CLAUDE_CODE_OAUTH_TOKEN: `${SECRET}-oauth`,
});

// ASSUMED SHAPE: system/init listing MCP server status.
const initLine = (servers = [{ name: 'rks-agent-tools', status: 'connected' }]) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  mcp_servers: servers,
});

// ASSUMED SHAPE: system/api_retry carrying an error category.
const retryLine = (error) => ({ type: 'system', subtype: 'api_retry', attempt: 1, error });

// ASSUMED SHAPE: per-model usage keyed by model id, camelCase token keys.
const MODEL_USAGE = {
  'model-a': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 },
  'model-b': { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
};
const EXPECTED_TOKENS = { in: 105, out: 21, cacheRead: 300, cacheCreate: 40 };
const ZERO_TOKENS = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
const CLEAN_META = Object.freeze({ malformedLines: 0, jsonSchemaDropped: false });

// ASSUMED SHAPE: the final result message.
const resultLine = (over = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  session_id: 'sess-1',
  total_cost_usd: 0.0123,
  duration_api_ms: 4567,
  result: '',
  modelUsage: MODEL_USAGE,
  ...over,
});

const OutputZ = z.object({ ok: z.boolean(), answer: z.string() });
const nonZod = (schema) => ({ parse: (v) => schema.parse(v) }); // no _def
const FENCE = '\x60\x60\x60'; // three backticks, escaped so no literal fence sits inside this markdown block

function baseConfig(over = {}) {
  return {
    name: 'research',
    userMessage: 'What does module X do?',
    inputSchema: z.object({ query: z.string() }),
    rawInput: { query: 'What does module X do?' },
    outputSchema: OutputZ,
    model: 'claude-test-model-id',
    maxTurns: 7,
    projectId: 'proj-test',
    projectRoot: '/nonexistent/proj-root',
    systemText: 'SYSTEM PROMPT UNDER TEST',
    ...over,
  };
}

const SUCCESS_LINES = [initLine(), resultLine({ structured_output: { ok: true, answer: 'hi' } })];

// ---------------------------------------------------------------------------
// Injected child-process double. Never starts a process.
// ---------------------------------------------------------------------------

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

/** The scratch dir is removed when the run ends, so its contents are captured at call time. */
function snapshotScratch(dir) {
  const files = fs.readdirSync(dir).sort();
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  return {
    files,
    systemPrompt: files.includes('system-prompt.txt') ? read('system-prompt.txt') : null,
    mcpConfigText: files.includes('mcp-config.json') ? read('mcp-config.json') : null,
  };
}

/**
 * Scripted injected spawn implementation: returns an EventEmitter child, then on the next
 * macrotask replays `lines` on stdout and emits close(code) (or an error event). A hanging child
 * emits nothing until kill(signal), which closes it asynchronously, as a real child would.
 */
function scriptedChild({ lines = [], code = 0, error = null, hang = false, onCall = null } = {}) {
  const calls = [];
  const impl = vi.fn((binary, args, opts) => {
    const child = makeChild();
    child.kill.mockImplementation((signal) => {
      setImmediate(() => child.emit('close', null, signal));
      return true;
    });
    const call = { binary, args, opts, child, scratch: snapshotScratch(opts.cwd) };
    calls.push(call);
    if (onCall) onCall(call);
    if (!hang) {
      setImmediate(() => {
        if (error) {
          child.emit('error', error);
          return;
        }
        for (const l of lines) child.stdout.emit('data', `${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
        child.emit('close', code, null);
      });
    }
    return child;
  });
  impl.calls = calls;
  return impl;
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) throw new Error(`flag ${flag} absent from argv`);
  return args[i + 1];
}

const mcpServerOf = (call) => JSON.parse(call.scratch.mcpConfigText).mcpServers[AGENT_TOOLS_SERVER_NAME];
const outcomesFileOf = (call) => argValue(mcpServerOf(call).args, '--outcomes-file');

let base;
let collector;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-cli-exec-test-'));
  collector = { emit: vi.fn(), flush: vi.fn(async () => {}) };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const makeDeps = (impl, over = {}) => ({
  probeResult: READY_PROBE,
  spawn: impl,
  env: TEST_ENV,
  tmpdir: base,
  collector,
  ...over,
});
const events = () => collector.emit.mock.calls.map(([type, projectId, data]) => ({ type, projectId, data }));
const eventOf = (suffix) => events().find((e) => e.type === `agent.research.${suffix}`);

// ---------------------------------------------------------------------------

describe('refusal without a ready claude.ai probe', () => {
  it.each([
    ['no probe result', undefined],
    ['ready false', { ...READY_PROBE, ready: false }],
    ['authMethod api_key', { ...READY_PROBE, authMethod: 'api_key' }],
    ['authMethod oauth_token', { ...READY_PROBE, authMethod: 'oauth_token' }],
    ['authMethod none', { ...READY_PROBE, authMethod: 'none' }],
  ])('%s: returns unavailable and never calls the injected spawn', async (_label, probeResult) => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl, { probeResult }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refused/);
    expect(res.backendFailure).toEqual({ reason: 'unavailable' });
    expect(impl).not.toHaveBeenCalled();
    expect(fs.readdirSync(base)).toEqual([]);
    expect(collector.emit).not.toHaveBeenCalled();
  });

  it('billingForProbe is subscription only for a ready claude.ai probe', () => {
    expect(billingForProbe(READY_PROBE)).toBe('subscription');
    expect(billingForProbe(undefined)).toBeNull();
    expect(billingForProbe({ ...READY_PROBE, ready: false })).toBeNull();
    expect(billingForProbe({ ...READY_PROBE, authMethod: 'api_key' })).toBeNull();
  });
});

describe('subscription environment and binary', () => {
  it('the child env carries no API credential and equals buildSubscriptionEnv(deps.env).env', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    const { opts, args, scratch } = impl.calls[0];
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(Object.prototype.hasOwnProperty.call(opts.env, key), key).toBe(false);
    }
    expect(opts.env.PATH).toBe(TEST_ENV.PATH);
    expect(opts.env.HOME).toBe(TEST_ENV.HOME);
    expect(opts.env).toEqual(buildSubscriptionEnv(TEST_ENV).env);
    const surfaces = [JSON.stringify(args), scratch.systemPrompt, scratch.mcpConfigText, JSON.stringify(opts.env)];
    for (const s of surfaces) expect(s).not.toContain(SECRET);
  });

  it('uses claude by default and RKS_CLAUDE_BIN from deps.env when set', async () => {
    const a = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig(), makeDeps(a));
    expect(a.calls[0].binary).toBe('claude');

    const b = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig(), makeDeps(b, { env: { ...TEST_ENV, RKS_CLAUDE_BIN: '/opt/test/claude-bin' } }));
    expect(b.calls[0].binary).toBe('/opt/test/claude-bin');
  });
});

describe('scratch directory and stdin', () => {
  it('runs in a fresh rks-claude-cli- dir under the injected tmpdir, writes the user message to stdin, and removes the dir after success', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(true);
    const { opts, child, scratch } = impl.calls[0];
    expect(path.dirname(opts.cwd)).toBe(base);
    expect(path.basename(opts.cwd).startsWith('rks-claude-cli-')).toBe(true);
    expect(scratch.files).toEqual(expect.arrayContaining(['system-prompt.txt', 'mcp-config.json']));
    expect(child.stdin.end).toHaveBeenCalledWith('What does module X do?');
    expect(fs.existsSync(opts.cwd)).toBe(false);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('removes the scratch dir after a non-zero exit', async () => {
    const impl = scriptedChild({ lines: [], code: 1 });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('removes the scratch dir after an executor throw and reports executor_error', async () => {
    const impl = scriptedChild({
      lines: SUCCESS_LINES,
      onCall: (call) => fs.writeFileSync(outcomesFileOf(call), '{"outcome":"healthy"}\n'),
    });
    const config = baseConfig({ _retrieval: { record: () => { throw new Error('record exploded'); } } });
    const res = await runClaudeCliAgent(config, makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('record exploded');
    expect(res.backendFailure).toEqual({ reason: 'executor_error' });
    expect(res.backendMeta).toEqual(CLEAN_META);
    expect(fs.readdirSync(base)).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  const input = { model: 'm-1', maxTurns: 4, systemPromptFile: '/s/sp.txt', mcpConfigFile: '/s/mcp.json', sessionId: 'sid-1' };

  it('emits every required flag with its value', () => {
    const args = buildClaudeArgs(input);
    expect(args[0]).toBe('-p');
    const pairs = {
      '--output-format': 'stream-json',
      '--model': 'm-1',
      '--max-turns': '4',
      '--system-prompt-file': '/s/sp.txt',
      '--tools': '',
      '--mcp-config': '/s/mcp.json',
      '--allowedTools': 'mcp__rks-agent-tools',
      '--permission-mode': 'dontAsk',
      '--permission-prompts': 'none',
      '--session-id': 'sid-1',
    };
    for (const [flag, value] of Object.entries(pairs)) expect(argValue(args, flag), flag).toBe(value);
    for (const flag of ['--verbose', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
      expect(args).toContain(flag);
    }
  });

  it('never emits --fallback-model or --bare, and --json-schema only when a schema is passed', () => {
    const without = buildClaudeArgs(input);
    expect(without).not.toContain('--fallback-model');
    expect(without).not.toContain('--bare');
    expect(without).not.toContain('--json-schema');
    const withSchema = buildClaudeArgs({ ...input, jsonSchema: { type: 'object' } });
    expect(argValue(withSchema, '--json-schema')).toBe('{"type":"object"}');
    expect(withSchema).not.toContain('--fallback-model');
    expect(withSchema).not.toContain('--bare');
  });

  it('the executor passes config.model, maxTurns and a UUID session id', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    const { args } = impl.calls[0];
    expect(argValue(args, '--model')).toBe('claude-test-model-id');
    expect(argValue(args, '--max-turns')).toBe('7');
    expect(argValue(args, '--session-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(argValue(args, '--system-prompt-file')).toBe(path.join(impl.calls[0].opts.cwd, 'system-prompt.txt'));
    expect(argValue(args, '--mcp-config')).toBe(path.join(impl.calls[0].opts.cwd, 'mcp-config.json'));
  });
});

describe('system prompt file and MCP config', () => {
  it('system prompt is config.systemText followed by the fixed read-only tools notice', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    const notice = buildToolsNotice('research');
    expect(impl.calls[0].scratch.systemPrompt).toBe(`SYSTEM PROMPT UNDER TEST${notice}`);
    expect(READ_ONLY_TOOLS.research.length).toBeGreaterThan(0);
    for (const tool of READ_ONLY_TOOLS.research) expect(notice).toContain(`mcp__${AGENT_TOOLS_SERVER_NAME}__${tool}`);
  });

  it('MCP config names exactly rks-agent-tools, launched with process.execPath, the six server flags and the launcher flags', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    const call = impl.calls[0];
    const cfg = JSON.parse(call.scratch.mcpConfigText);
    expect(AGENT_TOOLS_SERVER_NAME).toBe('rks-agent-tools');
    expect(Object.keys(cfg.mcpServers)).toEqual([AGENT_TOOLS_SERVER_NAME]);
    const server = cfg.mcpServers[AGENT_TOOLS_SERVER_NAME];
    expect(server.command).toBe(process.execPath);
    expect(path.basename(server.args[0])).toBe('agent-tools-mcp-server.mjs');
    expect(argValue(server.args, '--agent')).toBe('research');
    expect(argValue(server.args, '--project')).toBe('proj-test');
    expect(argValue(server.args, '--root')).toBe('/nonexistent/proj-root');
    expect(argValue(server.args, '--telemetry-id')).toBe(res.telemetryId);
    expect(argValue(server.args, '--model')).toBe('claude-test-model-id');
    expect(path.dirname(argValue(server.args, '--outcomes-file'))).toBe(call.opts.cwd);
    // Launcher flags read by backlog.feat.agent-tools-mcp-server (ARCH item 10 R1 on that story).
    expect(CLI_BACKEND).toBe('claude-cli');
    expect(argValue(server.args, '--backend')).toBe('claude-cli');
    expect(argValue(server.args, '--billing')).toBe('subscription');
    expect(server.env).toEqual({ RKS_AGENT_TOOLS_SERVER: '1' });
  });

  it('buildMcpConfig honours explicit nodePath and serverPath and omits --backend / --billing when not supplied', () => {
    const cfg = buildMcpConfig({
      agent: 'research', projectId: 'p', projectRoot: '/r', telemetryId: 't', model: 'm',
      outcomesFile: '/o.jsonl', nodePath: '/bin/node-test', serverPath: '/srv/server.mjs',
    });
    const server = cfg.mcpServers[AGENT_TOOLS_SERVER_NAME];
    expect(server.command).toBe('/bin/node-test');
    expect(server.args).toEqual([
      '/srv/server.mjs', '--agent', 'research', '--project', 'p', '--root', '/r',
      '--telemetry-id', 't', '--model', 'm', '--outcomes-file', '/o.jsonl',
    ]);
  });

  it('buildMcpConfig appends --backend and --billing after the six server flags when supplied', () => {
    const cfg = buildMcpConfig({
      agent: 'research', projectId: 'p', projectRoot: '/r', telemetryId: 't', model: 'm',
      outcomesFile: '/o.jsonl', backend: 'claude-cli', billing: 'subscription',
      nodePath: '/bin/node-test', serverPath: '/srv/server.mjs',
    });
    expect(cfg.mcpServers[AGENT_TOOLS_SERVER_NAME].args).toEqual([
      '/srv/server.mjs', '--agent', 'research', '--project', 'p', '--root', '/r',
      '--telemetry-id', 't', '--model', 'm', '--outcomes-file', '/o.jsonl',
      '--backend', 'claude-cli', '--billing', 'subscription',
    ]);
  });
});

describe('--json-schema source selection', () => {
  it('a Zod outputSchema produces --json-schema from zodToJsonSchema', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(argValue(impl.calls[0].args, '--json-schema')).toBe(JSON.stringify(zodToJsonSchema(OutputZ)));
  });

  it('a non-Zod outputSchema uses _outputSchemaZod when present', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig({ outputSchema: nonZod(OutputZ), _outputSchemaZod: OutputZ }), makeDeps(impl));
    expect(argValue(impl.calls[0].args, '--json-schema')).toBe(JSON.stringify(zodToJsonSchema(OutputZ)));
  });

  it('a non-Zod outputSchema with no _outputSchemaZod omits --json-schema and still validates', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig({ outputSchema: nonZod(OutputZ) }), makeDeps(impl));
    expect(impl.calls[0].args).not.toContain('--json-schema');
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
    // No Zod source at all is not a degradation: nothing was dropped.
    expect(res.backendMeta).toEqual(CLEAN_META);
  });

  it('a zodToJsonSchema throw omits --json-schema, does not fail the run, and is reported (R9)', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    // {} has no _def, so zodToJsonSchema throws on it.
    const res = await runClaudeCliAgent(baseConfig({ outputSchema: nonZod(OutputZ), _outputSchemaZod: {} }), makeDeps(impl));
    expect(impl.calls[0].args).not.toContain('--json-schema');
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
    expect(res.backendMeta).toEqual({ malformedLines: 0, jsonSchemaDropped: true });
    const complete = eventOf('complete');
    expect(complete.data.jsonSchemaDropped).toBe(true);
    expect(complete.data.jsonSchemaError).toContain('expected a Zod schema');
  });
});

describe('result parsing against assumed stream-json shapes', () => {
  it('success: validated object with telemetryId and clean backendMeta, one complete event with tokens and claude-cli tags', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
    expect(typeof res.telemetryId).toBe('string');
    expect(res.backendFailure).toBeUndefined();
    expect(res.backendMeta).toEqual(CLEAN_META);

    const complete = eventOf('complete');
    expect(complete.projectId).toBe('proj-test');
    expect(complete.data).toMatchObject({
      tokens: EXPECTED_TOKENS,
      backend: 'claude-cli',
      billing: 'subscription',
      claudeVersion: '2.1.300',
      authMethod: 'claude.ai',
      numTurns: 3,
      sessionId: 'sess-1',
      costUsdEstimate: 0.0123,
      durationApiMs: 4567,
      telemetryId: res.telemetryId,
    });
    expect('malformedLines' in complete.data).toBe(false);
    expect('jsonSchemaDropped' in complete.data).toBe(false);
    const started = eventOf('started');
    expect(started.data).toMatchObject({ backend: 'claude-cli', billing: 'subscription' });
    expect('tokens' in started.data).toBe(false);
    expect(events().filter((e) => 'tokens' in e.data)).toHaveLength(1);
  });

  it('without structured_output the result text is parsed, fenced JSON accepted', async () => {
    const text = `Here you go:\n${FENCE}json\n{"ok":true,"answer":"from text"}\n${FENCE}`;
    const impl = scriptedChild({ lines: [initLine(), resultLine({ result: text })] });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res).toMatchObject({ ok: true, answer: 'from text' });
  });

  it('schema mismatch returns Output validation failed with no backendFailure', async () => {
    const impl = scriptedChild({ lines: [initLine(), resultLine({ structured_output: { ok: true } })] });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.error.startsWith('Output validation failed')).toBe(true);
    expect(res.backendFailure).toBeUndefined();
  });

  it('malformed result text returns Agent output is not valid JSON with no backendFailure', async () => {
    const impl = scriptedChild({ lines: [initLine(), resultLine({ result: 'not json at all' })] });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Agent output is not valid JSON');
    expect(res.backendFailure).toBeUndefined();
  });

  it('no system/init line plus garbage and unknown-type lines still succeeds, and the malformed count is reported (R9)', async () => {
    const impl = scriptedChild({
      lines: ['garbage{', JSON.stringify({ type: 'assistant', message: {} }), resultLine({ structured_output: { ok: true, answer: 'hi' } })],
    });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
    expect(res.backendMeta).toEqual({ malformedLines: 1, jsonSchemaDropped: false });
    expect(eventOf('complete').data.malformedLines).toBe(1);
  });
});

describe('failure mapping', () => {
  it('error_max_turns returns Agent exceeded max turns with no backendFailure; failed event carries tokens', async () => {
    const impl = scriptedChild({
      lines: [initLine(), resultLine({ subtype: 'error_max_turns', is_error: true, num_turns: 7 })],
      code: 1,
    });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Agent exceeded max turns (7)');
    expect(res.backendFailure).toBeUndefined();
    expect(eventOf('failed').data.tokens).toEqual(EXPECTED_TOKENS);
  });

  it.each([
    ['rate_limit', 'rate_limit'],
    ['authentication_failed', 'auth'],
    ['billing_error', 'auth'],
    ['overloaded', 'overloaded'],
    ['model_not_found', 'model_unavailable'],
  ])('api_retry %s maps to backendFailure %s', async (category, reason) => {
    const impl = scriptedChild({
      lines: [initLine(), retryLine(category), resultLine({ is_error: true, subtype: 'error_during_execution', result: 'request failed', modelUsage: {} })],
      code: 1,
    });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.backendFailure).toEqual({ reason });
    expect(typeof res.telemetryId).toBe('string');
  });

  it('non-zero exit with no result line is cli_error, carries backendMeta, and the failed event has no tokens field', async () => {
    const impl = scriptedChild({ lines: [initLine()], code: 1 });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.backendFailure).toEqual({ reason: 'cli_error' });
    expect(res.backendMeta).toEqual(CLEAN_META);
    const failed = eventOf('failed');
    expect(failed.data.backend).toBe('claude-cli');
    expect('tokens' in failed.data).toBe(false);
  });

  it('a child error event is spawn_failed', async () => {
    const impl = scriptedChild({ error: Object.assign(new Error('claude not found'), { code: 'ENOENT' }) });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.backendFailure).toEqual({ reason: 'spawn_failed' });
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('a synchronously throwing spawn implementation is spawn_failed', async () => {
    const impl = vi.fn(() => { throw Object.assign(new Error('claude not found'), { code: 'ENOENT' }); });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.backendFailure).toEqual({ reason: 'spawn_failed' });
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it.each([
    ['rks-agent-tools absent', [], 'tools_unavailable'],
    ['rks-agent-tools not connected', [{ name: 'rks-agent-tools', status: 'failed' }], 'tools_unavailable'],
    ['an extra MCP server', [{ name: 'rks-agent-tools', status: 'connected' }, { name: 'other-server', status: 'connected' }], 'unexpected_mcp_servers'],
  ])('system/init with %s returns %s', async (_label, servers, reason) => {
    const impl = scriptedChild({ lines: [initLine(servers), resultLine({ structured_output: { ok: true, answer: 'hi' } })] });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(res.backendFailure).toEqual({ reason });
  });
});

describe('timeout', () => {
  it('a hanging child receives SIGINT and the run returns timeout', async () => {
    const impl = scriptedChild({ hang: true });
    const res = await runClaudeCliAgent(baseConfig(), makeDeps(impl, { timeoutMs: 15 }));
    expect(impl.calls[0].child.kill.mock.calls[0]).toEqual(['SIGINT']);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Agent timed out after 15ms');
    expect(res.backendFailure).toEqual({ reason: 'timeout' });
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('runChild sends SIGINT at timeoutMs, SIGTERM after killGraceMs, and clears both timers on close', async () => {
    const timers = [];
    const setTimer = vi.fn((fn, ms) => { timers.push({ fn, ms }); return timers.length; });
    const clearTimer = vi.fn();
    const child = makeChild();
    const impl = vi.fn(() => child);
    const pending = runChild({
      spawnImpl: impl, binary: 'claude', args: ['-p'], cwd: base, env: {}, input: 'hello',
      timeoutMs: 1234, killGraceMs: 99, setTimer, clearTimer,
    });
    expect(child.stdin.end).toHaveBeenCalledWith('hello');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1234);
    expect(child.kill).not.toHaveBeenCalled();
    timers[0].fn();
    expect(child.kill.mock.calls).toEqual([['SIGINT']]);
    expect(timers[1].ms).toBe(99);
    timers[1].fn();
    expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
    child.emit('close', null, 'SIGTERM');
    const res = await pending;
    expect(res).toMatchObject({ timedOut: true, signal: 'SIGTERM', exitCode: null, spawnError: null });
    expect(clearTimer).toHaveBeenCalledWith(1);
    expect(clearTimer).toHaveBeenCalledWith(2);
  });

  it('DEFAULT_CLI_TIMEOUT_MS is 180000', () => {
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(180_000);
  });
});

describe('retrieval outcome replay', () => {
  it('known outcomes are recorded in order BEFORE outputSchema.parse; unknown and malformed lines are ignored', async () => {
    const order = [];
    const outputSchema = { parse: (v) => { order.push('parse'); return OutputZ.parse(v); } };
    const _retrieval = { record: vi.fn((o) => order.push(`record:${o}`)) };
    const impl = scriptedChild({
      lines: SUCCESS_LINES,
      onCall: (call) => fs.writeFileSync(
        outcomesFileOf(call),
        ['{"outcome":"healthy"}', '{"outcome":"bogus_outcome"}', 'not json', '{"outcome":"no_results"}', ''].join('\n'),
      ),
    });
    const res = await runClaudeCliAgent(baseConfig({ outputSchema, _retrieval }), makeDeps(impl));
    expect(res.ok).toBe(true);
    expect(_retrieval.record.mock.calls).toEqual([['healthy'], ['no_results']]);
    expect(order).toEqual(['record:healthy', 'record:no_results', 'parse']);
  });

  it('readOutcomes of a missing file is an empty array', () => {
    expect(readOutcomes(path.join(base, 'does-not-exist.jsonl'))).toEqual([]);
  });
});

describe('input validation and short-circuit parity with _executeAgent', () => {
  it('a non-null shortCircuit returns the validated result without spawning', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig({ shortCircuit: () => ({ ok: true, answer: 'verbatim' }) }), makeDeps(impl));
    expect(impl).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, answer: 'verbatim' });
    expect(typeof res.telemetryId).toBe('string');
    expect(eventOf('complete').data).toMatchObject({ turns: 0, shortCircuit: true });
  });

  it('a null shortCircuit spawns once', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    await runClaudeCliAgent(baseConfig({ shortCircuit: () => null }), makeDeps(impl));
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('a throwing shortCircuit falls through and spawns', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig({ shortCircuit: () => { throw new Error('sc boom'); } }), makeDeps(impl));
    expect(impl).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, answer: 'hi' });
  });

  it('an inputSchema failure returns ok false without spawning', async () => {
    const impl = scriptedChild({ lines: SUCCESS_LINES });
    const res = await runClaudeCliAgent(baseConfig({ rawInput: { query: 42 } }), makeDeps(impl));
    expect(res.ok).toBe(false);
    expect(impl).not.toHaveBeenCalled();
    expect(fs.readdirSync(base)).toEqual([]);
  });
});

describe('pure helpers', () => {
  it('parseStreamJson captures init, retries and result and counts malformed lines', () => {
    const out = parseStreamJson([
      JSON.stringify(initLine()),
      'garbage{',
      '',
      JSON.stringify({ type: 'assistant', message: {} }),
      JSON.stringify(retryLine('overloaded')),
      JSON.stringify(resultLine()),
    ].join('\n'));
    expect(out.malformedLines).toBe(1);
    expect(out.init.subtype).toBe('init');
    expect(out.retries).toHaveLength(1);
    expect(out.result.type).toBe('result');
    expect(parseStreamJson(undefined)).toEqual({ init: null, retries: [], result: null, rateLimit: null, malformedLines: 0 });
  });

  it('mapUsage sums modelUsage, falls back to usage, and maps null and non-numeric values to 0', () => {
    expect(mapUsage({ modelUsage: MODEL_USAGE })).toEqual(EXPECTED_TOKENS);
    expect(mapUsage({ usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }))
      .toEqual({ in: 7, out: 3, cacheRead: 2, cacheCreate: 1 });
    expect(mapUsage(null)).toEqual(ZERO_TOKENS);
    expect(mapUsage({ modelUsage: { m: { inputTokens: 'x', outputTokens: null } } })).toEqual(ZERO_TOKENS);
  });

  it('classifyCliFailure: null on clean success, spawn_failed before timeout, is_error with exit 0 is a failure', () => {
    const okStream = { init: initLine(), retries: [], result: resultLine() };
    expect(classifyCliFailure({ spawnError: null, timedOut: false, exitCode: 0, stream: okStream, maxTurns: 3, timeoutMs: 10 })).toBeNull();
    expect(classifyCliFailure({ spawnError: new Error('x'), timedOut: true, exitCode: null, stream: okStream, maxTurns: 3, timeoutMs: 10 }).reason)
      .toBe('spawn_failed');
    expect(classifyCliFailure({ spawnError: null, timedOut: true, exitCode: null, stream: okStream, maxTurns: 3, timeoutMs: 10 }).reason)
      .toBe('timeout');
    const errStream = { init: null, retries: [], result: resultLine({ is_error: true }) };
    expect(classifyCliFailure({ spawnError: null, timedOut: false, exitCode: 0, stream: errStream, maxTurns: 3, timeoutMs: 10 }).reason)
      .toBe('cli_error');
  });
});
