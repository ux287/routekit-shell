/**
 * Tests for backlog.fix.ship-review-fail-closed.
 *
 * A 404 on a retired model id was converted into a passing review verdict:
 *
 *   "step": "review", "ok": true, "verdict": "pass", "findingCount": 0,
 *   "summary": "Reviewer LLM call failed: Anthropic error: 404 ..."
 *
 * Every story shipped through that path had a review gate reporting a pass it
 * never performed. Three things went wrong together: runReview computed a
 * verdict from pattern findings alone and called an empty result 'pass';
 * story-ship.mjs branched on reviewResult.ok and dropped the one honest field
 * (llmFailed) at the boundary; and the ship then merged.
 *
 * The fix makes unavailability a first-class non-passing outcome that survives
 * the trip to the caller, and halts on it by default.
 *
 * TIERING: runReview shells out to git via getDiff/getChangedFiles and
 * runStoryShipTool needs a real repo, so neither is unit-testable. Both
 * contracts are therefore pure named exports. This file must contain no
 * spawn-family call (unit-tier purity guard).
 *
 * DISCIPLINE: no assertion here pins a COUNT of failure exits, ok:false
 * occurrences or story_ship.failed emit sites, and none slices a fixed-size
 * source window out of story-ship.mjs or review.mjs — the shipped
 * tests/unit/ship-failure-branch-state.test.mjs suite must stay green alongside
 * this one, and it is deliberately NOT modified by this story.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  buildUnavailableReview,
  loadReviewPolicy,
  computeFinalVerdict,
} from '../../packages/mcp-rks/src/server/review.mjs';
import { buildReviewStepEntry } from '../../packages/mcp-rks/src/server/story-ship.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const REVIEW_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/review.mjs'),
  'utf8'
);
const SHIP_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/story-ship.mjs'),
  'utf8'
);

const BLOCK_FINDING = { severity: 'block', category: 'enforcement_modification' };
const WARN_FINDING = { severity: 'warn', category: 'anti_patterns' };

describe('buildUnavailableReview — a review that did not run is never a pass', () => {
  it('is a named export callable with no LLM, git or subprocess', () => {
    expect(typeof buildUnavailableReview).toBe('function');
    expect(() => buildUnavailableReview()).not.toThrow();
  });

  it('never returns verdict pass, for any shape of pattern findings', () => {
    const inputs = [
      { patternFindings: [] },
      { patternFindings: [WARN_FINDING] },
      { patternFindings: [BLOCK_FINDING] },
      { patternFindings: [WARN_FINDING, BLOCK_FINDING] },
      {},
    ];
    for (const input of inputs) {
      const result = buildUnavailableReview(input);
      expect(result.verdict).not.toBe('pass');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.llmFailed).toBe(true);
    }
  });

  it('pins ok:true so the consumer cannot route it down the merge-anyway path', () => {
    // ok means "the review module produced a result", not "the change is
    // acceptable". ok:false would send story-ship.mjs to its else branch, which
    // records a skipped step and merges — reinstating the fail-open.
    for (const input of [{}, { patternFindings: [BLOCK_FINDING] }]) {
      expect(buildUnavailableReview(input).ok).toBe(true);
    }
  });

  it("returns verdict 'unavailable' with no findings and 'block' with a blocker", () => {
    expect(buildUnavailableReview({ patternFindings: [] }).verdict).toBe('unavailable');
    expect(buildUnavailableReview({ patternFindings: [BLOCK_FINDING] }).verdict).toBe('block');
  });

  it('carries the underlying error in a dedicated field, not only in the summary', () => {
    const result = buildUnavailableReview({ error: 'Anthropic error: 404 model not found' });
    expect(result.error).toContain('404');
    // Populated even if a caller ignores summary entirely.
    expect(result.error).toBeTruthy();
  });

  it('still populates error when none is supplied', () => {
    expect(buildUnavailableReview({}).error).toBeTruthy();
  });

  it('preserves the supplied pattern findings', () => {
    const findings = [WARN_FINDING, BLOCK_FINDING];
    expect(buildUnavailableReview({ patternFindings: findings }).findings).toEqual(findings);
  });

  it('emits a cause from the closed three-value set, defaulting to call_failed', () => {
    expect(buildUnavailableReview({ cause: 'not_configured' }).cause).toBe('not_configured');
    expect(buildUnavailableReview({ cause: 'call_failed' }).cause).toBe('call_failed');
    // WIDENED by backlog.fix.review-malformed-response-indistinguishable. A
    // reviewer that ran and answered unparseably is categorically different
    // from one whose transport never produced output, so it carries its own
    // value rather than collapsing into call_failed.
    expect(buildUnavailableReview({ cause: 'malformed_response' }).cause).toBe(
      'malformed_response'
    );
    // Anything unrecognized still collapses to call_failed — the field is a
    // discriminator over a CLOSED vocabulary, never free text. Widening it by
    // one value is not the same as opening it: garbage must never survive, or
    // an arbitrary caller-supplied string reaches the ship step and telemetry.
    for (const cause of [undefined, null, '', 'nonsense', 404, {}]) {
      expect(['not_configured', 'call_failed']).toContain(
        buildUnavailableReview({ cause }).cause
      );
    }
    expect(buildUnavailableReview({}).cause).toBe('call_failed');
  });

  it('tolerates a non-array patternFindings without throwing', () => {
    expect(() => buildUnavailableReview({ patternFindings: null })).not.toThrow();
    expect(buildUnavailableReview({ patternFindings: null }).findings).toEqual([]);
  });
});

describe('buildReviewStepEntry — the boundary that used to drop llmFailed', () => {
  it('is a named export and pure', () => {
    expect(typeof buildReviewStepEntry).toBe('function');
    expect(() => buildReviewStepEntry()).not.toThrow();
  });

  it('records an unavailable reviewer as not-ok with a non-pass verdict', () => {
    const entry = buildReviewStepEntry(
      buildUnavailableReview({ error: '404', cause: 'call_failed' })
    );
    expect(entry.step).toBe('review');
    expect(entry.ok).toBe(false);
    expect(entry.verdict).not.toBe('pass');
    expect(entry.cause).toBe('call_failed');
    expect(entry.error).toBeTruthy();
  });

  it('refuses to report a pass even if the result claims one', () => {
    // The exact shape of the original defect: verdict 'pass' alongside llmFailed.
    const entry = buildReviewStepEntry({ ok: true, verdict: 'pass', llmFailed: true });
    expect(entry.ok).toBe(false);
    expect(entry.verdict).not.toBe('pass');
  });

  it('treats a missing credential the same as a failed call, distinguished only by cause', () => {
    const notConfigured = buildReviewStepEntry(
      buildUnavailableReview({ error: 'No ANTHROPIC_API_KEY configured for reviewer', cause: 'not_configured' })
    );
    const callFailed = buildReviewStepEntry(
      buildUnavailableReview({ error: 'Reviewer LLM call failed: 404', cause: 'call_failed' })
    );
    expect(notConfigured.ok).toBe(false);
    expect(callFailed.ok).toBe(false);
    expect(notConfigured.cause).toBe('not_configured');
    expect(callFailed.cause).toBe('call_failed');
  });

  it('leaves a genuine successful review unchanged in shape', () => {
    const entry = buildReviewStepEntry({
      ok: true,
      verdict: 'pass',
      summary: 'Looks good',
      findings: [],
    });
    expect(entry.step).toBe('review');
    expect(entry.ok).toBe(true);
    expect(entry.verdict).toBe('pass');
    expect(entry.summary).toBe('Looks good');
    expect(entry.findingCount).toBe(0);
  });

  it('reports warn and block verdicts from a real review untouched', () => {
    for (const verdict of ['warn', 'block']) {
      const entry = buildReviewStepEntry({ ok: true, verdict, findings: [WARN_FINDING] });
      expect(entry.ok).toBe(true);
      expect(entry.verdict).toBe(verdict);
      expect(entry.findingCount).toBe(1);
    }
  });

  it('produces a usable entry for the old else-branch case, keeping the reason', () => {
    // Previously: steps.push({ step:'review', skipped:true, reason: error }).
    const entry = buildReviewStepEntry({ ok: false, error: 'module blew up' });
    expect(entry.step).toBe('review');
    expect(entry.ok).toBe(false);
    expect(entry.reason).toContain('module blew up');
  });
});

describe('loadReviewPolicy — failOpen defaults closed', () => {
  function withPolicy(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-review-policy-'));
    fs.mkdirSync(path.join(dir, '.rks'), { recursive: true });
    if (contents !== null) {
      fs.writeFileSync(path.join(dir, '.rks', 'review-policy.yaml'), contents);
    }
    try {
      return loadReviewPolicy(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is false when the policy file is absent', () => {
    expect(withPolicy(null).failOpen).toBe(false);
  });

  it('is false when the file exists but declares no failOpen key', () => {
    expect(withPolicy('enabled: true\nverdictMode: warn\n').failOpen).toBe(false);
  });

  it('is true only when explicitly set', () => {
    expect(withPolicy('failOpen: true\n').failOpen).toBe(true);
    expect(withPolicy('failOpen: false\n').failOpen).toBe(false);
  });

  it('leaves the other defaults intact', () => {
    const policy = withPolicy(null);
    expect(policy.enabled).toBe(true);
    expect(policy.verdictMode).toBe('warn');
    expect(policy.blockCategories).toContain('enforcement_modification');
    expect(policy.blockCategories).toContain('security_issue');
    expect(policy.enforcementPaths).toContain('.routekit/hooks/');
    expect(policy.enforcementPaths).toContain('.rks/protected-files.yml');
    // This story's own ship is expected to be blocked by this entry. That is
    // correct behavior and must never be engineered around.
    expect(policy.enforcementPaths).toContain('.rks/review-policy.yaml');
  });
});

describe('review.mjs wiring (full-source scan, no fixed windows)', () => {
  it('routes the LLM-failure branch through buildUnavailableReview', () => {
    expect(REVIEW_SRC).toContain('export function buildUnavailableReview');
    expect(REVIEW_SRC).toMatch(/if \(!llmResult\.ok\)/);
    expect(REVIEW_SRC).toMatch(/const unavailable = buildUnavailableReview\(/);
    expect(REVIEW_SRC).toMatch(/return unavailable;/);
  });

  it('no longer computes a pass verdict on the degraded path', () => {
    expect(REVIEW_SRC).not.toMatch(
      /patternFindings\.length > 0 \? 'warn' : 'pass'/
    );
  });

  it('stamps cause at the callReviewer exits, not by parsing the error text', () => {
    expect(REVIEW_SRC).toMatch(/cause: 'not_configured',\s*\n\s*error: 'No ANTHROPIC_API_KEY/);
    expect(REVIEW_SRC).toMatch(/cause: 'call_failed',\s*\n\s*error: `Reviewer LLM call failed/);
    // The discriminator must never be recovered from the human-readable string.
    expect(REVIEW_SRC).not.toMatch(/error.*\.(includes|match|test)\([^)]*ANTHROPIC_API_KEY/);
  });

  it('reports the unavailable verdict and cause on the degraded review.complete emit', () => {
    const emitIdx = REVIEW_SRC.indexOf("collector.emit('review.complete'");
    expect(emitIdx).toBeGreaterThan(-1);
    // Anchor-to-anchor, not a fixed-size window.
    const emit = REVIEW_SRC.slice(emitIdx, REVIEW_SRC.indexOf('});', emitIdx));
    expect(emit).toContain('verdict: unavailable.verdict');
    expect(emit).toContain('llmFailed: true');
    expect(emit).toContain('cause: unavailable.cause');
  });

  it('keeps both genuine passes and the successful-LLM path', () => {
    expect(REVIEW_SRC).toContain("reason: 'Review disabled in policy'");
    expect(REVIEW_SRC).toContain("summary: 'No changes to review'");
    expect(REVIEW_SRC).toMatch(/policy\.verdictMode === 'skip'/);

    // These two properties were previously pinned as source text — the LLM
    // verdict seeding the result, and the hard-block category check — because
    // the verdict path was unreachable from a test. computeFinalVerdict is now
    // an exported seam, so assert the BEHAVIOUR instead of the expression.
    // backlog.fix.review-security-gate-discriminating.
    //
    // computeFinalVerdict now returns { verdict, downgradedFrom, downgradeReason }
    // (backlog.fix.review-verdict-downgrade-legibility), so these read .verdict.
    // The VALUES are unchanged — see the parity matrix below, which proves that.
    expect(computeFinalVerdict({ llmVerdict: undefined, policy: {} }).verdict).toBe('pass');
    expect(computeFinalVerdict({ llmVerdict: 'block', policy: {} }).verdict).toBe('block');

    // A hard-block category survives verdictMode:'warn'; a soft one is softened.
    const policy = { verdictMode: 'warn', blockCategories: ['security_issue'] };
    expect(computeFinalVerdict({
      llmVerdict: 'block',
      allFindings: [{ severity: 'block', category: 'security_issue' }],
      policy,
    }).verdict).toBe('block');
    expect(computeFinalVerdict({
      llmVerdict: 'block',
      allFindings: [{ severity: 'block', category: 'ac_coverage' }],
      policy,
    }).verdict).toBe('warn');
  });

  it('adds failOpen to the policy defaults without disturbing enforcementPaths', () => {
    expect(REVIEW_SRC).toMatch(/failOpen: false,/);
    expect(REVIEW_SRC).toContain("'.rks/review-policy.yaml'");
  });
});

describe('story-ship.mjs wiring (full-source scan, no fixed windows)', () => {
  it('records the review step through buildReviewStepEntry on both paths', () => {
    expect(SHIP_SRC).toContain('export function buildReviewStepEntry');
    expect(SHIP_SRC).toMatch(/const reviewStep = buildReviewStepEntry\(reviewResult\);/);
    expect(SHIP_SRC).toMatch(/steps\.push\(reviewStep\);/);
    // Neither the old success literal nor the old else literal survives.
    expect(SHIP_SRC).not.toMatch(/steps\.push\(\{\s*\n\s*step: 'review',\s*\n\s*ok: true,/);
    expect(SHIP_SRC).not.toMatch(
      /steps\.push\(\{ step: 'review', skipped: true, reason: reviewResult\.error/
    );
  });

  it('evaluates unavailability outside the reviewResult.ok / else split', () => {
    // The halt must not live inside either branch: that is what made the
    // original fail-open reachable by flipping one boolean.
    const splitIdx = SHIP_SRC.indexOf('if (reviewResult.ok)');
    const haltIdx = SHIP_SRC.indexOf("policy.failOpen !== true");
    expect(haltIdx).toBeGreaterThan(-1);
    // The old split is gone entirely — the step entry covers both outcomes.
    expect(splitIdx).toBe(-1);
    expect(SHIP_SRC).toMatch(/if \(!reviewStep\.ok && policy\.failOpen !== true\)/);
  });

  it('halts before the merge step', () => {
    const haltIdx = SHIP_SRC.indexOf("reason: 'reviewer_unavailable'");
    const mergeIdx = SHIP_SRC.indexOf('Step 2: Merge the PR to working branch');
    expect(haltIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(haltIdx);
  });

  it('never makes the halt conditional on credential presence', () => {
    // The credential is never READ here — making the halt depend on an unset
    // env var would be a bypass by omission, the same defect class in new
    // clothing. It may only be NAMED, in the remediation hint.
    expect(SHIP_SRC).not.toMatch(/process\.env\.ANTHROPIC/);
    expect(SHIP_SRC).not.toMatch(/anthropicKey/);
    expect(SHIP_SRC).not.toMatch(/loadEnv\(/);

    const mentions = SHIP_SRC.split('\n').filter((l) => l.includes('ANTHROPIC_API_KEY'));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      expect(line).toMatch(/hint:/);
    }
  });

  it('returns through the shipped buildShipFailure helper, not a new inline literal', () => {
    const haltIdx = SHIP_SRC.indexOf("reason: 'reviewer_unavailable'");
    const afterHalt = SHIP_SRC.slice(haltIdx);
    const returnIdx = afterHalt.indexOf('return ');
    expect(afterHalt.slice(returnIdx)).toMatch(/^return buildShipFailure\(\{/);
  });

  it('leads the new buildShipFailure payload with the two branch fields', () => {
    // The shipped ship-failure-branch-state suite asserts both literals appear
    // within the first 200 characters after `return buildShipFailure(`. The
    // two-remedy hint is long enough to push them out if they are not first.
    const blocks = SHIP_SRC.split('return buildShipFailure(').slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const head = block.slice(0, 200);
      expect(head).toContain('worktreeBranch: currentBranch');
      expect(head).toContain('baseBranch: working');
    }
  });

  it('defines buildReviewStepEntry outside the region that suite scans', () => {
    // TOOL_BODY there runs from runStoryShipTool to buildShipFailure's JSDoc.
    // buildReviewStepEntry returns ok:false and a `return {`, both of which
    // would violate that suite's constraints if they fell inside.
    const entryIdx = SHIP_SRC.indexOf('export function buildReviewStepEntry');
    const toolIdx = SHIP_SRC.indexOf('export async function runStoryShipTool');
    expect(entryIdx).toBeGreaterThan(-1);
    expect(entryIdx).toBeLessThan(toolIdx);
  });

  it('emits story_ship.failed with cause, worktreeBranch and a distinct reason', () => {
    const emitIdx = SHIP_SRC.indexOf("reason: 'reviewer_unavailable'");
    const emitStart = SHIP_SRC.lastIndexOf("collector.emit('story_ship.failed'", emitIdx);
    expect(emitStart).toBeGreaterThan(-1);
    const emit = SHIP_SRC.slice(emitStart, SHIP_SRC.indexOf('});', emitStart));
    expect(emit).toContain("failedStep: 'review'");
    expect(emit).toContain("reason: 'reviewer_unavailable'");
    expect(emit).toContain('cause: reviewStep.cause');
    expect(emit).toContain('worktreeBranch: currentBranch');
    // Distinct from the pre-existing blocked-review reason.
    expect(SHIP_SRC).toContain("reason: 'review_blocked'");
  });

  it('names both remedies literally in the hint', () => {
    expect(SHIP_SRC).toMatch(/ANTHROPIC_API_KEY credential/);
    expect(SHIP_SRC).toMatch(/enabled: false or failOpen: true in \.rks\/review-policy\.yaml/);
  });

  it('leaves the verdict block halt intact so a degraded blocker still stops the ship', () => {
    expect(SHIP_SRC).toMatch(/if \(reviewResult\.verdict === 'block'\)/);
    expect(SHIP_SRC).toContain("error: 'Code review blocked merge'");
  });
});

/**
 * backlog.fix.review-verdict-downgrade-legibility.
 *
 * The story is explicitly a NO-BEHAVIOUR-CHANGE change: computeFinalVerdict grew
 * two explanatory fields and must still return the same `verdict` for every
 * input. "Same as before" is only checkable against a stated before, so the
 * pre-change function body is transcribed here as an ORACLE and the matrix
 * compares against it — inspection of the diff is not evidence, and the AC says
 * so in as many words.
 *
 * Keep the oracle a verbatim transcription. If a future story deliberately
 * changes the decision, this oracle is what has to be edited, in the open.
 */
function preChangeVerdict({ patternFindings = [], allFindings = [], llmVerdict, policy = {} }) {
  let finalVerdict = llmVerdict || 'pass';
  const hasPatternBlockers = patternFindings.some(
    (f) => f.severity === 'block' && policy.blockCategories?.includes(f.category)
  );
  if (hasPatternBlockers && finalVerdict !== 'block') {
    finalVerdict = 'block';
  }
  if (policy.verdictMode === 'warn' && finalVerdict === 'block') {
    const hardBlockCategories = policy.blockCategories || [];
    const hasHardBlock = allFindings.some(
      (f) => f.severity === 'block' && hardBlockCategories.includes(f.category)
    );
    if (!hasHardBlock) {
      finalVerdict = 'warn';
    }
  } else if (policy.verdictMode === 'skip') {
    finalVerdict = 'pass';
  }
  return finalVerdict;
}

const VERDICT_MODES = ['warn', 'skip', 'block', undefined];
const SEVERITIES = ['block', 'warn'];
// One category inside the default blockCategories, one inside warnCategories.
const CATEGORIES = ['security_issue', 'ac_coverage'];
const LLM_VERDICTS = ['pass', 'warn', 'block', undefined];
const DEFAULT_BLOCK_CATEGORIES = ['enforcement_modification', 'security_issue'];

/** Every combination the AC enumerates: 4 x 2 x 2 x 4 = 64 cases. */
function parityMatrix() {
  const cases = [];
  for (const verdictMode of VERDICT_MODES) {
    for (const severity of SEVERITIES) {
      for (const category of CATEGORIES) {
        for (const llmVerdict of LLM_VERDICTS) {
          const findings = [{ severity, category }];
          cases.push({
            name: `verdictMode=${verdictMode} severity=${severity} category=${category} llmVerdict=${llmVerdict}`,
            args: {
              patternFindings: findings,
              allFindings: findings,
              llmVerdict,
              policy: { verdictMode, blockCategories: DEFAULT_BLOCK_CATEGORIES },
            },
          });
        }
      }
    }
  }
  return cases;
}

describe('computeFinalVerdict — behaviour parity matrix (no behaviour change)', () => {
  const CASES = parityMatrix();

  it('enumerates every combination the AC names', () => {
    expect(CASES).toHaveLength(
      VERDICT_MODES.length * SEVERITIES.length * CATEGORIES.length * LLM_VERDICTS.length
    );
    expect(CASES).toHaveLength(64);
  });

  it.each(CASES)('$name — verdict is byte-identical to the pre-change value', ({ args }) => {
    expect(computeFinalVerdict(args).verdict).toBe(preChangeVerdict(args));
  });

  it('never returns a verdict outside pass/warn/block', () => {
    for (const { args } of CASES) {
      expect(['pass', 'warn', 'block']).toContain(computeFinalVerdict(args).verdict);
    }
  });

  it('always returns an object carrying all three fields', () => {
    for (const { args } of CASES) {
      const result = computeFinalVerdict(args);
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('verdict');
      expect(result).toHaveProperty('downgradedFrom');
      expect(result).toHaveProperty('downgradeReason');
    }
  });

  it('records a downgrade for exactly the cases where the oracle softened or forced', () => {
    // The oracle cannot report a downgrade, so recompute the pre-downgrade
    // verdict from the same inputs and compare against the recorded field. This
    // is what makes downgradedFrom trustworthy rather than merely present.
    for (const { name, args } of CASES) {
      const withoutMode = preChangeVerdict({
        ...args,
        policy: { ...args.policy, verdictMode: undefined },
      });
      const actual = computeFinalVerdict(args);
      const wasDowngraded = actual.verdict !== withoutMode;
      if (wasDowngraded) {
        expect(actual.downgradedFrom, name).toBe(withoutMode);
        expect(typeof actual.downgradeReason, name).toBe('string');
      } else {
        expect(actual.downgradedFrom, name).toBeNull();
        expect(actual.downgradeReason, name).toBeNull();
      }
    }
  });
});

describe('computeFinalVerdict — the downgrade record itself', () => {
  const POLICY_WARN = { verdictMode: 'warn', blockCategories: ['enforcement_modification', 'security_issue'] };

  it("names the softened categories AND the policy field that permitted it", () => {
    const findings = [{ severity: 'block', category: 'ac_coverage' }];
    const result = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'block',
      policy: POLICY_WARN,
    });
    expect(result.verdict).toBe('warn');
    expect(result.downgradedFrom).toBe('block');
    expect(result.downgradeReason).toContain('ac_coverage');
    expect(result.downgradeReason).toContain('blockCategories');
  });

  it("records verdictMode 'skip' forcing a pass, naming the verdict it overrode", () => {
    const findings = [{ severity: 'block', category: 'security_issue' }];
    const result = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'block',
      policy: { verdictMode: 'skip', blockCategories: ['security_issue'] },
    });
    expect(result.verdict).toBe('pass');
    expect(result.downgradedFrom).toBe('block');
    expect(result.downgradeReason).toContain('skip');
  });

  it("does not invent a downgrade when 'skip' passes an already-passing review", () => {
    const result = computeFinalVerdict({ llmVerdict: 'pass', policy: { verdictMode: 'skip' } });
    expect(result.verdict).toBe('pass');
    expect(result.downgradedFrom).toBeNull();
  });

  it('leaves a genuine pass and a genuine warn unmarked', () => {
    for (const llmVerdict of ['pass', 'warn']) {
      const result = computeFinalVerdict({ llmVerdict, policy: POLICY_WARN });
      expect(result.verdict).toBe(llmVerdict);
      expect(result.downgradedFrom).toBeNull();
      expect(result.downgradeReason).toBeNull();
    }
  });

  it('does NOT downgrade a hard block under verdictMode warn', () => {
    const findings = [{ severity: 'block', category: 'security_issue' }];
    const result = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'block',
      policy: POLICY_WARN,
    });
    expect(result.verdict).toBe('block');
    expect(result.downgradedFrom).toBeNull();
    expect(result.downgradeReason).toBeNull();
  });

  it('treats the pattern-blocker UPGRADE as an upgrade, never a downgrade', () => {
    // hasPatternBlockers promotes pass -> block. verdictMode is not 'warn', so
    // nothing softens it back, and no downgrade may be recorded.
    const findings = [{ severity: 'block', category: 'security_issue' }];
    const result = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'pass',
      policy: { verdictMode: 'block', blockCategories: ['security_issue'] },
    });
    expect(result.verdict).toBe('block');
    expect(result.downgradedFrom).toBeNull();
    expect(result.downgradeReason).toBeNull();
  });

  it('a genuine pass is told apart from a downgraded block without reading findings', () => {
    const softened = [{ severity: 'block', category: 'ac_coverage' }];
    const genuine = computeFinalVerdict({ llmVerdict: 'warn', policy: POLICY_WARN });
    const downgraded = computeFinalVerdict({
      patternFindings: softened,
      allFindings: softened,
      llmVerdict: 'block',
      policy: POLICY_WARN,
    });
    // Identical verdicts — the whole point of the defect.
    expect(genuine.verdict).toBe(downgraded.verdict);
    // Distinguishable anyway, by field presence alone.
    expect(genuine.downgradedFrom).toBeNull();
    expect(downgraded.downgradedFrom).toBe('block');
  });
});
