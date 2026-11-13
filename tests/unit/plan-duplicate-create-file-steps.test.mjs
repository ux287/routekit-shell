import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPlan } from "../../packages/mcp-rks/src/server/plan-quality.mjs";
import {
  dedupeCreateFileSteps,
  findDuplicateCreateFileSteps,
  classifySteps,
  computeDroppedSteps,
} from "../../packages/mcp-rks/src/server/planner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_SRC = path.resolve(__dirname, "../../packages/mcp-rks/src/server/planner.mjs");

// Empty temp projectRoot so create_file_already_exists never fires.
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-dup-create-"));

const STORY_COPY = { id: "create-1", action: "create_file", path: "src/a.mjs", content: "export const a = 1;\n" };
const REVIEWER_COPY = { id: "step-001", action: "create_file", path: "src/a.mjs", content: "export const a = 1;", _source: "create_file_block" };

const dupErrors = (r) => r.errors.filter((e) => e.check === "duplicate_create_file_path");

describe("reviewPlan -- duplicate_create_file_path", () => {
  it("errors without targetFiles (exec recheck call shape)", async () => {
    const r = await reviewPlan({ projectRoot, plan: { steps: [STORY_COPY, REVIEWER_COPY] } });
    expect(r.ok).toBe(false);
    const errs = dupErrors(r);
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("error");
  });

  it("errors with targetFiles declaring the path op create", async () => {
    const r = await reviewPlan({
      projectRoot,
      plan: { steps: [STORY_COPY, REVIEWER_COPY] },
      targetFiles: [{ path: "src/a.mjs", op: "create" }],
    });
    expect(r.ok).toBe(false);
    expect(dupErrors(r)).toHaveLength(1);
  });

  it("names the duplicated path and every sharing step id", async () => {
    const r = await reviewPlan({ projectRoot, plan: { steps: [STORY_COPY, REVIEWER_COPY] } });
    const text = JSON.stringify(dupErrors(r)[0]);
    expect(text).toContain("src/a.mjs");
    expect(text).toContain("create-1");
    expect(text).toContain("step-001");
  });

  it("treats ./src/a.mjs and src/a.mjs as the same path", async () => {
    const r = await reviewPlan({
      projectRoot,
      plan: { steps: [STORY_COPY, { ...REVIEWER_COPY, path: "./src/a.mjs" }] },
    });
    expect(r.ok).toBe(false);
    expect(dupErrors(r)).toHaveLength(1);
  });

  it("does not fire for one create_file per distinct path", async () => {
    const r = await reviewPlan({
      projectRoot,
      plan: { steps: [STORY_COPY, { ...REVIEWER_COPY, id: "step-002", path: "src/b.mjs" }] },
    });
    expect(dupErrors(r)).toHaveLength(0);
  });

  it("does not fire for create_file plus search_replace on the same path", async () => {
    const r = await reviewPlan({
      projectRoot,
      plan: {
        steps: [
          STORY_COPY,
          { id: "step-002", action: "search_replace", path: "src/a.mjs", search: "export const a = 1;", replace: "export const a = 2;" },
        ],
      },
    });
    expect(dupErrors(r)).toHaveLength(0);
  });
});

describe("dedupeCreateFileSteps -- planner collapse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps exactly one create_file per path, the first (story-block) copy", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = dedupeCreateFileSteps([STORY_COPY, REVIEWER_COPY]);
    const creates = out.filter((s) => s.action === "create_file");
    expect(creates).toHaveLength(1);
    expect(creates[0].id).toBe("create-1");
    expect(creates[0].content).toBe("export const a = 1;\n");
  });

  it("treats normalized-equal paths as the same path", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = dedupeCreateFileSteps([STORY_COPY, { ...REVIEWER_COPY, path: "./src/a.mjs" }]);
    expect(out.filter((s) => s.action === "create_file")).toHaveLength(1);
    expect(out[0].id).toBe("create-1");
  });

  it("leaves non-create_file steps in order and keeps distinct-path creates", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sr = { id: "step-010", action: "search_replace", path: "src/x.mjs", search: "a", replace: "b" };
    const rc = { id: "step-011", action: "run_command", command: "npm test" };
    const note = { id: "step-012", action: "note", title: "n" };
    const other = { id: "create-2", action: "create_file", path: "src/b.mjs", content: "b\n" };
    const out = dedupeCreateFileSteps([sr, STORY_COPY, rc, other, REVIEWER_COPY, note]);
    expect(out.map((s) => s.id)).toEqual(["step-010", "create-1", "step-011", "create-2", "step-012"]);
  });

  it("logs each discarded step id and path with the [rks.plan] prefix", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    dedupeCreateFileSteps([STORY_COPY, REVIEWER_COPY]);
    const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[rks.plan]");
    expect(logged).toContain("step-001");
    expect(logged).toContain("src/a.mjs");
  });

});

describe("findDuplicateCreateFileSteps -- collapse report", () => {
  it("reports path, kept id and discarded ids for a story-block + reviewer pair", () => {
    expect(findDuplicateCreateFileSteps([STORY_COPY, REVIEWER_COPY])).toEqual([
      { path: "src/a.mjs", keptId: "create-1", discardedIds: ["step-001"] },
    ]);
  });

  it("normalizes ./src/a.mjs to src/a.mjs", () => {
    expect(findDuplicateCreateFileSteps([STORY_COPY, { ...REVIEWER_COPY, path: "./src/a.mjs" }])).toEqual([
      { path: "src/a.mjs", keptId: "create-1", discardedIds: ["step-001"] },
    ]);
  });

  it("returns [] for distinct paths and for create_file plus search_replace on one path", () => {
    expect(findDuplicateCreateFileSteps([STORY_COPY, { ...REVIEWER_COPY, id: "step-002", path: "src/b.mjs" }])).toEqual([]);
    expect(
      findDuplicateCreateFileSteps([
        STORY_COPY,
        { id: "step-002", action: "search_replace", path: "src/a.mjs", edits: [{ search: "1", replace: "2" }] },
      ]),
    ).toEqual([]);
  });
});

describe("discarded duplicate is not dropped work (ARCH Item 2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("one deduped array fed to classifySteps AND computeDroppedSteps yields no dropped step", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deduped = dedupeCreateFileSteps([STORY_COPY, REVIEWER_COPY]);
    const classified = classifySteps({ rawSteps: deduped, allowedTargets: null, projectRoot });
    expect(classified.executable).toEqual([STORY_COPY]);
    expect(computeDroppedSteps({ rawSteps: deduped, classified })).toEqual([]);
  });

  it("positive control: the raw array fed to computeDroppedSteps DOES report the discarded duplicate", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = [STORY_COPY, REVIEWER_COPY];
    const classified = classifySteps({ rawSteps: dedupeCreateFileSteps(raw), allowedTargets: null, projectRoot });
    const dropped = computeDroppedSteps({ rawSteps: raw, classified });
    // describeStep carries label/path/title/action/reason, not the step id -- assert on path + action.
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ path: "src/a.mjs", action: "create_file" });
  });
});

describe("runPlanTool wiring (full-source toMatch, no fixed-size window slice)", () => {
  const src = fs.readFileSync(PLANNER_SRC, "utf8");

  it("applies both helpers to rawCombined inside runPlanTool", () => {
    expect(src).toMatch(/findDuplicateCreateFileSteps\(\s*rawCombined\s*\)/);
    expect(src).toMatch(/dedupeCreateFileSteps\(\s*rawCombined\s*\)/);
  });

  it("feeds dedupedCombined to classifySteps and computeDroppedSteps, never rawCombined", () => {
    expect(src).toMatch(/classifySteps\(\{\s*rawSteps:\s*dedupedCombined\s*,/);
    expect(src).toMatch(/computeDroppedSteps\(\{\s*rawSteps:\s*dedupedCombined\s*,\s*classified\s*\}\)/);
    expect(src).not.toMatch(/rawSteps:\s*rawCombined/);
  });

  it("surfaces collapsedDuplicateCreates on the plan object and on planResult only when non-empty", () => {
    expect(src).toMatch(
      /steps:\s*finalSteps,\s*\.\.\.\(\s*collapsedDuplicateCreates\.length\s*\?\s*\{\s*collapsedDuplicateCreates\s*\}\s*:\s*\{\s*\}\s*\)/,
    );
    expect(src).toMatch(
      /if\s*\(\s*collapsedDuplicateCreates\.length\s*\)\s*planResult\.collapsedDuplicateCreates\s*=\s*collapsedDuplicateCreates;\s*return planResult;/,
    );
  });
});
