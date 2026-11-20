/**
 * plan_ready and the ARCH gate select targets through ONE selector.
 * Story: backlog.fix.target-extraction-prose-bullets-read-as-paths
 *
 * Frontmatter targetFiles are authoritative when non-empty; otherwise path-leading
 * body bullets under ## Target Files are used. A prose bullet is never a target.
 * The CREATE-FILE token is assembled by concatenation so a parser run over this
 * file's own source cannot mistake a fixture for a real directive.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runPlanReadyTool,
  findCreateTargetNoAuthorableBlockIssues,
  selectStoryTargets,
} from "../../packages/mcp-rks/src/server/plan-ready.mjs";
import { gatherTargetContext } from "../../packages/mcp-rks/src/server/planner-context.mjs";

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const PLAN_READY_SRC = path.join(REPO_ROOT, "packages/mcp-rks/src/server/plan-ready.mjs");

const CF = "// CREATE" + " FILE:";
const PROSE = "- Manual prerequisite, not targets: `scripts/tradier-switch.sh`, `scripts/x.sh`";

let projectRoot;
const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  projectRoot = undefined;
});

function makeRoot(existing = []) {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-target-selector-"));
  roots.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  for (const rel of existing) {
    const abs = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "export const x = 1;\n");
  }
  return projectRoot;
}

const story = (fmLines, bodyLines) => [
  "---",
  'id: "backlog.test-story"',
  'title: "Test Story"',
  'phase: "ready"',
  ...fmLines,
  "testRequirements:",
  '  - "Test something"',
  "---",
  "",
  "## Problem",
  "",
  "Something.",
  "",
  ...bodyLines,
  "",
  "## Telemetry",
  "",
  "None.",
  "",
].join("\n");

const fmEditTargets = (...paths) => [
  "targetFiles:",
  ...paths.flatMap((p) => ['  - path: "' + p + '"', '    op: "edit"']),
];

async function planReady(content, existing) {
  const root = makeRoot(existing);
  fs.writeFileSync(path.join(root, "notes", "backlog.test-story.md"), content);
  return runPlanReadyTool({ projectId: "test", problemId: "backlog.test-story", projectRoot: root });
}

const entries = (r) => [...(r.issues || []), ...(r.warnings || [])];
const byCheck = (r, check) => entries(r).filter((e) => e.check === check);

const DRIFT = "body_target_not_in_frontmatter";
const COLON_A = "- `src/c.mjs`: EDIT. Some description.";
const COLON_B = "- `src/d.mjs`: CREATE FILE. New module.";

const TARGET_SECTION = [
  "## Target Files", "",
  "- `src/a.mjs` — EDIT — one",
  "- `src/b.mjs` — EDIT — two",
  PROSE, "",
];

describe("selectStoryTargets — frontmatter authoritative, else path-leading body bullets", () => {
  it("returns the frontmatter targetFiles paths when frontmatter is non-empty, ignoring body bullets", () => {
    const body = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", "- `src/body-only.mjs` — EDIT — two", PROSE, ""].join("\n");
    const frontmatter = { targetFiles: [{ path: "src/a.mjs", op: "edit" }, { path: "src/b.mjs", op: "edit" }] };
    expect(Array.from(selectStoryTargets({ frontmatter, body }))).toEqual(["src/a.mjs", "src/b.mjs"]);
  });

  it("falls back to path-leading body bullets when frontmatter has no targetFiles", () => {
    const body = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", PROSE, ""].join("\n");
    expect(Array.from(selectStoryTargets({ frontmatter: {}, body }))).toEqual(["src/a.mjs"]);
  });

  it("falls back to body bullets when frontmatter targetFiles is an empty array", () => {
    const body = ["## Target Files", "", "- src/a.mjs (desc)", ""].join("\n");
    expect(Array.from(selectStoryTargets({ frontmatter: { targetFiles: [] }, body }))).toEqual(["src/a.mjs"]);
  });

  it("returns [] when frontmatter has no targetFiles and the only bullets are colon-separated", () => {
    const body = ["## Target Files", "", COLON_A, COLON_B, ""].join("\n");
    expect(Array.from(selectStoryTargets({ frontmatter: {}, body }))).toEqual([]);
  });

  it("plan-ready.mjs calls parseTargetsFromMarkdown at exactly one site (inside the selector)", () => {
    const src = fs.readFileSync(PLAN_READY_SRC, "utf8");
    expect(src.match(/parseTargetsFromMarkdown\(/g) || []).toHaveLength(1);
  });
});

describe("runPlanReadyTool — a prose bullet under ## Target Files is not a target", () => {
  it("2 frontmatter targets plus a prose bullet: no missing_create_directive, no multi_file_blocked, no multi_file_story", async () => {
    const r = await planReady(story(fmEditTargets("src/a.mjs", "src/b.mjs"), TARGET_SECTION), ["src/a.mjs", "src/b.mjs"]);
    expect(byCheck(r, "missing_create_directive")).toEqual([]);
    expect(byCheck(r, "multi_file_blocked")).toEqual([]);
    expect(byCheck(r, "multi_file_story")).toEqual([]);
  });

  it("targetCount counts frontmatter entries only: 3 acknowledged entries plus a prose bullet report 3", async () => {
    const fm = [...fmEditTargets("src/a.mjs", "src/b.mjs", "src/c.mjs"), "multiFileAcknowledged: true"];
    const r = await planReady(story(fm, TARGET_SECTION), ["src/a.mjs", "src/b.mjs", "src/c.mjs"]);
    const w = byCheck(r, "multi_file_story");
    expect(w).toHaveLength(1);
    expect(w[0].targetCount).toBe(3);
  });

  it("no frontmatter targetFiles: targets still come from path-leading body bullets, and the prose bullet is not one", async () => {
    const body = ["## Target Files", "", "- `src/missing.mjs` — EDIT — one", PROSE, ""];
    const r = await planReady(story([], body), []);
    expect(byCheck(r, "missing_create_directive").map((i) => i.file)).toEqual(["src/missing.mjs"]);
  });
});

describe("findCreateTargetNoAuthorableBlockIssues — the ARCH gate uses the same selector", () => {
  const GHOST_BODY = [
    "## Target Files", "",
    "- `src/a.mjs` — EDIT — one",
    "- `src/ghost.mjs` — CREATE — new", "",
    CF + " src/ghost.mjs", "",
    "## Notes", "", "No fence anywhere.", "",
  ].join("\n");

  it("POLICY (frontmatter authoritative): a body-only create bullet is not gated when frontmatter targetFiles is non-empty", () => {
    const root = makeRoot(["src/a.mjs"]);
    const frontmatter = { targetFiles: [{ path: "src/a.mjs", op: "edit" }] };
    expect(findCreateTargetNoAuthorableBlockIssues({ frontmatter, body: GHOST_BODY, projectRoot: root })).toEqual([]);
  });

  it("still flags a frontmatter op:create target that has no authorable block", () => {
    const root = makeRoot(["src/a.mjs"]);
    const frontmatter = { targetFiles: [{ path: "src/a.mjs", op: "edit" }, { path: "src/ghost.mjs", op: "create" }] };
    const found = findCreateTargetNoAuthorableBlockIssues({ frontmatter, body: GHOST_BODY, projectRoot: root });
    expect(found.map((i) => i.check)).toEqual(["create_target_no_authorable_block"]);
  });

  it("a prose bullet yields no gate issue and no plan_ready issue naming it", async () => {
    const r = await planReady(story(fmEditTargets("src/a.mjs", "src/b.mjs"), TARGET_SECTION), ["src/a.mjs", "src/b.mjs"]);
    const gate = findCreateTargetNoAuthorableBlockIssues({
      frontmatter: { targetFiles: [{ path: "src/a.mjs", op: "edit" }, { path: "src/b.mjs", op: "edit" }] },
      body: TARGET_SECTION.join("\n"),
      projectRoot,
    });
    expect(gate).toEqual([]);
    expect(entries(r).filter((e) => typeof e.file === "string" && e.file.includes("Manual prerequisite"))).toEqual([]);
  });
});

describe("runPlanReadyTool — colon-separated bullets are not targets", () => {
  it("2 frontmatter op:edit targets plus two colon bullets: no missing_create_directive, no multi_file_blocked, no drift warning", async () => {
    const body = ["## Target Files", "", COLON_A, COLON_B, ""];
    const r = await planReady(story(fmEditTargets("src/a.mjs", "src/b.mjs"), body), ["src/a.mjs", "src/b.mjs"]);
    expect(byCheck(r, "missing_create_directive")).toEqual([]);
    expect(byCheck(r, "multi_file_blocked")).toEqual([]);
    expect(byCheck(r, DRIFT)).toEqual([]);
  });
});

describe("runPlanReadyTool — drift warning for body path bullets omitted from frontmatter (choice 1D)", () => {
  const FM2 = fmEditTargets("src/a.mjs", "src/b.mjs");
  const EXISTING2 = ["src/a.mjs", "src/b.mjs"];
  const DRIFT_SECTION = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", "- `src/body-only.mjs` — EDIT — extra", PROSE, ""];
  const BASE_SECTION = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", PROSE, ""];

  it("reports exactly one non-blocking warning naming the omitted path, and the omitted path is not gated", async () => {
    const r = await planReady(story(FM2, DRIFT_SECTION), EXISTING2);
    const w = (r.warnings || []).filter((e) => e.check === DRIFT);
    expect(w).toHaveLength(1);
    expect((r.issues || []).filter((e) => e.check === DRIFT)).toEqual([]);
    const text = JSON.stringify(w[0]);
    expect(text).toContain("src/body-only.mjs");
    expect(text).not.toContain("Manual prerequisite");
    expect(byCheck(r, "missing_create_directive")).toEqual([]);
  });

  it("the warning alone does not change ready or the issue check list", async () => {
    const drift = await planReady(story(FM2, DRIFT_SECTION), EXISTING2);
    const base = await planReady(story(FM2, BASE_SECTION), EXISTING2);
    expect(drift.ready).toBe(base.ready);
    expect((drift.issues || []).map((i) => i.check)).toEqual((base.issues || []).map((i) => i.check));
  });

  it("a body-only path also named by a CREATE FILE directive is warned about, not gated", async () => {
    const body = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", "- `src/body-only.mjs` — CREATE — new", "", CF + " src/body-only.mjs", ""];
    const r = await planReady(story(FM2, body), EXISTING2);
    const w = byCheck(r, DRIFT);
    expect(w).toHaveLength(1);
    expect(JSON.stringify(w[0])).toContain("src/body-only.mjs");
    expect(byCheck(r, "missing_create_directive")).toEqual([]);
    expect(byCheck(r, "create_target_no_authorable_block")).toEqual([]);
  });

  it("no drift warning when body path bullets equal the frontmatter set, with or without an extra prose bullet", async () => {
    const equal = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", "- `src/b.mjs` — EDIT — two", ""];
    expect(byCheck(await planReady(story(FM2, equal), EXISTING2), DRIFT)).toEqual([]);
    expect(byCheck(await planReady(story(FM2, TARGET_SECTION), EXISTING2), DRIFT)).toEqual([]);
  });

  it("no drift warning when frontmatter targetFiles is absent or an empty array", async () => {
    const body = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", ""];
    expect(byCheck(await planReady(story([], body), ["src/a.mjs"]), DRIFT)).toEqual([]);
    expect(byCheck(await planReady(story(["targetFiles: []"], body), ["src/a.mjs"]), DRIFT)).toEqual([]);
  });

  it("the drift warning does not change targetCount", async () => {
    const fm = [...fmEditTargets("src/a.mjs", "src/b.mjs", "src/c.mjs"), "multiFileAcknowledged: true"];
    const r = await planReady(story(fm, DRIFT_SECTION), ["src/a.mjs", "src/b.mjs", "src/c.mjs"]);
    const multi = byCheck(r, "multi_file_story");
    expect(multi).toHaveLength(1);
    expect(multi[0].targetCount).toBe(3);
    expect(byCheck(r, DRIFT)).toHaveLength(1);
  });

  it("the ARCH gate never returns the drift check", () => {
    const root = makeRoot(EXISTING2);
    const frontmatter = { targetFiles: [{ path: "src/a.mjs", op: "edit" }, { path: "src/b.mjs", op: "edit" }] };
    const found = findCreateTargetNoAuthorableBlockIssues({ frontmatter, body: DRIFT_SECTION.join("\n"), projectRoot: root });
    expect(found.filter((i) => i.check === DRIFT)).toEqual([]);
    expect(found).toEqual([]);
  });
});

describe("gatherTargetContext — the planner selects the same target set as plan_ready", () => {
  async function gatherPaths(content, existing) {
    const root = makeRoot(existing);
    fs.writeFileSync(path.join(root, "notes", "backlog.test-story.md"), content);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    const result = await gatherTargetContext({
      projectRoot: root, projectId: "fixture", normalizedProblem: "backlog.test-story",
      normalizedTask: "", context: {}, finalSlug: "fixture",
    });
    return Array.from(result.editableTargetPaths);
  }

  it("non-empty frontmatter targetFiles: a body-only path bullet and a prose bullet are not editable targets", async () => {
    const body = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", "- `src/body-only.mjs` — EDIT — extra", PROSE, ""];
    expect(await gatherPaths(story(fmEditTargets("src/a.mjs"), body), ["src/a.mjs"])).toEqual(["src/a.mjs"]);
  });

  it("no frontmatter targetFiles: path-leading body bullets are still the targets and the prose bullet is not", async () => {
    const body = ["## Target Files", "", "- `src/a.mjs` — EDIT — one", PROSE, ""];
    expect(await gatherPaths(story([], body), ["src/a.mjs"])).toEqual(["src/a.mjs"]);
  });

  it("a single-string frontmatter targetFiles is still honoured and excludes a body-only bullet", async () => {
    const body = ["## Target Files", "", "- `src/body-only.mjs` — EDIT — extra", ""];
    expect(await gatherPaths(story(['targetFiles: "src/a.mjs"'], body), ["src/a.mjs"])).toEqual(["src/a.mjs"]);
  });
});
