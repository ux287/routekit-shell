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

/**
 * EVERY non-tier sibling the fixture plants, each with its own helper and its own
 * importing probe in a RELOCATED tier.
 *
 * `system` is the 0.38.0 case. `lib` is the real sibling that reopened the hole —
 * vendored shared modules that reached the deployed tree after 0.38.0 shipped.
 *
 * `vendor` IS NOT DECORATION, and must not be "tidied" into a second real name.
 * It is an arbitrary name production code has no reason to know. Without it this
 * fixture kills only one of the two mutations that matter:
 *
 *   reverting the mirror to 'system' only        → killed by system+lib
 *   hard-coding the pair ['system','lib']        → PASSES GREEN on system+lib
 *
 * The second row is precisely the recurrence being prevented — a hard-coded list
 * that goes stale the next time a sibling lands. A third, meaningless name makes
 * the ENUMERATION the thing under test rather than two literals.
 * (backlog.fix.unit-tier-offrail-hermeticity)
 */
const MIRRORED_SIBLINGS = ['system', 'lib', 'vendor'];

/** Helper planted in each sibling; returns a value unique to that sibling. */
const helperFor = (sibling) =>
  `export function greet() { return "loaded-from-${sibling}"; }\n`;

/**
 * A write-tier hook whose ONLY dependency is a relative import of one sibling.
 * WRITE tier deliberately: guardrailsOff relocates write/ and read/ only, so a
 * probe placed in system/ would never move and would prove nothing.
 */
const probeFor = (sibling) => `import { greet } from "../${sibling}/hook-output.mjs";
process.stdout.write(greet());
process.exit(0);
`;

const probeName = (sibling) => `needs-${sibling}.mjs`;

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-hook-loadability-'));
  const hooks = path.join(dir, '.routekit', 'hooks');
  fs.mkdirSync(path.join(hooks, 'write'), { recursive: true });
  fs.mkdirSync(path.join(hooks, 'read'), { recursive: true });

  for (const sibling of MIRRORED_SIBLINGS) {
    fs.mkdirSync(path.join(hooks, sibling), { recursive: true });
    fs.writeFileSync(path.join(hooks, sibling, 'hook-output.mjs'), helperFor(sibling));
    fs.writeFileSync(path.join(hooks, 'write', probeName(sibling)), probeFor(sibling));
  }

  fs.writeFileSync(path.join(hooks, 'read', 'enforce-read-provenance.mjs'), '// read hook');

  fs.writeFileSync(
    path.join(dir, '.routekit', 'hooks-manifest.json'),
    JSON.stringify(
      {
        ...Object.fromEntries(
          MIRRORED_SIBLINGS.map((s) => [`needs-${s}`, { tier: 'write' }]),
        ),
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
  it.each(MIRRORED_SIBLINGS)(
    'a relocated hook importing ../%s/ still LOADS and runs — the regression itself',
    async (sibling) => {
      const dir = makeProject();
      try {
        await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);

        const relocated = bak(dir, 'write', probeName(sibling));
        expect(fs.existsSync(relocated), 'hook should have been relocated').toBe(true);

        // The decisive assertion: spawn the hook from its relocated location and
        // require it to resolve its relative sibling import. Before the fix the
        // lib/ and vendor/ cases exited 1 with ERR_MODULE_NOT_FOUND.
        const res = spawnSync('node', [relocated], { encoding: 'utf8', timeout: 10000 });

        expect(res.stderr || '').not.toContain('ERR_MODULE_NOT_FOUND');
        expect(res.stderr || '').not.toContain('Cannot find module');
        expect(res.status).toBe(0);
        expect(res.stdout).toBe(`loaded-from-${sibling}`);
      } finally {
        cleanup(dir);
      }
    },
  );

  it.each(MIRRORED_SIBLINGS)(
    'negative control: without the ../%s/ copy the same hook fails to load',
    async (sibling) => {
      const dir = makeProject();
      try {
        await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
        // Recreate the pre-fix state for THIS sibling, so each case proves its own
        // copy is what makes it pass rather than something incidental.
        fs.rmSync(bak(dir, sibling), { recursive: true, force: true });

        const res = spawnSync('node', [bak(dir, 'write', probeName(sibling))], {
          encoding: 'utf8',
          timeout: 10000,
        });

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('ERR_MODULE_NOT_FOUND');
      } finally {
        cleanup(dir);
      }
    },
  );

  it('mirrors EVERY non-tier sibling, derived rather than enumerated', async () => {
    // The design requirement itself. A fixture asserting two known names would
    // pass against a hard-coded pair; `vendor` is a name production code has no
    // reason to know, so only a derived enumeration satisfies this.
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      for (const sibling of MIRRORED_SIBLINGS) {
        expect(
          fs.existsSync(bak(dir, sibling)),
          `sibling ${sibling} was not mirrored into hooks.bak`,
        ).toBe(true);
      }
      // …and the relocated tiers are still relocated, not copied.
      expect(fs.existsSync(bak(dir, 'write'))).toBe(true);
      expect(fs.existsSync(live(dir, 'write'))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('never mirrors a stray FILE at the hooks root — it would be injected into a tier', async () => {
    // isDirectory() is load-bearing: the legacy restore branch treats a flat .mjs
    // under hooks.bak/ as a tier-less hook and renames it INTO a live tier dir.
    const dir = makeProject();
    try {
      fs.writeFileSync(live(dir, 'stray.mjs'), '// not a tier, not a sibling\n');
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);
      expect(fs.existsSync(bak(dir, 'stray.mjs'))).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('EVERY sibling copy is a real DIRECTORY, never a symlink or flat files', async () => {
    const dir = makeProject();
    try {
      await guardrailsOff(dir, 'test', 'all', PROBLEM_ID);

      // PARAMETERIZED, not 'system'-scoped. The 0.38.0 ruling bound this
      // structural guarantee to the mirror as a whole; asserting it for one
      // sibling left the guarantee unwitnessed for every sibling added since.
      for (const sibling of MIRRORED_SIBLINGS) {
        const st = fs.lstatSync(bak(dir, sibling));

        // A symlink is a data-loss hazard: guardrailsAbort rm -rf's the live
        // hooks/ tree before renaming hooks.bak onto it, which through a link
        // destroys the real hooks. Flat .mjs files directly under hooks.bak/ are
        // picked up by the legacy restore branch and injected into a live tier
        // dir. Both alternatives must remain impossible, for every sibling.
        expect(st.isDirectory(), `${sibling} is not a real directory`).toBe(true);
        expect(st.isSymbolicLink(), `${sibling} is a symlink`).toBe(false);
      }

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
      for (const sibling of MIRRORED_SIBLINGS) {
        expect(fs.existsSync(bak(dir, sibling))).toBe(true);
      }

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
      expect(fs.existsSync(live(dir, 'write', probeName('system')))).toBe(true);

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
      expect(fs.existsSync(live(dir, 'write', probeName('system')))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
