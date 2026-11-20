// backlog.fix.story-ship-unreachable-from-fresh-session
// rks_story_ship invoked while the worktree is ALREADY on the working branch. The old short-circuit
// returned success with no phase write for every story, so an executed story whose code was already
// delivered never reached integrated. Drives the REAL runStoryShipTool and the REAL auto-phase
// evidence probes against temp repos (2-branch with a bare origin, 2-branch local-only, 3-branch).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STORY_ID = 'backlog.feat.test';
const ARCHIVED_ID = 'backlog.z_implemented.feat.test';
const TRAILER = `Story: ${STORY_ID}`;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' };
const TWO_BRANCH = { working: 'staging', integration: 'staging', production: 'main' };
const THREE_BRANCH = { working: 'dev', integration: 'staging', production: 'main' };
let mockRoot;
let branchCfg = TWO_BRANCH;

const h = vi.hoisted(() => ({
  runReview: vi.fn(async () => ({ ok: true, verdict: 'pass', findings: [] })),
  assertNotOnProtectedBranch: vi.fn(),
}));

vi.mock('../../packages/mcp-rks/src/server/project.mjs', () => ({
  loadContext: vi.fn(async () => ({ record: { root: mockRoot, id: 'test-project' }, projectJson: { branches: branchCfg } })),
  getBranchConfig: vi.fn(() => branchCfg),
  getWorkflowConfig: vi.fn(() => ({ autoMergeIntegration: false })),
}));
vi.mock('../../packages/mcp-rks/src/server/branch-protection.mjs', () => ({ assertNotOnProtectedBranch: h.assertNotOnProtectedBranch }));
vi.mock('../../packages/mcp-rks/src/server/review.mjs', () => ({
  runReview: h.runReview,
  loadReviewPolicy: vi.fn(() => ({ enabled: true })),
  redactReview: vi.fn((r) => r),
}));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function noteFile(dir, id = STORY_ID) {
  return path.join(dir, 'notes', `${id}.md`);
}
function phaseOf(dir, id = STORY_ID) {
  const p = noteFile(dir, id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').match(/^phase:\s*"?([^"\n]+)"?\s*$/m)?.[1] ?? null;
}

/**
 * Temp repo whose worktree ends on `branch` (or rks/test-branch when feature) with the story note
 * and an implementation commit whose message paragraphs are `messages` (so a trailer is its own line).
 */
function makeRepo({ phase = 'executed', messages = ['feat: unrelated work'], push = true, noOrigin = false, archived = false, branch = 'staging', feature = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-ship-onworking-'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-ship-onworking-origin-'));
  git(bare, ['init', '--bare', '-q', '-b', 'staging']);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['init', '-q', '-b', 'staging']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  if (!noOrigin) {
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-q', 'origin', 'staging']);
  }
  if (branch !== 'staging') git(dir, ['checkout', '-q', '-b', branch]);
  if (feature) git(dir, ['checkout', '-q', '-b', 'rks/test-branch']);
  const id = archived ? ARCHIVED_ID : STORY_ID;
  fs.writeFileSync(noteFile(dir, id), `---\nid: "${id}"\nphase: "${phase}"\n---\n\nbody\n`);
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', ...messages.flatMap((m) => ['-m', m])]);
  if (!noOrigin && push && branch === 'staging' && !feature) git(dir, ['push', '-q', 'origin', 'staging']);
  return { dir, bare };
}

async function ship(problemId = STORY_ID) {
  const { runStoryShipTool } = await import('../../packages/mcp-rks/src/server/story-ship.mjs');
  return runStoryShipTool({ projectId: 'test-project', ...(problemId ? { problemId } : {}) });
}
const stepOf = (result, name) => result.steps.find((s) => s.step === name);

let fixture;
beforeEach(() => {
  vi.resetModules();
  branchCfg = TWO_BRANCH;
  h.runReview.mockClear();
  h.assertNotOnProtectedBranch.mockReset();
});
afterEach(() => {
  if (fixture) {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(fixture.bare, { recursive: true, force: true });
  }
  fixture = undefined;
});

describe('findStoryCommitEvidence', () => {
  it('prefers the trailer, rejects a longer sibling id, and throws on a git failure', async () => {
    fixture = makeRepo({ noOrigin: true, messages: ['feat: implement', TRAILER] });
    const { findStoryCommitEvidence } = await import('../../packages/mcp-rks/src/workflow/auto-phase.mjs');
    const sha = git(fixture.dir, ['rev-parse', 'HEAD']);
    expect(findStoryCommitEvidence(fixture.dir, STORY_ID, 'staging')).toEqual({ form: 'trailer', commit: sha, ref: 'staging', trailer: TRAILER });
    expect(findStoryCommitEvidence(fixture.dir, 'backlog.feat.other', 'staging')).toBeNull();
    expect(() => findStoryCommitEvidence(fixture.dir, STORY_ID, 'no-such-ref')).toThrow();
  });
  it('falls back to the exact legacy exec subject, and a sibling trailer is not evidence', async () => {
    fixture = makeRepo({ noOrigin: true, messages: [`feat(exec): ${STORY_ID}`] });
    const { findStoryCommitEvidence } = await import('../../packages/mcp-rks/src/workflow/auto-phase.mjs');
    const sha = git(fixture.dir, ['rev-parse', 'HEAD']);
    expect(findStoryCommitEvidence(fixture.dir, STORY_ID, 'staging')).toEqual({ form: 'legacy_exec_subject', commit: sha, ref: 'staging', subject: `feat(exec): ${STORY_ID}` });
    fs.writeFileSync(path.join(fixture.dir, 'sibling.txt'), 'x\n');
    git(fixture.dir, ['add', '-A']);
    git(fixture.dir, ['commit', '-q', '-m', 'feat: child', '-m', `Story: ${STORY_ID}.child`]);
    expect(findStoryCommitEvidence(fixture.dir, `${STORY_ID}.c`, 'staging')).toBeNull();
  });
});

describe('isRefAncestorOfHead and readFileAtRef', () => {
  it('compare a ref with HEAD and read committed files, throwing on a git failure', async () => {
    fixture = makeRepo({ noOrigin: true });
    const { isRefAncestorOfHead, readFileAtRef } = await import('../../packages/mcp-rks/src/workflow/auto-phase.mjs');
    expect(isRefAncestorOfHead(fixture.dir, 'staging')).toBe(true);
    git(fixture.dir, ['checkout', '-q', '-b', 'ahead']);
    git(fixture.dir, ['commit', '-q', '--allow-empty', '-m', 'ahead']);
    git(fixture.dir, ['checkout', '-q', 'staging']);
    expect(isRefAncestorOfHead(fixture.dir, 'ahead')).toBe(false);
    expect(() => isRefAncestorOfHead(fixture.dir, 'no-such-ref')).toThrow();
    expect(readFileAtRef(fixture.dir, 'staging', `notes/${STORY_ID}.md`)).toContain('phase: "executed"');
    expect(readFileAtRef(fixture.dir, 'staging', `notes/${ARCHIVED_ID}.md`)).toBeNull();
    expect(() => readFileAtRef(fixture.dir, 'no-such-ref', `notes/${STORY_ID}.md`)).toThrow();
  });
});

describe('two-branch, worktree on the working branch', () => {
  it('advances an executed story whose trailer commit is on origin/staging', async () => {
    fixture = makeRepo({ messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    const implSha = git(fixture.dir, ['rev-parse', 'HEAD']);
    const result = await ship();
    expect(result.idempotent).toBeUndefined();
    const check = stepOf(result, 'check');
    expect(check?.ok).toBe(true);
    expect(check.reason).toBe('already_on_working_branch');
    expect(check.evidence).toMatchObject({ form: 'trailer', ref: 'origin/staging', commit: implSha });
    expect(stepOf(result, 'review')?.skipped).toBe(true);
    expect(h.runReview).not.toHaveBeenCalled();
    expect(stepOf(result, 'local_merge')?.skipped).toBe(true);
    expect(stepOf(result, 'mark_implemented')?.ok).toBe(true);
    expect(fs.existsSync(noteFile(fixture.dir))).toBe(false);
    expect(phaseOf(fixture.dir, ARCHIVED_ID)).toBe('integrated');
    expect(git(fixture.bare, ['log', '--format=%s', 'staging'])).toContain(`chore: mark ${STORY_ID} as implemented`);
    expect(result.ok).toBe(true);
  });

  it('advances on the exact legacy exec subject when there is no trailer', async () => {
    fixture = makeRepo({ messages: [`feat(exec): ${STORY_ID}`] });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(result.idempotent).toBeUndefined();
    expect(stepOf(result, 'check')?.evidence?.form).toBe('legacy_exec_subject');
    expect(phaseOf(fixture.dir, ARCHIVED_ID)).toBe('integrated');
  });

  it('refuses without a story commit and leaves phase and branch untouched', async () => {
    fixture = makeRepo();
    mockRoot = fixture.dir;
    const head = git(fixture.dir, ['rev-parse', 'HEAD']);
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.idempotent).toBeUndefined();
    expect(result.failedStep).toBe('on_working_branch');
    expect(result.reason).toBe('no_story_commit_on_working_branch');
    expect(result.worktreeBranch).toBe('staging');
    expect(result.baseBranch).toBe('staging');
    expect(result.branchRestored).toBe(false);
    expect(phaseOf(fixture.dir)).toBe('executed');
    expect(fs.existsSync(noteFile(fixture.dir, ARCHIVED_ID))).toBe(false);
    expect(git(fixture.dir, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('refuses when the trailer commit is only local and not on origin/staging', async () => {
    fixture = makeRepo({ messages: ['feat: implement', TRAILER], push: false });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_story_commit_on_working_branch');
    expect(phaseOf(fixture.dir)).toBe('executed');
  });

  it('refuses when only a longer sibling id carries the trailer', async () => {
    fixture = makeRepo({ messages: ['feat: child', `Story: ${STORY_ID}.child`] });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_story_commit_on_working_branch');
    expect(phaseOf(fixture.dir)).toBe('executed');
  });

  it('refuses a story that is not at phase executed even with a trailer commit', async () => {
    fixture = makeRepo({ phase: 'ready', messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    const head = git(fixture.dir, ['rev-parse', 'HEAD']);
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('phase_not_executed');
    expect(phaseOf(fixture.dir)).toBe('ready');
    expect(git(fixture.dir, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('reports an already-integrated story as idempotent and writes nothing', async () => {
    fixture = makeRepo({ phase: 'integrated' });
    mockRoot = fixture.dir;
    const head = git(fixture.dir, ['rev-parse', 'HEAD']);
    const before = fs.readFileSync(noteFile(fixture.dir), 'utf8');
    const result = await ship();
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(stepOf(result, 'check')).toMatchObject({ skipped: true, observed: 'integrated' });
    expect(git(fixture.dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.readFileSync(noteFile(fixture.dir), 'utf8')).toBe(before);
  });

  it('reports an archived story as idempotent', async () => {
    fixture = makeRepo({ archived: true, phase: 'integrated' });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(stepOf(result, 'check')?.observed).toBe('archived');
  });

  it('refuses when local staging is behind origin/staging, and writes nothing', async () => {
    fixture = makeRepo();
    mockRoot = fixture.dir;
    git(fixture.dir, ['commit', '-q', '--allow-empty', '-m', 'feat: implement', '-m', TRAILER]);
    git(fixture.dir, ['push', '-q', 'origin', 'staging']);
    const originHead = git(fixture.bare, ['rev-parse', 'staging']);
    git(fixture.dir, ['reset', '-q', '--hard', 'HEAD~1']);
    const head = git(fixture.dir, ['rev-parse', 'HEAD']);
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.idempotent).toBeUndefined();
    expect(result.failedStep).toBe('on_working_branch');
    expect(result.reason).toBe('working_branch_behind_delivered_ref');
    expect(result.hint).toContain('Fast-forward staging to origin/staging');
    expect(phaseOf(fixture.dir)).toBe('executed');
    expect(fs.existsSync(noteFile(fixture.dir, ARCHIVED_ID))).toBe(false);
    expect(git(fixture.dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(fixture.bare, ['rev-parse', 'staging'])).toBe(originHead);
  });

  it('refuses an archive that exists only in this clone, never reporting it as idempotent', async () => {
    fixture = makeRepo({ messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    fs.writeFileSync(noteFile(fixture.dir, ARCHIVED_ID), `---\nid: "${ARCHIVED_ID}"\nphase: "integrated"\n---\n\nbody\n`);
    fs.rmSync(noteFile(fixture.dir));
    git(fixture.dir, ['add', '-A']);
    git(fixture.dir, ['commit', '-q', '-m', `chore: mark ${STORY_ID} as implemented`]);
    const head = git(fixture.dir, ['rev-parse', 'HEAD']);
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.idempotent).toBeUndefined();
    expect(result.failedStep).toBe('on_working_branch');
    expect(result.reason).toBe('integration_not_on_delivered_ref');
    expect(git(fixture.dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(fixture.bare, ['log', '--format=%s', 'staging'])).not.toContain(`chore: mark ${STORY_ID} as implemented`);
  });

  it('refuses with no problemId', async () => {
    fixture = makeRepo({ messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    const result = await ship(null);
    expect(result.ok).toBe(false);
    expect(result.idempotent).toBeUndefined();
    expect(result.reason).toBe('no_story_id');
  });
});

describe('local-only working branch (no origin)', () => {
  it('advances on a trailer commit on local staging, with no bookkeeping push', async () => {
    fixture = makeRepo({ noOrigin: true, messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(stepOf(result, 'check')?.evidence?.ref).toBe('staging');
    expect(phaseOf(fixture.dir, ARCHIVED_ID)).toBe('integrated');
    expect(result.steps.some((s) => s.step === 'push_bookkeeping')).toBe(false);
    expect(result.idempotent).toBeUndefined();
    expect(stepOf(result, 'cycle_complete')?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('three-branch (working dev, integration staging)', () => {
  it('still refuses from the protected integration branch and names the working branch', async () => {
    branchCfg = THREE_BRANCH;
    h.assertNotOnProtectedBranch.mockImplementation(() => {
      throw new Error("BLOCKED: Cannot run story_ship from while on protected branch 'staging'.");
    });
    fixture = makeRepo({ noOrigin: true, messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(result.ok).toBe(false);
    expect(result.hint).toContain('not from a protected branch');
    expect(result.hint).toContain('check out dev');
    expect(phaseOf(fixture.dir)).toBe('executed');
  });

  it('advances from the working branch on a trailer commit on local dev', async () => {
    branchCfg = THREE_BRANCH;
    fixture = makeRepo({ noOrigin: true, branch: 'dev', messages: ['feat: implement', TRAILER] });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(stepOf(result, 'check')?.evidence?.ref).toBe('dev');
    expect(phaseOf(fixture.dir, ARCHIVED_ID)).toBe('integrated');
    expect(result.idempotent).toBeUndefined();
    expect(stepOf(result, 'cycle_complete')?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('regression: normal ship from a feature branch is unchanged', () => {
  it('reviews, merges and archives exactly as before, with no check step', async () => {
    fixture = makeRepo({ feature: true, messages: ['feat: test feature'] });
    mockRoot = fixture.dir;
    const result = await ship();
    expect(stepOf(result, 'check')).toBeUndefined();
    expect(h.runReview).toHaveBeenCalledTimes(1);
    expect(stepOf(result, 'local_merge')?.ok).toBe(true);
    expect(result.idempotent).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(phaseOf(fixture.dir, ARCHIVED_ID)).toBe('integrated');
  });
});
