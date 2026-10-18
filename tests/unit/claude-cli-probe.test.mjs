/**
 * Tests for packages/mcp-rks/src/llm/claude-cli/probe.mjs (backlog.feat.agent-backend-selection-research;
 * filed originally as backlog.feat.claude-cli-probe).
 *
 * Unit tier. Fully deterministic: the probe's run dependency and the cache's clock are injected,
 * and child_process.execFile is replaced with a vi.fn, so no subprocess is started, no claude
 * binary is needed, and no subscription is needed. No quoted telemetry-package specifier appears
 * in this file (telemetry-global-mock-triage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';

const h = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', async (io) => ({ ...(await io()), execFile: h.execFile }));

import {
  MIN_CLAUDE_VERSION,
  DEFAULT_PROBE_TTL_MS,
  buildSubscriptionEnv,
  parseClaudeVersion,
  compareVersions,
  defaultRun,
  probeClaudeCli,
  createProbeCache,
} from '../../packages/mcp-rks/src/llm/claude-cli/probe.mjs';

const SECRET = 'sk-ant-secret-value-do-not-leak';

const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SIMPLE',
];

/** Stub runner keyed on the argument vector; records every call. */
function makeRun({ version = { code: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '', error: null }, auth = { code: 0, stdout: '{"authMethod":"claude.ai"}', stderr: '', error: null } } = {}) {
  const calls = [];
  const run = vi.fn(async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '--version') return { stderr: '', error: null, ...version };
    if (args[0] === 'auth' && args[1] === 'status') return { stderr: '', error: null, ...auth };
    throw new Error(`unexpected args ${JSON.stringify(args)}`);
  });
  return { run, calls };
}

describe('module import is side-effect free', () => {
  it('importing probe.mjs starts no subprocess', () => {
    expect(h.execFile).not.toHaveBeenCalled();
  });
});

describe('buildSubscriptionEnv', () => {
  it.each(CREDENTIAL_KEYS)('removes %s', (key) => {
    const { env, stripped } = buildSubscriptionEnv({ PATH: '/usr/bin', [key]: SECRET });
    expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
    expect(stripped).toEqual([key]);
  });

  it('removes every listed credential key at once and reports names sorted, without values', () => {
    const parent = { PATH: '/usr/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/home/u/.claude' };
    for (const k of CREDENTIAL_KEYS) parent[k] = SECRET;
    const { env, stripped } = buildSubscriptionEnv(parent);
    for (const k of CREDENTIAL_KEYS) expect(env).not.toHaveProperty(k);
    expect(stripped).toEqual([...CREDENTIAL_KEYS].sort());
    expect(JSON.stringify(stripped)).not.toContain(SECRET);
    expect(JSON.stringify(env)).not.toContain(SECRET);
  });

  it('keeps unrelated keys such as PATH, HOME and CLAUDE_CONFIG_DIR', () => {
    const { env } = buildSubscriptionEnv({ PATH: '/usr/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: SECRET });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', CLAUDE_CONFIG_DIR: '/c' });
  });

  it('does not mutate its input', () => {
    const parent = { PATH: '/usr/bin', ANTHROPIC_API_KEY: SECRET };
    const snapshot = { ...parent };
    buildSubscriptionEnv(parent);
    expect(parent).toEqual(snapshot);
  });

  it('skips undefined values', () => {
    const { env } = buildSubscriptionEnv({ PATH: '/usr/bin', EMPTY: undefined });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('version helpers', () => {
  it('parseClaudeVersion extracts x.y.z or returns null', () => {
    expect(parseClaudeVersion('2.1.300 (Claude Code)')).toBe('2.1.300');
    expect(parseClaudeVersion('no version here')).toBeNull();
  });

  it('compareVersions orders numerically, not lexically', () => {
    expect(compareVersions('2.1.258', '2.1.259')).toBe(-1);
    expect(compareVersions('2.1.259', '2.1.259')).toBe(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
  });

  it('MIN_CLAUDE_VERSION is 2.1.259 and DEFAULT_PROBE_TTL_MS is 10 minutes', () => {
    expect(MIN_CLAUDE_VERSION).toBe('2.1.259');
    expect(DEFAULT_PROBE_TTL_MS).toBe(600_000);
  });
});

describe('probeClaudeCli — environment and invocation', () => {
  it('every run call receives an env with no ANTHROPIC_API_KEY when the parent has one', async () => {
    const { run, calls } = makeRun();
    const result = await probeClaudeCli({ run, parentEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: SECRET } });
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(Object.prototype.hasOwnProperty.call(c.opts.env, 'ANTHROPIC_API_KEY')).toBe(false);
      expect(c.opts.env.PATH).toBe('/usr/bin');
    }
    expect(result.strippedEnvKeys).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('runs --version then auth status', async () => {
    const { run, calls } = makeRun();
    await probeClaudeCli({ run, parentEnv: {} });
    expect(calls.map((c) => c.args)).toEqual([['--version'], ['auth', 'status']]);
  });

  it('passes cwd = os.tmpdir() by default and honours an explicit cwd', async () => {
    const a = makeRun();
    await probeClaudeCli({ run: a.run, parentEnv: {} });
    for (const c of a.calls) expect(c.opts.cwd).toBe(os.tmpdir());
    const b = makeRun();
    await probeClaudeCli({ run: b.run, parentEnv: {}, cwd: '/some/scratch' });
    for (const c of b.calls) expect(c.opts.cwd).toBe('/some/scratch');
  });

  it('passes an explicit timeoutMs to every run call', async () => {
    const { run, calls } = makeRun();
    await probeClaudeCli({ run, parentEnv: {}, timeoutMs: 1234 });
    for (const c of calls) expect(c.opts.timeoutMs).toBe(1234);
  });

  it('uses claude by default and RKS_CLAUDE_BIN when set in parentEnv', async () => {
    const a = makeRun();
    const ra = await probeClaudeCli({ run: a.run, parentEnv: {} });
    expect(a.calls.every((c) => c.cmd === 'claude')).toBe(true);
    expect(ra.binary).toBe('claude');
    const b = makeRun();
    const rb = await probeClaudeCli({ run: b.run, parentEnv: { RKS_CLAUDE_BIN: '/opt/bin/claude-x' } });
    expect(b.calls.every((c) => c.cmd === '/opt/bin/claude-x')).toBe(true);
    expect(rb.binary).toBe('/opt/bin/claude-x');
  });
});

describe('probeClaudeCli — auth gate', () => {
  it('returns ready: true only for authMethod claude.ai with a version at or above the floor', async () => {
    const { run } = makeRun();
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: true, version: '2.1.300', authMethod: 'claude.ai', reason: null });
  });

  it.each(['none', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'])(
    'authMethod %s returns ready: false, not_subscription_auth, and echoes the method',
    async (method) => {
      const { run } = makeRun({ auth: { code: 0, stdout: JSON.stringify({ authMethod: method }) } });
      const r = await probeClaudeCli({ run, parentEnv: {} });
      expect(r).toMatchObject({ ready: false, reason: 'not_subscription_auth', authMethod: method });
    },
  );

  it('JSON without an authMethod string returns not_subscription_auth with authMethod null', async () => {
    const { run } = makeRun({ auth: { code: 0, stdout: '{}' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'not_subscription_auth', authMethod: null });
  });

  it('non-JSON auth status output returns auth_status_unparseable', async () => {
    const { run } = makeRun({ auth: { code: 0, stdout: 'Logged in as someone' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'auth_status_unparseable', version: '2.1.300' });
  });

  it('exit code 1 with JSON {"authMethod":"none"} is parsed and returns not_subscription_auth', async () => {
    const { run } = makeRun({ auth: { code: 1, stdout: '{"authMethod":"none"}' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'not_subscription_auth', authMethod: 'none' });
  });

  it('a runner error on auth status returns auth_status_failed', async () => {
    const { run } = makeRun({ auth: { code: null, stdout: '', error: new Error('killed') } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'auth_status_failed' });
  });
});

describe('probeClaudeCli — version gate', () => {
  it('ENOENT runner error returns binary_not_found and does not call auth status', async () => {
    const err = Object.assign(new Error('claude not found'), { code: 'ENOENT' });
    const { run, calls } = makeRun({ version: { code: null, stdout: '', error: err } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'binary_not_found' });
    expect(calls.length).toBe(1);
  });

  it('a non-ENOENT runner error returns version_failed', async () => {
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    const { run } = makeRun({ version: { code: null, stdout: '', error: err } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'version_failed' });
  });

  it('a non-zero --version exit returns version_failed', async () => {
    const { run, calls } = makeRun({ version: { code: 2, stdout: '', stderr: 'boom' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'version_failed' });
    expect(calls.length).toBe(1);
  });

  it('output with no x.y.z returns version_unparseable', async () => {
    const { run } = makeRun({ version: { code: 0, stdout: 'Claude Code dev build' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'version_unparseable' });
  });

  it('2.1.258 returns version_too_old', async () => {
    const { run, calls } = makeRun({ version: { code: 0, stdout: '2.1.258 (Claude Code)' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: false, reason: 'version_too_old', version: '2.1.258' });
    expect(calls.length).toBe(1);
  });

  it('exactly 2.1.259 passes the version gate', async () => {
    const { run } = makeRun({ version: { code: 0, stdout: '2.1.259 (Claude Code)' } });
    const r = await probeClaudeCli({ run, parentEnv: {} });
    expect(r).toMatchObject({ ready: true, version: '2.1.259', authMethod: 'claude.ai' });
  });
});

describe('defaultRun — real runner wraps execFile with an explicit timeout (mocked, nothing starts)', () => {
  beforeEach(() => {
    h.execFile.mockReset();
  });

  it('passes env, cwd and the default 15000 ms timeout to execFile', async () => {
    h.execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '2.1.300\n', ''));
    const r = await defaultRun('claude', ['--version'], { env: { PATH: '/usr/bin' }, cwd: '/tmp/x' });
    expect(h.execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = h.execFile.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(['--version']);
    expect(opts).toMatchObject({ env: { PATH: '/usr/bin' }, cwd: '/tmp/x', timeout: 15_000 });
    expect(r).toEqual({ code: 0, stdout: '2.1.300\n', stderr: '', error: null });
  });

  it('passes a caller timeoutMs through as the execFile timeout', async () => {
    h.execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''));
    await defaultRun('claude', ['auth', 'status'], { timeoutMs: 500 });
    expect(h.execFile.mock.calls[0][2].timeout).toBe(500);
  });

  it('resolves a numeric exit code without an error and keeps stdout', async () => {
    h.execFile.mockImplementation((cmd, args, opts, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '{"authMethod":"none"}', ''));
    const r = await defaultRun('claude', ['auth', 'status'], {});
    expect(r).toEqual({ code: 1, stdout: '{"authMethod":"none"}', stderr: '', error: null });
  });

  it('resolves (never rejects) a non-numeric error code such as ENOENT as { code: null, error }', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    h.execFile.mockImplementation((cmd, args, opts, cb) => cb(err, '', ''));
    const r = await defaultRun('claude', ['--version'], {});
    expect(r.code).toBeNull();
    expect(r.error).toBe(err);
  });
});

describe('createProbeCache', () => {
  const READY = { ready: true, reason: null };

  it('returns the cached result within the TTL without probing again', async () => {
    let t = 0;
    const probe = vi.fn(async () => READY);
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => t });
    expect(await cache.get()).toBe(READY);
    t = 999;
    expect(await cache.get()).toBe(READY);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.peek()).toBe(READY);
  });

  it('re-probes once the TTL has elapsed', async () => {
    let t = 0;
    const probe = vi.fn(async () => ({ ...READY }));
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => t });
    await cache.get();
    t = 1000;
    await cache.get();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent get() calls', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const probe = vi.fn(async () => { await gate; return READY; });
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => 0 });
    const p1 = cache.get();
    const p2 = cache.get();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(READY);
    expect(r2).toBe(READY);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes after invalidate()', async () => {
    const probe = vi.fn(async () => ({ ...READY }));
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => 0 });
    await cache.get();
    cache.invalidate();
    expect(cache.peek()).toBeNull();
    await cache.get();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('maps a rejecting probe to { ready: false, reason: probe_error }', async () => {
    const probe = vi.fn(async () => { throw new Error('boom'); });
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => 0 });
    const r = await cache.get();
    expect(r).toMatchObject({ ready: false, reason: 'probe_error', detail: 'boom' });
  });

  it('maps a synchronously throwing probe to probe_error', async () => {
    const probe = vi.fn(() => { throw new Error('sync boom'); });
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => 0 });
    const r = await cache.get();
    expect(r).toMatchObject({ ready: false, reason: 'probe_error', detail: 'sync boom' });
  });

  it('forwards get(opts) to the probe', async () => {
    const probe = vi.fn(async () => READY);
    const cache = createProbeCache({ probe, ttlMs: 1000, now: () => 0 });
    await cache.get({ cwd: '/x' });
    expect(probe).toHaveBeenCalledWith({ cwd: '/x' });
  });
});
