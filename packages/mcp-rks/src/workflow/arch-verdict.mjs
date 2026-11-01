/**
 * ARCH verdict computation — a frozen finding ledger with a hard round cap.
 *
 * The problem this solves: ARCH had no pass condition. It re-reviewed the whole
 * story against its checklist every round, so a fix that added surface added
 * findings, and round N's findings could be entirely disjoint from round N-1's.
 * Observed: round 1 returned 4 findings, all 4 were fixed, and round 2 returned
 * 4 NEW ones — at least one of which existed only because of the round-1 fix.
 *
 * The fix is to make the verdict a computation rather than an assertion, with a
 * termination argument that is arithmetic rather than behavioural:
 *
 *   1. Round 1 FREEZES the ledger — the submitted finding keys become the ledger.
 *   2. Round N > 1 may only SHRINK it — a submitted finding whose key is not
 *      already in the ledger is structurally non-blocking and is returned as
 *      `deferred`. Therefore ledger(N) ⊆ ledger(N-1).
 *   3. A hard cap closes the tail — at round >= ARCH_MAX_ROUNDS the verdict is
 *      `approved` regardless of residue, and the residue moves to `deferred`.
 *      GATE EXCEPTION: the rks_arch_verdict HANDLER (server.mjs), not this pure
 *      module, also runs plan_ready's shared create_target_no_authorable_block
 *      predicate on every call. Any such issue is reported in `gateIssues`, forces
 *      the final verdict to `needs-revision` (at the cap too — `capped` keeps its
 *      meaning), and never enters the ledger or `deferred`, so neither ledger
 *      freezing nor the cap can clear it. Only amending the story clears it.
 *
 * ARCH cannot lengthen the loop by finding more, and cannot lengthen it by
 * finding the same thing again. Keys are derived here from { item, file }, so a
 * caller cannot supply one — and renaming a round-1 finding would only move it
 * to `deferred`, which shrinks the blocking set. Every remaining degree of
 * freedom points toward termination.
 *
 * This module is PURE: no filesystem, clock, network or randomness. It is
 * unit-testable without a project on disk.
 */

import { createHash } from "node:crypto";
import {
  ARCH_GUIDANCE_LINE,
  TARGET_HEADING_PREFIX,
  TARGET_SIGNATURE_LINE,
  TEST_EXEMPLAR_HEADING_PREFIX,
  TEST_EXEMPLAR_SIGNATURE_LINE,
  TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE,
  TEST_FIX_HEADING_PREFIX,
  REFINEMENT_HISTORY_HEADING_PREFIX,
  REFINE_ANCHOR_MARKER,
  OUT_OF_BAND_MARKER_PREFIX,
} from "../shared/refine-shapes.mjs";

/**
 * Hard ceiling on ARCH rounds — counted PER SUBJECT, not per story id.
 * At this round the verdict is `approved`.
 * Exception: the handler's plan-ready create gate — a story with
 * create_target_no_authorable_block issues (reported in `gateIssues`) is
 * `needs-revision` at every round, including this one.
 *
 * Because a `needs-revision` verdict REQUIRES an amendment to clear it, and any material
 * amendment rebases the subject, `round` is 1 on essentially every call of the normal loop
 * and this ceiling is not reached by it. That is correct for what it measures — rounds
 * against one version — but it means this number is NOT a bound on total ARCH cost for a
 * story. `arch_total_rounds` is that measure. It is advisory and surfaced only: it never
 * feeds `capped`, the verdict, or the phase.
 */
export const ARCH_MAX_ROUNDS = 3;

/** Stable ordering so key insertion order cannot change a digest. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = stable(value[k]);
        return acc;
      }, {});
  }
  return value === undefined ? null : value;
}

/** The heading ARCH writes its narrative under, per `.rks/prompts/governor-arch.md`. */
export const ARCH_GUIDANCE_HEADING = "## ARCH Guidance";

/**
 * A line whose ENTIRE text is the guidance heading, at column 0.
 *
 * LINE-ANCHORED BY NECESSITY, not by preference. A substring `indexOf` is a defect:
 * a story ABOUT this mechanism quotes the heading many times in ordinary prose, and
 * `body.indexOf("## ARCH Guidance")` resolves to the FIRST such quotation — which on a
 * real note sits inside the Problem section, so a strip from there to the next `## `
 * would silently delete Problem, Solution, Acceptance Criteria and Target Files from
 * the digested subject. Undetectable downstream, because the digest is a hash.
 *
 * Indentation is therefore NOT tolerated: `   ## ARCH Guidance` is prose quoting the
 * heading, not the heading. The prompt's own worked template is indented for exactly
 * that reason.
 */
// ARCH_GUIDANCE_LINE is imported from ../shared/refine-shapes.mjs: the digest and the refine writers
// (insertBeforeArchGuidance) locate the ARCH-owned section with one rule.

/** A line that STARTS a new level-2 section. Not `## ` occurring anywhere within a line. */
const SECTION_BREAK = /^## /;

/**
 * Remove the ARCH-owned `## ARCH Guidance` section from a note body.
 *
 * Where more than one line-anchored heading is present the LAST is taken as the
 * ARCH-owned one. `governor-arch.md` mandates that repeated passes converge on exactly
 * one section, and ARCH's first-pass branch appends near the END of the note — so the
 * last line-anchored heading is the one ARCH wrote, and an earlier one is a story that
 * quotes the heading at column 0 in its own prose. Picking the first would strip the
 * reviewable material between them.
 *
 * Total: a body with no line-anchored heading is returned unchanged.
 */
export function stripArchGuidanceSection(body) {
  const src = typeof body === "string" ? body : "";
  const lines = src.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (ARCH_GUIDANCE_LINE.test(lines[i])) start = i;
  }
  if (start === -1) return src;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (SECTION_BREAK.test(lines[i])) {
      end = i;
      break;
    }
  }

  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** A line made of whitespace only (or empty). */
const BLANK_LINE = /^\s*$/;

// ── Refine-owned content (backlog.fix.arch-subject-digest-excludes-refine-context-sections) ──
//
// The literals come from ../shared/refine-shapes.mjs, the module refine.mjs's writers
// interpolate, so a writer cannot drift from what the digest recognizes. The fence literal is
// refine.mjs's FENCE ("```"); it is not a refine-owned shape on its own, so it is restated here
// rather than widening the shared module.
const FENCE_LINE = "```";
/** An opening fence as refine writes it: the fence plus an optional language tag. */
const FENCE_OPEN = /^```[^`]*$/;
/** Any markdown heading line: ends a fix_test_assertion reason paragraph. */
const HEADING_LINE = /^#{1,6}\s/;
/** A clarify_ac checkbox line. Never a history line: it is acceptance scope (row 8). */
const CHECKBOX_LINE = /^- \[[ xX]\]/;
/** What follows REFINEMENT_HISTORY_HEADING_PREFIX on the history heading refine writes. */
const HISTORY_HEADING_TAIL = /^\d{4}-\d{2}-\d{2}\)$/;
/** The `### <file>` heading of an add_search_pattern anchor block. */
const ANCHOR_FILE_HEADING = /^### \S/;

/**
 * Index of the closing fence of a fenced block whose opening line is lines[i], or -1. The
 * closing line is exactly the fence refine writes; anything else leaves the block unmatched.
 */
function matchFence(lines, i) {
  if (i >= lines.length || !FENCE_OPEN.test(lines[i])) return -1;
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j] === FENCE_LINE) return j;
  }
  return -1;
}

/**
 * Rows 1, 3 and 4: heading, blank, a fixed signature line, blank, exactly ONE fenced block.
 * Returns the index of the closing fence, or -1 when the shape does not match exactly.
 */
function matchSignatureSection(lines, i, headingPrefix, signatures) {
  const heading = lines[i];
  if (!heading.startsWith(headingPrefix) || heading.length === headingPrefix.length) return -1;
  if (lines[i + 1] !== "" || !signatures.includes(lines[i + 2]) || lines[i + 3] !== "") return -1;
  return matchFence(lines, i + 4);
}

/** Row 2: the out-of-band marker, one whole line. */
function matchOutOfBandMarker(lines, i) {
  const line = lines[i];
  return line.startsWith(OUT_OF_BAND_MARKER_PREFIX)
    && line.endsWith(" -->")
    && line.length > OUT_OF_BAND_MARKER_PREFIX.length + " -->".length
    ? i
    : -1;
}

/**
 * Row 5: the refine-anchor marker, `### <file>`, blank, `@@SEARCH`, X, `@@REPLACE`, X, `@@END`.
 * Matched ONLY when the SEARCH text equals the REPLACE text (an identity anchor): a marked
 * block that edits something is buildable intent and stays inside. Returns the `@@END` index.
 */
function matchIdentityAnchor(lines, i) {
  if (lines[i] !== REFINE_ANCHOR_MARKER) return -1;
  if (!ANCHOR_FILE_HEADING.test(lines[i + 1] ?? "") || lines[i + 2] !== "" || lines[i + 3] !== "@@SEARCH") return -1;
  const search = [];
  let k = i + 4;
  for (; k < lines.length && lines[k] !== "@@REPLACE"; k += 1) {
    if (lines[k] === "@@SEARCH" || lines[k] === "@@END") return -1;
    search.push(lines[k]);
  }
  if (k >= lines.length) return -1;
  const replace = [];
  for (k += 1; k < lines.length && lines[k] !== "@@END"; k += 1) {
    if (lines[k] === "@@SEARCH" || lines[k] === "@@REPLACE") return -1;
    replace.push(lines[k]);
  }
  if (k >= lines.length) return -1;
  return search.join("\n") === replace.join("\n") ? k : -1;
}

/**
 * Row 6: the `### Test Fix Required:` heading, blank, and ONE reason paragraph (to the next
 * blank line or heading). Later paragraphs of a multi-paragraph reason stay inside.
 */
function matchTestFixSection(lines, i) {
  const heading = lines[i];
  if (!heading.startsWith(TEST_FIX_HEADING_PREFIX) || heading.length === TEST_FIX_HEADING_PREFIX.length) return -1;
  if (lines[i + 1] !== "") return -1;
  const isParagraphLine = (l) => typeof l === "string" && !BLANK_LINE.test(l) && !HEADING_LINE.test(l);
  if (!isParagraphLine(lines[i + 2])) return -1;
  let j = i + 2;
  while (isParagraphLine(lines[j + 1])) j += 1;
  return j;
}

/**
 * Row 7: `## Refinement History (YYYY-MM-DD)` and the contiguous `- ` history lines after it.
 * A checkbox line ends the run (clarify_ac appends directly under a history section), as does
 * any non-dash line. A heading with no history line is not refine's shape and stays inside.
 */
function matchRefinementHistory(lines, i) {
  const heading = lines[i];
  if (!heading.startsWith(REFINEMENT_HISTORY_HEADING_PREFIX)) return -1;
  if (!HISTORY_HEADING_TAIL.test(heading.slice(REFINEMENT_HISTORY_HEADING_PREFIX.length))) return -1;
  let j = i;
  while (j + 1 < lines.length && lines[j + 1].startsWith("- ") && !CHECKBOX_LINE.test(lines[j + 1])) j += 1;
  return j > i ? j : -1;
}

/**
 * Remove exactly the refine-owned spans (rows 1-7 of the story's shape table) from a body,
 * together with the whitespace-only lines directly above each span (the blank separator the
 * writer emitted).
 *
 * Each span is bounded by its writer's EXACT shape, never by "run to the next heading": text
 * that follows a refine block in the same section stays in the fingerprint. A line that does
 * not complete a shape is kept, so any ambiguous span resolves to INSIDE. Not exported through
 * any writer: refine records nothing from here; the digest alone calls it.
 *
 * Total: a non-string body is treated as "".
 */
export function stripRefineOwnedContent(body) {
  const src = typeof body === "string" ? body : "";
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let end = matchSignatureSection(lines, i, TARGET_HEADING_PREFIX, [TARGET_SIGNATURE_LINE]);
    if (end === -1) {
      end = matchSignatureSection(lines, i, TEST_EXEMPLAR_HEADING_PREFIX, [
        TEST_EXEMPLAR_SIGNATURE_LINE,
        TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE,
      ]);
    }
    if (end === -1) end = matchOutOfBandMarker(lines, i);
    if (end === -1) end = matchIdentityAnchor(lines, i);
    if (end === -1) end = matchTestFixSection(lines, i);
    if (end === -1) end = matchRefinementHistory(lines, i);
    if (end === -1) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    while (out.length > 0 && BLANK_LINE.test(out[out.length - 1])) out.pop();
    i = end + 1;
  }
  return out.join("\n");
}

/**
 * The CANONICAL subject body: the body minus the ARCH-owned section, with the whitespace
 * at that section's boundary and at end-of-body canonicalized.
 *
 * backlog.fix.arch-subject-digest-guidance-boundary-whitespace. stripArchGuidanceSection
 * removes the section from its heading line onward but KEEPS the blank separator that a
 * first-pass append writes above the heading. On a body with no trailing newline that
 * append (`X` -> `X\n\n## ARCH Guidance\n...`) leaves the stripped body one byte longer
 * (`X\n`), so the digest recorded by the verdict no longer matched after ARCH's mandated
 * narrative write. Whitespace at that boundary and at EOF is not reviewable material, so:
 *
 *   1. strip the section with the SAME line-anchored rule (last column-0 heading, through
 *      the next level-2 heading or EOF) — decoy handling is unchanged;
 *   2. when a section was stripped, drop the whitespace-only lines directly above it;
 *   3. when content follows the stripped section, rejoin with exactly one blank line;
 *   4. trimEnd() the result, whether or not a section was present.
 *
 * backlog.fix.arch-subject-digest-excludes-refine-context-sections: between 3 and 4, refine-owned
 * content is removed (stripRefineOwnedContent) — AFTER the ARCH span was located on the
 * original body. `refineCarveOut: false` reproduces the pre-carve-out canonical body exactly;
 * it exists only for the comparison-only preCarveOutSubjectDigest.
 *
 * backlog.fix.arch-subject-digest-whitespace-robust: `normaliseWhitespace: true` (fingerprint
 * version 2, ARCH_SUBJECT_VERSION) then applies normaliseSubjectWhitespace to the result. The
 * default `false` is today's (version 1) form exactly; v1SubjectDigest and the compat digests use
 * it.
 *
 * Total: a non-string body is treated as "".
 */
function canonicalSubjectBody(body, { refineCarveOut = true, normaliseWhitespace = false } = {}) {
  const carve = (s) => (refineCarveOut ? stripRefineOwnedContent(s) : s);
  const finish = (s) => (normaliseWhitespace ? normaliseSubjectWhitespace(s) : s);
  const src = typeof body === "string" ? body : "";
  const lines = src.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (ARCH_GUIDANCE_LINE.test(lines[i])) start = i;
  }
  if (start === -1) return finish(carve(src).trimEnd());

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (SECTION_BREAK.test(lines[i])) {
      end = i;
      break;
    }
  }

  const before = lines.slice(0, start);
  while (before.length > 0 && BLANK_LINE.test(before[before.length - 1])) before.pop();
  const after = lines.slice(end);

  let joined;
  if (after.length === 0) joined = before.join("\n");
  else if (before.length === 0) joined = after.join("\n");
  else joined = `${before.join("\n")}\n\n${after.join("\n")}`;
  // ORDER (ARCH round-1 finding 1): the ARCH span was located on the ORIGINAL body above, so
  // removing a refine-owned `## Refinement History (` heading here cannot stretch it to EOF.
  return finish(carve(joined).trimEnd());
}

/** A fence opener after trimStart(): a run of 3+ backticks or tildes. */
const PROTECTED_FENCE_OPEN = /^(`{3,}|~{3,})/;

/**
 * Fingerprint version 2's whitespace normalisation
 * (backlog.fix.arch-subject-digest-whitespace-robust), applied AFTER the ARCH section strip and
 * the refine carve-out. Outside protected regions only: (a) a whitespace-only line becomes empty,
 * (b) a run of 2+ blank lines collapses to one. Then (c) the whole result is trimmed at both
 * ends; that final trim is the only step that can touch a protected region.
 *
 * Protected regions, recognised line by line (at least as broad as the anchor consumers, e.g.
 * llm/planner.mjs matches `@@SEARCH` by trim() equality):
 *   - a fence opens on a line whose trimStart() begins with ``` or ~~~ (run length N >= 3) and
 *     closes on the next line whose trim() is only that marker character repeated N+ times;
 *   - an `@@SEARCH` region opens on a line whose trim() is "@@SEARCH" and closes on the next line
 *     whose trim() is "@@END";
 *   - an unclosed region is protected to the end of the body;
 *   - no nesting: while a region is open no other opener is recognised. Every line from the
 *     opener through the closer is preserved byte-for-byte.
 *
 * Whitespace layout outside those regions is not reviewable material, so this cannot mask a
 * content amendment; inside them it is (two distinct anchors must never hash equal).
 */
function normaliseSubjectWhitespace(text) {
  const lines = String(text).split("\n");
  const out = [];
  let region = null; // null | { kind: "fence", ch, n } | { kind: "search" }
  let lastBlank = false;
  for (const line of lines) {
    if (region !== null) {
      out.push(line);
      const t = line.trim();
      if (region.kind === "search") {
        if (t === "@@END") region = null;
      } else if (t.length >= region.n && [...t].every((c) => c === region.ch)) {
        region = null;
      }
      lastBlank = false;
      continue;
    }
    const fence = PROTECTED_FENCE_OPEN.exec(line.trimStart());
    if (fence) {
      region = { kind: "fence", ch: fence[1][0], n: fence[1].length };
      out.push(line);
      lastBlank = false;
      continue;
    }
    if (line.trim() === "@@SEARCH") {
      region = { kind: "search" };
      out.push(line);
      lastBlank = false;
      continue;
    }
    if (BLANK_LINE.test(line)) {
      if (!lastBlank) out.push("");
      lastBlank = true;
      continue;
    }
    out.push(line);
    lastBlank = false;
  }
  return out.join("\n").trim();
}

/**
 * The version of the fingerprint subjectDigest computes. Version 2 is the whitespace-normalised
 * canonical form (backlog.fix.arch-subject-digest-whitespace-robust). Writers record it beside
 * the digest (arch_subject_version, planSubjectVersion). A later change to the fingerprint keeps
 * the outgoing function under its version name and bumps this constant.
 */
export const ARCH_SUBJECT_VERSION = 2;

/**
 * True iff `value` is a string or a number whose String(value).trim() is the current version.
 * The handler writes every arch_* scalar as a string ("2"); a number is accepted for a
 * YAML-unquoted value. Anything else (absent, null, "", "1", "3", arrays, objects, booleans) is
 * UNVERSIONED: compared against the version-1, legacy and pre-carve-out digests.
 */
export function isCurrentArchSubjectVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  return String(value).trim() === String(ARCH_SUBJECT_VERSION);
}

/** sha256 of the stable JSON of the three subject inputs, hex sliced to 32. */
function digestSubject(strippedBody, targetFiles, testRequirements) {
  const canonical = JSON.stringify(
    stable({
      body: strippedBody,
      targetFiles: targetFiles ?? null,
      testRequirements: testRequirements ?? null,
    }),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Digest of the material ARCH's checklist is actually applied to.
 *
 * TWO exclusions, and they are the crux.
 *
 * The frontmatter exclusion is enforced by CONSTRUCTION rather than by a denylist:
 * this function is handed only the body, `targetFiles` and `testRequirements`, so the
 * arch-owned fields, `updated` and `phase` cannot leak in. Include any of them and the
 * digest changes on every recorded verdict — every round then looks amended, the ledger
 * resets every round, and the mechanism becomes the unbounded loop it replaced. The
 * failure mode of getting this wrong is not a smaller reset; it is total loss of
 * termination.
 *
 * The BODY needed the same treatment and did not have it, which is the defect
 * `backlog.fix.arch-guidance-write-self-rebases-ledger` closes. The body had no
 * arch-owned / reviewable partition at all, while `governor-arch.md` step 3(b) REQUIRES
 * ARCH to write its narrative into that body on every pass — approved, needs-revision
 * and RAG-unavailable alike. So the tool invalidated, as a normal step of its own
 * review, the subject it had just recorded: `round` was permanently 1 on the mandated
 * path, the `deferred` channel never fired, `ARCH_MAX_ROUNDS` was unreachable, and the
 * `ledger(N) ⊆ ledger(N-1)` termination argument in this module's header was vacuous
 * because there was never an N greater than 1.
 *
 * The ARCH-owned section is now subtracted before digesting. Everything else in the
 * body remains reviewable material: an amendment to it still rebases, which is correct
 * and is guarded separately.
 *
 * The stripped body is CANONICALIZED (canonicalSubjectBody): whitespace above the stripped
 * section and at end-of-body is normalized, so the first-pass append of the section cannot
 * move the digest whatever whitespace the body ended in
 * (backlog.fix.arch-subject-digest-guidance-boundary-whitespace). Digests recorded before
 * that fix are matched through legacySubjectDigest at every comparison site.
 *
 * Fingerprint VERSION 2 (ARCH_SUBJECT_VERSION; backlog.fix.arch-subject-digest-whitespace-robust):
 * the canonical body is also whitespace-normalised outside protected regions, so no refine
 * row 1-7 write moves it wherever the writer's trim or separators land. Recordings that carry no
 * current version are compared against v1SubjectDigest (today's form before this change), never
 * against this.
 */
export function subjectDigest({ body, targetFiles, testRequirements } = {}) {
  return digestSubject(canonicalSubjectBody(body, { normaliseWhitespace: true }), targetFiles, testRequirements);
}

/**
 * The VERSION-1 subject digest: byte-for-byte what subjectDigest computed before
 * backlog.fix.arch-subject-digest-whitespace-robust — ARCH strip, boundary canonicalisation,
 * refine carve-out and trimEnd, with NO whitespace normalisation. Not a new compat form: it is
 * the previous fingerprint under its version name, consulted only for UNVERSIONED recordings
 * (no current arch_subject_version / planSubjectVersion). Writers record only subjectDigest.
 */
export function v1SubjectDigest({ body, targetFiles, testRequirements } = {}) {
  return digestSubject(canonicalSubjectBody(body, { normaliseWhitespace: false }), targetFiles, testRequirements);
}

/**
 * noteSubjectDigest's field mapping applied to v1SubjectDigest. The ONE function the
 * rks_arch_verdict handler, the guardrails-off story gate and the governor-init stale check call
 * for the version-1 digest.
 *
 * @param {{ data?: object, content?: string } | null | undefined} parsed
 * @returns {string} 32 hex characters
 */
export function noteV1SubjectDigest(parsed) {
  return v1SubjectDigest({
    body: parsed?.content || "",
    targetFiles: parsed?.data?.targetFiles,
    testRequirements: parsed?.data?.testRequirements,
  });
}

/**
 * The PRE-FIX subject digest, byte-for-byte what subjectDigest computed before
 * backlog.fix.arch-subject-digest-guidance-boundary-whitespace: the section is stripped
 * but the body is NOT canonicalized.
 *
 * COMPARISON-ONLY. Digests persisted before the fix (arch_subject, planSubjectDigest) were
 * computed this way; a site comparing a persisted digest against the current note accepts
 * a match on EITHER this or the canonical digest, so the normalization does not read as an
 * amendment of every already-recorded story. Writers record only subjectDigest. A material
 * amendment to reviewable text moves both digests, so the compat match cannot mask one.
 */
export function legacySubjectDigest({ body, targetFiles, testRequirements } = {}) {
  return digestSubject(
    stripArchGuidanceSection(typeof body === "string" ? body : ""),
    targetFiles,
    testRequirements,
  );
}

/**
 * The ONE mapping from a parsed note to its ARCH subject digest.
 *
 * Takes a `parseFrontmatter` result ({ data, content }) and returns exactly the digest
 * `rks_arch_verdict` records as `arch_subject`. Both the verdict handler (server.mjs) and
 * the guardrails-off story gate (guardrails-audit.mjs) call THIS function, so the gate's
 * "has the story changed since ARCH approved it?" comparison can never drift from what the
 * handler recorded: there is one hash (subjectDigest) and one field mapping (here).
 *
 * Inherits subjectDigest's exclusions: only the body (minus `## ARCH Guidance`),
 * `targetFiles` and `testRequirements` are inputs, so the pipeline's own writes — arch_*
 * fields, an id back-fill, phase, updated, testFiles and the ARCH Guidance narrative —
 * leave the digest unchanged.
 *
 * @param {{ data?: object, content?: string } | null | undefined} parsed
 * @returns {string} 32 hex characters
 */
export function noteSubjectDigest(parsed) {
  return subjectDigest({
    body: parsed?.content || "",
    targetFiles: parsed?.data?.targetFiles,
    testRequirements: parsed?.data?.testRequirements,
  });
}

/**
 * noteSubjectDigest's field mapping applied to legacySubjectDigest — the pre-fix digest of
 * a parsed note. Comparison-only; see legacySubjectDigest.
 *
 * @param {{ data?: object, content?: string } | null | undefined} parsed
 * @returns {string} 32 hex characters
 */
export function noteLegacySubjectDigest(parsed) {
  return legacySubjectDigest({
    body: parsed?.content || "",
    targetFiles: parsed?.data?.targetFiles,
    testRequirements: parsed?.data?.testRequirements,
  });
}

/**
 * The PRE-CARVE-OUT subject digest: byte-for-byte what subjectDigest computed before
 * backlog.fix.arch-subject-digest-excludes-refine-context-sections — the ARCH Guidance strip
 * and whitespace canonicalization, but refine-owned content still hashed.
 *
 * COMPARISON-ONLY, like legacySubjectDigest. Digests persisted before the carve-out
 * (arch_subject, planSubjectDigest) were computed this way over bodies that may carry
 * refine-owned blocks; every comparison site accepts a match on the current, the legacy or
 * this digest. Writers record only subjectDigest. A material amendment moves all three, so
 * the compat match cannot mask one.
 */
export function preCarveOutSubjectDigest({ body, targetFiles, testRequirements } = {}) {
  return digestSubject(canonicalSubjectBody(body, { refineCarveOut: false }), targetFiles, testRequirements);
}

/**
 * noteSubjectDigest's field mapping applied to preCarveOutSubjectDigest. Comparison-only; the
 * ONE function the rks_arch_verdict handler, the guardrails-off story gate and the
 * governor-init stale check call for the pre-carve-out digest.
 *
 * @param {{ data?: object, content?: string } | null | undefined} parsed
 * @returns {string} 32 hex characters
 */
export function notePreCarveOutSubjectDigest(parsed) {
  return preCarveOutSubjectDigest({
    body: parsed?.content || "",
    targetFiles: parsed?.data?.targetFiles,
    testRequirements: parsed?.data?.testRequirements,
  });
}

/** ABSENT arch_subject_version: undefined, null, or a string that is empty after trim(). */
function archSubjectVersionAbsent(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * backlog.fix.exec-start-reset-story-changed-since-arch: has an arch-approved story's content changed
 * since rks_arch_verdict recorded arch_subject? Pure. Option C (fingerprint versioning,
 * backlog.fix.arch-subject-digest-whitespace-robust): only an approval whose arch_subject_version is the
 * current ARCH_SUBJECT_VERSION is gated, and it is compared against the current digest ONLY - no compat
 * digest. An approval whose arch_subject_version is ABSENT is never a mismatch here (it keeps today's
 * guardrails-off and ARCH-rebase checks). A PRESENT version that is not current ("1", 1, "3", an array, an
 * object, a boolean) is a mismatch: the code never observed that it is older, so it fails closed. An absent
 * arch_subject passes; a present non-string on a gated approval fails closed.
 */
export function archSubjectMismatch({ archVerdict, archSubject, archSubjectVersion, currentSubject } = {}) {
  if (archVerdict !== "approved") return false;
  if (archSubject === undefined || archSubject === null || archSubject === "") return false;
  if (archSubjectVersionAbsent(archSubjectVersion)) return false;
  if (!isCurrentArchSubjectVersion(archSubjectVersion)) return true;
  if (typeof archSubject !== "string") return true;
  if (typeof currentSubject !== "string" || currentSubject === "") return true;
  return archSubject !== currentSubject;
}

/**
 * The note-level check rks_plan_ready, ensureExecStartPhase and rks_exec apply. Takes a
 * parseFrontmatter result ({ data, content }). Ungated only when arch_subject_version is absent. FAILS CLOSED:
 * a present arch_subject_version that is not current, and a throw while computing the digest, are reported as
 * changed (failedClosed: true), never as a pass.
 *
 * @returns {{ changed: boolean, gated: boolean, failedClosed: boolean, ungatedReason?: string,
 *   recorded: *, recordedVersion: *, current: string|null, message: string|null }}
 */
export function storyChangedSinceArch(parsed, problemId) {
  const data = parsed?.data || {};
  const archVerdict = data.arch_verdict ?? null;
  const archSubject = data.arch_subject ?? null;
  const recordedVersion = data.arch_subject_version ?? null;
  const none = { recorded: archSubject, recordedVersion, current: null };
  if (archVerdict !== "approved" || archSubject === null || archSubject === "") {
    return { changed: false, gated: false, failedClosed: false, ...none, message: null };
  }
  if (archSubjectVersionAbsent(recordedVersion)) {
    return { changed: false, gated: false, failedClosed: false, ungatedReason: "arch_subject_unversioned", ...none, message: null };
  }
  if (!isCurrentArchSubjectVersion(recordedVersion)) {
    return {
      changed: true,
      gated: true,
      failedClosed: true,
      ...none,
      message: `Story ${problemId} has an ARCH approval recorded with arch_subject_version ${JSON.stringify(recordedVersion)}, which is present but is not the current fingerprint version ${ARCH_SUBJECT_VERSION}, so its arch_subject cannot be compared. Refusing (fail closed). Re-run /arch on ${problemId}.`,
    };
  }
  let current;
  try {
    current = noteSubjectDigest(parsed);
  } catch (err) {
    return {
      changed: true,
      gated: true,
      failedClosed: true,
      ...none,
      message: `Story ${problemId} could not be compared with the content ARCH approved: computing its subject digest threw (${err?.message ?? String(err)}). Refusing (fail closed). Repair the note, then re-run /arch on ${problemId}.`,
    };
  }
  const digests = { recorded: archSubject, recordedVersion, current };
  if (!archSubjectMismatch({ archVerdict, archSubject, archSubjectVersion: recordedVersion, currentSubject: current })) {
    return { changed: false, gated: true, failedClosed: false, ...digests, message: null };
  }
  const recordedLabel = typeof archSubject === "string" ? archSubject : `<non-string ${JSON.stringify(archSubject)}>`;
  return {
    changed: true,
    gated: true,
    failedClosed: false,
    ...digests,
    message: `Story ${problemId} has changed since ARCH approved it: recorded arch_subject ${recordedLabel} differs from the current content digest ${current}. Re-run /arch on ${problemId} so ARCH reviews the amended story, then retry.`,
  };
}

/** Tool name as it appears in the MCP tool list. */
export const TOOL_NAME = "rks_arch_verdict";

/** Tool description for MCP discovery. */
export const TOOL_DESCRIPTION =
  "Record an ARCH review's findings and receive the computed verdict. The verdict is DERIVED from a frozen finding ledger and a hard round cap, not asserted by the caller: round 1 freezes the ledger, later rounds may only shrink it, and findings first raised after round 1 are returned as deferred rather than blocking. The ledger is bound to the story's CONTENT, not its id — a material amendment to the body, targetFiles or testRequirements rebases it to round 1 with findings blocking again, and the round cap counts rounds per story VERSION. Rebase is derived from a content digest, never requested: there is no parameter that forces or suppresses it. This is the only permitted writer of arch_verdict, arch_round, arch_ledger, arch_deferred, arch_findings_count, arch_subject, arch_subject_version, arch_total_rounds, arch_round_findings and the arch-approved phase. The phase follows the verdict in BOTH directions: an approved verdict sets phase arch-approved, and a needs-revision verdict on a story at phase arch-approved returns its phase to ready (retraction). A needs-revision verdict never changes any other phase — draft and ready stay as they are, and planned, executing and executed are not demoted. arch_total_rounds and arch_round_findings are ADVISORY: they record cumulative review cost across rebases and never affect the verdict, the cap or the phase. Plan-ready create gate: the handler also runs rks_plan_ready's own create_target_no_authorable_block predicate on the story on every call and refuses approved while any such issue exists; those issues are reported in gateIssues (always present, [] when none), counted in findingsCount, never written to arch_ledger or arch_deferred, and neither the ledger nor the round cap can clear them — only amending the story does. No other plan_ready check affects the verdict.";

/** JSON Schema for tool input. Kept in step with archVerdictSchema in server.mjs. */
export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectId: {
      type: "string",
      description: "Project identifier from registry",
    },
    storyId: {
      type: "string",
      description: "Story note filename, e.g. backlog.feat.my-story",
    },
    findings: {
      type: "array",
      description:
        "Findings raised THIS round. Identity is derived from { item, file } — a key you supply is ignored, so a round-1 finding cannot be renamed to keep it blocking.",
      items: {
        type: "object",
        properties: {
          item: { type: "number", description: "Checklist item number" },
          file: { type: "string", description: "Repo-relative path the finding anchors to" },
          detail: { type: "string", description: "What is wrong and what would resolve it" },
        },
        required: ["item", "file"],
      },
    },
  },
  required: ["projectId", "storyId", "findings"],
};

/** The only two verdict values. */
export const VERDICT_APPROVED = "approved";
export const VERDICT_NEEDS_REVISION = "needs-revision";

/**
 * Lowercase-and-hyphenate an arbitrary value into a `[a-z0-9-]` slug.
 * Total by construction — every input yields a non-empty conforming slug, so
 * findingKey() cannot emit a key that violates the key format. A non-numeric
 * `item` becomes `nan`/its own slug rather than the `NaN` that `Number()`
 * interpolation would produce.
 */
function slug(value) {
  const s = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "x";
}

/**
 * Append this round's blocking-finding count to the trajectory, defensively.
 *
 * The SHAPE of the sequence is the signal that distinguishes a converging review from a
 * churning one: 5 → 1 → 1 → 0 converges; 3 → 3 → 3 does not. `arch_findings_count` already
 * computes each round's number and then overwrites it, so retaining the series costs one
 * array push and no new computation.
 *
 * Bounded so an unbounded loop cannot grow frontmatter without limit, and tolerant of a
 * malformed prior value for the same reason the seed is tolerant — this is advisory.
 */
const MAX_ROUND_FINDINGS = 24;
function appendRoundFindings(prior, count) {
  const arr = (Array.isArray(prior) ? prior : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0, Math.trunc(n)));
  arr.push(Math.max(0, Math.trunc(Number(count) || 0)));
  return arr.slice(-MAX_ROUND_FINDINGS);
}

/**
 * Derive a finding's identity from { item, file } and NOTHING else.
 *
 * Deriving rather than accepting is what makes the ledger monotone: ARCH cannot
 * mint a key, so it cannot rename a round-1 finding to keep it blocking.
 * Any `key` property on the input is ignored.
 *
 * @returns {string} matching /^[a-z0-9-]+$/
 */
export function findingKey({ item, file } = {}) {
  return `item-${slug(item)}-${slug(file)}`;
}

/** Stable de-dupe preserving first-seen order. */
function uniq(list) {
  return [...new Set(list)];
}

/**
 * Compute the ARCH verdict from persisted state.
 *
 * @param {object} args
 * @param {string[]} [args.priorLedger] Frozen finding keys from the last round.
 * @param {number}   [args.priorRound]  Rounds already recorded (0 = never reviewed).
 * @param {Array<{item: *, file: string, detail?: string}>} [args.submitted]
 *        Findings this round. `key` on an entry is ignored — keys are derived.
 * @param {string}   [args.recordedSubject] arch_subject recorded by the last verdict.
 * @param {string}   [args.currentSubject]  noteSubjectDigest of the note now (recorded).
 * @param {string}   [args.legacySubject]   noteLegacySubjectDigest of the note now —
 *        comparison-only: a recordedSubject equal to it is not a rebase.
 * @param {string}   [args.preCarveOutSubject] notePreCarveOutSubjectDigest of the note now —
 *        comparison-only, same rule as legacySubject.
 * @param {*}        [args.recordedVersion] arch_subject_version recorded with recordedSubject.
 *        A current version (isCurrentArchSubjectVersion) is compared against currentSubject
 *        ONLY; anything else is unversioned and compared against v1Subject, legacySubject and
 *        preCarveOutSubject, never against currentSubject.
 * @param {string}   [args.v1Subject] noteV1SubjectDigest of the note now — comparison-only,
 *        consulted only for an unversioned recording.
 * @returns {{
 *   round: number, verdict: string, capped: boolean,
 *   ledger: string[], blocking: string[], deferred: string[],
 *   subject: string|null, subjectVersion: *
 * }}
 */
export function computeArchVerdict({
  priorLedger,
  priorRound,
  submitted,
  recordedSubject,
  currentSubject,
  legacySubject,
  preCarveOutSubject,
  recordedVersion,
  v1Subject,
  priorTotalRounds,
  priorRoundFindings,
} = {}) {
  const prior = Array.isArray(priorLedger) ? uniq(priorLedger.map(String)) : [];
  const priorRoundNum = Number.isFinite(Number(priorRound)) ? Math.max(0, Math.trunc(Number(priorRound))) : 0;

  const hasRecorded = typeof recordedSubject === "string" && recordedSubject !== "";
  const hasCurrent = typeof currentSubject === "string" && currentSubject !== "";
  const hasLegacy = typeof legacySubject === "string" && legacySubject !== "";
  const hasPreCarveOut = typeof preCarveOutSubject === "string" && preCarveOutSubject !== "";

  // REBASE. Round-counting is only meaningful relative to a fixed subject: round 2
  // must not admit novel findings because it reviews what round 1 reviewed, so a
  // novel finding is churn or a consequence of round 1's fix. That reasoning does
  // not survive the story being rewritten — findings against new material are the
  // FIRST review of that material. When the recorded subject differs, the ledger is
  // a ledger of something that no longer exists, so it is discarded and this call
  // is computed as round 1.
  //
  // Absence is NOT a mismatch. A note with a round but no recorded subject was
  // verdicted before this field existed; treating that as amended would reopen the
  // entire approved backlog at once. Adopt and continue.
  //
  // A recorded subject equal to the LEGACY (pre-canonicalization) digest of the current
  // note is the same subject recorded under the old algorithm, not an amendment
  // (backlog.fix.arch-subject-digest-guidance-boundary-whitespace). It is not rebased, and
  // the canonical currentSubject is what gets recorded from here on.
  const legacyMatch = hasLegacy && recordedSubject === legacySubject;
  // Likewise a recorded subject equal to the PRE-CARVE-OUT digest: the same content recorded
  // before refine-owned blocks were excluded
  // (backlog.fix.arch-subject-digest-excludes-refine-context-sections).
  const preCarveOutMatch = hasPreCarveOut && recordedSubject === preCarveOutSubject;
  // FINGERPRINT VERSION (backlog.fix.arch-subject-digest-whitespace-robust). A recording that
  // carries the current version is accepted by the current digest ONLY: a v1, legacy or
  // pre-carve-out match does not rescue it. An UNVERSIONED recording gets exactly the previous
  // acceptance, with the previous current digest (v1Subject) in place of currentSubject. There is
  // no fallback to currentSubject: with no v1Subject supplied an unversioned recording is matched
  // only by the legacy or pre-carve-out digest, and otherwise rebases (the conservative outcome).
  const hasV1 = typeof v1Subject === "string" && v1Subject !== "";
  const v1Match = hasV1 && recordedSubject === v1Subject;
  const rebased = isCurrentArchSubjectVersion(recordedVersion)
    ? hasRecorded && hasCurrent && recordedSubject !== currentSubject
    : hasRecorded && hasCurrent && !v1Match && !legacyMatch && !preCarveOutMatch;
  // The version of the digest returned as `subject`: the current version whenever the current
  // digest is what is recorded; otherwise the recorded value's own version (or null), so a version
  // is never stamped onto a digest it does not describe.
  const subjectVersion = hasCurrent ? ARCH_SUBJECT_VERSION : (recordedVersion ?? null);

  const effectivePriorRound = rebased ? 0 : priorRoundNum;
  const effectivePrior = rebased ? [] : prior;
  const round = effectivePriorRound + 1;

  // CUMULATIVE COST. Deliberately NOT reset by a rebase — that is the whole point: `round`
  // measures this version, `totalRounds` measures the story.
  //
  // Seeded from priorRound rather than 0 when the field is absent. A note verdicted before
  // this field existed has a real review history; starting it at 0 would report a NEW false
  // number for every already-approved story, where seeding reports a conservative one. Same
  // reasoning as "Absence is NOT a mismatch" above.
  //
  // A malformed value must NOT refuse the review the way an invalid arch_round does. This
  // is advisory; an advisory field that can deny a verdict is worse than one that is wrong.
  const priorTotalNum = Number.isFinite(Number(priorTotalRounds))
    ? Math.max(0, Math.trunc(Number(priorTotalRounds)))
    : priorRoundNum;
  const totalRounds = priorTotalNum + 1;

  // Derived ONCE, above the round-1 branch, so the stated iff is a single
  // expression on every return path rather than a constant on one of them.
  const capped = round >= ARCH_MAX_ROUNDS;

  const submittedKeys = uniq((Array.isArray(submitted) ? submitted : []).map((f) => findingKey(f || {})));

  // Round 1 freezes the ledger: everything submitted is blocking.
  // Round N > 1 may only shrink it: anything not already in the ledger defers.
  const isFirstRound = effectivePriorRound === 0;
  const carried = isFirstRound ? submittedKeys : submittedKeys.filter((k) => effectivePrior.includes(k));
  const novel = isFirstRound ? [] : submittedKeys.filter((k) => !effectivePrior.includes(k));

  if (capped) {
    // The cap discards the residue rather than blocking on it. Residual ledger
    // entries the current round did not re-raise are deferred too, so nothing
    // is silently dropped.
    const residue = effectivePrior.filter((k) => !submittedKeys.includes(k));
    return {
      round,
      verdict: VERDICT_APPROVED,
      capped,
      ledger: [],
      blocking: [],
      deferred: uniq([...novel, ...carried, ...residue]),
      rebased,
      subject: hasCurrent ? currentSubject : (hasRecorded ? recordedSubject : null),
      subjectVersion,
      totalRounds,
      roundFindings: appendRoundFindings(priorRoundFindings, 0),
    };
  }

  return {
    round,
    totalRounds,
    roundFindings: appendRoundFindings(priorRoundFindings, carried.length),
    verdict: carried.length > 0 ? VERDICT_NEEDS_REVISION : VERDICT_APPROVED,
    capped,
    ledger: carried,
    blocking: carried,
    deferred: novel,
    rebased,
    subject: hasCurrent ? currentSubject : (hasRecorded ? recordedSubject : null),
    subjectVersion,
  };
}
