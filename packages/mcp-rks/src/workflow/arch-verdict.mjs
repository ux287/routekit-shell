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

/**
 * Hard ceiling on ARCH rounds — counted PER SUBJECT, not per story id.
 * At this round the verdict is `approved`.
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
const ARCH_GUIDANCE_LINE = /^## ARCH Guidance[ \t]*$/;

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
 */
export function subjectDigest({ body, targetFiles, testRequirements } = {}) {
  const canonical = JSON.stringify(
    stable({
      body: stripArchGuidanceSection(typeof body === "string" ? body : ""),
      targetFiles: targetFiles ?? null,
      testRequirements: testRequirements ?? null,
    }),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Tool name as it appears in the MCP tool list. */
export const TOOL_NAME = "rks_arch_verdict";

/** Tool description for MCP discovery. */
export const TOOL_DESCRIPTION =
  "Record an ARCH review's findings and receive the computed verdict. The verdict is DERIVED from a frozen finding ledger and a hard round cap, not asserted by the caller: round 1 freezes the ledger, later rounds may only shrink it, and findings first raised after round 1 are returned as deferred rather than blocking. The ledger is bound to the story's CONTENT, not its id — a material amendment to the body, targetFiles or testRequirements rebases it to round 1 with findings blocking again, and the round cap counts rounds per story VERSION. Rebase is derived from a content digest, never requested: there is no parameter that forces or suppresses it. This is the only permitted writer of arch_verdict, arch_round, arch_ledger, arch_deferred, arch_findings_count, arch_subject, arch_total_rounds, arch_round_findings and the arch-approved phase. arch_total_rounds and arch_round_findings are ADVISORY: they record cumulative review cost across rebases and never affect the verdict, the cap or the phase.";

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
 * @returns {{
 *   round: number, verdict: string, capped: boolean,
 *   ledger: string[], blocking: string[], deferred: string[]
 * }}
 */
export function computeArchVerdict({
  priorLedger,
  priorRound,
  submitted,
  recordedSubject,
  currentSubject,
  priorTotalRounds,
  priorRoundFindings,
} = {}) {
  const prior = Array.isArray(priorLedger) ? uniq(priorLedger.map(String)) : [];
  const priorRoundNum = Number.isFinite(Number(priorRound)) ? Math.max(0, Math.trunc(Number(priorRound))) : 0;

  const hasRecorded = typeof recordedSubject === "string" && recordedSubject !== "";
  const hasCurrent = typeof currentSubject === "string" && currentSubject !== "";

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
  const rebased = hasRecorded && hasCurrent && recordedSubject !== currentSubject;

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
  };
}
