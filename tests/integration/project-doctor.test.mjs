/**
 * Integration test for `routekit doctor`.
 *
 * Spawns the real CLI binary against a complete fake-ecosystem temp tree:
 *   - A "shell" temp dir with canonical+template hooks and a registry.
 *   - One drifted child (.mcp.json pinned to wrong shell, schemaVersion behind).
 *   - One pinned:true child whose .mcp.json drift should NOT be repaired.
 *
 * The first run reports findings and applies fixes; the second run reports
 * clean (idempotency).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SPAWN_TIMEOUT = 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'packages/cli/bin/routekit.js');

// backlog.fix.child-hook-registration-repair-and-audit — doctor Check 6 needs the shell's
// hook manifest (name → tiered path) and the child's hook scripts actually on disk. Both
// fixtures below gained them; see the comments at each site for why neither is optional.
const HOOK_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'),
);

function setupShell() {
  const shellRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-int-shell-'));
  fs.mkdirSync(path.join(shellRoot, 'packages', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(shellRoot, 'templates', 'generic', '.routekit', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(shellRoot, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(shellRoot, '.routekit', 'hooks'), { recursive: true });
  const sample = '// canonical sample hook\n';
  fs.writeFileSync(path.join(shellRoot, 'packages/hooks/write/sample.mjs'), sample);
  fs.writeFileSync(path.join(shellRoot, 'templates/generic/.routekit/hooks/write/sample.mjs'), sample);

  // backlog.fix.doctor-fixture-invalid-shell-no-skills: a shell has SKILLS. This fixture used to
  // build one without any, and doctor was happy to sync children from it — which is precisely the
  // bug backlog.fix.shell-self-sync-skill-wipe-health-gate closed: syncProject now refuses a shell
  // that has no skills to give, rather than silently reporting "Synced 0 file(s)" and exit 0. That
  // silence is what let a real shell get its skills wiped and still pass every check.
  //
  // So this is not padding to make a test go green — the fixture was asserting that doctor is happy
  // about a broken shell. One real skill makes it an actual shell, and the existing "first run must
  // exit 0" assertion means what it says again. Nothing downstream needs more: agents and the
  // rksVersion stamp are both optional and guarded (sync.mjs), so no package.json is required here.
  const skillDir = path.join(shellRoot, '.claude', 'skills', 'doctor');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: doctor\n---\n\n# doctor\n');

  // A real shell SHIPS .routekit/hooks-manifest.json. Without it Check 6 takes the
  // manifest-unload branch, which is NON-RECOVERABLE by construction (there is nothing
  // canonical to write) and therefore unrepairable by any fixer — forcing both runs
  // below non-zero. Fail-closed is the deliberate policy; the fixture was the thing that
  // was wrong.
  fs.writeFileSync(
    path.join(shellRoot, '.routekit', 'hooks-manifest.json'),
    JSON.stringify(HOOK_MANIFEST, null, 2),
  );
  return shellRoot;
}

/** The tiered "<tier>/<name>.mjs" of every hook the canonical registration names. */
function manifestHookRelPaths() {
  return [...new Set(Object.values(HOOK_MANIFEST).map((e) => e.path).filter(Boolean))];
}

function setupChild({ pinned = false, mcpPointsToShell = null, settings = undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-int-child-'));
  fs.mkdirSync(path.join(root, '.routekit', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });

  // INDEPENDENTLY of the manifest above: .routekit/hooks used to be an EMPTY directory
  // here, so once the Check 6 fixer wrote the canonical registration, every registered
  // command pointed at a file that does not exist in the child — condition (d) — and the
  // second run stayed non-zero on the fixer's OWN output. A governed child has the hook
  // scripts; seeding them is what makes "first wet run exits 0" reachable at all.
  for (const rel of manifestHookRelPaths()) {
    const p = path.join(root, '.routekit', 'hooks', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// stub hook\n');
  }
  // `settings` opts a case into a specific .claude/settings.json shape (Check 6 fixtures);
  // omitted, the child has none — the routekit-growth-adjacent "born ungoverned" state.
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2),
    );
  }
  fs.mkdirSync(path.join(root, 'routekit'), { recursive: true });
  // .rks/project.json — used for pinned read.
  fs.writeFileSync(
    path.join(root, '.rks/project.json'),
    JSON.stringify(pinned ? { id: 'child-x', pinned: true } : { id: 'child-x' }, null, 2),
  );
  // routekit/project.json — used by metadata.js for migrateConfig.
  fs.writeFileSync(
    path.join(root, 'routekit/project.json'),
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
  const pointer = mcpPointsToShell
    ? path.join(mcpPointsToShell, 'packages/mcp-rks/bin/mcp-rks.mjs')
    : '/old/shell/packages/mcp-rks/bin/mcp-rks.mjs';
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { rks: { command: 'node', args: [pointer], env: { ROUTEKIT_PROJECT_ID: 'child-x' } } },
    }, null, 2),
  );
  return root;
}

describe('routekit doctor — integration', () => {
  let shellRoot;
  let driftedChild;

  beforeEach(() => {
    shellRoot = setupShell();
    driftedChild = setupChild({ pinned: false });
    fs.writeFileSync(
      path.join(shellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'child-x', root: driftedChild, stack: 'app' }) + '\n',
    );
  });

  afterEach(() => {
    for (const dir of [shellRoot, driftedChild]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function runDoctor(args = []) {
    return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
      cwd: shellRoot,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT,
      env: {
        ...process.env,
        ROUTEKIT_SHELL_ROOT: shellRoot,
        ROUTEKIT_PROJECT_ID: 'routekit-shell-core',
      },
    });
  }

  it('reports drift on a drifted child and applies fixes; second run is clean', () => {
    const r1 = runDoctor([]);
    expect(r1.error).toBeUndefined();
    // The doctor subprocess must actually launch and succeed — a non-launching
    // CLI (e.g. a stale REPO_ROOT resolving to a nonexistent path) must fail
    // loudly here, not slip silently to the repin assertion below.
    expect(r1.status, `doctor first run must exit 0; stderr: ${r1.stderr}`).toBe(0);
    // First run repins the drifted child.
    const repinnedArgs = JSON.parse(fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8'));
    expect(repinnedArgs.mcpServers.rks.args[0]).toBe(
      path.join(shellRoot, 'packages/mcp-rks/bin/mcp-rks.mjs'),
    );
    // Second run sees no drift.
    const r2 = runDoctor([]);
    expect(r2.error).toBeUndefined();
    expect(r2.status, `stderr: ${r2.stderr}`).toBe(0);
  });

  it('--dry-run does not modify .mcp.json', () => {
    const before = fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8');
    const r = runDoctor(['--dry-run']);
    expect(r.error).toBeUndefined();
    const after = fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8');
    expect(after).toBe(before);
    expect(r.stdout || '').toContain('DRY RUN');
  });

  // backlog.fix.child-hook-registration-repair-and-audit — CLI VISIBILITY.
  // A finding present only in the returned object is invisible to the operator, which is
  // precisely how a child stayed ungoverned while `routekit doctor` printed health.
  it('renders a per-child hook-registration line and REPAIRS the routekit-growth shape', () => {
    fs.rmSync(driftedChild, { recursive: true, force: true });
    // Hook scripts on disk, .claude/settings.json carrying ONLY mcpServers — no hooks key.
    driftedChild = setupChild({
      mcpPointsToShell: shellRoot,
      settings: { mcpServers: { rks: { command: 'node', args: [] } } },
    });
    fs.writeFileSync(
      path.join(shellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'child-x', root: driftedChild, stack: 'app' }) + '\n',
    );

    const r = runDoctor([]);
    expect(r.error).toBeUndefined();
    expect(r.stdout || '').toMatch(/child child-x: hook registration:/);
    // Recoverable and repaired → exit 0, and the child is genuinely governed afterwards.
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(driftedChild, '.claude/settings.json'), 'utf8'));
    expect(Object.keys(after.hooks || {})).toEqual(['PreToolUse', 'PostToolUse']);
    expect(after.mcpServers).toEqual({ rks: { command: 'node', args: [] } }); // merge, not clobber
  });

  it('an unparseable child settings.json renders the line, is REFUSED, and exits non-zero', () => {
    fs.rmSync(driftedChild, { recursive: true, force: true });
    driftedChild = setupChild({ mcpPointsToShell: shellRoot, settings: '{ not valid json' });
    fs.writeFileSync(
      path.join(shellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'child-x', root: driftedChild, stack: 'app' }) + '\n',
    );
    const settingsPath = path.join(driftedChild, '.claude/settings.json');
    const before = fs.readFileSync(settingsPath, 'utf8');

    const r = runDoctor([]);
    expect(r.error).toBeUndefined();
    expect(r.stdout || '').toMatch(/child child-x: hook registration:.*unparseable/);
    expect(r.status).not.toBe(0); // the exit code reflects the finding
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before); // never clobbered
  });

  it('pinned:true child with .mcp.json drift exits non-zero; args[0] unchanged', () => {
    // Replace the drifted child with a pinned one.
    fs.rmSync(driftedChild, { recursive: true, force: true });
    driftedChild = setupChild({ pinned: true });
    fs.writeFileSync(
      path.join(shellRoot, 'projects/index.jsonl'),
      JSON.stringify({ id: 'child-x', root: driftedChild, stack: 'app' }) + '\n',
    );
    const beforeArgs = JSON.parse(fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8'));
    const r = runDoctor([]);
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0); // non-recoverable finding.
    const afterArgs = JSON.parse(fs.readFileSync(path.join(driftedChild, '.mcp.json'), 'utf8'));
    expect(afterArgs.mcpServers.rks.args[0]).toBe(beforeArgs.mcpServers.rks.args[0]);
    expect(r.stdout || '').toMatch(/NON-RECOVERABLE/);
  });
});
