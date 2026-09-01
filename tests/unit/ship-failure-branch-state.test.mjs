/**
 * Tests for backlog.fix.ship-failure-branch-state.
 *
 * `runStoryShipTool` has seven `ok: false` exits and none of them named the
 * branch the worktree was left on. A failed ship strands the repository on the
 * feature branch; the caller only found out by tripping over it later.
 *
 * The fix is REPORT, not RESTORE. Auto-checking-out the base branch would make
 * the `currentBranch === working` short-circuit return `idempotent: true` on a
 * retry, falsely reporting the story as already shipped — a loud failure turned
 * into a silent false success. So every failure return now routes through an
 * exported `buildShipFailure` helper that stamps `worktreeBranch`, `baseBranch`
 * and an explicit `branchRestored: false`, and `.rks/prompts/governor-build.md`
 * step 7 propagates those into the Build Governor's own return.
 *
 * UNIT TIER: this file must contain no spawn-family call. That is why the helper
 * is exported — the payload contract is a pure function, testable with no git
 * repo and no subprocess. Git-dependent behavior lives in
 * tests/integration/story-ship-preflight.test.mjs.
 *
 * NOTE ON COUNTS: nothing here pins a count of failure exits, `ok: false`
 * occurrences or `story_ship.failed` emit sites. backlog.fix.ship-review-fail-closed
 * adds an eighth exit to this same file and must not redden these tests, so every
 * structural assertion enumerates by scanning instead.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildShipFailure } from '../../packages/mcp-rks/src/server/story-ship.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const SHIP_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/story-ship.mjs'),
  'utf8'
);
const BUILD_PROMPT = fs.readFileSync(
  path.join(REPO_ROOT, '.rks/prompts/governor-build.md'),
  'utf8'
);

// Split the module into the tool body, the helper's doc comment, and the helper
// body, so each can be asserted against independently.
const TOOL_START = SHIP_SRC.indexOf('export async function runStoryShipTool');
const HELPER_START = SHIP_SRC.indexOf('export function buildShipFailure');
const HELPER_DOC_START = SHIP_SRC.lastIndexOf('/**', HELPER_START);

const TOOL_BODY = SHIP_SRC.slice(TOOL_START, HELPER_DOC_START);
const HELPER_DOC = SHIP_SRC.slice(HELPER_DOC_START, HELPER_START);
const HELPER_BODY = SHIP_SRC.slice(HELPER_START);

/** Every line of `src` that contains `needle`. */
function linesContaining(src, needle) {
  return src.split('\n').filter((l) => l.includes(needle));
}

/**
 * Every `collector.emit('<event>', ...)` CALL in `src`, as source text running
 * from the event name to the call's closing `});`. Line-based scanning is wrong
 * here — the preflight emit spans six lines, so a per-line check would miss a
 * field sitting on the next line and report a false failure.
 */
function emitCalls(src, event) {
  return src
    .split(`collector.emit('${event}'`)
    .slice(1)
    .map((tail) => tail.slice(0, tail.indexOf('});')));
}

describe('buildShipFailure — payload contract (pure)', () => {
  const base = {
    worktreeBranch: 'rks/backlog-fix-example',
    baseBranch: 'staging',
  };

  it('is a named export callable with no git repo and no subprocess', () => {
    expect(typeof buildShipFailure).toBe('function');
    expect(() => buildShipFailure(base)).not.toThrow();
  });

  it('stamps worktreeBranch, baseBranch and branchRestored:false', () => {
    const result = buildShipFailure(base);
    expect(result.ok).toBe(false);
    expect(result.worktreeBranch).toBe('rks/backlog-fix-example');
    expect(result.baseBranch).toBe('staging');
    expect(result.branchRestored).toBe(false);
  });

  it('never returns ok:true or branchRestored:true, even when passed them', () => {
    // The caller cannot opt out of the branch contract by supplying its own
    // values — the helper's fields are applied after the caller's spread.
    const forced = buildShipFailure({
      ...base,
      ok: true,
      branchRestored: true,
    });
    expect(forced.ok).toBe(false);
    expect(forced.branchRestored).toBe(false);

    for (const weird of [{}, { ...base, ok: 1 }, { ...base, branchRestored: 'yes' }]) {
      const r = buildShipFailure(weird);
      expect(r.ok).toBe(false);
      expect(r.branchRestored).toBe(false);
    }
  });

  it("preserves the caller's own fields rather than dropping them", () => {
    const steps = [{ step: 'working_pr', ok: true }];
    const result = buildShipFailure({
      ...base,
      error: 'Failed at working_merge: conflict',
      failedStep: 'working_merge',
      steps,
      prUrl: 'https://github.com/o/r/pull/1077',
      review: { verdict: 'block' },
    });

    expect(result.error).toBe('Failed at working_merge: conflict');
    expect(result.failedStep).toBe('working_merge');
    expect(result.steps).toBe(steps);
    expect(result.prUrl).toBe('https://github.com/o/r/pull/1077');
    expect(result.review).toEqual({ verdict: 'block' });
  });

  it('names both branches in the hint as literal substrings', () => {
    const result = buildShipFailure(base);
    expect(result.hint).toContain('rks/backlog-fix-example');
    expect(result.hint).toContain('staging');
  });

  it("keeps the exit's own remediation wording and appends the branch note", () => {
    // The preflight exit's hint is asserted verbatim by the integration test —
    // the branch note must be additive, never a replacement.
    const original =
      'commit or stash your changes before running rks_story_ship; notes/ files are auto-excluded (they are governor-managed)';
    const result = buildShipFailure({ ...base, hint: original });

    expect(result.hint).toContain(original);
    expect(result.hint).toMatch(/commit|stash/i);
    expect(result.hint).toMatch(/notes\//);
    expect(result.hint).toContain('rks/backlog-fix-example');
    expect(result.hint).toContain('staging');
  });

  it('still produces a branch-naming hint when the caller supplies none', () => {
    const result = buildShipFailure(base);
    expect(result.hint).toBeTruthy();
    expect(result.hint).toMatch(/not restored/i);
  });
});

describe('buildShipFailure — cannot move the worktree', () => {
  it('performs no git operation and no process spawn', () => {
    // Built from fragments so this assertion cannot itself trip the unit-tier
    // purity guard at tests/unit/unit-tier-purity.test.mjs.
    const spawnFamily = new RegExp(
      '(?<![\\w.])(' + 'spawn' + 'Sync|spawn|' + 'exec' + 'Sync|' + 'exec' + '|fork)\\s*\\(',
      'g'
    );
    expect(HELPER_BODY).not.toMatch(spawnFamily);
    expect(HELPER_BODY).not.toMatch(/\bcheckout\b/);
    expect(HELPER_BODY).not.toMatch(/\bgit\b\s*['"]/);
    expect(HELPER_BODY).not.toMatch(/['"]switch['"]/);
  });

  it('carries a comment recording why auto-restore is forbidden', () => {
    expect(HELPER_DOC).toMatch(/currentBranch === working/);
    expect(HELPER_DOC).toMatch(/idempotent: true/);
    expect(HELPER_DOC).toMatch(/restor/i);
    // A citation to the short-circuit must be present. The line number itself is
    // deliberately NOT pinned here — this repo has a standing problem with stale
    // positions, and a test that pins one would rot on the next edit.
    expect(HELPER_DOC).toMatch(/story-ship\.mjs:\d+/);
  });
});

describe('runStoryShipTool — every failure return routes through the helper', () => {
  it('constructs no failure return inline', () => {
    // If any exit still built its own object literal, it could omit the branch
    // fields. Enumerating rather than counting keeps this green when
    // backlog.fix.ship-review-fail-closed adds another exit.
    expect(TOOL_BODY).not.toMatch(/return\s*\{\s*\n?\s*ok:\s*false/);
    expect(TOOL_BODY).toMatch(/return buildShipFailure\(/);
  });

  it('leaves no ok:false literal outside the helper except the non-returning ci_check step', () => {
    const okFalseLines = linesContaining(TOOL_BODY, 'ok: false');
    // Not "expect(length).toBe(1)" — enumerate and characterize each one.
    for (const line of okFalseLines) {
      expect(line).toContain('ci_check');
      expect(line).toContain('steps.push');
    }
  });

  it('still contains all seven original failure exits', () => {
    for (const marker of [
      'not from a protected branch',
      'preflight_dirty_tree',
      'Failed at local_merge',
      'Failed to push branch to remote',
      'Failed at working_pr',
      'Code review blocked merge',
      'Failed at working_merge',
    ]) {
      expect(TOOL_BODY).toContain(marker);
    }
  });

  it('passes both branch values to the helper at every call site', () => {
    const callSites = linesContaining(TOOL_BODY, 'return buildShipFailure(');
    expect(callSites.length).toBeGreaterThan(0);
    // Each call site opens a payload whose next lines carry the branch pair.
    const blocks = TOOL_BODY.split('return buildShipFailure(').slice(1);
    for (const block of blocks) {
      const head = block.slice(0, 200);
      expect(head).toContain('worktreeBranch: currentBranch');
      expect(head).toContain('baseBranch: working');
    }
  });
});

describe('runStoryShipTool — telemetry carries the branch', () => {
  it('includes worktreeBranch on every story_ship.failed emit', () => {
    const emits = emitCalls(TOOL_BODY, 'story_ship.failed');
    expect(emits.length).toBeGreaterThan(0);
    for (const emit of emits) {
      expect(emit).toContain('worktreeBranch');
    }
  });

  it('does not claim coverage for the protected-branch refusal', () => {
    // Recorded, not fixed: the protected-branch exit returns before the
    // telemetry collector is constructed, so it has no story_ship.failed emit
    // at all. "Every emit carries worktreeBranch" is therefore not the same as
    // "every failure is observable". Adding that emit is out of scope.
    const collectorIdx = TOOL_BODY.indexOf('ensureTelemetryStorage(projectRoot)');
    const protectedIdx = TOOL_BODY.indexOf('not from a protected branch');
    expect(protectedIdx).toBeGreaterThan(-1);
    expect(collectorIdx).toBeGreaterThan(protectedIdx);
  });
});

describe('runStoryShipTool — success paths are unchanged in shape', () => {
  it('keeps the idempotent short-circuit returning ok:true', () => {
    const idx = TOOL_BODY.indexOf('already_on_working_branch');
    const block = TOOL_BODY.slice(idx, idx + 600);
    expect(block).toMatch(/ok:\s*true/);
    expect(block).toMatch(/idempotent:\s*true/);
    expect(block).toMatch(/workingBranch:\s*working/);
  });

  it('keeps the success return carrying its original fields', () => {
    const idx = TOOL_BODY.lastIndexOf('return {');
    const block = TOOL_BODY.slice(idx);
    for (const field of [
      // Was 'ok: true'. STALE ASSERTION, not a wrong implementation: the final
      // return no longer hardcodes success — it reports the reduction over
      // `steps`, so a ship whose step failed returns ok:false instead of
      // claiming success. Re-pinned to the reduced expression.
      'ok: shipOk',
      'steps',
      'stepsCompleted',
      'stepsSkipped',
      'prUrl',
      'workingBranch',
      'autoPromoted',
      'next',
    ]) {
      expect(block).toContain(field);
    }
    // The success path must NOT have picked up failure-only fields.
    expect(block).not.toContain('branchRestored');
  });
});

describe('.rks/prompts/governor-build.md — step 7 failure clause', () => {
  function stepSevenClause() {
    const stepIdx = BUILD_PROMPT.indexOf('7. mcp__rks__rks_story_ship(');
    expect(stepIdx).toBeGreaterThan(-1);
    return BUILD_PROMPT.slice(stepIdx, BUILD_PROMPT.indexOf('\n## ', stepIdx));
  }

  it('preserves the two literals other tests pin', () => {
    expect(BUILD_PROMPT).toContain('7. mcp__rks__rks_story_ship(');
    expect(BUILD_PROMPT).toContain(
      'After rks_exec succeeds, your ONLY next call is rks_story_ship'
    );
  });

  it('introduces no new numbered step marker', () => {
    // tests/unit/governor-build-prompt.test.mjs pins the ordered marker
    // sequence ending at step 7 — the failure clause must be prose under it.
    expect(BUILD_PROMPT).not.toMatch(/^8\.\s/m);
  });

  it('names the ok:false case and instructs the Governor to STOP', () => {
    const clause = stepSevenClause();
    expect(clause).toMatch(/ok:\s*false/);
    expect(clause).toContain('STOP');
    expect(clause).toMatch(/status:\s*'failed'/);
  });

  it('requires the branch state to be propagated into artifacts', () => {
    const clause = stepSevenClause();
    expect(clause).toContain('worktreeBranch');
    expect(clause).toContain('baseBranch');
    expect(clause).toContain('prUrl');
    expect(clause).toMatch(/branchRestored:\s*false/);
  });

  it('requires the summary to state in prose that the worktree was not restored', () => {
    const clause = stepSevenClause();
    expect(clause).toMatch(/summary/);
    expect(clause).toMatch(/prose/i);
    expect(clause).toMatch(/not restored/i);
  });

  it('forbids switching branches or retrying the ship after a failure', () => {
    const clause = stepSevenClause();
    expect(clause).toMatch(/Do NOT switch branches/i);
    expect(clause).toMatch(/retry/i);
  });
});
