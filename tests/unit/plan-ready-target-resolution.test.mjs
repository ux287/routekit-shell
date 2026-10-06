/**
 * Witness for backlog.fix.plan-ready-targetfiles-path-offset-revalidation.
 *
 * `plan_ready` already checked target existence, so the defect was never "no validation".
 * It was misdiagnosis: `resolveTargets` sat imported and dead, and a frontmatter `op: edit`
 * target whose path no longer resolved was reported as `missing_create_directive` — whose
 * suggestion ("add // CREATE FILE:") would turn a typo'd or moved path into a newly created
 * empty file rather than surfacing the stale reference.
 *
 * THE TRAP this file exists to avoid: asserting only `result.ready === false` PASSES against
 * unfixed code, because a dead op:edit path already blocked — just under the wrong identity.
 * Every assertion below is on the finding's IDENTITY and SUGGESTION, never on readiness alone.
 *
 * Pure filesystem. No subprocess spawns.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

function makeTempProject(storyContent, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-target-resolution-"));
  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "backlog.test-story.md"), storyContent);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const run = (projectRoot) =>
  runPlanReadyTool({ projectId: "test", problemId: "backlog.test-story", projectRoot });

const story = (targetFilesYaml, body = "## Problem\nSomething.\n\n## Telemetry\nNone.\n") =>
  `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
${targetFilesYaml}
testRequirements:
  - "Test something"
---
${body}`;

describe("plan_ready re-resolves frontmatter targetFiles", async () => {
  let projectRoot;
  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("diagnoses a dead op:edit path as stale_target_path with a non-creating suggestion", async () => {
    // Defect-present: check === "missing_create_directive", suggestion 'Add "// CREATE FILE:
    // src/gone.mjs" to story body'. `result.ready` was ALREADY false, which is why a
    // readiness-only assertion proves nothing here.
    projectRoot = makeTempProject(story('  - path: "src/gone.mjs"\n    op: "edit"'));
    const result = await run(projectRoot);

    expect(result.issues.filter((i) => i.check === "missing_create_directive")).toHaveLength(0);
    const stale = result.issues.filter((i) => i.check === "stale_target_path");
    expect(stale).toHaveLength(1);
    expect(stale[0].file).toBe("src/gone.mjs");
    expect(stale[0].suggestion).not.toMatch(/^Add "\/\/ CREATE FILE:/);
    // The directive is named only to FORBID it — that prohibition is the point.
    expect(stale[0].suggestion).toContain("Do NOT add");
  });

  it("does NOT flag an op:create target for non-existence", async () => {
    // Negative control. A create target is SUPPOSED to be absent; flagging it would wedge
    // every greenfield story. This is the assertion a flag-everything implementation fails.
    projectRoot = makeTempProject(
      story('  - path: "src/brand-new.mjs"\n    op: "create"', [
        "## Problem",
        "Something.",
        "",
        "// CREATE FILE: src/brand-new.mjs",
        "",
        "```javascript",
        "export const x = 1;",
        "```",
        "",
        "## Telemetry",
        "None.",
      ].join("\n")),
    );
    const result = await run(projectRoot);
    expect(result.issues.filter((i) => i.check === "stale_target_path")).toHaveLength(0);
  });

  it("does NOT flag an absent path covered by a body CREATE FILE directive", async () => {
    // Second negative control: op is edit, but the body declares the file will be created.
    // The directive-overrides-op precedence must survive.
    projectRoot = makeTempProject(
      story('  - path: "src/from-body.mjs"\n    op: "edit"', [
        "## Problem",
        "Something.",
        "",
        "// CREATE FILE: src/from-body.mjs",
        "",
        "```javascript",
        "export const y = 2;",
        "```",
        "",
        "## Telemetry",
        "None.",
      ].join("\n")),
    );
    const result = await run(projectRoot);
    expect(result.issues.filter((i) => i.check === "stale_target_path")).toHaveLength(0);
  });

  it("warns when an op:create target already exists", async () => {
    // Defect-present: silence. resolveTargets computed 'CREATE but file exists', but the
    // existence loop only entered its branch when the file was ABSENT, so the collision
    // fell through unreported. A warning, so nothing that passes today is newly blocked.
    projectRoot = makeTempProject(
      story('  - path: "src/already-here.mjs"\n    op: "create"'),
      { "src/already-here.mjs": "export const z = 3;\n" },
    );
    const result = await run(projectRoot);
    const w = result.warnings.filter((x) => x.check === "create_target_exists");
    expect(w).toHaveLength(1);
    expect(w[0].file).toBe("src/already-here.mjs");
    expect(result.issues.filter((i) => i.check === "create_target_exists")).toHaveLength(0);
  });

  it("reports the resolution that was performed, not just its result", async () => {
    // Without this a caller cannot tell "all targets resolved and were fine" from "no
    // targets were resolved at all" — both present as an absence of issues.
    projectRoot = makeTempProject(
      story('  - path: "src/here.mjs"\n    op: "edit"'),
      { "src/here.mjs": "export const a = 1;\n" },
    );
    const result = await run(projectRoot);
    expect(result.targetResolution).toBeDefined();
    expect(result.targetResolution.checked).toBe(1);
    expect(result.targetResolution.stale).toEqual([]);
    expect(result.targetResolution.createCollisions).toEqual([]);
  });
});

describe("desc_cites_line_offset — content-keyed anchors over line numbers", async () => {
  let projectRoot;
  afterEach(() => {
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("warns on a desc citing a line offset, WITHOUT range-checking it", async () => {
    // THE DECIDING CASE. Every recorded instance of this drift cited an offset that was
    // still IN RANGE for its file — one cited :1058-1067 where the real emission was
    // :1118-1119, in a file well over 1118 lines. A range-check implementation returns
    // clean here and fails this test. The file below is 3 lines; the desc cites :1118.
    projectRoot = makeTempProject(
      story('  - path: "src/short.mjs"\n    op: "edit"\n    desc: "fix the emission at :1118-1119"'),
      { "src/short.mjs": "a\nb\nc\n" },
    );
    const result = await run(projectRoot);
    const w = result.warnings.filter((x) => x.check === "desc_cites_line_offset");
    expect(w).toHaveLength(1);
    expect(w[0].file).toBe("src/short.mjs");
    expect(w[0].suggestion).toMatch(/anchor/i);
  });

  it("does not warn on a desc using a content-keyed anchor", async () => {
    // Negative control against a flag-everything implementation.
    projectRoot = makeTempProject(
      story('  - path: "src/short.mjs"\n    op: "edit"\n    desc: "anchor on the phrase This is the only permitted writer of"'),
      { "src/short.mjs": "a\nb\nc\n" },
    );
    const result = await run(projectRoot);
    expect(result.warnings.filter((x) => x.check === "desc_cites_line_offset")).toHaveLength(0);
  });

  it("never blocks readiness on an offset citation", async () => {
    // It is a warning by design: the check cannot prove an offset is wrong, only that it is
    // unverifiable. Making it an issue would gate on a shape-based guess.
    projectRoot = makeTempProject(
      story('  - path: "src/short.mjs"\n    op: "edit"\n    desc: "see :1118"'),
      { "src/short.mjs": "a\nb\nc\n" },
    );
    const result = await run(projectRoot);
    expect(result.issues.filter((i) => i.check === "desc_cites_line_offset")).toHaveLength(0);
  });
});
