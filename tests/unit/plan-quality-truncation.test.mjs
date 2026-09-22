/**
 * Tests for plan-quality truncation detection — verifies that reviewPlan()
 * returns an error when create_file or search_replace content contains RAG
 * omission markers, and passes cleanly when no markers are present.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

let reviewPlan;
beforeAll(async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/server/plan-quality.mjs"));
  reviewPlan = mod.reviewPlan;
});

function makePlan(steps) {
  return { steps };
}

describe("plan-quality — truncation detection", () => {
  it("returns error-severity issue when create_file content contains truncation marker", async () => {
    const plan = makePlan([
      {
        action: "create_file",
        path: "src/service.ts",
        content: "export class Foo {\n  // ... (799 lines omitted) ...\n}\n",
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    const truncationIssues = result.errors.filter(i => i.type === "truncated_content");
    expect(truncationIssues).toHaveLength(1);
    expect(truncationIssues[0].severity).toBe("error");
    expect(truncationIssues[0].step).toBe("create_file");
    expect(truncationIssues[0].file).toBe("src/service.ts");
  });

  it("returns error-severity issue when search_replace replace contains truncation marker", async () => {
    const plan = makePlan([
      {
        action: "search_replace",
        path: "src/modal.tsx",
        edits: [
          {
            search: "export function Modal() {",
            replace: "export function Modal() {\n  // ... (147 lines omitted) ...\n",
          },
        ],
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    const truncationIssues = result.errors.filter(i => i.type === "truncated_content");
    expect(truncationIssues).toHaveLength(1);
    expect(truncationIssues[0].severity).toBe("error");
    expect(truncationIssues[0].step).toBe("search_replace");
    expect(truncationIssues[0].file).toBe("src/modal.tsx");
  });

  it("error issue includes type, severity, step, and file fields", async () => {
    const plan = makePlan([
      {
        action: "create_file",
        path: "src/broken.ts",
        content: "// ... (42 lines omitted) ...",
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    const issue = result.errors.find(i => i.type === "truncated_content");
    expect(issue).toBeDefined();
    expect(issue.type).toBe("truncated_content");
    expect(issue.severity).toBe("error");
    expect(issue.step).toBeDefined();
    expect(issue.file).toBeDefined();
  });

  it("returns no truncation issues for create_file content with no truncation markers", async () => {
    const plan = makePlan([
      {
        action: "create_file",
        path: "src/clean.ts",
        content: "export const x = 1;\n",
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    const truncationIssues = result.errors.filter(i => i.type === "truncated_content");
    expect(truncationIssues).toHaveLength(0);
  });

  it("returns no truncation issues for search_replace replace content with no truncation markers", async () => {
    const plan = makePlan([
      {
        action: "search_replace",
        path: "src/clean.ts",
        edits: [
          {
            search: "const x = 1;",
            replace: "const x = 2;",
          },
        ],
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    const truncationIssues = result.errors.filter(i => i.type === "truncated_content");
    expect(truncationIssues).toHaveLength(0);
  });

  it("reviewPlan ok is false when a truncated create_file step is present", async () => {
    const plan = makePlan([
      {
        action: "create_file",
        path: "src/service.ts",
        content: "// ... (1 lines omitted) ...",
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    expect(result.ok).toBe(false);
  });

  it("reviewPlan does not surface truncation issues when all plan steps contain clean content", async () => {
    const plan = makePlan([
      {
        action: "create_file",
        path: "src/a.ts",
        content: "export const a = true;",
      },
      {
        action: "search_replace",
        path: "src/b.ts",
        edits: [{ search: "old", replace: "new" }],
      },
    ]);
    const result = await reviewPlan({ projectRoot: ROOT, plan });
    const truncationIssues = result.errors.filter(i => i.type === "truncated_content");
    expect(truncationIssues).toHaveLength(0);
  });
});
