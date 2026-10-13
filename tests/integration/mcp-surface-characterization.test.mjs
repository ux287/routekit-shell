/**
 * backlog.feat.server-mjs-dispatch-characterization-harness — S0 of the server.mjs safe
 * decomposition (notes/research.2026.10.05.server-mjs-safe-decomposition.md §5 S0).
 *
 * CI-collected characterization of the externally observable MCP surface of
 * packages/mcp-rks/src/server.mjs, through createServer() + InMemoryTransport:
 *
 *   (a) ListTools golden (tests/integration/fixtures/mcp-surface.golden.json) + the roster /
 *       _governorToken-injection contract ported from packages/mcp-rks/__tests__/mcp-contract.spec.mjs
 *   (b) dispatch bijection under the args policy P1–P6 (schema-invalid by construction, plus a
 *       committed READ_ONLY_ALLOWLIST), with every call isolated to an os.tmpdir() fixture
 *   (c) per-family response CONTENT (keys, ok, error class) and one governor chain-state transition
 *   (d) the named-export pin of server.mjs
 *
 * The golden is regenerated ONLY with UPDATE_MCP_SURFACE_GOLDEN=1. Review the diff: a non-empty
 * golden diff in a move-only story is a defect.
 *
 * SAFETY (## Solution, "Sweep isolation"): this file must never be able to touch the real
 * repository, a remote, gh, an LLM, the network or the embedding model. The order below is
 * load-bearing:
 *   1. static imports — ONLY vitest, node:* builtins, @modelcontextprotocol/sdk/* and tests/helpers/*.
 *      No packages/** and no @routekit/* specifier may be imported statically (step 3a).
 *   2. module top level — the step-3 scrub (credentials deleted, ROUTEKIT_RAG_EMBEDDINGS_MODE=stub,
 *      HOME / GH_CONFIG_DIR / XDG_CONFIG_HOME in a temp dir). @routekit/rag captures the embeddings
 *      mode once, at module load (packages/rag/src/embedding-pipeline.mjs:4, embed.mjs:81).
 *   3. beforeAll — fixture (getRepoCopy("working-no-origin"), no remote, no .env), routing env pinned
 *      to it, backstop snapshot, and only THEN the dynamic import() of packages/** modules.
 *   4. every callTool goes through guardedCall(), which re-verifies the root and the scrub first.
 *
 * getSelfProjectId() caches on first use (server.mjs:102-115) and is consulted only at call time,
 * so ROUTEKIT_PROJECT_ID is set to the fixture id before the first callTool (ARCH residual 1).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getRepoCopy, disposeTemplates } from "../helpers/git-repo-template.mjs";

// ── Step 3 / 3a: scrub BEFORE any packages/** module is imported ──────────────────────────────
// No static packages/** or @routekit/* import above this line, and none below it either.
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_HOME = ORIGINAL_ENV.HOME;
const ORIGINAL_USER_HOME = os.userInfo().homedir;

export const SCRUBBED_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ROUTEKIT_LLM_PROVIDER",
  "BRAVE_SEARCH_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
// Routing vars that would route a call away from the fixture (dendron.mjs:229-244,
// project-context.mjs:11-14). Deleted here; ROUTEKIT_PROJECT_ROOT/_ID are set to the fixture in beforeAll.
const ROUTING_UNSET_KEYS = ["RKS_PROJECT_ROOT", "CLAUDE_PROJECT_DIR", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];

const SCRUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rks-mcp-surface-home-"));
for (const key of SCRUBBED_KEYS) delete process.env[key];
for (const key of ROUTING_UNSET_KEYS) delete process.env[key];
delete process.env.ROUTEKIT_PROJECT_ROOT;
delete process.env.ROUTEKIT_PROJECT_ID;
process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
process.env.HOME = SCRUB_HOME;
process.env.GH_CONFIG_DIR = path.join(SCRUB_HOME, ".config", "gh");
process.env.XDG_CONFIG_HOME = path.join(SCRUB_HOME, ".config");
// Token-skip environment the sweep depends on (server.mjs:2373-2375). Restored in afterAll.
process.env.RKS_TEST_MODE = "1";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_MODULE = "../../packages/mcp-rks/src/server.mjs";
const GOVERNOR_TOKEN_MODULE = "../../packages/mcp-rks/src/shared/governor-token.mjs";
const DENDRON_MODULE = "../../packages/mcp-rks/src/dendron.mjs";
const PROJECT_CONTEXT_MODULE = "../../packages/mcp-rks/src/project-context.mjs";
const GOLDEN_PATH = path.join(REPO_ROOT, "tests/integration/fixtures/mcp-surface.golden.json");
const BOOT_SMOKE_PATH = path.join(REPO_ROOT, "tests/integration/mcp-boot-smoke.test.mjs");
const AGENTS_SRC_DIR = path.join(REPO_ROOT, "packages/mcp-rks/src/agents");
const UPDATE_GOLDEN = process.env.UPDATE_MCP_SURFACE_GOLDEN === "1";
const GIT_TIMEOUT_MS = 120_000;

let embeddingsModeAtFirstImport;
let packageImportCount = 0;
async function importPackageModule(specifier) {
  if (embeddingsModeAtFirstImport === undefined) embeddingsModeAtFirstImport = process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE;
  packageImportCount++;
  return import(specifier);
}

// ── Fixture identity ───────────────────────────────────────────────────────────────────────────
// Deliberately NOT a registered project id: if routing ever failed, the registry lookup
// (project-context.mjs:83-87) would throw "Project not found" rather than resolve a real repo.
export const FIXTURE_PROJECT_ID = "mcp-surface-characterization-fixture";
const FIXTURE_NOTE = "fixture.characterization";
const FABRICATED_TOOL = "rks_fabricated_tool_with_no_dispatch_path";

// ── Committed export pin (d) ───────────────────────────────────────────────────────────────────
export const EXPECTED_SERVER_EXPORTS = [
  "TOOL_ARG_SCHEMAS",
  "TOOL_TO_AGENT_MAP",
  "buildNoteDrivenSteps",
  "classifyPlanStatus",
  "classifyResolutionFailure",
  "createServer",
  "executeDendronCreateNoteVerbatim",
  "getSelfProjectId",
  "reconcileActiveScopeOnInit",
  "runApplyTool",
  "startServer",
];

// ── P5a: RAG_REACHING_TOOLS ────────────────────────────────────────────────────────────────────
// Membership means "NOT proven RAG-free": its only effect is to EXCLUDE a tool from
// READ_ONLY_ALLOWLIST and SUCCESS_CASES, so it is derived conservatively (over-inclusion is safe,
// omission is not). Every member is still swept, with schema-invalid args that reject before any
// RAG call (P2/P3). Derived at build HEAD @81c972adb:
export const RAG_REACHING_TOOLS = new Set([
  // RAG family handlers call @routekit/rag exports directly (server.mjs:3664 init, :3719/:3738
  // runRagEmbed, :3774/:3800 runRagQuery, :3842 compact, :3824/:3831 runExhaustiveSearch).
  "rks_rag_init",
  "rks_rag_embed",
  "rks_rag_query",
  "rks_rag_compact",
  "rks_exhaustive_search",
  // commitAndEmbedNote → commitAndEmbed → runRagEmbed (shared/commit-and-embed.mjs:2,:100;
  // embed skipped only under VITEST at :95): rks_memory_save (server.mjs:4246) and every dendron
  // write via commitDendronWriteResult (server.mjs:564-590).
  "rks_memory_save",
  "dendron_create_note",
  "dendron_edit_note",
  "dendron_update_field",
  "dendron_fix_frontmatter",
  "dendron_mark_implemented",
  // commitAndEmbed in server/git/git-workflow.mjs (runGitCommit :173/:211, runGitPR :314) and
  // server/guardrails-audit.mjs (guardrailsOn :3699; review.mjs import at :1130).
  "rks_git_commit",
  "rks_staging_pr",
  "rks_guardrails_on",
  // runRagQuery: story-validator-v2.mjs:199-203 (server.mjs:3103), review.mjs:1428 (server.mjs:4063;
  // story-ship.mjs:349 imports review.mjs).
  "rks_validate_story",
  "rks_review",
  "rks_story_ship",
  // embedScopedFiles (server/exec.mjs:33,:1817) — every tool whose handler lives in exec.mjs.
  "rks_exec",
  "rks_apply",
  "rks_exec_abort",
  // Planner / refine modules import @routekit/rag and call runRagEmbed (server/planner.mjs:1085,:1100;
  // planner-preflight.mjs:146; planner-context.mjs:13; planner-utils.mjs:10).
  "rks_analyze",
  "rks_plan",
  "rks_plan_review",
  "rks_plan_ready",
  "rks_refine",
  "rks_refine_apply",
  // rks_agent_* whose agent module's import closure reaches @routekit/rag (machine-checked below by
  // agentModuleReachesRag): product-owner, research, dendron, cycle-complete, story, recovery,
  // planner import it directly; delivery via story/cycle-complete; git and ship via
  // server/git-tools.mjs → git-workflow.mjs → commit-and-embed.mjs. rks_agent_run dispatches any
  // registered agent (server.mjs:4926-4941).
  "rks_agent_validate_story",
  "rks_agent_research",
  "rks_agent_dendron",
  "rks_agent_cycle_complete",
  "rks_agent_story",
  "rks_agent_recovery",
  "rks_agent_plan",
  "rks_agent_delivery",
  "rks_agent_git",
  "rks_agent_ship",
  "rks_agent_run",
]);

// ── NETWORK_REACHING_TOOLS (ARCH residual 2: symmetric machine-checked exclusion) ────────────────
// Tools whose handler path can open a network connection: HTTP fetch, an LLM API client, or a
// git / gh remote operation. Conservative, like RAG_REACHING_TOOLS: no member may be in
// READ_ONLY_ALLOWLIST or SUCCESS_CASES. Swept only with schema-invalid args.
export const NETWORK_REACHING_TOOLS = new Set([
  "rks_fetch_raw", // agents/fetch-raw.mjs via server.mjs:4256-4268
  "rks_agent_external_research", // agents/external-research.mjs:128 fetch, LLM synthesis
  // LLM agents (agents/runner.mjs → Anthropic client, llm/clients.mjs)
  "rks_agent_run",
  "rks_agent_validate_story",
  "rks_agent_research",
  "rks_agent_git",
  "rks_agent_dendron",
  "rks_agent_telemetry",
  "rks_agent_ship",
  "rks_agent_cycle_complete",
  "rks_agent_story",
  "rks_agent_delivery",
  "rks_agent_recovery",
  "rks_agent_plan",
  // planner / refine / review LLM calls
  "rks_plan",
  "rks_refine",
  "rks_review",
  // git / gh remote operations
  "rks_git_push",
  "rks_staging_pr",
  "rks_staging_merge",
  "rks_sync_staging",
  "rks_release",
  "rks_publish",
  "rks_ship",
  "rks_story_ship",
  "rks_promote",
  "rks_cycle_complete",
]);

// ── P5: READ_ONLY_ALLOWLIST ────────────────────────────────────────────────────────────────────
// The ONLY tools that may receive schema-valid args anywhere in this file. Each justification
// cites source: no write outside the fixture, no git mutation, no subprocess other than read-only
// git, no network, no LLM, and no @routekit/rag export on the handler path. Allowlisted calls carry
// FIXTURE_PROJECT_ID only. `argsInvariant` pins the arg shape the justification depends on.
export const READ_ONLY_ALLOWLIST = {
  rks_templates_list: {
    args: {},
    justification:
      "server.mjs:3184-3196 parses templatesListSchema then calls listTemplates(repoRoot) " +
      "(templates.mjs:88-113): readdir/readFile under <repo>/templates only. No write, no subprocess, " +
      "no network, no LLM, no @routekit/rag call. Takes no projectId.",
  },
  rks_publish_profiles: {
    args: { projectId: FIXTURE_PROJECT_ID },
    justification:
      "server.mjs:4380-4387: loadContext(fixture) then listProfiles/listRemotes → loadPublishProfiles " +
      "(server/publish.mjs:254-267, :699-723) reads <fixture>/.routekit/publish-profiles.yaml only. " +
      "No write, no subprocess, no network, no LLM, no @routekit/rag call.",
  },
  rks_guardrails_status: {
    args: { projectId: FIXTURE_PROJECT_ID },
    justification:
      "server.mjs:4343-4349: loadContext(fixture) then getSessionHistory (server/guardrails-audit.mjs:4187-4191), " +
      "which returns { ok, sessions: [], total: 0 } when <fixture>/.rks session log is absent (it is). " +
      "Read-only; no subprocess, no network, no LLM, no @routekit/rag call.",
  },
  dendron_read_note: {
    args: { filename: FIXTURE_NOTE },
    justification:
      "server.mjs:4531-4572: root from resolveProjectRoot() (dendron.mjs:222, env-pinned to the fixture), " +
      "reads <fixture>/notes/<filename>.md and slices it. No write, no subprocess, no network, no LLM, " +
      "no @routekit/rag call. Takes no projectId.",
  },
  rks_stash: {
    args: { projectId: FIXTURE_PROJECT_ID, action: "list" },
    argsInvariant: (parsed) => parsed.action === "list",
    justification:
      "server.mjs:3219-3243 with action 'list' ONLY: runGitStash (server/git/git-core.mjs:32-35) runs " +
      "`git stash list` in the fixture — read-only git. setPendingStash fires only for save/push with a " +
      "token (server.mjs:3232-3234). No network, no LLM, no @routekit/rag call.",
  },
  rks_guardrails_simulate: {
    args: { projectId: FIXTURE_PROJECT_ID, label: "docs-change" },
    justification:
      "server.mjs:3170-3182: loadContext(fixture) then simulateGuardrailPolicy (server/project.mjs:213-235) " +
      "reads <fixture>/guardrails/policy.json and matches a scenario (:182-191). Pure read; no subprocess, " +
      "no network, no LLM, no @routekit/rag call.",
  },
  rks_telemetry_query: {
    args: { projectId: FIXTURE_PROJECT_ID },
    justification:
      "server.mjs:4187-4193: loadContext(fixture) then queryTelemetry (packages/telemetry/src/query.mjs:14-40), " +
      "which reads <fixture>/.rks/telemetry/*.jsonl only (imports fs and path only). No write, no subprocess, " +
      "no network, no LLM, no @routekit/rag call.",
  },
  rks_onboarder: {
    args: { projectId: FIXTURE_PROJECT_ID },
    justification:
      "server.mjs:4270-4287: loadContext(fixture) then runOnboarder (server/onboarder.mjs:655) with " +
      "projectRoot = fixture; its writes are fs writes under that root only (state file " +
      ".rks/onboarder-state.json, onboarder.mjs:15,47-53; project files :61-110). Imports node:fs/node:path and " +
      "server/telemetry.mjs only — no subprocess, no git, no network, no LLM, no @routekit/rag call. Fixture-local.",
  },
  rks_governor_init: {
    args: { projectId: FIXTURE_PROJECT_ID, flowType: "ops" },
    argsInvariant: (parsed) => parsed.problemId === undefined,
    justification:
      "server.mjs:4863-4923: setProjectRoot(fixture) BEFORE detectOrphanedGuardrails " +
      "(shared/governor-token.mjs:773-781: no <fixture>/.routekit/hooks.bak → kept) and " +
      "reconcileActiveScopeOnInit(fixture); handleGovernorInit (tools/governor-init.mjs:65) is in-memory plus a " +
      "session record persisted under <fixture>/.rks/session/governor. The branch auto-checkout runs only with " +
      "a problemId (:4891), which the pinned args never carry. No network, no LLM, no @routekit/rag call. Fixture-local.",
  },
};

// ── P2 overrides: registered schemas that ACCEPT {} ────────────────────────────────────────────
// Each override fails TOOL_ARG_SCHEMAS[name].safeParse (asserted before the call).
export const P2_ARG_OVERRIDES = {
  dendron_validate_schema: { pattern: 0 }, // validateSchemaSchema (server.mjs:1105) — pattern must be a string
};

// ── P3: tools with no registered schema ────────────────────────────────────────────────────────
// args, then the statement that rejects them before any loadContext of a real project and before
// any git, gh, fs-write, network or LLM call.
const AGENT_STRICT_PARSE =
  "server.mjs:4943-4950: getAgentByToolName → parseAgentInput strict safeParse (agents/registry.mjs:242-276) " +
  "rejects {} (projectId required) and returns invalid_agent_input before loadContext at :4951";
export const NO_REGISTERED_SCHEMA_SWEEP = {
  rks_agent_cycle_complete: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_delivery: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_dendron: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_git: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_plan: {
    args: {},
    citation:
      "agents/planner.mjs:27-35 PlannerInputSchema is a ZodEffects (.refine), which has no .strict(), so parseAgentInput " +
      "passes the input through (agents/registry.mjs:246-250); server.mjs:4951 loadContext(undefined) then throws " +
      "'projectId is required' (project-context.mjs:27, wrapped server/project.mjs:115-120) before the factory or runAgent",
  },
  rks_agent_recovery: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_research: { args: {}, citation: AGENT_STRICT_PARSE + " (self-bootstrap at :2391 needs a projectId and is skipped in test mode)" },
  rks_agent_ship: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_story: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_telemetry: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_validate_story: { args: {}, citation: AGENT_STRICT_PARSE },
  rks_agent_run: {
    args: {},
    citation: "server.mjs:4927-4930: getAgent(undefined) returns null → { ok: false, error: 'Unknown agent: ...' } before parseAgentInput and loadContext",
  },
  rks_agent_external_research: {
    args: {},
    citation: "server.mjs:4071-4073 → agents/external-research.mjs:236 ExternalResearchInputSchema.parse is the first statement (throws before any fetch or LLM call)",
  },
  rks_approve: {
    args: {},
    citation: "server.mjs:3203-3208: throws McpError(InvalidParams) when projectId/planId/confirm are missing, before loadContext at :3209",
  },
  rks_exec_abort: {
    args: {},
    citation: "server.mjs:3161 → server/exec.mjs:2176 loadContext(undefined) → project-context.mjs:27 'projectId is required' (wrapped server/project.mjs:115-120), before any read of a project",
  },
  rks_exhaustive_search: {
    args: {},
    citation: "server.mjs:3829 loadContext(undefined) throws 'projectId is required'; caught at :3838 → { ok: false } before runExhaustiveSearch at :3831",
  },
  rks_git_preflight: {
    args: {},
    citation: "server.mjs:4109 loadContext(undefined) throws 'projectId is required' before runGitPreflight at :4111",
  },
  rks_preflight: {
    args: {},
    citation: "server.mjs:2994 z.object({ projectId: z.string() }).parse(cleanArgs) is the first statement",
  },
  rks_release: {
    args: {},
    citation: "server.mjs:4170-4181 z.object(...).parse(cleanArgs) is the first statement; preflight release_ready skips without a projectId (server/preflight.mjs:155-156)",
  },
  rks_resolve_conflict: {
    args: {},
    citation: "server.mjs:4156 z.object(...).parse(cleanArgs) is the first statement",
  },
  rks_review: {
    args: {},
    citation: "server.mjs:4058-4062 z.object(...).parse(cleanArgs) is the first statement, before the review.mjs import at :4063",
  },
  rks_story_create: {
    args: {},
    citation: "server.mjs:3574-3580 z.object({ projectId, name, ... }).parse(cleanArgs) precedes loadContext at :3582",
  },
  rks_story_ship: {
    args: {},
    citation: "server.mjs:3259 z.object({ projectId: z.string() ... }).parse(cleanArgs) is the first statement; preflight 'branch' skips without a projectId (server/preflight.mjs:96-108)",
  },
  rks_sync_staging: {
    args: {},
    citation: "server.mjs:4132 z.object({ projectId: z.string(), ... }).parse(cleanArgs) is the first statement",
  },
};

// ── P4: committed per-tool sweep outcome class ─────────────────────────────────────────────────
// mcp:<code>        — McpError raised by the branch (ZodError → InternalError -32603, server.mjs:5000-5001)
// payload:<error>   — parsed payload with ok === false (error text up to the first ':' or '.')
// OK / NO_OK_FIELD  — READ_ONLY_ALLOWLIST members only (schema-valid args)
export const EXPECTED_SWEEP_CLASSES = {
  dendron_create_note: "mcp:-32603",
  dendron_edit_note: "mcp:-32603",
  dendron_fix_frontmatter: "mcp:-32603",
  dendron_mark_implemented: "mcp:-32603",
  dendron_read_note: "OK",
  dendron_update_field: "mcp:-32603",
  dendron_validate_schema: "mcp:-32603",
  rks_agent_cycle_complete: "payload:invalid_agent_input",
  rks_agent_delivery: "payload:invalid_agent_input",
  rks_agent_dendron: "payload:invalid_agent_input",
  rks_agent_external_research: "mcp:-32603",
  rks_agent_git: "payload:invalid_agent_input",
  rks_agent_plan: "mcp:-32602",
  rks_agent_recovery: "payload:invalid_agent_input",
  rks_agent_research: "payload:invalid_agent_input",
  rks_agent_run: "payload:Unknown agent",
  rks_agent_ship: "payload:invalid_agent_input",
  rks_agent_story: "payload:invalid_agent_input",
  rks_agent_telemetry: "payload:invalid_agent_input",
  rks_agent_validate_story: "payload:invalid_agent_input",
  rks_analyze: "mcp:-32603",
  rks_apply: "mcp:-32603",
  rks_approve: "mcp:-32602",
  rks_arch_verdict: "mcp:-32603",
  rks_branch_repair: "mcp:-32603",
  rks_checkout: "mcp:-32603",
  rks_cherry_pick: "mcp:-32603",
  rks_cycle_complete: "mcp:-32603",
  rks_exec: "mcp:-32603",
  rks_exec_abort: "mcp:-32602",
  rks_exhaustive_search: "payload:MCP error -32602",
  rks_fetch_raw: "mcp:-32603",
  rks_git_branch: "mcp:-32603",
  rks_git_commit: "mcp:-32603",
  rks_git_merge: "mcp:-32603",
  rks_git_preflight: "mcp:-32602",
  rks_git_push: "mcp:-32603",
  rks_git_state: "mcp:-32603",
  rks_governor_init: "OK",
  rks_guardrails_abort: "mcp:-32603",
  rks_guardrails_off: "mcp:-32603",
  rks_guardrails_on: "mcp:-32603",
  rks_guardrails_simulate: "NO_OK_FIELD",
  rks_guardrails_status: "OK",
  rks_init: "mcp:-32603",
  rks_interview: "mcp:-32603",
  rks_kg_query: "mcp:-32603",
  rks_memory_save: "mcp:-32603",
  rks_onboarder: "OK",
  rks_phase_repair: "mcp:-32603",
  rks_plan: "mcp:-32603",
  rks_plan_ready: "mcp:-32603",
  rks_plan_review: "mcp:-32603",
  rks_preflight: "mcp:-32603",
  rks_project_get: "mcp:-32603",
  rks_project_init: "mcp:-32603",
  rks_promote: "mcp:-32603",
  rks_publish: "mcp:-32603",
  rks_publish_profiles: "OK",
  rks_rag_compact: "mcp:-32603",
  rks_rag_embed: "mcp:-32603",
  rks_rag_init: "mcp:-32603",
  rks_rag_query: "mcp:-32603",
  rks_refine: "mcp:-32603",
  rks_refine_apply: "mcp:-32603",
  rks_release: "mcp:-32603",
  rks_reset: "mcp:-32603",
  rks_resolve_conflict: "mcp:-32603",
  rks_restore: "mcp:-32603",
  rks_revert: "mcp:-32603",
  rks_review: "mcp:-32603",
  rks_ship: "mcp:-32603",
  rks_staging_merge: "mcp:-32603",
  rks_staging_pr: "mcp:-32603",
  rks_stash: "OK",
  rks_story_create: "mcp:-32603",
  rks_story_ship: "mcp:-32603",
  rks_sync_staging: "mcp:-32603",
  rks_tag: "mcp:-32603",
  rks_telemetry_export: "mcp:-32603",
  rks_telemetry_query: "OK",
  rks_telemetry_report: "mcp:-32603",
  rks_templates_list: "NO_OK_FIELD",
  rks_token_cost_report: "mcp:-32603",
  rks_validate_story: "mcp:-32603",
};

// ── (c) families, re-derived from the dispatch heads at build HEAD @81c972adb ──────────────────
// The research note's S3–S9 table plus a telemetry family it does not list. Every advertised tool
// and every unadvertised dispatch head is in exactly one family. The generic per-agent fallthrough
// (getAgentByToolName, server.mjs:4943) is covered by the rks_agent_* members of agent-bootstrap.
export const UNADVERTISED_DISPATCH_HEADS = ["rks_telemetry_digest", "rks_telemetry_analysis", "rks_ready"];
export const FAMILIES = {
  "project-meta": ["rks_project_get", "rks_kg_query", "rks_templates_list", "rks_publish", "rks_publish_profiles", "rks_git_state"],
  dendron: [
    "dendron_create_note",
    "dendron_fix_frontmatter",
    "dendron_validate_schema",
    "dendron_edit_note",
    "dendron_read_note",
    "dendron_update_field",
    "dendron_mark_implemented",
  ],
  rag: ["rks_rag_init", "rks_rag_embed", "rks_rag_query", "rks_exhaustive_search", "rks_rag_compact", "rks_memory_save", "rks_fetch_raw"],
  git: [
    "rks_git_branch",
    "rks_checkout",
    "rks_branch_repair",
    "rks_git_commit",
    "rks_git_push",
    "rks_git_preflight",
    "rks_stash",
    "rks_restore",
    "rks_reset",
    "rks_revert",
    "rks_tag",
    "rks_cherry_pick",
    "rks_resolve_conflict",
  ],
  ship: [
    "rks_story_ship",
    "rks_cycle_complete",
    "rks_promote",
    "rks_ship",
    "rks_staging_pr",
    "rks_git_merge",
    "rks_sync_staging",
    "rks_staging_merge",
    "rks_release",
  ],
  planner: [
    "rks_analyze",
    "rks_plan",
    "rks_plan_review",
    "rks_preflight",
    "rks_validate_story",
    "rks_plan_ready",
    "rks_exec",
    "rks_exec_abort",
    "rks_apply",
    "rks_approve",
    "rks_refine",
    "rks_refine_apply",
    "rks_ready",
    "rks_review",
    "rks_story_create",
    "rks_guardrails_simulate",
  ],
  governance: [
    "rks_guardrails_off",
    "rks_guardrails_on",
    "rks_guardrails_abort",
    "rks_guardrails_status",
    "rks_phase_repair",
    "rks_arch_verdict",
    "rks_governor_init",
  ],
  "agent-bootstrap": [
    "rks_agent_run",
    "rks_agent_external_research",
    "rks_agent_validate_story",
    "rks_agent_research",
    "rks_agent_git",
    "rks_agent_dendron",
    "rks_agent_telemetry",
    "rks_agent_ship",
    "rks_agent_cycle_complete",
    "rks_agent_story",
    "rks_agent_delivery",
    "rks_agent_recovery",
    "rks_agent_plan",
    "rks_init",
    "rks_project_init",
    "rks_onboarder",
    "rks_interview",
  ],
  telemetry: [
    "rks_telemetry_digest",
    "rks_telemetry_query",
    "rks_telemetry_report",
    "rks_telemetry_analysis",
    "rks_token_cost_report",
    "rks_telemetry_export",
  ],
};

export const SUCCESS_EXEMPT_FAMILIES = {
  rag:
    "Every success path loads the embedding pipeline (getSharedEmbeddingPipeline / embedScopedFiles / runRagEmbed) " +
    "and, outside stub mode, downloads a model (P5a, step 3a); several also commit (rks_memory_save) or fetch over " +
    "the network (rks_fetch_raw). Covered by its validation-failure case only.",
  ship:
    "No member is read-only, and no member is established as fixture-local: each success path pushes, opens or " +
    "merges a PR through gh, syncs or releases against a remote, or commits/merges through a path that reaches " +
    "commitAndEmbed or review.mjs (@routekit/rag). The working-no-origin fixture has no remote. Covered by its " +
    "validation-failure case only.",
};

// Every entry is annotated read-only or fixture-local, uses FIXTURE_PROJECT_ID, and is a
// READ_ONLY_ALLOWLIST member (the only tools that may receive schema-valid args).
export const SUCCESS_CASES = [
  {
    family: "project-meta",
    tool: "rks_publish_profiles",
    annotation: "read-only",
    args: READ_ONLY_ALLOWLIST.rks_publish_profiles.args,
    expect: {
      keys: ["ok", "profiles", "remotes"],
      ok: true,
      check: (p) => {
        expect(p.profiles).toEqual([]);
        expect(p.remotes).toEqual([]);
      },
    },
  },
  {
    family: "dendron",
    tool: "dendron_read_note",
    annotation: "read-only",
    args: READ_ONLY_ALLOWLIST.dendron_read_note.args,
    expect: {
      keys: ["content", "filename", "ok"],
      ok: true,
      check: (p) => {
        expect(p.filename).toBe(FIXTURE_NOTE);
        expect(p.content).toContain("Fixture body.");
      },
    },
  },
  {
    family: "git",
    tool: "rks_stash",
    annotation: "read-only",
    args: READ_ONLY_ALLOWLIST.rks_stash.args,
    expect: {
      keys: ["action", "metadata", "ok", "stashes"],
      ok: true,
      check: (p) => {
        expect(p.action).toBe("list");
        expect(p.stashes).toEqual([]);
      },
    },
  },
  {
    family: "planner",
    tool: "rks_guardrails_simulate",
    annotation: "read-only",
    args: READ_ONLY_ALLOWLIST.rks_guardrails_simulate.args,
    expect: {
      keys: ["defaultScenario", "label", "matchedScenario", "policyPath", "scenarios"],
      ok: undefined,
      check: (p) => {
        expect(p.label).toBe("docs-change");
        expect(p.matchedScenario?.id).toBe("docs");
        expect(p.defaultScenario?.id).toBe("default");
      },
    },
  },
  {
    family: "governance",
    tool: "rks_guardrails_status",
    annotation: "read-only",
    args: READ_ONLY_ALLOWLIST.rks_guardrails_status.args,
    expect: {
      keys: ["ok", "sessions", "total"],
      ok: true,
      check: (p) => {
        expect(p.sessions).toEqual([]);
        expect(p.total).toBe(0);
      },
    },
  },
  {
    family: "agent-bootstrap",
    tool: "rks_onboarder",
    annotation: "fixture-local",
    args: READ_ONLY_ALLOWLIST.rks_onboarder.args,
    expect: {
      keys: ["display", "nextAction", "ok", "prompts", "stage", "state"],
      ok: true,
      check: (p) => {
        expect(p.state?.projectId).toBe(FIXTURE_PROJECT_ID);
        // Fixture-local: the onboarder state landed in the fixture, never in the repo.
        expect(fs.existsSync(path.join(fixture.workDir, ".rks", "onboarder-state.json"))).toBe(true);
      },
    },
  },
  {
    family: "telemetry",
    tool: "rks_telemetry_query",
    annotation: "read-only",
    args: READ_ONLY_ALLOWLIST.rks_telemetry_query.args,
    expect: {
      keys: ["events", "limit", "ok", "returned", "summary", "total"],
      ok: true,
      check: (p) => {
        expect(p.total).toBe(0);
        expect(p.events).toEqual([]);
      },
    },
  },
];

// One validation-failure case per family (args per P2/P3), asserted on content.
export const VALIDATION_FAILURE_CASES = [
  { family: "project-meta", tool: "rks_project_get", args: {}, expect: { mcpCode: -32603, message: /"id"/ } },
  // P3: server.mjs:4532-4533 — empty filename returns { ok: false, error: "Missing filename" }.
  { family: "dendron", tool: "dendron_read_note", args: {}, expect: { keys: ["error", "ok"], class: "payload:Missing filename" } },
  // P3: loadContext's McpError (server/project.mjs:115-120) is caught at server.mjs:3838 and returned as data.
  {
    family: "rag",
    tool: "rks_exhaustive_search",
    args: {},
    expect: { keys: ["error", "ok"], class: "payload:MCP error -32602", error: /projectId is required/ },
  },
  { family: "git", tool: "rks_git_preflight", args: {}, expect: { mcpCode: -32602, message: /projectId is required/ } },
  { family: "ship", tool: "rks_story_ship", args: {}, expect: { mcpCode: -32603, message: /"projectId"/ } },
  { family: "planner", tool: "rks_approve", args: {}, expect: { mcpCode: -32602, message: /required params projectId, planId, confirm/ } },
  { family: "governance", tool: "rks_guardrails_status", args: {}, expect: { mcpCode: -32603, message: /"projectId"/ } },
  {
    family: "agent-bootstrap",
    tool: "rks_agent_validate_story",
    args: {},
    expect: {
      keys: ["acceptedKeys", "agent", "error", "issues", "message", "ok", "unknownKeys"],
      class: "payload:invalid_agent_input",
    },
  },
  { family: "telemetry", tool: "rks_telemetry_query", args: {}, expect: { mcpCode: -32603, message: /"projectId"/ } },
];

// ── helpers ────────────────────────────────────────────────────────────────────────────────────
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

export function stableSurface(tools) {
  return [...tools]
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function serializeSurface(surfaceTools) {
  return JSON.stringify(sortKeysDeep(surfaceTools), null, 2);
}

/** Returns a list of human-readable mismatches between a live surface and golden tools ([] = equal). */
export function compareSurface(liveSurface, goldenTools) {
  const mismatches = [];
  const liveByName = new Map(liveSurface.map((t) => [t.name, t]));
  const goldenByName = new Map((goldenTools || []).map((t) => [t.name, t]));
  for (const name of liveByName.keys()) if (!goldenByName.has(name)) mismatches.push(`not in golden: ${name}`);
  for (const name of goldenByName.keys()) if (!liveByName.has(name)) mismatches.push(`not advertised: ${name}`);
  for (const [name, live] of liveByName) {
    const golden = goldenByName.get(name);
    if (golden && serializeSurface(live) !== serializeSurface(golden)) mismatches.push(`differs: ${name}`);
  }
  if (mismatches.length === 0 && serializeSurface(liveSurface) !== serializeSurface(goldenTools)) {
    mismatches.push("serialization differs (order or duplicate entries)");
  }
  return mismatches;
}

function goldenDocument(surfaceTools) {
  return {
    description:
      "Committed ListTools golden for packages/mcp-rks/src/server.mjs. Regenerate only with UPDATE_MCP_SURFACE_GOLDEN=1 and review the diff; a non-empty diff in a move-only story is a defect.",
    source: "createServer() + InMemoryTransport listTools(), tools sorted by name, fields name/description/inputSchema",
    tools: surfaceTools,
  };
}

function readGoldenBytes() {
  return fs.existsSync(GOLDEN_PATH) ? fs.readFileSync(GOLDEN_PATH) : null;
}

function parsePayload(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Outcome class of one call (P4). */
export function classifyOutcome(out) {
  if (out.kind === "mcpError") {
    return out.code === ErrorCode.MethodNotFound ? "METHOD_NOT_FOUND" : `mcp:${out.code}`;
  }
  const payload = out.payload;
  if (payload && payload.preflightFailed === true) return "PREFLIGHT";
  if (payload && payload.error === "unauthorized") return "UNAUTHORIZED";
  if (payload && payload.ok === false) {
    const reason = payload.error ?? payload.reason ?? "";
    return `payload:${String(typeof reason === "string" ? reason : JSON.stringify(reason)).split(/[:.]/)[0].trim()}`;
  }
  if (payload && payload.ok === true) return "OK";
  return "NO_OK_FIELD";
}

function collectProjectIds(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => collectProjectIds(v, out));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "projectId") out.push(v);
      collectProjectIds(v, out);
    }
  }
  return out;
}

function assertProjectIdPolicy(args, label) {
  for (const value of collectProjectIds(args)) {
    if (typeof value === "string") expect(value, `${label}: projectId must be FIXTURE_PROJECT_ID`).toBe(FIXTURE_PROJECT_ID);
  }
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function gitOut(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout };
}

function snapshotBackstop(fixtureBase) {
  return {
    head: gitOut(["rev-parse", "HEAD"], REPO_ROOT).stdout,
    branch: gitOut(["rev-parse", "--abbrev-ref", "HEAD"], REPO_ROOT).stdout,
    porcelain: gitOut(["status", "--porcelain"], REPO_ROOT).stdout,
    fixtureParent: fs.readdirSync(fixtureBase).sort(),
    cwdParent: fs.readdirSync(path.resolve(process.cwd(), "..")).sort(),
  };
}

/** Does this agent module's relative-import closure contain a quoted @routekit/rag specifier? */
export function agentModuleReachesRag(file, seen = new Set()) {
  if (seen.has(file) || !fs.existsSync(file)) return false;
  seen.add(file);
  const src = fs.readFileSync(file, "utf8");
  if (/['"`]@routekit\/rag(?:\/[^'"`]*)?['"`]/.test(src)) return true;
  const rel = [...src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.\.?\/[^'"]+\.mjs)['"]/g)].map((m) => m[1]);
  return rel.some((spec) => agentModuleReachesRag(path.resolve(path.dirname(file), spec), seen));
}
const AGENT_TOOL_MODULES = {
  rks_agent_validate_story: "product-owner.mjs",
  rks_agent_research: "research.mjs",
  rks_agent_git: "git.mjs",
  rks_agent_dendron: "dendron.mjs",
  rks_agent_telemetry: "telemetry.mjs",
  rks_agent_ship: "ship.mjs",
  rks_agent_cycle_complete: "cycle-complete.mjs",
  rks_agent_story: "story.mjs",
  rks_agent_delivery: "delivery.mjs",
  rks_agent_recovery: "recovery.mjs",
  rks_agent_plan: "planner.mjs",
  rks_agent_external_research: "external-research.mjs",
};

// ── suite state ────────────────────────────────────────────────────────────────────────────────
let fixture; // { base, workDir }
let serverModule;
let governorTokenModule;
let dendronModule;
let projectContextModule;
let client;
let server;
let liveTools;
let advertisedNames;
let backstopBefore;
let goldenBytesAtStart;
let isolationVerified = false;
let callCount = 0;
let scrubbedAbsentAtFirstCall;
let sweepOutcomes;

async function connect() {
  const s = serverModule.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "mcp-surface-characterization", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([s.connect(serverTransport), c.connect(clientTransport)]);
  return { client: c, server: s };
}

/**
 * The ONLY path to callTool in this file. Re-verifies, before EVERY call, that dendron's root and
 * the project-context root of FIXTURE_PROJECT_ID are the fixture and not the repo, that the
 * credential scrub still holds, and that every projectId in the args is the fixture id.
 */
async function guardedCall(name, args) {
  expect(isolationVerified, "isolation must be verified before the first callTool").toBe(true);
  const dendronRoot = dendronModule.resolveProjectRoot();
  const contextRoot = (await projectContextModule.loadProjectContext(FIXTURE_PROJECT_ID, REPO_ROOT)).record.root;
  for (const root of [dendronRoot, contextRoot]) {
    expect(root).toBe(fixture.workDir);
    expect(root).not.toBe(REPO_ROOT);
    expect(isUnder(root, REPO_ROOT), `${root} must not lie under the repo`).toBe(false);
  }
  for (const key of SCRUBBED_KEYS) expect(process.env[key], `${key} must stay scrubbed`).toBeUndefined();
  expect(process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE).toBe("stub");
  assertProjectIdPolicy(args, name);
  if (callCount === 0) scrubbedAbsentAtFirstCall = SCRUBBED_KEYS.every((k) => !(k in process.env));
  callCount++;
  try {
    const result = await client.callTool({ name, arguments: args });
    return { kind: "result", result, payload: parsePayload(result) };
  } catch (err) {
    if (typeof err?.code === "number") return { kind: "mcpError", code: err.code, message: String(err.message) };
    throw err;
  }
}

function sweepArgsFor(name) {
  if (READ_ONLY_ALLOWLIST[name]) return READ_ONLY_ALLOWLIST[name].args;
  if (P2_ARG_OVERRIDES[name]) return P2_ARG_OVERRIDES[name];
  if (NO_REGISTERED_SCHEMA_SWEEP[name]) return NO_REGISTERED_SCHEMA_SWEEP[name].args;
  return {}; // P1
}

/** P6 classifier: names in none of TOOL_ARG_SCHEMAS, NO_REGISTERED_SCHEMA_SWEEP, READ_ONLY_ALLOWLIST. */
export function unclassifiedTools(names, toolArgSchemas) {
  return names.filter((n) => !(n in toolArgSchemas) && !(n in NO_REGISTERED_SCHEMA_SWEEP) && !(n in READ_ONLY_ALLOWLIST));
}

/** Bijection checker: names whose call yields MethodNotFound / "Unknown tool:". */
export async function findUndispatched(names, argsFor, call) {
  const failures = [];
  for (const name of names) {
    const out = await call(name, argsFor(name));
    if (classifyOutcome(out) === "METHOD_NOT_FOUND" || (out.kind === "mcpError" && out.message.includes("Unknown tool:"))) {
      failures.push(name);
    }
  }
  return failures;
}

beforeAll(async () => {
  // 1. Fixture outside the repo, no remote, no .env (## Solution, Sweep isolation step 1).
  fixture = getRepoCopy("working-no-origin");
  const root = fixture.workDir;
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, "guardrails"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".rks", "project.json"),
    JSON.stringify({ id: FIXTURE_PROJECT_ID, root, kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "project: mcp-surface-characterization-fixture\n");
  fs.writeFileSync(
    path.join(root, "notes", `${FIXTURE_NOTE}.md`),
    `---\nid: ${FIXTURE_NOTE}\ntitle: Fixture note\ndesc: Characterization fixture note\nupdated: 1\ncreated: 1\n---\n\nFixture body.\n`,
  );
  fs.writeFileSync(
    path.join(root, "guardrails", "policy.json"),
    JSON.stringify(
      {
        default: { id: "default", description: "Default scenario", allowedTools: ["rks_plan"], requiresReview: false },
        scenarios: [
          { id: "docs", description: "Docs-only change", match: { labels: ["docs"] }, allowedTools: ["dendron_edit_note"], requiresReview: false },
        ],
      },
      null,
      2,
    ),
  );

  // 2. Routing pinned to the fixture.
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  process.env.ROUTEKIT_PROJECT_ID = FIXTURE_PROJECT_ID;

  goldenBytesAtStart = readGoldenBytes();

  // 3a. Only now: dynamic imports of packages/** modules.
  serverModule = await importPackageModule(SERVER_MODULE);
  governorTokenModule = await importPackageModule(GOVERNOR_TOKEN_MODULE);
  dendronModule = await importPackageModule(DENDRON_MODULE);
  projectContextModule = await importPackageModule(PROJECT_CONTEXT_MODULE);

  // Isolation verification (also asserted, with messages, in the "(b) isolation" test below).
  const remotes = gitOut(["remote"], root);
  isolationVerified =
    isUnder(root, os.tmpdir()) &&
    !isUnder(root, REPO_ROOT) &&
    remotes.status === 0 &&
    remotes.stdout.trim() === "" &&
    !fs.existsSync(path.join(root, ".env")) &&
    process.env.ROUTEKIT_PROJECT_ROOT === root &&
    process.env.ROUTEKIT_PROJECT_ID === FIXTURE_PROJECT_ID &&
    ROUTING_UNSET_KEYS.every((k) => !(k in process.env)) &&
    SCRUBBED_KEYS.every((k) => !(k in process.env)) &&
    dendronModule.resolveProjectRoot() === root &&
    (await projectContextModule.loadProjectContext(FIXTURE_PROJECT_ID, REPO_ROOT)).record.root === root;

  ({ client, server } = await connect());
  ({ tools: liveTools } = await client.listTools());
  advertisedNames = liveTools.map((t) => t.name).sort();

  if (UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, JSON.stringify(sortKeysDeep(goldenDocument(stableSurface(liveTools))), null, 2) + "\n");
  }

  // 5. Backstop snapshot: after the (opt-in) golden write, before the first callTool.
  expect(callCount).toBe(0);
  backstopBefore = snapshotBackstop(fixture.base);
}, 120_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  disposeTemplates();
  fs.rmSync(SCRUB_HOME, { recursive: true, force: true });
});

describe("server.mjs MCP surface characterization", () => {
  // ── (b) isolation, before the first call ─────────────────────────────────────────────────────
  describe("(b) sweep isolation before the first callTool", () => {
    it("no callTool has been issued yet, and the fixture/routing/scrub are in place", () => {
      expect(callCount).toBe(0);
      const root = fixture.workDir;
      expect(isUnder(root, os.tmpdir()), `${root} must be under os.tmpdir()`).toBe(true);
      expect(isUnder(root, REPO_ROOT)).toBe(false);
      expect(gitOut(["remote"], root).stdout.trim(), "fixture must have no git remote").toBe("");
      expect(fs.existsSync(path.join(root, ".env")), "fixture must have no .env").toBe(false);
      expect(process.env.ROUTEKIT_PROJECT_ROOT).toBe(root);
      expect(process.env.ROUTEKIT_PROJECT_ID).toBe(FIXTURE_PROJECT_ID);
      for (const key of ROUTING_UNSET_KEYS) expect(process.env[key], `${key} must be unset`).toBeUndefined();
      for (const key of SCRUBBED_KEYS) expect(key in process.env, `${key} must be deleted`).toBe(false);
      expect(process.env.HOME).toBe(SCRUB_HOME);
      expect(isUnder(process.env.GH_CONFIG_DIR, SCRUB_HOME)).toBe(true);
      expect(isUnder(process.env.XDG_CONFIG_HOME, SCRUB_HOME)).toBe(true);
      expect(isolationVerified).toBe(true);
    });

    it("embeddings mode was stub immediately before the first packages/** import", () => {
      expect(packageImportCount).toBeGreaterThan(0);
      expect(embeddingsModeAtFirstImport).toBe("stub");
    });

    it("neither test file statically imports packages/** or @routekit/*; package modules load via import()", () => {
      for (const file of [fileURLToPath(import.meta.url), BOOT_SMOKE_PATH]) {
        const src = fs.readFileSync(file, "utf8");
        const staticSpecifiers = [...src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
        expect(staticSpecifiers.length, `${file}: static imports found`).toBeGreaterThan(0);
        for (const spec of staticSpecifiers) {
          const allowed =
            spec === "vitest" ||
            spec.startsWith("node:") ||
            spec.startsWith("@modelcontextprotocol/sdk/") ||
            spec.startsWith("../helpers/");
          expect(allowed, `${path.basename(file)}: static import ${spec} is not permitted (step 3a)`).toBe(true);
          expect(spec.includes("packages/")).toBe(false);
          expect(spec.startsWith("@routekit/")).toBe(false);
        }
      }
      // The four package modules this file needs are named only in dynamic-import constants.
      for (const spec of [SERVER_MODULE, GOVERNOR_TOKEN_MODULE, DENDRON_MODULE, PROJECT_CONTEXT_MODULE]) {
        expect(spec.startsWith("../../packages/mcp-rks/src/")).toBe(true);
      }
    });
  });

  // ── (a) ListTools golden ─────────────────────────────────────────────────────────────────────
  describe("(a) tool-surface golden", () => {
    it("ListTools matches the committed golden byte-for-byte after stable serialization", () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
      const live = stableSurface(liveTools);
      expect(Array.isArray(golden.tools)).toBe(true);
      expect(golden.tools.length).toBeGreaterThan(0);
      expect(golden.tools.length).toBe(liveTools.length);
      expect(compareSurface(live, golden.tools)).toEqual([]);
      expect(serializeSurface(live)).toBe(serializeSurface(golden.tools));
    });

    it("the golden is written only under UPDATE_MCP_SURFACE_GOLDEN=1; a normal run leaves it byte-identical", () => {
      if (UPDATE_GOLDEN) {
        expect(readGoldenBytes()).not.toBeNull();
        return;
      }
      expect(goldenBytesAtStart, "golden must exist for a normal run").not.toBeNull();
      expect(Buffer.compare(readGoldenBytes(), goldenBytesAtStart)).toBe(0);
    });

    it("negative control: a mutated description and a removed tool each make the comparator report a mismatch", () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
      const live = stableSurface(liveTools);
      const altered = structuredClone(golden.tools);
      altered[0].description = `${altered[0].description} (mutated)`;
      expect(compareSurface(live, altered)).toEqual([`differs: ${altered[0].name}`]);
      const removed = structuredClone(golden.tools);
      const [dropped] = removed.splice(removed.length - 1, 1);
      expect(compareSurface(live, removed)).toEqual([`not in golden: ${dropped.name}`]);
      // The committed skeleton shape (empty tools array) must fail too.
      expect(compareSurface(live, []).length).toBe(live.length);
    });

    it("determinism: two createServer() instances, and credential keys stubbed vs unset, give identical surfaces", async () => {
      const second = await connect();
      let withKeys;
      try {
        // Stubbed keys are set ONLY around listTools and removed before any further callTool.
        process.env.ANTHROPIC_API_KEY = "stub-not-a-key";
        process.env.OPENAI_API_KEY = "stub-not-a-key";
        try {
          ({ tools: withKeys } = await second.client.listTools());
        } finally {
          delete process.env.ANTHROPIC_API_KEY;
          delete process.env.OPENAI_API_KEY;
        }
        const { tools: secondTools } = await second.client.listTools();
        expect(serializeSurface(stableSurface(secondTools))).toBe(serializeSurface(stableSurface(liveTools)));
      } finally {
        await second.client.close().catch(() => {});
        await second.server.close().catch(() => {});
      }
      expect(serializeSurface(stableSurface(withKeys))).toBe(serializeSurface(stableSurface(liveTools)));
      expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
      expect("OPENAI_API_KEY" in process.env).toBe(false);
    });

    it("the serialized golden contains neither the repo root nor a home directory", () => {
      const text = fs.readFileSync(GOLDEN_PATH, "utf8");
      for (const needle of [REPO_ROOT, ORIGINAL_HOME, ORIGINAL_USER_HOME, os.homedir(), SCRUB_HOME].filter(Boolean)) {
        expect(text.includes(needle), `golden must not contain ${needle}`).toBe(false);
      }
    });

    it("roster: protected tools advertise _governorToken; UNPROTECTED_TOOLS members do not", () => {
      const { UNPROTECTED_TOOLS } = governorTokenModule;
      expect(UNPROTECTED_TOOLS.size).toBeGreaterThan(0);
      let protectedCount = 0;
      let unprotectedCount = 0;
      for (const tool of liveTools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description, `${tool.name} description`).toBeTruthy();
        expect(tool.inputSchema?.type, `${tool.name} inputSchema.type`).toBe("object");
        const hasToken = Boolean(tool.inputSchema.properties?._governorToken);
        if (UNPROTECTED_TOOLS.has(tool.name)) {
          unprotectedCount++;
          expect(hasToken, `unprotected ${tool.name} must not have _governorToken injected`).toBe(false);
        } else {
          protectedCount++;
          expect(hasToken, `protected ${tool.name} must advertise _governorToken`).toBe(true);
        }
      }
      expect(protectedCount).toBeGreaterThan(0);
      expect(unprotectedCount).toBeGreaterThan(0);
      expect(new Set(advertisedNames).size).toBe(advertisedNames.length);
    });
  });

  // ── (b) args policy and dispatch bijection ───────────────────────────────────────────────────
  describe("(b) args policy P1–P6 and dispatch bijection", () => {
    it("P5a: RAG_REACHING_TOOLS holds the required minimum and every rag-importing agent tool", () => {
      for (const t of ["rks_rag_init", "rks_rag_embed", "rks_rag_query", "rks_rag_compact", "rks_exhaustive_search"]) {
        expect(RAG_REACHING_TOOLS.has(t), t).toBe(true);
      }
      const advertisedAgentTools = advertisedNames.filter((n) => n.startsWith("rks_agent_") && n !== "rks_agent_run");
      for (const tool of advertisedAgentTools) {
        expect(AGENT_TOOL_MODULES[tool], `${tool} needs an agent-module mapping`).toBeTruthy();
        if (agentModuleReachesRag(path.join(AGENTS_SRC_DIR, AGENT_TOOL_MODULES[tool]))) {
          expect(RAG_REACHING_TOOLS.has(tool), `${tool}'s agent module reaches @routekit/rag`).toBe(true);
        }
      }
      // Positive control for the scanner: research.mjs imports @routekit/rag directly.
      expect(agentModuleReachesRag(path.join(AGENTS_SRC_DIR, "research.mjs"))).toBe(true);
      expect(RAG_REACHING_TOOLS.has("rks_agent_run")).toBe(true);
    });

    it("P5/P5a: no READ_ONLY_ALLOWLIST or SUCCESS_CASES entry is RAG- or network-reaching", () => {
      for (const name of Object.keys(READ_ONLY_ALLOWLIST)) {
        expect(RAG_REACHING_TOOLS.has(name), `${name} is RAG-reaching`).toBe(false);
        expect(NETWORK_REACHING_TOOLS.has(name), `${name} is network-reaching`).toBe(false);
        expect(READ_ONLY_ALLOWLIST[name].justification.length).toBeGreaterThan(40);
      }
      for (const c of SUCCESS_CASES) {
        expect(RAG_REACHING_TOOLS.has(c.tool), `${c.tool} is RAG-reaching`).toBe(false);
        expect(NETWORK_REACHING_TOOLS.has(c.tool), `${c.tool} is network-reaching`).toBe(false);
        expect(READ_ONLY_ALLOWLIST[c.tool], `${c.tool} must be READ_ONLY_ALLOWLIST (schema-valid args)`).toBeTruthy();
      }
      expect(NETWORK_REACHING_TOOLS.has("rks_fetch_raw")).toBe(true);
      expect(NETWORK_REACHING_TOOLS.has("rks_agent_external_research")).toBe(true);
    });

    it("every projectId in every committed args map is FIXTURE_PROJECT_ID or a non-string; allowlisted args are schema-valid and pinned", () => {
      const maps = [
        ...Object.entries(READ_ONLY_ALLOWLIST).map(([n, e]) => [n, e.args]),
        ...Object.entries(P2_ARG_OVERRIDES),
        ...Object.entries(NO_REGISTERED_SCHEMA_SWEEP).map(([n, e]) => [n, e.args]),
        ...SUCCESS_CASES.map((c) => [c.tool, c.args]),
        ...VALIDATION_FAILURE_CASES.map((c) => [c.tool, c.args]),
      ];
      for (const [name, args] of maps) assertProjectIdPolicy(args, name);
      const { TOOL_ARG_SCHEMAS } = serverModule;
      for (const [name, entry] of Object.entries(READ_ONLY_ALLOWLIST)) {
        expect(advertisedNames, `${name} must be advertised`).toContain(name);
        const schema = TOOL_ARG_SCHEMAS[name];
        if (schema) {
          const parsed = schema.safeParse(entry.args);
          expect(parsed.success, `${name} allowlisted args must be schema-valid`).toBe(true);
          if (entry.argsInvariant) expect(entry.argsInvariant(parsed.data), `${name} args invariant`).toBe(true);
        }
      }
    });

    it("P2: overrides exist only where the registered schema accepts {}, and each fails safeParse", () => {
      const { TOOL_ARG_SCHEMAS } = serverModule;
      for (const name of advertisedNames) {
        const schema = TOOL_ARG_SCHEMAS[name];
        if (!schema || READ_ONLY_ALLOWLIST[name]) continue;
        if (schema.safeParse({}).success) expect(P2_ARG_OVERRIDES[name], `${name} accepts {} and needs an override or allowlisting`).toBeTruthy();
        expect(schema.safeParse(sweepArgsFor(name)).success, `${name} sweep args must fail its schema`).toBe(false);
      }
      for (const name of Object.keys(P2_ARG_OVERRIDES)) expect(TOOL_ARG_SCHEMAS[name], `${name} override needs a registered schema`).toBeTruthy();
    });

    it("P3: every advertised tool without a registered schema is cited in NO_REGISTERED_SCHEMA_SWEEP or allowlisted", () => {
      const { TOOL_ARG_SCHEMAS } = serverModule;
      for (const name of advertisedNames) {
        if (name in TOOL_ARG_SCHEMAS) continue;
        const entry = NO_REGISTERED_SCHEMA_SWEEP[name];
        if (READ_ONLY_ALLOWLIST[name]) continue;
        expect(entry, `${name} has no registered schema and is not cited in NO_REGISTERED_SCHEMA_SWEEP`).toBeTruthy();
        expect(entry.args && typeof entry.args === "object").toBe(true);
        expect(typeof entry.citation === "string" && entry.citation.trim().length > 0, `${name} citation`).toBe(true);
      }
      for (const name of Object.keys(NO_REGISTERED_SCHEMA_SWEEP)) {
        expect(advertisedNames, `${name} cited but not advertised`).toContain(name);
        expect(name in TOOL_ARG_SCHEMAS, `${name} has a registered schema; use P2`).toBe(false);
      }
    });

    it("P6 fail-closed: every advertised tool is classified; a fabricated unclassified name is reported exactly", () => {
      const { TOOL_ARG_SCHEMAS } = serverModule;
      expect(unclassifiedTools(advertisedNames, TOOL_ARG_SCHEMAS)).toEqual([]);
      expect(unclassifiedTools([...advertisedNames, FABRICATED_TOOL], TOOL_ARG_SCHEMAS)).toEqual([FABRICATED_TOOL]);
    });

    it("sweep: every advertised tool reaches dispatch; every non-allowlisted response is a rejection matching the committed map", async () => {
      // Non-vacuity: isProtectedTool() is true for unknown names, so without the token-skip
      // environment the gate would refuse before dispatch and the bijection would prove nothing.
      expect(process.env.NODE_ENV === "test" || process.env.RKS_TEST_MODE === "1").toBe(true);
      for (const key of SCRUBBED_KEYS) expect(key in process.env).toBe(false);
      const { TOOL_ARG_SCHEMAS } = serverModule;
      const classes = {};
      const problems = [];
      for (const name of advertisedNames) {
        const args = sweepArgsFor(name);
        const allowlisted = Boolean(READ_ONLY_ALLOWLIST[name]);
        if (!allowlisted && TOOL_ARG_SCHEMAS[name]) {
          expect(TOOL_ARG_SCHEMAS[name].safeParse(args).success, `${name}: P2 args must fail safeParse before the call`).toBe(false);
        }
        const out = await guardedCall(name, args);
        const cls = classifyOutcome(out);
        classes[name] = cls;
        if (cls === "METHOD_NOT_FOUND") problems.push(`${name}: MethodNotFound`);
        if (cls === "PREFLIGHT" || cls === "UNAUTHORIZED") problems.push(`${name}: did not reach dispatch (${cls})`);
        if (!allowlisted && !(cls.startsWith("mcp:") || cls.startsWith("payload:"))) problems.push(`${name}: not a rejection (${cls})`);
        if (!allowlisted && out.payload?.ok === true) problems.push(`${name}: ok:true on a non-allowlisted call`);
        if (allowlisted && !(cls === "OK" || cls === "NO_OK_FIELD")) problems.push(`${name}: allowlisted call failed (${cls})`);
      }
      sweepOutcomes = classes;
      for (const key of SCRUBBED_KEYS) expect(key in process.env, `${key} after the sweep`).toBe(false);
      expect(scrubbedAbsentAtFirstCall).toBe(true);
      expect(problems).toEqual([]);
      expect(classes).toEqual(EXPECTED_SWEEP_CLASSES);
    });

    it("bijection: no advertised name yields MethodNotFound / Unknown tool:", async () => {
      expect(sweepOutcomes, "sweep must have run").toBeTruthy();
      expect(Object.keys(sweepOutcomes).sort()).toEqual(advertisedNames);
      expect(Object.entries(sweepOutcomes).filter(([, c]) => c === "METHOD_NOT_FOUND")).toEqual([]);
    });

    it("an unadvertised fabricated name yields McpError MethodNotFound (-32601) with 'Unknown tool:'", async () => {
      expect(advertisedNames).not.toContain(FABRICATED_TOOL);
      const out = await guardedCall(FABRICATED_TOOL, {});
      expect(out.kind).toBe("mcpError");
      expect(out.code).toBe(-32601);
      expect(ErrorCode.MethodNotFound).toBe(-32601);
      expect(out.message).toContain("Unknown tool:");
    });

    it("negative control: the bijection checker reports exactly a fabricated advertised name with no dispatch path", async () => {
      const fabricatedAdvertised = ["rks_project_get", FABRICATED_TOOL];
      const failures = await findUndispatched(fabricatedAdvertised, (n) => (n === FABRICATED_TOOL ? {} : sweepArgsFor(n)), guardedCall);
      expect(failures).toEqual([FABRICATED_TOOL]);
    });
  });

  // ── (c) response characterization ────────────────────────────────────────────────────────────
  describe("(c) per-family response content", () => {
    it("families are disjoint, cover every advertised tool and every unadvertised dispatch head", async () => {
      const all = Object.values(FAMILIES).flat();
      expect(new Set(all).size, "families must be disjoint").toBe(all.length);
      for (const name of advertisedNames) expect(all, `${name} must belong to a family`).toContain(name);
      const known = new Set([...advertisedNames, ...UNADVERTISED_DISPATCH_HEADS]);
      for (const name of all) expect(known.has(name), `${name} is neither advertised nor a known dispatch head`).toBe(true);
      expect(FAMILIES.telemetry).toEqual(expect.arrayContaining([
        "rks_telemetry_digest", "rks_telemetry_query", "rks_telemetry_report",
        "rks_telemetry_analysis", "rks_token_cost_report", "rks_telemetry_export",
      ]));
      // Each unadvertised head is proven to be a dispatch head: {} reaches its branch's parse.
      for (const name of UNADVERTISED_DISPATCH_HEADS) {
        expect(advertisedNames).not.toContain(name);
        const out = await guardedCall(name, {});
        expect(classifyOutcome(out), `${name} must reach a dispatch branch`).toBe("mcp:-32603");
      }
    });

    it("each family has a validation-failure case and a success case unless exempted with a reason", () => {
      expect(SUCCESS_EXEMPT_FAMILIES.rag?.trim().length).toBeGreaterThan(0);
      for (const family of Object.keys(FAMILIES)) {
        const failures = VALIDATION_FAILURE_CASES.filter((c) => c.family === family);
        expect(failures.length, `${family} needs a validation-failure case`).toBeGreaterThan(0);
        for (const c of failures) expect(FAMILIES[family]).toContain(c.tool);
        const successes = SUCCESS_CASES.filter((c) => c.family === family);
        if (SUCCESS_EXEMPT_FAMILIES[family]) {
          expect(SUCCESS_EXEMPT_FAMILIES[family].trim().length).toBeGreaterThan(0);
          expect(successes).toEqual([]);
        } else {
          expect(successes.length, `${family} needs a success case or an exemption`).toBeGreaterThan(0);
        }
        for (const c of successes) {
          expect(FAMILIES[family]).toContain(c.tool);
          expect(["read-only", "fixture-local"]).toContain(c.annotation);
        }
      }
      // A family whose every member is RAG-reaching must be exempt (## Solution, (c)).
      for (const [family, members] of Object.entries(FAMILIES)) {
        if (members.every((m) => RAG_REACHING_TOOLS.has(m))) expect(SUCCESS_EXEMPT_FAMILIES[family], family).toBeTruthy();
      }
    });

    for (const c of VALIDATION_FAILURE_CASES) {
      it(`validation failure [${c.family}] ${c.tool}`, async () => {
        const schema = serverModule.TOOL_ARG_SCHEMAS[c.tool];
        if (schema) expect(schema.safeParse(c.args).success, `${c.tool}: P2 args must fail safeParse`).toBe(false);
        const out = await guardedCall(c.tool, c.args);
        if (c.expect.mcpCode !== undefined) {
          expect(out.kind).toBe("mcpError");
          expect(out.code).toBe(c.expect.mcpCode);
          expect(out.message).toMatch(c.expect.message);
        } else {
          expect(out.kind).toBe("result");
          expect(Object.keys(out.payload).sort()).toEqual(c.expect.keys);
          expect(out.payload.ok).toBe(false);
          expect(classifyOutcome(out)).toBe(c.expect.class);
          if (c.expect.error) expect(out.payload.error).toMatch(c.expect.error);
        }
      });
    }

    for (const c of SUCCESS_CASES) {
      it(`success [${c.family}] ${c.tool} (${c.annotation})`, async () => {
        const out = await guardedCall(c.tool, c.args);
        expect(out.kind).toBe("result");
        expect(out.payload, `${c.tool} must return JSON`).not.toBeNull();
        expect(Object.keys(out.payload).sort()).toEqual(c.expect.keys);
        expect(out.payload.ok).toBe(c.expect.ok);
        if (c.expect.check) c.expect.check(out.payload);
      });
    }

    it("governor chain: ops token from rks_governor_init; a throwing call reverts its entry transition, a returned failure keeps it", async () => {
      const { getSession } = governorTokenModule;
      const init = await guardedCall("rks_governor_init", READ_ONLY_ALLOWLIST.rks_governor_init.args);
      expect(init.kind).toBe("result");
      expect(init.payload.ok).toBe(true);
      const token = init.payload.token;
      expect(typeof token).toBe("string");
      const session = getSession(token);
      expect(session.projectId).toBe(FIXTURE_PROJECT_ID);
      expect(session.flowType).toBe("ops");
      expect(session.state).toBe("init");

      // rks_release (ops init → executing on entry) with schema-invalid args: the parse throws,
      // and the catch path gives the entry transition back (server.mjs:4998-5000).
      const thrown = await guardedCall("rks_release", { _governorToken: token });
      expect(classifyOutcome(thrown)).toBe("mcp:-32603");
      expect(getSession(token).state).toBe("init");

      // rks_agent_run (ops init → executing on entry) with {}: getAgent(undefined) RETURNS
      // { ok: false } (server.mjs:4929-4930); the generic path keeps the entry transition.
      const returned = await guardedCall("rks_agent_run", { _governorToken: token });
      expect(classifyOutcome(returned)).toBe("payload:Unknown agent");
      expect(getSession(token).state).toBe("executing");
    });
  });

  // ── (d) export-surface pin ───────────────────────────────────────────────────────────────────
  describe("(d) export-surface pin", () => {
    it("Object.keys of the live server.mjs module equals the committed list", () => {
      expect(Object.keys(serverModule).sort()).toEqual([...EXPECTED_SERVER_EXPORTS].sort());
      expect(EXPECTED_SERVER_EXPORTS).toHaveLength(11);
    });
  });

  // ── (e) cross-check of the boot smoke's tool choice ──────────────────────────────────────────
  describe("(e) boot-smoke tool cross-check", () => {
    it("the boot smoke calls a tool in UNPROTECTED_TOOLS ∩ READ_ONLY_ALLOWLIST that is not RAG- or network-reaching", () => {
      const src = fs.readFileSync(BOOT_SMOKE_PATH, "utf8");
      const m = src.match(/export const BOOT_SMOKE_TOOL = "([a-z_]+)"/);
      expect(m, "boot smoke must declare BOOT_SMOKE_TOOL").toBeTruthy();
      const tool = m[1];
      expect(governorTokenModule.UNPROTECTED_TOOLS.has(tool)).toBe(true);
      expect(READ_ONLY_ALLOWLIST[tool]).toBeTruthy();
      expect(RAG_REACHING_TOOLS.has(tool)).toBe(false);
      expect(NETWORK_REACHING_TOOLS.has(tool)).toBe(false);
    });
  });

  // ── (b) backstop — LAST: covers every call above ─────────────────────────────────────────────
  describe("(b) backstop", () => {
    it("real repo HEAD, branch and porcelain, and the fixture-parent and cwd-parent listings are unchanged", () => {
      expect(callCount).toBeGreaterThan(advertisedNames.length);
      const after = snapshotBackstop(fixture.base);
      expect(after).toEqual(backstopBefore);
      for (const key of SCRUBBED_KEYS) expect(key in process.env).toBe(false);
    });
  });
});
