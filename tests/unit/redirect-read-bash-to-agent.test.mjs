import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyBashCommand, denyReasonFor, denyOptionsFor, nonReadDenyOutput, ALLOWLIST, loadProjectAllowTokens, loadProjectAllowConfig, ignoredTestCommandLine, gitSubcommand, gitWriteKeylessDenyOutput } from '../../packages/hooks/read/redirect-read-bash-to-agent.mjs';

// backlog.fix.child-bash-read-boundary-bypass — Part 4 (secondary).
// Allowlist-first / deny-by-default classifier for the child Bash read-redirect
// hook. Allowlisted toolchain runs directly; recognized reads hand off to the
// Research Agent; anything else — including shell chaining/obfuscation — denies.

describe('classifyBashCommand — allowlist pass-through', () => {
  for (const cmd of ['npm install', 'npm run build', 'node script.mjs', 'npx vitest run', 'git status']) {
    it(`allows: ${cmd}`, () => {
      expect(classifyBashCommand(cmd).action).toBe('allow');
    });
  }
});

describe('classifyBashCommand — reads redirect to the Research Agent', () => {
  for (const cmd of ['cat secrets.txt', 'grep token .env', 'find . -name "*.mjs"', 'rg apiKey', 'head -n5 x', 'ls -la']) {
    it(`redirects: ${cmd}`, () => {
      const r = classifyBashCommand(cmd);
      expect(r.action).toBe('redirect');
      expect(r.kind).toBe('read');
    });
  }
});

describe('classifyBashCommand — deny-by-default + chaining defense', () => {
  it('denies an unknown, non-allowlisted command', () => {
    const r = classifyBashCommand('somerandombinary --flag');
    expect(r.action).toBe('deny');
    expect(r.kind).toBe('unknown');
  });

  it('denies mkdir (mutation not on the allowlist)', () => {
    expect(classifyBashCommand('mkdir build').action).toBe('deny');
  });

  it('denies an allowlisted prefix chained to a read (no smuggling)', () => {
    const r = classifyBashCommand('npm run foo && cat secrets');
    expect(r.action).toBe('deny');
    expect(r.kind).toBe('metacharacter');
  });

  it('denies a pipe to a read', () => {
    expect(classifyBashCommand('cat a | grep b').action).toBe('deny');
  });

  it('denies command substitution', () => {
    expect(classifyBashCommand('echo $(cat /etc/passwd)').action).toBe('deny');
  });

  it('denies an env-prefixed read (leading token not allowlisted)', () => {
    // FOO=bar is the leading token, not "cat" — not allowlisted → deny.
    expect(classifyBashCommand('FOO=bar cat secrets').action).toBe('deny');
  });

  it('classification anchors on the leading token, not a substring', () => {
    // "node" appears in an arg but the command is a read → must redirect, not allow.
    expect(classifyBashCommand('grep node package.json').action).toBe('redirect');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.child-bash-hook-deny-message-misstates-allowlist
// A metacharacter denial used to reuse "not on the child allowlist", so `node --version 2>&1`
// read as "node is not allowed" — the reporters (ux287-bpm, routekit-growth) chased the wrong cause.
// ─────────────────────────────────────────────────────────────────────────────
describe('deny reasons name the rule that actually fired', () => {
  it('bare `node --version` is allowed (the retracted repro)', () => {
    expect(classifyBashCommand('node --version')).toEqual({ action: 'allow', kind: 'allowlisted' });
  });

  it.each([
    'node --version 2>&1',
    `node -e 'import("./packages/mcp-rks/src/shared/commit-and-embed-note.mjs").then(m => m.commitAndEmbedNote({ projectRoot: process.cwd(), slug: "x", content: "..." })).then(r => console.log(JSON.stringify(r)))'`,
    'head -3 notes/backlog.md 2>&1',
    ['cd /tmp/repo &&', 'git', 'clean -f -- notes/x.md'].join(' '),
  ])('the reported command %s is denied as a metacharacter', (cmd) => {
    expect(classifyBashCommand(cmd)).toEqual({ action: 'deny', kind: 'metacharacter' });
  });

  it('exports ALLOWLIST as a frozen read-only view and the pure deny builders', () => {
    expect(Object.isFrozen(ALLOWLIST)).toBe(true);
    expect(typeof ALLOWLIST.has).toBe('function');
    expect(typeof denyReasonFor).toBe('function');
    expect(typeof denyOptionsFor).toBe('function');
    expect(typeof nonReadDenyOutput).toBe('function');
  });

  it('a metacharacter denial says so, keeps the rule text, and does not blame the allowlist', () => {
    const r = denyReasonFor(classifyBashCommand('node --version 2>&1'));
    expect(r).toMatch(/metacharacter/i);
    expect(r).toContain('before its leading verb is considered');
    expect(r).toContain('2>&1');
    expect(r).not.toContain('not on the child allowlist');
    expect(r).not.toContain('run directly');
    expect(r).not.toContain('route the work through a Governor');
  });

  it('an unknown verb lists the whole allowlist, generated, with no ellipsis', () => {
    const r = denyReasonFor(classifyBashCommand('somerandombinary --flag'));
    expect(r).toContain('not on the child allowlist');
    for (const tok of ALLOWLIST) expect(r).toContain(tok);
    expect(r).not.toContain('…');
  });

  it('the unknown text is generated from the allowlist argument (extension seam)', () => {
    const custom = new Set([...ALLOWLIST, 'customtool']);
    const r = denyReasonFor({ action: 'deny', kind: 'unknown' }, custom);
    for (const tok of custom) expect(r).toContain(tok);
  });

  it('metacharacter and unknown reasons differ', () => {
    expect(denyReasonFor({ action: 'deny', kind: 'metacharacter' })).not.toBe(
      denyReasonFor({ action: 'deny', kind: 'unknown' }),
    );
  });

  it('the read-redirect text is unchanged', () => {
    const prefix = 'File reads/searches must go through the Research Agent';
    expect(denyReasonFor({ action: 'redirect', kind: 'read' }).startsWith(prefix)).toBe(true);
    expect(denyReasonFor(classifyBashCommand('cat notes/x.md')).startsWith(prefix)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Revision (reopened scope): frozen allowlist view, non-read denials name the real options.
// ─────────────────────────────────────────────────────────────────────────────
const CO_AUTHOR_CMD = 'git -C /tmp/repo commit -m "fix: x" -m "Co-Authored-By: Name <name@example.com>"';
const ROUTING_MARKERS = ['mcp__rks__rks_agent_research', 'GOVERNOR ROUTING', 'REDIRECT ORDER', 'run (needs governance)'];
const TOKENS = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'git', 'tsc', 'vitest', 'eslint', 'prettier'];

describe('peer witness: Co-Authored-By trailer', () => {
  it('the trailer command is a metacharacter denial with no agent routing', () => {
    const r = classifyBashCommand(CO_AUTHOR_CMD);
    expect(r).toEqual({ action: 'deny', kind: 'metacharacter' });
    const reason = denyReasonFor(r);
    expect(reason).toMatch(/metacharacter/i);
    expect(reason).not.toContain('not on the child allowlist');
    const ctx = nonReadDenyOutput(r).hookSpecificOutput.additionalContext;
    for (const m of ROUTING_MARKERS) expect(ctx).not.toContain(m);
    expect(ctx).toContain('rks_exec');
    expect(ctx).toContain('terminal');
  });

  it('control: the same command without the trailer is not a metacharacter denial (it is a git-write denial)', () => {
    const r = classifyBashCommand('git -C /tmp/repo commit -m "fix: x"');
    expect(r).toEqual({ action: 'deny', kind: 'git-write' });
    expect(r.kind).not.toBe('metacharacter');
  });
});

describe('ALLOWLIST is an immutable read-only view', () => {
  it('cannot be widened, and the classifier is unaffected by attempts', () => {
    expect(ALLOWLIST.add).toBeUndefined();
    expect(ALLOWLIST.delete).toBeUndefined();
    expect(ALLOWLIST.clear).toBeUndefined();
    expect(() => { ALLOWLIST.add = () => {}; }).toThrow(TypeError);
    expect(() => { ALLOWLIST.has = () => true; }).toThrow(TypeError);
    expect(() => Set.prototype.add.call(ALLOWLIST, 'customtool')).toThrow(TypeError);
    expect(classifyBashCommand('customtool --flag')).toEqual({ action: 'deny', kind: 'unknown' });
  });

  it('keeps the same ten tokens in order', () => {
    expect([...ALLOWLIST]).toEqual(TOKENS);
    expect(ALLOWLIST.size).toBe(10);
    expect(ALLOWLIST.has('node')).toBe(true);
    expect(ALLOWLIST.has('customtool')).toBe(false);
  });

  it('control: a plain frozen Set is still mutable (why a freeze alone was rejected)', () => {
    const s = Object.freeze(new Set(['a']));
    expect(() => s.add('b')).not.toThrow();
    expect(s.size).toBe(2);
  });
});

describe('nonReadDenyOutput / denyOptionsFor', () => {
  it('metacharacter case: deny envelope, real options, no routing', () => {
    const r = classifyBashCommand('node --version 2>&1');
    const out = nonReadDenyOutput(r).hookSpecificOutput;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toBe(denyReasonFor(r));
    for (const s of ['rks_exec', 'run_command', 'terminal', '2>&1', 'split']) expect(out.additionalContext).toContain(s);
    for (const m of ROUTING_MARKERS) expect(out.additionalContext).not.toContain(m);
  });

  it('unknown case: lists the allowlist (and a custom one), no routing', () => {
    const r = classifyBashCommand('somerandombinary --flag');
    const out = nonReadDenyOutput(r).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toBe(denyReasonFor(r));
    for (const s of ['rks_exec', 'run_command', 'terminal']) expect(out.additionalContext).toContain(s);
    for (const tok of ALLOWLIST) expect(out.additionalContext).toContain(tok);
    for (const m of ROUTING_MARKERS) expect(out.additionalContext).not.toContain(m);
    const custom = nonReadDenyOutput(r, new Set([...ALLOWLIST, 'customtool'])).hookSpecificOutput.additionalContext;
    expect(custom).toContain('customtool');
  });

  it('denyOptionsFor returns kind-specific string arrays that lead with "not run"', () => {
    const meta = denyOptionsFor(classifyBashCommand('node --version 2>&1'));
    const unk = denyOptionsFor(classifyBashCommand('somerandombinary --flag'));
    for (const arr of [meta, unk]) {
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.every((l) => typeof l === 'string')).toBe(true);
      expect(arr[0]).toMatch(/not run/i);
      expect(arr[0]).toMatch(/no agent can run it/i);
    }
    expect(meta).not.toEqual(unk);
  });
});

describe('main() wiring (spawned hook)', () => {
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'hooks', 'read', 'redirect-read-bash-to-agent.mjs');
  const dirs = [];
  function freshDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-bash-hook-'));
    dirs.push(d);
    return d;
  }
  function runHook(command, root, env = {}) {
    const base = { ...process.env, CLAUDE_PROJECT_DIR: root, RKS_GUARDRAILS: '' };
    const merged = { ...base, ...env };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    return execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env: merged,
      encoding: 'utf8',
      timeout: 10_000,
    });
  }
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  for (const cmd of ['node --version 2>&1', 'somerandombinary --flag', CO_AUTHOR_CMD]) {
    it(`non-read denial is not routed to an agent: ${cmd}`, () => {
      const out = runHook(cmd, freshDir());
      expect(out).toContain('"permissionDecision":"deny"');
      expect(out).toContain('rks_exec');
      for (const m of ROUTING_MARKERS) expect(out).not.toContain(m);
    });
  }

  it('a non-read denial still emits a guardrail bump with no redirect agent', () => {
    const root = freshDir();
    runHook('node --version 2>&1', root);
    const file = path.join(root, '.rks', 'telemetry', `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bump = events.find((e) => e.type === 'hook.guardrail_bump');
    expect(bump).toBeDefined();
    expect(bump.payload.blockedTool).toBe('Bash');
    expect(bump.payload.redirectAgent).toBeNull();
  });

  it('read routing is unchanged (keyed)', () => {
    const out = runHook('cat notes/x.md', freshDir(), { ANTHROPIC_API_KEY: 'test-sentinel-not-a-key' });
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain('mcp__rks__rks_agent_research');
    expect(out).toContain('inspect/search:');
    expect(out).not.toContain('Build/run:');
  });

  it('read routing is unchanged (keyless)', () => {
    const out = runHook('cat notes/x.md', freshDir(), { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined });
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain('mcp__rks__rks_agent_research');
    expect(out).toContain('inspect/search:');
    expect(out).toContain('rks_rag_query');
    expect(out).not.toContain('Build/run:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.feat.child-bash-hook-allow-project-test-command
// A project's own .rks/project.json testCommand.cmd (exact first word) widens the allowlist;
// read verbs and interpreters are refused; config faults fail closed and are NAMED (R9).
// ─────────────────────────────────────────────────────────────────────────────
describe('project-declared testCommand', () => {
  const HOOK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'hooks', 'read', 'redirect-read-bash-to-agent.mjs');
  const tmps = [];
  afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

  // project: undefined → no .rks/project.json; 'DIR' → project.json is a directory; string → raw text.
  function project(config) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-testcmd-'));
    tmps.push(d);
    fs.mkdirSync(path.join(d, '.rks'), { recursive: true });
    const p = path.join(d, '.rks', 'project.json');
    if (config === 'DIR') fs.mkdirSync(p);
    else if (typeof config === 'string') fs.writeFileSync(p, config);
    else if (config !== undefined) fs.writeFileSync(p, JSON.stringify(config));
    return d;
  }
  function run(command, root, env = {}) {
    const merged = { ...process.env, CLAUDE_PROJECT_DIR: root, RKS_GUARDRAILS: '', ...env };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    const r = spawnSync('node', [HOOK_PATH], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env: merged,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', hso: out ? out.hookSpecificOutput : null };
  }
  const denied = (r) => r.hso && r.hso.permissionDecision === 'deny';
  const allowed = (r) => r.status === 0 && !r.stdout.includes('"permissionDecision":"deny"');
  // Rendered allowlist, extracted from the two places the denial prints it (trailing period stripped).
  function renderedLists(hso) {
    const fromReason = hso.permissionDecisionReason.match(/Allowlisted build\/run commands \(([^)]*)\)/)[1].split(', ');
    const ctxLine = hso.additionalContext.split('\n').find((l) => l.startsWith('1. Use an allowlisted command if one does the job. These run directly: '));
    const fromCtx = ctxLine.replace('1. Use an allowlisted command if one does the job. These run directly: ', '').replace(/\.$/, '').split(', ');
    return [fromReason, fromCtx];
  }
  const PYTEST = { testCommand: { cmd: 'pytest', args: ['-q'] } };

  it('AC1: a declared pytest runs directly', () => {
    const root = project(PYTEST);
    expect(allowed(run('pytest -q --no-cov --color=no tests/', root))).toBe(true);
    expect([...loadProjectAllowTokens(root)]).toEqual(['pytest']);
    expect(loadProjectAllowConfig(root).ignored).toBeNull();
    expect(classifyBashCommand('pytest -q --no-cov --color=no tests/', ['pytest']).action).toBe('allow');
  });

  it('AC2: no config, or no testCommand key, changes nothing', () => {
    for (const root of [project(undefined), project({ id: 'x' })]) {
      expect(loadProjectAllowTokens(root).size).toBe(0);
      expect(denied(run('pytest -q tests/', root))).toBe(true);
    }
    expect(classifyBashCommand('pytest -q tests/')).toEqual({ action: 'deny', kind: 'unknown' });
  });

  it('AC3: malformed config and an EISDIR config widen nothing and never crash the hook', () => {
    const configs = ['{not json', { testCommand: 'pytest' }, { testCommand: ['pytest'] }, { testCommand: { args: [] } },
      { testCommand: { cmd: '   ' } }, { testCommand: { cmd: 'pytest', args: 'x' } }, 'DIR'];
    for (const c of configs) {
      const root = project(c);
      expect(() => loadProjectAllowTokens(root)).not.toThrow();
      expect(loadProjectAllowTokens(root).size).toBe(0);
      const r = run('pytest -q tests/', root);
      expect(r.status).toBe(0);
      expect(denied(r)).toBe(true);
      expect(r.stderr).not.toContain('Hook error');
    }
  });

  it('read-boundary guard: a read verb as cmd is refused and reads still redirect', () => {
    const root = project({ testCommand: { cmd: 'cat' } });
    expect(loadProjectAllowTokens(root).size).toBe(0);
    const read = run('cat notes/x.md', root);
    expect(read.stdout).toContain('mcp__rks__rks_agent_research');
    expect(read.stdout).toContain('inspect/search:');
    const unk = run('somerandombinary --flag', root);
    for (const list of renderedLists(unk.hso)) expect(list).not.toContain('cat');
    expect(unk.hso.permissionDecisionReason).toContain('"cat" was ignored (read-verb)');
    expect(loadProjectAllowTokens(project({ testCommand: { cmd: '/bin/cat' } })).size).toBe(0);
    expect(classifyBashCommand('cat x', ['cat'])).toEqual({ action: 'redirect', kind: 'read' });
  });

  it('AC4: metacharacters are still checked first', () => {
    expect(classifyBashCommand('pytest -q tests/ 2>&1', ['pytest']).kind).toBe('metacharacter');
    expect(classifyBashCommand('source venv/bin/activate && pytest -q tests/', ['pytest']).kind).toBe('metacharacter');
    const root = project(PYTEST);
    expect(denied(run('pytest -q tests/ 2>&1', root))).toBe(true);
    expect(denied(run('source venv/bin/activate && pytest -q tests/', root))).toBe(true);
  });

  it('AC5: the one-argument classifier reads no config', () => {
    project(PYTEST);
    expect(classifyBashCommand('pytest -q tests/').kind).toBe('unknown');
  });

  it('AC6: only the project config widens (not HOME, ~/.claude or env)', () => {
    const root = project({ id: 'x' });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-testcmd-home-'));
    tmps.push(home);
    fs.mkdirSync(path.join(home, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rks', 'project.json'), JSON.stringify(PYTEST));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(pytest:*)'] } }));
    const r = run('pytest -q tests/', root, { HOME: home, RKS_BASH_ALLOW: 'pytest' });
    expect(denied(r)).toBe(true);
    expect(r.hso.permissionDecisionReason).toContain('not on the child allowlist');
  });

  it('AC7: first word only, interpreters refused', () => {
    expect(allowed(run('pytest tests/test_other.py --maxfail=1', project(PYTEST)))).toBe(true);
    const py = project({ testCommand: { cmd: 'python', args: ['-m', 'pytest'] } });
    expect(loadProjectAllowTokens(py).size).toBe(0);
    expect(denied(run('python other_script.py', py))).toBe(true);
    expect(denied(run('python -m pytest -q tests/', py))).toBe(true);
    const vpy = project({ testCommand: { cmd: 'venv/bin/python' } });
    expect(loadProjectAllowTokens(vpy).size).toBe(0);
    expect(denied(run('venv/bin/python other_script.py', vpy))).toBe(true);
    for (const cmd of ['python', 'python3', 'bash', 'sh', 'env', 'uv']) {
      expect(loadProjectAllowTokens(project({ testCommand: { cmd } })).size).toBe(0);
    }
  });

  it('a path-shaped cmd is matched exactly', () => {
    const v = project({ testCommand: { cmd: 'venv/bin/pytest' } });
    expect([...loadProjectAllowTokens(v)]).toEqual(['venv/bin/pytest']);
    expect(allowed(run('venv/bin/pytest -q --no-cov --color=no tests/', v))).toBe(true);
    expect(denied(run('./venv/bin/pytest -q tests/', v))).toBe(true);
    expect(denied(run('pytest -q tests/', v))).toBe(true);
    const p = project(PYTEST);
    expect(denied(run('venv/bin/pytest -q tests/', p))).toBe(true);
    expect(denied(run('/tmp/x/pytest -q', p))).toBe(true);
  });

  it('the builtin ALLOWLIST is never widened', () => {
    loadProjectAllowTokens(project(PYTEST));
    expect(ALLOWLIST.size).toBe(10);
    expect(ALLOWLIST.has('pytest')).toBe(false);
  });

  it('the denial renders the effective allowlist', () => {
    const r = run('somerandombinary --flag', project(PYTEST));
    expect(r.hso.permissionDecisionReason).toContain('pytest');
    expect(r.hso.additionalContext).toContain('pytest');
    const plain = run('somerandombinary --flag', project(undefined));
    for (const list of renderedLists(plain.hso)) expect(list).toEqual([...ALLOWLIST]);
  });

  it('R9 spawned: an ignored testCommand is named in the denial and in telemetry', () => {
    const py = project({ testCommand: { cmd: 'python', args: ['-m', 'pytest'] } });
    const a = run('python -m pytest -q tests/', py);
    for (const f of [a.hso.permissionDecisionReason, a.hso.additionalContext]) {
      expect(f).toContain('python');
      expect(f).toContain('interpreter');
    }
    const log = fs.readFileSync(path.join(py, '.routekit', 'telemetry', 'guardrails.log'), 'utf8').trim().split('\n');
    const last = JSON.parse(log[log.length - 1]);
    expect(last.reason).toContain('python');
    expect(last.reason).toContain('interpreter');

    expect(run('pytest -q tests/', project('{not json')).hso.permissionDecisionReason).toContain('was ignored (malformed)');
    expect(run('pytest -q tests/', project('DIR')).hso.permissionDecisionReason).toContain('was ignored (unreadable)');

    const expected = nonReadDenyOutput({ action: 'deny', kind: 'unknown' }).hookSpecificOutput;
    for (const root of [project(undefined), project({ id: 'x' })]) {
      const c = run('somerandombinary --flag', root);
      expect(c.hso.permissionDecisionReason).toBe(expected.permissionDecisionReason);
      expect(c.hso.additionalContext).toBe(expected.additionalContext);
    }
  });

  it('R9 pure: loadProjectAllowConfig names why, and never throws', () => {
    expect(loadProjectAllowConfig(project(undefined)).ignored).toBeNull();
    expect(loadProjectAllowConfig(project({ id: 'x' })).ignored).toBeNull();
    expect(loadProjectAllowConfig(project({ testCommand: { cmd: 'python' } })).ignored).toEqual({ reason: 'interpreter', cmd: 'python' });
    expect(loadProjectAllowConfig(project({ testCommand: { cmd: 'cat' } })).ignored).toEqual({ reason: 'read-verb', cmd: 'cat' });
    expect(loadProjectAllowConfig(project('{not json')).ignored.reason).toBe('malformed');
    expect(loadProjectAllowConfig(project('DIR')).ignored.reason).toBe('unreadable');
    expect(ignoredTestCommandLine(null)).toBe('');
  });

  it('R9 scope guard: metacharacter denials and read redirects carry no ignored line', () => {
    const meta = run('python x.py 2>&1', project({ testCommand: { cmd: 'python' } }));
    expect(meta.hso.permissionDecisionReason).not.toContain('was ignored');
    expect(meta.hso.additionalContext).not.toContain('was ignored');
    expect(run('cat notes/x.md', project({ testCommand: { cmd: 'cat' } })).stdout).not.toContain('was ignored');
  });

  it('dedupe: a declared builtin is listed once', () => {
    const root = project({ testCommand: { cmd: 'npx' } });
    expect([...loadProjectAllowTokens(root)]).toEqual(['npx']);
    expect(loadProjectAllowConfig(root).ignored).toBeNull();
    for (const list of renderedLists(run('somerandombinary --flag', root).hso)) {
      expect(list.filter((t) => t === 'npx')).toHaveLength(1);
      expect(list).toEqual([...ALLOWLIST]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.child-bash-git-write-verbs-bypass-ship-governor (re-land)
// git commit/add/rm/stage are denied before the leading-token allowlist. Keyed mode routes to a
// Governor (Ship Governor ad-hoc Path 3 with files + rawMessage, or rks_agent_git); keyless mode
// denies with no REDIRECT ORDER and points the user to their own terminal.
// ─────────────────────────────────────────────────────────────────────────────
const GIT_WRITE = { action: 'deny', kind: 'git-write' };
const ALLOWLISTED = { action: 'allow', kind: 'allowlisted' };

describe('classifyBashCommand — git write verbs', () => {
  it.each(['git commit -m x', 'git add notes/a.md', 'git rm notes/a.md', 'git stage notes/a.md'])(
    'denies %s as git-write',
    (cmd) => {
      expect(classifyBashCommand(cmd)).toEqual(GIT_WRITE);
    },
  );

  it.each([
    'git -C /tmp/repo commit -m fix',
    'git -c user.name=x commit -m y',
    'git --no-pager add .',
    'git --git-dir=.git rm a.md',
    'git --git-dir .git rm a.md',
    'git --work-tree=. add a.md',
    'git --git-dir .git --work-tree . commit -m x',
    'git -C/tmp/repo add a.md',
  ])('skips global options: %s is git-write', (cmd) => {
    expect(classifyBashCommand(cmd)).toEqual(GIT_WRITE);
  });

  it.each(['git log --grep commit', 'git show HEAD:notes/add.md', 'git show HEAD', 'git commit-tree abc', 'git status', 'git -C add status'])(
    'subcommand detection is token-exact: %s stays allowlisted',
    (cmd) => {
      expect(classifyBashCommand(cmd)).toEqual(ALLOWLISTED);
    },
  );

  it.each([
    'git status', 'git log --oneline -5', 'git diff', 'git rev-parse HEAD', 'git branch',
    'git mv a.md b.md', 'git revert HEAD', 'git push', 'git',
  ])('other git subcommands keep their classification: %s', (cmd) => {
    expect(classifyBashCommand(cmd)).toEqual(ALLOWLISTED);
  });

  it.each(['npm install', 'node script.mjs', 'npx vitest run'])('non-git allowlisted is unchanged: %s', (cmd) => {
    expect(classifyBashCommand(cmd)).toEqual(ALLOWLISTED);
  });

  it('project testCommand widening cannot admit a git write verb', () => {
    expect(classifyBashCommand('git commit -m x', ['git'])).toEqual(GIT_WRITE);
    expect(classifyBashCommand('git add a.md', ['git', 'pytest'])).toEqual(GIT_WRITE);
    expect(classifyBashCommand('git rm a.md', ['git'])).toEqual(GIT_WRITE);
    expect(classifyBashCommand('git stage a.md', ['git'])).toEqual(GIT_WRITE);
  });

  it('the metacharacter check still runs first', () => {
    expect(classifyBashCommand(CO_AUTHOR_CMD)).toEqual({ action: 'deny', kind: 'metacharacter' });
    expect(classifyBashCommand('git add x && git commit -m y')).toEqual({ action: 'deny', kind: 'metacharacter' });
  });

  it('ALLOWLIST still contains git', () => {
    expect(ALLOWLIST.has('git')).toBe(true);
    expect([...ALLOWLIST]).toEqual(TOKENS);
  });
});

describe('gitSubcommand', () => {
  it('returns the first non-option token after git global options', () => {
    expect(gitSubcommand(['git', '-C', '/tmp/repo', 'commit'])).toBe('commit');
    expect(gitSubcommand(['git', '-c', 'user.name=x', 'commit', '-m', 'y'])).toBe('commit');
    expect(gitSubcommand(['git', '--git-dir', '.git', 'rm', 'a.md'])).toBe('rm');
    expect(gitSubcommand(['git', '--git-dir=.git', 'rm', 'a.md'])).toBe('rm');
    expect(gitSubcommand(['git', '--no-pager', 'log'])).toBe('log');
    expect(gitSubcommand(['git', 'status'])).toBe('status');
  });

  it('returns null when there is no subcommand', () => {
    expect(gitSubcommand(['git'])).toBeNull();
    expect(gitSubcommand(['git', '--no-pager'])).toBeNull();
    expect(gitSubcommand(['git', '-C'])).toBeNull();
  });

  it('returns null without throwing for non-array input, and is pure', () => {
    for (const bad of [undefined, null, 'git commit', 42, {}, { length: 2, 0: 'git', 1: 'commit' }]) {
      expect(() => gitSubcommand(bad)).not.toThrow();
      expect(gitSubcommand(bad)).toBeNull();
    }
    const tokens = ['git', '-C', '/tmp/repo', 'commit'];
    const copy = [...tokens];
    expect(gitSubcommand(tokens)).toBe(gitSubcommand(tokens));
    expect(tokens).toEqual(copy);
  });
});

describe('denyReasonFor / gitWriteKeylessDenyOutput — git-write text', () => {
  it('names commit, add, rm and stage, the Path 3 route, and does not blame the allowlist', () => {
    const r = denyReasonFor(GIT_WRITE);
    for (const s of ['commit', 'add', 'rm', 'stage', 'rks_agent_git', 'rawMessage', 'files', 'Ship Governor']) expect(r).toContain(s);
    expect(r).not.toContain('not on the child allowlist');
    expect(r).not.toContain('mcp__rks__rks_agent_research');
    expect(r).not.toContain('run (needs governance)');
    expect(r).not.toBe(denyReasonFor({ action: 'deny', kind: 'unknown' }));
  });

  it('the keyless envelope is a plain deny with no routing, pointing to the terminal', () => {
    const out = gitWriteKeylessDenyOutput(GIT_WRITE).hookSpecificOutput;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toBe(denyReasonFor(GIT_WRITE));
    const text = `${out.permissionDecisionReason}\n${out.additionalContext}`;
    for (const m of ['REDIRECT ORDER', 'GOVERNOR ROUTING', 'mcp__rks__rks_agent_research', 'run (needs governance)']) {
      expect(text).not.toContain(m);
    }
    expect(out.additionalContext).toMatch(/not run/i);
    expect(out.additionalContext).toContain('terminal');
  });
});

describe('main() wiring for git write verbs (spawned hook)', () => {
  const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'hooks', 'read', 'redirect-read-bash-to-agent.mjs');
  const KEYED = { ANTHROPIC_API_KEY: 'test-sentinel-not-a-key' };
  const KEYLESS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };
  const dirs = [];
  function freshDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-bash-gitw-'));
    dirs.push(d);
    return d;
  }
  function run(command, root, env) {
    const merged = { ...process.env, CLAUDE_PROJECT_DIR: root, RKS_GUARDRAILS: '', ...env };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env: merged,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const stdout = r.stdout || '';
    const hso = stdout ? JSON.parse(stdout).hookSpecificOutput : null;
    const text = hso ? `${hso.permissionDecisionReason}\n${hso.additionalContext}` : '';
    return { status: r.status, stdout, hso, text };
  }
  function lastGuardrailsLog(root) {
    const log = fs.readFileSync(path.join(root, '.routekit', 'telemetry', 'guardrails.log'), 'utf8').trim().split('\n');
    return JSON.parse(log[log.length - 1]);
  }
  function bumps(root) {
    const file = path.join(root, '.rks', 'telemetry', `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'hook.guardrail_bump');
  }
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it.each(['git commit -m x', 'git add notes/a.md', 'git rm notes/a.md', 'git stage notes/a.md'])(
    'keyed: %s is denied with a REDIRECT ORDER naming mcp__rks__rks_agent_git',
    (cmd) => {
      const r = run(cmd, freshDir(), KEYED);
      expect(r.status).toBe(0);
      expect(r.hso.permissionDecision).toBe('deny');
      expect(r.text).toContain('REDIRECT ORDER');
      expect(r.text).toContain('mcp__rks__rks_agent_git');
      expect(r.text).not.toContain('run (needs governance)');
      expect(r.text).not.toContain('mcp__rks__rks_agent_research');
      expect(r.text).not.toMatch(/no agent can run it/i);
    },
    15_000,
  );

  it('keyed: the deny text names the verbatim-commit route (Ship Governor Path 3 with files + rawMessage)', () => {
    const r = run('git commit -m x', freshDir(), KEYED);
    expect(r.text).toContain('rawMessage');
    expect(r.text).toContain('files');
    expect(r.text).toMatch(/Ship Governor|\/ship/);
    expect(r.text).toMatch(/not run/i);
  }, 15_000);

  it('keyed: git rm points the user to their terminal and to files (D2)', () => {
    const r = run('git rm notes/a.md', freshDir(), KEYED);
    expect(r.hso.permissionDecision).toBe('deny');
    expect(r.text).toContain('terminal');
    expect(r.text).toContain('files');
  }, 15_000);

  it('keyless: git rm is denied and points the user to their terminal (D2)', () => {
    const r = run('git rm notes/a.md', freshDir(), KEYLESS);
    expect(r.hso.permissionDecision).toBe('deny');
    expect(r.text).toContain('terminal');
  }, 15_000);

  it('keyed: guardrails.log records kind git-write and a single bump routes to rks_agent_git', () => {
    const root = freshDir();
    run('git commit -m x', root, KEYED);
    const entry = lastGuardrailsLog(root);
    expect(entry.hook).toBe('redirect-read-bash-to-agent');
    expect(entry.kind).toBe('git-write');
    const b = bumps(root);
    expect(b).toHaveLength(1);
    expect(b[0].payload.hookName).toBe('redirect-read-bash-to-agent');
    expect(b[0].payload.redirectAgent).toBe('mcp__rks__rks_agent_git');
  }, 15_000);

  it('other denial kinds also carry their own kind in guardrails.log', () => {
    for (const [cmd, kind] of [['node --version 2>&1', 'metacharacter'], ['somerandombinary --flag', 'unknown'], ['cat notes/x.md', 'read']]) {
      const root = freshDir();
      run(cmd, root, KEYED);
      expect(lastGuardrailsLog(root).kind).toBe(kind);
    }
  }, 30_000);

  it('keyless: git commit is still denied, with no REDIRECT ORDER, pointing to the terminal', () => {
    const root = freshDir();
    const r = run('git commit -m x', root, KEYLESS);
    expect(r.status).toBe(0);
    expect(r.hso.permissionDecision).toBe('deny');
    expect(r.text).not.toContain('REDIRECT ORDER');
    expect(r.text).not.toContain('GOVERNOR ROUTING');
    expect(r.text).not.toContain('mcp__rks__rks_agent_research');
    expect(r.text).not.toContain('run (needs governance)');
    expect(r.text).toMatch(/keyless/i);
    expect(r.text).toContain('terminal');
    expect(r.text).toMatch(/not run/i);
    expect(lastGuardrailsLog(root).kind).toBe('git-write');
    const b = bumps(root);
    expect(b).toHaveLength(1);
    expect(b[0].payload.hookName).toBe('redirect-read-bash-to-agent');
    expect(b[0].payload.redirectAgent).toBeNull();
  }, 15_000);

  it('the outage fallthrough does not apply to git-write', () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, '.rks', 'telemetry'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rks', 'telemetry', 'research-agent-outage.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), category: 'network' }),
    );
    // Positive control: the marker is live, so a read falls through (allowed, no output).
    const read = run('cat notes/x.md', root, KEYED);
    expect(read.status).toBe(0);
    expect(read.stdout).toBe('');
    const r = run('git commit -m x', root, KEYED);
    expect(r.hso.permissionDecision).toBe('deny');
  }, 15_000);

  it('git status still exits 0 with no output', () => {
    const r = run('git status', freshDir(), KEYED);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, 15_000);
});

describe('hook copies stay byte-identical to canonical', () => {
  const canonical = new URL('../../packages/hooks/read/redirect-read-bash-to-agent.mjs', import.meta.url);
  const template = new URL('../../templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs', import.meta.url);
  const deployed = new URL('../../.routekit/hooks/read/redirect-read-bash-to-agent.mjs', import.meta.url);

  it('the template copy matches canonical', () => {
    expect(fs.readFileSync(template).equals(fs.readFileSync(canonical))).toBe(true);
  });

  it.skipIf(!fs.existsSync(deployed))(
    'the deployed copy matches canonical (skipped while the read tier is relocated to .routekit/hooks.bak during guardrails-off)',
    () => {
      expect(fs.readFileSync(deployed).equals(fs.readFileSync(canonical))).toBe(true);
    },
  );
});
