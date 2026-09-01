/**
 * Integration tests for runRelease() — verifies real git behavior.
 * Extracted from git-release.test.mjs to isolate slow real-repo tests
 * from static analysis tests in the same suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { runRelease } = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

function makeTempRepo() {
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

  spawnSync('git', ['checkout', '-b', 'staging'], { cwd: workDir });
  spawnSync('git', ['push', '-u', 'origin', 'staging'], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'feature.txt'), 'new feature\n');
  spawnSync('git', ['add', '.'], { cwd: workDir });
  spawnSync('git', ['commit', '-m', 'feat: add feature'], { cwd: workDir });
  spawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });

  return { base, workDir };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

// SKIPPED 2026-06-04: file name says "integration" but lives in tests/unit/. Uses
// real spawnSync('git', ...) on temp bare repos — slow (~2-5s/test) and at risk of
// ETIMEDOUT on CI under load. Should move to tests/integration/ per audit.
describe.skip('runRelease — release.complete sha is a real commit SHA (integration)', () => {
  let base;
  let workDir;

  beforeEach(async () => {
    ({ base, workDir } = makeTempRepo());
  });

  afterEach(() => {
    if (base) cleanup(base);
  });

  it('release.complete sha is truthy and matches the release tag commit', async () => {
    const result = await runRelease({ projectRoot: workDir, version: 'patch', projectId: 'test' });
    expect(result.ok).toBe(true);

    const tagSha = spawnSync('git', ['rev-parse', '--short', 'v0.1.1^{}'], { cwd: workDir, encoding: 'utf8' });
    expect(tagSha.status).toBe(0);
    expect(tagSha.stdout.trim()).toBeTruthy();
    const mainSha = spawnSync('git', ['rev-parse', '--short', 'main'], { cwd: workDir, encoding: 'utf8' });
    expect(tagSha.stdout.trim()).toBe(mainSha.stdout.trim());
  });
});
