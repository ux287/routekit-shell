// rks permission rules for child projects (hybrid wildcard).
// backlog.fix.child-rks-permission-allow-list
//
// SINGLE SOURCE OF TRUTH — CHILD_RKS_ALLOW_TOOLS / CHILD_RKS_PROMPT_TOOLS are the
// shell-side classification of every advertised rks tool, pinned to the LIVE
// server registry by tests/integration/child-rks-permission-drift-guard.spec.mjs.
// A new server tool fails CI until it is classified into exactly one set.
//
// Children do NOT receive the explicit list. Children run the shell's live server
// (bootstrap.mjs serverPath), so an explicit child list would prompt for every new
// tool until that child's next upgrade/doctor. Instead children receive:
//   permissions.allow ⊇ CHILD_RKS_ALLOW_RULES  (["mcp__rks__*"])
//   permissions.ask   ⊇ CHILD_RKS_ASK_RULES    (the checkpoint tools)
// Claude Code evaluates deny → ask → allow, first match wins, so the ask entries keep
// every checkpoint a prompt while the wildcard lets the governed chain run unprompted.
//
// Only mcp__rks__-prefixed entries are ever written. Any other entry (e.g. a
// project-level Bash(...) rule) is never added, removed or reordered.
import fs from "node:fs";
import path from "node:path";
import { backupBeforeWrite } from "./backup-path.mjs";

export const CHILD_RKS_ALLOW_TOOLS = Object.freeze([
  "mcp__rks__dendron_create_note",
  "mcp__rks__dendron_edit_note",
  "mcp__rks__dendron_fix_frontmatter",
  "mcp__rks__dendron_mark_implemented",
  "mcp__rks__dendron_read_note",
  "mcp__rks__dendron_update_field",
  "mcp__rks__dendron_validate_schema",
  "mcp__rks__rks_agent_cycle_complete",
  "mcp__rks__rks_agent_delivery",
  "mcp__rks__rks_agent_dendron",
  "mcp__rks__rks_agent_external_research",
  "mcp__rks__rks_agent_git",
  "mcp__rks__rks_agent_plan",
  "mcp__rks__rks_agent_recovery",
  "mcp__rks__rks_agent_research",
  "mcp__rks__rks_agent_run",
  "mcp__rks__rks_agent_ship",
  "mcp__rks__rks_agent_story",
  "mcp__rks__rks_agent_telemetry",
  "mcp__rks__rks_agent_validate_story",
  "mcp__rks__rks_analyze",
  "mcp__rks__rks_apply",
  "mcp__rks__rks_approve",
  "mcp__rks__rks_arch_verdict",
  "mcp__rks__rks_branch_repair",
  "mcp__rks__rks_checkout",
  "mcp__rks__rks_cherry_pick",
  "mcp__rks__rks_cycle_complete",
  "mcp__rks__rks_exec",
  "mcp__rks__rks_exec_abort",
  "mcp__rks__rks_exhaustive_search",
  "mcp__rks__rks_fetch_raw",
  "mcp__rks__rks_git_branch",
  "mcp__rks__rks_git_commit",
  "mcp__rks__rks_git_merge",
  "mcp__rks__rks_git_preflight",
  "mcp__rks__rks_git_push",
  "mcp__rks__rks_git_state",
  "mcp__rks__rks_governor_init",
  "mcp__rks__rks_guardrails_abort",
  "mcp__rks__rks_guardrails_on",
  "mcp__rks__rks_guardrails_simulate",
  "mcp__rks__rks_guardrails_status",
  "mcp__rks__rks_init",
  "mcp__rks__rks_interview",
  "mcp__rks__rks_kg_query",
  "mcp__rks__rks_onboarder",
  "mcp__rks__rks_phase_repair",
  "mcp__rks__rks_plan",
  "mcp__rks__rks_plan_ready",
  "mcp__rks__rks_plan_review",
  "mcp__rks__rks_preflight",
  "mcp__rks__rks_project_get",
  "mcp__rks__rks_project_init",
  "mcp__rks__rks_promote",
  "mcp__rks__rks_rag_compact",
  "mcp__rks__rks_rag_embed",
  "mcp__rks__rks_rag_init",
  "mcp__rks__rks_rag_query",
  "mcp__rks__rks_refine",
  "mcp__rks__rks_refine_apply",
  "mcp__rks__rks_reset",
  "mcp__rks__rks_resolve_conflict",
  "mcp__rks__rks_restore",
  "mcp__rks__rks_revert",
  "mcp__rks__rks_review",
  "mcp__rks__rks_ship",
  "mcp__rks__rks_staging_merge",
  "mcp__rks__rks_staging_pr",
  "mcp__rks__rks_stash",
  "mcp__rks__rks_story_create",
  "mcp__rks__rks_story_ship",
  "mcp__rks__rks_sync_staging",
  "mcp__rks__rks_tag",
  "mcp__rks__rks_telemetry_export",
  "mcp__rks__rks_telemetry_query",
  "mcp__rks__rks_telemetry_report",
  "mcp__rks__rks_templates_list",
  "mcp__rks__rks_token_cost_report",
  "mcp__rks__rks_validate_story",
]);

// Human checkpoints — each stays a prompt in every child, in every permission mode.
export const CHILD_RKS_PROMPT_TOOLS = Object.freeze({
  mcp__rks__rks_guardrails_off: "disables governance — human checkpoint",
  mcp__rks__rks_release: "staging -> main promotion — human checkpoint",
  mcp__rks__rks_publish: "public mirror egress — human checkpoint",
  mcp__rks__rks_publish_profiles: "public mirror egress — human checkpoint",
});

export const CHILD_RKS_ALLOW_RULES = Object.freeze(["mcp__rks__*"]);

export const CHILD_RKS_ASK_RULES = Object.freeze(Object.keys(CHILD_RKS_PROMPT_TOOLS));

const WILDCARDS = ["mcp__rks__*", "mcp__rks"];

/**
 * Read a settings file for the merge. Absent → empty permissions (not an error).
 * Unparseable or malformed → null (the caller refuses).
 * Malformed = top-level not an object, `permissions` present but not an object, or
 * `permissions.allow` / `.ask` / `.deny` present but not an array.
 */
function readSettings(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { settings: null, absent: true };
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const perms = settings.permissions;
  if (perms !== undefined) {
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) return null;
    for (const key of ["allow", "ask", "deny"]) {
      if (perms[key] !== undefined && !Array.isArray(perms[key])) return null;
    }
  }
  return { settings, absent: false };
}

function listOf(settings, key) {
  const list = settings && settings.permissions && settings.permissions[key];
  return Array.isArray(list) ? list : [];
}

function isOptedOut(projectConfig) {
  const cp = projectConfig && typeof projectConfig === "object" ? projectConfig.claudePermissions : undefined;
  return !!cp && typeof cp === "object" && cp.manageAllowList === false;
}

function writeJSONWithBackup(filePath, obj) {
  backupBeforeWrite(filePath);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Compute the rks entries an existing child is missing, honouring user decisions in
 * settings.json AND settings.local.json. Pure — writes nothing.
 *
 * @returns {{ok: true, added: string[], addedAsk: string[]} |
 *           {ok: false, reason: "unparseable", file: string} |
 *           {ok: false, reason: "opted-out"}}
 */
export function planRksPermissionMerge({ settingsPath, localSettingsPath, projectConfig }) {
  if (isOptedOut(projectConfig)) return { ok: false, reason: "opted-out" };

  const main = readSettings(settingsPath);
  if (!main) return { ok: false, reason: "unparseable", file: ".claude/settings.json" };
  const local = readSettings(localSettingsPath);
  if (!local) return { ok: false, reason: "unparseable", file: ".claude/settings.local.json" };

  const both = (key) => [...listOf(main.settings, key), ...listOf(local.settings, key)];
  const allow = both("allow");
  const ask = both("ask");
  const deny = both("deny");
  const hasWildcard = (list) => WILDCARDS.some((w) => list.includes(w));

  // Allow side: skip when already allowed, or when the user denied/asked the whole
  // server (an allow would be inert, and the decision is theirs).
  const added =
    hasWildcard(allow) || hasWildcard(deny) || hasWildcard(ask) ? [] : [...CHILD_RKS_ALLOW_RULES];

  // Ask side: skip a checkpoint already asked (directly or by server-wide ask), denied
  // (already stricter), or explicitly allowed (a user decision not to be prompted).
  const addedAsk = hasWildcard(ask)
    ? []
    : CHILD_RKS_ASK_RULES.filter((t) => !ask.includes(t) && !deny.includes(t) && !allow.includes(t));

  return { ok: true, added, addedAsk, absent: main.absent };
}

/**
 * Additive, order-preserving, idempotent merge of the rks permission rules into a
 * child's .claude/settings.json. Never writes settings.local.json. Never touches an
 * entry without the mcp__rks__ prefix, and never rewrites any other key.
 *
 * @returns {{changed: boolean, reason: "added"|"unchanged"|"unparseable"|"opted-out",
 *            added: string[], addedAsk: string[], file?: string}}
 */
export function mergeRksPermissionAllow({ settingsPath, localSettingsPath, projectConfig }) {
  const plan = planRksPermissionMerge({ settingsPath, localSettingsPath, projectConfig });
  if (!plan.ok) {
    const out = { changed: false, reason: plan.reason, added: [], addedAsk: [] };
    if (plan.file) out.file = plan.file;
    return out;
  }
  if (plan.added.length === 0 && plan.addedAsk.length === 0) {
    return { changed: false, reason: "unchanged", added: [], addedAsk: [] };
  }

  if (plan.absent) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: [...plan.added], ask: [...plan.addedAsk] } }, null, 2) + "\n",
    );
  } else {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // Assigning in place preserves top-level and permissions key order.
    if (!settings.permissions) settings.permissions = {};
    const perms = settings.permissions;
    if (plan.added.length) perms.allow = [...(perms.allow || []), ...plan.added];
    if (plan.addedAsk.length) perms.ask = [...(perms.ask || []), ...plan.addedAsk];
    writeJSONWithBackup(settingsPath, settings);
  }
  return { changed: true, reason: "added", added: plan.added, addedAsk: plan.addedAsk };
}

/**
 * Read a child's .rks/project.json for the opt-out flag. Absent/unparseable → {}
 * (managed by default).
 */
export function readChildProjectConfig(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8")) || {};
  } catch {
    return {};
  }
}
