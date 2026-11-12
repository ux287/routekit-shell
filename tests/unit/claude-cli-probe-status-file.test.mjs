/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC1.
 * The probe status file <projectRoot>/.rks/state/llm-backend.json and the probe cache's observed
 * probe time. The probe function, probeCache, runCli and the collector are injected; no claude
 * binary is spawned, no subprocess is created and no network is touched. Every status file is
 * written under a per-case os.tmpdir() root, never the repo.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeCache, DEFAULT_PROBE_TTL_MS } from '../../packages/mcp-rks/src/llm/claude-cli/probe.mjs';
import {
  STATUS_FILE_REL, STATUS_FILE_KEYS, buildStatusRecord, writeStatusFile, recordProbeStatus, resolveInitCredential,
} from '../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs';
import { createBackendDispatcher } from '../../packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';
import { readSubscriptionStatusState } from '../../packages/hooks/system/credential-presence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const READY = Object.freeze({ ready: true, authMethod: 'claude.ai', version: '2.1.302', reason: null });
const NOT_READY = Object.freeze({ ready: false, authMethod: null, version: '2.1.302', reason: 'not_subscription_auth' });
const SENTINELS = Object.freeze({
  ANTHROPIC_API_KEY: 'sk-ant-SENTINEL-api-key-0001',
  ANTHROPIC_AUTH_TOKEN: 'SENTINEL-auth-token-0002',
  CLAUDE_CODE_OAUTH_TOKEN: 'SENTINEL-oauth-token-0003',
});

const roots = [];
function tmpRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rks-status-file-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});
const statusPath = (root) => path.join(root, STATUS_FILE_REL);
const readStatus = (root) => JSON.parse(fs.readFileSync(statusPath(root), 'utf8'));

describe('createProbeCache.probedAt() (AC1)', () => {
  it('null before the first probe, the injected now() when the probe ran, unchanged by a fresh hit, updated after invalidate and re-probe', async () => {
    let t = 1_000;
    const probe = vi.fn(async () => READY);
    const cache = createProbeCache({ probe, now: () => t, ttlMs: 60_000 });
    expect(cache.probedAt()).toBeNull();
    await cache.get({ parentEnv: {} });
    expect(cache.probedAt()).toBe(1_000);
    t = 1_500;
    await cache.get({ parentEnv: {} });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(cache.probedAt()).toBe(1_000);
    cache.invalidate();
    expect(cache.probedAt()).toBeNull();
    t = 2_000;
    await cache.get({ parentEnv: {} });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(cache.probedAt()).toBe(2_000);
  });

  it('createProbeCache itself writes no file: probe.mjs has no file-write call', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/llm/claude-cli/probe.mjs'), 'utf8');
    expect(src).not.toMatch(/\b(writeFileSync|writeFile|renameSync|appendFileSync|mkdirSync)\b/);
    expect(src).not.toMatch(/from ['"](node:)?fs['"]/);
  });
});

describe('buildStatusRecord (AC1)', () => {
  it('ready and not-ready probes produce exactly the seven documented keys; extra probe fields contribute nothing', () => {
    for (const probe of [READY, NOT_READY]) {
      const withExtras = { ...probe, token: 'tok-SENTINEL', env: { ANTHROPIC_API_KEY: 'x' }, strippedEnvKeys: ['ANTHROPIC_API_KEY'], detail: 'd', binary: 'claude' };
      const rec = buildStatusRecord(withExtras, { probedAt: 123 });
      expect(Object.keys(rec).sort()).toEqual([...STATUS_FILE_KEYS].sort());
      expect(Object.keys(rec)).toHaveLength(7);
      expect(rec).toEqual({
        ready: probe.ready, authMethod: probe.authMethod, version: probe.version, reason: probe.reason,
        probedAt: 123, ttlMs: DEFAULT_PROBE_TTL_MS, agentsYamlDigest: null,
      });
      expect(JSON.stringify(rec)).not.toContain('SENTINEL');
    }
  });
});

describe('writeStatusFile (AC1)', () => {
  it('writes <projectRoot>/.rks/state/llm-backend.json, creating .rks/state, and leaves no temp file', () => {
    const root = tmpRoot();
    const rec = buildStatusRecord(READY, { probedAt: Date.now() });
    const res = writeStatusFile(root, rec);
    expect(res).toEqual({ ok: true, path: statusPath(root) });
    expect(readStatus(root)).toEqual(rec);
    expect(fs.readdirSync(path.join(root, '.rks', 'state'))).toEqual(['llm-backend.json']);
  });

  it('an unwritable destination returns ok false with an error and does not throw', () => {
    const root = tmpRoot();
    const blocker = path.join(root, 'not-a-dir');
    fs.writeFileSync(blocker, 'a file where a directory is needed');
    let res;
    expect(() => { res = writeStatusFile(blocker, buildStatusRecord(READY, { probedAt: 1 })); }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
  });

  it('the status-file path is gitignored: STATUS_FILE_REL is under .rks/state/ and .gitignore lists .rks/state/', () => {
    expect(STATUS_FILE_REL.startsWith(path.join('.rks', 'state') + path.sep)).toBe(true);
    const lines = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    expect(lines).toContain('.rks/state/');
  });
});

describe('no credential value reaches the file (AC1)', () => {
  it('a probe that echoes its parent env (sentinels) writes no sentinel; resolveInitCredential with the sentinels writes none either', async () => {
    // (a) the probe itself sees the sentinels and returns them in extra fields.
    const root = tmpRoot();
    const echoProbe = vi.fn(async ({ parentEnv }) => ({ ...READY, token: parentEnv.ANTHROPIC_AUTH_TOKEN, env: parentEnv }));
    const cache = createProbeCache({ probe: echoProbe });
    const probe = await cache.get({ parentEnv: { ...SENTINELS, RKS_SUBSCRIPTION_CREDENTIAL: '1' } });
    expect(probe.token).toBe(SENTINELS.ANTHROPIC_AUTH_TOKEN); // positive control: the sentinel was in play
    expect(recordProbeStatus({ projectRoot: root, probe, probeCache: cache }).ok).toBe(true);
    const bytes = fs.readFileSync(statusPath(root), 'utf8');
    for (const s of Object.values(SENTINELS)) expect(bytes).not.toContain(s);

    // (b) resolveInitCredential with all three sentinels: ANTHROPIC_API_KEY makes it 'api' (no file).
    const keyedRoot = tmpRoot();
    const gate = { probeCache: createProbeCache({ probe: echoProbe }) };
    const keyed = await resolveInitCredential({ projectRoot: keyedRoot, env: { ...SENTINELS, RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate });
    expect(keyed.credential).toBe('api');
    expect(fs.existsSync(statusPath(keyedRoot))).toBe(false);

    // (c) the two non-API-key sentinels with the opt-in on: the file is written and holds neither.
    const subRoot = tmpRoot();
    const { ANTHROPIC_API_KEY, ...tokens } = SENTINELS;
    const sub = await resolveInitCredential({ projectRoot: subRoot, env: { ...tokens, RKS_SUBSCRIPTION_CREDENTIAL: '1' }, gate: { probeCache: createProbeCache({ probe: echoProbe }) } });
    expect(sub.credential).toBe('subscription');
    const subBytes = fs.readFileSync(statusPath(subRoot), 'utf8');
    for (const s of Object.values(SENTINELS)) expect(subBytes).not.toContain(s);
  });
});

describe('research dispatcher lazy probe writes the status file (AC1)', () => {
  function recorder() {
    const events = [];
    return { events, emit: (event, projectId, data) => { events.push({ event, projectId, data }); }, flush: async () => {} };
  }
  const run = async ({ projectRoot }) => {
    let t = Date.now();
    const probeCache = createProbeCache({ probe: vi.fn(async () => READY), now: () => t });
    const runCli = vi.fn(async () => ({ ok: true, answer: 'cli' }));
    const d = createBackendDispatcher({ probeCache, runCli, env: {} });
    const config = { name: 'research', projectId: 'p', model: 'm', prompt: 'P', _testCollector: recorder(), ...(projectRoot ? { projectRoot } : {}) };
    const result = await d.execute(config, { executeApi: vi.fn(), systemText: 'S' });
    return { result, probeCache };
  };

  it('with config.projectRoot set to a tmp dir, the file is written there with the observed probedAt', async () => {
    const root = tmpRoot();
    const { result, probeCache } = await run({ projectRoot: root });
    expect(result.answer).toBe('cli');
    const rec = readStatus(root);
    expect(rec.probedAt).toBe(probeCache.probedAt());
    expect(rec.ready).toBe(true);
    expect(readSubscriptionStatusState(root)).toBe('ready');
  });

  it('with no config.projectRoot, no file is written', async () => {
    const root = tmpRoot();
    await run({ projectRoot: null });
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
