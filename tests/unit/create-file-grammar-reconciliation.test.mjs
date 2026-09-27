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
