/**
 * Tests for runRelease() — verifies tag is created on main after ff-merge,
 * not on staging before merge. Also tests rollback on failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync as _spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Every subprocess spawn in this file carries an explicit timeout so a hung git
// invocation fails fast instead of stranding the vitest run with orphaned procs.
const SPAWN_TIMEOUT_MS = 30000;
function spawnSync(cmd, args, opts = {}) {
  return _spawnSync(cmd, args, { timeout: SPAWN_TIMEOUT_MS, ...opts });
}


const { runRelease, isReleaseBumpSubject } = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

// Helper: create a bare remote + clone with staging + main branches and a package.json
function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-release-test-'));
  const bareDir = path.join(base, 'origin.git');
  const workDir = path.join(base, 'work');

  // Create bare remote
  spawnSync('git', ['init', '--bare', '--initial-branch', 'main', bareDir]);

  // Clone it
  spawnSync('git', ['clone', bareDir, workDir]);
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: workDir });

  // Create package.json
  fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.0' }, null, 2) + '\n');

  // Create notes dir (required by resolveNotesDir)
  fs.mkdirSync(path.join(workDir, 'notes'), { recursive: true });

  // Initial commit on main and push
  spawnSync('git', ['add', '.'], { cwd: workDir });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: workDir });
  spawnSync('git', ['push', 'origin', 'main'], { cwd: workDir });

  // Create staging from main and push
  spawnSync('git', ['checkout', '-b', 'staging'], { cwd: workDir });
  spawnSync('git', ['push', '-u', 'origin', 'staging'], { cwd: workDir });

  // Add a feature commit on staging and push
  fs.writeFileSync(path.join(workDir, 'feature.txt'), 'new feature\n');
  spawnSync('git', ['add', '.'], { cwd: workDir });
  spawnSync('git', ['commit', '-m', 'feat: add feature'], { cwd: workDir });
  spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });

  return { base, workDir };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function getTagCommit(dir, tag) {
  const result = spawnSync('git', ['rev-list', '-1', tag], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function getBranchHead(dir, branch) {
  const result = spawnSync('git', ['rev-parse', branch], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function getTags(dir) {
  const result = spawnSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' });
  return result.stdout.trim().split('\n').filter(Boolean);
}

function getCurrentBranch(dir) {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return result.stdout.trim();
}

function countSubjectMatches(dir, branch, substring) {
  const result = spawnSync('git', ['log', '--format=%s', branch], { cwd: dir, encoding: 'utf8' });
  return result.stdout.split('\n').filter((l) => l.includes(substring)).length;
}

function commitCount(dir, branch) {
  const result = spawnSync('git', ['rev-list', '--count', branch], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function isClean(dir) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  return result.stdout.trim() === '';
}

function pkgVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

describe('runRelease', () => {
  let base;
  let workDir;

  beforeEach(async () => {
    ({ base, workDir } = makeTempRepo());
  });

  afterEach(() => {
    if (base) cleanup(base);
  });

  it('creates tag on main after successful ff-merge', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.tag).toBe('v0.1.1');

    // Tag commit should match main HEAD
    const tagCommit = getTagCommit(workDir, 'v0.1.1');
    const mainHead = getBranchHead(workDir, 'main');
    expect(tagCommit).toBe(mainHead);
  });

  it('tag is created while HEAD points to main, not staging', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);

    // Tag should be reachable from main
    const reachable = spawnSync('git', ['branch', '--contains', 'v0.1.1'], { cwd: workDir, encoding: 'utf8' });
    expect(reachable.stdout).toContain('main');
  });

  // backlog.chore.codify-semver-versioning-policy — the release bumps the workspace sub-packages
  // in lockstep with root so the three package.json versions never drift.
  it('lockstep-bumps packages/mcp-rks + packages/cli package.json alongside root', async () => {
    for (const rel of ['packages/mcp-rks', 'packages/cli']) {
      fs.mkdirSync(path.join(workDir, rel), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, rel, 'package.json'),
        JSON.stringify({ name: `@routekit/${rel.split('/')[1]}`, version: '0.1.0' }, null, 2) + '\n',
      );
    }
    spawnSync('git', ['add', '.'], { cwd: workDir });
    spawnSync('git', ['commit', '-m', 'chore: add workspace packages'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });
    expect(result.ok, result.error).toBe(true);
    expect(result.version).toBe('0.1.1');

    const v = (rel) => JSON.parse(fs.readFileSync(path.join(workDir, rel), 'utf8')).version;
    expect(pkgVersion(workDir)).toBe('0.1.1');
    expect(v('packages/mcp-rks/package.json')).toBe('0.1.1');
    expect(v('packages/cli/package.json')).toBe('0.1.1');
  });

  it('version bump commit happens on staging before checkout to main', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);

    // Staging log should have the version bump commit
    const logResult = spawnSync('git', ['log', '--oneline', 'staging'], { cwd: workDir, encoding: 'utf8' });
    expect(logResult.stdout).toContain('chore(release): 0.1.1');
  });

  it('returns error and creates NO tag when ff-merge fails', async () => {
    // Create a divergent commit on main and push it so local and origin match
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'divergent.txt'), 'divergent\n');
    spawnSync('git', ['add', '.'], { cwd: workDir });
    spawnSync('git', ['commit', '-m', 'divergent commit on main'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('fast-forward');
    // No tag should exist
    expect(getTags(workDir)).not.toContain('v0.1.1');
    // Should be back on staging
    expect(getCurrentBranch(workDir)).toBe('staging');
  });

  it('on full success: main and staging both contain version bump, tag on main', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);

    // Both branches should have the version bump commit
    const stagingLog = spawnSync('git', ['log', '--oneline', 'staging'], { cwd: workDir, encoding: 'utf8' });
    const mainLog = spawnSync('git', ['log', '--oneline', 'main'], { cwd: workDir, encoding: 'utf8' });
    expect(stagingLog.stdout).toContain('chore(release): 0.1.1');
    expect(mainLog.stdout).toContain('chore(release): 0.1.1');

    // Tag points to that commit on main
    const tagCommit = getTagCommit(workDir, 'v0.1.1');
    const mainHead = getBranchHead(workDir, 'main');
    expect(tagCommit).toBe(mainHead);
  });

  it('function signature is unchanged — accepts { projectRoot, version, changelog }', async () => {
    const result = await runRelease({
      projectRoot: workDir,
      version: 'minor',
      changelog: 'Test release notes'
    });
    expect(result).toHaveProperty('ok');
  });

  it('succeeds with pre-existing tags on origin — no --tags false rollback', async () => {
    const bareDir = path.join(base, 'origin.git');
    // Seed a pre-existing tag on local + origin so the old `--tags` push would
    // have hit an "already exists" rejection for the whole invocation.
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    spawnSync('git', ['tag', 'v0.0.9'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'v0.0.9'], { cwd: workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    // New tag pushed to origin and resolves to main HEAD
    expect(getTags(bareDir)).toContain('v0.1.1');
    expect(getTagCommit(bareDir, 'v0.1.1')).toBe(getBranchHead(bareDir, 'main'));
    // No rollback — the version bump landed on main
    const mainLog = spawnSync('git', ['log', '--oneline', 'main'], { cwd: workDir, encoding: 'utf8' });
    expect(mainLog.stdout).toContain('chore(release): 0.1.1');
  });

  it('genuine branch-push failure still triggers rollback', async () => {
    const bareDir = path.join(base, 'origin.git');
    // A bare-repo `update` hook rejecting refs/heads/main forces a genuine push failure.
    const hookPath = path.join(bareDir, 'hooks', 'update');
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\nif [ "$1" = "refs/heads/main" ]; then echo "main push rejected by test hook" >&2; exit 1; fi\nexit 0\n'
    );
    fs.chmodSync(hookPath, 0o755);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    // Rollback fired: no local release tag, working tree back on staging
    expect(getTags(workDir)).not.toContain('v0.1.1');
    expect(getCurrentBranch(workDir)).toBe('staging');
  });

  it('gate: proceeds when local main is behind origin/main but fast-forwardable', async () => {
    // Advance origin/main to staging's commit; local main stays behind (ff-able).
    spawnSync('git', ['push', 'origin', 'staging:main'], { cwd: workDir });

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
  });

  it('gate: rejects diverged local main pre-mutation, no chore(release) commit', async () => {
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'local-only.txt'), 'local only\n');
    spawnSync('git', ['add', '.'], { cwd: workDir });
    spawnSync('git', ['commit', '-m', 'local-only commit on main'], { cwd: workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const stagingBefore = getBranchHead(workDir, 'staging');
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
    const stagingLog = spawnSync('git', ['log', '--oneline', 'staging'], { cwd: workDir, encoding: 'utf8' });
    expect(stagingLog.stdout).not.toContain('chore(release)');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: workDir, encoding: 'utf8' });
    expect(status.stdout.trim()).toBe('');
  });

  it('gate: rejects non-ff staging pre-mutation, no chore(release) commit', async () => {
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'divergent.txt'), 'divergent\n');
    spawnSync('git', ['add', '.'], { cwd: workDir });
    spawnSync('git', ['commit', '-m', 'divergent commit on main'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const stagingBefore = getBranchHead(workDir, 'staging');
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
    const stagingLog = spawnSync('git', ['log', '--oneline', 'staging'], { cwd: workDir, encoding: 'utf8' });
    expect(stagingLog.stdout).not.toContain('chore(release)');
  });

  it('gate: rejects when the release tag already exists on origin, pre-mutation', async () => {
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    spawnSync('git', ['tag', 'v0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'v0.1.1'], { cwd: workDir });
    spawnSync('git', ['tag', '-d', 'v0.1.1'], { cwd: workDir }); // drop local — test the origin check
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const stagingBefore = getBranchHead(workDir, 'staging');
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
  });

  it('gate: rejects when the release tag already exists locally, pre-mutation', async () => {
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    spawnSync('git', ['tag', 'v0.1.1'], { cwd: workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const stagingBefore = getBranchHead(workDir, 'staging');
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
  });
});

// --- Telemetry payload enrichment tests ---

describe('runRelease — release.complete telemetry enrichment', () => {
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/git/git-release.mjs'),
    'utf8'
  );

  it('release.complete emit includes sha field', () => {
    expect(src).toMatch(/"release\.complete"[\s\S]*?sha:/);
  });

  it('sha is derived from runGit rev-parse with tag dereference (^{}), not hardcoded', () => {
    expect(src).toContain('rev-parse');
    expect(src).toContain('releaseSha');
    // annotated tag must be dereferenced to get the commit SHA
    expect(src).toContain('^{}');
  });

  it('release.complete emit includes bump field mapped to version param', () => {
    expect(src).toMatch(/release\.complete[\s\S]*?bump:\s*version/);
  });

  it('release.complete emit includes branch field from currentBranch', () => {
    expect(src).toMatch(/release\.complete[\s\S]*?branch:\s*currentBranch/);
  });

  it('existing release.complete fields are preserved: version, tag, durationMs, changelogLines', () => {
    const emitLine = src.match(/collector\.emit\("release\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(emitLine).toContain('version: newVersion');
    expect(emitLine).toContain('tag: `v${newVersion}`');
    expect(emitLine).toContain('durationMs: Date.now() - releaseStartMs');
    expect(emitLine).toContain('changelogLines:');
  });

  it('release.start payload is unchanged (version, bump, branch only)', () => {
    const startEmit = src.match(/collector\.emit\("release\.start"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(startEmit).toContain('version');
    expect(startEmit).toContain('bump');
    expect(startEmit).toContain('branch');
    // should NOT have sha (sha only belongs in complete)
    expect(startEmit).not.toContain('releaseSha');
  });

  it('release.failed payload is unchanged (version, durationMs, error)', () => {
    const failedEmit = src.match(/collector\.emit\("release\.failed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(failedEmit).toContain('version');
    expect(failedEmit).toContain('durationMs');
    expect(failedEmit).toContain('error');
  });

  it('durationMs in release.complete uses releaseStartMs (same reference as release.start)', () => {
    expect(src).toContain('releaseStartMs');
    const completeEmit = src.match(/collector\.emit\("release\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(completeEmit).toContain('releaseStartMs');
  });
});

// --- Single-tag push (release-single-tag-push fix) ---

describe('runRelease — single-tag push (release-single-tag-push fix)', () => {
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/git/git-release.mjs'),
    'utf8'
  );

  it('no longer uses the `git push origin main --tags` form', () => {
    expect(src).not.toContain('"main", "--tags"');
  });

  it('pushes the new release tag as a single ref via tagPushResult', () => {
    expect(src).toContain('tagPushResult');
  });

  it('has the git ls-remote idempotent re-check on a non-zero tag-push exit', () => {
    expect(src).toContain('ls-remote');
    expect(src).toContain('remoteTagSha');
    expect(src).toContain('localTagSha');
  });
});

// --- Late/idempotent bump + complete rollback (release-late-bump-complete-rollback fix) ---

describe('runRelease — late/idempotent bump + complete rollback', () => {
  let base;
  let workDir;

  beforeEach(() => {
    ({ base, workDir } = makeTempRepo());
  });

  afterEach(() => {
    if (base) cleanup(base);
  });

  it('happy path: exactly one chore(release) commit per branch, tag on main HEAD, clean tree', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    // Regression guard for late-bump placement: no duplicate bump commits.
    expect(countSubjectMatches(workDir, 'staging', 'chore(release)')).toBe(1);
    expect(countSubjectMatches(workDir, 'main', 'chore(release)')).toBe(1);
    expect(countSubjectMatches(workDir, 'staging', 'chore(release): 0.1.1')).toBe(1);
    // Tag points at main HEAD.
    expect(getTagCommit(workDir, 'v0.1.1')).toBe(getBranchHead(workDir, 'main'));
    // Working tree clean — no stray uncommitted writes.
    expect(isClean(workDir)).toBe(true);
  });

  it('tag-failure rollback: staging + main return to pre-release SHAs, no orphan bump', async () => {
    // Force `git tag -a` to fail AFTER Story 2's pre-mutation gate passes (the gate
    // rejects a pre-existing tag, so we cannot just pre-create it). Requiring a signed
    // tag against a nonexistent gpg program makes `git tag -a` exit non-zero without
    // the tag ever existing beforehand.
    spawnSync('git', ['config', 'tag.gpgSign', 'true'], { cwd: workDir });
    spawnSync('git', ['config', 'gpg.program', '/nonexistent/gpg-binary'], { cwd: workDir });

    const stagingBefore = getBranchHead(workDir, 'staging');
    const mainBefore = getBranchHead(workDir, 'main');

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tag/i);
    // Staging fully rolled back — no orphaned chore(release) bump commit.
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
    expect(countSubjectMatches(workDir, 'staging', 'chore(release)')).toBe(0);
    // The real feature commit beneath the bump is preserved (guard reset exactly one commit).
    expect(countSubjectMatches(workDir, 'staging', 'feat: add feature')).toBe(1);
    // Main rolled back to pre-merge state.
    expect(getBranchHead(workDir, 'main')).toBe(mainBefore);
    expect(getTags(workDir)).not.toContain('v0.1.1');
    expect(getCurrentBranch(workDir)).toBe('staging');
    expect(isClean(workDir)).toBe(true);
  });

  it('push-failure rollback: staging + main return to pre-release SHAs, local tag deleted, no orphan bump', async () => {
    const bareDir = path.join(base, 'origin.git');
    // A bare-repo `update` hook rejecting refs/heads/main forces a genuine main-push failure.
    const hookPath = path.join(bareDir, 'hooks', 'update');
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\nif [ "$1" = "refs/heads/main" ]; then echo "main push rejected by test hook" >&2; exit 1; fi\nexit 0\n'
    );
    fs.chmodSync(hookPath, 0o755);

    const stagingBefore = getBranchHead(workDir, 'staging');
    const mainBefore = getBranchHead(workDir, 'main');

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    // Staging fully rolled back — no orphaned chore(release) bump commit.
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
    expect(countSubjectMatches(workDir, 'staging', 'chore(release)')).toBe(0);
    expect(countSubjectMatches(workDir, 'staging', 'feat: add feature')).toBe(1);
    // Local release tag deleted, main rolled back, tree clean, back on staging.
    expect(getTags(workDir)).not.toContain('v0.1.1');
    expect(getBranchHead(workDir, 'main')).toBe(mainBefore);
    expect(getCurrentBranch(workDir)).toBe('staging');
    expect(isClean(workDir)).toBe(true);
  });

  it('ff-merge-failure rollback also leaves staging clean (no orphan bump) — regression guard', async () => {
    // Diverge main so the ff-merge fails.
    spawnSync('git', ['checkout', 'main'], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'divergent.txt'), 'divergent\n');
    spawnSync('git', ['add', '.'], { cwd: workDir });
    spawnSync('git', ['commit', '-m', 'divergent commit on main'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: workDir });

    const stagingBefore = getBranchHead(workDir, 'staging');
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(getBranchHead(workDir, 'staging')).toBe(stagingBefore);
    expect(countSubjectMatches(workDir, 'staging', 'chore(release)')).toBe(0);
    expect(isClean(workDir)).toBe(true);
  });

  it('idempotent skip: a pre-existing chore(release) staging HEAD is reused, no second bump commit', async () => {
    // Mimic a prior partial run that already committed the bump. package.json stays at
    // 0.1.0 so newVersion computes to 0.1.1 and the guard's subject check matches.
    // Push it so runRelease's staging-sync pre-check sees origin in sync.
    spawnSync('git', ['commit', '--allow-empty', '-m', 'chore(release): 0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });
    const stagingCommitsBefore = commitCount(workDir, 'staging');

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    // No additional chore(release) commit — the existing one was reused.
    expect(countSubjectMatches(workDir, 'staging', 'chore(release): 0.1.1')).toBe(1);
    // Staging commit count is unchanged by the (skipped) bump step.
    expect(commitCount(workDir, 'staging')).toBe(stagingCommitsBefore);
  });

  it('idempotent skip: no double package.json write and no CHANGELOG re-write', async () => {
    spawnSync('git', ['commit', '--allow-empty', '-m', 'chore(release): 0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });
    const changelogPath = path.join(workDir, 'CHANGELOG.md');
    expect(fs.existsSync(changelogPath)).toBe(false);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    // The skipped bump block performs no fs.writeFileSync — package.json untouched,
    // no CHANGELOG.md created, working tree clean.
    expect(pkgVersion(workDir)).toBe('0.1.0');
    expect(fs.existsSync(changelogPath)).toBe(false);
    expect(isClean(workDir)).toBe(true);
  });
});

// --- Never-blind-reset guard (source assertion) ---

describe('runRelease — guarded staging reset (never blind-reset)', () => {
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/git/git-release.mjs'),
    'utf8'
  );

  it('all three tag/push rollbacks guard the staging HEAD~1 reset with a chore(release) subject check', () => {
    const guard = 'runGit(projectRoot, ["log", "-1", "--format=%s", "HEAD"]) === `chore(release): ${newVersion}`';
    const occurrences = src.split(guard).length - 1;
    // tag-failure rollback + branch-push rollback + tag-push rollback = 3 guarded resets.
    expect(occurrences).toBe(3);
  });

  it('the version bump itself is idempotent — guarded by the integration HEAD subject check', () => {
    expect(src).toContain('const stagingHeadSubject = runGit(projectRoot, ["log", "-1", "--format=%s", branchConfig.integration])');
    expect(src).toContain('if (stagingHeadSubject !== `chore(release): ${newVersion}`)');
  });
});

// --- Resumable / idempotent re-run (release-resumable-rerun fix) ---

describe('runRelease — resumable / idempotent re-run', () => {
  let base;
  let workDir;

  beforeEach(() => {
    ({ base, workDir } = makeTempRepo());
  });

  afterEach(() => {
    if (base) cleanup(base);
  });

  it('Row 1 — release already complete on origin: returns resumed:true and fast-forwards local main', async () => {
    // Prior run finished remotely: bump on staging, origin/main at the bump, tag on origin.
    spawnSync('git', ['commit', '--allow-empty', '-m', 'chore(release): 0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging:main'], { cwd: workDir });
    spawnSync('git', ['tag', '-a', 'v0.1.1', '-m', 'Release 0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'v0.1.1'], { cwd: workDir });
    spawnSync('git', ['tag', '-d', 'v0.1.1'], { cwd: workDir }); // drop local tag — Row 1 must re-fetch it
    const stagingHead = getBranchHead(workDir, 'staging');
    expect(getBranchHead(workDir, 'main')).not.toBe(stagingHead); // local main is behind

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.version).toBe('0.1.1');
    // Local main fast-forwarded to the released commit; tag re-fetched.
    expect(getBranchHead(workDir, 'main')).toBe(stagingHead);
    expect(getTags(workDir)).toContain('v0.1.1');
    // No new bump commit, back on staging.
    expect(countSubjectMatches(workDir, 'staging', 'chore(release)')).toBe(1);
    expect(getCurrentBranch(workDir)).toBe('staging');
  });

  it('Row 2 — bump committed but merge/tag/push incomplete: resumes without re-bumping', async () => {
    // Prior run committed + pushed the bump on staging; merge/tag/push never ran.
    spawnSync('git', ['commit', '--allow-empty', '-m', 'chore(release): 0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });
    const stagingHead = getBranchHead(workDir, 'staging');
    const bumpCountBefore = countSubjectMatches(workDir, 'staging', 'chore(release)');

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.version).toBe('0.1.1');
    // No re-bump.
    expect(countSubjectMatches(workDir, 'staging', 'chore(release)')).toBe(bumpCountBefore);
    // Merge + tag + push completed on origin.
    const bareDir = path.join(base, 'origin.git');
    expect(getTags(bareDir)).toContain('v0.1.1');
    expect(getBranchHead(bareDir, 'main')).toBe(stagingHead);
  });

  it('Row 4 — non-chore(release) staging HEAD: full fresh release, not a resume', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.resumed).toBeUndefined();
    // This run created the bump commit.
    expect(countSubjectMatches(workDir, 'staging', 'chore(release): 0.1.1')).toBe(1);
  });

  it('a resume run never adds a chore(release) commit to staging (commit-count invariant)', async () => {
    spawnSync('git', ['commit', '--allow-empty', '-m', 'chore(release): 0.1.1'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });
    const stagingCommitsBefore = commitCount(workDir, 'staging');

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(commitCount(workDir, 'staging')).toBe(stagingCommitsBefore);
  });

  it('a resume reuses the version from the chore(release) HEAD, not package.json', async () => {
    // staging HEAD says 0.9.9 while package.json still says 0.1.0 — a fresh derive
    // would produce 0.1.1; a resume must reuse 0.9.9.
    spawnSync('git', ['commit', '--allow-empty', '-m', 'chore(release): 0.9.9'], { cwd: workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.version).toBe('0.9.9');
    expect(result.tag).toBe('v0.9.9');
  });
});

// --- Resume telemetry hygiene (source assertion) ---

describe('runRelease — resume telemetry hygiene', () => {
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/git/git-release.mjs'),
    'utf8'
  );

  it('the resumed flag is never placed in a collector.emit telemetry payload', () => {
    const emitCalls = src.match(/collector\.emit\([\s\S]*?\}\)/g) || [];
    expect(emitCalls.length).toBeGreaterThan(0);
    for (const call of emitCalls) {
      expect(call).not.toContain('resumed');
    }
  });
});

// --- Branch-config parameterization (release-parameterize-branch-config fix) ---

// Variant of makeTempRepo whose integration branch is `integrationName` instead of
// `staging` — exercises runRelease under a non-default (3-branch) branch config.
function makeTempRepoWithIntegration(integrationName) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-release-test-'));
  const bareDir = path.join(base, 'origin.git');
  const workDir = path.join(base, 'work');

  spawnSync('git', ['init', '--bare', '--initial-branch', 'main', bareDir]);
  spawnSync('git', ['clone', bareDir, workDir]);
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.0' }, null, 2) + '\n');
  fs.mkdirSync(path.join(workDir, 'notes'), { recursive: true });

  spawnSync('git', ['add', '.'], { cwd: workDir });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: workDir });
  spawnSync('git', ['push', 'origin', 'main'], { cwd: workDir });

  spawnSync('git', ['checkout', '-b', integrationName], { cwd: workDir });
  spawnSync('git', ['push', '-u', 'origin', integrationName], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'feature.txt'), 'new feature\n');
  spawnSync('git', ['add', '.'], { cwd: workDir });
  spawnSync('git', ['commit', '-m', 'feat: add feature'], { cwd: workDir });
  spawnSync('git', ['push', 'origin', integrationName], { cwd: workDir });

  return { base, workDir };
}

describe('runRelease — branch-config parameterization', () => {
  it('default config (no projectRecord/projectJson): resolves to staging/main, happy path unchanged', async () => {
    const { base, workDir } = makeTempRepo();
    try {
      const result = await runRelease({ projectRoot: workDir, version: 'patch' });

      expect(result.ok).toBe(true);
      expect(result.tag).toBe('v0.1.1');
      expect(getTagCommit(workDir, 'v0.1.1')).toBe(getBranchHead(workDir, 'main'));
      const stagingLog = spawnSync('git', ['log', '--oneline', 'staging'], { cwd: workDir, encoding: 'utf8' });
      expect(stagingLog.stdout).toContain('chore(release): 0.1.1');
    } finally {
      cleanup(base);
    }
  });

  it('3-branch config: runRelease operates on the release/main branches', async () => {
    const { base, workDir } = makeTempRepoWithIntegration('release');
    try {
      const projectRecord = { branches: { working: 'dev', integration: 'release', production: 'main' } };
      const result = await runRelease({ projectRoot: workDir, version: 'patch', projectRecord });

      expect(result.ok).toBe(true);
      expect(result.tag).toBe('v0.1.1');
      // Tag on the production branch (main) HEAD; bump present on the integration branch (release).
      expect(getTagCommit(workDir, 'v0.1.1')).toBe(getBranchHead(workDir, 'main'));
      const releaseLog = spawnSync('git', ['log', '--oneline', 'release'], { cwd: workDir, encoding: 'utf8' });
      const mainLog = spawnSync('git', ['log', '--oneline', 'main'], { cwd: workDir, encoding: 'utf8' });
      expect(releaseLog.stdout).toContain('chore(release): 0.1.1');
      expect(mainLog.stdout).toContain('chore(release): 0.1.1');
      // origin/main advanced to the released commit.
      const bareDir = path.join(base, 'origin.git');
      expect(getBranchHead(bareDir, 'main')).toBe(getBranchHead(workDir, 'main'));
    } finally {
      cleanup(base);
    }
  });

  it('3-branch config: rejects when the current branch is not the integration branch', async () => {
    const { base, workDir } = makeTempRepoWithIntegration('release');
    try {
      // Check out a non-integration branch.
      spawnSync('git', ['checkout', 'main'], { cwd: workDir });
      const projectRecord = { branches: { working: 'dev', integration: 'release', production: 'main' } };
      const result = await runRelease({ projectRoot: workDir, version: 'patch', projectRecord });

      expect(result.ok).toBe(false);
      // Rejection names the configured integration branch, not the literal 'staging'.
      expect(result.error).toContain('release');
      expect(result.error).not.toContain('staging');
    } finally {
      cleanup(base);
    }
  });
});

describe('runRelease — branch parameterization (source assertion)', () => {
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/git/git-release.mjs'),
    'utf8'
  );
  const runReleaseSrc = src.slice(
    src.indexOf('export async function runRelease'),
    src.indexOf('export async function runSyncStaging')
  );

  it('runRelease resolves branch names via getBranchConfig', () => {
    expect(runReleaseSrc).toContain('getBranchConfig(projectRecord, projectJson)');
  });

  it('runRelease has no hardcoded "staging" or "main" branch-ref literal', () => {
    expect(runReleaseSrc).not.toContain('"staging"');
    expect(runReleaseSrc).not.toContain('"main"');
  });

  it('the first pre-flight compares currentBranch against branchConfig.integration', () => {
    expect(runReleaseSrc).toContain('currentBranch !== branchConfig.integration');
  });
});

// ---------------------------------------------------------------------------
// backlog.fix.release-commits-story-transitions
//
// Every release since 0.40.0 left its story transitions uncommitted: the phase writes
// ran AFTER the tag and the push, and were never staged. The tree stayed dirty, the
// tagged notes still read `phase: integrated`, and the next release refused with a bare
// "Working tree not clean".
// ---------------------------------------------------------------------------

/** A story note at `phase: integrated`, committed on the integration branch. */
function writeIntegratedStory(dir, id) {
  const file = path.join(dir, 'notes', `${id}.md`);
  fs.writeFileSync(
    file,
    `---\nid: "${id}"\ntitle: "T"\ndesc: "d"\ncreated: 1\nupdated: 2\nphase: "integrated"\n---\n\n## Problem\n\nbody\n`,
  );
  return file;
}

const porcelain = (dir) =>
  spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim();

const showAtRef = (dir, ref, file) => {
  const r = spawnSync('git', ['show', `${ref}:${file}`], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
};

const subjectsOn = (dir, branch) =>
  spawnSync('git', ['log', '--format=%s', branch], { cwd: dir, encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);

describe('release transitions are committed, not stranded', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo();
    writeIntegratedStory(repo.workDir, 'backlog.fix.story-one');
    writeIntegratedStory(repo.workDir, 'backlog.fix.story-two');
    spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
    spawnSync('git', ['commit', '-m', 'docs: two integrated stories'], { cwd: repo.workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: repo.workDir });
  });
  afterEach(() => { cleanup(repo.base); });

  it('AC1 — a successful release leaves a CLEAN working tree', async () => {
    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.releasedStories.sort()).toEqual(['backlog.fix.story-one', 'backlog.fix.story-two']);
    expect(porcelain(repo.workDir)).toBe('');
  });

  it('AC2 — the transitions are reachable FROM THE TAG', async () => {
    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.transitionsInTag).toBe(true);
    for (const id of result.releasedStories) {
      const atTag = showAtRef(repo.workDir, `v${result.version}`, `notes/${id}.md`);
      expect(atTag, `notes/${id}.md must exist at the tag`).toBeTruthy();
      expect(atTag).toMatch(/phase:\s*["']?released["']?/);
      expect(atTag).toMatch(new RegExp(`releasedIn:\\s*["']?${result.version.replace(/\./g, '\\.')}`));
    }
  });

  it('AC1/AC2 — a SECOND release straight after the first is not refused', async () => {
    const first = await runRelease({ projectRoot: repo.workDir, version: 'patch' });
    expect(first.ok).toBe(true);

    writeIntegratedStory(repo.workDir, 'backlog.fix.story-three');
    spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
    spawnSync('git', ['commit', '-m', 'docs: another integrated story'], { cwd: repo.workDir });

    const second = await runRelease({ projectRoot: repo.workDir, version: 'patch' });
    expect(second.ok).toBe(true);
    expect(second.releasedStories).toEqual(['backlog.fix.story-three']);
    expect(porcelain(repo.workDir)).toBe('');
  });

  it('AC4 — a failure after the transitions rolls them back and leaves a clean tree', async () => {
    // Diverge main so the ff-merge fails AFTER the bump commit has been made.
    spawnSync('git', ['checkout', 'main'], { cwd: repo.workDir });
    fs.writeFileSync(path.join(repo.workDir, 'divergent.txt'), 'x\n');
    spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
    spawnSync('git', ['commit', '-m', 'chore: divergent main commit'], { cwd: repo.workDir });
    spawnSync('git', ['checkout', 'staging'], { cwd: repo.workDir });

    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(porcelain(repo.workDir)).toBe('');
    for (const id of ['backlog.fix.story-one', 'backlog.fix.story-two']) {
      const content = fs.readFileSync(path.join(repo.workDir, 'notes', `${id}.md`), 'utf8');
      expect(content).toMatch(/phase:\s*["']?integrated["']?/);
      expect(content).not.toMatch(/releasedIn:/);
    }
  });

  it('AC5 — an early return transitions NOTHING and leaves the repo byte-identical', async () => {
    // Not on the integration branch: the earliest refusal there is.
    spawnSync('git', ['checkout', 'main'], { cwd: repo.workDir });
    const headBefore = getBranchHead(repo.workDir, 'staging');

    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(porcelain(repo.workDir)).toBe('');
    expect(getBranchHead(repo.workDir, 'staging')).toBe(headBefore);
    // Read from the staging REF: this case deliberately stands on main, where these notes
    // do not exist in the worktree at all.
    for (const id of ['backlog.fix.story-one', 'backlog.fix.story-two']) {
      const onStaging = showAtRef(repo.workDir, 'staging', `notes/${id}.md`);
      expect(onStaging, `notes/${id}.md must exist on staging`).toBeTruthy();
      expect(onStaging).toMatch(/phase:\s*["']?integrated["']?/);
      expect(onStaging).not.toMatch(/releasedIn:/);
    }
  });

  it('AC8 — releasedStories lists only ids whose transitions were committed', async () => {
    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    for (const id of result.releasedStories) {
      // Committed means: present at the tag with the released phase. Worktree-only would fail.
      expect(showAtRef(repo.workDir, `v${result.version}`, `notes/${id}.md`))
        .toMatch(/phase:\s*["']?released["']?/);
    }
  });

  it('AC10 — no subject this release writes is readable as a bump commit', async () => {
    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });
    expect(result.ok).toBe(true);

    const bumps = subjectsOn(repo.workDir, 'staging').filter((s) => isReleaseBumpSubject(s));
    // Exactly one: the bump itself. Any transition commit subject must be rejected.
    expect(bumps).toEqual([`chore(release): ${result.version}`]);
  });
});

describe('a dirty tree of stranded transitions is NAMED, never swept up', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo();
    writeIntegratedStory(repo.workDir, 'backlog.fix.story-one');
    spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
    spawnSync('git', ['commit', '-m', 'docs: one integrated story'], { cwd: repo.workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: repo.workDir });
  });
  afterEach(() => { cleanup(repo.base); });

  /** Exactly the residue an old release left: phase flipped, releasedIn stamped, uncommitted. */
  function strandTransition(id, version = '0.1.0') {
    const file = path.join(repo.workDir, 'notes', `${id}.md`);
    const content = fs.readFileSync(file, 'utf8')
      .replace(/phase: "integrated"/, 'phase: "released"')
      .replace(/^updated: 2$/m, `updated: 2\nreleasedIn: "${version}"`);
    fs.writeFileSync(file, content);
  }

  it('AC6 — refuses with a distinct reason naming the stranded notes', async () => {
    strandTransition('backlog.fix.story-one');

    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stranded_release_transitions');
    expect(result.strandedNotes).toEqual(['notes/backlog.fix.story-one.md']);
    expect(result.error).toMatch(/retry rks_release/);
  });

  it('AC6 — it REFUSES rather than committing them', async () => {
    strandTransition('backlog.fix.story-one');
    const headBefore = getBranchHead(repo.workDir, 'staging');

    await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    // Still dirty, still uncommitted: the refusal repaired nothing.
    expect(porcelain(repo.workDir)).not.toBe('');
    expect(getBranchHead(repo.workDir, 'staging')).toBe(headBefore);
  });

  it('AC6 — an unrelated dirty file still gets the generic refusal', async () => {
    strandTransition('backlog.fix.story-one');
    fs.writeFileSync(path.join(repo.workDir, 'unrelated.txt'), 'not a transition\n');

    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.error).toBe('Working tree not clean');
  });

  it('a note modified in any OTHER way is not classified as a transition', async () => {
    const file = path.join(repo.workDir, 'notes', 'backlog.fix.story-one.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\nan edit that is not a transition\n');

    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.error).toBe('Working tree not clean');
  });
});

describe('AC9 — the resume detector admits only an exact bump subject', () => {
  // The two verbatim subjects of the rescue commits in this repository's own history.
  const RESCUE_SUBJECTS = [
    'chore(release): record v0.52.0 story phase transitions left uncommitted by rks_release',
    'chore(release): chore(release): record v0.52.1 story phase transition left uncommitted by rks_release',
  ];

  it('rejects both rescue-commit subjects, and accepts a real bump', () => {
    for (const subject of RESCUE_SUBJECTS) {
      expect(isReleaseBumpSubject(subject), subject).toBeNull();
    }
    expect(isReleaseBumpSubject('chore(release): 0.52.1')).toBe('0.52.1');
    expect(isReleaseBumpSubject('chore(release): 1.0.0')).toBe('1.0.0');
    // Not a version: the old `(.+)` capture admitted all of these.
    expect(isReleaseBumpSubject('chore(release): v0.52.1')).toBeNull();
    expect(isReleaseBumpSubject('chore(release): 0.52')).toBeNull();
    expect(isReleaseBumpSubject('chore(story): 0.52.1')).toBeNull();
    expect(isReleaseBumpSubject(undefined)).toBeNull();
  });

  it.each(RESCUE_SUBJECTS)('with %s at HEAD, runRelease takes the FRESH path', async (subject) => {
    const repo = makeTempRepo();
    try {
      writeIntegratedStory(repo.workDir, 'backlog.fix.story-one');
      spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
      spawnSync('git', ['commit', '-m', subject], { cwd: repo.workDir });
      spawnSync('git', ['push', 'origin', 'staging'], { cwd: repo.workDir });
      const fixtureSha = getBranchHead(repo.workDir, 'staging');

      const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

      expect(result.ok).toBe(true);
      // Fresh: the version came from package.json (0.1.0 → 0.1.1), not from the subject.
      expect(result.version).toBe('0.1.1');
      expect(result.resumed).toBeUndefined();
      // The fixture commit is still on the branch — the guarded rollback never ate it.
      expect(subjectsOn(repo.workDir, 'staging')).toContain(subject);
      expect(getTagCommit(repo.workDir, 'v0.1.1')).toBeTruthy();
      expect(spawnSync('git', ['cat-file', '-e', fixtureSha], { cwd: repo.workDir }).status).toBe(0);
    } finally {
      cleanup(repo.base);
    }
  }, 60000);
});

describe('AC7 — the resume paths commit their transitions too', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo();
    writeIntegratedStory(repo.workDir, 'backlog.fix.resume-story');
    spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
    spawnSync('git', ['commit', '-m', 'docs: one integrated story'], { cwd: repo.workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: repo.workDir });
  });
  afterEach(() => { cleanup(repo.base); });

  it('the fall-through resume commits them, pushes them, and reports their tag-reachability', async () => {
    // An interrupted release: the bump commit exists on the integration branch, but no tag
    // and no merge. That is the state the resume fall-through is for.
    fs.writeFileSync(
      path.join(repo.workDir, 'package.json'),
      JSON.stringify({ name: 'test', version: '0.1.1' }, null, 2) + '\n',
    );
    spawnSync('git', ['add', '-A'], { cwd: repo.workDir });
    spawnSync('git', ['commit', '-m', 'chore(release): 0.1.1'], { cwd: repo.workDir });
    spawnSync('git', ['push', 'origin', 'staging'], { cwd: repo.workDir });

    const result = await runRelease({ projectRoot: repo.workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.1.1');
    expect(result.releasedStories).toEqual(['backlog.fix.resume-story']);
    // They could not join the bump commit, but their own commit still lands before the
    // ff-merge and the tag, so the marker reports them as tag-reachable. Row 1, which
    // returns before those steps, is the path that reports false.
    expect(result.transitionsInTag).toBe(true);
    expect(porcelain(repo.workDir)).toBe('');

    // Committed on the integration branch, with a subject no later run can mistake for a bump.
    const subjects = subjectsOn(repo.workDir, 'staging');
    const transitionSubject = subjects.find((s) => s.startsWith('chore(story): mark'));
    expect(transitionSubject).toBeTruthy();
    expect(isReleaseBumpSubject(transitionSubject)).toBeNull();

    // And it reached origin: the later integration-branch push carries it.
    expect(subjectsOn(repo.workDir, 'origin/staging')).toContain(transitionSubject);

    // And the tag carries the transition, which is what transitionsInTag: true asserts.
    const atTag = showAtRef(repo.workDir, 'v0.1.1', 'notes/backlog.fix.resume-story.md');
    expect(atTag).toMatch(/phase:\s*["']?released["']?/);
  }, 60000);
});
