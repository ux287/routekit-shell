// CREATE FILE: tests/integration/doctor-release-pin.test.mjs
/**
 * backlog.fix.doctor-repins-release-pinned-children — CLI witness for `routekit doctor`.
 *
 * User decision: report only. Doctor never writes to a child pinned to another rks shell; for such
 * a child Checks 2, 3, 5, 6, 7 and 8 only report and the CLI prints one line
 *   child <id>: pinned to <R> — run that shell's doctor to repair
 * A stale pin is reported with the `routekit project upgrade --from-release` remedy. Checks 9a
 * and 9b still run.
 *
 * Reproduces the user report: after `routekit project upgrade --from-release <R>`, running doctor
 * from the core shell repinned the child's .mcp.json to the core shell and resynced its hooks and
 * hook registration from the core shell. Every root here — the invoking shell, R and the child —
 * is a mkdtemp fixture; nothing reads a real ../routekit-shell-release.
 *
 * Fixture reachability: the invoking shell's templates carry write/sample.mjs and the child does
 * not, so judged against the INVOKING shell the child drifts (the unfixed doctor copies sample.mjs
 * in). R carries templates, a manifest and a child-permissions.mjs that throws on import, so a
 * doctor that judged, loaded or ran anything from R would show it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildHookRegistration } from '../../packages/cli/src/project/bootstrap.mjs';

const SPAWN_TIMEOUT = 60_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/cli/bin/routekit.js');
const HOOK_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'),
);
const CANONICAL_HOOKS = buildHookRegistration(HOOK_MANIFEST);
const BIN_REL = path.join('packages', 'mcp-rks', 'bin', 'mcp-rks.mjs');
const STAMP = '0.74.2';
const SAMPLE_REL = path.join('.routekit', 'hooks', 'write', 'sample.mjs');
/** The release-lag hook: registered by the invoking shell, absent from the child R deployed. */
const LAG_HOOK_REL = 'system/block-git-during-off-rail.mjs';
const pinnedLine = (R) => `child child-x: pinned to ${R} — run that shell's doctor to repair`;
const remedy = (R) => `routekit project upgrade --id child-x --from-release ${R}`;

/** The tiered "<tier>/<name>.mjs" of every hook command in a registration, de-duplicated. */
function hookRelPathsOf(registration) {
  const out = new Set();
  for (const groups of Object.values(registration)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = /\.routekit\/hooks\/(\S+\.mjs)/.exec(h.command);
        if (m) out.add(m[1]);
      }
    }
  }
  return [...out];
}

/** A registration with every command naming `rel` removed (empty groups and events dropped). */
function withoutHookCommand(registration, rel) {
  const out = {};
  for (const [event, groups] of Object.entries(registration)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command.includes(`.routekit/hooks/${rel}`)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** Every file under `dir` as [relative path, content] pairs, sorted — a byte-level snapshot. */
function snapshotDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push([path.relative(dir, p), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// Same isolation as tests/integration/project-doctor.test.mjs: Check 9b spawns real git in the child.
function isolatedGitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') || k === 'GIT_EXEC_PATH') env[k] = v;
  }
  env.GIT_CEILING_DIRECTORIES = [os.tmpdir(), fs.realpathSync(os.tmpdir())].join(path.delimiter);
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = os.devNull;
  return env;
}

const tmp = [];
function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
}
function put(root, rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function setupShell() {
  const root = mk('doctor-rp-int-shell-');
  put(root, 'packages/hooks/write/sample.mjs', '// canonical sample hook\n');
  put(root, 'templates/generic/.routekit/hooks/write/sample.mjs', '// canonical sample hook\n');
  put(root, '.claude/skills/doctor/SKILL.md', '---\nname: doctor\n---\n\n# doctor\n');
  put(root, '.routekit/hooks-manifest.json', JSON.stringify(HOOK_MANIFEST, null, 2));
  put(root, 'package.json', JSON.stringify({ name: 'routekit-shell', version: '0.99.0' }, null, 2));
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  return root;
}

/** Another rks shell R. Its templates, manifest and permission module must never be used. */
function setupRelease({ version = STAMP } = {}) {
  const root = mk('doctor-rp-int-release-');
  put(root, 'package.json', JSON.stringify({ name: 'routekit-shell', version }, null, 2));
  put(root, BIN_REL, '// release mcp-rks\n');
  put(root, '.routekit/hooks-manifest.json', JSON.stringify(HOOK_MANIFEST, null, 2));
  put(root, 'templates/generic/.routekit/hooks/write/release-only.mjs', '// release template\n');
  put(root, 'packages/cli/src/project/child-permissions.mjs', 'throw new Error("doctor must never import code from another shell");\n');
  return root;
}

/** Create the child, write .mcp.json args[0] = pointer, and register it in the shell registry. */
function setupChild(shellRoot, pointer, { settings = null, hookRels = hookRelPathsOf(CANONICAL_HOOKS) } = {}) {
  const root = mk('doctor-rp-int-child-');
  if (settings) put(root, '.claude/settings.json', JSON.stringify(settings, null, 2));
  for (const rel of hookRels) put(root, path.join('.routekit', 'hooks', rel), '// stub hook\n');
  put(root, '.rks/project.json', JSON.stringify({ id: 'child-x', rksVersion: STAMP }, null, 2));
  put(
    root,
    'routekit/project.json',
    JSON.stringify({
      id: 'child-x',
      root,
      schemaVersion: 1,
      notes: { vaultPath: 'notes', dendronConfig: 'dendron.yml' },
      rag: { indexPath: 'routekit/rag/index.lance', enabled: true },
      kg: { configPath: 'routekit/kg.yaml' },
      llm: { providerEnvVar: 'ROUTEKIT_LLM_PROVIDER' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
  );
  put(
    root,
    '.mcp.json',
    JSON.stringify({
      mcpServers: { rks: { command: 'node', args: [pointer], env: { ROUTEKIT_PROJECT_ID: 'child-x' } } },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(shellRoot, 'projects', 'index.jsonl'),
    JSON.stringify({ id: 'child-x', root, stack: 'app' }) + '\n',
  );
  return root;
}

function doctor(shellRoot, args = []) {
  return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
    cwd: shellRoot,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT,
    env: { ...isolatedGitEnv(), ROUTEKIT_SHELL_ROOT: shellRoot, ROUTEKIT_PROJECT_ID: 'routekit-shell-core' },
  });
}
const outLines = (r) => (r.stdout || '').split('\n').map((l) => l.trim());
const childNonRecoverable = (r) => outLines(r).filter((l) => l.startsWith('NON-RECOVERABLE ') && l.includes(' id=child-x:'));
const hooksDir = (child) => path.join(child, '.routekit', 'hooks');
const mcpOf = (child) => fs.readFileSync(path.join(child, '.mcp.json'), 'utf8');

afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('routekit doctor — children pinned to another rks shell (integration)', () => {
  it('RED before fix: a release-pinned child gets the pinned line and Checks 2, 3, 5, 6, 7 and 8 write nothing to it', () => {
    const shellRoot = setupShell();
    const R = setupRelease();
    const child = setupChild(shellRoot, path.join(R, BIN_REL));
    const mcpBefore = mcpOf(child);
    const hooksBefore = snapshotDir(hooksDir(child));
    // Reachability control: judged against the INVOKING shell, this child would drift.
    expect(fs.existsSync(path.join(shellRoot, 'templates', 'generic', SAMPLE_REL))).toBe(true);
    expect(fs.existsSync(path.join(child, SAMPLE_REL))).toBe(false);

    const r = doctor(shellRoot);
    expect(r.error).toBeUndefined();
    expect(outLines(r), r.stdout).toContain(pinnedLine(R));
    for (const fragment of [
      'child child-x: .mcp.json points outside shellRoot',
      'child child-x: hooks drift:',
      'child child-x: hook registration:',
      'child child-x: rks permissions:',
      'child child-x: schema migrated',
    ]) {
      expect(r.stdout, fragment).not.toContain(fragment);
    }
    expect(childNonRecoverable(r), r.stdout).toEqual([]);
    expect(mcpOf(child)).toBe(mcpBefore);
    expect(snapshotDir(hooksDir(child))).toEqual(hooksBefore);
    expect(fs.existsSync(path.join(child, SAMPLE_REL))).toBe(false);
    expect(fs.existsSync(path.join(child, '.claude', 'settings.json'))).toBe(false);
    // Check 9a still runs for this child (it does not depend on which shell is used).
    expect(fs.readFileSync(path.join(child, '.gitignore'), 'utf8')).toContain('.rks/runs/');
  });

  it('RED before fix: release lag — the invoking shell registers a hook the child lacks; settings.json, .mcp.json and the hooks tree are byte-identical after a wet run', () => {
    const shellRoot = setupShell();
    const R = setupRelease();
    const rRegistration = withoutHookCommand(CANONICAL_HOOKS, LAG_HOOK_REL);
    const child = setupChild(shellRoot, path.join(R, BIN_REL), {
      settings: { hooks: rRegistration, permissions: { ask: ['mcp__rks__*'] } },
      hookRels: hookRelPathsOf(rRegistration),
    });
    const settingsPath = path.join(child, '.claude', 'settings.json');
    const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
    const mcpBefore = mcpOf(child);
    const hooksBefore = snapshotDir(hooksDir(child));
    // Reachability control: judged against the INVOKING shell, this registration is incomplete.
    expect(JSON.stringify(CANONICAL_HOOKS)).toContain(LAG_HOOK_REL);
    expect(settingsBefore).not.toContain(LAG_HOOK_REL);

    const r = doctor(shellRoot);
    expect(r.error).toBeUndefined();
    expect(outLines(r), r.stdout).toContain(pinnedLine(R));
    expect(childNonRecoverable(r), r.stdout).toEqual([]);
    expect(r.stdout).not.toContain('child child-x: hook registration:');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(mcpOf(child)).toBe(mcpBefore);
    expect(snapshotDir(hooksDir(child))).toEqual(hooksBefore);
  });

  it('--dry-run: prints DRY RUN and the pinned line; .mcp.json and the hooks tree are byte-identical', () => {
    const shellRoot = setupShell();
    const R = setupRelease();
    const child = setupChild(shellRoot, path.join(R, BIN_REL));
    const mcpBefore = mcpOf(child);
    const hooksBefore = snapshotDir(hooksDir(child));
    const r = doctor(shellRoot, ['--dry-run']);
    expect(r.error).toBeUndefined();
    expect(r.stdout || '').toContain('DRY RUN');
    expect(outLines(r), r.stdout).toContain(pinnedLine(R));
    expect(mcpOf(child)).toBe(mcpBefore);
    expect(snapshotDir(hooksDir(child))).toEqual(hooksBefore);
  });

  it('stale pin (R version differs from the stamp): exactly one NON-RECOVERABLE line, check=3, carrying the upgrade remedy; exit 1; Checks 2, 3, 5, 6, 7 and 8 write nothing', () => {
    const shellRoot = setupShell();
    const R = setupRelease({ version: '9.9.9' });
    const P = path.join(R, BIN_REL);
    const child = setupChild(shellRoot, P);
    const mcpBefore = mcpOf(child);
    const hooksBefore = snapshotDir(hooksDir(child));
    const r = doctor(shellRoot);
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout).toBe(1);
    const nr = childNonRecoverable(r);
    expect(nr, r.stdout).toHaveLength(1);
    expect(nr[0].startsWith('NON-RECOVERABLE check=3 id=child-x:')).toBe(true);
    expect(nr[0]).toContain('Checks 2, 5, 6, 7 and 8 not run; Check 3 reported only; .mcp.json not repinned');
    expect(nr[0]).toContain(remedy(R));
    expect(outLines(r)).not.toContain(pinnedLine(R));
    expect(mcpOf(child)).toBe(mcpBefore);
    expect(snapshotDir(hooksDir(child))).toEqual(hooksBefore);
    expect(fs.existsSync(path.join(child, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(child, SAMPLE_REL))).toBe(false);
    expect(r.stdout).not.toContain('child child-x: schema migrated');
    // Check 9a still runs for this child (it does not depend on which shell is used).
    expect(fs.readFileSync(path.join(child, '.gitignore'), 'utf8')).toContain('.rks/runs/');
  });

  it('invoking-shell child: no pinned line; pointer unchanged', () => {
    const shellRoot = setupShell();
    const P = path.join(shellRoot, BIN_REL);
    const child = setupChild(shellRoot, P);
    const r = doctor(shellRoot);
    expect(r.error).toBeUndefined();
    expect(r.stdout || '').not.toContain('child child-x: pinned to');
    expect(JSON.parse(mcpOf(child)).mcpServers.rks.args[0]).toBe(P);
  });
});
