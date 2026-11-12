import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The chain.violation requirement spies on getTelemetryCollector().emit, so this file needs the REAL
// collector rather than the suite-wide stub (tests/setup.mjs). vi.unmock is one of the sanctioned
// escapes, hoisted above the imports; escaping both specifiers keeps this file classified UN-SHADOWED
// by tests/unit/telemetry-global-mock-triage.test.mjs.
vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry";
import * as governorToken from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { createDendronAgent } from "../../packages/mcp-rks/src/agents/dendron.mjs";
import { createRecoveryAgent } from "../../packages/mcp-rks/src/agents/recovery.mjs";

const h = vi.hoisted(() => ({ captured: [] }));
vi.mock("@routekit/rag/tools");
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runAgent: vi.fn(async (config) => { h.captured.push(config); return { ok: true }; }),
}));

const { createSession, checkAllowedTool, advanceState, revertStateOnFailure, setProjectRoot, resetToken, checkTokenToolArgs } = governorToken;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKLOG = "backlog.feat.x";

let tmpRoot;
let project;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dwac-"));
  setProjectRoot(tmpRoot);
  resetToken();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "dwac-proj-"));
  fs.mkdirSync(path.join(project, "notes"), { recursive: true });
  fs.mkdirSync(path.join(project, ".rks", "prompts"), { recursive: true });
  h.captured.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  resetToken();
  // Drop any storage a delegated run bound to the temp project before that directory is removed.
  resetTelemetryCollector();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

const open = () => createSession({ projectId: "routekit-shell-core" }).token;
const flow = (flowType, problemId) => createSession({ projectId: "routekit-shell-core", flowType, problemId }).token;
const create = (token, filename) => checkAllowedTool(token, "dendron_create_note", { filename });
const guardFor = (token) => (toolName, args) => checkTokenToolArgs(token, toolName, args);
const tool = (agent, name) => agent.tools.find((t) => t.name === name);
const notePath = (name) => path.join(project, "notes", `${name}.md`);
const seedNote = (name) => {
  fs.writeFileSync(notePath(name), `---\nid: "${name}"\ntitle: "t"\nphase: "draft"\n---\n\nbody\n`);
  return fs.readFileSync(notePath(name));
};

describe("open-flow backlog create gate: traversed chain", () => {
  it("refuses a backlog.* create from a fresh open session at init", () => {
    expect(create(open(), BACKLOG)).toMatchObject({ ok: false, error: "namespace_violation" });
  });

  it("refuses a backlog.* create after init -> research.* create -> writing", () => {
    const token = open();
    expect(create(token, "research.topic")).toBeNull();
    expect(advanceState(token, "dendron_create_note")).toMatchObject({ newState: "writing" });
    expect(create(token, BACKLOG)).toMatchObject({ ok: false, error: "namespace_violation" });
  });

  it("refuses a backlog.* create after init -> dendron_edit_note -> writing", () => {
    const token = open();
    expect(advanceState(token, "dendron_edit_note")).toMatchObject({ newState: "writing" });
    expect(create(token, BACKLOG)).toMatchObject({ ok: false, error: "namespace_violation" });
  });

  it("admits a backlog.* create in test-file-scanning and in writing after the PO research traversal", () => {
    const token = open();
    for (let i = 0; i < 3; i++) advanceState(token, "rks_agent_research");
    expect(create(token, BACKLOG)).toBeNull();
    advanceState(token, "rks_agent_research");
    expect(create(token, BACKLOG)).toBeNull();
  });

  it("still refuses backlog.* from researching and concern-separating and admits research, design and notes creates from init, researching and concern-separating", () => {
    for (const steps of [0, 1, 2]) {
      const token = open();
      for (let i = 0; i < steps; i++) advanceState(token, "rks_agent_research");
      for (const filename of ["research.2026.11.12.topic", "design.topic", "notes.topic"]) {
        expect(create(token, filename), `${steps} ${filename}`).toBeNull();
      }
      if (steps > 0) expect(create(token, BACKLOG), String(steps)).toMatchObject({ ok: false, error: "namespace_violation" });
    }
  });

  it("admits edit, update_field and update_fields on a backlog.* note from open init", () => {
    const token = open();
    expect(checkAllowedTool(token, "dendron_edit_note", { filename: BACKLOG })).toBeNull();
    expect(checkAllowedTool(token, "dendron_update_field", { filename: BACKLOG, field: "desc", value: "x" })).toBeNull();
    expect(checkAllowedTool(token, "dendron_update_fields", { filename: BACKLOG, fields: { desc: "x" } })).toBeNull();
  });

  it("refuses a backlog.* create after the entry transition into test-file-scanning is reverted", () => {
    const token = open();
    advanceState(token, "rks_agent_research");
    advanceState(token, "rks_agent_research");
    const entry = advanceState(token, "rks_agent_research");
    revertStateOnFailure(token, entry);
    expect(create(token, BACKLOG)).toMatchObject({ ok: false, error: "namespace_violation" });
  });

  it("arg refusals emit chain.violation with violationKind namespace or proto_story_guard, never state_machine", () => {
    const emit = vi.spyOn(getTelemetryCollector(), "emit");
    const story = flow("story", "backlog.feat.example-story");
    create(open(), BACKLOG);
    checkTokenToolArgs(story, "dendron_create_note", { filename: "research.topic" });
    checkTokenToolArgs(story, "dendron_update_field", { filename: "backlog.feat.example-story", field: "phase", value: "ready" });
    const kinds = emit.mock.calls.filter((c) => c[0] === "chain.violation").map((c) => c[2].violationKind);
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    for (const k of kinds) expect(["namespace", "proto_story_guard"]).toContain(k);
    expect(kinds).not.toContain("state_machine");
  });
});

describe("dendron agent writeGuard", () => {
  it("story-flow guard refuses dendron_create on research.topic and writes no file", async () => {
    const agent = createDendronAgent({ projectId: "t", request: "r", projectRoot: project, writeGuard: guardFor(flow("story", "backlog.feat.s")) });
    const res = await tool(agent, "dendron_create").execute({ filename: "research.topic" });
    expect(JSON.stringify(res)).toContain("namespace_violation");
    expect(fs.existsSync(notePath("research.topic"))).toBe(false);
  });

  it("story-flow guard refuses phase ready with proto_story_guard and leaves the note unchanged", async () => {
    const before = seedNote("backlog.feat.s");
    const agent = createDendronAgent({ projectId: "t", request: "r", projectRoot: project, writeGuard: guardFor(flow("story", "backlog.feat.s")) });
    const res = await tool(agent, "dendron_update_field").execute({ filename: "backlog.feat.s", field: "phase", value: "ready" });
    expect(JSON.stringify(res)).toContain("proto_story_guard");
    expect(fs.readFileSync(notePath("backlog.feat.s")).equals(before)).toBe(true);
  });

  it("open-flow init guard refuses dendron_create on backlog.feat.x and writes no file", async () => {
    const agent = createDendronAgent({ projectId: "t", request: "r", projectRoot: project, writeGuard: guardFor(open()) });
    const res = await tool(agent, "dendron_create").execute({ filename: BACKLOG });
    expect(JSON.stringify(res)).toContain("namespace_violation");
    expect(fs.existsSync(notePath(BACKLOG))).toBe(false);
  });

  it("ops-flow guard admits a research.* create and refuses phase ready with proto_story_guard", async () => {
    const ops = flow("ops");
    const agent = createDendronAgent({ projectId: "t", request: "r", projectRoot: project, writeGuard: guardFor(ops) });
    await tool(agent, "dendron_create").execute({ filename: "research.topic" });
    expect(fs.existsSync(notePath("research.topic"))).toBe(true);
    const before = seedNote("backlog.feat.o");
    const res = await tool(agent, "dendron_update_field").execute({ filename: "backlog.feat.o", field: "phase", value: "ready" });
    expect(JSON.stringify(res)).toContain("proto_story_guard");
    expect(fs.readFileSync(notePath("backlog.feat.o")).equals(before)).toBe(true);
  });

  it("each write tool calls writeGuard with the mapped MCP tool name and args before writing", async () => {
    const refusal = { ok: false, error: "namespace_violation", message: "test refusal" };
    const writeGuard = vi.fn(() => refusal);
    const name = "backlog.feat.w";
    const before = seedNote(name);
    const agent = createDendronAgent({ projectId: "t", request: "r", projectRoot: project, writeGuard });
    const cases = [
      ["dendron_create", { filename: "research.fresh" }, "dendron_create_note", { filename: "research.fresh" }],
      ["dendron_edit", { filename: name, content: "new" }, "dendron_edit_note", { filename: name }],
      ["dendron_update_field", { filename: name, field: "desc", value: "x" }, "dendron_update_field", { filename: name, field: "desc", value: "x" }],
      ["dendron_fix_frontmatter", { filename: name }, "dendron_update_fields", { filename: name, fields: {} }],
      ["dendron_mark_implemented", { filename: name, commitId: "abc1234" }, "dendron_edit_note", { filename: name }],
    ];
    for (const [agentTool, input, mcpName, mcpArgs] of cases) {
      writeGuard.mockClear();
      const res = await tool(agent, agentTool).execute(input);
      expect(writeGuard, agentTool).toHaveBeenCalledWith(mcpName, mcpArgs);
      expect(JSON.stringify(res), agentTool).toContain("test refusal");
    }
    expect(fs.existsSync(notePath("research.fresh"))).toBe(false);
    expect(fs.readFileSync(notePath(name)).equals(before)).toBe(true);
  });

  it("without writeGuard the agent writes exactly as before", async () => {
    const agent = createDendronAgent({ projectId: "t", request: "r", projectRoot: project });
    await tool(agent, "dendron_create").execute({ filename: "research.unguarded" });
    expect(fs.existsSync(notePath("research.unguarded"))).toBe(true);
  });

  it("the guard helper refuses a token with no live session and admits a live admitted write", () => {
    expect(checkTokenToolArgs("no-such-token", "dendron_create_note", { filename: "research.topic" })).toMatchObject({ ok: false });
    expect(checkTokenToolArgs(open(), "dendron_create_note", { filename: "research.topic" })).toBeNull();
  });
});

describe("recovery fix_dendron writeGuard forwarding", () => {
  it("the fix_dendron delegated dendron agent applies the writeGuard passed to createRecoveryAgent", async () => {
    const writeGuard = vi.fn(() => ({ ok: false, error: "namespace_violation", message: "recovery refusal" }));
    const config = createRecoveryAgent({ projectId: "t", symptoms: [], autoFix: false, projectRoot: project, writeGuard });
    await tool(config, "fix_dendron").execute({ request: "repair frontmatter" });
    const target = h.captured.find((c) => c.tools?.some((t) => t.name === "dendron_create"));
    expect(target).toBeDefined();
    await tool(target, "dendron_create").execute({ filename: "research.recovery" });
    expect(writeGuard).toHaveBeenCalledWith("dendron_create_note", { filename: "research.recovery" });
    expect(fs.existsSync(notePath("research.recovery"))).toBe(false);
  });
});

describe("governor-token export surface", () => {
  it("checkToolArgs stays a plain non-exported function and the guard helper is on the trailing export list", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"), "utf8");
    expect(src).toMatch(/^function checkToolArgs\(/m);
    expect(src).not.toContain("export function checkToolArgs");
    expect(src).not.toContain("export function checkTokenToolArgs");
    expect(src.slice(src.lastIndexOf("\nexport {"))).toMatch(/\bcheckTokenToolArgs\b/);
    expect(typeof governorToken.checkTokenToolArgs).toBe("function");
  });
});
