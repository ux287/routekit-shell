/**
 * backlog.fix.child-bash-protected-rks-config-write-routes
 *
 * Child Bash (guardrails on, read tier) and off-rail (system tier) denial of the Bash routes that can
 * rewrite protected rks config: git apply / git am, git checkout / git restore pathspecs reaching a
 * protected path, and any non-read command naming one (npx, node, a project testCommand token, ...).
 * The protected path lists live in one shared module, packages/hooks/lib/protected-rks-paths.mjs,
 * loaded by guarded dynamic import so a failed or malformed load fails closed.
 *
 * Every spawn runs the CANONICAL hook (or a temp copy of it) against a fresh fs.mkdtempSync root under
 * os.tmpdir(), removed in afterEach; nothing touches the repository's own .rks or .routekit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonicalHookPath } from '../helpers/hook-path.mjs';
import {
  classifyBashCommand,
  denyReasonFor,
  nonReadDenyOutput,
} from '../../packages/hooks/read/redirect-read-bash-to-agent.mjs';
import {
  PROTECTED_CONFIG_PATHS,
  PROTECTED_STATE_PATHS,
} from '../../packages/hooks/lib/protected-rks-paths.mjs';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const HOOKS_SRC = path.join(REPO_ROOT, 'packages', 'hooks');
const OFF_RAIL_HOOK = canonicalHookPath('system/block-git-during-off-rail.mjs');
const READ_HOOK = canonicalHookPath('read/redirect-read-bash-to-agent.mjs');
const PROTECTED = { action: 'deny', kind: 'protected-config' };
const ALLOWLISTED = { action: 'allow', kind: 'allowlisted' };
const READ_REDIRECT = { action: 'redirect', kind: 'read' };
const ALL_PROTECTED = [...PROTECTED_CONFIG_PATHS, ...PROTECTED_STATE_PATHS];
const NO_DISABLE = /hooks\.bak|disabl\w*\s+(the\s+)?hooks|turn\s+(the\s+)?hooks\s+off|move\s+(the\s+)?hooks/i;

// Every temp directory made by a test; all are removed in afterEach.
let tempDirs = [];
function mkTemp(prefix = 'rks-bpc-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function makeRoot({ offRail = true } = {}) {
  const root = mkTemp();
  fs.mkdirSync(path.join(root, '.rks', 'rag'), { recursive: true });
  if (offRail) fs.mkdirSync(path.join(root, '.routekit', 'hooks.bak'), { recursive: true });
  return root;
}

function writeScope(root, scope) {
  const body = typeof scope === 'string' ? scope : JSON.stringify(scope);
  fs.writeFileSync(path.join(root, '.rks', 'active-scope.json'), body);
}

/**
 * Spawn a hook for one Bash command. The single spawnSync call carries the timeout literally; a
 * timed-out or failed child process sets result.error, which is thrown, so it fails the test
 * instead of reading as an allow.
 */
function runHook(hookPath, command, { projectDir, cwd } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, RKS_GUARDRAILS: '' };
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    cwd: cwd || projectDir,
    env,
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  let out = null;
  try { out = JSON.parse(result.stdout); } catch { out = null; }
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    decision: out?.hookSpecificOutput?.permissionDecision ?? null,
    reason: out?.hookSpecificOutput?.permissionDecisionReason ?? '',
    context: out?.hookSpecificOutput?.additionalContext ?? '',
    routedAgent: ((out?.hookSpecificOutput?.additionalContext ?? '').match(/^\s*agent:\s*(\S+)/m) || [])[1] || null,
  };
}

const runOffRail = (root, command, opts = {}) => runHook(OFF_RAIL_HOOK, command, { projectDir: root, ...opts });

function expectAllowed(r) {
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
}
function expectDenied(r) {
  expect(r.code).toBe(0);
  expect(r.decision).toBe('deny');
}

let root;
beforeEach(() => { tempDirs = []; root = makeRoot(); });
afterEach(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared lib
// ─────────────────────────────────────────────────────────────────────────────
describe('protected-rks-paths lib', () => {
  it('exports the config and state classes as frozen arrays', () => {
    expect(new Set(PROTECTED_CONFIG_PATHS)).toEqual(new Set([
      '.rks/project.json', '.rks/rag/config.json', '.routekit/command-policy.yaml', '.rks/protected-files.yml',
    ]));
    expect(new Set(PROTECTED_STATE_PATHS)).toEqual(new Set([
      '.rks/active-scope.json', '.rks/telemetry/research-agent-outage.json', '.rks/guardrails-state.json',
    ]));
    expect(PROTECTED_CONFIG_PATHS).toHaveLength(4);
    expect(PROTECTED_STATE_PATHS).toHaveLength(3);
    expect(Object.isFrozen(PROTECTED_CONFIG_PATHS)).toBe(true);
    expect(Object.isFrozen(PROTECTED_STATE_PATHS)).toBe(true);
  });

  it('is the single source: both hooks load it by guarded dynamic import and hold no copy of the list', () => {
    for (const rel of ['read/redirect-read-bash-to-agent.mjs', 'system/block-git-during-off-rail.mjs']) {
      const src = fs.readFileSync(path.join(HOOKS_SRC, rel), 'utf8');
      expect(src, rel).toContain('protected-rks-paths.mjs');
      expect(src, rel).toContain('await import(');
      expect(src, rel).not.toMatch(/^\s*import\s[^(]*protected-rks-paths/m);
      expect(src, rel).not.toContain('rag/config.json');
      expect(src, rel).not.toContain('guardrails-state.json');
    }
    const lib = fs.readFileSync(path.join(HOOKS_SRC, 'lib', 'protected-rks-paths.mjs'), 'utf8');
    for (const imp of ['read/redirect-read-bash-to-agent.mjs', 'system/block-git-during-off-rail.mjs', 'system/protect-system-files.mjs']) {
      expect(lib).toContain(imp);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guardrails on: classifyBashCommand
// ─────────────────────────────────────────────────────────────────────────────
describe('child Bash (guardrails on): git apply and git am', () => {
  it.each([
    'git apply x.patch', 'git apply --cached x.patch', 'git apply --check x.patch', 'git am x.mbox', 'git apply', 'git am',
  ])('%s is protected-config', (cmd) => {
    expect(classifyBashCommand(cmd, undefined, root)).toMatchObject(PROTECTED);
  });
});

describe('child Bash (guardrails on): checkout and restore pathspecs', () => {
  const cases = () => [
    'git checkout HEAD -- .rks/project.json',
    'git checkout main -- .rks/rag/config.json',
    'git checkout -- .rks',
    'git checkout -- .routekit',
    'git checkout .rks/telemetry',
    'git checkout .',
    'git checkout -- .',
    'git restore .',
    'git restore --staged .',
    'git restore .rks/project.json',
    'git restore --source=HEAD~1 .rks/rag/config.json',
    "git restore '*.json'",
    "git restore ':/'",
    "git checkout HEAD -- ':(top)'",
    'git restore ./.rks/../.rks/project.json',
    'git restore src/../.rks',
    'git restore .RKS/Project.json',
    'git -C .rks checkout -- project.json',
  ];
  it.each(cases())('%s is protected-config', (cmd) => {
    expect(classifyBashCommand(cmd, undefined, root)).toMatchObject(PROTECTED);
  });
  it('git restore <absolute path of .rks/project.json> is protected-config', () => {
    const abs = path.join(root, '.rks', 'project.json');
    expect(classifyBashCommand(`git restore ${abs}`, undefined, root)).toMatchObject(PROTECTED);
  });
});

describe('child Bash (guardrails on): branch navigation and narrow pathspecs stay allowed', () => {
  it.each([
    'git checkout main', 'git checkout -b feature/x', 'git switch main', 'git restore src/app.ts',
    'git checkout -- src/app.ts', 'git checkout main -- src/app.ts', 'git restore src', 'git checkout',
    'git restore', 'git status', 'git diff',
  ])('%s stays exactly allowlisted', (cmd) => {
    expect(classifyBashCommand(cmd, undefined, root)).toEqual(ALLOWLISTED);
  });
});

describe('child Bash (guardrails on): any allowlisted verb naming a protected path', () => {
  it.each([
    "npx json -I -f .rks/project.json -e 'this.offRail.roots=[\"*\"]'",
    'npx some-tool --file=.rks/rag/config.json',
    'npx some-tool --file=rag/config.json',
    'node scripts/x.mjs .rks/project.json',
    'npx prettier --write .routekit/command-policy.yaml',
    'node x.mjs .rks/protected-files.yml',
    'node x.mjs .rks/active-scope.json',
    'node x.mjs .rks/telemetry/research-agent-outage.json',
    'node x.mjs .rks/guardrails-state.json',
    'node x.mjs .RKS/PROJECT.JSON',
    'git diff .rks/project.json',
    'git log -- .rks/active-scope.json',
  ])('%s is protected-config', (cmd) => {
    expect(classifyBashCommand(cmd, undefined, root)).toMatchObject(PROTECTED);
  });
  it('node scripts/x.mjs <absolute path of .rks/project.json> is protected-config', () => {
    const abs = path.join(root, '.rks', 'project.json');
    expect(classifyBashCommand(`node scripts/x.mjs ${abs}`, undefined, root)).toMatchObject(PROTECTED);
  });
  it('the result names the protected path', () => {
    expect(classifyBashCommand('node x.mjs .rks/project.json', undefined, root).paths).toEqual(['.rks/project.json']);
  });
});

describe('child Bash (guardrails on): no false positives on near misses', () => {
  it.each([
    'npx vitest run', 'npm test', 'npx vitest run tests/unit/protect-system-files.test.mjs',
    'node scripts/x.mjs project.json', 'node x.mjs .rks/other.json',
  ])('%s stays exactly allowlisted', (cmd) => {
    expect(classifyBashCommand(cmd, undefined, root)).toEqual(ALLOWLISTED);
  });
});

describe('child Bash (guardrails on): existing kinds keep precedence', () => {
  it('read verbs keep redirect/read', () => {
    expect(classifyBashCommand('cat .rks/project.json', undefined, root)).toEqual(READ_REDIRECT);
    expect(classifyBashCommand('grep x .rks/rag/config.json', undefined, root)).toEqual(READ_REDIRECT);
  });
  it('git write verbs keep git-write', () => {
    expect(classifyBashCommand('git add .rks/project.json', undefined, root).kind).toBe('git-write');
    expect(classifyBashCommand('git commit -m x -- .rks/project.json', undefined, root).kind).toBe('git-write');
  });
  it('git config injection keeps git-exec', () => {
    expect(classifyBashCommand('git -c core.pager=less log -- .rks/project.json', undefined, root).kind).toBe('git-exec');
  });
});

const READ_VERBS = [
  'cat', 'less', 'more', 'head', 'tail', 'tac', 'nl',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'find', 'fd', 'ls', 'tree', 'stat',
  'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'column',
  'od', 'xxd', 'strings', 'hexdump', 'diff', 'view',
];

describe('child Bash (guardrails on): read verbs keep the read redirect (ARCH Item 11)', () => {
  it('lists the 31 READ_COMMANDS verbs', () => {
    expect(READ_VERBS).toHaveLength(31);
    expect(ALL_PROTECTED).toHaveLength(7);
  });
  const cases = READ_VERBS.flatMap((v) => ALL_PROTECTED.map((p) => `${v} ${p}`));
  it.each(cases)('%s stays redirect/read', (cmd) => {
    expect(classifyBashCommand(cmd, undefined, root)).toEqual(READ_REDIRECT);
  });
  it('sed -i s/a/b/ .rks/project.json stays redirect/read', () => {
    expect(classifyBashCommand('sed -i s/a/b/ .rks/project.json', undefined, root)).toEqual(READ_REDIRECT);
  });
});

describe('child Bash (guardrails on): a project testCommand cannot widen past the check', () => {
  it('pytest naming .rks/project.json is protected-config; pytest -q stays allowlisted', () => {
    expect(classifyBashCommand('pytest .rks/project.json', ['pytest'])).toMatchObject(PROTECTED);
    expect(classifyBashCommand('pytest -q', ['pytest'])).toMatchObject(ALLOWLISTED);
  });
});

describe('child Bash (guardrails on): deny text', () => {
  const texts = (cmd) => {
    const result = classifyBashCommand(cmd, undefined, root);
    expect(result).toMatchObject(PROTECTED);
    const out = nonReadDenyOutput(result).hookSpecificOutput;
    return [denyReasonFor(result), `${out.permissionDecisionReason}\n${out.additionalContext}`];
  };

  it('a config-class path names the file, the story route and a direct user edit', () => {
    for (const t of texts('npx json -I -f .rks/project.json -e x=1')) {
      expect(t).toContain('.rks/project.json');
      expect(t).toMatch(/story whose targetFiles lists its exact path/);
      expect(t).toMatch(/guardrails-off/);
      expect(t).toMatch(/user to edit the file directly/);
      expect(t).not.toMatch(NO_DISABLE);
    }
  });
  it('a state-class path says it is written only by the rks MCP server', () => {
    for (const t of texts('node x.mjs .rks/active-scope.json')) {
      expect(t).toContain('.rks/active-scope.json');
      expect(t).toMatch(/written only by the rks MCP server/);
      expect(t).not.toMatch(NO_DISABLE);
    }
  });
  it('git apply and git am say a patch target cannot be verified from the command', () => {
    for (const cmd of ['git apply x.patch', 'git am x.mbox']) {
      for (const t of texts(cmd)) {
        expect(t).toMatch(/target files cannot be verified from the command/);
        expect(t).not.toMatch(NO_DISABLE);
      }
    }
  });
  it('git checkout . and git restore . suggest narrowing the pathspec', () => {
    for (const cmd of ['git checkout .', 'git restore .']) {
      for (const t of texts(cmd)) {
        expect(t).toMatch(/narrow the pathspec/);
        expect(t).not.toMatch(NO_DISABLE);
      }
    }
  });
});

describe('child Bash (guardrails on): spawned canonical read hook', () => {
  it('denies git checkout -- .rks/project.json with the non-read deny and allows git status', () => {
    const onRail = makeRoot({ offRail: false });
    const denied = runHook(READ_HOOK, 'git checkout -- .rks/project.json', { projectDir: onRail });
    expect(denied.code).toBe(0);
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain('.rks/project.json');
    expect(denied.context).toMatch(/no agent can run it for you/);
    expect(denied.context).not.toMatch(/REDIRECT ORDER/);
    const allowed = runHook(READ_HOOK, 'git status', { projectDir: onRail });
    expectAllowed(allowed);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read hook: fail-closed lib load
// ─────────────────────────────────────────────────────────────────────────────
async function importReadHookCopy(mutateLib) {
  const tmp = mkTemp('rks-bpc-hooks-');
  for (const tier of ['read', 'system', 'lib']) {
    fs.cpSync(path.join(HOOKS_SRC, tier), path.join(tmp, tier), { recursive: true });
  }
  mutateLib(path.join(tmp, 'lib', 'protected-rks-paths.mjs'));
  return import(pathToFileURL(path.join(tmp, 'read', 'redirect-read-bash-to-agent.mjs')).href);
}

describe('read hook: fail-closed lib load', () => {
  const failures = {
    deleted: (p) => fs.rmSync(p),
    malformed: (p) => fs.writeFileSync(p, 'export const OTHER = 1;\n'),
  };
  for (const [name, mutate] of Object.entries(failures)) {
    it(`lib ${name}: classifies fail-closed, read and plain build commands unchanged`, async () => {
      const mod = await importReadHookCopy(mutate);
      const classify = (cmd) => mod.classifyBashCommand(cmd, undefined, root);
      for (const cmd of [
        "npx json -I -f .rks/project.json -e 'x=1'", 'node x.mjs .rks/other.json', 'node x.mjs .ROUTEKIT/x.yaml',
        'git apply x.patch', 'git checkout -- src/app.ts', 'git restore src/app.ts',
      ]) {
        expect(classify(cmd), cmd).toMatchObject(PROTECTED);
      }
      expect(classify('cat .rks/project.json')).toEqual(READ_REDIRECT);
      expect(classify('npm test')).toEqual(ALLOWLISTED);
      expect(classify('git status')).toEqual(ALLOWLISTED);
    });
  }
  it('positive control: with the lib present the same copy allows .rks/other.json and a narrow restore', async () => {
    const mod = await importReadHookCopy(() => {});
    expect(mod.classifyBashCommand('node x.mjs .rks/other.json', undefined, root)).toEqual(ALLOWLISTED);
    expect(mod.classifyBashCommand('git restore src/app.ts', undefined, root)).toEqual(ALLOWLISTED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Off-rail: system-tier block-git-during-off-rail.mjs
// ─────────────────────────────────────────────────────────────────────────────
describe('off-rail: protected commands are denied (no scope file)', () => {
  it.each([
    ['git apply x.patch', null],
    ['git am x.mbox', null],
    ['git checkout HEAD -- .rks/project.json', '.rks/project.json'],
    ['git checkout HEAD -- .', '.rks/project.json'],
    ['git checkout HEAD -- .rks', '.rks/project.json'],
    ["npx json -I -f .rks/project.json -e 'x=1'", '.rks/project.json'],
    [`node -e "require('fs').writeFileSync('.rks/active-scope.json', '{}')"`, '.rks/active-scope.json'],
    ["echo '{}' > .rks/guardrails-state.json", '.rks/guardrails-state.json'],
    ['cat .rks/telemetry/research-agent-outage.json', '.rks/telemetry/research-agent-outage.json'],
    ['git diff .rks/project.json', '.rks/project.json'],
    ['npx prettier --write .routekit/command-policy.yaml', '.routekit/command-policy.yaml'],
  ])('%s is denied', (cmd, file) => {
    const r = runOffRail(root, cmd);
    expectDenied(r);
    if (file) expect(r.reason).toContain(file);
  });
});

describe('off-rail: git apply and git am route as write gestures', () => {
  it.each([['git apply x.patch', 'apply'], ['git am x.mbox', 'am']])('%s routes to rks_guardrails_on', (cmd, op) => {
    const r = runOffRail(root, cmd);
    expectDenied(r);
    expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_on');
    expect(r.context).toMatch(/GOVERNOR ROUTING/);
    expect(r.reason).toContain(`git ${op}`);
  });
});

describe('off-rail: existing routing unchanged', () => {
  it.each(['git restore .', 'git checkout -- .', 'git restore .rks/rag/config.json'])('%s routes to rks_guardrails_abort', (cmd) => {
    const r = runOffRail(root, cmd);
    expectDenied(r);
    expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_abort');
  });
  it.each(['git commit -m x', 'git add .', 'git push origin staging', 'git merge feature'])('%s routes to rks_guardrails_on', (cmd) => {
    const r = runOffRail(root, cmd);
    expectDenied(r);
    expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_on');
  });
});

describe('off-rail: build commands stay allowed', () => {
  it.each([
    'npm test', 'npx vitest run tests/unit/x.test.mjs', 'node scripts/sync-hooks.mjs --check', 'git status',
    'git diff HEAD', 'git log --oneline -5', 'git show HEAD', 'git branch --list', 'git checkout main',
    'git checkout HEAD -- src/app.ts', 'ls .rks',
  ])('%s exits 0 with empty stdout', (cmd) => {
    expectAllowed(runOffRail(root, cmd));
  });
});

describe('off-rail: exact-path exemption', () => {
  it('an exact allowedFiles entry exempts only that config path, in exact case', () => {
    writeScope(root, { writeMode: 'scoped', allowedFiles: ['.rks/project.json'] });
    expectAllowed(runOffRail(root, 'git checkout HEAD -- .rks/project.json'));
    expectAllowed(runOffRail(root, "npx json -I -f .rks/project.json -e 'x=1'"));
    expectDenied(runOffRail(root, 'git checkout HEAD -- .rks/rag/config.json'));
    const both = runOffRail(root, 'node x.mjs .rks/project.json .rks/rag/config.json');
    expectDenied(both);
    expect(both.reason).toContain('.rks/rag/config.json');
    expectDenied(runOffRail(root, "npx json -I -f .RKS/project.json -e 'x=1'"));
  });
  it.each([
    ['./.rks/project.json'],
    ['ABSOLUTE'],
  ])('allowedFiles [%s] exempts the same way', (entry) => {
    const e = entry === 'ABSOLUTE' ? path.join(root, '.rks', 'project.json') : entry;
    writeScope(root, { writeMode: 'scoped', allowedFiles: [e] });
    expectAllowed(runOffRail(root, 'git checkout HEAD -- .rks/project.json'));
    expectAllowed(runOffRail(root, "npx json -I -f .rks/project.json -e 'x=1'"));
    expectDenied(runOffRail(root, 'git checkout HEAD -- .rks/rag/config.json'));
  });
});

describe('off-rail: fail-closed scope', () => {
  const cmd = 'git checkout HEAD -- .rks/project.json';
  it.each([
    ['allowedFiles [.rks/**]', { writeMode: 'scoped', allowedFiles: ['.rks/**'] }],
    ['allowedFiles [.rks/*.json]', { writeMode: 'scoped', allowedFiles: ['.rks/*.json'] }],
    ['allowedFiles [**/*]', { writeMode: 'scoped', allowedFiles: ['**/*'] }],
    ['writeMode read-only', { writeMode: 'read-only', allowedFiles: ['.rks/project.json'] }],
    ['writeMode deny-list', { writeMode: 'deny-list', allowedFiles: ['.rks/project.json'] }],
    ['writeMode absent', { allowedFiles: ['.rks/project.json'] }],
    ['allowedFiles absent', { writeMode: 'scoped' }],
    ['allowedFiles a string', { writeMode: 'scoped', allowedFiles: '.rks/project.json' }],
    ['invalid JSON', '{ not json'],
    ['empty file', ''],
  ])('denied when %s', (_label, scope) => {
    writeScope(root, scope);
    expectDenied(runOffRail(root, cmd));
  });
  it('denied when the scope file is a directory', () => {
    fs.mkdirSync(path.join(root, '.rks', 'active-scope.json'));
    expectDenied(runOffRail(root, cmd));
  });
  it('denied when the scope file is missing', () => {
    expectDenied(runOffRail(root, cmd));
  });
});

describe('off-rail: state class is never exempt', () => {
  it.each(PROTECTED_STATE_PATHS.map((p) => [p]))('%s stays denied even when listed exactly', (p) => {
    writeScope(root, { writeMode: 'scoped', allowedFiles: [p, '.rks/project.json'] });
    const r = runOffRail(root, `node x.mjs ${p}`);
    expectDenied(r);
    expect(r.reason).toContain(p);
  });
});

describe('off-rail: scope source is CLAUDE_PROJECT_DIR, not cwd', () => {
  it('uses the project dir scope file', () => {
    const a = root;
    writeScope(a, { writeMode: 'scoped', allowedFiles: ['.rks/project.json'] });
    const b = makeRoot();
    const cmd = 'git checkout HEAD -- .rks/project.json';
    expectAllowed(runOffRail(a, cmd, { cwd: b }));
    expectDenied(runOffRail(b, cmd, { cwd: a }));
  });
});

describe('off-rail: deny text', () => {
  it('names the file, the story or direct-edit route and the Read tool, with no advice to disable hooks', () => {
    const r = runOffRail(root, "npx json -I -f .rks/project.json -e 'x=1'");
    expectDenied(r);
    const text = `${r.reason}\n${r.context}`;
    expect(text).toContain('.rks/project.json');
    expect(text).toMatch(/story whose targetFiles lists the exact path guardrails-off/);
    expect(text).toMatch(/user to edit the file directly/);
    expect(text).toMatch(/Read tool/);
    expect(text).not.toMatch(NO_DISABLE);
  });
});

describe('on-rail: system hook unchanged', () => {
  it.each(["npx json -I -f .rks/project.json -e 'x=1'", 'git apply x.patch', 'git checkout HEAD -- .rks/project.json'])(
    '%s exits 0 with empty stdout when there is no hooks.bak',
    (cmd) => {
      const onRail = makeRoot({ offRail: false });
      expectAllowed(runOffRail(onRail, cmd));
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Off-rail hook: fail-closed load
// ─────────────────────────────────────────────────────────────────────────────
describe('off-rail hook: fail-closed load', () => {
  it('has only Node-builtin static imports and loads hook-output and the lib by guarded dynamic import', () => {
    const src = fs.readFileSync(OFF_RAIL_HOOK, 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^(]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(isBuiltin(s), s).toBe(true);
    for (const spec of ['./hook-output.mjs', '../lib/protected-rks-paths.mjs']) {
      const at = src.indexOf(`await import("${spec}")`);
      expect(at, spec).toBeGreaterThan(-1);
      const before = src.slice(0, at);
      expect(before.lastIndexOf('try {')).toBeGreaterThan(before.lastIndexOf('}'));
    }
  });

  const setups = {
    'nothing else copied': { copy: [], mutate: null, module: /hook-output\.mjs|protected-rks-paths\.mjs/ },
    'lib deleted': { copy: ['system', 'lib'], mutate: (p) => fs.rmSync(p), module: /protected-rks-paths\.mjs/ },
    'lib malformed': { copy: ['system', 'lib'], mutate: (p) => fs.writeFileSync(p, 'export const OTHER = 1;\n'), module: /protected-rks-paths\.mjs/ },
  };

  function tempHook({ copy, mutate }) {
    const tmp = mkTemp('rks-bpc-hooks-');
    for (const tier of copy) fs.cpSync(path.join(HOOKS_SRC, tier), path.join(tmp, tier), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'system'), { recursive: true });
    fs.copyFileSync(OFF_RAIL_HOOK, path.join(tmp, 'system', 'block-git-during-off-rail.mjs'));
    if (mutate) mutate(path.join(tmp, 'lib', 'protected-rks-paths.mjs'));
    return path.join(tmp, 'system', 'block-git-during-off-rail.mjs');
  }

  for (const [name, setup] of Object.entries(setups)) {
    it(`${name}: denies fail-closed with exit 0, allows build commands, and is silent on-rail`, () => {
      const hook = tempHook(setup);
      const onRail = makeRoot({ offRail: false });
      for (const cmd of [
        "npx json -I -f .rks/project.json -e 'x=1'", 'node x.mjs .rks/other.json', 'cat .RKS/x.json',
        'echo x > .routekit/guardrails.yaml', 'git checkout HEAD -- .',
      ]) {
        const r = runHook(hook, cmd, { projectDir: root });
        expect(r.code, cmd).toBe(0);
        expect(r.decision, cmd).toBe('deny');
        expect(r.reason, cmd).toMatch(setup.module);
        expect(r.reason, cmd).not.toMatch(NO_DISABLE);
      }
      for (const cmd of ['git apply x.patch', 'git commit -m x']) {
        const r = runHook(hook, cmd, { projectDir: root });
        expect(r.code, cmd).toBe(0);
        expect(r.decision, cmd).toBe('deny');
      }
      for (const cmd of ['npm test', 'npx vitest run tests/unit/x.test.mjs', 'git status']) {
        expectAllowed(runHook(hook, cmd, { projectDir: root }));
      }
      for (const cmd of [
        "npx json -I -f .rks/project.json -e 'x=1'", 'node x.mjs .rks/other.json', 'cat .RKS/x.json',
        'echo x > .routekit/guardrails.yaml', 'git checkout HEAD -- .', 'git apply x.patch', 'git commit -m x',
        'npm test', 'npx vitest run tests/unit/x.test.mjs', 'git status',
      ]) {
        expectAllowed(runHook(hook, cmd, { projectDir: onRail }));
      }
    });
  }

  it('positive control: with system and lib copied whole, .rks/other.json is allowed and .rks/project.json denied', () => {
    const hook = tempHook({ copy: ['system', 'lib'], mutate: null });
    expectAllowed(runHook(hook, 'node x.mjs .rks/other.json', { projectDir: root }));
    expectDenied(runHook(hook, "npx json -I -f .rks/project.json -e 'x=1'", { projectDir: root }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Copies (sync-hooks --check skips lib/, so lib parity is asserted here)
// ─────────────────────────────────────────────────────────────────────────────
describe('hook copies are byte-identical to canonical', () => {
  const hooksBak = path.join(REPO_ROOT, '.routekit', 'hooks.bak');
  const rels = ['lib/protected-rks-paths.mjs', 'read/redirect-read-bash-to-agent.mjs', 'system/block-git-during-off-rail.mjs'];
  it.each(rels)('template copy of %s', (rel) => {
    const canonical = path.join(HOOKS_SRC, rel);
    const template = path.join(REPO_ROOT, 'templates', 'generic', '.routekit', 'hooks', rel);
    expect(fs.readFileSync(template).equals(fs.readFileSync(canonical))).toBe(true);
  });
  (fs.existsSync(hooksBak) ? it.skip : it).each(rels)('deployed copy of %s (skipped while hooks.bak exists)', (rel) => {
    const canonical = path.join(HOOKS_SRC, rel);
    const deployed = path.join(REPO_ROOT, '.routekit', 'hooks', rel);
    expect(fs.readFileSync(deployed).equals(fs.readFileSync(canonical))).toBe(true);
  });
});
