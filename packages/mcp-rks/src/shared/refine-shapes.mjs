/**
 * Refine-owned story-body shapes: the literals refine.mjs's writers emit and arch-verdict.mjs's
 * subject digest recognizes, defined ONCE
 * (backlog.fix.arch-subject-digest-excludes-refine-context-sections).
 *
 * PURE: no imports. arch-verdict.mjs is imported by governor-token.mjs, guardrails-audit.mjs,
 * governance.mjs and server.mjs; importing refine.mjs there would pull glob, js-yaml,
 * @routekit/telemetry and utils/git into all of them.
 */

export const TARGET_HEADING_PREFIX = "### Target: ";
export const TARGET_SIGNATURE_LINE = "Current source (use for search_replace patterns):";
export const TEST_EXEMPLAR_HEADING_PREFIX = "### Test Exemplar: ";
export const TEST_EXEMPLAR_SIGNATURE_LINE = "Use this existing test as a pattern for imports, describe/it structure, and assertion syntax:";
export const TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE = "Use this as a pattern for imports, describe/it structure, and assertion syntax:";
export const TEST_FIX_HEADING_PREFIX = "### Test Fix Required: ";
export const REFINEMENT_HISTORY_HEADING_PREFIX = "## Refinement History (";
export const REFINE_ANCHOR_MARKER = "<!-- rks:refine-anchor -->";
export const OUT_OF_BAND_MARKER_PREFIX = "<!-- rks:context-out-of-band: ";

/**
 * The ARCH-owned section heading: column 0, whole line. Moved unchanged from arch-verdict.mjs so
 * the digest and insertBeforeArchGuidance locate the section with one rule (the LAST match).
 */
export const ARCH_GUIDANCE_LINE = /^## ARCH Guidance[ \t]*$/;

/**
 * Append `block` at the end of the reviewable body: before the LAST column-0 ARCH Guidance
 * heading when one exists, otherwise at end of body exactly as refine's writers did before.
 *   no heading: trim(body) + block   (byte-identical to the old `body.trim() + block`)
 *   heading:    trim(textBefore) + block.trimEnd() + blank line + headingLineAndRest (unchanged)
 * trimMode "trimEnd" is for the writer that used `body.trimEnd()` (fix_test_assertion).
 */
export function insertBeforeArchGuidance(body, block, { trimMode = "trim" } = {}) {
  const src = typeof body === "string" ? body : "";
  const add = typeof block === "string" ? block : "";
  const trimmed = (s) => (trimMode === "trimEnd" ? s.trimEnd() : s.trim());
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (ARCH_GUIDANCE_LINE.test(lines[i])) start = i;
  }
  if (start === -1) return trimmed(src) + add;
  const before = lines.slice(0, start).join("\n");
  const rest = lines.slice(start).join("\n");
  return trimmed(before) + add.trimEnd() + "\n\n" + rest;
}
