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
export const KNOWN_LANES = new Set(["ide", "dispatch", "call", "mcp"]);

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
 * @returns {{ status: "absent"|"ok"|"invalid", lanes: object|null, error?: string }}
 */
export function readLanePolicy(projectJson) {
  const block = projectJson?.lanes;
  if (block === undefined) return { status: "absent", lanes: null };
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { status: "invalid", lanes: null, error: "lanes must be an object" };
  }
  for (const [lane, mode] of Object.entries(block)) {
    if (!KNOWN_LANES.has(lane)) return { status: "invalid", lanes: null, error: `unknown lane: ${lane}` };
    if (!LANE_MODES.has(mode)) return { status: "invalid", lanes: null, error: `unknown mode for ${lane}: ${mode}` };
  }
  return { status: "ok", lanes: { ...block } };
}

/** The mode a lane runs in under a policy. Absent: full. Invalid: read-only (fail closed). */
export function laneMode(policy, lane) {
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
  return { ...readLanePolicy(projectJson), root };
}

/** The lane report rks_governor_init returns: { via, policy, enforced, mode, root }. */
export function laneReport(policy = loadBootLanePolicy(), lane = envLane()) {
  return {
    via: lane,
    policy: policy.status,
    enforced: policy.status !== "absent",
    mode: laneMode(policy, lane),
    root: policy.root ?? null,
    ...(policy.error ? { error: policy.error } : {}),
  };
}

/** null to admit, else a refusal object. */
export function decideLane({ lane, policy, tool, args }) {
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
