// backlog.feat.cli-call-batch-runner — unit tests for routekit call --batch.
// No subprocess is spawned: runBatch takes an injected stub client and
// handleCallCommand takes an injected deps.connect.
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseBatchFile, runBatch, handleCallCommand, buildServerEnv } from "../../packages/cli/src/cli/call.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/bin/routekit.js"), "utf8");
const CALL_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/cli/call.js"), "utf8");

const mcp = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

// handlers: { [toolName]: (args, n) => payload | throws }; default payload { ok: true }.
// A handler may return { __raw: <MCP result> } to bypass JSON wrapping (non-JSON text, no text item).
function stubClient(handlers = {}) {
  const counts = {};
  const callTool = vi.fn(async ({ name, arguments: args }) => {
    counts[name] = (counts[name] || 0) + 1;
    const h = handlers[name];
    if (h) {
      const out = await h(args, counts[name]);
      return out && out.__raw ? out.__raw : mcp(out);
    }
    if (name === "rks_governor_init") return mcp({ ok: true, token: "TOK", state: "init" });
    return mcp({ ok: true });
  });
  return { callTool };
}
const callsTo = (client, name) => client.callTool.mock.calls.filter(([c]) => c.name === name).map(([c]) => c.arguments);

function tmpBatch(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-call-"));
  const p = path.join(dir, "calls.json");
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}

describe("parseBatchFile", () => {
  it("rejects a non-array", () => {
    expect(() => parseBatchFile(tmpBatch({ tool: "x" }))).toThrow(/array/);
  });
  it("rejects an entry without tool, naming its index", () => {
    expect(() => parseBatchFile(tmpBatch([{ tool: "a" }, { arguments: {} }]))).toThrow(/1/);
  });
  it("returns the entries for a valid file", () => {
    expect(parseBatchFile(tmpBatch([{ tool: "a", arguments: { x: 1 } }]))).toHaveLength(1);
  });
  it("refuses an entry carrying _governorToken", () => {
    expect(() => parseBatchFile(tmpBatch([{ tool: "a", arguments: { _governorToken: "x" } }]))).toThrow(/_governorToken/);
  });
  it("refuses an entry naming rks_governor_init", () => {
    expect(() => parseBatchFile(tmpBatch([{ tool: "rks_governor_init", arguments: {} }]))).toThrow(/rks_governor_init/);
  });
});

describe("buildServerEnv", () => {
  it("sets project vars and scrubs bypass vars, naming them", () => {
    const base = { PATH: "/bin", RKS_SKIP_PREFLIGHT: "1", RKS_TEST_MODE: "1", NODE_ENV: "test" };
    const { env, scrubbed } = buildServerEnv(base, { projectId: "p1", projectRoot: "/r" });
    expect(env).toEqual(expect.objectContaining({ PATH: "/bin", ROUTEKIT_PROJECT_ID: "p1", ROUTEKIT_PROJECT_ROOT: "/r" }));
    expect(env.RKS_SKIP_PREFLIGHT).toBeUndefined();
    expect(env.RKS_TEST_MODE).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect([...scrubbed].sort()).toEqual(["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"]);
    expect(base.RKS_SKIP_PREFLIGHT).toBe("1"); // input not mutated
  });
  it("scrubs nothing from a clean env", () => {
    expect(buildServerEnv({ PATH: "/bin", NODE_ENV: "production" }, { projectId: "p1", projectRoot: "/r" }).scrubbed).toEqual([]);
  });
});

describe("runBatch", () => {
  const base = { projectId: "p1" };

  it("calls rks_governor_init exactly once, first, with the default open flow", async () => {
    const client = stubClient();
    await runBatch({ ...base, client, calls: [{ tool: "a", arguments: {} }, { tool: "b", arguments: {} }] });
    expect(callsTo(client, "rks_governor_init")).toEqual([expect.objectContaining({ projectId: "p1", flowType: "open" })]);
    expect(client.callTool.mock.calls[0][0].name).toBe("rks_governor_init");
  });

  it("passes flowType ops through to init", async () => {
    const client = stubClient();
    const r = await runBatch({ ...base, flowType: "ops", client, calls: [] });
    expect(callsTo(client, "rks_governor_init")[0].flowType).toBe("ops");
    expect(r.flowType).toBe("ops");
  });

  it("injects projectId and the init token into every call, keeping the entry's own arguments", async () => {
    const client = stubClient();
    await runBatch({ ...base, client, calls: [{ tool: "a", arguments: { q: 1 } }, { tool: "b" }] });
    expect(callsTo(client, "a")[0]).toEqual({ q: 1, projectId: "p1", _governorToken: "TOK" });
    expect(callsTo(client, "b")[0]).toEqual(expect.objectContaining({ projectId: "p1", _governorToken: "TOK" }));
  });

  it("refuses an entry whose projectId conflicts, without calling the tool", async () => {
    const client = stubClient();
    const r = await runBatch({ ...base, client, calls: [{ tool: "a", arguments: { projectId: "other" } }] });
    expect(callsTo(client, "a")).toHaveLength(0);
    expect(r.steps[0].ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(0);
  });

  it("admits an entry whose projectId matches", async () => {
    const client = stubClient();
    const r = await runBatch({ ...base, client, calls: [{ tool: "a", arguments: { projectId: "p1" } }] });
    expect(r.ok).toBe(true);
  });

  for (const [label, init] of [
    ["ok:false", () => ({ ok: false, error: "nope" })],
    ["no token", () => ({ ok: true })],
  ]) {
    it(`stops before any batch call when init fails (${label})`, async () => {
      const client = stubClient({ rks_governor_init: init });
      const r = await runBatch({ ...base, client, calls: [{ tool: "a" }, { tool: "b" }] });
      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(r.ok).toBe(false);
      expect(r.steps.every((s) => s.ok !== true)).toBe(true);
      expect(JSON.stringify(r)).toMatch(/init/i);
    });
  }

  it("reads back after a successful dendron_update_field and passes only when the value read back equals the value written", async () => {
    // Real dendron_read_note({ fields }) shape: content holds the selected frontmatter lines, no fences.
    const client = stubClient({
      dendron_read_note: (args) => ({ ok: true, content: `${args.fields[0]}: "ready"`, fieldsNotFound: [] }),
    });
    const r = await runBatch({ ...base, client, calls: [{ tool: "dendron_update_field", arguments: { filename: "n", field: "phase", value: "ready" } }] });
    expect(callsTo(client, "dendron_read_note")).toEqual([
      expect.objectContaining({ filename: "n", fields: ["phase"], projectId: "p1", _governorToken: "TOK" }),
    ]);
    expect(r.steps[0].ok).toBe(true);
    expect(r.steps[0].readback).toBeDefined();
  });

  it("compares array values element-wise on read-back", async () => {
    const client = stubClient({
      dendron_read_note: () => ({ ok: true, content: "testFiles:\n  - a.test.mjs\n  - b.test.mjs", fieldsNotFound: [] }),
    });
    const r = await runBatch({ ...base, client, calls: [{ tool: "dendron_update_field", arguments: { filename: "n", field: "testFiles", value: ["a.test.mjs", "b.test.mjs"] } }] });
    expect(r.steps[0].ok).toBe(true);
  });

  for (const [label, read, reason] of [
    ["read fails", () => ({ ok: false, error: "unreadable" }), "readback_failed"],
    ["field missing", () => ({ ok: true, content: "id: n", fieldsNotFound: ["phase"] }), "readback_mismatch"],
    ["value differs", () => ({ ok: true, content: 'phase: "draft"', fieldsNotFound: [] }), "readback_mismatch"],
  ]) {
    it(`fails the step when the read-back ${label}`, async () => {
      const client = stubClient({ dendron_read_note: read });
      const r = await runBatch({ ...base, client, calls: [
        { tool: "dendron_update_field", arguments: { filename: "n", field: "phase", value: "ready" } },
        { tool: "b" },
      ] });
      expect(r.steps[0].ok).toBe(false);
      expect(r.steps[0].reason).toBe(reason);
      expect(r.ok).toBe(false);
      expect(r.failedAt).toBe(0);
      expect(r.skipped).toEqual([1]);
      expect(callsTo(client, "b")).toHaveLength(0);
    });
  }

  it("skips the read-back when readback is false", async () => {
    const client = stubClient();
    await runBatch({ ...base, readback: false, client, calls: [{ tool: "dendron_update_field", arguments: { filename: "n", field: "phase", value: "x" } }] });
    expect(callsTo(client, "dendron_read_note")).toHaveLength(0);
  });

  // Fail closed (user decision 2026-10-29): a step is ok only when its first text item parses as JSON
  // with ok === true and no _autoRouted. Everything else fails, stops the batch and names a reason.
  for (const [label, handler, reason] of [
    ["ok:false", () => ({ ok: false, reason: "chain_violation" }), "tool_error"],
    ["error field", () => ({ error: "boom" }), "tool_error"],
    ["throw", () => { throw new Error("transport closed"); }, "call_threw"],
    ["_autoRouted envelope", () => ({ ok: true, _autoRouted: true }), "auto_routed"],
    ["non-JSON text", () => ({ __raw: { content: [{ type: "text", text: "not json" }] } }), "unverifiable_payload"],
    ["no text item", () => ({ __raw: { content: [] } }), "unverifiable_payload"],
    ["ok-less payload", () => ({}), "unverifiable_payload"],
  ]) {
    it(`stops at the first failed step (${label}) and reports later steps as skipped`, async () => {
      const client = stubClient({ b: handler });
      const r = await runBatch({ ...base, client, calls: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] });
      expect(r.steps[1].ok).toBe(false);
      expect(r.steps[1].reason).toBe(reason);
      expect(r.steps.every((s) => s.ok === true || s.ok === false)).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.failedAt).toBe(1);
      expect(r.skipped).toEqual([2]);
      expect(callsTo(client, "c")).toHaveLength(0);
      expect(r.steps.find((s) => s.index === 2)?.ok).not.toBe(true);
    });
  }

  it("reports chain_violation as failed with the server state and message, with no retry and no reset re-init", async () => {
    const client = stubClient({ b: () => ({ ok: false, reason: "chain_violation", state: "qa_assessing", message: "not admitted" }) });
    const r = await runBatch({ ...base, client, calls: [{ tool: "a" }, { tool: "b" }] });
    expect(r.steps[1].ok).toBe(false);
    expect(JSON.stringify(r.steps[1])).toContain("qa_assessing");
    expect(JSON.stringify(r.steps[1])).toContain("not admitted");
    expect(callsTo(client, "b")).toHaveLength(1);
    expect(callsTo(client, "rks_governor_init")).toHaveLength(1);
    expect(client.callTool.mock.calls.some(([c]) => c.arguments && c.arguments.reset === true)).toBe(false);
  });

  it("never sends a call without _governorToken (batch calls and read-backs alike)", async () => {
    const client = stubClient({ dendron_read_note: () => ({ ok: true, content: "phase: x", fieldsNotFound: [] }) });
    await runBatch({ ...base, client, calls: [{ tool: "a" }, { tool: "dendron_update_field", arguments: { filename: "n", field: "phase", value: "x" } }] });
    const nonInit = client.callTool.mock.calls.map(([c]) => c).filter((c) => c.name !== "rks_governor_init");
    expect(nonInit.length).toBe(4); // a, dendron_update_field, dendron_read_note, rks_governor_end
    expect(nonInit.at(-1).name).toBe("rks_governor_end");
    for (const c of nonInit) expect(c.arguments._governorToken).toBe("TOK");
  });

  it("with continueOnError runs every step and reports each failure", async () => {
    const client = stubClient({ a: () => ({ ok: false }), c: () => ({ error: "x" }) });
    const r = await runBatch({ ...base, continueOnError: true, client, calls: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] });
    expect(callsTo(client, "c")).toHaveLength(1);
    expect(r.steps.map((s) => s.ok)).toEqual([false, true, false]);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(0);
    expect(r.skipped).toEqual([]);
  });

  it("reports ok:true, failedAt null and no skips for an all-success batch", async () => {
    const r = await runBatch({ ...base, client: stubClient(), calls: [{ tool: "a" }, { tool: "b" }] });
    expect(r).toEqual(expect.objectContaining({ ok: true, projectId: "p1", flowType: "open", failedAt: null, skipped: [] }));
    expect(r.steps.map((s) => [s.index, s.tool, s.ok])).toEqual([[0, "a", true], [1, "b", true]]);
  });
});

// Session end (decision D12): once init returned a token, rks_governor_end is called exactly once,
// last, in a finally. It is never a step and never retried, and a failed end fails the run closed.
describe("runBatch session end (rks_governor_end)", () => {
  const base = { projectId: "p1" };
  const names = (client) => client.callTool.mock.calls.map(([c]) => c.name);

  it("ends the session once, last, with projectId and the init token after an all-success batch", async () => {
    const client = stubClient();
    const r = await runBatch({ ...base, client, calls: [{ tool: "a" }, { tool: "b" }] });
    expect(names(client)).toEqual(["rks_governor_init", "a", "b", "rks_governor_end"]);
    expect(callsTo(client, "rks_governor_end")).toEqual([expect.objectContaining({ projectId: "p1", _governorToken: "TOK" })]);
    expect(r.sessionEnd).toEqual(expect.objectContaining({ ok: true }));
    expect(r.ok).toBe(true);
  });

  for (const [reason, handler] of [
    ["tool_error", () => ({ ok: false })],
    ["call_threw", () => { throw new Error("transport closed"); }],
    ["auto_routed", () => ({ ok: true, _autoRouted: true })],
    ["unverifiable_payload", () => ({})],
  ]) {
    it(`still ends the session once and last on stop-on-first-failure (${reason}), step results unchanged`, async () => {
      const client = stubClient({ b: handler });
      const r = await runBatch({ ...base, client, calls: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] });
      expect(names(client)).toEqual(["rks_governor_init", "a", "b", "rks_governor_end"]);
      expect(r.steps[0].ok).toBe(true);
      expect(r.steps[1]).toEqual(expect.objectContaining({ ok: false, reason }));
      expect(r.failedAt).toBe(1);
      expect(r.skipped).toEqual([2]);
      expect(r.steps.some((s) => s.tool === "rks_governor_end")).toBe(false);
    });
  }

  it("still ends the session once and last after a continueOnError run with failures", async () => {
    const client = stubClient({ a: () => ({ ok: false }), c: () => ({ error: "x" }) });
    const r = await runBatch({ ...base, continueOnError: true, client, calls: [{ tool: "a" }, { tool: "b" }, { tool: "c" }] });
    expect(names(client)).toEqual(["rks_governor_init", "a", "b", "c", "rks_governor_end"]);
    expect(r.steps.map((s) => s.ok)).toEqual([false, true, false]);
    expect(r.failedAt).toBe(0);
    expect(r.skipped).toEqual([]);
  });

  it("ends a session whose init carried a token without ok true, making no batch call", async () => {
    const client = stubClient({ rks_governor_init: () => ({ ok: false, token: "TOK", reason: "project_leased" }) });
    const r = await runBatch({ ...base, client, calls: [{ tool: "a" }] });
    expect(names(client)).toEqual(["rks_governor_init", "rks_governor_end"]);
    expect(callsTo(client, "rks_governor_end")[0]._governorToken).toBe("TOK");
    expect(r.ok).toBe(false);
  });

  for (const [label, init] of [
    ["ok true without token", () => ({ ok: true })],
    ["ok false without token", () => ({ ok: false, error: "nope" })],
    ["init throws", () => { throw new Error("spawn failed"); }],
  ]) {
    it(`makes no end call when init issued no token (${label})`, async () => {
      const client = stubClient({ rks_governor_init: init });
      const r = await runBatch({ ...base, client, calls: [{ tool: "a" }] }).catch((e) => ({ ok: false, sessionEnd: null, error: String(e) }));
      expect(callsTo(client, "rks_governor_end")).toHaveLength(0);
      expect(r.ok).toBe(false);
      expect(r.sessionEnd ?? null).toBeNull();
    });
  }

  it("never reports the end call as a step and never retries a refused end", async () => {
    const client = stubClient({ rks_governor_end: () => ({ ok: false, reason: "end_blocked", blockedBy: ["guardrailsDisabled"] }) });
    const r = await runBatch({ ...base, client, calls: [{ tool: "a" }] });
    expect(callsTo(client, "rks_governor_end")).toHaveLength(1);
    expect(r.steps).toHaveLength(1);
    expect(r.steps.some((s) => s.tool === "rks_governor_end")).toBe(false);
    expect(r.failedAt).toBeNull();
    expect(r.skipped).toEqual([]);
    expect(r.sessionEnd.blockedBy).toEqual(["guardrailsDisabled"]);
  });

  for (const [label, end, reason] of [
    ["end_blocked", () => ({ ok: false, reason: "end_blocked", blockedBy: ["guardrailsDisabled"] }), "end_blocked"],
    ["project_mismatch", () => ({ ok: false, reason: "project_mismatch" }), "project_mismatch"],
    ["an _autoRouted envelope", () => ({ ok: true, _autoRouted: true }), "auto_routed"],
    ["an ok-less payload", () => ({}), "unverifiable_payload"],
    ["a throw", () => { throw new Error("transport closed"); }, "call_threw"],
  ]) {
    it(`fails the run closed when the end is ${label}, leaving step results unchanged`, async () => {
      const client = stubClient({ rks_governor_end: end });
      const r = await runBatch({ ...base, client, calls: [{ tool: "a" }] });
      expect(r.sessionEnd.ok).toBe(false);
      expect(r.sessionEnd.reason).toBe(reason);
      expect(r.ok).toBe(false);
      expect(r.steps.map((s) => s.ok)).toEqual([true]);
      expect(r.failedAt).toBeNull();
      expect(r.skipped).toEqual([]);
    });
  }

  it("treats ok true, ended false, session_not_live as a clean end", async () => {
    const client = stubClient({ rks_governor_end: () => ({ ok: true, ended: false, reason: "session_not_live" }) });
    const r = await runBatch({ ...base, client, calls: [{ tool: "a" }] });
    expect(r.sessionEnd).toEqual(expect.objectContaining({ ok: true, ended: false, reason: "session_not_live" }));
    expect(r.ok).toBe(true);
  });
});

// backlog.fix.cli-call-throw-path-session-end-report — a throw escaping the step loop is
// recorded in the report and the session is still ended once, last.
describe("runBatch step-loop throw (runner_threw)", () => {
  const base = { projectId: "p1" };
  const names = (client) => client.callTool.mock.calls.map(([c]) => c.name);
  const throwingCalls = () => [
    { tool: "a" },
    {
      tool: "b",
      get arguments() {
        throw new Error("boom");
      },
    },
    { tool: "c" },
  ];

  it("resolves (does not reject) with a report", async () => {
    const client = stubClient();
    const p = runBatch({ ...base, client, calls: throwingCalls() });
    await expect(p).resolves.toEqual(expect.objectContaining({ projectId: "p1" }));
  });

  it("calls rks_governor_end exactly once, last, with projectId and the init token", async () => {
    const client = stubClient();
    await runBatch({ ...base, client, calls: throwingCalls() });
    expect(callsTo(client, "rks_governor_end")).toEqual([{ projectId: "p1", _governorToken: "TOK" }]);
    expect(names(client).at(-1)).toBe("rks_governor_end");
    expect(callsTo(client, "c")).toHaveLength(0);
  });

  it("reports ok false, runner_threw with the message, failedAt 1, skipped [2] and the sessionEnd", async () => {
    const client = stubClient();
    const r = await runBatch({ ...base, client, calls: throwingCalls() });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
    expect(r.skipped).toEqual([2]);
    expect(r.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(r.steps[1]).toEqual(expect.objectContaining({ index: 1, tool: "b", ok: false, reason: "runner_threw" }));
    expect(r.steps[1].error).toMatch(/boom/);
    expect(r.sessionEnd).toEqual(expect.objectContaining({ ok: true }));
  });

  it("fails closed: ok false even when the end succeeds and every step before the throw was ok", async () => {
    const client = stubClient({ rks_governor_end: () => ({ ok: true, ended: true }) });
    const r = await runBatch({ ...base, client, calls: throwingCalls() });
    expect(r.steps[0].ok).toBe(true);
    expect(r.sessionEnd.ok).toBe(true);
    expect(r.ok).toBe(false);
  });

  for (const [label, end] of [
    ["refused", () => ({ ok: false, reason: "end_blocked", blockedBy: ["guardrailsDisabled"] })],
    ["a throw", () => { throw new Error("transport closed"); }],
  ]) {
    it(`resolves ok false with sessionEnd.ok false and no retry when the end is ${label}`, async () => {
      const client = stubClient({ rks_governor_end: end });
      const r = await runBatch({ ...base, client, calls: throwingCalls() });
      expect(r.ok).toBe(false);
      expect(r.sessionEnd.ok).toBe(false);
      expect(callsTo(client, "rks_governor_end")).toHaveLength(1);
      expect(names(client).at(-1)).toBe("rks_governor_end");
    });
  }
});

describe("handleCallCommand", () => {
  function deps(client) {
    return {
      env: { PATH: process.env.PATH || "", RKS_SKIP_PREFLIGHT: "1", RKS_TEST_MODE: "1", NODE_ENV: "test" },
      resolveProjectRoot: vi.fn(() => "/tmp/p1-root"),
      connect: vi.fn(async () => ({ client, close: vi.fn(async () => {}) })),
      log: vi.fn(),
      errorLog: vi.fn(),
      processExit: vi.fn(),
    };
  }

  it("fails on a malformed batch file before connecting", async () => {
    const d = deps(stubClient());
    await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch("{\"tool\":\"a\"}")], SHELL_ROOT: REPO_ROOT }, d);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.processExit).toHaveBeenCalledWith(expect.any(Number));
    expect(d.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("connects exactly once for the batch, prints a JSON report and exits non-zero on failure", async () => {
    const client = stubClient({ b: () => ({ ok: false }) });
    const d = deps(client);
    await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a" }, { tool: "b" }])], SHELL_ROOT: REPO_ROOT }, d);
    expect(d.connect).toHaveBeenCalledTimes(1);
    expect(callsTo(client, "rks_governor_init")).toHaveLength(1);
    const printed = d.log.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(JSON.parse(printed)).toEqual(expect.objectContaining({ ok: false, failedAt: 1 }));
    expect(d.processExit.mock.calls.at(-1)[0]).not.toBe(0);
  });

  for (const [label, payload, reason] of [
    ["_autoRouted envelope", { ok: true, _autoRouted: true }, "auto_routed"],
    ["ok-less payload", {}, "unverifiable_payload"],
  ]) {
    it(`exits non-zero and reports the reason when a step returns an ${label}`, async () => {
      const d = deps(stubClient({ a: () => payload }));
      await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a" }])], SHELL_ROOT: REPO_ROOT }, d);
      const report = JSON.parse(d.log.mock.calls.map((c) => c.join(" ")).join("\n"));
      expect(report.ok).toBe(false);
      expect(report.steps[0]).toEqual(expect.objectContaining({ ok: false, reason }));
      expect(d.processExit.mock.calls.at(-1)[0]).not.toBe(0);
    });
  }

  it("hands connect a scrubbed env carrying the project id, and reports envScrubbed", async () => {
    const d = deps(stubClient());
    await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a" }])], SHELL_ROOT: REPO_ROOT }, d);
    const { env } = d.connect.mock.calls[0][0];
    expect(env.ROUTEKIT_PROJECT_ID).toBe("p1");
    expect(env.ROUTEKIT_PROJECT_ROOT).toBe("/tmp/p1-root");
    expect(env.RKS_SKIP_PREFLIGHT).toBeUndefined();
    expect(env.RKS_TEST_MODE).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    const report = JSON.parse(d.log.mock.calls.map((c) => c.join(" ")).join("\n"));
    expect([...report.envScrubbed].sort()).toEqual(["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"]);
  });

  it("runs --tool/--args as a one-entry batch with the same report shape", async () => {
    const client = stubClient();
    const d = deps(client);
    await handleCallCommand({ args: ["call", "--project", "p1", "--tool", "a", "--args", "{\"q\":1}"], SHELL_ROOT: REPO_ROOT }, d);
    expect(d.connect).toHaveBeenCalledTimes(1);
    expect(callsTo(client, "a")).toEqual([{ q: 1, projectId: "p1", _governorToken: "TOK" }]);
    const report = JSON.parse(d.log.mock.calls.map((c) => c.join(" ")).join("\n"));
    expect(report).toEqual(expect.objectContaining({ ok: true, projectId: "p1", failedAt: null, skipped: [] }));
    expect(report.steps).toHaveLength(1);
  });

  it("refuses a batch entry carrying _governorToken before connecting, exiting non-zero", async () => {
    const d = deps(stubClient());
    await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a", arguments: { _governorToken: "x" } }])], SHELL_ROOT: REPO_ROOT }, d);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("refuses --tool rks_governor_init before connecting, exiting non-zero", async () => {
    const d = deps(stubClient());
    await handleCallCommand({ args: ["call", "--project", "p1", "--tool", "rks_governor_init"], SHELL_ROOT: REPO_ROOT }, d);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.processExit.mock.calls[0][0]).not.toBe(0);
  });

  it("exits non-zero with sessionEnd.ok false when every step passed but the session end was refused", async () => {
    const d = deps(stubClient({ rks_governor_end: () => ({ ok: false, reason: "end_blocked", blockedBy: ["guardrailsDisabled"] }) }));
    await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a" }])], SHELL_ROOT: REPO_ROOT }, d);
    const report = JSON.parse(d.log.mock.calls.map((c) => c.join(" ")).join("\n"));
    expect(report.steps[0].ok).toBe(true);
    expect(report.sessionEnd.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(d.processExit.mock.calls.at(-1)[0]).not.toBe(0);
  });

  it("prints the throw-path report with sessionEnd and envScrubbed, without 'runner failed', and exits 1", async () => {
    const realParse = JSON.parse;
    // A failed step payload marked __throwState exposes a throwing state getter, so the step loop throws.
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const v = realParse(text, reviver);
      if (v && typeof v === "object" && v.__throwState === true) {
        delete v.__throwState;
        Object.defineProperty(v, "state", {
          enumerable: false,
          get() {
            throw new Error("state getter exploded");
          },
        });
      }
      return v;
    });
    let d;
    try {
      d = deps(stubClient({ a: () => ({ ok: false, __throwState: true }) }));
      await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a" }, { tool: "b" }])], SHELL_ROOT: REPO_ROOT }, d);
    } finally {
      spy.mockRestore();
    }
    expect(d.log).toHaveBeenCalledTimes(1);
    const report = JSON.parse(d.log.mock.calls[0].join(" "));
    expect(report).toHaveProperty("sessionEnd");
    expect(report.sessionEnd).toEqual(expect.objectContaining({ ok: true }));
    expect(report).toHaveProperty("envScrubbed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toBe(0);
    expect(report.skipped).toEqual([1]);
    expect(report.steps[0]).toEqual(expect.objectContaining({ ok: false, reason: "runner_threw" }));
    const allLogged = [...d.log.mock.calls, ...d.errorLog.mock.calls].map((c) => c.join(" ")).join("\n");
    expect(allLogged).not.toMatch(/runner failed/);
    expect(d.processExit.mock.calls.at(-1)[0]).toBe(1);
  });
});

describe("call.js governance parity", () => {
  it("imports no packages/mcp-rks/src module or tool handler", () => {
    expect(CALL_SRC).not.toMatch(/mcp-rks\/src/);
    expect(CALL_SRC).not.toMatch(/from\s*["'][^"']*\/tools\//);
  });
  it("reaches tools through the MCP client and a spawned mcp-rks.mjs", () => {
    expect(CALL_SRC).toContain("mcp-rks.mjs");
    expect(CALL_SRC).toMatch(/StdioClientTransport/);
  });
});

describe("routekit.js wiring", () => {
  it("imports handleCallCommand from ../src/cli/call.js", () => {
    expect(CLI_SRC).toMatch(/import\s*\{\s*handleCallCommand\s*\}\s*from\s*["']\.\.\/src\/cli\/call\.js["']/);
  });
  it("dispatches cmd === \"call\"", () => {
    expect(CLI_SRC).toMatch(/if\s*\(\s*cmd\s*===\s*["']call["']\s*\)/);
  });
  it("lists the call verb with --batch in the help text", () => {
    expect(CLI_SRC).toMatch(/\n\s+call\s+--project <id> --batch <calls\.json>/);
  });
  it("help text states hooks do not run for CLI calls and governance is server-side", () => {
    expect(CLI_SRC).toMatch(/hooks do not run for CLI calls/);
    expect(CLI_SRC).toMatch(/token gate/);
  });
});

// backlog.feat.project-lease-actor-attribution §6a / AC24: the routekit call lane. The server resolves
// via from RKS_VIA before the init input, so buildServerEnv always sets RKS_VIA=call and names an
// overridden inherited value in scrubbed; RKS_ACTOR and RKS_DISPATCH_RUN_ID pass through unchanged.
// Audit of the assertions above: the runBatch init assertion uses expect.objectContaining({ projectId,
// flowType }), the buildServerEnv env assertion uses expect.objectContaining, the clean-env case asserts
// only scrubbed equal to [], and the handleCallCommand envScrubbed case passes no RKS_VIA, so all stay
// true with RKS_VIA=call in the env and via: "call" in the init arguments.
describe("routekit call lane attribution (AC24)", () => {
  const ids = { RKS_ACTOR: "agent-7", RKS_DISPATCH_RUN_ID: "run-42" };

  for (const [label, inherited, expectScrubbed] of [
    ["no inherited RKS_VIA", undefined, false],
    ["inherited RKS_VIA=call", "call", false],
    ["inherited RKS_VIA=dispatch", "dispatch", true],
  ]) {
    it(`buildServerEnv with ${label}: env RKS_VIA is call; scrubbed ${expectScrubbed ? "names" : "omits"} RKS_VIA; actor and run id pass through`, () => {
      const base = { PATH: "/bin", ...ids, ...(inherited === undefined ? {} : { RKS_VIA: inherited }) };
      const snapshot = { ...base };
      const { env, scrubbed } = buildServerEnv(base, { projectId: "p1", projectRoot: "/r" });
      expect(env.RKS_VIA).toBe("call");
      expect(scrubbed.includes("RKS_VIA")).toBe(expectScrubbed);
      expect(env.RKS_ACTOR).toBe("agent-7");
      expect(env.RKS_DISPATCH_RUN_ID).toBe("run-42");
      expect(base).toEqual(snapshot); // baseEnv not mutated: RKS_VIA keeps its value or absence
      expect("RKS_VIA" in base).toBe(inherited !== undefined);
    });
  }

  it("runBatch sends exactly one rks_governor_init whose arguments include via call", async () => {
    const client = stubClient();
    await runBatch({ projectId: "p1", client, calls: [{ tool: "a", arguments: {} }] });
    const inits = callsTo(client, "rks_governor_init");
    expect(inits).toHaveLength(1);
    expect(inits[0]).toEqual(expect.objectContaining({ projectId: "p1", flowType: "open", via: "call" }));
  });

  it("handleCallCommand with an inherited RKS_VIA=dispatch hands connect RKS_VIA=call and reports RKS_VIA in envScrubbed", async () => {
    const client = stubClient();
    const d = {
      env: { PATH: process.env.PATH || "", RKS_VIA: "dispatch", ...ids },
      resolveProjectRoot: vi.fn(() => "/tmp/p1-root"),
      connect: vi.fn(async () => ({ client, close: vi.fn(async () => {}) })),
      log: vi.fn(),
      errorLog: vi.fn(),
      processExit: vi.fn(),
    };
    await handleCallCommand({ args: ["call", "--project", "p1", "--batch", tmpBatch([{ tool: "a" }])], SHELL_ROOT: REPO_ROOT }, d);
    const { env } = d.connect.mock.calls[0][0];
    expect(env.RKS_VIA).toBe("call");
    expect(env.RKS_ACTOR).toBe("agent-7");
    expect(env.RKS_DISPATCH_RUN_ID).toBe("run-42");
    const report = JSON.parse(d.log.mock.calls.map((c) => c.join(" ")).join("\n"));
    expect(report.envScrubbed).toContain("RKS_VIA");
  });

  it("buildServerEnv's doc comment states the D15 caveat: scrubbed names values removed OR replaced", () => {
    const at = CALL_SRC.indexOf("export function buildServerEnv");
    const doc = CALL_SRC.slice(Math.max(0, at - 900), at);
    expect(doc).toMatch(/removed OR\s*(\/\/\s*)?replaced/);
    expect(doc).toMatch(/RKS_VIA=call/);
  });
});
