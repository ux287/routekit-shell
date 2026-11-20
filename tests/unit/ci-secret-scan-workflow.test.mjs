/**
 * Tests for backlog.security.ci-secret-scan-workflow — static structure of the
 * server-side secret-scan gate in .github/workflows/secret-scan.yml.
 *
 * The behavioral proof that a finding fails the check is the first CI run on a
 * seeded-secret branch (see the story's QA Review section). These tests pin every
 * property of the YAML that the fail-closed, fork-safe, keyless property rests on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const WF_PATH = path.join(REPO_ROOT, '.github/workflows/secret-scan.yml');
const PIN_PATH = path.join(REPO_ROOT, 'scripts/gitleaks-pin.json');
const WF_SRC = fs.existsSync(WF_PATH) ? fs.readFileSync(WF_PATH, 'utf8') : '';
const WF = WF_SRC ? parseYaml(WF_SRC) : null;

const has = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
const jobs = () => Object.values(WF?.jobs ?? {});
const steps = () => jobs().flatMap((j) => j.steps ?? []);
const scanSteps = () =>
  steps().filter((s) => typeof s.run === 'string' && /\bgitleaks\s+(detect|git|dir|protect)\b/.test(s.run));

describe('secret-scan workflow — presence and triggers', () => {
  it('exists at .github/workflows/secret-scan.yml and parses to a mapping with jobs', () => {
    expect(fs.existsSync(WF_PATH)).toBe(true);
    expect(WF).toBeTypeOf('object');
    expect(WF.jobs).toBeTypeOf('object');
  });

  it('triggers on push and on pull_request', () => {
    expect(has(WF.on, 'push')).toBe(true);
    expect(has(WF.on, 'pull_request')).toBe(true);
  });

  it('uses pull_request, not pull_request_target, so fork PRs run with a read-only token', () => {
    expect(has(WF.on, 'pull_request_target')).toBe(false);
  });

  it('has no path filters and does not narrow push to a branch subset', () => {
    for (const trig of ['push', 'pull_request']) {
      const t = WF.on[trig] ?? {};
      expect(has(t, 'paths')).toBe(false);
      expect(has(t, 'paths-ignore')).toBe(false);
    }
    const branches = WF.on.push?.branches;
    expect(branches === undefined || branches.includes('**')).toBe(true);
  });
});

describe('secret-scan workflow — needs no repository secret', () => {
  it('references no secrets expression', () => {
    expect(WF_SRC).not.toMatch(/\bsecrets\./);
  });

  it('top-level permissions are exactly contents: read and no job grants write', () => {
    expect(WF.permissions).toEqual({ contents: 'read' });
    for (const job of jobs()) {
      if (job.permissions && typeof job.permissions === 'object') {
        expect(Object.values(job.permissions)).not.toContain('write');
      }
    }
  });
});

describe('secret-scan workflow — history and config', () => {
  it('checkout fetches full history (fetch-depth: 0)', () => {
    const checkout = steps().find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
    expect(checkout).toBeDefined();
    expect(checkout.with?.['fetch-depth']).toBe(0);
  });

  it('every gitleaks scan passes a --config argument, and the config and pin files exist', () => {
    // The literal path is no longer pinned here: on pull_request the scan passes the
    // base-branch copy (backlog.security.secret-scan-config-from-base-ref). Which path
    // each event uses is proven behaviorally below.
    expect(scanSteps().length).toBeGreaterThan(0);
    for (const s of scanSteps()) expect(s.run).toMatch(/--config[ =]\S+/);
    expect(fs.existsSync(path.join(REPO_ROOT, '.gitleaks.toml'))).toBe(true);
    expect(fs.existsSync(PIN_PATH)).toBe(true);
  });

  it('every gitleaks scan passes --redact', () => {
    for (const s of scanSteps()) expect(s.run).toContain('--redact');
  });
});

describe('secret-scan workflow — fails closed on a finding', () => {
  it('no job or step sets continue-on-error', () => {
    for (const job of jobs()) expect(job['continue-on-error']).toBeFalsy();
    for (const s of steps()) expect(s['continue-on-error']).toBeFalsy();
  });

  it('no scan step swallows a non-zero exit', () => {
    for (const s of scanSteps()) {
      expect(s.run).not.toMatch(/\|\|\s*(true|exit\s+0|:)/);
      expect(s.run).not.toMatch(/set\s+\+e/);
      const m = s.run.match(/--exit-code[ =](\d+)/);
      if (m) expect(Number(m[1])).not.toBe(0);
    }
  });
});

describe('secret-scan workflow — pinned, checksum-verified scanner', () => {
  it('reads the linux-x64 asset from scripts/gitleaks-pin.json', () => {
    expect(WF_SRC).toContain('scripts/gitleaks-pin.json');
    expect(WF_SRC).toContain('linux-x64');
  });

  it('the pin provides a linux-x64 .tar.gz asset with a 64-hex sha256', () => {
    const pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
    const asset = pin.assets['linux-x64'];
    expect(asset.file).toMatch(/\.tar\.gz$/);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the archive with sha256sum -c before extracting with tar -x', () => {
    const verify = WF_SRC.indexOf('sha256sum -c');
    const extract = WF_SRC.indexOf('tar -x');
    expect(verify).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(verify);
  });

  it('hard-codes no gitleaks version and uses only first-party actions', () => {
    expect(WF_SRC).not.toMatch(/\b8\.\d+\.\d+\b/);
    const uses = steps().map((s) => s.uses).filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u.startsWith('actions/')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// backlog.security.secret-scan-config-from-base-ref — behavioral tests.
//
// Each step's `run` script is extracted from the parsed workflow and executed
// under bash (as Actions does: --noprofile --norc -eo pipefail) with stub
// binaries first on PATH. Every stub appends its argv to a log, so the tests
// assert what the script actually invoked and which files it read, not what its
// source text looks like.
// ---------------------------------------------------------------------------

const PR_BASE = 'b1'.repeat(20);
const HEAD_SHA = 'c2'.repeat(20);
const PUSH_BEFORE = 'd3'.repeat(20);
const ZEROS = '0'.repeat(40);
const SPAWN_TIMEOUT_MS = 15_000;
const SEP = '\x1f';
const PIN_BASE_CONTENT = '{"baseUrl":"https://example.invalid/base/","assets":{}}\n';
const CONFIG_BASE_CONTENT = 'title = "base-branch config"\n';
const FAKE_SHA256 = 'e'.repeat(64);

const installStep = () => steps().find((s) => typeof s.run === 'string' && s.run.includes('sha256sum -c'));
const scanStep = () => scanSteps()[0];
const FLAG_IF = "always() && github.event_name == 'pull_request'";
const flagStep = () => steps().find((s) => s.if === FLAG_IF);

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/** Single-quote a string for safe embedding in a bash script. */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run a workflow step's run script under bash with stub binaries.
 * @param {string} script - the step's run text
 * @param {object} opts
 * @param {Record<string,string>} opts.env - step env values
 * @param {Record<string,string>} opts.stubs - command name -> bash body (after argv logging)
 * @param {(tmp:object)=>void} [opts.setup] - prepare files before the run
 */
function runStep(script, { env = {}, stubs = {}, setup } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-step-'));
  tmpDirs.push(root);
  const stubDir = path.join(root, 'bin');
  const runnerTemp = path.join(root, 'runner-temp');
  const work = path.join(root, 'work');
  const summary = path.join(root, 'step-summary.md');
  const log = path.join(root, 'stub.log');
  for (const d of [stubDir, runnerTemp, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(summary, '');
  fs.writeFileSync(log, '');
  for (const [name, body] of Object.entries(stubs)) {
    const file = path.join(stubDir, name);
    fs.writeFileSync(
      file,
      [
        '#!/bin/bash',
        `{ printf '%s' ${sq(name)}; for a in "$@"; do printf '${SEP}%s' "$a"; done; printf '\\n'; } >> ${sq(log)}`,
        body,
        '',
      ].join('\n'),
    );
    fs.chmodSync(file, 0o755);
  }
  const tmp = { root, runnerTemp, work, summary, log };
  if (setup) setup(tmp);
  const scriptFile = path.join(root, 'step.sh');
  fs.writeFileSync(scriptFile, script);
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
    cwd: work,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  });
  expect(res.error).toBeUndefined();
  const calls = fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [cmd, ...args] = line.split(SEP);
      return { cmd, args };
    });
  const record = path.join(runnerTemp, 'secret-scan-inputs.env');
  return {
    ...tmp,
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    calls,
    callsOf: (cmd) => calls.filter((c) => c.cmd === cmd),
    recordLines: () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean) : null),
    summaryText: () => fs.readFileSync(summary, 'utf8'),
  };
}

const gitShowStub = ({ content = '', fail = false } = {}) =>
  [
    'if [ "$1" = "show" ]; then',
    fail ? '  echo "fatal: bad object" >&2; exit 128' : `  printf '%s' ${sq(content)}; exit 0`,
    'fi',
    'echo "unexpected git invocation: $*" >&2; exit 99',
  ].join('\n');

const installStubs = (gitOpts) => ({
  git: gitShowStub({ content: PIN_BASE_CONTENT, ...gitOpts }),
  jq: [
    'case "$2" in',
    "  .baseUrl) echo 'https://example.invalid/dl/' ;;",
    "  *.file) echo 'scanner_linux_x64.tar.gz' ;;",
    `  *.sha256) echo ${sq(FAKE_SHA256)} ;;`,
    '  *) exit 5 ;;',
    'esac',
  ].join('\n'),
  curl: 'exit 0',
  sha256sum: 'cat > /dev/null; exit 0',
  tar: 'exit 0',
  sudo: 'exit 0',
  gitleaks: 'exit 0',
});

const scanStubs = ({ gitleaksExit = 0, ...gitOpts } = {}) => ({
  git: gitShowStub({ content: CONFIG_BASE_CONTENT, ...gitOpts }),
  gitleaks: `exit ${gitleaksExit}`,
});

/** Value of a flag in an argv: `--name value` or `--name=value`. */
function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

const prEnv = { EVENT_NAME: 'pull_request', PR_BASE, HEAD_SHA, PUSH_BEFORE: '' };
const pushEnv = (before) => ({ EVENT_NAME: 'push', PR_BASE: '', HEAD_SHA, PUSH_BEFORE: before });

describe('secret-scan workflow — PR config and pin come from the base SHA', () => {
  it('scan step on pull_request uses git show of the base config, never .gitleaks.toml', () => {
    const r = runStep(scanStep().run, { env: prEnv, stubs: scanStubs() });
    expect(r.status).toBe(0);
    const shows = r.callsOf('git');
    expect(shows).toHaveLength(1);
    expect(shows[0].args).toEqual(['show', `${PR_BASE}:.gitleaks.toml`]);
    const leaks = r.callsOf('gitleaks');
    expect(leaks).toHaveLength(1);
    const config = flagValue(leaks[0].args, '--config');
    expect(config).not.toBe('.gitleaks.toml');
    expect(path.dirname(config)).toBe(r.runnerTemp);
    expect(fs.readFileSync(config, 'utf8')).toBe(CONFIG_BASE_CONTENT);
  });

  it('scan step on pull_request fails closed when git show fails and never runs gitleaks', () => {
    const r = runStep(scanStep().run, { env: prEnv, stubs: scanStubs({ fail: true }) });
    expect(r.status).not.toBe(0);
    expect(r.callsOf('gitleaks')).toHaveLength(0);
  });

  it('scan step on pull_request still passes the PR range, --redact and --exit-code 1', () => {
    const r = runStep(scanStep().run, { env: prEnv, stubs: scanStubs() });
    const [leak] = r.callsOf('gitleaks');
    expect(flagValue(leak.args, '--log-opts')).toBe(`${PR_BASE}..${HEAD_SHA}`);
    expect(leak.args).toContain('--redact');
    expect(flagValue(leak.args, '--exit-code')).toBe('1');
  });

  it('install step on pull_request reads the pin only from git show of the base pin', () => {
    const r = runStep(installStep().run, { env: prEnv, stubs: installStubs() });
    expect(r.status).toBe(0);
    const shows = r.callsOf('git');
    expect(shows).toHaveLength(1);
    expect(shows[0].args).toEqual(['show', `${PR_BASE}:scripts/gitleaks-pin.json`]);
    const jqs = r.callsOf('jq');
    expect(jqs.length).toBeGreaterThanOrEqual(3);
    for (const j of jqs) {
      const file = j.args[j.args.length - 1];
      expect(file).not.toBe('scripts/gitleaks-pin.json');
      expect(path.dirname(file)).toBe(r.runnerTemp);
      expect(fs.readFileSync(file, 'utf8')).toBe(PIN_BASE_CONTENT);
    }
  });

  it('install step on pull_request fails closed when git show fails, before curl, sha256sum or tar', () => {
    const r = runStep(installStep().run, { env: prEnv, stubs: installStubs({ fail: true }) });
    expect(r.status).not.toBe(0);
    for (const cmd of ['curl', 'sha256sum', 'tar']) expect(r.callsOf(cmd)).toHaveLength(0);
  });

  it('install step declares EVENT_NAME and PR_BASE with the same expressions as the scan step', () => {
    const inst = installStep();
    const scan = scanStep();
    for (const key of ['EVENT_NAME', 'PR_BASE']) {
      expect(typeof scan.env?.[key]).toBe('string');
      expect(inst.env?.[key]).toBe(scan.env[key]);
    }
  });
});

describe('secret-scan workflow — push path reads the working tree as before', () => {
  for (const [label, before, range] of [
    ['a real prior tip', PUSH_BEFORE, `${PUSH_BEFORE}..${HEAD_SHA}`],
    ['an empty before', '', HEAD_SHA],
    ['forty zeros', ZEROS, HEAD_SHA],
  ]) {
    it(`scan step on push with ${label} uses .gitleaks.toml and range ${range === HEAD_SHA ? 'HEAD_SHA' : 'before..HEAD_SHA'}`, () => {
      const r = runStep(scanStep().run, { env: pushEnv(before), stubs: scanStubs() });
      expect(r.status).toBe(0);
      expect(r.callsOf('git')).toHaveLength(0);
      const [leak] = r.callsOf('gitleaks');
      expect(flagValue(leak.args, '--config')).toBe('.gitleaks.toml');
      expect(flagValue(leak.args, '--log-opts')).toBe(range);
    });
  }

  it('install step on push never runs git show and every jq reads scripts/gitleaks-pin.json', () => {
    const r = runStep(installStep().run, { env: pushEnv(PUSH_BEFORE), stubs: installStubs() });
    expect(r.status).toBe(0);
    expect(r.callsOf('git')).toHaveLength(0);
    const jqs = r.callsOf('jq');
    expect(jqs.length).toBeGreaterThanOrEqual(3);
    for (const j of jqs) expect(j.args[j.args.length - 1]).toBe('scripts/gitleaks-pin.json');
  });
});

describe('secret-scan workflow — install and scan record the paths they used', () => {
  const onlyLine = (lines, key) => {
    const hits = (lines ?? []).filter((l) => l.startsWith(`${key}=`));
    expect(hits).toHaveLength(1);
    return hits[0].slice(key.length + 1);
  };

  it('install on pull_request records PIN_USED as the RUNNER_TEMP base copy that jq read', () => {
    const r = runStep(installStep().run, { env: prEnv, stubs: installStubs() });
    const pinUsed = onlyLine(r.recordLines(), 'PIN_USED');
    expect(pinUsed).toBe(path.join(r.runnerTemp, 'gitleaks-pin.base.json'));
    for (const j of r.callsOf('jq')) expect(j.args[j.args.length - 1]).toBe(pinUsed);
    expect(r.summaryText()).toContain(pinUsed);
  });

  it('install on push records PIN_USED as scripts/gitleaks-pin.json, the path jq read', () => {
    const r = runStep(installStep().run, { env: pushEnv(PUSH_BEFORE), stubs: installStubs() });
    const pinUsed = onlyLine(r.recordLines(), 'PIN_USED');
    expect(pinUsed).toBe('scripts/gitleaks-pin.json');
    for (const j of r.callsOf('jq')) expect(j.args[j.args.length - 1]).toBe(pinUsed);
    expect(r.summaryText()).toContain('scripts/gitleaks-pin.json');
  });

  it('scan on pull_request records CONFIG_USED as the RUNNER_TEMP base copy passed to --config', () => {
    const r = runStep(scanStep().run, { env: prEnv, stubs: scanStubs() });
    const configUsed = onlyLine(r.recordLines(), 'CONFIG_USED');
    expect(configUsed).toBe(path.join(r.runnerTemp, 'gitleaks.base.toml'));
    expect(flagValue(r.callsOf('gitleaks')[0].args, '--config')).toBe(configUsed);
    expect(r.summaryText()).toContain(configUsed);
  });

  it('scan on push records CONFIG_USED as .gitleaks.toml, the path passed to --config', () => {
    const r = runStep(scanStep().run, { env: pushEnv(PUSH_BEFORE), stubs: scanStubs() });
    const configUsed = onlyLine(r.recordLines(), 'CONFIG_USED');
    expect(configUsed).toBe('.gitleaks.toml');
    expect(flagValue(r.callsOf('gitleaks')[0].args, '--config')).toBe(configUsed);
    expect(r.summaryText()).toContain('.gitleaks.toml');
  });

  it('scan on pull_request records CONFIG_USED even when gitleaks exits 1 (a finding)', () => {
    const r = runStep(scanStep().run, { env: prEnv, stubs: scanStubs({ gitleaksExit: 1 }) });
    expect(r.status).not.toBe(0);
    const configUsed = onlyLine(r.recordLines(), 'CONFIG_USED');
    expect(flagValue(r.callsOf('gitleaks')[0].args, '--config')).toBe(configUsed);
  });
});

// ---------------------------------------------------------------------------
// backlog.fix.secret-scan-gitleaks-download-retry — a transient download failure
// (e.g. HTTP 504, curl exit 22) is retried within bounds; checksum verification
// and fail-closed behavior are unchanged.
// ---------------------------------------------------------------------------

describe('secret-scan workflow — gitleaks download retry', () => {
  const DL_URL = 'https://example.invalid/dl/scanner_linux_x64.tar.gz';
  const DL_OUT = '/tmp/scanner_linux_x64.tar.gz';
  const RETRY_ATTEMPTS_MAX = 10;

  const CURL_ALWAYS_FAIL = 'exit 22';
  /** Fails on its first invocation, succeeds afterwards; exits 0 at once when its
   *  argv carries --retry (curl's own internal retry absorbs the first failure). */
  const CURL_FAIL_ONCE = [
    'for a in "$@"; do [ "$a" = "--retry" ] && exit 0; done',
    'n="$(cat "$HOME/curl.count" 2>/dev/null || echo 0)"; n=$((n + 1)); echo "$n" > "$HOME/curl.count"',
    '[ "$n" -eq 1 ] && exit 22',
    'exit 0',
  ].join('\n');

  const runInstall = (stubOverrides, env = pushEnv(PUSH_BEFORE)) =>
    runStep(installStep().run, {
      env,
      stubs: { ...installStubs(), sleep: 'exit 0', ...stubOverrides },
    });

  const isPosInt = (v) => typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0;
  const isPosNum = (v) => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;

  for (const [label, env] of [
    ['push', pushEnv(PUSH_BEFORE)],
    ['pull_request', prEnv],
  ]) {
    it(`always-failing curl on ${label}: exits non-zero with 1..${RETRY_ATTEMPTS_MAX} curl invocations`, () => {
      const r = runInstall({ curl: CURL_ALWAYS_FAIL }, env);
      expect(r.status).not.toBe(0);
      const n = r.callsOf('curl').length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(RETRY_ATTEMPTS_MAX);
    });
  }

  it('retry policy is bounded and delayed, and every attempt is time-bounded', () => {
    const r = runInstall({ curl: CURL_ALWAYS_FAIL });
    const curls = r.callsOf('curl');
    expect(curls.length).toBeGreaterThanOrEqual(1);
    if (curls.length === 1) {
      const { args } = curls[0];
      const retry = flagValue(args, '--retry');
      expect(retry).toMatch(/^\d+$/);
      expect(Number(retry)).toBeGreaterThanOrEqual(1);
      expect(Number(retry)).toBeLessThanOrEqual(RETRY_ATTEMPTS_MAX);
      const delay = flagValue(args, '--retry-delay');
      const maxTime = flagValue(args, '--retry-max-time');
      expect(delay !== undefined || maxTime !== undefined).toBe(true);
    } else {
      const idx = r.calls.map((c, i) => (c.cmd === 'curl' ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < idx.length; k++) {
        const between = r.calls.slice(idx[k - 1] + 1, idx[k]).filter((c) => c.cmd === 'sleep');
        expect(between.length).toBeGreaterThan(0);
        expect(between.some((c) => isPosNum(c.args[0]))).toBe(true);
      }
    }
    for (const { args } of curls) {
      const perAttempt = flagValue(args, '--max-time') ?? flagValue(args, '-m');
      expect(isPosInt(perAttempt)).toBe(true);
    }
  });

  it('after a transient failure the step succeeds, verifies once after the last download, then extracts', () => {
    const r = runInstall({ curl: CURL_FAIL_ONCE });
    expect(r.status).toBe(0);
    const cmds = r.calls.map((c) => c.cmd);
    const lastCurl = cmds.lastIndexOf('curl');
    expect(lastCurl).toBeGreaterThanOrEqual(0);
    const shaIdx = cmds.map((c, i) => (c === 'sha256sum' ? i : -1)).filter((i) => i >= 0);
    expect(shaIdx).toHaveLength(1);
    expect(shaIdx[0]).toBeGreaterThan(lastCurl);
    const tarIdx = cmds.indexOf('tar');
    expect(tarIdx).toBeGreaterThan(shaIdx[0]);
  });

  it('a checksum mismatch after a successful download fails before tar, sudo or gitleaks', () => {
    const r = runInstall({ curl: 'exit 0', sha256sum: 'cat > /dev/null; exit 1' });
    expect(r.status).not.toBe(0);
    for (const cmd of ['tar', 'sudo', 'gitleaks']) expect(r.callsOf(cmd)).toHaveLength(0);
  });

  it('when every download attempt fails, no sha256sum, tar, sudo or gitleaks runs', () => {
    const r = runInstall({ curl: CURL_ALWAYS_FAIL });
    for (const cmd of ['sha256sum', 'tar', 'sudo', 'gitleaks']) expect(r.callsOf(cmd)).toHaveLength(0);
  });

  it('when every download attempt fails, the output names the download as the cause', () => {
    const r = runInstall({ curl: CURL_ALWAYS_FAIL });
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/download/i);
  });

  it('every curl invocation requests the pin-derived URL and writes it to /tmp via -o', () => {
    for (const curl of [CURL_ALWAYS_FAIL, CURL_FAIL_ONCE, 'exit 0']) {
      const r = runInstall({ curl });
      const curls = r.callsOf('curl');
      expect(curls.length).toBeGreaterThan(0);
      for (const { args } of curls) {
        expect(args).toContain(DL_URL);
        expect(flagValue(args, '-o')).toBe(DL_OUT);
      }
    }
  });

  it('the install step adds no URL literal and the workflow no version literal', () => {
    expect(installStep().run).not.toMatch(/https?:\/\//);
    expect(WF_SRC).not.toMatch(/\b8\.\d+\.\d+\b/);
  });
});

describe('secret-scan workflow — flag step reports changed scan inputs', () => {
  const PROTECTED = ['.gitleaks.toml', 'scripts/gitleaks-pin.json', '.github/workflows/secret-scan.yml'];
  const UNRELATED = 'src/unrelated.mjs';
  const flagEnv = { PR_BASE, HEAD_SHA };

  /** Stub git whose `diff --name-only` lists `files`, filtered by any pathspecs after `--`. */
  const gitDiffStub = (files, { fail = false } = {}) =>
    [
      'if [ "$1" != "diff" ]; then echo "unexpected git invocation: $*" >&2; exit 99; fi',
      fail ? 'echo "fatal: bad revision" >&2; exit 128' : '',
      'specs=""; seen=0',
      'for a in "$@"; do',
      '  if [ "$seen" = 1 ]; then specs="${specs}${a%/}"$\'\\n\'; elif [ "$a" = "--" ]; then seen=1; fi',
      'done',
      `for f in ${files.map(sq).join(' ')}; do`,
      '  if [ -z "$specs" ]; then echo "$f"; continue; fi',
      '  while IFS= read -r s; do',
      '    [ -z "$s" ] && continue',
      '    case "$f" in "$s"|"$s"/*) echo "$f"; break ;; esac',
      '  done <<< "$specs"',
      'done',
    ].join('\n');

  const runFlag = ({ record, files = [...PROTECTED, UNRELATED], fail = false } = {}) =>
    runStep(flagStep().run, {
      env: flagEnv,
      stubs: { git: gitDiffStub(files, { fail }) },
      setup: (t) => {
        if (record) fs.writeFileSync(path.join(t.runnerTemp, 'secret-scan-inputs.env'), record(t));
      },
    });

  const baseRecord = (t) =>
    `CONFIG_USED=${path.join(t.runnerTemp, 'gitleaks.base.toml')}\nPIN_USED=${path.join(t.runnerTemp, 'gitleaks-pin.base.json')}\n`;
  const warnings = (r) => r.stdout.split('\n').filter((l) => l.startsWith('::warning'));

  it('exists after the scan step, runs always() on pull_request only, and is not a scan step', () => {
    const job = jobs().find((j) => (j.steps ?? []).includes(scanStep()));
    const flag = flagStep();
    expect(flag).toBeDefined();
    expect(flag.if).toBe(FLAG_IF);
    expect(job.steps.indexOf(flag)).toBeGreaterThan(job.steps.indexOf(scanStep()));
    expect(scanSteps()).not.toContain(flag);
  });

  it('warns once per changed protected path and writes them to the step summary', () => {
    const r = runFlag({ record: baseRecord });
    expect(r.status).toBe(0);
    const w = warnings(r);
    expect(w).toHaveLength(PROTECTED.length);
    for (const p of PROTECTED) expect(w.filter((l) => l.includes(`file=${p}::`))).toHaveLength(1);
    expect(w.some((l) => l.includes(UNRELATED))).toBe(false);
    const summary = r.summaryText();
    for (const p of PROTECTED) expect(summary).toContain(p);
    expect(summary).not.toContain(UNRELATED);
  });

  it('with a base-copy record, says base-branch copy with the recorded paths verbatim', () => {
    const r = runFlag({ record: baseRecord });
    const cfg = path.join(r.runnerTemp, 'gitleaks.base.toml');
    const pin = path.join(r.runnerTemp, 'gitleaks-pin.base.json');
    const w = warnings(r);
    expect(w.length).toBeGreaterThan(0);
    for (const l of w) {
      expect(l).toContain(`scan config used: base-branch copy (${cfg})`);
      expect(l).toContain(`scanner pin used: base-branch copy (${pin})`);
    }
    expect(r.summaryText()).toContain(cfg);
    expect(r.summaryText()).toContain(pin);
  });

  it('with a PR-tree record, says (not the base-branch copy) and never base-branch copy (', () => {
    const r = runFlag({ record: () => 'CONFIG_USED=.gitleaks.toml\nPIN_USED=scripts/gitleaks-pin.json\n' });
    expect(r.status).toBe(0);
    const w = warnings(r);
    expect(w.length).toBeGreaterThan(0);
    for (const l of w) {
      expect(l).toContain('scan config used: .gitleaks.toml (not the base-branch copy)');
      expect(l).toContain('scanner pin used: scripts/gitleaks-pin.json (not the base-branch copy)');
      expect(l).not.toContain('base-branch copy (');
    }
  });

  it('with no record file, exits 0 and says unknown (no record)', () => {
    const r = runFlag({});
    expect(r.status).toBe(0);
    const w = warnings(r);
    expect(w).toHaveLength(PROTECTED.length);
    for (const l of w) {
      expect(l).toContain('scan config used: unknown (no record)');
      expect(l).toContain('scanner pin used: unknown (no record)');
      expect(l).not.toContain('base-branch copy (');
    }
  });

  it('prints no warning when no protected path changed', () => {
    const r = runFlag({ record: baseRecord, files: [UNRELATED, 'README.md'] });
    expect(r.status).toBe(0);
    expect(warnings(r)).toHaveLength(0);
  });

  it('does not mask a git diff failure', () => {
    const r = runFlag({ record: baseRecord, fail: true });
    expect(r.status).not.toBe(0);
  });

  it('computes the diff from both the PR base and head SHAs', () => {
    const r = runFlag({ record: baseRecord });
    const diffs = r.callsOf('git').filter((c) => c.args[0] === 'diff');
    expect(diffs.length).toBeGreaterThan(0);
    const joined = diffs[0].args.join(' ');
    expect(joined).toContain(PR_BASE);
    expect(joined).toContain(HEAD_SHA);
  });

  it('reads the record by line match, never by sourcing it', () => {
    expect(flagStep().run).not.toMatch(/(^|[\s;])(source|\.)\s+\S*secret-scan-inputs|(source|\.)\s+"?\$\{?REC\b/m);
  });
});
