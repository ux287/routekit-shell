/**
 * Witness for backlog.fix.qa-prompt-create-op-destroys-existing-test-files.
 *
 * THE DEFECT: `governor-qa.md` step 5b closed with, verbatim and unconditionally,
 *
 *       → Merge: keep all existing targetFiles, ADD test file entries with op: 'create'.
 *
 * Every test-file target the QA Governor emitted was stamped `op: 'create'`, whether or not the
 * file was already on disk. That op dispatches into `applyCreateFile`
 * (packages/mcp-rks/src/server/step-apply.mjs), whose only guard is on empty content before
 * `fs.writeFileSync` — no existence check. So a pre-existing test file was SILENTLY DESTROYED
 * and replaced at Build time: it did not fail, and it did not no-op. Step 5b aimed at precisely
 * the files step 4's regression-witness scan had just gone to considerable effort to find.
 *
 * It also contradicted step 4 of the same prompt, which correctly says `op: 'edit'` for exactly
 * this class of file — twelve lines earlier.
 *
 * SCOPE: this witness pins the PROMPT fix only. The defence-in-depth guard in `applyCreateFile`
 * is deliberately deferred to a separate story; nothing here asserts over
 * `packages/mcp-rks/src/server/`.
 *
 * TEST APPROACH — the step-5b region is bounded by BOTH of its structural markers via `indexOf`,
 * never a fixed `slice(idx, idx + N)` window. The bound is LOAD-BEARING, not decoration: an
 * unscoped whole-file `toContain("op: 'edit'")` already passes at HEAD via step 4's text, so a
 * whole-file assertion here would be vacuous — it would exist, be falsifiable in principle, and
 * still not test what its requirement says. `region()` proves its own markers are present.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const readPrompt = (name) =>
  fs.readFileSync(path.join(REPO_ROOT, ".rks/prompts", name), "utf8");

const QA = readPrompt("governor-qa.md");

/** Step 5b: from the `targetFiles` update call to the `phase` update call that follows it. */
function region() {
  const start = QA.indexOf("field: 'targetFiles'");
  const end = QA.indexOf("field: 'phase'", start);
  expect(start, "step 5b `field: 'targetFiles'` marker not found — prompt structure changed").toBeGreaterThan(-1);
  expect(end, "step 5c `field: 'phase'` marker not found after it — prompt structure changed").toBeGreaterThan(start);
  return QA.slice(start, end);
}

describe("THE FIX — step 5b chooses op per file instead of stamping create on everything", () => {
  it("the legacy unconditional sentence is gone from the whole prompt", () => {
    expect(QA).not.toContain("ADD test file entries with op: 'create'");
  });

  it("an already-existing test file gets op: 'edit'", () => {
    const r = region();
    expect(r).toContain("ALREADY EXISTS");
    expect(r).toContain("op: 'edit'");
  });

  it("op: 'create' is conditioned on non-existence, not stamped unconditionally", () => {
    const r = region();
    expect(r).toContain("DOES NOT YET EXIST");
    expect(r).toContain("op: 'create'");
  });

  it("the region bound is load-bearing — a whole-file assertion would be vacuous", () => {
    // Step 4 at :67 already carries `op: 'edit'`, so the unscoped assertion passes even on the
    // broken prompt. If this ever stops being true the region bound may look redundant; it is not.
    expect(QA).toContain("fold it into this story's testFiles AND targetFiles (op: 'edit')");
    const r = region();
    expect(QA.replace(r, "")).toContain("op: 'edit'");
  });

  it("step 5b names the concrete existence check rather than leaving it to inference", () => {
    expect(region()).toContain("rks_exhaustive_search");
  });

  it("merge semantics are preserved — nothing is dropped", () => {
    const r = region();
    expect(r).toContain("keep all existing targetFiles");
    expect(r).toContain("drop none");
  });

  it("both branches land in a plannable shape", () => {
    const r = region();
    expect(r).toContain("authorable fenced block");
    expect(r).toContain("@@SEARCH");
  });
});

describe("REGRESSION GUARD — the correct half of the prompt survives the repair", () => {
  it("step 4's regression-witness instruction is still present", () => {
    // Identified by its verbatim phrase, not by line number, so the guard survives reflow.
    expect(QA).toContain("fold it into this story's testFiles AND targetFiles");
  });

  it("QA still does not cite the plan-ready blocking issue — authoring, not enforcement", () => {
    expect(QA).not.toContain("no_search_pattern_for_modify");
  });
});

describe("SELF-ASSERTION — this witness follows the antipattern rule it was written under", () => {
  it("uses no fixed-size source window", () => {
    const self = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Assert over CODE, not prose. The header comment NAMES the antipattern in order to explain
    // it, and a whole-source regex cannot tell an explanation from a violation — it would fail on
    // its own documentation. Testing the stripped source is what the requirement actually says.
    const code = self.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Positive control: the strip removed the prose and kept the code. Without this, a regex that
    // silently emptied the source would make the assertion below pass vacuously.
    expect(code, "comment strip removed the code too").toContain("function region()");
    expect(code, "a block comment survived the strip").not.toMatch(/\/\*\*/);
    expect(code).not.toMatch(/slice\(\s*\w+\s*,\s*\w+\s*\+/);
  });
});
