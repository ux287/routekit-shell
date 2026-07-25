/**
 * 3-branch auto-ship dispatch in guardrailsOn().
 *
 * When a project has branches.working !== branches.integration, the auto-ship
 * inside guardrailsOn() must do a local merge into the working branch and skip
 * push/PR/merge/cycle_complete. Promote and release are explicit, human-led
 * steps in 3-branch mode.
 *
 * (backlog.feat.guardrails-on-three-branch-aware)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const runGitPRMock = vi.fn().mockResolvedValue({ ok: true, url: 'https://github.com/test/pr/1', number: 1 });
const runStagingMergeMock = vi.fn().mockResolvedValue({ ok: true });
const runCycleCompleteMock = vi.fn().mockResolvedValue({ ok: true, branch: 'staging' });

vi.mock('../../packages/mcp-rks/src/server/git-tools.mjs', () => ({
  runGitPR: runGitPRMock,
  runStagingMerge: runStagingMergeMock,
  runCycleComplete: runCycleCompleteMock,
}));

vi.mock('../../packages/mcp-rks/src/shared/commit-and-embed.mjs', () => ({
  commitAndEmbed: vi.fn().mockResolvedValue({ commitId: 'mockcommit123', ragEmbedWarning: null }),
}));

const { guardrailsOff, guardrailsOn } = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');

const guardrailsSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8'
);

function makeProject({ branches } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-3branch-test-'));

  const hooksDir = path.join(dir, '.routekit', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'enforce-plan-scope.mjs'), '// hook');
  fs.writeFileSync(path.join(hooksDir, 'enforce-read-provenance.mjs'), '// hook');

  fs.writeFileSync(
    path.join(dir, '.routekit', 'hooks-manifest.json'),
    JSON.stringify({
      'enforce-plan-scope': { tier: 'write' },
      'enforce-read-provenance': { tier: 'read' },
    }, null, 2)
  );

  fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
  if (branches) {
    fs.writeFileSync(
      path.join(dir, '.rks', 'project.json'),
      JSON.stringify({ branches, frameworkProject: true }, null, 2)
    );
  }

  // Initialize git repo
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  };
  execSync('git init -b staging', { cwd: dir, stdio: 'ignore', env: gitEnv });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore', env: gitEnv });
  execSync('git config user.name "test"', { cwd: dir, stdio: 'ignore', env: gitEnv });
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore', env: gitEnv });

  // Write an arch-approved story note so the phase gate passes.
  const problemId = 'test-3branch-story';
  const notesDir = path.join(dir, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, `${problemId}.md`), [
    '---',
    `id: "${problemId}"`,
    'title: "3-branch test story"',
    'phase: "arch-approved"',
    'targetFiles: []',
    '---',
    '',
  ].join('\n'));

  // For 3-branch: create dev branch and check it out (working branch)
  if (branches && branches.working && branches.working !== branches.integration) {
    execSync(`git checkout -b ${branches.working}`, { cwd: dir, stdio: 'ignore', env: gitEnv });
  }

  return { dir, gitEnv, problemId };
}

function makeChangeAndStage(dir) {
  fs.writeFileSync(path.join(dir, 'work.txt'), 'off-rail change\n');
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('guardrailsOn 3-branch auto-ship', () => {
  let projectRoot;
  let gitEnv;

  beforeEach(() => {
    runGitPRMock.mockClear();
    runStagingMergeMock.mockClear();
    runCycleCompleteMock.mockClear();
  });

  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
    projectRoot = undefined;
  });

  it('skips push/PR/merge/cycle_complete and does local merge into working branch when working !== integration', async () => {
    let problemId;
    ({ dir: projectRoot, gitEnv, problemId } = makeProject({
      branches: { working: 'dev', integration: 'staging', production: 'main' },
    }));

    await guardrailsOff(projectRoot, 'test-3branch', 'all', problemId);
    makeChangeAndStage(projectRoot);

    const result = await guardrailsOn(projectRoot);

    expect(result.autoShipped).toBe(true);
    expect(result.localOnly).toBe(true);
    expect(result.shipSteps).toBeDefined();

    const stepNames = result.shipSteps.map(s => s.step);
    expect(stepNames).toContain('local_merge');

    const localMergeStep = result.shipSteps.find(s => s.step === 'local_merge');
    expect(localMergeStep.ok).toBe(true);
    expect(localMergeStep.from).toMatch(/^off-rail\//);
    expect(localMergeStep.to).toBe('dev');

    const skippedSteps = result.shipSteps.filter(s => s.skipped === true);
    const skippedNames = skippedSteps.map(s => s.step);
    expect(skippedNames).toContain('working_pr');
    expect(skippedNames).toContain('working_merge');
    expect(skippedNames).toContain('cycle_complete');
    for (const s of skippedSteps) {
      expect(s.reason).toBe('three_branch_local_only');
    }

    // No PR/merge/cycle calls should have been issued
    expect(runGitPRMock).not.toHaveBeenCalled();
    expect(runStagingMergeMock).not.toHaveBeenCalled();
    expect(runCycleCompleteMock).not.toHaveBeenCalled();
  }, 30000);

  it('off-rail branch is deleted after local merge in 3-branch mode', async () => {
    let problemId;
    ({ dir: projectRoot, gitEnv, problemId } = makeProject({
      branches: { working: 'dev', integration: 'staging', production: 'main' },
    }));

    await guardrailsOff(projectRoot, 'test-3branch', 'all', problemId);
    makeChangeAndStage(projectRoot);

    const result = await guardrailsOn(projectRoot);
    expect(result.autoShipped).toBe(true);

    const offRailBranch = result.shipSteps.find(s => s.step === 'commit')?.branch;
    expect(offRailBranch).toMatch(/^off-rail\//);

    // The off-rail branch should be deleted after local merge
    const branches = execSync('git branch', { cwd: projectRoot, encoding: 'utf8', env: gitEnv });
    expect(branches).not.toContain(offRailBranch);
    expect(branches).toContain('dev');
  }, 30000);

  it('falls back to existing 2-branch dispatch when project.json has no branches field (regression preservation)', () => {
    // Static-analysis assertion: source contains the dispatch on isThreeBranch
    // and the 2-branch path uses localMerge + branch -D + push origin directly
    // (runGitPR and runStagingMerge were removed in PR #1068).
    // (Behavioral 2-branch coverage lives in tests/unit/guardrails-audit.spec.mjs.)
    expect(guardrailsSrc).toMatch(/const\s+isThreeBranch\s*=\s*branchConfig\.working\s*!==\s*branchConfig\.integration/);
    expect(guardrailsSrc).toMatch(/if\s*\(\s*isThreeBranch\s*\)\s*\{[\s\S]*localMerge\s*\(/);
    expect(guardrailsSrc).toMatch(/}\s*else\s*\{[\s\S]*localMerge[\s\S]*branch.*-D[\s\S]*push.*origin/);
  });

  it('source uses getBranchConfig from project.mjs to determine topology', () => {
    expect(guardrailsSrc).toMatch(/import\s*\{[^}]*\bgetBranchConfig\b[^}]*\}\s*from\s*['"]\.\/project\.mjs['"]/);
    expect(guardrailsSrc).toMatch(/const\s+branchConfig\s*=\s*getBranchConfig\s*\(/);
  });

  it('3-branch unpushed-commits path stays local instead of pushing to remote', () => {
    // When changes were committed during the session (no staged changes left
    // at guardrailsOn time but commits ahead of origin), 3-branch must NOT push.
    // Static-analysis assertion: the aheadCount block checks isThreeBranch and
    // short-circuits with localOnly:true before reaching the push call.
    const idxAhead = guardrailsSrc.indexOf('if (aheadCount > 0)');
    expect(idxAhead).toBeGreaterThan(-1);
    const idxPush = guardrailsSrc.indexOf('git", ["push", "origin", gitState.branch]', idxAhead);
    expect(idxPush).toBeGreaterThan(-1);
    const aheadBlock = guardrailsSrc.slice(idxAhead, idxPush);
    expect(aheadBlock).toContain('isThreeBranch');
    expect(aheadBlock).toMatch(/localOnly\s*=\s*true/);
    expect(aheadBlock).toMatch(/return\s+response/);
  });
});
