// backlog.feat.dispatch-detach-status — unit tests for `routekit dispatch --detach` and `--status`.
// Every claude and worker spawn goes through an injected spawn seam (mirror fakeSpawn/run/childTarget
// in tests/unit/routekit-dispatch.test.mjs); no real process is launched. Temp roots via fs.mkdtempSync,
// removed in afterEach. Each `it` is named TRnn after the position of its testRequirement in the story
// frontmatter (TR01-TR40 here; the two AC20 requirements live in routekit-dispatch.test.mjs) and
// carries an explicit timeout.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  handleDispatchCommand,
  parseDispatchArgs,
  runRecordPath,
  runDispatchWorker,
  handoffPath,
  eventsLogPath,
  isProcessAlive,
  buildClaudeArgs,
  buildSpawnEnv,
  RELEASE_TOOLS,
  USER_ACTOR_ENV_KEY,
  WORKER_NONCE_ENV_KEY,
  DISPATCH_USAGE,
  EXIT_CODES,
} from "../../packages/cli/src/cli/dispatch.js";

const TEST_TIMEOUT = 30_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_ENTRY = "/opt/fake-rks/packages/cli/bin/routekit.js";
const FIXED_NOW = "2026-11-03T12:00:00.000Z";
const WORKER_PID = 777001;
// The one harness nonce: makeDeps injects it into every launch and work() merges it into every worker env.
const TEST_WORKER_NONCE = "0123456789abcdef".repeat(4);

// ---------- fixtures ----------

const tmpDirs = [];
function tmp(prefix = "rks-dds-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function childTarget({ stamp = "0.85.0", dispatch } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  const pj = { id: "child", rksVersion: stamp };
  if (dispatch !== undefined) pj.dispatch = dispatch;
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(pj));
  return root;
}
const setProjectJson = (root, pj) => fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: "child", rksVersion: "0.85.0", ...pj }));

const INIT = (sid = "sess-from-init") => ({ type: "system", subtype: "init", session_id: sid, mcp_servers: [] });
const RESULT = (structured, extra = {}) => ({ type: "result", subtype: "success", is_error: false, session_id: "sess-from-init", structured_output: structured, ...extra });
const COMPLETE = { status: "complete", summary: "done" };
const awaiting = (kind, id = "cp-1") => ({
  status: "awaiting_human",
  summary: "waiting",
  checkpoint: { id, kind, storyIds: ["backlog.x"], question: "proceed?", options: ["yes", "no"], recommendation: "yes" },
});
// A result.permission_denials entry, and a user-event tool_result for it that is not a hook block (source permission).
const DENIED = (i) => ({ tool_name: "Write", tool_use_id: `toolu_denied_${i}`, tool_input: { file_path: `f${i}` } });
const REFUSED = (i) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", content: "Refused by permission mode.", is_error: true, tool_use_id: `toolu_denied_${i}` }] } });
const lines = (...events) => events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));

/** Fake claude: emits scripted stdout/stderr lines then closes. `throw` makes the spawn call throw. */
function fakeSpawn(script = {}, { onCall, beforeClose } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (onCall) onCall({ command, args, options });
    if (script.throw) throw new Error(script.throw);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      for (const l of script.stderr || []) child.stderr.write(l + "\n");
      for (const l of script.stdout || lines(INIT(), RESULT(COMPLETE))) child.stdout.write(l + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => {
        if (beforeClose) beforeClose();
        child.emit("close", script.exitCode ?? 0);
      });
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** Fake worker launcher: the child emits `spawn` (or `error`), exposes pid and counts unref(). */
function launcherSpawn({ mode = "spawn", pid = 4242, onCall } = {}) {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (onCall) onCall({ command, args, options });
    if (mode === "throw") throw new Error("spawn EAGAIN (fake launcher)");
    const child = new EventEmitter();
    child.pid = mode === "nopid" ? undefined : pid;
    child.unrefCalls = 0;
    child.unref = () => {
      child.unrefCalls += 1;
    };
    children.push(child);
    setImmediate(() => {
      if (mode === "error") child.emit("error", new Error("spawn ENOENT (fake worker)"));
      else child.emit("spawn");
    });
    return child;
  };
  spawn.calls = calls;
  spawn.children = children;
  return spawn;
}

function makeDeps(o = {}) {
  const out = [];
  const err = [];
  const events = [];
  const counts = { resolveCredential: 0, findClaude: 0 };
  const projectId = o.projectId || "child";
  const deps = {
    spawn: o.spawn || fakeSpawn(),
    getProject: async (id) => (o.root && id === projectId ? { id, root: o.root } : null),
    listProjects: async () => (o.root ? [{ id: projectId, root: o.root }] : []),
    resolveCredential: async () => {
      counts.resolveCredential += 1;
      return { credential: o.credential || "api" };
    },
    findClaude: async () => {
      counts.findClaude += 1;
      return o.claude === undefined ? "/usr/local/bin/claude" : o.claude;
    },
    env: o.env || {},
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    telemetry: async (type, payload) => events.push({ type, payload }),
  };
  if (o.workerEntry !== null) deps.workerEntry = o.workerEntry || WORKER_ENTRY;
  if (o.newWorkerNonce !== null) deps.newWorkerNonce = o.newWorkerNonce || (() => TEST_WORKER_NONCE);
  for (const k of ["newRunId", "now", "pid", "isProcessAlive"]) if (o[k] !== undefined) deps[k] = o[k];
  return { deps, out, err, events, counts };
}

async function run(argv, o = {}) {
  const m = makeDeps(o);
  const { result, exitCode } = await handleDispatchCommand({ args: ["dispatch", ...argv], kv: {}, SHELL_ROOT: tmp("rks-dds-sr-") }, m.deps);
  return { result, exitCode, out: m.out.join(""), err: m.err.join(""), events: m.events, spawn: m.deps.spawn, counts: m.counts };
}

/** Worker env: the caller's env merged (never replaced) with TEST_WORKER_NONCE; the caller's key wins, workerNonce null omits it. */
function workerEnvFor(o) {
  const env = { ...(o.env || {}) };
  if (o.workerNonce === null) return env;
  if (!Object.prototype.hasOwnProperty.call(env, WORKER_NONCE_ENV_KEY)) env[WORKER_NONCE_ENV_KEY] = o.workerNonce || TEST_WORKER_NONCE;
  return env;
}

async function work(runId, o = {}) {
  const m = makeDeps({ pid: WORKER_PID, ...o, env: workerEnvFor(o) });
  const { result, exitCode } = await runDispatchWorker({ runId, projectId: o.projectId || "child", SHELL_ROOT: tmp("rks-dds-sr-") }, m.deps);
  return { result, exitCode, out: m.out.join(""), err: m.err.join(""), events: m.events, spawn: m.deps.spawn, counts: m.counts };
}

const newRun = (actor = "agent-a", extra = []) => ["--project", "child", "--actor", actor, ...extra, "build the thing"];
const answer = (runId, cp, actor, extra = [], text = "go ahead") => ["--resume", runId, "--answer", cp, "--actor", actor, ...extra, text];
const statusArgs = (runId, actor = "agent-a") => ["--status", runId, "--project", "child", "--actor", actor];
const detach = (root, { actor = "agent-a", mode, pid, ...o } = {}) =>
  run(newRun(actor, ["--detach"]), { root, spawn: launcherSpawn({ mode, pid }), ...o });

const ddir = (root) => path.join(root, ".rks", "session", "dispatch");
const listDir = (root) => (fs.existsSync(ddir(root)) ? fs.readdirSync(ddir(root)) : []);
const readRecord = (root, runId) => JSON.parse(fs.readFileSync(runRecordPath(root, runId), "utf8"));
const readHandoff = (root, runId) => JSON.parse(fs.readFileSync(handoffPath(root, runId), "utf8"));
const patchHandoff = (root, runId, fn) => {
  const h = readHandoff(root, runId);
  fn(h);
  fs.writeFileSync(handoffPath(root, runId), JSON.stringify(h));
};
const writeRecord = (root, rec) => {
  fs.mkdirSync(ddir(root), { recursive: true });
  fs.writeFileSync(runRecordPath(root, rec.runId), JSON.stringify(rec, null, 2) + "\n");
};
const baseRecord = (runId, extra = {}) => ({
  runId,
  projectId: "child",
  initiator: "agent-a",
  claudeSessionId: null,
  status: "running",
  startedAt: "2026-11-03T00:00:00.000Z",
  updatedAt: null,
  admissionCredential: "api",
  rksVersion: "0.85.0",
  rksVersionSource: "stamp",
  permissionDenied: 0,
  checkpoints: [],
  ...extra,
});
const outLines = (out) => out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const norm = (result) => ({ ...result, runId: "x" });
const TAIL_EVENTS = ["dispatch.checkpoint_raised", "dispatch.permission_denied", "dispatch.completed"];
const tailEvents = (events) => events.filter((e) => TAIL_EVENTS.includes(e.type)).map((e) => ({ type: e.type, payload: { ...e.payload, runId: "x" } }));
const completedFailed = (events) => events.some((e) => e.type === "dispatch.completed" && e.payload.status === "failed");

/** Blocking run with the given claude script, then the same intent detached + worker in a twin root. */
async function blockingAndWorker(script, { dispatch, env = {}, actor = "agent-a", workerEnv } = {}) {
  const rootB = childTarget({ dispatch });
  const blocking = await run(newRun(actor, ["--json"]), { root: rootB, env, spawn: fakeSpawn(script) });
  const rootW = childTarget({ dispatch });
  const launched = await detach(rootW, { actor, env });
  expect(launched.exitCode).toBe(0);
  const runId = launched.result.runId;
  const worker = await work(runId, { root: rootW, env: workerEnv || env, spawn: fakeSpawn(script) });
  return { rootB, blocking, rootW, runId, worker };
}

// ---------- AC1 / AC2: parsing and usage ----------

describe("AC1/AC2 — parsing and --status usage", () => {
  it("TR01 AC1: --detach is a value-less flag, --status <runId> a value option; --detach=x is a usage error exactly as --json=x", async () => {
    expect(parseDispatchArgs(["dispatch", "--detach", "--status", "r-1", "--project", "p"])).toMatchObject({ detach: true, status: "r-1", project: "p" });
    expect(parseDispatchArgs(["--status=r-2"]).status).toBe("r-2");
    expect(() => parseDispatchArgs(["--status"])).toThrow("--status needs a value");
    expect(() => parseDispatchArgs(["--detach=x"])).toThrow("--detach takes no value");
    expect(() => parseDispatchArgs(["--json=x"])).toThrow("--json takes no value");
    const root = childTarget();
    const d = await run(["--detach=x", ...newRun()], { root });
    const j = await run(["--json=x", ...newRun()], { root });
    for (const r of [d, j]) {
      expect(r.exitCode).toBe(EXIT_CODES.usage);
      expect(r.result.reason).toBe("usage");
      expect(r.spawn.calls).toHaveLength(0);
    }
  }, TEST_TIMEOUT);

  it("TR02 AC2: --status with --resume, --answer, --detach or a positional intent → exit 2, spawn never called", async () => {
    const root = childTarget();
    for (const extra of [["--resume", "r1"], ["--answer", "cp-1"], ["--detach"], ["an intent"]]) {
      const r = await run([...statusArgs("r1"), ...extra], { root });
      expect(r.exitCode, extra.join(" ")).toBe(EXIT_CODES.usage);
      expect(r.spawn.calls).toHaveLength(0);
    }
  }, TEST_TIMEOUT);

  it("TR03 AC2: --status without --project → exit 2; without --actor → actor_required, exit 2", async () => {
    const root = childTarget();
    const noProject = await run(["--status", "r1", "--actor", "agent-a"], { root });
    expect(noProject.exitCode).toBe(EXIT_CODES.usage);
    expect(noProject.spawn.calls).toHaveLength(0);
    const noActor = await run(["--status", "r1", "--project", "child"], { root });
    expect(noActor.result.reason).toBe("actor_required");
    expect(noActor.exitCode).toBe(EXIT_CODES.usage);
    expect(noActor.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);
});

// ---------- AC3-AC5: fresh --detach ----------

describe("AC3-AC5 — fresh --detach", () => {
  it("TR04 AC3: a failing admission refuses --detach with the blocking reason and exit 1, no handoff, no spawn", async () => {
    const cases = [
      ["credential_required", {}, { credential: "none" }],
      ["claude_cli_unavailable", {}, { claude: null }],
      ["rks_version_unsupported", { stamp: "0.84.0" }, {}],
      ["invalid_dispatch_config", { dispatch: { reservedForUser: "po_review_confirmation" } }, {}],
    ];
    for (const [reason, target, o] of cases) {
      const blocking = await run(newRun(), { root: childTarget(target), ...o });
      const root = childTarget(target);
      const det = await detach(root, o);
      expect(blocking.result.reason).toBe(reason);
      expect(det.result.reason).toBe(reason);
      expect(det.exitCode).toBe(blocking.exitCode);
      expect(det.exitCode).toBe(EXIT_CODES.failure);
      expect(det.spawn.calls).toHaveLength(0);
      expect(listDir(root).filter((f) => f.includes(".handoff."))).toEqual([]);
    }
  }, TEST_TIMEOUT);

  it("TR05 AC4: record running/detached/workerPid null and the handoff exist before launch; the worker is launched as process.execPath workerEntry dispatch --_worker", async () => {
    const root = childTarget();
    let atLaunch = null;
    const spawn = launcherSpawn({
      onCall: ({ args }) => {
        const runId = args[3];
        atLaunch = { record: readRecord(root, runId), handoff: fs.existsSync(handoffPath(root, runId)) };
      },
    });
    const r = await run(newRun("agent-a", ["--detach"]), { root, spawn });
    const runId = r.result.runId;
    expect(atLaunch.record).toMatchObject({ runId, status: "running", detached: true, workerPid: null });
    expect(atLaunch.handoff).toBe(true);
    expect(spawn.calls).toHaveLength(1);
    const { command, args, options } = spawn.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([WORKER_ENTRY, "dispatch", "--_worker", runId, "--project", "child", "--actor", "agent-a"]);
    expect(options.detached).toBe(true);
    expect(options.cwd).toBe(root);
    expect(Array.isArray(options.stdio)).toBe(true);
    expect(options.stdio.some((s) => s === "pipe")).toBe(false);
    // default workerEntry is the absolute packages/cli/bin/routekit.js
    const d2 = launcherSpawn();
    await run(newRun("agent-a", ["--detach"]), { root: childTarget(), spawn: d2, workerEntry: null });
    expect(d2.calls[0].args[0]).toBe(path.join(REPO_ROOT, "packages", "cli", "bin", "routekit.js"));
  }, TEST_TIMEOUT);

  it("TR06 AC4: the handoff carries the foreground's userActor, validated reservedForUser and admission", async () => {
    const withUser = childTarget();
    const a = await detach(withUser, { env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    const ha = readHandoff(withUser, a.result.runId);
    expect(ha.userActor).toBe("vince");
    expect(ha.reservedForUser).toEqual(["po_review_confirmation"]); // defaulted: no dispatch block
    expect(ha.admission).toEqual({ admissionCredential: "api", rksVersion: "0.85.0", rksVersionSource: "stamp" });
    expect(ha).toMatchObject({ runId: a.result.runId, projectId: "child", prompt: "build the thing", resumeSessionId: null, releaseAllowed: false, initiator: "agent-a" });
    expect(typeof ha.writtenAt).toBe("string");
    const optOut = childTarget({ dispatch: { reservedForUser: [] }, stamp: "0.85.1" });
    const b = await detach(optOut, { credential: "subscription" });
    const hb = readHandoff(optOut, b.result.runId);
    expect(hb.userActor).toBeNull();
    expect(hb.reservedForUser).toEqual([]);
    expect(hb.admission).toEqual({ admissionCredential: "subscription", rksVersion: "0.85.1", rksVersionSource: "stamp" });
  }, TEST_TIMEOUT);

  it("TR07 AC4: a confirmed launch calls unref(), prints exactly one success line with workerPid, exits 0, never spawns claude, and leaves the record unchanged", async () => {
    const root = childTarget();
    let recordBytesAtLaunch = null;
    const spawn = launcherSpawn({
      pid: 4242,
      onCall: ({ args }) => {
        recordBytesAtLaunch = fs.readFileSync(runRecordPath(root, args[3]), "utf8");
      },
    });
    const r = await run(newRun("agent-a", ["--detach"]), { root, spawn });
    expect(r.exitCode).toBe(0);
    expect(spawn.children[0].unrefCalls).toBe(1);
    const printed = outLines(r.out);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toEqual({ ok: true, status: "running", detached: true, runId: r.result.runId, projectId: "child", initiator: "agent-a", workerPid: 4242 });
    expect(spawn.calls.every((c) => c.command === process.execPath)).toBe(true);
    expect(spawn.calls.some((c) => c.command === "claude")).toBe(false);
    expect(fs.readFileSync(runRecordPath(root, r.result.runId), "utf8")).toBe(recordBytesAtLaunch);
  }, TEST_TIMEOUT);

  it("TR08 AC5: error before spawn → no success line, worker_spawn_failed exit 1 with the message, handoff removed, record failed, dispatch.completed failed", async () => {
    const root = childTarget();
    const r = await detach(root, { mode: "error" });
    expect(outLines(r.out).some((l) => l.ok === true)).toBe(false);
    expect(r.result).toMatchObject({ ok: false, reason: "worker_spawn_failed" });
    expect(r.result.message).toContain("spawn ENOENT (fake worker)");
    expect(r.exitCode).toBe(EXIT_CODES.failure);
    const runId = r.result.runId;
    expect(fs.existsSync(handoffPath(root, runId))).toBe(false);
    expect(readRecord(root, runId)).toMatchObject({ status: "failed", failureReason: "worker_spawn_failed" });
    expect(completedFailed(r.events)).toBe(true);
    expect(r.spawn.children[0].unrefCalls).toBe(0);
  }, TEST_TIMEOUT);

  it("TR09 AC5: pid undefined / not a positive integer, and a throwing spawn → worker_spawn_failed, no success line, handoff removed, record failed, no unref()", async () => {
    const cases = [{ mode: "nopid" }, { pid: 0 }, { pid: -3 }, { pid: 1.5 }, { pid: "123" }, { mode: "throw" }];
    for (const c of cases) {
      const root = childTarget();
      const r = await detach(root, c);
      expect(outLines(r.out).some((l) => l.ok === true), JSON.stringify(c)).toBe(false);
      expect(r.result.reason).toBe("worker_spawn_failed");
      expect(r.exitCode).toBe(EXIT_CODES.failure);
      expect(fs.existsSync(handoffPath(root, r.result.runId))).toBe(false);
      expect(readRecord(root, r.result.runId)).toMatchObject({ status: "failed", failureReason: "worker_spawn_failed" });
      for (const child of r.spawn.children) expect(child.unrefCalls).toBe(0);
    }
  }, TEST_TIMEOUT);
});

// ---------- AC6: resume --detach ----------

describe("AC6 — --resume --detach", () => {
  const raise = async (root, { kind = "build_tests_failed", actor = "agent-a", env = {}, stdout, now } = {}) => {
    const r = await run(newRun(actor), { root, env, now, spawn: fakeSpawn({ stdout: stdout || lines(INIT("sess-orig"), RESULT(awaiting(kind, "cp-9"))) }) });
    expect(r.result.status).toMatch(/^awaiting_/);
    return r.result.runId;
  };

  it("TR10 AC6: checkpoint_not_open, reserved_for_user, answerer_not_initiator and claude_session_unknown refuse --detach as blocking resume does, no handoff, no spawn", async () => {
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const cases = [];
    const r1 = childTarget();
    cases.push(["checkpoint_not_open", r1, await raise(r1), "cp-wrong", "agent-a", {}]);
    const r2 = childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } });
    cases.push(["reserved_for_user", r2, await raise(r2, { kind: "po_review_confirmation", env }), "cp-9", "agent-a", env]);
    const r3 = childTarget();
    cases.push(["answerer_not_initiator", r3, await raise(r3, { kind: "arch_needs_revision", env }), "cp-9", "agent-b", env]);
    const r4 = childTarget();
    const noSession = lines(RESULT(awaiting("build_tests_failed", "cp-9"), { session_id: undefined }));
    cases.push(["claude_session_unknown", r4, await raise(r4, { stdout: noSession }), "cp-9", "agent-a", {}]);
    for (const [reason, root, runId, cp, actor, e] of cases) {
      const det = await run(answer(runId, cp, actor, ["--detach"]), { root, env: e, spawn: launcherSpawn() });
      const blocking = await run(answer(runId, cp, actor), { root, env: e });
      expect(det.result.reason).toBe(reason);
      expect(blocking.result.reason).toBe(reason);
      expect(det.exitCode).toBe(blocking.exitCode);
      expect(det.spawn.calls).toHaveLength(0);
      expect(blocking.spawn.calls).toHaveLength(0);
      expect(fs.existsSync(handoffPath(root, runId))).toBe(false);
    }
  }, TEST_TIMEOUT);

  it("TR11 AC6: an admitted --resume --detach records the answer and status running as blocking resume does; handoff releaseAllowed equals the blocking value", async () => {
    const now = () => FIXED_NOW;
    for (const [actor, env] of [["agent-a", {}], ["vince", { [USER_ACTOR_ENV_KEY]: "vince" }]]) {
      const rootB = childTarget();
      const runB = await raise(rootB, { actor, env, now });
      let snapshot = null;
      const blocking = await run(answer(runB, "cp-9", actor, [], "fix it"), {
        root: rootB,
        env,
        now,
        spawn: fakeSpawn({}, { onCall: () => (snapshot = readRecord(rootB, runB)) }),
      });
      const blockingRelease = !blocking.spawn.calls[0].args[blocking.spawn.calls[0].args.indexOf("--disallowedTools") + 1].split(",").includes(RELEASE_TOOLS[0]);

      const rootD = childTarget();
      const runD = await raise(rootD, { actor, env, now });
      const det = await run(answer(runD, "cp-9", actor, ["--detach"], "fix it"), { root: rootD, env, now, spawn: launcherSpawn() });
      expect(det.exitCode).toBe(0);
      const rec = readRecord(rootD, runD);
      expect(rec.status).toBe("running");
      expect(snapshot.status).toBe("running");
      expect(rec.checkpoints).toEqual(snapshot.checkpoints);
      expect(rec.checkpoints[0]).toMatchObject({ answeredBy: actor, answeredVia: "dispatch", answer: "fix it", answeredAt: FIXED_NOW });
      expect(det.events.some((e) => e.type === "dispatch.checkpoint_answered")).toBe(true);
      const h = readHandoff(rootD, runD);
      expect(h.releaseAllowed).toBe(blockingRelease);
      expect(h.releaseAllowed).toBe(actor === "vince");
      expect(h).toMatchObject({ prompt: "fix it", resumeSessionId: "sess-orig", initiator: actor });
    }
  }, TEST_TIMEOUT);

  it("TR12 AC6: the resume handoff carries the resume foreground's userActor, reservedForUser and its own admission, not the record's fresh-segment values", async () => {
    for (const [env, expectedUser] of [[{ [USER_ACTOR_ENV_KEY]: "vince" }, "vince"], [{}, null]]) {
      const root = childTarget();
      const runId = await raise(root, { env });
      expect(readRecord(root, runId)).toMatchObject({ admissionCredential: "api", rksVersion: "0.85.0", rksVersionSource: "stamp" });
      setProjectJson(root, { rksVersion: "0.86.0", dispatch: { reservedForUser: ["governor_failed"] } });
      const det = await run(answer(runId, "cp-9", "agent-a", ["--detach"]), { root, env, credential: "subscription", spawn: launcherSpawn() });
      expect(det.exitCode).toBe(0);
      const h = readHandoff(root, runId);
      expect(h.userActor).toBe(expectedUser);
      expect(h.reservedForUser).toEqual(["governor_failed"]);
      expect(h.admission).toEqual({ admissionCredential: "subscription", rksVersion: "0.86.0", rksVersionSource: "stamp" });
      expect(readRecord(root, runId)).toMatchObject({ admissionCredential: "api", rksVersion: "0.85.0" });
    }
  }, TEST_TIMEOUT);
});

// ---------- AC7-AC9: the worker ----------

describe("AC7-AC9 — runDispatchWorker", () => {
  it("TR13 AC7: runDispatchWorker is exported; it consumes the pending handoff and spawns claude exactly once", async () => {
    expect(typeof runDispatchWorker).toBe("function");
    const root = childTarget();
    const launched = await detach(root);
    const runId = launched.result.runId;
    expect(fs.existsSync(handoffPath(root, runId))).toBe(true);
    const w = await work(runId, { root });
    expect(fs.existsSync(handoffPath(root, runId))).toBe(false);
    expect(listDir(root).some((f) => f.endsWith(".claimed"))).toBe(false);
    expect(w.spawn.calls).toHaveLength(1);
    expect(w.spawn.calls[0].command).toBe("claude");
    expect(w.result.status).toBe("complete");
    expect(w.exitCode).toBe(0);
  }, TEST_TIMEOUT);

  it("TR14 AC7: a second invocation and a runId that never had a handoff refuse handoff_not_found, exit 1, zero spawns", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    await work(runId, { root });
    const second = await work(runId, { root });
    expect(second.result.reason).toBe("handoff_not_found");
    expect(second.exitCode).toBe(EXIT_CODES.failure);
    expect(second.spawn.calls).toHaveLength(0);
    const never = await work("never-had-a-handoff", { root });
    expect(never.result.reason).toBe("handoff_not_found");
    expect(never.exitCode).toBe(EXIT_CODES.failure);
    expect(never.spawn.calls).toHaveLength(0);
    const traversal = await work("../x", { root });
    expect(traversal.result.reason).toBe("handoff_not_found");
    expect(traversal.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("TR15 AC7: the worker takes initiator and releaseAllowed from the handoff and cannot widen release", async () => {
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const disallowed = (call) => call.args[call.args.indexOf("--disallowedTools") + 1].split(",");
    const setup = async () => {
      const root = childTarget();
      const raised = await run(newRun("vince"), { root, env, spawn: fakeSpawn({ stdout: lines(INIT("s-r"), RESULT(awaiting("build_tests_failed", "cp-r"))) }) });
      const runId = raised.result.runId;
      const det = await run(answer(runId, "cp-r", "vince", ["--detach"]), { root, env, spawn: launcherSpawn() });
      expect(det.exitCode).toBe(0);
      expect(readHandoff(root, runId).releaseAllowed).toBe(true); // the record would admit release
      return { root, runId };
    };
    const narrowed = await setup();
    patchHandoff(narrowed.root, narrowed.runId, (h) => (h.releaseAllowed = false));
    const w = await work(narrowed.runId, { root: narrowed.root, env });
    expect(w.spawn.calls).toHaveLength(1);
    for (const t of RELEASE_TOOLS) expect(disallowed(w.spawn.calls[0])).toContain(t);
    expect(w.spawn.calls[0].options.env.RKS_ACTOR).toBe("vince");
    expect(w.result.initiator).toBe("vince");
    const untouched = await setup();
    const w2 = await work(untouched.runId, { root: untouched.root, env });
    for (const t of RELEASE_TOOLS) expect(disallowed(w2.spawn.calls[0])).not.toContain(t);
  }, TEST_TIMEOUT);

  it("TR16 AC7: malformed userActor / reservedForUser / admission handoffs → handoff_invalid, exit 1, zero spawns, record failed, dispatch.completed failed; userActor null + [] is valid", async () => {
    const mutations = [
      ["userActor absent", (h) => delete h.userActor],
      ["userActor empty string", (h) => (h.userActor = "")],
      ["userActor 42", (h) => (h.userActor = 42)],
      ["reservedForUser absent", (h) => delete h.reservedForUser],
      ["reservedForUser not an array", (h) => (h.reservedForUser = "po_review_confirmation")],
      ["reservedForUser non-string entry", (h) => (h.reservedForUser = ["po_review_confirmation", 7])],
      ["admission absent", (h) => delete h.admission],
      ["admission not an object", (h) => (h.admission = "api")],
      ["admissionCredential none", (h) => (h.admission.admissionCredential = "none")],
    ];
    for (const [label, mutate] of mutations) {
      const root = childTarget();
      const runId = (await detach(root)).result.runId;
      patchHandoff(root, runId, mutate);
      const w = await work(runId, { root });
      expect(w.result.reason, label).toBe("handoff_invalid");
      expect(w.exitCode).toBe(EXIT_CODES.failure);
      expect(w.spawn.calls).toHaveLength(0);
      expect(readRecord(root, runId)).toMatchObject({ status: "failed", failureReason: "handoff_invalid" });
      expect(completedFailed(w.events), label).toBe(true);
    }
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    patchHandoff(root, runId, (h) => {
      h.userActor = null;
      h.reservedForUser = [];
    });
    const ok = await work(runId, { root });
    expect(ok.result.reason).not.toBe("handoff_invalid");
    expect(ok.spawn.calls).toHaveLength(1);
    expect(ok.result.status).toBe("complete");
  }, TEST_TIMEOUT);

  it("TR17 AC8: when the worker spawns claude, the record already carries workerPid = deps.pid and workerStartedAt = now()", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    let atSpawn = null;
    await work(runId, { root, now: () => FIXED_NOW, spawn: fakeSpawn({}, { onCall: () => (atSpawn = readRecord(root, runId)) }) });
    expect(atSpawn.workerPid).toBe(WORKER_PID);
    expect(atSpawn.workerStartedAt).toBe(FIXED_NOW);
    expect(atSpawn.status).toBe("running");
  }, TEST_TIMEOUT);

  it("TR18 AC9: the worker spawns claude with buildClaudeArgs and buildSpawnEnv(parentEnv, { runId, actor: initiator }), as a blocking run does", async () => {
    const env = { PATH: "/bin", SENTINEL_VAR: "keep-me", RKS_VIA: "ide" };
    const { blocking, runId, worker } = await blockingAndWorker({}, { env });
    const wc = worker.spawn.calls[0];
    expect(wc.command).toBe("claude");
    expect(wc.args).toEqual(buildClaudeArgs({ prompt: "build the thing", resumeSessionId: null, releaseAllowed: false }));
    expect(wc.args).toEqual(blocking.spawn.calls[0].args);
    expect(wc.options.env).toEqual(buildSpawnEnv(env, { runId, actor: "agent-a" }));
    expect(wc.options.env).toMatchObject({ RKS_DISPATCH_RUN_ID: runId, RKS_ACTOR: "agent-a", RKS_VIA: "dispatch", SENTINEL_VAR: "keep-me" });
    expect({ ...blocking.spawn.calls[0].options.env, RKS_DISPATCH_RUN_ID: runId }).toEqual(wc.options.env);
  }, TEST_TIMEOUT);

  it("TR19 AC9: the worker finalizes complete, permission_denied, awaiting_human, reserved_for_user, contract violation and claude spawn failure like a blocking run, with the same telemetry", async () => {
    const scripts = [
      ["complete", {}],
      ["permission_denied", { stdout: lines(INIT(), REFUSED(0), RESULT(COMPLETE, { permission_denials: [DENIED(0), DENIED(1)] })) }],
      ["awaiting_human", { stdout: lines(INIT(), RESULT(awaiting("build_tests_failed"))) }],
      ["reserved_for_user", { stdout: lines(INIT(), RESULT({ status: "reserved_for_user", summary: "release asked" })) }],
      ["checkpoint_contract_violation", { stdout: lines(INIT(), RESULT({ status: "done", summary: "" })) }],
      ["failed", { throw: "spawn claude ENOENT (fake)" }],
    ];
    for (const [expected, script] of scripts) {
      const { rootB, blocking, rootW, runId, worker } = await blockingAndWorker(script);
      const recB = readRecord(rootB, blocking.result.runId);
      const recW = readRecord(rootW, runId);
      expect(recW.status, expected).toBe(expected);
      expect(recW.status).toBe(recB.status);
      expect(worker.exitCode).toBe(blocking.exitCode);
      expect(norm(worker.result)).toEqual(norm(blocking.result));
      expect(tailEvents(worker.events)).toEqual(tailEvents(blocking.events));
    }
  }, TEST_TIMEOUT);

  it("TR20 AC9: reserved kinds map from the handoff reservedForUser and userActor exactly as a blocking run", async () => {
    const vince = { [USER_ACTOR_ENV_KEY]: "vince" };
    const cases = [
      ["reserved, initiator not the user actor", "po_review_confirmation", "agent-a", vince, "awaiting_user", true],
      ["reserved, no user actor", "po_review_confirmation", "agent-a", {}, "awaiting_user", true],
      ["reserved, initiator is the user actor", "po_review_confirmation", "vince", vince, "awaiting_human", true],
      ["kind not reserved", "build_tests_failed", "agent-a", vince, "awaiting_human", false],
    ];
    for (const [label, kind, actor, env, status, reserved] of cases) {
      const script = { stdout: lines(INIT(), RESULT(awaiting(kind, "cp-r"))) };
      const { blocking, rootW, runId, worker } = await blockingAndWorker(script, { actor, env });
      expect(worker.result.status, label).toBe(status);
      expect(worker.result.checkpoint.reserved, label).toBe(reserved);
      expect(worker.exitCode).toBe(EXIT_CODES.awaiting);
      const rec = readRecord(rootW, runId);
      expect(rec.status, label).toBe(status);
      expect(rec.checkpoints[rec.checkpoints.length - 1]).toMatchObject({ id: "cp-r", kind, reserved });
      const raised = worker.events.find((e) => e.type === "dispatch.checkpoint_raised");
      expect(raised.payload).toMatchObject({ kind, reserved });
      expect(norm(worker.result)).toEqual(norm(blocking.result));
      expect(tailEvents(worker.events)).toEqual(tailEvents(blocking.events));
    }
  }, TEST_TIMEOUT);

  it("TR21 AC9: after a detached awaiting_user on a reserved kind, the initiator's --resume is refused reserved_for_user as after a blocking run; the user actor is admitted", async () => {
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const script = { stdout: lines(INIT("s-k1"), RESULT(awaiting("po_review_confirmation", "cp-k1"))) };
    const { rootB, blocking, rootW, runId, worker } = await blockingAndWorker(script, { env });
    expect(worker.result.status).toBe("awaiting_user");
    const refusedW = await run(answer(runId, "cp-k1", "agent-a"), { root: rootW, env });
    const refusedB = await run(answer(blocking.result.runId, "cp-k1", "agent-a"), { root: rootB, env });
    expect(refusedW.result.reason).toBe("reserved_for_user");
    expect(refusedW.result.reason).toBe(refusedB.result.reason);
    expect(refusedW.exitCode).toBe(refusedB.exitCode);
    expect(refusedW.spawn.calls).toHaveLength(0);
    const admitted = await run(answer(runId, "cp-k1", "vince", [], "confirmed"), { root: rootW, env });
    expect(admitted.spawn.calls).toHaveLength(1);
    expect(admitted.result.status).toBe("complete");
  }, TEST_TIMEOUT);

  it("TR22 AC9: the worker never re-resolves reservedForUser, userActor or admission (project.json, worker env and credential all differ)", async () => {
    const root = childTarget({ dispatch: { reservedForUser: ["arch_needs_revision"] } });
    const launched = await detach(root, { env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    const runId = launched.result.runId;
    const h = readHandoff(root, runId);
    expect(h).toMatchObject({ userActor: "vince", reservedForUser: ["arch_needs_revision"] });
    // After the handoff: the project opts out, and the worker's env and .env name another actor.
    setProjectJson(root, { dispatch: { reservedForUser: [] } });
    fs.writeFileSync(path.join(root, ".env"), `${USER_ACTOR_ENV_KEY}=agent-a\n`);
    const handoffAdmission = { admissionCredential: "subscription", rksVersion: "9.9.9", rksVersionSource: "shell_package_json" };
    patchHandoff(root, runId, (x) => (x.admission = handoffAdmission));
    const w = await work(runId, {
      root,
      env: { [USER_ACTOR_ENV_KEY]: "agent-a" },
      credential: "api",
      spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("arch_needs_revision", "cp-n"))) }),
    });
    expect(w.result.status).toBe("awaiting_user");
    expect(w.result.checkpoint.reserved).toBe(true);
    expect(readRecord(root, runId).status).toBe("awaiting_user");
    expect(w.counts).toEqual({ resolveCredential: 0, findClaude: 0 });
    expect(w.result).toMatchObject(handoffAdmission);
  }, TEST_TIMEOUT);

  it("advisory: after the claim, a missing record refuses run_not_found and an unparseable one run_record_unreadable, exit 1, nothing spawned", async () => {
    const missing = childTarget();
    const r1 = (await detach(missing)).result.runId;
    fs.unlinkSync(runRecordPath(missing, r1));
    const w1 = await work(r1, { root: missing });
    expect(w1.result.reason).toBe("run_not_found");
    expect(w1.exitCode).toBe(EXIT_CODES.failure);
    expect(w1.spawn.calls).toHaveLength(0);
    expect(fs.existsSync(runRecordPath(missing, r1))).toBe(false);
    const damaged = childTarget();
    const r2 = (await detach(damaged)).result.runId;
    fs.writeFileSync(runRecordPath(damaged, r2), "{ torn");
    const w2 = await work(r2, { root: damaged });
    expect(w2.result.reason).toBe("run_record_unreadable");
    expect(w2.exitCode).toBe(EXIT_CODES.failure);
    expect(w2.spawn.calls).toHaveLength(0);
    expect(fs.readFileSync(runRecordPath(damaged, r2), "utf8")).toBe("{ torn");
  }, TEST_TIMEOUT);
});

// ---------- AC10-AC12: progress persistence ----------

describe("AC10-AC12 — progress persistence", () => {
  it("TR23 AC10: blocking run and worker write claudeSessionId to the record after init and before the child closes", async () => {
    const script = { stdout: lines(INIT("early-sess"), RESULT(COMPLETE, { session_id: "early-sess" })) };
    const rootB = childTarget();
    let snapB = null;
    await run(newRun(), { root: rootB, newRunId: () => "run-early-b", spawn: fakeSpawn(script, { beforeClose: () => (snapB = readRecord(rootB, "run-early-b")) }) });
    expect(snapB.status).toBe("running");
    expect(snapB.claudeSessionId).toBe("early-sess");
    const rootW = childTarget();
    const runId = (await detach(rootW)).result.runId;
    let snapW = null;
    await work(runId, { root: rootW, spawn: fakeSpawn(script, { beforeClose: () => (snapW = readRecord(rootW, runId)) }) });
    expect(snapW.status).toBe("running");
    expect(snapW.claudeSessionId).toBe("early-sess");
  }, TEST_TIMEOUT);

  it("TR24 AC11: the events log holds one parsed object per stream-json line in order; non-JSON stdout and stderr are absent (blocking and worker)", async () => {
    const hook = "PreToolUse:Read hook error: not json";
    const assistant = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
    const script = { stdout: [hook, ...lines(INIT(), assistant, RESULT(COMPLETE))], stderr: ["stderr-noise-text"] };
    const check = (root, runId) => {
      const text = fs.readFileSync(eventsLogPath(root, runId), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.trim().split("\n").map((l) => JSON.parse(l))).toEqual([INIT(), assistant, RESULT(COMPLETE)]);
      expect(text).not.toContain(hook);
      expect(text).not.toContain("stderr-noise-text");
    };
    const rootB = childTarget();
    const b = await run(newRun(), { root: rootB, spawn: fakeSpawn(script) });
    check(rootB, b.result.runId);
    const rootW = childTarget();
    const runId = (await detach(rootW)).result.runId;
    await work(runId, { root: rootW, spawn: fakeSpawn(script) });
    check(rootW, runId);
  }, TEST_TIMEOUT);

  it("TR25 AC11: blocking stdout relay and --json output are unchanged while the events log is written", async () => {
    const hook = "hook says hi";
    const evs = lines(INIT(), RESULT(COMPLETE));
    const relay = await run(newRun(), { root: childTarget(), spawn: fakeSpawn({ stdout: [hook, ...evs] }) });
    expect(relay.out).toBe(evs.map((l) => l + "\n").join("") + JSON.stringify(relay.result) + "\n");
    expect(relay.err).toContain(hook);
    const json = await run(newRun("agent-a", ["--json"]), { root: childTarget(), spawn: fakeSpawn({ stdout: [hook, ...evs] }) });
    expect(json.out).toBe(JSON.stringify(json.result) + "\n");
  }, TEST_TIMEOUT);

  it("TR26 AC12: the record stores summary and result; for a blocking run the stored result deep-equals the printed final JSON", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root });
    const printed = outLines(r.out).pop();
    const rec = readRecord(root, r.result.runId);
    expect(rec.summary).toBe("done");
    expect(rec.result).toEqual(printed);
    const aw = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("governor_failed"))) }) });
    const recAw = readRecord(root, aw.result.runId);
    expect(recAw.summary).toBe("waiting");
    expect(recAw.result).toEqual(outLines(aw.out).pop());
  }, TEST_TIMEOUT);
});

// ---------- AC13-AC17: --status ----------

describe("AC13-AC17 — --status", () => {
  const STATUS_KEYS = [
    "ok", "runId", "projectId", "initiator", "status", "startedAt", "updatedAt", "detached", "workerPid", "workerStartedAt",
    "workerAlive", "handoffPending", "claudeSessionId", "permissionDenied", "permissionDenials", "openCheckpoint", "summary", "result", "eventCount", "lastEventAt",
  ];
  const past = new Date("2020-01-01T00:00:00.000Z");

  it("TR27 AC13: --status prints one JSON object with every field, exits 0, spawns nothing, and leaves record and events log bytes and mtime unchanged", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root });
    const runId = r.result.runId;
    const rp = runRecordPath(root, runId);
    const lp = eventsLogPath(root, runId);
    for (const p of [rp, lp]) fs.utimesSync(p, past, past);
    const before = [rp, lp].map((p) => ({ bytes: fs.readFileSync(p, "utf8"), mtime: fs.statSync(p).mtimeMs }));
    const s = await run([...statusArgs(runId), "--json"], { root, spawn: fakeSpawn() });
    expect(s.exitCode).toBe(0);
    expect(s.spawn.calls).toHaveLength(0);
    const printed = outLines(s.out);
    expect(printed).toHaveLength(1);
    for (const k of STATUS_KEYS) expect(Object.prototype.hasOwnProperty.call(printed[0], k), k).toBe(true);
    expect(printed[0]).toMatchObject({ ok: true, runId, projectId: "child", initiator: "agent-a", status: "complete", detached: false });
    const after = [rp, lp].map((p) => ({ bytes: fs.readFileSync(p, "utf8"), mtime: fs.statSync(p).mtimeMs }));
    expect(after).toEqual(before);
  }, TEST_TIMEOUT);

  it("TR28 AC13: eventCount counts the JSON lines and skips an unterminated or unparseable trailing line; lastEventAt is the log mtime; no log → 0 and null", async () => {
    const root = childTarget();
    writeRecord(root, baseRecord("run-ev"));
    const lp = eventsLogPath(root, "run-ev");
    fs.writeFileSync(lp, lines(INIT(), { type: "assistant" }, RESULT(COMPLETE)).join("\n") + '\n{"type":"partial');
    const when = new Date("2026-10-01T08:30:00.000Z");
    fs.utimesSync(lp, when, when);
    const a = await run(statusArgs("run-ev"), { root });
    expect(a.result).toMatchObject({ eventCount: 3, lastEventAt: when.toISOString() });
    fs.writeFileSync(lp, lines(INIT(), RESULT(COMPLETE)).join("\n") + "\nnot json at all\n");
    expect((await run(statusArgs("run-ev"), { root })).result.eventCount).toBe(2);
    writeRecord(root, baseRecord("run-nolog"));
    const none = await run(statusArgs("run-nolog"), { root });
    expect(none.exitCode).toBe(0);
    expect(none.result).toMatchObject({ eventCount: 0, lastEventAt: null });
  }, TEST_TIMEOUT);

  it("TR29 AC14: --status on a running record reports openCheckpoint null and result null", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const s = await run(statusArgs(runId), { root });
    expect(s.result).toMatchObject({ status: "running", openCheckpoint: null, result: null, detached: true, workerPid: null });
    // a resumed run is running again: the previous segment's stored result is not reported
    const raised = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("s-x"), RESULT(awaiting("governor_failed", "cp-x"))) }) });
    await run(answer(raised.result.runId, "cp-x", "agent-a", ["--detach"]), { root, spawn: launcherSpawn() });
    const s2 = await run(statusArgs(raised.result.runId), { root });
    expect(s2.result).toMatchObject({ status: "running", openCheckpoint: null, result: null });
  }, TEST_TIMEOUT);

  it("TR30 AC14: after awaiting_human, --status reports the open checkpoint and --resume --answer <openCheckpoint.id> passes the checkpoint check", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("s-a"), RESULT(awaiting("build_tests_failed", "cp-open"))) }) });
    const s = await run(statusArgs(r.result.runId), { root });
    expect(s.result.status).toBe("awaiting_human");
    expect(s.result.openCheckpoint).toMatchObject({ id: "cp-open", kind: "build_tests_failed", question: "proceed?", options: ["yes", "no"], recommendation: "yes", storyIds: ["backlog.x"], reserved: false });
    const resumed = await run(answer(r.result.runId, s.result.openCheckpoint.id, "agent-a"), { root });
    expect(resumed.result.reason).not.toBe("checkpoint_not_open");
    expect(resumed.spawn.calls).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("TR31 AC14: after complete, --status reports result.status complete and the stored summary", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root });
    const s = await run(statusArgs(r.result.runId), { root });
    expect(s.result.result.status).toBe("complete");
    expect(s.result.result).toEqual(r.result);
    expect(s.result.summary).toBe("done");
  }, TEST_TIMEOUT);

  it("TR32 AC15: a running record with workerPid and workerStartedAt → isProcessAlive called once with workerPid, its value reported; record unchanged", async () => {
    for (const alive of [false, true]) {
      const root = childTarget();
      writeRecord(root, baseRecord("run-live", { detached: true, workerPid: 31337, workerStartedAt: FIXED_NOW }));
      const before = fs.readFileSync(runRecordPath(root, "run-live"), "utf8");
      const calls = [];
      const s = await run(statusArgs("run-live"), { root, isProcessAlive: (pid) => (calls.push(pid), alive) });
      expect(calls).toEqual([31337]);
      expect(s.result.workerAlive).toBe(alive);
      expect(fs.readFileSync(runRecordPath(root, "run-live"), "utf8")).toBe(before);
    }
  }, TEST_TIMEOUT);

  it("TR33 AC15: workerAlive is null and the probe never called without workerPid, without workerStartedAt, or for a terminal status", async () => {
    const records = [
      baseRecord("r-nopid", { detached: true, workerPid: null, workerStartedAt: FIXED_NOW }),
      baseRecord("r-nostart", { detached: true, workerPid: 31337 }),
      baseRecord("r-done", { status: "complete", detached: true, workerPid: 31337, workerStartedAt: FIXED_NOW }),
    ];
    for (const rec of records) {
      const root = childTarget();
      writeRecord(root, rec);
      let probed = 0;
      const s = await run(statusArgs(rec.runId), { root, isProcessAlive: () => ((probed += 1), true) });
      expect(s.exitCode).toBe(0);
      expect(s.result.workerAlive, rec.runId).toBeNull();
      expect(probed).toBe(0);
    }
  }, TEST_TIMEOUT);

  it("TR34 AC15: handoffPending is true while the handoff exists and false after the worker claimed it", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    expect((await run(statusArgs(runId), { root })).result.handoffPending).toBe(true);
    await work(runId, { root });
    const after = await run(statusArgs(runId), { root });
    expect(after.result.handoffPending).toBe(false);
    expect(after.result.workerPid).toBe(WORKER_PID);
  }, TEST_TIMEOUT);

  it("TR35 AC16: the default isProcessAlive maps kill(pid, 0) success → true, ESRCH → false, EPERM → true, other → false", () => {
    const codeErr = (code) => Object.assign(new Error(code), { code });
    const seen = [];
    const spy = vi.spyOn(process, "kill");
    spy.mockImplementationOnce((pid, sig) => (seen.push([pid, sig]), true));
    expect(isProcessAlive(4242)).toBe(true);
    expect(seen).toEqual([[4242, 0]]);
    spy.mockImplementationOnce(() => { throw codeErr("ESRCH"); });
    expect(isProcessAlive(4242)).toBe(false);
    spy.mockImplementationOnce(() => { throw codeErr("EPERM"); });
    expect(isProcessAlive(4242)).toBe(true);
    spy.mockImplementationOnce(() => { throw codeErr("EINVAL"); });
    expect(isProcessAlive(4242)).toBe(false);
  }, TEST_TIMEOUT);

  it("TR36 AC17: unknown runId, an invalid runId and a foreign record → run_not_found; an unregistered --project → project_not_registered (exit 1)", async () => {
    const root = childTarget();
    const unknown = await run(statusArgs("no-such-run"), { root });
    expect(unknown.result.reason).toBe("run_not_found");
    expect(unknown.exitCode).toBe(EXIT_CODES.failure);
    const invalid = await run(statusArgs("../x"), { root });
    expect(invalid.result.reason).toBe("run_not_found");
    expect(invalid.exitCode).toBe(EXIT_CODES.failure);
    writeRecord(root, baseRecord("run-foreign", { projectId: "other" }));
    const foreign = await run(statusArgs("run-foreign"), { root });
    expect(foreign.result.reason).toBe("run_not_found");
    expect(foreign.exitCode).toBe(EXIT_CODES.failure);
    const unregistered = await run(statusArgs("run-foreign"), { root: null });
    expect(unregistered.result.reason).toBe("project_not_registered");
    expect(unregistered.exitCode).toBe(EXIT_CODES.failure);
  }, TEST_TIMEOUT);

  it("TR37 AC17: invalid JSON and a non-object record → run_record_unreadable (exit 1) carrying the parse error, not run_not_found", async () => {
    const root = childTarget();
    fs.mkdirSync(ddir(root), { recursive: true });
    fs.writeFileSync(runRecordPath(root, "run-torn"), "{not json");
    let parseError;
    try {
      JSON.parse("{not json");
    } catch (e) {
      parseError = e.message;
    }
    const torn = await run(statusArgs("run-torn"), { root });
    expect(torn.result.reason).toBe("run_record_unreadable");
    expect(torn.exitCode).toBe(EXIT_CODES.failure);
    expect(torn.result.message).toContain(parseError);
    for (const [id, body] of [["run-array", "[1,2]"], ["run-number", "42"]]) {
      fs.writeFileSync(runRecordPath(root, id), body);
      const r = await run(statusArgs(id), { root });
      expect(r.result.reason, id).toBe("run_record_unreadable");
      expect(r.exitCode).toBe(EXIT_CODES.failure);
      expect(typeof r.result.message).toBe("string");
    }
  }, TEST_TIMEOUT);
});

// ---------- backlog.fix.dispatch-status-segment-truthfulness ----------
// Each `it` is named "truthfulness TRnn" after the position of its testRequirement in that story's
// frontmatter (TR01-TR18; TR19 is a process requirement).

describe("dispatch-status-segment-truthfulness — each segment reported truthfully", () => {
  const DISPATCH_JS = path.join(REPO_ROOT, "packages", "cli", "src", "cli", "dispatch.js");
  const WRITE_PREFIX = "routekit dispatch: could not write run record:";

  /** A blocking run that raises awaiting_human on cp-t (summary "waiting", result stored). */
  const raise = async (root) => {
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("sess-t"), RESULT(awaiting("build_tests_failed", "cp-t"))) }) });
    expect(r.result.status).toBe("awaiting_human");
    const rec = readRecord(root, r.result.runId);
    expect(rec.summary).toBe("waiting");
    expect(rec.result).toMatchObject({ status: "awaiting_human" });
    return r.result.runId;
  };
  const patchRecord = (root, runId, fn) => {
    const rec = readRecord(root, runId);
    fn(rec);
    writeRecord(root, rec);
  };
  const parsePayload = (data) => {
    try {
      const v = JSON.parse(String(data));
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  /** Make fs.writeFileSync throw only for payloads the predicate selects (by parsed record content). */
  const faultWrites = (predicate, message = "EIO: fake record write failure") => {
    const realWrite = fs.writeFileSync;
    const hits = [];
    vi.spyOn(fs, "writeFileSync").mockImplementation((p, data, ...rest) => {
      const v = parsePayload(data);
      if (v && predicate(v, p)) {
        hits.push(v);
        throw Object.assign(new Error(message), { code: "EIO" });
      }
      return realWrite(p, data, ...rest);
    });
    return hits;
  };
  const failHandoffWrites = () => {
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((p, data, ...rest) => {
      if (String(p).includes(".handoff.json.")) throw Object.assign(new Error("EACCES: fake handoff write failure"), { code: "EACCES" });
      return realWrite(p, data, ...rest);
    });
  };
  const notAwaiting = (result) => expect(["awaiting_human", "awaiting_user"]).not.toContain(result.status);

  it("truthfulness TR01: a resumed --detach whose launch succeeds reports running with summary and result null, in --status and in the record", async () => {
    const root = childTarget();
    const runId = await raise(root);
    const det = await run(answer(runId, "cp-t", "agent-a", ["--detach"]), { root, spawn: launcherSpawn() });
    expect(det.exitCode).toBe(0);
    const s = await run(statusArgs(runId), { root });
    expect(s.result).toMatchObject({ status: "running", summary: null, result: null });
    const rec = readRecord(root, runId);
    expect(rec.summary).toBeNull();
    expect(rec.result).toBeNull();
  }, TEST_TIMEOUT);

  it("truthfulness TR02: a blocking resume writes the segment-start record with summary null, result null and no failureReason key", async () => {
    const root = childTarget();
    const runId = await raise(root);
    // a stale failureReason from an earlier segment must not survive the segment start either
    patchRecord(root, runId, (rec) => (rec.failureReason = "stale_reason"));
    let atStart = null;
    const r = await run(answer(runId, "cp-t", "agent-a"), { root, spawn: fakeSpawn({}, { onCall: () => (atStart = readRecord(root, runId)) }) });
    expect(r.spawn.calls).toHaveLength(1);
    expect(atStart.status).toBe("running");
    expect(atStart.summary).toBeNull();
    expect(atStart.result).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(atStart, "failureReason")).toBe(false);
  }, TEST_TIMEOUT);

  it("truthfulness TR03: a resumed --detach whose worker launch fails (error or throw) reports failed/worker_spawn_failed with a failure result, never the awaiting result", async () => {
    for (const mode of ["error", "throw"]) {
      const root = childTarget();
      const runId = await raise(root);
      const det = await run(answer(runId, "cp-t", "agent-a", ["--detach"]), { root, spawn: launcherSpawn({ mode }) });
      expect(det.result.reason, mode).toBe("worker_spawn_failed");
      const s = await run(statusArgs(runId), { root });
      expect(s.result).toMatchObject({ status: "failed", failureReason: "worker_spawn_failed", summary: null });
      expect(s.result.result).toMatchObject({ ok: false, status: "failed", reason: "worker_spawn_failed" });
      notAwaiting(s.result.result);
    }
  }, TEST_TIMEOUT);

  it("truthfulness TR04: a fresh --detach whose handoff write fails reports failed/handoff_unwritable with summary null and a failure result", async () => {
    const root = childTarget();
    failHandoffWrites();
    const det = await detach(root);
    vi.restoreAllMocks();
    expect(det.result.reason).toBe("handoff_unwritable");
    expect(det.spawn.calls).toHaveLength(0);
    const s = await run(statusArgs(det.result.runId), { root });
    expect(s.result).toMatchObject({ status: "failed", failureReason: "handoff_unwritable", summary: null });
    expect(s.result.result).toMatchObject({ ok: false, status: "failed", reason: "handoff_unwritable" });
  }, TEST_TIMEOUT);

  it("truthfulness TR05: a resumed --detach whose handoff write fails reports failed/handoff_unwritable, never the previous segment's awaiting result or summary", async () => {
    const root = childTarget();
    const runId = await raise(root);
    failHandoffWrites();
    const det = await run(answer(runId, "cp-t", "agent-a", ["--detach"]), { root, spawn: launcherSpawn() });
    vi.restoreAllMocks();
    expect(det.result.reason).toBe("handoff_unwritable");
    expect(det.spawn.calls).toHaveLength(0);
    const s = await run(statusArgs(runId), { root });
    expect(s.result).toMatchObject({ status: "failed", failureReason: "handoff_unwritable", summary: null });
    expect(s.result.result).toMatchObject({ ok: false, status: "failed", reason: "handoff_unwritable" });
    notAwaiting(s.result.result);
    expect(s.result.summary).not.toBe("waiting");
  }, TEST_TIMEOUT);

  it("truthfulness TR06: a worker handoff_invalid writes failed/handoff_invalid with summary null and a failure result; --status projects all four", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    patchRecord(root, runId, (rec) => {
      rec.summary = "stale summary";
      rec.result = { ok: false, status: "awaiting_human", reason: "awaiting_human" };
    });
    patchHandoff(root, runId, (h) => delete h.userActor);
    const w = await work(runId, { root });
    expect(w.result.reason).toBe("handoff_invalid");
    expect(w.spawn.calls).toHaveLength(0);
    const rec = readRecord(root, runId);
    expect(rec).toMatchObject({ status: "failed", failureReason: "handoff_invalid", summary: null });
    expect(rec.result).toMatchObject({ ok: false, status: "failed", reason: "handoff_invalid" });
    const s = await run(statusArgs(runId), { root });
    expect(s.result).toMatchObject({ status: "failed", failureReason: "handoff_invalid", summary: null });
    expect(s.result.result).toMatchObject({ ok: false, status: "failed", reason: "handoff_invalid" });
  }, TEST_TIMEOUT);

  it("truthfulness TR07: a claimed worker finding a foreign projectId records failed/run_project_mismatch (projectId unchanged), refuses run_not_found exit 1, spawns nothing, emits completed failed", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    patchRecord(root, runId, (rec) => {
      rec.projectId = "other";
      rec.summary = "stale summary";
    });
    const w = await work(runId, { root });
    expect(w.result.reason).toBe("run_not_found");
    expect(w.result.message).toBe(`run ${runId} belongs to other`);
    expect(w.exitCode).toBe(EXIT_CODES.failure);
    expect(w.spawn.calls).toHaveLength(0);
    expect(completedFailed(w.events)).toBe(true);
    expect(fs.existsSync(handoffPath(root, runId))).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(w.result, "recordWriteError")).toBe(false);
    const rec = readRecord(root, runId);
    expect(rec).toMatchObject({ projectId: "other", status: "failed", failureReason: "run_project_mismatch", summary: null });
    expect(rec.result).toMatchObject({ ok: false, status: "failed", reason: "run_project_mismatch" });
  }, TEST_TIMEOUT);

  it("truthfulness TR08: the advisory order holds — the handoff is claimed first, a missing record is not recreated and a torn one is left byte-for-byte", async () => {
    const missing = childTarget();
    const r1 = (await detach(missing)).result.runId;
    fs.unlinkSync(runRecordPath(missing, r1));
    const w1 = await work(r1, { root: missing });
    expect(w1.result.reason).toBe("run_not_found");
    expect(fs.existsSync(handoffPath(missing, r1))).toBe(false); // claimed before the record was validated
    expect(fs.existsSync(runRecordPath(missing, r1))).toBe(false);
    const damaged = childTarget();
    const r2 = (await detach(damaged)).result.runId;
    fs.writeFileSync(runRecordPath(damaged, r2), "{ torn");
    const w2 = await work(r2, { root: damaged });
    expect(w2.result.reason).toBe("run_record_unreadable");
    expect(fs.existsSync(handoffPath(damaged, r2))).toBe(false);
    expect(fs.readFileSync(runRecordPath(damaged, r2), "utf8")).toBe("{ torn");
    for (const w of [w1, w2]) {
      expect(w.exitCode).toBe(EXIT_CODES.failure);
      expect(w.spawn.calls).toHaveLength(0);
    }
  }, TEST_TIMEOUT);

  it("truthfulness TR09: --status of a running record with a stored summary reports summary null; every --status carries failureReason (null when absent)", async () => {
    const root = childTarget();
    writeRecord(root, baseRecord("run-stale", { summary: "previous segment", result: { status: "awaiting_human" } }));
    const s = await run(statusArgs("run-stale"), { root });
    expect(s.result.summary).toBeNull();
    expect(s.result.result).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(s.result, "failureReason")).toBe(true);
    expect(s.result.failureReason).toBeNull();
    writeRecord(root, baseRecord("run-done", { status: "complete", summary: "all done" }));
    const done = await run(statusArgs("run-done"), { root });
    expect(done.result.summary).toBe("all done");
    expect(done.result.failureReason).toBeNull();
    writeRecord(root, baseRecord("run-fail", { status: "failed", failureReason: "worker_spawn_failed" }));
    expect((await run(statusArgs("run-fail"), { root })).result.failureReason).toBe("worker_spawn_failed");
  }, TEST_TIMEOUT);

  it("truthfulness TR10: a completed run's --status reports result deep-equal to the blocking result and the stored summary", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root });
    const s = await run(statusArgs(r.result.runId), { root });
    expect(s.result.result).toEqual(r.result);
    expect(s.result.summary).toBe("done");
    expect(s.result.failureReason).toBeNull();
  }, TEST_TIMEOUT);

  it("truthfulness TR11: dispatch.js has exactly one status, failureReason and summary assignment and one `belongs to ${record.projectId}`", () => {
    const src = fs.readFileSync(DISPATCH_JS, "utf8");
    const count = (re) => (src.match(re) || []).length;
    expect(count(/record[.]status = (?!=)/g)).toBe(1);
    expect(count(/record[.]failureReason = (?!=)/g)).toBe(1);
    expect(count(/record[.]summary = (?!=)/g)).toBe(1);
    expect(src.split("belongs to ${record.projectId}").length - 1).toBe(1);
    // the comparison in projectRunStatus stays and is not counted by the status regex
    const comparison = 'const running = record.status === "running";';
    expect(src.includes(comparison)).toBe(true);
    expect(comparison.match(/record[.]status = (?!=)/g)).toBeNull();
  });

  it("truthfulness TR12: --status refusal parity — missing, torn, non-object and foreign records", async () => {
    const root = childTarget();
    const missing = await run(statusArgs("run-missing"), { root });
    expect(missing.result).toMatchObject({ reason: "run_not_found", message: "no dispatch run run-missing in child" });
    fs.mkdirSync(ddir(root), { recursive: true });
    fs.writeFileSync(runRecordPath(root, "run-torn"), "{ torn");
    fs.writeFileSync(runRecordPath(root, "run-arr"), "[]");
    const torn = await run(statusArgs("run-torn"), { root });
    const arr = await run(statusArgs("run-arr"), { root });
    expect(torn.result.reason).toBe("run_record_unreadable");
    expect(arr.result).toMatchObject({ reason: "run_record_unreadable", message: "run record run-arr does not parse as a JSON object" });
    writeRecord(root, baseRecord("run-foreign", { projectId: "other" }));
    const foreign = await run(statusArgs("run-foreign"), { root });
    expect(foreign.result).toMatchObject({ reason: "run_not_found", message: "run run-foreign belongs to other" });
    for (const r of [missing, torn, arr, foreign]) expect(r.exitCode).toBe(EXIT_CODES.failure);
  }, TEST_TIMEOUT);

  it("truthfulness TR13: --resume refusal parity — missing, torn and non-object refuse run_not_found 'no dispatch run', foreign 'belongs to'; nothing spawned", async () => {
    const root = childTarget();
    fs.mkdirSync(ddir(root), { recursive: true });
    fs.writeFileSync(runRecordPath(root, "run-torn"), "{ torn");
    fs.writeFileSync(runRecordPath(root, "run-arr"), "[]");
    writeRecord(root, baseRecord("run-foreign", { projectId: "other" }));
    const resume = (id) => run(answer(id, "cp-1", "agent-a", ["--project", "child"]), { root });
    for (const id of ["run-missing", "run-torn", "run-arr"]) {
      const r = await resume(id);
      expect(r.result.reason, id).toBe("run_not_found");
      expect(r.result.message, id).toBe(`no dispatch run ${id} in child`);
      expect(r.exitCode).toBe(EXIT_CODES.failure);
      expect(r.spawn.calls).toHaveLength(0);
    }
    const foreign = await resume("run-foreign");
    expect(foreign.result).toMatchObject({ reason: "run_not_found", message: "run run-foreign belongs to other" });
    expect(foreign.exitCode).toBe(EXIT_CODES.failure);
    expect(foreign.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("truthfulness TR14: worker refusal parity — torn and non-object refuse run_record_unreadable with bytes unchanged; missing refuses run_not_found", async () => {
    for (const body of ["{ torn", "[]"]) {
      const root = childTarget();
      const runId = (await detach(root)).result.runId;
      fs.writeFileSync(runRecordPath(root, runId), body);
      const w = await work(runId, { root });
      expect(w.result.reason, body).toBe("run_record_unreadable");
      expect(w.exitCode).toBe(EXIT_CODES.failure);
      expect(w.spawn.calls).toHaveLength(0);
      expect(fs.readFileSync(runRecordPath(root, runId), "utf8")).toBe(body);
    }
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    fs.unlinkSync(runRecordPath(root, runId));
    const w = await work(runId, { root });
    expect(w.result).toMatchObject({ reason: "run_not_found", message: `no dispatch run ${runId} in child` });
    expect(w.exitCode).toBe(EXIT_CODES.failure);
    expect(w.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("truthfulness TR15: a run-record write failure at resume segment start still refuses run_record_unwritable, exit 1, nothing spawned", async () => {
    const root = childTarget();
    const runId = await raise(root);
    const hits = faultWrites((v) => v.runId === runId && v.status === "running");
    const r = await run(answer(runId, "cp-t", "agent-a"), { root });
    vi.restoreAllMocks();
    expect(hits).toHaveLength(1);
    expect(r.result.reason).toBe("run_record_unwritable");
    expect(r.result.message).toContain("fake record write failure");
    expect(r.exitCode).toBe(EXIT_CODES.failure);
    expect(r.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("truthfulness TR16: a failed fail() write after worker_spawn_failed writes the stderr line and keeps the refusal reason and exit code", async () => {
    const ok = await detach(childTarget(), { mode: "error" });
    const root = childTarget();
    const hits = faultWrites((v) => v.status === "failed" && v.failureReason === "worker_spawn_failed");
    const bad = await detach(root, { mode: "error" });
    vi.restoreAllMocks();
    expect(hits).toHaveLength(1);
    expect(bad.err.split("\n").some((l) => l.startsWith(WRITE_PREFIX))).toBe(true);
    expect(ok.err.includes(WRITE_PREFIX)).toBe(false);
    expect(bad.result.reason).toBe(ok.result.reason);
    expect(bad.result.reason).toBe("worker_spawn_failed");
    expect(bad.exitCode).toBe(ok.exitCode);
    expect(bad.exitCode).toBe(EXIT_CODES.failure);
  }, TEST_TIMEOUT);

  it("truthfulness TR17: a failed fail() write after a resume --detach puts recordWriteError in the refusal; a successful one carries no such key", async () => {
    const rootBad = childTarget();
    const runBad = await raise(rootBad);
    const hits = faultWrites((v) => v.runId === runBad && v.status === "failed");
    const bad = await run(answer(runBad, "cp-t", "agent-a", ["--detach"]), { root: rootBad, spawn: launcherSpawn({ mode: "error" }) });
    vi.restoreAllMocks();
    expect(hits).toHaveLength(1);
    // the segment-start write succeeded; only the fail() write was faulted
    expect(readRecord(rootBad, runBad)).toMatchObject({ status: "running", summary: null, result: null });
    expect(typeof bad.result.recordWriteError).toBe("string");
    expect(bad.result.recordWriteError.length).toBeGreaterThan(0);
    expect(bad.result.reason).toBe("worker_spawn_failed");
    expect(bad.exitCode).toBe(EXIT_CODES.failure);
    expect(outLines(bad.out).at(-1).recordWriteError).toBe(bad.result.recordWriteError);

    const rootOk = childTarget();
    const runOk = await raise(rootOk);
    const good = await run(answer(runOk, "cp-t", "agent-a", ["--detach"]), { root: rootOk, spawn: launcherSpawn({ mode: "error" }) });
    expect(good.result.reason).toBe("worker_spawn_failed");
    expect(good.exitCode).toBe(EXIT_CODES.failure);
    expect(Object.prototype.hasOwnProperty.call(good.result, "recordWriteError")).toBe(false);
  }, TEST_TIMEOUT);

  it("truthfulness TR18: a failed runClaudeSegment terminal write adds recordWriteError to the final JSON only; --status then reports running with null summary/result/failureReason", async () => {
    const rootOk = childTarget();
    const good = await run(newRun("agent-a", ["--json"]), { root: rootOk });
    const goodFinal = outLines(good.out).at(-1);
    expect(Object.prototype.hasOwnProperty.call(goodFinal, "recordWriteError")).toBe(false);

    const root = childTarget();
    const hits = faultWrites((v) => typeof v.runId === "string" && v.result !== undefined && v.result !== null);
    const bad = await run(newRun("agent-a", ["--json"]), { root });
    vi.restoreAllMocks();
    expect(hits).toHaveLength(1);
    const badFinal = outLines(bad.out).at(-1);
    expect(typeof badFinal.recordWriteError).toBe("string");
    expect(badFinal.recordWriteError.length).toBeGreaterThan(0);
    expect(badFinal.status).toBe(goodFinal.status);
    expect(badFinal.reason).toBe(goodFinal.reason);
    expect(bad.exitCode).toBe(good.exitCode);
    const { recordWriteError: _e, ...rest } = badFinal;
    expect(norm(rest)).toEqual(norm(goodFinal));
    expect(tailEvents(bad.events)).toEqual(tailEvents(good.events));
    expect(bad.err.split("\n").some((l) => l.startsWith(WRITE_PREFIX))).toBe(true);
    const s = await run(statusArgs(bad.result.runId), { root });
    expect(s.result).toMatchObject({ status: "running", summary: null, result: null, failureReason: null });
  }, TEST_TIMEOUT);
});

// ---------- AC18 / AC19: atomic writes and blocking parity ----------

describe("AC18/AC19 — atomic writes and blocking parity", () => {
  const noTmp = (root) => expect(listDir(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);

  it("TR38 AC18: after a blocking run, a detached launch and a worker finalization the record parses as the latest record and no *.tmp remains", async () => {
    const rootB = childTarget();
    const b = await run(newRun(), { root: rootB });
    expect(readRecord(rootB, b.result.runId)).toMatchObject({ status: "complete", result: { status: "complete" } });
    noTmp(rootB);
    const rootW = childTarget();
    const runId = (await detach(rootW)).result.runId;
    expect(readRecord(rootW, runId)).toMatchObject({ status: "running", detached: true, workerPid: null });
    noTmp(rootW);
    await work(runId, { root: rootW });
    expect(readRecord(rootW, runId)).toMatchObject({ status: "complete", workerPid: WORKER_PID, result: { status: "complete" } });
    noTmp(rootW);
  }, TEST_TIMEOUT);

  it("TR39 AC18: a failing renameSync leaves the previous record bytes, removes the temp file and surfaces run_record_unwritable", async () => {
    const root = childTarget();
    const raised = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("s-w"), RESULT(awaiting("build_tests_failed", "cp-w"))) }) });
    const runId = raised.result.runId;
    const rp = runRecordPath(root, runId);
    const before = fs.readFileSync(rp, "utf8");
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((src, dst) => {
      if (dst === rp) throw Object.assign(new Error("EIO: fake rename failure"), { code: "EIO" });
      return realRename(src, dst);
    });
    const r = await run(answer(runId, "cp-w", "agent-a"), { root });
    vi.restoreAllMocks();
    expect(r.result.reason).toBe("run_record_unwritable");
    expect(r.result.message).toContain("fake rename failure");
    expect(r.exitCode).toBe(EXIT_CODES.failure);
    expect(r.spawn.calls).toHaveLength(0);
    expect(fs.readFileSync(rp, "utf8")).toBe(before);
    noTmp(root);
  }, TEST_TIMEOUT);

  it("TR40 AC19: blocking complete and awaiting_human keep exit codes 0 and 3, statuses, no detached/workerPid/workerStartedAt fields and no handoff", async () => {
    const root = childTarget();
    const c = await run(newRun(), { root });
    expect(c.exitCode).toBe(0);
    expect(c.result.status).toBe("complete");
    const a = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("build_tests_failed"))) }) });
    expect(a.exitCode).toBe(3);
    expect(a.result.status).toBe("awaiting_human");
    for (const [r, status] of [[c, "complete"], [a, "awaiting_human"]]) {
      const rec = readRecord(root, r.result.runId);
      expect(rec.status).toBe(status);
      for (const k of ["detached", "workerPid", "workerStartedAt"]) expect(Object.prototype.hasOwnProperty.call(rec, k), k).toBe(false);
    }
    expect(listDir(root).filter((f) => f.includes(".handoff."))).toEqual([]);
  }, TEST_TIMEOUT);
});

// ---------- backlog.fix.dispatch-worker-handoff-nonce ----------

describe("dispatch-worker-handoff-nonce — the --detach handoff is bound to a worker nonce delivered by env", () => {
  const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");
  const HEX64 = /^[0-9a-f]{64}$/;
  const OTHER_NONCE = "fedcba9876543210".repeat(4);
  const launchNonce = (launched) => launched.spawn.calls[0].options.env[WORKER_NONCE_ENV_KEY];
  const claimedFiles = (root) => listDir(root).filter((f) => f.endsWith(".claimed"));
  const snapshot = (root, runId) => ({ handoff: fs.readFileSync(handoffPath(root, runId), "utf8"), record: fs.readFileSync(runRecordPath(root, runId), "utf8") });
  /** Pass-through renameSync spy recording every rename whose source is the pending handoff (a claim attempt). */
  const trackClaims = (root, runId) => {
    const hp = handoffPath(root, runId);
    const claims = [];
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((src, dst) => {
      if (src === hp) claims.push(dst);
      return realRename(src, dst);
    });
    return claims;
  };
  const expectUntouched = (root, runId, before, w, claims) => {
    expect(claims, "the pending handoff was never renamed").toEqual([]);
    expect(w.result.reason).toBe("worker_unauthorized");
    expect(w.exitCode).toBe(EXIT_CODES.failure);
    expect(fs.readFileSync(handoffPath(root, runId), "utf8")).toBe(before.handoff);
    expect(fs.readFileSync(runRecordPath(root, runId), "utf8")).toBe(before.record);
    expect(claimedFiles(root)).toEqual([]);
    expect(w.spawn.calls).toHaveLength(0);
  };

  it("nonce TR01: WORKER_NONCE_ENV_KEY is exported and equals RKS_DISPATCH_WORKER_NONCE", () => {
    expect(WORKER_NONCE_ENV_KEY).toBe("RKS_DISPATCH_WORKER_NONCE");
  });

  it("nonce TR02: with the real generator a fresh --detach spawns the worker with parentEnv plus a 64-hex nonce, unchanged argv, and a fresh nonce per launch", async () => {
    const env = { PATH: "/bin", SENTINEL_VAR: "keep-me", RKS_VIA: "ide" };
    const nonces = [];
    for (let i = 0; i < 2; i += 1) {
      const root = childTarget();
      const launched = await detach(root, { env, newWorkerNonce: null });
      expect(launched.exitCode).toBe(0);
      const { args, options } = launched.spawn.calls[0];
      for (const [k, v] of Object.entries(env)) expect(options.env[k], k).toBe(v);
      expect(Object.keys(options.env).sort()).toEqual([...Object.keys(env), WORKER_NONCE_ENV_KEY].sort());
      expect(options.env[WORKER_NONCE_ENV_KEY]).toMatch(HEX64);
      expect(args).toEqual([WORKER_ENTRY, "dispatch", "--_worker", launched.result.runId, "--project", "child", "--actor", "agent-a"]);
      nonces.push(options.env[WORKER_NONCE_ENV_KEY]);
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  }, TEST_TIMEOUT);

  it("nonce TR03: an injected deps.newWorkerNonce is exactly the nonce the launcher spawn env carries", async () => {
    const root = childTarget();
    const launched = await detach(root, { newWorkerNonce: () => OTHER_NONCE });
    expect(launchNonce(launched)).toBe(OTHER_NONCE);
  }, TEST_TIMEOUT);

  it("nonce TR04: the handoff stores workerNonceSha256 = SHA-256(spawn-env nonce) and its raw text never contains the nonce", async () => {
    const root = childTarget();
    const launched = await detach(root, { newWorkerNonce: null });
    const nonce = launchNonce(launched);
    const runId = launched.result.runId;
    expect(readHandoff(root, runId).workerNonceSha256).toBe(sha256(nonce));
    expect(fs.readFileSync(handoffPath(root, runId), "utf8")).not.toContain(nonce);
  }, TEST_TIMEOUT);

  it("nonce TR05: the run record text and the launcher stdout contain neither the nonce nor its digest", async () => {
    const root = childTarget();
    const launched = await detach(root, { newWorkerNonce: null });
    const nonce = launchNonce(launched);
    const recordText = fs.readFileSync(runRecordPath(root, launched.result.runId), "utf8");
    for (const secret of [nonce, sha256(nonce)]) {
      expect(recordText).not.toContain(secret);
      expect(launched.out).not.toContain(secret);
    }
  }, TEST_TIMEOUT);

  it("nonce TR06: an admitted --resume --detach also spawns the worker with a 64-hex nonce and writes its digest in the handoff", async () => {
    const root = childTarget();
    const raised = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("sess-orig"), RESULT(awaiting("build_tests_failed", "cp-9"))) }) });
    const runId = raised.result.runId;
    const det = await run(answer(runId, "cp-9", "agent-a", ["--detach"]), { root, spawn: launcherSpawn(), newWorkerNonce: null });
    expect(det.exitCode).toBe(0);
    const nonce = launchNonce(det);
    expect(nonce).toMatch(HEX64);
    expect(readHandoff(root, runId).workerNonceSha256).toBe(sha256(nonce));
  }, TEST_TIMEOUT);

  it("nonce TR07: runDispatchWorker without the nonce env key refuses worker_unauthorized before touching the handoff or the record", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const before = snapshot(root, runId);
    const claims = trackClaims(root, runId);
    const w = await work(runId, { root, workerNonce: null });
    vi.restoreAllMocks();
    expectUntouched(root, runId, before, w, claims);
  }, TEST_TIMEOUT);

  it("nonce TR08: argv-only --_worker <runId> --project child, with and without --actor, refuses worker_unauthorized and never spawns claude", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const before = snapshot(root, runId);
    for (const extra of [[], ["--actor", "agent-a"]]) {
      const claims = trackClaims(root, runId);
      const r = await run(["--_worker", runId, "--project", "child", ...extra], { root, env: { PATH: "/bin" } });
      vi.restoreAllMocks();
      expectUntouched(root, runId, before, r, claims);
    }
  }, TEST_TIMEOUT);

  it("nonce TR09: a present but malformed env nonce (uppercase, 63 chars, non-hex) refuses worker_unauthorized with nothing touched", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const before = snapshot(root, runId);
    for (const bad of [TEST_WORKER_NONCE.toUpperCase(), TEST_WORKER_NONCE.slice(1), "z".repeat(64)]) {
      const claims = trackClaims(root, runId);
      const w = await work(runId, { root, env: { [WORKER_NONCE_ENV_KEY]: bad } });
      vi.restoreAllMocks();
      expectUntouched(root, runId, before, w, claims);
    }
  }, TEST_TIMEOUT);

  it("nonce TR10: a well-formed non-matching nonce refuses worker_unauthorized without claiming; the real worker then claims and completes", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const before = snapshot(root, runId);
    const claims = trackClaims(root, runId);
    const racer = await work(runId, { root, workerNonce: OTHER_NONCE });
    vi.restoreAllMocks();
    expectUntouched(root, runId, before, racer, claims);
    const real = await work(runId, { root });
    expect(real.spawn.calls).toHaveLength(1);
    expect(real.result.status).toBe("complete");
    expect(readRecord(root, runId)).toMatchObject({ status: "complete", workerPid: WORKER_PID });
  }, TEST_TIMEOUT);

  it("nonce TR11: the nonce captured from the launcher spawn env claims the handoff, spawns once and finalizes complete; --status reports handoffPending false", async () => {
    const root = childTarget();
    const launched = await detach(root, { newWorkerNonce: null });
    const runId = launched.result.runId;
    const w = await work(runId, { root, env: { [WORKER_NONCE_ENV_KEY]: launchNonce(launched) } });
    expect(w.spawn.calls).toHaveLength(1);
    expect(w.exitCode).toBe(0);
    expect(fs.existsSync(handoffPath(root, runId))).toBe(false);
    expect(readRecord(root, runId)).toMatchObject({ status: "complete", workerPid: WORKER_PID });
    const s = await run(statusArgs(runId), { root });
    expect(s.result.handoffPending).toBe(false);
  }, TEST_TIMEOUT);

  it("nonce TR12: a deleted, uppercase, wrong-length or non-string workerNonceSha256 refuses handoff_invalid and records failed", async () => {
    const mutations = [
      (h) => delete h.workerNonceSha256,
      (h) => (h.workerNonceSha256 = h.workerNonceSha256.toUpperCase()),
      (h) => (h.workerNonceSha256 = h.workerNonceSha256.slice(2)),
      (h) => (h.workerNonceSha256 = 12345),
    ];
    for (const mutate of mutations) {
      const root = childTarget();
      const runId = (await detach(root)).result.runId;
      patchHandoff(root, runId, mutate);
      const w = await work(runId, { root });
      expect(w.result.reason).toBe("handoff_invalid");
      expect(w.exitCode).toBe(EXIT_CODES.failure);
      expect(w.spawn.calls).toHaveLength(0);
      expect(readRecord(root, runId)).toMatchObject({ status: "failed", failureReason: "handoff_invalid" });
      expect(completedFailed(w.events)).toBe(true);
    }
  }, TEST_TIMEOUT);

  /** Rewrite the handoff with a foreign digest only on the claim rename; optionally throw on the put-back. */
  const spyClaimRace = (root, runId, { putBackError } = {}) => {
    const hp = handoffPath(root, runId);
    const replaced = JSON.stringify({ ...readHandoff(root, runId), workerNonceSha256: sha256(OTHER_NONCE) });
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((src, dst) => {
      if (src === hp && String(dst).endsWith(".claimed")) fs.writeFileSync(hp, replaced);
      if (putBackError && String(src).endsWith(".claimed") && dst === hp) throw putBackError;
      return realRename(src, dst);
    });
    return replaced;
  };

  it("nonce TR13: content replaced between the pre-claim read and the claim is put back; worker_unauthorized with handoffRestored true", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const recordBefore = fs.readFileSync(runRecordPath(root, runId), "utf8");
    const replaced = spyClaimRace(root, runId);
    const w = await work(runId, { root });
    vi.restoreAllMocks();
    expect(w.result).toMatchObject({ ok: false, reason: "worker_unauthorized", handoffRestored: true });
    expect(w.exitCode).toBe(EXIT_CODES.failure);
    expect(fs.readFileSync(handoffPath(root, runId), "utf8")).toBe(replaced);
    expect(claimedFiles(root)).toEqual([]);
    expect(fs.readFileSync(runRecordPath(root, runId), "utf8")).toBe(recordBefore);
    expect(w.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("nonce TR14: when the put-back rename throws, the refusal reports handoffRestored false, restoreError and claimedPath, and stderr names both", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const recordBefore = fs.readFileSync(runRecordPath(root, runId), "utf8");
    const injected = Object.assign(new Error("EIO: injected put-back failure"), { code: "EIO" });
    const replaced = spyClaimRace(root, runId, { putBackError: injected });
    const w = await work(runId, { root });
    vi.restoreAllMocks();
    expect(w.result).toMatchObject({ ok: false, reason: "worker_unauthorized", handoffRestored: false });
    expect(w.exitCode).toBe(EXIT_CODES.failure);
    expect(w.result.restoreError).toContain("injected put-back failure");
    const claimedPath = w.result.claimedPath;
    expect(path.dirname(claimedPath)).toBe(ddir(root));
    expect(claimedPath.endsWith(".claimed")).toBe(true);
    expect(w.err).toContain(claimedPath);
    expect(w.err).toContain("injected put-back failure");
    expect(fs.readFileSync(claimedPath, "utf8")).toBe(replaced);
    expect(fs.existsSync(handoffPath(root, runId))).toBe(false);
    expect(fs.readFileSync(runRecordPath(root, runId), "utf8")).toBe(recordBefore);
    expect(w.spawn.calls).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("nonce TR15: buildSpawnEnv drops the nonce key, keeps every other key and does not mutate its argument", () => {
    const parentEnv = { PATH: "/bin", SENTINEL_VAR: "keep-me", [WORKER_NONCE_ENV_KEY]: TEST_WORKER_NONCE };
    const copy = { ...parentEnv };
    const out = buildSpawnEnv(parentEnv, { runId: "r-1", actor: "agent-a" });
    expect(Object.prototype.hasOwnProperty.call(out, WORKER_NONCE_ENV_KEY)).toBe(false);
    expect(out).toMatchObject({ PATH: "/bin", SENTINEL_VAR: "keep-me" });
    expect(parentEnv).toEqual(copy);
  });

  it("nonce TR16: neither the worker's claude child nor a blocking run's claude child sees the nonce", async () => {
    const root = childTarget();
    const runId = (await detach(root)).result.runId;
    const workerEnv = { PATH: "/bin", SENTINEL_VAR: "keep-me", [WORKER_NONCE_ENV_KEY]: TEST_WORKER_NONCE };
    const w = await work(runId, { root, env: workerEnv });
    const childEnv = w.spawn.calls[0].options.env;
    expect(Object.prototype.hasOwnProperty.call(childEnv, WORKER_NONCE_ENV_KEY)).toBe(false);
    expect(childEnv).toEqual(buildSpawnEnv(workerEnv, { runId, actor: "agent-a" }));
    const blocking = await run(newRun(), { root: childTarget(), env: { PATH: "/bin", [WORKER_NONCE_ENV_KEY]: TEST_WORKER_NONCE } });
    expect(blocking.spawn.calls).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(blocking.spawn.calls[0].options.env, WORKER_NONCE_ENV_KEY)).toBe(false);
  }, TEST_TIMEOUT);

  it("nonce TR17: DISPATCH_USAGE and the routekit.js usage() text mention neither the nonce env key nor _worker", () => {
    const cli = fs.readFileSync(path.join(REPO_ROOT, "packages", "cli", "bin", "routekit.js"), "utf8");
    const usageSlice = cli.slice(cli.indexOf("function usage()"), cli.indexOf("function printPlanHelp()"));
    expect(usageSlice.length).toBeGreaterThan(0);
    for (const text of [DISPATCH_USAGE, usageSlice]) {
      expect(text).not.toContain("RKS_DISPATCH_WORKER_NONCE");
      expect(text).not.toContain("_worker");
    }
  });

  it("nonce TR18 [process]: the one harness mechanism — makeDeps launches with TEST_WORKER_NONCE and work() merges it into the caller env", async () => {
    const root = childTarget();
    const launched = await detach(root, { env: { PATH: "/bin" } });
    expect(launchNonce(launched)).toBe(TEST_WORKER_NONCE);
    expect(readHandoff(root, launched.result.runId).workerNonceSha256).toBe(sha256(TEST_WORKER_NONCE));
    expect(workerEnvFor({ env: { PATH: "/bin" } })).toEqual({ PATH: "/bin", [WORKER_NONCE_ENV_KEY]: TEST_WORKER_NONCE });
    expect(workerEnvFor({ env: { [WORKER_NONCE_ENV_KEY]: OTHER_NONCE } })).toEqual({ [WORKER_NONCE_ENV_KEY]: OTHER_NONCE });
    expect(workerEnvFor({ env: { PATH: "/bin" }, workerNonce: null })).toEqual({ PATH: "/bin" });
  }, TEST_TIMEOUT);
});

// ---------- backlog.fix.dispatch-permission-denials-truthful ----------
// "denials TRnn" maps to the nn-th testRequirement of notes/backlog.fix.dispatch-permission-denials-truthful.md;
// the remaining requirements live in tests/unit/routekit-dispatch.test.mjs.

describe("dispatch-permission-denials-truthful — records and --status", () => {
  const hookBlock = (tool, id) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", content: `PreToolUse:${tool} hook error: blocked`, is_error: true, tool_use_id: id }] },
  });

  it("denials TR04 AC2/AC3: --status on a record with no permissionDenials field returns permissionDenials [] and does not throw", async () => {
    const root = childTarget();
    const rec = baseRecord("run-legacy", { status: "complete", permissionDenied: 2 });
    expect(Object.prototype.hasOwnProperty.call(rec, "permissionDenials")).toBe(false);
    writeRecord(root, rec);
    const s = await run(statusArgs("run-legacy"), { root });
    expect(s.exitCode).toBe(0);
    expect(s.result).toMatchObject({ ok: true, permissionDenied: 2, permissionDenials: [] });
  }, TEST_TIMEOUT);

  it("denials TR05 AC2/AC3: a --resume segment against a baseRecord-shaped record (permissionDenied 0, no permissionDenials) accumulates without throwing", async () => {
    const root = childTarget();
    const rec = baseRecord("run-oldrec", {
      status: "awaiting_human",
      claudeSessionId: "sess-old",
      checkpoints: [{ id: "cp-o", kind: "build_tests_failed", reserved: false, answeredAt: null }],
    });
    expect(rec.permissionDenied).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(rec, "permissionDenials")).toBe(false);
    writeRecord(root, rec);
    const script = { stdout: lines(INIT("sess-old"), hookBlock("Read", "toolu_r1"), RESULT(COMPLETE, { permission_denials: [{ tool_name: "Read", tool_use_id: "toolu_r1" }, DENIED(7)] })) };
    const r = await run(answer("run-oldrec", "cp-o", "agent-a"), { root, spawn: fakeSpawn(script) });
    expect(r.spawn.calls).toHaveLength(1);
    const expected = [
      { tool: "Read", toolUseId: "toolu_r1", source: "hook" },
      { tool: "Write", toolUseId: "toolu_denied_7", source: "unclassified" },
    ];
    expect(r.result).toMatchObject({ ok: false, reason: "permission_denied", permissionDenied: 2 });
    const after = readRecord(root, "run-oldrec");
    expect(after.permissionDenials).toEqual(expected);
    expect(after.permissionDenied).toBe(2);
    const s = await run(statusArgs("run-oldrec"), { root });
    expect(s.result.permissionDenials).toEqual(expected);
    expect(s.result.permissionDenied).toBe(2);
  }, TEST_TIMEOUT);

  it("denials TR31 AC11: the TR19 permission_denied case feeds result.permission_denials and the worker finalizes like the blocking run", async () => {
    const script = { stdout: lines(INIT(), REFUSED(0), RESULT(COMPLETE, { permission_denials: [DENIED(0), DENIED(1)] })) };
    const { rootB, blocking, rootW, runId, worker } = await blockingAndWorker(script);
    expect(blocking.result).toMatchObject({ ok: false, reason: "permission_denied", permissionDenied: 2 });
    expect(blocking.result.permissionDenials.map((d) => d.source)).toEqual(["permission", "unclassified"]);
    expect(readRecord(rootW, runId).status).toBe("permission_denied");
    expect(readRecord(rootB, blocking.result.runId).status).toBe("permission_denied");
    expect(worker.exitCode).toBe(blocking.exitCode);
    expect(norm(worker.result)).toEqual(norm(blocking.result));
    expect(tailEvents(worker.events)).toEqual(tailEvents(blocking.events));
    const pd = worker.events.find((e) => e.type === "dispatch.permission_denied");
    expect(pd.payload).toEqual({ runId, count: 2, bySource: { hook: 0, permission: 1, unclassified: 1 } });
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(src).not.toContain("permission_denied #$" + "{i}");
  }, TEST_TIMEOUT);

  it("denials TR32 AC11: --status prints permissionDenials (and the STATUS_KEYS list names it)", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT(), hookBlock("Glob", "toolu_g1"), RESULT(COMPLETE, { permission_denials: [{ tool_name: "Glob", tool_use_id: "toolu_g1" }] })) }) });
    expect(r.result.status).toBe("complete");
    const s = await run([...statusArgs(r.result.runId), "--json"], { root });
    const printed = outLines(s.out);
    expect(printed).toHaveLength(1);
    expect(printed[0].permissionDenials).toEqual([{ tool: "Glob", toolUseId: "toolu_g1", source: "hook" }]);
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const keys = src.slice(src.indexOf("const STATUS_KEYS = ["), src.indexOf("];", src.indexOf("const STATUS_KEYS = [")));
    expect(keys).toContain('"permissionDenials"');
  }, TEST_TIMEOUT);
});
