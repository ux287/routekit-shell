import { describe, it, expect } from "vitest";
import { classifyPlanStatus } from "../packages/mcp-rks/src/server.mjs";

describe("classifyPlanStatus", () => {
  it("treats note-only steps as needs_refinement", () => {
    // Note steps indicate unresolved issues that need refinement
    const status = classifyPlanStatus({
      llmStatus: "note_only",
      steps: [{ action: "note", content: "just a note" }],
    });
    expect(status).toBe("needs_refinement");
  });

  it("treats create_file with non-empty content as executable", () => {
    const status = classifyPlanStatus({
      llmStatus: "note_only",
      steps: [
        {
          action: "create_file",
          path: "notes/hello-apply.md",
          content: "Hello from apply\n",
        },
      ],
    });
    expect(status).toBe("executable");
  });

  it("remains error if llmStatus is error", () => {
    const status = classifyPlanStatus({
      llmStatus: "error",
      steps: [
        {
          action: "create_file",
          path: "notes/hello-apply.md",
          content: "Hello from apply\n",
        },
      ],
    });
    expect(status).toBe("error");
  });

  it("remains note_only when executable content is empty", () => {
    const status = classifyPlanStatus({
      llmStatus: "note_only",
      steps: [
        {
          action: "create_file",
          path: "notes/hello-apply.md",
          content: "",
        },
      ],
    });
    expect(status).toBe("note_only");
  });

  it("treats README.md edit with content as executable", () => {
    const status = classifyPlanStatus({
      llmStatus: "note_only",
      steps: [
        {
          action: "edit_file",
          path: "README.md",
          content: "Add plan/apply overview",
        },
      ],
    });
    expect(status).toBe("executable");
  });
});
