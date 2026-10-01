/**
 * Regression-witness scan encoded in the QA + ARCH governor prompts.
 *
 * Story: backlog.feat.regression-witness-scan-qa-arch
 *
 * Three times this campaign a story changed a file's content and a PRE-EXISTING test that
 * pinned that content broke CI. These assertions verify governor-qa.md / governor-arch.md
 * now instruct the governors to grep for such tests and fold them in (QA) / fail review
 * (ARCH). Full-content matches only — no fixed-window slicing (the brittleness this fixes).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const qa = fs.readFileSync(path.join(repoRoot, ".rks/prompts/governor-qa.md"), "utf8");
const arch = fs.readFileSync(path.join(repoRoot, ".rks/prompts/governor-arch.md"), "utf8");
const selfSrc = fs.readFileSync(path.join(repoRoot, "tests/unit/governor-regression-witness.test.mjs"), "utf8");

describe("regression-witness scan in QA + ARCH governor prompts", () => {
  it("governor-qa.md has a regression-witness scan step that folds pinning tests into testFiles/targetFiles", () => {
    expect(qa).toContain("Regression-witness scan");
    expect(qa).toMatch(/PRE-EXISTING tests that assert on each of the story's targetFiles/);
    expect(qa).toMatch(/fold it into this story's testFiles AND targetFiles/);
  });

  it("governor-qa.md warns against the brittle-test antipattern", () => {
    expect(qa).toContain("Avoid brittle test patterns");
    expect(qa).toMatch(/fixed-size source window/);
  });

  it("governor-arch.md Item 3 mandates the governed exhaustive-search tool for pinning tests and returns needs-revision", () => {
    expect(arch).toMatch(/use the governed exhaustive-search tool/);
    // The false raw-grep mandate is gone (Option C — raw grep is not a sanctioned tool).
    expect(arch).not.toMatch(/You MUST actively grep the test suite/);
    expect(arch).toMatch(/return `needs-revision`/);
  });

  it("governor-arch.md allowlist includes the governed exhaustive-search tool, not a raw Grep tool", () => {
    expect(arch).toMatch(/rks_exhaustive_search/);
    // No bare `- Grep` allowlist entry was added.
    expect(arch).not.toMatch(/^\s*-\s*Grep\s*$/m);
  });

  it("governor-qa.md regression-witness completeness step is governed-exhaustive-search-primary, not RAG/Grep", () => {
    expect(qa).toMatch(/governed exhaustive[- ]search/);
    // The old RAG-primary "Use rks_agent_research (or Grep) to find them" wording is gone.
    expect(qa).not.toMatch(/Use\s+rks_agent_research \(or Grep\) to find them/);
    // recall -> precision -> commit loop is encoded.
    expect(qa).toMatch(/recall/);
    expect(qa).toMatch(/precision/);
    expect(qa).toMatch(/Commit only/);
  });

  it("governor-arch.md flags brittle new tests (fixed-window slices)", () => {
    expect(arch).toMatch(/fixed-size source-window slices/);
  });

  it("dogfood: this test does not use fixed-window source slicing", () => {
    expect(selfSrc).not.toMatch(/\.slice\(\s*\w*[Ii]dx/);
  });
});
