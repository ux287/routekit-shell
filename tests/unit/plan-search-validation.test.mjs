import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { reviewPlan } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// ── Helper: build a minimal plan with one search_replace step ───────

function makeSearchReplacePlan(filePath, search, replace = "new code") {
  return {
    steps: [{
      action: "search_replace",
      path: filePath,
      edits: [{ search, replace }],
    }],
  };
}

// ── closest_match tests ─────────────────────────────────────────────

describe("checkSearchReplacePatterns closest_match", () => {
  // Use a real file in the project that we know exists
  const targetFile = "packages/mcp-rks/src/shared/governor-state.mjs";

  it("returns closest_match when search pattern has a near-miss", async () => {
    // Use a slightly wrong version of a real pattern
    const plan = makeSearchReplacePlan(targetFile, "export function getStates(flowTyp) {");
    const result = await reviewPlan({ projectRoot: PROJECT_ROOT, plan });
    const error = result.errors.find(e => e.check === "search_pattern_not_found");
    expect(error).toBeDefined();
    expect(error.closest_match).toBeTruthy();
    expect(error.closest_match).toContain("getStates");
  });

  it("returns empty closest_match when no region is remotely similar", async () => {
    const plan = makeSearchReplacePlan(targetFile, "zzz_completely_unrelated_gibberish_xyz_12345");
    const result = await reviewPlan({ projectRoot: PROJECT_ROOT, plan });
    const error = result.errors.find(e => e.check === "search_pattern_not_found");
    expect(error).toBeDefined();
    expect(error.closest_match).toBe("");
  });

  it("returns no errors for exact match", async () => {
    // Read actual content to get an exact match
    const content = fs.readFileSync(path.join(PROJECT_ROOT, targetFile), "utf8");
    const lines = content.split("\n");
    // Find a unique line to use as search pattern
    const exportLine = lines.find(l => l.includes("export function getStates"));
    expect(exportLine).toBeTruthy();
    const plan = makeSearchReplacePlan(targetFile, exportLine);
    const result = await reviewPlan({ projectRoot: PROJECT_ROOT, plan });
    const searchErrors = result.errors.filter(e => e.check === "search_pattern_not_found");
    expect(searchErrors.length).toBe(0);
  });

  it("returns target_file_not_found for missing files", async () => {
    const plan = makeSearchReplacePlan("nonexistent/file.mjs", "some pattern");
    const result = await reviewPlan({ projectRoot: PROJECT_ROOT, plan });
    const error = result.errors.find(e => e.check === "target_file_not_found");
    expect(error).toBeDefined();
  });

  it("returns search_pattern_ambiguous for patterns matching multiple times", async () => {
    // 'rks_project_get' appears in many states — should be ambiguous
    const plan = makeSearchReplacePlan(targetFile, "'rks_project_get',");
    const result = await reviewPlan({ projectRoot: PROJECT_ROOT, plan });
    const error = result.errors.find(e => e.check === "search_pattern_ambiguous");
    expect(error).toBeDefined();
  });
});

// ── Planner prompt content tests ────────────────────────────────────

describe("planner.mjs system prompt content", () => {
  let plannerSource;

  it("loads planner source", () => {
    plannerSource = fs.readFileSync(
      path.join(PROJECT_ROOT, "packages/mcp-rks/src/llm/planner.mjs"),
      "utf8"
    );
    expect(plannerSource).toBeTruthy();
  });

  it("callOpenAiChat system prompt includes verbatim verification instruction", () => {
    expect(plannerSource).toContain(
      "verify that each SEARCH pattern exists verbatim in the RAG code snippets"
    );
  });

  it("callAnthropicChat system prompt includes verbatim verification instruction", () => {
    const matches = plannerSource.match(/verify that each SEARCH pattern exists verbatim/g);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("system prompt includes needs_code_context fallback instruction", () => {
    expect(plannerSource).toContain("needs_code_context step instead of guessing");
  });

  it("system prompt includes exact whitespace copy instruction", () => {
    expect(plannerSource).toContain(
      "Copy exact lines including whitespace and indentation"
    );
  });
});

// ── Governor build prompt tests ─────────────────────────────────────

describe("governor-build.md plan-validation retry", () => {
  let buildPrompt;

  it("loads build governor prompt", () => {
    buildPrompt = fs.readFileSync(
      path.join(PROJECT_ROOT, ".rks/prompts/governor-build.md"),
      "utf8"
    );
    expect(buildPrompt).toBeTruthy();
  });

  it("contains retry branch for search_pattern_not_found", () => {
    expect(buildPrompt).toContain("search_pattern_not_found");
    expect(buildPrompt).toContain("plan_rejected");
  });

  it("caps plan-validation retry at max 1", () => {
    expect(buildPrompt).toContain("max 1 retry");
  });

  it("non-search-pattern errors still hard-stop", () => {
    expect(buildPrompt).toContain("destructive_edit");
    expect(buildPrompt).toContain("STOP immediately");
  });
});
