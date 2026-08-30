/**
 * backlog.feat.governor-prompt-tool-defect-workarounds
 *
 * Three tools in the Governor chain return success responses that are wrong. All three are
 * open and unfixed. The workarounds used to live in the Dispatcher's head and were
 * hand-injected per invocation, which meant a Governor knew only what the Dispatcher
 * remembered to type — and child projects, which vendor `.rks/prompts/*.md` byte-identically
 * but do NOT vendor briefs, learned none of it.
 *
 * There is no include mechanism for prompts: each is a standalone file read whole at session
 * start. So the only defence against five copies drifting apart is that they are literally
 * identical and asserted so. That parity assertion is the point of this file.
 *
 * Pure filesystem reads — no subprocess spawn, so no timeout guard is required.
 *
 * WRAP-POSITION SWEEP (backlog.fix.post-ship-review-findings-batch, Finding 5).
 * Every assertion in this file was swept for expected text embedding a newline
 * lifted from where the prompt prose happens to wrap. Two did — both in
 * "caution 1's retirement pointer is scoped so the three new facts survive it" —
 * and both are now \s+ regexes. A THIRD was missed by that sweep and found by
 * backlog.fix.exhaustive-search-case-sensitivity-undisclosed: the caution-1
 * sufficiency pin did not embed a newline at the time, so it failed the sweep's
 * criterion, and the amendment that qualified that sentence in place pushed it
 * past the wrap width. Every expected-text pin over the Tool Reliability block is
 * now \s+ tolerant; the criterion "already embeds a newline" is what let one
 * through, so it is retired in favour of tolerating wraps unconditionally.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PROMPTS = path.join(ROOT, ".rks/prompts");

const EDITED = [
  "governor-po.md",
  "governor-qa.md",
  "governor-arch.md",
  "governor-build.md",
  "governor-research.md",
];

const HEADING = "## Tool Reliability";

const read = (f) => fs.readFileSync(path.join(PROMPTS, f), "utf8");

/**
 * The block runs from its heading to the line before the next line-initial `## `, or EOF.
 * Extracted structurally rather than by a fixed-size window — a fixed slice is the exact
 * brittleness this project's own ARCH prompt tells stories to avoid.
 */
function extractBlock(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith(HEADING));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

describe("Tool Reliability block — presence and parity", () => {
  it.each(EDITED)("%s contains a Tool Reliability heading", (f) => {
    expect(read(f)).toContain(HEADING);
  });

  it("the block body is byte-identical across all five prompts", () => {
    // Compared without normalization, deliberately: whitespace drift IS drift. With no
    // include mechanism, identity is the only thing keeping five copies in sync.
    const blocks = EDITED.map((f) => [f, extractBlock(read(f))]);
    for (const [f, b] of blocks) expect(b, `${f} has no extractable block`).toBeTruthy();

    const [, reference] = blocks[0];
    for (const [f, b] of blocks.slice(1)) {
      expect(b, `${f} block differs from ${blocks[0][0]}`).toBe(reference);
    }
  });

  it("appears exactly once per prompt", () => {
    for (const f of EDITED) {
      const count = read(f).split(HEADING).length - 1;
      expect(count, `${f} has ${count} Tool Reliability headings`).toBe(1);
    }
  });
});

describe("Tool Reliability block — required content", () => {
  const block = () => extractBlock(read(EDITED[0]));

  it("caution 1 states the prune tests the scope root, not only descendants", () => {
    const b = block();
    expect(b).toContain("OWN basename");
    expect(b).toContain("INCLUDING the scope root");
  });

  it("caution 1 does NOT carry the refuted scope-root-is-exempt claim", () => {
    // This claim circulated as a correction and is false — reproduced three times:
    // `.routekit` returns 0 for a literal that `.routekit/read-policy.yaml` returns.
    // Shipping it byte-identically into every child project would propagate the error.
    const b = block().toLowerCase();
    expect(b).not.toContain("scope root is exempt");
    expect(b).not.toContain("only descendants");
    expect(b).not.toContain("descendants only");
  });

  it("caution 1 mandates a positive control before a zero is reported as absence", () => {
    const b = block();
    expect(b).toContain("POSITIVE CONTROL");
    // WRAP-TOLERANT. backlog.fix.exhaustive-search-case-sensitivity-undisclosed
    // qualified this sentence in place, roughly doubling it past the prompt files'
    // wrap width, so the phrase now spans a line break. Literal spaces would report
    // present text as ABSENT.
    expect(b).toMatch(/ONLY\s+when\s+a\s+positive\s+control\s+on\s+that\s+same\s+scope\s+returned\s+a\s+hit/);
  });

  it("caution 1 no longer claims a positive control is sufficient", () => {
    // POLARITY. The refuted literal is the pinned phrase above TERMINATED BY A
    // PERIOD — a proper superstring of it. The amendment displaces that period with
    // " AND", so the phrase survives and the unqualified claim goes absent.
    //
    // The period is ESCAPED deliberately. A bare dot matches whatever character
    // replaces it; with the authored wrap that is a line break, which a bare dot
    // does NOT match without dotAll — so an unescaped assertion would pass today by
    // accident and invert the moment the sentence is reflowed onto one line.
    const b = block();
    expect(b).not.toMatch(/ONLY\s+when\s+a\s+positive\s+control\s+on\s+that\s+same\s+scope\s+returned\s+a\s+hit\./);
    expect(b).toMatch(/returned\s+a\s+hit\s+AND\s+the\s+pattern\s+was\s+verified\s+expressible/);
  });

  it("caution 1 states what a positive control does and does not establish", () => {
    const b = block();
    expect(b).toMatch(/establishes\s+only\s+that\s+the\s+SCOPE\s+was/);
    expect(b).toMatch(/nothing\s+about\s+whether\s+the\s+PATTERN/);
  });

  it("caution 1 states matching is case-sensitive and that a mismatch survives the control", () => {
    const b = block();
    expect(b).toMatch(/CASE-SENSITIVE/);
    expect(b).toMatch(/case\s+mismatch\s+survives\s+the\s+control/);
    expect(b).toMatch(/control\s+tests\s+the\s+scope,\s+the\s+query\s+tests\s+the\s+pattern/);
  });

  it("caution 1 names enumeration as the way to settle an absence claim", () => {
    const b = block();
    expect(b).toMatch(/ENUMERATE/);
    expect(b).toMatch(/read\s+the\s+verbatim/);
  });

  it("caution 1 names the unbackticked and line-scoped traps", () => {
    const b = block();
    expect(b).toContain("unbackticked query");
    expect(b).toContain("line-scoped");
  });

  it("caution 1 states matchCount counts lines CONTAINING the pattern, not equal to it", () => {
    // backlog.fix.multiline-anchor-verification-false-green. A governor read a
    // count as a verdict on verbatim identity, which containment matching cannot
    // support. The block must say so, and must name the field that can.
    const b = block();
    expect(b).toContain("A COUNT IS NOT EVIDENCE OF VERBATIM IDENTITY");
    expect(b).toContain("lines[i].includes(pattern)");
    expect(b).toContain("compare `results[].text` against the pattern");
  });

  it("caution 1 states separate single-line searches carry no evidence of contiguity", () => {
    // The two-line anchor case: both halves returned one match, both were true,
    // and the block had already been broken by a line inserted between them.
    const b = block();
    expect(b).toContain("SEPARATE SINGLE-LINE SEARCHES CARRY NO EVIDENCE OF CONTIGUITY");
    expect(b).toContain("`results[].line`");
    expect(b).toContain("never implied by two counts both reading one");
  });

  it("caution 1's retirement pointer is scoped so the three new facts survive it", () => {
    // ARCH F6: containment matching is correct behaviour, not a defect, and
    // adjacency evidence will never come from separate single-line searches.
    // Neither is retired by the pruned-basename fix, so the pointer is qualified
    // in place rather than left to imply it covers them.
    const b = block();
    // WRAP-TOLERANT. These two previously embedded a newline lifted from where the
    // prompt prose happened to wrap, so a cosmetic reflow of the Tool Reliability
    // block would have reported present text as ABSENT. \s+ spans the break without
    // loosening the claim: the qualifying clause still has to be there, in order.
    // Same form the sibling assertion below already uses.
    expect(b).toMatch(/that pointer retires the\s+pruned-basename zero only/);
    expect(b).toMatch(/retired by\s+nothing/);
    // THIRD unretired fact: case sensitivity. Without this, retiring the
    // pruned-basename pointer in a later story would appear to retire the casing
    // warning too, which is false — they are fixed by different stories.
    expect(b).toMatch(/CASE-SENSITIVE/);
  });

  it("caution 2 states RAG line numbers are generated, not retrieved", () => {
    const b = block();
    expect(b).toContain("GENERATED, not retrieved");
  });

  it("caution 2 forbids pasting a RAG line number into a story, plan, anchor or finding", () => {
    const b = block();
    expect(b).toMatch(/MUST NOT paste a RAG line number into a story, a plan, a SEARCH anchor or a\s+review finding/);
  });

  it("caution 2 routes completeness claims to rks_exhaustive_search", () => {
    const b = block();
    expect(b).toContain("these are all of them");
    expect(b).toContain("MUST come from `rks_exhaustive_search`");
  });

  it("caution 3 states the corrupting write reports success", () => {
    const b = block();
    expect(b).toContain("`ok: true`");
    expect(b).toContain("unparseable");
  });

  it("caution 3 states the corruption surfaces on the NEXT write, not the causing one", () => {
    const b = block();
    expect(b).toContain("does NOT surface on the");
    expect(b).toContain("NEXT field write or read");
  });

  it("caution 3 mandates a read-back after EACH frontmatter write", () => {
    const b = block();
    expect(b).toContain("`dendron_read_note`");
    expect(b).toContain("EACH field write, not once at the end");
  });

  it("each caution carries a retirement pointer naming its fix story", () => {
    const b = block();
    // Without these the workaround becomes permanent cruft in every child project, with
    // nothing recording the condition under which it should be removed.
    expect(b).toContain("Retired by: backlog.fix.exhaustive-search-dotdir-silent-zero");
    expect(b).toContain("Retired by: backlog.fix.research-agent-output-contract");
    expect(b).toContain("Retired by: backlog.fix.yaml-frontmatter-quoting");
  });
});

describe("per-prompt amendments", () => {
  it("governor-build.md no longer makes RAG the authority for exact anchor text", () => {
    const src = read("governor-build.md");
    // Both the query step AND the identify-a-verbatim-line step had to be re-pointed —
    // amending only the first leaves the AC satisfiable while the defect survives one
    // line below it.
    expect(src).not.toContain("Find the exact function signature or export declaration at the edit location");
    expect(src).not.toContain("From the research result, identify a short verbatim line");
    expect(src).toContain("rks_exhaustive_search");
  });

  it("governor-build.md states caution 3 is inert AND keeps the dendron_read_note prohibition", () => {
    const src = read("governor-build.md");
    expect(src).toContain("Do NOT call dendron_read_note");
    expect(src).toContain("caution 3 is INERT for Build");
    // The point of the sentence is that it resolves the apparent conflict rather than
    // creating one — this prompt has shipped a self-contradiction before.
    expect(src).toContain("does NOT license calling `dendron_read_note`");
  });

  it("governor-qa.md amendment is additive — pinned phrases survive", () => {
    const src = read("governor-qa.md");
    expect(src).toContain("Regression-witness scan");
    expect(src).toContain("Avoid brittle test patterns");
    expect(src).toContain("POSITIVE CONTROL");
  });

  it("governor-arch.md amendment is additive — pinned phrases survive", () => {
    const src = read("governor-arch.md");
    expect(src).toContain("use the governed exhaustive-search tool");
    expect(src).toContain("rks_exhaustive_search");
    expect(src).toContain("fixed-size source-window slices");
    expect(src).toContain("POSITIVE CONTROL");
  });

  it("governor-po.md reconciles its anchor rule with caution 2 rather than competing", () => {
    const src = read("governor-po.md");
    expect(src).toContain("Get the anchor text from `rks_exhaustive_search`");
    expect(src).toContain("caution 2 applied to anchors");
  });
});

describe("pre-existing negative assertions must stay satisfied", () => {
  it("governor-arch.md still has no arch_guidance-colon literal", () => {
    expect(read("governor-arch.md")).not.toContain("arch_guidance:");
  });

  it("no edited prompt gains a bare Grep list line", () => {
    for (const f of EDITED) {
      const lines = read(f).split("\n").map((l) => l.trim());
      expect(lines, `${f} gained a bare Grep bullet`).not.toContain("- Grep");
    }
  });

  it("the block introduces neither a Decomposed Child string nor a Rules heading", () => {
    // decomp-test-coverage-gate.test.mjs anchors its windows with indexOf on these strings;
    // introducing either would move a window onto different source text.
    const b = extractBlock(read(EDITED[0]));
    expect(b).not.toContain("Decomposed Child");
    expect(b.split("\n").some((l) => l.trim() === "## Rules")).toBe(false);
  });
});

describe("substitution placeholders are unchanged by the block", () => {
  it("the canonical block introduces no placeholders", () => {
    const b = extractBlock(read(EDITED[0]));
    for (const ph of ["__PROJECT_ID__", "__PROBLEM_ID__", "__STORY_IDS__"]) {
      expect(b, `block introduced ${ph}`).not.toContain(ph);
    }
  });
});

describe("tool allowlists permit what the block requires", () => {
  it("governor-qa.md allows dendron_read_note, which caution 3 requires there", () => {
    // Caution 3 fires for QA (it writes frontmatter), so the read-back must be callable.
    const src = read("governor-qa.md");
    const idx = src.indexOf("## Tool Allowlist");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx)).toContain("dendron_read_note");
  });
});
