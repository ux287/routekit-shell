/**
 * Tests for plan-ready.mjs — frontmatter op:create satisfies create directive check
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

function makeTempProject(storyContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-plan-ready-create-test-"));
  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "backlog.test-story.md"), storyContent);
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
}

describe("plan-ready: frontmatter op:create satisfies create directive check", () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
  });

  it("story with op:create in frontmatter targetFiles and no body directive passes", async () => {
    projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "create"
testRequirements:
  - "Test that new-file.mjs is created correctly"
---
## Problem
Need a new file.

## Telemetry
None.
`);
    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.test-story",
      projectRoot,
    });
    const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
    expect(createIssues).toHaveLength(0);

    // ADDED (backlog.fix.plan-ready-create-target-requires-code-block): the directive check
    // above is satisfied, but there is no fenced block, so the NEW check must fire and the
    // story must not be plannable. The assertion above is left verbatim on purpose — it is
    // the regression witness for missing_create_directive and must keep passing unchanged.
    const blockIssues = result.issues.filter(i => i.check === "create_target_no_authorable_block");
    expect(blockIssues).toHaveLength(1);
    expect(blockIssues[0].file).toBe("src/new-file.mjs");
    expect(result.ready).toBe(false);
  });

  it("story with op:create in frontmatter AND body CREATE FILE directive passes (no regression)", async () => {
    projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "create"
testRequirements:
  - "Test that new-file.mjs is created correctly"
---
## Problem
Need a new file.

// CREATE FILE: src/new-file.mjs

## Telemetry
None.
`);
    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.test-story",
      projectRoot,
    });
    const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
    expect(createIssues).toHaveLength(0);

    // ADDED: a directive WITH no fence is the exact shape that reaches the planner and dies
    // with failureClass "structural" / refinable:false. Caught here instead.
    expect(result.issues.filter(i => i.check === "create_target_no_authorable_block")).toHaveLength(1);
    expect(result.ready).toBe(false);
  });

  it("non-existent target with op:edit and no body directive produces missing_create_directive", async () => {
    projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "edit"
testRequirements:
  - "Test something"
---
## Problem
Something.

## Telemetry
None.
`);
    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.test-story",
      projectRoot,
    });
    const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
    expect(createIssues.length).toBeGreaterThan(0);

    // ADDED — no-collateral witness. This target has NO directive, so it never enters the
    // hasDirective arm and the new check must stay silent. If the new push were nested in
    // the wrong branch, or replaced missing_create_directive rather than sitting beside it,
    // this goes red.
    expect(result.issues.filter(i => i.check === "create_target_no_authorable_block")).toHaveLength(0);
  });

  it("non-existent target with body CREATE FILE directive only (no frontmatter op:create) passes", async () => {
    projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "edit"
testRequirements:
  - "Test something"
---
## Problem
Something.

// CREATE FILE: src/new-file.mjs

## Telemetry
None.
`);
    const result = await runPlanReadyTool({
      projectId: "test",
      problemId: "backlog.test-story",
      projectRoot,
    });
    const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
    expect(createIssues).toHaveLength(0);

    // ADDED: body-directive-only, still no fence.
    expect(result.issues.filter(i => i.check === "create_target_no_authorable_block")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// backlog.fix.plan-ready-create-target-requires-code-block
//
// A `// CREATE FILE:` directive tells the planner a file WILL exist. It does not tell it
// what to put in the file. The planner binds its create_file step from the fenced block
// that follows; with no block it falls through to the LLM, and when that returns nothing
// usable the failure is `failureClass: "structural"` with `refinable: false` — unrecoverable,
// and discovered only after a full LLM pass. This gate catches it before any planner spawn.
//
// It failed four times in a real child project across two stories and two rks versions.
// ---------------------------------------------------------------------------
describe("plan-ready: create targets require an authorable code block", () => {
  let projectRoot;
  afterEach(() => { if (projectRoot) cleanup(projectRoot); });

  const NEW_CHECK = "create_target_no_authorable_block";
  const blocksOf = (result) => result.issues.filter(i => i.check === NEW_CHECK);

  const story = (targets, bodyTail) => `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
${targets}
testRequirements:
  - "Test something"
---
## Problem
Something.

${bodyTail}

## Telemetry
None.
`;

  const CREATE_MJS = `  - path: "src/new-thing.mjs"
    op: "create"`;

  async function ready(content) {
    projectRoot = makeTempProject(content);
    return runPlanReadyTool({ projectId: "test", problemId: "backlog.test-story", projectRoot });
  }

  it("REJECTS a fence containing only a placeholder — a fence is necessary, not sufficient", async () => {
    // The load-bearing case. If a TODO fence satisfied the gate, the failure would simply
    // move from planning to build — later and more expensive. Mutation: replace the
    // isSynthesizedBody() call with a bare non-empty check and this goes green.
    const result = await ready(story(CREATE_MJS, [
      "// CREATE FILE: src/new-thing.mjs",
      "```js",
      "// TODO: implement this",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(1);
    expect(result.ready).toBe(false);
  });

  it("REJECTS prose narration in a code file", async () => {
    const result = await ready(story(CREATE_MJS, [
      "// CREATE FILE: src/new-thing.mjs",
      "```",
      "Create a module that handles the four arithmetic operations and exposes them.",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(1);
  });

  it("ACCEPTS prose in a prose-exempt file — doc and config creates are not over-blocked", async () => {
    // PROSE_EXEMPT_EXTS covers md/json/yml/... Blocking these would wedge legitimate
    // documentation and config stories, which is the opposite of the intent.
    const result = await ready(story(`  - path: "docs/new-guide.md"
    op: "create"`, [
      "// CREATE FILE: docs/new-guide.md",
      "```markdown",
      "# New Guide",
      "",
      "This guide explains how the thing works.",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(0);
  });

  it("ACCEPTS binding form A — // CREATE FILE: directive followed by a fence", async () => {
    const result = await ready(story(CREATE_MJS, [
      "// CREATE FILE: src/new-thing.mjs",
      "```js",
      "export function newThing() { return 42; }",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(0);
  });

  it("ACCEPTS binding form B — ### Target: heading followed by a fence", async () => {
    const result = await ready(story(CREATE_MJS, [
      "### Target: src/new-thing.mjs",
      "```js",
      "export function newThing() { return 42; }",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(0);
  });

  it("ACCEPTS binding form C — ## Implementation section block", async () => {
    const result = await ready(story(CREATE_MJS, [
      "## Implementation",
      "",
      "### src/new-thing.mjs (CREATE FILE)",
      "```js",
      "export function newThing() { return 42; }",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(0);
  });

  it("matches the block path SUFFIX-TOLERANTLY, exactly as the directive check does", async () => {
    // The extractors key on the path as written in the BODY; the directive check above is
    // suffix-tolerant. A strict `blocks.has(target)` would falsely block this story — a
    // false positive that wedges projects harder than the bug this gate catches.
    // Mutation: swap the key scan for createFileBlocks.has(target) and this goes red.
    const result = await ready(story(`  - path: "packages/app/src/new-thing.mjs"
    op: "create"`, [
      "// CREATE FILE: src/new-thing.mjs",
      "```js",
      "export function newThing() { return 42; }",
      "```",
    ].join("\n")));

    expect(blocksOf(result)).toHaveLength(0);
  });

  it("names EVERY uncovered create target, not just the first", async () => {
    const result = await ready(story(`  - path: "src/one.mjs"
    op: "create"
  - path: "src/two.mjs"
    op: "create"`, [
      "// CREATE FILE: src/one.mjs",
      "// CREATE FILE: src/two.mjs",
    ].join("\n")));

    const files = blocksOf(result).map(i => i.file).sort();
    expect(files).toEqual(["src/one.mjs", "src/two.mjs"]);
  });

  it("does not touch op:edit targets against files that exist", async () => {
    projectRoot = makeTempProject(story(`  - path: "src/existing.mjs"
    op: "edit"`, "Nothing to create here."));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "existing.mjs"), "export const a = 1;\n");

    const result = await runPlanReadyTool({
      projectId: "test", problemId: "backlog.test-story", projectRoot,
    });

    expect(blocksOf(result)).toHaveLength(0);
  });
});
