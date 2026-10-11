/**
 * CREATE FILE grammar reconciliation.
 * Story: backlog.fix.create-file-directive-grammar-not-reconciled
 *
 * Two directive grammars are in play. The COMMENT form (a double-slash comment)
 * is canonical and is what planner-utils reads. The HEADING form (a three-hash
 * heading) is what reviewer.mjs reads, and what the authoring how-to teaches for
 * the content fence. Before this story they bound at different seams, so a story
 * authored exactly as the how-to documents was refused by rks_plan_ready with
 * create_target_no_authorable_block.
 *
 * Every CREATE-FILE token below is assembled by concatenation, so a parser run
 * over this file's own source cannot mistake a fixture for a real directive.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractCreateFileDirectives,
  extractCreateFileBlocks,
} from "../../packages/mcp-rks/src/server/planner-utils.mjs";
import {
  extractExplicitEdits,
  editsToSteps,
} from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import { detectCreateFileDirective } from "../../packages/mcp-rks/src/server/planner-llm.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";
import { validateStory } from "../../packages/mcp-rks/src/server/story-validator-v2.mjs";

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const CF = "// CREATE" + " FILE:";   // comment form  — canonical for the directive
const H3 = "### CREATE" + " FILE:";  // heading form  — what the how-to teaches
const H2 = "## CREATE" + " FILE:";   // two-hash form — NOT bounded by the section split
const TICKS = "`" + "`" + "`";
const fenced = (lang, ...lines) => [TICKS + lang, ...lines, TICKS].join("\n");

const NEW = "src/new-thing.mjs";
const BODY = "export const answer = 42;";

let projectRoot;
afterEach(() => {
  if (projectRoot) {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  projectRoot = undefined;
});

function stageStory(storyContent) {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-create-grammar-"));
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "notes", "backlog.test-story.md"), storyContent);
  return projectRoot;
}

async function planReady(storyContent) {
  return runPlanReadyTool({
    projectId: "test", problemId: "backlog.test-story", projectRoot: stageStory(storyContent),
  });
}

// story-validator-v2 takes the SAME ({ projectId, problemId, projectRoot }) shape as
// runPlanReadyTool (story-validator-v2.mjs:243) and reads the same notes/<problemId>.md.
async function validateStoryOn(storyContent) {
  return validateStory({
    projectId: "test", problemId: "backlog.test-story", projectRoot: stageStory(storyContent),
  });
}

const issuesOf = (result, check) => (result.issues || []).filter((i) => i.check === check);
const entriesOf = (result, check) =>
  [...(result.issues || []), ...(result.warnings || [])].filter((e) => e.check === check);

// The frontmatter targetFiles block is a PARAMETER, not a constant. ARCH round 1 found
// that hard-coding op: "create" made every plan-ready fixture satisfy the FRONTMATTER arm
// of hasDirective at plan-ready.mjs:235 —
//   const hasDirective = fmCreateFiles.has(target) || createFileDirectives.some(
// — so the directive list was never reached, and TR-14 plus the missing_create_directive
// half of TR-15 passed at HEAD regardless of the broadening.
const FM_CREATE_TARGET = [
  "targetFiles:",
  '  - path: "' + NEW + '"',
  '    op: "create"',
];

const storyWith = (fmTargetLines, bodyLines) => [
  "---",
  'id: "backlog.test-story"',
  'title: "Test Story"',
  'phase: "ready"',
  ...fmTargetLines,
  "testRequirements:",
  '  - "Test something"',
  "---",
  "",
  "## Problem",
  "",
  "Need a new file.",
  "",
  ...bodyLines,
  "",
  "## Telemetry",
  "",
  "None.",
  "",
].join("\n");

// Frontmatter DOES declare op: "create" — the shape the how-to teaches.
const story = (...bodyLines) => storyWith(FM_CREATE_TARGET, bodyLines);

// Frontmatter declares NO targetFiles key at all. resolveTargets(projectRoot, undefined)
// returns [] (normalizeTargetFiles returns [] for a non-array), so staleEditTargets at
// plan-ready.mjs:203 is empty, and the target reaches allTargets only through the body
// "## Target Files" bullet via parseTargetsFromMarkdown (plan-ready.mjs:187). The DIRECTIVE
// list is then the only thing that can satisfy hasDirective.
//
// Declaring the missing path op: "edit" instead would NOT work: normalizeTargetFiles stamps
// it action "EDIT", resolveTargets sets mismatch "EDIT but file does not exist", and the
// staleEditTargets branch at plan-ready.mjs:265 raises stale_target_path — a different
// check, which would leave the acceptance criterion unreachable.
const storyNoFmTarget = (...bodyLines) => storyWith([], bodyLines);

// One fixture, two consumers of the same broadened extractor: TR-15 runs it through
// plan-ready, TR-24 through story-validator-v2. RED at HEAD in both.
const HEADING_ONLY = storyNoFmTarget(
  "## Target Files", "",
  "- `" + NEW + "`", "",
  "## Implementation", "",
  H3 + " " + NEW, "",
  fenced("js", "export function newThing() {", "  return 42;", "}"),
);

// ── TR-01 .. TR-03 — extractCreateFileDirectives ────────────────────────────
describe("extractCreateFileDirectives — both grammars, and no phantom directives", () => {
  it("TR-01 returns the path for a comment-form directive (unchanged)", () => {
    const body = ["## Target Files", "", CF + " " + NEW, ""].join("\n");
    expect(extractCreateFileDirectives(body)).toEqual([NEW]);
  });

  it("TR-02 returns the path for a heading-form directive", () => {
    const body = ["## Implementation", "", H3 + " " + NEW, ""].join("\n");
    expect(extractCreateFileDirectives(body)).toEqual([NEW]);
  });

  it("TR-02b names exactly one path when a story carries both forms for the same file", () => {
    const body = [
      "## Target Files", "", CF + " " + NEW, "",
      "## Implementation", "", H3 + " " + NEW, "",
    ].join("\n");
    expect([...new Set(extractCreateFileDirectives(body))]).toEqual([NEW]);
  });

  it("TR-03 does not register a directive for a heading form quoted inline in prose", () => {
    // Both how-to documents, the PO prompt and this story's own note describe the
    // grammar in backticks mid-sentence. An unanchored heading arm would read every
    // one of those as a real directive.
    const body = [
      "## Problem", "",
      "The how-to teaches `" + H3 + " " + NEW + "` for the content fence,",
      "which is the form no binder read before this story.", "",
    ].join("\n");
    expect(extractCreateFileDirectives(body)).toEqual([]);
  });
});

// ── TR-04 .. TR-07 — extractCreateFileBlocks ────────────────────────────────
describe("extractCreateFileBlocks — binds both grammars, never across a ### boundary", () => {
  it("TR-04 binds a fence after a comment-form directive in the same section (unchanged)", () => {
    const body = [
      "### " + NEW, "", CF + " " + NEW, "", fenced("js", BODY), "",
    ].join("\n");
    expect(extractCreateFileBlocks(body).get(NEW)).toContain(BODY);
  });

  it("TR-05 binds a fence after a heading-form directive in that heading's own section", () => {
    const body = [
      "## Implementation", "", H3 + " " + NEW, "", fenced("js", BODY), "",
    ].join("\n");
    expect(extractCreateFileBlocks(body).get(NEW)).toContain(BODY);
  });

  it("TR-06a holds the ### boundary for the comment form", () => {
    const body = [
      "### Target Files", "", CF + " " + NEW, "",
      "### Reference — existing code, do not create", "",
      fenced("js", "export const unrelated = 1;"), "",
    ].join("\n");
    expect(extractCreateFileBlocks(body).has(NEW)).toBe(false);
  });

  it("TR-06b holds the ### boundary for the heading form", () => {
    const body = [
      H3 + " " + NEW, "", "No fence here — the content was never authored.", "",
      "### Reference — existing code, do not create", "",
      fenced("js", "export const unrelated = 1;"), "",
    ].join("\n");
    expect(extractCreateFileBlocks(body).has(NEW)).toBe(false);
  });

  it("TR-07 does not let a ##-level directive reach past a ### heading into a later section", () => {
    const body = [
      H2 + " " + NEW, "", "No fence in this section.", "",
      "### Reference — existing code, do not create", "",
      fenced("js", "export const unrelated = 1;"), "",
    ].join("\n");
    expect(extractCreateFileBlocks(body).has(NEW)).toBe(false);
  });

  it("TR-03b binds no fence for a heading form quoted inline in prose inside its own ### section", () => {
    const body = [
      "### Reference — how the grammar is described, not used", "",
      "The how-to teaches `" + H3 + " " + NEW + "` for the content fence,",
      "which is the form no binder read before this story.", "",
      fenced("js", "export const unrelated = 1;"), "",
    ].join("\n");
    expect(extractCreateFileBlocks(body).has(NEW)).toBe(false);
  });
});

// ── TR-08 .. TR-10 — reviewer.mjs extractExplicitEdits ──────────────────────
describe("extractExplicitEdits — create_file_block edits from both grammars", () => {
  const createEdits = (s) => extractExplicitEdits(s).filter((e) => e.action === "create");

  it("TR-08 emits a create edit for a heading-form directive plus fence (unchanged)", () => {
    const edits = createEdits([H3 + " " + NEW, fenced("js", BODY), ""].join("\n"));
    expect(edits).toHaveLength(1);
    expect(edits[0].source).toBe("create_file_block");
    expect(edits[0].file).toBe(NEW);
    expect(edits[0].content).toContain(BODY);
  });

  it("TR-09 emits a create edit for a comment-form directive plus fence", () => {
    const edits = createEdits([CF + " " + NEW, fenced("js", BODY), ""].join("\n"));
    expect(edits).toHaveLength(1);
    expect(edits[0].source).toBe("create_file_block");
    expect(edits[0].file).toBe(NEW);
    expect(edits[0].content).toContain(BODY);
  });

  it("TR-10 captures the path alone when a comment-form directive carries a description", () => {
    const line = CF + " " + NEW + " — the new module";
    const edits = createEdits([line, fenced("js", BODY), ""].join("\n"));
    expect(edits).toHaveLength(1);
    expect(edits[0].file).toBe(NEW);
    expect(extractCreateFileDirectives(line)).toEqual([edits[0].file]);
  });
});

// ── TR-11 .. TR-12 — editsToSteps, previously zero-coverage ─────────────────
describe("editsToSteps — the reviewer's create_file synthesiser", () => {
  it("TR-11 turns an action:create edit with content into a create_file step", () => {
    const steps = editsToSteps(
      // editsToSteps consumes the VALIDATED shape produced by validateExplicitEdits —
      // a flat edit carrying a validation sub-object, gated at reviewer.mjs:688.
      [{ action: "create", file: NEW, content: BODY + "\n", description: "Create file " + NEW,
        validation: { passed: true } }],
      process.cwd(),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe("create_file");
    expect(steps[0].path).toBe(NEW);
    expect(steps[0].content).toBe(BODY + "\n");
  });

  it("TR-12 downgrades a content-less action:create edit to a note step", () => {
    const steps = editsToSteps(
      [{ action: "create", file: NEW, content: "", description: "Create file " + NEW,
        validation: { passed: true } }],
      process.cwd(),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe("note");
    expect(steps[0].content).toContain("no content");
  });
});

// ── TR-13 .. TR-16 — plan-ready end to end ─────────────────────────────────
describe("plan-ready — a story shaped exactly as the how-to teaches is plannable", () => {
  const HOW_TO_SHAPED = story(
    "## Target Files", "",
    CF + " " + NEW, "",
    "## Implementation", "",
    H3 + " " + NEW, "",
    fenced("js", "export function newThing() {", "  return 42;", "}"),
  );

  it("TR-13 raises no create_target_no_authorable_block — FALSE at HEAD", async () => {
    const result = await planReady(HOW_TO_SHAPED);
    expect(issuesOf(result, "create_target_no_authorable_block").map((i) => i.file)).toEqual([]);
  });

  it("TR-14 raises no missing_create_directive for the how-to-shaped story — PIN, green at HEAD", async () => {
    const result = await planReady(HOW_TO_SHAPED);
    expect(issuesOf(result, "missing_create_directive")).toHaveLength(0);
  });

  it("TR-15 accepts a heading-form directive as the sole evidence a body target is new — RED at HEAD on missing_create_directive; the no-authorable-block expect is a post-fix guard, green at HEAD", async () => {
    const result = await planReady(HEADING_ONLY);
    expect(issuesOf(result, "missing_create_directive")).toHaveLength(0);
    expect(issuesOf(result, "create_target_no_authorable_block")).toHaveLength(0);
  });

  it("TR-16 still blocks a create target with directives but no fence anywhere", async () => {
    const result = await planReady(story(
      "## Target Files", "", CF + " " + NEW, "",
      "## Implementation", "", H3 + " " + NEW, "",
      "The content was never authored.",
    ));
    expect(issuesOf(result, "create_target_no_authorable_block")).toHaveLength(1);
    expect(result.ready).toBe(false);
  });
});

// ── TR-17 .. TR-18 — plan-ready create_file_syntax warning ─────────────────
describe("plan-ready create_file_syntax — path-vs-description warning on both grammars", () => {
  it("TR-17 warns on a heading-form directive with a trailing description, naming the path only", async () => {
    const result = await planReady(story(
      H3 + " " + NEW + " — the new module", "",
      fenced("js", "export function newThing() {", "  return 42;", "}"),
    ));
    const warns = entriesOf(result, "create_file_syntax");
    expect(warns).toHaveLength(1);
    expect(warns[0].suggestion).toContain(NEW);
    expect(warns[0].suggestion).not.toContain("#");
  });

  it("TR-18 does not warn on a well-formed heading-form directive carrying only a path", async () => {
    const result = await planReady(story(
      H3 + " " + NEW, "",
      fenced("js", "export function newThing() {", "  return 42;", "}"),
    ));
    expect(entriesOf(result, "create_file_syntax")).toHaveLength(0);
  });
});

// ── TR-19 .. TR-20 — planner-llm ───────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────────────────
// backlog.fix.create-directive-binds-only-same-section
// A complete story must not fail the create gate; when it does fail, the gate names the shape.
// Directives are assembled by concatenation (CF) so this file is never parsed as a story.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const REAL_A = "export const a = 1;";
const REAL_C = "export const c = 3;";
const fmStory = (targets, body) =>
  ["---", 'id: "backlog.test-story"', 'phase: "arch-approved"', "targetFiles:",
    ...targets.flatMap(([p, op]) => [`  - path: "${p}"`, `    op: "${op}"`]),
    "---", "", body].join("\n");
const gateIssues = (r, file) =>
  issuesOf(r, "create_target_no_authorable_block").filter((i) => i.file === file);

const directiveUnderTargetFiles = (target, heading = `### ${target}`, content = REAL_A) =>
  ["## Target Files", "", `${CF} ${target}`, "", heading, fenced("js", content), ""].join("\n");

describe("extractCreateFileBlocks — directive in ## Target Files binds the ### <path> fence", () => {
  it("binds the later plain heading's fence to the directive path", () => {
    const blocks = extractCreateFileBlocks(directiveUnderTargetFiles("src/a.mjs"));
    expect(blocks.get("src/a.mjs")).toContain(REAL_A);
  });

  it("binds a backticked heading, keyed on the unbackticked path", () => {
    const blocks = extractCreateFileBlocks(directiveUnderTargetFiles("src/a.mjs", "### `src/a.mjs`"));
    expect(blocks.get("src/a.mjs")).toContain(REAL_A);
  });

  it("frontmatter-only: binds with declaredCreatePaths, not with the one-argument call", () => {
    const body = ["### src/c.mjs", fenced("js", REAL_C), ""].join("\n");
    expect(extractCreateFileBlocks(body, { declaredCreatePaths: ["src/c.mjs"] }).get("src/c.mjs")).toContain(REAL_C);
    expect(extractCreateFileBlocks(body).has("src/c.mjs")).toBe(false);
  });

  it("an undeclared heading does not bind (no ## Implementation; edit anchors are never create content)", () => {
    const body = ["### src/b.mjs", fenced("js", "export const b = 2;"), ""].join("\n");
    expect(extractCreateFileBlocks(body, { declaredCreatePaths: ["src/other.mjs"] }).has("src/b.mjs")).toBe(false);
  });

  it("edit-declared variant: neither the extractor nor the plan-ready block map binds src/b.mjs", async () => {
    const { buildCreateFileBlocks } = await import("../../packages/mcp-rks/src/server/plan-ready.mjs");
    const body = ["### src/b.mjs", fenced("js", "export const b = 2;"), ""].join("\n");
    expect(extractCreateFileBlocks(body, { declaredCreatePaths: [] }).has("src/b.mjs")).toBe(false);
    expect(buildCreateFileBlocks(body, new Set()).has("src/b.mjs")).toBe(false);
  });

  it.each(["(create)", "(CREATE FILE)", "(new file)", "(Create)", "(New File)"])(
    "heading suffix %s binds outside ## Implementation (suffix stripped from the key)",
    (suffix) => {
      const plain = extractCreateFileBlocks(directiveUnderTargetFiles("src/a.mjs", `### src/a.mjs ${suffix}`));
      expect(plain.get("src/a.mjs")).toContain(REAL_A);
      const ticked = extractCreateFileBlocks(directiveUnderTargetFiles("src/a.mjs", "### `src/a.mjs` " + suffix));
      expect(ticked.get("src/a.mjs")).toContain(REAL_A);
    },
  );

  it("(create) binds inside ## Implementation, and plan-ready raises no gate issue for it", async () => {
    const { parseImplementationCodeBlocks } = await import("../../packages/mcp-rks/src/llm/targets.mjs");
    const body = ["## Implementation", "", `### ${NEW} (create)`, fenced("js", BODY), ""].join("\n");
    expect(parseImplementationCodeBlocks(body).get(NEW)).toContain(BODY);
    const r = await planReady(fmStory([[NEW, "create"]], body));
    expect(gateIssues(r, NEW)).toEqual([]);
  });

  it("one suffix definition: both extractors bind the same key and content for every variant", async () => {
    const { parseImplementationCodeBlocks } = await import("../../packages/mcp-rks/src/llm/targets.mjs");
    for (const suffix of ["(create)", "(CREATE FILE)", "(new file)", "(Create)", "(New File)"]) {
      const impl = parseImplementationCodeBlocks(["## Implementation", "", `### src/a.mjs ${suffix}`, fenced("js", REAL_A), ""].join("\n"));
      const outside = extractCreateFileBlocks(["### src/a.mjs " + suffix, fenced("js", REAL_A), ""].join("\n"), { declaredCreatePaths: ["src/a.mjs"] });
      expect([...outside.entries()], suffix).toEqual([...impl.entries()]);
    }
  });

  it("a same-section directive binding keeps precedence over a separate ### <path> section", () => {
    const body = [`${CF} src/a.mjs`, fenced("js", "export const first = 1;"), "", "### src/a.mjs", fenced("js", "export const second = 2;"), ""].join("\n");
    expect(extractCreateFileBlocks(body).get("src/a.mjs")).toContain("first");
  });

  it("a ### Target: binding keeps precedence over a separate ### <path> section", () => {
    const body = ["### Target: src/a.mjs", fenced("js", "export const target = 1;"), "", "### src/a.mjs", fenced("js", "export const other = 2;"), "", `${CF} src/a.mjs`, ""].join("\n");
    expect(extractCreateFileBlocks(body).get("src/a.mjs")).toContain("target");
  });

  it("existing negatives stay unbound: fences under non-path headings", () => {
    for (const heading of ["### Reference — existing code, do not create", "### Source: src/other.mjs"]) {
      const body = ["## Target Files", `${CF} src/a.mjs`, "", heading, fenced("js", REAL_A), ""].join("\n");
      expect(extractCreateFileBlocks(body).has("src/a.mjs"), heading).toBe(false);
    }
  });
});

describe("two directives, one fence — the fence never crosses a later directive", () => {
  const twoDirectives = (rescue = false) =>
    ["## Shared", `${CF} src/x.mjs`, `${CF} src/y.mjs`, fenced("js", "export const y = 'Y';"), "",
      ...(rescue ? ["### src/x.mjs", fenced("js", "export const x = 'X';"), ""] : [])].join("\n");

  it("binds the fence to src/y.mjs, never to src/x.mjs", () => {
    const blocks = extractCreateFileBlocks(twoDirectives());
    expect(blocks.get("src/y.mjs")).toContain("'Y'");
    expect(blocks.get("src/x.mjs") || "").not.toContain("'Y'");
  });

  it("with rescue: src/x.mjs binds its own ### section, src/y.mjs keeps the shared fence", () => {
    const blocks = extractCreateFileBlocks(twoDirectives(true));
    expect(blocks.get("src/x.mjs")).toContain("'X'");
    expect(blocks.get("src/y.mjs")).toContain("'Y'");
  });

  it("no rescue: plan-ready raises exactly one issue, for src/x.mjs, with a shape (c) suggestion", async () => {
    const r = await planReady(fmStory([["src/x.mjs", "create"], ["src/y.mjs", "create"]], twoDirectives()));
    const all = issuesOf(r, "create_target_no_authorable_block");
    expect(all.map((i) => i.file)).toEqual(["src/x.mjs"]);
    expect(all[0].suggestion).toContain("src/y.mjs");
    expect(all[0].suggestion).toContain("Shared");
    expect(all[0].suggestion).toMatch(/one fence per directive/i);
    expect(all[0].message).toContain("src/y.mjs");
  });
});

describe("plan-ready create gate — complete stories pass, failures name the shape", () => {
  it("directive under ## Target Files + real content under ### src/a.mjs: zero gate issues", async () => {
    const r = await planReady(fmStory([["src/a.mjs", "create"]], directiveUnderTargetFiles("src/a.mjs")));
    expect(gateIssues(r, "src/a.mjs")).toEqual([]);
  });

  it("frontmatter-only op:create + real content under ### src/c.mjs: zero gate issues", async () => {
    const r = await planReady(fmStory([["src/c.mjs", "create"]], ["### src/c.mjs", fenced("js", REAL_C), ""].join("\n")));
    expect(gateIssues(r, "src/c.mjs")).toEqual([]);
  });

  it("the pre-Revision-4 child-rks-permission-allow-list shape passes with zero gate issues", async () => {
    const files = ["packages/cli/src/project/child-permissions.mjs", "tests/unit/child-permissions.test.mjs", "tests/integration/child-rks-permission-drift-guard.spec.mjs"];
    const body = ["## Target Files", "", ...files.map((f) => `${CF} ${f}`), "",
      ...files.flatMap((f, i) => [`### ${f}`, fenced("js", `export const v${i} = ${i};`), ""])].join("\n");
    const r = await planReady(fmStory(files.map((f) => [f, "create"]), body));
    expect(issuesOf(r, "create_target_no_authorable_block")).toEqual([]);
  });

  it("shape (a): directive-declared heading with placeholder-only content still fails", async () => {
    const r = await planReady(fmStory([["src/a.mjs", "create"]], directiveUnderTargetFiles("src/a.mjs", "### src/a.mjs", "// TODO")));
    const [issue, ...rest] = gateIssues(r, "src/a.mjs");
    expect(rest).toEqual([]);
    expect(issue.suggestion).toMatch(/placeholder/i);
    expect(issue.suggestion).toMatch(/real file content/i);
  });

  it("shape (a): frontmatter-only heading with placeholder-only content still fails", async () => {
    const r = await planReady(fmStory([["src/c.mjs", "create"]], ["### src/c.mjs", fenced("js", "// TODO"), ""].join("\n")));
    const [issue, ...rest] = gateIssues(r, "src/c.mjs");
    expect(rest).toEqual([]);
    expect(issue.suggestion).toMatch(/placeholder/i);
  });

  const SHAPE_B = ["## Target Files", "", `${CF} src/a.mjs`, "", "## Notes", "nothing here", ""].join("\n");
  const SHAPE_D = ["### src/c.mjs", "No fence yet.", ""].join("\n");
  const SHAPE_E = ["## Problem", "Just prose.", ""].join("\n");

  it("shape (b): names the directive, the Target Files section and the fix", async () => {
    const r = await planReady(fmStory([["src/a.mjs", "create"]], SHAPE_B));
    const [issue] = gateIssues(r, "src/a.mjs");
    expect(issue.suggestion).toMatch(/directive for src\/a\.mjs was found/i);
    expect(issue.suggestion).toContain("Target Files");
    expect(issue.suggestion).toMatch(/no fenced block/i);
    expect(issue.suggestion).toContain("### src/a.mjs");
    expect(issue.message).toContain("Target Files");
  });

  it("shape (d): the ### T section exists but holds no fence", async () => {
    const r = await planReady(fmStory([["src/c.mjs", "create"]], SHAPE_D));
    const [issue] = gateIssues(r, "src/c.mjs");
    expect(issue.suggestion).toMatch(/"### src\/c\.mjs" section exists but has no fenced block/);
    expect(issue.message).toMatch(/no fenced block/);
  });

  it("shape (e): no directive and no ### T section", async () => {
    const r = await planReady(fmStory([["src/c.mjs", "create"]], SHAPE_E));
    const [issue] = gateIssues(r, "src/c.mjs");
    expect(issue.suggestion).toMatch(/no create directive for src\/c\.mjs and no "### src\/c\.mjs" section/);
    expect(issue.message).toMatch(/no "### src\/c\.mjs" section/);
  });

  it("no false claims: frontmatter-only shapes never say a directive was found", async () => {
    for (const body of [SHAPE_D, SHAPE_E, ["### src/c.mjs", fenced("js", "// TODO"), ""].join("\n")]) {
      const [issue] = gateIssues(await planReady(fmStory([["src/c.mjs", "create"]], body)), "src/c.mjs");
      for (const text of [issue.suggestion, issue.message]) {
        expect(text).not.toMatch(/directive (for \S+ )?was found/i);
        expect(text).not.toContain("has a directive but no authorable code block");
      }
    }
  });

  it("round trip: applying the suggested fix literally clears the gate for (b), (d) and (e)", async () => {
    const fence = fenced("js", "export const fixed = 1;");
    const fixedB = SHAPE_B.replace(`${CF} src/a.mjs\n`, `${CF} src/a.mjs\n${fence}\n`);
    const fixedD = SHAPE_D + fence + "\n";
    const fixedE = SHAPE_E + "\n### src/c.mjs\n" + fence + "\n";
    expect(gateIssues(await planReady(fmStory([["src/a.mjs", "create"]], fixedB)), "src/a.mjs")).toEqual([]);
    expect(gateIssues(await planReady(fmStory([["src/c.mjs", "create"]], fixedD)), "src/c.mjs")).toEqual([]);
    expect(gateIssues(await planReady(fmStory([["src/c.mjs", "create"]], fixedE)), "src/c.mjs")).toEqual([]);
  });
});

describe("planner parity — gatherTargetContext binds exactly what the gate accepts", () => {
  async function gather(storyContent) {
    const { gatherTargetContext } = await import("../../packages/mcp-rks/src/server/planner-context.mjs");
    const root = stageStory(storyContent);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
    const result = await gatherTargetContext({
      projectRoot: root, projectId: "fixture", normalizedProblem: "backlog.test-story",
      normalizedTask: "", context: {}, finalSlug: "fixture",
    });
    return (result.automatedSteps || []).filter((st) => st.action === "create_file");
  }

  it("directive-declared heading shape → create_file for src/a.mjs with the fence content", async () => {
    const steps = await gather(fmStory([["src/a.mjs", "create"]], directiveUnderTargetFiles("src/a.mjs")));
    expect(steps.find((st) => st.path === "src/a.mjs")?.content).toContain(REAL_A);
  });

  it("frontmatter-only heading shape → create_file for src/c.mjs", async () => {
    const steps = await gather(fmStory([["src/c.mjs", "create"]], ["### src/c.mjs", fenced("js", REAL_C), ""].join("\n")));
    expect(steps.find((st) => st.path === "src/c.mjs")?.content).toContain(REAL_C);
  });

  it("undeclared and op:edit-declared ### src/b.mjs sections → no create_file step", async () => {
    const body = ["### src/b.mjs", fenced("js", "export const b = 2;"), ""].join("\n");
    expect((await gather(fmStory([["src/other.mjs", "create"]], body))).some((st) => st.path === "src/b.mjs")).toBe(false);
    expect((await gather(fmStory([["src/b.mjs", "edit"]], body))).some((st) => st.path === "src/b.mjs")).toBe(false);
  });

  it("two directives, one fence → the shared fence is src/y.mjs's step, never src/x.mjs's", async () => {
    const body = ["## Shared", `${CF} src/x.mjs`, `${CF} src/y.mjs`, fenced("js", "export const y = 'Y';"), ""].join("\n");
    const steps = await gather(fmStory([["src/x.mjs", "create"], ["src/y.mjs", "create"]], body));
    expect(steps.find((st) => st.path === "src/y.mjs")?.content).toContain("'Y'");
    expect(steps.find((st) => st.path === "src/x.mjs")?.content || "").not.toContain("'Y'");
  });
});

describe("planner-llm — its own directive detector, and its stale comment", () => {
  it("TR-19 detectCreateFileDirective sees a heading-form directive", () => {
    expect(detectCreateFileDirective(H3 + " " + NEW + "\n", [])).toBe(true);
  });

  it("TR-19b still sees the comment form", () => {
    expect(detectCreateFileDirective(CF + " " + NEW + "\n", [])).toBe(true);
  });

  it("TR-20 no longer claims reviewer mode does not synthesize create_file steps", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "packages/mcp-rks/src/server/planner-llm.mjs"), "utf8");
    expect(src).not.toMatch(/does not synthesize create_file steps/i);
  });
});

// ── TR-21 .. TR-23 — the two how-to documents ──────────────────────────────
describe("how-to documents — reconciled grammar, shipped in step to child projects", () => {
  const NOTES_HOW_TO = "notes/how-to.write-backlog-stories.md";
  const TEMPLATE_HOW_TO = "templates/base/notes/how-to.write-backlog-stories.md";
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const createFileLines = (src) =>
    src.split("\n").filter((l) => l.includes("CREATE" + " FILE"));

  it("TR-21 both copies carry the same CREATE FILE guidance, line for line", () => {
    expect(createFileLines(read(TEMPLATE_HOW_TO))).toEqual(createFileLines(read(NOTES_HOW_TO)));
  });

  it("TR-22 both copies name a canonical directive form", () => {
    expect(read(NOTES_HOW_TO)).toMatch(/canonical/i);
    expect(read(TEMPLATE_HOW_TO)).toMatch(/canonical/i);
  });

  it("TR-23 both copies keep an example of each form", () => {
    for (const rel of [NOTES_HOW_TO, TEMPLATE_HOW_TO]) {
      const src = read(rel);
      expect(src).toContain(H3);
      expect(src).toContain(CF);
    }
  });
});

// ── TR-24 — story-validator-v2, the third transitive consumer ───────────────
describe("story-validator-v2 — inherits the broadening through planner-utils", () => {
  it("TR-24 reports no missing_create_directive gap for a heading-form-only story", async () => {
    const result = await validateStoryOn(HEADING_ONLY);
    const createGaps = (result.gaps || []).filter((g) => g.status === "missing_create_directive");
    expect(createGaps).toEqual([]);
  });
});
