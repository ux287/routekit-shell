/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC2, AC3, AC4, AC5.
 * Hook posture: the hasLlmCredential / isKeyless subscription arm, the opt-in reader, and the hook
 * sites that read them.
 *
 * In-process cells use SYNTHETIC env objects carrying CLAUDE_PROJECT_DIR (a per-case tmp dir), so
 * the runner's own environment and repo .env cannot change any verdict. Hooks are spawned with node
 * exactly as tests/unit/hook-credential-presence-dotenv.test.mjs does, with ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, RKS_SUBSCRIPTION_CREDENTIAL and RKS_GUARDRAILS deleted from the child env unless
 * the case sets them. The status file and opt-in are fixtures. No claude binary, no network, no git
 * repository. Every spawnSync passes timeout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as source from '../../packages/hooks/system/credential-presence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = path.join(REPO_ROOT, 'packages', 'hooks');
const TEMPLATE_HOOKS = path.join(REPO_ROOT, 'templates', 'generic', '.routekit', 'hooks');
const SOURCE_CP = path.join(HOOKS, 'system', 'credential-presence.mjs');
const TEMPLATE_CP = path.join(TEMPLATE_HOOKS, 'system', 'credential-presence.mjs');
const TTL_MS = 10 * 60_000;
const SENTINEL = 'sk-ant-api03-FAKE-SUBSCRIPTION-TEST-SENTINEL';
const KEYLESS_MSG = 'the Research Agent is unavailable';
const SPAWN_TIMEOUT_MS = 15_000;

const dirs = [];
function tmpProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rks-sub-cred-')));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const STATUS_KINDS = ['fresh-ready', 'fresh-not-ready', 'stale', 'absent', 'unreadable'];
function writeStatus(dir, kind) {
  const file = path.join(dir, '.rks', 'state', 'llm-backend.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { version: '2.1.300', ttlMs: TTL_MS, agentsYamlDigest: null };
  const now = Date.now();
  switch (kind) {
    case 'fresh-ready':
      fs.writeFileSync(file, JSON.stringify({ ...base, ready: true, authMethod: 'claude.ai', reason: null, probedAt: now }));
      break;
    case 'fresh-not-ready':
      fs.writeFileSync(file, JSON.stringify({ ...base, ready: false, authMethod: null, reason: 'not_subscription_auth', probedAt: now }));
      break;
    case 'fresh-other-auth':
      fs.writeFileSync(file, JSON.stringify({ ...base, ready: true, authMethod: 'api_key', reason: null, probedAt: now }));
      break;
    case 'stale':
      fs.writeFileSync(file, JSON.stringify({ ...base, ready: true, authMethod: 'claude.ai', reason: null, probedAt: now - 2 * TTL_MS }));
      break;
    case 'unreadable':
      fs.mkdirSync(file); // EISDIR on read: exists but cannot be read
      break;
    case 'unparseable':
      fs.writeFileSync(file, '{ not json');
      break;
    case 'absent':
      break;
    default:
      throw new Error(`unknown status kind ${kind}`);
  }
}

const OPT_IN_VALUES = { on: '1', off: undefined, malformed: 'true' };
/** A synthetic env: only the keys the cell names, plus CLAUDE_PROJECT_DIR. */
function cellEnv(dir, { key = false, optIn = 'off' } = {}) {
  const env = { CLAUDE_PROJECT_DIR: dir };
  if (key) env.ANTHROPIC_API_KEY = SENTINEL;
  if (OPT_IN_VALUES[optIn] !== undefined) env.RKS_SUBSCRIPTION_CREDENTIAL = OPT_IN_VALUES[optIn];
  return env;
}
const expectedKeyless = ({ key, optIn, status }) => !(key || (optIn === 'on' && (status === 'fresh-ready' || status === 'unreadable')));

/** Child env for a spawned hook: credential keys and the opt-in removed unless the cell sets them. */
function childEnv(dir, { key = false, optIn = 'off' } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.RKS_SUBSCRIPTION_CREDENTIAL;
  delete env.RKS_GUARDRAILS;
  if (key) env.ANTHROPIC_API_KEY = SENTINEL;
  if (OPT_IN_VALUES[optIn] !== undefined) env.RKS_SUBSCRIPTION_CREDENTIAL = OPT_IN_VALUES[optIn];
  return env;
}
function runHook(rel, hookData, env) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, rel)], {
    input: JSON.stringify(hookData), encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env,
  });
  return { ...res, combined: `${res.stdout || ''}${res.stderr || ''}` };
}

describe('hasLlmCredential subscription arm (AC2, AC3)', () => {
  it('API key present -> true regardless of opt-in and status (keyed arm unchanged)', () => {
    for (const optIn of Object.keys(OPT_IN_VALUES)) {
      for (const status of STATUS_KINDS) {
        const dir = tmpProject();
        writeStatus(dir, status);
        const env = cellEnv(dir, { key: true, optIn });
        expect(source.hasLlmCredential(env), `${optIn}/${status}`).toBe(true);
        expect(source.hasLlmCredential({ ...cellEnv(dir, { optIn }), OPENAI_API_KEY: SENTINEL }), `openai ${optIn}/${status}`).toBe(true);
      }
    }
  });

  it('no key, opt-in on: true only for a fresh ready claude.ai file; not-ready, other authMethod, stale and ENOENT are false', () => {
    const cases = [['fresh-ready', true], ['fresh-not-ready', false], ['fresh-other-auth', false], ['stale', false], ['absent', false]];
    for (const [kind, want] of cases) {
      const dir = tmpProject();
      writeStatus(dir, kind);
      expect(source.hasLlmCredential(cellEnv(dir, { optIn: 'on' })), kind).toBe(want);
      expect(source.isKeyless(cellEnv(dir, { optIn: 'on' })), kind).toBe(!want);
    }
  });

  it('no key, opt-in on: an unreadable or unparseable status file is ambiguous -> governed (true)', () => {
    for (const kind of ['unreadable', 'unparseable']) {
      const dir = tmpProject();
      writeStatus(dir, kind);
      expect(source.hasLlmCredential(cellEnv(dir, { optIn: 'on' })), kind).toBe(true);
      expect(source.readSubscriptionStatusState(dir), kind).toBe('ambiguous');
    }
  });

  it('the opt-in is exactly "1" from env; every other value is off and leaves hasLlmCredential false', () => {
    const dir = tmpProject();
    writeStatus(dir, 'fresh-ready');
    expect(source.isSubscriptionOptInOn({ CLAUDE_PROJECT_DIR: dir, RKS_SUBSCRIPTION_CREDENTIAL: '1' })).toBe(true);
    expect(source.hasLlmCredential({ CLAUDE_PROJECT_DIR: dir, RKS_SUBSCRIPTION_CREDENTIAL: '1' })).toBe(true);
    for (const off of [undefined, '', 'true', 'yes', '0', ' 1']) {
      const env = { CLAUDE_PROJECT_DIR: dir };
      if (off !== undefined) env.RKS_SUBSCRIPTION_CREDENTIAL = off;
      expect(source.isSubscriptionOptInOn(env), JSON.stringify(off)).toBe(false);
      expect(source.hasLlmCredential(env), JSON.stringify(off)).toBe(false);
    }
  });

  it('with the opt-in absent from env, CLAUDE_PROJECT_DIR/.env turns it on (plain, quoted, trailing comment); =true stays off', () => {
    for (const [line, want] of [
      ['RKS_SUBSCRIPTION_CREDENTIAL=1', true],
      ['RKS_SUBSCRIPTION_CREDENTIAL="1"', true],
      ['RKS_SUBSCRIPTION_CREDENTIAL=1 # this machine has a subscription', true],
      ['RKS_SUBSCRIPTION_CREDENTIAL=true', false],
    ]) {
      const dir = tmpProject();
      fs.writeFileSync(path.join(dir, '.env'), `OTHER=x\n${line}\n`);
      writeStatus(dir, 'fresh-ready');
      const env = { CLAUDE_PROJECT_DIR: dir };
      expect(source.isSubscriptionOptInOn(env), line).toBe(want);
      expect(source.hasLlmCredential(env), line).toBe(want);
    }
  });

  it('the .env read has no upward walk: a parent .env opt-in is ignored', () => {
    const parent = tmpProject();
    const child = path.join(parent, 'child');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(parent, '.env'), 'RKS_SUBSCRIPTION_CREDENTIAL=1\n');
    writeStatus(child, 'fresh-ready');
    expect(source.isSubscriptionOptInOn({ CLAUDE_PROJECT_DIR: child })).toBe(false);
    expect(source.hasLlmCredential({ CLAUDE_PROJECT_DIR: child })).toBe(false);
  });

  it('a .env holding only the opt-in is not an API key; a .env ANTHROPIC_API_KEY still credentials as today', () => {
    const optOnly = tmpProject();
    fs.writeFileSync(path.join(optOnly, '.env'), 'RKS_SUBSCRIPTION_CREDENTIAL=1\n');
    expect(source.hasLlmCredential({ CLAUDE_PROJECT_DIR: optOnly })).toBe(false);
    const keyed = tmpProject();
    fs.writeFileSync(path.join(keyed, '.env'), `ANTHROPIC_API_KEY=${SENTINEL}\n`);
    expect(source.hasLlmCredential({ CLAUDE_PROJECT_DIR: keyed })).toBe(true);
  });

  it('an opt-in written into .rks/project.json is never read', () => {
    const dir = tmpProject();
    writeStatus(dir, 'fresh-ready');
    fs.writeFileSync(path.join(dir, '.rks', 'project.json'), JSON.stringify({
      id: 'fixture', RKS_SUBSCRIPTION_CREDENTIAL: '1', subscriptionCredential: true, llm: { subscriptionCredential: true },
    }));
    expect(source.isSubscriptionOptInOn({ CLAUDE_PROJECT_DIR: dir })).toBe(false);
    expect(source.hasLlmCredential({ CLAUDE_PROJECT_DIR: dir })).toBe(false);
  });

  it('a synthetic env without CLAUDE_PROJECT_DIR never reads cwd; isKeyless({}) true, isKeyless(null) false', () => {
    expect(source.isKeyless({})).toBe(true);
    expect(source.isKeyless(null)).toBe(false);
    expect(source.isSubscriptionOptInOn({})).toBe(false);
    expect(source.hasLlmCredential({ RKS_SUBSCRIPTION_CREDENTIAL: '1' })).toBe(false);

    // Proof by subprocess: cwd holds a .env opt-in AND a fresh ready status file. Synthetic envs
    // still answer keyless; the ambient env (positive control) does read cwd and answers credentialed.
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, '.env'), 'RKS_SUBSCRIPTION_CREDENTIAL=1\n');
    writeStatus(dir, 'fresh-ready');
    const harness = path.join(dir, 'harness.mjs');
    fs.writeFileSync(harness, `
      import { isKeyless, isSubscriptionOptInOn } from ${JSON.stringify(pathToFileURL(SOURCE_CP).href)};
      process.stdout.write(JSON.stringify({
        syntheticKeyless: isKeyless({ RKS_SUBSCRIPTION_CREDENTIAL: '1' }),
        syntheticOptIn: isSubscriptionOptInOn({}),
        ambientKeyless: isKeyless(process.env),
      }));
    `);
    const env = childEnv(dir);
    delete env.CLAUDE_PROJECT_DIR;
    const res = spawnSync(process.execPath, [harness], { cwd: dir, env, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ syntheticKeyless: true, syntheticOptIn: false, ambientKeyless: false });
  });

  it('source and template credential-presence.mjs are byte-identical and give the same verdict on every matrix cell', async () => {
    // A missing template throws here and fails the test; it never skips.
    const srcBytes = fs.readFileSync(SOURCE_CP);
    const tplBytes = fs.readFileSync(TEMPLATE_CP);
    expect(tplBytes.equals(srcBytes)).toBe(true);
    const template = await import(pathToFileURL(TEMPLATE_CP).href);
    for (const key of [true, false]) {
      for (const optIn of Object.keys(OPT_IN_VALUES)) {
        for (const status of STATUS_KINDS) {
          const dir = tmpProject();
          writeStatus(dir, status);
          const env = cellEnv(dir, { key, optIn });
          expect(template.isKeyless(env), `${key}/${optIn}/${status}`).toBe(source.isKeyless(env));
          expect(template.isSubscriptionOptInOn(env)).toBe(source.isSubscriptionOptInOn(env));
        }
      }
    }
  });
});

describe('keyless matrix (AC4)', () => {
  it('isKeyless on every key x opt-in x status cell', () => {
    let cells = 0;
    for (const key of [true, false]) {
      for (const optIn of Object.keys(OPT_IN_VALUES)) {
        for (const status of STATUS_KINDS) {
          const dir = tmpProject();
          writeStatus(dir, status);
          expect(source.isKeyless(cellEnv(dir, { key, optIn })), `key=${key} optIn=${optIn} status=${status}`)
            .toBe(expectedKeyless({ key, optIn, status }));
          cells++;
        }
      }
    }
    expect(cells).toBe(2 * 3 * 5);
  });

  const VERDICT_CELLS = [
    ['keyed', { key: true, optIn: 'off', status: 'absent' }],
    ['subscription fresh-ready, opt-in on', { key: false, optIn: 'on', status: 'fresh-ready' }],
    ['true keyless', { key: false, optIn: 'off', status: 'absent' }],
    ['opt-in on, unreadable status', { key: false, optIn: 'on', status: 'unreadable' }],
  ];
  // [hook, payload(dir), allowed(result)] — allow = exit 0 with empty stdout (enforce: exit 0, block: 2).
  const ALLOW_SITES = [
    ['read/redirect-rag-tools-to-agent.mjs', () => ({ tool_name: 'mcp__rks__rks_rag_query', tool_input: { q: 'how does preflight work?' } }),
      (r) => r.status === 0 && String(r.stdout || '').trim() === ''],
    ['read/enforce-dendron-note-creation.mjs', (dir) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'notes', 'keyless-notes.demo.md') } }),
      (r) => r.status === 0],
    ['write/redirect-dendron-tools-to-agent.mjs', () => ({ tool_name: 'mcp__rks__dendron_create_note', tool_input: { filename: 'keyless-notes.demo', projectId: 'fixture' } }),
      (r) => r.status === 0 && String(r.stdout || '').trim() === ''],
    ['write/redirect-edit-to-governor.mjs', (dir) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'notes', 'keyless-notes.demo.md') } }),
      (r) => r.status === 0 && String(r.stdout || '').trim() === ''],
  ];

  for (const [hook, payload, allowed] of ALLOW_SITES) {
    it(`${hook}, spawned, allows or denies exactly as isKeyless predicts on one cell per verdict class`, () => {
      for (const [label, cell] of VERDICT_CELLS) {
        const dir = tmpProject();
        writeStatus(dir, cell.status);
        const keyless = source.isKeyless(cellEnv(dir, cell));
        expect(keyless, label).toBe(expectedKeyless(cell));
        const res = runHook(hook, payload(dir), childEnv(dir, cell));
        expect(res.error, `${label}: ${res.error}`).toBeUndefined();
        expect(allowed(res), `${label}: status=${res.status} stdout=${String(res.stdout).slice(0, 200)}`).toBe(keyless);
        expect(res.combined).not.toContain(SENTINEL);
      }
    });
  }
});

describe('keyless message sites (AC5)', () => {
  const READ_HOOKS = [
    ['redirect-read-bash-to-agent.mjs', { tool_name: 'Bash', tool_input: { command: 'cat packages/mcp-rks/src/server.mjs' } }],
    ['redirect-read-to-agent.mjs', { tool_name: 'Read', tool_input: { file_path: 'packages/mcp-rks/src/server.mjs' } }],
    ['redirect-grep-to-agent.mjs', { tool_name: 'Grep', tool_input: { pattern: 'foo' } }],
  ];

  for (const [file, hookData] of READ_HOOKS) {
    it(`${file}: true keyless emits the message plus the subscription remedy; a subscription cell does not emit it`, () => {
      const keylessDir = tmpProject();
      const keyless = runHook(path.join('read', file), hookData, childEnv(keylessDir));
      expect(keyless.combined).toContain('Keyless mode (no LLM credential): the Research Agent is unavailable.');
      expect(keyless.combined).toContain('RKS_SUBSCRIPTION_CREDENTIAL=1');
      expect(keyless.combined).toContain('claude /login');
      expect(keyless.combined).toContain('rks_governor_init');
      expect(keyless.combined).toMatch(/Starting any Governor \(rks_governor_init\) re-probes and restores the subscription state/);

      const subDir = tmpProject();
      writeStatus(subDir, 'fresh-ready');
      const sub = runHook(path.join('read', file), hookData, childEnv(subDir, { optIn: 'on' }));
      expect(sub.error).toBeUndefined();
      expect(sub.combined).not.toContain(KEYLESS_MSG);
      expect(sub.combined.length).toBeGreaterThan(0); // still redirected (decision unchanged)
    });
  }

  it('the keyless message text is identical at the six source and template message sites', () => {
    const SITE_RE = /"Keyless mode \(no LLM credential\): the Research Agent is unavailable\.",\s*\n\s*("Subscription route:[^"\n]*")/g;
    const texts = [];
    for (const root of [path.join(HOOKS, 'read'), path.join(TEMPLATE_HOOKS, 'read')]) {
      for (const [file] of READ_HOOKS) {
        // A missing template file throws and fails the test; it never skips.
        const src = fs.readFileSync(path.join(root, file), 'utf8');
        const matches = [...src.matchAll(SITE_RE)];
        expect(matches, `${root}/${file}`).toHaveLength(1);
        texts.push(matches[0][1]);
      }
    }
    expect(texts).toHaveLength(6);
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toMatch(/RKS_SUBSCRIPTION_CREDENTIAL=1/);
    expect(texts[0]).toMatch(/claude \/login/);
    expect(texts[0]).toMatch(/falls back to keyless/);
  });
});
