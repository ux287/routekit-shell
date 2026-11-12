// backlog.feat.server-lane-policy
//
// Per-project lane policy. `.rks/project.json` may carry
//   "lanes": { "ide": "full", "dispatch": "full", "call": "read-only", "mcp": "read-only" }
// mapping each lane (the env-resolved RKS_VIA, then RKS_VIA_DEFAULT, else "mcp") to a mode. In a
// read-only lane the server admits only READ_ONLY_TOOLS (default-deny) plus an open-flow
// rks_governor_init, and refuses everything else with a typed result that is never auto-routed.
//
// The lane is SELF-REPORTED: whoever starts mcp-rks chooses its environment. This is defence in
// depth for clients that do not lie about their lane, not authentication.
import fs from "node:fs";
import path from "node:path";
import { envProjectRoot } from "../project-context.mjs";

export const LANE_MODES = new Set(["full", "read-only"]);
export const KNOWN_LANES = new Set(["ide", "dispatch", "call", "mcp", "remote"]);

// backlog.feat.remote-surface-lane: the `remote` lane's policy is FIXED IN CODE. It is applied in
// decideLane before any lanes-block lookup, a `lanes.remote` entry is dropped with a warning, and
// LANE_MODES does not gain a "remote" mode, so the project json can never widen it.
export const REMOTE_LANE = "remote";
export const REMOTE_LANE_TOOLS = new Set([
  "rks_governor_init", // open flow only, no token needed (it is how a token is obtained)
  "rks_governor_end",
  "rks_rag_query",
  "dendron_read_note", // any note
  "dendron_create_note", // only under inbox.<RKS_ACTOR>. with a non-empty remainder
]);
export const REMOTE_REASONS = new Set([
  "remote_tool_not_allowed",
  "remote_token_required",
  "remote_write_outside_prefix",
  "remote_actor_unset",
  "remote_project_mismatch",
  "remote_project_unresolved",
]);
export const REMOTE_POLICY_WARNING = "lanes.remote is ignored: the remote lane policy is fixed in code";
const REMOTE_ACTOR_RE = /^[a-z0-9][a-z0-9-]*$/;

export const LANE_POLICY_SOURCE = ".rks/project.json lanes";

// Default-deny: a read-only lane admits these and nothing else. Each entry was confirmed
// read-only by reading its handler; a tool may be added only with that evidence beside it.
// Removed from the story's starting list because their handlers write:
//   - rks_agent_research: the research agent's toolset includes dendron_create_note,
//     dendron_edit_note and dendron_update_field, each committed via commitInAgentNoteWrite
//     (agents/research.mjs), and the untokened path self-bootstraps a session + lease (server.mjs).
//   - rks_plan_review: on a completed plan marker it calls ensureExecStartPhase (story phase write)
//     and removePendingPlanMarker (server/handlers/planner.mjs).
//   - rks_plan_ready: with no session (untokened) or a story session it runs the stale-executing
//     phase self-heal write (runPlanReadyTool readOnly: false; server/handlers/planner.mjs).
export const READ_ONLY_TOOLS = new Set([
  // Admitted only for an open flow (no problemId, flowType absent or "open"); see decideLane.
  // Creates an in-memory/disk session record and a SHARED lease, no worktree/git/notes write.
  "rks_governor_init",
  // tools/governor-end.mjs: ends the caller's own session; refuses (end_blocked) when ending
  // would restore guardrails or pop a stash, so it makes no worktree write.
  "rks_governor_end",
  // handlers/project-meta.mjs: loadContext + JSON echo of registry, project.json, kg.
  "rks_project_get",
  // handlers/project-meta.mjs: resolveKgKey over the loaded kg.
  "rks_kg_query",
  // handlers/rag.mjs: runRagQuery. NOTE: when ensureRagIndex throws it auto-embeds notes
  // (runRagEmbed), which rewrites the derived RAG index (never the notes, worktree or git).
  // Kept because AC6 requires rks_rag_query to succeed in a read-only lane.
  "rks_rag_query",
  // handlers/rag.mjs: runExhaustiveSearch, a read-only scan returning cited results.
  "rks_exhaustive_search",
  // handlers/dendron.mjs: readNoteRaw + sliceNote; no write.
  "dendron_read_note",
  // handlers/project-meta.mjs: git rev-parse / git status --porcelain via execSync; no write.
  "rks_git_state",
  // handlers/telemetry.mjs: queryTelemetry (@routekit/telemetry/query), read-only.
  "rks_telemetry_query",
  // handlers/telemetry.mjs: generateReport (@routekit/telemetry/reports), read-only.
  "rks_telemetry_report",
  // handlers/governance.mjs: getSessionHistory (guardrails-audit.mjs) reads notes only.
  "rks_guardrails_status",
  // handlers/project-meta.mjs: lists template skeletons.
  "rks_templates_list",
  // handlers/project-meta.mjs: previewChannelPublish (server/channel-preview.mjs) reads notes.
  "rks_channel_preview",
]);

/**
 * Parse the lanes block of a project json.
 * A `remote` key (whatever its value) is removed before validation and reported through `warning`;
 * the status comes from the remaining entries, so a remote entry never demotes the owner's lanes.
 * `warning` is present only when a remote entry was dropped.
 * @returns {{ status: "absent"|"ok"|"invalid", lanes: object|null, error?: string, warning?: string }}
 */
export function readLanePolicy(projectJson) {
  let block = projectJson?.lanes;
  if (block === undefined) return { status: "absent", lanes: null };
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { status: "invalid", lanes: null, error: "lanes must be an object" };
  }
  let warn = {};
  if (Object.prototype.hasOwnProperty.call(block, REMOTE_LANE)) {
    const { [REMOTE_LANE]: _dropped, ...rest } = block;
    block = rest;
    warn = { warning: REMOTE_POLICY_WARNING };
    if (Object.keys(block).length === 0) return { status: "absent", lanes: null, ...warn };
  }
  for (const [lane, mode] of Object.entries(block)) {
    if (!KNOWN_LANES.has(lane)) return { status: "invalid", lanes: null, error: `unknown lane: ${lane}`, ...warn };
    if (!LANE_MODES.has(mode)) return { status: "invalid", lanes: null, error: `unknown mode for ${lane}: ${mode}`, ...warn };
  }
  return { status: "ok", lanes: { ...block }, ...warn };
}

/**
 * The mode a lane runs in under a policy. Remote: "remote" (fixed, before any policy lookup).
 * Absent: full. Invalid: read-only (fail closed).
 */
export function laneMode(policy, lane) {
  if (lane === REMOTE_LANE) return REMOTE_LANE;
  if (!policy || policy.status === "absent") return "full";
  if (policy.status === "invalid") return "read-only";
  return policy.lanes?.[lane] ?? "read-only";
}

/**
 * The lane used for ENFORCEMENT: a valid RKS_VIA, then a valid RKS_VIA_DEFAULT, else "mcp".
 * The rks_governor_init input `via` is attribution only and is never consulted here, so a caller
 * cannot raise its own lane through a tool argument.
 */
export function envLane(env = process.env) {
  if (KNOWN_LANES.has(env.RKS_VIA)) return env.RKS_VIA;
  if (KNOWN_LANES.has(env.RKS_VIA_DEFAULT)) return env.RKS_VIA_DEFAULT;
  return "mcp";
}

// Policy source is the server's own boot project root (user decision). Never args.projectId.
// Resolved from process.env at call time; no cwd fallback.
export function loadBootLanePolicy() {
  const root = envProjectRoot();
  if (!root) return { status: "absent", lanes: null, root: null };
  const file = path.join(root, ".rks", "project.json");
  if (!fs.existsSync(file)) return { status: "absent", lanes: null, root };
  let projectJson;
  try {
    projectJson = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { status: "invalid", lanes: null, root, error: `.rks/project.json: ${err.message}` };
  }
  const policy = readLanePolicy(projectJson);
  // backlog.feat.remote-surface-lane (R9): the lanes.remote warning is volunteered in the return
  // value and logged with console.error at most once per process.
  if (policy.warning && !_remoteWarningLogged) {
    _remoteWarningLogged = true;
    try { console.error(`[rks] ${policy.warning}`); } catch { /* logging is best-effort */ }
  }
  return { ...policy, root };
}
let _remoteWarningLogged = false;

/**
 * backlog.feat.remote-surface-lane: the boot project's id, read from the boot root's
 * .rks/project.json. Separate from loadBootLanePolicy so that function's return shape is unchanged.
 * Fails closed: id is null (with an `error`) when the root is unset, the file is missing or
 * unparseable, or `id` is not a non-empty string. Never consults args.projectId, and never the rks
 * repo's own project json (unlike getSelfProjectId).
 * @returns {{ id: string|null, root: string|null, error?: string }}
 */
export function loadBootProjectId() {
  const root = envProjectRoot();
  if (!root) return { id: null, root: null, error: "boot project root is unset (ROUTEKIT_PROJECT_ROOT / RKS_PROJECT_ROOT)" };
  const file = path.join(root, ".rks", "project.json");
  if (!fs.existsSync(file)) return { id: null, root, error: ".rks/project.json not found" };
  let projectJson;
  try {
    projectJson = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { id: null, root, error: `.rks/project.json: ${err.message}` };
  }
  const id = projectJson?.id;
  if (typeof id !== "string" || id.length === 0) return { id: null, root, error: ".rks/project.json id is missing or not a non-empty string" };
  return { id, root };
}

/** The lane report rks_governor_init returns: { via, policy, enforced, mode, root }. */
export function laneReport(policy = loadBootLanePolicy(), lane = envLane()) {
  return {
    via: lane,
    policy: policy.status,
    // The remote lane's fixed policy is enforced under every policy status.
    enforced: lane === REMOTE_LANE ? true : policy.status !== "absent",
    mode: laneMode(policy, lane),
    root: policy.root ?? null,
    ...(policy.error ? { error: policy.error } : {}),
    ...(policy.warning ? { warning: policy.warning } : {}),
  };
}

function remoteRefusal(tool, reason, remedy) {
  return { ok: false, reason, lane: REMOTE_LANE, tool, policySource: "fixed remote lane policy (lane-policy.mjs)", remedy };
}

/**
 * backlog.feat.remote-surface-lane: the fixed remote lane policy. Checks run in this order and the
 * first failure decides the reason:
 *   1. bootProjectId not a non-empty string  -> remote_project_unresolved (every tool)
 *   2. tool not admitted, or non-open init   -> remote_tool_not_allowed
 *   3. non-init tool and tokenValid !== true -> remote_token_required
 *   4. project pin                           -> remote_project_mismatch
 *   5. dendron_create_note: actor, prefix    -> remote_actor_unset, remote_write_outside_prefix
 */
function decideRemote({ tool, args, tokenValid, bootProjectId, env }) {
  if (typeof bootProjectId !== "string" || bootProjectId.length === 0) {
    return remoteRefusal(tool, "remote_project_unresolved", "Start the remote mcp-rks with ROUTEKIT_PROJECT_ROOT set to a project whose .rks/project.json carries a string id.");
  }
  let admitted = REMOTE_LANE_TOOLS.has(tool);
  if (tool === "rks_governor_init") {
    const flow = args?.flowType;
    admitted = !args?.problemId && (flow === undefined || flow === "open");
  }
  if (!admitted) {
    return remoteRefusal(tool, "remote_tool_not_allowed", "The remote lane admits only an open-flow rks_governor_init, rks_governor_end, rks_rag_query, dendron_read_note, and dendron_create_note under inbox.<actor>.");
  }
  if (tool !== "rks_governor_init" && tokenValid !== true) {
    return remoteRefusal(tool, "remote_token_required", "Call rks_governor_init (open flow) first and pass its token as _governorToken.");
  }
  const pid = args?.projectId;
  const pidRequired = tool === "rks_governor_init" || tool === "rks_rag_query";
  if ((pidRequired && pid === undefined) || (pid !== undefined && pid !== bootProjectId)) {
    return remoteRefusal(tool, "remote_project_mismatch", `The remote lane is pinned to project ${bootProjectId}; pass projectId "${bootProjectId}".`);
  }
  if (tool === "dendron_create_note") {
    const actor = env?.RKS_ACTOR;
    if (typeof actor !== "string" || !REMOTE_ACTOR_RE.test(actor)) {
      return remoteRefusal(tool, "remote_actor_unset", "Set RKS_ACTOR (lowercase letters, digits and hyphens) in the remote mcp-rks environment.");
    }
    const prefix = `inbox.${actor}.`;
    const filename = args?.filename;
    if (typeof filename !== "string" || !filename.startsWith(prefix) || filename.length <= prefix.length) {
      return remoteRefusal(tool, "remote_write_outside_prefix", `The remote lane may create notes only under ${prefix}<name>.`);
    }
  }
  return null;
}

/**
 * null to admit, else a refusal object. `tokenValid` and `bootProjectId` are read ONLY by the
 * remote lane (applied before any lanes-block lookup); every other lane ignores them. `env`
 * (default process.env) supplies RKS_ACTOR for the remote create prefix.
 */
export function decideLane({ lane, policy, tool, args, tokenValid, bootProjectId, env = process.env }) {
  if (lane === REMOTE_LANE) return decideRemote({ tool, args, tokenValid, bootProjectId, env });
  if (laneMode(policy, lane) === "full") return null;
  if (tool === "rks_governor_init") {
    const flow = args?.flowType;
    if (!args?.problemId && (flow === undefined || flow === "open")) return null;
  } else if (READ_ONLY_TOOLS.has(tool)) {
    return null;
  }
  const reason = policy.status === "invalid" ? "invalid_lane_policy" : "lane_read_only";
  return {
    ok: false,
    reason,
    lane,
    tool,
    policySource: LANE_POLICY_SOURCE,
    ...(policy.error ? { error: policy.error } : {}),
    remedy: reason === "invalid_lane_policy"
      ? `Fix the lanes block in .rks/project.json (${policy.error ?? "malformed"}); until it parses, every lane is read-only.`
      : "Run through `routekit dispatch` or an rks-configured IDE (mcpServers.rks.env.RKS_VIA_DEFAULT = ide, or `routekit project repin-mcp`, then restart MCP), or change the lanes block in .rks/project.json.",
  };
}
