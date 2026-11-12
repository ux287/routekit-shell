// backlog.feat.routekit-dispatch-headless — unit tests for `routekit dispatch`.
//
// Every claude process is INJECTED through the spawn seam (deps.spawn); no test launches a real
// claude. No test spawns any subprocess at all; SPAWN_TIMEOUT below exists for the suite's
// subprocess-timeout convention and would bound any future subprocess.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  CHECKPOINT_KINDS,
  RELEASE_TOOLS,
  USER_ACTOR_ENV_KEY,
  DISPATCHER_ALLOWED_TOOLS,
  ALWAYS_DISALLOWED_TOOLS,
  DISPATCH_RESULT_SCHEMA,
  MIN_RKS_VERSION,
  EXIT_CODES,
  resolveUserActor,
  validateDispatchConfig,
  parseFinalResult,
  runRecordPath,
  isRksShellRoot,
  handleDispatchCommand,
  DISPATCH_USAGE,
} from "../../packages/cli/src/cli/dispatch.js";

const SPAWN_TIMEOUT = 30_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DISPATCH_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/cli/dispatch.js"), "utf8");
const CLI_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/bin/routekit.js"), "utf8");

// ---------- fixtures ----------

const tmpDirs = [];
function tmp(prefix = "rks-dispatch-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/** A temp child target (no shell marker) stamped rksVersion (default 0.85.0, AC20 fixture). */
function childTarget({ stamp = "0.85.0", dispatch, projectJson, dotenv, omitProjectJson = false } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  if (!omitProjectJson) {
    if (typeof projectJson === "string") {
      fs.writeFileSync(path.join(root, ".rks", "project.json"), projectJson);
    } else {
      const pj = projectJson || { id: "child" };
      if (stamp !== null) pj.rksVersion = stamp; // stamp: null → no rksVersion key
      if (dispatch !== undefined) pj.dispatch = dispatch;
      fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(pj));
    }
  }
  if (dotenv !== undefined) fs.writeFileSync(path.join(root, ".env"), dotenv);
  return root;
}

/** A temp shell-marker target (packages/mcp-rks/package.json named @routekit/mcp-rks). */
function shellTarget({ version = "0.85.0", markerName = "@routekit/mcp-rks", dispatch, stamp } = {}) {
  const root = tmp("rks-dispatch-shell-");
  fs.mkdirSync(path.join(root, "packages", "mcp-rks"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "mcp-rks", "package.json"), JSON.stringify({ name: markerName }));
  if (version !== null) fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "routekit-shell-core", version }));
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  const pj = { id: "shell" };
  if (dispatch !== undefined) pj.dispatch = dispatch;
  if (stamp !== undefined) pj.rksVersion = stamp;
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(pj));
  return root;
}

const INIT = (sid = "sess-from-init") => ({ type: "system", subtype: "init", session_id: sid, mcp_servers: [] });
const RESULT = (structured, extra = {}) => ({ type: "result", subtype: "success", is_error: false, session_id: "sess-from-init", structured_output: structured, ...extra });
const COMPLETE = { status: "complete", summary: "done" };
const awaiting = (kind, id = "cp-1") => ({
  status: "awaiting_human",
  summary: "waiting",
  checkpoint: { id, kind, storyIds: ["backlog.x"], question: "proceed?", options: ["yes", "no"], recommendation: "yes" },
});
const lines = (...events) => events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));

/**
 * Injected spawn seam: records every call and returns a fake child that emits the given stdout /
 * stderr lines, then closes with exitCode. Never launches a process.
 */
function fakeSpawn(script = {}) {
  const scripts = Array.isArray(script) ? script : null;
  const calls = [];
  const spawn = (command, args, options) => {
    const s = scripts ? scripts[calls.length] || scripts[scripts.length - 1] : script;
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      for (const l of s.stderr || []) child.stderr.write(l + "\n");
      for (const l of s.stdout || lines(INIT(), RESULT(COMPLETE))) child.stdout.write(l + "\n");
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", s.exitCode ?? 0));
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** Run handleDispatchCommand with all dependencies injected (overridable). */
async function run(argv, { root, projectId = "child", spawn = fakeSpawn(), credential = "api", claude = "/usr/local/bin/claude", env = {}, telemetry, shellRoot, getProject, listProjects, newRunId } = {}) {
  const out = [];
  const err = [];
  const events = [];
  const deps = {
    spawn,
    getProject: getProject || (async (id) => (root && id === projectId ? { id, root } : null)),
    listProjects: listProjects || (async () => (root ? [{ id: projectId, root }] : [])),
    resolveCredential: async () => ({ credential }),
    findClaude: async () => claude,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  if (telemetry !== null) deps.telemetry = telemetry || (async (type, payload) => events.push({ type, payload }));
  if (newRunId) deps.newRunId = newRunId;
  const { result, exitCode } = await handleDispatchCommand({ args: ["dispatch", ...argv], kv: {}, SHELL_ROOT: shellRoot || tmp("rks-dispatch-shellroot-") }, deps);
  return { result, exitCode, out: out.join(""), err: err.join(""), events, spawn };
}

const newRun = (actor = "agent-a", extra = []) => ["--project", "child", "--actor", actor, ...extra, "build the thing"];
const argValue = (args, flag) => args[args.indexOf(flag) + 1];
const readRecord = (root, runId) => JSON.parse(fs.readFileSync(runRecordPath(root, runId), "utf8"));

// ---------- constants ----------

describe("dispatch — closed checkpoint set and constants", () => {
  it("exports exactly the five K1-K5 kinds", () => {
    expect(CHECKPOINT_KINDS).toEqual([
      "po_review_confirmation",
      "arch_needs_revision",
      "build_decomposed_orphaned_tests",
      "build_tests_failed",
      "governor_failed",
    ]);
  });

  it("AC17: DISPATCHER_ALLOWED_TOOLS contains none of Edit, Write or Bash; ALWAYS_DISALLOWED_TOOLS has rks_guardrails_off", () => {
    for (const t of ["Edit", "Write", "Bash"]) expect(DISPATCHER_ALLOWED_TOOLS).not.toContain(t);
    expect(ALWAYS_DISALLOWED_TOOLS).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC20: MIN_RKS_VERSION is 0.85.0", () => {
    expect(MIN_RKS_VERSION).toBe("0.85.0");
  });

  it("exit codes: awaiting is non-zero and distinct from the failure code", () => {
    expect(EXIT_CODES.complete).toBe(0);
    expect(EXIT_CODES.awaiting).not.toBe(0);
    expect(EXIT_CODES.awaiting).not.toBe(EXIT_CODES.failure);
    expect(EXIT_CODES.failure).not.toBe(0);
  });

  it("subprocess-timeout convention: SPAWN_TIMEOUT is a positive number", () => {
    expect(typeof SPAWN_TIMEOUT).toBe("number");
    expect(SPAWN_TIMEOUT).toBeGreaterThan(0);
  });
});

// ---------- AC1: admission ----------

describe("AC1 — admission refuses without spawning", () => {
  it("unregistered project → project_not_registered, non-zero, no spawn", async () => {
    const r = await run(newRun(), { root: null });
    expect(r.result).toMatchObject({ ok: false, reason: "project_not_registered" });
    expect(r.exitCode).not.toBe(0);
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("registered project whose root does not exist → project_not_registered, no spawn", async () => {
    const missing = path.join(tmp(), "gone");
    const r = await run(newRun(), { root: missing });
    expect(r.result.reason).toBe("project_not_registered");
    expect(r.exitCode).not.toBe(0);
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("credential none → credential_required naming routekit call, no spawn", async () => {
    const r = await run(newRun(), { root: childTarget(), credential: "none" });
    expect(r.result.reason).toBe("credential_required");
    expect(r.result.message).toContain("routekit call");
    expect(r.exitCode).not.toBe(0);
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("claude binary not found → claude_cli_unavailable, no spawn", async () => {
    const r = await run(newRun(), { root: childTarget(), claude: null });
    expect(r.result.reason).toBe("claude_cli_unavailable");
    expect(r.exitCode).not.toBe(0);
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("missing --actor → refused, non-zero, no spawn", async () => {
    const r = await run(["--project", "child", "do it"], { root: childTarget() });
    expect(r.result.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("AC1/AC8: malformed reservedForUser config refuses without spawning", async () => {
    for (const dispatch of [{ reservedForUser: "po_review_confirmation" }, { reservedForUser: [1] }, { reservedForUser: ["not_a_kind"] }]) {
      const r = await run(newRun(), { root: childTarget({ dispatch }) });
      expect(r.result.reason).toBe("invalid_dispatch_config");
      expect(r.exitCode).not.toBe(0);
      expect(r.spawn.calls).toHaveLength(0);
    }
  });
});

describe("AC8 — validateDispatchConfig", () => {
  it("rejects non-array, non-string entry and unknown kind with invalid_dispatch_config", () => {
    expect(validateDispatchConfig({ reservedForUser: "po_review_confirmation" })).toMatchObject({ ok: false, reason: "invalid_dispatch_config" });
    expect(validateDispatchConfig({ reservedForUser: ["po_review_confirmation", 7] })).toMatchObject({ ok: false, reason: "invalid_dispatch_config" });
    expect(validateDispatchConfig({ reservedForUser: ["release"] })).toMatchObject({ ok: false, reason: "invalid_dispatch_config" });
  });

  it("defaults an absent block to reserving po_review_confirmation and honours an explicit list", () => {
    expect(validateDispatchConfig(undefined)).toEqual({ ok: true, reservedForUser: ["po_review_confirmation"], defaulted: true });
    expect(validateDispatchConfig({ reservedForUser: ["po_review_confirmation"] })).toEqual({ ok: true, reservedForUser: ["po_review_confirmation"], defaulted: false });
  });

  it("AC12: a userActor key is rejected with a message naming RKS_DISPATCH_USER_ACTOR", () => {
    const r = validateDispatchConfig({ reservedForUser: [], userActor: "vince" });
    expect(r).toMatchObject({ ok: false, reason: "invalid_dispatch_config" });
    expect(r.message).toContain("RKS_DISPATCH_USER_ACTOR");
  });
});

// ---------- AC12: user actor resolution ----------

describe("AC12 — resolveUserActor", () => {
  it("process env wins over the target .env", () => {
    const root = childTarget({ dotenv: `${USER_ACTOR_ENV_KEY}=from-file\n` });
    expect(resolveUserActor({ projectRoot: root, env: { [USER_ACTOR_ENV_KEY]: "from-env" } })).toBe("from-env");
  });

  it("falls back to the target .env, and is null when both are absent or empty", () => {
    const root = childTarget({ dotenv: `ANTHROPIC_API_KEY=\n${USER_ACTOR_ENV_KEY}=vince\n` });
    expect(resolveUserActor({ projectRoot: root, env: {} })).toBe("vince");
    expect(resolveUserActor({ projectRoot: childTarget(), env: {} })).toBeNull();
    const emptyRoot = childTarget({ dotenv: `${USER_ACTOR_ENV_KEY}=\n` });
    expect(resolveUserActor({ projectRoot: emptyRoot, env: { [USER_ACTOR_ENV_KEY]: "" } })).toBeNull();
  });

  it("never reads userActor from .rks/project.json", async () => {
    const root = childTarget({ dispatch: { userActor: "owner-in-json" } });
    expect(resolveUserActor({ projectRoot: root, env: {} })).toBeNull();
    const r = await run(newRun("owner-in-json"), { root });
    expect(r.result.reason).toBe("invalid_dispatch_config");
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("an invalid value yields invalid_dispatch_config, not an unset actor", async () => {
    for (const bad of ["vince smith", "a;b"]) {
      let thrown;
      try {
        resolveUserActor({ projectRoot: childTarget(), env: { [USER_ACTOR_ENV_KEY]: bad } });
      } catch (e) {
        thrown = e;
      }
      expect(thrown?.reason).toBe("invalid_dispatch_config");
      const r = await run(newRun(), { root: childTarget(), env: { [USER_ACTOR_ENV_KEY]: bad } });
      expect(r.result.reason).toBe("invalid_dispatch_config");
      expect(r.spawn.calls).toHaveLength(0);
    }
    const fileRoot = childTarget({ dotenv: `${USER_ACTOR_ENV_KEY}=bad;actor\n` });
    const r2 = await run(newRun(), { root: fileRoot });
    expect(r2.result.reason).toBe("invalid_dispatch_config");
  });
});

// ---------- AC2: spawn ----------

describe("AC2 — spawn args and env", () => {
  it("passes -p, intent, stream-json, --verbose, the schema, the contract and exactly the allowed tools; cwd = root", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root });
    expect(r.spawn.calls).toHaveLength(1);
    const { command, args, options } = r.spawn.calls[0];
    expect(command).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("build the thing");
    expect(argValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(JSON.parse(argValue(args, "--json-schema"))).toEqual(DISPATCH_RESULT_SCHEMA);
    expect(args).toContain("--append-system-prompt");
    expect(argValue(args, "--allowedTools").split(",")).toEqual([...DISPATCHER_ALLOWED_TOOLS]);
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(options.cwd).toBe(root);
  });

  it("env carries RKS_ACTOR, RKS_VIA=dispatch and a fresh non-empty RKS_DISPATCH_RUN_ID per run", async () => {
    const root = childTarget();
    const a = await run(newRun("agent-a"), { root });
    const b = await run(newRun("agent-a"), { root });
    const envA = a.spawn.calls[0].options.env;
    const envB = b.spawn.calls[0].options.env;
    expect(envA.RKS_ACTOR).toBe("agent-a");
    expect(envA.RKS_VIA).toBe("dispatch");
    expect(typeof envA.RKS_DISPATCH_RUN_ID).toBe("string");
    expect(envA.RKS_DISPATCH_RUN_ID.length).toBeGreaterThan(0);
    expect(envB.RKS_DISPATCH_RUN_ID).not.toBe(envA.RKS_DISPATCH_RUN_ID);
  });

  it("AC2/6b: parent env passes through unchanged apart from the three run variables", async () => {
    const root = childTarget();
    const parent = { ANTHROPIC_API_KEY: "sk-ant-sentinel", SENTINEL_VAR: "keep-me", RKS_VIA: "ide", PATH: "/bin" };
    const r = await run(newRun(), { root, env: parent });
    const env = r.spawn.calls[0].options.env;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-sentinel");
    expect(env.SENTINEL_VAR).toBe("keep-me");
    for (const [k, v] of Object.entries(parent)) {
      if (["RKS_ACTOR", "RKS_VIA", "RKS_DISPATCH_RUN_ID"].includes(k)) continue;
      expect(env[k]).toBe(v);
    }
    expect(Object.keys(env).sort()).toEqual([...new Set([...Object.keys(parent), "RKS_ACTOR", "RKS_VIA", "RKS_DISPATCH_RUN_ID"])].sort());
    const noKey = await run(newRun(), { root, env: { SENTINEL_VAR: "x" } });
    expect("ANTHROPIC_API_KEY" in noKey.spawn.calls[0].options.env).toBe(false);
  });
});

// ---------- AC3 / AC17: disallowed tools ----------

describe("AC3/AC17 — release reservation and off-rail floor", () => {
  const disallowed = (call) => argValue(call.args, "--disallowedTools").split(",");

  it("fresh run: all four RELEASE_TOOLS are disallowed for another actor, no user actor, and the user actor", async () => {
    const root = childTarget();
    const other = await run(newRun("agent-a"), { root, env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    for (const t of RELEASE_TOOLS) expect(disallowed(other.spawn.calls[0])).toContain(t);
    const none = await run(newRun("agent-a"), { root });
    for (const t of RELEASE_TOOLS) expect(disallowed(none.spawn.calls[0])).toContain(t);
    const user = await run(newRun("vince"), { root, env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    for (const t of RELEASE_TOOLS) expect(disallowed(user.spawn.calls[0])).toContain(t);
  });

  it("fresh run: the user actor set only in the target .env still gets all four RELEASE_TOOLS disallowed", async () => {
    const root = childTarget({ dotenv: `${USER_ACTOR_ENV_KEY}=vince\n` });
    const r = await run(newRun("vince"), { root });
    expect(r.spawn.calls).toHaveLength(1);
    const d = disallowed(r.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d).toContain(t);
    expect(d).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC17: mcp__rks__rks_guardrails_off is disallowed for the user actor, another actor and no user actor", async () => {
    const root = childTarget();
    for (const [actor, env] of [["vince", { [USER_ACTOR_ENV_KEY]: "vince" }], ["agent-a", { [USER_ACTOR_ENV_KEY]: "vince" }], ["agent-a", {}]]) {
      const r = await run(newRun(actor), { root, env });
      expect(disallowed(r.spawn.calls[0])).toContain("mcp__rks__rks_guardrails_off");
    }
  });

  it("AC3: final status reserved_for_user → ok false, reason reserved_for_user, intent release, non-zero", async () => {
    const r = await run(newRun(), { root: childTarget(), spawn: fakeSpawn({ stdout: lines(INIT(), RESULT({ status: "reserved_for_user", summary: "release asked" })) }) });
    expect(r.result).toMatchObject({ ok: false, reason: "reserved_for_user", intent: "release" });
    expect(r.exitCode).not.toBe(0);
  });
});

// ---------- AC4 / AC5 / AC6 ----------

describe("AC4/AC5 — checkpoints", () => {
  it("AC4: awaiting_human build_tests_failed → checkpoint, runId, initiator, awaiting exit, run record, telemetry", async () => {
    const root = childTarget();
    const r = await run(newRun("agent-a"), { root, spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("build_tests_failed"))) }) });
    expect(r.result.status).toBe("awaiting_human");
    expect(r.result.checkpoint).toMatchObject({ id: "cp-1", kind: "build_tests_failed" });
    expect(r.result.initiator).toBe("agent-a");
    expect(typeof r.result.runId).toBe("string");
    expect(r.exitCode).toBe(EXIT_CODES.awaiting);
    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBe(EXIT_CODES.failure);
    const rec = readRecord(root, r.result.runId);
    expect(rec.checkpoints).toHaveLength(1);
    expect(rec.checkpoints[0]).toMatchObject({ id: "cp-1", kind: "build_tests_failed" });
    expect(r.events.some((e) => e.type === "dispatch.checkpoint_raised" && e.payload.kind === "build_tests_failed")).toBe(true);
  });

  it("AC4/AC6: parseFinalResult accepts every kind and every status; complete exits 0", async () => {
    for (const kind of CHECKPOINT_KINDS) expect(parseFinalResult(JSON.stringify(awaiting(kind))).ok).toBe(true);
    for (const status of ["complete", "reserved_for_user", "failed"]) expect(parseFinalResult({ status, summary: "s" }).ok).toBe(true);
    const r = await run(newRun(), { root: childTarget() });
    expect(r.result).toMatchObject({ ok: true, status: "complete" });
    expect(r.exitCode).toBe(0);
  });

  it("AC5: a reserved kind with initiator != user actor (or none configured) → awaiting_user", async () => {
    const root = childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } });
    const s = () => fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("po_review_confirmation"))) });
    const other = await run(newRun("agent-a"), { root, spawn: s(), env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    expect(other.result.status).toBe("awaiting_user");
    const none = await run(newRun("agent-a"), { root, spawn: s() });
    expect(none.result.status).toBe("awaiting_user");
    const user = await run(newRun("vince"), { root, spawn: s(), env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    expect(user.result.status).toBe("awaiting_human");
  });
});

describe("AC6 — checkpoint contract violations", () => {
  const violates = async (stdout, extra = {}) => {
    const r = await run(newRun(), { root: childTarget(), spawn: fakeSpawn({ stdout, exitCode: 0, ...extra }) });
    expect(r.result.reason).toBe("checkpoint_contract_violation");
    expect(r.result.ok).toBe(false);
    expect(r.result.status).not.toBe("complete");
    expect(r.exitCode).not.toBe(0);
    return r;
  };

  it("missing result, unparseable JSON, unknown status, kind outside K1-K5, awaiting_human without checkpoint", async () => {
    expect(parseFinalResult(undefined).reason).toBe("checkpoint_contract_violation");
    expect(parseFinalResult("{not json").reason).toBe("checkpoint_contract_violation");
    expect(parseFinalResult({ status: "done", summary: "" }).reason).toBe("checkpoint_contract_violation");
    expect(parseFinalResult({ status: "awaiting_human", summary: "", checkpoint: { id: "x", kind: "release" } }).reason).toBe("checkpoint_contract_violation");
    expect(parseFinalResult({ status: "awaiting_human", summary: "" }).reason).toBe("checkpoint_contract_violation");
    await violates(lines(INIT(), RESULT({ status: "done", summary: "" })));
    await violates(lines(INIT(), RESULT({ status: "awaiting_human", summary: "", checkpoint: { id: "x", kind: "release" } })));
    await violates(lines(INIT(), RESULT({ status: "awaiting_human", summary: "" })));
    await violates(lines(INIT(), RESULT("{not json")));
  });

  it("the LAST result event's structured_output decides", async () => {
    const r = await run(newRun(), {
      root: childTarget(),
      spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(COMPLETE), RESULT(awaiting("governor_failed"))) }),
    });
    expect(r.result.status).toBe("awaiting_human");
    expect(r.result.checkpoint.kind).toBe("governor_failed");
    const r2 = await run(newRun(), {
      root: childTarget(),
      spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("governor_failed")), RESULT(COMPLETE)) }),
    });
    expect(r2.result.status).toBe("complete");
  });

  it("no result event, result without structured_output, is_error true (exit 0 each) → violation; is_error raw carries subtype", async () => {
    await violates(lines(INIT(), { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
    await violates(lines(INIT(), { type: "result", subtype: "success", is_error: false, result: "text only" }));
    const r = await violates(lines(INIT(), { type: "result", subtype: "error_max_turns", is_error: true, structured_output: COMPLETE }));
    expect(r.result.raw.subtype).toBe("error_max_turns");
  });

  it("no assistant-text fallback: a valid complete JSON in assistant text is never complete", async () => {
    const text = JSON.stringify(COMPLETE);
    await violates(lines(INIT(), { type: "assistant", message: { content: [{ type: "text", text: "```json\n" + text + "\n```" }] } }, { type: "result", subtype: "success", is_error: false, result: text }));
    await violates(lines(INIT(), { type: "assistant", message: { content: [{ type: "text", text }] } }));
  });

  it("non-JSON stdout lines and stderr go to the caller's stderr only and do not affect the result", async () => {
    const hook = "PreToolUse:Read hook error: No provenance for packages/x";
    const r = await run(newRun(), {
      root: childTarget(),
      spawn: fakeSpawn({ stdout: [hook, ...lines(INIT(), RESULT(COMPLETE))], stderr: ["claude.ai connectors are disabled"] }),
    });
    expect(r.err).toContain(hook);
    expect(r.err).toContain("claude.ai connectors are disabled");
    expect(r.out).not.toContain(hook);
    expect(r.out).not.toContain("claude.ai connectors are disabled");
    expect(r.result.status).toBe("complete");
    expect(r.out).toContain('"subtype":"init"'); // stream-json events are relayed to stdout
  });

  it("--json prints only the final result to stdout", async () => {
    const r = await run(newRun("agent-a", ["--json"]), { root: childTarget() });
    const outLines = r.out.trim().split("\n");
    expect(outLines).toHaveLength(1);
    expect(JSON.parse(outLines[0])).toEqual(r.result);
  });
});

// ---------- AC16: permission denials (backlog.fix.dispatch-permission-denials-truthful) ----------
//
// Tests named "denials TRnn" map to the nn-th testRequirement of
// notes/backlog.fix.dispatch-permission-denials-truthful.md. TR04, TR05, TR31 and TR32 live in
// tests/unit/routekit-dispatch-detach-status.test.mjs; TR33 is the [process] regression requirement.

describe("AC16 — permission denials fail closed", () => {
  const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tests/fixtures/dispatch-permission-denials.json"), "utf8"));
  const SENTINEL = "SENTINEL-tool-input-7f3a9c";
  /** A permission_denials entry as claude prints it (tool_input carries the sentinel). */
  const denial = (tool, id, extra = {}) => ({ tool_name: tool, tool_use_id: id, tool_input: { command: `cat ${SENTINEL}` }, ...extra });
  /** A user event carrying one tool_result block; meta (when given) is the event's tool_result_meta. */
  const toolResult = (id, content, { meta, parent = null } = {}) => ({
    type: "user",
    parent_tool_use_id: parent,
    message: { role: "user", content: [{ type: "tool_result", content, is_error: true, tool_use_id: id }] },
    ...(meta !== undefined ? { tool_result_meta: meta } : {}),
  });
  const hookText = (tool) => `PreToolUse:${tool} hook error: [node enforce-read-provenance.mjs]: blocked`;
  const hookResult = (tool, id, opts) => toolResult(id, hookText(tool), opts);
  const meta = (id, source) => ({ id, permission_decision: { decision: "reject", source, reason_type: source } });
  const RESULT_D = (structured, denials) => RESULT(structured, { permission_denials: denials });
  /** One blocking run whose stream is INIT, the given events, then a result with the given denials. */
  const segment = async (events, denials, structured = COMPLETE, root = childTarget()) => {
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT(), ...events, RESULT_D(structured, denials)) }) });
    return { ...r, root };
  };
  const sources = (r) => r.result.permissionDenials.map((d) => d.source);
  const statusOf = (root, runId) => run(["--status", runId, "--project", "child", "--actor", "agent-a"], { root });
  const expectFailClosed = (r) => {
    expect(r.result).toMatchObject({ ok: false, reason: "permission_denied" });
    expect(r.exitCode).toBe(EXIT_CODES.failure);
    expect(r.exitCode).not.toBe(EXIT_CODES.awaiting);
    expect(readRecord(r.root, r.result.runId).status).toBe("permission_denied");
  };

  it("denials TR01 AC1: 3 permission_denials → permissionDenied 3 in the printed result, the run record and --status", async () => {
    const r = await segment([], [denial("Write", "t1"), denial("Bash", "t2"), denial("Edit", "t3")]);
    expect(r.result.permissionDenied).toBe(3);
    expect(JSON.parse(r.out.trim().split("\n").pop()).permissionDenied).toBe(3);
    expect(readRecord(r.root, r.result.runId).permissionDenied).toBe(3);
    const s = await statusOf(r.root, r.result.runId);
    expect(s.result.permissionDenied).toBe(3);
  });

  it("denials TR02 AC1: the literal permission_denied in a tool_result string and in assistant text leaves the count at 0", async () => {
    const events = [
      ...Array.from({ length: 3 }, (_, i) => toolResult(`x${i}`, `permission_denied #${i}`)),
      { type: "assistant", message: { content: [{ type: "text", text: "I saw permission_denied earlier" }] } },
    ];
    const r = await run(newRun(), { root: childTarget(), spawn: fakeSpawn({ stdout: lines(INIT(), ...events, RESULT(COMPLETE)) }) });
    expect(r.result).toMatchObject({ ok: true, status: "complete", permissionDenied: 0, permissionDenials: [] });
    expect(r.exitCode).toBe(0);
  });

  it("denials TR03 AC2: no permission_denials key, or a string / object / null value → permissionDenied 0 and permissionDenials [] in result and record", async () => {
    const results = [RESULT(COMPLETE), ...["nope", { tool_name: "Bash" }, null].map((v) => RESULT(COMPLETE, { permission_denials: v }))];
    for (const res of results) {
      const root = childTarget();
      const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT(), res) }) });
      expect(r.result, JSON.stringify(res.permission_denials)).toMatchObject({ ok: true, permissionDenied: 0, permissionDenials: [] });
      const rec = readRecord(root, r.result.runId);
      expect(rec.permissionDenied).toBe(0);
      expect(rec.permissionDenials).toEqual([]);
    }
  });

  it("denials TR06 AC2/AC3: a claude spawn failure yields permissionDenied 0 and permissionDenials [] in the result and the record, without throwing", async () => {
    const root = childTarget();
    const spawn = () => {
      throw new Error("spawn claude ENOENT (fake)");
    };
    spawn.calls = [];
    const r = await run(newRun(), { root, spawn });
    expect(r.result).toMatchObject({ ok: false, reason: "claude_spawn_failed", permissionDenied: 0, permissionDenials: [] });
    const rec = readRecord(root, r.result.runId);
    expect(rec.status).toBe("failed");
    expect(rec.permissionDenied).toBe(0);
    expect(rec.permissionDenials).toEqual([]);
  });

  it("denials TR07 AC3: permissionDenials is an ordered array of { tool, toolUseId, source }, toolUseId null when absent, in result, record and --status", async () => {
    const { tool_use_id: _drop, ...noId } = denial("Grep", "unused");
    const r = await segment([hookResult("Bash", "a1"), toolResult("a2", "refused")], [denial("Bash", "a1"), denial("Read", "a2"), noId]);
    const expected = [
      { tool: "Bash", toolUseId: "a1", source: "hook" },
      { tool: "Read", toolUseId: "a2", source: "permission" },
      { tool: "Grep", toolUseId: null, source: "unclassified" },
    ];
    expect(r.result.permissionDenials).toEqual(expected);
    for (const e of r.result.permissionDenials) expect(Object.keys(e).sort()).toEqual(["source", "tool", "toolUseId"]);
    expect(readRecord(r.root, r.result.runId).permissionDenials).toEqual(expected);
    expect((await statusOf(r.root, r.result.runId)).result.permissionDenials).toEqual(expected);
  });

  it("denials TR08 AC3: a 2-denial segment and a resumed 1-denial segment accumulate to permissionDenied 3 and 3 entries in segment order", async () => {
    const root = childTarget();
    const first = await run(newRun(), {
      root,
      spawn: fakeSpawn({ stdout: lines(INIT("sess-acc"), hookResult("Read", "s1"), hookResult("Glob", "s2"), RESULT_D(awaiting("build_tests_failed", "cp-acc"), [denial("Read", "s1"), denial("Glob", "s2")])) }),
    });
    expect(first.result.status).toBe("awaiting_human");
    const runId = first.result.runId;
    const second = await run(["--resume", runId, "--answer", "cp-acc", "--actor", "agent-a", "go"], {
      root,
      spawn: fakeSpawn({ stdout: lines(INIT("sess-acc"), hookResult("Grep", "s3"), RESULT_D(COMPLETE, [denial("Grep", "s3")])) }),
    });
    const expected = [
      { tool: "Read", toolUseId: "s1", source: "hook" },
      { tool: "Glob", toolUseId: "s2", source: "hook" },
      { tool: "Grep", toolUseId: "s3", source: "hook" },
    ];
    expect(second.result).toMatchObject({ ok: true, status: "complete", permissionDenied: 3 });
    expect(second.result.permissionDenials).toEqual(expected);
    const rec = readRecord(root, runId);
    expect(rec.permissionDenied).toBe(3);
    expect(rec.permissionDenials).toEqual(expected);
    const s = await statusOf(root, runId);
    expect(s.result.permissionDenied).toBe(3);
    expect(s.result.permissionDenials).toEqual(expected);
  });

  it("denials TR09 AC3: the tool_input value appears nowhere in the result, the record bytes or the telemetry payloads", async () => {
    const r = await segment([hookResult("Bash", "q1"), toolResult("q2", "refused")], [denial("Bash", "q1"), denial("Write", "q2"), denial("Edit", "q3")]);
    expect(r.result.permissionDenied).toBe(3);
    expect(JSON.stringify(r.result)).not.toContain(SENTINEL);
    expect(fs.readFileSync(runRecordPath(r.root, r.result.runId), "utf8")).not.toContain(SENTINEL);
    expect(r.events.some((e) => e.type === "dispatch.permission_denied")).toBe(true);
    for (const e of r.events) expect(JSON.stringify(e.payload), e.type).not.toContain(SENTINEL);
  });

  it("denials TR10 AC4: a Bash denial whose string tool_result begins PreToolUse:Bash hook error: (no tool_result_meta) is hook", async () => {
    const r = await segment([hookResult("Bash", "b1")], [denial("Bash", "b1")]);
    expect(sources(r)).toEqual(["hook"]);
  });

  it("denials TR11 AC4: array content — the prefix in the first text block is hook; only in the second text block is permission", async () => {
    const first = await segment([toolResult("r1", [{ type: "text", text: hookText("Read") }, { type: "text", text: "more" }])], [denial("Read", "r1")]);
    expect(sources(first)).toEqual(["hook"]);
    const second = await segment([toolResult("r1", [{ type: "text", text: "Refused." }, { type: "text", text: hookText("Read") }])], [denial("Read", "r1")]);
    expect(sources(second)).toEqual(["permission"]);
  });

  it("denials TR12 AC4: a non-text first element then the prefixed text block is hook; no text at all (no text element, or a non-string non-array content) is permission", async () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const withImage = await segment([toolResult("r2", [img, { type: "text", text: hookText("Read") }])], [denial("Read", "r2")]);
    expect(sources(withImage)).toEqual(["hook"]);
    for (const content of [[img], 42, { text: hookText("Read") }, null]) {
      const r = await segment([toolResult("r2", content)], [denial("Read", "r2")]);
      expect(sources(r), JSON.stringify(content)).toEqual(["permission"]);
    }
  });

  it("denials TR13 AC4/AC5: hook error mid-string (not at offset 0) is permission, and a complete run with that single denial fails closed", async () => {
    for (const text of ["Refused: echo PreToolUse:Bash hook error: x", "Refused: the command mentions hook error"]) {
      const r = await segment([toolResult("m1", text)], [denial("Bash", "m1")]);
      expect(sources(r), text).toEqual(["permission"]);
      expectFailClosed(r);
    }
  });

  it("denials TR14 AC4: a Bash denial whose tool_result begins with another tool's prefix (PreToolUse:Read hook error:) is permission", async () => {
    const r = await segment([hookResult("Read", "d1")], [denial("Bash", "d1")]);
    expect(sources(r)).toEqual(["permission"]);
  });

  it("denials TR15 AC4: no tool_name or an empty tool_name is permission, never hook, against PreToolUse: hook error: and PreToolUse:undefined hook error:", async () => {
    const { tool_name: _drop, ...noName } = denial("x", "n1");
    for (const d of [noName, denial("", "n1")]) {
      for (const text of ["PreToolUse: hook error: blocked", "PreToolUse:undefined hook error: blocked"]) {
        const r = await segment([toolResult("n1", text)], [d]);
        expect(sources(r), `${JSON.stringify(d.tool_name)} / ${text}`).toEqual(["permission"]);
      }
    }
  });

  it("denials TR16 AC4: with two tool_result blocks for one id only the first is consulted (non-prefixed first, prefixed later → permission)", async () => {
    const r = await segment([toolResult("u1", "Refused."), hookResult("Bash", "u1")], [denial("Bash", "u1")]);
    expect(sources(r)).toEqual(["permission"]);
    const sameEvent = {
      type: "user",
      message: { content: [{ type: "tool_result", content: "Refused.", tool_use_id: "u2" }, { type: "tool_result", content: hookText("Bash"), tool_use_id: "u2" }] },
    };
    const r2 = await segment([sameEvent], [denial("Bash", "u2")]);
    expect(sources(r2)).toEqual(["permission"]);
  });

  it("denials TR17 AC4: tool_result_meta for the id — source config / no permission_decision / no source → permission; source hook → hook; meta only for other ids → hook", async () => {
    const cases = [
      [[meta("e1", "config")], "permission"],
      [[{ id: "e1" }], "permission"],
      [[{ id: "e1", permission_decision: { decision: "reject" } }], "permission"],
      [[meta("e1", "hook")], "hook"],
      [[meta("other-1", "config"), meta("other-2", "hook")], "hook"],
    ];
    for (const [m, expected] of cases) {
      const r = await segment([hookResult("Bash", "e1", { meta: m })], [denial("Bash", "e1")]);
      expect(sources(r), JSON.stringify(m)).toEqual([expected]);
    }
  });

  it("denials TR18 AC4: a matching tool_result without the prefix and without hook error is permission", async () => {
    const r = await segment([toolResult("p1", "The user doesn't want to proceed with this tool use.")], [denial("Write", "p1")]);
    expect(sources(r)).toEqual(["permission"]);
  });

  it("denials TR19 AC4: no matching tool_result in the segment, or no tool_use_id, is unclassified", async () => {
    const { tool_use_id: _drop, ...noId } = denial("Bash", "z");
    const r = await segment([hookResult("Bash", "other")], [denial("Bash", "missing"), noId]);
    expect(sources(r)).toEqual(["unclassified", "unclassified"]);
  });

  it("denials TR20 AC5: complete with a permission-source denial → permission_denied, failure exit (not awaiting), record permission_denied", async () => {
    const r = await segment([toolResult("f1", "Refused.")], [denial("Write", "f1")]);
    expect(sources(r)).toEqual(["permission"]);
    expectFailClosed(r);
  });

  it("denials TR21 AC5: complete whose only denials are unclassified → permission_denied, failure exit, record permission_denied", async () => {
    const r = await segment([], [denial("Write", "g1"), denial("Edit", "g2")]);
    expect(sources(r)).toEqual(["unclassified", "unclassified"]);
    expectFailClosed(r);
  });

  it("denials TR22 AC5: complete with a mix of hook and permission denials → permission_denied", async () => {
    const r = await segment([hookResult("Read", "h1"), toolResult("h2", "Refused.")], [denial("Read", "h1"), denial("Write", "h2")]);
    expect(sources(r)).toEqual(["hook", "permission"]);
    expectFailClosed(r);
  });

  it("denials TR23 AC6: complete whose only denials are hook → ok true, complete, exit 0, record complete, denials attached", async () => {
    const r = await segment([hookResult("Read", "k1"), hookResult("Glob", "k2")], [denial("Read", "k1"), denial("Glob", "k2")]);
    expect(r.result).toMatchObject({ ok: true, status: "complete", permissionDenied: 2 });
    expect(r.result.permissionDenials).toHaveLength(2);
    expect(r.exitCode).toBe(0);
    expect(readRecord(r.root, r.result.runId).status).toBe("complete");
  });

  it("denials TR24 AC7: awaiting_human with 11 permission_denials reports 11 (not 0), an 11-entry permissionDenials, awaiting exit", async () => {
    const ds = Array.from({ length: 11 }, (_, i) => denial("Read", `w${i}`));
    const r = await segment([], ds, awaiting("arch_needs_revision"));
    expect(r.result.status).toBe("awaiting_human");
    expect(r.result.permissionDenied).toBe(11);
    expect(r.result.permissionDenials).toHaveLength(11);
    expect(r.exitCode).toBe(EXIT_CODES.awaiting);
  });

  it("denials TR25 AC8: one dispatch.permission_denied per segment with payload { runId, count, bySource }", async () => {
    const r = await segment(
      [hookResult("Read", "v1"), hookResult("Glob", "v2"), toolResult("v3", "Refused.")],
      [denial("Read", "v1"), denial("Glob", "v2"), denial("Write", "v3"), denial("Edit", "v4")],
    );
    const pd = r.events.filter((e) => e.type === "dispatch.permission_denied");
    expect(pd).toHaveLength(1);
    expect(pd[0].payload).toEqual({ runId: r.result.runId, count: 4, bySource: { hook: 2, permission: 1, unclassified: 1 } });
  });

  it("denials TR26 AC8: a segment with zero denials emits no dispatch.permission_denied", async () => {
    const r = await segment([toolResult("y1", "permission_denied")], []);
    expect(r.result.status).toBe("complete");
    expect(r.events.filter((e) => e.type === "dispatch.permission_denied")).toHaveLength(0);
  });

  it('denials TR27 AC9: dispatch.js no longer contains line.includes("permission_denied")', () => {
    expect(DISPATCH_SRC).not.toContain('line.includes("permission_denied")');
  });

  /** The fixture events in file order; only a structured_output is added to the result event. */
  const fixtureRun = async () => {
    const events = FIXTURE.events.map((e) => (e.type === "result" ? { ...e, structured_output: COMPLETE } : e));
    const root = childTarget();
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(...events) }) });
    return { ...r, root };
  };

  it("denials TR28 AC10: the real-transcript fixture yields permissionDenied 11 with the expected tools in order and every source equal to expectedSources (hook)", async () => {
    const r = await fixtureRun();
    expect(r.result.permissionDenied).toBe(11);
    expect(r.result.permissionDenials.map((d) => d.tool)).toEqual([
      "Bash", "Read", "Grep", "Read", "Glob", "mcp__rks__dendron_read_note", "Glob", "Glob", "Glob", "Read", "Read",
    ]);
    for (const d of r.result.permissionDenials) {
      expect(d.source, d.toolUseId).toBe(FIXTURE.expectedSources[d.toolUseId]);
      expect(d.source).toBe("hook");
    }
    expect(r.result).toMatchObject({ ok: true, status: "complete" });
  });

  it("denials TR29 AC10: the 8 subagent-carried fixture denials are hook, and the segment payload bySource is { hook: 11, permission: 0, unclassified: 0 }", async () => {
    const SUBAGENT_IDS = [
      "toolu_018dA5fR6a5hihSZb71NsG53", "toolu_011kfw8F2deC5xyoo6B1XbaX", "toolu_01PnX9WnbqDLLjZhMHd4aXbo", "toolu_01FBXLNx9cCZhTz4qTERpUdy",
      "toolu_01M8jqpefS9XUajkx1BNPbYe", "toolu_01TNSisfteG7w3kRU4t1khBE", "toolu_019kDxTNEfyd25kaVUpFWpr3", "toolu_01EowmLZ8FZhWnPruHkY3FbJ",
    ];
    const carriedBySubagent = FIXTURE.events
      .filter((e) => e.type === "user" && e.parent_tool_use_id !== null)
      .map((e) => e.message.content[0].tool_use_id);
    expect(carriedBySubagent).toEqual(SUBAGENT_IDS);
    const r = await fixtureRun();
    const byId = Object.fromEntries(r.result.permissionDenials.map((d) => [d.toolUseId, d.source]));
    for (const id of SUBAGENT_IDS) expect(byId[id], id).toBe("hook");
    const pd = r.events.filter((e) => e.type === "dispatch.permission_denied");
    expect(pd).toHaveLength(1);
    expect(pd[0].payload).toEqual({ runId: r.result.runId, count: 11, bySource: { hook: 11, permission: 0, unclassified: 0 } });
  });

  it("denials TR30 AC11: the AC16 tests feed result.permission_denials, not the fabricated permission_denied #i tool_result lines", () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const block = src.slice(src.indexOf('describe("AC16'), src.indexOf("// ---------- run record, telemetry best-effort"));
    expect(block).toContain("permission_denials: denials");
    expect(block).not.toContain("permission_denied #$" + "{i}` }] } }))");
    expect(src).not.toContain("const denied" + " = (n)");
  });
});

// ---------- run record, telemetry best-effort, testability ----------

describe("run record and telemetry", () => {
  it("claudeSessionId comes from the stream-json init event", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("observed-session-42"), RESULT(COMPLETE, { session_id: "observed-session-42" })) }) });
    expect(readRecord(root, r.result.runId).claudeSessionId).toBe("observed-session-42");
    expect(r.result.claudeSessionId).toBe("observed-session-42");
  });

  it("a throwing telemetry emitter does not change a complete run's result or exit code", async () => {
    const root = childTarget();
    const ids = ["fixed-run-1", "fixed-run-2"];
    const quiet = await run(newRun(), { root, newRunId: () => ids[0] });
    const loud = await run(newRun(), { root, newRunId: () => ids[1], telemetry: async () => { throw new Error("sink down"); } });
    expect(loud.exitCode).toBe(quiet.exitCode);
    expect({ ...loud.result, runId: "x" }).toEqual({ ...quiet.result, runId: "x" });
    expect(loud.result.status).toBe("complete");
  });

  it("testability: spawn, registry, credential, claude lookup and telemetry are all injectable (no real claude)", async () => {
    const seen = {};
    const root = childTarget();
    const spawn = fakeSpawn();
    const { result } = await handleDispatchCommand(
      { args: ["dispatch", ...newRun()], SHELL_ROOT: tmp() },
      {
        spawn,
        getProject: async (id) => { seen.registry = id; return { id, root }; },
        resolveCredential: async () => { seen.credential = true; return { credential: "api" }; },
        findClaude: async () => { seen.claude = true; return "/x/claude"; },
        telemetry: async (type) => { seen.telemetry = type; },
        env: {},
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(result.status).toBe("complete");
    expect(spawn.calls).toHaveLength(1);
    expect(seen).toMatchObject({ registry: "child", credential: true, claude: true });
    expect(typeof seen.telemetry).toBe("string");
  });
});

// ---------- AC7: resume / answer ----------

describe("AC7 — resume and answer", () => {
  async function raise(kind, { root, actor = "agent-a", env = {} } = {}) {
    const r = await run(newRun(actor), { root, env, spawn: fakeSpawn({ stdout: lines(INIT("sess-orig"), RESULT(awaiting(kind, "cp-9"))) }) });
    expect(r.result.status).toMatch(/^awaiting_/);
    return r.result.runId;
  }
  const answer = (runId, cp, actor, text = "go ahead") => ["--resume", runId, "--answer", cp, "--actor", actor, text];

  it("a checkpoint id that is not the open one → checkpoint_not_open, no spawn", async () => {
    const root = childTarget();
    const runId = await raise("build_tests_failed", { root });
    const r = await run(answer(runId, "cp-wrong", "agent-a"), { root });
    expect(r.result.reason).toBe("checkpoint_not_open");
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("reserved kind answered by a non-user actor → reserved_for_user; non-reserved by a non-initiator → answerer_not_initiator", async () => {
    const root = childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } });
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const reservedRun = await raise("po_review_confirmation", { root, env });
    const r1 = await run(answer(reservedRun, "cp-9", "agent-a"), { root, env });
    expect(r1.result.reason).toBe("reserved_for_user");
    expect(r1.spawn.calls).toHaveLength(0);
    const plainRun = await raise("arch_needs_revision", { root, env });
    const r2 = await run(answer(plainRun, "cp-9", "agent-b"), { root, env });
    expect(r2.result.reason).toBe("answerer_not_initiator");
    expect(r2.spawn.calls).toHaveLength(0);
  });

  it("a valid answer is recorded, emits checkpoint_answered and resumes the stored session with the same run id", async () => {
    const root = childTarget();
    const runId = await raise("build_tests_failed", { root });
    const r = await run(answer(runId, "cp-9", "agent-a", "fix the flaky test and retry"), { root });
    expect(r.spawn.calls).toHaveLength(1);
    const { args, options } = r.spawn.calls[0];
    expect(args).toContain("-p");
    expect(argValue(args, "--resume")).toBe("sess-orig");
    expect(options.env.RKS_DISPATCH_RUN_ID).toBe(runId);
    const cp = readRecord(root, runId).checkpoints.find((c) => c.id === "cp-9");
    expect(cp).toMatchObject({ answeredBy: "agent-a", answeredVia: "dispatch", answer: "fix the flaky test and retry" });
    expect(typeof cp.answeredAt).toBe("string");
    const ev = r.events.find((e) => e.type === "dispatch.checkpoint_answered");
    expect(ev.payload).toMatchObject({ runId, checkpointId: "cp-9", kind: "build_tests_failed", answeringActor: "agent-a", via: "dispatch" });
    expect(r.result.status).toBe("complete");
  });

  it("the user actor answers a reserved checkpoint; --resume finds the run without --project", async () => {
    const root = childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } });
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const runId = await raise("po_review_confirmation", { root, env });
    const r = await run(answer(runId, "cp-9", "vince", "confirmed"), { root, env });
    expect(r.spawn.calls).toHaveLength(1);
    expect(r.result.status).toBe("complete");
  });

  const resumeDisallowed = (call) => argValue(call.args, "--disallowedTools").split(",");

  it("AC2: a non-reserved checkpoint started and answered by the user actor resumes with no RELEASE_TOOLS disallowed", async () => {
    const root = childTarget();
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const runId = await raise("build_tests_failed", { root, actor: "vince", env });
    const r = await run(answer(runId, "cp-9", "vince"), { root, env });
    expect(r.spawn.calls).toHaveLength(1);
    expect(r.spawn.calls[0].args).toContain("--resume");
    const d = resumeDisallowed(r.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d).not.toContain(t);
    expect(d).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC2: a reserved checkpoint started and answered by the user actor resumes with no RELEASE_TOOLS disallowed", async () => {
    const root = childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } });
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const runId = await raise("po_review_confirmation", { root, actor: "vince", env });
    const r = await run(answer(runId, "cp-9", "vince", "confirmed"), { root, env });
    expect(r.spawn.calls).toHaveLength(1);
    expect(r.spawn.calls[0].args).toContain("--resume");
    const d = resumeDisallowed(r.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d).not.toContain(t);
    expect(d).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC3: a reserved checkpoint started by agent-a and answered by the user actor still disallows all four RELEASE_TOOLS", async () => {
    const root = childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } });
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const runId = await raise("po_review_confirmation", { root, actor: "agent-a", env });
    const r = await run(answer(runId, "cp-9", "vince", "confirmed"), { root, env });
    expect(r.spawn.calls).toHaveLength(1);
    const d = resumeDisallowed(r.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d).toContain(t);
    expect(d).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC3: an answering actor that is not the user actor disallows all four RELEASE_TOOLS (agent-a answering, and vince under a different user actor)", async () => {
    const root = childTarget();
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const agentRun = await raise("build_tests_failed", { root, actor: "agent-a", env });
    const r1 = await run(answer(agentRun, "cp-9", "agent-a"), { root, env });
    expect(r1.spawn.calls).toHaveLength(1);
    const d1 = resumeDisallowed(r1.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d1).toContain(t);
    expect(d1).toContain("mcp__rks__rks_guardrails_off");
    const vinceRun = await raise("build_tests_failed", { root, actor: "vince", env });
    const r2 = await run(answer(vinceRun, "cp-9", "vince"), { root, env: { [USER_ACTOR_ENV_KEY]: "alice" } });
    expect(r2.spawn.calls).toHaveLength(1);
    const d2 = resumeDisallowed(r2.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d2).toContain(t);
    expect(d2).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC3: with no user actor configured at resume, all four RELEASE_TOOLS are disallowed", async () => {
    const root = childTarget();
    const runId = await raise("build_tests_failed", { root, actor: "vince", env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    const r = await run(answer(runId, "cp-9", "vince"), { root, env: {} });
    expect(r.spawn.calls).toHaveLength(1);
    const d = resumeDisallowed(r.spawn.calls[0]);
    for (const t of RELEASE_TOOLS) expect(d).toContain(t);
    expect(d).toContain("mcp__rks__rks_guardrails_off");
  });

  it("AC17: the resume spawn also disallows mcp__rks__rks_guardrails_off", async () => {
    const root = childTarget();
    const runId = await raise("governor_failed", { root });
    const r = await run(answer(runId, "cp-9", "agent-a"), { root });
    expect(argValue(r.spawn.calls[0].args, "--disallowedTools").split(",")).toContain("mcp__rks__rks_guardrails_off");
  });
});

// ---------- AC18: lease ----------

describe("AC18 — lease stays server-side", () => {
  it("dispatch.js has no static or dynamic import of project-lease.mjs, governor-token.mjs or server.mjs", () => {
    for (const mod of ["project-lease.mjs", "governor-token.mjs", "server.mjs"]) {
      const esc = mod.replace(/\./g, "\\.");
      expect(DISPATCH_SRC).not.toMatch(new RegExp(`from\\s*["'][^"']*${esc}["']`));
      expect(DISPATCH_SRC).not.toMatch(new RegExp(`import\\s*\\(\\s*["'\`][^"'\`]*${esc}`));
    }
  });

  it("cold-start: dispatch.js does not import packages/mcp-rks/src/server.mjs", () => {
    expect(DISPATCH_SRC).not.toMatch(/mcp-rks\/src\/server\.mjs/);
  });

  it("no .rks/session/lease directory after an admitted run and after a resume run", async () => {
    const root = childTarget();
    const r = await run(newRun(), { root, spawn: fakeSpawn({ stdout: lines(INIT("s1"), RESULT(awaiting("governor_failed", "cp-l"))) }) });
    expect(fs.existsSync(path.join(root, ".rks", "session", "lease"))).toBe(false);
    await run(["--resume", r.result.runId, "--answer", "cp-l", "--actor", "agent-a", "retry"], { root });
    expect(fs.existsSync(path.join(root, ".rks", "session", "lease"))).toBe(false);
  });

  it("the appended contract names project_leased, lease_contended, lease_lost, governor_failed and holder", async () => {
    const r = await run(newRun(), { root: childTarget() });
    const contract = argValue(r.spawn.calls[0].args, "--append-system-prompt");
    for (const s of ["project_leased", "lease_contended", "lease_lost", "governor_failed", "holder"]) expect(contract).toContain(s);
  });
});

// ---------- AC19: admission credential ----------

describe("AC19 — admissionCredential", () => {
  for (const credential of ["subscription", "api"]) {
    it(`credential ${credential}: result, run record and dispatch.started carry admissionCredential and never credential`, async () => {
      const root = childTarget();
      const r = await run(newRun(), { root, credential });
      const rec = readRecord(root, r.result.runId);
      const started = r.events.find((e) => e.type === "dispatch.started").payload;
      for (const obj of [r.result, rec, started]) {
        expect(obj.admissionCredential).toBe(credential);
        expect(Object.prototype.hasOwnProperty.call(obj, "credential")).toBe(false);
      }
    });
  }

  it("routekit.js usage for dispatch mentions admissionCredential, ANTHROPIC_API_KEY and claude.ai", () => {
    const usage = CLI_SRC.slice(CLI_SRC.indexOf("function usage()"), CLI_SRC.indexOf("function printPlanHelp()"));
    expect(usage).toContain("admissionCredential");
    expect(usage).toContain("ANTHROPIC_API_KEY");
    expect(usage).toContain("claude.ai");
  });

  it("cold start: subscription-status.mjs appears only inside a dynamic import(, never a static import", () => {
    expect(DISPATCH_SRC).not.toMatch(/import\s+[^;()]*?from\s*["'][^"']*subscription-status\.mjs["']/);
    const all = DISPATCH_SRC.match(/subscription-status\.mjs/g) || [];
    const dynamic = DISPATCH_SRC.match(/import\(\s*["'][^"']*subscription-status\.mjs["']\s*\)/g) || [];
    expect(all.length).toBeGreaterThan(0);
    expect(dynamic.length).toBe(all.length);
  });
});

// ---------- AC20: version floor ----------

describe("AC20 — version floor", () => {
  const refusedChild = async (root, expectedVersion) => {
    const r = await run(newRun(), { root });
    expect(r.result).toMatchObject({ ok: false, reason: "rks_version_unsupported", minRksVersion: "0.85.0", rksVersionSource: "stamp" });
    expect(r.result.rksVersion).toBe(expectedVersion);
    expect(r.exitCode).toBe(EXIT_CODES.failure);
    expect(r.spawn.calls).toHaveLength(0);
    const refused = r.events.filter((e) => e.type === "dispatch.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].payload).toMatchObject({ projectId: "child", reason: "rks_version_unsupported" });
    return r;
  };

  it("child refusals: no key, numeric, no project.json, malformed, bad format, unstamped sentinel, below floor", async () => {
    await refusedChild(childTarget({ stamp: null }), null);
    await refusedChild(childTarget({ stamp: 85 }), null);
    await refusedChild(childTarget({ omitProjectJson: true }), null);
    await refusedChild(childTarget({ projectJson: "{ not json" }), null);
    await refusedChild(childTarget({ stamp: "v0.85.0" }), "v0.85.0");
    await refusedChild(childTarget({ stamp: "garbage" }), "garbage");
    await refusedChild(childTarget({ stamp: "0.1.0" }), "0.1.0");
    await refusedChild(childTarget({ stamp: "0.84.9" }), "0.84.9");
  });

  it("numeric comparison: 0.85.0, 0.85.1, 0.100.0, 1.0.0 admitted; 0.9.0 and 0.84.99 refused", async () => {
    for (const stamp of ["0.85.0", "0.85.1", "0.100.0", "1.0.0"]) {
      const r = await run(newRun(), { root: childTarget({ stamp }) });
      expect(r.spawn.calls, stamp).toHaveLength(1);
    }
    for (const stamp of ["0.9.0", "0.84.99"]) {
      const r = await run(newRun(), { root: childTarget({ stamp }) });
      expect(r.result.reason, stamp).toBe("rks_version_unsupported");
      expect(r.spawn.calls).toHaveLength(0);
    }
  });

  it("child message names routekit project upgrade --id <projectId> and --from-release", async () => {
    const r = await refusedChild(childTarget({ stamp: "0.84.0" }), "0.84.0");
    expect(r.result.message).toContain("routekit project upgrade --id child");
    expect(r.result.message).toContain("--from-release");
  });

  it("shell root: admitted at 0.85.0 from package.json regardless of SHELL_ROOT; 0.84.0 or no package.json refused with the shell message", async () => {
    const shellRoot = tmp("rks-dispatch-other-shell-");
    const ok = await run(newRun(), { root: shellTarget({ version: "0.85.0" }), shellRoot });
    expect(ok.spawn.calls).toHaveLength(1);
    expect(ok.result).toMatchObject({ rksVersion: "0.85.0", rksVersionSource: "shell_package_json" });
    for (const version of ["0.84.0", null]) {
      const r = await run(newRun(), { root: shellTarget({ version }), shellRoot });
      expect(r.result).toMatchObject({ reason: "rks_version_unsupported", rksVersionSource: "shell_package_json" });
      expect(r.spawn.calls).toHaveLength(0);
      expect(r.result.message).toMatch(/update the shell checkout/);
      expect(r.result.message).not.toContain("routekit project upgrade");
    }
  });

  it("shell marker: isRksShellRoot true for the marker; a differently named package is a child (stamp source)", async () => {
    expect(isRksShellRoot(shellTarget())).toBe(true);
    const notShell = shellTarget({ markerName: "@someone/else" });
    expect(isRksShellRoot(notShell)).toBe(false);
    const r = await run(newRun(), { root: notShell });
    expect(r.result).toMatchObject({ reason: "rks_version_unsupported", rksVersionSource: "stamp" });
    expect(r.result.message).toContain("routekit project upgrade");
    const stamped = await run(newRun(), { root: shellTarget({ markerName: "@someone/else", version: "0.10.0", stamp: "0.85.0" }) });
    expect(stamped.result).toMatchObject({ status: "complete", rksVersionSource: "stamp", rksVersion: "0.85.0" });
  });

  it("an admitted child run carries rksVersionSource stamp in result, run record and dispatch.started", async () => {
    const root = childTarget({ stamp: "0.85.1" });
    const r = await run(newRun(), { root });
    expect(r.result).toMatchObject({ rksVersion: "0.85.1", rksVersionSource: "stamp" });
    expect(readRecord(root, r.result.runId)).toMatchObject({ rksVersion: "0.85.1", rksVersionSource: "stamp" });
    expect(r.events.find((e) => e.type === "dispatch.started").payload).toMatchObject({ rksVersion: "0.85.1", rksVersionSource: "stamp" });
  });

  it("ordering: an unregistered project yields project_not_registered, never rks_version_unsupported", async () => {
    const r = await run(newRun(), { root: null });
    expect(r.result.reason).toBe("project_not_registered");
  });

  it("resume: a stamp lowered to 0.84.0 after the run record was written refuses with no claude --resume", async () => {
    const root = childTarget();
    const first = await run(newRun("agent-a"), { root, spawn: fakeSpawn({ stdout: lines(INIT("s-v"), RESULT(awaiting("build_tests_failed", "cp-v"))) }) });
    fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: "child", rksVersion: "0.84.0" }));
    const r = await run(["--resume", first.result.runId, "--answer", "cp-v", "--actor", "agent-a", "retry"], { root });
    expect(r.result.reason).toBe("rks_version_unsupported");
    expect(r.exitCode).not.toBe(0);
    expect(r.spawn.calls).toHaveLength(0);
    // the refused answer did not consume the checkpoint
    expect(readRecord(root, first.result.runId).checkpoints[0].answeredAt).toBeNull();
  });
});

// ---------- AC21: default telemetry sink ----------

describe("AC21 — default telemetry sink", () => {
  const readEvents = (root) => {
    const dir = path.join(root, ".rks", "telemetry");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^events-.*\.jsonl$/.test(f))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  };

  it("no emitter injected: dispatch.started lands in <target>/.rks/telemetry/events-*.jsonl", async () => {
    const root = childTarget();
    const r = await run(newRun("agent-a"), { root, telemetry: null, credential: "subscription" });
    const started = readEvents(root).find((e) => e.type === "dispatch.started");
    expect(started).toBeTruthy();
    expect(started.payload).toMatchObject({ runId: r.result.runId, initiator: "agent-a", admissionCredential: "subscription" });
  });

  it("a project_not_registered refusal is written under SHELL_ROOT", async () => {
    const shellRoot = tmp("rks-dispatch-sr-");
    await run(newRun(), { root: null, telemetry: null, shellRoot });
    expect(readEvents(shellRoot).some((e) => e.type === "dispatch.refused")).toBe(true);
  });

  it("a failing default write never changes the result or exit code", async () => {
    const root = childTarget();
    fs.writeFileSync(path.join(root, ".rks", "telemetry"), "not a directory");
    const r = await run(newRun(), { root, telemetry: null });
    expect(r.result).toMatchObject({ ok: true, status: "complete" });
    expect(r.exitCode).toBe(0);
    const badRoot = childTarget({ stamp: "0.84.0" });
    fs.writeFileSync(path.join(badRoot, ".rks", "telemetry"), "not a directory");
    const refused = await run(newRun(), { root: badRoot, telemetry: null });
    expect(refused.result.reason).toBe("rks_version_unsupported");
    expect(refused.exitCode).not.toBe(0);
  });

  it("cold start: storage.mjs and types.mjs are loaded only via dynamic import(", () => {
    for (const mod of ["storage.mjs", "types.mjs"]) {
      const esc = mod.replace(/\./g, "\\.");
      expect(DISPATCH_SRC).not.toMatch(new RegExp(`import\\s+[^;()]*?from\\s*["'][^"']*telemetry/src/${esc}["']`));
      expect(DISPATCH_SRC).toMatch(new RegExp(`import\\(\\s*["'][^"']*telemetry/src/${esc}["']\\s*\\)`));
    }
  });
});

// ---------- AC10 / AC9: wiring and repo config ----------

describe("AC10 — routekit.js wiring", () => {
  it("imports handleDispatchCommand from ../src/cli/dispatch.js and has a cmd === \"dispatch\" branch", () => {
    expect(CLI_SRC).toMatch(/import\s*\{\s*handleDispatchCommand\s*\}\s*from\s*["']\.\.\/src\/cli\/dispatch\.js["']/);
    expect(CLI_SRC).toMatch(/if\s*\(\s*cmd\s*===\s*["']dispatch["']\s*\)/);
  });

  it("usage text names routekit dispatch, --project, --resume, --answer, --actor and the exit codes", () => {
    const usage = CLI_SRC.slice(CLI_SRC.indexOf("function usage()"), CLI_SRC.indexOf("function printPlanHelp()"));
    expect(usage).toContain("routekit dispatch");
    for (const flag of ["--project", "--resume", "--answer", "--actor"]) expect(usage).toMatch(new RegExp(`dispatch[^\\n]*${flag}`));
    expect(usage).toMatch(/exit codes: 0 complete; 1 refused or failed; 2 usage error; 3 awaiting_human \/ awaiting_user/);
  });

  it("AC5: dispatch --help says release tools are never admitted on a fresh run, only on a --resume", async () => {
    const r = await run(["--help"], { root: childTarget() });
    expect(r.spawn.calls).toHaveLength(0);
    const flat = r.out.replace(/\s+/g, " ");
    const sentence = (flat.match(/release tools[^.]*\./i) || [""])[0];
    expect(sentence).toMatch(/fresh run/i);
    expect(sentence).toContain("--resume");
  });

  it("AC5: the routekit.js usage() dispatch help says release is never admitted on a fresh run, only on a --resume", () => {
    const usage = CLI_SRC.slice(CLI_SRC.indexOf("function usage()"), CLI_SRC.indexOf("function printPlanHelp()"));
    expect(usage).toMatch(/never admitted on a fresh run/i);
    expect(usage).toMatch(/fresh run[^\n]*--resume/i);
  });

  it("AC5: the RELEASE_TOOLS doc comment names a fresh run and --resume and drops the initiator-only rule", () => {
    const at = DISPATCH_SRC.indexOf("export const RELEASE_TOOLS");
    const doc = DISPATCH_SRC.slice(DISPATCH_SRC.lastIndexOf("/**", at), at);
    expect(doc).toMatch(/fresh run/i);
    expect(doc).toContain("--resume");
    expect(doc).not.toMatch(/disallowed unless the initiator is the configured user actor/i);
  });

  it("out of scope: DISPATCH_CONTRACT still says Never attempt a release, promotion, staging sync or tag.", () => {
    expect(DISPATCH_SRC).toContain("Never attempt a release, promotion, staging sync or tag.");
  });

  it("--help prints the dispatch usage and exits 0 without spawning", async () => {
    const r = await run(["--help"], { root: childTarget() });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("routekit dispatch --project <id> --actor <name>");
    expect(r.spawn.calls).toHaveLength(0);
  });

  // backlog.feat.dispatch-detach-status AC20
  const usageSlice = () => CLI_SRC.slice(CLI_SRC.indexOf("function usage()"), CLI_SRC.indexOf("function printPlanHelp()"));

  it("AC20 (detach-status): DISPATCH_USAGE and the usage() slice document --detach on both forms, the --status form, and both exit-0 rules", () => {
    for (const [name, text] of [["DISPATCH_USAGE", DISPATCH_USAGE], ["usage()", usageSlice()]]) {
      const all = text.split("\n");
      const start = all.find((l) => /dispatch --project <id> --actor <name>/.test(l));
      const resume = all.find((l) => /dispatch --resume <runId> --answer <checkpointId>/.test(l));
      expect(start, name).toContain("--detach");
      expect(resume, name).toContain("--detach");
      expect(text, name).toContain("--status <runId> --project <id> --actor <name> [--json]");
      const flat = text.replace(/\s+#?\s*/g, " ");
      expect(flat, name).toContain("--detach exits 0 once the worker is launched");
      expect(flat, name).toContain("--status exits 0 when the record is found");
    }
    // the pinned exit-code line keeps its wording
    expect(usageSlice()).toMatch(/exit codes: 0 complete; 1 refused or failed; 2 usage error; 3 awaiting_human \/ awaiting_user/);
  });

  it("AC20 (detach-status): the hidden --_worker entry is not documented in DISPATCH_USAGE or the usage() slice", () => {
    expect(DISPATCH_USAGE).not.toContain("_worker");
    expect(usageSlice()).not.toContain("_worker");
  });
});

describe("default reservation — po_review_confirmation is reserved when dispatch.reservedForUser is absent", () => {
  it("AC1: validateDispatchConfig(undefined) and (null) default to reserving po_review_confirmation", () => {
    for (const config of [undefined, null]) {
      expect(validateDispatchConfig(config)).toEqual({ ok: true, reservedForUser: ["po_review_confirmation"], defaulted: true });
    }
  });

  it("AC2: validateDispatchConfig({}) defaults the same way", () => {
    expect(validateDispatchConfig({})).toEqual({ ok: true, reservedForUser: ["po_review_confirmation"], defaulted: true });
  });

  it("AC3: an explicit list, including the [] opt-out, is honoured with defaulted false", () => {
    expect(validateDispatchConfig({ reservedForUser: [] })).toEqual({ ok: true, reservedForUser: [], defaulted: false });
    expect(validateDispatchConfig({ reservedForUser: ["po_review_confirmation"] })).toEqual({ ok: true, reservedForUser: ["po_review_confirmation"], defaulted: false });
  });

  it("AC3: successive default results are distinct arrays, so mutating one does not change the next default", () => {
    const a = validateDispatchConfig(undefined);
    const b = validateDispatchConfig(undefined);
    expect(a.reservedForUser).not.toBe(b.reservedForUser);
    a.reservedForUser.push("governor_failed");
    expect(b.reservedForUser).toEqual(["po_review_confirmation"]);
    expect(validateDispatchConfig(undefined).reservedForUser).toEqual(["po_review_confirmation"]);
  });

  it("AC4: malformed configs are still refused with invalid_dispatch_config", () => {
    for (const config of [
      { reservedForUser: "po_review_confirmation" },
      { reservedForUser: [1] },
      { reservedForUser: ["not_a_kind"] },
      { reservedForUser: [], extra: true },
      { reservedForUser: [], userActor: "vince" },
    ]) {
      expect(validateDispatchConfig(config)).toMatchObject({ ok: false, reason: "invalid_dispatch_config" });
    }
  });

  const k1 = () => fakeSpawn({ stdout: lines(INIT("sess-k1"), RESULT(awaiting("po_review_confirmation", "cp-k1"))) });

  it("AC5: a fresh run in a child with no dispatch block stops at K1 as awaiting_user, with or without a user actor", async () => {
    const root = childTarget();
    const other = await run(newRun("agent-a"), { root, spawn: k1(), env: { [USER_ACTOR_ENV_KEY]: "vince" } });
    expect(other.result.status).toBe("awaiting_user");
    const none = await run(newRun("agent-a"), { root, spawn: k1() });
    expect(none.result.status).toBe("awaiting_user");
  });

  it("AC5: the initiator cannot answer the defaulted K1 — reserved_for_user, zero spawn calls", async () => {
    const root = childTarget();
    const env = { [USER_ACTOR_ENV_KEY]: "vince" };
    const raised = await run(newRun("agent-a"), { root, env, spawn: k1() });
    expect(raised.result.status).toBe("awaiting_user");
    const r = await run(["--resume", raised.result.runId, "--answer", "cp-k1", "--actor", "agent-a", "go ahead"], { root, env });
    expect(r.result.reason).toBe("reserved_for_user");
    expect(r.spawn.calls).toHaveLength(0);
  });

  it("AC5: the default reserves only po_review_confirmation — build_tests_failed stays awaiting_human", async () => {
    const root = childTarget();
    const r = await run(newRun("agent-a"), {
      root,
      env: { [USER_ACTOR_ENV_KEY]: "vince" },
      spawn: fakeSpawn({ stdout: lines(INIT(), RESULT(awaiting("build_tests_failed"))) }),
    });
    expect(r.result.status).toBe("awaiting_human");
  });

  const startedPayload = (r) => r.events.find((e) => e.type === "dispatch.started").payload;

  it("AC6: dispatch.started records reservedForUser and reservedDefaulted true for a child with no dispatch block", async () => {
    const r = await run(newRun(), { root: childTarget() });
    expect(startedPayload(r)).toMatchObject({ reservedForUser: ["po_review_confirmation"], reservedDefaulted: true });
  });

  it("AC6: explicit config, including [], records reservedDefaulted false", async () => {
    const explicit = await run(newRun(), { root: childTarget({ dispatch: { reservedForUser: ["po_review_confirmation"] } }) });
    expect(startedPayload(explicit)).toMatchObject({ reservedForUser: ["po_review_confirmation"], reservedDefaulted: false });
    const optOut = await run(newRun(), { root: childTarget({ dispatch: { reservedForUser: [] } }) });
    expect(startedPayload(optOut)).toMatchObject({ reservedForUser: [], reservedDefaulted: false });
  });

  it("AC7: dispatch --help names the default reservation and the [] opt-out", async () => {
    const r = await run(["--help"], { root: childTarget() });
    expect(r.spawn.calls).toHaveLength(0);
    const flat = r.out.replace(/\s+/g, " ");
    expect(flat).toContain("dispatch.reservedForUser is absent");
    expect(flat).toContain("po_review_confirmation is reserved for the user by default");
    expect(flat).toContain('"reservedForUser": []');
    expect(flat).toMatch(/opt-out/);
  });
});

describe("AC9 — repo .rks/project.json dispatch block", () => {
  it("reserves po_review_confirmation and has no userActor", () => {
    const pj = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".rks", "project.json"), "utf8"));
    expect(pj.dispatch.reservedForUser).toEqual(["po_review_confirmation"]);
    expect(Object.prototype.hasOwnProperty.call(pj.dispatch, "userActor")).toBe(false);
    expect(validateDispatchConfig(pj.dispatch).ok).toBe(true);
  });
});
