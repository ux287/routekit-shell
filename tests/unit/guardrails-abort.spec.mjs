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

// The global stub (tests/setup.mjs); read to assert the hooks.bak provenance telemetry event.
import { ensureTelemetryStorage } from '@routekit/telemetry';

const { guardrailsOff, guardrailsAbort, measureHooksTrackedInGit } = await import(
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

  // ── backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed (AC4, AC7) ──────────────
  const readLog = (root) => {
    const p = path.join(root, '.rks', 'guardrails-off-sessions.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const provenanceRecords = (root, component) =>
    readLog(root).filter((r) => r.kind === 'hooks_bak_provenance' && r.component === component);
  const expectProvenanceShape = (rec) => {
    expect(Object.prototype.hasOwnProperty.call(rec, 'sessionId')).toBe(true);
    expect(rec.sessionId === null || typeof rec.sessionId === 'string').toBe(true);
    expect(new Date(rec.timestamp).toISOString()).toBe(rec.timestamp);
    expect(typeof rec.reason).toBe('string');
    expect(rec.reason.length).toBeGreaterThan(0);
    for (const k of ['problemId', 'startedAt', 'endedAt', 'aborted']) {
      expect(Object.prototype.hasOwnProperty.call(rec, k)).toBe(false);
    }
  };
  const hooksBakRemovedEmits = () =>
    vi.mocked(ensureTelemetryStorage)().emit.mock.calls.filter((c) => c[0] === 'guardrails.hooks_bak_removed');

  it('orphan session with NO hooks.bak: fails closed with hooks_backup_missing, installs no template hooks, keeps guard state off (AC7)', async () => {
    ({ dir: projectRoot } = makeProject());
    // Orphan state: guard state off, no session recorded, and the backup is gone.
    fs.rmSync(path.join(projectRoot, '.routekit', 'hooks'), { recursive: true, force: true });
    fs.mkdirSync(path.join(projectRoot, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.rks', 'guardrails-state.json'),
      JSON.stringify({ active: false, disabledTiers: ['read', 'write'] }, null, 2)
    );

    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');

    expect(result.ok).not.toBe(true);
    expect(String(result.reason ?? result.error)).toContain('hooks_backup_missing');
    expect(result.hooksRestored).not.toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, 'provenance')).toBe(true);
    expect(result.provenance).toBeNull();
    // No template install.
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks'))).toBe(false);
    // Guard state still off.
    const state = JSON.parse(fs.readFileSync(path.join(projectRoot, '.rks', 'guardrails-state.json'), 'utf8'));
    expect(state.active).toBe(false);
  });

  it('orphan session with hooks.bak: the rename back records provenance and emits telemetry (AC4)', async () => {
    ({ dir: projectRoot } = makeProject());
    fs.renameSync(
      path.join(projectRoot, '.routekit', 'hooks'),
      path.join(projectRoot, '.routekit', 'hooks.bak')
    );
    fs.mkdirSync(path.join(projectRoot, '.rks'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.rks', 'guardrails-state.json'),
      JSON.stringify({ active: false, disabledTiers: ['read', 'write'] }, null, 2)
    );
    vi.mocked(ensureTelemetryStorage)().emit.mockClear();

    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');
    expect(result.ok).toBe(true);

    const recs = provenanceRecords(projectRoot, 'guardrailsAbort');
    expect(recs).toHaveLength(1);
    expectProvenanceShape(recs[0]);
    const emits = hooksBakRemovedEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0][2]).toMatchObject({
      component: recs[0].component,
      sessionId: recs[0].sessionId,
      timestamp: recs[0].timestamp,
      reason: recs[0].reason,
    });
  });

  it('tracked-session abort: the post-reset hooks.bak cleanup records provenance with the session id (AC4)', async () => {
    let problemId;
    ({ dir: projectRoot, problemId } = makeProject());
    const off = await guardrailsOff(projectRoot, 'test-abort-provenance', 'all', problemId);
    expect(off.ok).toBe(true);
    // Leave a non-tier entry in hooks.bak so the post-reset cleanup has something to remove.
    fs.writeFileSync(path.join(projectRoot, '.routekit', 'hooks.bak', 'leftover.txt'), 'x');
    vi.mocked(ensureTelemetryStorage)().emit.mockClear();

    const result = await guardrailsAbort(projectRoot, {}, 'routekit-shell-core');
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(false);

    const recs = provenanceRecords(projectRoot, 'guardrailsAbort');
    expect(recs).toHaveLength(1);
    expectProvenanceShape(recs[0]);
    expect(recs[0].sessionId).toBe(result.sessionId);
    const emits = hooksBakRemovedEmits();
    expect(emits).toHaveLength(1);
    expect(emits[0][2]).toMatchObject({ component: 'guardrailsAbort', sessionId: result.sessionId, timestamp: recs[0].timestamp });
    // The aborted end entry is still what the log's end-selection finds.
    expect(readLog(projectRoot).filter((e) => e.endedAt).pop().aborted).toBe(true);
  }, 30000);

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
// backlog.fix.guardrails-abort-restores-hooks-from-filesystem
//
// The main abort path used to restore the relocated tiers best-effort and rely on
// `git reset --hard` to recreate them. When `.routekit/` is untracked (content-only
// remote: listed in .git/info/exclude) the reset recreates nothing, and hooks.bak/ is
// the only copy. The restore is now authoritative and fail-closed.
// ─────────────────────────────────────────────────────────────────────────────
const AUDIT_SRC_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);
const SPAWN_TIMEOUT_MS = 120000;

function git(dir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: dir,
    encoding: 'utf8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SPAWN_TIMEOUT_MS,
  }).trim();
}

const TIER_FILES = {
  'write/enforce-plan-scope.mjs': '// write-tier hook: original bytes\nexport const tier = "write";\n',
  'write/redirect-edit-to-governor.mjs': '// second write hook\n',
  'read/enforce-read-provenance.mjs': '// read-tier hook: original bytes\nexport const tier = "read";\n',
  'system/hook-output.mjs': '// system-tier helper\n',
};

/**
 * Tier-layout fixture. `tracked: false` lists `.routekit/` in .git/info/exclude so the hooks
 * are never committed (content-only remote); `tracked: true` commits them.
 */
function makeTierProject({ tracked }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-abort-tier-'));
  const hooksDir = path.join(dir, '.routekit', 'hooks');
  for (const [rel, body] of Object.entries(TIER_FILES)) {
    fs.mkdirSync(path.dirname(path.join(hooksDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(hooksDir, rel), body);
  }
  fs.writeFileSync(
    path.join(dir, '.routekit', 'hooks-manifest.json'),
    JSON.stringify(
      {
        'enforce-plan-scope': { tier: 'write' },
        'redirect-edit-to-governor': { tier: 'write' },
        'enforce-read-provenance': { tier: 'read' },
        'hook-output': { tier: 'system' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    ['node_modules/', '.rks/', '.routekit/hooks.bak/', ''].join('\n')
  );
  const problemId = 'test-abort-tier-story';
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'notes', `${problemId}.md`),
    `---\nid: "${problemId}"\ntitle: "tier abort fixture"\nphase: "arch-approved"\ntargetFiles: []\n---\n`
  );
  fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.rks', 'review-policy.yaml'),
    '# Fixture: keep the off-rail gate from calling a live reviewer.\nenabled: false\n'
  );

  git(dir, 'init -b staging');
  git(dir, 'config user.email "test@test.com"');
  git(dir, 'config user.name "test"');
  if (!tracked) {
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.routekit/\n');
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# original\n');
  git(dir, 'add -A');
  git(dir, 'commit -q -m init');

  // Fixture preconditions, measured: tracked-ness of the tier files is what the case is about.
  const lsFiles = git(dir, 'ls-files -- .routekit/hooks/write .routekit/hooks/read');
  if (tracked) expect(lsFiles.length).toBeGreaterThan(0);
  else expect(lsFiles).toBe('');

  return { dir, problemId, head: git(dir, 'rev-parse HEAD') };
}

function readTierFiles(dir) {
  const out = {};
  for (const rel of Object.keys(TIER_FILES)) {
    const p = path.join(dir, '.routekit', 'hooks', rel);
    out[rel] = fs.existsSync(p) ? fs.readFileSync(p) : null;
  }
  return out;
}

function guardActive(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.rks', 'guardrails-state.json'), 'utf8')).active;
}

/** Off-rail session with session work: one new untracked file, one edit to a tracked file. */
async function openSessionWithWork(dir, problemId) {
  const off = await guardrailsOff(dir, 'tier abort test', 'all', problemId, 'test-project');
  expect(off.ok, JSON.stringify(off)).toBe(true);
  const bak = path.join(dir, '.routekit', 'hooks.bak');
  expect(fs.existsSync(path.join(bak, 'write'))).toBe(true);
  expect(fs.existsSync(path.join(bak, 'read'))).toBe(true);
  expect(fs.existsSync(path.join(dir, '.routekit', 'hooks', 'write'))).toBe(false);
  fs.writeFileSync(path.join(dir, 'session-new.txt'), 'made during the session\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# SESSION EDIT\n');
  return off;
}

/** The guardrailsAbort function body: from its export to the next top-level export. */
function abortBody(src) {
  const start = src.indexOf('export async function guardrailsAbort');
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport /);
  expect(next).toBeGreaterThan(-1);
  return src.slice(start, start + 1 + next);
}

describe('guardrailsAbort — filesystem hook restore, fail-closed (untracked hooks)', () => {
  let projectRoot;
  let spies = [];
  const realRenameSync = fs.renameSync;
  const realReaddirSync = fs.readdirSync;

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
    if (projectRoot) cleanup(projectRoot);
    projectRoot = undefined;
  });

  it('untracked hooks: abort restores write/ and read/ byte-identical, removes hooks.bak, and still discards session work', async () => {
    let problemId, head;
    ({ dir: projectRoot, problemId, head } = makeTierProject({ tracked: false }));
    const before = readTierFiles(projectRoot);
    await openSessionWithWork(projectRoot, problemId);

    const res = await guardrailsAbort(projectRoot, {}, 'test-project');

    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.aborted).toBe(true);
    // Hooks back, byte-identical, backup gone.
    expect(fs.statSync(path.join(projectRoot, '.routekit', 'hooks', 'write')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(projectRoot, '.routekit', 'hooks', 'read')).isDirectory()).toBe(true);
    const after = readTierFiles(projectRoot);
    for (const rel of Object.keys(TIER_FILES)) {
      expect(after[rel], rel).not.toBeNull();
      expect(Buffer.compare(after[rel], before[rel]), rel).toBe(0);
    }
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(false);
    // Session work discarded.
    expect(headOf(projectRoot)).toBe(head);
    expect(fs.existsSync(path.join(projectRoot, 'session-new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# original\n');
    // Evidence-bound success report.
    expect(res.hooksRestored).toBe(true);
    expect(Array.isArray(res.restoredTiers)).toBe(true);
    expect([...res.restoredTiers].sort()).toEqual(['read', 'write']);
    expect(res.message).toContain('hooks restored');
    expect(guardActive(projectRoot)).toBe(true);
  }, 30000);

  it('restore fault: returns hook_restore_failed, runs no reset or clean, keeps hooks.bak and guard state, and a retry succeeds', async () => {
    let problemId, head;
    ({ dir: projectRoot, problemId, head } = makeTierProject({ tracked: false }));
    const before = readTierFiles(projectRoot);
    await openSessionWithWork(projectRoot, problemId);

    // Deterministic, not permission-based: any rename OUT of hooks.bak throws.
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      if (String(src).includes(`${path.sep}hooks.bak`)) {
        throw Object.assign(new Error('EACCES: injected rename fault'), { code: 'EACCES' });
      }
      return realRenameSync(src, dst);
    });
    spies.push(spy);

    const res = await guardrailsAbort(projectRoot, {}, 'test-project');

    expect(res.ok).toBe(false);
    expect(res.aborted).toBe(false);
    expect(res.reason).toBe('hook_restore_failed');
    expect(typeof res.error).toBe('string');
    expect(res.error.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalled();

    // No reset or clean ran.
    expect(headOf(projectRoot)).toBe(head);
    expect(fs.existsSync(path.join(projectRoot, 'session-new.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# SESSION EDIT\n');
    const bak = path.join(projectRoot, '.routekit', 'hooks.bak');
    expect(fs.statSync(path.join(bak, 'write')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(bak, 'read')).isDirectory()).toBe(true);
    expect(guardActive(projectRoot)).toBe(false);

    // Clear the fault and retry.
    spy.mockRestore();
    spies = [];
    const retry = await guardrailsAbort(projectRoot, {}, 'test-project');
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    expect(retry.aborted).toBe(true);
    expect(retry.hooksRestored).toBe(true);
    expect(fs.existsSync(bak)).toBe(false);
    const after = readTierFiles(projectRoot);
    for (const rel of Object.keys(TIER_FILES)) {
      expect(Buffer.compare(after[rel], before[rel]), rel).toBe(0);
    }
    expect(headOf(projectRoot)).toBe(head);
    expect(fs.existsSync(path.join(projectRoot, 'session-new.txt'))).toBe(false);
  }, 30000);

  it('hooks.bak deleted on the main path: fails closed with hooks_backup_missing (hooksTrackedInGit false), no reset', async () => {
    let problemId, head;
    ({ dir: projectRoot, problemId, head } = makeTierProject({ tracked: false }));
    await openSessionWithWork(projectRoot, problemId);
    fs.rmSync(path.join(projectRoot, '.routekit', 'hooks.bak'), { recursive: true, force: true });

    const res = await guardrailsAbort(projectRoot, {}, 'test-project');

    expect(res.ok).toBe(false);
    expect(res.aborted).toBe(false);
    expect(res.reason).toBe('hooks_backup_missing');
    expect(res.hooksRestored).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(res, 'provenance')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(res, 'hooksTrackedInGit')).toBe(true);
    expect(res.hooksTrackedInGit).toBe(false);
    expect(res.recovery).not.toContain('tracked under');
    expect(res.recovery).not.toContain('git checkout HEAD');
    expect(res.recovery).toContain('restoreFromTemplate: true');
    // No reset: HEAD unchanged, session work still on disk, guard state still off-rail.
    expect(headOf(projectRoot)).toBe(head);
    expect(fs.existsSync(path.join(projectRoot, 'session-new.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# SESSION EDIT\n');
    expect(guardActive(projectRoot)).toBe(false);
  }, 30000);

  it('hooks.bak deleted with git-tracked tiers: hooksTrackedInGit true and the recovery names git checkout', async () => {
    let problemId;
    ({ dir: projectRoot, problemId } = makeTierProject({ tracked: true }));
    await openSessionWithWork(projectRoot, problemId);
    fs.rmSync(path.join(projectRoot, '.routekit', 'hooks.bak'), { recursive: true, force: true });

    const res = await guardrailsAbort(projectRoot, {}, 'test-project');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('hooks_backup_missing');
    expect(res.hooksTrackedInGit).toBe(true);
    expect(res.recovery).toContain('git checkout HEAD -- .routekit/hooks/write .routekit/hooks/read');
    expect(res.recovery).toContain('restoreFromTemplate: true');
  }, 30000);

  it('hooksTrackedInGit is null when git ls-files fails (non-git directory), and the recovery makes no tracked claim', async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-abort-nogit-'));
    // Stop git discovery at the temp dir so an enclosing repo cannot answer for it.
    const prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(projectRoot);
    try {
      expect(measureHooksTrackedInGit(projectRoot)).toBeNull();

      // Orphan off-rail state (no session, no hooks.bak) → hooksBackupMissingResult.
      fs.mkdirSync(path.join(projectRoot, '.rks'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.rks', 'guardrails-state.json'),
        JSON.stringify({ active: false, disabledTiers: ['read', 'write'] }, null, 2)
      );
      const res = await guardrailsAbort(projectRoot, {}, 'test-project');
      expect(res.reason).toBe('hooks_backup_missing');
      expect(Object.prototype.hasOwnProperty.call(res, 'hooksTrackedInGit')).toBe(true);
      expect(res.hooksTrackedInGit).toBeNull();
      expect(res.recovery).not.toContain('tracked under');
      expect(res.recovery).not.toContain('git checkout HEAD');
      expect(res.recovery).toContain('restoreFromTemplate: true');
    } finally {
      if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
    }
  });

  it('post-reset verification failure: hooks_missing_after_abort keeps hooks.bak and guard state, and reports no restore', async () => {
    let problemId;
    ({ dir: projectRoot, problemId } = makeTierProject({ tracked: false }));
    await openSessionWithWork(projectRoot, problemId);

    // Deterministic fs fault AFTER the move: the first time the restored write/ tier is listed
    // (moveHookTiersFromBak does so right after the rename), delete it. On an untracked
    // fixture nothing recreates it, so the post-reset check must catch the absence.
    const writeDst = path.join(projectRoot, '.routekit', 'hooks', 'write');
    let fired = false;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      const out = realReaddirSync(...args);
      if (!fired && path.resolve(String(args[0])) === writeDst) {
        fired = true;
        fs.rmSync(writeDst, { recursive: true, force: true });
      }
      return out;
    });
    spies.push(spy);

    const res = await guardrailsAbort(projectRoot, {}, 'test-project');
    spy.mockRestore();
    spies = [];

    expect(fired).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('hooks_missing_after_abort');
    expect(res.hooksRestored).not.toBe(true);
    if (res.message !== undefined) expect(res.message).not.toContain('hooks restored');
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(true);
    expect(guardActive(projectRoot)).toBe(false);
  }, 30000);

  it('flat-layout fixture (no tiers moved): ok true, hooksRestored strictly false, restoredTiers [], hooks.bak removed', async () => {
    let problemId;
    ({ dir: projectRoot, problemId } = makeProject());
    await guardrailsOff(projectRoot, 'flat', 'all', problemId);
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(true);

    const res = await guardrailsAbort(projectRoot, {}, 'test-project');

    expect(res.ok).toBe(true);
    expect(res.aborted).toBe(true);
    expect(res.hooksRestored).toBe(false);
    expect(res.restoredTiers).toEqual([]);
    expect(res.message).not.toContain('hooks restored');
    expect(fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'))).toBe(false);
  }, 30000);

  it('source: the guardrailsAbort body uses the shared moveHookTiersFromBak restore and no constant success report', () => {
    const src = fs.readFileSync(AUDIT_SRC_PATH, 'utf8');
    const body = abortBody(src);
    expect(body).toContain('moveHookTiersFromBak(');
    expect(body).not.toContain('["write", "read"]');
    expect(body).not.toContain('hooksRestored: true');
    expect(body).toContain('restoredTiers');
  });

  it('source: the JSDoc immediately preceding guardrailsAbort no longer claims the hooks are git-tracked', () => {
    const src = fs.readFileSync(AUDIT_SRC_PATH, 'utf8');
    const start = src.indexOf('export async function guardrailsAbort');
    const docStart = src.lastIndexOf('/**', start);
    const doc = src.slice(docStart, start);
    expect(doc.trimEnd().endsWith('*/')).toBe(true);
    expect(doc).not.toContain('are git-tracked');
  });

  it('source: the git ls-files call behind hooksTrackedInGit passes an explicit timeout', () => {
    const src = fs.readFileSync(AUDIT_SRC_PATH, 'utf8');
    const start = src.indexOf('export function measureHooksTrackedInGit');
    expect(start).toBeGreaterThan(-1);
    const fnSrc = src.slice(start, src.indexOf('\n}\n', start) + 2);
    const lsIdx = fnSrc.indexOf('ls-files');
    expect(lsIdx).toBeGreaterThan(-1);
    expect(fnSrc.slice(lsIdx)).toMatch(/\btimeout\s*:\s*\d/);
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
