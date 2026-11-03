// routekit dispatch --project <id> --actor <name> [--json] "<intent>"
// routekit dispatch --resume <runId> --answer <checkpointId> --actor <name> [--project <id>] [--json] "<direction>"
//
// backlog.feat.routekit-dispatch-headless (Phase 1b of the external-agent dispatch parity roadmap).
//
// Runs the REAL Dispatcher as headless Claude Code (`claude -p`, no --bare) in a registered project
// root, so the project's hooks, CLAUDE.md, skills and .mcp.json load exactly as in the IDE. The
// caller hands over intent and relays results and answers; it never calls MCP tools itself. Every
// run ends in exactly one of: complete, a K1-K5 checkpoint (awaiting_human / awaiting_user),
// reserved_for_user, failed, or a refusal. There is no third "unverified" success state.
//
// No side effects at import time: routekit.js imports this module statically for every verb.
// Cold start: the credential resolver and the telemetry modules are loaded lazily with
// `await import(...)` inside the code paths that need them, so `routekit --help` does not load them.
//
// Lease: this module never touches the project lease. It sets RKS_ACTOR, RKS_VIA and
// RKS_DISPATCH_RUN_ID on the spawned claude process; the mcp-rks server that Claude Code starts
// from .mcp.json reads them and enforces the lease server-side (story §6a).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { readRksVersion } from "../project/read-rks-version.mjs";

/** The closed parity checkpoint set (paper §4.1). */
export const CHECKPOINT_KINDS = Object.freeze([
  "po_review_confirmation",
  "arch_needs_revision",
  "build_decomposed_orphaned_tests",
  "build_tests_failed",
  "governor_failed",
]);

/** Release-family MCP tools: always disallowed on a fresh run; admitted only on a --resume whose initiator and answering actor are the configured user actor. */
export const RELEASE_TOOLS = Object.freeze([
  "mcp__rks__rks_release",
  "mcp__rks__rks_promote",
  "mcp__rks__rks_sync_staging",
  "mcp__rks__rks_tag",
]);

/** Per-machine env key naming the owner's dispatch actor (never read from committed config; §5a). */
export const USER_ACTOR_ENV_KEY = "RKS_DISPATCH_USER_ACTOR";

/** Actor names (the --actor value and RKS_DISPATCH_USER_ACTOR) must match this. */
export const ACTOR_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The headless Dispatcher's pre-approved surface (§3; spike S3). No Edit, Write or Bash. */
export const DISPATCHER_ALLOWED_TOOLS = Object.freeze([
  "Task",
  "Skill",
  "Read",
  "Grep",
  "Glob",
  "mcp__rks",
  "mcp__rks-gov",
]);

/** Disallowed for every initiator (§3 off-rail floor; AC17). */
export const ALWAYS_DISALLOWED_TOOLS = Object.freeze(["mcp__rks__rks_guardrails_off"]);

/** Oldest target rks with rks_governor_end and the project lease (§6c; AC20). */
export const MIN_RKS_VERSION = "0.85.0";

/** A child stamp of this value was only ever a hardcoded literal: UNSTAMPED, never a real release. */
export const UNSTAMPED_RKS_VERSION = "0.1.0";

/** Passed via --json-schema; read back from structured_output on the result event (§4; spike S2). */
export const DISPATCH_RESULT_SCHEMA = Object.freeze({
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["complete", "awaiting_human", "reserved_for_user", "failed"] },
    checkpoint: { type: "object" },
    summary: { type: "string" },
  },
});

const FINAL_STATUSES = Object.freeze(["complete", "awaiting_human", "reserved_for_user", "failed"]);

/** Exit codes (documented in `routekit dispatch --help` and the routekit usage text). */
export const EXIT_CODES = Object.freeze({
  complete: 0,
  failure: 1, // every refusal and every failed / violated run
  usage: 2, // bad or missing arguments (including a missing --actor)
  awaiting: 3, // awaiting_human or awaiting_user: a K1-K5 checkpoint waits for an answer
});

/**
 * The dispatch checkpoint contract, appended to the headless Dispatcher's system prompt. A constant
 * here so it is versioned with the verb. CLAUDE.md "On Governor return" stays the source of the
 * K1-K5 set; if the two ever diverge, CLAUDE.md wins (story Out of scope).
 */
export const DISPATCH_CONTRACT = `# routekit dispatch — checkpoint contract

You are the rks Dispatcher running headless under \`routekit dispatch\`. No human is watching this
session. Follow CLAUDE.md exactly as in the IDE, with these additions.

## How every run ends
End the run with exactly ONE structured result (the --json-schema output):
  { "status": "complete" | "awaiting_human" | "reserved_for_user" | "failed",
    "checkpoint": { "id", "kind", "storyIds", "question", "options", "recommendation" },
    "summary": "..." }
"checkpoint" is required when, and only when, status is "awaiting_human".

## The only checkpoints (K1-K5)
Stop with status "awaiting_human" ONLY at these CLAUDE.md "On Governor return" waits:
  K1 po_review_confirmation          — PO Governor returned review ("Wait for confirmation.")
  K2 arch_needs_revision             — ARCH returned needs-revision ("Wait for user direction. Do NOT launch Build.")
  K3 build_decomposed_orphaned_tests — Build decomposed with orphanedTests ("Stop for user review.")
  K4 build_tests_failed              — Build failed with testsFailed ("Wait for user direction. Do NOT auto-retry")
  K5 governor_failed                 — any Governor returned failed ("wait for user direction.")
checkpoint.kind MUST be one of those five strings. Give the checkpoint a short unique id. Everything
else proceeds without a human exactly as in the IDE: QA review -> ARCH; ARCH approved -> Build;
decomposition without orphaned tests auto-proceeds.

## Lease refusals are Governor failures
A project_leased, lease_contended or lease_lost refusal from any rks tool is a Governor failure.
Raise it as K5 governor_failed and quote the refusal's holder object verbatim in checkpoint.question.
Do not retry around the lease and do not try to release another holder.

## Release is reserved
Never attempt a release, promotion, staging sync or tag. If the intent requires one, end with
status "reserved_for_user" and a summary naming what was requested.

## Off-rail is unavailable under dispatch
Guardrails-off (off-rail) work is not available in a dispatched run. If the work requires it, do not
attempt it: end with status "failed" and a summary stating that off-rail is unavailable under dispatch.

## Honesty
Report "complete" only when the requested work actually completed. A denied tool, a skipped governed
step or an unverified outcome is never "complete".`;

// ---------- small helpers ----------

function readJsonFile(p) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** Parse KEY=value lines of a .env file. Comments and blank lines are skipped; the last occurrence wins. */
function readDotenvValue(filePath, key) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let value = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    }
    value = v;
  }
  return value;
}

class DispatchConfigError extends Error {
  constructor(message) {
    super(message);
    this.reason = "invalid_dispatch_config";
  }
}

// ---------- user actor and dispatch config (§5, §5a) ----------

/**
 * Resolve the owner's dispatch actor: RKS_DISPATCH_USER_ACTOR from the process environment first,
 * else from the TARGET project's root .env, read fresh. Never read from .rks/project.json.
 * Returns the actor string, or null when absent or empty (no dispatch actor is the user).
 * Throws an Error with reason "invalid_dispatch_config" for a value failing ACTOR_PATTERN — an
 * invalid value is never silently treated as unset.
 */
export function resolveUserActor({ projectRoot, env = process.env } = {}) {
  const fromEnv = env && typeof env[USER_ACTOR_ENV_KEY] === "string" ? env[USER_ACTOR_ENV_KEY].trim() : "";
  let value = fromEnv;
  let source = "environment";
  if (!value && projectRoot) {
    const fromFile = readDotenvValue(path.join(projectRoot, ".env"), USER_ACTOR_ENV_KEY);
    value = typeof fromFile === "string" ? fromFile.trim() : "";
    source = `${path.join(projectRoot, ".env")}`;
  }
  if (!value) return null;
  if (!ACTOR_PATTERN.test(value)) {
    throw new DispatchConfigError(
      `${USER_ACTOR_ENV_KEY} from ${source} is not a valid actor name (must match ${ACTOR_PATTERN}); fix or remove it.`,
    );
  }
  return value;
}

/**
 * Validate the optional `dispatch` block of .rks/project.json. Fail closed: a malformed block is
 * never silently ignored, because a dropped reservation would let an agent answer a checkpoint the
 * owner reserved. Returns { ok: true, reservedForUser, defaulted } or { ok: false, reason, message }.
 * An absent block or reservedForUser key defaults to ["po_review_confirmation"] with defaulted: true;
 * an explicit array (including the [] opt-out) is honoured with defaulted: false.
 */
export function validateDispatchConfig(config) {
  const bad = (message) => ({ ok: false, reason: "invalid_dispatch_config", message });
  if (config === undefined || config === null) return { ok: true, reservedForUser: ["po_review_confirmation"], defaulted: true };
  if (!isPlainObject(config)) return bad("dispatch must be an object");
  if (Object.prototype.hasOwnProperty.call(config, "userActor")) {
    return bad(
      `dispatch.userActor is not allowed in committed config: the owner's actor is per-machine — set ${USER_ACTOR_ENV_KEY} in the gitignored .env (npm run setup) instead.`,
    );
  }
  const unknown = Object.keys(config).filter((k) => k !== "reservedForUser");
  if (unknown.length) return bad(`dispatch has unknown key(s): ${unknown.join(", ")} (only reservedForUser is recognised)`);
  if (config.reservedForUser === undefined) return { ok: true, reservedForUser: ["po_review_confirmation"], defaulted: true };
  if (!Array.isArray(config.reservedForUser)) return bad("dispatch.reservedForUser must be an array of checkpoint kinds");
  for (const entry of config.reservedForUser) {
    if (typeof entry !== "string") return bad("dispatch.reservedForUser entries must be strings");
    if (!CHECKPOINT_KINDS.includes(entry)) {
      return bad(`dispatch.reservedForUser has unknown kind "${entry}" (allowed: ${CHECKPOINT_KINDS.join(", ")})`);
    }
  }
  return { ok: true, reservedForUser: [...config.reservedForUser], defaulted: false };
}

// ---------- final result (§4) ----------

/**
 * Validate a final result (JSON text, or the already-parsed structured_output object) against the
 * closed K1-K5 contract. Returns { ok: true, value } or
 * { ok: false, reason: "checkpoint_contract_violation", detail, raw }.
 */
export function parseFinalResult(text) {
  const violation = (detail, raw) => ({ ok: false, reason: "checkpoint_contract_violation", detail, raw });
  let value = text;
  if (text === undefined || text === null) return violation("missing final result", null);
  if (typeof text === "string") {
    try {
      value = JSON.parse(text);
    } catch {
      return violation("final result is not valid JSON", text);
    }
  }
  if (!isPlainObject(value)) return violation("final result is not an object", value);
  if (!FINAL_STATUSES.includes(value.status)) return violation(`unknown status ${JSON.stringify(value.status)}`, value);
  if (value.summary !== undefined && typeof value.summary !== "string") return violation("summary is not a string", value);
  const out = { status: value.status, summary: typeof value.summary === "string" ? value.summary : "" };
  if (value.status === "awaiting_human") {
    const cp = value.checkpoint;
    if (!isPlainObject(cp)) return violation("awaiting_human without a checkpoint", value);
    if (!nonEmptyString(cp.id)) return violation("checkpoint has no id", value);
    if (!CHECKPOINT_KINDS.includes(cp.kind)) return violation(`checkpoint kind ${JSON.stringify(cp.kind)} is outside K1-K5`, value);
    out.checkpoint = {
      id: cp.id,
      kind: cp.kind,
      storyIds: Array.isArray(cp.storyIds) ? cp.storyIds : [],
      question: typeof cp.question === "string" ? cp.question : "",
      options: Array.isArray(cp.options) ? cp.options : [],
      recommendation: typeof cp.recommendation === "string" ? cp.recommendation : "",
    };
  }
  return { ok: true, value: out };
}

/**
 * Take the final result ONLY from structured_output of the LAST stream-json event with
 * type "result". No assistant-text fallback.
 */
export function finalResultFromEvent(resultEvent) {
  if (!resultEvent) {
    return { ok: false, reason: "checkpoint_contract_violation", detail: "no result event", raw: null };
  }
  if (resultEvent.is_error === true) {
    return {
      ok: false,
      reason: "checkpoint_contract_violation",
      detail: "result event has is_error true",
      raw: { subtype: resultEvent.subtype ?? null },
    };
  }
  if (!Object.prototype.hasOwnProperty.call(resultEvent, "structured_output") || resultEvent.structured_output == null) {
    return {
      ok: false,
      reason: "checkpoint_contract_violation",
      detail: "result event has no structured_output",
      raw: { subtype: resultEvent.subtype ?? null },
    };
  }
  return parseFinalResult(resultEvent.structured_output);
}

// ---------- version floor (§6c) ----------

/** A target whose file at this path has name @routekit/mcp-rks is an rks shell checkout (§6c). */
export const SHELL_MARKER_REL = path.join("packages", "mcp-rks", "package.json");

export function isRksShellRoot(root) {
  if (!root) return false;
  const r = readJsonFile(path.join(root, SHELL_MARKER_REL));
  return r.ok && isPlainObject(r.value) && r.value.name === "@routekit/mcp-rks";
}

function parseSemver(v) {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Resolve and judge the target's rks version. A shell checkout (recognised from the target itself,
 * never from SHELL_ROOT) is read from its root package.json; anything else from the string
 * rksVersion stamp in .rks/project.json. Every unknown fails closed.
 */
export function checkRksVersion({ projectRoot, projectId }) {
  const shell = isRksShellRoot(projectRoot);
  let rksVersion = null;
  let rksVersionSource;
  if (shell) {
    rksVersionSource = "shell_package_json";
    const v = readRksVersion(projectRoot);
    rksVersion = typeof v === "string" ? v : null;
  } else {
    rksVersionSource = "stamp";
    const r = readJsonFile(path.join(projectRoot, ".rks", "project.json"));
    if (r.ok && isPlainObject(r.value) && typeof r.value.rksVersion === "string") rksVersion = r.value.rksVersion;
  }
  const parsed = parseSemver(rksVersion);
  const supported =
    parsed !== null && rksVersion !== UNSTAMPED_RKS_VERSION && cmpSemver(parsed, parseSemver(MIN_RKS_VERSION)) >= 0;
  if (supported) return { ok: true, rksVersion, rksVersionSource };
  const found = rksVersion === null ? "no readable rks version" : `rks version "${rksVersion}"`;
  const why =
    `dispatch needs rks >= ${MIN_RKS_VERSION} in the target (rks_governor_end and the project lease); ` +
    `project ${projectId} has ${found}${rksVersion === UNSTAMPED_RKS_VERSION ? " (the unstamped sentinel)" : ""}.`;
  const message = shell
    ? `${why} The target is an rks shell checkout: update the shell checkout to ${MIN_RKS_VERSION} or later (git pull, or check out a newer release).`
    : `${why} Upgrade it: routekit project upgrade --id ${projectId} --from-release <path-to-rks-release>`;
  return {
    ok: false,
    reason: "rks_version_unsupported",
    rksVersion,
    rksVersionSource,
    minRksVersion: MIN_RKS_VERSION,
    message,
  };
}

// ---------- telemetry (AC21) ----------

/**
 * Default sink (AC21): lazily imports createTelemetryStorage + createEvent and awaits write([event])
 * under root (the target root once resolved, else shellRoot). Returns an async emitter
 * (type, payload, { projectId, runId }) => void. Callers wrap it in try/catch: best-effort.
 */
export function createDefaultTelemetryEmitter({ targetRoot = null, shellRoot } = {}) {
  return async (type, payload, { projectId = null, runId = null } = {}) => {
    const root = targetRoot || shellRoot;
    if (!root) return;
    const { createTelemetryStorage } = await import("../../../telemetry/src/storage.mjs");
    const { createEvent } = await import("../../../telemetry/src/types.mjs");
    await createTelemetryStorage(root).write([createEvent(type, projectId, payload, { runId })]);
  };
}

// ---------- run record (§6) ----------

export function runRecordPath(projectRoot, runId) {
  return path.join(projectRoot, ".rks", "session", "dispatch", `${runId}.json`);
}

export function newRunId() {
  return crypto.randomUUID();
}

function writeRunRecord(projectRoot, record) {
  const p = runRecordPath(projectRoot, record.runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + "\n");
}

// ---------- spawn construction (§3) ----------

/** The disallow list for a spawn: the off-rail floor always, the release family unless releaseAllowed. */
export function disallowedToolsFor({ releaseAllowed }) {
  return [...ALWAYS_DISALLOWED_TOOLS, ...(releaseAllowed ? [] : RELEASE_TOOLS)];
}

export function buildClaudeArgs({ prompt, resumeSessionId = null, releaseAllowed }) {
  // The prompt sits directly after -p, ahead of the variadic tool-list options, so they cannot
  // swallow it.
  const args = ["-p", prompt];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(DISPATCH_RESULT_SCHEMA),
    "--append-system-prompt",
    DISPATCH_CONTRACT,
    "--allowedTools",
    DISPATCHER_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    disallowedToolsFor({ releaseAllowed }).join(","),
  );
  return args;
}

/** The caller's environment, unchanged, plus exactly the three run variables (§3, §6b). */
export function buildSpawnEnv(parentEnv, { runId, actor }) {
  return { ...parentEnv, RKS_DISPATCH_RUN_ID: runId, RKS_ACTOR: actor, RKS_VIA: "dispatch" };
}

// ---------- defaults for injectable dependencies ----------

async function defaultGetProject(projectId, SHELL_ROOT) {
  const { getProjectById } = await import("../project/index.js");
  return getProjectById(projectId, SHELL_ROOT);
}

async function defaultListProjects(SHELL_ROOT) {
  const { loadProjects } = await import("../project/index.js");
  return loadProjects(SHELL_ROOT);
}

async function defaultResolveCredential({ projectRoot, env }) {
  const { resolveInitCredential } = await import("../../../mcp-rks/src/llm/claude-cli/subscription-status.mjs");
  return resolveInitCredential({ projectRoot, env });
}

function defaultFindClaude(env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

// ---------- argument parsing ----------

const VALUE_OPTIONS = new Set(["project", "actor", "resume", "answer"]);
const FLAG_OPTIONS = new Set(["json", "help"]);

export function parseDispatchArgs(args = []) {
  const parts = args[0] === "dispatch" ? args.slice(1) : args.slice();
  const opts = {};
  const positionals = [];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (a === "-h") {
      opts.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (FLAG_OPTIONS.has(key)) {
      if (eq !== -1) throw new Error(`--${key} takes no value`);
      opts[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new Error(`unknown option: --${key}`);
    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = parts[i + 1];
      i += 1;
    }
    if (value === undefined || value === "") throw new Error(`--${key} needs a value`);
    opts[key] = value;
  }
  opts.text = positionals.join(" ").trim();
  return opts;
}

export const DISPATCH_USAGE = `Usage:
  routekit dispatch --project <id> --actor <name> [--json] "<intent>"
  routekit dispatch --resume <runId> --answer <checkpointId> --actor <name> [--project <id>] [--json] "<direction>"

  Runs the project's real Dispatcher as headless Claude Code (claude -p, no --bare) in the registered
  project root, so its hooks, CLAUDE.md, skills and .mcp.json apply. Stream-json events are relayed to
  stdout (unless --json), then exactly one final JSON result object is printed. Non-JSON output and
  claude's stderr go to stderr. A run stops only at the K1-K5 checkpoints (po_review_confirmation,
  arch_needs_revision, build_decomposed_orphaned_tests, build_tests_failed, governor_failed).

  --actor is required on every invocation. Checkpoint kinds listed in .rks/project.json
  dispatch.reservedForUser belong to the user actor. When dispatch.reservedForUser is absent, or the
  project has no dispatch block, po_review_confirmation is reserved for the user by default; an
  explicit empty list ("reservedForUser": []) is the opt-out that lets the initiator answer it. The
  user actor is RKS_DISPATCH_USER_ACTOR from the environment,
  else the target project's .env (npm run setup provisions it). Without it no dispatch actor is the
  user. A non-reserved checkpoint is answered by the run's initiator. Release tools are never admitted
  on a fresh run, whatever --actor is; they are admitted only on a --resume whose run initiator and
  answering --actor are both the user actor.

  Credential: dispatch requires one (keyless projects use the deterministic \`routekit call\` lane).
  A dispatched run authenticates with whatever credential Claude Code resolves from the caller's
  environment; an exported ANTHROPIC_API_KEY takes precedence over a claude.ai login. The result's
  admissionCredential (api | subscription) is the credential rks found in the caller's environment at
  admission, not an observation of how Claude Code authenticated.

  Exit codes: 0 complete; 1 refused or failed (incl. checkpoint_contract_violation, permission_denied,
  reserved_for_user); 2 usage error (e.g. missing --actor); 3 awaiting_human / awaiting_user.`;

// ---------- the runner ----------

function makeWriter(stream) {
  return (text) => {
    stream.write(text);
  };
}

/**
 * Feed a spawned child's output: each stdout line is one stream-json event (relayed to stdout unless
 * json mode); non-JSON stdout lines and all stderr go to stderr and are never parsed as the result.
 */
function consumeChild(child, { relay, writeOut, writeErr }) {
  const state = { lastResult: null, initSessionId: null, anySessionId: null, permissionDenied: 0 };
  const handleLine = (line) => {
    if (line.trim() === "") return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      event = undefined;
    }
    if (!isPlainObject(event)) {
      writeErr(line.endsWith("\n") ? line : line + "\n");
      return;
    }
    if (relay) writeOut(line + "\n");
    if (line.includes("permission_denied")) state.permissionDenied += 1;
    if (typeof event.session_id === "string" && event.session_id) {
      if (!state.anySessionId) state.anySessionId = event.session_id;
      if (!state.initSessionId && (event.subtype === "init" || event.type === "system")) state.initSessionId = event.session_id;
    }
    if (event.type === "result") state.lastResult = event;
  };

  return new Promise((resolve) => {
    let buffer = "";
    let stdoutDone = !child.stdout;
    let exited = false;
    let exitCode = null;
    let spawnError = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      if (spawnError || (stdoutDone && exited)) {
        settled = true;
        resolve({ ...state, exitCode, spawnError });
      }
    };
    if (child.stdout) {
      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      });
      const endStdout = () => {
        if (stdoutDone) return;
        if (buffer) handleLine(buffer.replace(/\r$/, ""));
        buffer = "";
        stdoutDone = true;
        finish();
      };
      child.stdout.on("end", endStdout);
      child.stdout.on("close", endStdout);
    }
    if (child.stderr) {
      child.stderr.setEncoding?.("utf8");
      child.stderr.on("data", (chunk) => writeErr(String(chunk)));
    }
    child.on("error", (err) => {
      spawnError = err;
      finish();
    });
    child.on("close", (code) => {
      exited = true;
      exitCode = code;
      finish();
    });
  });
}

/**
 * Entry point. DI contract follows handleCallCommand: every side-effecting dependency is injectable
 * (spawn, getProject, listProjects, resolveCredential, findClaude, telemetry, env, stdout, stderr,
 * newRunId, now) and defaults to the real implementation. Never calls process.exit; returns
 * { result, exitCode } and routekit.js exits with exitCode.
 */
export async function handleDispatchCommand({ args = [], kv = {}, SHELL_ROOT } = {}, deps = {}) {
  void kv; // routekit.js's generic kv cannot parse a trailing positional intent; args are parsed here.
  const spawnFn = deps.spawn || nodeSpawn;
  const getProject = deps.getProject || defaultGetProject;
  const listProjects = deps.listProjects || defaultListProjects;
  const resolveCredential = deps.resolveCredential || defaultResolveCredential;
  const parentEnv = deps.env || process.env;
  const findClaude = deps.findClaude || (() => defaultFindClaude(parentEnv));
  const writeOut = deps.stdout || makeWriter(process.stdout);
  const writeErr = deps.stderr || makeWriter(process.stderr);
  const makeRunId = deps.newRunId || newRunId;
  const now = deps.now || (() => new Date().toISOString());

  // Telemetry context: root is SHELL_ROOT until the target root is resolved.
  const tctx = { targetRoot: null, projectId: null, runId: null };
  const emit = async (type, payload) => {
    try {
      const emitter =
        deps.telemetry || createDefaultTelemetryEmitter({ targetRoot: tctx.targetRoot, shellRoot: SHELL_ROOT });
      await emitter(type, payload, { projectId: tctx.projectId, runId: tctx.runId, root: tctx.targetRoot || SHELL_ROOT });
    } catch {
      // best-effort: telemetry never changes the result or the exit code
    }
  };

  let jsonMode = false;
  const done = (result, exitCode) => {
    writeOut(JSON.stringify(result) + "\n");
    return { result, exitCode };
  };
  const refuse = async (reason, extra = {}, exitCode = EXIT_CODES.failure) => {
    await emit("dispatch.refused", { projectId: tctx.projectId, reason });
    return done({ ok: false, reason, ...extra }, exitCode);
  };

  let opts;
  try {
    opts = parseDispatchArgs(args);
  } catch (err) {
    writeErr(`routekit dispatch: ${err?.message || err}\n${DISPATCH_USAGE}\n`);
    return done({ ok: false, reason: "usage", message: err?.message || String(err) }, EXIT_CODES.usage);
  }
  jsonMode = opts.json === true;
  if (opts.help) {
    writeOut(DISPATCH_USAGE + "\n");
    return { result: null, exitCode: EXIT_CODES.complete };
  }

  const resumeMode = opts.resume !== undefined || opts.answer !== undefined;
  if (opts.project) tctx.projectId = opts.project;

  if (!opts.actor) {
    writeErr(`routekit dispatch: --actor <name> is required\n`);
    return refuse("actor_required", { message: "--actor <name> is required on every invocation" }, EXIT_CODES.usage);
  }
  if (!ACTOR_PATTERN.test(opts.actor)) {
    return refuse("invalid_actor", { message: `--actor must match ${ACTOR_PATTERN}` }, EXIT_CODES.usage);
  }
  const actor = opts.actor;

  if (resumeMode) {
    if (!opts.resume || !opts.answer) {
      return refuse("usage", { message: "--resume <runId> and --answer <checkpointId> go together" }, EXIT_CODES.usage);
    }
    if (!opts.text) return refuse("usage", { message: "a direction (the answer text) is required" }, EXIT_CODES.usage);
  } else {
    if (!opts.project) return refuse("usage", { message: "--project <id> is required" }, EXIT_CODES.usage);
    if (!opts.text) return refuse("usage", { message: "an intent is required" }, EXIT_CODES.usage);
  }

  // ----- locate the target -----
  let projectId = opts.project || null;
  let projectRoot = null;
  let record = null;

  const resolveRoot = async (id) => {
    let rec = null;
    try {
      rec = await getProject(id, SHELL_ROOT);
    } catch {
      rec = null;
    }
    const root = rec && (rec.root || rec.path);
    if (!root || !fs.existsSync(root)) return null;
    return path.resolve(root);
  };

  if (resumeMode) {
    const runId = opts.resume;
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) return refuse("run_not_found", { runId, message: "invalid runId" });
    tctx.runId = runId;
    if (projectId) {
      projectRoot = await resolveRoot(projectId);
      if (!projectRoot) {
        return refuse("project_not_registered", { projectId, message: `project ${projectId} is not registered or its root is missing` });
      }
    } else {
      let projects = [];
      try {
        projects = (await listProjects(SHELL_ROOT)) || [];
      } catch {
        projects = [];
      }
      for (const p of projects) {
        const root = p && (p.root || p.path);
        if (root && fs.existsSync(runRecordPath(root, runId))) {
          projectId = p.id;
          projectRoot = await resolveRoot(p.id);
          break;
        }
      }
      tctx.projectId = projectId;
      if (!projectId) return refuse("run_not_found", { runId, message: `no registered project holds dispatch run ${runId}` });
      if (!projectRoot) {
        return refuse("project_not_registered", { projectId, message: `project ${projectId} is not registered or its root is missing` });
      }
    }
    tctx.projectId = projectId;
    tctx.targetRoot = projectRoot;
    const r = readJsonFile(runRecordPath(projectRoot, runId));
    if (!r.ok || !isPlainObject(r.value)) return refuse("run_not_found", { runId, projectId, message: `no dispatch run ${runId} in ${projectId}` });
    record = r.value;
    if (record.projectId && record.projectId !== projectId) {
      return refuse("run_not_found", { runId, projectId, message: `run ${runId} belongs to ${record.projectId}` });
    }
  } else {
    projectRoot = await resolveRoot(projectId);
    if (!projectRoot) {
      return refuse("project_not_registered", { projectId, message: `project ${projectId} is not registered or its root is missing` });
    }
    tctx.targetRoot = projectRoot;
  }

  // ----- dispatch config and user actor -----
  const projectJson = readJsonFile(path.join(projectRoot, ".rks", "project.json"));
  const cfg = validateDispatchConfig(projectJson.ok && isPlainObject(projectJson.value) ? projectJson.value.dispatch : undefined);
  let userActor = null;
  const configCheck = () => {
    if (!cfg.ok) return { ok: false, message: cfg.message };
    try {
      userActor = resolveUserActor({ projectRoot, env: parentEnv });
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
    return { ok: true };
  };

  // ----- admission (all before any spawn) -----
  const admitCredentialClaudeVersion = async () => {
    let cred;
    try {
      cred = await resolveCredential({ projectRoot, env: parentEnv });
    } catch {
      cred = { credential: "none" };
    }
    const credential = cred && cred.credential;
    if (credential !== "api" && credential !== "subscription") {
      return {
        refusal: [
          "credential_required",
          {
            projectId,
            message:
              "routekit dispatch runs headless Claude Code and requires a credential (an API key, or an opted-in claude.ai subscription). " +
              "Keyless projects use the deterministic `routekit call` lane instead.",
          },
        ],
      };
    }
    let claudePath = null;
    try {
      claudePath = await findClaude();
    } catch {
      claudePath = null;
    }
    if (!claudePath) {
      return { refusal: ["claude_cli_unavailable", { projectId, message: "the claude CLI was not found on PATH" }] };
    }
    const version = checkRksVersion({ projectRoot, projectId });
    if (!version.ok) {
      const { ok: _ok, reason, ...rest } = version;
      return { refusal: [reason, { projectId, ...rest }] };
    }
    return { admissionCredential: credential, rksVersion: version.rksVersion, rksVersionSource: version.rksVersionSource };
  };

  let admission;
  let runId;
  let prompt;
  let resumeSessionId = null;
  let initiator;
  let releaseAllowed;

  if (resumeMode) {
    const c = configCheck();
    if (!c.ok) return refuse("invalid_dispatch_config", { projectId, message: c.message });
    runId = record.runId || opts.resume;
    initiator = record.initiator;
    const checkpoints = Array.isArray(record.checkpoints) ? record.checkpoints : [];
    const open = [...checkpoints].reverse().find((cp) => cp && !cp.answeredAt);
    if (!open || open.id !== opts.answer || !String(record.status || "").startsWith("awaiting")) {
      return refuse("checkpoint_not_open", {
        runId,
        projectId,
        checkpointId: opts.answer,
        openCheckpointId: open ? open.id : null,
        message: open ? `the open checkpoint of run ${runId} is ${open.id}` : `run ${runId} has no open checkpoint`,
      });
    }
    const reserved = open.reserved === true || cfg.reservedForUser.includes(open.kind);
    if (reserved) {
      if (!userActor || actor !== userActor) {
        return refuse("reserved_for_user", {
          runId,
          projectId,
          checkpointId: open.id,
          kind: open.kind,
          message: userActor
            ? `checkpoint kind ${open.kind} is reserved for the user actor`
            : `checkpoint kind ${open.kind} is reserved for the user and no ${USER_ACTOR_ENV_KEY} is configured; answer it outside dispatch`,
        });
      }
    } else if (actor !== initiator) {
      return refuse("answerer_not_initiator", {
        runId,
        projectId,
        checkpointId: open.id,
        kind: open.kind,
        message: `only the run's initiator (${initiator}) answers a non-reserved checkpoint`,
      });
    }
    if (!nonEmptyString(record.claudeSessionId)) {
      return refuse("claude_session_unknown", { runId, projectId, message: "the run record has no claudeSessionId to resume" });
    }
    admission = await admitCredentialClaudeVersion();
    if (admission.refusal) return refuse(admission.refusal[0], { runId, ...admission.refusal[1] });

    // Record the answer only now that every admission check passed.
    open.answeredBy = actor;
    open.answeredVia = "dispatch";
    open.answeredAt = now();
    open.answer = opts.text;
    record.status = "running";
    record.updatedAt = now();
    try {
      writeRunRecord(projectRoot, record);
    } catch (err) {
      return refuse("run_record_unwritable", { runId, projectId, message: err?.message || String(err) });
    }
    await emit("dispatch.checkpoint_answered", {
      runId,
      checkpointId: open.id,
      kind: open.kind,
      answeringActor: actor,
      via: "dispatch",
      at: open.answeredAt,
    });
    prompt = opts.text;
    resumeSessionId = record.claudeSessionId;
    // Release stays reserved unless both the run's initiator and the answering actor are the user.
    releaseAllowed = Boolean(userActor) && initiator === userActor && actor === userActor;
  } else {
    admission = await admitCredentialClaudeVersion();
    if (admission.refusal) return refuse(admission.refusal[0], admission.refusal[1]);
    const c = configCheck();
    if (!c.ok) return refuse("invalid_dispatch_config", { projectId, message: c.message });
    runId = makeRunId();
    tctx.runId = runId;
    initiator = actor;
    prompt = opts.text;
    // A fresh run never admits release tools: --actor is self-reported. Release is resume-only.
    releaseAllowed = false;
    record = {
      runId,
      projectId,
      initiator,
      claudeSessionId: null,
      status: "running",
      startedAt: now(),
      updatedAt: null,
      admissionCredential: admission.admissionCredential,
      rksVersion: admission.rksVersion,
      rksVersionSource: admission.rksVersionSource,
      permissionDenied: 0,
      checkpoints: [],
    };
    try {
      writeRunRecord(projectRoot, record);
    } catch (err) {
      return refuse("run_record_unwritable", { runId, projectId, message: err?.message || String(err) });
    }
    await emit("dispatch.started", {
      reservedForUser: [...cfg.reservedForUser],
      reservedDefaulted: cfg.defaulted === true,
      runId,
      projectId,
      initiator,
      admissionCredential: admission.admissionCredential,
      rksVersion: admission.rksVersion,
      rksVersionSource: admission.rksVersionSource,
    });
  }

  // ----- spawn -----
  const claudeArgs = buildClaudeArgs({ prompt, resumeSessionId, releaseAllowed });
  // Resumed segments keep the run's attribution: RKS_ACTOR is the initiator, the answer is recorded
  // in the run record as answeredBy.
  const spawnEnv = buildSpawnEnv(parentEnv, { runId, actor: initiator });
  let child;
  let outcome;
  try {
    child = spawnFn("claude", claudeArgs, { cwd: projectRoot, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });
    outcome = await consumeChild(child, { relay: !jsonMode, writeOut, writeErr });
  } catch (err) {
    outcome = { spawnError: err, lastResult: null, permissionDenied: 0, initSessionId: null, anySessionId: null, exitCode: null };
  }

  const sessionId = outcome.initSessionId || outcome.anySessionId || null;
  if (!record.claudeSessionId && sessionId) record.claudeSessionId = sessionId;
  record.permissionDenied = (Number(record.permissionDenied) || 0) + outcome.permissionDenied;
  const base = {
    runId,
    projectId,
    initiator,
    admissionCredential: admission.admissionCredential,
    rksVersion: admission.rksVersion,
    rksVersionSource: admission.rksVersionSource,
    claudeSessionId: record.claudeSessionId,
    permissionDenied: record.permissionDenied,
  };

  let result;
  let exitCode;
  if (outcome.spawnError) {
    result = { ok: false, reason: "claude_spawn_failed", ...base, message: outcome.spawnError?.message || String(outcome.spawnError) };
    exitCode = EXIT_CODES.failure;
    record.status = "failed";
  } else {
    const final = finalResultFromEvent(outcome.lastResult);
    if (!final.ok) {
      result = { ok: false, reason: "checkpoint_contract_violation", ...base, detail: final.detail, raw: final.raw };
      exitCode = EXIT_CODES.failure;
      record.status = "checkpoint_contract_violation";
    } else {
      const v = final.value;
      if (v.status === "complete") {
        if (outcome.exitCode !== 0) {
          result = {
            ok: false,
            reason: "checkpoint_contract_violation",
            ...base,
            detail: `claude exited ${outcome.exitCode} after reporting complete`,
            raw: { childExitCode: outcome.exitCode },
          };
          exitCode = EXIT_CODES.failure;
          record.status = "checkpoint_contract_violation";
        } else if (record.permissionDenied > 0) {
          result = { ok: false, reason: "permission_denied", ...base, summary: v.summary };
          exitCode = EXIT_CODES.failure;
          record.status = "permission_denied";
        } else {
          result = { ok: true, status: "complete", ...base, summary: v.summary };
          exitCode = EXIT_CODES.complete;
          record.status = "complete";
        }
      } else if (v.status === "awaiting_human") {
        const cp = v.checkpoint;
        const reserved = cfg.reservedForUser.includes(cp.kind);
        const status = reserved && (!userActor || initiator !== userActor) ? "awaiting_user" : "awaiting_human";
        const entry = {
          ...cp,
          raisedAt: now(),
          reserved,
          answeredBy: null,
          answeredVia: null,
          answeredAt: null,
          answer: null,
        };
        record.checkpoints = [...(Array.isArray(record.checkpoints) ? record.checkpoints : []), entry];
        record.status = status;
        result = { ok: false, status, reason: status, ...base, checkpoint: { ...cp, reserved }, summary: v.summary };
        exitCode = EXIT_CODES.awaiting;
      } else if (v.status === "reserved_for_user") {
        result = { ok: false, reason: "reserved_for_user", intent: "release", ...base, summary: v.summary };
        exitCode = EXIT_CODES.failure;
        record.status = "reserved_for_user";
      } else {
        result = { ok: false, status: "failed", reason: "run_failed", ...base, summary: v.summary };
        exitCode = EXIT_CODES.failure;
        record.status = "failed";
      }
    }
  }

  record.updatedAt = now();
  try {
    writeRunRecord(projectRoot, record);
  } catch (err) {
    writeErr(`routekit dispatch: could not write run record: ${err?.message || err}\n`);
  }
  if (result.status === "awaiting_human" || result.status === "awaiting_user") {
    await emit("dispatch.checkpoint_raised", {
      runId,
      checkpointId: result.checkpoint.id,
      kind: result.checkpoint.kind,
      reserved: result.checkpoint.reserved,
    });
  }
  if (outcome.permissionDenied > 0) {
    await emit("dispatch.permission_denied", { runId, count: outcome.permissionDenied });
  }
  await emit("dispatch.completed", { runId, status: result.status || result.reason });
  return done(result, exitCode);
}
