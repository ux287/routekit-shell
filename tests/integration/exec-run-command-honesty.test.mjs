/**
 * backlog.fix.run-command-honest-and-usable — Defect A, mock tier (no ".workflow." infix).
 *
 * Drives the REAL exported runApplyTool with force:true. Only the project-registry seam (loadContext in
 * server/project.mjs) is mocked, so the live projects/index.jsonl is never read or written; every other
 * project.mjs export is the real one. command-runner.mjs, exec.mjs and test-runner.mjs are real.
 *
 * rks_apply does NOT reach the step loop: applySchema (server.mjs) has no force field, so runApplyTool
 * refuses it at its direct-call guard. Only rks_exec (_execContext) and force:true reach the loop.
 * force:true skips the per-step scope guard, so these cases carry no guard coverage.
 *
 * TR44 (no shell literals in exec.mjs, comments included) is pinned by
 * tests/integration/exec-precommands-policy.test.mjs over the raw source, all four literals; it is not
 * duplicated here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root } })),
}));

const { runApplyTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");

const SKIP_EVENT = "exec.run_command_skipped";
const POLICY_PATH = ".routekit/command-policy.yaml";
const PROJECT_ID = "rc-honesty";

let seq = 0;
function writePlan(label, steps) {
  const runDir = path.join(h.root, ".rks", "runs", `2026-11-04T00-00-0${seq++}-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, steps }));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: PROJECT_ID, timestamps: {}, telemetry: { outcome: "planned" } }));
  return runDir;
}

function writePolicy(autoExecute) {
  fs.mkdirSync(path.join(h.root, ".routekit"), { recursive: true });
  fs.writeFileSync(
    path.join(h.root, ".routekit", "command-policy.yaml"),
    `command_policy:\n  auto_execute: ${JSON.stringify(autoExecute)}\n`,
  );
}

/** Drive runApplyTool and return the rejection (or fail the test on a success-shaped result). */
async function applyExpectingFailure(label) {
  let err;
  let res;
  try {
    res = await runApplyTool({ projectId: PROJECT_ID, label, force: true });
  } catch (e) {
    err = e;
  }
  expect(res, "runApplyTool must not return a success-shaped result").toBeUndefined();
  expect(err).toBeInstanceOf(McpError);
  return err;
}

const collector = () => ensureTelemetryStorage(h.root);
const skipEvents = () => collector().emit.mock.calls.filter((c) => c[0] === SKIP_EVENT);
const triple = (o) => ({ command: o.command, classification: o.classification, reason: o.reason });

beforeEach(() => {
  h.root = makeTempDir("rc-honesty");
  collector().emit.mockClear();
});

afterEach(() => {
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("TR7/TR8: a non-executed run_command fails runApplyTool", () => {
  it("TR7: unknown_command is a failure, never a success", async () => {
    writePlan("unknown", [{ action: "run_command", command: "definitely-not-in-policy --x" }]);
    const err = await applyExpectingFailure("unknown");
    expect(err.data?.nonExecutedCommands?.[0]?.reason).toBe("unknown_command");
  });

  it("TR8a: an empty command (malformed step, never classified) fails", async () => {
    const runDir = writePlan("empty", [{ action: "run_command", command: "   " }]);
    const err = await applyExpectingFailure("empty");
    expect(err.message).toMatch(/no command/i);
    // Its own code, distinct from the snapshot pre-flight's InvalidRequest refusal (TR15b).
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.code).not.toBe(ErrorCode.InvalidRequest);
    // The skip line is written before the throw and persisted to apply.log.
    const log = fs.readFileSync(path.join(runDir, "apply", "apply.log"), "utf8");
    expect(log).toContain("skip: run_command (no command)");
  });

  it("TR8b: requires_explicit_confirmation ('rm -rf build' under defaults) fails", async () => {
    fs.mkdirSync(path.join(h.root, "build"));
    writePlan("confirm", [{ action: "run_command", command: "rm -rf build" }]);
    const err = await applyExpectingFailure("confirm");
    expect(err.data.nonExecutedCommands[0].reason).toBe("requires_explicit_confirmation");
    expect(fs.existsSync(path.join(h.root, "build"))).toBe(true);
  });

  it("TR8c: shell_syntax_rejected fails, and nothing was run (no PWNED file)", async () => {
    writePlan("shell", [{ action: "run_command", command: "npm run build && touch PWNED" }]);
    const err = await applyExpectingFailure("shell");
    expect(err.data.nonExecutedCommands[0].reason).toBe("shell_syntax_rejected");
    expect(fs.existsSync(path.join(h.root, "PWNED"))).toBe(false);
  });
});

describe("TR9/TR10: the failure is legible on the error surface", () => {
  it("TR9: the error carries a structured field with command, classification, reason and hint", async () => {
    writePlan("structured", [{ action: "run_command", command: "definitely-not-in-policy --x" }]);
    const err = await applyExpectingFailure("structured");
    const list = err.data.nonExecutedCommands;
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      command: "definitely-not-in-policy --x",
      classification: "unknown",
      reason: "unknown_command",
    });
    expect(typeof list[0].hint).toBe("string");
    expect(list[0].hint.length).toBeGreaterThan(0);
  });

  it("TR10: unknown_command message names the command, classification, reason, policy file and key", async () => {
    writePlan("msg-unknown", [{ action: "run_command", command: "definitely-not-in-policy --x" }]);
    const err = await applyExpectingFailure("msg-unknown");
    for (const s of ["definitely-not-in-policy --x", "unknown", "unknown_command", POLICY_PATH, "command_policy"]) {
      expect(err.message).toContain(s);
    }
  });

  it("TR10: shell_syntax_rejected message says no shell and does NOT name the policy file", async () => {
    writePlan("msg-shell", [{ action: "run_command", command: "npm run build && touch PWNED" }]);
    const err = await applyExpectingFailure("msg-shell");
    expect(err.message).toContain("npm run build && touch PWNED");
    expect(err.message).toContain("shell_syntax_rejected");
    expect(err.message).toMatch(/without a shell/i);
    expect(err.message).not.toContain(POLICY_PATH);
  });

  it("TR10: built-in veto message ('rm -rf build') does NOT name the policy file", async () => {
    writePlan("msg-veto", [{ action: "run_command", command: "rm -rf build" }]);
    const err = await applyExpectingFailure("msg-veto");
    expect(err.message).toContain("rm -rf build");
    expect(err.message).toContain("require_explicit_confirmation");
    expect(err.message).toContain("requires_explicit_confirmation");
    expect(err.message).not.toContain(POLICY_PATH);
  });
});

describe("TR11-TR13: apply.log, telemetry and the one reduction", () => {
  it("TR11: apply.log still records the skip line after the failure", async () => {
    const runDir = writePlan("log", [{ action: "run_command", command: "definitely-not-in-policy --x" }]);
    await applyExpectingFailure("log");
    const log = fs.readFileSync(path.join(runDir, "apply", "apply.log"), "utf8");
    expect(log).toContain("skip: run_command (unknown_command): definitely-not-in-policy --x");
  });

  it("TR12: a skip event carrying command, classification and reason is read off the collector", async () => {
    writePlan("telemetry", [{ action: "run_command", command: "definitely-not-in-policy --x" }]);
    await applyExpectingFailure("telemetry");
    const events = skipEvents();
    expect(events).toHaveLength(1);
    const [name, projectId, payload] = events[0];
    expect(name).toBe(SKIP_EVENT);
    expect(projectId).toBe(PROJECT_ID);
    expect(triple(payload)).toEqual({
      command: "definitely-not-in-policy --x",
      classification: "unknown",
      reason: "unknown_command",
    });
  });

  it("TR13: the result's structured triple EQUALS the telemetry payload triple (observed vs observed)", async () => {
    writePlan("reduction", [{ action: "run_command", command: "rm -rf build" }]);
    const err = await applyExpectingFailure("reduction");
    const events = skipEvents();
    expect(events).toHaveLength(1);
    expect(triple(events[0][2])).toEqual(triple(err.data.nonExecutedCommands[0]));
  });
});

describe("TR14/TR15: executed commands keep their existing outcomes", () => {
  it("TR14 positive control: a policy-admitted plain-argv command runs, succeeds and writes its marker", async () => {
    writePolicy(["node write-marker.mjs"]);
    fs.writeFileSync(path.join(h.root, "write-marker.mjs"), 'import fs from "node:fs";\nfs.writeFileSync("MARKER", "1");\n');
    writePlan("control", [{ action: "run_command", command: "node write-marker.mjs" }]);
    const res = await runApplyTool({ projectId: PROJECT_ID, label: "control", force: true });
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("nonExecutedCommands");
    expect(fs.existsSync(path.join(h.root, "MARKER"))).toBe(true);
    expect(skipEvents()).toHaveLength(0);
  }, 60_000);

  it("TR15: a command that RAN and exited non-zero still fails through the non-zero-exit path", async () => {
    writePolicy(["node exit-three.mjs"]);
    fs.writeFileSync(path.join(h.root, "exit-three.mjs"), "process.exit(3);\n");
    writePlan("exit3", [{ action: "run_command", command: "node exit-three.mjs" }]);
    const err = await applyExpectingFailure("exit3");
    expect(err.message).toContain("run_command failed (exit 3): node exit-three.mjs");
    expect(err.data?.nonExecutedCommands).toBeUndefined();
    expect(skipEvents()).toHaveLength(0);
  }, 60_000);
});

describe("TR15b: the pre-loop policy-file refusal stays outside the skip reduction", () => {
  it("rejects with InvalidRequest, no structured skip field and no skip event", async () => {
    writePlan("policy-target", [
      { action: "create_file", path: ".routekit/command-policy.yaml", content: "x" },
      { action: "run_command", command: "definitely-not-in-policy --x" },
    ]);
    const err = await applyExpectingFailure("policy-target");
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.data?.nonExecutedCommands).toBeUndefined();
    expect(skipEvents()).toHaveLength(0);
  });
});
