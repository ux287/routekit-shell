// routekit dispatch --project <id> --actor <name> [--json] [--detach] "<intent>"
// routekit dispatch --resume <runId> --answer <checkpointId> --actor <name> [--project <id>] [--json] [--detach] "<direction>"
// routekit dispatch --status <runId> --project <id> --actor <name> [--json]
//
// backlog.feat.dispatch-detach-status: --detach hands the admitted segment to a detached background
// worker (a hidden re-entry of this verb) through a one-shot handoff file; --status is a read-only
// projection of the run record. Every record write is temp-file-plus-rename.
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
import { fileURLToPath } from "node:url";
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

/**
 * Env key carrying the per-launch --detach worker nonce. Only the launched worker receives it (never
 * argv, stdout or the run record); the handoff stores only its SHA-256 digest.
 */
export const WORKER_NONCE_ENV_KEY = "RKS_DISPATCH_WORKER_NONCE";

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

/** A per-launch worker nonce (32 random bytes, lowercase hex). */
function newWorkerNonce() {
  return crypto.randomBytes(32).toString("hex");
}

/** A worker nonce and its SHA-256 digest are both exactly 64 lowercase hex characters. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const isSha256Hex = (v) => typeof v === "string" && SHA256_HEX_PATTERN.test(v);

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Constant-time comparison of two well-formed 64-char hex digests. */
function digestsEqual(a, b) {
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** A runId must match this before any record, handoff or log path is built from it. */
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function dispatchDir(projectRoot) {
  return path.join(projectRoot, ".rks", "session", "dispatch");
}

/** The one-shot handoff from a --detach foreground to its worker. */
export function handoffPath(projectRoot, runId) {
  return path.join(dispatchDir(projectRoot), `${runId}.handoff.json`);
}

/** One parsed stream-json event per line, appended in arrival order (blocking and detached runs). */
export function eventsLogPath(projectRoot, runId) {
  return path.join(dispatchDir(projectRoot), `${runId}.events.jsonl`);
}

/** The detached worker's stdout/stderr (never connected to the caller). */
export function workerLogPath(projectRoot, runId) {
  return path.join(dispatchDir(projectRoot), `${runId}.worker.log`);
}

/**
 * Write JSON to a temp file in the same directory, then renameSync it onto p. A concurrent reader sees
 * the previous complete file or the new complete file, never a partial one. On failure the temp file
 * is removed and the error rethrown.
 */
function writeJsonAtomic(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmpPath = `${p}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmpPath, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    throw err;
  }
}

function writeRunRecord(projectRoot, record) {
  writeJsonAtomic(runRecordPath(projectRoot, record.runId), record);
}

/**
 * The one reader of an existing run record. Write-free; each caller maps `kind` (missing, unreadable,
 * foreign) to its own refusal. A foreign result carries the parsed record.
 */
function loadRunRecord(projectRoot, runId, projectId) {
  const rp = runRecordPath(projectRoot, runId);
  if (!fs.existsSync(rp)) return { ok: false, kind: "missing", message: `no dispatch run ${runId} in ${projectId}` };
  const r = readJsonFile(rp);
  if (!r.ok) return { ok: false, kind: "unreadable", message: r.error };
  if (!isPlainObject(r.value)) return { ok: false, kind: "unreadable", message: `run record ${runId} does not parse as a JSON object` };
  const record = r.value;
  if (record.projectId && record.projectId !== projectId) {
    return { ok: false, kind: "foreign", record, message: `run ${runId} belongs to ${record.projectId}` };
  }
  return { ok: true, record };
}

/**
 * The one writer of a run-record status transition: status, summary, result and failureReason move
 * together, so a record never describes one segment's status with another segment's answer. Returns
 * the write outcome; each caller decides what a failed write means.
 */
function writeRunTransition(projectRoot, record, { status, summary = null, result = null, failureReason, now }) {
  record.status = status;
  record.summary = summary;
  record.result = result;
  if (failureReason === undefined) delete record.failureReason;
  else record.failureReason = failureReason;
  record.updatedAt = now();
  try {
    writeRunRecord(projectRoot, record);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** The stored result of a run that ended in a refusal-class failure (failureReason === reason). */
function failureResult({ reason, runId, projectId, initiator, message }) {
  return { ok: false, status: "failed", reason, runId, projectId, initiator: initiator ?? null, message };
}

/** The message a failed run-record write reports: on stderr and as recordWriteError. */
function writeErrorMessage(error) {
  return error?.message || String(error);
}

/**
 * Default liveness probe for --status: process.kill(pid, 0). Success -> true; ESRCH -> false; EPERM ->
 * true (the process exists but belongs to another user); any other error -> false. This is a
 * pid-occupancy probe: true means some process holds pid, not that it is this run's worker.
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

function defaultWorkerEntry() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "routekit.js");
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

/**
 * The caller's environment, unchanged, plus exactly the three run variables (§3, §6b). The --detach
 * worker nonce is removed so it never reaches a claude child.
 */
export function buildSpawnEnv(parentEnv, { runId, actor }) {
  const env = { ...parentEnv, RKS_DISPATCH_RUN_ID: runId, RKS_ACTOR: actor, RKS_VIA: "dispatch" };
  delete env[WORKER_NONCE_ENV_KEY];
  return env;
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

const VALUE_OPTIONS = new Set(["project", "actor", "resume", "answer", "status", "_worker"]);
const FLAG_OPTIONS = new Set(["json", "help", "detach"]);

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
  routekit dispatch --project <id> --actor <name> [--json] [--detach] "<intent>"
  routekit dispatch --resume <runId> --answer <checkpointId> --actor <name> [--project <id>] [--json] [--detach] "<direction>"
  routekit dispatch --status <runId> --project <id> --actor <name> [--json]

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
  reserved_for_user); 2 usage error (e.g. missing --actor); 3 awaiting_human / awaiting_user.

  --detach: after the same admission as a blocking run, a detached background worker (stdio not
  connected to the caller) owns the claude run and finalizes the run record. --detach exits 0 once the worker is launched,
  printing one JSON line { ok, status: "running", detached: true, runId, projectId, initiator, workerPid };
  a launch that cannot be confirmed is refused worker_spawn_failed (exit 1).
  --status: a read-only projection of the run record (status, openCheckpoint, summary, result,
  eventCount, lastEventAt, workerAlive, handoffPending); no spawn, no write. --status exits 0 when the record is found,
  whatever the run's state; 1 run_not_found / run_record_unreadable / project_not_registered.
  workerAlive is a pid-occupancy probe of the worker's recorded pid: false means no process holds it;
  true means some process does, not proof that it is this run's worker.`;

// ---------- the runner ----------

function makeWriter(stream) {
  return (text) => {
    stream.write(text);
  };
}

/**
 * Record the first tool_result block per tool_use_id from a user stream-json event, with its text
 * (string content, or the text of the first type:"text" element of array content, else "") and the
 * carrying event's tool_result_meta entry for that id (or null). Later blocks for a seen id are ignored.
 */
function collectToolResults(event, toolResults) {
  const content = event.message?.content;
  if (!Array.isArray(content)) return;
  const metaList = Array.isArray(event.tool_result_meta) ? event.tool_result_meta : [];
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== "tool_result") continue;
    const id = block.tool_use_id;
    if (!nonEmptyString(id) || toolResults.has(id)) continue;
    let text = "";
    if (typeof block.content === "string") {
      text = block.content;
    } else if (Array.isArray(block.content)) {
      const first = block.content.find((el) => isPlainObject(el) && el.type === "text");
      if (first && typeof first.text === "string") text = first.text;
    }
    const meta = metaList.find((m) => isPlainObject(m) && m.id === id) || null;
    toolResults.set(id, { text, meta });
  }
}

/**
 * Classify one permission_denials entry. "hook" needs the matching tool_result's text to START WITH
 * the Claude Code generated prefix `PreToolUse:<tool_name> hook error:` for the denial's own non-empty
 * tool_name, and, when a meta entry for the id exists, permission_decision.source === "hook". A
 * matching tool_result that fails that rule is "permission"; no tool_use_id or no match is "unclassified".
 */
function classifyDenialSource(denial, toolResults) {
  const id = denial.tool_use_id;
  if (!nonEmptyString(id) || !toolResults.has(id)) return "unclassified";
  const { text, meta } = toolResults.get(id);
  const toolName = denial.tool_name;
  if (!nonEmptyString(toolName)) return "permission";
  if (!text.startsWith(`PreToolUse:${toolName} hook error:`)) return "permission";
  if (meta && meta.permission_decision?.source !== "hook") return "permission";
  return "hook";
}

/**
 * The segment's denials, from its final result event's permission_denials array (absent or
 * non-array: none). Each entry is { tool, toolUseId, source }; tool_input is never copied.
 */
function classifyPermissionDenials(resultEvent, toolResults) {
  const list = isPlainObject(resultEvent) && Array.isArray(resultEvent.permission_denials) ? resultEvent.permission_denials : [];
  return list.map((raw) => {
    const denial = isPlainObject(raw) ? raw : {};
    return {
      tool: typeof denial.tool_name === "string" ? denial.tool_name : null,
      toolUseId: nonEmptyString(denial.tool_use_id) ? denial.tool_use_id : null,
      source: classifyDenialSource(denial, toolResults),
    };
  });
}

/** Count accumulated denials by source. */
function denialsBySource(denials) {
  const bySource = { hook: 0, permission: 0, unclassified: 0 };
  for (const d of denials) {
    if (d && Object.prototype.hasOwnProperty.call(bySource, d.source)) bySource[d.source] += 1;
    else bySource.unclassified += 1;
  }
  return bySource;
}

/**
 * Feed a spawned child's output: each stdout line is one stream-json event (relayed to stdout unless
 * json mode); non-JSON stdout lines and all stderr go to stderr and are never parsed as the result.
 */
function consumeChild(child, { relay, writeOut, writeErr, onEvent }) {
  const state = { lastResult: null, initSessionId: null, anySessionId: null, permissionDenied: 0 };
  // First tool_result block per tool_use_id, from any user event (top-level or subagent).
  const toolResults = new Map();
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
    if (event.type === "user") collectToolResults(event, toolResults);
    if (typeof event.session_id === "string" && event.session_id) {
      if (!state.anySessionId) state.anySessionId = event.session_id;
      if (!state.initSessionId && (event.subtype === "init" || event.type === "system")) state.initSessionId = event.session_id;
    }
    if (event.type === "result") state.lastResult = event;
    if (onEvent) onEvent(event, line);
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
        const permissionDenials = classifyPermissionDenials(state.lastResult, toolResults);
        resolve({ ...state, permissionDenied: permissionDenials.length, permissionDenials, exitCode, spawnError });
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

/** Resolve every injectable dependency once; handleDispatchCommand and runDispatchWorker share it. */
function resolveDispatchDeps(deps = {}) {
  const parentEnv = deps.env || process.env;
  return {
    spawnFn: deps.spawn || nodeSpawn,
    getProject: deps.getProject || defaultGetProject,
    listProjects: deps.listProjects || defaultListProjects,
    resolveCredential: deps.resolveCredential || defaultResolveCredential,
    parentEnv,
    findClaude: deps.findClaude || (() => defaultFindClaude(parentEnv)),
    writeOut: deps.stdout || makeWriter(process.stdout),
    writeErr: deps.stderr || makeWriter(process.stderr),
    makeRunId: deps.newRunId || newRunId,
    makeWorkerNonce: deps.newWorkerNonce || newWorkerNonce,
    now: deps.now || (() => new Date().toISOString()),
    probeAlive: deps.isProcessAlive || isProcessAlive,
    pid: deps.pid !== undefined ? deps.pid : process.pid,
    workerEntry: deps.workerEntry || defaultWorkerEntry(),
  };
}

/** Best-effort telemetry emitter bound to a mutable context (root is SHELL_ROOT until the target root is resolved). */
function makeEmit(deps, tctx, SHELL_ROOT) {
  return async (type, payload) => {
    try {
      const emitter =
        deps.telemetry || createDefaultTelemetryEmitter({ targetRoot: tctx.targetRoot, shellRoot: SHELL_ROOT });
      await emitter(type, payload, { projectId: tctx.projectId, runId: tctx.runId, root: tctx.targetRoot || SHELL_ROOT });
    } catch {
      // best-effort: telemetry never changes the result or the exit code
    }
  };
}

/** The final-JSON printer and the refusal helper every entry point uses. */
function makeResponders(writeOut, emit, tctx) {
  const done = (result, exitCode) => {
    writeOut(JSON.stringify(result) + "\n");
    return { result, exitCode };
  };
  const refuse = async (reason, extra = {}, exitCode = EXIT_CODES.failure) => {
    await emit("dispatch.refused", { projectId: tctx.projectId, reason });
    return done({ ok: false, reason, ...extra }, exitCode);
  };
  return { done, refuse };
}

async function resolveProjectRoot(getProject, id, SHELL_ROOT) {
  let rec = null;
  try {
    rec = await getProject(id, SHELL_ROOT);
  } catch {
    rec = null;
  }
  const root = rec && (rec.root || rec.path);
  if (!root || !fs.existsSync(root)) return null;
  return path.resolve(root);
}

/**
 * The shared claude segment: spawn, consume, finalize the record, emit telemetry. A blocking run and
 * the detached worker both run exactly this. Every foreground-decided value arrives as an argument
 * (prompt, resumeSessionId, releaseAllowed, initiator, admission, reservedForUser, userActor); nothing
 * here re-resolves them. Returns { result, exitCode } without printing.
 */
async function runClaudeSegment(c) {
  const { spawnFn, projectRoot, parentEnv, record, runId, projectId, initiator, prompt, resumeSessionId, releaseAllowed } = c;
  const { admission, reservedForUser, userActor, relay, writeOut, writeErr, now, emit } = c;

  const claudeArgs = buildClaudeArgs({ prompt, resumeSessionId, releaseAllowed });
  // Resumed segments keep the run's attribution: RKS_ACTOR is the initiator, the answer is recorded
  // in the run record as answeredBy.
  const spawnEnv = buildSpawnEnv(parentEnv, { runId, actor: initiator });

  // Progress persistence: every parsed stream-json event goes to the events log, and the session id
  // is written to the record as soon as it is seen (a run killed mid-flight stays resumable).
  const logPath = eventsLogPath(projectRoot, runId);
  let logWarned = false;
  const sessionWasUnknown = !record.claudeSessionId;
  const seen = { init: null, any: null };
  const onEvent = (event, line) => {
    try {
      fs.appendFileSync(logPath, line + "\n");
    } catch (err) {
      if (!logWarned) {
        logWarned = true;
        writeErr(`routekit dispatch: could not append to events log: ${err?.message || err}\n`);
      }
    }
    if (!sessionWasUnknown || typeof event.session_id !== "string" || !event.session_id) return;
    if (!seen.any) seen.any = event.session_id;
    if (!seen.init && (event.subtype === "init" || event.type === "system")) seen.init = event.session_id;
    const candidate = seen.init || seen.any;
    if (candidate === record.claudeSessionId) return;
    record.claudeSessionId = candidate;
    record.updatedAt = now();
    try {
      writeRunRecord(projectRoot, record);
    } catch (err) {
      writeErr(`routekit dispatch: could not write run record: ${err?.message || err}\n`);
    }
  };

  let child;
  let outcome;
  try {
    child = spawnFn("claude", claudeArgs, { cwd: projectRoot, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] });
    outcome = await consumeChild(child, { relay, writeOut, writeErr, onEvent });
  } catch (err) {
    outcome = { spawnError: err, lastResult: null, permissionDenied: 0, permissionDenials: [], initSessionId: null, anySessionId: null, exitCode: null };
  }

  const sessionId = outcome.initSessionId || outcome.anySessionId || null;
  if (!record.claudeSessionId && sessionId) record.claudeSessionId = sessionId;
  const segmentDenials = Array.isArray(outcome.permissionDenials) ? outcome.permissionDenials : [];
  record.permissionDenied = (Number(record.permissionDenied) || 0) + segmentDenials.length;
  // A record written before permissionDenials existed (or a malformed one) accumulates from [].
  record.permissionDenials = [...(Array.isArray(record.permissionDenials) ? record.permissionDenials : []), ...segmentDenials];
  const base = {
    runId,
    projectId,
    initiator,
    admissionCredential: admission.admissionCredential,
    rksVersion: admission.rksVersion,
    rksVersionSource: admission.rksVersionSource,
    claudeSessionId: record.claudeSessionId,
    permissionDenied: record.permissionDenied,
    permissionDenials: record.permissionDenials,
  };

  let result;
  let exitCode;
  let terminalStatus;
  if (outcome.spawnError) {
    result = { ok: false, reason: "claude_spawn_failed", ...base, message: outcome.spawnError?.message || String(outcome.spawnError) };
    exitCode = EXIT_CODES.failure;
    terminalStatus = "failed";
  } else {
    const final = finalResultFromEvent(outcome.lastResult);
    if (!final.ok) {
      result = { ok: false, reason: "checkpoint_contract_violation", ...base, detail: final.detail, raw: final.raw };
      exitCode = EXIT_CODES.failure;
      terminalStatus = "checkpoint_contract_violation";
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
          terminalStatus = "checkpoint_contract_violation";
        } else if (record.permissionDenials.some((den) => den?.source !== "hook")) {
          // Fail closed: any accumulated permission or unclassified denial. Hook-only stays complete.
          result = { ok: false, reason: "permission_denied", ...base, summary: v.summary };
          exitCode = EXIT_CODES.failure;
          terminalStatus = "permission_denied";
        } else {
          result = { ok: true, status: "complete", ...base, summary: v.summary };
          exitCode = EXIT_CODES.complete;
          terminalStatus = "complete";
        }
      } else if (v.status === "awaiting_human") {
        const cp = v.checkpoint;
        const reserved = reservedForUser.includes(cp.kind);
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
        terminalStatus = status;
        result = { ok: false, status, reason: status, ...base, checkpoint: { ...cp, reserved }, summary: v.summary };
        exitCode = EXIT_CODES.awaiting;
      } else if (v.status === "reserved_for_user") {
        result = { ok: false, reason: "reserved_for_user", intent: "release", ...base, summary: v.summary };
        exitCode = EXIT_CODES.failure;
        terminalStatus = "reserved_for_user";
      } else {
        result = { ok: false, status: "failed", reason: "run_failed", ...base, summary: v.summary };
        exitCode = EXIT_CODES.failure;
        terminalStatus = "failed";
      }
    }
  }

  // The record stores what a blocking caller receives, so --status can return it.
  const written = writeRunTransition(projectRoot, record, {
    status: terminalStatus,
    summary: typeof result.summary === "string" ? result.summary : null,
    result,
    now,
  });
  if (!written.ok) {
    writeErr(`routekit dispatch: could not write run record: ${writeErrorMessage(written.error)}\n`);
    // The caller is told the record was not finalized; the stored object is left as it was.
    result = { ...result, recordWriteError: writeErrorMessage(written.error) };
  }
  if (result.status === "awaiting_human" || result.status === "awaiting_user") {
    await emit("dispatch.checkpoint_raised", {
      runId,
      checkpointId: result.checkpoint.id,
      kind: result.checkpoint.kind,
      reserved: result.checkpoint.reserved,
    });
  }
  if (segmentDenials.length > 0) {
    await emit("dispatch.permission_denied", { runId, count: segmentDenials.length, bySource: denialsBySource(segmentDenials) });
  }
  await emit("dispatch.completed", { runId, status: result.status || result.reason });
  return { result, exitCode };
}

/** Count the newline-terminated lines of an events log that parse as JSON; an unterminated trailing line is skipped. */
function readEventsSummary(logPath) {
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return { eventCount: 0, lastEventAt: null };
  }
  let text = "";
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    text = "";
  }
  const parts = text.split("\n");
  parts.pop(); // the segment after the last newline is unterminated (or empty)
  let eventCount = 0;
  for (const line of parts) {
    if (line.trim() === "") continue;
    try {
      JSON.parse(line);
      eventCount += 1;
    } catch {
      // unparseable line: skipped
    }
  }
  return { eventCount, lastEventAt: stat.mtime.toISOString() };
}

/** --status: a read-only projection of the run record. No spawn, no record or log write, no admission. */
async function projectRunStatus({ runId, projectId, SHELL_ROOT }, d, { done, refuse }, tctx) {
  if (!RUN_ID_PATTERN.test(runId)) return refuse("run_not_found", { runId, projectId, message: "invalid runId" });
  tctx.runId = runId;
  const projectRoot = await resolveProjectRoot(d.getProject, projectId, SHELL_ROOT);
  if (!projectRoot) {
    return refuse("project_not_registered", { projectId, message: `project ${projectId} is not registered or its root is missing` });
  }
  tctx.targetRoot = projectRoot;
  const loaded = loadRunRecord(projectRoot, runId, projectId);
  if (!loaded.ok) {
    const reason = loaded.kind === "unreadable" ? "run_record_unreadable" : "run_not_found";
    return refuse(reason, { runId, projectId, message: loaded.message });
  }
  const record = loaded.record;
  const running = record.status === "running";
  const workerPid = record.workerPid ?? null;
  const workerStartedAt = record.workerStartedAt ?? null;
  let workerAlive = null;
  if (running && Number.isInteger(workerPid) && workerPid > 0 && nonEmptyString(workerStartedAt)) {
    workerAlive = Boolean(d.probeAlive(workerPid));
  }
  const checkpoints = Array.isArray(record.checkpoints) ? record.checkpoints : [];
  const open = [...checkpoints].reverse().find((cp) => cp && !cp.answeredAt);
  const openCheckpoint = open
    ? {
        id: open.id ?? null,
        kind: open.kind ?? null,
        question: open.question ?? null,
        options: open.options ?? null,
        recommendation: open.recommendation ?? null,
        storyIds: open.storyIds ?? null,
        reserved: open.reserved === true,
      }
    : null;
  const { eventCount, lastEventAt } = readEventsSummary(eventsLogPath(projectRoot, runId));
  return done(
    {
      ok: true,
      runId,
      projectId,
      initiator: record.initiator ?? null,
      status: record.status ?? null,
      startedAt: record.startedAt ?? null,
      updatedAt: record.updatedAt ?? null,
      detached: record.detached === true,
      workerPid,
      workerStartedAt,
      workerAlive,
      handoffPending: fs.existsSync(handoffPath(projectRoot, runId)),
      claudeSessionId: record.claudeSessionId ?? null,
      permissionDenied: Number(record.permissionDenied) || 0,
      permissionDenials: Array.isArray(record.permissionDenials) ? record.permissionDenials : [],
      openCheckpoint,
      summary: running ? null : (record.summary ?? null),
      result: running ? null : (record.result ?? null),
      failureReason: record.failureReason ?? null,
      eventCount,
      lastEventAt,
    },
    EXIT_CODES.complete,
  );
}

/**
 * Entry point. DI contract follows handleCallCommand: every side-effecting dependency is injectable
 * (spawn, getProject, listProjects, resolveCredential, findClaude, telemetry, env, stdout, stderr,
 * newRunId, now, isProcessAlive, pid, workerEntry) and defaults to the real implementation. Never
 * calls process.exit; returns { result, exitCode } and routekit.js exits with exitCode.
 */
export async function handleDispatchCommand({ args = [], kv = {}, SHELL_ROOT } = {}, deps = {}) {
  void kv; // routekit.js's generic kv cannot parse a trailing positional intent; args are parsed here.
  const d = resolveDispatchDeps(deps);
  const { spawnFn, listProjects, resolveCredential, parentEnv, findClaude, writeOut, writeErr, makeRunId, now } = d;

  // Telemetry context: root is SHELL_ROOT until the target root is resolved.
  const tctx = { targetRoot: null, projectId: null, runId: null };
  const emit = makeEmit(deps, tctx, SHELL_ROOT);
  const { done, refuse } = makeResponders(writeOut, emit, tctx);

  let jsonMode = false;
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

  // Hidden re-entry of a --detach launch: the worker executes only the segment its handoff describes.
  if (opts._worker !== undefined) {
    return runDispatchWorker({ runId: opts._worker, projectId: opts.project, SHELL_ROOT }, deps);
  }

  const statusMode = opts.status !== undefined;
  const resumeMode = opts.resume !== undefined || opts.answer !== undefined;
  if (opts.project) tctx.projectId = opts.project;

  if (statusMode && (resumeMode || opts.detach || opts.text)) {
    return refuse("usage", { message: "--status <runId> takes no --resume, --answer, --detach or intent" }, EXIT_CODES.usage);
  }

  if (!opts.actor) {
    writeErr(`routekit dispatch: --actor <name> is required\n`);
    return refuse("actor_required", { message: "--actor <name> is required on every invocation" }, EXIT_CODES.usage);
  }
  if (!ACTOR_PATTERN.test(opts.actor)) {
    return refuse("invalid_actor", { message: `--actor must match ${ACTOR_PATTERN}` }, EXIT_CODES.usage);
  }
  const actor = opts.actor;

  if (statusMode) {
    if (!opts.project) return refuse("usage", { message: "--status requires --project <id>" }, EXIT_CODES.usage);
    return projectRunStatus({ runId: opts.status, projectId: opts.project, SHELL_ROOT }, d, { done, refuse }, tctx);
  }

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

  const resolveRoot = (id) => resolveProjectRoot(d.getProject, id, SHELL_ROOT);

  if (resumeMode) {
    const runId = opts.resume;
    if (!RUN_ID_PATTERN.test(runId)) return refuse("run_not_found", { runId, message: "invalid runId" });
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
    const loaded = loadRunRecord(projectRoot, runId, projectId);
    if (!loaded.ok) {
      // Resume never refuses run_record_unreadable: a missing or damaged record is "no such run".
      const message = loaded.kind === "foreign" ? loaded.message : `no dispatch run ${runId} in ${projectId}`;
      return refuse("run_not_found", { runId, projectId, message });
    }
    record = loaded.record;
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
  const detach = opts.detach === true;

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
    // The worker fields describe the current segment only: a detached segment starts with no worker
    // recorded; a blocking segment carries none of them.
    if (detach) {
      record.detached = true;
      record.workerPid = null;
      record.workerStartedAt = null;
    } else {
      delete record.detached;
      delete record.workerPid;
      delete record.workerStartedAt;
    }
    // A new segment starts with no answer of its own: the previous segment's summary, result and
    // failureReason are cleared in the same write that marks it running.
    const started = writeRunTransition(projectRoot, record, { status: "running", now });
    if (!started.ok) {
      return refuse("run_record_unwritable", { runId, projectId, message: writeErrorMessage(started.error) });
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
      permissionDenials: [],
      checkpoints: [],
      ...(detach ? { detached: true, workerPid: null } : {}),
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

  const segmentAdmission = {
    admissionCredential: admission.admissionCredential,
    rksVersion: admission.rksVersion,
    rksVersionSource: admission.rksVersionSource,
  };

  if (detach) {
    // Generated once per launch: the worker receives it by env, the handoff keeps only its digest.
    const workerNonce = d.makeWorkerNonce();
    return launchDetachedWorker({
      d,
      emit,
      done,
      refuse,
      projectRoot,
      record,
      workerNonce,
      handoff: {
        runId,
        projectId,
        prompt,
        resumeSessionId,
        releaseAllowed,
        initiator,
        userActor,
        reservedForUser: [...cfg.reservedForUser],
        admission: segmentAdmission,
        workerNonceSha256: sha256Hex(workerNonce),
        writtenAt: now(),
      },
    });
  }

  // ----- spawn (blocking) -----
  const { result, exitCode } = await runClaudeSegment({
    spawnFn,
    projectRoot,
    parentEnv,
    record,
    runId,
    projectId,
    initiator,
    prompt,
    resumeSessionId,
    releaseAllowed,
    admission: segmentAdmission,
    reservedForUser: cfg.reservedForUser,
    userActor,
    relay: !jsonMode,
    writeOut,
    writeErr,
    now,
    emit,
  });
  return done(result, exitCode);
}

/**
 * --detach: write the handoff, launch the worker and report it only once its launch is observed
 * (a spawn event before any error, and a positive-integer pid). The record was written before this
 * call (detached: true, workerPid: null); after a confirmed launch the foreground never writes it again.
 */
async function launchDetachedWorker({ d, emit, done, refuse, projectRoot, record, handoff, workerNonce }) {
  const { runId, projectId, initiator } = handoff;
  const hp = handoffPath(projectRoot, runId);

  const fail = async (failureReason, message) => {
    try {
      if (fs.existsSync(hp)) fs.unlinkSync(hp);
    } catch {
      // best-effort
    }
    const written = writeRunTransition(projectRoot, record, {
      status: "failed",
      failureReason,
      result: failureResult({ reason: failureReason, runId, projectId, initiator, message }),
      now: d.now,
    });
    const extra = {};
    if (!written.ok) {
      d.writeErr(`routekit dispatch: could not write run record: ${writeErrorMessage(written.error)}\n`);
      extra.recordWriteError = writeErrorMessage(written.error);
    }
    await emit("dispatch.completed", { runId, status: "failed" });
    return refuse(failureReason, { runId, projectId, message, ...extra });
  };

  try {
    writeJsonAtomic(hp, handoff);
  } catch (err) {
    return fail("handoff_unwritable", err?.message || String(err));
  }

  let fd = null;
  const closeFd = () => {
    if (fd === null) return;
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    fd = null;
  };

  let child;
  try {
    fd = fs.openSync(workerLogPath(projectRoot, runId), "a");
    child = d.spawnFn(
      process.execPath,
      [d.workerEntry, "dispatch", "--_worker", runId, "--project", projectId, "--actor", initiator],
      { cwd: projectRoot, env: { ...d.parentEnv, [WORKER_NONCE_ENV_KEY]: workerNonce }, detached: true, stdio: ["ignore", fd, fd] },
    );
  } catch (err) {
    closeFd();
    return fail("worker_spawn_failed", err?.message || String(err));
  }

  // Node emits exactly one of spawn / error for every spawn; the first decides.
  const launch = await new Promise((resolve) => {
    if (!child || typeof child.once !== "function") {
      resolve({ ok: false, error: new Error("spawn returned no child process") });
      return;
    }
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", (err) => resolve({ ok: false, error: err }));
  });
  if (!launch.ok) {
    closeFd();
    return fail("worker_spawn_failed", launch.error?.message || String(launch.error));
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    closeFd();
    return fail("worker_spawn_failed", `the worker launched without a positive-integer pid (${String(child.pid)})`);
  }
  child.unref();
  closeFd();
  return done({ ok: true, status: "running", detached: true, runId, projectId, initiator, workerPid: child.pid }, EXIT_CODES.complete);
}

/** Validate a claimed handoff. Returns null when valid, else why it is not. Nothing is defaulted. */
function handoffProblem(h, { runId, projectId }) {
  if (!isPlainObject(h)) return "handoff is not a JSON object";
  if (h.runId !== runId) return "handoff runId does not match";
  if (h.projectId !== projectId) return "handoff projectId does not match";
  if (!nonEmptyString(h.prompt)) return "handoff prompt is missing";
  if (h.resumeSessionId !== null && !nonEmptyString(h.resumeSessionId)) return "handoff resumeSessionId must be a non-empty string or null";
  if (typeof h.releaseAllowed !== "boolean") return "handoff releaseAllowed must be a boolean";
  if (typeof h.initiator !== "string" || !ACTOR_PATTERN.test(h.initiator)) return "handoff initiator is not a valid actor";
  if (!Object.prototype.hasOwnProperty.call(h, "userActor")) return "handoff userActor is missing";
  if (h.userActor !== null && !nonEmptyString(h.userActor)) return "handoff userActor must be a non-empty string or null";
  if (!Array.isArray(h.reservedForUser)) return "handoff reservedForUser must be an array";
  if (!h.reservedForUser.every((k) => typeof k === "string")) return "handoff reservedForUser entries must be strings";
  if (!isPlainObject(h.admission)) return "handoff admission must be an object";
  if (h.admission.admissionCredential !== "api" && h.admission.admissionCredential !== "subscription") {
    return "handoff admission.admissionCredential must be api or subscription";
  }
  if (!isSha256Hex(h.workerNonceSha256)) return "handoff workerNonceSha256 must be a 64-char lowercase hex string";
  return null;
}

/**
 * The detached worker (hidden `--_worker <runId>` re-entry). Takes the same deps as
 * handleDispatchCommand. Claims <runId>.handoff.json by rename (one-shot: of two workers exactly one
 * wins), records its own pid and start time, then runs the shared claude segment with every
 * foreground-decided value taken from the handoff and never re-resolved. Never calls process.exit.
 */
export async function runDispatchWorker({ runId, projectId, SHELL_ROOT } = {}, deps = {}) {
  const d = resolveDispatchDeps(deps);
  const tctx = { targetRoot: null, projectId: projectId || null, runId: null };
  const emit = makeEmit(deps, tctx, SHELL_ROOT);
  const { done, refuse } = makeResponders(d.writeOut, emit, tctx);

  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return refuse("handoff_not_found", { runId: runId ?? null, projectId: projectId ?? null, message: "invalid runId" });
  }
  tctx.runId = runId;
  if (!projectId) return refuse("usage", { runId, message: "--project <id> is required" }, EXIT_CODES.usage);

  // ----- worker nonce: only the launched worker holds it (by env). Checked before anything is touched. -----
  const envNonce = d.parentEnv ? d.parentEnv[WORKER_NONCE_ENV_KEY] : undefined;
  if (!isSha256Hex(envNonce)) {
    return refuse("worker_unauthorized", { runId, projectId, message: "this process is not the worker launched for this dispatch run" });
  }
  const envNonceSha256 = sha256Hex(envNonce);
  // Only a well-formed digest that differs is a mismatch; a missing or malformed one is handoff_invalid after the claim.
  const digestMismatch = (content) =>
    content.ok && isPlainObject(content.value) && isSha256Hex(content.value.workerNonceSha256) && !digestsEqual(content.value.workerNonceSha256, envNonceSha256);

  const projectRoot = await resolveProjectRoot(d.getProject, projectId, SHELL_ROOT);
  if (!projectRoot) {
    return refuse("project_not_registered", { runId, projectId, message: `project ${projectId} is not registered or its root is missing` });
  }
  tctx.targetRoot = projectRoot;
  const hp = handoffPath(projectRoot, runId);
  const unauthorizedMessage = `the worker nonce does not match the handoff for dispatch run ${runId}`;

  // ----- pre-claim check: a mismatched worker leaves the pending handoff claimable -----
  if (!fs.existsSync(hp)) {
    return refuse("handoff_not_found", { runId, projectId, message: `no pending handoff for dispatch run ${runId}` });
  }
  if (digestMismatch(readJsonFile(hp))) {
    return refuse("worker_unauthorized", { runId, projectId, message: unauthorizedMessage });
  }

  // ----- one-shot claim -----
  const claimed = path.join(dispatchDir(projectRoot), `${runId}.handoff.${d.pid}.claimed`);
  try {
    fs.renameSync(hp, claimed);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return refuse("handoff_not_found", { runId, projectId, message: `no pending handoff for dispatch run ${runId}` });
    }
    return refuse("handoff_claim_failed", { runId, projectId, message: err?.message || String(err) });
  }
  const parsed = readJsonFile(claimed);

  // ----- post-claim re-verify: the content may have been replaced between the read and the rename -----
  // A mismatched claim is put back (never deleted) and the run record is not written.
  if (digestMismatch(parsed)) {
    try {
      fs.renameSync(claimed, hp);
    } catch (err) {
      const restoreError = err?.message || String(err);
      d.writeErr(`routekit dispatch: could not restore the handoff; it remains at ${claimed}: ${restoreError}\n`);
      return refuse("worker_unauthorized", { runId, projectId, message: unauthorizedMessage, handoffRestored: false, restoreError, claimedPath: claimed });
    }
    return refuse("worker_unauthorized", { runId, projectId, message: unauthorizedMessage, handoffRestored: true });
  }
  try {
    fs.unlinkSync(claimed);
  } catch {
    // already gone
  }

  // ----- the record this worker finalizes: refuse explicitly when it is missing or damaged -----
  // Missing and damaged records stay write-free (never recreated, never overwritten).
  const loaded = loadRunRecord(projectRoot, runId, projectId);
  if (!loaded.ok && loaded.kind === "missing") return refuse("run_not_found", { runId, projectId, message: loaded.message });
  if (!loaded.ok && loaded.kind === "unreadable") return refuse("run_record_unreadable", { runId, projectId, message: loaded.message });
  if (!loaded.ok) {
    // The handoff is already consumed, so no worker can pick this run up again: record why it ended
    // (projectId left as it is) instead of leaving it running.
    const foreign = loaded.record;
    const written = writeRunTransition(projectRoot, foreign, {
      status: "failed",
      failureReason: "run_project_mismatch",
      result: failureResult({ reason: "run_project_mismatch", runId, projectId, initiator: foreign.initiator, message: loaded.message }),
      now: d.now,
    });
    const extra = {};
    if (!written.ok) {
      d.writeErr(`routekit dispatch: could not write run record: ${writeErrorMessage(written.error)}\n`);
      extra.recordWriteError = writeErrorMessage(written.error);
    }
    await emit("dispatch.completed", { runId, status: "failed" });
    return refuse("run_not_found", { runId, projectId, message: loaded.message, ...extra });
  }
  const record = loaded.record;

  // ----- malformed handoff: never completed with defaults -----
  const problem = parsed.ok ? handoffProblem(parsed.value, { runId, projectId }) : `handoff does not parse: ${parsed.error}`;
  if (problem) {
    const written = writeRunTransition(projectRoot, record, {
      status: "failed",
      failureReason: "handoff_invalid",
      result: failureResult({ reason: "handoff_invalid", runId, projectId, initiator: record.initiator, message: problem }),
      now: d.now,
    });
    const extra = {};
    if (!written.ok) {
      d.writeErr(`routekit dispatch: could not write run record: ${writeErrorMessage(written.error)}\n`);
      extra.recordWriteError = writeErrorMessage(written.error);
    }
    await emit("dispatch.completed", { runId, status: "failed" });
    return refuse("handoff_invalid", { runId, projectId, message: problem, ...extra });
  }
  const handoff = parsed.value;

  // ----- worker identity, written before claude is spawned -----
  record.workerPid = d.pid;
  record.workerStartedAt = d.now();
  record.updatedAt = record.workerStartedAt;
  try {
    writeRunRecord(projectRoot, record);
  } catch (err) {
    return refuse("run_record_unwritable", { runId, projectId, message: err?.message || String(err) });
  }

  const { result, exitCode } = await runClaudeSegment({
    spawnFn: d.spawnFn,
    projectRoot,
    parentEnv: d.parentEnv,
    record,
    runId,
    projectId,
    initiator: handoff.initiator,
    prompt: handoff.prompt,
    resumeSessionId: handoff.resumeSessionId,
    releaseAllowed: handoff.releaseAllowed,
    admission: handoff.admission,
    reservedForUser: handoff.reservedForUser,
    userActor: handoff.userActor,
    relay: false, // the worker has no caller; events are persisted to the events log
    writeOut: d.writeOut,
    writeErr: d.writeErr,
    now: d.now,
    emit,
  });
  return done(result, exitCode);
}

