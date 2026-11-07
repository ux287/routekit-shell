import { describe, it, expect } from "vitest";
import { foldableCreatePaths } from "../../packages/mcp-rks/src/server/planner-context.mjs";
import { isFrontmatterEditTarget } from "../../packages/mcp-rks/src/server/refine.mjs";

// backlog.fix.refine-create-file-respects-op-edit
//
// Frontmatter op:edit must be authoritative. A story's `### Target: <path>` headings and
// `// CREATE FILE: <path>` directives must NOT re-stamp an explicit op:edit target as op:create.
// Contamination (uat-calc-0629-2): op:edit targets were folded into frontmatterCreateFiles, which
// planner-persistence stamped op:create, which made the #8 incomplete_target_coverage check demand
// a create_file step for a real edit — false-rejecting an already-executable search_replace plan
// (the deps run's plan.json was status:"executable" with 3 valid search_replace steps).

describe("foldableCreatePaths — frontmatter op:edit wins at the create-file fold", () => {
  it("does NOT fold an op:edit target surfaced as a `### Target:`/`// CREATE FILE:` body path", () => {
    const editFiles = new Set(["vitest.config.base.mjs"]);
    const bodyPaths = ["vitest.config.base.mjs"]; // body create-signal for an edit target
    expect(foldableCreatePaths(bodyPaths, editFiles)).toEqual([]);
  });

  it("still folds a genuine create path (not declared op:edit)", () => {
    expect(foldableCreatePaths(["src/brand-new.ts"], new Set(["src/existing.ts"]))).toEqual([
      "src/brand-new.ts",
    ]);
  });

  it("op:edit wins on conflict; non-edit create paths pass through", () => {
    const result = foldableCreatePaths(["package.json", "src/new.ts"], new Set(["package.json"]));
    expect(result).toEqual(["src/new.ts"]);
  });

  it("reproduces the uat-calc-0629-2 deps scenario: both op:edit targets excluded → no create stamp", () => {
    // deps story: package.json + vitest.config.base.mjs both op:edit, both carry `### Target:` headings.
    // Nothing folds → frontmatterCreateFiles stays empty → both classify op:edit downstream →
    // the search_replace steps satisfy coverage → no false incomplete_target_coverage.
    const editFiles = new Set(["package.json", "vitest.config.base.mjs"]);
    expect(foldableCreatePaths(["package.json", "vitest.config.base.mjs"], editFiles)).toEqual([]);
  });

  it("accepts any iterable of body paths (e.g. Map.keys())", () => {
    const blocks = new Map([["a.ts", "x"], ["b.ts", "y"]]);
    expect(foldableCreatePaths(blocks.keys(), new Set(["a.ts"]))).toEqual(["b.ts"]);
  });

  it("folds everything when no op:edit targets are declared", () => {
    expect(foldableCreatePaths(["a.ts", "b.ts"], new Set())).toEqual(["a.ts", "b.ts"]);
  });
});

describe("isFrontmatterEditTarget — refine never injects CREATE FILE for an op:edit target", () => {
  it("returns true for explicit op:edit targets (deps shape)", () => {
    const frontmatter = `targetFiles:\n  - path: "package.json"\n    op: "edit"\n  - path: "vitest.config.base.mjs"\n    op: "edit"`;
    expect(isFrontmatterEditTarget(frontmatter, "package.json")).toBe(true);
    expect(isFrontmatterEditTarget(frontmatter, "vitest.config.base.mjs")).toBe(true);
  });

  it("returns false for an op:create target (legitimate creates stay injectable)", () => {
    const frontmatter = `targetFiles:\n  - path: "src/new.ts"\n    op: "create"`;
    expect(isFrontmatterEditTarget(frontmatter, "src/new.ts")).toBe(false);
  });

  it("returns false for a path not declared in frontmatter", () => {
    expect(isFrontmatterEditTarget(`targetFiles:\n  - path: "a.ts"\n    op: "edit"`, "b.ts")).toBe(false);
  });

  it("treats a target with no explicit op as NOT op:edit (does not over-suppress)", () => {
    expect(isFrontmatterEditTarget(`targetFiles:\n  - path: "a.ts"`, "a.ts")).toBe(false);
  });

  it("honors alternate path keys and action/edit forms", () => {
    expect(isFrontmatterEditTarget(`targetFiles:\n  - file: "a.ts"\n    action: "EDIT"`, "a.ts")).toBe(true);
    expect(isFrontmatterEditTarget(`targetFiles:\n  - target: "b.ts"\n    edit: true`, "b.ts")).toBe(true);
  });

  it("does not throw on malformed/empty frontmatter", () => {
    expect(isFrontmatterEditTarget("not: [valid", "a.ts")).toBe(false);
    expect(isFrontmatterEditTarget("", "a.ts")).toBe(false);
  });
});
