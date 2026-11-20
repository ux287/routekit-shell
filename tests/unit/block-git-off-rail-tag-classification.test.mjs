/**
 * block-git-during-off-rail: argument-aware git tag classification.
 *
 * Read-only git tag forms (list / inspect / verify) must pass during off-rail; creation and
 * deletion must still route to rks_guardrails_on. The fail-closed branch keys on
 * WRITE_SUBCOMMANDS and must keep denying every git tag form conservatively.
 *
 * Runs the CANONICAL hook (packages/hooks/system/...) directly so the result does not depend on
 * whether the deployed copy currently sits in .routekit/hooks/ or .routekit/hooks.bak/.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../helpers/tmp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK_REL = 'system/block-git-during-off-rail.mjs';
const CANONICAL_HOOK = path.join(REPO_ROOT, 'packages/hooks', HOOK_REL);
const TEMPLATE_HOOK = path.join(REPO_ROOT, 'templates/generic/.routekit/hooks', HOOK_REL);
const DEPLOYED_CANDIDATES = [
  path.join(REPO_ROOT, '.routekit/hooks', HOOK_REL),
  path.join(REPO_ROOT, '.routekit/hooks.bak', HOOK_REL),
];

const READ_ONLY_TAG_FORMS = [
  'git tag',
  'git tag -l',
  "git tag --list 'v*'",
  'git tag --contains abc1234',
  'git tag --no-contains abc1234',
  'git tag --points-at HEAD',
  'git tag -n',
  'git tag -n5',
  'git tag --merged',
  'git tag --no-merged',
  'git tag --sort=-creatordate',
  "git tag --format='%(refname)'",
  'git tag -v v1',
];

const MUTATING_TAG_FORMS = [
  'git tag v1.0.0',
  'git tag v1.0.0 abc1234',
  'git tag -a v1 -m msg',
  'git tag -s v1',
  'git tag -f v1',
  'git tag -d v1',
  'git tag --delete v1',
];

/** Spawn a hook copy against one Bash command. offRail creates .routekit/hooks.bak in projectDir. */
function runHook(hookPath, command, projectDir, { offRail }) {
  if (offRail) fs.mkdirSync(path.join(projectDir, '.routekit', 'hooks.bak'), { recursive: true });
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, RKS_GUARDRAILS: '' },
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  let output = null;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    output = null;
  }
  const hso = output?.hookSpecificOutput || {};
  const context = hso.additionalContext || '';
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    decision: hso.permissionDecision,
    reason: hso.permissionDecisionReason || '',
    routedAgent: (context.match(/^\s*agent:\s*(\S+)/m) || [])[1] || null,
  };
}

describe('block-git-during-off-rail git tag classification', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTempDir('block-git-tag');
  });

  it('read-only git tag forms pass during off-rail', () => {
    for (const cmd of READ_ONLY_TAG_FORMS) {
      const r = runHook(CANONICAL_HOOK, cmd, projectDir, { offRail: true });
      expect(r.exitCode, cmd).toBe(0);
      expect(r.stdout.trim(), cmd).toBe('');
    }
  });

  it('mutating git tag forms still redirect to rks_guardrails_on', () => {
    for (const cmd of MUTATING_TAG_FORMS) {
      const r = runHook(CANONICAL_HOOK, cmd, projectDir, { offRail: true });
      expect(r.exitCode, cmd).toBe(0);
      expect(r.decision, cmd).toBe('deny');
      expect(r.routedAgent, cmd).toBe('mcp__rks__rks_guardrails_on');
      expect(r.reason, cmd).toContain("Looks like you're done with your changes");
      expect(r.reason, cmd).toContain('(git tag detected)');
    }
  });

  it('a chained read-only tag plus commit still redirects for the commit', () => {
    const r = runHook(CANONICAL_HOOK, 'git tag -l && git commit -m x', projectDir, { offRail: true });
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBe('deny');
    expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_on');
    expect(r.reason).toContain('(git commit detected)');
  });

  it('fail-closed load still denies every git tag form', () => {
    // The hook copied alone: system/hook-output.mjs and lib/protected-rks-paths.mjs cannot load.
    const hooksRoot = makeTempDir('block-git-tag-failclosed');
    fs.mkdirSync(path.join(hooksRoot, 'system'), { recursive: true });
    const isolatedHook = path.join(hooksRoot, HOOK_REL);
    fs.copyFileSync(CANONICAL_HOOK, isolatedHook);
    for (const cmd of [...READ_ONLY_TAG_FORMS, ...MUTATING_TAG_FORMS]) {
      const r = runHook(isolatedHook, cmd, projectDir, { offRail: true });
      expect(r.exitCode, cmd).toBe(0);
      expect(r.decision, cmd).toBe('deny');
    }
  });

  it('without an off-rail session every git tag form is silent', () => {
    for (const cmd of [...READ_ONLY_TAG_FORMS, ...MUTATING_TAG_FORMS]) {
      const r = runHook(CANONICAL_HOOK, cmd, projectDir, { offRail: false });
      expect(r.exitCode, cmd).toBe(0);
      expect(r.stdout.trim(), cmd).toBe('');
    }
  });

  it('documents the git tag classification in the hook source', () => {
    const src = fs.readFileSync(CANONICAL_HOOK, 'utf8');
    expect(src).toMatch(/git tag classification/i);
  });

  it('canonical, deployed and template copies are byte-identical', () => {
    const deployed = DEPLOYED_CANDIDATES.find((p) => fs.existsSync(p));
    expect(deployed, 'deployed copy in .routekit/hooks or .routekit/hooks.bak').toBeTruthy();
    const canonical = fs.readFileSync(CANONICAL_HOOK);
    expect(fs.readFileSync(deployed).equals(canonical)).toBe(true);
    expect(fs.readFileSync(TEMPLATE_HOOK).equals(canonical)).toBe(true);
  });
});
