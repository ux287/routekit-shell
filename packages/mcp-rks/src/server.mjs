#!/usr/bin/env node

import fs from "fs";
import { execSync, execFileSync, spawnSync, spawn } from "child_process";
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
// Imported straight from the shared module: dendron.mjs re-exports only the
// format/parse pair, and the arch-verdict write needs the byte-stable split/join
// pair plus the bare YAML serializer.
import { splitNoteFrontmatter, spliceNoteFrontmatter, spliceNoteFrontmatterWithBody } from "./shared/frontmatter.mjs";
import { resolveKgKey } from "./project-context.mjs";
import { listTemplates } from "./templates.mjs";
import { runProjectInit } from "./project-init.mjs";
import { runRagEmbed, runRagInit, runRagReset, runRagQuery, runRagCompact, ensureRagIndex, runExhaustiveSearch, resolveFidelityCeiling, setRagHostHooks } from "@routekit/rag";
import { addRagSourcedPath } from "./shared/session-state.mjs";
import { createCapabilityToken } from "@routekit/rag/capability-token";
import { AGENT_ROLES } from "@routekit/rag/capability-profiles";
import {
  runAnalyzeTool,
  runPlanTool,
  buildNoteDrivenSteps,
  classifyPlanStatus,
  findLatestRunDir,
} from "./server/planner.mjs";
import { reviewPlan, resolvedPlanIdentity, describePlanContents, isStatePreservingCall, buildPlanReviewArgs, formatPlanReviewBlockLog } from "./server/plan-quality.mjs";
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
import { guardrailsOff, guardrailsOn, guardrailsAbort, getSessionHistory, commitAndPushNote } from "./server/guardrails-audit.mjs";
import { publish, listProfiles, listRemotes } from "./server/publish.mjs";
import { runInterview } from "./server/interview.mjs";
import { runOnboarder } from "./server/onboarder.mjs";
import { advancePhase, repairPhaseToIntegrated } from "./workflow/auto-phase.mjs";
import { ensureExecStartPhase } from "./server/exec-start-durability.mjs";
import { commitAndEmbedNote } from "./shared/commit-and-embed-note.mjs";
import { buildDendronCommitMessage } from "./shared/dendron-commit-message.mjs";
import { coAuthorTrailer, CO_AUTHOR_REJECTED_WARNING } from "./shared/commit-attribution.mjs";
import { runPreflight, hasPreflightChecks, LOADED_RKS_VERSION, readDiskRksVersion, checkGitReadiness, ragKeylessPreflightMessage } from "./server/preflight.mjs";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { validateStory } from "./server/story-validator-v2.mjs";
import { runAgent } from "./agents/runner.mjs";
import { shouldEmitResearchFailureEvent } from "./agents/research.mjs";
import { getAgent, getAgentByToolName, generateAgentToolDefinitions, listAgents, initProjectAgents, parseAgentInput } from "./agents/registry.mjs";
import { TOOL_NAME as GOVERNOR_INIT_TOOL, TOOL_DESCRIPTION as GOVERNOR_INIT_DESC, INPUT_SCHEMA as GOVERNOR_INIT_SCHEMA, handleGovernorInit } from "./tools/governor-init.mjs";
import { TOOL_NAME as ARCH_VERDICT_TOOL, TOOL_DESCRIPTION as ARCH_VERDICT_DESC, INPUT_SCHEMA as ARCH_VERDICT_SCHEMA, computeArchVerdict, noteSubjectDigest, noteV1SubjectDigest, noteLegacySubjectDigest, notePreCarveOutSubjectDigest, ARCH_MAX_ROUNDS } from "./workflow/arch-verdict.mjs";
import { classifyMarkerFailure, buildPlanReviewFailureResponse, decideToolOutcome, toolPayloadFromResponse, TOOL_FAILED } from "./server/failure-classification.mjs";
import { buildPendingPlanMarker } from "./server/plan-marker.mjs";
import { requireToken, isProtectedTool, unauthorizedResponse, validateToken, checkAllowedTool, touchSession, advanceState, revertStateOnFailure, advanceStateOnResult, getSession, getActiveChild, updateChildState, advanceToNextChild, setProjectRoot, detectOrphanedGuardrails, setPendingStash, clearPendingStash, createSession, flushPendingStashPops } from "./shared/governor-token.mjs";
import { sliceNote } from "./shared/note-slice.mjs";
import { recordIntervention } from "./shared/intervention-record.mjs";
import { createHandlerRegistry } from "./server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "./server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "./server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "./server/handlers/dendron.mjs";
import { registerRagHandlers } from "./server/handlers/rag.mjs";
import { registerGitHandlers } from "./server/handlers/git.mjs";
import { registerShipHandlers } from "./server/handlers/ship.mjs";
import { registerPlannerHandlers } from "./server/handlers/planner.mjs";
import { registerAgentBootstrapHandlers } from "./server/handlers/agent-bootstrap.mjs";
import { registerGovernanceHandlers } from "./server/handlers/governance.mjs";
import { resolveInitCredential } from "./llm/claude-cli/subscription-status.mjs";
import { registerAgentToolHandlers } from "./server/handlers/agent-tools.mjs";

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
// Exported so the auto-route allowlist can be asserted by importing it rather than by
// regexing this file's source — same precedent as TOOL_ARG_SCHEMAS below, which is exported
// for tests/integration/mcp-schema-drift-guard.spec.mjs. Additive; no behaviour change.
export const TOOL_TO_AGENT_MAP = {
  // ── Git tools → Git Agent (expects { projectId, request: string }) ──
  rks_git_state:        { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: 'Show current git status' }) },
  rks_git_branch:       { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `${a.type === 'delete' ? 'Delete' : 'Create'} branch${a.name ? ': ' + a.name : ''}${a.type ? ' (type: ' + a.type + ')' : ''}` }) },
  rks_checkout:         { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Checkout branch: ${a.branch || 'unknown'}${a.force ? ' (force)' : ''}` }) },
  rks_branch_repair:    { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Repair branch ${a.branch || 'current'} — reset to ${a.target || 'upstream'}${a.dryRun ? ' (dry run)' : ''}` }) },
  // rks_git_commit is deliberately NOT mapped. Auto-routing it handed an untokened caller's
  // structured commit to the LLM git agent as prose: type, scope, rawMessage and coAuthor were
  // dropped, and the file list was appended to the message after a literal ' files: '. Untokened
  // callers now get unauthorizedResponse('rks_git_commit'); a tokened caller reaches the
  // deterministic runGitCommit handler. backlog.fix.git-commit-autoroute-rewrites-commit-message
  rks_git_merge:        { agent: 'git', buildInput: (_t, a) => ({ projectId: a.projectId, request: `Merge current branch into ${a.targetBranch || 'target'}${a.deleteBranch ? ' and delete source branch' : ''}` }) },
  // rks_stash is deliberately NOT mapped. Auto-routing it sent an untokened caller to the LLM
  // git agent, which creates stashes nothing restores — the agent cannot register a pending
  // stash because agent tools never receive a token (runner.mjs invokes tool.execute(input)
  // with arguments only), so endSession's auto-pop never fires for one. Flattening `action`
  // and `includeUntracked` into prose for the model to re-parse made it worse. Untokened
  // callers now get unauthorizedResponse('rks_stash') instead: an
  // honest refusal; a tokened caller with a LIVE Governor session reaches the inline handler via
  // STATE_BYPASS_TOOLS (governor-state.mjs:847), which is consulted inside checkStateAllowed —
  // i.e. AFTER checkAllowedTool's session lookup. Deliberately NOT COMMON_TOOLS, which returns at
  // governor-token.mjs:557 before that lookup and would make setPendingStash a silent no-op.
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

      // ── Research tools: DELIBERATELY NOT ROUTED ──
      //
      // backlog.fix.autoroute-substitutes-llm-for-deterministic-retrieval
      //
      // `rks_rag_query`, `rks_kg_query` and `rks_exhaustive_search` used to be mapped to the
      // research agent here. An unmapped tool falls through to a real refusal (see the
      // `if (autoRouted)` check at the call site), which is the correct behaviour and the
      // reason this is a deletion rather than a rewrite.
      //
      // The original rationale was that an unauthorized call should "redirect to the evidence
      // layer (RAG) just as raw Grep is redirected". That analogy holds for LOCATING and breaks
      // for RETRIEVAL. Redirecting Grep to RAG substitutes one way of finding a file for
      // another. Substituting an LLM for `rks_exhaustive_search` substitutes invented text for
      // verbatim text — the research agent's output contract carries no line column at all
      // (`agents/research.mjs`, `sources: [{ file, snippet? }]`), so every file:line it returns
      // on this path is fabricated by construction. Its `buildInput` also dropped `path`,
      // `maxResults` and `countOnly`, turning a bounded scoped search into an unbounded
      // semantic question.
      //
      // Reported from the field on v0.43.0: a symbol reported absent that exists, a return
      // statement placed 90 lines off, a file reported nonexistent, and an invented CLI
      // subcommand — each returned as `ok: true` with only an appended `_autoRouted` field to
      // distinguish it. A governor takes "no such symbol" as proven absence and authors the
      // wrong anchor into a story. A refusal is recoverable; a confident wrong answer is not.
      //
      // Note `rks_rag_query` is in UNPROTECTED_TOOLS, so its entry was already unreachable on
      // this path. It is removed anyway: leaving dead misleading routing arms a trap the day
      // the tool becomes protected.

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

    // A PROJECT THAT DID NOT RESOLVE IS NOT AN AUTHORIZATION REFUSAL.
    //
    // loadContext throws four distinct resolution failures, this blanket catch
    // swallowed all of them, and the caller fell through to unauthorizedResponse
    // — so a missing registry entry, a missing project.json and a missing KG file
    // were all reported as "unauthorized". Telling them apart required moving
    // projects/index.jsonl aside and re-running, by hand, every time.
    //
    // SUBSTRING, not equality: project.mjs re-wraps this in an McpError, which
    // PREFIXES the message, so the producer's literals survive only as
    // substrings. An equality or startsWith match would silently regress every
    // resolution failure straight back to unauthorized.
    const resolution = classifyResolutionFailure(err);
    if (resolution) {
      // GUARDED. `recordIntervention` never throws, but resolving the root can —
      // plausibly for the SAME reason the resolution failed in the first place,
      // which is exactly when this branch runs. Unguarded, the receipt would
      // escape this catch and convert a graceful refusal into an unhandled
      // rejection: instrumentation crashing the path it exists to explain.
      let intervention = null;
      try {
        intervention = recordIntervention(resolveProjectRoot(), {
          kind: 'project_unresolved',
          cause: resolution,
          projectId,
          tool,
          error: err?.message || String(err),
        });
      } catch (receiptErr) {
        // Report the failure as a receipt rather than losing it silently — the
        // operator still learns the refusal was a resolution failure.
        intervention = {
          kind: 'project_unresolved',
          cause: resolution,
          projectId,
          recorded: false,
          recordPath: null,
          writeError: receiptErr?.message || String(receiptErr),
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            reason: 'project_unresolved',
            // Deliberately NO repoRoot and NO registry path: loadProjectContext
            // resolves the registry inside loadProjects and never binds either as
            // a local, so this catch cannot observe them. Recomputing one would
            // report a path the producer never confirmed reading.
            projectId,
            detail: err?.message || String(err),
            intervention,
          }, null, 2),
        }],
      };
    }

    return null; // Fall back to unauthorizedResponse
  }
}

/**
 * The four resolution failures loadProjectContext throws, matched by SUBSTRING.
 *
 * Returns a stable cause token, or null for anything that is not one of them —
 * so an unrecognised error still falls through to the authorization refusal and
 * the classifier cannot over-claim.
 */
export function classifyResolutionFailure(err) {
  const message = err?.message || String(err || '');
  if (message.includes('Project not found:')) return 'project_not_in_registry';
  if (message.includes('missing root in registry')) return 'registry_entry_missing_root';
  if (message.includes('Missing .rks/project.json or routekit/project.json')) return 'project_json_missing';
  if (message.includes('KG file not found for')) return 'kg_file_missing';
  return null;
}

/**
 * Init-time reconciliation of `.rks/active-scope.json`.
 *
 * The scope file is current-flow state: it is SCOPE_FILE in
 * packages/mcp-rks/src/server/guardrails-audit.mjs, written by guardrailsOff and
 * torn down by removeScopeFile on guardrails-on/abort. It must never be removed
 * while an off-rail build is live. When in doubt, the write scope is KEPT.
 *
 * Keep the file when ANY of these holds:
 *   - initResult.mode !== 'new' (resumed / reset / stale_reset / unknown)
 *   - .rks/guardrails-state.json exists and does not parse to active === true
 *     (an unparseable or unreadable file counts as a live off-rail record)
 *   - .routekit/hooks.bak exists
 * Remove it only on a mode-'new' init with guard state absent or active:true and
 * no hooks.bak. `removed` is sourced from an observed post-unlink existsSync false.
 *
 * Never throws. Returns { removed: boolean, reason: string }.
 *
 * backlog.fix.governor-init-deletes-live-offrail-scope
 */
export function reconcileActiveScopeOnInit({ projectRoot, initResult } = {}) {
  if (!projectRoot) return { removed: false, reason: "no_project_root" };
  const scopeFile = path.join(projectRoot, ".rks", "active-scope.json");
  if (!fs.existsSync(scopeFile)) return { removed: false, reason: "no_scope_file" };

  const mode = initResult?.mode;
  if (mode !== "new") {
    return { removed: false, reason: `kept: init mode is ${mode === undefined ? "unknown" : String(mode)}, not new` };
  }

  const guardFile = path.join(projectRoot, ".rks", "guardrails-state.json");
  if (fs.existsSync(guardFile)) {
    let guard;
    try {
      guard = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    } catch (err) {
      return { removed: false, reason: `kept: guardrails-state.json unreadable or unparseable (treated as live off-rail): ${err?.message || String(err)}` };
    }
    if (guard?.active !== true) {
      return { removed: false, reason: "kept: guardrails-state.json records a live off-rail session (active is not true)" };
    }
  }

  const hooksBak = path.join(projectRoot, ".routekit", "hooks.bak");
  if (fs.existsSync(hooksBak)) {
    return { removed: false, reason: "kept: .routekit/hooks.bak exists (off-rail session live)" };
  }

  try {
    fs.unlinkSync(scopeFile);
  } catch (err) {
    const reason = `unlink_failed: ${err?.code ? `${err.code} ` : ""}${err?.message || String(err)}`;
    console.error(`[rks.governor_init] orphaned active-scope.json not removed — ${reason}`);
    return { removed: false, reason };
  }

  if (fs.existsSync(scopeFile)) {
    const reason = "unlink_ineffective: active-scope.json still present after unlink";
    console.error(`[rks.governor_init] ${reason}`);
    return { removed: false, reason };
  }
  return { removed: true, reason: "removed: orphaned active-scope.json (mode new, no live guard state, no hooks.bak)" };
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
        // argv, no shell: a path holding $(...) or a backtick is staged literally.
        try { execFileSync("git", ["add", "--", extra], { cwd: projectRoot, stdio: "pipe" }); } catch { /* best-effort */ }
      }
    }
    const commitMessage = buildDendronCommitMessage(tool, innerResult.id);
    const start = Date.now();
    const commitResult = await commitAndEmbedNote({
      projectRoot,
      notePath: relFromRoot,
      commitMessage,
      // Forwarded so the SCOPED commit covers a rename's old and new path. These were
      // staged above but invisible downstream, where both the pre-check and the commit
      // saw only the note path.
      extraStagePaths,
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
    // Read back from git, not echoed from intent — a caller can tell from the envelope
    // alone whether the commit was actually scoped to this tool's write set.
    if (commitResult.committedPaths) merged.committedPaths = commitResult.committedPaths;
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

import { runRefineTool, runRefineApplyTool, REFINEMENT_TYPES } from "./server/refine.mjs";
import { runPlanReadyTool, isPlanReadyReadOnly, findCreateTargetNoAuthorableBlockIssues } from "./server/plan-ready.mjs";

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
  expectedAnchor: z.string().optional(),
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

function writePendingPlanMarker(projectRoot, { planKey, projectId, problemId, startedAt, pid, workerLogPath = null }) {
  try {
    const filePath = getPendingPlanPath(projectRoot);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(buildPendingPlanMarker({ planKey, projectId, problemId, startedAt, pid, workerLogPath }), null, 2));
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
  projectId: z.string(),
  // backlog.fix.cycle-complete-ungated-hard-reset: opt-in for the destructive
  // `git reset --hard origin/<working>`. OPTIONAL by design — absent means refuse, mirroring
  // rks_branch_repair's `confirm`. Must stay out of required[]; adding it there would make every
  // caller state a destructive intent they usually do not have.
  // NOTE: the advertised inputSchema for rks_cycle_complete must carry the identical optionality —
  // tests/integration/mcp-schema-drift-guard.spec.mjs diffs the two bidirectionally.
  discardLocalCommits: z.boolean().optional().describe("Required to discard unpushed local commits on the working branch")
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
const channelPreviewSchema = z.object({
  projectId: z.string(),
  system: z.enum(["jira", "confluence"]).optional(),
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
  // Advertised since inception but missing here, so z.object stripped it and the
  // read below always saw undefined — every caller asking for 2-branch silently
  // received 3-branch. Adding it CHANGES BEHAVIOUR for those callers, on purpose.
  branchModel: z.enum(["2-branch", "3-branch"]).optional(),
});
const ragInitSchema = z.object({ projectId: z.string(), reset: z.boolean().optional() });
// `files` is advertised, and the tool description promises it for incremental
// updates; without it here the array was stripped before reaching the handler.
const ragEmbedSchema = z.object({
  projectId: z.string(),
  glob: z.string().optional(),
  files: z.array(z.string()).optional(),
});
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
    // backlog.fix.refine-noop-escalation-false-positive: derived from REFINEMENT_TYPES rather
    // than hand-written. z.enum REJECTS rather than strips, so every emitted-but-unlisted type
    // made the refine engine capable of suggesting a refinement type its own tool's parser threw
    // on. Hand-listing 13 values left 8 emitters unaccepted; deriving from the emitter set is
    // what keeps the two from drifting apart again.
    //
    // NOTE: this must stay a ZodObject carrying a `type` ZodEnum —
    // tests/integration/mcp-schema-drift-guard.spec.mjs reaches structurally into
    // `.shape.refinements._def.type.shape.type._def.values`. `.passthrough()` preserves that
    // path; z.record()/z.any() would break it.
    type: z.enum(REFINEMENT_TYPES),
    data: z.any().optional(),
  // .passthrough() because `rks_refine` puts its payload at the TOP LEVEL of each suggestion
  // (`file`, `files`, `hint`, `reason`, `priority`), not under `data`. The default strip deleted
  // exactly those keys, so handing a suggestion straight back delivered `{ type }` alone and all
  // eight `data?.file` handlers in refine.mjs read undefined — the refinement was dropped before
  // any handler could see it, and the resulting empty `applied` was reported as a genuine no-op.
  }).passthrough()),
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
  coAuthor: z.string().optional(), // caller's own identity, 'Name <email>'; omitted = no Co-Authored-By trailer
  projectId: z.string(),
  // Exactly one of message (structured) / rawMessage (verbatim) is required; runGitCommit
  // enforces it, so this stays a plain z.object (the schema drift guard reads .shape).
  message: z.string().optional(),
  rawMessage: z.string().optional(),
  scope: z.string().optional(),
  // No .default here: the feat default is applied inside runGitCommit in structured mode only,
  // so a caller-supplied type can be told apart from the default and refused with rawMessage.
  type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test"]).optional(),
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
const shipSchema = z.object({
  projectId: z.string(),
  message: z.string().describe("Commit message (without type prefix)"),
  scope: z.string().optional().describe("Optional scope for commit"),
  type: z.enum(["feat", "fix", "refactor", "docs", "chore", "test"]).default("feat"),
  files: z.array(z.string()).optional().describe("Specific files to commit. If omitted, all changes are staged (explicit stageAll opt-in at the tool layer); an empty array is rejected"),
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
  // REQUIRED, not cosmetic: this is a plain z.object(), so parse() STRIPS unknown keys and a
  // reset declared only in INPUT_SCHEMA would never reach handleGovernorInit. The two
  // declarations must also stay in step for the mcp-schema-drift-guard comparison.
  reset: z.boolean().optional(),
});

// Kept in step with INPUT_SCHEMA in workflow/arch-verdict.mjs — the drift guard
// (tests/integration/mcp-schema-drift-guard.spec.mjs) compares key presence and
// required-ness between the advertised schema and this one.
const archVerdictSchema = z.object({
  projectId: z.string(),
  storyId: z.string(),
  findings: z.array(
    z.object({
      // Typed as a number deliberately: findingKey slugifies, so a non-numeric
      // item could not corrupt the key format — but typing it here makes the
      // key's shape a parse-time guarantee rather than a downstream rescue.
      item: z.number(),
      file: z.string(),
      detail: z.string().optional(),
    }),
  ),
});

const guardrailsOffSchema = z.object({
  projectId: z.string(),
  reason: z.string(),
  scope: z.enum(["all", "write", "read"]).optional(),
  problemId: z.string().optional(), // Links to story for scoped writes; if null, session is read-only for code
});
const guardrailsOnSchema = z.object({
  coAuthor: z.string().optional(), // caller's own identity, 'Name <email>'; omitted = no Co-Authored-By trailer
  projectId: z.string(),
  // Per-invocation escape from an `offRail: block` enforcement halt. The reason
  // is REQUIRED when overriding and is recorded in shipSteps and telemetry —
  // an override that leaves no trace would be a silent bypass, which is the
  // defect the gate exists to remove.
  enforcementOverride: z
    .object({
      enabled: z.literal(true),
      reason: z.string().min(1, "an enforcement override must state a reason"),
    })
    .optional(),
  // Explicit opt-in to a template hook restore when hooks.bak is missing
  // (backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed). Absent = fail closed.
  restoreFromTemplate: z.boolean().optional(),
});
const guardrailsAbortSchema = z.object({
  projectId: z.string(),
  discardPreExisting: z.boolean().optional(),
});
const guardrailsStatusSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
});
const phaseRepairSchema = z.object({
  projectId: z.string(),
  storyId: z.string(),
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

// rks_memory_save — token-free; writes ONLY notes/memories.<slug>.md. No path input.
// Slug validity is decided by the commitAndEmbedNote legacy form (single allowlist), so the
// schema accepts any string and the helper refuses with ok:false.
const memorySaveSchema = z.object({
  projectId: z.string(),
  slug: z.string(),
  content: z.string(),
  title: z.string().optional(),
  desc: z.string().optional(),
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
const updateFieldSchema = z.object({ filename: z.string(), field: z.string(), value: z.union([z.string(), z.array(z.unknown())]), acknowledgeRemoval: z.boolean().optional() });
const markImplementedSchema = z.object({ filename: z.string(), commitId: z.string().optional() });

/**
 * The missing link between a tool's NAME and the zod schema that actually parses
 * its arguments.
 *
 * Every tool here carries two independent hand-maintained descriptions of one
 * contract: the zod schema below, which PARSES arguments, and a hand-written
 * JSON Schema `inputSchema` literal in the ListTools handler, which tells clients
 * what to SEND. Nothing linked them, so they drifted silently — and the failure
 * is asymmetric, which is how it survived ~80 tools. A new tool missing its
 * advertised half is uncallable and gets caught immediately; a field added to an
 * existing tool's zod schema is merely unreachable, forever and quietly.
 *
 * These are REFERENCES to the same const bindings the CallTool branches parse
 * with — never copies and never re-declarations — so this map cannot describe a
 * schema different from the one actually enforced. The one remaining rot vector
 * is forgetting to register a NEW tool, which the drift guard turns into a test
 * failure rather than a silent pass (see tests/integration/mcp-schema-drift-guard.spec.mjs).
 *
 * Deliberately excluded: tools whose zod schema exists but whose tool is not
 * advertised at all (rks_telemetry_analysis, rks_ready), since every key here
 * must appear in live listTools() output.
 */
export const TOOL_ARG_SCHEMAS = Object.freeze({
  rks_init: rksInitSchema,
  rks_project_init: projectInitSchema,
  rks_project_get: projectGetSchema,
  rks_kg_query: kgQuerySchema,
  rks_analyze: analyzeSchema,
  rks_plan: planSchema,
  rks_plan_review: planReviewSchema,
  rks_plan_ready: planReadySchema,
  rks_validate_story: validateStorySchema,
  rks_exec: execSchema,
  rks_apply: applySchema,
  rks_refine: refineSchema,
  rks_refine_apply: refineApplySchema,
  rks_templates_list: templatesListSchema,
  rks_stash: stashSchema,
  rks_restore: restoreSchema,
  rks_cycle_complete: cycleCompleteSchema,
  rks_promote: promoteSchema,
  rks_ship: shipSchema,
  rks_reset: resetSchema,
  rks_revert: revertSchema,
  rks_tag: tagSchema,
  rks_cherry_pick: cherryPickSchema,
  rks_publish: publishSchema,
  rks_publish_profiles: publishProfilesSchema,
  rks_channel_preview: channelPreviewSchema,
  rks_rag_init: ragInitSchema,
  rks_rag_embed: ragEmbedSchema,
  rks_rag_query: ragQuerySchema,
  rks_rag_compact: ragCompactSchema,
  rks_git_state: gitStateSchema,
  rks_git_branch: gitBranchSchema,
  rks_git_commit: gitCommitSchema,
  rks_git_push: gitPushSchema,
  rks_git_merge: gitMergeSchema,
  rks_checkout: checkoutSchema,
  rks_branch_repair: branchRepairSchema,
  rks_staging_pr: stagingPrSchema,
  rks_staging_merge: stagingMergeSchema,
  rks_telemetry_query: telemetryQuerySchema,
  rks_telemetry_report: telemetryReportSchema,
  rks_telemetry_export: telemetryExportSchema,
  rks_memory_save: memorySaveSchema,
  rks_token_cost_report: tokenCostReportSchema,
  rks_fetch_raw: fetchRawSchema,
  rks_onboarder: onboarderSchema,
  rks_interview: interviewSchema,
  rks_guardrails_off: guardrailsOffSchema,
  rks_guardrails_on: guardrailsOnSchema,
  rks_guardrails_abort: guardrailsAbortSchema,
  rks_guardrails_status: guardrailsStatusSchema,
  rks_phase_repair: phaseRepairSchema,
  rks_guardrails_simulate: guardrailSimSchema,
  [GOVERNOR_INIT_TOOL]: governorInitSchema,
  [ARCH_VERDICT_TOOL]: archVerdictSchema,
  dendron_create_note: createNoteSchema,
  dendron_edit_note: editNoteSchema,
  dendron_update_field: updateFieldSchema,
  dendron_fix_frontmatter: fixFrontmatterSchema,
  dendron_validate_schema: validateSchemaSchema,
  dendron_mark_implemented: markImplementedSchema,
});

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
// S2 handler registry: one per createServer() call, consulted once inside the CallTool IIFE
// after the protected-tool gate. Schema consts stay module-level here and are passed in.
const _handlerRegistry = createHandlerRegistry();
registerTelemetryHandlers(_handlerRegistry, {
  telemetryQuerySchema,
  telemetryReportSchema,
  telemetryAnalysisSchema,
  tokenCostReportSchema,
  telemetryExportSchema,
});
registerProjectMetaHandlers(_handlerRegistry, {
  projectGetSchema,
  kgQuerySchema,
  templatesListSchema,
  gitStateSchema,
  publishSchema,
  publishProfilesSchema,
  channelPreviewSchema,
});
registerDendronHandlers(_handlerRegistry, {
  createNoteSchema,
  fixFrontmatterSchema,
  validateSchemaSchema,
  editNoteSchema,
  updateFieldSchema,
  markImplementedSchema,
}, {
  getDendronContext,
  assertNotesDir,
  notePathFromFilename,
  commitDendronWriteResult,
});
registerRagHandlers(_handlerRegistry, {
  ragInitSchema,
  ragEmbedSchema,
  ragQuerySchema,
  ragCompactSchema,
  memorySaveSchema,
  fetchRawSchema,
}, {
  getDendronContext,
});
registerGitHandlers(_handlerRegistry, {
  stashSchema,
  restoreSchema,
  resetSchema,
  revertSchema,
  tagSchema,
  cherryPickSchema,
  gitBranchSchema,
  checkoutSchema,
  branchRepairSchema,
  gitCommitSchema,
  gitPushSchema,
});
registerShipHandlers(_handlerRegistry, {
  cycleCompleteSchema,
  promoteSchema,
  shipSchema,
  stagingPrSchema,
  gitMergeSchema,
  stagingMergeSchema,
});
registerPlannerHandlers(_handlerRegistry, {
  analyzeSchema,
  planSchema,
  planReviewSchema,
  validateStorySchema,
  planReadySchema,
  execSchema,
  applySchema,
  guardrailSimSchema,
  refineSchema,
  refineApplySchema,
}, {
  pendingPlans,
  getPollHintMs,
  getPendingPlanPath,
  writePendingPlanMarker,
  isProcessAlive,
  readPendingPlanMarker,
  removePendingPlanMarker,
});
registerAgentBootstrapHandlers(_handlerRegistry, {
  rksInitSchema,
  projectInitSchema,
  onboarderSchema,
  interviewSchema,
});
registerGovernanceHandlers(_handlerRegistry, {
  guardrailsOffSchema,
  guardrailsOnSchema,
  guardrailsAbortSchema,
  guardrailsStatusSchema,
  phaseRepairSchema,
  archVerdictSchema,
  governorInitSchema,
}, {
  getDendronContext,
  assertNotesDir,
  notePathFromFilename,
  commitDendronWriteResult,
  reconcileActiveScopeOnInit,
});
registerAgentToolHandlers(_handlerRegistry);
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
          expectedAnchor: { type: "string", description: "Git anchor (@sha or @sha+dirty, as returned by rks_exhaustive_search) asserting which working tree was verified. Refuses with status anchor_mismatch on a different commit, or when a clean tree was asserted and the tree is dirty. A +dirty expectation proceeds as anchorMatch dirty-weak — two dirty trees at one HEAD are not the same tree, so it is a weaker guarantee than exact; a +dirty expectation against a clean tree is also dirty-weak, since the expectation itself was stated loosely. The leading @ is optional. If the working-tree anchor cannot be computed at all, the call refuses rather than proceeding unverified." },
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
      description: "Initialize the LanceDB database for a project's note embeddings. Without reset, this only creates or opens the database and never deletes rows or the embed manifest. reset: true is DESTRUCTIVE: it deletes every row in the embeddings table and clears the embed manifest; it is refused while an embed holds the lock, and must be followed by a full rks_rag_embed (no files) to rebuild the index.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          reset: { type: "boolean", description: "DESTRUCTIVE: delete every row in the embeddings table and clear the embed manifest before a full re-embed. Default false." },
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
          pattern: { type: "string", description: "Literal string to search for. Matching is a CASE-SENSITIVE substring test, so a zero result may mean the pattern differs in case from the source rather than that the content is absent." },
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
          strategy: { type: "string", enum: ["auto", "rebase", "merge", "push-only"], description: "Sync strategy (default: auto). push-only publishes a clean, strictly-ahead, notes-only integration branch and never pulls, rebases or merges; with a governor token push-only is forced and any other strategy is refused." },
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
          enforcementOverride: {
            type: "object",
            description: "Deliberately release past a blocking CI verdict. Requires a reason — an override that leaves no trace is indistinguishable from the fail-open this gate exists to prevent.",
            properties: {
              enabled: { type: "boolean", enum: [true], description: "Must be true" },
              reason: { type: "string", description: "Why the CI gate is being overridden (non-empty; recorded in the response and in telemetry)" },
            },
            required: ["enabled", "reason"],
          },
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
      description: "Stage and commit changes. Two modes, exactly one required. Structured mode (message): builds a conventional-commit subject type(scope): message; appends a Co-Authored-By trailer only when coAuthor is supplied. Verbatim mode (rawMessage): commits the complete message (subject, body and trailers) byte-for-byte, with no type(scope) prefix and no trailer added; it requires a non-empty files list and is scoped to those paths only (other staged paths stay staged and uncommitted), cannot be combined with type, scope, message or coAuthor, and returns committedPaths read back from git. A staged rename needs both the old and the new path listed in files.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          message: { type: "string", description: "Structured mode: commit message (without type prefix). Exactly one of message or rawMessage is required." },
          rawMessage: { type: "string", description: "Verbatim mode: the complete commit message (subject, body, trailers), committed byte-for-byte with no prefix and no added trailer. Requires files; cannot be combined with message, type, scope or coAuthor." },
          scope: { type: "string", description: "Optional scope (e.g., backlog, planner)" },
          type: { type: "string", enum: ["feat", "fix", "refactor", "docs", "chore", "test"], description: "Commit type (default: feat)" },
          files: { type: "array", items: { type: "string" }, description: "Specific files to commit. If omitted, all changes are staged (explicit stageAll opt-in at the tool layer); an empty array is rejected" },
          coAuthor: { type: "string", description: "The caller's own identity as 'Name <email>', written to a Co-Authored-By trailer. Omitted means no trailer." },
        },
        required: ["projectId"],
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
      description: "Complete feature→working branch cycle. Syncs with origin (unless local-only), deletes feature branch. Uses branch config. Refuses if the working branch has unpushed local commits unless discardLocalCommits is true.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          discardLocalCommits: { type: "boolean", description: "Required to discard unpushed local commits on the working branch" },
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
          files: { type: "array", items: { type: "string" }, description: "Specific files to commit. If omitted, all changes are staged (explicit stageAll opt-in at the tool layer); an empty array is rejected" },
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
          since: { type: "string", description: "Relative lookback window (e.g. '7d', '24h')" },
          lastNCycles: { type: "number", description: "Restrict to the last N completed cycles" },
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
          since: { type: "string", description: "Relative lookback window (e.g. '7d', '24h')" },
          lastNCycles: { type: "number", description: "Restrict to the last N completed cycles" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_token_cost_report",
      description: "Generate a token cost and efficiency report for a story or commit. Returns rawCost, efficientCost, wasteRatio, cacheRatio, healthBand (green/yellow/red; n/a with apiNoData: true when the scope has only subscription-billed token events), and phase-level breakdowns, all over API-billed token events. Subscription-billed (claude -p) usage is not API spend: it is reported separately in a subscription block (calls, tokens, estimatedApiEquivalentCost, cliCostUsdEstimate, byModel).",
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
      name: "rks_memory_save",
      description: "Save an agent memory as notes/memories.<slug>.md and commit it as `docs(memory): save <slug>` (commit strictly before embed). Callable without a Governor token. Writes nothing else: there is no path input, the slug must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ with no '..', and the save is refused on a protected branch. The project root comes from the server's environment (ROUTEKIT_PROJECT_ROOT), not from projectId.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier (schema parity only; does not select the write root)" },
          slug: { type: "string", description: "Memory slug; the note id becomes memories.<slug>. Allowlist: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, no '..'." },
          content: { type: "string", description: "Markdown body of the memory note" },
          title: { type: "string", description: "Optional note title (default: slug)" },
          desc: { type: "string", description: "Optional note description" },
        },
        required: ["projectId", "slug", "content"],
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
                // backlog.fix.refine-noop-escalation-false-positive: derived from the same
                // REFINEMENT_TYPES constant as the zod enum above, so the advertised schema
                // and the parser cannot drift apart.
                type: { type: "string", enum: [...REFINEMENT_TYPES] },
                data: { type: "object", description: "Refinement-specific data" },
              },
              // Suggestions carry their payload at the top level, so the advertised schema must
              // not claim to be closed. Mirrors .passthrough() on the zod side.
              additionalProperties: true,
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
          skipStage: { type: "boolean", description: "Skip the current stage and advance to the next one" },
          bounce: { type: "boolean", description: "Re-run the current stage instead of advancing" },
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
          enforcementOverride: {
            type: "object",
            description: "Proceed past an enforcement-gate halt. The reason is REQUIRED and is recorded in shipSteps and telemetry — an override that leaves no trace would be a silent bypass.",
            properties: {
              enabled: { type: "boolean", enum: [true], description: "Must be true" },
              reason: { type: "string", description: "Why the halt is being overridden (non-empty)" },
            },
            required: ["enabled", "reason"],
          },
          coAuthor: { type: "string", description: "The caller's own identity as 'Name <email>', written to a Co-Authored-By trailer on the off-rail auto-ship commit. Omitted means no trailer." },
          restoreFromTemplate: { type: "boolean", description: "Explicit opt-in: when .routekit/hooks.bak is missing, restore the hook tiers from the template instead of failing closed with hooks_backup_missing. The response then states the restored hook set came from the template (hooksSource: 'template'), not the backup. Absent or false, a missing hooks.bak returns ok:false, keeps guard state off and never auto-ships." },
        },
        required: ["projectId"],
      },
    },
    {
      name: "rks_guardrails_abort",
      description: "ABORT an off-rail session WITHOUT shipping: hard reset to the session's start commit + clean of new untracked files, hooks restored, NO commit, branch, PR, merge, or push. REFUSES rather than discarding when the working tree was ALREADY DIRTY when the session opened — the reset targets a COMMIT, so it would also destroy uncommitted work that predated the session and was never this session's. On refusal it returns ok:false with the pre-existing paths, changes nothing, and leaves the session active; pass discardPreExisting: true to destroy them deliberately. Use this to throw away off-rail work instead of rks_guardrails_on (which always commits/ships). Gitignored paths (node_modules, .env, RAG index) are preserved.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          discardPreExisting: { type: "boolean", description: "Explicit opt-in to ALSO discard uncommitted work that already existed when the session opened. Absent or false, such work causes a refusal and nothing is discarded." },
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
      name: "rks_phase_repair",
      description:
        "Advance a story to 'integrated' after an off-rail ship whose phase advance was suppressed by the review gate. EVIDENCE-BOUND: refuses unless a commit reachable from the integration branch carries either the line-exact trailer 'Story: <storyId>' or, for pre-0.66 exec commits, the exact legacy subject line 'feat(exec): <storyId>'. The trailer is preferred when both exist, and the result's evidence.form reports which matched ('trailer' or 'legacy_exec_subject'). Refuses on an unreadable git history rather than treating that as absence. Reports an already-advanced story as a no-op, never as a repair. A successful repair commits the story note and pushes it only when the integration branch is checked out; on any other branch it makes no commit and reports note.skipped with reason 'not_on_integration_branch'.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          storyId: { type: "string", description: "Story note filename, e.g. backlog.fix.my-story" },
        },
        required: ["projectId", "storyId"],
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
      name: "rks_channel_preview",
      description: "Dry-run preview of a Jira/Confluence channel publish. Lists notes whose channel: frontmatter has publish: true and whether each would create or update a remote item. Read-only: writes nothing and does not contact Jira or Confluence (remoteChecked is always false).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project identifier from registry" },
          system: { type: "string", enum: ["jira", "confluence"], description: "Only preview notes for this channel system" },
        },
        required: ["projectId"],
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
      description: "Read a Dendron note's content (frontmatter + body). Callable directly with a governor token. Large notes: pass sections, fields, offset/limit or maxBytes for a bounded read; an unselected read over the byte cap returns a navigable manifest (frontmatter keys and headings) with truncated: true instead of overflowing. TWO DIFFERENT COMPLETENESS FIELDS: truncated means only that the response is not the whole note, so it is true for every selection by construction and answers nothing about your selection; selectionComplete is the field that answers whether what you asked for came back whole. Read selectionComplete — never truncated — before rewriting a field from a slice, because a whole-array write built from a partial read silently destroys the entries you did not see. fieldsNotFound lists any requested field names the note does not carry.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          sections: { type: "array", items: { type: "string" }, description: "Body headings to return, each running to the next heading" },
          fields: { type: "array", items: { type: "string" }, description: "Top-level frontmatter keys to return, with their indented blocks" },
          offset: { type: "number", description: "0-based first line, when slicing by line" },
          limit: { type: "number", description: "Line count, when slicing by line" },
          maxBytes: { type: "number", description: "Byte cap on returned content; requests a bounded read even when the note fits" },
        },
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
          acknowledgeRemoval: {
            type: "boolean",
            description:
              "Permit a write that REMOVES entries from an array field (targetFiles, dependsOn, testFiles, testRequirements). Such a write is refused by default, because the usual cause is a caller rewriting the whole array from a partial read. Pass true only when the removal is intended; the response reports beforeCount, afterCount and removed either way.",
          },
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
    {
      name: ARCH_VERDICT_TOOL,
      description: ARCH_VERDICT_DESC,
      inputSchema: ARCH_VERDICT_SCHEMA,
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
  // backlog.fix.governor-phase-state-desync-and-recovery: the entry transition this call
  // committed, held so the catch below can hand it back if the tool failed.
  let _entryTransition = null;
  let _entryTransitionToken = null;

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
    // The tool body is wrapped so its RETURN VALUE is observable before the finally
    // emits. Previously `_auditOk` flipped false only in the catch, so a handler that
    // returned an ok:false payload WITHOUT throwing was recorded as mcp.tool.complete
    // and the failure went uncounted. Wrapping is used rather than touching 92 return
    // sites; every `return` below still returns the same value, now via the IIFE.
    // Outer `let`s (_entryTransitionToken, _entryTransition) stay mutable through the
    // closure, so the catch and finally observe them exactly as before.
    const _response = await (async () => {

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
      // Advance state on tool entry (before execution).
      //
      // backlog.fix.planned-state-plan-contents-disclosure: a DRY RUN must not move the chain.
      // Entry transitions are keyed on tool name and fire before the tool body, so they cannot
      // see `dryRun` — which meant inspecting a plan with rks_exec dryRun demoted `planned` to
      // `executing` (4 tools, no search, no research) while doing no work at all. Strictly
      // worse than the state you started in, for a call whose whole purpose is to look.
      const stateTransition = isStatePreservingCall(tool, cleanArgs)
        ? null
        : advanceState(activeToken, tool);
      // backlog.fix.governor-phase-state-desync-and-recovery: remembered so a FAILED call can
      // give the transition back. Entry transitions gate in-flight calls correctly, but a call
      // that errored did no work and must not leave the chain moved — that is how `planned`
      // silently became `refining` (where rks_exec is forbidden) on a failed research call.
      _entryTransition = stateTransition;
      _entryTransitionToken = activeToken;
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

    // backlog.feat.server-mjs-registry-only-dispatch (S10): handlers reach the entry-transition
    // revert only through this closure, passed on ctx as revertEntryTransition. The handler decides
    // when to call it; server.mjs owns how. It reads the two lets above at call time.
    const _revertEntryTransition = () => {
      if (_entryTransitionToken) revertStateOnFailure(_entryTransitionToken, _entryTransition);
    };

    // Registry seam (S2; registry-only since S10): every tool is dispatched here, inside the IIFE,
    // so decideToolOutcome, the catch-path entry-transition revert, the audit finally and
    // flushPendingStashPops wrap it. A name-map miss consults the agent-tool resolver; a miss on
    // both is the only path to the unknown-tool throw below.
    const _registeredHandler = _handlerRegistry.lookupHandler(tool);
    if (_registeredHandler) {
      return await _registeredHandler(cleanArgs, Object.freeze({ tool, args, activeToken, governorToken: _governorToken, revertEntryTransition: _revertEntryTransition }));
    }
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
    })();
    // A payload-level failure is a failure. Decided by the same exported helper the unit
    // tier drives, so the rule lives in one place rather than being restated here.
    if (decideToolOutcome({ threw: false, result: toolPayloadFromResponse(_response) }) === TOOL_FAILED) {
      _auditOk = false;
    }
    return _response;
  } catch (error) {
    _auditOk = false;
    _auditError = error.message || String(error);
    // backlog.fix.governor-phase-state-desync-and-recovery: give back the entry transition.
    // A throw means the tool body did not complete, so it has no claim on the chain position.
    try {
      if (_entryTransitionToken) revertStateOnFailure(_entryTransitionToken, _entryTransition);
    } catch { /* rollback is best-effort — never mask the original error */ }
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

    // THE SINGLE AWAIT POINT for stash auto-pops fired by endSession.
    //
    // endSession is synchronous and cannot await its own pop — advanceStateOnResult
    // alone has 18 call sites here, and endSession has 64 references across 14 test
    // files, so making it async would turn every one of those into a new floating
    // promise. It therefore RETAINS the promise and this awaits it once.
    //
    // `finally` is chosen over wrapping the dispatch body deliberately: an await
    // here suspends the async handler, so the MCP response is not delivered until
    // every in-flight pop has settled. That covers all inline returns AND the throw
    // path from ONE insertion. Wrapping instead would mean extracting a ~2,250-line
    // handler body with dozens of inline returns — a far larger refactor than the
    // fix it carries.
    //
    // KNOWN AND ACCEPTED: `finally` runs after the return value is fixed, so a
    // failed pop cannot be surfaced on THIS response. Reporting it is deferred to
    // its own story; the outcome objects carry `projectId` so that consumer has
    // what it needs. Never return or throw from here — either would discard the
    // real result or swallow an in-flight exception.
    try {
      await flushPendingStashPops();
    } catch (_e) { /* a pop outcome is already recorded; never mask the tool result */ }
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

  // Wire the RAG module's host hooks (session-state provenance + telemetry collector) before
  // accepting connections. RAG ops only fire on MCP tool calls after server.connect() below, so this
  // precedes any production RAG op. src/rag/** deliberately has NO static import of these (dependency
  // inversion so RAG can be lifted into a standalone @routekit/rag package without a host cycle).
  setRagHostHooks({ addRagSourcedPath, getTelemetryCollector });

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
