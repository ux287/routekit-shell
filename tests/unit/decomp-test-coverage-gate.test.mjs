/**
 * Tests for decomp-test-coverage-gate — per-child test coverage enforcement.
 * Verifies that governor prompts contain the rule and planner.mjs exports
 * checkDecomposedChildTestCoverage with correct behavior.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// ── Source-based: governor-build.md ─────────────────────────────────────────

describe("governor-build.md — decomposed child test coverage rule (source)", () => {
  const src = readSource(".rks/prompts/governor-build.md");

  it("contains a section for decomposed child test coverage", () => {
    expect(src).toMatch(/Decomposed Child.*Test Coverage/i);
  });

  it("rule is present in a distinct section (not just the general rules)", () => {
    const sectionIdx = src.indexOf("Decomposed Child");
    const rulesIdx = src.indexOf("## Rules");
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeLessThan(rulesIdx);
  });

  it("explicitly rejects plans that defer test coverage to a sibling", () => {
    const sectionIdx = src.indexOf("Decomposed Child");
    const snippet = src.slice(sectionIdx, sectionIdx + 600);
    expect(snippet).toMatch(/defer.*test|sibling|MUST NOT/i);
  });

  it("references parent field as the detector for child stories", () => {
    const sectionIdx = src.indexOf("Decomposed Child");
    const snippet = src.slice(sectionIdx, sectionIdx + 300);
    expect(snippet).toMatch(/parent/);
  });
});

// ── Source-based: governor-qa.md ─────────────────────────────────────────────

describe("governor-qa.md — decomposed child test coverage rule (source)", () => {
  const src = readSource(".rks/prompts/governor-qa.md");

  it("contains a section for decomposed child test coverage", () => {
    expect(src).toMatch(/Decomposed Child.*Test Coverage/i);
  });

  it("rule is scoped to decomposed children (distinguishable from general rules)", () => {
    const sectionIdx = src.indexOf("Decomposed Child");
    const rulesIdx = src.lastIndexOf("## Rules");
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeLessThan(rulesIdx);
  });

  it("rule references testRequirements covering full scope", () => {
    const sectionIdx = src.indexOf("Decomposed Child");
    const snippet = src.slice(sectionIdx, sectionIdx + 500);
    expect(snippet).toMatch(/testRequirements/);
    expect(snippet).toMatch(/full|complete|scope/i);
  });

  it("rule prohibits deferred coverage to siblings", () => {
    const sectionIdx = src.indexOf("Decomposed Child");
    const snippet = src.slice(sectionIdx, sectionIdx + 500);
    expect(snippet).toMatch(/sibling|defer|MUST NOT/i);
  });
});

// ── Source-based: planner.mjs ────────────────────────────────────────────────

describe("planner.mjs — checkDecomposedChildTestCoverage export (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/planner.mjs");

  it("exports checkDecomposedChildTestCoverage", () => {
    expect(src).toMatch(/export async function checkDecomposedChildTestCoverage/);
  });

  it("only applies to child stories (parent field check)", () => {
    const fnIdx = src.indexOf("export async function checkDecomposedChildTestCoverage");
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    expect(fnBody).toMatch(/story\.parent/);
    expect(fnBody).toMatch(/return.*ok.*true/);
  });

  it("returns error when testRequirements is empty", () => {
    const fnIdx = src.indexOf("export async function checkDecomposedChildTestCoverage");
    const fnBody = src.slice(fnIdx, fnIdx + 1200);
    expect(fnBody).toMatch(/testRequirements.*length.*0|length.*0.*testRequirements/);
    expect(fnBody).toMatch(/deferred_test_coverage/);
  });

  it("imports and uses analyzeTestQuality (no duplicate logic)", () => {
    const fnIdx = src.indexOf("export async function checkDecomposedChildTestCoverage");
    const fnBody = src.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toMatch(/analyzeTestQuality/);
    expect(fnBody).toMatch(/test-static-analysis/);
  });

  it("post-exec check is scoped to child stories only (non-child returns ok immediately)", () => {
    const fnIdx = src.indexOf("export async function checkDecomposedChildTestCoverage");
    const fnBody = src.slice(fnIdx, fnIdx + 500);
    expect(fnBody).toMatch(/!story.*parent|!.*story\.parent/);
    expect(fnBody).toMatch(/return.*ok.*true/);
  });
});

// ── Behavioral unit tests ─────────────────────────────────────────────────────

describe("checkDecomposedChildTestCoverage — behavioral", async () => {
  const { checkDecomposedChildTestCoverage } = await import(
    path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs")
  );

  it("returns ok for non-child stories (no parent field)", async () => {
    const result = await checkDecomposedChildTestCoverage("/tmp", {
      id: "backlog.feat.some-story",
      targetFiles: ["src/foo.mjs"],
      testRequirements: [],
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok for child stories with testRequirements defined", async () => {
    const result = await checkDecomposedChildTestCoverage("/tmp", {
      id: "backlog.feat.some-story.part-one",
      parent: "backlog.feat.some-story",
      targetFiles: ["src/foo.mjs"],
      testRequirements: ["foo renders correctly", "foo handles empty input"],
    });
    expect(result.ok).toBe(true);
  });

  it("returns error for child stories with no testRequirements", async () => {
    const result = await checkDecomposedChildTestCoverage("/tmp", {
      id: "backlog.feat.some-story.part-one",
      parent: "backlog.feat.some-story",
      targetFiles: ["src/foo.mjs"],
      testRequirements: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("deferred_test_coverage");
    expect(result.message).toMatch(/testRequirements/);
  });

  it("returns error for child stories with undefined testRequirements", async () => {
    const result = await checkDecomposedChildTestCoverage("/tmp", {
      id: "backlog.feat.some-story.part-one",
      parent: "backlog.feat.some-story",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("deferred_test_coverage");
  });

  it("returns ok for null/undefined story (fail-open)", async () => {
    const result = await checkDecomposedChildTestCoverage("/tmp", null);
    expect(result.ok).toBe(true);
  });
});
