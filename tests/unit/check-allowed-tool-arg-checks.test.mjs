import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { getTelemetryCollector } from "@routekit/telemetry";
import {
  setProjectRoot,
  createSession,
  getSession,
  resetToken,
  checkAllowedTool,
  advanceState,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Built by concatenation so this file does not itself contain the deleted function's name.
const DELETED = "assert" + "ToolAllowed";
const WRITE_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_update_field", "dendron_update_fields"];
const STORY = "backlog.feat.example-story";

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cat-args-"));
  setProjectRoot(tmpRoot);
  resetToken();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetToken();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function session(flowType, initialState, problemId) {
  const { token } = createSession({ projectId: "routekit-shell-core", flowType, initialState, problemId });
  return token;
}

// backlog.feat.dendron-write-arg-checks-close-bypasses: an open session reaches `writing` with
// backlog creates admitted only by traversing the PO research chain
// (init -> researching -> concern-separating -> test-file-scanning -> writing).
function traversedOpenWriting() {
  const token = session("open", "init");
  for (let i = 0; i < 4; i++) advanceState(token, "rks_agent_research");
  expect(getSession(token).state).toBe("writing");
  return token;
}

function writeArgs(tool, filename) {
  if (tool === "dendron_update_field") return { filename, field: "desc", value: "x" };
  if (tool === "dendron_update_fields") return { filename, fields: { desc: "x" } };
  return { filename };
}

const READY_SINGLE = { filename: STORY, field: "phase", value: "ready" };
const READY_MULTI = { filename: STORY, fields: { phase: "ready" } };

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(mjs|cjs|js|ts)$/.test(ent.name)) out.push(p);
  }
  return out;
}

describe("checkAllowedTool args: open-flow PO backlog gate", () => {
  it("refuses a backlog.* create from researching and concern-separating with namespace_violation", () => {
    for (const state of ["researching", "concern-separating"]) {
      const token = session("open", state);
      expect(checkAllowedTool(token, "dendron_create_note", { filename: STORY }), state)
        .toMatchObject({ ok: false, error: "namespace_violation" });
    }
  });

  it("admits research.*, design.* and notes.* creates from researching and concern-separating", () => {
    for (const state of ["researching", "concern-separating"]) {
      const token = session("open", state);
      for (const filename of ["research.2026.11.12.topic", "design.topic", "notes.topic"]) {
        expect(checkAllowedTool(token, "dendron_create_note", { filename }), `${state} ${filename}`).toBeNull();
      }
    }
  });

  it("admits a backlog.* create from writing", () => {
    const token = traversedOpenWriting();
    expect(checkAllowedTool(token, "dendron_create_note", { filename: STORY })).toBeNull();
  });
});

describe("checkAllowedTool args: namespace allowlist", () => {
  it("refuses story-flow dendron writes on a non-backlog filename", () => {
    const token = session("story", "init", STORY);
    for (const tool of WRITE_TOOLS) {
      expect(checkAllowedTool(token, tool, writeArgs(tool, "research.topic")), tool)
        .toMatchObject({ ok: false, error: "namespace_violation" });
    }
  });

  it("admits story-flow dendron writes on a backlog.* filename", () => {
    const token = session("story", "init", STORY);
    for (const tool of WRITE_TOOLS) {
      expect(checkAllowedTool(token, tool, writeArgs(tool, STORY)), tool).toBeNull();
    }
  });

  it("admits qa-flow writes on qa.* and backlog.* and refuses other namespaces", () => {
    const token = session("qa", "researching", STORY);
    for (const tool of WRITE_TOOLS) {
      expect(checkAllowedTool(token, tool, writeArgs(tool, "qa.report")), `${tool} qa`).toBeNull();
      expect(checkAllowedTool(token, tool, writeArgs(tool, STORY)), `${tool} backlog`).toBeNull();
      expect(checkAllowedTool(token, tool, writeArgs(tool, "research.topic")), `${tool} research`)
        .toMatchObject({ ok: false, error: "namespace_violation" });
    }
  });

  it("does not namespace-restrict open-flow writes", () => {
    const token = traversedOpenWriting();
    for (const tool of WRITE_TOOLS) {
      for (const filename of ["how-to.guide", "research.topic", STORY]) {
        expect(checkAllowedTool(token, tool, writeArgs(tool, filename)), `${tool} ${filename}`).toBeNull();
      }
    }
  });
});

describe("checkAllowedTool args: proto-story guard", () => {
  it("refuses phase ready from story flow with proto_story_guard via both update tools", () => {
    const token = session("story", "init", STORY);
    expect(checkAllowedTool(token, "dendron_update_field", READY_SINGLE))
      .toMatchObject({ ok: false, error: "proto_story_guard" });
    expect(checkAllowedTool(token, "dendron_update_fields", READY_MULTI))
      .toMatchObject({ ok: false, error: "proto_story_guard" });
  });

  it("admits phase ready from open and qa flows", () => {
    const open = session("open", "writing");
    const qa = session("qa", "researching", STORY);
    for (const token of [open, qa]) {
      expect(checkAllowedTool(token, "dendron_update_field", READY_SINGLE)).toBeNull();
      expect(checkAllowedTool(token, "dendron_update_fields", READY_MULTI)).toBeNull();
    }
  });

  it("admits non-ready phase writes from story flow", () => {
    const token = session("story", "init", STORY);
    for (const value of ["planned", "executed"]) {
      expect(checkAllowedTool(token, "dendron_update_field", { filename: STORY, field: "phase", value }), value).toBeNull();
    }
  });

  it("ship and ops sessions are refused dendron phase writes by the state machine", () => {
    for (const flow of ["ship", "ops"]) {
      const token = session(flow);
      expect(checkAllowedTool(token, "dendron_update_field", READY_SINGLE), flow)
        .toMatchObject({ ok: false, error: "chain_violation" });
    }
  });
});

describe("checkAllowedTool args: refusal contract", () => {
  it("an arg refusal carries ok, error, tool, flowType, state and message", () => {
    const token = session("story", "init", STORY);
    const ns = checkAllowedTool(token, "dendron_create_note", { filename: "research.topic" });
    expect(ns).toMatchObject({ ok: false, error: "namespace_violation", tool: "dendron_create_note", flowType: "story", state: "init" });
    expect(typeof ns.message === "string" && ns.message.length > 0).toBe(true);
    const guard = checkAllowedTool(token, "dendron_update_field", READY_SINGLE);
    expect(guard).toMatchObject({ ok: false, error: "proto_story_guard", tool: "dendron_update_field", flowType: "story", state: "init" });
    expect(typeof guard.message === "string" && guard.message.length > 0).toBe(true);
  });

  it("an arg refusal emits chain.violation with a violationKind distinct from state_machine", () => {
    const emit = vi.spyOn(getTelemetryCollector(), "emit");
    const story = session("story", "init", STORY);
    checkAllowedTool(story, "dendron_create_note", { filename: "research.topic" });
    checkAllowedTool(story, "dendron_update_field", READY_SINGLE);
    const open = session("open", "researching");
    checkAllowedTool(open, "dendron_create_note", { filename: STORY });
    const events = emit.mock.calls.filter((c) => c[0] === "chain.violation").map((c) => c[2]);
    expect(events.map((e) => e.violationKind)).toEqual(["namespace", "proto_story_guard", "namespace"]);
    expect(events.map((e) => e.blockedTool)).toEqual(["dendron_create_note", "dendron_update_field", "dendron_create_note"]);
  });

  it("an arg refusal does not increment toolCallCounts", () => {
    const token = session("story", "init", STORY);
    checkAllowedTool(token, "dendron_create_note", { filename: "research.topic" });
    checkAllowedTool(token, "dendron_update_field", READY_SINGLE);
    const counts = getSession(token).toolCallCounts || {};
    expect(counts.dendron_create_note ?? 0).toBe(0);
    expect(counts.dendron_update_field ?? 0).toBe(0);
    expect(checkAllowedTool(token, "dendron_create_note", { filename: STORY })).toBeNull();
    expect(getSession(token).toolCallCounts.dendron_create_note).toBe(1);
  });

  it("with args omitted no arg check runs", () => {
    const story = session("story", "init", STORY);
    expect(checkAllowedTool(story, "dendron_create_note")).toBeNull();
    const open = session("open", "researching");
    expect(checkAllowedTool(open, "dendron_create_note")).toBeNull();
  });
});

describe("checkAllowedTool args: documented chains", () => {
  it("QA story-review writes on a backlog.* story are admitted", () => {
    const token = session("qa", "researching", STORY);
    const writes = [
      ["testRequirements", ["a requirement"]],
      ["testFiles", ["tests/unit/example.test.mjs"]],
      ["targetFiles", [{ path: "tests/unit/example.test.mjs", op: "create" }]],
      ["requirementCoverage", [{ index: 0, testFile: "tests/unit/example.test.mjs", path: "d > t" }]],
      ["phase", "ready"],
    ];
    for (const [field, value] of writes) {
      expect(checkAllowedTool(token, "dendron_update_field", { filename: STORY, field, value }), field).toBeNull();
    }
  });

  it("the Build ship step rks_story_ship is admitted from story-flow executed", () => {
    const token = session("story", "executed", STORY);
    expect(checkAllowedTool(token, "rks_story_ship", { projectId: "routekit-shell-core", problemId: STORY })).toBeNull();
  });
});

describe("arg-check fold: source surface", () => {
  it("packages/mcp-rks/src neither defines nor references the deleted admission function", () => {
    const files = walk(path.join(ROOT, "packages/mcp-rks/src"));
    expect(files.some((f) => f.endsWith("governor-token.mjs"))).toBe(true);
    const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes(DELETED)).map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it("no file under tests/ names the deleted admission function", () => {
    const files = walk(path.join(ROOT, "tests"));
    expect(files.some((f) => f.endsWith("check-allowed-tool-arg-checks.test.mjs"))).toBe(true);
    const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes(DELETED)).map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it("server.mjs passes cleanArgs to checkAllowedTool", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server.mjs"), "utf8");
    expect(src).toContain("checkAllowedTool(activeToken, tool, cleanArgs)");
  });

  it("checkAllowedTool accepts an optional args parameter", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"), "utf8");
    expect(src).toContain("\nexport function checkAllowedTool(token, toolName, args) {");
  });

  it("governor-state.mjs no longer describes OPEN_FLOW_TOOLS as a required admission layer", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/shared/governor-state.mjs"), "utf8");
    expect(src).not.toContain("both layers are required");
  });
});
