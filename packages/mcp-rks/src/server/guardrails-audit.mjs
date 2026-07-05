/**
 * Guardrails-Off Governance Module
 *
 * Manages guardrails-off sessions with:
 * - Session logging (start/end times, reason, commits)
 * - Automatic PR/merge/complete_cycle on restore
 * - Audit trail for compliance
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { ensureTelemetryStorage } from "./telemetry/index.mjs";
import { runCycleComplete } from "./git-tools.mjs";
import { getHooksHealth, restoreHooksFromTemplate } from "./hooks-health.mjs";
import { parseFrontmatter, resolveNotesDir } from "../dendron.mjs";
import { PHASE_GATE_GUARDRAIL } from "../workflow/phases.mjs";
import { normalizeTargetFiles } from "../shared/normalize-target-files.mjs";
import { localMerge } from "./git/local-merge.mjs";
import { getBranchConfig } from "./project.mjs";
import { commitAndEmbed } from '../shared/commit-and-embed.mjs';

const HOOKS_DIR = ".routekit/hooks";
const HOOKS_BAK_DIR = ".routekit/hooks.bak"; // Active backup: hooks/ is renamed here when guardrails are off
const HOOKS_MANIFEST = ".routekit/hooks-manifest.json";
const SESSION_LOG = ".rks/guardrails-off-sessions.jsonl";
const SCOPE_FILE = ".rks/active-scope.json";
const GUARD_STATE_FILE = ".rks/guardrails-state.json";

/**
 * Check if a file path is listed in the current active scope (allowedFiles).
 * Fail-open: returns false on any error (missing file, bad JSON, missing field).
 * Used by hooks to pass through tool calls for files already declared in scope.
 * @param {string} filePath - Absolute or relative path to check
 * @param {string} [projectRoot] - Project root for resolving relative paths (defaults to cwd)
 * @returns {boolean}
 */
export function isFileInActiveScope(filePath, projectRoot) {
  try {
    const root = projectRoot || process.cwd();
    const scopePath = path.join(root, SCOPE_FILE);
    const data = JSON.parse(fs.readFileSync(scopePath, 'utf8'));
    const allowedFiles = Array.isArray(data.allowedFiles) ? data.allowedFiles : [];
    if (allowedFiles.length === 0) return false;
    const absTarget = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    return allowedFiles.some(f => {
      const absAllowed = path.isAbsolute(f) ? f : path.resolve(root, f);
      return absTarget === absAllowed;
    });
  } catch {
    return false;
  }
}

// Core file patterns - off-rail is appropriate for these
const RKS_CORE_PATTERNS = [
  'packages/',
  '.routekit/',
  'templates/',
  'scripts/mcp/',
  'scripts/rag/',
  'tests/',  // Tests for core packages are core work
];

/**
 * Load .rks/project.json for the given project root. Returns null on any failure
 * (missing file, invalid JSON). Callers fall back to default behavior on null.
 */
function loadProjectJson(projectRoot) {
  try {
    const p = path.join(projectRoot, '.rks', 'project.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the offRail config mode from project.json contents.
 * Returns one of:
 *   { mode: 'disabled' }                  — projectJson.offRail.enabled === false
 *   { mode: 'configured', roots }         — enabled === true with non-empty roots array
 *   { mode: 'default' }                   — offRail field absent (use RKS_CORE_PATTERNS)
 *   { mode: 'invalid', error }            — malformed config; do not throw
 */
export function resolveOffRailConfig(projectJson) {
  if (projectJson === null || projectJson === undefined) return { mode: 'default' };
  const offRail = projectJson.offRail;
  if (offRail === undefined || offRail === null) return { mode: 'default' };
  if (typeof offRail !== 'object' || Array.isArray(offRail)) {
    return { mode: 'invalid', error: 'offRail must be an object with `enabled` and `roots`' };
  }
  if (typeof offRail.enabled !== 'boolean') {
    return { mode: 'invalid', error: 'offRail.enabled must be a boolean' };
  }
  if (offRail.enabled === false) return { mode: 'disabled' };
  // enabled === true
  if (!Array.isArray(offRail.roots)) {
    return { mode: 'invalid', error: 'offRail.roots must be an array of pattern strings' };
  }
  if (offRail.roots.length === 0) {
    return { mode: 'invalid', error: 'offRail.roots must be a non-empty array' };
  }
  if (offRail.roots.some(r => typeof r !== 'string')) {
    return { mode: 'invalid', error: 'offRail.roots entries must be strings' };
  }
  return { mode: 'configured', roots: offRail.roots };
}

/**
 * Trailing-`*` prefix-wildcard match (e.g. `components/*` matches `components/Foo.tsx`).
 * Consistent with RKS_CORE_PATTERNS `startsWith` semantics.
 */
function matchesOffRailRoot(filePath, pattern) {
  const prefix = pattern.replace(/\/\*$/, '/').replace(/\*$/, '');
  return filePath.startsWith(prefix);
}

function targetFilesMatchRoots(targetFiles, roots) {
  if (!Array.isArray(targetFiles) || targetFiles.length === 0) return true;
  return targetFiles.every(f => roots.some(r => matchesOffRailRoot(f, r)));
}

function getOffRailRootsGuidance(targetFiles, roots) {
  const fileList = targetFiles?.slice(0, 5).map(f => `  - ${f}`).join('\n') || '  (none specified)';
  const rootList = roots.map(r => `  - ${r}`).join('\n');
  return `⛔ Off-rail rejected: targetFiles do not match this project's configured offRail.roots.

## Your Target Files
${fileList}

## Configured offRail.roots (from .rks/project.json)
${rootList}

To allow this scope, either add a matching pattern to offRail.roots in .rks/project.json,
or scope the story to files within the existing roots.`;
}

/**
 * Build the deny-list for framework-update tier.
 * Lists project-layer paths that framework writes must not touch.
 */
function buildFrameworkDenyList() {
  return ['notes/', 'CLAUDE.md', '.claude/'];
}

/**
 * Get the routekit-shell root directory.
 * The MCP server lives at packages/mcp-rks/src/server/ within routekit-shell.
 */
function getRoutekitShellRoot() {
  // __dirname equivalent for ESM - go up from server/ to routekit-shell root
  const serverDir = path.dirname(new URL(import.meta.url).pathname);
  // serverDir = .../routekit-shell/packages/mcp-rks/src/server
  // Go up 4 levels to get to routekit-shell root
  return path.resolve(serverDir, '..', '..', '..', '..');
}

/**
 * Check if we're in a child project (not routekit-shell itself)
 */
function isChildProject(projectRoot) {
  const rksRoot = getRoutekitShellRoot();
  return path.resolve(projectRoot) !== path.resolve(rksRoot);
}

/**
 * Check if targetFiles include RKS core files
 */
function isRksCoreWork(targetFiles) {
  if (!targetFiles || targetFiles.length === 0) {
    // No targetFiles = can't determine scope, allow off-rail (assume core)
    return true;
  }
  return targetFiles.some(f => RKS_CORE_PATTERNS.some(p => f.startsWith(p)));
}

/**
 * Get guidance for child project agents
 */
function getChildProjectGuidance() {
  return `⛔ Guardrails-off requests from child projects are not permitted.

## FAQ: Common Issues and Solutions

**Q: I need to read a file but it's blocked?**
A: Use \`rks_rag_query\` to search for content, or \`rks_code_context\` for specific files.

**Q: I need to edit a file but the hook blocks me?**
A: Use the on-rail workflow: \`rks_plan\` → \`rks_exec\` → \`rks_story_ship\`

**Q: I need to create or edit a note?**
A: Use \`dendron_create_note\` or \`dendron_edit_note\`.

**Q: I need to commit changes?**
A: Use \`rks_git_commit\` for commits, \`rks_staging_pr\` for PRs.

**Q: The planner keeps failing?**
A: Check that your story has valid SEARCH/REPLACE blocks and correct targetFiles.

**Q: Tests are failing during exec?**
A: Use \`skipTests: true\` if tests aren't relevant, or fix the test failures first.

## Still Stuck?

If the FAQ doesn't answer your issue, raise a bug with the human:

"I'm blocked on [specific task]. I tried [what you tried]. The FAQ doesn't cover this case.
Can you help me find an MCP tool for this, or should I file a bug for missing tooling?"

The human will either point you to the right tool or escalate to the RKS agent.`;
}

/**
 * Get guidance for RKS agent doing non-core work
 */
function getRksNonCoreGuidance(targetFiles) {
  const fileList = targetFiles?.slice(0, 5).map(f => `  - ${f}`).join('\n') || '  (none specified)';

  return `⚠️ You're requesting off-rail access, but your current work doesn't involve RKS core files.

## Your Target Files
${fileList}

## Core File Patterns (off-rail appropriate)
- \`packages/*\` - MCP server, CLI, design system
- \`.routekit/*\` - Hooks, templates
- \`templates/*\` - Project scaffolding
- \`scripts/mcp/*\`, \`scripts/rag/*\` - Tooling scripts

## Use MCP tools instead for non-core work:

**For code changes:**
\`rks_plan\` → \`rks_exec\` → \`rks_story_ship\`

**For notes/docs:**
\`dendron_create_note\`, \`dendron_edit_note\`

**For research:**
\`rks_rag_query\`, \`rks_code_context\`

**For git operations:**
\`rks_git_commit\`, \`rks_staging_pr\`, \`rks_story_ship\`

## Still Stuck?

If there's no suitable MCP tool for what you need, raise a bug with the human:

"I need to [specific task] but there's no MCP tool for this. Should I:
1. Go off-rail for this specific task?
2. File a bug for missing tooling?"`;
}

/**
 * Load targetFiles from a story note.
 * @param {string} projectRoot - Project root directory
 * @param {string} problemId - Story ID (e.g., "backlog.feat.my-feature")
 * @returns {string[]|null} Array of target file patterns or null if not found
 */
function loadStoryTargetFiles(projectRoot, problemId) {
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const notePath = path.join(notesDir, `${problemId}.md`);
    if (!fs.existsSync(notePath)) return null;

    const raw = fs.readFileSync(notePath, "utf8");
    const parsed = parseFrontmatter(raw);
    const files = parsed?.data?.targetFiles || null;
    if (!files) return null;
    return normalizeTargetFiles(files).map(t => t.path);
  } catch (e) {
    console.error(`[guardrails] Failed to load targetFiles for ${problemId}: ${e.message}`);
    return null;
  }
}

/**
 * Write scope file for enforcement hook.
 * @param {string} projectRoot - Project root directory
 * @param {object} scopeData - Scope data including allowedFiles, sessionId, etc.
 */
function writeScopeFile(projectRoot, scopeData) {
  const scopePath = path.join(projectRoot, SCOPE_FILE);
  const scopeDir = path.dirname(scopePath);
  if (!fs.existsSync(scopeDir)) {
    fs.mkdirSync(scopeDir, { recursive: true });
  }
  fs.writeFileSync(scopePath, JSON.stringify(scopeData, null, 2));
  return scopePath;
}

/**
 * Remove scope file (called by guardrailsOn).
 * @param {string} projectRoot - Project root directory
 */
export function removeScopeFile(projectRoot) {
  const scopePath = path.join(projectRoot, SCOPE_FILE);
  try {
    if (fs.existsSync(scopePath)) {
      fs.unlinkSync(scopePath);
      return true;
    }
  } catch (e) {
    console.error(`[guardrails] Failed to remove scope file: ${e.message}`);
  }
  return false;
}

/**
 * Write guardrails state file.
 * Hooks read this file to determine whether to enforce.
 */
function writeGuardState(projectRoot, state) {
  const statePath = path.join(projectRoot, GUARD_STATE_FILE);
  const stateDir = path.dirname(statePath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Clear guardrails state file (restore to active/enforcing).
 */
function clearGuardState(projectRoot) {
  writeGuardState(projectRoot, {
    active: true,
    scope: null,
    sessionId: null,
    sessionType: null,
    reason: null,
    disabledTiers: [],
  });
}

/**
 * Read current guardrails state.
 */
function readGuardState(projectRoot) {
  const statePath = path.join(projectRoot, GUARD_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { active: true, disabledTiers: [] };
  }
}

/**
 * Map scope to disabled tiers.
 * "all" disables read + write. "write" disables write only. "read" disables read only.
 * System tier is never disabled.
 */
function scopeToDisabledTiers(scope) {
  switch (scope) {
    case "all": return ["read", "write"];
    case "write": return ["write"];
    case "read": return ["read"];
    default: return ["read", "write"];
  }
}

/**
 * Load hooks manifest for tier classification.
 * Returns a Map of hookName → { tier: "read"|"write"|"system" }.
 * Hooks not in manifest default to "write" (conservative — disabled when in doubt).
 */
function loadHooksManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, HOOKS_MANIFEST);
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
  } catch (e) {
    console.error(`[guardrails] Failed to read hooks manifest: ${e.message}`);
  }
  return {};
}

/**
 * Get tier for a hook name. Defaults to "write" if not in manifest.
 */
function getHookTier(manifest, hookName) {
  const entry = manifest[hookName];
  return entry?.tier || "write";
}

/**
 * Classify hooks in a directory by tier.
 * Returns { write: [...], read: [...], system: [...] }
 */
function classifyHooks(projectRoot, manifest) {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const result = { write: [], read: [], system: [] };
  if (!fs.existsSync(hooksPath)) return result;

  try {
    for (const tier of ['system', 'write', 'read']) {
      const tierDir = path.join(hooksPath, tier);
      if (!fs.existsSync(tierDir)) continue;
      const files = fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs'));
      result[tier].push(...files);
    }
  } catch (e) {
    console.error(`[guardrails] Failed to classify hooks: ${e.message}`);
  }
  return result;
}

/**
 * Get current git state
 */
function getGitState(projectRoot) {
  try {
    const head = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();
    const branch = execSync("git branch --show-current", { cwd: projectRoot, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { cwd: projectRoot, encoding: "utf8" }).trim();
    return { head, branch, dirty: dirty.length > 0 };
  } catch (e) {
    return { head: null, branch: null, dirty: false, error: e.message };
  }
}

/**
 * Get changed files since a commit
 */
function getChangedFilesSince(projectRoot, sinceCommit) {
  try {
    const diff = execSync(`git diff --name-only ${sinceCommit}`, { cwd: projectRoot, encoding: "utf8" }).trim();
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd: projectRoot, encoding: "utf8" }).trim();
    const changed = diff ? diff.split("\n").filter(Boolean) : [];
    const newFiles = untracked ? untracked.split("\n").filter(Boolean) : [];
    return { changed, newFiles, total: changed.length + newFiles.length };
  } catch (e) {
    return { changed: [], newFiles: [], total: 0, error: e.message };
  }
}

/**
 * Append session entry to log file
 */
function appendSessionLog(projectRoot, entry) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  const logDir = path.dirname(logPath);

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  return logPath;
}

/**
 * Get active session (if any)
 *
 * Merges start/end JSONL entries by sessionId before checking,
 * since guardrailsOn() appends a separate end entry rather than
 * updating the original start entry.
 */
function getActiveSession(projectRoot) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  if (!fs.existsSync(logPath)) return null;

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  // Merge entries by sessionId (same logic as getSessionHistory)
  const sessionMap = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry.sessionId) continue;
      const existing = sessionMap.get(entry.sessionId) || {};
      sessionMap.set(entry.sessionId, { ...existing, ...entry });
    } catch (e) {
      continue;
    }
  }

  // Find the most recent session that has startedAt but no endedAt
  let latest = null;
  for (const session of sessionMap.values()) {
    if (session.startedAt && !session.endedAt) {
      if (!latest || new Date(session.startedAt) > new Date(latest.startedAt)) {
        latest = session;
      }
    }
  }
  return latest;
}

/**
 * Turn guardrails OFF
 * - Logs session start with scope
 * - scope="all" (default): moves entire hooks/ to hooks.bak/ (backward compatible)
 * - scope="write": moves only write-tier hooks to hooks.bak/, keeps read+system active
 * - scope="read": moves only read-tier hooks (unusual but supported)
 *
 * If problemId is provided:
 * - Loads targetFiles from the story note
 * - Writes a scope file for the enforce-targetfile-scope hook to enforce
 * - Session is scoped to those files only
 *
 * If problemId is null/undefined:
 * - Session is read-only for code (no scoped files = no code writes allowed)
 * - The enforce-targetfile-scope hook will block all code writes
 */
export async function guardrailsOff(projectRoot, reason = "unspecified", scope = "all", problemId = null, projectId = "unknown") {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);

  // Validate scope
  const validScopes = ["all", "write", "read"];
  if (!validScopes.includes(scope)) {
    return { ok: false, error: `Invalid scope "${scope}". Must be one of: ${validScopes.join(", ")}` };
  }

  // Child projects: Governor sessions may call guardrails_off to disable hooks.
  // The state machine + token gating enforce sequencing with hooks off.
  // No block here — hooks + CLAUDE.md are the Dispatcher-level protection.

  // Resolve per-project offRail config early — off_rail_disabled and invalid_offrail_config
  // must fire before the problemId and story-phase gates (otherwise they're unreachable when a
  // project has offRail.enabled: false and the caller provides a valid problemId).
  const projectJson = loadProjectJson(projectRoot);
  const offRailConfig = resolveOffRailConfig(projectJson);

  if (offRailConfig.mode === 'disabled') {
    return {
      ok: false,
      blocked: true,
      reason: 'off_rail_disabled',
      message: 'off-rail disabled for this project per .rks/project.json',
    };
  }
  if (offRailConfig.mode === 'invalid') {
    return {
      ok: false,
      blocked: true,
      reason: 'invalid_offrail_config',
      error: offRailConfig.error,
      message: `Invalid offRail config in .rks/project.json: ${offRailConfig.error}`,
    };
  }

  // Phase gate: a valid arch-approved story ID is required for every off-rail session,
  // except for framework projects (frameworkProject: true) which use the framework-update tier.
  const isFrameworkProject = projectJson?.frameworkProject === true;
  if (!problemId && !isFrameworkProject) {
    return {
      ok: false,
      reason: 'problemId_required',
      message: 'An arch-approved story ID is required to start an off-rail session. Identify the story this work belongs to (or run the PO Governor to create one), advance it to arch-approved, then retry with the storyId as problemId.',
    };
  }

  // Verify the story has reached arch-approved phase before enabling writes.
  if (problemId) {
    let storyPhase = null;
    try {
      const notesDir = resolveNotesDir(projectRoot);
      const notePath = path.join(notesDir, `${problemId}.md`);
      if (fs.existsSync(notePath)) {
        const parsed = parseFrontmatter(fs.readFileSync(notePath, 'utf8'));
        storyPhase = parsed?.data?.phase ?? null;
      }
    } catch { /* treat as missing */ }
    if (storyPhase !== PHASE_GATE_GUARDRAIL) {
      return {
        ok: false,
        reason: 'story_not_ready',
        storyId: problemId,
        message: `Story ${problemId} has not reached phase ${PHASE_GATE_GUARDRAIL} (current: ${storyPhase ?? 'not found'}). Run PO → QA → ARCH review before using as a problemId.`,
      };
    }
  }

  // For path-predicate check: require problemId + targetFiles. Without targetFiles we can't validate.
  if (problemId) {
    const targetFiles = loadStoryTargetFiles(projectRoot, problemId);
    if (targetFiles && targetFiles.length > 0) {
      if (offRailConfig.mode === 'configured') {
        if (!targetFilesMatchRoots(targetFiles, offRailConfig.roots)) {
          return {
            ok: false,
            blocked: true,
            reason: 'non_core_work',
            guidance: getOffRailRootsGuidance(targetFiles, offRailConfig.roots),
            roots: offRailConfig.roots,
            message: 'targetFiles do not match this project\'s configured offRail.roots.',
          };
        }
      } else {
        // mode === 'default' — preserve existing RKS_CORE_PATTERNS behavior
        if (!isRksCoreWork(targetFiles)) {
          return {
            ok: false,
            blocked: true,
            reason: 'non_core_work',
            guidance: getRksNonCoreGuidance(targetFiles),
            message: 'This work can be done on-rail with MCP tools. See guidance for alternatives.',
          };
        }
      }
    }
  }

  // --- Tier inference ---
  // Determines which permission tier applies and populates denyList for framework-update.
  let tier;
  let denyList = null;
  if (problemId) {
    tier = 'build-only';
  } else if (projectJson !== null) {
    if (projectJson.frameworkProject === true) {
      tier = 'framework-update';
      denyList = buildFrameworkDenyList();
    } else {
      return {
        ok: false,
        reason: 'no_tier_available',
        message: 'guardrails-off requires a problemId (build-only) or frameworkProject: true in .rks/project.json (framework-update). No tier available.',
      };
    }
  } else {
    // No project.json — backward-compatible read-only session
    tier = 'read-only';
  }

  // Check if already off via state file
  const currentState = readGuardState(projectRoot);
  if (currentState.active === false) {
    const activeSession = getActiveSession(projectRoot);
    return {
      ok: false,
      error: `Guardrails already off (scope=${currentState.scope || "unknown"})`,
      activeSession,
    };
  }

  // Check if hooks.bak exists — may be a live off-session OR an orphan from a prior crash
  if (fs.existsSync(hooksBakPath)) {
    const activeSession = getActiveSession(projectRoot);
    if (activeSession) {
      // Live session: block as before — this is a real concurrent conflict
      return {
        ok: false,
        error: "Guardrails already off — hooks.bak exists. Call rks_guardrails_on to restore.",
        activeSession,
      };
    }
    // Orphan hooks.bak (no active session recorded): restore tiers then clean
    try {
      for (const tier of ['write', 'read']) {
        const src = path.join(hooksBakPath, tier);
        const dst = path.join(hooksPath, tier);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.renameSync(src, dst);
        }
      }
      fs.rmSync(hooksBakPath, { recursive: true, force: true });
      console.error(`[guardrails] Auto-recovered orphan hooks.bak at ${hooksBakPath} (no active session found)`);
      try {
        const collector = ensureTelemetryStorage(projectRoot);
        collector.emit("guardrails.orphan_cleanup", projectId, {
          hooksBakPath,
          reason: "no_active_session",
        });
        await collector.flush();
      } catch (e) { /* telemetry is best-effort */ }
    } catch (e) {
      return {
        ok: false,
        error: `Failed to auto-recover orphan hooks.bak: ${e.message}`,
      };
    }
  }


  // Check if hooks directory exists
  if (!fs.existsSync(hooksPath)) {
    return {
      ok: false,
      error: "Guardrails infrastructure broken - hooks directory missing",
      severity: "critical",
      recovery: [
        "1. Restore from git: git checkout HEAD~10 -- .routekit/hooks/",
        "2. Or from template: cp -r templates/generic/.routekit/hooks/ .routekit/",
        "3. Commit the restored hooks before continuing"
      ],
    };
  }

  // Get git state
  const gitState = getGitState(projectRoot);

  // Create session entry
  const sessionId = randomUUID();
  const session = {
    sessionId,
    startedAt: new Date().toISOString(),
    reason,
    scope,
    branch: gitState.branch,
    headCommit: gitState.head,
    dirtyAtStart: gitState.dirty,
    problemId: problemId || null,
  };

  // Load targetFiles if problemId provided (for scoped writes)
  let allowedFiles = null;
  let writeMode = "read-only"; // Default: no code writes allowed

  if (problemId) {
    const targetFiles = loadStoryTargetFiles(projectRoot, problemId);
    if (targetFiles && Array.isArray(targetFiles) && targetFiles.length > 0) {
      allowedFiles = targetFiles;
      writeMode = "scoped";
      session.allowedFiles = allowedFiles;
    } else {
      // problemId provided but no targetFiles found - warn but continue
      session.warning = `Story ${problemId} has no targetFiles defined. Session is read-only for code.`;
    }
  } else if (tier === 'framework-update') {
    writeMode = 'deny-list';
  }
  session.writeMode = writeMode;

  // Write scope file for enforce-targetfile-scope hook
  const scopeData = {
    sessionId,
    problemId: problemId || null,
    tier,
    allowedFiles,
    denyList,
    writeMode,
    startedAt: session.startedAt,
    reason,
  };
  const scopePath = writeScopeFile(projectRoot, scopeData);
  session.scopeFile = scopePath;

  // Write guardrails state file — hooks check this to decide enforcement
  const disabledTiers = scopeToDisabledTiers(scope);
  try {
    // Enumerate hooks from tier subdirectories
    const manifest = loadHooksManifest(projectRoot);
    const hooksByTier = { system: [], write: [], read: [] };
    for (const tier of ['system', 'write', 'read']) {
      const tierDir = path.join(hooksPath, tier);
      if (fs.existsSync(tierDir)) {
        hooksByTier[tier] = fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs'));
      }
    }
    const allHooks = [...hooksByTier.system, ...hooksByTier.write, ...hooksByTier.read];

    // Determine which hooks are effectively disabled by scope
    const disabledHooks = allHooks.filter(f => {
      const name = f.replace(".mjs", "");
      const tier = getHookTier(manifest, name);
      return disabledTiers.includes(tier);
    });

    writeGuardState(projectRoot, {
      active: false,
      scope,
      sessionId,
      sessionType: null,
      reason,
      disabledTiers,
    });

    // Atomic tier-directory renames — system/ always stays
    if (!fs.existsSync(hooksBakPath)) {
      fs.mkdirSync(hooksBakPath, { recursive: true });
    }
    const movedHooks = [];
    for (const tier of ['write', 'read']) {
      if (!disabledTiers.includes(tier)) continue;
      const src = path.join(hooksPath, tier);
      const dst = path.join(hooksBakPath, tier);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
        movedHooks.push(...(hooksByTier[tier] || []));
      }
    }
    session.movedHooks = movedHooks;

    session.disabledHooks = disabledHooks;
    session.hookCount = allHooks.length;
  } catch (e) {
    return {
      ok: false,
      error: `Failed to write guardrails state: ${e.message}`,
    };
  }

  // Log session start
  const logPath = appendSessionLog(projectRoot, session);

  // Emit telemetry
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("guardrails.off", projectId, {
      sessionId,
      reason,
      scope,
      branch: gitState.branch,
      headCommit: gitState.head,
      dirtyAtStart: gitState.dirty,
      disabledHooks: session.disabledHooks,
      problemId: problemId || null,
      writeMode,
      allowedFiles: allowedFiles?.length || 0,
    });
    await collector.flush(); // Flush immediately for critical events
  } catch (e) { /* telemetry is best-effort */ }

  const scopeMsg = scope === "all" ? "" : ` (scope=${scope})`;
  const writeModeMsg = writeMode === "scoped"
    ? ` Writes scoped to ${allowedFiles.length} file(s) from story ${problemId}.`
    : " Session is READ-ONLY for code (no problemId).";

  return {
    ok: true,
    sessionId,
    scope,
    tier,
    startedAt: session.startedAt,
    headCommit: gitState.head,
    branch: gitState.branch,
    disabledHooks: session.disabledHooks,
    problemId: problemId || null,
    writeMode,
    allowedFiles,
    denyList,
    scopeFile: session.scopeFile,
    logPath,
    message: `Guardrails OFF${scopeMsg}.${writeModeMsg} Session ${sessionId.slice(0, 8)} started. Remember to call rks_guardrails_on when done.`,
    ...(session.warning ? { warning: session.warning } : {}),
  };
}

/**
 * Turn guardrails ON
 * - Restores hooks
 * - Logs session end
 * - Returns changes made during session
 */
export async function guardrailsOn(projectRoot, options = {}, projectId = "unknown") {
  const hooksPath = path.join(projectRoot, HOOKS_DIR);
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);

  // Check if guardrails are actually off via state file
  const currentState = readGuardState(projectRoot);
  if (currentState.active !== false) {
    return {
      ok: false,
      error: "Guardrails are already on (state file shows active)",
    };
  }

  // Get active session
  const activeSession = getActiveSession(projectRoot);
  if (!activeSession) {
    // No tracked session — still restore state but warn
    clearGuardState(projectRoot);
    return {
      ok: true,
      warning: "No active session found - guardrails state restored but no audit trail",
      hooksRestored: true,
    };
  }

  // Get git state and changes
  const gitState = getGitState(projectRoot);
  const changes = getChangedFilesSince(projectRoot, activeSession.headCommit);

  // Restore guardrails state file to active and move hooks back.
  //
  // Ordering rationale (atomic with rollback):
  //   1. Move hooks from hooks.bak/ back to hooks/ FIRST. System-tier hooks that
  //      were never moved remain in hooks/ untouched. If the per-file move fails,
  //      state is still active=false and partially moved hooks stay in .bak — recoverable.
  //   2. Only AFTER all moves succeed do we call clearGuardState. hooks.bak/ is
  //      cleaned up as a best-effort step after clearGuardState succeeds.
  //   3. If clearGuardState fails, attempt rollback: move restored hooks back to .bak.
  let hooksFallback = false;
  let renameSucceeded = false;
  let restoredFiles = [];
  try {
    // Step 1: per-file restore from hooks.bak/ to hooks/ (or fallback to template)
    if (fs.existsSync(hooksBakPath)) {
      try {
        if (!fs.existsSync(hooksPath)) {
          fs.mkdirSync(hooksPath, { recursive: true });
        }
        const bakEntries = fs.readdirSync(hooksBakPath, { withFileTypes: true });
        const bakTierDirs = bakEntries.filter(e => e.isDirectory() && ['write', 'read'].includes(e.name));
        const bakFlatFiles = bakEntries.filter(e => e.isFile() && e.name.endsWith('.mjs'));

        if (bakTierDirs.length > 0) {
          // Atomic tier restore (new layout)
          for (const dir of bakTierDirs) {
            const src = path.join(hooksBakPath, dir.name);
            const dst = path.join(hooksPath, dir.name);
            // Pre-remove destination if it exists — makes restore idempotent when
            // a prior guardrails_on was interrupted after partial rename (ENOTEMPTY).
            if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
            fs.renameSync(src, dst);
            restoredFiles.push(...fs.readdirSync(dst).filter(f => f.endsWith('.mjs')));
          }
        } else if (bakFlatFiles.length > 0) {
          // Legacy compat: flat files from old per-file move code
          const manifest = loadHooksManifest(projectRoot);
          for (const f of bakFlatFiles) {
            const tier = getHookTier(manifest, f.name.replace('.mjs', ''));
            const tierDir = path.join(hooksPath, tier);
            if (!fs.existsSync(tierDir)) fs.mkdirSync(tierDir, { recursive: true });
            fs.renameSync(path.join(hooksBakPath, f.name), path.join(tierDir, f.name));
            restoredFiles.push(f.name);
          }
        }
        renameSucceeded = true;
      } catch (renameErr) {
        // Move failed: state is still active=false, partially-moved hooks tracked — recoverable
        return {
          ok: false,
          error: `Failed to restore hooks: ${renameErr.message}`,
          recovery: "State unchanged (active=false), hooks still in hooks.bak. Retry rks_guardrails_on after resolving the filesystem issue.",
        };
      }
    } else {
      // hooks.bak missing — fall back to restoring from template
      hooksFallback = true;
      restoreHooksFromTemplate(projectRoot);
      renameSucceeded = true; // template restore counts as the "hooks in place" milestone
    }

    // Step 2: clear guard state (AFTER per-file restore succeeded)
    try {
      clearGuardState(projectRoot);
      // Best-effort cleanup of now-empty hooks.bak/
      try {
        if (fs.existsSync(hooksBakPath)) {
          fs.rmSync(hooksBakPath, { recursive: true, force: true });
        }
      } catch (e) { /* best-effort */ }
    } catch (clearErr) {
      // clearGuardState failed AFTER hooks were restored. Attempt rollback.
      if (!hooksFallback) {
        try {
          if (!fs.existsSync(hooksBakPath)) {
            fs.mkdirSync(hooksBakPath, { recursive: true });
          }
          const manifest = loadHooksManifest(projectRoot);
          const currentHooks = fs.existsSync(hooksPath) ? fs.readdirSync(hooksPath).filter(f => f.endsWith('.mjs')) : [];
          for (const file of currentHooks) {
            if (getHookTier(manifest, file.replace('.mjs', '')) !== 'system') {
              fs.renameSync(path.join(hooksPath, file), path.join(hooksBakPath, file));
            }
          }
          return {
            ok: false,
            error: `Failed to clear guardrails state: ${clearErr.message}`,
            rolledBack: true,
            recovery: "Rolled back: hooks restored to hooks.bak, state file unchanged. Retry rks_guardrails_on.",
          };
        } catch (rollbackErr) {
          // Rollback itself failed — split state requiring manual recovery
          return {
            ok: false,
            error: `Manual recovery required: clearGuardState failed (${clearErr.message}) AND rollback failed (${rollbackErr.message}). State=active may be partially written; hooks are physically in hooks/. Inspect .rks/guardrails-state.json and .routekit/hooks/ manually.`,
            manualRecoveryRequired: true,
            clearError: clearErr.message,
            rollbackError: rollbackErr.message,
          };
        }
      } else {
        // Template-fallback path: cannot rollback hook files. Surface manual recovery.
        return {
          ok: false,
          error: `Manual recovery required: clearGuardState failed (${clearErr.message}) after template-fallback hook restore. Hooks are in place but state file may be stale. Inspect .rks/guardrails-state.json manually.`,
          manualRecoveryRequired: true,
          clearError: clearErr.message,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `Failed to restore guardrails state: ${e.message}`,
    };
  }

  // Clean up scope file (if it exists from scoped write session)
  const scopeFileRemoved = removeScopeFile(projectRoot);

  // Log session end
  const endEntry = {
    sessionId: activeSession.sessionId,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - new Date(activeSession.startedAt).getTime(),
    endCommit: gitState.head,
    changesDetected: changes.total,
    changedFiles: changes.changed.slice(0, 20), // Limit for readability
    newFiles: changes.newFiles.slice(0, 20),
    autoWorkflow: options.autoWorkflow !== false,
  };

  const logPath = appendSessionLog(projectRoot, endEntry);

  // Build response
  const response = {
    ok: true,
    sessionId: activeSession.sessionId,
    startedAt: activeSession.startedAt,
    endedAt: endEntry.endedAt,
    durationMs: endEntry.durationMs,
    durationHuman: formatDuration(endEntry.durationMs),
    reason: activeSession.reason,
    headCommitAtStart: activeSession.headCommit,
    headCommitAtEnd: gitState.head,
    changesDetected: changes.total,
    changedFiles: changes.changed,
    newFiles: changes.newFiles,
    hooksRestored: true,
    hooksFallback,
    scopeFileRemoved,
    logPath,
    ...(hooksFallback ? { warning: "hooks.bak was missing — hooks restored from template rather than from backup" } : {}),
  };

  // Emit telemetry
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("guardrails.on", projectId, {
      sessionId: activeSession.sessionId,
      reason: activeSession.reason,
      durationMs: endEntry.durationMs,
      changesDetected: changes.total,
      changedFiles: changes.changed.length,
      newFiles: changes.newFiles.length,
      branch: gitState.branch,
      headCommitAtStart: activeSession.headCommit,
      headCommitAtEnd: gitState.head,
    });
    // Emit restore verification telemetry
    // expected = hooks physically moved to .bak at session start (movedHooks);
    // falls back to disabledHooks for sessions recorded before selective-retention
    const expectedHooks = activeSession.movedHooks || activeSession.disabledHooks || [];
    let restoredHooks = [];
    try {
      for (const tier of ['system', 'write', 'read']) {
        const tierDir = path.join(hooksPath, tier);
        if (fs.existsSync(tierDir)) {
          restoredHooks.push(...fs.readdirSync(tierDir).filter(f => f.endsWith('.mjs')));
        }
      }
    } catch (e) { /* best-effort */ }
    const expectedSet = new Set(expectedHooks);
    const restoredSet = new Set(restoredHooks);
    const missingHooks = expectedHooks.filter(h => !restoredSet.has(h));
    const unexpectedHooks = restoredHooks.filter(h => !expectedSet.has(h));
    collector.emit("guardrails.restore.verified", projectId, {
      sessionId: activeSession.sessionId,
      expectedCount: expectedHooks.length,
      actualCount: restoredHooks.length,
      missingCount: missingHooks.length,
      unexpectedCount: unexpectedHooks.length,
      missingHooks,
      unexpectedHooks,
      verified: true,
    });
    await collector.flush(); // Flush immediately for critical events
  } catch (e) { /* telemetry is best-effort */ }

  // If changes exist, auto-ship through proper PR flow (mandatory)
  // Skip when called internally from exec — exec handles its own commit/ship flow
  if (changes.total > 0 && !options.skipAutoShip) {
    const sessionShort = activeSession.sessionId.slice(0, 8);
    const branchName = `off-rail/${sessionShort}`;

    // Branch topology: 3-branch projects (working !== integration) skip the
    // remote PR/merge auto-ship and do a local merge into the working branch
    // only. Promote/release are explicit, human-led steps in 3-branch mode.
    const projectJsonForBranchConfig = loadProjectJson(projectRoot);
    const branchConfig = getBranchConfig(null, projectJsonForBranchConfig);
    const isThreeBranch = branchConfig.working !== branchConfig.integration;

    const storyLine = activeSession.problemId ? `\nStory: ${activeSession.problemId}` : "";
    const commitMessage = `feat(off-rail): ${activeSession.reason.slice(0, 50)}\n\nSession: ${activeSession.sessionId}\nDuration: ${formatDuration(endEntry.durationMs)}\nFiles: ${changes.total}${storyLine}\n\n#off-rail-work\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`;

    const shipSteps = [];

    try {
      // Step 1: Create off-rail branch and commit
      execSync(`git checkout -b ${branchName}`, { cwd: projectRoot, encoding: "utf8" });
      execSync("git add -A", { cwd: projectRoot, encoding: "utf8" });

      // Check if there's actually anything to commit (changes may already be committed during the session)
      const stagingCheck = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: projectRoot });
      if (stagingCheck.status === 0) {
        // Nothing staged — changes were committed during the session
        // Clean up the temp branch we created
        execSync(`git checkout ${gitState.branch}`, { cwd: projectRoot, encoding: "utf8", stdio: "ignore" });
        spawnSync("git", ["branch", "-D", branchName], { cwd: projectRoot, encoding: "utf8" });

        // Check if there are unpushed commits that need to be pushed
        const aheadCheck = spawnSync("git", ["rev-list", "--count", `origin/${gitState.branch}..${gitState.branch}`], { cwd: projectRoot, encoding: "utf8" });
        const aheadCount = parseInt(aheadCheck.stdout?.trim() || "0", 10);

        if (aheadCount > 0) {
          // 3-branch: commits remain local on the working branch. Promote is a
          // separate, human-led step (rks_promote dev → integration).
          if (isThreeBranch) {
            response.autoShipped = true;
            response.unpushedCommits = aheadCount;
            response.localOnly = true;
            response.message = `${aheadCount} off-rail commit(s) on ${gitState.branch} (3-branch local-only — use rks_promote to advance to ${branchConfig.integration})`;
            return response;
          }

          // 2-branch: push directly to the working/integration branch
          const pushResult = spawnSync("git", ["push", "origin", gitState.branch], { cwd: projectRoot, encoding: "utf8" });
          if (pushResult.status !== 0) {
            response.autoShipped = false;
            response.shipError = `Failed to push ${aheadCount} commit(s): ${pushResult.stderr?.trim()}`;
            response.message = `Off-rail commits exist locally but push failed. Manual push required: git push origin ${gitState.branch}`;
            return response;
          }

          response.autoShipped = true;
          response.unpushedCommits = aheadCount;
          response.message = `Pushed ${aheadCount} off-rail commit(s) to ${gitState.branch}`;

          // Telemetry for direct push
          try {
            const collector = ensureTelemetryStorage(projectRoot);
            collector.emit("guardrails.direct_pushed", projectId, {
              sessionId: activeSession.sessionId,
              branch: gitState.branch,
              commitCount: aheadCount,
            });
            await collector.flush();
          } catch (e) { /* telemetry is best-effort */ }

          return response;
        }

        // No unpushed commits - truly nothing to do
        response.autoShipped = false;
        response.message = "Changes detected vs session start but already committed and pushed.";
        return response;
      }

      const { commitId: fullCommitId, ragEmbedWarning: embedWarn } = await commitAndEmbed(projectRoot, commitMessage);
      const commitId = fullCommitId.slice(0, 8);
      if (embedWarn) response.ragEmbedWarning = embedWarn;
      shipSteps.push({ step: "commit", ok: true, branch: branchName, commitId });

      if (isThreeBranch) {
        // 3-branch: local merge off-rail branch into working branch (no push, no PR).
        // Promote/release are explicit, human-led steps.
        const lmResult = localMerge(projectRoot, branchName, gitState.branch);
        if (!lmResult.ok) {
          throw new Error(`Local merge failed: ${lmResult.error}`);
        }
        shipSteps.push({
          step: "local_merge",
          ok: true,
          from: branchName,
          to: gitState.branch,
          warning: lmResult.warning,
        });
        shipSteps.push({ step: "working_pr", skipped: true, reason: "three_branch_local_only" });
        shipSteps.push({ step: "working_merge", skipped: true, reason: "three_branch_local_only" });
        shipSteps.push({ step: "cycle_complete", skipped: true, reason: "three_branch_local_only" });

        response.autoShipped = true;
        response.shipSteps = shipSteps;
        response.commitId = commitId;
        response.localOnly = true;
        response.message = `Off-rail changes merged locally into ${gitState.branch} (3-branch — use rks_promote to advance to ${branchConfig.integration})`;

        try {
          const collector = ensureTelemetryStorage(projectRoot);
          collector.emit("guardrails.auto_shipped", projectId, {
            sessionId: activeSession.sessionId,
            commitId,
            filesChanged: changes.total,
            localOnly: true,
            workingBranch: gitState.branch,
          });
          await collector.flush();
        } catch (e) { /* telemetry is best-effort */ }
      } else {
        // 2-branch: local merge into integration branch, delete feature branch,
        // push integration branch directly — no remote feature branch, one CI run.
        const lmResult = localMerge(projectRoot, branchName, gitState.branch);
        if (!lmResult.ok) {
          throw new Error(`Local merge failed: ${lmResult.error}`);
        }
        shipSteps.push({ step: "local-merge", ok: true, from: branchName, to: gitState.branch });

        // Ensure we're on the integration branch before deleting the feature branch
        execSync(`git checkout ${gitState.branch}`, { cwd: projectRoot, encoding: "utf8", stdio: "ignore" });

        // Delete local feature branch — commits are preserved in integration branch history.
        // `localMerge` above already invoked `git branch -d <feature>` internally; on a clean
        // fast-forward that deletion succeeded and the branch is already gone. Trust it first,
        // then fall back to `git branch -D` only if `localMerge` returned a warning OR the
        // branch still exists. Capture stderr on real failures so the shipSteps entry carries
        // a non-empty error message instead of a silent `ok: false`.
        const branchListResult = spawnSync("git", ["branch", "--list", branchName], { cwd: projectRoot, encoding: "utf8" });
        const branchStillExists = (branchListResult.stdout || "").trim().length > 0;
        if (!branchStillExists) {
          // localMerge's internal `-d` succeeded — branch is gone, record idempotent success.
          shipSteps.push({ step: "delete-branch", ok: true, branch: branchName });
        } else {
          // Fallback: force-delete the branch that localMerge could not remove. Capture stderr.
          const deleteResult = spawnSync("git", ["branch", "-D", branchName], { cwd: projectRoot, encoding: "utf8" });
          if (deleteResult.status === 0) {
            shipSteps.push({ step: "delete-branch", ok: true, branch: branchName });
          } else {
            const errMsg = (deleteResult.stderr || deleteResult.stdout || "git branch -D exited non-zero with no stderr").trim();
            shipSteps.push({ step: "delete-branch", ok: false, branch: branchName, error: errMsg });
          }
        }

        // Push integration branch to origin directly — one CI run on the branch that matters
        const pushResult = spawnSync("git", ["push", "origin", gitState.branch], { cwd: projectRoot, encoding: "utf8" });
        if (pushResult.status !== 0) {
          throw new Error(`Push failed: ${pushResult.stderr?.trim()}`);
        }
        shipSteps.push({ step: "push-staging", ok: true, branch: gitState.branch });

        const cycleResult = await runCycleComplete({ projectRoot });
        shipSteps.push({ step: "cycle_complete", ok: cycleResult.ok, branch: cycleResult.branch });

        response.autoShipped = true;
        response.shipSteps = shipSteps;
        response.commitId = commitId;
        response.message = `Off-rail changes merged to ${gitState.branch} and pushed to origin/${gitState.branch}`;

        try {
          const collector = ensureTelemetryStorage(projectRoot);
          collector.emit("guardrails.auto_shipped", projectId, {
            sessionId: activeSession.sessionId,
            commitId,
            filesChanged: changes.total,
          });
          await collector.flush();
        } catch (e) { /* telemetry is best-effort */ }
      }

    } catch (shipError) {
      response.autoShipped = false;
      response.shipSteps = shipSteps;
      response.shipError = shipError.message;
      response.message = `Failed to auto-ship off-rail changes: ${shipError.message}. Manual intervention required.`;

      // Try to get back to working branch on failure
      try {
        execSync(`git checkout ${gitState.branch}`, { cwd: projectRoot, encoding: "utf8", stdio: "ignore" });
      } catch (e) { /* best effort */ }
    }
  } else {
    // No uncommitted changes, but check for unpushed commits on staging
    // This handles the case where work was committed during off-rail but not pushed
    const isStaging = gitState.branch === "staging";

    if (isStaging) {
      try {
        const aheadCheck = spawnSync("git", ["rev-list", "--count", `origin/${gitState.branch}..${gitState.branch}`], { cwd: projectRoot, encoding: "utf8" });
        const aheadCount = parseInt(aheadCheck.stdout?.trim() || "0", 10);

        if (aheadCount > 0) {
          // Push unpushed commits to staging
          const pushResult = spawnSync("git", ["push", "origin", gitState.branch], { cwd: projectRoot, encoding: "utf8" });

          if (pushResult.status !== 0) {
            response.autoShipped = false;
            response.pushedToStaging = false;
            response.shipError = `Failed to push ${aheadCount} commit(s) to staging: ${pushResult.stderr?.trim()}`;
            response.message = `Off-rail commits exist on staging but push failed. Manual push required: git push origin staging`;
          } else {
            response.autoShipped = true;
            response.pushedToStaging = true;
            response.pushedCommits = aheadCount;
            response.message = `Pushed ${aheadCount} off-rail commit(s) to staging.`;

            // Telemetry for staging push
            try {
              const collector = ensureTelemetryStorage(projectRoot);
              collector.emit("guardrails.staging_pushed", projectId, {
                sessionId: activeSession.sessionId,
                branch: gitState.branch,
                commitCount: aheadCount,
              });
              await collector.flush();
            } catch (e) { /* telemetry is best-effort */ }
          }
        } else {
          response.autoShipped = false;
          response.message = "No changes detected during guardrails-off session.";
        }
      } catch (e) {
        response.autoShipped = false;
        response.message = "No changes detected during guardrails-off session.";
      }
    } else {
      response.autoShipped = false;
      response.message = "No changes detected during guardrails-off session.";
    }
  }

  return response;
}

/**
 * Validate hooks registration
 * 
 * Compares hooks present in .routekit/hooks/ with those registered in .claude/settings.json
 * 
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Analysis of hook registration status
 */
export function validateHooksRegistration(projectRoot) {
  const hooksDir = path.join(projectRoot, HOOKS_DIR);
  const settingsPath = path.join(projectRoot, ".claude/settings.json");

  // Get hook files from directory
  let hookFiles = [];
  if (fs.existsSync(hooksDir)) {
    try {
      for (const tier of ['system', 'write', 'read']) {
        const tierDir = path.join(hooksDir, tier);
        if (fs.existsSync(tierDir)) {
          fs.readdirSync(tierDir)
            .filter(f => f.endsWith('.mjs'))
            .forEach(f => hookFiles.push(f.replace('.mjs', '')));
        }
      }
    } catch (error) {
      // Directory exists but can't read - return empty array
    }
  }

  // Get registered hooks from settings
  let registeredHooks = [];
  let settingsExists = false;

  if (fs.existsSync(settingsPath)) {
    settingsExists = true;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.tools && settings.tools.bash && settings.tools.bash.hooks) {
        registeredHooks = settings.tools.bash.hooks;
      }
    } catch (error) {
      // Settings file exists but can't parse - treat as no registered hooks
    }
  }

  // Compare hooks
  const registered = hookFiles.filter(hook => registeredHooks.includes(hook));
  const unregistered = hookFiles.filter(hook => !registeredHooks.includes(hook));

  return {
    registered,
    unregistered,
    total: hookFiles.length,
    settingsExists
  };
}

/**
 * Get session history
 */
export function getSessionHistory(projectRoot, limit = 10) {
  const logPath = path.join(projectRoot, SESSION_LOG);
  if (!fs.existsSync(logPath)) {
    return { ok: true, sessions: [], total: 0 };
  }

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);

  // Group start/end entries by sessionId
  const sessionMap = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const existing = sessionMap.get(entry.sessionId) || {};
      sessionMap.set(entry.sessionId, { ...existing, ...entry });
    } catch (e) {
      continue;
    }
  }

  // Convert to array and sort by startedAt
  const allSessions = Array.from(sessionMap.values())
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);

  // Get hooks health status
  const hooksHealth = getHooksHealth(projectRoot);

  // Detect state conflicts using state file
  const currentState = readGuardState(projectRoot);
  const activeSession = getActiveSession(projectRoot);

  const warnings = [];
  let resolvedActiveSession = activeSession;

  // Check for legacy hooks.bak directory
  const hooksBakPath = path.join(projectRoot, HOOKS_BAK_DIR);
  if (fs.existsSync(hooksBakPath)) {
    warnings.push("Legacy hooks.bak/ directory found. Next guardrails toggle will clean it up.");
  }

  // Auto-close stale sessions: state file says active but session log says open
  if (activeSession && currentState.active !== false) {
    const recoveryEntry = {
      sessionId: activeSession.sessionId,
      endedAt: new Date().toISOString(),
      endReason: "auto_recovered",
      durationMs: Date.now() - new Date(activeSession.startedAt).getTime(),
      changesDetected: 0,
      changedFiles: [],
      newFiles: [],
      autoWorkflow: false,
      note: "Session auto-closed on status check - state file shows active but session was never ended",
    };
    appendSessionLog(projectRoot, recoveryEntry);

    const closedSession = { ...activeSession, ...recoveryEntry };
    sessionMap.set(activeSession.sessionId, closedSession);
    const idx = allSessions.findIndex(s => s.sessionId === activeSession.sessionId);
    if (idx >= 0) {
      allSessions[idx] = closedSession;
    }

    warnings.push(`Auto-closed stale session ${activeSession.sessionId.slice(0, 8)}: state file shows active, session marked as recovered.`);
    resolvedActiveSession = null;
  }

  return {
    ok: true,
    sessions: allSessions,
    total: sessionMap.size,
    activeSession: resolvedActiveSession,
    hooksHealth,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}
