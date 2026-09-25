/**
 * Witnesses for backlog.fix.arch-cross-story-check-file-overlap-only.
 *
 * Two concerns, one story:
 *
 *   1. ARCH's cross-story check keyed only on shared `targetFiles`, so two stories with
 *      DISJOINT targets and directly contradictory assertions were invisible to it by
 *      construction. It was also the only UNNUMBERED checklist entry, and
 *      `archVerdictSchema` requires findings to carry a numeric `item` — so its findings
 *      could not be submitted at all. It is now Item 11.
 *
 *   2. The prose cardinality ("an N-item mechanical checklist") was a hardcoded constant
 *      that rotted silently through the additions of Items 9 and 10 — it still read 8 when
 *      ten items existed. Replacing it with a fresh literal would only relocate the rot, so
 *      the count is DERIVED from the checklist and compared against the stated value.
 *
 * Pure filesystem reads. No subprocess spawns: `pool: "forks"` means a hanging child holds
 * a fork slot forever and surfaces as a silent CI timeout with no diagnostic output.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.resolve(__dirname, "../../.rks/prompts/governor-arch.md");
const skillPath = path.resolve(__dirname, "../../.claude/skills/arch/SKILL.md");

const prompt = fs.readFileSync(promptPath, "utf8");
const skill = fs.readFileSync(skillPath, "utf8");

/** Matches a checklist heading only as far as its number. */
const ITEM_HEADING_ANY = /^[ \t]*\*\*Item (\d+)/gm;

/**
 * The shared fragment is the ONLY text common to the two cardinality sentences — the
 * prompt says "applying an N-item mechanical checklist, and returning a binary verdict per
 * story", the skill says "applies an N-item mechanical checklist, and returns a binary
 * verdict". Keying on the full sentence would match neither file.
 */
const STATED_COUNT = /\b(\d+)-item mechanical checklist\b/;

/**
 * Derive the item count from the checklist itself, and prove the numbering is sane while
 * doing it — a typo (two Item 7s, or a jump from 9 to 11) would otherwise change the count
 * silently, which is the failure mode a raw `.length` would miss.
 *
 * Item 10's heading uses a hyphen and a trailing space where Items 1-9 use an em dash, so
 * the regex stops at the number and never requires a separator.
 */
function derivedItemCount(src) {
  const nums = [...src.matchAll(ITEM_HEADING_ANY)].map((m) => Number(m[1]));
  expect(nums.length, "no `**Item <n>` headings found").toBeGreaterThan(0);
  const sorted = [...nums].sort((a, b) => a - b);
  expect(new Set(sorted).size, `duplicate item numbers: ${sorted.join(", ")}`).toBe(sorted.length);
  expect(sorted, `item numbers are not contiguous from 1: ${sorted.join(", ")}`).toEqual(
    Array.from({ length: sorted.length }, (_, i) => i + 1),
  );
  return nums.length;
}

function statedItemCount(src) {
  const m = src.match(STATED_COUNT);
  expect(m, "no `<n>-item mechanical checklist` sentence found").toBeTruthy();
  return Number(m[1]);
}

/** The comparison under test, extracted so the meta-witnesses can perturb its inputs. */
function assertCardinalityAgrees(promptSrc, skillSrc) {
  const derived = derivedItemCount(promptSrc);
  expect(statedItemCount(promptSrc), "prompt cardinality disagrees with the checklist").toBe(derived);
  expect(statedItemCount(skillSrc), "SKILL.md cardinality disagrees with the checklist").toBe(derived);
}

/**
 * Slice a checklist item by STRUCTURAL boundary — the next item heading, the next `##`
 * heading, or the first dedent back to column 0, whichever comes first.
 *
 * Not `src.slice(idx, idx + N)`: fixed-size source windows are named brittle by
 * governor-arch.md's own Item 3 and asserted against by governor-regression-witness.mjs.
 * The dedent clause carries the weight here — Item 11 is the LAST entry, and the next `##`
 * heading is far below it, so a heading-only boundary would swallow the verdict-submission
 * instructions and let an unrelated line satisfy a section-scoped assertion.
 */
function extractItemSection(src, itemNumber) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^[ \\t]*\\*\\*Item ${itemNumber}\\b`).test(l));
  expect(start, `Item ${itemNumber} heading not found`).toBeGreaterThan(-1);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const isNextItem = /^[ \t]*\*\*Item \d+\b/.test(line);
    const isNextHeading = /^## /.test(line);
    const isDedent = line.trim() !== "" && !/^[ \t]/.test(line);
    if (isNextItem || isNextHeading || isDedent) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("ARCH checklist cardinality is derived, not stated", () => {
  it("both cardinality sentences agree with the count derived from the checklist", () => {
    // RED against the pre-fix tree: ten `**Item ` headings existed while both sentences
    // read 8. A fixture comparing one literal against another would have passed there.
    assertCardinalityAgrees(prompt, skill);
  });

  it("SKILL.md carries no item headings of its own, so its count must come from the prompt", () => {
    // This asserts the PREMISE of the cross-file coupling rather than assuming it. If
    // someone later inlines the checklist into SKILL.md, this fails loudly and names the
    // changed premise instead of the coupling silently going stale.
    expect([...skill.matchAll(ITEM_HEADING_ANY)]).toHaveLength(0);
  });

  it("META: adding an item without touching the sentences turns the comparison RED", () => {
    // Perturbs the DERIVED side. Without this, `expect(11).toBe(11)` would satisfy the
    // test above and the derivation could be quietly degraded back into a constant.
    const derived = derivedItemCount(prompt);
    const withExtra = `${prompt}\n   **Item ${derived + 1} — Hypothetical**\n   Body.\n`;

    // Pin the throw to its cause first: a bare .toThrow() passes on any error, including
    // one from an unrelated regression, which would itself be a non-discriminating witness.
    expect(derivedItemCount(withExtra)).toBe(derived + 1);
    expect(statedItemCount(withExtra)).toBe(derived);

    expect(() => assertCardinalityAgrees(withExtra, skill)).toThrow();
  });

  it("META: bumping the stated sentence without adding an item turns the comparison RED", () => {
    // Perturbs the STATED side. The added-item perturbation above proves only that the
    // derived half reads the checklist; this proves `statedItemCount` actually reads the
    // sentence. Otherwise that half rests solely on the one-time pre-fix RED observation,
    // which leaves no permanent artifact behind once the fix lands.
    const derived = derivedItemCount(prompt);
    const bumped = prompt.replace(STATED_COUNT, `${derived + 1}-item mechanical checklist`);

    // The replace actually fired — a silently non-matching regex must not pass as a bump.
    expect(bumped).not.toBe(prompt);
    expect(derivedItemCount(bumped)).toBe(derived);
    expect(statedItemCount(bumped)).toBe(derived + 1);

    expect(() => assertCardinalityAgrees(bumped, skill)).toThrow();
  });
});

/**
 * Lazy on purpose. Called in a `describe` body, a missing Item 11 throws during COLLECTION
 * and takes the whole file down — including the cardinality witnesses, which have nothing
 * to do with Item 11. A suite that cannot collect reports "1 failed" for an arbitrary
 * reason; these must fail individually, each naming what it actually checked.
 */
const item11 = () => extractItemSection(prompt, 11);
const item3 = () => extractItemSection(prompt, 3);

describe("Item 11 — cross-story contradiction check", () => {
  it("is a numbered checklist item, so its findings can carry a numeric `item`", () => {
    const section = item11();
    // archVerdictSchema declares `item: z.number()` and lists it in `required`, and
    // server.mjs .parse()s the args before computeArchVerdict runs. An unnumbered entry
    // gave the governor no legitimate number to submit, so a cross-story finding could not
    // be filed at all — in practice it got mis-attributed to another item's number.
    expect(section).toContain("Cross-story contradiction check");
    expect(prompt).toContain("**Item 11 — Cross-story contradiction check**");
  });

  it("retains the file-overlap stale-snapshot hazard as one trigger", () => {
    const section = item11();
    // NON-DISCRIMINATING BY DESIGN: both phrases predate the fix. They are asserted so a
    // future edit cannot drop the original sub-case while widening the antecedent.
    expect(section).toContain("stale-snapshot");
    expect(section).toContain("target the same file");
  });

  it("reaches story pairs whose targetFiles are disjoint", () => {
    const section = item11();
    expect(section).toContain("share no target file");
    expect(section).toMatch(/ONE trigger, not the antecedent/);
  });

  it("carries the asserts-absent versus adds-export worked example", () => {
    const section = item11();
    // Deliberately NOT pinned to the originating repo's identifiers — those coordinates
    // belong to another project and are not files of this one, so a witness naming them
    // could never be honoured here.
    expect(section).toMatch(/ABSENT from a module's export surface/);
    expect(section).toMatch(/ADDS that export/);
  });

  it("states the direction rule that distinguishes not-touching from asserting-about", () => {
    const section = item11();
    expect(section).toContain("DIRECTION RULE");
    expect(section).toMatch(/does not touch surface S/);
    expect(section).toMatch(/asserts a property of S/);
    // The field dismissal this rule exists to forbid, quoted so it cannot recur unnoticed.
    expect(section).toMatch(/neither needs nor creates that surface/);
  });

  it("binds the report to the comparison actually performed", () => {
    const section = item11();
    expect(section).toContain("REPORT WHAT WAS COMPARED");
    expect(section).toMatch(/confine the claim to that comparison's reach/);
  });

  it("forbids the unqualified compatibility disposition", () => {
    const section = item11();
    // Scoped to the PROMPT's prohibition. Scanning notes/ for the historical instances
    // would fail for the wrong reason — those are cited as evidence and are not retro-fixed.
    expect(section).toContain("FORBIDDEN OUTPUT FORM");
    expect(section).toMatch(/may be built in either order/);
    expect(section).toMatch(/If you compared only target files, say only that/);
  });

  it("constrains the single-story batch, which cannot compute a cross-story claim", () => {
    const section = item11();
    expect(section).toContain("SINGLE-STORY BATCH");
    expect(section).toMatch(/no cross-story comparison was performed/);
    expect(section).toMatch(/any other story in flight/);
  });

  it("fails closed when a sibling's testRequirements cannot be obtained", () => {
    const section = item11();
    expect(section).toContain("FAIL CLOSED");
    expect(section).toMatch(/was NOT performed for that sibling/);
    expect(section).toMatch(/never inferred from silence/);
  });
});

describe("Item 3's sweep corpus includes in-flight siblings", () => {

  it("names sibling testRequirements as part of the corpus", () => {
    const section = item3();
    // The reason the motivating pair escaped: story A's asserting test was not on disk, so
    // a governed exhaustive search over `tests` returned a TRUTHFUL zero for an assertion
    // that was nonetheless about to exist. Widening the corpus, not the keying.
    expect(section).toMatch(/NOT limited to tests already on disk/);
    expect(section).toMatch(/testRequirements` prose of every OTHER story in this ARCH batch/);
  });

  it("keeps the four phrases pinned by governor-regression-witness.test.mjs", () => {
    const section = item3();
    // The Item 3 amendment must be strictly additive — these are asserted elsewhere as an
    // additive-amendment guard, and rewording any of them reddens that suite instead.
    expect(section).toContain("use the governed exhaustive-search tool");
    expect(section).toContain("rks_exhaustive_search");
    expect(section).toContain("needs-revision");
    expect(section).toContain("fixed-size source-window slices");
  });
});

describe("promoting Item 11 does not disturb Items 1-10", () => {
  const TITLES = [
    "Correct function/variable/condition",
    "Secondary firing paths",
    "Tests to delete vs. update",
    "Frontmatter consistency",
    "Left-side/right-side imbalance",
    "Wrong-phase validation",
    "Circular dogfood dependency",
    "Stale active/target scope",
    "Vertical value coherence",
    "Evidence-bound reporting",
  ];

  it.each(TITLES.map((title, i) => [i + 1, title]))(
    "Item %i keeps its number and title (%s)",
    (num, title) => {
      const section = extractItemSection(prompt, num);
      expect(section.split("\n")[0]).toContain(title);
    },
  );

  it("each item heading appears exactly once", () => {
    const nums = [...prompt.matchAll(ITEM_HEADING_ANY)].map((m) => Number(m[1]));
    expect(nums).toEqual([...new Set(nums)]);
    expect(nums).toHaveLength(TITLES.length + 1);
  });

  it("introduces no second `## Tool Reliability` heading", () => {
    // That block is asserted byte-identical across five prompts; a duplicate heading
    // reddens all five. This story's edits all sit far above it.
    const headings = [...prompt.matchAll(/^## Tool Reliability/gm)];
    expect(headings).toHaveLength(1);
  });
});
