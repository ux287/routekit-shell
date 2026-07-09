#!/usr/bin/env node

import fs from "fs";
import { execSync, spawnSync, spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { verifyHooksPresent, restoreHooksFromTemplate, canRestoreFromTemplate } from "./server/hooks-health.mjs";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  resolveProjectRoot,
  resolveNotesDir,
  readNote,
  readNoteRaw,
  writeNoteRaw,
  hasFrontmatter,
  frontmatterDefaults,
  formatWithFrontmatter,
  parseFrontmatter,
  validateNoteFrontmatter,
  canonicalIdFromFilename,
  findMatchingSchema,
  loadSchemaTemplate,
  mergeTemplateWithGenerated,
  updateField,
  updateFieldDirect,
} from "./dendron.mjs";
import { resolveKgKey } from "./project-context.mjs";
import { listTemplates } from "./templates.mjs";
import { runProjectInit } from "./project-init.mjs";
import { runRagEmbed, runRagInit, runRagQuery, runRagCompact, ensureRagIndex, runExhaustiveSearch } from "./rag/tools.mjs";
import { createCapabilityToken } from "./rag/capability-token.mjs";
import { AGENT_ROLES } from "./rag/capability-profiles.mjs";
import {
  runAnalyzeTool,
  runPlanTool,
  buildNoteDrivenSteps,
  classifyPlanStatus,
  findLatestRunDir,
} from "./server/planner.mjs";
import { reviewPlan } from "./server/plan-quality.mjs";
import {
  runExecTool,
  runApplyTool,
  runExecAbortTool,
  hasGitRepo,
  getCurrentBranch,
  assertCleanWorkingTree,
} from "./server/exec.mjs";
import {
  repoRoot,
  loadContext,
  simulateGuardrailPolicy,
  slugify,
  getBranchConfig,
  getWorkflowConfig,
} from "./server/project.mjs";
import { runGitBranch, runGitCommit, runGitMerge, runGitPR, runStagingMerge, runRelease, runSyncStaging, runResolveConflict, runShip, runGitCheckout, runBranchRepair } from "./server/git-tools.mjs";
import { runGitPush } from "./tools/git-push.mjs";
import { runGitPreflight, TOOL_NAME as GIT_PREFLIGHT_TOOL, TOOL_DESCRIPTION as GIT_PREFLIGHT_DESC, INPUT_SCHEMA as GIT_PREFLIGHT_SCHEMA } from "./tools/git-preflight.mjs";
import { guardrailsOff, guardrailsOn, getSessionHistory } from "./server/guardrails-audit.mjs";
import { publish, listProfiles, listRemotes } from "./server/publish.mjs";
import { runInterview } from "./server/interview.mjs";
import { runOnboarder } from "./server/onboarder.mjs";
import { advancePhase } from "./workflow/auto-phase.mjs";
import { commitAndEmbedNote } from "./shared/commit-and-embed-note.mjs";
import { runPreflight, hasPreflightChecks, readRksVersion, checkGitReadiness } from "./server/preflight.mjs";
import { getTelemetryCollector } from "./server/telemetry/collector.mjs";
import { ensureTelemetryStorage } from "./server/telemetry/index.mjs";
import { validateStory } from "./server/story-validator-v2.mjs";
import { runAgent } from "./agents/runner.mjs";
import { getAgent, getAgentByToolName, generateAgentToolDefinitions, listAgents, initProjectAgents } from "./agents/registry.mjs";
import { TOOL_NAME as GOVERNOR_INIT_TOOL, TOOL_DESCRIPTION as GOVERNOR_INIT_DESC, INPUT_SCHEMA as GOVERNOR_INIT_SCHEMA, handleGovernorInit } from "./tools/governor-init.mjs";
import { requireToken, isProtectedTool, unauthorizedResponse, validateToken, checkAllowedTool, touchSession, advanceState, advanceStateOnResult, getSession, getActiveChild, updateChildState, advanceToNextChild, setProjectRoot, detectOrphanedGuardrails, setPendingStash, clearPendingStash, createSession } from "./shared/governor-token.mjs";

// Resolve SELF_PROJECT_ID lazily: env var → .rks/project.json → throw.
// The CLI transitively imports this module; an eager throw blocks any verb
// launched from a CWD without identity. Cached after first successful call.
const _selfSrcDir = path.dirname(fileURLToPath(import.meta.url));
const _selfRepoRoot = path.resolve(_selfSrcDir, '..', '..', '..');
let _selfProjectIdCache;
export function getSelfProjectId() {
  if (_selfProjectIdCache !== undefined) return _selfProjectIdCache;
  const envId = process.env.ROUTEKIT_PROJECT_ID;
  if (envId && envId.trim()) {
    _selfProjectIdCache = envId.trim();
    return _selfProjectIdCache;
  }
  const rksPath = path.join(_selfRepoRoot, '.rks', 'project.json');
  try {
    const rks = JSON.parse(fs.readFileSync(rksPath, 'utf8'));
    if (rks.id) {
      _selfProjectIdCache = rks.id;
      return _selfProjectIdCache;
    }
  } catch (_) { /* fall through */ }
  throw new Error('[rks] Cannot determine SELF_PROJECT_ID: set ROUTEKIT_PROJECT_ID env var or ensure .rks/project.json has an id field');
}

// ── Auto-routing: Tool → Agent mapping ──────────────────────────────
// When an unauthorized call arrives for a protected tool, we auto-route
// it through the appropriate agent rather than rejecting. The agent
// executes server-side (no MCP round-trip), so the Dispatcher gets a
// result but the work went through proper orchestration.
//
// Tools not in this map fall back to the standard unauthorizedResponse().

/**
 * Maps raw MCP tool names to the agent + input transform that handles them.
 * Each entry: { agent: string, buildInput: (toolName, args) => agentInput }
 *
 * The agent name must match a key in the AGENTS registry (registry.mjs).
 * buildInput receives the original tool name and cleaned args (no _governorToken)
 * and returns the input payload the agent factory expects.
 */
const TOOL_TO_AGENT_MAP = {
  // ── Git tools → Git Agent (expects { projectId, request: string }) ──
  rks_git_state:        { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: 'Show current git status' }) },
  rks_git_branch:       { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `${a.type === 'delete' ? 'Delete' : 'Create'} branch${a.name ? ': ' + a.name : ''}${a.type ? ' (type: ' + a.type + ')' : ''}` }) },
  rks_checkout:         { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Checkout branch: ${a.branch || 'unknown'}${a.force ? ' (force)' : ''}` }) },
  rks_branch_repair:    { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Repair branch ${a.branch || 'current'} — reset to ${a.target || 'upstream'}${a.dryRun ? ' (dry run)' : ''}` }) },
  rks_git_commit:       { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Commit: ${a.message || 'no message'}${a.files ? ' files: ' + (Array.isArray(a.files) ? a.files.join(', ') : a.files) : ''}` }) },
  rks_git_merge:        { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Merge current branch into ${a.targetBranch || 'target'}${a.deleteBranch ? ' and delete source branch' : ''}` }) },
  rks_stash:            { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Stash ${a.action || 'push'}${a.message ? ': ' + a.message : ''}${a.includeUntracked ? ' (include untracked)' : ''}` }) },
  rks_reset:            { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Reset ${a.mode || 'mixed'} to ${a.target || 'HEAD'}` }) },
  rks_revert:           { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Revert commit ${a.commit || 'HEAD'}${a.noCommit ? ' (no auto-commit)' : ''}` }) },
  rks_tag:              { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Tag ${a.action || 'create'}: ${a.name || 'unnamed'}${a.message ? ' — ' + a.message : ''}${a.commit ? ' at ' + a.commit : ''}` }) },
  rks_cherry_pick:      { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Cherry-pick commit ${a.commit || 'unknown'}${a.noCommit ? ' (no auto-commit)' : ''}${a.abort ? ' (abort)' : ''}` }) },

  // ── Ship/merge tools → Ship Agent (expects { projectId, storyId?, title? }) ──
  // rks_ship is unprotected (governor-ship one-shot) — no agent routing needed
  rks_staging_pr:       { agent: 'ship', buildInput: (_t, a) => ({ projectId: a.projectId, storyId: a.problemId, title: a.title || 'Staging PR' }) },
  rks_staging_merge:    { agent: 'ship', buildInput: (_t, a) => ({ projectId: a.projectId, storyId: a.problemId, title: `Merge staging PR #${a.prNumber || '?'}` }) },
  // rks_story_ship is unprotected — deterministic workflow in story-ship.mjs, no agent routing needed
  rks_sync_staging:     { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Sync staging branch with remote. Strategy: ${a.strategy || 'auto'}` }) },
  rks_release:          { agent: 'ship', buildInput: (_t, a) => ({ projectId: a.projectId, title: `Release ${a.version || 'patch'}` }) },

  // ── Dendron tools → Dendron Agent (expects { projectId, request: string }) ──
  // dendron_create_note: auto-route bypasses the LLM and calls the verbatim
  // create helper directly (see autoRouteUnauthorized). buildInput forwards
  // the full args so the helper can write content byte-equal.
  // backlog.fix.dendron-agent-rewrites-content
  dendron_create_note:      { agent: 'dendron', directHandler: 'dendron_create_note', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), filename: a.filename, title: a.title, desc: a.desc, content: a.content, testFile: a.testFile, request: `Create note ${a.filename}${a.title ? ' — ' + a.title : ''}${a.desc ? ': ' + a.desc : ''}` }) },
  dendron_fix_frontmatter:  { agent: 'dendron', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), request: `Fix frontmatter for ${a.filename}` }) },
  dendron_validate_schema:  { agent: 'dendron', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), request: `Validate schema${a.pattern ? ' matching pattern: ' + a.pattern : ''}` }) },
  dendron_edit_note:        { agent: 'dendron', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), request: `Edit note ${a.filename}` }) },
  dendron_read_note:        { agent: 'dendron', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), request: `Read note ${a.filename}` }) },
  dendron_update_field:     { agent: 'dendron', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), request: `Update field '${a.field}' on ${a.filename} to ${typeof a.value === 'string' ? a.value : JSON.stringify(a.value)}` }) },
  dendron_mark_implemented: { agent: 'dendron', buildInput: (_t, a) => ({ projectId: a.projectId || getSelfProjectId(), request: `Mark ${a.filename} as implemented${a.commitId ? ' (commit: ' + a.commitId + ')' : ''}` }) },

  // ── Planning tools ──
  // rks_plan, rks_plan_review, rks_plan_ready are unprotected (direct execution by thin Governor)

      // ── Research tools → Research Agent ──
      rks_rag_query:      { agent: 'research', buildInput: (_t, a) => ({ projectId: a.projectId, query: a.q }) },
      rks_kg_query:       { agent: 'research', buildInput: (_t, a) => ({ projectId: a.projectId, query: `KG key: ${a.key || 'root'}` }) },
      // Governed exhaustive search — protected by default. An unauthorized (no-token)
      // call redirects to the evidence layer (RAG) just as raw Grep is redirected;
      // a governed (token-bearing) call runs the deterministic exhaustive search.
      rks_exhaustive_search: { agent: 'research', buildInput: (_t, a) => ({ projectId: a.projectId, query: a.pattern }) },

      // ── Visual tools → Visual Agent (expects { projectId, request: string }) ──
      rks_agent_visual:   { agent: 'visual', buildInput: (_t, a) => ({ projectId: a.projectId, request: a.request || 'Perform visual QA check' }) },

  // ── Story tools → Story Agent (expects { projectId, storyId, action }) ──
  rks_validate_story: { agent: 'story', buildInput: (_t, a) => ({ projectId: a.projectId, storyId: a.problemId, action: 'validate' }) },
  // rks_story_create is unprotected (direct execution) — no agent routing needed

  // ── Recovery tools → Recovery Agent (expects { projectId, symptoms? }) ──
  rks_resolve_conflict: { agent: 'recovery', buildInput: (_t, a) => ({ projectId: a.projectId, symptoms: `Merge conflict — strategy: ${a.strategy || 'theirs'}` }) },

  // ── Cycle-complete tools → Cycle Complete Agent (expects { projectId, storyId }) ──
  rks_cycle_complete: { agent: 'cycle-complete', buildInput: (_t, a) => ({ projectId: a.projectId, storyId: a.problemId || a.storyId || 'unknown' }) },
};

/**
 * Auto-route an unauthorized tool call through the appropriate agent.
 *
 * Instead of returning a rejection, we find the agent best suited to handle
 * the tool, build the right input payload, and run it server-side.
 * The result is returned in standard MCP tool response format.
 *
 * @param {string} tool - The protected tool that was called without token
 * @param {object} cleanArgs - Tool arguments (already stripped of _governorToken)
 * @returns {Promise<object|null>} MCP response if auto-routed, null if no mapping exists
 */
async function autoRouteUnauthorized(tool, cleanArgs) {
  const mapping = TOOL_TO_AGENT_MAP[tool];
  if (!mapping) {
    return null; // No mapping — caller should fall back to unauthorizedResponse
  }

  const { agent: agentName, buildInput, directHandler } = mapping;
  const agentFactory = getAgent(agentName);
  if (!agentFactory) {
    return null; // Agent not found in registry — fall back
  }

  const projectId = cleanArgs.projectId || cleanArgs.id || 'unknown';

  // Emit telemetry for the auto-route event
  try {
    getTelemetryCollector().emit('auth.auto_route.started', projectId, {
      tool,
      agent: agentName,
      reason: 'Unauthorized direct call — auto-routed through agent',
    });
  } catch { /* telemetry is best-effort */ }

  // backlog.fix.dendron-agent-rewrites-content: certain tools bypass the LLM
  // agent entirely so caller content can never be paraphrased. Direct-handler
  // path produces byte-equal on-disk content; auto-route MUST be parity.
  if (directHandler === 'dendron_create_note') {
    try {
      const result = await executeDendronCreateNoteVerbatim(cleanArgs);
      try {
        getTelemetryCollector().emit('auth.auto_route.complete', projectId, {
          tool,
          agent: agentName,
          ok: result.ok !== false,
          wrote_verbatim: result.wrote_verbatim === true,
        });
      } catch { /* best-effort */ }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            _autoRouted: {
              originalTool: tool,
              routedToAgent: agentName,
              reason: 'Unauthorized direct call — verbatim helper (no LLM)',
            },
          }, null, 2),
        }],
      };
    } catch (err) {
      try {
        getTelemetryCollector().emit('auth.auto_route.failed', projectId, {
          tool,
          agent: agentName,
          error: err.message || String(err),
        });
      } catch { /* best-effort */ }
      return null;
    }
  }

  try {
    const agentInput = buildInput(tool, cleanArgs);
    const context = await loadContext(projectId);
    const config = agentFactory({ ...agentInput, projectRoot: context.record.root });
    const result = await runAgent(config);

    // Emit success telemetry
    try {
      getTelemetryCollector().emit('auth.auto_route.complete', projectId, {
        tool,
        agent: agentName,
        ok: result.ok !== false,
        telemetryId: result.telemetryId,
      });
    } catch { /* best-effort */ }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...result,
          _autoRouted: {
            originalTool: tool,
            routedToAgent: agentName,
            reason: 'Unauthorized direct call — auto-routed through agent',
          },
        }, null, 2),
      }],
    };
  } catch (err) {
    // Auto-routing failed — emit telemetry and return null to fall back
    try {
      getTelemetryCollector().emit('auth.auto_route.failed', projectId, {
        tool,
        agent: agentName,
        error: err.message || String(err),
      });
    } catch { /* best-effort */ }

    return null; // Fall back to unauthorizedResponse
  }
}

/**
 * Verbatim dendron_create_note helper — shared by direct handler and auto-route.
 * Guarantees on-disk body is byte-equal to caller's `content` (frontmatter merged
 * if caller embedded one). Returns the inner response payload (the MCP wrapper
 * is the caller's responsibility).
 *
 * backlog.fix.dendron-agent-rewrites-content
 */
async function executeDendronCreateNoteVerbatim(args) {
  const input = createNoteSchema.parse(args);
  const { notesDir } = getDendronContext();
  assertNotesDir(notesDir);
  const notePath = notePathFromFilename(notesDir, input.filename);
  if (fs.existsSync(notePath)) {
    throw new McpError(ErrorCode.InvalidRequest, `Note already exists: ${path.relative(notesDir, notePath)}`);
  }
  const id = canonicalIdFromFilename(input.filename);
  const generated = frontmatterDefaults({ id, title: input.title || null, desc: input.desc || null });
  if (input.filename.startsWith("backlog.") && !input.filename.includes("z_implemented") && !input.filename.includes("z_archive")) {
    generated.phase = "draft";
  }
  if (input.testFile) {
    generated.testFile = input.testFile;
  }
  let bodyContent = input.content || "";
  if (hasFrontmatter(bodyContent)) {
    const contentParsed = parseFrontmatter(bodyContent);
    bodyContent = contentParsed.content || "";
    Object.assign(generated, contentParsed.data || {});
  }
  const verifyNoteOnDisk = () => {
    if (!fs.existsSync(notePath)) {
      return { ok: false, error: `post-write verification failed — file not present on disk: ${path.relative(notesDir, notePath)}` };
    }
    let size;
    try {
      size = fs.statSync(notePath).size;
    } catch (err) {
      return { ok: false, error: `post-write verification failed — stat error: ${err?.message || String(err)}` };
    }
    if (size === 0) {
      return { ok: false, error: `post-write verification failed — file is empty: ${path.relative(notesDir, notePath)}` };
    }
    return { ok: true };
  };
  const schema = findMatchingSchema(notesDir, input.filename);
  if (schema && schema.template) {
    const tpl = loadSchemaTemplate(notesDir, schema.template);
    if (tpl) {
      const { merged, body } = mergeTemplateWithGenerated({ generated, templateParsed: tpl.parsed, content: bodyContent, id });
      writeNoteRaw(notePath, formatWithFrontmatter(merged, body));
      const verify = verifyNoteOnDisk();
      if (!verify.ok) return verify;
      return { ok: true, path: path.relative(notesDir, notePath), id, schema: schema.id, wrote_verbatim: true };
    }
  }
  writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent));
  const verify = verifyNoteOnDisk();
  if (!verify.ok) return verify;
  return { ok: true, path: path.relative(notesDir, notePath), id, wrote_verbatim: true };
}

export { executeDendronCreateNoteVerbatim };

/**
 * Derive a `docs(<scope>): <action> <noteId>` commit message from the tool name
 * and note id. backlog.fix.dendron-writes-no-auto-commit AC2 + testReq #6.
 */
function buildDendronCommitMessage(tool, noteId) {
  const id = String(noteId || "");
  let scope;
  if (id.startsWith("research.")) scope = "research";
  else if (id.startsWith("backlog.")) scope = "backlog";
  else if (id.startsWith("canon.")) scope = "canon";
  else if (id.startsWith("memories.")) scope = "memory";
  else scope = "notes";
  const action = {
    dendron_create_note: "create",
    dendron_edit_note: "edit",
    dendron_update_field: "update",
    dendron_fix_frontmatter: "fix",
    dendron_mark_implemented: "implement",
  }[tool] || "update";
  return `docs(${scope}): ${action} ${id}`;
}

/**
 * Wrap a dendron-tool inner result (the JSON payload, not the MCP wrapper)
 * with the auto-commit step. Returns the merged result that the caller wraps
 * in MCP { content: [...] }. backlog.fix.dendron-writes-no-auto-commit AC7.
 *
 * @param {object} args
 * @param {string} args.tool          - MCP tool name (for commit-message scope)
 * @param {object} args.innerResult   - { ok, path, id, ... } from the handler
 * @param {boolean} args.skipCommit   - Caller opt-out
 * @param {string[]} [args.extraStagePaths] - Additional paths to `git add` (e.g.
 *                                            old path for mark_implemented rename)
 */
async function commitDendronWriteResult({ tool, innerResult, skipCommit, extraStagePaths }) {
  if (!innerResult || innerResult.ok === false) {
    return { ...innerResult, writeOk: false, commitOk: false };
  }
  if (skipCommit) {
    return { ...innerResult, writeOk: true, commitOk: false, skipCommit: true };
  }
  try {
    const { projectRoot, notesDir } = getDendronContext();
    const relNotePath = innerResult.path; // already relative-to-notesDir
    const absNotePath = path.join(notesDir, relNotePath);
    const relFromRoot = path.relative(projectRoot, absNotePath);
    if (Array.isArray(extraStagePaths)) {
      for (const extra of extraStagePaths) {
        try { execSync(`git add ${JSON.stringify(extra)}`, { cwd: projectRoot, stdio: "pipe" }); } catch { /* best-effort */ }
      }
    }
    const commitMessage = buildDendronCommitMessage(tool, innerResult.id);
    const start = Date.now();
    const commitResult = await commitAndEmbedNote({
      projectRoot,
      notePath: relFromRoot,
      commitMessage,
    });
    const durationMs = Date.now() - start;
    try {
      if (commitResult.commitOk) {
        getTelemetryCollector().emit("dendron.auto_commit", "routekit-shell-core", {
          tool,
          noteId: innerResult.id,
          commitSha: commitResult.commitId,
          durationMs,
        });
      } else if (commitResult.commitError) {
        getTelemetryCollector().emit("dendron.auto_commit_failed", "routekit-shell-core", {
          tool,
          noteId: innerResult.id,
          phase: "commit",
          errorMessage: commitResult.commitError,
        });
      }
    } catch { /* telemetry best-effort */ }
    const merged = {
      ...innerResult,
      writeOk: true,
      commitOk: commitResult.commitOk === true,
    };
    if (commitResult.commitId) merged.commitId = commitResult.commitId;
    if (commitResult.commitError) merged.commitError = commitResult.commitError;
    if (commitResult.idempotent) merged.idempotent = true;
    if (commitResult.ragEmbedWarning) merged.ragEmbedWarning = commitResult.ragEmbedWarning;
    return merged;
  } catch (err) {
    return { ...innerResult, writeOk: true, commitOk: false, commitError: err?.message || String(err) };
  }
}

/**
 * Sanitize tool arguments for audit logging (strip secrets, truncate large values).
 */
function sanitizeToolArgs(args) {
  if (!args || typeof args !== "object") return {};
  const sanitized = { ...args };
  const sensitiveKeys = ["token", "secret", "password", "apiKey", "api_key", "credentials"];
  for (const key of sensitiveKeys) {
    if (key in sanitized) sanitized[key] = "[REDACTED]";
  }
  for (const [key, val] of Object.entries(sanitized)) {
    if (typeof val === "string" && val.length > 200) {
      sanitized[key] = val.slice(0, 200) + "...[truncated]";
    }
  }
  return sanitized;
}

import { runRefineTool, runRefineApplyTool } from "./server/refine.mjs";
import { runPlanReadyTool } from "./server/plan-ready.mjs";

const projectGetSchema = z.object({ id: z.string() });
const analyzeSchema = z.object({ projectId: z.string() });
const planSchema = z.object({
  projectId: z.string(),
  task: z.string().optional().nullable(),
  problemId: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  autoEmbed: z.boolean().optional().default(true),
});
const planReviewSchema = z.object({
  projectId: z.string(),
  label: z.string().optional().nullable(),
  problemId: z.string().optional().nullable(),
});
function getPollHintMs(elapsedSeconds) {
  if (elapsedSeconds < 30) return 2000;
  if (elapsedSeconds < 60) return 5000;
  if (elapsedSeconds < 120) return 15000;
  return 30000;
}
const planReadySchema = z.object({
  projectId: z.string(),
  problemId: z.string(),
});
const execSchema = z.object({
  projectId: z.string(),
  label: z.string().optional(),
  skipTests: z.boolean().optional().default(false),
  autoCommit: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});

// ── Pending Plans Map ──────────────────────────────────────────────
// Stores in-flight plan promises so rks_plan can return immediately
// and rks_plan_review can poll for completion.
// Key: "projectId:problemId" or "projectId:task-slug"
// Value: { promise: Promise, startedAt: number, result?: object, error?: string }
const pendingPlans = new Map();

// ── Pending Plan Disk Persistence ────────────────────────────────
// The MCP server process can restart during async plan generation,
// clearing the in-memory pendingPlans Map. To survive restarts:
// - rks_plan writes a marker file when starting async generation
// - rks_plan_review checks the marker when no in-memory entry found
// - The marker is removed when the plan completes or fails
const PENDING_PLAN_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getPendingPlanPath(projectRoot) {
  return path.join(projectRoot, ".rks", "pending-plan.json");
}

function writePendingPlanMarker(projectRoot, { planKey, projectId, problemId, startedAt, pid }) {
  try {
    const filePath = getPendingPlanPath(projectRoot);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ planKey, projectId, problemId, startedAt, pid: pid || process.pid }, null, 2));
  } catch { /* best-effort */ }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPendingPlanMarker(projectRoot) {
  try {
    const filePath = getPendingPlanPath(projectRoot);
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data?.planKey || !data?.startedAt) return null;
    // Expire stale markers
    if (Date.now() - data.startedAt > PENDING_PLAN_MAX_AGE_MS) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return data;
  } catch { return null; }
}

function removePendingPlanMarker(projectRoot) {
  try {
    const filePath = getPendingPlanPath(projectRoot);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best-effort */ }
}

const guardrailSimSchema = z.object({ projectId: z.string(), label: z.string().optional().nullable() });
const applySchema = z.object({ projectId: z.string(), label: z.string().optional() });
const kgQuerySchema = z.object({ projectId: z.string(), key: z.string().optional() });
const templatesListSchema = z.object({ prefix: z.string().optional() });
const stashSchema = z.object({
  projectId: z.string(),
  action: z.enum(['save', 'list', 'apply', 'pop', 'drop']).optional().default('save'),
  message: z.string().optional(),
  stashIndex: z.number().optional(),
  includeUntracked: z.boolean().optional().default(false)
});

const restoreSchema = z.object({
  projectId: z.string(),
  files: z.union([z.string(), z.array(z.string())]),
  staged: z.boolean().optional().default(false),
  source: z.string().optional()
});

const cycleCompleteSchema = z.object({
  projectId: z.string()
});

const promoteSchema = z.object({
  projectId: z.string(),
  from: z.string().optional().describe("Source branch (defaults to current branch)"),
  to: z.string().optional().describe("Target branch (defaults to integration branch from config)"),
  push: z.boolean().optional().default(true).describe("Push target branch after merge")
});

const resetSchema = z.object({
  projectId: z.string(),
  mode: z.enum(['soft', 'mixed', 'hard']).optional().default('mixed'),
  target: z.string().optional().default('HEAD'),
  confirm: z.boolean().optional().default(false)
});

const revertSchema = z.object({
  projectId: z.string(),
  commit: z.string(),
  noCommit: z.boolean().optional().default(false)
});

const tagSchema = z.object({
  projectId: z.string(),
  action: z.enum(['list', 'create', 'delete']).optional().default('list'),
  name: z.string().optional(),
  message: z.string().optional(),
  commit: z.string().optional(),
  pattern: z.string().optional()
});

const cherryPickSchema = z.object({
  projectId: z.string(),
  commit: z.string().optional(),
  noCommit: z.boolean().optional().default(false),
  abort: z.boolean().optional().default(false)
});
const publishSchema = z.object({
  projectId: z.string(),
  remote: z.string(),
  profile: z.string().optional(),
  branch: z.string().optional(),
  dryRun: z.boolean().optional(),
  message: z.string().optional(),
});
const publishProfilesSchema = z.object({
  projectId: z.string(),
});

const projectInitSchema = z.object({
  projectId: z.string(),
  id: z.string(),
  stack: z.string(),
  path: z.string(),
  apply: z.boolean().optional(),
  register: z.boolean().optional(),
});
const rksInitSchema = z.object({
  projectName: z.string(),
  parentDir: z.string().optional(),
  dev: z.boolean().optional(),
});
const ragInitSchema = z.object({ projectId: z.string() });
const ragEmbedSchema = z.object({ projectId: z.string(), glob: z.string().optional() });
const ragQuerySchema = z.object({
  projectId: z.string(),
  q: z.string(),
  k: z.number().int().positive().max(20).optional(),
  role: z.enum(["scout", "planner", "executor", "auditor"]).optional(),
});
const ragCompactSchema = z.object({ projectId: z.string() });
const gitStateSchema = z.object({ projectId: z.string() });
const refineSchema = z.object({
  projectId: z.string(),
  problemId: z.string(),
  trigger: z.enum(["plan_failed", "plan_rejected", "exec_failed", "test_failed", "design"]).optional(),
  context: z.string().optional(),
});
const refineApplySchema = z.object({
  projectId: z.string(),
  problemId: z.string(),
  refinements: z.array(z.object({
    type: z.enum(["add_target_files", "add_code_snippet", "add_test_exemplar", "clarify_ac", "decompose", "fix_target_files", "add_test_requirements", "upgrade_target_files_format", "add_search_pattern", "create_file_directive", "acknowledge_multi_file", "acknowledge_destructive_rewrite"]),
    data: z.any().optional(),
  })),
});
const validateStorySchema = z.object({
  projectId: z.string(),
  problemId: z.string(),
});
const gitBranchSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  type: z.enum(["feature", "fix", "refactor", "docs", "chore", "rks"]).default("feature"),
});
const checkoutSchema = z.object({
  projectId: z.string(),
  branch: z.string(),
  force: z.boolean().optional().default(false),
});
const branchRepairSchema = z.object({
  projectId: z.string(),
  branch: z.string(),
  target: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});
const stagingPrSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  targetBranch: z.string().optional(),
  autoMerge: z.boolean().optional().default(false),
  problemId: z.string().optional(),
  reason: z.enum(["hotfix", "docs-only", "infrastructure", "off-rail"]).optional(),
});
const gitCommitSchema = z.object({
  projectId: z.string(),
  message: z.string(),
  scope: z.string().optional(),
  type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test"]).default("feat"),
  files: z.array(z.string()).optional(),
});
const gitPushSchema = z.object({
  projectId: z.string(),
  branch: z.string().optional(),
});
const gitMergeSchema = z.object({
  projectId: z.string(),
  targetBranch: z.string().optional(),
  deleteBranch: z.boolean().default(false),
});
const stagingMergeSchema = z.object({
  projectId: z.string(),
  prNumber: z.number().optional(),
  problemId: z.string().optional(),
  reason: z.enum(["hotfix", "docs-only", "infrastructure", "off-rail"]).optional(),
});
const gitPRSchema = z.object({
  projectId: z.string(),
  targetBranch: z.string().optional(),
  title: z.string().optional(),
  problemId: z.string().optional(),
  summary: z.string().optional(),
  autoMerge: z.boolean().default(true),
  squash: z.boolean().default(true),
});
const shipSchema = z.object({
  projectId: z.string(),
  message: z.string().describe("Commit message (without type prefix)"),
  scope: z.string().optional().describe("Optional scope for commit"),
  type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test"]).default("feat"),
  files: z.array(z.string()).optional().describe("Specific files to commit (all if omitted)"),
  branchName: z.string().optional().describe("Branch name (auto-generated if omitted)"),
  branchType: z.enum(["feature", "fix", "refactor", "docs", "chore"]).default("feature"),
  prTitle: z.string().optional().describe("PR title (auto-generated if omitted)"),
  problemId: z.string().optional().describe("Backlog story ID to mark as implemented"),
});
const onboarderSchema = z.object({
  projectId: z.string(),
  stage: z.enum(["welcome", "expectations", "stance", "first_story", "first_build", "first_ship", "next_steps"]).optional(),
  responses: z.record(z.unknown()).optional(),
  skipTour: z.boolean().optional(),
  skipStage: z.boolean().optional(),
  bounce: z.boolean().optional(),
  resume: z.boolean().optional(),
  reset: z.boolean().optional(),
});

const interviewSchema = z.object({
  projectId: z.string(),
  responses: z.object({
    project_type: z.string().optional(),
    one_liner: z.string().optional(),
    tech_stack: z.string().optional(),
    github_setup: z.string().optional(),
  }).optional(),
  reset: z.boolean().optional(),
});
const governorInitSchema = z.object({
  projectId: z.string(),
  problemId: z.string().optional(),
  flowType: z.enum(["story", "open", "qa", "ship", "ops"]).optional(),
});

const guardrailsOffSchema = z.object({
  projectId: z.string(),
  reason: z.string(),
  scope: z.enum(["all", "write", "read"]).optional(),
  problemId: z.string().optional(), // Links to story for scoped writes; if null, session is read-only for code
});
const guardrailsOnSchema = z.object({
  projectId: z.string(),
});
const guardrailsStatusSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
});
const telemetryQuerySchema = z.object({
  projectId: z.string(),
  type: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  correlationId: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  format: z.enum(["json", "summary"]).optional(),
  since: z.string().optional(),
  lastNCycles: z.number().int().positive().optional(),
});

const telemetryReportSchema = z.object({
  projectId: z.string(),
  reportType: z.enum(["summary", "failures", "trends"]).default("summary"),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  since: z.string().optional(),
  lastNCycles: z.number().int().positive().optional(),
});
const telemetryAnalysisSchema = z.object({
  projectId: z.string(),
  correlationId: z.string().optional(),
  eventId: z.string().optional(),
  runId: z.string().optional(),
});

const tokenCostReportSchema = z.object({
  projectId: z.string(),
  scope: z.enum(["story", "commit"]).default("story"),
  storyId: z.string().optional(),
  commitSha: z.string().optional(),
  format: z.enum(["json", "markdown", "summary"]).default("json"),
});

const telemetryExportSchema = z.object({
  projectId: z.string(),
  storyId: z.string().optional(),
  outDir: z.string().optional(),
});

const fetchRawSchema = z.object({
  projectId: z.string(),
  url: z.string(),
  timeoutMs: z.number().optional(),
  maxBytes: z.number().optional(),
});

const createNoteSchema = z.object({
  filename: z.string(),
  title: z.string().optional(),
  desc: z.string().optional(),
  content: z.string().optional(),
  testFile: z.string().optional(),
});
const fixFrontmatterSchema = z.object({ filename: z.string() });
const readNoteSchema = z.object({ filename: z.string() });
const validateSchemaSchema = z.object({ pattern: z.string().optional() });
const editNoteSchema = z.object({ filename: z.string(), patches: z.array(z.object({ search: z.string(), replace: z.string() })) });
const updateFieldSchema = z.object({ filename: z.string(), field: z.string(), value: z.union([z.string(), z.array(z.unknown())]) });
const markImplementedSchema = z.object({ filename: z.string(), commitId: z.string().optional() });

function getDendronContext() {
  const projectRoot = resolveProjectRoot();
  const notesDir = resolveNotesDir(projectRoot);
  return { projectRoot, notesDir };
}

function assertNotesDir(notesDir) {
  if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) {
    throw new McpError(ErrorCode.InvalidRequest, `notes directory not found: ${notesDir}`);
  }
}

function notePathFromFilename(notesDir, filename) {
  const safe = String(filename || "").trim();
  if (!safe || safe.includes("..") || safe.includes("/") || safe.includes("\\")) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid filename: ${filename}`);
  }
  return path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
}

// Composition root: build and return a fully-configured MCP server WITHOUT
// connecting it or running any boot-time side effects. Importing this module is
// side-effect-free; startServer() (below) performs the actual boot. Tests can
// construct a server instance here with no vi.resetModules / re-import dance.
// NOTE: the handler/registration body below is intentionally left at its prior
// indentation for a minimal, reviewable Stage-1 diff; later stages extract these
// into per-family registerXTools(server, deps) modules and re-indent.
export function createServer() {
const server = new Server(
  {
    name: "routekit-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {
        rks_approve: {
          name: "rks_approve",
          description: "Approve or reject a guardrail-critical plan after review.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Project identifier" },
              planId: { type: "string", description: "Plan ID from needs_approval response" },
              confirm: { type: "boolean", description: "true to approve, false to reject" },
              reason: { type: "string", description: "Optional reason (required for rejection)" }
            },
            required: ["projectId", "planId", "confirm"]
          }
        },
        rks_telemetry_analysis: {
          name: "rks_telemetry_analysis",
          description: "Analyze telemetry failures: categorize root cause, provide actionable suggestions.",
          inputSchema: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Project identifier" },
              correlationId: { type: "string", description: "Optional correlation identifier" },
              eventId: { type: "string", description: "Optional event identifier" },
              runId: { type: "string", description: "Optional run identifier" }
            },
            required: ["projectId"]
          }
        },
        rks_init: {
          name: "rks_init",
          description: "Create a new RKS project from base template",
          inputSchema: {
            type: "object",
            properties: {
              projectName: { type: "string", description: "Name of the project (becomes directory name)" },
              parentDir: { type: "string", description: "Parent directory (default: ..)" }
            },
            required: ["projectName"]
          }
        }
      },
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "rks_project_get",
      description: "Get project metadata, project.json, and KG for a projectId.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "rks_kg_query",
      description: "Resolve a dot-notation key from a project's KG.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          key: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_analyze",
      description: "Scan src/ + KG and write a codemap for the project.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
    {
      name: "rks_plan",
      description: "Generate a plan from a backlog item (problemId) or free-text task. Returns structured JSON with runId, planPath, and steps.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Backlog item ID (e.g., backlog.foo.bar)" },
          task: { type: "string", description: "Free-text task description (alternative to problemId)" },
          label: { type: "string", description: "Optional label for the run slug" },
          autoEmbed: { type: "boolean", description: "Auto-embed when RAG is stale (default: true)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_plan_review",
      description: "Validate plan quality. Checks for destructive edits (edit_file on large files) and semantic preservation (missing exports/imports). Returns errors, warnings, and suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier" },
          label: { type: "string", description: "Plan slug/label (uses latest if omitted)" },
          problemId: { type: "string", description: "Story ID — used to find correct run directory after server restart" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_preflight",
      description: "Validate project prerequisites before running rks workflow. Checks project attached, notes dir exists, RAG initialized, API key set, GitHub remote configured.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_plan_ready",
      description: "Validate story readiness before planning. Checks targetFiles exist, SEARCH patterns are verbatim and unique. Returns issues list for refinement.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Backlog item ID to validate (e.g., backlog.foo.bar)" },
        },
        required: ["projectId", "problemId"],
      },
    },
    {
      name: "rks_validate_story",
      description: "Validate story readiness with quality/completeness scoring. Returns structured verdict with per-project thresholds and RAG benchmarking against similar implemented stories.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Backlog item ID to validate (e.g., backlog.foo.bar)" },
        },
        required: ["projectId", "problemId"],
      },
    },
    {
      name: "rks_exec",
      description: "Execute a plan: create git branch and apply plan steps. Runs tests before/after by default. Respects guardrail levels (guardrail-critical blocks execution).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          label: { type: "string", description: "Plan slug/label to execute (uses latest if omitted)" },
          skipTests: { type: "boolean", description: "Skip running tests before and after apply" },
          autoCommit: { type: "boolean", description: "Commit changes even when tests are skipped (default: false)" },
          dryRun: { type: "boolean", description: "Preview changes without applying them (default: false)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_exec_abort",
      description: "Abort an incomplete exec run and clean up state. Use when exec fails mid-execution.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          reason: { type: "string", description: "Optional reason for aborting" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_apply",
      description: "Pure file application: apply plan steps without git operations. Use this in CI or when git is managed separately.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          label: { type: "string", description: "Plan slug/label to apply (uses latest if omitted)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_approve",
      description: "Approve or reject a guardrail-critical plan after review.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier" },
          planId: { type: "string", description: "Plan ID from needs_approval response" },
          confirm: { type: "boolean", description: "true to approve, false to reject" },
          reason: { type: "string", description: "Optional reason (required for rejection)" },
        },
        required: ["projectId", "planId", "confirm"],
      },
    },
    {
      name: "rks_guardrails_simulate",
      description: "Report guardrail policy coverage and scenario matching for a label.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          label: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_templates_list",
      description: "List stack templates (stackId, displayName, description, official flag, kg path).",
      inputSchema: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description: "Optional stackId prefix filter",
          },
        },
      },
    },
    {
      name: "rks_project_init",
      description: "Scaffold a new Routekit project from a stack template (dry-run by default).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          id: { type: "string", description: "New project id/slug" },
          stack: { type: "string", description: "Stack template id" },
          path: { type: "string", description: "Absolute or relative target path" },
          apply: { type: "boolean", description: "Set true to apply scaffold" },
          register: {
            type: "boolean",
            description: "Append to projects/index.jsonl after creation (requires apply=true)",
          },
        },
        required: ["projectId", "id", "stack", "path"],
      },
    },
    {
      name: "rks_story_create",
      description: "Create a backlog story with optional template. Templates provide boilerplate targetFiles, structure, and acceptance criteria.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          name: { type: "string", description: "Story name (will be prefixed with backlog.feat.)" },
          title: { type: "string", description: "Human-readable title" },
          desc: { type: "string", description: "Brief description" },
          template: { type: "string", description: "Template name: react-component, api-endpoint, cli-command" },
        },
        required: ["projectId", "name"],
      },
    },
    {
      name: "rks_rag_init",
      description: "Initialize the LanceDB database for a project's note embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_rag_embed",
      description: "Embed project notes into the LanceDB database (skips z_archive.* automatically). Pass files array for incremental updates.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          files: { type: "array", items: { type: "string" }, description: "Specific files to re-embed (incremental update)" },
          glob: {
            type: "string",
            description: "Optional glob override for selecting notes",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_rag_query",
      description: "Query the LanceDB embeddings and return the top-k matching note chunks.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          q: { type: "string" },
          k: {
            type: "number",
            description: "Optional number of results (default 5, max 20)",
          },
          role: {
            type: "string",
            enum: ["scout", "planner", "executor", "auditor"],
            description: "Agent role for capability-based fidelity filtering. Scout=L0 metadata, Planner=L2 redacted, Executor=L1 abstracted, Auditor=L3 full.",
          },
        },
        required: ["projectId", "q"],
      },
    },
    {
      name: "rks_exhaustive_search",
      description: "Governed, deterministic, EXHAUSTIVE literal search over a scoped path. Returns every cited file:line match (verbatim text + git-state anchor) — the precision complement to the semantic rks_rag_query for completeness checks. Protected: requires a Governor session token; bounded: a scoped 'path' is required.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          pattern: { type: "string", description: "Literal string to search for." },
          path: { type: "string", description: "Scoped path under the project root to search within (REQUIRED — searches are bounded, never repo-wide)." },
          countOnly: { type: "boolean", description: "Bounded mode: return filenames + match counts only, without full match text." },
          maxResults: { type: "number", description: "Cap on returned hits (default 1000)." },
        },
        required: ["projectId", "pattern", "path"],
      },
    },
    {
      name: "rks_rag_compact",
      description: "Compact LanceDB to reclaim disk space from transaction logs and deletions.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_git_state",
      description: "Get git state (branch, clean, ahead/behind) for informed workflow decisions.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_git_branch",
      description: "Create a feature branch following naming conventions. Validates branch name and ensures clean working tree.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          name: { type: "string", description: "Branch name (without type prefix)" },
          type: { type: "string", enum: ["feature", "fix", "refactor", "docs", "chore", "rks"], description: "Branch type prefix (default: feature)" },
        },
        required: ["projectId", "name"],
      },
    },
    {
      name: "rks_checkout",
      description: "Switch to an existing branch. Use rks_git_branch to create new branches.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          branch: { type: "string", description: "Branch name to switch to" },
          force: { type: "boolean", description: "Force checkout even with local changes (discards changes)" },
        },
        required: ["projectId", "branch"],
      },
    },
    {
      name: "rks_branch_repair",
      description: "Repair branch state by resetting to remote. Use when a branch has unwanted commits.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          branch: { type: "string", description: "Branch to repair" },
          target: { type: "string", description: "Reset target (default: origin/<branch>)" },
          dryRun: { type: "boolean", description: "Preview changes without applying" },
          confirm: { type: "boolean", description: "Required to actually reset" },
        },
        required: ["projectId", "branch"],
      },
    },
    {
      name: "rks_staging_pr",
      description: "Create a pull request for staging changes using git tools (no auto-merge).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          title: { type: "string", description: "PR title" },
          targetBranch: { type: "string", description: "Target branch for PR (default: staging)" },
          autoMerge: { type: "boolean", description: "Enable automatic merge after PR (default: false)", default: false },
          problemId: { type: "string", description: "Backlog story ID - auto-marks as implemented before PR creation" },
          reason: { type: "string", enum: ["hotfix", "docs-only", "infrastructure", "off-rail"], description: "Required when problemId is omitted - justification for unlinked PR" }
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_review",
      description: "Run agent-based code review on current branch. Spawns a separate reviewer with isolated context (diff + story + RAG only) to evaluate changes before merge.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Backlog story ID (for AC coverage checking)" },
          targetBranch: { type: "string", description: "Branch to diff against (default: staging)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_agent_external_research",
      description: "Run external web research with structured output. Searches the web via provider APIs, synthesizes results using LLM, and returns a contract-validated answer with sources.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          query: { type: "string", description: "Research query (min 5 characters)" },
          maxSources: { type: "number", description: "Maximum sources to retrieve (default: 10, max: 20)" },
          provider: { type: "string", enum: ["brave"], description: "Search provider (default: brave)" },
        },
        required: ["projectId", "query"],
      },
    },
    {
      name: "rks_sync_staging",
      description: "Sync staging branch with origin before merge/release. Handles diverged branches via rebase or merge.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          strategy: { type: "string", enum: ["auto", "rebase", "merge"], description: "Sync strategy (default: auto)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_resolve_conflict",
      description: "Resolve merge/rebase conflicts with ours/theirs/abort strategy.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          strategy: { type: "string", enum: ["ours", "theirs", "abort"], description: "Resolution strategy (default: theirs)" },
          files: { type: "array", items: { type: "string" }, description: "Specific files to resolve (optional, defaults to all)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_release",
      description: "Release staging to main with version bump, changelog, and tag. Transitions integrated stories to released.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          version: { type: "string", enum: ["patch", "minor", "major"], description: "Version bump type (default: patch)" },
          changelog: { type: "string", description: "Release notes (optional)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_staging_merge",
      description: "Merge a PR to staging (squash merge, delete branch). Updates backlog status if problemId provided.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          prNumber: { type: "number", description: "PR number to merge (uses current branch PR if omitted)" },
          problemId: { type: "string", description: "Backlog problem ID to mark as implemented" },
          reason: { type: "string", enum: ["hotfix", "docs-only", "infrastructure", "off-rail"], description: "Required when problemId is omitted - justification for unlinked merge" }
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_git_commit",
      description: "Stage and commit changes with conventional commit format. Auto-appends Co-Authored-By.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          message: { type: "string", description: "Commit message (without type prefix)" },
          scope: { type: "string", description: "Optional scope (e.g., backlog, planner)" },
          type: { type: "string", enum: ["feat", "fix", "refactor", "docs", "chore", "test"], description: "Commit type (default: feat)" },
          files: { type: "array", items: { type: "string" }, description: "Specific files to commit (all if omitted)" },
        },
        required: ["projectId", "message"],
      },
    },
    {
      name: "rks_git_push",
      description: "Push a branch to origin remote. Defaults to current branch if not specified.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          branch: { type: "string", description: "Branch to push (defaults to current branch)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: GIT_PREFLIGHT_TOOL,
      description: GIT_PREFLIGHT_DESC,
      inputSchema: GIT_PREFLIGHT_SCHEMA,
    },
    {
      name: "rks_git_merge",
      description: "Merge current branch to target branch. Detects conflicts and aborts gracefully.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          targetBranch: { type: "string", description: "Branch to merge into (default: staging)" },
          deleteBranch: { type: "boolean", description: "Delete source branch after merge" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_stash",
      description: "Git stash operations: save, list, apply, pop, drop. Use for temporarily shelving changes.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          action: { type: "string", enum: ["save", "list", "apply", "pop", "drop"], description: "Stash action (default: save)" },
          message: { type: "string", description: "Message for stash save" },
          stashIndex: { type: "number", description: "Stash index for apply/pop/drop (default: 0)" },
          includeUntracked: { type: "boolean", description: "Include untracked files in save (default: false)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_restore",
      description: "Restore working tree files. Use to discard changes or unstage files.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          files: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "File(s) to restore" },
          staged: { type: "boolean", description: "Restore from staging area (--staged)" },
          source: { type: "string", description: "Restore from specific commit/branch" },
        },
        required: ["projectId", "files"],
      },
    },
    {
      name: "rks_story_ship",
      description: "Ship a story atomically: creates PR → merges → marks integrated. Call this after rks_exec instead of separate staging_pr/merge/cycle_complete calls.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Problem ID to mark as integrated (optional)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_cycle_complete",
      description: "Complete feature→working branch cycle. Syncs with origin (unless local-only), deletes feature branch. Uses branch config.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_promote",
      description: "Promote changes from one branch to another (e.g., dev → staging). Useful for controlled CI/preview builds without full ship workflow.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          from: { type: "string", description: "Source branch (defaults to current branch)" },
          to: { type: "string", description: "Target branch (defaults to integration branch from config)" },
          push: { type: "boolean", description: "Push target branch after merge (default: true)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_ship",
      description: "Ship changes in one command: commit → branch → PR → merge → cycle_complete. Use after guardrails-off work or any time you have uncommitted changes to ship.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          message: { type: "string", description: "Commit message (without type prefix)" },
          scope: { type: "string", description: "Optional scope (e.g., interview, planner)" },
          type: { type: "string", enum: ["feat", "fix", "refactor", "docs", "chore", "test"], description: "Commit type (default: feat)" },
          files: { type: "array", items: { type: "string" }, description: "Specific files to commit (all if omitted)" },
          branchName: { type: "string", description: "Branch name (auto-generated from message if omitted)" },
          branchType: { type: "string", enum: ["feature", "fix", "refactor", "docs", "chore"], description: "Branch type prefix (default: feature)" },
          prTitle: { type: "string", description: "PR title (auto-generated if omitted)" },
          problemId: { type: "string", description: "Backlog story ID to mark as implemented" },
        },
        required: ["projectId", "message"],
      },
    },
    {
      name: "rks_reset",
      description: "Reset HEAD to a specific state. Use soft/mixed/hard modes.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          mode: { type: "string", enum: ["soft", "mixed", "hard"], description: "Reset mode (default: mixed)" },
          target: { type: "string", description: "Reset target (commit SHA, HEAD~N, branch)" },
          confirm: { type: "boolean", description: "Required for hard reset" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_revert",
      description: "Revert a commit by creating a new commit that undoes changes.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          commit: { type: "string", description: "Commit SHA to revert" },
          noCommit: { type: "boolean", description: "Stage changes only, don't commit" },
        },
        required: ["projectId", "commit"],
      },
    },
    {
      name: "rks_tag",
      description: "Git tag operations: list, create, delete.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          action: { type: "string", enum: ["list", "create", "delete"], description: "Tag action (default: list)" },
          name: { type: "string", description: "Tag name (for create/delete)" },
          message: { type: "string", description: "Annotation message (creates annotated tag)" },
          commit: { type: "string", description: "Commit to tag (default: HEAD)" },
          pattern: { type: "string", description: "Filter pattern for list" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_cherry_pick",
      description: "Cherry-pick commits from other branches.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          commit: { type: "string", description: "Commit SHA to cherry-pick" },
          noCommit: { type: "boolean", description: "Stage changes only, don't commit" },
          abort: { type: "boolean", description: "Abort in-progress cherry-pick" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_telemetry_query",
      description: "Query telemetry events with filtering by type, date range, and correlationId.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          type: { type: "string", description: "Filter by event type (e.g., plan.start, exec.failed)" },
          startDate: { type: "string", description: "ISO 8601 start date" },
          endDate: { type: "string", description: "ISO 8601 end date" },
          correlationId: { type: "string", description: "Filter by correlation ID" },
          limit: { type: "number", description: "Max events to return (default 100, max 1000)" },
          format: { type: "string", enum: ["json", "summary"], description: "Output format" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_telemetry_report",
      description: "Generate aggregate telemetry reports: operation summaries, failure breakdowns, daily trends.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          reportType: { type: "string", enum: ["summary", "failures", "trends"], description: "Report type (default: summary)" },
          startDate: { type: "string", description: "ISO 8601 start date" },
          endDate: { type: "string", description: "ISO 8601 end date" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_token_cost_report",
      description: "Generate a token cost and efficiency report for a story or commit. Returns rawCost, efficientCost, wasteRatio, cacheRatio, healthBand (green/yellow/red), and phase-level breakdowns.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          scope: { type: "string", enum: ["story", "commit"], description: "Scope to report on (default: story)" },
          storyId: { type: "string", description: "Story/problem ID (e.g., backlog.feat.my-story). Required for scope=story." },
          commitSha: { type: "string", description: "Commit SHA to filter by. Required for scope=commit." },
          format: { type: "string", enum: ["json", "markdown", "summary"], description: "Output format (default: json)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_telemetry_export",
      description: "Export a project's telemetry to a shareable, REDACTED bundle (.json + .md) for UAT reports or attaching to a GitHub issue. Scrubs secrets (API keys, tokens, session UUIDs, absolute paths), reuses the cost-report + query readers. Local file output only — no upload.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          storyId: { type: "string", description: "Optional — scope the export to a single story/problem ID." },
          outDir: { type: "string", description: "Optional output directory (default <projectRoot>/.rks/exports)." },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_fetch_raw",
      description: "Fetch a COMPLETE raw document from an https URL (curl mode) — for reading a full external doc/spec when RAG snippets are not enough. Egress posture is per-project via .rks/project.json fetchRaw.mode: 'allowlist' (default) enforces a default-deny host allowlist (fetchRaw.allowedHosts); 'open' allows any public host for casual use. EITHER WAY the security floor always applies: HTTPS-only, SSRF-guarded (internal/loopback/link-local refused), size-capped + timed out, GET-only, recorded in the write-ledger. Not a crawler; no auth; no JS render.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          url: { type: "string", description: "The https URL to fetch. In default 'allowlist' mode the host must be in fetchRaw.allowedHosts; in 'open' mode any public host is allowed (SSRF floor still applies)." },
          timeoutMs: { type: "number", description: "Optional request timeout override (ms), clamped to a ceiling." },
          maxBytes: { type: "number", description: "Optional response size cap (bytes)." },
        },
        required: ["projectId", "url"],
      },
    },
    {
      name: "rks_refine",
      description: "Analyze a backlog story and suggest refinements to improve plan generation success. Returns suggestions for adding targetFiles, code snippets, or decomposition.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Backlog item ID to refine (e.g., backlog.foo.bar)" },
          trigger: { type: "string", enum: ["plan_failed", "plan_rejected", "exec_failed", "test_failed", "design"], description: "What triggered refinement need" },
          context: { type: "string", description: "Optional additional context (error messages, etc.)" },
        },
        required: ["projectId", "problemId"],
      },
    },
    {
      name: "rks_refine_apply",
      description: "Apply refinement suggestions to a backlog story. Updates targetFiles, adds code snippets, or decomposes into child stories.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          problemId: { type: "string", description: "Backlog item ID to update" },
          refinements: {
            type: "array",
            description: "Array of refinement actions to apply",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["add_target_files", "add_code_snippet", "add_test_exemplar", "clarify_ac", "decompose", "fix_target_files", "add_test_requirements", "upgrade_target_files_format", "add_search_pattern", "create_file_directive", "acknowledge_multi_file", "acknowledge_destructive_rewrite", "fix_duplicate_frontmatter"] },
                data: { type: "object", description: "Refinement-specific data" },
              },
              required: ["type"],
            },
          },
        },
        required: ["projectId", "problemId", "refinements"],
      },
    },
    {
      name: "rks_init",
      description: "Create a new RKS project from base template",
      inputSchema: {
        type: "object",
        properties: {
          projectName: { type: "string", description: "Name of the project (becomes directory name)" },
          parentDir: { type: "string", description: "Parent directory (default: ..)" },
          dev: { type: "boolean", description: "Use local file path for development/UAT (default: false)" },
          branchModel: { type: "string", enum: ["2-branch", "3-branch"], description: "Branch workflow: 2-branch (feature → main) or 3-branch (feature → staging → main). Default: 3-branch" },
        },
        required: ["projectName"],
      },
    },
    {
      name: "rks_onboarder",
      description: "Run the rks onboarding flow. Guides new users through the permission model, first story, first build, and first ship. Use stage to resume at a specific step. Use reset:true to restart.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier" },
          stage: { type: "string", enum: ["welcome", "expectations", "stance", "first_story", "first_build", "first_ship", "next_steps"], description: "Stage to run (omit to resume from last incomplete stage)" },
          responses: { type: "object", description: "User responses for the current stage" },
          skipTour: { type: "boolean", description: "Skip the informational stages and go straight to first story" },
          resume: { type: "boolean", description: "Resume from last incomplete stage" },
          reset: { type: "boolean", description: "Reset onboarder state and restart from welcome" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_interview",
      description: "[DEPRECATED — use /rks-onboard instead. Will be removed in v0.21.0] Run or continue project onboarding interview. Forwards to rks_onboarder. Use reset:true to restart.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier" },
          responses: { type: "object", description: "Responses collected so far" },
          reset: { type: "boolean", description: "Set true to restart interview" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_guardrails_off",
      description: "Temporarily disable guardrails hooks for off-rail work. Logs session start with reason and git state. If problemId is provided, code writes are scoped to the story's targetFiles. If problemId is null, session is READ-ONLY for code (meta/config files still allowed). Call rks_guardrails_on when done to restore hooks.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          reason: { type: "string", description: "Why guardrails are being disabled (for audit log)" },
          scope: { type: "string", enum: ["all", "write", "read"], description: "Which tier of hooks to disable. 'all' (default): disables everything. 'write': keeps read+system hooks active for research guidance. 'read': disables only read-tier hooks." },
          problemId: { type: "string", description: "Story ID (e.g., 'backlog.feat.my-feature') to scope code writes. Story's targetFiles define allowed files. If omitted, session is read-only for code." },
        },
        required: ["projectId", "reason"],
      },
    },
    {
      name: "rks_guardrails_on",
      description: "Restore guardrails hooks after off-rail work. Logs session end, detects changes, and returns workflow guidance (commit → PR → merge → complete_cycle).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_guardrails_status",
      description: "Check guardrails status and session history. Returns active session (if any) and recent sessions.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          limit: { type: "number", description: "Number of sessions to return (default: 10)" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_publish",
      description: "Publish filtered project snapshot to a remote repository using a publish profile. Uses git archive with exclude patterns for clean filtering.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          remote: { type: "string", description: "Remote name to push to" },
          profile: { type: "string", description: "Publish profile name (default: app-only)" },
          branch: { type: "string", description: "Target branch (default: main)" },
          dryRun: { type: "boolean", description: "Show what would be published without pushing" },
          message: { type: "string", description: "Commit message for the publish" },
        },
        required: ["projectId", "remote"],
      },
    },
    {
      name: "rks_publish_profiles",
      description: "List available publish profiles and configured remotes for a project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "dendron_create_note",
      description: "Create a Dendron note with RouteKit-style frontmatter. Callable directly with a governor token. Without a token, auto-routes through rks_agent_dendron.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          title: { type: "string" },
          desc: { type: "string" },
          content: { type: "string" },
          testFile: { type: "string", description: "Path to the test file that validates this story" },
        },
        required: ["filename"],
      },
    },
    {
      name: "dendron_fix_frontmatter",
      description: "Ensure a Dendron note has required frontmatter fields. Callable directly with a governor token.",
      inputSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
    {
      name: "dendron_validate_schema",
      description: "Validate frontmatter for notes under notes/. Callable directly with a governor token.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" } },
      },
    },
    {
      name: "dendron_edit_note",
      description: "Edit an existing Dendron note using surgical SEARCH/REPLACE patches. Patches are applied sequentially; if any search string is not found, no changes are written (full rollback). Preserves frontmatter. Callable directly with a governor token.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          patches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                search: { type: "string" },
                replace: { type: "string" },
              },
              required: ["search", "replace"],
            },
          },
        },
        required: ["filename", "patches"],
      },
    },
    {
      name: "dendron_read_note",
      description: "Read a Dendron note's content (frontmatter + body). Callable directly with a governor token.",
      inputSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
    {
      name: "dendron_update_field",
      description: "Update a single field in a Dendron note. Pass arrays as JSON arrays, not strings. Callable directly with a governor token.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          field: { type: "string" },
          value: { oneOf: [{ type: "string" }, { type: "array" }] },
        },
        required: ["filename", "field", "value"],
      },
    },
    {
      name: "dendron_mark_implemented",
      description: "Mark a backlog story as implemented and move to z_implemented. Callable directly with a governor token.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          commitId: { type: "string" },
        },
        required: ["filename"],
      },
    },
    // --- Governor session tools ---
    {
      name: GOVERNOR_INIT_TOOL,
      description: GOVERNOR_INIT_DESC,
      inputSchema: GOVERNOR_INIT_SCHEMA,
    },
    // --- Agent tools (generated from registry) ---
    ...generateAgentToolDefinitions(),
  ];

  // Inject _governorToken into every protected tool's schema so Claude
  // sees the parameter and includes it when the Governor prompt instructs.
  // This is the single-point fix — no individual tool schemas need modification.
  for (const t of tools) {
    if (isProtectedTool(t.name)) {
      if (!t.inputSchema.properties) {
        t.inputSchema.properties = {};
      }
      t.inputSchema.properties._governorToken = {
        type: 'string',
        description: 'Governor session token for authorization',
      };
    }
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = req.params.name;
  const args = req.params.arguments || {};
  const _auditStart = Date.now();
  const _auditProjectId = args?.projectId || args?.id || "unknown";
  let _auditOk = true;
  let _auditError = null;

  // Ensure telemetry storage is initialized for this project so events
  // emitted in the finally block (and by direct tool handlers) persist to disk.
  // Without this, the collector buffer silently drops events when no storage is set.
  try {
    if (_auditProjectId !== "unknown") {
      const ctx = await loadContext(_auditProjectId);
      if (ctx?.record?.root) ensureTelemetryStorage(ctx.record.root);
    }
  } catch { /* best-effort — don't block tool execution */ }

  try {

    // MCP tool preflight validation (mirrors hook-level enforcement)
    if (hasPreflightChecks(tool)) {
      const preflight = await runPreflight(tool, args);
      if (!preflight.ok) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              preflightFailed: true,
              errors: preflight.errors,
              warnings: preflight.warnings,
            }, null, 2)
          }]
        };
      }
    }

    // Governor token validation — protected tools require a valid session token.
    // Unprotected tools (rks_governor_init, rks_project_get, guardrails, telemetry)
    // bypass this gate so the Dispatcher can bootstrap a Governor session.
    // Skip in test/CI environments (same convention as preflight checks).
    const _skipTokenValidation = process.env.RKS_SKIP_PREFLIGHT === "1"
      || process.env.NODE_ENV === "test"
      || process.env.RKS_TEST_MODE === "1";

    // Strip _governorToken from args before passing to tool handlers.
    // Handlers should never see or depend on the token — separation of concerns.
    const { _governorToken, ...cleanArgs } = args;
    // Use cleanArgs for all downstream tool dispatch from here on.
    // (We keep `args` in scope only for the audit trail in the finally block.)

    // Self-bootstrap: rks_agent_research creates its own open-flow Governor session
    // when called without a token. This enables fluid UX escalation from conversation
    // to research task — the agent is blocked, holds its query, gets a token, and proceeds.
    let activeToken = _governorToken;
    if (!activeToken && tool === 'rks_agent_research' && cleanArgs.projectId && !_skipTokenValidation) {
      try {
        const ctx = await loadContext(cleanArgs.projectId);
        setProjectRoot(ctx.record.root);
        const { token: bootstrapToken } = createSession({ projectId: cleanArgs.projectId, flowType: 'open' });
        activeToken = bootstrapToken;
      } catch { /* fail-open — fall through to normal token gate */ }
    }

    // Ensure project root is set for session persistence (needed for disk rehydration
    // after server restart). This is a no-op if already set.
    if (activeToken && cleanArgs.projectId) {
      try {
        const ctx = await loadContext(cleanArgs.projectId);
        setProjectRoot(ctx.record.root);
      } catch { /* best-effort — loadContext may fail for invalid projectId */ }
    }

    // Governor chain discipline: allowlist enforcement + state tracking.
    // When a governor token is present, only tools allowed in the current state are permitted.
    // The state machine advances on each tool call (entry transition) and optionally
    // on tool result (result transition) for async operations like plan/exec/ship.
    // Users (no token) can still call any tool freely.
    if (activeToken && validateToken(activeToken)) {
      const violation = checkAllowedTool(activeToken, tool);
      if (violation) {
        return {
          content: [{ type: "text", text: JSON.stringify(violation, null, 2) }],
        };
      }
      // Advance state on tool entry (before execution)
      const stateTransition = advanceState(activeToken, tool);
      if (stateTransition?.transitioned) {
        try {
          getTelemetryCollector().emit('governor.state.transition', cleanArgs.projectId || 'unknown', {
            tool,
            from: stateTransition.previousState,
            to: stateTransition.newState,
            trigger: 'tool_entry',
          });
        } catch { /* telemetry is best-effort */ }
      }
      // Touch session activity for timeout tracking
      touchSession(activeToken);
    }

    if (!_skipTokenValidation && isProtectedTool(tool)) {
      const rejection = requireToken(activeToken, tool);
      if (rejection) {
        // Auto-route: instead of rejecting, dispatch through the appropriate agent.
        // The agent runs server-side (bypasses the token gate internally).
        // If no agent mapping exists or auto-routing fails, fall back to rejection.
        const autoRouted = await autoRouteUnauthorized(tool, cleanArgs);
        if (autoRouted) {
          return autoRouted;
        }
        // Fallback: no agent mapping or auto-routing failed
        return {
          content: [{ type: "text", text: JSON.stringify(unauthorizedResponse(tool), null, 2) }],
        };
      }
    }

    if (tool === "rks_init") {
      const input = rksInitSchema.parse(cleanArgs);
      const projectName = input.projectName;
      const parentDir = input.parentDir || "..";
      const dev = input.dev || false;
      const branchModel = input.branchModel || "3-branch";
      // dynamically import the init implementation to avoid circular deps / startup cost
      const { runInitTool } = await import('./server/init.mjs');
      const res = await runInitTool({ projectName, parentDir, dev, branchModel });
      // Auto-trigger the onboarder ONLY on a verified-successful init, using the authoritative
      // path runInitTool returned (res.path) — never a recomputed path.resolve(parentDir,
      // projectName), which reintroduced the wrong-root split-brain and echoed the wrong
      // project. On a failed init (res.success === false) we skip the onboarder entirely.
      if (res.success && res.path) {
        try {
          const onboardResult = await runOnboarder({ projectId: projectName, projectRoot: res.path, stage: "welcome" });
          res.onboarder = onboardResult;
        } catch {
          res.nextStep = { command: "/rks-onboard", reason: "first-run" };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_project_get") {
      const input = projectGetSchema.parse(cleanArgs);
      const context = await loadContext(input.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                registry: context.record,
                projectJson: context.projectJson,
                kg: context.kg,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    if (tool === "rks_kg_query") {
      const input = kgQuerySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const value = resolveKgKey(context.kg, input.key || "");
      if (value === undefined) {
        throw new McpError(ErrorCode.InvalidParams, `Key not found in KG: ${input.key || "(root)"}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    }
    if (tool === "rks_analyze") {
      const input = analyzeSchema.parse(cleanArgs);
      const res = await runAnalyzeTool(input);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_plan") {
      const input = planSchema.parse(cleanArgs);
      // Accept maxRefinements (number of refinements to attempt). Default: 2
      const maxRefinements = (cleanArgs && typeof cleanArgs.maxRefinements === "number") ? cleanArgs.maxRefinements : 2;
      input.maxRefinements = (input.maxRefinements !== undefined) ? input.maxRefinements : maxRefinements;

      // ── Pre-spawn readiness gate (backlog.fix.rks-plan.not-ready-short-circuit) ──────
      // A story that is not ready to plan must NOT spawn the detached worker (which would die
      // with worker_crashed). Reuse runPlanReadyTool — the same predicate rks_plan_ready uses —
      // as the single source of truth, and return a structured `not_ready` result instead. Only
      // applies to story-based plans (skip ad-hoc task plans with no problemId). RKS_SKIP_READINESS=1
      // bypasses the gate; a readiness-check exception is tolerated so planning is never blocked
      // by a gate error (defense-in-depth with the in-worker gate, which still catches the rest).
      if (input.problemId && process.env.RKS_SKIP_READINESS !== "1") {
        try {
          const readyCtx = await loadContext(input.projectId);
          const readiness = await runPlanReadyTool({
            projectId: input.projectId,
            problemId: input.problemId,
            projectRoot: readyCtx.record.root,
          });
          if (readiness && readiness.ready === false) {
            return { content: [{ type: "text", text: JSON.stringify({
              ok: false,
              status: "not_ready",
              projectId: input.projectId,
              problemId: input.problemId,
              issues: readiness.issues || [],
              warnings: readiness.warnings || [],
              message: "Story is not ready to plan — no worker was spawned. Resolve the issues below, then re-run rks_plan.",
              requiredNext: `rks_plan_ready { "projectId": "${input.projectId}", "problemId": "${input.problemId}" }`,
            }, null, 2) }] };
          }
        } catch { /* readiness check failed — do not block; let planning proceed */ }
      }

      // ── Async plan: kick off in background, return immediately ──────
      // The MCP SDK has a 60-second client-side request timeout.
      // runPlanTool makes LLM calls that take > 60s, causing "Connection closed".
      // Solution: start planning in background, return a ticket, poll via rks_plan_review.
      //
      // Sync fallback: when RKS_SKIP_LLM=1 or RKS_SKIP_PREFLIGHT=1 (test/CI),
      // the LLM call is skipped and the whole operation is fast — run synchronously.
      const _syncPlan = process.env.RKS_SKIP_LLM === "1" || process.env.RKS_SKIP_PREFLIGHT === "1";

      if (_syncPlan) {
        // Synchronous path for tests/CI
        const res = await runPlanTool(input);
        // Commit the phase change that runPlanTool already wrote to disk.
        // Do NOT call advancePhase — runPlanTool handles phase advancement internally.
        if (res.ok && res.problemId) {
          try {
            const context = await loadContext(input.projectId);
            execSync(`git add notes/${res.problemId}.md && git commit -m "chore(backlog): advance ${res.problemId} to planned"`, {
              cwd: context.record.root, stdio: "pipe"
            });
            res.phaseCommitted = true;
          } catch { /* Non-fatal: runPlanTool may have already committed */ }
        }
        if (_governorToken && validateToken(_governorToken)) {
          const resultKey = res.ok ? 'plan.ok' : 'plan.failed';
          const resultTransition = advanceStateOnResult(_governorToken, resultKey);
          if (resultTransition?.transitioned) {
            res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
            try {
              getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                tool, resultKey,
                from: resultTransition.previousState,
                to: resultTransition.newState,
                trigger: 'tool_result',
              });
            } catch { /* telemetry is best-effort */ }
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      // Async path for production — detached child process
      // The MCP server process can be killed/restarted by Claude Code during
      // Task agent lifecycle. A background Promise would die with the server.
      // Instead, spawn a detached worker process that survives server restarts
      // and writes results to disk. plan_review checks disk + worker liveness.
      const planKey = `${input.projectId}:${input.problemId || input.task || "plan"}`;
      const startedAt = Date.now();

      const ctx = await loadContext(input.projectId);

      // Write plan params to temp file for the worker to read
      const paramsFile = path.join(ctx.record.root, ".rks", `plan-params-${startedAt}.json`);
      const markerPath = getPendingPlanPath(ctx.record.root);
      try {
        const dir = path.dirname(paramsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(paramsFile, JSON.stringify({
          input,
          _markerPath: markerPath,
        }, null, 2));
      } catch (err) {
        throw new McpError(ErrorCode.InternalError, `Failed to write plan params: ${err.message}`);
      }

      // Spawn detached worker
      const workerScript = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..', 'bin', 'plan-worker.mjs'
      );
      const child = spawn('node', [workerScript, paramsFile], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env },
        cwd: ctx.record.root,
      });

      // Guard: spawn failure
      if (!child.pid) {
        try { fs.unlinkSync(paramsFile); } catch { /* best-effort */ }
        throw new McpError(ErrorCode.InternalError, "Failed to spawn plan worker process");
      }

      // Brief error listener before unref (catches async spawn errors)
      child.on('error', (err) => {
        try {
          if (fs.existsSync(markerPath)) {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
            fs.writeFileSync(markerPath, JSON.stringify({
              ...marker, done: true, ok: false,
              error: `Worker spawn error: ${err.message}`,
              completedAt: Date.now(),
            }, null, 2));
          }
        } catch { /* best-effort */ }
      });
      child.unref();

      // Write marker with WORKER PID (not server PID)
      writePendingPlanMarker(ctx.record.root, {
        planKey, projectId: input.projectId, problemId: input.problemId,
        startedAt, pid: child.pid,
      });

      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        status: "planning",
        planKey,
        workerPid: child.pid,
        projectId: input.projectId,
        problemId: input.problemId || null,
        message: "Plan generation started in detached worker. Poll with rks_plan_review to get the result.",
        requiredNext: `rks_plan_review { "projectId": "${input.projectId}" }`,
      }, null, 2) }] };
    }
    if (tool === "rks_plan_review") {
      const input = planReviewSchema.parse(cleanArgs);

      // ── Check for pending async plan ────────────────────────────────
      // Find any pending plan for this project (by projectId prefix match).
      let pendingEntry = null;
      let pendingKey = null;
      for (const [key, val] of pendingPlans) {
        if (key.startsWith(input.projectId + ":")) {
          pendingEntry = val;
          pendingKey = key;
          break;
        }
      }

      // If no in-memory entry, check disk marker (detached worker or legacy server)
      if (!pendingEntry) {
        try {
          const ctx = await loadContext(input.projectId);
          const marker = readPendingPlanMarker(ctx.record.root);
          if (marker && marker.projectId === input.projectId) {
            const elapsed = Math.round((Date.now() - marker.startedAt) / 1000);

            // Case 1: Worker explicitly signaled completion (done flag)
            if (marker.done === true && marker.ok === true) {
              // Plan completed — remove marker and fall through to disk review path
              removePendingPlanMarker(ctx.record.root);
              // (falls through to disk review below)
            } else if (marker.done === true && marker.ok === false) {
              // Plan failed — remove marker and return failure
              removePendingPlanMarker(ctx.record.root);
              if (_governorToken && validateToken(_governorToken)) {
                advanceStateOnResult(_governorToken, 'plan.failed');
              }
              // Propagate structured error context from marker (readiness issues,
              // workflow hints) so the Governor can act on them (e.g., loop back to refine).
              // F3: classify the failure so the operator learns WHY, not just THAT, it failed.
              //   worker_crashed   — uncaught worker exception (marker.failureClass stamped)
              //   story_unplannable — create_file_complexity / AC-cap reject
              //   output_invalid    — note_only / has_note_steps / quality_failed
              // `reason` is the discriminator within the shared "refinement_required" status.
              const failureClass = marker.failureClass
                || (marker.status === "refinement_required"
                      ? (marker.reason === "create_file_complexity" ? "story_unplannable" : "output_invalid")
                      : marker.status === "quality_failed" ? "output_invalid" : "worker_crashed");
              const failureClassMessage = failureClass === "story_unplannable"
                ? "Story is too complex to plan as-is — split it (rks_refine) or reduce acceptance-criteria scope, then re-plan."
                : failureClass === "output_invalid"
                ? "The generated plan had no executable steps — refine the story (add @@SEARCH/@@REPLACE blocks or clearer targets) and re-plan."
                : "The plan worker crashed before producing a plan; see error. Re-run rks_plan.";
              const failureResponse = {
                ok: false,
                status: marker.status || "failed",
                failureClass,
                elapsedSeconds: elapsed,
                error: marker.error || "Plan generation failed in worker",
                message: `Plan worker failed (${failureClass}). ${failureClassMessage}`,
              };
              if (marker.reason) failureResponse.reason = marker.reason;
              if (marker.errors) failureResponse.errors = marker.errors;
              if (marker.issues) failureResponse.issues = marker.issues;
              if (marker.warnings) failureResponse.warnings = marker.warnings;
              if (marker.hint) failureResponse.hint = marker.hint;
              if (marker.workflow) failureResponse.workflow = marker.workflow;
              if (marker.suggestions) failureResponse.suggestions = marker.suggestions;
              return { content: [{ type: "text", text: JSON.stringify(failureResponse, null, 2) }] };
            }
            // Case 2: Worker still alive (no done flag yet)
            else if (marker.pid && isProcessAlive(marker.pid)) {
              const pollHintMs = getPollHintMs(elapsed);
              return { content: [{ type: "text", text: JSON.stringify({
                ok: true,
                status: "planning",
                elapsedSeconds: elapsed,
                workerPid: marker.pid,
                recommendedNextPollMs: pollHintMs,
                message: `Plan is still generating (${elapsed}s elapsed). Poll again in ~${pollHintMs / 1000}s.`,
              }, null, 2) }] };
            }
            // Case 3: No done flag + worker dead — check disk for plan.json
            else {
              const slug = input.label ? slugify(input.label) : (input.problemId ? slugify(input.problemId) : null);
              const runDir = findLatestRunDir(ctx.record.root, slug);
              const planPath = runDir ? path.join(runDir, "plan.json") : null;
              if (planPath && fs.existsSync(planPath)) {
                // Plan completed on disk — remove marker and fall through
                removePendingPlanMarker(ctx.record.root);
              } else {
                // Worker is dead and no plan.json — orphaned
                removePendingPlanMarker(ctx.record.root);
                if (_governorToken && validateToken(_governorToken)) {
                  advanceStateOnResult(_governorToken, 'plan.failed');
                }
                return { content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "failed",
                  elapsedSeconds: elapsed,
                  orphanedPlan: true,
                  message: `Plan worker (pid: ${marker.pid || 'unknown'}) died without completing. Re-run rks_plan.`,
                }, null, 2) }] };
              }
            }
          }
        } catch { /* best-effort — fall through to disk review */ }
      }

      if (pendingEntry && !pendingEntry.done) {
        // Plan still running — tell caller to poll again
        const elapsed = Math.round((Date.now() - pendingEntry.startedAt) / 1000);
        const pollHintMs = getPollHintMs(elapsed);
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true,
          status: "planning",
          elapsedSeconds: elapsed,
          recommendedNextPollMs: pollHintMs,
          message: `Plan is still generating (${elapsed}s elapsed). Poll again in ~${pollHintMs / 1000}s.`,
        }, null, 2) }] };
      }

      if (pendingEntry?.done) {
        // Plan completed — return result and clean up
        pendingPlans.delete(pendingKey);

        if (pendingEntry.error) {
          // Governor state: plan.failed
          if (_governorToken && validateToken(_governorToken)) {
            const resultTransition = advanceStateOnResult(_governorToken, 'plan.failed');
            if (resultTransition?.transitioned) {
              try {
                getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                  tool: 'rks_plan', resultKey: 'plan.failed',
                  from: resultTransition.previousState,
                  to: resultTransition.newState,
                  trigger: 'tool_result',
                });
              } catch { /* telemetry is best-effort */ }
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({
            ok: false,
            status: "failed",
            error: pendingEntry.error,
            message: "Plan generation failed",
          }, null, 2) }] };
        }

        const res = pendingEntry.result;
        // Governor state: plan.ok or plan.failed based on result
        if (_governorToken && validateToken(_governorToken)) {
          const resultKey = res.ok ? 'plan.ok' : 'plan.failed';
          const resultTransition = advanceStateOnResult(_governorToken, resultKey);
          if (resultTransition?.transitioned) {
            res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
            try {
              getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                tool: 'rks_plan', resultKey,
                from: resultTransition.previousState,
                to: resultTransition.newState,
                trigger: 'tool_result',
              });
            } catch { /* telemetry is best-effort */ }
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }

      // ── No pending plan — review plan from disk ──
      // This path handles two cases:
      //   1. Direct plan_review call (no async plan was started)
      //   2. Server restarted after async plan completed (pendingPlans lost)
      // In case 2, the plan result is on disk and the session was rehydrated.
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      // Set project root for session persistence (may not have been set if server restarted)
      setProjectRoot(projectRoot);
      // Derive slug from label or problemId (problemId uses same slugify as planner.mjs:1266)
      const slug = input.label ? slugify(input.label) : (input.problemId ? slugify(input.problemId) : null);
      const runDir = findLatestRunDir(projectRoot, slug);
      if (!runDir) {
        // Transition governor state to plan.failed so it's not stuck in 'planning'
        if (_governorToken && validateToken(_governorToken)) {
          advanceStateOnResult(_governorToken, 'plan.failed');
        }
        const hint = slug
          ? `No plan found for '${slug}'. The plan may not have completed — re-run rks_plan.`
          : "No plans found. Run rks_plan first.";
        throw new McpError(ErrorCode.InvalidParams, hint);
      }
      const planPath = path.join(runDir, "plan.json");
      if (!fs.existsSync(planPath)) {
        // Transition governor state to plan.failed so it's not stuck in 'planning'
        if (_governorToken && validateToken(_governorToken)) {
          advanceStateOnResult(_governorToken, 'plan.failed');
        }
        throw new McpError(ErrorCode.InvalidParams,
          `Plan generation was interrupted (no plan.json in ${path.basename(runDir)}). Re-run rks_plan.`);
      }
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      // Read the story's declared targetFiles up front so reviewPlan can validate target
      // coverage (backlog.fix.plan-review-validates-target-coverage). Best-effort: a plan
      // missing a covering step for any declared target (esp. op:create) is rejected; if the
      // note can't be read, the coverage check no-ops.
      let reviewTargetFiles;
      if (input.problemId) {
        try {
          const note0 = readNote(resolveNotesDir(projectRoot), input.problemId);
          reviewTargetFiles = note0?.targetFiles;
        } catch { /* coverage check no-ops without targetFiles */ }
      }
      const review = await reviewPlan({ projectRoot, plan, targetFiles: reviewTargetFiles, checkExecutableSteps: true });

      // Advance governor state if a valid token is present (handles server restart recovery)
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = review.ok ? 'plan.ok' : 'plan.failed';
        const resultTransition = advanceStateOnResult(_governorToken, resultKey);
        if (resultTransition?.transitioned) {
          review._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool: 'rks_plan', resultKey,
              from: resultTransition.previousState,
              to: resultTransition.newState,
              trigger: 'tool_result_disk_recovery',
            });
          } catch { /* telemetry is best-effort */ }
        }
      }

      // Advance story phase to "planned" if review passed and phase is still "ready"
      // This is the safety net for when the plan worker's phase commit failed
      if (review.ok && input.problemId) {
        try {
          const notesDir = resolveNotesDir(projectRoot);
          const note = readNote(notesDir, input.problemId);
          if (note.phase === 'ready') {
            updateField(notesDir, input.problemId, "phase", "planned");
            // Scoped auto-commit of just the note file
            const noteRelPath = `notes/${input.problemId}.md`;
            spawnSync("git", ["add", noteRelPath], { cwd: projectRoot, encoding: "utf8" });
            const commitMsg = `docs(backlog): mark ${input.problemId} as planned`;
            const commitResult = spawnSync("git", ["commit", "-m", commitMsg], { cwd: projectRoot, encoding: "utf8" });
            if (commitResult.status === 0) {
              console.error(`[rks.plan_review] auto-committed phase change for ${input.problemId}`);
            }
            getTelemetryCollector().emit("story.phase.changed", input.projectId, {
              storyId: input.problemId,
              from: "ready",
              to: "planned",
              reason: "plan_review_safety_net",
            });
          }
        } catch (phaseErr) {
          console.error(`[rks.plan_review] phase advancement failed: ${phaseErr?.message}`);
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(review, null, 2) }] };
    }
    if (tool === "rks_preflight") {
      const input = z.object({ projectId: z.string() }).parse(cleanArgs);
      const checks = [];

      // Check 1: Project attached
      let record = null;
      let projectJson = null;
      try {
        const context = await loadContext(input.projectId);
        record = context.record;
        projectJson = context.projectJson;
      } catch (e) {
        // Project not found - record stays null
      }
      checks.push({
        name: "project_attached",
        passed: !!record,
        hint: record ? null : "Run rks_init first"
      });

      // Check 2: Notes directory
      const notesDir = record ? path.join(record.root, "notes") : null;
      const notesExist = notesDir && fs.existsSync(notesDir);
      checks.push({
        name: "notes_directory",
        passed: !!notesExist,
        hint: notesExist ? null : "Create notes/ directory"
      });

      // Check 3: RAG initialized
      const ragPath = record ? path.join(record.root, ".rks/rag") : null;
      const ragExists = ragPath && fs.existsSync(ragPath);
      checks.push({
        name: "rag_initialized",
        passed: !!ragExists,
        hint: ragExists ? null : "Run rks_rag_embed to initialize RAG index"
      });

      // Check 4: API key
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
      checks.push({
        name: "api_key",
        passed: hasApiKey,
        hint: hasApiKey ? null : "Set ANTHROPIC_API_KEY in .env"
      });

      // Check 5: git readiness — validity, not mere presence. Validates that
      // origin is real (not a YOUR-ORG/YOUR-REPO placeholder) AND reachable, that
      // the configured working branch is checked out, and that a baseline commit
      // exists. Previously this passed on ANY non-empty `git remote get-url origin`,
      // so a fresh project with a placeholder remote and no branch/baseline read
      // GREEN while build/ship/push would fail (the 2026-06-22 UAT false-green).
      if (record) {
        for (const c of checkGitReadiness({ projectRoot: record.root, projectJson })) {
          checks.push(c);
        }
      } else {
        checks.push({
          name: "github_remote",
          passed: false,
          detail: null,
          hint: "Project not attached — run rks_init first",
        });
      }

      const allPassed = checks.every(c => c.passed);

      // Build workflow info from branch topology config
      let workflowInfo = null;
      if (record) {
        const branchConfig = getBranchConfig(record, projectJson);
        const workflowConfig = getWorkflowConfig(record, projectJson);
        const isCustomWorkflow = branchConfig.working !== branchConfig.integration;

        workflowInfo = {
          workingBranch: branchConfig.working,
          integrationBranch: branchConfig.integration,
          productionBranch: branchConfig.production,
          workflow: isCustomWorkflow
            ? "plan → exec → promote → ship"
            : "plan → exec → ship",
          notes: []
        };

        if (workflowConfig.workingBranchLocal) {
          workflowInfo.notes.push(`Working branch (${branchConfig.working}) is local-only`);
        }
        if (!workflowConfig.autoMergeIntegration) {
          workflowInfo.notes.push("Auto-merge disabled: use rks_promote to control when builds trigger");
        }
        if (isCustomWorkflow) {
          workflowInfo.notes.push(`Use rks_promote to merge ${branchConfig.working} → ${branchConfig.integration}`);
        }
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: allPassed, rksVersion: readRksVersion(), checks, workflowInfo }, null, 2) }] };
    }
    if (tool === "rks_validate_story") {
      const input = validateStorySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const result = await validateStory({ projectId: input.projectId, problemId: input.problemId, projectRoot: context.record.root });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (tool === "rks_plan_ready") {
      const input = planReadySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const result = await runPlanReadyTool({
        projectId: input.projectId,
        problemId: input.problemId,
        projectRoot
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (tool === "rks_exec") {
      const input = execSchema.parse(cleanArgs);
      let res;
      try {
        res = await runExecTool(input);
      } catch (err) {
        // If exec throws before touching any files (e.g. note-step gate, pre-exec validation),
        // roll chain state back to planned so recovery tools are accessible.
        if (_governorToken && validateToken(_governorToken)) {
          const isPreExecRejection = err instanceof McpError && err.message?.includes('note step');
          const resultKey = isPreExecRejection ? 'exec.no_actions' : 'exec.error';
          advanceStateOnResult(_governorToken, resultKey);
        }
        throw err;  // re-throw so MCP framework surfaces the error to the caller
      }
      // Auto-advance phase on successful exec
      if (res.ok && input.problemId) {
        try {
          const context = await loadContext(input.projectId);
          const phaseResult = await advancePhase(context.record.root, input.problemId, "exec");
          if (phaseResult.ok) {
            res.phaseAdvanced = { from: phaseResult.from, to: phaseResult.to };
            // Note: exec already commits changes, phase change will be in working tree
            // Commit it now
            try {
              execSync(`git add -A && git commit -m "chore(backlog): advance ${input.problemId} to executed"`, {
                cwd: context.record.root,
                stdio: "pipe"
              });
            } catch (e) {
              // Non-fatal
            }
          }
        } catch (e) {
          // Non-fatal: phase advancement failed but exec succeeded
        }
      }
      // Governor state machine: advance state based on exec result
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'exec.ok' : 'exec.failed';
        const resultTransition = advanceStateOnResult(_governorToken, resultKey);
        if (resultTransition?.transitioned) {
          res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool, resultKey,
              from: resultTransition.previousState,
              to: resultTransition.newState,
              trigger: 'tool_result',
            });
          } catch { /* telemetry is best-effort */ }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_exec_abort") {
      const res = await runExecAbortTool(cleanArgs);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_apply") {
      const input = applySchema.parse(cleanArgs);
      const res = await runApplyTool(input);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_guardrails_simulate") {
      const input = guardrailSimSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const result = simulateGuardrailPolicy(projectRoot, input.label || "");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_templates_list") {
      const input = templatesListSchema.parse(cleanArgs || {});
      const templates = listTemplates(repoRoot).filter((template) =>
        input.prefix ? template.stackId.startsWith(input.prefix) : true
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ templates }, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_approve") {
      const projectId = cleanArgs?.projectId || req.params.arguments?.projectId;
      const planId = cleanArgs?.planId || req.params.arguments?.planId;
      const confirm = (cleanArgs?.confirm !== undefined) ? cleanArgs.confirm : req.params.arguments?.confirm;
      const reason = cleanArgs?.reason || req.params.arguments?.reason;
      if (!projectId || !planId || typeof confirm !== "boolean") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "rks_approve: required params projectId, planId, confirm"
        );
      }
      const context = await loadContext(projectId);
      const { approve } = await import("./server/approve.mjs");
      const res = await approve({
        projectRoot: context.record.root,
        planId,
        confirm,
        reason,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_stash") {
      const input = stashSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runGitStash } = await import("./server/git-tools.mjs");
      const stashProjectRoot = context.record.root;
      const res = await runGitStash({
        projectRoot: stashProjectRoot,
        action: input.action,
        message: input.message,
        stashIndex: input.stashIndex,
        includeUntracked: input.includeUntracked
      });
      // Track pending stash for auto-pop guarantee when governor session ends
      if (_governorToken && validateToken(_governorToken)) {
        if (input.action === 'save' || input.action === 'push') {
          setPendingStash(_governorToken, async () => {
            const { runGitStash: popStash } = await import("./server/git-tools.mjs");
            return popStash({ projectRoot: stashProjectRoot, action: 'pop' });
          });
        } else if (input.action === 'pop' || input.action === 'drop') {
          clearPendingStash(_governorToken);
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_restore") {
      const input = restoreSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runGitRestore } = await import("./server/git-tools.mjs");
      const res = await runGitRestore({
        projectRoot: context.record.root,
        files: input.files,
        staged: input.staged,
        source: input.source
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_story_ship") {
      const input = z.object({ projectId: z.string(), problemId: z.string().optional() }).parse(cleanArgs);
      const { runStoryShipTool } = await import('./server/story-ship.mjs');
      const result = await runStoryShipTool({ projectId: input.projectId, problemId: input.problemId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (tool === "rks_cycle_complete") {
      const input = cycleCompleteSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runCycleComplete } = await import("./server/git-tools.mjs");
      const res = await runCycleComplete({
        projectRoot: context.record.root,
        projectId: input.projectId
      });
      // Advance ship flow state: merging → shipped
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'cycle_complete.ok' : 'cycle_complete.error';
        advanceStateOnResult(_governorToken, resultKey);
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_promote") {
      const input = promoteSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runPromote } = await import("./server/git-tools.mjs");
      const res = await runPromote({
        projectRoot: context.record.root,
        projectId: input.projectId,
        from: input.from,
        to: input.to,
        push: input.push
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_ship") {
      const input = shipSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const res = await runShip({
        projectRoot: context.record.root,
        projectId: input.projectId,
        message: input.message,
        scope: input.scope,
        type: input.type,
        files: input.files,
        branchName: input.branchName,
        branchType: input.branchType,
        prTitle: input.prTitle,
        problemId: input.problemId,
      });
      // Governor state machine: advance state based on ship result
      if (_governorToken && validateToken(_governorToken)) {
        const session = getSession(_governorToken);
        const resultKey = res.ok ? 'ship.ok' : 'ship.failed';

        // Phase 3: if in child_active and ship succeeded, advance child tracking
        if (session?.state === 'child_active' && res.ok) {
          updateChildState(_governorToken, 'complete');
          const next = advanceToNextChild(_governorToken);
          if (next?.allComplete) {
            // All children done — transition to shipped
            session.state = 'shipped';
            res._governorState = { from: 'child_active', to: 'shipped' };
            res._childComplete = { allComplete: true, total: next.total };
            try {
              getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                tool, resultKey: 'children.all_complete',
                from: 'child_active', to: 'shipped',
                trigger: 'child_complete',
                childrenTotal: next.total,
              });
            } catch { /* telemetry is best-effort */ }
          } else if (next) {
            // More children — stay in child_active
            res._childComplete = { nextChildId: next.childId, index: next.index, total: next.total };
            try {
              getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                tool, resultKey: 'child.complete',
                from: 'child_active', to: 'child_active',
                trigger: 'child_advance',
                nextChildId: next.childId,
                childIndex: next.index,
                childrenTotal: next.total,
              });
            } catch { /* telemetry is best-effort */ }
          }
        } else {
          const resultTransition = advanceStateOnResult(_governorToken, resultKey);
          if (resultTransition?.transitioned) {
            res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
            try {
              getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                tool, resultKey,
                from: resultTransition.previousState,
                to: resultTransition.newState,
                trigger: 'tool_result',
              });
            } catch { /* telemetry is best-effort */ }
          }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_reset") {
      const input = resetSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runGitReset } = await import("./server/git-tools.mjs");
      const res = await runGitReset({
        projectRoot: context.record.root,
        mode: input.mode,
        target: input.target,
        confirm: input.confirm
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_revert") {
      const input = revertSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runGitRevert } = await import("./server/git-tools.mjs");
      const res = await runGitRevert({
        projectRoot: context.record.root,
        commit: input.commit,
        noCommit: input.noCommit
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_tag") {
      const input = tagSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runGitTag } = await import("./server/git-tools.mjs");
      const branchConfig = getBranchConfig(context.record, context.projectJson);
      const res = await runGitTag({
        projectRoot: context.record.root,
        action: input.action,
        name: input.name,
        message: input.message,
        commit: input.commit,
        pattern: input.pattern,
        productionBranch: branchConfig.production || 'main'
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_cherry_pick") {
      const input = cherryPickSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const { runGitCherryPick } = await import("./server/git-tools.mjs");
      const res = await runGitCherryPick({
        projectRoot: context.record.root,
        commit: input.commit,
        noCommit: input.noCommit,
        abort: input.abort
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_project_init") {
      const input = projectInitSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const baseBranch = context.projectJson?.baseBranch || "staging";
      if (hasGitRepo(projectRoot)) {
        assertCleanWorkingTree(projectRoot, { toolName: 'rks_project_init' });
        const currentBranch = getCurrentBranch(projectRoot);
        if (currentBranch !== baseBranch) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `rks.project_init: expected to run from base branch "${baseBranch}" but you're on "${currentBranch}".`
          );
        }
      }
      if (input.register && !input.apply) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "rks.project_init: apply must be true when register is requested."
        );
      }

      const initResult = await runProjectInit({
        shellRoot: projectRoot,
        id: input.id,
        stackId: input.stack,
        targetPath: input.path,
        apply: Boolean(input.apply),
        register: Boolean(input.register),
      });

      const payload = {
        ok: true,
        applied: initResult.applied,
        project: initResult.project,
        registryRecord: initResult.registryRecord,
        message: initResult.message,
        instructions: [
          "Use rks_templates_list to discover stack ids before init.",
          `Run npm install inside ${initResult.project.root} once scaffolding completes.`,
        ],
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_story_create") {
      const STORY_TEMPLATES = {
        "react-component": {
          targetFiles: [
            { path: "src/components/${name}.tsx", op: "create", desc: "${name} component" },
            { path: "src/components/${name}.test.tsx", op: "create", desc: "${name} unit tests" },
          ],
          content: `## Problem

Describe what problem this component solves.

## Goal

A reusable \${name} component that...

## Target Files

- src/components/\${name}.tsx
- src/components/\${name}.test.tsx

## Acceptance Criteria

- [ ] Component renders correctly
- [ ] Props are properly typed
- [ ] Unit tests cover main scenarios
- [ ] Accessibility considerations addressed`
        },
        "api-endpoint": {
          targetFiles: [
            { path: "src/api/${name}.ts", op: "create", desc: "${name} API endpoint" },
            { path: "src/api/${name}.test.ts", op: "create", desc: "${name} integration tests" },
          ],
          content: `## Problem

Describe the API need.

## Goal

A RESTful endpoint for \${name} operations.

## Target Files

- src/api/\${name}.ts
- src/api/\${name}.test.ts

## Acceptance Criteria

- [ ] Endpoint handles GET/POST/PUT/DELETE as needed
- [ ] Input validation implemented
- [ ] Error responses follow API conventions
- [ ] Integration tests verify behavior`
        },
        "cli-command": {
          targetFiles: [
            { path: "packages/cli/src/commands/${name}.mjs", op: "create", desc: "${name} CLI command" },
          ],
          content: `## Problem

Describe the CLI need.

## Goal

A CLI command \`rks \${name}\` that...

## Target Files

- packages/cli/src/commands/\${name}.mjs

## Acceptance Criteria

- [ ] Command registered in CLI
- [ ] Help text describes usage
- [ ] Options/flags implemented
- [ ] Error handling for invalid inputs`
        }
      };

      const input = z.object({
        projectId: z.string(),
        name: z.string(),
        title: z.string().optional(),
        desc: z.string().optional(),
        template: z.string().optional(),
      }).parse(cleanArgs);

      const context = await loadContext(input.projectId);
      const notesDir = path.join(context.record.root, "notes");

      // Build filename
      const filename = `backlog.feat.${input.name}`;
      const notePath = path.join(notesDir, `${filename}.md`);

      if (fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidRequest, `Story already exists: ${filename}`);
      }

      // Get template or use default
      const template = input.template ? STORY_TEMPLATES[input.template] : null;

      // Substitute variables in template
      const substitute = (str) => str.replace(/\$\{name\}/g, input.name);
      const substituteTarget = (t) => typeof t === 'object' ? { ...t, path: substitute(t.path), desc: substitute(t.desc) } : substitute(t);

      // Build frontmatter
      const frontmatter = {
        id: filename,
        title: input.title || `Add ${input.name}`,
        desc: input.desc || `Story for ${input.name}`,
        created: Date.now(),
        updated: Date.now(),
        status: "not-implemented",
        targetFiles: template ? template.targetFiles.map(substituteTarget) : [],
        phase: "draft",
      };

      // Build body content
      let body = template ? substitute(template.content) : `## Problem

Describe the problem clearly and concisely.

## Goal

Describe the desired outcome.

## Target Files

- (add target files)

## Acceptance Criteria

- [ ] (clear, testable criteria)`;

      // Write the note
      const content = `---
${Object.entries(frontmatter).map(([k, v]) => {
        if (Array.isArray(v)) {
          if (v.length === 0) return `${k}:`;
          if (typeof v[0] === 'object') {
            return `${k}:\n${v.map(item => {
              return Object.entries(item).map(([ik, iv], idx) =>
                `  ${idx === 0 ? '- ' : '  '}${ik}: "${iv}"`
              ).join('\n');
            }).join('\n')}`;
          }
          return `${k}:\n${v.map(item => `  - "${item}"`).join('\n')}`;
        }
        return `${k}: ${typeof v === 'string' ? `"${v}"` : v}`;
      }).join('\n')}
---

${body}
`;
      fs.writeFileSync(notePath, content, "utf8");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            filename,
            path: path.relative(context.record.root, notePath),
            template: input.template || null,
            targetFiles: frontmatter.targetFiles,
          }, null, 2),
        }],
      };
    }
    if (tool === "rks_rag_init") {
      const input = ragInitSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { working: workingBranch } = getBranchConfig(context.record, context.projectJson);
      if (hasGitRepo(projectRoot)) {
        // No clean-tree gate: RAG init writes no commits and reads the working
        // tree (not a committed ref), so a dirty tree (e.g. an npm-install'd
        // package-lock.json — already in CODE_IGNORE) must not block it. The
        // orphaned gate was copy-pasted from exec, which DOES write commits.
        // See notes/research.2026.06.28.uat-findings.md Finding 2.
        const currentBranch = getCurrentBranch(projectRoot);
        if (currentBranch !== workingBranch) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `rks_rag_init: expected to run from working branch "${workingBranch}" but you're on "${currentBranch}".`
          );
        }
      }

      const result = await runRagInit(projectRoot);
      const payload = {
        ok: result?.ok ?? false,
        projectId: input.projectId,
        projectRoot,
        db: result?.db,
        message: result?.ok ? "RAG database initialized" : result?.error || "Initialization failed",
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_rag_embed") {
      const input = ragEmbedSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { working: workingBranch } = getBranchConfig(context.record, context.projectJson);
      if (hasGitRepo(projectRoot)) {
        // No clean-tree gate (see rks_rag_init above): embedding reads the
        // working tree via globby and writes only to the gitignored, regenerable
        // .rks/rag index — a dirty tree must not block it.
        // notes/research.2026.06.28.uat-findings.md Finding 2.
        const currentBranch = getCurrentBranch(projectRoot);
        if (currentBranch !== workingBranch) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `rks_rag_embed: expected to run from working branch "${workingBranch}" but you're on "${currentBranch}".`
          );
        }
      }

      const result = await runRagEmbed(projectRoot, { glob: input.glob });
      const payload = {
        ok: result?.ok ?? false,
        projectId: input.projectId,
        projectRoot,
        glob: input.glob || null,
        indexed: result?.indexed,
        db: result?.db,
        warning: result?.error,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_rag_query") {
      const input = ragQuerySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      try {
        await ensureRagIndex(projectRoot);
      } catch (err) {
        console.error(`[rks] RAG index stale or ensure failed - auto-embedding notes...`);
        try {
          await runRagEmbed(projectRoot, { glob: "notes/**/*.md" });
          console.error(`[rks] auto-embed completed`);
        } catch (embedErr) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "RAG index stale and auto-embed failed: " + (embedErr?.message || String(embedErr)) }, null, 2) }] };
        }
      }

      // Create capability token when role is provided for fidelity filtering
      let capabilityToken = null;
      if (input.role && Object.values(AGENT_ROLES).includes(input.role)) {
        capabilityToken = createCapabilityToken({
          runId: `query-${Date.now()}`,
          role: input.role,
          projectId: input.projectId,
        });
      }

      const result = await runRagQuery(projectRoot, {
        q: input.q,
        k: input.k,
        capabilityToken,
      });
      const payload = {
        ok: result?.ok ?? true,
        projectId: input.projectId,
        matches: result?.matches || [],
        role: input.role || null,
        fidelityApplied: capabilityToken ? `L${capabilityToken.maxFidelity}` : "L2 (default)",
        hint: result?.error,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_exhaustive_search") {
      // Governed (protected-by-default) deterministic exhaustive search. Reaching
      // this handler means the token gate above already passed — only cited
      // results are returned; the raw search runs server-side in runExhaustiveSearch.
      try {
        const context = await loadContext(cleanArgs.projectId);
        const projectRoot = context.record.root;
        const result = runExhaustiveSearch(projectRoot, {
          pattern: cleanArgs.pattern,
          path: cleanArgs.path,
          countOnly: cleanArgs.countOnly,
          maxResults: cleanArgs.maxResults,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }] };
      }
    }
    if (tool === "rks_rag_compact") {
      const input = ragCompactSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      try {
        const result = await runRagCompact(projectRoot);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                projectId: input.projectId,
                ...result,
              }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: err?.message || String(err),
              }, null, 2),
            },
          ],
        };
      }
    }
    if (tool === "rks_git_state") {
      const input = gitStateSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const run = (cmd) => {
        try {
          return execSync(cmd, { cwd: projectRoot, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
        } catch { return null; }
      };
      const currentBranch = run("git rev-parse --abbrev-ref HEAD");
      const upstream = run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
      const statusOut = run("git status --porcelain");
      const isClean = statusOut !== null && statusOut.length === 0;
      const uncommittedFiles = statusOut ? statusOut.split("\n").filter(Boolean).slice(0, 20).map(l => l.slice(3)) : [];
      let aheadBy = 0, behindBy = 0;
      if (upstream && currentBranch) {
        const counts = run(`git rev-list --left-right --count ${currentBranch}...${upstream}`);
        if (counts) {
          const parts = counts.split(/\s+/);
          aheadBy = Number(parts[0] || 0);
          behindBy = Number(parts[1] || 0);
        }
      }
      const diverged = aheadBy > 0 && behindBy > 0;
      const recommendations = [];
      if (!isClean) recommendations.push("Working tree has uncommitted changes");
      if (!upstream) recommendations.push("No upstream tracking branch set");
      if (behindBy > 0) recommendations.push(`Pull remote changes (${behindBy} commits behind)`);
      if (aheadBy > 0) recommendations.push(`Push local commits (${aheadBy} commits ahead)`);
      if (diverged) recommendations.push("Branch diverged - consider git pull --rebase");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ currentBranch, isClean, aheadBy, behindBy, diverged, uncommittedFiles, recommendations }, null, 2),
          },
        ],
      };
    }
    if (tool === "rks_refine") {
      const input = refineSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runRefineTool({ projectRoot, ...input });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_telemetry_digest") {
      const input = z.object({ 
        projectId: z.string(), 
        timeframe: z.enum(["today", "yesterday", "last-7-days", "last-30-days"]).optional() 
      }).parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { generateDigest } = await import("./server/telemetry/digest.mjs");
      const res = await generateDigest(projectRoot, { timeframe: input.timeframe || "yesterday" });
      return { content: [{ type: "text", text: res.markdown }] };
    }
    if (tool === "rks_refine_apply") {
      const input = refineApplySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runRefineApplyTool({ projectRoot, ...input });
      // Phase 3: detect decomposition and update governor state
      if (_governorToken && validateToken(_governorToken) && res.decomposed) {
        // Transition to decomposing state
        const resultTransition = advanceStateOnResult(_governorToken, 'refine_apply.decomposed');
        if (resultTransition?.transitioned) {
          res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool, resultKey: 'refine_apply.decomposed',
              from: resultTransition.previousState,
              to: resultTransition.newState,
              trigger: 'decompose',
              childCount: res.children?.length || 0,
            });
          } catch { /* telemetry is best-effort */ }
        }
        // Set up child queue if children were created
        if (res.children?.length) {
          const { setChildQueue } = await import("./shared/governor-token.mjs");
          setChildQueue(_governorToken, res.children);
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_ready") {
      const rksReadySchema = z.object({
        projectId: z.string(),
        problemId: z.string(),
      });
      const input = rksReadySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { runRksReadyTool } = await import("./server/refine.mjs");
      const res = await runRksReadyTool({ projectRoot, problemId: input.problemId, projectId: input.projectId });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_git_branch") {
      const input = gitBranchSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const baseBranch = context.projectJson?.baseBranch || "staging";
      const res = await runGitBranch({ projectRoot, name: input.name, type: input.type, baseBranch });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_checkout") {
      const input = checkoutSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runGitCheckout({ projectRoot, branch: input.branch, force: input.force });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_branch_repair") {
      const input = branchRepairSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runBranchRepair({ projectRoot, ...input });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_staging_pr") {
      const input = stagingPrSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      // Resolve targetBranch from project config if not explicitly provided
      const branchConfig = getBranchConfig(context.record, context.projectJson);
      const targetBranch = input.targetBranch || branchConfig.integration;
      const res = await runGitPR({ projectRoot, targetBranch, ...input, autoMerge: false });
      // Advance ship flow state: committed → pr_created
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'staging_pr.ok' : 'staging_pr.error';
        advanceStateOnResult(_governorToken, resultKey);
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_review") {
      const input = z.object({
        projectId: z.string(),
        problemId: z.string().optional(),
        targetBranch: z.string().optional(),
      }).parse(cleanArgs);
      const { runReview } = await import('./server/review.mjs');
      const result = await runReview({
        projectId: input.projectId,
        problemId: input.problemId,
        targetBranch: input.targetBranch || 'staging',
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (tool === "rks_agent_external_research") {
      const { runExternalResearch } = await import('./agents/external-research.mjs');
      const result = await runExternalResearch({ ...cleanArgs });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (tool === "rks_git_commit") {
      const input = gitCommitSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runGitCommit({ projectRoot, ...input });
      // Advance ship flow state: init → committed
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'git_commit.ok' : 'git_commit.error';
        advanceStateOnResult(_governorToken, resultKey);
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_git_push") {
      const input = gitPushSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = runGitPush(projectRoot, { branch: input.branch });
      // Advance ship flow state: committed stays committed after push
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'git_push.ok' : 'git_push.error';
        advanceStateOnResult(_governorToken, resultKey);
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === GIT_PREFLIGHT_TOOL) {
      const context = await loadContext(cleanArgs.projectId);
      const projectRoot = context.record.root;
      const res = runGitPreflight(projectRoot, {
        expectedBranch: cleanArgs.expectedBranch,
        autoStash: cleanArgs.autoStash,
        cleanWorktrees: cleanArgs.cleanWorktrees ?? true,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_git_merge") {
      const input = gitMergeSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const targetBranch = input.targetBranch || context.projectJson?.baseBranch || "staging";
      const res = await runGitMerge({ projectRoot, targetBranch, deleteBranch: input.deleteBranch });
      // Advance ship flow state: pr_created → merging
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'git_merge.ok' : 'git_merge.error';
        advanceStateOnResult(_governorToken, resultKey);
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_sync_staging") {
      const input = z.object({ projectId: z.string(), strategy: z.enum(["rebase", "merge", "auto"]).optional() }).parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runSyncStaging({ projectRoot, strategy: input.strategy || "auto" });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_resolve_conflict") {
      const input = z.object({ projectId: z.string(), strategy: z.enum(["ours", "theirs", "abort"]).optional(), files: z.array(z.string()).optional() }).parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runResolveConflict({ projectRoot, strategy: input.strategy || "theirs", files: input.files || [] });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_staging_merge") {
      const input = stagingMergeSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runStagingMerge({ projectRoot, prNumber: input.prNumber, problemId: input.problemId, reason: input.reason });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_release") {
      const input = z.object({ projectId: z.string(), version: z.enum(["patch", "minor", "major"]).optional(), changelog: z.string().optional() }).parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await runRelease({ projectRoot, version: input.version || "patch", changelog: input.changelog, projectId: input.projectId, projectRecord: context.record, projectJson: context.projectJson });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_telemetry_query") {
      const input = telemetryQuerySchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { queryTelemetry } = await import("./server/telemetry/query.mjs");
      const res = await queryTelemetry(projectRoot, input);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_telemetry_report") {
      const input = telemetryReportSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { generateReport } = await import("./server/telemetry/reports.mjs");
      const res = await generateReport(projectRoot, input);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (tool === "rks_telemetry_analysis") {
      const input = telemetryAnalysisSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { analyzeFailure } = await import("./server/telemetry/analysis.mjs");
      const res = await analyzeFailure(projectRoot, input);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_token_cost_report") {
      const input = tokenCostReportSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { generateCostReport } = await import("./server/telemetry/cost-report.mjs");
      const res = generateCostReport(projectRoot, {
        scope: input.scope,
        storyId: input.storyId,
        commitSha: input.commitSha,
        format: input.format,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_telemetry_export") {
      const input = telemetryExportSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { exportTelemetry } = await import("./server/telemetry/export.mjs");
      const res = await exportTelemetry(projectRoot, {
        projectId: input.projectId,
        storyId: input.storyId,
        outDir: input.outDir,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_fetch_raw") {
      const input = fetchRawSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const { fetchRaw } = await import("./agents/fetch-raw.mjs");
      const res = await fetchRaw(input.url, {
        projectRoot,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_onboarder") {
      const input = onboarderSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const result = await runOnboarder({
        projectId: input.projectId,
        projectRoot,
        stage: input.stage,
        responses: input.responses || {},
        skipTour: input.skipTour || false,
        skipStage: input.skipStage || false,
        bounce: input.bounce || false,
        resume: input.resume || false,
        reset: input.reset || false,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (tool === "rks_interview") {
      const input = interviewSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const DEPRECATION_WARNING =
        "⚠️ `rks_interview` is deprecated and will be removed in v0.21.0. Use `/rks-onboard` instead. Forwarding you to the new onboarding experience now.\n\n";
      const onboardResult = await runOnboarder({
        projectId: input.projectId,
        projectRoot,
        stage: "welcome",
      });
      const result = {
        ...onboardResult,
        display: DEPRECATION_WARNING + (onboardResult.display || ""),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (tool === "rks_guardrails_off") {
      const input = guardrailsOffSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await guardrailsOff(projectRoot, input.reason, input.scope || "all", input.problemId, input.projectId);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_guardrails_on") {
      const input = guardrailsOnSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = await guardrailsOn(projectRoot, {}, input.projectId);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_guardrails_status") {
      const input = guardrailsStatusSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const res = getSessionHistory(projectRoot, input.limit || 10);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    if (tool === "rks_publish") {
      const input = publishSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const result = await publish(projectRoot, {
        projectId: input.projectId,
        remote: input.remote,
        profile: input.profile || "app-only",
        branch: input.branch || "main",
        dryRun: input.dryRun || false,
        message: input.message || `Publish from RKS - ${new Date().toISOString()}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (tool === "rks_publish_profiles") {
      const input = publishProfilesSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;
      const profiles = listProfiles(projectRoot);
      const remotes = listRemotes(projectRoot);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, profiles, remotes }, null, 2) }] };
    }

    if (tool === "dendron_create_note") {
      const input = createNoteSchema.parse(cleanArgs);
      const { notesDir } = getDendronContext();
      assertNotesDir(notesDir);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidRequest, `Note already exists: ${path.relative(notesDir, notePath)}`);
      }
      const id = canonicalIdFromFilename(input.filename);
      const generated = frontmatterDefaults({ id, title: input.title || null, desc: input.desc || null });
      // Add phase: draft for backlog stories
      if (input.filename.startsWith("backlog.") && !input.filename.includes("z_implemented") && !input.filename.includes("z_archive")) {
        generated.phase = "draft";
      }
      // Pass through testFile if provided
      if (input.testFile) {
        generated.testFile = input.testFile;
      }
      // Strip frontmatter from content if caller already included it — prevents duplicate blocks
      let bodyContent = input.content || "";
      if (hasFrontmatter(bodyContent)) {
        const contentParsed = parseFrontmatter(bodyContent);
        bodyContent = contentParsed.content || "";
        // Merge caller's frontmatter fields into generated (caller wins on conflicts)
        Object.assign(generated, contentParsed.data || {});
      }
      // Post-write verification: confirm the file landed on disk with non-zero
      // size before reporting success. Prevents the "phantom story" failure
      // mode where downstream Governors run via RAG queries against a note
      // that was reported created but never actually written.
      const verifyNoteOnDisk = () => {
        if (!fs.existsSync(notePath)) {
          return { ok: false, error: `post-write verification failed — file not present on disk: ${path.relative(notesDir, notePath)}` };
        }
        let size;
        try {
          size = fs.statSync(notePath).size;
        } catch (err) {
          return { ok: false, error: `post-write verification failed — stat error: ${err?.message || String(err)}` };
        }
        if (size === 0) {
          return { ok: false, error: `post-write verification failed — file is empty: ${path.relative(notesDir, notePath)}` };
        }
        return { ok: true };
      };
      // backlog.fix.dendron-writes-no-auto-commit AC1: auto-commit dendron writes.
      const skipCommit = cleanArgs.skipCommit === true;
      const schema = findMatchingSchema(notesDir, input.filename);
      if (schema && schema.template) {
        const tpl = loadSchemaTemplate(notesDir, schema.template);
        if (tpl) {
          const { merged, body } = mergeTemplateWithGenerated({ generated, templateParsed: tpl.parsed, content: bodyContent, id });
          if (skipCommit) {
            writeNoteRaw(notePath, formatWithFrontmatter(merged, body));
          } else {
            writeNoteRaw(notePath, formatWithFrontmatter(merged, body), { skipEmbed: true });
          }
          const verify = verifyNoteOnDisk();
          if (!verify.ok) {
            return { content: [{ type: "text", text: JSON.stringify(verify, null, 2) }] };
          }
          // backlog.fix.dendron-agent-rewrites-content AC5: expose wrote_verbatim on MCP envelope.
          const innerSchemaResult = { ok: true, path: path.relative(notesDir, notePath), id, schema: schema.id, wrote_verbatim: true };
          const wrappedSchema = await commitDendronWriteResult({ tool: "dendron_create_note", innerResult: innerSchemaResult, skipCommit });
          return { content: [{ type: "text", text: JSON.stringify(wrappedSchema, null, 2) }] };
        }
      }
      if (skipCommit) {
        writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent));
      } else {
        writeNoteRaw(notePath, formatWithFrontmatter(generated, bodyContent), { skipEmbed: true });
      }
      const verify = verifyNoteOnDisk();
      if (!verify.ok) {
        return { content: [{ type: "text", text: JSON.stringify(verify, null, 2) }] };
      }
      // backlog.fix.dendron-agent-rewrites-content AC5: expose wrote_verbatim on MCP envelope.
      const innerCreateResult = { ok: true, path: path.relative(notesDir, notePath), id, wrote_verbatim: true };
      const wrappedCreate = await commitDendronWriteResult({ tool: "dendron_create_note", innerResult: innerCreateResult, skipCommit });
      return { content: [{ type: "text", text: JSON.stringify(wrappedCreate, null, 2) }] };
    }
    if (tool === "dendron_fix_frontmatter") {
      const input = fixFrontmatterSchema.parse(cleanArgs);
      const { notesDir } = getDendronContext();
      assertNotesDir(notesDir);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
      const raw = readNoteRaw(notePath);
      const parsed = parseFrontmatter(raw);
      const id = canonicalIdFromFilename(input.filename);
      const next = { ...frontmatterDefaults({ id }), ...(parsed.data || {}), id, updated: Date.now() };
      const skipCommit = cleanArgs.skipCommit === true;
      writeNoteRaw(notePath, formatWithFrontmatter(next, parsed.content || ""), skipCommit ? {} : { skipEmbed: true });
      const inner = { ok: true, path: path.relative(notesDir, notePath), id };
      const wrapped = await commitDendronWriteResult({ tool: "dendron_fix_frontmatter", innerResult: inner, skipCommit });
      return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
    }
    if (tool === "dendron_validate_schema") {
      const input = validateSchemaSchema.parse(cleanArgs);
      const { notesDir } = getDendronContext();
      assertNotesDir(notesDir);
      const pattern = input.pattern || "**/*.md";
      const { globSync } = await import("glob");
      const matches = globSync(pattern, { cwd: notesDir, nodir: true }).sort();
      const results = matches.map((rel) => {
        const raw = readNoteRaw(path.join(notesDir, rel));
        return { path: rel, ...validateNoteFrontmatter(raw) };
      });
      return { content: [{ type: "text", text: JSON.stringify({ ok: results.every(r => r.ok), count: results.length, results }, null, 2) }] };
    }
    if (tool === "dendron_edit_note") {
      const input = editNoteSchema.parse(cleanArgs);
      const { notesDir } = getDendronContext();
      assertNotesDir(notesDir);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Note not found", filename: input.filename }, null, 2) }] };
      }
      const raw = readNoteRaw(notePath);
      const parsed = parseFrontmatter(raw);
      const id = parsed.data?.id || canonicalIdFromFilename(input.filename);

      // Apply patches sequentially — rollback (write nothing) if any patch's search string is not found
      let body = parsed.content || "";
      for (let i = 0; i < input.patches.length; i++) {
        const { search, replace } = input.patches[i];
        const idx = body.indexOf(search);
        if (idx === -1) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, patchIndex: i, search, error: "search_not_found" }, null, 2) }] };
        }
        body = body.slice(0, idx) + replace + body.slice(idx + search.length);
      }

      const next = { ...(parsed.data || {}), id, updated: Date.now() };
      const skipCommit = cleanArgs.skipCommit === true;
      writeNoteRaw(notePath, formatWithFrontmatter(next, body), skipCommit ? {} : { skipEmbed: true });
      const inner = { ok: true, path: path.relative(notesDir, notePath), id, patchesApplied: input.patches.length };
      const wrapped = await commitDendronWriteResult({ tool: "dendron_edit_note", innerResult: inner, skipCommit });
      return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
    }
    if (tool === "dendron_read_note") {
      const inputFilename = String((args && args.filename) || "").trim();
      if (!inputFilename) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Missing filename" }, null, 2) }] };
      const { notesDir } = getDendronContext();
      try {
        assertNotesDir(notesDir);
        const notePath = notePathFromFilename(notesDir, inputFilename);
        if (!fs.existsSync(notePath)) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Note not found` }, null, 2) }] };
        const raw = readNoteRaw(notePath);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, filename: inputFilename, content: raw }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }] };
      }
    }
    if (tool === "dendron_update_field") {
      const input = updateFieldSchema.parse(cleanArgs);
      const { notesDir } = getDendronContext();
      assertNotesDir(notesDir);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
      const skipCommit = cleanArgs.skipCommit === true;
      const writeOptions = skipCommit ? {} : { skipEmbed: true };
      const result = Array.isArray(input.value)
        ? updateFieldDirect(notesDir, input.filename, input.field, input.value, writeOptions)
        : updateField(notesDir, input.filename, input.field, input.value, writeOptions);
      const inner = { ok: true, ...result };
      const wrapped = await commitDendronWriteResult({ tool: "dendron_update_field", innerResult: inner, skipCommit });
      return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
    }
    if (tool === "dendron_mark_implemented") {
      const input = markImplementedSchema.parse(cleanArgs);
      const { notesDir, projectRoot } = getDendronContext();
      assertNotesDir(notesDir);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);
      if (!input.filename.startsWith("backlog.") || input.filename.startsWith("backlog.z_implemented.")) {
        throw new McpError(ErrorCode.InvalidParams, `Note must be in backlog.* namespace`);
      }
      const raw = readNoteRaw(notePath);
      const parsed = parseFrontmatter(raw);
      const originalId = parsed.data?.id || canonicalIdFromFilename(input.filename);
      const newFilename = input.filename.replace(/^backlog\./, "backlog.z_implemented.");
      // Update the id field to match the new filename hierarchy
      const newId = originalId.includes("z_implemented")
        ? originalId
        : originalId.replace(/^backlog\./, "backlog.z_implemented.");
      const next = { ...(parsed.data || {}), id: newId, status: "implemented", updated: Date.now() };
      if (input.commitId) next.commitId = input.commitId;
      const skipCommit = cleanArgs.skipCommit === true;
      writeNoteRaw(notePath, formatWithFrontmatter(next, parsed.content), skipCommit ? {} : { skipEmbed: true });
      const newPath = notePathFromFilename(notesDir, newFilename);
      fs.renameSync(notePath, newPath);
      const oldRelFromRoot = path.relative(projectRoot, notePath);
      const inner = { ok: true, oldPath: input.filename, newPath: newFilename, id: newId, status: "implemented", commitId: input.commitId || null, path: path.relative(notesDir, newPath) };
      const wrapped = await commitDendronWriteResult({
        tool: "dendron_mark_implemented",
        innerResult: inner,
        skipCommit,
        extraStagePaths: [oldRelFromRoot],
      });
      return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
    }
    // --- Governor session tools ---
    if (tool === GOVERNOR_INIT_TOOL) {
      const input = governorInitSchema.parse(cleanArgs);
      const context = await loadContext(input.projectId);
      const projectRoot = context.record.root;

      // Set project root for governor session persistence
      setProjectRoot(projectRoot);

      // Detect orphaned guardrails (hooks.bak with no active session)
      detectOrphanedGuardrails();

      // Clean up stale active-scope.json from previous sessions.
      // This file was written by the old guardrailsOff() flow and can linger
      // across runs, causing the Governor to think it's stuck in old state.
      try {
        const scopeFile = path.join(projectRoot, ".rks", "active-scope.json");
        if (fs.existsSync(scopeFile)) fs.unlinkSync(scopeFile);
      } catch { /* best-effort cleanup */ }

      const result = handleGovernorInit(input);

      // Branch validation for story flows: ensure we're on base branch
      // before refine/research waste cycles on the wrong branch.
      if (result.ok && input.problemId) {
        const baseBranch = context.projectJson?.baseBranch || "staging";
        const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false });
        if (currentBranch && currentBranch !== baseBranch && !currentBranch.startsWith("rks/")) {
          try {
            const checkout = await runGitCheckout({ projectRoot, branch: baseBranch });
            if (checkout.ok) {
              result.branchCorrected = { from: currentBranch, to: baseBranch };
              result.message += ` (auto-checkout: ${currentBranch} → ${baseBranch})`;
              getTelemetryCollector().emit('governor.branch.corrected', input.projectId, {
                from: currentBranch,
                to: baseBranch,
                problemId: input.problemId,
              });
            }
          } catch { /* checkout failed — plan preflight will catch it */ }
        }
        result.branch = currentBranch === baseBranch ? baseBranch
          : (result.branchCorrected?.to || currentBranch);
        result.baseBranch = baseBranch;
      }

      // Emit session creation telemetry
      if (result.ok && result.message?.includes('initialized')) {
        try {
          getTelemetryCollector().emit('governor.session.created', input.projectId, {
            flowType: result.flowType,
            problemId: input.problemId || null,
          });
        } catch { /* telemetry is best-effort */ }
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    // --- Agent runner tools ---
    if (tool === "rks_agent_run") {
      const { agent: agentName, input: agentInput } = cleanArgs;
      const agentFactory = getAgent(agentName);
      if (!agentFactory) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown agent: ${agentName}. Available: ${listAgents().join(", ")}` }, null, 2) }] };
      }
      const context = await loadContext(agentInput.projectId);
      const config = agentFactory({ ...agentInput, projectRoot: context.record.root });
      const result = await runAgent(config);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    // Per-agent convenience tools (e.g., rks_agent_validate_story)
    const agentEntry = getAgentByToolName(tool);
    if (agentEntry) {
      const context = await loadContext(cleanArgs.projectId);
      const config = agentEntry.factory({ ...cleanArgs, projectRoot: context.record.root });
      const result = await runAgent(config);
      if (tool === 'rks_agent_research' && result.failureCategory) {
        try {
          getTelemetryCollector().emit(`agent.research.${result.failureCategory}`, cleanArgs.projectId || 'unknown', {
            failureCategory: result.failureCategory,
            confidence: result.confidence,
            telemetryId: result.telemetryId,
          });
        } catch { /* best-effort */ }
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
  } catch (error) {
    _auditOk = false;
    _auditError = error.message || String(error);
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, error.message || String(error));
  } finally {
    // MCP tool audit trail — emit telemetry for every tool invocation
    try {
      getTelemetryCollector().emit(
        _auditOk ? "mcp.tool.complete" : "mcp.tool.failed",
        _auditProjectId,
        {
          tool,
          params: sanitizeToolArgs(args),
          latencyMs: Date.now() - _auditStart,
          ok: _auditOk,
          ...(_auditError ? { error: _auditError } : {}),
        }
      );
    } catch (_e) { /* audit telemetry is best-effort */ }
  }
});

  return server;
}

// Boot the server: run the four boot-time side effects (hooks verification,
// lifecycle telemetry, project-agent init, transport connect) that previously
// executed at module-parse time. Call this explicitly from an entrypoint —
// importing server.mjs no longer triggers any of it.
export async function startServer() {
  const server = createServer();

// Verify hooks infrastructure before accepting connections
// Skip in test mode to allow CLI tests in temp directories without hooks
const rksRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const isTestMode = process.env.NODE_ENV === "test" || process.env.RKS_TEST_MODE === "1";
if (!isTestMode && !verifyHooksPresent(rksRoot)) {
  console.error("[rks-mcp] FATAL: .routekit/hooks/ directory missing!");
  if (canRestoreFromTemplate(rksRoot)) {
    console.error("[rks-mcp] Attempting auto-restore from template...");
    const result = restoreHooksFromTemplate(rksRoot);
    if (result.ok) {
      console.error("[rks-mcp] Hooks restored successfully from template");
    } else {
      console.error(`[rks-mcp] Auto-restore failed: ${result.error}`);
      console.error("[rks-mcp] Manual restore: git checkout HEAD~10 -- .routekit/hooks/");
      process.exit(1);
    }
  } else {
    console.error("[rks-mcp] Cannot auto-restore - template not found");
    console.error("[rks-mcp] Manual restore: git checkout HEAD~10 -- .routekit/hooks/");
    process.exit(1);
  }
}

// ── Telemetry: track MCP server process lifecycle ──────────────────────
// Emits on every server start so we can diagnose restart patterns
// (especially during async plan generation where PID mismatches cause orphans).
try {
  const pendingPlanPath = path.join(rksRoot, ".rks", "pending-plan.json");
  const hasPendingPlan = fs.existsSync(pendingPlanPath);
  let pendingPlanPid = null;
  if (hasPendingPlan) {
    try {
      const marker = JSON.parse(fs.readFileSync(pendingPlanPath, "utf8"));
      pendingPlanPid = marker.pid || null;
    } catch { /* best-effort */ }
  }
  getTelemetryCollector().emit("mcp.server.start", rksRoot, {
    pid: process.pid,
    ppid: process.ppid,
    startedAt: Date.now(),
    hasPendingPlan,
    pendingPlanPid,
    isTestMode,
  });
} catch { /* telemetry is best-effort */ }

// Initialize project-specific agents from .rks/agents/*.json
try {
  const projectRoot = process.env.ROUTEKIT_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const agentResult = initProjectAgents(projectRoot);
  if (agentResult.registered.length > 0) {
    console.error(`[rks-mcp] Project agents: ${agentResult.registered.join(', ')}`);
  }
} catch (err) {
  console.error(`[rks-mcp] Warning: Failed to init project agents: ${err.message}`);
}

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

// Entrypoint guard: start the server only when this module is run directly
// (e.g. `node src/server.mjs`, the way the MCP contract test and the dev
// scripts spawn it). When imported (bin/mcp-rks.mjs, the CLI, unit tests),
// import stays side-effect-free and the importer calls startServer() itself.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error("[rks-mcp] FATAL: failed to start server:", err?.message || err);
    process.exit(1);
  });
}

export { buildNoteDrivenSteps, runApplyTool, classifyPlanStatus };
