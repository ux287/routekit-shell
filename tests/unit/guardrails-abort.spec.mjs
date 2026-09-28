/**
 * guardrailsAbort() — the discard exit off-rail never had.
 *
 * rks_guardrails_on ALWAYS commits/ships; there was no way to throw away a bad off-rail
 * build. guardrailsAbort() hard-resets the working tree to the session-start commit, cleans
 * new files, restores hooks, and ends the session with NO commit/branch/merge/push.
 *
 * (Off-rail abort-path reliability work — unblocks Stage 3 + future large moves.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

// guardrailsOn ships via these; abort never calls them, but guardrailsOff may touch commit-and-embed.
// Mock defensively so no test path reaches a real network/git-push.
vi.mock('../../packages/mcp-rks/src/server/git-tools.mjs', () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true }),
  runCycleComplete: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../packages/mcp-rks/src/shared/commit-and-embed.mjs', () => ({
  commitAndEmbed: vi.fn().mockResolvedValue({ commitId: 'mockcommit', ragEmbedWarning: null }),
}));

const { guardrailsOff, guardrailsAbort } = await import(
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-abort-test-'));

  // Deployed hooks (tracked, so a hard reset recreates them) + manifest.
  const hooksDir = path.join(dir, '.routekit', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'enforce-plan-scope.mjs'), '// hook');
  fs.writeFileSync(path.join(hooksDir, 'enforce-read-provenance.mjs'), '// hook');
  fs.writeFileSync(
    path.join(dir, '.routekit', 'hooks-manifest.json'),
    JSON.stringify(
      {
        'enforce-plan-scope': { tier: 'write' },
        'enforce-read-provenance': { tier: 'read' },
      },
      null,
      2
    )
  );

  // .rks/ and hooks.bak/ gitignored so `git clean -fd` (no -x) preserves session state, mirroring
  // a real project — the explicit rmSync in guardrailsAbort is what removes hooks.bak.
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    ['node_modules/', '.rks/', '.routekit/hooks.bak/', ''].join('\n')
  );

  // arch-approved story so guardrailsOff's phase gate passes; empty targetFiles = no scope violation.
  const problemId = 'test-abort-story';
  const notesDir = path.join(dir, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(
    path.join(notesDir, `${problemId}.md`),
    [
      '---',
      `id: "${problemId}"`,
      'title: "abort test story"',
      'phase: "arch-approved"',
      'targetFiles: []',
      '---',
      '',
    ].join('\n')
  );

  execSync('git init -b staging', { cwd: dir, stdio: 'ignore', env: gitEnv });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore', env: gitEnv });
  execSync('git config user.name "test"', { cwd: dir, stdio: 'ignore', env: gitEnv });
  fs.writeFileSync(path.join(dir, 'README.md'), '# original\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore', env: gitEnv });

  const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
  return { dir, problemId, head };
}

function porcelain(dir) {
  return execSync('git status --porcelain', { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
}
function headOf(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
}
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe('guardrailsAbort', () => {
  let projectRoot;
  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
    projectRoot = undefined;
  });

  it('discards working-tree changes, restores hooks, and does NOT commit or ship', async () => {
    let problemId, head;
    ({ dir: projectRoot, problemId, head } = makeProject());

    await guardrailsOff(projectRoot, 'test-abort', 'all', problemId);
    // hooks moved to .bak, guardrails now off
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(true);

    // Simulate off-rail work: a new file and an edit to a tracked file.
    fs.writeFileSync(path.join(projectRoot, 'new-work.txt'), 'scratch\n');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# HALF-BAKED CHANGE\n');

    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');

    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.changesDiscarded).toBeGreaterThan(0);
    expect(result.resetToCommit).toBe(head);

    // Working tree is clean and reset to the session-start commit — NO new commit.
    expect(headOf(projectRoot)).toBe(head);
    expect(porcelain(projectRoot)).toBe('');

    // The off-rail changes are gone.
    expect(fs.existsSync(path.join(projectRoot, 'new-work.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# original\n');

    // Hooks restored: live tree back, backup removed.
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(false);

    // Guard state is back to enforcing and the scope file is gone.
    const state = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.rks', 'guardrails-state.json'), 'utf8')
    );
    expect(state.active).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.rks', 'active-scope.json'))).toBe(false);

    // Session log records an aborted end entry.
    const log = fs
      .readFileSync(path.join(projectRoot, '.rks', 'guardrails-off-sessions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(log.some((e) => e.aborted === true && e.endedAt)).toBe(true);
  }, 30000);

  it('refuses when guardrails are already on (no off-rail session to abort)', async () => {
    ({ dir: projectRoot } = makeProject());
    // Fresh project: guard state defaults to active (on).
    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already on|no off-rail session/i);
  });

  it('orphan session: restores hooks and warns, discarding nothing when there is no headCommit', async () => {
    ({ dir: projectRoot } = makeProject());

    // Simulate a crashed/orphan off-rail state: hooks moved to .bak, guard state off, but NO
    // session recorded (nothing to reset to).
    fs.renameSync(
      path.join(projectRoot, '.routekit', 'hooks'),
      path.join(projectRoot, '.routekit', 'hooks.bak')
    );
    fs.mkdirSync(path.join(projectRoot, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.rks', 'guardrails-state.json'),
      JSON.stringify({ active: false, disabledTiers: ['read', 'write'] }, null, 2)
    );

    // A pre-existing dirty change that MUST be preserved (orphan abort discards nothing).
    fs.writeFileSync(path.join(projectRoot, 'keep-me.txt'), 'do not discard\n');

    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');

    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.hooksRestored).toBe(true);
    expect(result.warning).toMatch(/nothing was discarded/i);

    // Hooks restored, backup gone.
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(false);

    // The dirty file survives — orphan abort does NOT reset.
    expect(fs.existsSync(path.join(projectRoot, 'keep-me.txt'))).toBe(true);
  });

  it('ABORT LEAVES A LOADABLE TREE — the swap must not install an incomplete one', async () => {
    // The 0.38.0 ARCH requirement that was specified and never landed, now with the
    // oracle corrected. That story asked for a witness on this swap; the criterion
    // was presence-based, and `existsSync` is precisely the oracle this area keeps
    // being fooled by. A directory can exist and still be unloadable.
    //
    // THE PATH: the no-active-session branch does
    //   fs.rmSync(hooksPath)  →  fs.renameSync(hooksBakPath, hooksPath)
    // It is the ONLY consumption path that is not tier-filtered. It destroys the
    // live tree — the only copy of the non-tier siblings — and installs hooks.bak
    // in its place. Before the sibling mirror was generalised, hooks.bak carried
    // {write, read, system} and no lib/, so every ../lib/-importing hook became
    // unloadable AFTERWARDS, including the system-tier ones still meant to be
    // enforcing, and the branch returns before anything repairs it.
    ({ dir: projectRoot } = makeProject());

    // A realistic tiered tree with a non-tier sibling, built the way a real
    // deployed tree is: a write hook importing a shared module from ../lib/.
    const hooks = path.join(projectRoot, '.routekit', 'hooks');
    for (const d of ['write', 'read', 'system', 'lib']) {
      fs.mkdirSync(path.join(hooks, d), { recursive: true });
    }
    fs.writeFileSync(
      path.join(hooks, 'lib', 'session-state.mjs'),
      'export function state() { return "lib-loaded"; }\n',
    );
    fs.writeFileSync(
      path.join(hooks, 'write', 'needs-lib.mjs'),
      'import { state } from "../lib/session-state.mjs";\n'
      + 'process.stdout.write(state());\nprocess.exit(0);\n',
    );
    fs.writeFileSync(
      path.join(projectRoot, '.routekit', 'hooks-manifest.json'),
      JSON.stringify({ 'needs-lib': { tier: 'write' } }, null, 2),
    );
    // guardrailsOff refuses without an arch-approved story (problemId_required),
    // so the fixture carries one — mirroring tests/integration/off-rail-hook-loadability.test.mjs.
    const STORY = 'backlog.fix.abort-fixture';
    fs.mkdirSync(path.join(projectRoot, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'notes', `${STORY}.md`),
      `---\nid: "${STORY}"\ntitle: "Abort fixture"\nphase: "arch-approved"\ntargetFiles: []\n---\n`,
    );
    fs.mkdirSync(path.join(projectRoot, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.rks', 'review-policy.yaml'),
      '# Fixture: keep the off-rail gate from calling a live reviewer.\nenabled: false\n',
    );
    execSync('git add -A && git commit -q -m tiered', { cwd: projectRoot, stdio: 'ignore' });

    // Produce hooks.bak with the REAL code — this is what makes the fixture
    // meaningful: hooks.bak is the genuine PARTIAL tree guardrailsOff builds
    // (relocated tiers plus mirrored siblings), not a whole-tree rename.
    const off = await guardrailsOff(projectRoot, 'test', 'all', STORY, 'routekit-shell-core');
    expect(
      fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak', 'write')),
      `fixture precondition: guardrailsOff did not relocate the write tier — ${JSON.stringify(off)}`,
    ).toBe(true);

    // ORPHAN IT PROPERLY. getActiveSession reads .rks/guardrails-off-sessions.jsonl
    // (SESSION_LOG) — NOT guardrails-state.json. Removing the log is what makes
    // getActiveSession return null and routes abort to the rm→rename swap.
    //
    // This matters: with the session still tracked, abort takes the normal path,
    // whose `git reset --hard` restores every tracked file and repairs the tree —
    // masking the defect entirely. An earlier draft of this test did exactly that
    // and passed against the broken code.
    fs.rmSync(path.join(projectRoot, '.rks', 'guardrails-off-sessions.jsonl'), { force: true });
    expect(
      fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak')),
      'fixture precondition: hooks.bak must survive to be swapped in',
    ).toBe(true);

    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');
    expect(result.ok).toBe(true);

    // THE ORACLE IS EXECUTION, NOT PRESENCE. Pre-fix the swapped-in tree had no
    // lib/, so this spawn died with ERR_MODULE_NOT_FOUND and empty stdout.
    const restored = path.join(hooks, 'write', 'needs-lib.mjs');
    expect(fs.existsSync(restored), 'hook was not restored at all').toBe(true);
    const res = spawnSync('node', [restored], { encoding: 'utf8', timeout: 10000 });
    expect(res.stderr || '').not.toContain('ERR_MODULE_NOT_FOUND');
    expect(res.status, `restored hook exited ${res.status}: ${res.stderr}`).toBe(0);
    expect(res.stdout).toBe('lib-loaded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.guardrails-abort-discards-pre-session-work
//
// The discard targets the session's START COMMIT, so before this change it also destroyed
// uncommitted work that PREDATED the session and was never the session's to throw away.
// On 2026-09-05 an abort took an uncommitted archive rename and a never-committed
// research note with it; neither was recoverable.
//
// The scope "since the session started" is enforced by the PRE-SESSION DIRTY MANIFEST
// plus refusal — never by the hard reset, which targets a commit and cannot express it.
// ─────────────────────────────────────────────────────────────────────────────
describe('guardrailsAbort — pre-session work is not this session to discard', () => {
  let projectRoot;
  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
    projectRoot = undefined;
  });

  it('a CLEAN tree at open discards exactly as before, and records an EMPTY manifest', async () => {
    const { dir, problemId } = makeProject();
    projectRoot = dir;

    const off = await guardrailsOff(dir, 'clean open', 'all', problemId, 'test-project');
    expect(off.ok).toBe(true);

    // Empty and unknown must be distinguishable by a later reader.
    const scope = JSON.parse(fs.readFileSync(path.join(dir, '.rks', 'active-scope.json'), 'utf8'));
    expect(Array.isArray(scope.preExistingDirty)).toBe(true);
    expect(scope.preExistingDirty).toEqual([]);

    fs.writeFileSync(path.join(dir, 'session-work.txt'), 'made during the session\n');

    const res = await guardrailsAbort(dir, {}, 'test-project');
    expect(res.ok).toBe(true);
    expect(res.aborted).toBe(true);
    expect(fs.existsSync(path.join(dir, 'session-work.txt'))).toBe(false);
    expect(porcelain(dir)).toBe('');
  });

  it('a DIRTY tree at open REFUSES, discards nothing, and leaves the paths on disk', async () => {
    const { dir, problemId } = makeProject();
    projectRoot = dir;

    // Pre-session work: one tracked modification and one untracked file.
    fs.writeFileSync(path.join(dir, 'README.md'), '# edited before the session\n');
    fs.writeFileSync(path.join(dir, 'pre-existing.txt'), 'not the session to throw away\n');
    const headBefore = headOf(dir);

    const off = await guardrailsOff(dir, 'dirty open', 'all', problemId, 'test-project');
    expect(off.ok).toBe(true);

    fs.writeFileSync(path.join(dir, 'session-work.txt'), 'made during the session\n');

    const res = await guardrailsAbort(dir, {}, 'test-project');

    expect(res.ok).toBe(false);
    expect(res.aborted).toBe(false);
    expect(res.reason).toBe('pre_session_work_present');
    expect(res.preExistingDirty).toEqual(
      expect.arrayContaining(['README.md', 'pre-existing.txt'])
    );

    // NOTHING was discarded — not the pre-session work, and not the session's own.
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain('edited before the session');
    expect(fs.existsSync(path.join(dir, 'pre-existing.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'session-work.txt'))).toBe(true);
    expect(headOf(dir)).toBe(headBefore);

    // AND THE HOOKS STATE IS EXACTLY AS FOUND. This is the half-abort the AC forbids:
    // restoring hooks and then declining the discard leaves the caller in a state that
    // neither rks_guardrails_on nor a retried abort describes. The gate therefore sits
    // ABOVE the hook-relocation block.
    //
    // Asserted on the FILESYSTEM, not on the return payload. `res.hooksRestored` only
    // reports what the function SAYS it did; a bug that restored the tiers without
    // recording it would pass that check alone. The write/read tiers must still be in
    // hooks.bak, where guardrailsOff put them.
    //
    // Note the live `.routekit/hooks` directory legitimately still EXISTS during a
    // session — off-rail relocates only the write and read tiers and leaves the system
    // tier in place — so its presence proves nothing either way. The relocated tiers are
    // the discriminating observation.
    // `hooks.bak` STILL PRESENT is the discriminator, and it is a real one: a successful
    // abort removes it, which the first test in this file asserts explicitly. So its
    // survival here distinguishes "declined before touching hooks" from "restored hooks
    // and then declined". Measured, not read off the return payload.
    expect(fs.existsSync(path.join(dir, '.routekit', 'hooks.bak'))).toBe(true);
    expect(res.hooksRestored).toBeUndefined();

    // The off-rail session is STILL OPEN, which is what lets the caller retry with
    // discardPreExisting: true without re-running guardrailsOff.
    //
    // READ THIS FIELD CAREFULLY: `active` in guardrails-state.json means "guardrails are
    // ENFORCING", not "an off-rail session is active". Off-rail is `active: false`. So
    // `false` here is the session still being open — the successful-abort case above
    // asserts `true`, meaning enforcement was restored and the session ended.
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, '.rks', 'guardrails-state.json'), 'utf8')
    );
    expect(state.active).toBe(false);
  });

  it('the refusal leaves the session ACTIVE, so an immediate opt-in retry succeeds', async () => {
    const { dir, problemId } = makeProject();
    projectRoot = dir;

    fs.writeFileSync(path.join(dir, 'pre-existing.txt'), 'pre-session\n');
    await guardrailsOff(dir, 'retry after refusal', 'all', problemId, 'test-project');

    const refused = await guardrailsAbort(dir, {}, 'test-project');
    expect(refused.ok).toBe(false);

    // No re-run of guardrailsOff between the two calls.
    const res = await guardrailsAbort(dir, { discardPreExisting: true }, 'test-project');
    expect(res.ok).toBe(true);
    expect(res.aborted).toBe(true);
    expect(res.preExistingDiscarded).toEqual(expect.arrayContaining(['pre-existing.txt']));
    expect(fs.existsSync(path.join(dir, 'pre-existing.txt'))).toBe(false);
  });

  it('the OVERLAP case — dirty at open AND modified during — is reported as pre-existing', async () => {
    // The case a path-scoped discard cannot resolve: restoring the path destroys the
    // pre-session work, skipping it leaves session work behind.
    const { dir, problemId } = makeProject();
    projectRoot = dir;

    fs.writeFileSync(path.join(dir, 'README.md'), '# pre-session edit\n');
    await guardrailsOff(dir, 'overlap', 'all', problemId, 'test-project');
    fs.writeFileSync(path.join(dir, 'README.md'), '# pre-session edit, then session edit\n');

    const res = await guardrailsAbort(dir, {}, 'test-project');
    expect(res.ok).toBe(false);
    expect(res.preExistingDirty).toContain('README.md');
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain('session edit');
  });

  it('a LEGACY session with no manifest and dirtyAtStart TRUE refuses with a distinct reason', async () => {
    const { dir, problemId } = makeProject();
    projectRoot = dir;

    fs.writeFileSync(path.join(dir, 'pre-existing.txt'), 'pre-session\n');
    await guardrailsOff(dir, 'legacy dirty', 'all', problemId, 'test-project');

    // Simulate a record written before the manifest field existed.
    const logPath = path.join(dir, '.rks', 'guardrails-off-sessions.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => {
      const e = JSON.parse(l);
      if (e.preExistingDirty !== undefined) delete e.preExistingDirty;
      return JSON.stringify(e);
    });
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    // Strip it from the scope file too, so the fixture states the legacy condition in
    // BOTH places a manifest is written rather than relying on which one abort happens to
    // read today. guardrailsAbort currently reads the session log via getActiveSession;
    // if it ever also consults active-scope.json, this keeps the fixture legacy instead
    // of silently becoming a non-legacy session that passes for the wrong reason.
    const scopePath = path.join(dir, '.rks', 'active-scope.json');
    if (fs.existsSync(scopePath)) {
      const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
      delete scope.preExistingDirty;
      fs.writeFileSync(scopePath, JSON.stringify(scope, null, 2));
    }

    const res = await guardrailsAbort(dir, {}, 'test-project');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('pre_session_state_unknown');
    // NULL, not [] — an absence of measurement must not read as an observation.
    expect(res.preExistingDirty).toBeNull();
    expect(res.error).toContain('UNKNOWN');
    expect(fs.existsSync(path.join(dir, 'pre-existing.txt'))).toBe(true);
  });

  it('a LEGACY session with no manifest but dirtyAtStart FALSE still discards — it does NOT wedge', async () => {
    // The conjunction that keeps legacy sessions escapable. Refusing unconditionally
    // would wedge them: guardrails are already off, the session cannot be reopened, and
    // the only escape would be an opt-in to destroying nothing.
    const { dir, problemId } = makeProject();
    projectRoot = dir;

    await guardrailsOff(dir, 'legacy clean', 'all', problemId, 'test-project');

    const logPath = path.join(dir, '.rks', 'guardrails-off-sessions.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => {
      const e = JSON.parse(l);
      if (e.preExistingDirty !== undefined) delete e.preExistingDirty;
      return JSON.stringify(e);
    });
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    // Strip it from the scope file too, so the fixture states the legacy condition in
    // BOTH places a manifest is written rather than relying on which one abort happens to
    // read today. guardrailsAbort currently reads the session log via getActiveSession;
    // if it ever also consults active-scope.json, this keeps the fixture legacy instead
    // of silently becoming a non-legacy session that passes for the wrong reason.
    const scopePath = path.join(dir, '.rks', 'active-scope.json');
    if (fs.existsSync(scopePath)) {
      const scope = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
      delete scope.preExistingDirty;
      fs.writeFileSync(scopePath, JSON.stringify(scope, null, 2));
    }

    fs.writeFileSync(path.join(dir, 'session-work.txt'), 'session\n');

    const res = await guardrailsAbort(dir, {}, 'test-project');
    expect(res.ok).toBe(true);
    expect(res.aborted).toBe(true);
    expect(fs.existsSync(path.join(dir, 'session-work.txt'))).toBe(false);
  });
});
