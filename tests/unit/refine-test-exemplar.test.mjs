import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool, runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

describe("refine test exemplar injection", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_exemplar");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "tests/unit"));
    ensureDir(path.join(projectRoot, "packages/mcp-rks/src/server"));

    // Create an existing source file (edit target)
    writeFile(
      path.join(projectRoot, "packages/mcp-rks/src/server/exec.mjs"),
      'export function runExecTool() { return { ok: true }; }\n'
    );

    // Create an existing test file (exemplar candidate)
    writeFile(
      path.join(projectRoot, "tests/unit/exec-rollback.test.mjs"),
      `import { describe, it, expect } from "vitest";

describe("exec rollback", () => {
  it("rolls back on failure", () => {
    const result = { ok: false, rolledBack: true };
    expect(result.rolledBack).toBe(true);
  });

  it("preserves files on success", () => {
    expect(true).toBe(true);
  });
});
`
    );
  });

  it("suggests add_test_exemplar for CREATE FILE test targets", async () => {
    const story = `---
id: test-story
status: not-implemented
targetFiles:
  - path: "packages/mcp-rks/src/server/exec.mjs"
    op: "edit"
    desc: "Modify exec"
  - path: "tests/unit/exec-new-feature.test.mjs"
    op: "create"
    desc: "New test file"
---

## Acceptance Criteria
- [ ] Feature works correctly
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-story" });

    expect(result.ok).toBe(true);
    const exemplarSuggestion = result.suggestions.find(s => s.type === "add_test_exemplar");
    expect(exemplarSuggestion).toBeDefined();
    expect(exemplarSuggestion.priority).toBe("high");
    expect(exemplarSuggestion.file).toBe("tests/unit/exec-new-feature.test.mjs");
  });

  it("does NOT suggest test exemplar when no CREATE FILE test targets", async () => {
    const story = `---
id: test-story-edit-only
status: not-implemented
targetFiles:
  - path: "packages/mcp-rks/src/server/exec.mjs"
    op: "edit"
    desc: "Modify exec"
---

## Acceptance Criteria
- [ ] Feature works correctly
`;
    writeFile(path.join(projectRoot, "notes", "test-story-edit-only.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-story-edit-only" });

    expect(result.ok).toBe(true);
    const exemplarSuggestion = result.suggestions.find(s => s.type === "add_test_exemplar");
    expect(exemplarSuggestion).toBeUndefined();
  });

  it("apply injects exemplar test content into story body", async () => {
    const story = `---
id: test-story-apply
status: not-implemented
targetFiles:
  - path: "packages/mcp-rks/src/server/exec.mjs"
    op: "edit"
    desc: "Modify exec"
  - path: "tests/unit/exec-new-feature.test.mjs"
    op: "create"
    desc: "New test file"
---

## Acceptance Criteria
- [ ] Feature works correctly
`;
    writeFile(path.join(projectRoot, "notes", "test-story-apply.md"), story);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-story-apply",
      refinements: [
        {
          type: "add_test_exemplar",
          editTargetDirs: ["packages/mcp-rks/src/server"],
        },
      ],
    });

    expect(result.ok).toBe(true);

    // Read the updated story
    const updated = fs.readFileSync(
      path.join(projectRoot, "notes", "test-story-apply.md"),
      "utf8"
    );
    expect(updated).toContain("### Test Exemplar:");
    expect(updated).toContain("import { describe, it, expect }");
    expect(updated).toContain("expect(result.rolledBack).toBe(true)");
  });

  it("skips injection when exemplar already present", async () => {
    const story = `---
id: test-story-skip
status: not-implemented
targetFiles:
  - path: "tests/unit/exec-new.test.mjs"
    op: "create"
    desc: "New test file"
---

## Acceptance Criteria
- [ ] Feature works

### Test Exemplar: tests/unit/exec-rollback.test.mjs

Already has an exemplar.
`;
    // backlog.fix.build-governor-self-heal: the section must name the exemplar that would ACTUALLY
    // be chosen (exec-rollback.test.mjs — the only test file on disk in this fixture). The dedup is
    // now effect-aware: it skips only when writing would genuinely change nothing. The old fixture
    // named a file that does not exist, so under the old bare-header check ANY exemplar suppressed
    // the injection — which is exactly the bug: a story could never be given the exemplar it was
    // missing, and the caller was told "success, go re-plan" anyway.
    writeFile(path.join(projectRoot, "notes", "test-story-skip.md"), story);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-story-skip",
      refinements: [{ type: "add_test_exemplar", editTargetDirs: [] }],
    });

    // backlog.fix.build-governor-self-heal: a refinement that changes NOTHING no longer reports
    // success. It used to return ok:true AND `requiredNext: rks_plan` — "success, now go re-plan" an
    // unchanged story — which is the infinite loop this story exists to break.
    expect(result.ok).toBe(false);
    expect(result.status).toBe("refine_noop");
    expect(result.requiredNext).toBeUndefined();
    const applied = result.applied.find(a => a.type === "add_test_exemplar");
    expect(applied.result).toContain("skipped");
  });
});
