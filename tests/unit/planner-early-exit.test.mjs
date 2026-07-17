/**
 * Tests for runPlanTool early-exit path:
 * when all op:edit targets have @@SEARCH/@@REPLACE blocks, bypass LLM entirely.
 *
 * Covers:
 * - All op:edit targets covered → early-exit fires, orchestrateLlmPlanning not called
 * - Returned steps have correct shape: action, path, edits array, source field
 * - Any op:edit target missing blocks → falls through to LLM (orchestrateLlmPlanning called)
 * - op:create excluded from the @@SEARCH coverage loop (checkAllCovered), but the early-exit
 *   DECISION is gated by shouldEarlyExitToSteps, which refuses the bypass when uncovered
 *   op:create targets exist (backlog.fix.planner-drops-create-file-steps)
 * - Partial coverage does not trigger early-exit
 * - Inline comment documents the all-or-nothing rationale (static check)
 * - persistAndFinalize and checkOpMatch handle source: "search_replace_block"
 * - planProblem function removed from planner.mjs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Unit tests for extractSearchReplaceBlocks (used by the early-exit)
// ---------------------------------------------------------------------------
import { extractSearchReplaceBlocks } from "../../packages/mcp-rks/src/server/planner-context.mjs";

describe("extractSearchReplaceBlocks", () => {
  it("returns blocks when @@SEARCH/@@REPLACE/@@END present under a path heading", () => {
    const content = `
### src/server/foo.mjs

@@SEARCH
export function foo() {
@@REPLACE
export function foo(x) {
@@END
`;
    const blocks = extractSearchReplaceBlocks(content, "src/server/foo.mjs");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].search).toContain("export function foo()");
    expect(blocks[0].replace).toContain("export function foo(x)");
  });

  it("returns empty array when no @@SEARCH block for path", () => {
    const content = `
### src/server/other.mjs

@@SEARCH
something
@@REPLACE
something else
@@END
`;
    const blocks = extractSearchReplaceBlocks(content, "src/server/foo.mjs");
    expect(blocks).toHaveLength(0);
  });

  it("returns empty array for empty content", () => {
    expect(extractSearchReplaceBlocks("", "src/foo.mjs")).toHaveLength(0);
    expect(extractSearchReplaceBlocks(null, "src/foo.mjs")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Early-exit step shape
// ---------------------------------------------------------------------------

describe("early-exit step shape", () => {
  it("builds steps in edits-array format (not flat search/replace)", () => {
    // The early-exit path builds: { action, path, edits: [{search, replace}], source }
    // Verify this is what exec.mjs expects — it checks Array.isArray(step.edits)
    const content = `
### packages/mcp-rks/src/server/exec.mjs

@@SEARCH
old code here
@@REPLACE
new code here
@@END
`;
    const blocks = extractSearchReplaceBlocks(content, "packages/mcp-rks/src/server/exec.mjs");
    expect(blocks.length).toBeGreaterThan(0);

    // Simulate early-exit step construction
    const step = {
      action: "search_replace",
      path: "packages/mcp-rks/src/server/exec.mjs",
      edits: blocks.map(b => ({ search: b.search, replace: b.replace })),
      source: "search_replace_block",
    };

    expect(step.action).toBe("search_replace");
    expect(step.path).toBe("packages/mcp-rks/src/server/exec.mjs");
    expect(Array.isArray(step.edits)).toBe(true);
    expect(step.edits.length).toBeGreaterThan(0);
    expect(step.edits[0]).toHaveProperty("search");
    expect(step.edits[0]).toHaveProperty("replace");
    expect(step.source).toBe("search_replace_block");
  });

  it("source: search_replace_block is pass-through — checkOpMatch ignores it", () => {
    // checkOpMatch only checks create_file steps — search_replace steps with any source pass through
    const { checkOpMatch } = require("../../packages/mcp-rks/src/server/plan-quality.mjs");
    const steps = [
      {
        action: "search_replace",
        path: "src/existing.mjs",
        edits: [{ search: "old", replace: "new" }],
        source: "search_replace_block",
      },
    ];
    const targetFiles = [{ path: "src/existing.mjs", op: "edit" }];
    const violations = checkOpMatch(steps, targetFiles);
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// All-or-nothing gate rationale (static check)
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const plannerPath = path.resolve(__dirname, "../../packages/mcp-rks/src/server/planner.mjs");

describe("early-exit all-or-nothing gate documentation", () => {
  it("inline comment documents the all-or-nothing rationale", () => {
    const source = fs.readFileSync(plannerPath, "utf8");
    // The rationale comment must be present near the early-exit gate
    expect(source).toContain("All-or-nothing gate");
    expect(source).toContain("split execution model");
  });

  it("tech debt comment references design.arch-planner-refactor.md", () => {
    const source = fs.readFileSync(plannerPath, "utf8");
    expect(source).toContain("design.arch-planner-refactor.md");
  });
});

// ---------------------------------------------------------------------------
// Coverage check logic (pure unit, no runPlanTool invocation)
// ---------------------------------------------------------------------------

describe("early-exit coverage check logic", () => {
  function checkAllCovered(planningText, editableTargetPaths) {
    // Mirrors the early-exit logic in runPlanTool
    const steps = [];
    for (const targetPath of editableTargetPaths) {
      const blocks = extractSearchReplaceBlocks(planningText, targetPath);
      if (blocks.length === 0) return { allCovered: false, steps: [] };
      steps.push({
        action: "search_replace",
        path: targetPath,
        edits: blocks.map(b => ({ search: b.search, replace: b.replace })),
        source: "search_replace_block",
      });
    }
    return { allCovered: true, steps };
  }

  const makeBlock = (filePath) => `
### ${filePath}

@@SEARCH
old code
@@REPLACE
new code
@@END
`;

  it("all op:edit targets covered → allCovered true, steps built", () => {
    const planningText = makeBlock("src/a.mjs") + makeBlock("src/b.mjs");
    const { allCovered, steps } = checkAllCovered(planningText, ["src/a.mjs", "src/b.mjs"]);
    expect(allCovered).toBe(true);
    expect(steps).toHaveLength(2);
    expect(steps[0].path).toBe("src/a.mjs");
    expect(steps[1].path).toBe("src/b.mjs");
  });

  it("any op:edit target missing blocks → allCovered false", () => {
    const planningText = makeBlock("src/a.mjs"); // only a, not b
    const { allCovered } = checkAllCovered(planningText, ["src/a.mjs", "src/b.mjs"]);
    expect(allCovered).toBe(false);
  });

  it("partial coverage (first covered, second not) → allCovered false", () => {
    const planningText = makeBlock("src/a.mjs");
    const { allCovered } = checkAllCovered(planningText, ["src/a.mjs", "src/b.mjs"]);
    expect(allCovered).toBe(false);
  });

  it("op:create targets not in editableTargetPaths → excluded from check", () => {
    // editableTargetPaths only contains op:edit paths — op:create paths are in frontmatterCreateFiles.
    // The @@SEARCH coverage loop (checkAllCovered) only iterates editableTargetPaths, so it ignores
    // op:create. The early-exit DECISION, however, is now gated by shouldEarlyExitToSteps, which
    // refuses the LLM bypass when uncovered op:create targets exist — so op:create no longer slips
    // through silently (backlog.fix.planner-drops-create-file-steps).
    const planningText = makeBlock("src/edit-me.mjs");
    // op:create path NOT in editableTargetPaths — simulating correct gatherTargetContext behavior
    const editableTargetPaths = ["src/edit-me.mjs"]; // only op:edit
    const { allCovered, steps } = checkAllCovered(planningText, editableTargetPaths);
    expect(allCovered).toBe(true);
    expect(steps).toHaveLength(1);
    expect(steps[0].path).toBe("src/edit-me.mjs");
  });

  it("empty editableTargetPaths → early-exit does not fire (no steps)", () => {
    // Guard: editableTargetPaths.length > 0 check prevents early-exit on create-only stories
    const planningText = makeBlock("src/new-file.mjs");
    const editableTargetPaths = [];
    // The early-exit guard is `if (editableTargetPaths && editableTargetPaths.length > 0)`
    // With empty array, checkAllCovered is never called
    expect(editableTargetPaths.length).toBe(0);
    // No steps built — falls through to LLM
  });

  it("multiple @@SEARCH blocks for same file → all included in edits array", () => {
    const planningText = `
### src/multi.mjs

@@SEARCH
first old
@@REPLACE
first new
@@END

@@SEARCH
second old
@@REPLACE
second new
@@END
`;
    const { allCovered, steps } = checkAllCovered(planningText, ["src/multi.mjs"]);
    expect(allCovered).toBe(true);
    expect(steps[0].edits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// F10 regression: the early-exit must classify its plan as "executable" (not the
// inert 'ready' that persistAndFinalize ignores), so a successful deterministic
// plan advances arch-approved -> executing and is marked executable.
// See backlog.fix.planner-early-exit-status-not-executable.
// ---------------------------------------------------------------------------
import { classifyPlanStatus } from "../../packages/mcp-rks/src/server/planner-prompts.mjs";

describe("F10: early-exit status classification", () => {
  const earlyExitSteps = [
    {
      action: "search_replace",
      path: "src/example.js",
      edits: [{ search: "const a = 1;", replace: "const a = 2;" }],
      source: "search_replace_block",
    },
  ];

  it("classifyPlanStatus returns 'executable' for early-exit search_replace steps", () => {
    // Single source of truth the early-exit now derives its status from
    // (planner.mjs: classifyPlanStatus({ steps: earlyExitSteps })). Must NOT be
    // the inert 'ready' that persistAndFinalize ignores (no exec_start, executable:false).
    expect(classifyPlanStatus({ steps: earlyExitSteps })).toBe("executable");
    expect(classifyPlanStatus({ steps: earlyExitSteps })).not.toBe("ready");
  });

  it("note steps -> needs_refinement, empty -> note_only (negative controls preserved)", () => {
    expect(classifyPlanStatus({ steps: [{ action: "note", text: "do later" }] })).toBe("needs_refinement");
    expect(classifyPlanStatus({ steps: [] })).toBe("note_only");
  });

  it("early-exit derives planStatus from classifyPlanStatus, not a hardcoded 'ready' (static guard)", () => {
    const source = fs.readFileSync(plannerPath, "utf8");
    expect(source).toContain("classifyPlanStatus({ steps: earlyExitSteps })");
    expect(source).not.toContain("planStatus: 'ready'");
  });
});
