/**
 * Tests for version-tag branch guard in runGitTag().
 * Version tags (v followed by digit) must be created on the production branch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempRepo(initialBranch = 'main') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-tag-guard-'));
  spawnSync('git', ['init', '--initial-branch', initialBranch], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'init.txt'), 'init\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: dir });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function getTags(dir) {
  const result = spawnSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' });
  return result.stdout.trim().split('\n').filter(Boolean);
}

describe('runGitTag branch guard', () => {
  let tempDir;
  let runGitTag;

  beforeEach(async () => {
    tempDir = makeTempRepo('main');
    const mod = await import('../../packages/mcp-rks/src/server/git/git-core.mjs');
    runGitTag = mod.runGitTag;
  });

  afterEach(() => {
    if (tempDir) cleanup(tempDir);
  });

  it('version tag on production branch succeeds', async () => {
    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v1.0.0',
      message: 'Release 1.0.0',
      productionBranch: 'main'
    });
    expect(result.ok).toBe(true);
    expect(result.tag).toBe('v1.0.0');
    expect(getTags(tempDir)).toContain('v1.0.0');
  });

  it('version tag on non-production branch returns error with branch names', async () => {
    // Create and checkout a non-production branch
    spawnSync('git', ['checkout', '-b', 'staging'], { cwd: tempDir });

    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v1.0.0',
      productionBranch: 'main'
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('main');
    expect(result.error).toContain('staging');
    expect(getTags(tempDir)).not.toContain('v1.0.0');
  });

  it('non-version tag on non-production branch succeeds', async () => {
    spawnSync('git', ['checkout', '-b', 'staging'], { cwd: tempDir });

    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'build-123',
      productionBranch: 'main'
    });
    expect(result.ok).toBe(true);
    expect(result.tag).toBe('build-123');
  });

  it('version tag with explicit commit arg on wrong branch still blocked', async () => {
    const commitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['checkout', '-b', 'staging'], { cwd: tempDir });

    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v2.0.0',
      commit: commitSha,
      productionBranch: 'main'
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('main');
  });

  it('annotated version tag on production branch succeeds', async () => {
    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v0.19.5',
      message: 'Release 0.19.5',
      productionBranch: 'main'
    });
    expect(result.ok).toBe(true);
    expect(result.annotated).toBe(true);
    expect(getTags(tempDir)).toContain('v0.19.5');
  });

  it('production branch read from config, not hardcoded', async () => {
    // Use a custom production branch name
    spawnSync('git', ['checkout', '-b', 'release'], { cwd: tempDir });

    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v3.0.0',
      productionBranch: 'release'
    });
    expect(result.ok).toBe(true);
    expect(result.tag).toBe('v3.0.0');
  });

  it('error message includes both expected and actual branch names', async () => {
    spawnSync('git', ['checkout', '-b', 'feature-x'], { cwd: tempDir });

    const result = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v1.0.0',
      productionBranch: 'main'
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('main');
    expect(result.error).toContain('feature-x');
  });

  it('list and delete actions unaffected by guard', async () => {
    // Create a tag first (on main, so it works)
    await runGitTag({ projectRoot: tempDir, action: 'create', name: 'v1.0.0', productionBranch: 'main' });

    // Switch to staging
    spawnSync('git', ['checkout', '-b', 'staging'], { cwd: tempDir });

    // List should work from any branch
    const listResult = await runGitTag({ projectRoot: tempDir, action: 'list' });
    expect(listResult.ok).toBe(true);
    expect(listResult.tags).toContain('v1.0.0');

    // Delete should work from any branch
    const deleteResult = await runGitTag({ projectRoot: tempDir, action: 'delete', name: 'v1.0.0' });
    expect(deleteResult.ok).toBe(true);
  });

  it('pattern matches v+digit but not arbitrary v-prefixed names', async () => {
    spawnSync('git', ['checkout', '-b', 'staging'], { cwd: tempDir });

    // vendor-fix should NOT be blocked (not v+digit)
    const vendorResult = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'vendor-fix',
      productionBranch: 'main'
    });
    expect(vendorResult.ok).toBe(true);

    // v1.0.0 SHOULD be blocked
    const versionResult = await runGitTag({
      projectRoot: tempDir,
      action: 'create',
      name: 'v1.0.0',
      productionBranch: 'main'
    });
    expect(versionResult.ok).toBe(false);
  });
});
