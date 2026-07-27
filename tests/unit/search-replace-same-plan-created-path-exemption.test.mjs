import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateSearchReplacePatterns as validateFromValidation } from "../../packages/mcp-rks/src/validation/search-replace.mjs";
import { validateSearchReplacePatterns as validateFromPlanner } from "../../packages/mcp-rks/src/llm/planner.mjs";
import { reviewPlan } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

// backlog.feat.search-replace-same-plan-created-path-exemption (N2 Option 1)
//
// A plan that CREATES a file and then SEARCH_REPLACE-edits it in the same plan
// must pass validation: the file does not exist on disk until apply (which runs
// create before edit and anchors against the just-written content), so the
// on-disk SEARCH-anchor validators must be EXEMPT for in-plan-created paths.
// The exemption is strictly scoped — a search_replace on a path NOT created
// in-plan must STILL fail (no over-exemption).
//
// The two validateSearchReplacePatterns functions have REVERSED signatures:
//   validation/search-replace.mjs : (plan, projectRoot, createdPaths)
//   llm/planner.mjs               : (projectRoot, plan, createdPaths)
// createdPaths is computed + passed by the central caller (planner.mjs /
// reviewPlan); these tests pass it explicitly to exercise the exemption, and the
// reviewPlan tests exercise the createdPaths-from-plan.steps computation end to end.

const NEW = "src/new-module.ts";
const MISSING = "src/does-not-exist.ts";

const createThenEdit = (editTarget) => ({
  steps: [
    { action: "create_file", path: NEW, content: "export const x = 1;\n" },
    {
      action: "search_replace",
      path: editTarget,
      edits: [{ search: "export const x = 1;", replace: "export const x = 2;" }],
    },
  ],
});

const withTmpRoot = (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-exempt-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe("same-plan-created-path exemption — validation/search-replace.mjs (plan, root, createdPaths)", () => {
  it("does NOT reject a search_replace on a path created earlier in the same plan", () => {
    withTmpRoot((root) => {
      const result = validateFromValidation(createThenEdit(NEW), root, new Set([NEW]));
      const unreadable = (result.validationErrors || []).filter((e) =>
        /unable to read file/.test(e.error || ""),
      );
      expect(unreadable).toEqual([]);
    });
  });

  it("STILL rejects a search_replace on a genuinely-missing, non-created path (no over-exemption)", () => {
    withTmpRoot((root) => {
      // edits MISSING, which no create_file produces; createdPaths only contains NEW
      const result = validateFromValidation(createThenEdit(MISSING), root, new Set([NEW]));
      const unreadable = (result.validationErrors || []).filter((e) =>
        /unable to read file/.test(e.error || ""),
      );
      expect(unreadable.length).toBeGreaterThan(0);
    });
  });
});

describe("same-plan-created-path exemption — llm/planner.mjs (root, plan, createdPaths)", () => {
  it("does NOT flag a search_replace on a same-plan-created path", () => {
    withTmpRoot((root) => {
      const res = validateFromPlanner(root, createThenEdit(NEW), new Set([NEW]));
      expect(res.needs_refinement).toBe(false);
    });
  });

  it("STILL flags a search_replace on a non-created missing path", () => {
    withTmpRoot((root) => {
      const res = validateFromPlanner(root, createThenEdit(MISSING), new Set([NEW]));
      expect(res.needs_refinement).toBe(true);
    });
  });
});

describe("same-plan-created-path exemption — plan-quality reviewPlan (computes createdPaths from plan.steps)", () => {
  it("does NOT emit target_file_not_found for a same-plan-created path", async () => {
    await withTmpRoot(async (root) => {
      const { errors } = await reviewPlan({ projectRoot: root, plan: createThenEdit(NEW) });
      const notFound = (errors || []).filter(
        (i) => i.check === "target_file_not_found" && i.file === NEW,
      );
      expect(notFound).toEqual([]);
    });
  });

  it("STILL emits target_file_not_found for a non-created missing path", async () => {
    await withTmpRoot(async (root) => {
      const plan = {
        steps: [
          { action: "search_replace", path: MISSING, edits: [{ search: "a", replace: "b" }] },
        ],
      };
      const { errors } = await reviewPlan({ projectRoot: root, plan });
      const notFound = (errors || []).filter(
        (i) => i.check === "target_file_not_found" && i.file === MISSING,
      );
      expect(notFound.length).toBeGreaterThan(0);
    });
  });
});
