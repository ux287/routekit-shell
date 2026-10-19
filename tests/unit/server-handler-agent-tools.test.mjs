/**
 * S10 (backlog.feat.server-mjs-registry-only-dispatch): per-agent tool handler family resolved lazily
 * through the registry resolver (packages/mcp-rks/src/server/handlers/agent-tools.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  emitted: [],
  emitThrows: false,
  late: new Map(),
  parse: null,
  runAgent: null,
  loadContext: null,
}));

vi.mock("@routekit/telemetry/collector", () => ({
  getTelemetryCollector: () => ({
    emit: (type, projectId, payload) => {
      if (h.emitThrows) throw new Error("emit failed");
      h.emitted.push({ type, projectId, payload });
    },
  }),
}));
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (io) => ({ ...(await io()), runAgent: (...a) => h.runAgent(...a) }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (io) => ({ ...(await io()), loadContext: (...a) => h.loadContext(...a) }));
vi.mock("../../packages/mcp-rks/src/agents/registry.mjs", async (io) => {
  const real = await io();
  return {
    ...real,
    getAgentByToolName: vi.fn((t) => h.late.get(t) ?? real.getAgentByToolName(t)),
    parseAgentInput: (...a) => (h.parse ? h.parse(...a) : real.parseAgentInput(...a)),
  };
});

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerAgentToolHandlers } from "../../packages/mcp-rks/src/server/handlers/agent-tools.mjs";
import { getAgentByToolName } from "../../packages/mcp-rks/src/agents/registry.mjs";
import { shouldEmitResearchFailureEvent } from "../../packages/mcp-rks/src/agents/research.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AT_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers/agent-tools.mjs");
const SELF_ABS = fileURLToPath(import.meta.url);
const CORE_AGENT_TOOLS = [
  "rks_agent_validate_story", "rks_agent_research", "rks_agent_git", "rks_agent_dendron",
  "rks_agent_telemetry", "rks_agent_ship", "rks_agent_cycle_complete", "rks_agent_story",
  "rks_agent_delivery", "rks_agent_recovery", "rks_agent_plan",
];
const EMITTING = ["retrieval_failed", "malformed_output", "partial_answer", "escalated", "timeout"];

function atRegistry() {
  const r = createHandlerRegistry();
  registerAgentToolHandlers(r);
  return r;
}
const ctxFor = (tool, revert = vi.fn()) => Object.freeze({ tool, args: {}, activeToken: undefined, governorToken: undefined, revertEntryTransition: revert });

// A test-controlled agent entry reachable under `tool` (shadows the real entry for core names).
function stubAgent(tool, name = "stub") {
  const config = { marker: `${name}-config` };
  const entry = { name, factory: vi.fn(() => config) };
  h.late.set(tool, entry);
  return { entry, config };
}

function countOccurrences(src, needle) {
  let n = 0;
  let at = src.indexOf(needle);
  while (at !== -1) {
    n++;
    at = src.indexOf(needle, at + 1);
  }
  return n;
}

beforeEach(() => {
  h.emitted.length = 0;
  h.emitThrows = false;
  h.late.clear();
  h.parse = (_name, input) => ({ ok: true, data: { ...input } });
  h.loadContext = vi.fn(async () => ({ record: { root: "/fixture/root" } }));
  h.runAgent = vi.fn(async () => ({ ok: true }));
});

describe("S10 agent-tool handlers (unit)", () => {
  it("AT1 resolves the 11 core agent tools, registers no named tool, unknown is null", () => {
    const r = atRegistry();
    expect(r.registeredTools()).toEqual([]);
    for (const t of CORE_AGENT_TOOLS) expect(typeof r.lookupHandler(t), t).toBe("function");
    expect(r.lookupHandler("rks_agent_nonexistent")).toBeNull();
  });

  it("AT2 an agent made resolvable after registration resolves (lazy, per lookup)", () => {
    const r = atRegistry();
    getAgentByToolName.mockClear();
    expect(r.lookupHandler("rks_agent_late")).toBeNull();
    h.late.set("rks_agent_late", { name: "late", factory: vi.fn(() => ({})) });
    expect(typeof r.lookupHandler("rks_agent_late")).toBe("function");
    expect(getAgentByToolName).toHaveBeenCalledWith("rks_agent_late");
    expect(getAgentByToolName).toHaveBeenCalledTimes(2);
  });

  it("AT3 invalid input returns the parse error verbatim and runs nothing", async () => {
    const { entry } = stubAgent("rks_agent_git", "git");
    const error = { error: "invalid_agent_input", agent: "git", unknownKeys: ["command"] };
    const parse = vi.fn(() => ({ ok: false, error }));
    h.parse = parse;
    const cleanArgs = { projectId: "p", command: "x" };
    const res = await atRegistry().lookupHandler("rks_agent_git")(cleanArgs, ctxFor("rks_agent_git"));
    expect(parse).toHaveBeenCalledWith("git", cleanArgs);
    expect(res).toEqual({ content: [{ type: "text", text: JSON.stringify(error, null, 2) }] });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toBe(JSON.stringify(error, null, 2));
    expect(h.loadContext).toHaveBeenCalledTimes(0);
    expect(entry.factory).toHaveBeenCalledTimes(0);
    expect(h.runAgent).toHaveBeenCalledTimes(0);
  });

  it("AT4 success path: loadContext(projectId), factory({...data, projectRoot}), runAgent(config), JSON response", async () => {
    const { entry, config } = stubAgent("rks_agent_story", "story");
    const data = { projectId: "proj-a", query: "q" };
    h.parse = vi.fn(() => ({ ok: true, data }));
    const result = { ok: true, answer: "done", nested: { a: [1, 2] } };
    h.runAgent = vi.fn(async () => result);
    const res = await atRegistry().lookupHandler("rks_agent_story")({ projectId: "proj-a", query: "q" }, ctxFor("rks_agent_story"));
    expect(h.loadContext).toHaveBeenCalledTimes(1);
    expect(h.loadContext).toHaveBeenCalledWith("proj-a");
    expect(entry.factory).toHaveBeenCalledTimes(1);
    expect(entry.factory).toHaveBeenCalledWith({ projectId: "proj-a", query: "q", projectRoot: "/fixture/root" });
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.runAgent).toHaveBeenCalledWith(config);
    expect(res).toEqual({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    expect(res.content).toHaveLength(1);
  });

  it("AT5 soft-failure revert: once for ok false, once for status failed, never for ok true with partial_answer", async () => {
    stubAgent("rks_agent_ship", "ship");
    const r = atRegistry();
    const cases = [
      [{ ok: false, error: "max turns" }, 1],
      [{ status: "failed" }, 1],
      [{ ok: true, failureCategory: "partial_answer" }, 0],
    ];
    for (const [result, calls] of cases) {
      h.runAgent = vi.fn(async () => result);
      const revert = vi.fn();
      await r.lookupHandler("rks_agent_ship")({ projectId: "p" }, ctxFor("rks_agent_ship", revert));
      expect(revert, JSON.stringify(result)).toHaveBeenCalledTimes(calls);
    }
  });

  it("AT6 a throwing revertEntryTransition is swallowed and the response is still returned", async () => {
    stubAgent("rks_agent_recovery", "recovery");
    const result = { ok: false, error: "boom" };
    h.runAgent = vi.fn(async () => result);
    const revert = vi.fn(() => { throw new Error("revert failed"); });
    const res = await atRegistry().lookupHandler("rks_agent_recovery")({ projectId: "p" }, ctxFor("rks_agent_recovery", revert));
    expect(revert).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  });

  it("AT7 rks_agent_research emits agent.research.<failureCategory> once for each emitting category", async () => {
    stubAgent("rks_agent_research", "research");
    const r = atRegistry();
    for (const failureCategory of EMITTING) {
      expect(shouldEmitResearchFailureEvent(failureCategory), failureCategory).toBe(true);
      h.emitted.length = 0;
      const result = { ok: true, failureCategory, confidence: 0.25, telemetryId: `tid-${failureCategory}`, answer: "a" };
      h.runAgent = vi.fn(async () => result);
      await r.lookupHandler("rks_agent_research")({ projectId: "proj-r" }, ctxFor("rks_agent_research"));
      expect(h.emitted).toHaveLength(1);
      const [ev] = h.emitted;
      expect(ev.type).toBe(`agent.research.${failureCategory}`);
      expect(ev.projectId).toBe("proj-r");
      expect(Object.keys(ev.payload).sort()).toEqual(["confidence", "failureCategory", "telemetryId"]);
      expect(ev.payload).toEqual({ failureCategory, confidence: 0.25, telemetryId: `tid-${failureCategory}` });
    }

    // projectId absent -> 'unknown'.
    h.emitted.length = 0;
    h.runAgent = vi.fn(async () => ({ ok: true, failureCategory: "retrieval_failed", confidence: 0, telemetryId: "t" }));
    await r.lookupHandler("rks_agent_research")({}, ctxFor("rks_agent_research"));
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].projectId).toBe("unknown");
  });

  it("AT8 no emit for non-emitting categories or other tools; a throwing emit leaves the response unchanged", async () => {
    stubAgent("rks_agent_research", "research");
    stubAgent("rks_agent_plan", "plan");
    const r = atRegistry();
    for (const failureCategory of ["no_results", "thin_results", undefined]) {
      expect(shouldEmitResearchFailureEvent(failureCategory)).toBe(false);
      h.runAgent = vi.fn(async () => (failureCategory ? { ok: true, failureCategory } : { ok: true }));
      await r.lookupHandler("rks_agent_research")({ projectId: "p" }, ctxFor("rks_agent_research"));
      expect(h.emitted, String(failureCategory)).toHaveLength(0);
    }

    const failing = { ok: true, failureCategory: "retrieval_failed", confidence: 0.1, telemetryId: "t1" };
    h.runAgent = vi.fn(async () => failing);
    await r.lookupHandler("rks_agent_plan")({ projectId: "p" }, ctxFor("rks_agent_plan"));
    expect(h.emitted).toHaveLength(0);

    const quiet = await r.lookupHandler("rks_agent_research")({ projectId: "p" }, ctxFor("rks_agent_research"));
    expect(h.emitted).toHaveLength(1);
    h.emitThrows = true;
    const loud = await r.lookupHandler("rks_agent_research")({ projectId: "p" }, ctxFor("rks_agent_research"));
    expect(JSON.stringify(loud)).toBe(JSON.stringify(quiet));
    expect(loud).toEqual({ content: [{ type: "text", text: JSON.stringify(failing, null, 2) }] });
  });

  it("AT9 agent-tools.mjs module shape", () => {
    const src = fs.readFileSync(AT_ABS, "utf8");
    const specifiers = [...src.matchAll(/^import\s[^;]*?\sfrom\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
    const telemetrySpecifiers = specifiers.filter((s) => s.startsWith("@routekit/" + "telemetry"));
    expect(telemetrySpecifiers).toEqual(["@routekit/telemetry/collector"]);
    expect(src).toMatch(/^import \{ getTelemetryCollector \} from "@routekit\/telemetry\/collector";$/m);
    // No dynamic import of any specifier, so no other telemetry route exists.
    expect(src).not.toMatch(/\bimport\s*\(/);
    for (const s of specifiers) expect(s, s).not.toMatch(/(?:^|\/)server\.mjs$/);
    const fnDecls = [...src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    expect(fnDecls).toEqual(["registerAgentToolHandlers"]);
    expect(countOccurrences(src, "registerResolver(")).toBe(1);
    expect(countOccurrences(src, "registerHandler(")).toBe(0);
    expect(countOccurrences(src, "if (tool === 'rks_agent_research' && shouldEmitResearchFailureEvent(")).toBe(1);
    expect(src).not.toContain("revertStateOnFailure(");
  });

  it("AT10 this test file is unit-tier: no server.mjs import, no spawn-family call, the heavy collaborators are mocked", () => {
    const self = fs.readFileSync(SELF_ABS, "utf8");
    const importSpecifiers = [...self.matchAll(/^import\s[^;]*?\sfrom\s+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
    for (const s of importSpecifiers) expect(s, s).not.toMatch(/(?:^|\/)server\.mjs$/);
    expect(self).not.toMatch(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/);
    expect(self).not.toMatch(/["']node:child_process["']|["']child_process["']/);
    expect(self).toContain('vi.mock("../../packages/mcp-rks/src/agents/runner.mjs"');
    expect(self).toContain('vi.mock("../../packages/mcp-rks/src/server/project.mjs"');
    // Concatenated so the triage classifier does not read this assertion as a mock-position specifier.
    expect(self).toContain("vi.mock(" + '"@routekit/telemetry/collector"');
  });

  it("AT11 telemetry triage escape: the mocked collector name exists on the real module", async () => {
    // Literal-specifier escape (server-handler-planner.test.mjs:548 precedent): keeps this file
    // un-shadowed for tests/unit/telemetry-global-mock-triage.test.mjs, so it needs no VERDICTS entry.
    const realCollector = await vi.importActual("@routekit/telemetry/collector");
    expect(typeof realCollector.getTelemetryCollector).toBe("function");
  });
});
