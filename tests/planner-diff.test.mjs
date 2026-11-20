import { describe, it, expect } from "vitest";
import {
  normalizePlannerSteps,
  classifyPlan,
} from "../packages/mcp-rks/src/llm/planner.mjs";

describe("planner diff handling", () => {
  it("rejects diff-style content and marks status error", () => {
    const parsed = { planSummary: "test", steps: [] };
    const normalized = normalizePlannerSteps([
      { action: "edit_file", path: "src/file.js", content: "@@\n-import a\n+import b\n@@" },
    ]);
    expect(normalized.diffRejected).toBe(true);
    expect(normalized.hasExecutableWithContent).toBe(false);
    const status = classifyPlan({
      parsed,
      hasExecutableWithContent: normalized.hasExecutableWithContent,
      diffRejected: normalized.diffRejected,
    });
    expect(status).toBe("error");
  });

  it("accepts full-file rewrite content", () => {
    const parsed = { planSummary: "test", steps: [] };
    const normalized = normalizePlannerSteps([
      { action: "edit_file", path: "src/file.js", content: "import a\nexport function go() {}\n" },
    ]);
    expect(normalized.diffRejected).toBe(false);
    expect(normalized.hasExecutableWithContent).toBe(true);
    const status = classifyPlan({
      parsed,
      hasExecutableWithContent: normalized.hasExecutableWithContent,
      diffRejected: normalized.diffRejected,
    });
    expect(status).toBe("executable");
  });

  it("treats empty content as note_only", () => {
    const parsed = { planSummary: "test", steps: [] };
    const normalized = normalizePlannerSteps([
      { action: "edit_file", path: "src/file.js", content: "" },
    ]);
    const status = classifyPlan({
      parsed,
      hasExecutableWithContent: normalized.hasExecutableWithContent,
      diffRejected: normalized.diffRejected,
    });
    expect(status).toBe("note_only");
  });
});

