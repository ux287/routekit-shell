/**
 * Guardrails-Off Governance Module
 *
 * Manages guardrails-off sessions with:
 * - Session logging (start/end times, reason, commits)
 * - Automatic PR/merge/complete_cycle on restore
 * - Audit trail for compliance
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { runCycleComplete } from "./git-tools.mjs";
import { getHooksHealth, restoreHooksFromTemplate } from "./hooks-health.mjs";
import { parseFrontmatter, resolveNotesDir } from "../dendron.mjs";
import { PHASE_GATE_GUARDRAIL } from "../workflow/phases.mjs";
import { reconcileToIntegrated } from "../workflow/auto-phase.mjs";
import { normalizeTargetFiles } from "../shared/normalize-target-files.mjs";
import { localMerge } from "./git/local-merge.mjs";
import { getBranchConfig } from "./project.mjs";
import { getCurrentBranch } from "../utils/git.mjs";
import { commitAndEmbed } from '../shared/commit-and-embed.mjs';

const HOOKS_DIR = ".routekit/hooks";
const HOOKS_BAK_DIR = ".routekit/hooks.bak"; // Active backup: hooks/ is renamed here when guardrails are off
const HOOKS_MANIFEST = ".routekit/hooks-manifest.json";
/**
 * The hook tier directories a guardrails-off session RELOCATES into hooks.bak.
 *
 * Everything else under .routekit/hooks/ is a non-tier sibling — `system/` (which
 * stays live and enforcing) and shared-module directories such as `lib/`. The
 * sibling mirror below derives its set by EXCLUDING these names rather than
 * listing the siblings, so a sibling added later is covered without anyone
 * remembering to update a second list.
 */
const RELOCATABLE_TIERS = ['write', 'read'];

const SESSION_LOG = ".rks/guardrails-off-sessions.jsonl";
const SCOPE_FILE = ".rks/active-scope.json";
const GUARD_STATE_FILE = ".rks/guardrails-state.json";

/**
 * Check if a file path is listed in the current active scope (allowedFiles).
 * Fail-open: returns false on any error (missing file, bad JSON, missing field).
 * Used by hooks to pass through tool calls for files already declared in scope.
 * @param {string} filePath - Absolute or relative path to check
 * @param {string} [projectRoot] - Project root for resolving relative paths (defaults to cwd)
 * @returns {boolean}
 */
export function isFileInActiveScope(filePath, projectRoot) {
  try {
    const root = projectRoot || process.cwd();
    const scopePath = path.join(root, SCOPE_FILE);
    const data = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
    const allowedFiles = Array.isArray(data.allowedFiles) ? data.allowedFiles : [];
    if (allowedFiles.length === 0) return false;
    const absTarget = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    return allowedFiles.some(f => {
      const absAllowed = path.isAbsolute(f) ? f : path.resolve(root, f);
      return absTarget === absAllowed;
    });
  } catch {
    return false;
  }
}

/**
 * Commit + push a single note that was written to disk AFTER the primary auto-ship commit.
 *
 * bug #7 (backlog.fix.offrail-ship-commit-phase-note): the off-rail auto-ship advances the
 * story note to `phase: integrated` via a git-free disk write that lands AFTER the scoped
 * commit + push, stranding the note dirty in the working tree — which dirties the tree and
 * desyncs the integration branch, blocking the next rks_release. This persists that note so
 * `guardrailsOn()` ends with a CLEAN tree and a SYNCED branch.
 *
 * Idempotent no-op when the note is not dirty (never makes an empty commit). Never throws —
 * returns a structured result the caller records as a `ship-note` shipStep. On push failure
 * the note is still committed locally (tree clean); the caller surfaces a manual-push hint,
 * mirroring the existing manual-push fallback used elsewhere in this module.
 *
 * @param {string} projectRoot
 * @param {string} notePath - absolute or repo-relative path to the note file
 * @param {string} branch - integration branch to push (e.g. "staging")
 * @param {string} message - commit message
 * @returns {{ok: boolean, skipped?: boolean, reason?: string, commitId?: string, error?: string}}
 */
export function commitAndPushNote(projectRoot, notePath, branch, message) {
  try {
    if (!notePath) return { ok: true, skipped: true, reason: "no note path" };
    // Only act when the note is actually dirty — never make an empty commit.
    const status = spawnSync("git", ["status", "--porcelain", "--", notePath], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
    if ((status.stdout || "").trim().length === 0) {
      return { ok: true, skipped: true, reason: "note not dirty" };
    }
    const add = spawnSync("git", ["add", "--", notePath], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
    if (add.status !== 0) {
      return { ok: false, error: `git add of story note failed: ${(add.stderr || "").trim()}` };
    }
    const commit = spawnSync("git", ["commit", "-m", message], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
    if (commit.status !== 0) {
      return { ok: false, error: `git commit of story note failed: ${(commit.stderr || commit.stdout || "").trim()}` };
    }
    const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
    const commitId = (rev.stdout || "").trim();
    const push = spawnSync("git", ["push", "origin", branch], { cwd: projectRoot, encoding: "utf8", timeout: 30_000 });
    if (push.status !== 0) {
      // Tree is clean (committed); only the push failed. Do NOT fail the whole ship —
      // surface a manual-push hint, same posture as the primary manual-push fallback.
      return { ok: false, commitId, error: `story note committed (${commitId}) but push failed — manual push required: ${(push.stderr || "").trim()}` };
    }
    return { ok: true, commitId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Core file patterns - off-rail is appropriate for these
const RKS_CORE_PATTERNS = [
  'packages/',
  '.routekit/',
  'templates/',
  'scripts/mcp/',
  'packages/rag/src',
  'tests/',  // Tests for core packages are core work
];

/**
 * Load .rks/project.json for the given project root. Returns null on any failure
 * (missing file, invalid JSON). Callers fall back to default behavior on null.
 */
function loadProjectJson(projectRoot) {
  try {
    const p = path.join(projectRoot, '.rks', 'project.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the active write-scope file without deleting it.
 *
 * Returns { writeMode, allowedFiles } or null when there is no scope (a session
 * opened with no problemId, or the file is absent/malformed). Deliberately
 * separate from isFileInActiveScope, which re-reads the file per call and
 * compares by exact path equality — the ship-time gate matches an in-memory
 * snapshot with glob semantics instead.
 */
export function readActiveScope(projectRoot) {
  try {
    const scopePath = path.join(projectRoot, SCOPE_FILE);
    if (!fs.existsSync(scopePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(scopePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      writeMode: parsed.writeMode ?? null,
      allowedFiles: Array.isArray(parsed.allowedFiles) ? parsed.allowedFiles : null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the off-rail enforcement posture from a review policy.
 *
 * ADVISORY BY DEFAULT, AND DELIBERATELY SO — this is intentionally asymmetric
 * with the on-rail gate, which fails closed (story-ship.mjs halts when a review
 * could not run). CLAUDE.md designates guardrails-off as the escape hatch for
 * exactly the sessions where the on-rail path has wedged, and review.mjs already
 * defaults failOpen:false with buildUnavailableReview never returning 'pass', so
 * a user with no credential already cannot ship on-rail. Copying fail-closed here
 * would leave them unable to ship by EITHER route. The defect this gate fixes is
 * silence, not permissiveness: before it, off-rail shipped with no signal at all.
 *
 * Fails open to 'advisory' on anything unrecognized, so a malformed policy can
 * never wedge the escape hatch shut.
 */
export function resolveOffRailPosture(policy) {
  return policy?.offRail === "block" ? "block" : "advisory";
}

/**
 * The closed `cause` vocabulary, mirrored from review.mjs's RECOGNIZED_CAUSES.
 *
 * DUPLICATED DELIBERATELY, not imported. Importing review.mjs here would pull
 * @routekit/rag (lancedb, transformers) into every load of this module — the
 * same reason the redaction caller-contract below is stated in prose rather
 * than enforced by an import.
 *
 * An unrecognized cause still normalizes to call_failed: this is an allowlist,
 * never blanket passthrough, so a caller-supplied string cannot reach the ship
 * step or telemetry.
 */
const RECOGNIZED_REVIEW_CAUSES = ["not_configured", "call_failed", "malformed_response"];

function normalizeReviewCause(cause) {
  return RECOGNIZED_REVIEW_CAUSES.includes(cause) ? cause : "call_failed";
}

/**
 * Bounds on the acCoverage payload carried onto the review ship step.
 *
 * Exported so a test can READ the caps rather than restate them — a test that
 * hardcodes 25 passes against an implementation that hardcodes a different 25.
 * Precedent: `export const MAX_PERSISTED_FINDINGS = 25;` in review.mjs.
 *
 * These arrays hold model-authored free text quoting acceptance criteria, and
 * the step reaches the rks_guardrails_on response and telemetry, so the payload
 * is bounded at the producer rather than trusted to be small.
 */
export const MAX_AC_COVERAGE_ENTRIES = 25;
export const MAX_AC_COVERAGE_ENTRY_CHARS = 200;

function normalizeAcCoverageList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_AC_COVERAGE_ENTRIES)
    .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
    .map((entry) => entry.slice(0, MAX_AC_COVERAGE_ENTRY_CHARS));
}

/**
 * Coerce a review result's acCoverage into the bounded shape the step emits.
 *
 * Returns null for anything unusable, which is what makes the step's key
 * CONDITIONAL: absence is the signal for "no coverage evidence", and the
 * suppression predicate reads that absence as not-assessed rather than as
 * permission to advance.
 *
 * Never throws. A getter on a model-shaped object can throw on access, and a
 * malformed payload must degrade to "no evidence", not take down the ship.
 */
function normalizeAcCoverage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    return {
      assessed: raw.assessed === true,
      // STRICT COERCION, and note the direction is the OPPOSITE of `assessed`.
      // Only an explicit `false` marks the diff partial, because the partial
      // state PERMITS the advance — the loose outcome must require a positive
      // signal, never arise from an absent key. A raw spread here would defeat
      // the allowlist, which is a deliberate bound on a model-authored payload.
      assessable: raw.assessable !== false,
      covered: normalizeAcCoverageList(raw.covered),
      notCovered: normalizeAcCoverageList(raw.notCovered),
      uncertain: normalizeAcCoverageList(raw.uncertain),
    };
  } catch {
    return null;
  }
}

/**
 * Build the `review` shipStep for the off-rail gate.
 *
 * A SKIPPED review (policy disabled, or no resolvable project context) is not a
 * failed review and must never halt. A review that ran and could not produce a
 * verdict reports 'unavailable' — never 'pass', matching buildUnavailableReview.
 */
export function buildOffRailReviewStep(reviewResult) {
  const r = reviewResult || {};
  if (r.skipped) {
    return { step: "review", skipped: true, reason: r.reason || "review_skipped" };
  }
  const acCoverage = normalizeAcCoverage(r.acCoverage);
  const unavailable = r.reviewerUnavailable === true || r.llmFailed === true || r.ok === false;
  const verdict = unavailable
    ? (r.verdict && r.verdict !== "pass" ? r.verdict : "unavailable")
    : r.verdict;
  return {
    step: "review",
    ok: !unavailable,
    verdict,
    findingCount: r.findings?.length || 0,
    ...(unavailable ? { reviewerUnavailable: true, cause: normalizeReviewCause(r.cause) } : {}),
    ...(r.error ? { error: r.error } : {}),
    // What the reviewer actually SAID, when it answered but unparseably. Without
    // it the operator sees a truncated error string and cannot tell a prompt
    // defect from a dead model. CONDITIONAL: absent unless supplied, so the
    // strict toEqual shape pins on the other branches do not redden. Already
    // scrubbed of secret-shaped literals at the producer (review.mjs callReviewer).
    ...(unavailable && r.rawResponse !== undefined ? { rawResponse: r.rawResponse } : {}),
    ...(r.findings?.length ? { categories: [...new Set(r.findings.map((f) => f?.category).filter(Boolean))] } : {}),
    // Findings are carried through so a block verdict is actionable — counts
    // alone left ship 54602ef4 reporting 15 blockers nobody could investigate.
    //
    // CALLER CONTRACT: the review result passed here MUST already be redacted.
    // A finding's `line` holds up to 100 chars of the matched diff line, which
    // for a security pattern is the credential assignment itself. Redaction
    // happens in runOffRailEnforcementGate, which has review.mjs imported;
    // importing it here instead would pull @routekit/rag (lancedb, transformers)
    // into every load of this module.
    ...(r.findings?.length ? { findings: r.findings } : {}),
    // A policy-softened block is not a genuine warn. computeFinalVerdict records
    // which one happened; carry it through so the rks_guardrails_on response the
    // Dispatcher reads can explain its own verdict instead of contradicting the
    // findings sitting beside it.
    //
    // CONDITIONAL, DELIBERATELY. These keys must appear only when a downgrade
    // actually occurred: absence is the signal for "genuine verdict". The skipped
    // branch returns above and keeps its exact { step, skipped, reason } shape —
    // strict toEqual pins in tests/unit/review-findings-redaction.test.mjs and
    // tests/unit/off-rail-enforcement-helpers.test.mjs redden on any extra key.
    ...(r.downgradedFrom ? { downgradedFrom: r.downgradedFrom } : {}),
    ...(r.downgradedFrom && r.downgradeReason ? { downgradeReason: r.downgradeReason } : {}),
    // The acceptance-criteria evidence the phase-advance gate reads.
    //
    // CONDITIONAL, for the same reason as the keys above: the skipped early
    // return keeps its exact { step, skipped, reason } shape, and an absent key
    // is what the suppression predicate reads as "no evidence". Normalized and
    // bounded here, at the producer — the raw value is model-authored free text.
    ...(acCoverage ? { acCoverage } : {}),
  };
}

/**
 * Build the `scope_reconcile` shipStep by matching the changed set against the
 * allowedFiles snapshot.
 *
 * Enumerates EVERY violating path — not a count, not a truncated sample — because
 * the point is to tell the operator exactly what escaped the write-time hook.
 * Anchored on the changed set rather than the git index: the empty-index path
 * (work committed mid-session) still has to be reconciled.
 */
export function buildScopeReconcileStep({ changedFiles = [], allowedFiles = null, unevaluated = null } = {}) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    return { step: "scope_reconcile", skipped: true, reason: "no_scope" };
  }
  // NOTHING WAS OBSERVED — say so, rather than reporting a clean reconcile.
  //
  // `ok` is OMITTED, deliberately, never set to false. resolveOffRailHalt reads
  // `if (scopeStep?.ok === false) return "scope_violation"`, and `undefined ===
  // false` is false, so neither unevaluated flavour can reach that branch. An
  // `ok: false` here would instead fire the scope_violation halt under `block`
  // posture at BOTH gates — including gate alpha, on every empty-index ship —
  // which would ship the deferred halt-posture decision by accident. The
  // `no_scope` skip shape above already sets the precedent for an `ok`-less step.
  //
  // The cost is paid in collectFailedShipSteps, which ignores `ok`-less steps by
  // design and therefore gains one explicit rule for `manifest_unreadable`.
  //
  // NOT INFERRED FROM AN EMPTY MANIFEST: a commit that genuinely touched nothing
  // still takes the evaluated path below and reports ok:true. Unevaluated is a
  // state the caller declares, never one deduced from silence.
  if (unevaluated) {
    return {
      step: "scope_reconcile",
      evaluated: false,
      reason: unevaluated.reason,
      ...(unevaluated.error ? { error: unevaluated.error } : {}),
    };
  }
  const matches = (file) =>
    allowedFiles.some((pattern) => {
      if (pattern === file) return true;
      if (pattern.endsWith("*")) return file.startsWith(pattern.slice(0, -1));
      return false;
    });
  const violations = (changedFiles || []).filter((f) => f && !matches(f));
  return {
    step: "scope_reconcile",
    ok: violations.length === 0,
    inScopeCount: (changedFiles || []).length - violations.length,
    violations,
  };
}

/**
 * Every distinct category among a review step's `severity: "block"` findings.
 *
 * The gate used to read only the COLLAPSED verdict. computeFinalVerdict
 * (review.mjs) downgrades a block-severity finding to a `warn` verdict whenever
 * the finding's category is absent from `policy.blockCategories` — and the
 * default policy lists only enforcement_modification and security_issue, putting
 * ac_coverage and test_coverage (exactly what a reviewer raises most) in
 * warnCategories. So `offRail: block` was inert against "zero acceptance
 * criteria are implemented". The downgrade is correct policy; discarding the
 * severity on the way to the halt predicate was not.
 *
 * DEFENSIVE BY CONTRACT: buildOffRailReviewStep spreads `findings` onto the step
 * only under `r.findings?.length`, so the skipped and reviewer-unavailable paths
 * carry no `findings` key at all. Never throws on a missing, null or non-array
 * findings value, and never invents a category — an uncategorised block finding
 * still counts (see blockSeverityFindingCount) but contributes nothing here.
 */
export function blockSeverityCategories(reviewStep) {
  const findings = reviewStep?.findings;
  if (!Array.isArray(findings)) return [];
  return [
    ...new Set(
      findings
        .filter((f) => f && f.severity === "block")
        .map((f) => f?.category)
        .filter((c) => typeof c === "string" && c.length > 0),
    ),
  ];
}

/** How many of a review step's findings carry severity "block". Never throws. */
export function blockSeverityFindingCount(reviewStep) {
  const findings = reviewStep?.findings;
  if (!Array.isArray(findings)) return 0;
  return findings.filter((f) => f && f.severity === "block").length;
}

/**
 * The off-rail gate's halt decision, as a pure function.
 *
 * ONE implementation, exported so it is unit-testable without an LLM reviewer:
 * the integration fixtures run against an unregistered project, so runReview
 * always fails there and yields an `unavailable` verdict with NO findings —
 * there is no end-to-end route to a block-severity finding in CI. Follows the
 * exported-helper precedent already set by resolveOffRailPosture,
 * buildOffRailReviewStep and buildScopeReconcileStep.
 *
 * Branch order is load-bearing. review_block, review_unavailable and
 * scope_violation keep their exact prior meanings and their prior precedence, so
 * a genuine `verdict === "block"` — including one whose block-severity finding IS
 * in blockCategories — still reports review_block. review_block_finding is the
 * NEW, strictly-last branch: it fires only for a finding the policy downgraded,
 * which the collapsed verdict can never express. Keeping the two values distinct
 * keeps them separable in telemetry.
 *
 * Returns a haltReason string, or null for "do not halt".
 */
export function resolveOffRailHalt({
  posture,
  reviewStep,
  scopeStep,
  overrideApplied = false,
} = {}) {
  if (posture !== "block" || overrideApplied) return null;
  if (reviewStep?.verdict === "block") return "review_block";
  if (reviewStep?.reviewerUnavailable) return "review_unavailable";
  if (scopeStep?.ok === false) return "scope_violation";
  if (blockSeverityFindingCount(reviewStep) > 0) return "review_block_finding";
  return null;
}

/**
 * Whether the story's phase advance must be suppressed, as a pure function.
 *
 * Advisory posture stays advisory: the commit, the merge and the push all still
 * proceed, because off-rail is the documented escape hatch and refusing the
 * merge would wedge it. But advisory must not also mean "and mark the story
 * done". A review that found zero acceptance criteria implemented previously
 * ended with the story reconciled to `integrated` and that phase bump committed.
 * Refusing the PHASE ADVANCE costs the user nothing — the code still lands, the
 * branch still merges — and leaves the next run seeing work remaining.
 *
 * Reuses `downgradeReason` verbatim where backlog.fix.review-verdict-downgrade-
 * legibility supplied it, rather than recomputing the rationale; falls back to a
 * locally composed reason otherwise, and never emits the string "undefined".
 *
 * WHAT THE PHASE ADVANCE IS BOUND TO. Severity is a code-quality signal; it was
 * never a completion signal, and reading it as one let a review that assessed
 * NOTHING mark a story done, because a reviewer that never ran emits no findings
 * and no findings scored zero blockers. The advance is therefore bound to the
 * acceptance-criteria EVIDENCE, and "no evidence" is given its own state rather
 * than being folded into "nothing wrong".
 *
 * PREDICATE ORDER IS LOAD-BEARING: block -> skipped -> not-assessable -> coverage -> not-assessed.
 *
 *   1. Block-severity findings. First, and byte-identical to its prior output —
 *      everything that suppresses today still suppresses.
 *   2. A skipped review, and ONLY with reason "policy_disabled". That is the one
 *      producer of `skipped` that is a DECISION. "review_module_unavailable" and
 *      "no_project_context" are FAILURES, and letting a failure return null is a
 *      gate passing on a checker that did not run. This rule must precede rule 3:
 *      production never emits acCoverage on the skipped branch, but the unit call
 *      can, and under the reverse order that case would be unreachable.
 *   3. Coverage evidence, when it was actually assessed and is non-empty.
 *   4. Everything else — absent, malformed, unassessed, or assessed-but-empty —
 *      suppresses as `ac_coverage_not_assessed`. An all-empty coverage object
 *      carrying `assessed: true` is an echo of the prompt's example JSON, not an
 *      assessment.
 *
 * The default direction of rule 4 is SUPPRESS, deliberately: buildUnavailableReview
 * emits no findings at all, so a broken reviewer is exactly the input that used to
 * sail through. `advanceOnUnassessedAC` opts out, and is a recorded policy decision.
 *
 * The remedy is composed HERE, where the cause is known, and carried on the
 * returned object — not hardcoded at the shipSteps push site, which would pin a
 * constant to itself and would need a second copy to reach the response.
 *
 * Returns null when there is nothing to suppress, so callers can branch on it.
 */
const AC_REMEDY =
  "set advancePhaseOnUnassessedAC: true in .rks/review-policy.yaml to advance the " +
  "phase without acceptance-criteria evidence, or re-run the ship with a working reviewer";

export function resolvePhaseAdvanceSuppression(reviewStep, { advanceOnUnassessedAC = false } = {}) {
  // 1. Block severity — unchanged, and first.
  const findingCount = blockSeverityFindingCount(reviewStep);
  if (findingCount > 0) {
    const categories = blockSeverityCategories(reviewStep);
    const inherited = reviewStep?.downgradeReason;
    const reason =
      typeof inherited === "string" && inherited.length > 0
        ? inherited
        : categories.length > 0
          ? `block_severity_finding (${categories.join(", ")})`
          : "block_severity_finding";
    return { reason, categories, findingCount };
  }

  // 2. A recorded decision to not review. That reason and no other.
  if (reviewStep?.skipped === true && reviewStep?.reason === "policy_disabled") return null;

  // 3. NOT ASSESSABLE FROM THIS DIFF — the fourth state, and the only one that
  // PERMITS. The diff under review covers part of the story, so the criteria
  // satisfied by earlier commits could never appear in it. This differs from
  // rule 5 in a way that decides the outcome: a reviewer that produced no
  // evidence can produce some on a re-run, but a partial diff can NEVER widen —
  // `targetBranch: activeSession.headCommit` is fixed. Failing closed here would
  // be a permanent block whose only exit is a manual advance that adjudicates
  // nothing, so this returns a non-suppressing result carrying its reason.
  const coverage = reviewStep?.acCoverage;
  const usable = coverage && typeof coverage === "object" && !Array.isArray(coverage);
  if (usable && coverage.assessable === false) {
    return {
      reason:
        "ac_coverage_partial_diff (the diff under review spans only part of this story, so acceptance-criteria coverage could not be assessed from it)",
      suppress: false,
    };
  }

  // 4. Coverage evidence, when there is any.
  if (usable && coverage.assessed === true) {
    const notCovered = Array.isArray(coverage.notCovered) ? coverage.notCovered : [];
    const uncertain = Array.isArray(coverage.uncertain) ? coverage.uncertain : [];
    const covered = Array.isArray(coverage.covered) ? coverage.covered : [];
    if (notCovered.length > 0) {
      return {
        reason: `ac_not_covered (${notCovered.length} of the story's acceptance criteria are not covered)`,
        remedy: AC_REMEDY,
      };
    }
    if (uncertain.length > 0) {
      return {
        reason: `ac_coverage_uncertain (${uncertain.length} acceptance criteria have unclear coverage)`,
        remedy: AC_REMEDY,
      };
    }
    // Assessed, nothing outstanding, and something was actually examined.
    if (covered.length > 0) return null;
    // All three empty: falls through to rule 4. Nothing was examined.
  }

  // 5. No usable evidence. Suppress unless the opt-out is set.
  if (advanceOnUnassessedAC === true) return null;
  return {
    reason:
      "ac_coverage_not_assessed (the review produced no acceptance-criteria evidence, so story completion was never assessed)",
    remedy: AC_REMEDY,
  };
}

/**
 * Session-artifact path prefixes the off-rail auto-ship stages even though they
 * never appear in a story's `targetFiles`.
 *
 * REQUIRED, NOT INCIDENTAL. The ship legitimately writes outside the story scope:
 * `runHookDeploy` rewrites `.routekit/hooks/**` (and the generic template copy of
 * it), the session's own bookkeeping lives under `.rks/`, and the ship advances
 * the story note itself. Scoping the index to `allowedFiles` alone would strand
 * the hook restore/deploy dirty in the worktree and break the hook-deploy commit
 * that tests/integration/guardrails-on-syncs-hooks.test.mjs pins against
 * `git show` — "in the allowlist" is not enough, the deployed hook has to reach
 * the index.
 *
 * Matched as a PREFIX so it covers UNTRACKED as well as modified paths beneath
 * these roots; a freshly deployed hook is untracked the first time it lands.
 *
 * `.rks/` IS ENUMERATED, NOT A BARE PREFIX. It used to be `".rks/"`, which by
 * prefix match admitted `.rks/prompts/**` and `.rks/project.json` — tracked
 * SOURCE — under an allowance whose stated purpose is session bookkeeping. That
 * is how the ship for commit `a9093f0d` declared 5 allowedFiles and committed 9,
 * four of them governor prompts, while reporting `violations: []` and
 * `unstagedOutOfScope: []`: an artifact-admitted path is staged, so it never
 * reaches `unstagedPaths`, and it was filtered out of the reconcile input too, so
 * it appeared in neither report. Only the three files the session itself writes
 * belong here. Anything else under `.rks/` is source and must fall to
 * `unstagedOutOfScope` like any other out-of-scope path.
 */
const SHIP_ARTIFACT_PREFIXES = [
  ".routekit/hooks/",
  ".routekit/hooks-manifest.json",
  SESSION_LOG,
  SCOPE_FILE,
  GUARD_STATE_FILE,
  "templates/generic/.routekit/hooks/",
];

/** Normalize any path to a repo-relative, forward-slash path — git's own shape. */
function toRepoRelative(projectRoot, p) {
  if (!p) return null;
  const rel = path.isAbsolute(p) ? path.relative(projectRoot, p) : p;
  return rel.split(path.sep).join("/");
}

/**
 * Match a path against an `allowedFiles` pattern set.
 *
 * PARITY OBLIGATION — these are exactly `buildScopeReconcileStep`'s semantics
 * (exact equality, or a trailing-`*` prefix wildcard). Staging and reconciliation
 * MUST agree: narrower semantics here would leave a glob-scoped story's own files
 * unstaged, wider semantics would make the audit flag paths staging deliberately
 * included. Duplicated rather than extracted because `buildScopeReconcileStep`'s
 * body is deliberately frozen (its output shape is pinned by three suites).
 *
 * A pattern is never handed to `git add` as a literal pathspec — entries such as
 * `tests/unit/*` are resolved against real worktree paths here first.
 */
function matchesScopePattern(patterns, file) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (pattern === file) return true;
    if (typeof pattern === "string" && pattern.endsWith("*")) return file.startsWith(pattern.slice(0, -1));
    return false;
  });
}

/** True when a path is a session artifact the ship owns regardless of story scope. */
function isShipArtifactPath(file, noteRel = null) {
  if (noteRel && file === noteRel) return true;
  return SHIP_ARTIFACT_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix));
}

/**
 * THE admission rule — the single predicate for "this ship may carry this path".
 *
 * PARITY OBLIGATION, now discharged by construction rather than by comment.
 * Staging (buildShipScope) and reconciliation (the gate's manifest partition)
 * MUST agree on what is in scope. They used to be two expressions that happened
 * to match; a divergence would either strand a story's own files unstaged or make
 * the audit flag paths staging deliberately included. One function, two callers.
 */
function isShipAdmissiblePath(file, allowedFiles, noteRel = null) {
  return isShipArtifactPath(file, noteRel) || matchesScopePattern(allowedFiles, file);
}

/**
 * Read the ACTUAL file manifest of a commit that exists.
 *
 * This is the evidence the scope reconcile was missing. Reconciling against the
 * staging-time intent set can only ever confirm the intent; reconciling against
 * `git diff-tree` observes what the ship really produced.
 *
 * Reads the exit STATUS, not just stdout: a non-zero exit with empty stdout would
 * otherwise be indistinguishable from a commit that legitimately touched nothing,
 * which is the same silence this whole area keeps producing. Carries the same
 * explicit `timeout` the other spawns in this file use.
 *
 * EXPORTED so the failure path can be DRIVEN rather than hand-built. An assertion
 * on a literal `{ error: ... }` object proves only that buildScopeReconcileStep
 * reshapes it; it cannot prove a real `git diff-tree` failure produces that shape
 * in the first place. A bogus SHA against a real repo does.
 *
 * @returns {{paths: string[]}|{error: string}} never both, never throws
 */
export function readCommitManifest(projectRoot, commitId) {
  // `--root` IS LOAD-BEARING, not decoration. Without it `git diff-tree` prints
  // NOTHING for a commit with no parent — it has nothing to diff against — and
  // exits 0. An initial commit would therefore have produced an empty manifest
  // that reconciled to `ok: true, violations: [], inScopeCount: 0`: a false clean,
  // which is precisely the defect this function exists to close, reintroduced at
  // its own source. A positive control on a real repo caught it.
  //
  // KNOWN LIMIT, stated rather than hidden: `diff-tree` is likewise silent for a
  // MERGE commit without `-m`/`--cc`. The ship only ever passes its own
  // single-parent work commit (created at the `commit` shipStep, before any
  // merge), so that case is unreachable from here — but a future caller passing a
  // merge SHA would get an empty manifest, not an error.
  const run = spawnSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commitId], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) return { error: run.error.message };
  if (run.status !== 0) {
    return { error: (run.stderr || "").trim() || `git diff-tree exited ${run.status}` };
  }
  return { paths: (run.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean) };
}

/**
 * Partition a real commit manifest into the three sets the ship must account for.
 *
 * EXHAUSTIVE AND DISJOINT by construction — every manifest path lands in exactly
 * one bucket, so no committed path can be invisible in every report. That was the
 * defect: an artifact-admitted path was staged (so absent from `unstagedPaths`)
 * AND filtered out of the reconcile input (so absent from `violations`).
 *
 *   inScope     — matches allowedFiles. The announced scope.
 *   admitted    — outside allowedFiles but owned by the ship (hook deploy, session
 *                 bookkeeping, the story note). Legitimate, but must be NAMED.
 *   violations  — outside allowedFiles and not owned by the ship. The real thing
 *                 `violations` was always supposed to mean.
 */
function partitionCommitManifest(paths, allowedFiles, noteRel = null) {
  const inScope = [];
  const admitted = [];
  const violations = [];
  for (const p of paths) {
    if (matchesScopePattern(allowedFiles, p)) inScope.push(p);
    else if (isShipArtifactPath(p, noteRel)) admitted.push(p);
    else violations.push(p);
  }
  return { inScope, admitted, violations };
}

/**
 * Enumerate every dirty or untracked path as a repo-relative path.
 *
 * `-z` sidesteps git's path quoting (a path with a space or a quote would
 * otherwise come back mangled and stage nothing); `-uall` lists files inside
 * untracked directories individually, so an untracked hook deploy is addressable
 * by name rather than only by its parent directory.
 */
function listWorktreePaths(projectRoot) {
  const run = spawnSync("git", ["status", "--porcelain", "-z", "-uall"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (run.error) return { paths: [], error: run.error.message };
  if (run.status !== 0) {
    return { paths: [], error: (run.stderr || "").trim() || `git status --porcelain exited ${run.status}` };
  }
  const records = (run.stdout || "").split("\0");
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec || rec.length < 4) continue;
    paths.push(rec.slice(3));
    // A rename/copy record carries its ORIGINAL path as the NEXT NUL-delimited
    // field. Stage both halves or the rename is split across the boundary.
    if (rec[0] === "R" || rec[0] === "C") {
      const from = records[i + 1];
      i += 1;
      if (from) paths.push(from);
    }
  }
  return { paths };
}

/**
 * Partition the worktree into what this off-rail session may stage and what it
 * must leave alone.
 *
 * The ship scope is the session's `allowedFiles` UNION the session-artifact
 * allowlist above. Out-of-scope paths are returned rather than dropped, because
 * the caller has to enumerate every one of them — silence is the failure mode
 * this whole area keeps producing.
 *
 * `scoped: false` means "stage everything" and is returned for two distinct
 * reasons, both deliberate:
 *   - `no_scope`  — the session has no `allowedFiles` (no problemId, or a story
 *     with no targetFiles). The escape hatch must still ship; committing nothing
 *     would wedge exactly the sessions with the least structure.
 *   - `enumeration_failed` — git could not describe the worktree. Falling back to
 *     the historical sweep is safer than silently committing a partial set from a
 *     list we know is incomplete.
 *
 * @param {{projectRoot: string, allowedFiles?: string[]|null, notePath?: string|null}} args
 * @returns {{scoped: boolean, reason?: string, error?: string, stagePaths: string[], unstagedPaths: string[]}}
 */
export function buildShipScope({ projectRoot, allowedFiles = null, notePath = null } = {}) {
  if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
    return { scoped: false, reason: "no_scope", stagePaths: [], unstagedPaths: [] };
  }
  const listed = listWorktreePaths(projectRoot);
  if (listed.error) {
    return { scoped: false, reason: "enumeration_failed", error: listed.error, stagePaths: [], unstagedPaths: [] };
  }
  const noteRel = toRepoRelative(projectRoot, notePath);
  const stagePaths = [];
  const unstagedPaths = [];
  for (const p of new Set(listed.paths)) {
    if (isShipAdmissiblePath(p, allowedFiles, noteRel)) stagePaths.push(p);
    else unstagedPaths.push(p);
  }
  return { scoped: true, stagePaths, unstagedPaths };
}

/**
 * The step-failure rule, mirrored from `reduceShipOk` in story-ship.mjs:
 * `ok === false` is a failure, and a step that merely OMITS `ok` (the
 * `{ step, skipped: true, reason }` shape the gate pushes for a suppressed
 * advance_phase) is a legitimate skip, not a failure. Deliberately NOT
 * `every(s => s.ok === true)` — that predicate treats every skip as a failure.
 *
 * Returns the names of the failed steps, in the order they were recorded, so a
 * caller never has to walk shipSteps to find out what degraded. A missing or
 * non-array shipSteps yields an empty list rather than throwing.
 */
function collectFailedShipSteps(response) {
  const steps = response?.shipSteps;
  if (!Array.isArray(steps)) return [];
  const failed = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (step.ok === false) { failed.push(step.step); continue; }
    // THE ONE EXCEPTION to the omits-`ok`-is-a-skip rule above.
    //
    // An unevaluated scope_reconcile step omits `ok` so it cannot trip the
    // scope_violation halt (see buildScopeReconcileStep). That is correct for the
    // halt, and wrong for the outcome: without this rule a ship whose containment
    // could not be observed would resolve to a clean `shipped`, which is the very
    // report-without-evidence this story exists to close, reintroduced one field
    // over.
    //
    // Only `manifest_unreadable` counts. `no_commit` is gate alpha, where no
    // commit exists to make a containment claim ABOUT — nothing was falsified,
    // and that path already reports its own outcome through the empty-index
    // early return.
    if (
      step.step === "scope_reconcile"
      && step.evaluated === false
      && step.reason === "manifest_unreadable"
    ) {
      failed.push(step.step);
    }
  }
  return failed;
}

/**
 * Classify what actually happened to the auto-ship, as one required field.
 *
 * `ok` deliberately does NOT mean "the ship succeeded" — it scopes the
 * guardrails-restore operation (hooks restored, session ended, scope file
 * removed), all of which genuinely succeed even when a ship throws. That left
 * no field meaning "did the ship work", so a crash, a policy halt and a no-op
 * were indistinguishable: all three returned ok:true with autoShipped:false.
 * A real CI failure surfaced as `expected [] to have a length of 1` because of
 * it.
 *
 * Derived rather than hand-set at each exit, so a new exit cannot forget it.
 * Order matters: an error outranks a halt, a halt outranks a completed ship.
 *
 *   failed               — threw, or a git operation reported failure
 *   halted               — the enforcement gate stopped it on purpose; work preserved
 *   shipped              — merged and pushed, every step clean
 *   shipped_with_failures — merged and pushed, but at least one step reported ok:false
 *   nothing_to_ship      — nothing staged and nothing unpushed
 *   skipped              — the caller suppressed the auto-ship
 *
 * `shipped_with_failures` is deliberately NOT `failed`. `failed` is the
 * shipError outcome and means the integration did not land, which sends
 * recovery down a path that would try to redo a merge that already happened.
 * A failed `delete-branch`, `cycle_complete`, `advance_phase` or `ship-note`
 * step leaves a landed merge plus something a human still has to finish.
 * Continuing after those failures is correct and unchanged by this — the
 * defect was that continuing was indistinguishable from succeeding.
 */

export function resolveShipOutcome(response) {
  if (!response || typeof response !== "object") return "skipped";
  if (response.shipError) return "failed";
  if (response.haltReason) return "halted";
  if (response.autoShipSuppressed) return "skipped";
  if (response.autoShipped === true) {
    // The ONLY branch the step reduction touches: everything above still
    // outranks it, so a shipError, a halt or a suppressed auto-ship resolves
    // exactly as it did before, failed steps or not.
    return collectFailedShipSteps(response).length > 0
      ? "shipped_with_failures"
      : "shipped";
  }
  if (response.autoShipped === false) return "nothing_to_ship";
  return "skipped";
}

/**
 * Stamp the derived outcome onto a response immediately before returning it.
 *
 * ALSO the single site that names the failed steps. resolveShipOutcome stays a
 * pure, non-mutating read of the response — its unit suite exercises it over
 * hand-built and deep-frozen objects, so stamping inside it would throw — which
 * is why the naming lives here and not there.
 *
 * The key is deliberately NOT `autoShipSuppressed`: that name ranks ABOVE
 * `autoShipped` in resolveShipOutcome's precedence chain, so reusing it would
 * report a merge that actually landed as "skipped".
 *
 * Stamped only when something actually failed. An absent key means "no failed
 * steps"; it is never an empty array a reader has to distinguish from silence.
 */
export function finalizeShipOutcome(response) {
  response.shipOutcome = resolveShipOutcome(response);
  const failedSteps = collectFailedShipSteps(response);
  if (failedSteps.length > 0) response.failedShipSteps = failedSteps;
  return response;
}

/**
 * The off-rail auto-ship enforcement gate. ONE helper, TWO call sites.
 *
 * Before this existed the auto-ship block had no enforcement layer of any kind:
 * no code review, and no re-check of the session's write scope. It is invoked at
 * both pre-integration points so no committing or pushing exit can escape it —
 * gate alpha covers the empty-index path (work committed mid-session, then pushed
 * directly), gate beta covers the main commit → merge → push → note path.
 *
 * Never throws. A reviewer that errors becomes an `unavailable` verdict; a review
 * that was deliberately not asked becomes a `skipped` step, which is NOT a halt
 * under any posture — a reviewer nobody called is not a reviewer that failed.
 *
 * The policy is loaded HERE, with the off-rail projectRoot, rather than relying on
 * runReview's own registry lookup (review.mjs resolves projectRoot from
 * loadContext(projectId), which cannot see a fixture root and throws for an
 * unregistered id).
 */
async function runOffRailEnforcementGate({
  projectRoot,
  projectId,
  activeSession,
  changedFiles,
  allowedFiles,
  gate,
  override,
  // The commit to reconcile AGAINST. Null at gate alpha, where the index is empty
  // and this ship produced no commit — that call site gets the `no_commit`
  // unevaluated step rather than a reconcile of intent against itself.
  commitId = null,
  noteRel = null,
}) {
  let reviewMod = null;
  try {
    reviewMod = await import("./review.mjs");
  } catch { /* review module unavailable — recorded as a skip, never a halt */ }

  const policy = reviewMod?.loadReviewPolicy ? reviewMod.loadReviewPolicy(projectRoot) : null;
  const posture = resolveOffRailPosture(policy);

  let reviewResult;
  if (!reviewMod) {
    reviewResult = { skipped: true, reason: "review_module_unavailable" };
  } else if (!policy?.enabled) {
    reviewResult = { skipped: true, reason: "policy_disabled" };
  } else if (!projectId || projectId === "unknown") {
    // guardrailsOn's projectId defaults to "unknown"; runReview would throw in
    // loadContext rather than degrade, so do not call it at all.
    reviewResult = { skipped: true, reason: "no_project_context" };
  } else {
    try {
      reviewResult = await reviewMod.runReview({
        projectId,
        problemId: activeSession.problemId,
        branch: activeSession.branch,
        // A commit SHA is a valid ref for getDiff's `${targetBranch}...HEAD`.
        // headCommit is an ancestor of HEAD at both gates, so this reduces to
        // <headCommit>..HEAD — exactly this session's commits, on 2- and
        // 3-branch topologies alike, with no previously-merged history.
        targetBranch: activeSession.headCommit,
      });
    } catch (err) {
      reviewResult = reviewMod.buildUnavailableReview
        ? reviewMod.buildUnavailableReview({ error: err?.message ?? String(err), cause: "call_failed" })
        : { reviewerUnavailable: true, llmFailed: true, cause: "call_failed", error: err?.message ?? String(err) };
    }
  }

  // Redact HERE — this is the one place with review.mjs already loaded, and
  // buildOffRailReviewStep's caller contract requires it.
  const reviewStep = buildOffRailReviewStep(
    reviewMod?.redactReview ? reviewMod.redactReview(reviewResult) : reviewResult,
  );
  // SCOPE RECONCILE, SOURCED FROM THE COMMIT — not from `changedFiles`.
  //
  // `changedFiles` is the staging-time intent set, already filtered by
  // allowedFiles at the call site. Reconciling it against allowedFiles was a
  // tautology: every non-matching element had been removed before it arrived, so
  // `violations` was `[]` for every scoped session on every input, and the field
  // named an evaluation that never happened. It is still passed, because the
  // no-scope and unevaluated shapes do not need a manifest.
  let scopeStep;
  let artifactAdmissions = [];
  const scoped = Array.isArray(allowedFiles) && allowedFiles.length > 0;
  if (!scoped) {
    scopeStep = buildScopeReconcileStep({ changedFiles, allowedFiles });
  } else if (!commitId) {
    scopeStep = buildScopeReconcileStep({ allowedFiles, unevaluated: { reason: "no_commit" } });
  } else {
    const manifest = readCommitManifest(projectRoot, commitId);
    if (manifest.error) {
      scopeStep = buildScopeReconcileStep({
        allowedFiles,
        unevaluated: { reason: "manifest_unreadable", error: manifest.error },
      });
    } else {
      const parts = partitionCommitManifest(manifest.paths, allowedFiles, noteRel);
      // Feed the reconcile everything EXCEPT the ship-owned admissions, so
      // `violations` carries exactly the paths nothing authorised — and
      // inScopeCount counts exactly the announced scope. The admissions are not
      // dropped; they are reported separately, which is the whole point.
      scopeStep = buildScopeReconcileStep({
        changedFiles: [...parts.inScope, ...parts.violations],
        allowedFiles,
      });
      artifactAdmissions = parts.admitted;
    }
  }

  const overrideApplied = posture === "block" && Boolean(override?.enabled);
  // THE one halt decision. Both gates inherit it from here; neither call site
  // re-implements it and neither call site scans findings of its own.
  const haltReason = resolveOffRailHalt({ posture, reviewStep, scopeStep, overrideApplied });

  // Bound ONCE here: the return literal reads it twice, and a second call would
  // break the exactly-two-call-sites invariant a withheld guard suite pins.
  const phaseAdvanceOutcome = resolvePhaseAdvanceSuppression(reviewStep, {
    advanceOnUnassessedAC: policy?.advancePhaseOnUnassessedAC === true,
  });

  const steps = [reviewStep, scopeStep];
  if (overrideApplied) {
    steps.push({
      step: "enforcement_override",
      ok: true,
      gate,
      reason: override.reason,
    });
  }

  return {
    posture,
    steps,
    haltReason,
    haltedAt: haltReason ? gate : null,
    reviewVerdict: reviewStep.skipped ? "skipped" : (reviewStep.verdict ?? null),
    scopeViolations: scopeStep.violations?.length ?? 0,
    // Committed paths the ship owns but the story never declared. Surfaced on the
    // RESPONSE by the caller, never on a shipSteps entry — these are precisely
    // `.routekit/hooks/**` strings, and
    // tests/unit/guardrails-on-hook-sync-ordering.test.mjs asserts no shipSteps
    // entry stringifies to a /hook|sync|drift/i match.
    artifactAdmissions,
    overrideApplied,
    overrideReason: overrideApplied ? override.reason : null,
    // The block-severity signal, surfaced once so BOTH callers inherit it.
    blockFindingCategories: blockSeverityCategories(reviewStep),
    // null, or { reason, remedy? } / { reason, categories, findingCount }.
    // Deliberately NOT named autoShipSuppressed: resolveShipOutcome ranks that
    // key above autoShipped and would reclassify a landed merge as "skipped".
    //
    // A NULL policy fails CLOSED to suppress: `policy` is null when review.mjs
    // could not be loaded at all, which is precisely the reviewer-broken case
    // this gate exists to stop advancing on.
    // NARROWED HERE, NOT AT THE CONSUMER. The consumer branches on truthiness,
    // and both that line and its assignment are pinned as source text by a guard
    // suite this story may not edit. So a non-suppressing outcome is published
    // as null, letting control fall to the existing `else` arm and reach the
    // sole reconcileToIntegrated call untouched.
    //
    // The consequence is worth stating: `response.phaseAdvanceSuppressed` is
    // then absent on a permit STRUCTURALLY — the branch that assigns it is never
    // entered — rather than by a coded exception someone could later delete.
    phaseAdvanceSuppression: phaseAdvanceOutcome?.suppress === false ? null : phaseAdvanceOutcome,
    // The reason survives the narrowing, so a permitted-under-partial-diff
    // advance stays distinguishable from a clean one. Named to carry neither
    // "severity" nor a findings access, because it is READ inside guardrailsOn
    // where a guard forbids both.
    phaseAdvanceNotice: phaseAdvanceOutcome?.suppress === false ? phaseAdvanceOutcome.reason : null,
  };
}

/**
 * Resolve the offRail config mode from project.json contents.
 * Returns one of:
 *   { mode: 'disabled' }                  — projectJson.offRail.enabled === false
 *   { mode: 'configured', roots }         — enabled === true with non-empty roots array
 *   { mode: 'default' }                   — offRail field absent (use RKS_CORE_PATTERNS)
 *   { mode: 'invalid', error }            — malformed config; do not throw
 */
export function resolveOffRailConfig(projectJson) {
  if (projectJson === null || projectJson === undefined) return { mode: 'default' };
  const offRail = projectJson.offRail;
  if (offRail === undefined || offRail === null) return { mode: 'default' };
  if (typeof offRail !== 'object' || Array.isArray(offRail)) {
    return { mode: 'invalid', error: 'offRail must be an object with `enabled` and `roots`' };
  }
  if (typeof offRail.enabled !== 'boolean') {
    return { mode: 'invalid', error: 'offRail.enabled must be a boolean' };
  }
  if (offRail.enabled === false) return { mode: 'disabled' };
  // enabled === true
  if (!Array.isArray(offRail.roots)) {
    return { mode: 'invalid', error: 'offRail.roots must be an array of pattern strings' };
  }
  if (offRail.roots.length === 0) {
    return { mode: 'invalid', error: 'offRail.roots must be a non-empty array' };
  }
  if (offRail.roots.some(r => typeof r !== 'string')) {
    return { mode: 'invalid', error: 'offRail.roots entries must be strings' };
  }
  return { mode: 'configured', roots: offRail.roots };
}

/**
 * Trailing-`*` prefix-wildcard match (e.g. `components/*` matches `components/Foo.tsx`).
 * Consistent with RKS_CORE_PATTERNS `startsWith` semantics.
 */
function matchesOffRailRoot(filePath, pattern) {
  const prefix = pattern.replace(/\/\*$/, '/').replace(/\*$/, '');
  return filePath.startsWith(prefix);
}

function targetFilesMatchRoots(targetFiles, roots) {
  if (!Array.isArray(targetFiles) || targetFiles.length === 0) return true;
  return targetFiles.every(f => roots.some(r => matchesOffRailRoot(f, r)));
}

function getOffRailRootsGuidance(targetFiles, roots) {
  const fileList = targetFiles?.slice(0, 5).map(f => `  - ${f}`).join('\n') || '  (none specified)';
  const rootList = roots.map(r => `  - ${r}`).join('\n');
  return `⛔ Off-rail rejected: targetFiles do not match this project's configured offRail.roots.

## Your Target Files
${fileList}

## Configured offRail.roots (from .rks/project.json)
${rootList}

To allow this scope, either add a matching pattern to offRail.roots in .rks/project.json,
or scope the story to files within the existing roots.`;
}

/**
 * Build the deny-list for framework-update tier.
 * Lists project-layer paths that framework writes must not touch.
 */
function buildFrameworkDenyList() {
  return ['notes/', 'CLAUDE.md', '.claude/'];
}

/**
 * Get the routekit-shell root directory.
 * The MCP server lives at packages/mcp-rks/src/server/ within routekit-shell.
 */
function getRoutekitShellRoot() {
  // __dirname equivalent for ESM - go up from server/ to routekit-shell root
  const serverDir = path.dirname(new URL(import.meta.url).pathname);
  // serverDir = .../routekit-shell/packages/mcp-rks/src/server
  // Go up 4 levels to get to routekit-shell root
  return path.resolve(serverDir, '..', '..', '..', '..');
}

/**
 * Check if we're in a child project (not routekit-shell itself)
 */
function isChildProject(projectRoot) {
  const rksRoot = getRoutekitShellRoot();
  return path.resolve(projectRoot) !== path.resolve(rksRoot);
}

/**
 * Check if targetFiles include RKS core files
 */
function isRksCoreWork(targetFiles) {
  if (!targetFiles || targetFiles.length === 0) {
    // No targetFiles = can't determine scope, allow off-rail (assume core)
    return true;
  }
  return targetFiles.some(f => RKS_CORE_PATTERNS.some(p => f.startsWith(p)));
}

/**
 * Get guidance for child project agents
 */
function getChildProjectGuidance() {
  return `⛔ Guardrails-off requests from child projects are not permitted.

## FAQ: Common Issues and Solutions

**Q: I need to read a file but it's blocked?**
A: Use \`rks_rag_query\` to search for content, or \`rks_code_context\` for specific files.

**Q: I need to edit a file but the hook blocks me?**
A: Use the on-rail workflow: \`rks_plan\` → \`rks_exec\` → \`rks_story_ship\`

**Q: I need to create or edit a note?**
A: Use \`dendron_create_note\` or \`dendron_edit_note\`.

**Q: I need to commit changes?**
A: Use \`rks_git_commit\` for commits, \`rks_staging_pr\` for PRs.

**Q: The planner keeps failing?**
A: Check that your story has valid SEARCH/REPLACE blocks and correct targetFiles.

**Q: Tests are failing during exec?**
A: Use \`skipTests: true\` if tests aren't relevant, or fix the test failures first.

## Still Stuck?

If the FAQ doesn't answer your issue, raise a bug with the human:

"I'm blocked on [specific task]. I tried [what you tried]. The FAQ doesn't cover this case.
Can you help me find an MCP tool for this, or should I file a bug for missing tooling?"

The human will either point you to the right tool or escalate to the RKS agent.`;
}

/**
 * Get guidance for RKS agent doing non-core work
 */
function getRksNonCoreGuidance(targetFiles) {
  const fileList = targetFiles?.slice(0, 5).map(f => `  - ${f}`).join('\n') || '  (none specified)';

  return `⚠️ You're requesting off-rail access, but your current work doesn't involve RKS core files.

## Your Target Files
${fileList}

## Core File Patterns (off-rail appropriate)
- \`packages/*\` - MCP server, CLI, design system
- \`.routekit/*\` - Hooks, templates
- \`templates/*\` - Project scaffolding
- \`scripts/mcp/*\`, \`packages/rag/src/*\` - Tooling scripts

## Use MCP tools instead for non-core work:

**For code changes:**
\`rks_plan\` → \`rks_exec\` → \`rks_story_ship\`

**For notes/docs:**
\`dendron_create_note\`, \`dendron_edit_note\`

**For research:**
\`rks_rag_query\`, \`rks_code_context\`

**For git operations:**
\`rks_git_commit\`, \`rks_staging_pr\`, \`rks_story_ship\`

## Still Stuck?

If there's no suitable MCP tool for what you need, raise a bug with the human:

"I need to [specific task] but there's no MCP tool for this. Should I:
1. Go off-rail for this specific task?
2. File a bug for missing tooling?"`;
}

/**
 * Load targetFiles from a story note.
 * @param {string} projectRoot - Project root directory
 * @param {string} problemId - Story ID (e.g., "backlog.feat.my-feature")
 * @returns {string[]|null} Array of target file patterns or null if not found
 */
function loadStoryTargetFiles(projectRoot, problemId) {
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const notePath = path.join(notesDir, `${problemId}.md`);
    if (!fs.existsSync(notePath)) return null;

    const raw = fs.readFileSync(notePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const files = parsed?.data?.targetFiles || null;
    if (!files) return null;
    return normalizeTargetFiles(files).map(t => t.path);
  } catch (e) {
    console.error(`[guardrails] Failed to load targetFiles for ${problemId}: ${e.message}`);
    return null;
  }
}

/**
 * Write scope file for enforcement hook.
 * @param {string} projectRoot - Project root directory
 * @param {object} scopeData - Scope data including allowedFiles, sessionId, etc.
 */
function writeScopeFile(projectRoot, scopeData) {
  const scopePath = path.join(projectRoot, SCOPE_FILE);
  const scopeDir = path.dirname(scopePath);
  if (!fs.existsSync(scopeDir)) {
    fs.mkdirSync(scopeDir, { recursive: true });
  }
  fs.writeFileSync(scopePath, JSON.stringify(scopeData, null, 2));
  return scopePath;
}

/**
 * Remove scope file (called by guardrailsOn).
 * @param {string} projectRoot - Project root directory
 */
export function removeScopeFile(projectRoot) {
  const scopePath = path.join(projectRoot, SCOPE_FILE);
  try {
    if (fs.existsSync(scopePath)) {
      fs.unlinkSync(scopePath);
      return true;
    }
  } catch (e) {
    console.error(`[guardrails] Failed to remove scope file: ${e.message}`);
  }
  return false;
}

/**
 * Write guardrails state file.
 * Hooks read this file to determine whether to enforce.
 */
function writeGuardState(projectRoot, state) {
  const statePath = path.join(projectRoot, GUARD_STATE_FILE);
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Clear guardrails state file (restore to active/enforcing).
 */
function clearGuardState(projectRoot) {
  writeGuardState(projectRoot, {
    active: true,
    scope: null,
    sessionId: null,
    sessionType: null,
    reason: null,
    disabledTiers: [],
  });
}

/**
 * Read current guardrails state.
 */
function readGuardState(projectRoot) {
  const statePath = path.join(projectRoot, GUARD_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { active: true, disabledTiers: [] };
  }
}

/**
 * Map scope to disabled tiers.
 * "all" disables read + write. "write" disables write only. "read" disables read only.
 * System tier is never disabled.
 */
function scopeToDisabledTiers(scope) {
  switch (scope) {
    case "all": return ["read", "write"];
    case "write": return ["write"];
    case "read": return ["read"];
    default: return ["read", "write"];
  }
}

/**
 * Load hooks manifest for tier classification.
 * Returns a Map of hookName → { tier: "read"|"write"|"system" }.
 * Hooks not in manifest default to "write" (conservative — disabled when in doubt).
 */
function loadHooksManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, HOOKS_MANIFEST);
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
  } catch (e) {
    console.error(`[guardrails] Failed to read hooks manifest: ${e.message}`);
  }
  return {};
}

/**
 * Get tier for a hook name. Defaults to "write" if not in manifest.
 */
function getHookTier(manifest, hookName) {
  const entry = manifest[hookName];
  return entry?.tier || "write";
}

/**
 * Classify hooks in a directory by tier.
 * Returns { write: [...], read: [...], system: [...] }
 */
function classifyHooks(projectRoot, manifest) {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const result = { write: [], read: [], system: [] };
  if (!fs.existsSync(hooksPath)) return result;

  try {
    for (const tier of ['system', 'write', 'read']) {
      const tierDir = path.join(hooksPath, tier);
      if (!fs.existsSync(tierDir)) continue;
      const files = fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs'));
      result[tier].push(...files);
    }
  } catch (e) {
    console.error(`[guardrails] Failed to classify hooks: ${e.message}`);
  }
  return result;
}

/**
 * Get current git state
 */
function getGitState(projectRoot) {
  try {
    const head = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();
    const branch = execSync("git branch --show-current", { cwd: projectRoot, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf8" }).trim();
    return { head, branch, dirty: dirty.length > 0 };
  } catch (e) {
    return { head: null, branch: null, dirty: false, error: e.message };
  }
}

/**
 * Get changed files since a commit.
 *
 * `sinceCommit` is passed as an ARGV ELEMENT, never interpolated into a shell
 * string: it originates from the session log, so a ref carrying shell
 * metacharacters would otherwise execute as a second command. spawnSync with an
 * argv array runs git directly — no shell — so metacharacters are inert.
 *
 * The returned `error` field is LOAD-BEARING. A hard git failure (bogus ref,
 * rebased-away commit, undefined ref) yields total:0, which is byte-identical to
 * a genuinely clean worktree. Every caller MUST read `.error` to tell those two
 * apart; treating an errored count as "no changes" is what let a failed change
 * count report as a successful ship.
 *
 * @param {string} projectRoot
 * @param {string} sinceCommit
 * @returns {{changed: string[], newFiles: string[], total: number, error?: string}}
 */
function getChangedFilesSince(projectRoot, sinceCommit) {
  try {
    const diffRun = spawnSync("git", ["diff", "--name-only", sinceCommit], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (diffRun.error) throw diffRun.error;
    if (diffRun.status !== 0) {
      throw new Error(
        `git diff --name-only exited ${diffRun.status}: ${(diffRun.stderr || "").trim() || "no stderr"}`,
      );
    }
    const untrackedRun = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (untrackedRun.error) throw untrackedRun.error;
    if (untrackedRun.status !== 0) {
      throw new Error(
        `git ls-files --others exited ${untrackedRun.status}: ${(untrackedRun.stderr || "").trim() || "no stderr"}`,
      );
    }
    const diff = (diffRun.stdout || "").trim();
    const untracked = (untrackedRun.stdout || "").trim();
    const changed = diff ? diff.split("\n").filter(Boolean) : [];
    const newFiles = untracked ? untracked.split("\n").filter(Boolean) : [];
    return { changed, newFiles, total: changed.length + newFiles.length };
  } catch (e) {
    return { changed: [], newFiles: [], total: 0, error: e.message };
  }
}

/**
 * Append session entry to log file
 */
function appendSessionLog(projectRoot, entry) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  const logDir = path.dirname(logPath);

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  return logPath;
}

/**
 * Get active session (if any)
 *
 * Merges start/end JSONL entries by sessionId before checking,
 * since guardrailsOn() appends a separate end entry rather than
 * updating the original start entry.
 */
function getActiveSession(projectRoot) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  if (!fs.existsSync(logPath)) return null;

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  // Merge entries by sessionId (same logic as getSessionHistory)
  const sessionMap = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry.sessionId) continue;
      const existing = sessionMap.get(entry.sessionId) || {};
      sessionMap.set(entry.sessionId, { ...existing, ...entry });
    } catch (e) {
      continue;
    }
  }

  // Find the most recent session that has startedAt but no endedAt
  let latest = null;
  for (const session of sessionMap.values()) {
    if (session.startedAt && !session.endedAt) {
      if (!latest || new Date(session.startedAt) > new Date(latest.startedAt)) {
        latest = session;
      }
    }
  }
  return latest;
}

/**
 * Classify the story-note gate for rks_guardrails_off.
 *
 * This used to be a single `storyPhase !== 'arch-approved'` test whose subject
 * stayed null in three structurally different situations — note absent from the
 * worktree, note present with no phase field, and a swallowed read/parse throw —
 * all of which reported `story_not_ready` with "(current: not found)". Only the
 * middle one is a phase problem. A note that lives on another branch is a BRANCH
 * problem, and the advice attached to story_not_ready ("run PO → QA → ARCH") is
 * actively wrong for it: the story is frequently already arch-approved elsewhere.
 *
 * Pure by construction — the caller resolves every field and does all fs/git I/O,
 * mirroring the resolveOffRailConfig precedent above, so the reason logic is
 * testable in tests/unit where the purity guard rejects spawn-family calls.
 *
 * @param {object} descriptor
 * @param {string} descriptor.problemId
 * @param {string|null} descriptor.notePath          resolved path the note was looked for at
 * @param {boolean} descriptor.noteExists            whether that path exists in this worktree
 * @param {string|null} descriptor.phase             frontmatter phase, when the note was read
 * @param {Error|string|null} descriptor.readError   read/parse failure, if one occurred
 * @param {string|null} descriptor.archivedNotePath  backlog.z_implemented.* counterpart, if present
 * @param {string|null} descriptor.branch            current branch ('HEAD' when detached)
 * @returns {{ok: true} | {ok: false, reason: string, storyId: string, branch: string|null, notePath: string|null, message: string}}
 */
export function classifyStoryGate({
  problemId,
  notePath = null,
  noteExists = false,
  phase = null,
  readError = null,
  archivedNotePath = null,
  branch = null,
} = {}) {
  // getCurrentBranch returns the literal 'HEAD' on a detached checkout and null
  // when it cannot resolve at all — both must read as "no branch", not as a name.
  const onBranch = Boolean(branch) && branch !== 'HEAD';
  const branchLabel = onBranch ? `\`${branch}\`` : '(detached HEAD / no current branch)';
  const pathLabel = notePath ?? '<unresolved notes directory>';
  const common = {
    ok: false,
    storyId: problemId,
    branch: branch ?? null,
    notePath,
  };

  // Order matters: a read failure must not be mistaken for an absent note.
  if (readError) {
    const detail = readError?.message ?? String(readError);
    return {
      ...common,
      reason: 'story_note_unreadable',
      message: `Story note for ${problemId} at ${pathLabel} could not be read or parsed on branch ${branchLabel}: ${detail}. Fix or restore the note, then retry.`,
    };
  }

  if (!noteExists) {
    const archivedNote = archivedNotePath
      ? ` A shipped counterpart exists at ${archivedNotePath}, so this story appears to have already shipped and been archived.`
      : '';
    return {
      ...common,
      reason: 'story_note_not_on_branch',
      message: `Story note for ${problemId} is not present in the worktree on branch ${branchLabel} (looked for ${pathLabel}). This is a branch problem, not a phase problem: check out a branch that contains the note, then retry.${archivedNote}`,
    };
  }

  if (phase !== PHASE_GATE_GUARDRAIL) {
    const phaseLabel = phase ? `${phase}` : 'no phase field in frontmatter';
    return {
      ...common,
      reason: 'story_not_ready',
      message: `Story ${problemId} has not reached phase ${PHASE_GATE_GUARDRAIL} (current: ${phaseLabel}). Run PO → QA → ARCH review before using as a problemId.`,
    };
  }

  return { ok: true };
}

/**
 * Turn guardrails OFF
 * - Logs session start with scope
 * - scope="all" (default): moves entire hooks/ to hooks.bak/ (backward compatible)
 * - scope="write": moves only write-tier hooks to hooks.bak/, keeps read+system active
 * - scope="read": moves only read-tier hooks (unusual but supported)
 *
 * If problemId is provided:
 * - Loads targetFiles from the story note
 * - Writes a scope file for the enforce-targetfile-scope hook to enforce
 * - Session is scoped to those files only
 *
 * If problemId is null/undefined:
 * - Session is read-only for code (no scoped files = no code writes allowed)
 * - The enforce-targetfile-scope hook will block all code writes
 */
export async function guardrailsOff(projectRoot, reason = "unspecified", scope = "all", problemId = null, projectId = "unknown") {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);

  // Validate scope
  const validScopes = ["all", "write", "read"];
  if (!validScopes.includes(scope)) {
    return { ok: false, error: `Invalid scope "${scope}". Must be one of: ${validScopes.join(", ")}` };
  }

  // Child projects: Governor sessions may call guardrails_off to disable hooks.
  // The state machine + token gating enforce sequencing with hooks off.
  // No block here — hooks + CLAUDE.md are the Dispatcher-level protection.

  // Resolve per-project offRail config early — off_rail_disabled and invalid_offrail_config
  // must fire before the problemId and story-phase gates (otherwise they're unreachable when a
  // project has offRail.enabled: false and the caller provides a valid problemId).
  const projectJson = loadProjectJson(projectRoot);
  const offRailConfig = resolveOffRailConfig(projectJson);

  if (offRailConfig.mode === 'disabled') {
    return {
      ok: false,
      blocked: true,
      reason: 'off_rail_disabled',
      message: 'off-rail disabled for this project per .rks/project.json',
    };
  }
  if (offRailConfig.mode === 'invalid') {
    return {
      ok: false,
      blocked: true,
      reason: 'invalid_offrail_config',
      error: offRailConfig.error,
      message: `Invalid offRail config in .rks/project.json: ${offRailConfig.error}`,
    };
  }

  // Phase gate: a valid arch-approved story ID is required for every off-rail session,
  // except for framework projects (frameworkProject: true) which use the framework-update tier.
  const isFrameworkProject = projectJson?.frameworkProject === true;
  if (!problemId && !isFrameworkProject) {
    return {
      ok: false,
      reason: 'problemId_required',
      message: 'An arch-approved story ID is required to start an off-rail session. Identify the story this work belongs to (or run the PO Governor to create one), advance it to arch-approved, then retry with the storyId as problemId.',
    };
  }

  // Verify the story has reached arch-approved phase before enabling writes.
  // I/O happens here; the classification itself is delegated to the pure
  // classifyStoryGate so the reason logic is unit-testable without a worktree.
  if (problemId) {
    let notePath = null;
    let archivedNotePath = null;
    let noteExists = false;
    let phase = null;
    let readError = null;

    try {
      const notesDir = resolveNotesDir(projectRoot);
      notePath = path.join(notesDir, `${problemId}.md`);

      const archivedId = problemId.replace(/^backlog\./, 'backlog.z_implemented.');
      if (archivedId !== problemId) {
        const candidate = path.join(notesDir, `${archivedId}.md`);
        if (fs.existsSync(candidate)) archivedNotePath = candidate;
      }

      noteExists = fs.existsSync(notePath);
      if (noteExists) {
        const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
        phase = parsed?.data?.phase ?? null;
      }
    } catch (err) {
      // Previously a bare `catch {}` that reclassified every read/parse failure
      // as a missing note. Carry the error through so it gets its own reason.
      readError = err;
    }

    const gate = classifyStoryGate({
      problemId,
      notePath,
      noteExists,
      phase,
      readError,
      archivedNotePath,
      branch: getCurrentBranch(projectRoot, { throwOnError: false }),
    });
    if (!gate.ok) return gate;
  }

  // For path-predicate check: require problemId + targetFiles. Without targetFiles we can't validate.
  if (problemId) {
    const targetFiles = loadStoryTargetFiles(projectRoot, problemId);
    if (targetFiles && targetFiles.length > 0) {
      if (offRailConfig.mode === 'configured') {
        if (!targetFilesMatchRoots(targetFiles, offRailConfig.roots)) {
          return {
            ok: false,
            blocked: true,
            reason: 'non_core_work',
            guidance: getOffRailRootsGuidance(targetFiles, offRailConfig.roots),
            roots: offRailConfig.roots,
            message: 'targetFiles do not match this project\'s configured offRail.roots.',
          };
        }
      } else {
        // mode === 'default' — preserve existing RKS_CORE_PATTERNS behavior
        if (!isRksCoreWork(targetFiles)) {
          return {
            ok: false,
            blocked: true,
            reason: 'non_core_work',
            guidance: getRksNonCoreGuidance(targetFiles),
            message: 'This work can be done on-rail with MCP tools. See guidance for alternatives.',
          };
        }
      }
    }
  }

  // --- Tier inference ---
  // Determines which permission tier applies and populates denyList for framework-update.
  let tier;
  let denyList = null;
  if (problemId) {
    tier = 'build-only';
  } else if (projectJson !== null) {
    if (projectJson.frameworkProject === true) {
      tier = 'framework-update';
      denyList = buildFrameworkDenyList();
    } else {
      return {
        ok: false,
        reason: 'no_tier_available',
        message: 'guardrails-off requires a problemId (build-only) or frameworkProject: true in .rks/project.json (framework-update). No tier available.',
      };
    }
  } else {
    // No project.json — backward-compatible read-only session
    tier = 'read-only';
  }

  // Check if already off via state file
  const currentState = readGuardState(projectRoot);
  if (currentState.active === false) {
    const activeSession = getActiveSession(projectRoot);
    return {
      ok: false,
      error: `Guardrails already off (scope=${currentState.scope || "unknown"})`,
      activeSession,
    };
  }

  // Check if hooks.bak exists — may be a live off-session OR an orphan from a prior crash
  if (fs.existsSync(hooksBakPath)) {
    const activeSession = getActiveSession(projectRoot);
    if (activeSession) {
      // Live session: block as before — this is a real concurrent conflict
      return {
        ok: false,
        error: "Guardrails already off — hooks.bak exists. Call rks_guardrails_on to restore.",
        activeSession,
      };
    }
    // Orphan hooks.bak (no active session recorded): restore tiers then clean
    try {
      for (const tier of ['write', 'read']) {
        const src = path.join(hooksBakPath, tier);
        const dst = path.join(hooksPath, tier);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.renameSync(src, dst);
        }
      }
      fs.rmSync(hooksBakPath, { recursive: true, force: true });
      console.error(`[guardrails] Auto-recovered orphan hooks.bak at ${hooksBakPath} (no active session found)`);
      try {
        const collector = ensureTelemetryStorage(projectRoot);
        collector.emit("guardrails.orphan_cleanup", projectId, {
          hooksBakPath,
          reason: "no_active_session",
        });
        await collector.flush();
      } catch (e) { /* telemetry is best-effort */ }
    } catch (e) {
      return {
        ok: false,
        error: `Failed to auto-recover orphan hooks.bak: ${e.message}`,
      };
    }
  }


  // Check if hooks directory exists
  if (!fs.existsSync(hooksPath)) {
    return {
      ok: false,
      error: "Guardrails infrastructure broken - hooks directory missing",
      severity: "critical",
      recovery: [
        "1. Restore from git: git checkout HEAD~10 -- .routekit/hooks/",
        "2. Or from template: cp -r templates/generic/.routekit/hooks/ .routekit/",
        "3. Commit the restored hooks before continuing"
      ],
    };
  }

  // Get git state
  const gitState = getGitState(projectRoot);

  // Create session entry
  const sessionId = randomUUID();
  const session = {
    sessionId,
    startedAt: new Date().toISOString(),
    reason,
    scope,
    branch: gitState.branch,
    headCommit: gitState.head,
    dirtyAtStart: gitState.dirty,
    problemId: problemId || null,
  };

  // Load targetFiles if problemId provided (for scoped writes)
  let allowedFiles = null;
  let writeMode = "read-only"; // Default: no code writes allowed

  if (problemId) {
    const targetFiles = loadStoryTargetFiles(projectRoot, problemId);
    if (targetFiles && Array.isArray(targetFiles) && targetFiles.length > 0) {
      allowedFiles = targetFiles;
      writeMode = "scoped";
      session.allowedFiles = allowedFiles;
    } else {
      // problemId provided but no targetFiles found - warn but continue
      session.warning = `Story ${problemId} has no targetFiles defined. Session is read-only for code.`;
    }
  } else if (tier === 'framework-update') {
    writeMode = 'deny-list';
  }
  session.writeMode = writeMode;

  // Write scope file for enforce-targetfile-scope hook
  const scopeData = {
    sessionId,
    problemId: problemId || null,
    tier,
    allowedFiles,
    denyList,
    writeMode,
    startedAt: session.startedAt,
    reason,
  };
  const scopePath = writeScopeFile(projectRoot, scopeData);
  session.scopeFile = scopePath;

  // Write guardrails state file — hooks check this to decide enforcement
  const disabledTiers = scopeToDisabledTiers(scope);
  try {
    // Enumerate hooks from tier subdirectories
    const manifest = loadHooksManifest(projectRoot);
    const hooksByTier = { system: [], write: [], read: [] };
    for (const tier of ['system', 'write', 'read']) {
      const tierDir = path.join(hooksPath, tier);
      if (fs.existsSync(tierDir)) {
        hooksByTier[tier] = fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs'));
      }
    }
    const allHooks = [...hooksByTier.system, ...hooksByTier.write, ...hooksByTier.read];

    // Determine which hooks are effectively disabled by scope
    const disabledHooks = allHooks.filter(f => {
      const name = f.replace(".mjs", "");
      const tier = getHookTier(manifest, name);
      return disabledTiers.includes(tier);
    });

    writeGuardState(projectRoot, {
      active: false,
      scope,
      sessionId,
      sessionType: null,
      reason,
      disabledTiers,
    });

    // Atomic tier-directory renames — system/ always stays
    if (!fs.existsSync(hooksBakPath)) {
      fs.mkdirSync(hooksBakPath, { recursive: true });
    }
    const movedHooks = [];
    for (const tier of RELOCATABLE_TIERS) {
      if (!disabledTiers.includes(tier)) continue;
      const src = path.join(hooksPath, tier);
      const dst = path.join(hooksBakPath, tier);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
        movedHooks.push(...(hooksByTier[tier] || []));
      }
    }
    session.movedHooks = movedHooks;

    // Every write/ and read/ hook imports the shared helper by RELATIVE path
    // ("../system/hook-output.mjs"). Once a tier dir is relocated under
    // hooks.bak/, that specifier resolves to hooks.bak/system/ — which does not
    // exist, because system/ deliberately stays live. Node then fails the hook
    // with ERR_MODULE_NOT_FOUND and exits 1 before any hook logic runs, which is
    // what made every deployed-hook test red for the duration of a session.
    //
    // COPY system/ alongside the relocated tiers so the relative import still
    // resolves. It MUST be a real directory, never a symlink: guardrailsAbort
    // rm -rf's the live hooks/ tree before renaming hooks.bak onto it, so a
    // symlink there would destroy the real system/ hooks. It must also be a
    // system/ SUBDIRECTORY, never flat files — the legacy restore branch treats
    // flat .mjs under hooks.bak/ as tier-less hooks and injects them into a live
    // tier dir. The live system/ tier keeps executing from hooks/system/; this
    // copy exists solely so relocated hooks can resolve their imports.
    //
    // Every close path (guardrailsOn's trailing cleanup, guardrailsAbort, and
    // orphan recovery) already removes hooks.bak/ wholesale, so nothing new is
    // required to undo this — which also makes it safe when a session opened by
    // older code is closed by this one, and vice versa. Those filters test the
    // TIER names and never 'system', so they hold for any number of siblings.
    // (backlog.fix.off-rail-hook-loadability)
    //
    // GENERALISED from the single name 'system' by
    // backlog.fix.unit-tier-offrail-hermeticity. The original mirrored exactly
    // one hard-coded sibling. It was never a list that lost an entry — it was
    // `path.join(hooksBakPath, 'system')` — so every sibling added to the
    // deployed tree AFTER 0.38.0 silently reopened the hole. `lib/` did exactly
    // that (vendored shared modules, reaching the deployed tree via
    // scripts/sync-hooks.mjs), leaving 14 relocatable hooks importing
    // '../lib/session-state.mjs' unloadable for the duration of every session.
    //
    // DERIVED, NOT ENUMERATED. The siblings are whatever is NOT a relocatable
    // tier, so a future sibling is covered on the day it lands and no one has to
    // remember this code exists. Note scripts/sync-hooks.mjs:84 models the same
    // distinction with the opposite polarity — `exclude: ["lib"]` names the
    // sibling, so a new sibling becomes a false-positive orphan there. Naming the
    // tiers and deriving the rest is the polarity that does not carry that defect
    // forward.
    //
    // isDirectory() IS LOAD-BEARING: the legacy restore branch treats a flat .mjs
    // at the hooks.bak root as a tier-less hook and renames it INTO a live tier
    // directory, so mirroring a stray file would inject it into hooks/.
    if (movedHooks.length > 0) {
      for (const entry of fs.readdirSync(hooksPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (RELOCATABLE_TIERS.includes(entry.name)) continue;
        const siblingSrc = path.join(hooksPath, entry.name);
        const siblingDst = path.join(hooksBakPath, entry.name);
        if (!fs.existsSync(siblingDst)) {
          fs.cpSync(siblingSrc, siblingDst, { recursive: true });
        }
      }
    }

    session.disabledHooks = disabledHooks;
    session.hookCount = allHooks.length;
  } catch (e) {
    return {
      ok: false,
      error: `Failed to write guardrails state: ${e.message}`,
    };
  }

  // Log session start
  const logPath = appendSessionLog(projectRoot, session);

  // Emit telemetry
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("guardrails.off", projectId, {
      sessionId,
      reason,
      scope,
      branch: gitState.branch,
      headCommit: gitState.head,
      dirtyAtStart: gitState.dirty,
      disabledHooks: session.disabledHooks,
      problemId: problemId || null,
      writeMode,
      allowedFiles: allowedFiles?.length || 0,
    });
    await collector.flush(); // Flush immediately for critical events
  } catch (e) { /* telemetry is best-effort */ }

  const scopeMsg = scope === "all" ? "" : ` (scope=${scope})`;
  const writeModeMsg = writeMode === "scoped"
    ? ` Writes scoped to ${allowedFiles.length} file(s) from story ${problemId}.`
    : " Session is READ-ONLY for code (no problemId).";

  return {
    ok: true,
    sessionId,
    scope,
    tier,
    startedAt: session.startedAt,
    headCommit: gitState.head,
    branch: gitState.branch,
    disabledHooks: session.disabledHooks,
    problemId: problemId || null,
    writeMode,
    allowedFiles,
    denyList,
    scopeFile: session.scopeFile,
    logPath,
    message: `Guardrails OFF${scopeMsg}.${writeModeMsg} Session ${sessionId.slice(0, 8)} started. Remember to call rks_guardrails_on when done.`,
    ...(session.warning ? { warning: session.warning } : {}),
  };
}

/**
 * ABORT an off-rail session WITHOUT shipping.
 *
 * The discard exit that rks_guardrails_on (which ALWAYS commits/ships) never provided.
 * Throws away every working-tree change made since the session started — `git reset --hard`
 * to the session's headCommit plus `git clean -fd` for new untracked files — and restores
 * the guardrails hooks, with NO commit, branch, merge, or push.
 *
 * Hook restoration is automatic: `.routekit/hooks/*` are git-tracked, so the hard reset to
 * headCommit recreates them (the off-rail move only "deleted" them from the worktree). We then
 * remove the leftover hooks.bak/ and clear the guard state so isOffRailActive() reads false.
 *
 * Note `git clean -fd` (no -x) preserves gitignored paths (node_modules, .env, .rks/rag, and the
 * session log/state under .rks/ which we clear explicitly) — only session-created source files go.
 */
export async function guardrailsAbort(projectRoot, options = {}, projectId = "unknown") {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);

  const currentState = readGuardState(projectRoot);
  if (currentState.active !== false) {
    return { ok: false, error: "Guardrails are already on — there is no off-rail session to abort." };
  }

  const activeSession = getActiveSession(projectRoot);

  // No tracked session (orphan hooks.bak): restore hooks, clear state, but DO NOT discard —
  // without a recorded headCommit we cannot safely decide what to reset to.
  if (!activeSession || !activeSession.headCommit) {
    let hooksRestored = false;
    try {
      if (fs.existsSync(hooksBakPath)) {
        if (fs.existsSync(hooksPath)) fs.rmSync(hooksPath, { recursive: true, force: true });
        fs.renameSync(hooksBakPath, hooksPath);
        hooksRestored = true;
      } else {
        restoreHooksFromTemplate(projectRoot);
        hooksRestored = true;
      }
    } catch (e) {
      return { ok: false, error: `Abort: no active session and hook restore failed: ${e.message}` };
    }
    clearGuardState(projectRoot);
    removeScopeFile(projectRoot);
    return {
      ok: true,
      aborted: true,
      hooksRestored,
      warning: "No active session found — hooks restored, but nothing was discarded (no session headCommit to reset to).",
    };
  }

  const headCommit = activeSession.headCommit;
  const gitBefore = getGitState(projectRoot);

  // Restore the relocated hook tiers BEFORE detecting what is about to be
  // discarded — same ordering defect as guardrailsOn. While off-rail, the write
  // and read tiers live in the gitignored .routekit/hooks.bak/, so every tracked
  // hook file reads as a DELETION and inflates changesDiscarded with phantoms
  // that were never session work. The `git reset --hard` below recreates them
  // regardless; doing it first is what makes the reported number honest.
  // Best-effort: a failure here must not block the abort, because the reset
  // repairs the tree either way.
  try {
    if (fs.existsSync(hooksBakPath)) {
      if (!fs.existsSync(hooksPath)) fs.mkdirSync(hooksPath, { recursive: true });
      for (const entry of fs.readdirSync(hooksBakPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || !["write", "read"].includes(entry.name)) continue;
        const dst = path.join(hooksPath, entry.name);
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
        fs.renameSync(path.join(hooksBakPath, entry.name), dst);
      }
    }
  } catch (e) { /* best-effort — the hard reset below repairs the tree anyway */ }

  const changes = getChangedFilesSince(projectRoot, headCommit);
  // An errored count is NOT a clean tree. The abort still proceeds — the hard
  // reset below repairs the worktree either way — but `changesDiscarded: 0` would
  // be a lie, so the error travels with the count to the log, telemetry and the
  // caller instead of being swallowed.
  const changeCountError = changes.error || null;

  // DISCARD + auto-restore tracked hooks via a hard reset to the session-start commit.
  try {
    execSync(`git reset --hard ${headCommit}`, { cwd: projectRoot, encoding: "utf8" });
    execSync("git clean -fd", { cwd: projectRoot, encoding: "utf8" });
  } catch (e) {
    return {
      ok: false,
      error: `Abort failed during discard (git reset --hard ${headCommit.slice(0, 8)}): ${e.message}`,
      recovery: "Working tree may be partially reset and hooks may still be off. Resolve git state manually, then retry rks_guardrails_abort or rks_guardrails_on.",
    };
  }

  // The reset recreated .routekit/hooks/; remove any leftover hooks.bak/ (git clean skips it if
  // it is gitignored) so isOffRailActive() reads false, then clear the state + scope files.
  try {
    if (fs.existsSync(hooksBakPath)) fs.rmSync(hooksBakPath, { recursive: true, force: true });
  } catch (e) { /* best-effort */ }
  clearGuardState(projectRoot);
  const scopeFileRemoved = removeScopeFile(projectRoot);

  // Log the aborted session end (parallel to guardrailsOn's end entry, marked aborted).
  const endEntry = {
    sessionId: activeSession.sessionId,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(activeSession.startedAt).getTime(),
    aborted: true,
    discardedFromCommit: gitBefore.head,
    resetToCommit: headCommit,
    changesDiscarded: changes.total,
    discardedFiles: changes.changed.slice(0, 20),
    discardedNewFiles: changes.newFiles.slice(0, 20),
    ...(changeCountError ? { changeCountError } : {}),
    autoWorkflow: false,
  };
  appendSessionLog(projectRoot, endEntry);

  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("guardrails.abort", projectId, {
      sessionId: activeSession.sessionId,
      reason: activeSession.reason,
      durationMs: endEntry.durationMs,
      changesDiscarded: changes.total,
      resetToCommit: headCommit,
      ...(changeCountError ? { changeCountError } : {}),
    });
    await collector.flush();
  } catch (e) { /* telemetry is best-effort */ }

  return {
    ok: true,
    aborted: true,
    sessionId: activeSession.sessionId,
    reason: activeSession.reason,
    resetToCommit: headCommit,
    discardedFromCommit: gitBefore.head,
    changesDiscarded: changes.total,
    discardedFiles: endEntry.discardedFiles,
    discardedNewFiles: endEntry.discardedNewFiles,
    ...(changeCountError ? { changeCountError } : {}),
    hooksRestored: true,
    scopeFileRemoved,
    message: `Guardrails ABORTED — off-rail session ${activeSession.sessionId.slice(0, 8)} discarded. Working tree reset to ${headCommit.slice(0, 8)} (${changes.total} change(s) thrown away), hooks restored, NO commit or push.`,
  };
}

// Canonical hook source + template deploy target, relative to the project root.
// HOOKS_DIR (".routekit/hooks") is the third path and is already defined above.
const CANONICAL_HOOKS_DIR = path.join("packages", "hooks");
const TEMPLATE_HOOKS_DIR = path.join("templates", "generic", ".routekit", "hooks");
// git reports repo-relative POSIX paths, so match the prefix in POSIX form.
const CANONICAL_HOOKS_PREFIX = "packages/hooks/";

/**
 * True when a repo-relative path from git lies under the canonical hook source.
 * @param {string} file
 * @returns {boolean}
 */
function touchesCanonicalHooks(file) {
  const norm = String(file).replace(/\\/g, "/");
  return norm === "packages/hooks" || norm.startsWith(CANONICAL_HOOKS_PREFIX);
}

/**
 * Always-on hook drift check plus conditional hook deploy, run during guardrailsOn.
 *
 * backlog.fix.guardrails-on-syncs-hooks (defect register item A4): a hook change
 * could not reach runtime by ANY agent path. With guardrails ON the bash allowlist
 * denies `npm run sync-hooks`; with guardrails OFF, scripts/sync-hooks.mjs
 * self-skips while .routekit/hooks.bak exists. So .routekit/hooks/** only ever
 * updated via `npm install` or a human acting outside the agent loop, and a story
 * could ship green without its hook fix ever reaching runtime.
 *
 * Contract: NEVER throws, NEVER leaves hooks half-restored, NEVER aborts the ship.
 * Every failure is reported through the returned object instead.
 *
 * @param {string} projectRoot
 * @param {{changed: string[], newFiles: string[], total: number}} changes
 * @returns {Promise<Object>} the hookDeploy payload field
 */
async function runHookDeploy(projectRoot, changes) {
  const result = {
    checked: false,
    synced: false,
    skipped: null,
    drift: null,
    deployedFiles: null,
    error: null,
  };

  const src = path.join(projectRoot, CANONICAL_HOOKS_DIR);
  const projectHooks = path.join(projectRoot, HOOKS_DIR);
  const templateHooks = path.join(projectRoot, TEMPLATE_HOOKS_DIR);

  // Attached child projects vendor their hooks and have no canonical source.
  // Absence is a NORMAL state, not an error — return a benign skip.
  //
  // This guard is mandatory, not defensive polish: syncAll/syncHooks THROW on a
  // missing src (after mkdirSync has already created an empty dest as a side
  // effect), and checkDrift/checkOrphans do not throw but fabricate one issue per
  // deployed file. Neither degrades benignly on its own. It is also the regression
  // shield for every pre-existing guardrailsOn test fixture, none of which has a
  // packages/hooks/ directory.
  if (!fs.existsSync(src)) {
    result.skipped = "no_canonical_hooks_source";
    return result;
  }

  let sync;
  try {
    // Dynamic, not a static top-level import: scripts/ lives outside this package
    // and is absent from its published `files` allowlist, so a static import would
    // fail resolution on a standalone install and take the whole module graph down
    // with it. Here, an unresolvable module degrades to a reported skip.
    sync = await import("../../../../scripts/sync-hooks.mjs");
  } catch (e) {
    result.skipped = "sync_hooks_unavailable";
    result.error = `Hook sync module unavailable: ${e.message}`;
    return result;
  }

  // 1. ALWAYS: the read-only drift check (`--check` semantics). Cheap, no writes,
  //    and reported regardless of whether a sync follows.
  try {
    const templateDrift = sync.checkDrift(src, templateHooks);
    const projectOrphans = sync.checkOrphans(src, projectHooks);
    const templateOrphans = sync.checkOrphans(src, templateHooks);
    result.checked = true;
    result.drift = {
      ok: templateDrift.ok && projectOrphans.ok && templateOrphans.ok,
      canonicalCount: templateDrift.srcCount,
      issues: [
        ...templateDrift.issues.map((i) => `[canonical<->template] ${i}`),
        ...projectOrphans.issues.map((i) => `[${HOOKS_DIR}] ${i}`),
        ...templateOrphans.issues.map((i) => `[${TEMPLATE_HOOKS_DIR}] ${i}`),
      ],
    };
  } catch (e) {
    result.error = `Hook drift check failed: ${e.message}`;
  }

  // 2. CONDITIONAL: deploy only when THIS session actually touched the canonical
  //    hook source. Otherwise an unrelated story silently deploys someone else's
  //    pending drift, and the auto-ship commits .routekit/hooks/** under a story
  //    whose targetFiles never listed those paths. Both git signals must be
  //    tested: `changed` (tracked edits) and `newFiles` (untracked additions).
  const touched = [
    ...(changes?.changed || []),
    ...(changes?.newFiles || []),
  ].some(touchesCanonicalHooks);
  if (!touched) {
    result.skipped = "session_did_not_touch_canonical_hooks";
    return result;
  }

  try {
    // Computed live rather than hardcoded false. By this point the restore has
    // removed .routekit/hooks.bak, so this is false and the sync is real. If it
    // is somehow true we are running too early — sync-hooks self-skips, which is
    // silent and is the exact defect this story fixes, so surface it loudly
    // rather than letting a no-op masquerade as a deploy.
    const offRailActive = sync.isOffRailActive(projectRoot);
    const { projectSynced, templateSynced, skippedProject } = sync.syncAll({
      src,
      projectHooks,
      templateHooks,
      offRailActive,
    });
    result.offRailActive = offRailActive;
    if (skippedProject) {
      result.skipped = "off_rail_still_active";
      result.error =
        "Hook sync self-skipped: .routekit/hooks.bak still present at sync time — the deploy did NOT occur.";
      return result;
    }
    result.synced = true;
    result.deployedFiles = projectSynced;
    result.templateFiles = templateSynced;
  } catch (e) {
    // LOUD BUT NON-FATAL. The tier restore above has already completed, so hooks
    // are whole; this failure must not abort the ship or change guardrailsOn's
    // ok:true. Report it and carry on.
    result.error = `Hook sync failed: ${e.message}`;
  }

  return result;
}

/**
 * Turn guardrails ON
 * - Restores hooks
 * - Logs session end
 * - Returns changes made during session
 */
export async function guardrailsOn(projectRoot, options = {}, projectId = "unknown") {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);

  // Check if guardrails are actually off via state file
  const currentState = readGuardState(projectRoot);
  if (currentState.active !== false) {
    return {
      ok: false,
      error: "Guardrails are already on (state file shows active)",
    };
  }

  // Get active session
  const activeSession = getActiveSession(projectRoot);
  if (!activeSession) {
    // No tracked session — still restore state but warn
    clearGuardState(projectRoot);
    return {
      ok: true,
      warning: "No active session found - guardrails state restored but no audit trail",
      hooksRestored: true,
    };
  }

  // Get git state. Change detection deliberately does NOT happen here — it runs
  // after the hook restore below. See the detection site for why counting at this
  // point produces phantom deletions.
  const gitState = getGitState(projectRoot);

  // Restore guardrails state file to active and move hooks back.
  //
  // Ordering rationale (atomic with rollback):
  //   1. Move hooks from hooks.bak/ back to hooks/ FIRST. System-tier hooks that
  //      were never moved remain in hooks/ untouched. If the per-file move fails,
  //      state is still active=false and partially moved hooks stay in .bak — recoverable.
  //   2. Only AFTER all moves succeed do we call clearGuardState. hooks.bak/ is
  //      cleaned up as a best-effort step after clearGuardState succeeds.
  //   3. If clearGuardState fails, attempt rollback: move restored hooks back to .bak.
  let hooksFallback = false;
  let renameSucceeded = false;
  let restoredFiles = [];
  try {
    // Step 1: per-file restore from hooks.bak/ to hooks/ (or fallback to template)
    if (fs.existsSync(hooksBakPath)) {
      try {
        if (!fs.existsSync(hooksPath)) {
          fs.mkdirSync(hooksPath, { recursive: true });
        }
        const bakEntries = fs.readdirSync(hooksBakPath, { withFileTypes: true });
        const bakTierDirs = bakEntries.filter(e => e.isDirectory() && ['write', 'read'].includes(e.name));
        const bakFlatFiles = bakEntries.filter(e => e.isFile() && e.name.endsWith('.mjs'));

        if (bakTierDirs.length > 0) {
          // Atomic tier restore (new layout)
          for (const dir of bakTierDirs) {
            const src = path.join(hooksBakPath, dir.name);
            const dst = path.join(hooksPath, dir.name);
            // Pre-remove destination if it exists — makes restore idempotent when
            // a prior guardrails_on was interrupted after partial rename (ENOTEMPTY).
            if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
            fs.renameSync(src, dst);
            restoredFiles.push(...fs.readdirSync(dst).filter(f => f.endsWith('.mjs')));
          }
        } else if (bakFlatFiles.length > 0) {
          // Legacy compat: flat files from old per-file move code
          const manifest = loadHooksManifest(projectRoot);
          for (const f of bakFlatFiles) {
            const tier = getHookTier(manifest, f.name.replace('.mjs', ''));
            const tierDir = path.join(hooksPath, tier);
            if (!fs.existsSync(tierDir)) fs.mkdirSync(tierDir, { recursive: true });
            fs.renameSync(path.join(hooksBakPath, f.name), path.join(tierDir, f.name));
            restoredFiles.push(f.name);
          }
        }
        renameSucceeded = true;
      } catch (renameErr) {
        // Move failed: state is still active=false, partially-moved hooks tracked — recoverable
        return {
          ok: false,
          error: `Failed to restore hooks: ${renameErr.message}`,
          recovery: "State unchanged (active=false), hooks still in hooks.bak. Retry rks_guardrails_on after resolving the filesystem issue.",
        };
      }
    } else {
      // hooks.bak missing — fall back to restoring from template
      hooksFallback = true;
      restoreHooksFromTemplate(projectRoot);
      renameSucceeded = true; // template restore counts as the "hooks in place" milestone
    }

    // Step 2: clear guard state (AFTER per-file restore succeeded)
    try {
      clearGuardState(projectRoot);
      // Best-effort cleanup of now-empty hooks.bak/
      try {
        if (fs.existsSync(hooksBakPath)) {
          fs.rmSync(hooksBakPath, { recursive: true, force: true });
        }
      } catch (e) { /* best-effort */ }
    } catch (clearErr) {
      // clearGuardState failed AFTER hooks were restored. Attempt rollback.
      if (!hooksFallback) {
        try {
          if (!fs.existsSync(hooksBakPath)) {
            fs.mkdirSync(hooksBakPath, { recursive: true });
          }
          const manifest = loadHooksManifest(projectRoot);
          const currentHooks = fs.existsSync(hooksPath) ? fs.readdirSync(hooksPath).filter(f => f.endsWith('.mjs')) : [];
          for (const file of currentHooks) {
            if (getHookTier(manifest, file.replace('.mjs', '')) !== 'system') {
              fs.renameSync(path.join(hooksPath, file), path.join(hooksBakPath, file));
            }
          }
          return {
            ok: false,
            error: `Failed to clear guardrails state: ${clearErr.message}`,
            rolledBack: true,
            recovery: "Rolled back: hooks restored to hooks.bak, state file unchanged. Retry rks_guardrails_on.",
          };
        } catch (rollbackErr) {
          // Rollback itself failed — split state requiring manual recovery
          return {
            ok: false,
            error: `Manual recovery required: clearGuardState failed (${clearErr.message}) AND rollback failed (${rollbackErr.message}). State=active may be partially written; hooks are physically in hooks/. Inspect .rks/guardrails-state.json and .routekit/hooks/ manually.`,
            manualRecoveryRequired: true,
            clearError: clearErr.message,
            rollbackError: rollbackErr.message,
          };
        }
      } else {
        // Template-fallback path: cannot rollback hook files. Surface manual recovery.
        return {
          ok: false,
          error: `Manual recovery required: clearGuardState failed (${clearErr.message}) after template-fallback hook restore. Hooks are in place but state file may be stale. Inspect .rks/guardrails-state.json manually.`,
          manualRecoveryRequired: true,
          clearError: clearErr.message,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `Failed to restore guardrails state: ${e.message}`,
    };
  }

  // Snapshot the write scope BEFORE destroying it. POSITION IS LOAD-BEARING:
  // removeScopeFile below deletes .rks/active-scope.json, and the auto-ship gate
  // further down needs allowedFiles to reconcile what is about to be committed.
  // Reading it after the delete is why ship-time scope verification did not exist.
  const scopeSnapshot = readActiveScope(projectRoot);

  // Clean up scope file (if it exists from scoped write session)
  const scopeFileRemoved = removeScopeFile(projectRoot);

  // Detect changes AFTER the hook restore above — the ordering IS the fix.
  //
  // While a session is off-rail, the write- and read-tier hooks are physically
  // relocated to .routekit/hooks.bak/, which is gitignored. Every tracked file
  // under .routekit/hooks/ is therefore ABSENT from the worktree, and
  // `git diff --name-only` reports each one as a deletion. Counting before the
  // restore produced ~30 phantom deletions that can never reach a commit,
  // because the `git add -A` below runs against the restored tree. That inflated
  // number gated auto-ship, stamped "Files: N" into the commit body, and was
  // reported to the caller, the session log and telemetry — e.g. 35 detected
  // against a 5-file commit.
  //
  // Filtering the hook paths out of a pre-restore count would not work either:
  // a GENUINE in-session hook edit lives in the gitignored .bak copy and is
  // equally invisible to git before the restore, so the filter would under-count
  // real work. Detecting after the restore gets both cases right.
  let changes = getChangedFilesSince(projectRoot, activeSession.headCommit);

  // Always drift-check the hooks; deploy them only if this session touched their
  // canonical source. See runHookDeploy above for the why.
  //
  // POSITION IS LOAD-BEARING — this call must stay:
  //   - AFTER the fs.rmSync(hooksBakPath) restore cleanup above, so sync-hooks
  //     does not self-skip, and so the tier restore cannot rename hooks.bak back
  //     over a freshly written deploy;
  //   - BEFORE the `const response = {` literal below, so the result is a property
  //     of that object and therefore reaches every exit — all of which return via
  //     finalizeShipOutcome — including the no-changes one at the end;
  //   - BEFORE the auto-ship gate below, so the read-only check still runs on the
  //     no-changes path and when the caller suppresses the auto-ship;
  //   - BEFORE the auto-ship stages files, so a real deploy is captured by the
  //     same commit rather than being left dirty in the worktree.
  const hookDeploy = await runHookDeploy(projectRoot, changes);

  // A real deploy WRITES: syncAll overwrites .routekit/hooks/{write,read,system}/
  // and templates/generic/.routekit/hooks/. Those writes are staged by the
  // `git add -A` below, so a count taken before the deploy would under-report
  // exactly as badly as the pre-restore count over-reported. Recompute so the
  // gate, the commit body, the session log, the response and telemetry all
  // describe the same committable set.
  if (hookDeploy?.synced) {
    changes = getChangedFilesSince(projectRoot, activeSession.headCommit);
  }

  // READ THE ERROR. Both getChangedFilesSince calls above return total:0 when git
  // itself failed, which is indistinguishable from a clean worktree by the count
  // alone — and total:0 routes into the no-changes branch below, which used to
  // push and report autoShipped:true. An uncomputable change count is a FAILURE,
  // not a clean tree: it is surfaced on the response, written to the session log
  // and emitted to telemetry, and it forces shipOutcome to "failed" via shipError.
  const changeCountError = changes.error || null;

  // SCOPED STAGING — decide here, BEFORE anything is reported, what this session
  // is allowed to commit. Computed at this point on purpose:
  //   - AFTER the hook restore and runHookDeploy above, so a deployed hook is a
  //     real worktree path the partition can see;
  //   - BEFORE the session-log entry and the response literal below, so both
  //     describe the same committed set and the same left-behind set;
  //   - from the EXISTING `scopeSnapshot` (captured before removeScopeFile()).
  //     Calling readActiveScope() again at staging time returns null — the scope
  //     file is gone by then — which would silently collapse every scoped session
  //     back into the unscoped sweep. That failure is invisible: the ship still
  //     succeeds and still looks correct.
  const storyNoteRel = activeSession.problemId
    ? toRepoRelative(projectRoot, path.join(resolveNotesDir(projectRoot), `${activeSession.problemId}.md`))
    : null;
  const shipScope = buildShipScope({
    projectRoot,
    allowedFiles: scopeSnapshot?.allowedFiles ?? null,
    notePath: storyNoteRel,
  });
  const unstagedOutOfScope = shipScope.unstagedPaths;

  // TWO TOTALS, DELIBERATELY. `touchedTotal` is what the session touched and is
  // what opens the auto-ship gate below — the gate must still open for a session
  // whose changes are entirely out of scope, or the newly-reachable empty-index
  // case would never be reported at all. `changes.total` becomes what the session
  // will COMMIT, which is what the response, the session log, telemetry and the
  // commit body's `Files: N` stamp all describe.
  //
  // The filter is `allowedFiles` only, NOT the artifact allowlist: `changedFiles`
  // stays the user-work count, so hook-restore/deploy churn cannot inflate it
  // (the reason the post-restore recount at :1802 exists) and so
  // buildScopeReconcileStep — which is fed this same set — reports ok:true with
  // zero violations for a scoped session, by construction.
  const touchedTotal = changes.total;
  if (shipScope.scoped) {
    const inScope = (f) => matchesScopePattern(scopeSnapshot.allowedFiles, f);
    changes = {
      ...changes,
      changed: changes.changed.filter(inScope),
      newFiles: changes.newFiles.filter(inScope),
    };
    changes.total = changes.changed.length + changes.newFiles.length;
  }

  // The session changed things and NONE of them were in scope. Distinguished
  // from a genuinely-already-committed session (which has in-scope changes
  // relative to headCommit) and consumed by the empty-index branch below.
  const allOutOfScope = shipScope.scoped && touchedTotal > 0 && changes.total === 0;

  // Log session end. Deliberately AFTER the deploy above so the logged count is
  // the same committable set the commit body and the auto-ship gate see; nothing
  // requires the log to be written before the deploy.
  const endEntry = {
    sessionId: activeSession.sessionId,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(activeSession.startedAt).getTime(),
    endCommit: gitState.head,
    changesDetected: changes.total,
    changedFiles: changes.changed.slice(0, 20), // Limit for readability
    newFiles: changes.newFiles.slice(0, 20),
    ...(changeCountError ? { changeCountError } : {}),
    // EVERY path, not a sample — unlike the two slice(0, 20) fields above. A
    // truncated list of files the ship deliberately left behind is the same
    // silence the scoped-staging change exists to remove.
    ...(shipScope.scoped ? { unstagedOutOfScope } : {}),
    autoWorkflow: options.autoWorkflow !== false,
  };

  const logPath = appendSessionLog(projectRoot, endEntry);

  // Build response
  const response = {
    ok: true,
    hookDeploy,
    sessionId: activeSession.sessionId,
    startedAt: activeSession.startedAt,
    endedAt: endEntry.endedAt,
    durationMs: endEntry.durationMs,
    durationHuman: formatDuration(endEntry.durationMs),
    reason: activeSession.reason,
    headCommitAtStart: activeSession.headCommit,
    headCommitAtEnd: gitState.head,
    changesDetected: changes.total,
    changedFiles: changes.changed,
    newFiles: changes.newFiles,
    ...(changeCountError ? { changeCountError } : {}),
    hooksRestored: true,
    hooksFallback,
    scopeFileRemoved,
    // Reported on the RESPONSE (and the session log), never as a shipSteps entry.
    // tests/unit/guardrails-on-hook-sync-ordering.test.mjs filters shipSteps with
    // /hook|sync|drift/i over the whole stringified step object and asserts zero
    // matches, so a step payload carrying a `.routekit/hooks/` path string would
    // redden it. Present (possibly empty) whenever the session was scoped, so
    // callers can rely on the key rather than inferring from its absence.
    ...(shipScope.scoped ? { unstagedOutOfScope } : {}),
    logPath,
    ...(hooksFallback ? { warning: "hooks.bak was missing — hooks restored from template rather than from backup" } : {}),
  };

  // Emit telemetry
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("guardrails.on", projectId, {
      sessionId: activeSession.sessionId,
      reason: activeSession.reason,
      durationMs: endEntry.durationMs,
      changesDetected: changes.total,
      changedFiles: changes.changed.length,
      newFiles: changes.newFiles.length,
      ...(changeCountError ? { changeCountError } : {}),
      branch: gitState.branch,
      headCommitAtStart: activeSession.headCommit,
      headCommitAtEnd: gitState.head,
    });
    // Emit restore verification telemetry
    // expected = hooks physically moved to .bak at session start (movedHooks);
    // falls back to disabledHooks for sessions recorded before selective-retention
    const expectedHooks = activeSession.movedHooks || activeSession.disabledHooks || [];
    let restoredHooks = [];
    try {
      for (const tier of ['system', 'write', 'read']) {
        const tierDir = path.join(hooksPath, tier);
        if (fs.existsSync(tierDir)) {
          restoredHooks.push(...fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs')));
        }
      }
    } catch (e) { /* best-effort */ }
    const expectedSet = new Set(expectedHooks);
    const restoredSet = new Set(restoredHooks);
    const missingHooks = expectedHooks.filter(h => !restoredSet.has(h));
    const unexpectedHooks = restoredHooks.filter(h => !expectedSet.has(h));
    collector.emit("guardrails.restore.verified", projectId, {
      sessionId: activeSession.sessionId,
      expectedCount: expectedHooks.length,
      actualCount: restoredHooks.length,
      missingCount: missingHooks.length,
      unexpectedCount: unexpectedHooks.length,
      missingHooks,
      unexpectedHooks,
      verified: true,
    });
    await collector.flush(); // Flush immediately for critical events
  } catch (e) { /* telemetry is best-effort */ }

  // If changes exist, auto-ship through proper PR flow (mandatory)
  // Skip when called internally from exec — exec handles its own commit/ship flow
  //
  // Gated on `touchedTotal`, NOT the scope-filtered `changes.total`: a session
  // whose entire change set is out of scope still has to enter this block so the
  // empty-index branch can report what it left behind. Gating on the filtered
  // count would route it to the "No changes detected" exit, which is a different
  // and equally false claim.
  if (touchedTotal > 0 && !options.skipAutoShip) {
    const sessionShort = activeSession.sessionId.slice(0, 8);
    const branchName = `off-rail/${sessionShort}`;

    // Branch topology: 3-branch projects (working !== integration) skip the
    // remote PR/merge auto-ship and do a local merge into the working branch
    // only. Promote/release are explicit, human-led steps in 3-branch mode.
    const projectJsonForBranchConfig = loadProjectJson(projectRoot);
    const branchConfig = getBranchConfig(null, projectJsonForBranchConfig);
    const isThreeBranch = branchConfig.working !== branchConfig.integration;

    const storyLine = activeSession.problemId ? `\nStory: ${activeSession.problemId}` : "";
    const commitMessage = `feat(off-rail): ${activeSession.reason.slice(0, 50)}\n\nSession: ${activeSession.sessionId}\nDuration: ${formatDuration(endEntry.durationMs)}\nFiles: ${changes.total}${storyLine}\n\n#off-rail-work\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`;

    const shipSteps = [];

    // Where we got to. The first shipSteps push happens well inside the try, so
    // a throw before it leaves shipSteps legitimately empty — which reads as
    // "nothing happened" when in fact something failed. This records the stage
    // so the catch can say where it stopped.
    let shipStage = "branch_create";

    try {
      // Step 1: Create off-rail branch and commit
      execSync(`git checkout -b ${branchName}`, { cwd: projectRoot, encoding: "utf8" });
      shipStage = "stage_files";
      if (shipScope.scoped) {
        // SCOPED STAGE. Only the session's own write scope plus the session
        // artifacts enter the index; every other dirty or untracked path stays in
        // the worktree and is enumerated on the response. Prevention at staging,
        // not enumeration after the commit: `scope_reconcile` is a post-hoc audit
        // of a commit that already exists, and commit f8ff97b1 is the proof that
        // a report nobody acts on does not keep a foreign file out of a story.
        //
        // Pathspecs are REAL worktree paths resolved through matchesScopePattern,
        // never raw `allowedFiles` entries — a glob handed to `git add` as a
        // literal pathspec stages nothing at all.
        if (shipScope.stagePaths.length > 0) {
          const addScoped = spawnSync("git", ["add", "--", ...shipScope.stagePaths], {
            cwd: projectRoot,
            encoding: "utf8",
            timeout: 60_000,
          });
          if (addScoped.status !== 0) {
            throw new Error(`git add of the ship scope failed: ${(addScoped.stderr || "").trim()}`);
          }
        }
      } else {
        // NO SCOPE (no problemId, or a story with no targetFiles) — or the
        // worktree could not be enumerated. Fall back to the historical sweep:
        // the escape hatch must still ship, and committing nothing here would
        // wedge exactly the sessions that have the least structure.
        execSync("git add -A", { cwd: projectRoot, encoding: "utf8" });
      }
      shipStage = "staging_check";

      // Check if there's actually anything to commit (changes may already be committed during the session)
      const stagingCheck = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: projectRoot });
      if (stagingCheck.status === 0) {
        // Nothing staged — changes were committed during the session
        // Clean up the temp branch we created
        execSync(`git checkout ${gitState.branch}`, { cwd: projectRoot, encoding: "utf8", stdio: "ignore" });
        spawnSync("git", ["branch", "-D", branchName], { cwd: projectRoot, encoding: "utf8" });

        // ALL CHANGES OUT OF SCOPE — NOT the same thing as "already committed".
        //
        // This branch was written when staging was `git add -A`, which could only
        // leave an empty index if the session genuinely had nothing uncommitted.
        // Scoped staging breaks that equivalence: a session whose entire change
        // set falls outside allowedFiles now stages nothing while its work sits in
        // the worktree. Neither exit below is honest for it —
        //   - aheadCount > 0 would direct-push unrelated commits and set
        //     autoShipped:true with telemetry guardrails.direct_pushed, i.e. a
        //     false `shipped`; that is exactly the defect class
        //     backlog.fix.offrail-autoship-else-branch-false-ship closed, and
        //     tests/unit/guardrails-zero-change-no-false-ship.test.mjs is its
        //     standing witness;
        //   - aheadCount === 0 would claim the changes "were already committed and
        //     pushed", which is false while they are uncommitted on disk.
        // Return before either. autoShipped stays false, so resolveShipOutcome
        // derives nothing_to_ship and can never derive shipped here.
        if (allOutOfScope) {
          response.autoShipped = false;
          response.message =
            `Nothing was committed: all ${unstagedOutOfScope.length} changed path(s) fall outside the write `
            + `scope of story ${activeSession.problemId ?? "(none)"}, so nothing was staged. The work is still `
            + `in the worktree, unstaged — commit it under a story that owns those files.`;
          return finalizeShipOutcome(response);
        }

        // Check if there are unpushed commits that need to be pushed
        const aheadCheck = spawnSync("git", ["rev-list", "--count", `origin/${gitState.branch}..${gitState.branch}`], { cwd: projectRoot, encoding: "utf8" });
        const aheadCount = parseInt(aheadCheck.stdout?.trim() || "0", 10);

        if (aheadCount > 0) {
          // GATE ALPHA — the empty-index path. Nothing is staged because the work
          // was committed mid-session, but it is real session work about to be
          // pushed (:1639) or reported as shipped (:1631). Both exits sit inside
          // this `if`, so one gate here dominates them.
          const gateAlpha = await runOffRailEnforcementGate({
            projectRoot,
            projectId,
            activeSession,
            changedFiles: [...changes.changed, ...changes.newFiles],
            allowedFiles: scopeSnapshot?.allowedFiles ?? null,
            gate: "gate_alpha",
            override: options.enforcementOverride,
            // NO COMMIT EXISTS on this path — the index is empty and this ship
            // produced nothing to read. The gate reports the scope reconcile as
            // unevaluated (`reason: "no_commit"`) rather than manufacturing a
            // clean result out of the staging-time intent set.
            commitId: null,
            noteRel: storyNoteRel,
          });
          shipSteps.push(...gateAlpha.steps);
          response.shipSteps = shipSteps;
          response.reviewVerdict = gateAlpha.reviewVerdict;
          response.scopeViolations = gateAlpha.scopeViolations;
          if (gateAlpha.blockFindingCategories.length > 0) {
            response.blockFindingCategories = gateAlpha.blockFindingCategories;
          }
          if (gateAlpha.overrideApplied) {
            response.enforcementOverride = { applied: true, reason: gateAlpha.overrideReason };
          }
          if (gateAlpha.haltReason) {
            // The commits stay local and unpushed on the working branch —
            // recoverable, nothing stranded.
            response.autoShipped = false;
            response.haltReason = gateAlpha.haltReason;
            response.haltedAt = gateAlpha.haltedAt;
            response.recoveryBranch = gitState.branch;
            response.message = `Off-rail ship halted at gate_alpha (${gateAlpha.haltReason}). ${aheadCount} commit(s) remain unpushed on ${gitState.branch}.`;
            return finalizeShipOutcome(response);
          }

          // 3-branch: commits remain local on the working branch. Promote is a
          // separate, human-led step (rks_promote dev → integration).
          if (isThreeBranch) {
            response.autoShipped = true;
            response.unpushedCommits = aheadCount;
            response.localOnly = true;
            response.message = `${aheadCount} off-rail commit(s) on ${gitState.branch} (3-branch local-only — use rks_promote to advance to ${branchConfig.integration})`;
            return finalizeShipOutcome(response);
          }

          // 2-branch: push directly to the working/integration branch
          const pushResult = spawnSync("git", ["push", "origin", gitState.branch], { cwd: projectRoot, encoding: "utf8" });
          if (pushResult.status !== 0) {
            response.autoShipped = false;
            response.shipError = `Failed to push ${aheadCount} commit(s): ${pushResult.stderr?.trim()}`;
            response.message = `Off-rail commits exist locally but push failed. Manual push required: git push origin ${gitState.branch}`;
            return finalizeShipOutcome(response);
          }

          response.autoShipped = true;
          response.unpushedCommits = aheadCount;
          response.message = `Pushed ${aheadCount} off-rail commit(s) to ${gitState.branch}`;

          // Telemetry for direct push
          try {
            const collector = ensureTelemetryStorage(projectRoot);
            collector.emit("guardrails.direct_pushed", projectId, {
              sessionId: activeSession.sessionId,
              branch: gitState.branch,
              commitCount: aheadCount,
              reviewVerdict: gateAlpha.reviewVerdict,
              scopeViolations: gateAlpha.scopeViolations,
              enforcementPosture: gateAlpha.posture,
              ...(gateAlpha.overrideApplied ? { enforcementOverride: gateAlpha.overrideReason } : {}),
            });
            await collector.flush();
          } catch (e) { /* telemetry is best-effort */ }

          return finalizeShipOutcome(response);
        }

        // No unpushed commits — truly nothing to do. Do NOT claim the work was
        // "already committed and pushed": reaching here means nothing staged, so
        // there may have been nothing to commit in the first place.
        response.autoShipped = false;
        response.message = "Nothing to ship: no staged changes and no unpushed commits on "
          + `${gitState.branch}. Any session changes were already committed and pushed.`;
        return finalizeShipOutcome(response);
      }

      shipStage = "commit";
      const { commitId: fullCommitId, ragEmbedWarning: embedWarn } = await commitAndEmbed(projectRoot, commitMessage);
      const commitId = fullCommitId.slice(0, 8);
      if (embedWarn) response.ragEmbedWarning = embedWarn;
      shipSteps.push({ step: "commit", ok: true, branch: branchName, commitId });
      shipStage = "enforcement_gate";

      // GATE BETA — the main path. Placed AFTER the commit deliberately: the
      // commit is what makes the diff reviewable (<headCommit>..HEAD is empty
      // before it), and it is what makes a halt non-destructive — the work is a
      // reachable commit on off-rail/<sessionShort>, which is only deleted after
      // a successful merge. Placed BEFORE the isThreeBranch split so it dominates
      // the local merge, the branch delete, the push and commitAndPushNote.
      const gateBeta = await runOffRailEnforcementGate({
        projectRoot,
        projectId,
        activeSession,
        changedFiles: [...changes.changed, ...changes.newFiles],
        allowedFiles: scopeSnapshot?.allowedFiles ?? null,
        gate: "gate_beta",
        override: options.enforcementOverride,
        // THE COMMIT THIS SHIP JUST MADE. Gate beta runs after it, so there is a
        // real manifest to reconcile against — this is what makes `violations` an
        // observation rather than a restatement of intent.
        commitId,
        noteRel: storyNoteRel,
      });
      shipSteps.push(...gateBeta.steps);
      response.reviewVerdict = gateBeta.reviewVerdict;
      response.scopeViolations = gateBeta.scopeViolations;
      // ASSIGNED HERE, not spread into the response literal above — that literal
      // is built before the commit exists, so a manifest-sourced field written
      // there would itself be intent-sourced, which is the defect this story
      // closes reappearing one field over.
      // PRESENT WHENEVER THE SHIP WAS SCOPED, `[]` when nothing was admitted —
      // the convention its sibling `unstagedOutOfScope` already documents and
      // spreads on exactly this condition (see :2561 and :2592).
      //
      // Under the old `.length > 0` guard, "scoped ship, nothing admitted" and
      // "field not produced at all" were the SAME observation to a consumer, so
      // every reader needed a defensive `|| []` and could never tell an empty
      // disclosure from a missing one. Absence now means one thing only: the ship
      // was not scoped, so there was no admission decision to disclose.
      if (shipScope.scoped) {
        response.artifactAdmissions = gateBeta.artifactAdmissions;
      }
      if (gateBeta.blockFindingCategories.length > 0) {
        response.blockFindingCategories = gateBeta.blockFindingCategories;
      }
      if (gateBeta.overrideApplied) {
        response.enforcementOverride = { applied: true, reason: gateBeta.overrideReason };
      }
      if (gateBeta.haltReason) {
        response.autoShipped = false;
        response.shipSteps = shipSteps;
        response.haltReason = gateBeta.haltReason;
        response.haltedAt = gateBeta.haltedAt;
        response.recoveryBranch = branchName;
        response.commitId = commitId;
        response.message = `Off-rail ship halted at gate_beta (${gateBeta.haltReason}). Work is committed on ${branchName}; ${gitState.branch} is unchanged.`;
        return finalizeShipOutcome(response);
      }

      shipStage = "integrate";
      if (isThreeBranch) {
        // 3-branch: local merge off-rail branch into working branch (no push, no PR).
        // Promote/release are explicit, human-led steps.
        const lmResult = localMerge(projectRoot, branchName, gitState.branch);
        if (!lmResult.ok) {
          throw new Error(`Local merge failed: ${lmResult.error}`);
        }
        shipSteps.push({
          step: "local_merge",
          ok: true,
          from: branchName,
          to: gitState.branch,
          warning: lmResult.warning,
        });
        shipSteps.push({ step: "working_pr", skipped: true, reason: "three_branch_local_only" });
        shipSteps.push({ step: "working_merge", skipped: true, reason: "three_branch_local_only" });
        shipSteps.push({ step: "cycle_complete", skipped: true, reason: "three_branch_local_only" });

        response.autoShipped = true;
        response.shipSteps = shipSteps;
        response.commitId = commitId;
        response.localOnly = true;
        response.message = `Off-rail changes merged locally into ${gitState.branch} (3-branch — use rks_promote to advance to ${branchConfig.integration})`;

        try {
          const collector = ensureTelemetryStorage(projectRoot);
          collector.emit("guardrails.auto_shipped", projectId, {
            sessionId: activeSession.sessionId,
            commitId,
            filesChanged: changes.total,
            localOnly: true,
            workingBranch: gitState.branch,
            reviewVerdict: gateBeta.reviewVerdict,
            scopeViolations: gateBeta.scopeViolations,
            enforcementPosture: gateBeta.posture,
            ...(gateBeta.overrideApplied ? { enforcementOverride: gateBeta.overrideReason } : {}),
          });
          await collector.flush();
        } catch (e) { /* telemetry is best-effort */ }
      } else {
        // 2-branch: local merge into integration branch, delete feature branch,
        // push integration branch directly — no remote feature branch, one CI run.
        const lmResult = localMerge(projectRoot, branchName, gitState.branch);
        if (!lmResult.ok) {
          throw new Error(`Local merge failed: ${lmResult.error}`);
        }
        shipSteps.push({ step: "local-merge", ok: true, from: branchName, to: gitState.branch });

        // Ensure we're on the integration branch before deleting the feature branch
        execSync(`git checkout ${gitState.branch}`, { cwd: projectRoot, encoding: "utf8", stdio: "ignore" });

        // Delete local feature branch — commits are preserved in integration branch history.
        // `localMerge` above already invoked `git branch -d <feature>` internally; on a clean
        // fast-forward that deletion succeeded and the branch is already gone. Trust it first,
        // then fall back to `git branch -D` only if `localMerge` returned a warning OR the
        // branch still exists. Capture stderr on real failures so the shipSteps entry carries
        // a non-empty error message instead of a silent `ok: false`.
        const branchListResult = spawnSync("git", ["branch", "--list", branchName], { cwd: projectRoot, encoding: "utf8" });
        const branchStillExists = (branchListResult.stdout || "").trim().length > 0;
        if (!branchStillExists) {
          // localMerge's internal `-d` succeeded — branch is gone, record idempotent success.
          shipSteps.push({ step: "delete-branch", ok: true, branch: branchName });
        } else {
          // Fallback: force-delete the branch that localMerge could not remove. Capture stderr.
          const deleteResult = spawnSync("git", ["branch", "-D", branchName], { cwd: projectRoot, encoding: "utf8" });
          if (deleteResult.status === 0) {
            shipSteps.push({ step: "delete-branch", ok: true, branch: branchName });
          } else {
            const errMsg = (deleteResult.stderr || deleteResult.stdout || "git branch -D exited non-zero with no stderr").trim();
            shipSteps.push({ step: "delete-branch", ok: false, branch: branchName, error: errMsg });
          }
        }

        // Push integration branch to origin directly — one CI run on the branch that matters
        const pushResult = spawnSync("git", ["push", "origin", gitState.branch], { cwd: projectRoot, encoding: "utf8" });
        if (pushResult.status !== 0) {
          throw new Error(`Push failed: ${pushResult.stderr?.trim()}`);
        }
        shipSteps.push({ step: "push-staging", ok: true, branch: gitState.branch });

        // backlog.fix.cycle-complete-ungated-hard-reset: this is caller #4 — the auto-ship that
        // terminates every documented off-rail build per CLAUDE.md, and therefore the most
        // dangerous route into the destructive reset. It is deliberately NOT opted in.
        //
        // On the healthy path the gate never fires: the push at the top of this block has already
        // sent `gitState.branch` to origin, so the working branch is not ahead and the reset is a
        // no-op. The gate only bites when that push was skipped or failed and local commits
        // remain — which is precisely the state in which the old unconditional reset destroyed
        // them. Refusing and reporting is the correct outcome there; hardcoding `true` here would
        // reinstate the defect at its worst call site.
        const cycleResult = await runCycleComplete({ projectRoot, discardLocalCommits: false });
        shipSteps.push({
          step: "cycle_complete",
          ok: cycleResult.ok,
          branch: cycleResult.branch,
          // collectFailedShipSteps already promotes an `ok: false` step into failedShipSteps;
          // carry the cause so the Dispatcher sees WHY and how to proceed, not just that it failed.
          ...(cycleResult.ok ? {} : {
            error: cycleResult.error,
            ...(cycleResult.hint ? { hint: cycleResult.hint } : {}),
            ...(cycleResult.localCommitsDiscarded ? { localCommitsDiscarded: cycleResult.localCommitsDiscarded } : {}),
          }),
        });

        // Advance the off-rail story's phase to `integrated` so rks_release sees it as
        // releasable (populates releasedStories). The off-rail flow never runs rks_exec, so
        // this is the only place the arch-approved → executing → executed → integrated ladder
        // advances. Best-effort: a phase-advance failure must NOT undo the merge+push that
        // already succeeded — reconcileToIntegrated never throws; we only record the step.
        if (activeSession.problemId) {
          // Advisory lets the merge land; it must NOT also mark the story done.
          // The decision is the gate's (one implementation, no findings scan
          // here) — this branch only records it. RESTRUCTURED, not no-op'd:
          // phaseResult is declared BY the reconcileToIntegrated call, so the
          // ship-note block below cannot simply be left reading it.
          const advanceSuppression = gateBeta.phaseAdvanceSuppression;
          if (advanceSuppression) {
            // NO `ok` KEY, deliberately. Key ABSENCE is what marks this a
            // legitimate skip rather than a failure to any step-reducing
            // consumer; `ok: false` would report the gate doing its job as a bug.
            shipSteps.push({
              step: "advance_phase",
              skipped: true,
              reason: advanceSuppression.reason,
              // CONDITIONAL SPREAD, not an unconditional key. The legacy
              // suppression cause supplies no remedy, and its step must stay the
              // byte-identical three-keyed shape the source-literal test pins.
              ...(advanceSuppression.remedy ? { remedy: advanceSuppression.remedy } : {}),
            });
            // Dispatcher-visible, and NOT named autoShipSuppressed — see
            // resolveShipOutcome, which ranks that key above autoShipped and
            // would report this completed merge as "skipped".
            response.phaseAdvanceSuppressed = {
              reason: advanceSuppression.reason,
              // ABSENT, not undefined. Only the legacy cause measures these two;
              // the coverage and not-assessed causes measure neither, and emitting
              // them as `undefined` would advertise a measurement never taken.
              // Those causes carry their measured quantity inside the reason
              // string instead — these two keys count something else entirely.
              ...(advanceSuppression.categories ? { categories: advanceSuppression.categories } : {}),
              ...(advanceSuppression.findingCount !== undefined
                ? { findingCount: advanceSuppression.findingCount }
                : {}),
              ...(advanceSuppression.remedy ? { remedy: advanceSuppression.remedy } : {}),
            };
            // No reconcileToIntegrated, so no phase bump, so nothing to commit:
            // the ship-note step is not taken. That falls out of the existing
            // phaseResult.ok gate below — no second gate is added.
          } else {
            const phaseResult = await reconcileToIntegrated(projectRoot, activeSession.problemId, projectId);
            // Conditional spread so a permitted-under-partial-diff advance is
            // distinguishable in telemetry from a clean one. Reporting it as
            // clean would be the same defect wearing the opposite sign.
            shipSteps.push({ step: "advance_phase", ok: phaseResult.ok, to: phaseResult.to || null, ...(gateBeta.phaseAdvanceNotice ? { notice: gateBeta.phaseAdvanceNotice } : {}) });

            // bug #7: reconcileToIntegrated wrote the story note to `phase: integrated` on disk
            // with NO git (it runs after the commit+push above), leaving the note dirty and the
            // branch out of sync — which blocks the next rks_release. Persist the just-bumped
            // note so the tree ends clean and synced. Guarded on the phase advance actually
            // succeeding; a no-op when the note isn't dirty; never fails the ship on push error.
            if (phaseResult.ok) {
              const notePath = path.join(resolveNotesDir(projectRoot), `${activeSession.problemId}.md`);
              const noteResult = commitAndPushNote(
                projectRoot,
                notePath,
                gitState.branch,
                `chore(story): advance ${activeSession.problemId} to ${phaseResult.to || "integrated"}`,
              );
              if (!noteResult.skipped) {
                shipSteps.push({
                  step: "ship-note",
                  ok: noteResult.ok,
                  ...(noteResult.commitId ? { commitId: noteResult.commitId } : {}),
                  ...(noteResult.error ? { error: noteResult.error } : {}),
                });
              }
            }
          }
        }

        response.autoShipped = true;
        response.shipSteps = shipSteps;
        response.commitId = commitId;
        response.message = `Off-rail changes merged to ${gitState.branch} and pushed to origin/${gitState.branch}`;

        try {
          const collector = ensureTelemetryStorage(projectRoot);
          collector.emit("guardrails.auto_shipped", projectId, {
            sessionId: activeSession.sessionId,
            commitId,
            filesChanged: changes.total,
            reviewVerdict: gateBeta.reviewVerdict,
            scopeViolations: gateBeta.scopeViolations,
            enforcementPosture: gateBeta.posture,
            ...(gateBeta.overrideApplied ? { enforcementOverride: gateBeta.overrideReason } : {}),
          });
          await collector.flush();
        } catch (e) { /* telemetry is best-effort */ }
      }

    } catch (shipError) {
      response.failedStage = shipStage;
      response.autoShipped = false;
      response.shipSteps = shipSteps;
      response.shipError = shipError.message;
      response.message = `Failed to auto-ship off-rail changes: ${shipError.message}. Manual intervention required.`;

      // Try to get back to working branch on failure
      try {
        execSync(`git checkout ${gitState.branch}`, { cwd: projectRoot, encoding: "utf8", stdio: "ignore" });
      } catch (e) { /* best effort */ }
    }
  } else {
    // Distinguish "the caller told us not to ship" from "there was nothing to
    // ship" — exec.mjs and test-runner.mjs always suppress, and would otherwise
    // report nothing_to_ship on sessions that had real changes.
    //
    // Deliberately set HERE rather than before the gate above: an earlier
    // reference to the suppression flag would move the start of the source slice
    // in tests/unit/off-rail-enforcement-helpers.test.mjs, which anchors on the
    // first occurrence of that token.
    if (options.skipAutoShip) response.autoShipSuppressed = true;

    // An UNCOMPUTABLE change count lands here too, because getChangedFilesSince
    // reports total:0 when git failed. That is not "nothing to ship" — it is "we
    // do not know what there was to ship", and it must never resolve to shipped.
    // shipError makes resolveShipOutcome return "failed" (it outranks every other
    // branch), and the return is immediate so the ahead-count below never runs
    // against a state we could not measure.
    if (changeCountError) {
      response.autoShipped = false;
      response.shipError = `Could not compute the off-rail change count: ${changeCountError}`;
      response.message =
        `Change detection FAILED (${changeCountError}). No ship was attempted and nothing was pushed — `
        + `the session's work, if any, is still in the worktree. Resolve the git state and inspect manually.`;
      return finalizeShipOutcome(response);
    }

    // No uncommitted changes, but check for unpushed commits on staging
    // This handles the case where work was committed during off-rail but not pushed
    const isStaging = gitState.branch === "staging";

    if (isStaging) {
      try {
        // FETCH BEFORE COUNTING. `origin/<branch>` is a local remote-tracking ref
        // that goes stale the moment anyone else pushes; counting against it
        // without a fetch reported commits that were already on the remote — the
        // "102 unpushed commits" on a session that changed nothing.
        // Best-effort: an offline or absent remote must not fail the restore, so a
        // failed fetch only marks the count as possibly stale.
        const fetchResult = spawnSync("git", ["fetch", "origin", gitState.branch], {
          cwd: projectRoot,
          encoding: "utf8",
          timeout: 120_000,
        });
        if (fetchResult.error || fetchResult.status !== 0) {
          response.aheadCountStale = true;
        }

        const aheadCheck = spawnSync("git", ["rev-list", "--count", `origin/${gitState.branch}..${gitState.branch}`], { cwd: projectRoot, encoding: "utf8" });
        const aheadCount = parseInt(aheadCheck.stdout?.trim() || "0", 10);

        if (aheadCount > 0) {
          // DO NOT PUSH. Reaching this branch means the session changed nothing,
          // so any ahead commits are by construction NOT this session's work.
          // Pushing them and reporting a successful auto-ship told the Dispatcher
          // a ship had happened when the session had shipped nothing, so the
          // ship-claiming fields are gone from this path entirely. Report the
          // count as unpushedCommits instead — matching the already-
          // corrected in-gate sites — and leave them alone.
          response.autoShipped = false;
          response.unpushedCommits = aheadCount;
          response.message =
            `No changes detected during guardrails-off session. ${aheadCount} pre-existing unpushed `
            + `commit(s) on ${gitState.branch} were NOT pushed — this session did not author them. `
            + `Push them explicitly if that is what you want.`;

          // Telemetry for the detection (no push happened).
          try {
            const collector = ensureTelemetryStorage(projectRoot);
            collector.emit("guardrails.unpushed_detected", projectId, {
              sessionId: activeSession.sessionId,
              branch: gitState.branch,
              commitCount: aheadCount,
              pushed: false,
              ...(response.aheadCountStale ? { aheadCountStale: true } : {}),
            });
            await collector.flush();
          } catch (e) { /* telemetry is best-effort */ }
        } else {
          response.autoShipped = false;
          response.message = "No changes detected during guardrails-off session.";
        }
      } catch (e) {
        response.autoShipped = false;
        response.message = "No changes detected during guardrails-off session.";
      }
    } else {
      response.autoShipped = false;
      response.message = "No changes detected during guardrails-off session.";
    }
  }

  return finalizeShipOutcome(response);
}

/**
 * Validate hooks registration
 * 
 * Compares hooks present in .routekit/hooks/ with those registered in .claude/settings.json
 * 
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Analysis of hook registration status
 */
export function validateHooksRegistration(projectRoot) {
  const hooksDir = path.join(projectRoot, HOOKS_DIR);
  const settingsPath = path.join(projectRoot, ".claude/settings.json");

  // Get hook files from directory
  let hookFiles = [];
  if (fs.existsSync(hooksDir)) {
    try {
      for (const tier of ['system', 'write', 'read']) {
        const tierDir = path.join(hooksDir, tier);
        if (fs.existsSync(tierDir)) {
          fs.readdirSync(tierDir)
            .filter(f => f.endsWith('.mjs'))
            .forEach(f => hookFiles.push(f.replace('.mjs', '')));
        }
      }
    } catch (error) {
      // Directory exists but can't read - return empty array
    }
  }

  // Get registered hooks from settings
  let registeredHooks = [];
  let settingsExists = false;

  if (fs.existsSync(settingsPath)) {
    settingsExists = true;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.tools && settings.tools.bash && settings.tools.bash.hooks) {
        registeredHooks = settings.tools.bash.hooks;
      }
    } catch (error) {
      // Settings file exists but can't parse - treat as no registered hooks
    }
  }

  // Compare hooks
  const registered = hookFiles.filter(hook => registeredHooks.includes(hook));
  const unregistered = hookFiles.filter(hook => !registeredHooks.includes(hook));

  return {
    registered,
    unregistered,
    total: hookFiles.length,
    settingsExists
  };
}

/**
 * Get session history
 */
export function getSessionHistory(projectRoot, limit = 10) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  if (!fs.existsSync(logPath)) {
    return { ok: true, sessions: [], total: 0 };
  }

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);

  // Group start/end entries by sessionId
  const sessionMap = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const existing = sessionMap.get(entry.sessionId) || {};
      sessionMap.set(entry.sessionId, { ...existing, ...entry });
    } catch (e) {
      continue;
    }
  }

  // Convert to array and sort by startedAt
  const allSessions = Array.from(sessionMap.values())
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);

  // Get hooks health status
  const hooksHealth = getHooksHealth(projectRoot);

  // Detect state conflicts using state file
  const currentState = readGuardState(projectRoot);
  const activeSession = getActiveSession(projectRoot);

  const warnings = [];
  let resolvedActiveSession = activeSession;

  // Check for legacy hooks.bak directory
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);
  if (fs.existsSync(hooksBakPath)) {
    warnings.push("Legacy hooks.bak/ directory found. Next guardrails toggle will clean it up.");
  }

  // Auto-close stale sessions: state file says active but session log says open
  if (activeSession && currentState.active !== false) {
    const recoveryEntry = {
      sessionId: activeSession.sessionId,
      endedAt: new Date().toISOString(),
      endReason: "auto_recovered",
      durationMs: Date.now() - new Date(activeSession.startedAt).getTime(),
      changesDetected: 0,
      changedFiles: [],
      newFiles: [],
      autoWorkflow: false,
      note: "Session auto-closed on status check - state file shows active but session was never ended",
    };
    appendSessionLog(projectRoot, recoveryEntry);

    const closedSession = { ...activeSession, ...recoveryEntry };
    sessionMap.set(activeSession.sessionId, closedSession);
    const idx = allSessions.findIndex(s => s.sessionId === activeSession.sessionId);
    if (idx >= 0) {
      allSessions[idx] = closedSession;
    }

    warnings.push(`Auto-closed stale session ${activeSession.sessionId.slice(0, 8)}: state file shows active, session marked as recovered.`);
    resolvedActiveSession = null;
  }

  return {
    ok: true,
    sessions: allSessions,
    total: sessionMap.size,
    activeSession: resolvedActiveSession,
    hooksHealth,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
