/**
 * backlog.fix.ship-delivery-implemented-twice
 *
 * ONE delivery implementation, ONE topology predicate, called by both ship entry points.
 *
 * Modelled on tests/unit/local-merge-shared-import.spec.mjs, which already asserts this
 * shape for `localMerge`. The defect this guards against is not that the two rails
 * DISAGREED — it is that there were TWO of them. `guardrails-on-no-feature-branch-push`
 * corrected one implementation on 2026-05-07, scoped itself to a single file, and the
 * other drifted unnoticed for 85 commits because nothing exercised it. Structural
 * assertions are the only kind that fail when a future story re-introduces a second copy.
 *
 * The behavioural half (AC 13) exercises the REAL deliverFeatureBranch with child_process
 * mocked, because the fail-closed guard cannot be observed from source text alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Both specifiers are mocked: branch-delivery.mjs imports "node:child_process" while
// git/local-merge.mjs imports the unprefixed "child_process". Vitest keys mocks on the
// resolved module id, so a single mock would leave the other path live — and clause (c)
// asserts that NOTHING spawns before the guard, which needs both observed.
const spawnSyncPrefixed = vi.fn();
const spawnSyncBare = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...a) => spawnSyncPrefixed(...a) }));
vi.mock('child_process', () => ({ spawnSync: (...a) => spawnSyncBare(...a) }));

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

/**
 * Strip comments so an assertion about CODE cannot be satisfied — or defeated — by prose.
 *
 * This matters concretely here. The rail-agnostic assertions below are negatives, and
 * branch-delivery.mjs's own header documents what it does NOT do ("no allowedFiles or
 * scope reconciliation", "a `const target = branchConfig.working;` here would…"). A
 * source-text negative reads those descriptions as occurrences and reddens a correct
 * module — the same comment-vs-code confusion that made pr-body-cost-report.test.mjs a
 * false witness, in the opposite direction.
 */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const moduleSrc = read('packages/mcp-rks/src/server/git/branch-delivery.mjs');
const storyShipSrc = read('packages/mcp-rks/src/server/story-ship.mjs');
const guardrailsSrc = read('packages/mcp-rks/src/server/guardrails-audit.mjs');
const projectSrc = read('packages/mcp-rks/src/server/project.mjs');
const gitShipSrc = read('packages/mcp-rks/src/server/git/git-ship.mjs');

describe('ship delivery — a single shared implementation', () => {
  it('branch-delivery.mjs exports the predicate and the delivery', () => {
    expect(moduleSrc).toMatch(/export\s+function\s+isThreeBranchTopology\s*\(/);
    expect(moduleSrc).toMatch(/export\s+function\s+deliverFeatureBranch\s*\(/);
  });

  it('all four topology sites obtain the answer from the shared predicate', () => {
    for (const src of [storyShipSrc, guardrailsSrc, projectSrc, gitShipSrc]) {
      expect(src).toMatch(/\bisThreeBranchTopology\s*\(/);
    }
  });

  it('no ship-delivery or workflow-config site recomputes the predicate inline', () => {
    // The four sites this story scopes. Other occurrences of the same literal exist
    // elsewhere in packages/mcp-rks/src (server.mjs, branch-protection.mjs, the
    // autoMergeIntegration promotion) and are deliberately OUT of scope — asserting
    // repo-wide absence would be unachievable, which is why this is per-site.
    expect(guardrailsSrc).not.toMatch(/const\s+isThreeBranch\s*=\s*branchConfig\.working\s*!==\s*branchConfig\.integration/);
    expect(projectSrc).not.toMatch(/const\s+isThreeBranch\s*=\s*branchConfig\.working\s*!==\s*branchConfig\.integration/);
    expect(storyShipSrc).not.toMatch(/let\s+workingBranchIsLocal\s*=\s*working\s*!==\s*integration/);
    expect(gitShipSrc).not.toMatch(/let\s+workingBranchLocal\s*=\s*workflowConfig\.workingBranchLocal\s*\|\|\s*\(\s*working\s*!==\s*integration\s*\)/);
  });

  it('the NON-topology disjuncts at the two impure sites survive', () => {
    // git-ship.mjs and story-ship.mjs each widen the answer beyond topology. Replacing
    // the whole expression with the shared predicate would be a behaviour change, not a
    // refactor, so only the parenthesised comparison moved.
    expect(gitShipSrc).toMatch(/workflowConfig\.workingBranchLocal\s*\|\|/);
    expect(gitShipSrc).toMatch(/workingBranchLocal\s*=\s*true;/);
    expect(storyShipSrc).toMatch(/workingBranchIsLocal\s*=\s*true;/);
  });

  it('both rails delegate delivery to the shared module', () => {
    expect(storyShipSrc).toMatch(/import\s*\{[^}]*\bdeliverFeatureBranch\b[^}]*\}\s*from\s*['"]\.\/git\/branch-delivery\.mjs['"]/);
    expect(guardrailsSrc).toMatch(/import\s*\{[^}]*\bdeliverFeatureBranch\b[^}]*\}\s*from\s*['"]\.\/git\/branch-delivery\.mjs['"]/);
    expect(storyShipSrc).toMatch(/deliverFeatureBranch\(\{/);
    expect(guardrailsSrc).toMatch(/deliverFeatureBranch\(\{/);
  });

  it('the shared module is rail-agnostic — no session, scope, phase or rail telemetry', () => {
    const code = codeOnly(moduleSrc);
    expect(code).not.toMatch(/collector\.emit/);
    expect(code).not.toMatch(/story_ship\./);
    expect(code).not.toMatch(/guardrails\./);
    expect(code).not.toMatch(/allowedFiles/);
    expect(code).not.toMatch(/_governorToken/);
    expect(code).not.toMatch(/advancePhase|advance_phase/);
    // Cost reporting is a per-rail REPORTING concern and must not leak in here either.
    expect(code).not.toMatch(/generateCostReport/);
  });

  it('the module never reads branchConfig.working as its delivery target', () => {
    // The target is CALLER-SUPPLIED. A `branchConfig.working` default would silently
    // retarget off-rail, which merges into the branch the operator was actually on —
    // FINDING A, option (i). Asserted against code only, because the module's own header
    // quotes the forbidden line while explaining why it is forbidden.
    const code = codeOnly(moduleSrc);
    expect(code).not.toMatch(/\btarget\s*=\s*branchConfig\.working/);
    expect(code).toMatch(/deliverFeatureBranch\(\{[^}]*\btarget\b/);
  });
});

describe('deliverFeatureBranch — fail-closed on a missing target (AC 13)', () => {
  beforeEach(() => {
    spawnSyncPrefixed.mockReset();
    spawnSyncBare.mockReset();
  });

  const load = async () => (await import('../../packages/mcp-rks/src/server/git/branch-delivery.mjs')).deliverFeatureBranch;
  const branchConfig = { working: 'staging', integration: 'staging', production: 'main' };

  it('(a) throws a TypeError when target is omitted', async () => {
    const deliver = await load();
    expect(() => deliver({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig }))
      .toThrow(TypeError);
  });

  it('(b) the error names `target`, so a wiring defect is diagnosable', async () => {
    const deliver = await load();
    expect(() => deliver({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig }))
      .toThrow(/target/);
  });

  it('(c) NOTHING spawns before the guard', async () => {
    const deliver = await load();
    expect(() => deliver({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig })).toThrow();
    expect(spawnSyncPrefixed).not.toHaveBeenCalled();
    expect(spawnSyncBare).not.toHaveBeenCalled();
  });

  it('(d) refuses a non-string and an empty string, not merely undefined', async () => {
    const deliver = await load();
    for (const target of ['', null, 0, 123, {}, []]) {
      expect(() => deliver({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig, target }))
        .toThrow(TypeError);
    }
    expect(spawnSyncPrefixed).not.toHaveBeenCalled();
    expect(spawnSyncBare).not.toHaveBeenCalled();
  });

  it('does NOT throw once a real target is supplied — the guard is not a blanket refusal', async () => {
    const deliver = await load();
    // localMerge's checkout is the first spawn; a non-zero status makes it return an
    // ok:false record rather than throwing, which is the behaviour under test here.
    spawnSyncBare.mockReturnValue({ status: 1, stderr: 'nope', stdout: '' });
    const result = deliver({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig, target: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('local_merge_failed');
    expect(spawnSyncBare).toHaveBeenCalled();
  });
});
