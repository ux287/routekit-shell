/**
 * Create-target grammar drift: refine, planner-llm and plan_ready must agree.
 * Story: backlog.fix.create-target-grammar-drift-refine-and-po-prompt
 *
 * Every directive-shaped token below is assembled by concatenation so that a
 * parser run over this file's own source cannot mistake a fixture for a real
 * directive.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractCreateFileDirectives,
  parseCreateHeadingPath,
} from "../../packages/mcp-rks/src/server/planner-utils.mjs";
import { detectCreateFileDirective } from "../../packages/mcp-rks/src/server/planner-llm.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";
import { runRefineTool, runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import matter from "gray-matter";

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const CF_WORD = "CREATE" + " FILE";
const CF_COLON = "// " + CF_WORD + ":";
const CF_NO_COLON = "// " + CF_WORD;
const H3_DIRECTIVE = "### " + CF_WORD + ":";
const HASH3 = "#" + "## ";
const TICK = "`";
const TICKS = TICK + TICK + TICK;
const fenced = (lang, ...lines) => [TICKS + lang, ...lines, TICKS].join("\n");
const bullet = (p) => "- " + TICK + p + TICK + " — " + CF_WORD + " — a new module";
const EM_DASH_HEADING = (p) => HASH3 + TICK + p + TICK + " — create";

let projectRoot;
afterEach(() => {
  if (projectRoot) {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  projectRoot = undefined;
});

function stage(problemId, content) {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-create-drift-"));
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({
    projectId: "test-project",
    branches: { working: "staging", integration: "staging", production: "main" },
  }));
  fs.writeFileSync(path.join(projectRoot, "notes", problemId + ".md"), content);
  return projectRoot;
}

const storyWith = (id, targets, bodyLines) => [
  "---",
  'id: "' + id + '"',
  'title: "Test Story"',
  'status: "not-implemented"',
  'phase: "ready"',
  "targetFiles:",
  ...targets.flatMap(([p, op]) => ['  - path: "' + p + '"', '    op: "' + op + '"']),
  "testRequirements:",
  '  - "Test something"',
  "---",
  "",
  "## Problem",
  "",
  "Test story.",
  "",
  ...bodyLines,
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] One criterion",
  "",
].join("\n");

async function refineMissingFiles(targets, bodyLines) {
  const id = "backlog.test-drift";
  const root = stage(id, storyWith(id, targets, bodyLines));
  const result = await runRefineTool({ projectRoot: root, problemId: id });
  expect(result.ok).toBe(true);
  const all = [...(result.suggestions || []), ...(result.advisory || [])];
  const fix = all.find((s) => s.type === "fix_target_files");
  return fix ? fix.missingFiles : [];
}

describe("refine.mjs holds no create-target grammar of its own", () => {
  const src = read("packages/mcp-rks/src/server/refine.mjs");
  it("drops the local patterns", () => {
    expect(src).not.toContain("bulletPattern");
    expect(src).not.toContain("createFilePattern");
    expect(src).not.toMatch(/const createPattern\b/);
    expect(src).not.toContain("FILE[:\\s]*");
  });
  it("resolves create targets through the plan_ready directive extractor", () => {
    expect(src).toContain("extractCreateFileDirectives");
  });
});

describe("planner-utils grammar (the one plan_ready binds)", () => {
  it("does not treat the bullet form or a colon-less comment as a directive", () => {
    expect(extractCreateFileDirectives(bullet("src/b.mjs") + "\n")).toEqual([]);
    expect(extractCreateFileDirectives(CF_NO_COLON + " src/d.mjs\n")).toEqual([]);
  });
  it("binds the (create) heading and does not widen to the em-dash tail", () => {
    expect(parseCreateHeadingPath(HASH3 + "src/e.mjs (create)")).toBe("src/e.mjs");
    expect(parseCreateHeadingPath(EM_DASH_HEADING("src/c.mjs"))).not.toBe("src/c.mjs");
  });
  it("headings bind blocks but are not create declarations", () => {
    expect(parseCreateHeadingPath(HASH3 + "src/g.mjs")).toBe("src/g.mjs");
    expect(extractCreateFileDirectives(HASH3 + "src/e.mjs (create)\n")).toEqual([]);
    expect(extractCreateFileDirectives(HASH3 + "src/g.mjs\n")).toEqual([]);
  });
});

describe("refine agrees with plan_ready on create markers", () => {
  it("bullet-only marker on an absent op:edit path is NOT a create to refine", async () => {
    const missing = await refineMissingFiles([["src/b.mjs", "edit"]], ["## Target Files", "", bullet("src/b.mjs")]);
    expect(missing).toContain("src/b.mjs");
  });
  it("colon-less comment marker on an absent op:edit path is NOT a create to refine", async () => {
    const missing = await refineMissingFiles([["src/d.mjs", "edit"]], ["## Target Files", "", CF_NO_COLON + " src/d.mjs"]);
    expect(missing).toContain("src/d.mjs");
  });
  it("a (create), a backticked (new file) and a bare heading are NOT creates to refine", async () => {
    const missing = await refineMissingFiles(
      [["src/e.mjs", "edit"], ["src/f.mjs", "edit"], ["src/g.mjs", "edit"]],
      [
        HASH3 + "src/e.mjs (create)", fenced("js", "export const e = 1;"), "",
        HASH3 + TICK + "src/f.mjs" + TICK + " (new file)", fenced("js", "export const f = 1;"), "",
        HASH3 + "src/g.mjs", fenced("js", "export const g = 1;"),
      ],
    );
    expect(missing).toContain("src/e.mjs");
    expect(missing).toContain("src/f.mjs");
    expect(missing).toContain("src/g.mjs");
  });
  it("a colon comment directive still suppresses existence validation (positive control)", async () => {
    const missing = await refineMissingFiles(
      [["src/a.mjs", "edit"], ["src/g.mjs", "edit"]],
      ["## Target Files", "", CF_COLON + " src/a.mjs", "", HASH3 + "src/g.mjs", fenced("js", "export const g = 1;")],
    );
    expect(missing).toContain("src/g.mjs");
    expect(missing).not.toContain("src/a.mjs");
  });
});

describe("refine legacy-format upgrade uses plan_ready's create rule", () => {
  it("stamps op create only for a colon directive; headings and bullets become op edit", async () => {
    const id = "backlog.test-drift-legacy";
    const content = [
      "---",
      'id: "' + id + '"',
      'title: "Test Story"',
      'status: "not-implemented"',
      'phase: "draft"',
      "targetFiles:",
      '  - "src/a.mjs"',
      '  - "src/e.mjs"',
      '  - "src/g.mjs"',
      '  - "src/b.mjs"',
      "---",
      "",
      "## Problem",
      "",
      "Test story.",
      "",
      "## Target Files",
      "",
      CF_COLON + " src/a.mjs",
      bullet("src/b.mjs"),
      "",
      HASH3 + "src/e.mjs (create)",
      fenced("js", "export const e = 1;"),
      "",
      HASH3 + "src/g.mjs",
      fenced("js", "export const g = 1;"),
      "",
      "## Code Changes",
      "",
      "Some changes.",
      "",
    ].join("\n");
    const root = stage(id, content);
    // A body-changing refinement for an unrelated path guarantees the note is written,
    // so the legacy upgrade's result reaches disk.
    const result = await runRefineApplyTool({
      projectRoot: root,
      problemId: id,
      refinements: [{ type: "create_file_directive", file: "src/z.mjs" }],
    });
    expect(result.ok).toBe(true);
    const written = matter(fs.readFileSync(path.join(root, "notes", id + ".md"), "utf8"));
    const opOf = (p) => ((written.data.targetFiles || []).find((t) => t && t.path === p) || {}).op;
    expect(opOf("src/a.mjs")).toBe("create");
    expect(opOf("src/e.mjs")).toBe("edit");
    expect(opOf("src/g.mjs")).toBe("edit");
    expect(opOf("src/b.mjs")).toBe("edit");
  });
});

describe("detectCreateFileDirective agrees with plan_ready", () => {
  it("rejects every heading form when no frontmatter target is a create", () => {
    expect(detectCreateFileDirective(HASH3 + "src/e.mjs (create)\n", [])).toBe(false);
    expect(detectCreateFileDirective(HASH3 + TICK + "src/f.mjs" + TICK + " (new file)\n", [])).toBe(false);
    expect(detectCreateFileDirective(HASH3 + "src/g.mjs\n", [{ path: "src/g.mjs", op: "edit" }])).toBe(false);
  });
  it("rejects a bare (CREATE FILE) mention outside a directive", () => {
    expect(detectCreateFileDirective("see src/h.mjs (" + CF_WORD + ")\n", [])).toBe(false);
  });
  it("accepts a frontmatter create marker whatever the body says", () => {
    expect(detectCreateFileDirective(HASH3 + "src/e.mjs (create)\n", [{ path: "src/e.mjs", op: "create" }])).toBe(true);
  });
  it("rejects a colon-less comment and a bullet-only body", () => {
    expect(detectCreateFileDirective(CF_NO_COLON + " src/d.mjs\n", [])).toBe(false);
    expect(detectCreateFileDirective(bullet("src/b.mjs") + "\n", [])).toBe(false);
  });
  it("still accepts both colon directive forms", () => {
    expect(detectCreateFileDirective(CF_COLON + " src/a.mjs\n", [])).toBe(true);
    expect(detectCreateFileDirective(H3_DIRECTIVE + " src/a.mjs\n", [])).toBe(true);
  });
});

describe("plan_ready treats a (create) heading on an op:edit target as no create declaration", () => {
  it("flags the absent target and does not report it as file_will_be_created", async () => {
    const id = "backlog.test-drift-pr-heading";
    const root = stage(id, storyWith(id, [["src/e.mjs", "edit"]], [HASH3 + "src/e.mjs (create)", fenced("js", "export const e = 1;")]));
    const r = await runPlanReadyTool({ projectId: "test", problemId: id, projectRoot: root });
    // stale_target_path / missing_create_directive are pushed to issues; file_will_be_created is
    // pushed to warnings (runPlanReadyTool existence loop). Assert each in its own array.
    const issuesForE = (r.issues || []).filter((i) => i.file === "src/e.mjs");
    const warningsForE = (r.warnings || []).filter((i) => i.file === "src/e.mjs");
    expect(issuesForE.some((i) => i.check === "missing_create_directive" || i.check === "stale_target_path")).toBe(true);
    expect(warningsForE.some((i) => i.check === "file_will_be_created")).toBe(false);
    expect(issuesForE.some((i) => i.check === "file_will_be_created")).toBe(false);
  });
});

describe("plan_ready names an unsupported heading tail", () => {
  it("quotes the offending heading and lists the accepted forms", async () => {
    const id = "backlog.test-drift-heading";
    const heading = EM_DASH_HEADING("src/c.mjs");
    const root = stage(id, storyWith(id, [["src/c.mjs", "create"]], [heading, fenced("js", "export const c = 3;")]));
    const r = await runPlanReadyTool({ projectId: "test", problemId: id, projectRoot: root });
    const gate = (r.issues || []).filter((i) => i.check === "create_target_no_authorable_block" && i.file === "src/c.mjs");
    expect(gate).toHaveLength(1);
    expect(gate[0].suggestion).toContain(heading);
    expect(gate[0].suggestion).toMatch(/\(create\)/i);
    expect(gate[0].suggestion).toMatch(/\(create file\)/i);
    expect(gate[0].suggestion).toMatch(/\(new file\)/i);
  });
});

describe("prompts teach that the bullet is prose, not a create declaration", () => {
  for (const rel of [
    ".rks/prompts/governor-po.md",
    "templates/base/.rks/prompts/governor-po.md",
    "templates/generic/CLAUDE.md",
  ]) {
    it(rel, () => {
      const src = read(rel);
      expect(src).toMatch(/not a create declaration/i);
      expect(src).toMatch(/op: ?['"]?create/);
      expect(src).toMatch(/fenced/i);
    });
  }
});
