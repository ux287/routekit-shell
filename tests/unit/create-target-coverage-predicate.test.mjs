/**
 * Regression witness - backlog.fix.create-target-coverage-predicate-diverges
 *
 * plan-ready decided create-target coverage SUFFIX-TOLERANTLY (plan-ready.mjs:236
 * and :253) while planner.mjs subtracted with EXACT Set membership at four
 * coverage sites (planner.mjs:519, :1086, :1211-1212, :1720). A story whose body
 * fence path differs in PREFIX from its frontmatter path therefore PASSED
 * runPlanReadyTool and then FAILED rks_plan with failureClass "structural" and
 * refinable false - an unrefinable dead end reached only after a full LLM pass.
 *
 * All coordinates measured with rks_exhaustive_search at git anchor @b217380ab.
 *
 * Seams used here:
 *   runPlanReadyTool      exported at plan-ready.mjs:121; driven on a temp root.
 *   buildExhaustedPayload exported at planner.mjs:503 and CONTAINS the :519
 *                         coverage subtraction, so the planner half of the
 *                         divergence is behaviourally drivable. The other three
 *                         sites are inline in the LLM-driven runPlanTool and are
 *                         pinned at source level instead.
 *   runRefineTool         exported at refine.mjs:330; driven on a temp root.
 *
 * Literal safety: this file never writes a bare triple-backtick or a bare
 * create-file directive token, because the story note that authors it embeds
 * this source inside a markdown fence and either would be re-parsed as story
 * grammar. TICK/FENCE/CF below exist for that reason.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";
import { runRefineTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

const PLANNER_SRC = read("packages/mcp-rks/src/server/planner.mjs");
const PLAN_READY_SRC = read("packages/mcp-rks/src/server/plan-ready.mjs");
const REFINE_SRC = read("packages/mcp-rks/src/server/refine.mjs");
const DEGEN_SRC = read("tests/unit/planner-structural-degeneracy-real.test.mjs");

const TICK = "`";
const FENCE = TICK + TICK + TICK;
const CF = "// CREATE" + " FILE:";

const REAL_BODY = [
  "export function widget(input) {",
  "  const trimmed = String(input || '').trim();",
  "  if (!trimmed) return null;",
  "  return { value: trimmed, length: trimmed.length };",
  "}",
].join("\n");

const PLACEHOLDER_BODY = "// TODO: implement";

let predicate;
let buildExhaustedPayload;

beforeAll(async () => {
  predicate = await import(
    "../../packages/mcp-rks/src/shared/create-target-path-match.mjs"
  );
  ({ buildExhaustedPayload } = await import(
    "../../packages/mcp-rks/src/server/planner.mjs"
  ));
});

function newProject() {
  const root = makeTempDir("create_target_coverage_predicate");
  ensureDir(path.join(root, "notes"));
  ensureDir(path.join(root, ".rks"));
  writeFile(
    path.join(root, ".rks", "project.json"),
    JSON.stringify({ projectId: "test-project" }, null, 2),
  );
  return root;
}

/**
 * One op:create target in frontmatter; the body optionally carries a create
 * directive and a fenced block under a path heading.
 */
function storyNote({ id, fmPath, bodyPath, directive = true, body = REAL_BODY }) {
  const p = bodyPath || fmPath;
  const lines = [
    "---",
    'id: "' + id + '"',
    'title: "Fixture ' + id + '"',
    'desc: "Fixture story exercising create-target coverage matching"',
    'status: "not-implemented"',
    'phase: "ready"',
    'testFile: "tests/unit/fixture.test.mjs"',
    "targetFiles:",
    '  - path: "' + fmPath + '"',
    '    op: "create"',
    '    desc: "New module authored in the story body"',
    "---",
    "",
    "## Problem",
    "",
    "A fixture story used to exercise create-target coverage matching.",
    "",
    "## Solution",
    "",
    "Author the new module from the body block.",
    "",
    "## Target Files",
    "",
    "### " + p,
    "",
  ];
  if (directive) lines.push(CF + " " + p, "");
  if (body !== null) lines.push(FENCE + "js", body, FENCE, "");
  lines.push(
    "## Acceptance Criteria",
    "",
    "- [ ] " + fmPath + " exists and exports widget",
    "- [ ] widget() returns null for empty input",
    "- [ ] widget() fails gracefully when input is missing",
    "",
    "## Testing Requirements",
    "",
    "- Test that widget() returns null when input is empty",
    "- Test that widget() fails gracefully when input is undefined",
    "",
  );
  return lines.join("\n");
}

function twoCreateStory(id) {
  return [
    "---",
    'id: "' + id + '"',
    'title: "Fixture two create targets"',
    'desc: "Fixture story with two op:create targets"',
    'status: "not-implemented"',
    'phase: "draft"',
    'testFile: "tests/unit/fixture.test.mjs"',
    "targetFiles:",
    '  - path: "src/gen/alpha.js"',
    '    op: "create"',
    '    desc: "First new module"',
    '  - path: "src/gen/beta.js"',
    '    op: "create"',
    '    desc: "Second new module"',
    "---",
    "",
    "## Problem",
    "",
    "A fixture story with two create targets.",
    "",
    "## Solution",
    "",
    "Author both modules from the body blocks.",
    "",
    "## Target Files",
    "",
    "### src/gen/alpha.js",
    "",
    CF + " src/gen/alpha.js",
    "",
    FENCE + "js",
    REAL_BODY,
    FENCE,
    "",
    "### src/gen/beta.js",
    "",
    CF + " src/gen/beta.js",
    "",
    FENCE + "js",
    REAL_BODY,
    FENCE,
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] src/gen/alpha.js exists and exports widget",
    "- [ ] src/gen/beta.js exists and exports widget",
    "",
    "## Testing Requirements",
    "",
    "- Test that widget() returns null when input is empty",
    "- Test that widget() fails gracefully when input is undefined",
    "",
  ].join("\n");
}

async function planReady(spec) {
  const root = newProject();
  writeFile(path.join(root, "notes", spec.id + ".md"), storyNote(spec));
  return runPlanReadyTool({
    projectId: "test-project",
    problemId: spec.id,
    projectRoot: root,
  });
}

const blockIssues = (res) =>
  (res.issues || []).filter((i) => i.check === "create_target_no_authorable_block");

describe("shared create-target path predicate", () => {
  it("exports createTargetPathsMatch and findMatchingCreateTargetPath", () => {
    expect(typeof predicate.createTargetPathsMatch).toBe("function");
    expect(typeof predicate.findMatchingCreateTargetPath).toBe("function");
  });

  it("matches identical paths and normalises a leading dot-slash", () => {
    const { createTargetPathsMatch } = predicate;
    expect(createTargetPathsMatch("src/a.js", "src/a.js")).toBe(true);
    expect(createTargetPathsMatch("./src/a.js", "src/a.js")).toBe(true);
    expect(createTargetPathsMatch("src/a.js", "./src/a.js")).toBe(true);
  });

  it("PRESERVES the segment-aligned prefix-truncation shape real stories use", () => {
    const { createTargetPathsMatch } = predicate;
    const full = "packages/mcp-rks/src/shared/x.mjs";
    expect(createTargetPathsMatch(full, "src/shared/x.mjs")).toBe(true);
    expect(createTargetPathsMatch("src/shared/x.mjs", full)).toBe(true);
    expect(createTargetPathsMatch(full, "x.mjs")).toBe(true);
  });

  it("REJECTS a mid-segment suffix and rejects empty or null input", () => {
    const { createTargetPathsMatch } = predicate;
    expect(createTargetPathsMatch("foo/bar.py", "oo/bar.py")).toBe(false);
    expect(createTargetPathsMatch("oo/bar.py", "foo/bar.py")).toBe(false);
    expect(createTargetPathsMatch("src/helper.js", "elper.js")).toBe(false);
    expect(createTargetPathsMatch("", "src/a.js")).toBe(false);
    expect(createTargetPathsMatch("src/a.js", null)).toBe(false);
  });

  it("findMatchingCreateTargetPath returns the candidate, or undefined", () => {
    const { findMatchingCreateTargetPath } = predicate;
    const keys = ["lib/z.js", "src/shared/x.mjs"];
    expect(findMatchingCreateTargetPath(keys, "shared/x.mjs")).toBe("src/shared/x.mjs");
    expect(
      findMatchingCreateTargetPath(new Map([["src/shared/x.mjs", "c"]]).keys(), "x.mjs"),
    ).toBe("src/shared/x.mjs");
    expect(findMatchingCreateTargetPath(keys, "q.js")).toBeUndefined();
    expect(findMatchingCreateTargetPath([], "q.js")).toBeUndefined();
  });
});

describe("plan-ready create-target binding", () => {
  it("PIN - still binds a segment-aligned prefix divergence", async () => {
    const res = await planReady({
      id: "backlog.fixture-prefix-divergence",
      fmPath: "packages/app/src/gen/widget.js",
      bodyPath: "src/gen/widget.js",
    });
    expect(blockIssues(res)).toHaveLength(0);
  });

  it("STOPS binding a mid-segment suffix - the tightening this story introduces", async () => {
    const res = await planReady({
      id: "backlog.fixture-midsegment-suffix",
      fmPath: "packages/app/src/gen/helper.js",
      bodyPath: "elper.js",
    });
    expect(blockIssues(res)).toHaveLength(1);
    expect(res.ready).toBe(false);
  });

  it("REGRESSION GUARD - a create directive with NO fenced block is still refused", async () => {
    const res = await planReady({
      id: "backlog.fixture-directive-no-fence",
      fmPath: "src/gen/nofence.js",
      body: null,
    });
    expect(blockIssues(res)).toHaveLength(1);
    expect(res.ready).toBe(false);
  });

  it("REGRESSION GUARD - a placeholder-only fenced block is still refused", async () => {
    const res = await planReady({
      id: "backlog.fixture-placeholder-only",
      fmPath: "src/gen/placeholder.js",
      body: PLACEHOLDER_BODY,
    });
    expect(blockIssues(res)).toHaveLength(1);
    expect(res.ready).toBe(false);
  });
});

describe("file_will_be_created suggestion is evidence-bound", () => {
  const warnOf = (res) =>
    (res.warnings || []).filter((w) => w.check === "file_will_be_created")[0];

  it("names frontmatter when only a frontmatter op:create satisfied hasDirective", async () => {
    const res = await planReady({
      id: "backlog.fixture-fm-only",
      fmPath: "src/gen/same.js",
      directive: false,
    });
    const w = warnOf(res);
    expect(w).toBeDefined();
    expect(w.suggestion).toMatch(/frontmatter/i);
  });

  it("emits a DIFFERENT suggestion for a body directive than for frontmatter alone", async () => {
    const fmOnly = warnOf(
      await planReady({
        id: "backlog.fixture-fm-only-b",
        fmPath: "src/gen/same.js",
        directive: false,
      }),
    );
    const withDirective = warnOf(
      await planReady({
        id: "backlog.fixture-body-directive",
        fmPath: "src/gen/same.js",
        directive: true,
      }),
    );
    expect(fmOnly).toBeDefined();
    expect(withDirective).toBeDefined();
    expect(fmOnly.suggestion).toBeTruthy();
    expect(withDirective.suggestion).toBeTruthy();
    expect(fmOnly.suggestion).not.toBe(withDirective.suggestion);
  });
});

describe("planner create-coverage subtraction (buildExhaustedPayload, planner.mjs:519)", () => {
  it("covers a segment-aligned prefix divergence - no structural failure", () => {
    const { structural } = buildExhaustedPayload({
      combinedSteps: [
        { action: "create_file", path: "src/gen/widget.js", content: REAL_BODY },
      ],
      frontmatterCreateFiles: ["packages/app/src/gen/widget.js"],
    });
    expect(structural).toBeNull();
  });

  it("PIN - an exactly-matching create_file step still covers its target", () => {
    const { structural } = buildExhaustedPayload({
      combinedSteps: [
        { action: "create_file", path: "src/gen/widget.js", content: REAL_BODY },
      ],
      frontmatterCreateFiles: ["src/gen/widget.js"],
    });
    expect(structural).toBeNull();
  });

  it("PIN - a genuinely uncovered create still yields structural, refinable false", () => {
    const { structural } = buildExhaustedPayload({
      combinedSteps: [],
      frontmatterCreateFiles: ["src/gen/never-authored.js"],
    });
    expect(structural).not.toBeNull();
    expect(structural.failureClass).toBe("structural");
    expect(structural.refinable).toBe(false);
    expect(structural.uncoveredCreateTargets).toContain("src/gen/never-authored.js");
  });
});

describe("both consumers adopt the one shared predicate", () => {
  it("plan-ready.mjs imports the shared predicate module", () => {
    expect(PLAN_READY_SRC).toContain("create-target-path-match.mjs");
  });

  it("no bare endsWith path comparison remains in the plan-ready create block", () => {
    expect(PLAN_READY_SRC).not.toContain("d.endsWith(target) || target.endsWith(d)");
    expect(PLAN_READY_SRC).not.toContain("k.endsWith(target) || target.endsWith(k)");
  });

  it("planner.mjs imports the shared predicate module", () => {
    expect(PLANNER_SRC).toContain("create-target-path-match.mjs");
  });

  it("no exact Set.has subtraction remains at :519, :1086, :1211-1212 or :1720", () => {
    expect(PLANNER_SRC).not.toContain("!createStepPaths.has(p)");
    expect(PLANNER_SRC).not.toContain("!automatedStepPaths.has(p)");
    expect(PLANNER_SRC).not.toContain("!finalCreateStepPaths.has(p)");
  });
});

describe("refine createFiles survives the MCP JSON boundary", () => {
  it("analysis.createFiles round-trips as an array carrying every op:create path", async () => {
    const root = newProject();
    const id = "backlog.fixture-refine-createfiles";
    writeFile(path.join(root, "notes", id + ".md"), twoCreateStory(id));
    const result = await runRefineTool({ projectRoot: root, problemId: id });
    const round = JSON.parse(JSON.stringify(result));
    expect(round.analysis).toBeTruthy();
    expect(Array.isArray(round.analysis.createFiles)).toBe(true);
    expect(round.analysis.createFiles).toContain("src/gen/alpha.js");
    expect(round.analysis.createFiles).toContain("src/gen/beta.js");
  });

  it("PIN - refine.mjs keeps the internal Set and its four call sites", () => {
    expect(REFINE_SRC).toContain("analysis.createFiles = new Set(");
    expect(REFINE_SRC).toContain("analysis.createFiles.size > 0");
    expect(REFINE_SRC).toContain("analysis.createFiles.has(");
  });
});

describe("pre-existing witness updated in the same change", () => {
  it("planner-structural-degeneracy-real.test.mjs no longer pins the exact Set.has form", () => {
    expect(DEGEN_SRC).not.toContain("!llmCreatePaths");
  });
});
