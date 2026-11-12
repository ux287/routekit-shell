// Planner early-exit, LLM path and fix-plan handling of requirementCoverage. No subprocess;
// the LLM is mocked following tests/unit/fix-planner.test.mjs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LLM = vi.hoisted(() => ({ calls: [], response: null }));

vi.mock("../../packages/mcp-rks/src/llm/planner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runLlmPlanner: vi.fn(async (args) => {
      LLM.calls.push(args);
      return typeof LLM.response === "function" ? LLM.response(args) : LLM.response;
    }),
  };
});

const { buildPrompt, parsePlannerJson } = await import("../../packages/mcp-rks/src/llm/planner.mjs");
const { processLlmResult, orchestrateLlmPlanning } = await import("../../packages/mcp-rks/src/server/planner-llm.mjs");
const { shouldEarlyExitToSteps, decideEarlyExit, readStoryRequirementCoverage, selectPlanRequirementCoverage } = await import("../../packages/mcp-rks/src/server/planner.mjs");
const { persistRunFiles } = await import("../../packages/mcp-rks/src/server/planner-persistence.mjs");
const { loadPlan } = await import("../../packages/mcp-rks/src/server/plan-loader.mjs");
const { generateFixPlan } = await import("../../packages/mcp-rks/src/server/fix-planner.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLANNER_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"), "utf8");
const EXEC_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const REQS = ["does x", "[process] Every pre-existing test passes", "does y"];
const COMPLETE = [
  { index: 0, testFile: "tests/unit/a.test.mjs", path: "suite > does x" },
  { index: 2, testFile: "tests/unit/a.test.mjs", path: "suite > does y" },
  { index: 2, testFile: "tests/unit/b.test.mjs", path: "does y again" },
];

let tmp;
beforeEach(() => {
  LLM.calls.length = 0;
  LLM.response = null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-plan-reqcov-"));
});
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe("early-exit decision", () => {
  const covered = { allCovered: true, earlyExitStepCount: 2, uncoveredCreateCount: 0 };

  it("refused without a complete story map; allowed with one (AC6)", () => {
    expect(decideEarlyExit({ ...covered, testRequirements: REQS, requirementCoverage: null })).toEqual({ earlyExit: false, requirementCoverage: null, refusedReason: "requirement_coverage_incomplete" });
    // Incomplete: a non-process index with no entry.
    expect(decideEarlyExit({ ...covered, testRequirements: REQS, requirementCoverage: [COMPLETE[0]] }).earlyExit).toBe(false);
    // Incomplete: an entry with an empty testFile or path does not count.
    expect(decideEarlyExit({ ...covered, testRequirements: REQS, requirementCoverage: [COMPLETE[0], { index: 2, testFile: "", path: "suite > does y" }] }).earlyExit).toBe(false);
    expect(decideEarlyExit({ ...covered, testRequirements: REQS, requirementCoverage: [COMPLETE[0], { index: 2, testFile: "tests/unit/a.test.mjs", path: "" }] }).earlyExit).toBe(false);
    // Complete: process index 1 needs no entry, index 2 appears twice.
    const allowed = decideEarlyExit({ ...covered, testRequirements: REQS, requirementCoverage: COMPLETE });
    expect(allowed.earlyExit).toBe(true);
    expect(allowed.refusedReason).toBeNull();
    // A complete map never overrides the base decision.
    expect(decideEarlyExit({ ...covered, allCovered: false, testRequirements: REQS, requirementCoverage: COMPLETE }).earlyExit).toBe(false);
    expect(decideEarlyExit({ ...covered, uncoveredCreateCount: 1, testRequirements: REQS, requirementCoverage: COMPLETE }).earlyExit).toBe(false);
  });

  it("unchanged for empty or absent testRequirements; early plan copies the story map (AC6)", () => {
    const cases = [];
    for (const allCovered of [true, false, 1, 0, undefined]) {
      for (const steps of [0, 1, 2]) {
        for (const creates of [0, 1, 3]) cases.push([allCovered, steps, creates]);
      }
    }
    for (const [allCovered, steps, creates] of cases) {
      const today = shouldEarlyExitToSteps(allCovered, steps, creates);
      for (const testRequirements of [undefined, null, []]) {
        const d = decideEarlyExit({ allCovered, earlyExitStepCount: steps, uncoveredCreateCount: creates, testRequirements, requirementCoverage: testRequirements === null ? COMPLETE : null });
        expect(d.earlyExit, JSON.stringify([allCovered, steps, creates, testRequirements])).toBe(today);
        expect(d.refusedReason).toBeNull();
      }
    }
    // The existing pinned cases from planner-drops-create-file-steps, verbatim.
    expect(decideEarlyExit({ allCovered: true, earlyExitStepCount: 2, uncoveredCreateCount: 0 }).earlyExit).toBe(true);
    expect(decideEarlyExit({ allCovered: true, earlyExitStepCount: 1, uncoveredCreateCount: 3 }).earlyExit).toBe(false);
    expect(decideEarlyExit({ allCovered: false, earlyExitStepCount: 1, uncoveredCreateCount: 0 }).earlyExit).toBe(false);
    expect(decideEarlyExit({ allCovered: true, earlyExitStepCount: 0, uncoveredCreateCount: 0 }).earlyExit).toBe(false);

    // With a complete story map the decision hands back that map, and the early plan copies it.
    const note = `---\nid: "s"\ntestRequirements:\n  - "does x"\n  - "[process] Every pre-existing test passes"\n  - "does y"\nrequirementCoverage:\n  - index: 0\n    testFile: "tests/unit/a.test.mjs"\n    path: "suite > does x"\n  - index: 2\n    testFile: "tests/unit/a.test.mjs"\n    path: "suite > does y"\n  - index: 2\n    testFile: "tests/unit/b.test.mjs"\n    path: "does y again"\n---\n\nbody\n`;
    const story = readStoryRequirementCoverage(note);
    expect(story.testRequirements).toEqual(REQS);
    expect(story.requirementCoverage).toEqual(COMPLETE);
    const d = decideEarlyExit({ allCovered: true, earlyExitStepCount: 2, uncoveredCreateCount: 0, ...story });
    expect(d.earlyExit).toBe(true);
    expect(d.requirementCoverage).toEqual(COMPLETE);
    // The early plan literal spreads exactly that map, and the call site uses the decision.
    expect(PLANNER_SRC).toContain("...(Array.isArray(earlyExitDecision.requirementCoverage) ? { requirementCoverage: earlyExitDecision.requirementCoverage } : {}),");
    expect(PLANNER_SRC).toContain("if (earlyExitDecision.earlyExit) {");
    expect(PLANNER_SRC).toContain("testRequirements: storyRequirementInputs.testRequirements,");
    expect(readStoryRequirementCoverage(null)).toEqual({ testRequirements: null, requirementCoverage: null });
  });
});

describe("LLM path", () => {
  it("buildPrompt carries indexed testRequirements and the requirementCoverage instruction (AC7)", () => {
    const withReqs = buildPrompt({ requirements: "r", fullRequirements: "r", context: "c", testRequirements: REQS });
    for (const [i, text] of REQS.entries()) expect(withReqs).toContain(`- [${i}] ${text}`);
    expect(withReqs).toContain('"requirementCoverage"');
    expect(withReqs).toMatch(/beside "steps"/);
    for (const without of [buildPrompt({ requirements: "r", fullRequirements: "r", context: "c" }), buildPrompt({ requirements: "r", context: "c", testRequirements: [] })]) {
      expect(without).not.toContain("requirementCoverage");
    }
  });

  it("parsePlannerJson and processLlmResult keep requirementCoverage; plan.json persists it (AC7)", async () => {
    const map = [{ index: 0, testFile: "tests/unit/a.test.mjs", path: "suite > does x" }, { index: 2, testFile: "tests/unit/a.test.mjs", path: "suite > does y" }];
    const raw = JSON.stringify({ planSummary: "s", steps: [{ action: "create_file", path: "tests/unit/a.test.mjs", content: "x" }], requirementCoverage: map });
    expect(parsePlannerJson(raw).requirementCoverage).toEqual(map);
    expect(parsePlannerJson("```json\n" + raw + "\n```").requirementCoverage).toEqual(map);
    const processed = processLlmResult({ status: "executable", actions: [{ action: "create_file", path: "p", content: "x" }], requirementCoverage: map });
    expect(processed.requirementCoverage).toEqual(map);
    expect(processed.requirementCoverage).toBe(map);
    expect(processLlmResult({ status: "executable", actions: [] })).not.toHaveProperty("requirementCoverage");

    // A mocked LLM planner response travels through orchestrateLlmPlanning to plan.json.
    LLM.response = { status: "executable", prompt: "p", raw, actions: [{ action: "create_file", path: "tests/unit/a.test.mjs", content: "x", title: "t" }], requirementCoverage: map };
    const runFolder = path.join(tmp, ".rks", "runs", "2026-11-01T00-00-00-000Z_story-x");
    fs.mkdirSync(runFolder, { recursive: true });
    const orch = await orchestrateLlmPlanning({
      planningText: "Plain story text with no edit blocks.",
      planningSource: "Plain story text with no edit blocks.",
      requirementSummary: "s",
      enhancedEditableTargets: [],
      contextualRefs: [],
      frontmatterTargets: [],
      plannerMode: "full",
      runFolder,
      projectRoot: tmp,
      slug: "story-x",
      projectId: "p",
      uncoveredCreatePaths: [],
      testRequirements: REQS,
    });
    expect(LLM.calls).toHaveLength(1);
    expect(LLM.calls[0].testRequirements).toEqual(REQS);
    expect(orch.requirementCoverage).toEqual(map);
    const selected = selectPlanRequirementCoverage({ testRequirements: REQS, storyRequirementCoverage: null, llmRequirementCoverage: orch.requirementCoverage });
    expect(selected).toEqual(map);
    // The plan object carries it exactly as planner.mjs builds it, and persistence writes the whole object.
    expect(PLANNER_SRC).toContain("llmRequirementCoverage: llmOrchResult.requirementCoverage,");
    expect(PLANNER_SRC).toContain("...(planRequirementCoverage ? { requirementCoverage: planRequirementCoverage } : {}),");
    const plan = { projectId: "p", problemId: "story-x", slug: "story-x", status: "executable", steps: orch.llmActions, ...(selected ? { requirementCoverage: selected } : {}) };
    persistRunFiles({ runFolder, plan, problemYaml: {}, planYaml: {}, slug: "story-x" });
    const onDisk = JSON.parse(fs.readFileSync(path.join(runFolder, "plan.json"), "utf8"));
    expect(onDisk.requirementCoverage).toEqual(LLM.response.requirementCoverage);
    // exec loads plans through plan-loader, which hands back the key unchanged.
    expect(loadPlan(tmp, "story-x").plan.requirementCoverage).toEqual(map);

    // A complete story-authored map wins over the LLM map; with none, the LLM map is used.
    expect(selectPlanRequirementCoverage({ testRequirements: REQS, storyRequirementCoverage: COMPLETE, llmRequirementCoverage: map })).toEqual(COMPLETE);
    expect(selectPlanRequirementCoverage({ testRequirements: REQS, storyRequirementCoverage: [COMPLETE[0]], llmRequirementCoverage: map })).toEqual(map);
    expect(selectPlanRequirementCoverage({ testRequirements: null, storyRequirementCoverage: null, llmRequirementCoverage: null })).toBeNull();
  });

  it("generateFixPlan prompt includes the map; a fix plan cannot replace it (AC7)", async () => {
    const originalMap = [{ index: 0, testFile: "tests/unit/orig.test.mjs", path: "orig suite > keeps name" }, { index: 2, testFile: "tests/unit/other.test.mjs", path: "other > case" }];
    const originalPlan = { problemId: "backlog.fix.x", planSummary: "demo", requirementCoverage: originalMap, steps: [] };
    const snapshot = JSON.parse(JSON.stringify(originalPlan));
    LLM.response = { steps: [{ action: "note" }], planSummary: "fix", requirementCoverage: [{ index: 0, testFile: "tests/unit/renamed.test.mjs", path: "renamed" }] };
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir, { recursive: true });
    const fixPlan = await generateFixPlan({ projectRoot: tmp, runDir, originalPlan, appliedFiles: [], testOutput: "FAIL x", attemptNumber: 1 });
    expect(LLM.calls).toHaveLength(1);
    const prompt = LLM.calls[0].requirements;
    for (const e of originalMap) {
      expect(prompt).toContain(e.testFile);
      expect(prompt).toContain(e.path);
    }
    // The fix plan's own map is dropped, and the original plan (the gate's input) is untouched.
    expect(fixPlan).not.toHaveProperty("requirementCoverage");
    expect(originalPlan).toEqual(snapshot);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "plan-fix-1.json"), "utf8"))).not.toHaveProperty("requirementCoverage");
    // exec's gate reads plan.requirementCoverage, and exec never reassigns plan from a fix plan.
    expect(EXEC_SRC).toContain("requirementCoverage: plan.requirementCoverage,");
    expect(EXEC_SRC).not.toMatch(/\bplan\.requirementCoverage\s*=/);
    expect(EXEC_SRC).not.toMatch(/\bplan\s*=\s*fixPlan\b/);
    // Without a map, the prompt has no coverage section.
    LLM.calls.length = 0;
    await generateFixPlan({ projectRoot: tmp, runDir, originalPlan: { problemId: "p", planSummary: "s" }, appliedFiles: [], testOutput: "x", attemptNumber: 1 });
    expect(LLM.calls[0].requirements).not.toContain("Requirement Coverage Map");
  });
});
