/**
 * backlog.fix.dispatcher-authors-conclusions-as-governor-premises
 *
 * Pins both halves of the rule that keeps Dispatcher-authored conclusions out of
 * Governor briefs:
 *
 *   - CLAUDE.md's `## Observations, Not Conclusions` section (Dispatcher side), and
 *   - the byte-identical `## The Brief Is Not Evidence` block in all five governor
 *     prompts (Governor side).
 *
 * The prompt half is the load-bearing one: child projects vendor `.rks/prompts/*.md`
 * byte-identically but do NOT vendor briefs, so a rule that lives only in a brief
 * reaches nobody downstream. Precedent and reasoning:
 * tests/unit/governor-tool-reliability-block.test.mjs.
 *
 * ADJACENCY IS ASSERTED BY LINE INDEX, NEVER BY indexOf — see the comment on that case.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PROMPTS = [
  "governor-po.md",
  "governor-qa.md",
  "governor-arch.md",
  "governor-build.md",
  "governor-research.md",
];

const BRIEF_HEADING = "## The Brief Is Not Evidence";

// Mirrors tests/unit/governor-tool-reliability-block.test.mjs's own constant byte for
// byte. That file counts occurrences with `split(HEADING).length - 1` — a WHOLE-FILE
// SUBSTRING count — so this must be the prefix form, not the full heading text, or the
// count asserted below would not be the count that file takes.
const TR_PREFIX = "## Tool Reliability";
// The full heading, used only to LOCATE the line. Kept separate on purpose.
const TR_FULL = "## Tool Reliability — verify before you trust";

const readPrompt = (f) =>
  fs.readFileSync(path.resolve(".rks/prompts", f), "utf8");
const readClaudeMd = () => fs.readFileSync(path.resolve("CLAUDE.md"), "utf8");

/** Heading -> next line starting `## `, else EOF, trimEnd()'d. */
function extractBlock(src, heading) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

describe("the brief-is-not-evidence block is present and identical in all five prompts", () => {
  it("every governor prompt carries the section exactly once", () => {
    for (const f of PROMPTS) {
      const src = readPrompt(f);
      const count = src.split(BRIEF_HEADING).length - 1;
      expect(count, `${f} must carry the section exactly once`).toBe(1);
    }
  });

  it("the five copies are byte-identical", () => {
    const blocks = PROMPTS.map((f) => [f, extractBlock(readPrompt(f), BRIEF_HEADING)]);
    for (const [f, b] of blocks) {
      expect(b, `${f} must contain the block`).toBeTruthy();
    }
    const reference = blocks[0][1];
    for (const [f, b] of blocks) {
      expect(b, `${f} must be byte-identical to ${blocks[0][0]}`).toBe(reference);
    }
  });

  it("the block instructs re-derivation and names refutation as a correct outcome", () => {
    const b = extractBlock(readPrompt(PROMPTS[0]), BRIEF_HEADING);
    expect(b).toContain("UNVERIFIED PREMISES");
    expect(b).toContain("results[].text");
    expect(b).toContain("positive control");
    expect(b).toMatch(/CORRECT OUTCOME/);
  });
});

describe("the block sits immediately before the tool-reliability block", () => {
  // ADJACENCY BY LINE INDEX, NOT indexOf.
  //
  // An `indexOf(BRIEF) < indexOf(TR)` check is a FALSE GREEN. If the block's prose ever
  // quoted the tool-reliability heading, indexOf would resolve to that quotation — which
  // sits AFTER the brief heading — so the ordering assertion would pass while
  // governor-tool-reliability-block.test.mjs's whole-file count went from 1 to 2 and
  // reddened. The witness would report green on precisely the defect it exists to catch.
  it("no `## ` heading intervenes between the two, in any prompt", () => {
    for (const f of PROMPTS) {
      const lines = readPrompt(f).split("\n");
      const briefIdx = lines.findIndex((l) => l.startsWith(BRIEF_HEADING));
      const trIdx = lines.findIndex((l) => l.startsWith(TR_FULL));

      expect(briefIdx, `${f} must contain ${BRIEF_HEADING}`).toBeGreaterThan(-1);
      expect(trIdx, `${f} must still contain the tool-reliability heading`).toBeGreaterThan(-1);
      expect(briefIdx, `${f}: the block must come first`).toBeLessThan(trIdx);

      const intervening = lines
        .slice(briefIdx + 1, trIdx)
        .filter((l) => l.startsWith("## "));
      expect(intervening, `${f}: nothing may sit between the two blocks`).toEqual([]);
    }
  });

  // Separate assertion from adjacency; neither substitutes for the other.
  it("the tool-reliability prefix still occurs exactly once per prompt, whole-file", () => {
    for (const f of PROMPTS) {
      const count = readPrompt(f).split(TR_PREFIX).length - 1;
      expect(count, `${f}: the new prose must not quote the tool-reliability heading`).toBe(1);
    }
  });

  it("the block itself never contains that prefix", () => {
    for (const f of PROMPTS) {
      const b = extractBlock(readPrompt(f), BRIEF_HEADING);
      expect(b, `${f}: block must not quote the tool-reliability heading`).not.toContain(TR_PREFIX);
    }
  });
});

describe("CLAUDE.md carries the Dispatcher half", () => {
  it("the section sits between Behavioral Rules and the Read Boundary Rule", () => {
    // BY LINE INDEX, NOT indexOf — for the same reason as the prompt case above, and
    // because the rule is categorical rather than scoped to the prompts. This section's
    // own prose CROSS-REFERENCES `## Dispatcher Read Boundary Rule` by name, so an
    // indexOf on that string resolves to the citation INSIDE this section rather than to
    // the heading. That is not hypothetical here: it is what the shipped text does.
    const lines = readClaudeMd().split("\n");
    const at = (h) => lines.findIndex((l) => l.startsWith(h));

    const behavioral = at("## Behavioral Rules");
    const observations = at("## Observations, Not Conclusions");
    const readBoundary = at("## Dispatcher Read Boundary Rule");

    expect(behavioral, "## Behavioral Rules must exist").toBeGreaterThan(-1);
    expect(observations, "## Observations, Not Conclusions must exist").toBeGreaterThan(-1);
    expect(readBoundary, "## Dispatcher Read Boundary Rule must exist").toBeGreaterThan(-1);
    expect(observations).toBeGreaterThan(behavioral);
    expect(observations).toBeLessThan(readBoundary);

    // Nothing may be interposed between the new section and the Read Boundary Rule.
    const intervening = lines
      .slice(observations + 1, readBoundary)
      .filter((l) => l.startsWith("## "));
    expect(intervening).toEqual([]);
  });

  it("it enumerates admissible and inadmissible brief content", () => {
    const section = extractBlock(readClaudeMd(), "## Observations, Not Conclusions");
    expect(section).toBeTruthy();
    expect(section).toContain("Verbatim tool output");
    expect(section).toContain("A count");
    expect(section).toContain("completeness claim");
    expect(section).toContain("proposed decomposition");
  });

  it("it permits relaying allowlisted output verbatim while forbidding conclusions from it", () => {
    const section = extractBlock(readClaudeMd(), "## Observations, Not Conclusions");
    expect(section).toContain("VERBATIM AS OUTPUT");
    expect(section).toContain("nothing changed");
  });

  it("it names the resolution in the imperative and cross-references both rules", () => {
    const section = extractBlock(readClaudeMd(), "## Observations, Not Conclusions");
    expect(section).toContain("DISPATCH, DO NOT INVESTIGATE");
    expect(section).toContain("Behavioral Rule 1");
    expect(section).toContain("Dispatcher Read Boundary Rule");
  });

  it("it says CAN AND MUST NOT — never that the search is unavailable", () => {
    const section = extractBlock(readClaudeMd(), "## Observations, Not Conclusions");
    // The reachability nuance must be carried, naming the step that would reach it.
    expect(section).toContain("rks_governor_init");
    expect(section).toContain("can, and must not");
    // The false version must never ship: a rule claiming a capability the Dispatcher can
    // observe it has dies the moment it is tested.
    expect(section).not.toMatch(/rks_exhaustive_search is (not available|unavailable)/i);
    expect(section).not.toMatch(/cannot (call|reach|run) rks_exhaustive_search/i);
  });

  it("it states plainly that the rule is not hook-enforced, and names the seam", () => {
    const section = extractBlock(readClaudeMd(), "## Observations, Not Conclusions");
    expect(section).toContain("not hook-enforced");
    expect(section).toContain("Task");
  });
});
