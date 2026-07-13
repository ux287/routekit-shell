/**
 * Tests for planner-decomposed-gate — verifies that rks_plan (planProblem)
 * returns a story_decomposed error when the story phase is 'decomposed',
 * and proceeds normally for other phases.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// Mock the RAG tools chain so beforeAll dynamic import of planner.mjs does not
// transitively load @xenova/transformers + onnxruntime-node. See
// research.2026.05.13.slow-test-hook-inventory.md.
vi.mock("../../packages/mcp-rks/src/rag/tools.mjs", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

// Dynamically import planProblem — it's the entry point for rks_plan
let planProblem;
beforeAll(async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"));
  planProblem = mod.planProblem;
});

/**
 * Write a minimal story note to a temp directory and return the temp dir + note path.
 */
function writeTempStory(tmpDir, storyId, frontmatter) {
  const noteDir = path.join(tmpDir, "notes");
  fs.mkdirSync(noteDir, { recursive: true });
  const filename = storyId.replace(/\./g, ".") + ".md";
  const notePath = path.join(noteDir, filename);
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${i}`).join("\n")}`;
      return `${k}: "${v}"`;
    })
    .join("\n");
  fs.writeFileSync(notePath, `---\n${fm}\n---\n\n## Problem\n\nTest story.\n`);
  return notePath;
}

describe("planner decomposed-gate — behavioral", () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-gate-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns { ok: false, error: 'story_decomposed' } when phase is decomposed", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-decomposed", {
      id: "backlog.feat.test-decomposed",
      phase: "decomposed",
      status: "not-implemented",
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-decomposed");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("story_decomposed");
  });

  it("includes childStories from frontmatter children field when present", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-decomposed-children", {
      id: "backlog.feat.test-decomposed-children",
      phase: "decomposed",
      status: "not-implemented",
      children: ["backlog.feat.test-decomposed-children.child-1", "backlog.feat.test-decomposed-children.child-2"],
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-decomposed-children");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("story_decomposed");
    expect(result.childStories).toEqual([
      "backlog.feat.test-decomposed-children.child-1",
      "backlog.feat.test-decomposed-children.child-2",
    ]);
  });

  it("includes childStories as empty array when frontmatter has no children field", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-decomposed-nochildren", {
      id: "backlog.feat.test-decomposed-nochildren",
      phase: "decomposed",
      status: "not-implemented",
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-decomposed-nochildren");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("story_decomposed");
    expect(Array.isArray(result.childStories)).toBe(true);
    expect(result.childStories).toHaveLength(0);
  });

  it("includes a human-readable message directing caller to build child stories", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-decomposed-msg", {
      id: "backlog.feat.test-decomposed-msg",
      phase: "decomposed",
      status: "not-implemented",
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-decomposed-msg");
    expect(result.message).toBeTruthy();
    expect(result.message).toMatch(/child|decomposed/i);
  });

  it("proceeds normally (does not return story_decomposed) when phase is draft", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-draft", {
      id: "backlog.feat.test-draft",
      phase: "draft",
      status: "not-implemented",
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-draft");
    // Should not return story_decomposed — may return ok or an LLM error, but not this gate
    expect(result.error).not.toBe("story_decomposed");
  });

  it("proceeds normally (does not return story_decomposed) when phase is ready", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-ready", {
      id: "backlog.feat.test-ready",
      phase: "ready",
      status: "not-implemented",
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-ready");
    expect(result.error).not.toBe("story_decomposed");
  });

  it("proceeds normally (does not return story_decomposed) when phase is planning", async () => {
    writeTempStory(tmpDir, "backlog.feat.test-planning", {
      id: "backlog.feat.test-planning",
      phase: "planning",
      status: "not-implemented",
    });
    const result = await planProblem(tmpDir, "backlog.feat.test-planning");
    expect(result.error).not.toBe("story_decomposed");
  });
});

describe("planner decomposed-gate — source check", () => {
  it("gate appears before any RAG or LLM invocation in planner.mjs source", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"),
      "utf8"
    );
    const gateIdx = src.indexOf("story_decomposed");
    // Find the invocation of runLlmPlanner, not the import declaration
    const llmInvokeIdx = src.indexOf("await runLlmPlanner(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(llmInvokeIdx).toBeGreaterThan(-1);
    // Gate must appear before the LLM invocation
    expect(gateIdx).toBeLessThan(llmInvokeIdx);
  });

  it("gate checks frontmatter.phase === 'decomposed'", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"),
      "utf8"
    );
    expect(src).toMatch(/frontmatter\.phase.*decomposed|phase.*===.*decomposed/);
  });
});
