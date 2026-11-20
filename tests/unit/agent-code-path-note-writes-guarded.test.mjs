import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import * as governorToken from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { createCycleCompleteAgent } from "../../packages/mcp-rks/src/agents/cycle-complete.mjs";
import { createStoryAgent } from "../../packages/mcp-rks/src/agents/story.mjs";
import { createResearchAgent } from "../../packages/mcp-rks/src/agents/research.mjs";
import { createDeliveryAgent } from "../../packages/mcp-rks/src/agents/delivery.mjs";
import { createProductOwnerAgent } from "../../packages/mcp-rks/src/agents/product-owner.mjs";
import { createPlannerAgent } from "../../packages/mcp-rks/src/agents/planner.mjs";

// backlog.feat.agent-code-path-note-writes-guarded
const h = vi.hoisted(() => ({ captured: [], advanced: [] }));
vi.mock("@routekit/rag/tools");
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runAgent: vi.fn(async (config) => { h.captured.push(config); return { ok: true }; }),
}));
vi.mock("../../packages/mcp-rks/src/workflow/auto-phase.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  advancePhase: vi.fn(async (...args) => { h.advanced.push(args); return { ok: true }; }),
}));
// ARCH Guidance (tests 9 and 10): the research agent is exempt, so forwarding is observed at the factory
// boundary. The wrappers delegate to the originals, so every other test still exercises real code.
vi.mock("../../packages/mcp-rks/src/agents/research.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, createResearchAgent: vi.fn(original.createResearchAgent) };
});
vi.mock("../../packages/mcp-rks/src/agents/product-owner.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, createProductOwnerAgent: vi.fn(original.createProductOwnerAgent) };
});

const { createSession, endSession, setProjectRoot, resetToken, checkTokenToolArgs, agentWriteGuardFor } = governorToken;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORY = "backlog.feat.s";
const EXEMPT = "backlog.feat.agent-code-path-note-writes-guarded";
const refusal = { ok: false, error: "namespace_violation", message: "test refusal" };

let tmpRoot;
let project;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acpnwg-"));
  setProjectRoot(tmpRoot);
  resetToken();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "acpnwg-proj-"));
  fs.mkdirSync(path.join(project, "notes"), { recursive: true });
  fs.mkdirSync(path.join(project, ".rks", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(project, ".rks", "project.json"), JSON.stringify({ projectId: "t", branches: { working: "staging", integration: "staging", production: "main" } }));
  h.captured.length = 0;
  h.advanced.length = 0;
  vi.mocked(createResearchAgent).mockClear();
  vi.mocked(createProductOwnerAgent).mockClear();
});
afterEach(() => {
  resetToken();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

const flow = (flowType, problemId) => createSession({ projectId: "routekit-shell-core", flowType, problemId }).token;
const tool = (agent, name) => agent.tools.find((t) => t.name === name);
const notePath = (name) => path.join(project, "notes", `${name}.md`);
const seedNote = (name, phase = "integrated", extra = "") => {
  fs.writeFileSync(notePath(name), `---\nid: "${name}"\ntitle: "t"\nphase: "${phase}"\nstatus: "shipped"\n${extra}---\n\nbody\n`);
  return fs.readFileSync(notePath(name));
};
const archivedPath = (name) => notePath(name.replace(/^backlog\./, "backlog.z_implemented."));

describe("agent code-path note writes guarded", () => {
  it("cycle-complete mark_implemented without writeGuard still archives the note", async () => {
    seedNote(STORY);
    const agent = createCycleCompleteAgent({ projectId: "t", storyId: STORY, projectRoot: project });
    const res = await tool(agent, "mark_implemented").execute({ storyId: STORY });
    expect(res.updated).toBe(true);
    expect(fs.existsSync(notePath(STORY))).toBe(false);
    expect(fs.readFileSync(archivedPath(STORY), "utf8")).toContain('status: "implemented"');
  });

  it("cycle-complete mark_implemented with a refusing writeGuard returns the refusal and leaves the note untouched", async () => {
    const before = seedNote(STORY);
    const writeGuard = vi.fn(() => refusal);
    const agent = createCycleCompleteAgent({ projectId: "t", storyId: STORY, projectRoot: project, writeGuard });
    const res = await tool(agent, "mark_implemented").execute({ storyId: STORY });
    expect(JSON.stringify(res)).toContain("test refusal");
    expect(fs.readFileSync(notePath(STORY)).equals(before)).toBe(true);
    expect(fs.existsSync(archivedPath(STORY))).toBe(false);
  });

  it("cycle-complete mark_implemented consults writeGuard for the rename before its first write", async () => {
    const before = seedNote(STORY);
    const writeGuard = vi.fn((toolName) => (toolName === "dendron_update_field" ? null : refusal));
    const agent = createCycleCompleteAgent({ projectId: "t", storyId: STORY, projectRoot: project, writeGuard });
    const res = await tool(agent, "mark_implemented").execute({ storyId: STORY });
    expect(JSON.stringify(res)).toContain("test refusal");
    expect(writeGuard).toHaveBeenCalledWith("dendron_rename_note", expect.objectContaining({ filename: STORY }));
    expect(fs.readFileSync(notePath(STORY)).equals(before)).toBe(true);
    expect(fs.existsSync(archivedPath(STORY))).toBe(false);
  });

  it("cycle-complete update_epic with a refusing writeGuard returns the refusal and leaves the epic untouched", async () => {
    // update_epic takes { storyId } only and finds the epic through the story's `epic:` frontmatter.
    seedNote(STORY, "integrated", 'epic: "e"\n');
    const epic = "backlog.epics.e";
    const before = seedNote(epic, "draft");
    const writeGuard = vi.fn(() => refusal);
    const agent = createCycleCompleteAgent({ projectId: "t", storyId: STORY, projectRoot: project, writeGuard });
    const res = await tool(agent, "update_epic").execute({ storyId: STORY });
    expect(JSON.stringify(res)).toContain("test refusal");
    expect(writeGuard).toHaveBeenCalledWith("dendron_update_field", expect.objectContaining({ filename: epic, field: "updated" }));
    expect(fs.readFileSync(notePath(epic)).equals(before)).toBe(true);
  });

  it("story advance_phase without writeGuard still calls advancePhase", async () => {
    seedNote(STORY, "ready");
    const agent = createStoryAgent({ projectId: "t", storyId: STORY, action: "advance", projectRoot: project });
    await tool(agent, "advance_phase").execute({ operation: "plan" });
    expect(h.advanced.length).toBe(1);
    expect(h.advanced[0].slice(0, 3)).toEqual([project, STORY, "plan"]);
  });

  it("story advance_phase with a refusing writeGuard returns the refusal and does not call advancePhase", async () => {
    const before = seedNote(STORY, "ready");
    const writeGuard = vi.fn(() => refusal);
    const agent = createStoryAgent({ projectId: "t", storyId: STORY, action: "advance", projectRoot: project, writeGuard });
    const res = await tool(agent, "advance_phase").execute({ operation: "plan" });
    expect(JSON.stringify(res)).toContain("test refusal");
    expect(writeGuard).toHaveBeenCalledWith("dendron_update_field", expect.objectContaining({ filename: STORY, field: "phase" }));
    expect(h.advanced.length).toBe(0);
    expect(fs.readFileSync(notePath(STORY)).equals(before)).toBe(true);
  });

  it("research write tools honour a refusing writeGuard or carry a documented exemption", async () => {
    // ARCH Decision 1: the research write tools are exempt; each write site carries the exemption.
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/agents/research.mjs"), "utf8");
    expect(src.split(EXEMPT).length - 1).toBeGreaterThanOrEqual(3);
    const writeGuard = vi.fn(() => refusal);
    const agent = createResearchAgent({ projectId: "t", query: "q", projectRoot: project, writeGuard });
    const res = await tool(agent, "dendron_create_note").execute({ filename: "design.guarded", title: "T", body: "b" });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(notePath("design.guarded"))).toBe(true);
  });

  it("research dendron_create_note of a research.* paper still writes under a story-flow agentWriteGuardFor guard", async () => {
    const agent = createResearchAgent({ projectId: "t", query: "q", projectRoot: project, writeGuard: agentWriteGuardFor(flow("story", STORY)) });
    await tool(agent, "dendron_create_note").execute({ filename: "research.2026.11.12.topic", title: "T", body: "b" });
    expect(fs.existsSync(notePath("research.2026.11.12.topic"))).toBe(true);
  });

  it("delivery forwards writeGuard to its story and cycle-complete children", async () => {
    seedNote(STORY, "ready");
    const writeGuard = vi.fn(() => refusal);
    const config = createDeliveryAgent({ projectId: "t", storyIds: [STORY], projectRoot: project, writeGuard });
    await tool(config, "validate_batch").execute({ storyIds: [STORY] });
    await tool(config, "complete_cycles").execute({ storyIds: [STORY] });
    const storyChild = h.captured.find((c) => c.tools?.some((t) => t.name === "advance_phase"));
    const cycleChild = h.captured.find((c) => c.tools?.some((t) => t.name === "mark_implemented"));
    expect(storyChild).toBeDefined();
    expect(cycleChild).toBeDefined();
    expect(JSON.stringify(await tool(storyChild, "advance_phase").execute({ operation: "plan" }))).toContain("test refusal");
    expect(JSON.stringify(await tool(cycleChild, "mark_implemented").execute({ storyId: STORY }))).toContain("test refusal");
    expect(h.advanced.length).toBe(0);
    expect(fs.existsSync(archivedPath(STORY))).toBe(false);
  });

  it("product-owner forwards writeGuard to its research delegate", async () => {
    const writeGuard = vi.fn(() => null);
    const config = createProductOwnerAgent({ projectId: "t", problemId: STORY, projectRoot: project, writeGuard });
    await tool(config, "research_codebase").execute({ query: "q" });
    expect(createResearchAgent).toHaveBeenCalledWith(expect.objectContaining({ writeGuard }));
    expect(h.captured.find((c) => c.tools?.some((t) => t.name === "dendron_create_note"))).toBeDefined();
  });

  it("planner forwards writeGuard to its research and product-owner delegates", async () => {
    const writeGuard = vi.fn(() => null);
    const config = createPlannerAgent({ projectId: "t", storyId: STORY, projectRoot: project, writeGuard });
    await tool(config, "research_architecture").execute({ query: "q" });
    expect(createResearchAgent).toHaveBeenCalledWith(expect.objectContaining({ writeGuard }));
    await tool(config, "check_story_readiness").execute({ problemId: STORY });
    expect(createProductOwnerAgent).toHaveBeenCalledWith(expect.objectContaining({ writeGuard }));
    const po = h.captured.find((c) => c.tools?.some((t) => t.name === "research_codebase"));
    expect(po).toBeDefined();
    // The product-owner child must carry the same guard into its own research delegate.
    vi.mocked(createResearchAgent).mockClear();
    await tool(po, "research_codebase").execute({ query: "q" });
    expect(createResearchAgent).toHaveBeenCalledWith(expect.objectContaining({ writeGuard }));
  });

  it("agent outcome under the real agentWriteGuardFor matches checkTokenToolArgs for an admitted and a refused call", async () => {
    const ended = flow("ops");
    endSession(ended);
    const cases = [
      { token: flow("ops"), name: "backlog.feat.admitted" },
      { token: ended, name: "backlog.feat.refused" },
    ];
    const verdicts = [];
    for (const { token, name } of cases) {
      const before = seedNote(name);
      const expected = checkTokenToolArgs(token, "dendron_update_field", { filename: name, field: "status", value: "implemented" });
      verdicts.push(expected === null);
      const agent = createCycleCompleteAgent({ projectId: "t", storyId: name, projectRoot: project, writeGuard: agentWriteGuardFor(token) });
      const res = await tool(agent, "mark_implemented").execute({ storyId: name });
      if (expected === null) {
        expect(res.updated).toBe(true);
        expect(fs.existsSync(archivedPath(name))).toBe(true);
      } else {
        expect(res).toMatchObject({ ok: false, error: expected.error });
        expect(fs.readFileSync(notePath(name)).equals(before)).toBe(true);
        expect(fs.existsSync(archivedPath(name))).toBe(false);
      }
    }
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("every note write in a registered agent is guarded or carries an exemption comment", () => {
    const WRITE = /\b(updateField|writeNoteRaw|editNote|advancePhase|fs\.writeFileSync|fs\.renameSync)\s*\(/;
    const files = ["cycle-complete.mjs", "story.mjs", "research.mjs", "dendron.mjs", "recovery.mjs"];
    let scanned = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/agents", f), "utf8");
      const writes = src.split("\n").filter((l) => WRITE.test(l) && !/^\s*(\/\/|\*)/.test(l));
      if (writes.length === 0) continue;
      scanned += 1;
      expect(/guardWrite\s*\(/.test(src) || src.includes(EXEMPT), f).toBe(true);
    }
    expect(scanned).toBeGreaterThan(0);
  });
});
