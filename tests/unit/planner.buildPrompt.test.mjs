import { describe, it, expect } from "vitest";
import { buildPrompt } from "../../packages/mcp-rks/src/llm/planner.mjs";

// buildPromptForTest is a thin export wrapper so tests can call buildPrompt directly.
// If it is not exported yet, these tests will document the expected public surface.

describe("buildPrompt — live content and story-intent labeling", () => {
  it("exports buildPromptForTest or buildPrompt", async () => {
    const mod = await import("../../packages/mcp-rks/src/llm/planner.mjs");
    const fn = mod.buildPrompt;
    expect(typeof fn).toBe("function");
  });

  it("Editable Code Targets section includes LIVE DISK CONTENT label when liveContent is present", async () => {
    const mod = await import("../../packages/mcp-rks/src/llm/planner.mjs");
    const buildPrompt = mod.buildPrompt;

    const target = {
      path: "src/foo.ts",
      summary: "(existing file)",
      ragSnippets: ["const foo = () => {};"],
      liveContent: {
        content: "export const foo = () => 42;\n",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        source: "full-file",
      },
    };

    const prompt = buildPrompt({
      requirements: "Update foo to return 99",
      editableTargets: [target],
    });

    expect(prompt).toContain("LIVE DISK CONTENT");
    expect(prompt).toContain("export const foo = () => 42;");
  });

  it("ragSnippets label de-prioritized to 'additional context' when liveContent is present", async () => {
    const mod = await import("../../packages/mcp-rks/src/llm/planner.mjs");
    const buildPrompt = mod.buildPrompt;

    const target = {
      path: "src/bar.ts",
      ragSnippets: ["const bar = () => {};"],
      liveContent: {
        content: "export const bar = () => 1;\n",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        source: "full-file",
      },
    };

    const prompt = buildPrompt({
      requirements: "Update bar",
      editableTargets: [target],
    });

    expect(prompt).toContain("prefer LIVE DISK CONTENT");
  });

  it("no liveContent — ragSnippets label remains COPY VERBATIM (not de-prioritized)", async () => {
    const mod = await import("../../packages/mcp-rks/src/llm/planner.mjs");
    const buildPrompt = mod.buildPrompt;

    const target = {
      path: "src/baz.ts",
      ragSnippets: ["const baz = () => {};"],
    };

    const prompt = buildPrompt({
      requirements: "Update baz",
      editableTargets: [target],
    });

    expect(prompt).toContain("COPY VERBATIM for search patterns - exact whitespace matters");
    // The "prefer LIVE DISK CONTENT" label is only used when liveContent is present
    expect(prompt).not.toContain("prefer LIVE DISK CONTENT");
  });

  it("AUTHORITATIVE CONTENT RULE mentions LIVE DISK CONTENT and STORY INTENT", async () => {
    const mod = await import("../../packages/mcp-rks/src/llm/planner.mjs");
    const buildPrompt = mod.buildPrompt;

    const prompt = buildPrompt({ requirements: "test" });

    expect(prompt).toContain("LIVE DISK CONTENT");
    expect(prompt).toContain("STORY INTENT");
  });

  it("SOURCE BLOCKS ARE INPUT-ONLY rule includes transcription fidelity instruction", async () => {
    const mod = await import("../../packages/mcp-rks/src/llm/planner.mjs");
    const buildPrompt = mod.buildPrompt;

    const prompt = buildPrompt({ requirements: "test" });

    expect(prompt).toContain("Transcribe the source logic exactly");
  });
});
