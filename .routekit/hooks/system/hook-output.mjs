/**
 * hook-output.mjs — Shared output builder for PreToolUse redirect hooks
 *
 * Provides a consistent structured JSON output for all redirect hooks.
 * All hooks MUST use exit 0 + JSON stdout for denials (not exit 2 + stderr).
 * Claude Code only processes hookSpecificOutput JSON on exit 0.
 *
 * Governor routing fields are included in every redirect for the
 * Governor orchestration layer.
 *
 * @see notes/reports.hooks-redirect-architecture.md
 * @see backlog.governor.hook-routing
 */
import fs from "fs";
import path from "path";
import { isKeyless, hasLlmCredential } from "./credential-presence.mjs";

// Re-export the single-source key-presence authority so EVERY hook imports the SAME decision from
// this one module (INV-5 no-drift). Never re-derive keyless-ness in a hook.
export { isKeyless, hasLlmCredential };

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Basename of a flat keyless-notes.* dendron file. Dot-prefix boundary: `keyless-notes.evil.md`
// matches (keyless-notes. + leaf + .md); `keyless-notes-evil.md` (hyphen) does NOT.
const KEYLESS_NOTES_BASENAME_RE = /^keyless-notes\.[^/\\]+\.md$/;
// Bare dendron-name form (the dendron_create_note `filename` arg — no path, no extension).
const KEYLESS_NOTES_NAME_RE = /^keyless-notes\.[^/\\]+$/;

/**
 * The ONE shared predicate for "is this a write to the keyless-notes.* namespace?" (INV-4). Every
 * write hook (enforce-dendron-note-creation, redirect-edit-to-governor, redirect-dendron-tools-to-
 * agent) MUST reuse this — no hook may define a second local/lexical matcher.
 *
 * A file_path is a keyless-notes target ONLY when, after REALPATH normalization, its PARENT dir IS
 * the project's notes/ dir (absolute-anchored to the resolved PROJECT_DIR/notes) AND its basename
 * matches the `keyless-notes.` dot-prefix + `.md`. Realpath, not lexical:
 *  - A LEAF SYMLINK (`notes/keyless-notes.link.md` → `../packages/mcp-rks/src/server.mjs`) is
 *    rejected outright via lstat — a real keyless-notes file is a flat regular file, never a
 *    symlink; this closes the write-escape a lexical `path.resolve` would follow (broken or not).
 *  - The parent dir is realpath'd and compared to realpath(PROJECT_DIR/notes), so `/tmp/notes/…`,
 *    a nested `foo/notes/…`, or a symlinked parent do NOT anchor to the real notes dir.
 *
 * Also accepts a BARE dendron `filename` (no separator, no traversal) for the dendron tool form.
 *
 * FAIL-CLOSED: non-string input, parent missing, realpath throw, a leaf symlink, or any parent that
 * is not the real notes dir → false.
 *
 * @param {string} target - a file_path (Write/Edit) or a bare dendron note filename
 * @param {string} [projectDir=PROJECT_DIR]
 * @returns {boolean}
 */
export function isKeylessNotesTarget(target, projectDir = PROJECT_DIR) {
  try {
    if (!target || typeof target !== "string") return false;

    // Bare dendron-name form — the dendron_create_note `filename` arg (a note id with NO extension,
    // e.g. "keyless-notes.foo"). A path separator OR a `.md` suffix means the input is a file_path
    // (e.g. a repo-root "keyless-notes.md"), NOT a bare name, and must go through the realpath-
    // anchored path check below — otherwise a no-separator repo-root path would be mis-allowed.
    const looksLikePath =
      target.includes("/") || target.includes("\\") || target.includes(path.sep) || target.endsWith(".md");
    if (!looksLikePath) {
      if (target.includes("..")) return false; // traversal in a bare name → deny
      return KEYLESS_NOTES_NAME_RE.test(target);
    }

    // File-path form. Basename must be a flat keyless-notes.*.md dendron file.
    if (!KEYLESS_NOTES_BASENAME_RE.test(path.basename(target))) return false;

    // Absolute anchor: the resolved, realpath'd notes dir. No notes dir → fail-closed.
    let realNotes;
    try {
      realNotes = fs.realpathSync(path.join(projectDir, "notes"));
    } catch {
      return false;
    }

    const abs = path.isAbsolute(target) ? target : path.resolve(projectDir, target);

    // Reject a LEAF symlink regardless of where it points (lstat does not follow) — a planted
    // symlink whose Write would follow it out of the namespace is the core write-escape vector.
    let leafStat = null;
    try {
      leafStat = fs.lstatSync(abs);
    } catch {
      leafStat = null; // does not exist yet (normal new-file case) → not a symlink
    }
    if (leafStat && leafStat.isSymbolicLink()) return false;

    // Parent must realpath to the real notes dir (catches parent symlinks, nesting, out-of-repo).
    let realParent;
    try {
      realParent = fs.realpathSync(path.dirname(abs));
    } catch {
      return false; // parent missing / unresolvable → fail-closed
    }
    return realParent === realNotes;
  } catch {
    return false; // any error → fail-closed
  }
}
const TELEMETRY_DIR = path.join(PROJECT_DIR, ".routekit", "telemetry");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "guardrails.log");

/**
 * Read and parse hook input from stdin.
 * @returns {Promise<object>} Parsed hook data
 */
export async function readHookInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

/**
 * Get the project ID from env or directory name.
 * @returns {string}
 */
export function getProjectId() {
  if (process.env.RKS_PROJECT_ID) return process.env.RKS_PROJECT_ID;
  return path.basename(PROJECT_DIR);
}

/**
 * Append a telemetry entry to the guardrails log.
 * @param {object} entry - Telemetry event data
 */
export function appendTelemetry(entry) {
  try {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort telemetry
  }
}

/**
 * Emit a `hook.guardrail_bump` event to the SERVER telemetry sink (.rks/telemetry) so that
 * client-side hook blocks/redirects ("guardrail bumps") become observable in the dashboard
 * trust panel — the SAME sink and canonical {id,type,timestamp,projectId,payload} envelope the
 * MCP server + readers use (NOT the orphaned .routekit/telemetry/guardrails.log). This is the
 * client-side half of hook/chain-violation telemetry (server-side chain.violation already emits
 * from governor-token.mjs). Best-effort: a telemetry failure must NEVER break the redirect.
 * @param {object} opts { reason, redirectAgent, agentParams, blockedTool, projectId, projectDir }
 */
export function emitGuardrailBump({ reason, redirectAgent, agentParams, blockedTool, projectId, projectDir } = {}) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(root, ".rks", "telemetry");
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `events-${date}.jsonl`);

    let scope = null;
    try {
      scope = JSON.parse(fs.readFileSync(path.join(root, ".rks", "active-scope.json"), "utf8"));
    } catch {
      /* no active scope */
    }

    const hookName = process.argv && process.argv[1]
      ? path.basename(process.argv[1]).replace(/\.mjs$/, "")
      : null;
    const tool = blockedTool
      || (agentParams && agentParams.tool)
      || (agentParams && typeof agentParams.command === "string" ? agentParams.command.trim().split(/\s+/)[0] : null)
      || null;

    const event = {
      id: `gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "hook.guardrail_bump",
      timestamp: new Date().toISOString(),
      projectId: projectId || getProjectId(),
      payload: {
        hookName,
        blockedTool: tool,
        redirectAgent: redirectAgent || null,
        reason: reason || null,
        problemId: scope ? scope.problemId || null : null,
        tier: scope ? scope.tier || null : null,
        sessionId: scope ? scope.sessionId || null : null,
        context: agentParams != null ? agentParams : null,
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort: telemetry must never break the redirect
  }
}

/** Longest description/prompt-preview stored on a launch record. Never store a full prompt body. */
const LAUNCH_PREVIEW_MAX = 200;

/**
 * backlog.fix.agent-launch-telemetry-ledger
 *
 * Record a PERMITTED agent launch to the canonical server telemetry sink.
 *
 * Until this existed, `redirect-task-explore-to-agent.mjs` wrote telemetry ONLY on its deny path —
 * so the only launches rks wrote down were the ones it refused. A permitted launch left no trace
 * anywhere, which meant delegated work could not be reconciled: an agent that died silently was
 * indistinguishable from one still running, and the Dispatcher had nothing to query.
 *
 * Writes the SAME {id,type,timestamp,projectId,payload} envelope as emitGuardrailBump, to the SAME
 * `.rks/telemetry/events-<date>.jsonl` sink — NOT the orphaned `.routekit/telemetry/guardrails.log`,
 * which has no reader. This sink is read by `queryTelemetry` (behind `rks_telemetry_query`), whose
 * type filter is plain string equality, so `{ type: 'hook.agent_launch' }` retrieves these records
 * with no further change anywhere.
 *
 * FAIL-OPEN, non-negotiable: a ledger that can block an agent launch is strictly worse than no
 * ledger. Bare try/catch, no rethrow — identical posture to emitGuardrailBump.
 *
 * @param {object} opts { subagentType, description, allowReason, projectDir, projectId }
 */
export function emitAgentLaunch({ subagentType, description, allowReason, projectDir, projectId } = {}) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(root, ".rks", "telemetry");
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `events-${date}.jsonl`);

    let scope = null;
    try {
      scope = JSON.parse(fs.readFileSync(path.join(root, ".rks", "active-scope.json"), "utf8"));
    } catch {
      /* no active scope */
    }

    const hookName = process.argv && process.argv[1]
      ? path.basename(process.argv[1]).replace(/\.mjs$/, "")
      : null;

    // Defensive truncation: the caller already previews, but a long `description` must never put a
    // full prompt body into the ledger.
    const preview = typeof description === "string" && description
      ? description.slice(0, LAUNCH_PREVIEW_MAX)
      : null;

    const event = {
      id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "hook.agent_launch",
      timestamp: new Date().toISOString(),
      projectId: projectId || getProjectId(),
      payload: {
        hookName,
        subagentType: subagentType || null,
        description: preview,
        allowReason: allowReason || null,
        problemId: scope ? scope.problemId || null : null,
        sessionId: scope ? scope.sessionId || null : null,
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort: the ledger must NEVER block a launch
  }
}

/**
 * Build a structured deny output with redirect and governor routing.
 *
 * @param {object} opts
 * @param {string} opts.reason - Human-readable denial reason
 * @param {string} opts.agent - MCP agent tool name (e.g., "mcp__rks__rks_agent_git")
 * @param {object} opts.agentParams - Parameters for the agent call
 * @param {string[]} opts.instructions - Additional context lines for the Governor
 * @param {string} [opts.project] - Project ID (defaults to getProjectId())
 * @returns {object} JSON output for stdout
 */
export function buildRedirectOutput({ reason, agent, agentParams, instructions = [], project = null }) {
  const projectId = project || getProjectId();
  const paramsJson = JSON.stringify(agentParams);

  const contextLines = [
    `REDIRECT ORDER: Route to Governor. Do NOT call ${agent} or the original tool directly.`,
    `Context: ${paramsJson}`,
    ...instructions,
    ``,
    `GOVERNOR ROUTING:`,
    `  agent: ${agent}`,
    `  params: ${paramsJson}`,
    `  project: ${projectId}`,
  ];

  // Observe the guardrail bump (best-effort; never breaks the redirect).
  try {
    emitGuardrailBump({ reason, redirectAgent: agent, agentParams, projectId });
  } catch {
    /* never break the redirect */
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: contextLines.join("\n"),
    },
  };
}

/**
 * Write the deny output to stdout and exit.
 * @param {object} output - Output from buildRedirectOutput
 */
export function denyWithRedirect(output) {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/**
 * Check if guardrails are off (escape hatch).
 * @returns {boolean}
 */
export function isGuardrailsOff() {
  return process.env.RKS_GUARDRAILS === "off";
}

// backlog.fix.hook-fallthrough-on-research-agent-outage
// How long an outage breadcrumb is honored. Past this the hooks fail closed (redirect) even if the
// breadcrumb is still on disk — a stale breadcrumb must never leave the read boundary open.
const OUTAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fail-closed reader for the Research-Agent outage breadcrumb the agent runner writes when a
 * research invocation fails with a genuine INFRASTRUCTURE error. Returns `{ active:true, category }`
 * ONLY when a well-formed breadcrumb exists AND is within TTL. Every edge — missing, unreadable,
 * malformed, future-dated, or stale (past TTL) — returns `false` so the caller redirects. This is
 * the security-sensitive gate: mis-reading a normal state as an outage would open a general read
 * bypass, so it defaults to "not an outage".
 *
 * @param {string} [projectDir]
 * @returns {{active:true, category:string}|false}
 */
export function isResearchAgentOutage(projectDir) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = path.join(root, ".rks", "telemetry", "research-agent-outage.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ts = Date.parse(data && data.timestamp);
    if (!Number.isFinite(ts)) return false;          // malformed timestamp → fail closed
    const age = Date.now() - ts;
    if (age < 0 || age > OUTAGE_TTL_MS) return false; // future-dated or stale → fail closed
    const category = typeof data.category === "string" && data.category ? data.category : "unknown";
    return { active: true, category };
  } catch {
    return false; // missing / unreadable / invalid JSON → fail closed
  }
}

/**
 * Audit a Research-Agent outage fallthrough (a bounded direct read permitted because the agent is
 * down). Distinct reason `research_agent_outage_fallthrough`, recording tool + path + category, to
 * the same server telemetry sink as guardrail bumps. Best-effort — never breaks the read.
 */
export function emitOutageFallthrough({ blockedTool, targetPath, category, projectDir, projectId } = {}) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(root, ".rks", "telemetry");
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `events-${date}.jsonl`);
    const hookName = process.argv && process.argv[1]
      ? path.basename(process.argv[1]).replace(/\.mjs$/, "")
      : null;
    const event = {
      id: `rof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "hook.research_agent_outage_fallthrough",
      timestamp: new Date().toISOString(),
      projectId: projectId || getProjectId(),
      payload: {
        reason: "research_agent_outage_fallthrough",
        hookName,
        blockedTool: blockedTool || null,
        path: targetPath || null,
        category: category || "unknown",
      },
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort: audit must never break the read
  }
}

export { PROJECT_DIR };
