/**
 * backlog.fix.planner-prune-silent-and-provenance-split
 *
 * Two defects on one call site:
 *
 *   1. planner-context.mjs — `planningText = pruneRefineBlocks(planningText);` passed NO
 *      report out-param, so the four loss counters (gated on `opts.report`) were never
 *      computed on the plan path, nothing reached stderr, and gatherTargetContext's return
 *      object carried no prune field. The other production caller, refine.mjs, DOES pass one.
 *
 *   2. planner.mjs handed computeEarlyExitCoverage the PRUNED text while the create-side
 *      extractors read the RAW note. buildNoteDrivenSteps already passes
 *      `problemNote?.content || planningText` — the same deterministic-builder role — so raw
 *      provenance is the established in-file convention.
 *
 * FIXTURE NOTE: anchor markers and code fences are assembled from fragments so that no line
 * of THIS FILE begins with an anchor or a fence at column 0. A column-0 literal here is picked
 * up by the planner's own extractors when this file is embedded in a story note.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  gatherTargetContext,
  pruneRefineBlocks,
  extractSearchReplaceBlocks,
  PLAN_NOTE_PRUNE_THRESHOLD_BYTES,
} from "../../packages/mcp-rks/src/server/planner-context.mjs";
import {
  computeEarlyExitCoverage,
  shouldEarlyExitToSteps,
} from "../../packages/mcp-rks/src/server/planner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PLANNER_SRC = path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs");

const S = "@" + "@SEARCH";
const R = "@" + "@REPLACE";
const E = "@" + "@END";
const FENCE = "`" + "`" + "`";
const SNAPSHOT_MARKER = "SNAPSHOT-ONLY-MARKER";

const anchorGroup = (search, replace) => [S, search, R, replace, E].join("\n");
const filler = (n) =>
  Array.from(
    { length: n },
    (_, i) => SNAPSHOT_MARKER + " line " + i + " — refine snapshot padding, well past the prune threshold",
  ).join("\n");

/** Over-threshold body: one `### Target:` snapshot, one correctly-headed anchor group. */
function overThresholdBody() {
  return [
    "## Problem",
    "",
    "A story body that has accumulated a refine snapshot.",
    "",
    "### Target: src/a.mjs",
    "",
    FENCE + "js",
    filler(120),
    FENCE,
    "",
    "### src/a.mjs",
    "",
    anchorGroup("const a = 1;", "const a = 2;"),
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] something",
    "",
  ].join("\n");
}

/** Anchor group nested INSIDE a `### Target:` zone that follows a real `### <path>` heading. */
function misattributionBody() {
  return [
    "## Problem",
    "",
    "### src/b.mjs",
    "",
    anchorGroup("const b = 1;", "const b = 2;"),
    "",
    "### Target: src/a.mjs",
    "",
    FENCE + "js",
    filler(120),
    FENCE,
    "",
    anchorGroup("const a = 1;", "const a = 2;"),
    "",
    "## Acceptance Criteria",
    "",
  ].join("\n");
}

/** Over-threshold, but every editable target has its own `### <path>` heading + anchor group. */
function coveredBody() {
  return [
    "## Problem",
    "",
    "### Target: src/a.mjs",
    "",
    FENCE + "js",
    filler(120),
    FENCE,
    "",
    "### src/a.mjs",
    "",
    anchorGroup("const a = 1;", "const a = 2;"),
    "",
    "### src/b.mjs",
    "",
    anchorGroup("const b = 1;", "const b = 2;"),
    "",
    "## Acceptance Criteria",
    "",
  ].join("\n");
}

let tmpRoot;

beforeAll(() => {
  // A BARE temp root: no .rks/rag/config.json, so loadRagConfig returns null and
  // getRagContext short-circuits to empty without loading the embedding pipeline.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-prune-report-"));
  fs.writeFileSync(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ name: "rks-prune-report-fixture", version: "0.0.0", scripts: {} }, null, 2),
  );
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Drive the real gatherTargetContext, capturing stderr. No subprocess is spawned. */
async function runGather(taskText) {
  const stderr = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  try {
    const result = await gatherTargetContext({
      projectRoot: tmpRoot,
      projectId: "rks-prune-report-fixture",
      normalizedProblem: null,
      normalizedTask: taskText,
      context: {},
      finalSlug: "prune-report-fixture",
    });
    return { result, stderr };
  } finally {
    spy.mockRestore();
  }
}

describe("plan-path prune is observable (T1, T2, T4)", () => {
  it("T1 RED: gatherTargetContext returns a pruneReport with the four loss counters", async () => {
    const body = overThresholdBody();
    expect(body.length).toBeGreaterThan(PLAN_NOTE_PRUNE_THRESHOLD_BYTES);

    const { result } = await runGather(body);

    expect(result.pruneReport).toBeDefined();
    expect(typeof result.pruneReport).toBe("object");
    expect(result.pruneReport.linesShed).toBeGreaterThan(0);
    expect(result.pruneReport.fencesShed).toBe(2);
    expect(result.pruneReport.createDirectivesShed).toBe(0);
    expect(result.pruneReport.anchorsShed).toBe(0);
  });

  it("T2 RED: a stderr line names the non-zero counters when the plan-path prune sheds content", async () => {
    const { stderr } = await runGather(overThresholdBody());
    expect(stderr.filter((l) => l.includes("linesShed")).length).toBeGreaterThan(0);
  });

  it("T4 PIN: an under-threshold body emits no prune line and is passed through untouched", async () => {
    const small = "## Problem\n\nshort body\n\n## Acceptance Criteria\n\n- [ ] x\n";
    expect(small.length).toBeLessThan(PLAN_NOTE_PRUNE_THRESHOLD_BYTES);

    const { result, stderr } = await runGather(small);

    expect(result.planningText).toBe(small);
    expect(stderr.filter((l) => l.includes("linesShed"))).toHaveLength(0);
  });
});

describe("the prune's context-budget purpose is preserved (T5, T6, T7)", () => {
  it("T5 PIN: PLAN_NOTE_PRUNE_THRESHOLD_BYTES is still exactly 5120", () => {
    expect(PLAN_NOTE_PRUNE_THRESHOLD_BYTES).toBe(5120);
  });

  it("T6 PIN: the one-argument call still returns a string and still strips the Target snapshot", () => {
    const pruned = pruneRefineBlocks(overThresholdBody());

    expect(typeof pruned).toBe("string");
    expect(pruned).not.toContain(SNAPSHOT_MARKER);
    expect(pruned).not.toContain("### Target: src/a.mjs");
    expect(pruned).toContain("### src/a.mjs");
    expect(extractSearchReplaceBlocks(pruned, "src/a.mjs")).toHaveLength(1);
  });

  it("T7 PIN: the LLM prompt text gatherTargetContext builds still derives from the PRUNED body", async () => {
    const { result } = await runGather(overThresholdBody());

    expect(result.planningText).not.toContain(SNAPSHOT_MARKER);
    expect(result.planningSource).not.toContain(SNAPSHOT_MARKER);
    expect(result.planningText).toContain(S);
  });
});

describe("create-side / edit-side body provenance (T3, T8, T9)", () => {
  it("T8 PIN: the pruned copy MISATTRIBUTES an anchor group nested in a ### Target: zone", () => {
    const raw = misattributionBody();
    expect(raw.length).toBeGreaterThan(PLAN_NOTE_PRUNE_THRESHOLD_BYTES);
    const pruned = pruneRefineBlocks(raw);

    // RAW: `### Target: src/a.mjs` yields headerPath "Target: src/a.mjs", which matches no
    // target, so it acts as an attribution BARRIER.
    expect(extractSearchReplaceBlocks(raw, "src/b.mjs")).toHaveLength(1);
    expect(extractSearchReplaceBlocks(raw, "src/a.mjs")).toHaveLength(0);

    // PRUNED: the barrier line is deleted while the anchor group survives, so the group
    // inherits src/b.mjs's heading.
    const prunedB = extractSearchReplaceBlocks(pruned, "src/b.mjs");
    expect(prunedB).toHaveLength(2);
    expect(prunedB.map((b) => b.search)).toContain("const a = 1;");
    expect(extractSearchReplaceBlocks(pruned, "src/a.mjs")).toHaveLength(0);
  });

  it("T9 PIN: a correctly-authored over-threshold note still early-exits on the RAW body", () => {
    const raw = coveredBody();
    expect(raw.length).toBeGreaterThan(PLAN_NOTE_PRUNE_THRESHOLD_BYTES);

    const { allCovered, steps } = computeEarlyExitCoverage(raw, ["src/a.mjs", "src/b.mjs"]);

    expect(allCovered).toBe(true);
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.action === "search_replace")).toBe(true);
    expect(shouldEarlyExitToSteps(allCovered, steps.length, 0)).toBe(true);
  });

  it("T3 RED: the early-exit gate is handed the un-pruned story body, like buildNoteDrivenSteps", () => {
    // Durable-phrase toContain, not a fixed source-window slice.
    const src = fs.readFileSync(PLANNER_SRC, "utf8");

    // The precedent 66 lines above the defect.
    expect(src).toContain("buildNoteDrivenSteps(problemNote?.content || planningText");
    // The fix. The `= ` prefix scopes this to the CALL, not the function declaration.
    expect(src).toContain("= computeEarlyExitCoverage(problemNote?.content || planningText");
    expect(src).not.toContain("= computeEarlyExitCoverage(planningText");

    // The rationale comment block four other assertions read must survive the edit.
    expect(src).toContain("All-or-nothing gate");
    expect(src).toContain("split execution model");
    expect(src).toContain("design.arch-planner-refactor.md");
  });
});
