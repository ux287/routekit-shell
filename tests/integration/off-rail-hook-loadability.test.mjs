/**
 * Relocated hooks must remain LOADABLE during an off-rail session.
 *
 * guardrailsOff relocates the write/ and read/ tier directories under
 * .routekit/hooks.bak/ while system/ deliberately stays live. But every write/
 * and read/ hook imports the shared helper by relative path —
 * `import { … } from "../system/hook-output.mjs"`. From hooks.bak/write/ that
 * specifier resolves to hooks.bak/system/, which did not exist, so node failed
 * the hook with ERR_MODULE_NOT_FOUND and exit 1 BEFORE running a single line.
 * Every deployed-hook test was therefore red for the whole duration of every
 * off-rail session — repeatedly rediscovered and repeatedly waved off as "known
 * off-rail noise".
 *
 * The fix copies system/ alongside the relocated tiers. These tests pin it.
 *
 * WHY THIS FILE EXISTS SEPARATELY: tests/unit/guardrails-audit.spec.mjs already
 * owns a fixture that drives the real guardrailsOff, and reusing it would have
 * been the obvious home — but that entire file is `describe.skip` (since
 * 2026-06-05, for subprocess flake), so nothing in it executes. Tests added
 * there would have been vacuously green. This file runs.
 *
 * (backlog.fix.off-rail-hook-loadability)
 */
import { describe, it, expect, vi } from 'vitest';

// These drive real guardrailsOff → guardrailsOn cycles against a git repo. The
// off-rail enforcement gate added a policy load and a dynamic import to that
// path, pushing several cases past vitest's 5s default — they were already
// close. Raise it so a slow-but-passing test does not read as a failure.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../packages/mcp-rks/src/server/git-tools.mjs', () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true, url: 'https://example.invalid/pr/1', number: 1 }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true }),
}));

const { guardrailsOff, guardrailsOn } = await import(
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);

const PROBLEM_ID = 'backlog.fix.off-rail-hook-loadability';

/** The shared helper a relocated hook must still be able to import. */
const SYSTEM_HELPER = `export function greet() { return "loaded-from-system"; }\n`;

/** A write-tier hook whose ONLY dependency is the relative system import. */
const WRITE_HOOK = `import { greet } from "../system/hook-output.mjs";
process.stdout.write(greet());
process.exit(0);
`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-hook-loadability-'));
  const hooks = path.join(dir, '.routekit', 'hooks');
  fs.mkdirSync(path.join(hooks, 'write'), { recursive: true });
  fs.mkdirSync(path.join(hooks, 'read'), { recursive: true });
  fs.mkdirSync(path.join(hooks, 'system'), { recursive: true });

  fs.writeFileSync(path.join(hooks, 'system', 'hook-output.mjs'), SYSTEM_HELPER);
  fs.writeFileSync(path.join(hooks, 'write', 'needs-system.mjs'), WRITE_HOOK);
  fs.writeFileSync(path.join(hooks, 'read', 'enforce-read-provenance.mjs'), '// read hook');

  fs.writeFileSync(
    path.join(dir, '.routekit', 'hooks-manifest.json'),
    JSON.stringify(
      {
        'needs-system': { tier: 'write' },
        'enforce-read-provenance': { tier: 'read' },
        'hook-output': { tier: 'system' },
      },
      null,
      2,
    ),
  );

  fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
  // Off-rail enforcement gate loads .rks/review-policy.yaml with this root;
  // disable review so the bare guardrailsOn calls never reach a live reviewer.
  fs.writeFileSync(
    path.join(dir, '.rks', 'review-policy.yaml'),
    '# Fixture: keep the off-rail enforcement gate from calling a live reviewer.\nenabled: false\n',
  );
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'notes', `${PROBLEM_ID}.md`),
    `---\nid: "${PROBLEM_ID}"\ntitle: "Test story"\nphase: "arch-approved"\ntargetFiles: []\n---\n`,
  );

  execSync(
    'git init && git config user.email test@test.com && git config user.name test && git add -A && git commit -m init',
    { cwd: dir, stdio: 'ignore' },
  );
  return dir;
}

function cleanup(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const bak = (dir, ...p) => path.join(dir, '.routekit', 'hooks.bak', ...p);
const live = (dir, ...p) => path.join(dir, '.routekit', 'hooks', ...p);

describe('off-rail hook loadability', () => {
  it('a relocated hook still LOADS and runs — the regression itself', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);

      const relocated = bak(dir, 'write', 'needs-system.mjs');
      expect(fs.existsSync(relocated), 'hook should have been relocated').toBe(true);

      // The decisive assertion: spawn the hook from its relocated location and
      // require it to resolve its relative system import. Before the fix this
      // exited 1 with ERR_MODULE_NOT_FOUND.
      const res = spawnSync('node', [relocated], { encoding: 'utf8', timeout: 10000 });

      expect(res.stderr || '').not.toContain('ERR_MODULE_NOT_FOUND');
      expect(res.stderr || '').not.toContain('Cannot find module');
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('loaded-from-system');
    } finally {
      cleanup(dir);
    }
  });

  it('negative control: without the system copy the same hook fails to load', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      // Recreate the pre-fix state exactly, so this test proves the copy is what
      // makes the case above pass rather than something incidental.
      fs.rmSync(bak(dir, 'system'), { recursive: true, force: true });

      const res = spawnSync('node', [bak(dir, 'write', 'needs-system.mjs')], {
        encoding: 'utf8',
        timeout: 10000,
      });

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('ERR_MODULE_NOT_FOUND');
    } finally {
      cleanup(dir);
    }
  });

  it('the system copy is a real DIRECTORY, never a symlink or flat files', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      const st = fs.lstatSync(bak(dir, 'system'));

      // A symlink is a data-loss hazard: guardrailsAbort rm -rf's the live hooks/
      // tree before renaming hooks.bak onto it, which through a link destroys the
      // real system hooks. Flat .mjs files directly under hooks.bak/ are picked up
      // by the legacy restore branch and injected into a live tier dir. Both
      // alternatives must remain impossible.
      expect(st.isDirectory()).toBe(true);
      expect(st.isSymbolicLink()).toBe(false);

      const flat = fs.readdirSync(bak(dir)).filter((f) => f.endsWith('.mjs'));
      expect(flat).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('the LIVE system tier keeps executing during the session', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      // system/ enforces the rails that remain on; it must never be relocated.
      expect(fs.existsSync(live(dir, 'system', 'hook-output.mjs'))).toBe(true);
      expect(fs.existsSync(live(dir, 'write'))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('guardrailsOn removes the copy, leaving no orphan for the auto-ship to sweep', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      expect(fs.existsSync(bak(dir, 'system'))).toBe(true);

      // The repository's own manifest must be untouched by an operation scoped to `dir`.
      // guardrailsOn auto-ships, which reaches commitAndEmbed -> runRagEmbed. Before
      // backlog.fix.rag-embed-honours-explicit-project-root, the resolver discarded `dir`
      // (it has no package.json) and substituted process.cwd(), so this call embedded the
      // real repository — 34867 chunks, 251723ms — and overwrote the repo's
      // embed-manifest.json, which is the skip oracle for its next legitimate embed.
      const repoManifest = path.join(process.cwd(), '.rks', 'rag', 'embed-manifest.json');
      const manifestBefore = fs.existsSync(repoManifest)
        ? fs.statSync(repoManifest).mtimeMs
        : null;

      await guardrailsOn(dir);

      expect(fs.existsSync(bak(dir))).toBe(false);
      expect(fs.existsSync(live(dir, 'system', 'hook-output.mjs'))).toBe(true);
      expect(fs.existsSync(live(dir, 'write', 'needs-system.mjs'))).toBe(true);

      const manifestAfter = fs.existsSync(repoManifest)
        ? fs.statSync(repoManifest).mtimeMs
        : null;
      expect(manifestAfter).toBe(manifestBefore);
    } finally {
      cleanup(dir);
    }
  });

  it('close path tolerates hooks.bak with NO system copy (session opened by older code)', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      // A session opened before this fix existed has no system copy to remove.
      fs.rmSync(bak(dir, 'system'), { recursive: true, force: true });

      const res = await guardrailsOn(dir);

      expect(res.ok).toBe(true);
      expect(fs.existsSync(live(dir, 'write', 'needs-system.mjs'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
