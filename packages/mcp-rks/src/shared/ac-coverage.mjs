/**
 * The ONE acCoverage cleaning rule.
 *
 * Applied by buildOffRailReviewStep in server/guardrails-audit.mjs, which
 * builds the review ship step the phase-advance gate reads, and by the
 * review.complete telemetry emit in server/review.mjs. Both apply it AFTER
 * redactAcCoverage, so the value recorded on disk is the shape the gate reads.
 *
 * ZERO IMPORTS, deliberately. review.mjs imports @routekit/rag (lancedb,
 * transformers), which is why guardrails-audit.mjs loads review.mjs only by
 * dynamic import. Neither module may import the other statically for this
 * rule, so both import this leaf. Same shape as shared/check-rollup.mjs, which
 * server/gh-tools.mjs imports and re-exports.
 */

/**
 * Bounds on the acCoverage payload.
 *
 * Exported so a test can READ the caps rather than restate them — a test that
 * hardcodes 25 passes against an implementation that hardcodes a different 25.
 * Precedent: `export const MAX_PERSISTED_FINDINGS = 25;` in review.mjs.
 * guardrails-audit.mjs re-exports both, so existing importers keep working.
 *
 * These arrays hold model-authored free text quoting acceptance criteria, and
 * the normalized value reaches the rks_guardrails_on response and telemetry,
 * so the payload is bounded at the producer rather than trusted to be small.
 */
export const MAX_AC_COVERAGE_ENTRIES = 25;
export const MAX_AC_COVERAGE_ENTRY_CHARS = 200;

/**
 * Coerce one list entry to a string. The ONE coercion rule.
 *
 * Exported for redactAcCoverage in review.mjs. A nested array is not a string,
 * so an entry-wise string scrub passes it untouched, and this coercion then
 * turns it into its joined contents AFTER scrubbing is over. redactAcCoverage
 * therefore coerces with this function first and scrubs the result, so the
 * two modules cannot disagree about what an entry becomes.
 *
 * THROWS on an entry String cannot coerce, such as a parsed object whose
 * toString is not callable, and must keep throwing. redactAcCoverage guards
 * each call and keeps such an entry unchanged, and the list helper below lets
 * the throw reach normalizeAcCoverage's catch. Making this total, for example
 * by returning an empty string, would turn that null into a present list and
 * flip the phase-advance decision.
 */
export function coerceAcCoverageEntry(entry) {
  return typeof entry === "string" ? entry : String(entry ?? "");
}

function normalizeAcCoverageList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_AC_COVERAGE_ENTRIES)
    .map((entry) => coerceAcCoverageEntry(entry))
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
export function normalizeAcCoverage(raw) {
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
