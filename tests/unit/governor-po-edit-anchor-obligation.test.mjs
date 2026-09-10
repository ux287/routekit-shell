/**
 * Witness for backlog.fix.po-prompt-edit-target-anchor-obligation.
 *
 * THE DEFECT: `governor-po.md` closed its CRITICAL create-side block with
 *
 *     `op: 'edit'` targets need no code block. This applies to creates only.
 *
 * True about fenced code blocks. Misleading about `@@SEARCH` anchors. Read by a PO Governor it
 * lands as "edit targets need nothing" — which is precisely how a story reaches `arch-approved`
 * carrying three `op: edit` targets and zero anchors, then hard-blocks at plan time on
 * `no_search_pattern_for_modify`. Child projects run on-rail, so this stopped them on their first
 * story with an edit target.
 *
 * OWNERSHIP, and why the fix is here and nowhere else: `plan-ready.mjs` is the correct mechanical
 * owner and stays as-is; the Build refine loop is the sanctioned automated satisfier; and PO is
 * the AUTHORING owner by direct precedent, since it already owns the exactly-symmetric `op: create`
 * rule enforced by `create_target_no_authorable_block`. QA and ARCH are the wrong owners — ARCH
 * structurally cannot check it, because `rks_plan_ready` is on its explicit NOT-Allowed list. The
 * negative assertions at the bottom of this file enforce that boundary rather than merely stating it.
 *
 * TEST APPROACH — region bounded by BOTH markers, never a fixed `slice(idx, idx + N)` window.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const readPrompt = (name) =>
  fs.readFileSync(path.join(REPO_ROOT, ".rks/prompts", name), "utf8");

const PO = readPrompt("governor-po.md");

/** The target-authoring block: from the create-side CRITICAL heading to the next `## ` section. */
function authoringRegion() {
  const start = PO.indexOf("**CRITICAL — every `op: 'create'` target needs a FENCED CODE BLOCK");
  const end = PO.indexOf("\n## Rules", start);
  expect(start, "create-side CRITICAL heading not found — prompt structure changed").toBeGreaterThan(-1);
  expect(end, "`## Rules` heading not found after it — prompt structure changed").toBeGreaterThan(start);
  return PO.slice(start, end);
}

describe("the edit-side disclaimer is replaced by an obligation", () => {
  it("THE FIX: the misleading sentence is gone", () => {
    expect(PO).not.toContain("`op: 'edit'` targets need no code block. This applies to creates only.");
  });

  it("the region states the anchor obligation for op:edit targets", () => {
    const region = authoringRegion();
    expect(region).toMatch(/@@SEARCH/);
    expect(region).toMatch(/op: 'edit'/);
    // The distinction that makes it non-misleading: no fenced BLOCK, but yes an ANCHOR.
    expect(region).toMatch(/verbatim/i);
    expect(region).toMatch(/unique/i);
  });

  it("it names the enforcing check, the way the create side names its own", () => {
    const region = authoringRegion();
    expect(region).toContain("no_search_pattern_for_modify");
    // Symmetry is the point — both rules cite the blocking issue that enforces them.
    expect(region).toContain("create_target_no_authorable_block");
  });

  it("it shows the canonical shape with markers at column 0", () => {
    // `toContain` would pass on an indented marker, which does NOT parse. Anchor to line start.
    const region = authoringRegion();
    expect(region).toMatch(/^@@SEARCH$/m);
    expect(region).toMatch(/^@@REPLACE$/m);
    expect(region).toMatch(/^@@END$/m);
  });

  it("it directs PO to governed exhaustive search, NOT to RAG", () => {
    const region = authoringRegion();
    expect(region).toContain("rks_exhaustive_search");
    // The prohibition has to be explicit. RAG line numbers are generated rather than retrieved
    // and have been observed off by several lines on these exact files.
    expect(region).toMatch(/do NOT take it from RAG/i);
  });

  it("it retains an explicit escape hatch, and closes the silent one", () => {
    const region = authoringRegion();
    expect(region).toMatch(/refine loop must\s+supply it/i);
    // Omitting an anchor is allowed only WITH a stated reason. Silence must not read as consent.
    expect(region).toMatch(/Silence is not an escape/i);
  });
});

describe("the create-side rules are untouched", () => {
  it("the directive-plus-block requirement still stands", () => {
    const region = authoringRegion();
    expect(region).toContain("// CREATE FILE:");
    expect(region).toMatch(/fenced block holding real file/i);
    expect(region).toMatch(/failureClass: "structural"/);
  });

  it("the `## Rules` section still follows the region", () => {
    expect(PO).toContain("\n## Rules");
  });

  it("section ordering that other witnesses walk is preserved", () => {
    // governor-po-prompt.test.mjs asserts this ordering. The inserted example uses `###`
    // headings inside a fence, never `## `, so it cannot introduce a spurious waypoint.
    expect(PO.indexOf("## Decomposition Rules")).toBeLessThan(PO.indexOf("## Chain"));
  });

  it("the inserted example does not add a top-level section heading", () => {
    const headings = authoringRegion().split("\n").filter((l) => /^## /.test(l));
    expect(headings, `unexpected '## ' heading inside the region: ${headings.join(", ")}`).toEqual([]);
  });
});

describe("SCOPE BOUNDARY — the obligation lands on PO and nowhere else", () => {
  // Not a stylistic preference. ENFORCEMENT ownership is what this boundary defends — not the
  // absence of anchor vocabulary. `rks_plan_ready` is the mechanical owner of the edit-anchor
  // check; PO is the AUTHORING owner; ARCH has `rks_plan_ready` on its explicit NOT-Allowed
  // list, so it structurally CANNOT perform the check. Duplicating a deterministic predicate
  // with an LLM eyeball in either place would treat the symptom.
  //
  // AMENDED by backlog.fix.qa-prompt-create-op-destroys-existing-test-files. The original
  // rationale here read "QA's targetFiles contribution is `op: create` test entries", and the
  // pin below forbade `@@SEARCH` in `governor-qa.md` on that basis. That premise is now FALSE:
  // step 5b emits `op: 'edit'` targets for test files that already exist on disk, so the QA
  // prompt MUST name the anchor obligation its own targets carry. Naming the obligation is not
  // performing the check — QA still never calls `rks_plan_ready` nor cites its blocking issue.
  it("governor-qa.md states the edit-anchor obligation but does not perform the check", () => {
    const qa = readPrompt("governor-qa.md");
    // INVERTED, not deleted: QA emits op:'edit' targets, so it must name `@@SEARCH`.
    expect(qa).toContain("@@SEARCH");
    // PRESERVED: naming the anchor is authoring; citing the plan-ready issue would be enforcement.
    expect(qa).not.toContain("no_search_pattern_for_modify");
  });

  it("governor-arch.md gains no anchor check", () => {
    const arch = readPrompt("governor-arch.md");
    expect(arch).not.toContain("no_search_pattern_for_modify");
    expect(arch).not.toContain("@@SEARCH");
  });

  it("ARCH still cannot call rks_plan_ready — the structural reason it is the wrong owner", () => {
    expect(readPrompt("governor-arch.md")).toContain("rks_plan_ready");
  });
});
