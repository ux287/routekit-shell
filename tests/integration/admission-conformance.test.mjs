// backlog.feat.admission-conformance-suite
// backlog.feat.admission-conformance-strict-baseline (strict AC 7 governance baseline)
// Server admission conformance matrix (AC 1-7, 9-11, 13-15). Black-box: every assertion is on a tools/call response.
// Every server points at a makeFixtureRoot mkdtemp repo, never at this checkout (AC 13).
// Telemetry is not mocked; if it ever must be, use the vi.importActual escape (server-lane-gate.test.mjs:22).
//
// The corpus (tests/integration/fixtures/admission-conformance.corpus.json) is regenerated only with
// UPDATE_ADMISSION_CORPUS=1 (precedent: UPDATE_MCP_SURFACE_GOLDEN in mcp-surface-characterization.test.mjs).
// CASE_SPECS below holds only the INPUTS of each case (lane, fixture, setup, args, dimension labels);
// every expected decision in the corpus is observed output, never hand-written (AC 11).
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: vi.fn(async () => ({ ok: true, summary: "conformance stub" })) };
});

// AC 10: no embedder, index build or retrieval model in-process.
vi.mock("@routekit/rag", async (importOriginal) => {
  const actual = await importOriginal();
  const stub = () => vi.fn(async () => ({ ok: true, stub: "admission-conformance" }));
  return { ...actual, runRagEmbed: stub(), runRagInit: stub(), runRagReset: stub(), runRagQuery: stub(), runRagCompact: stub(), ensureRagIndex: stub() };
});

// AC 15: the mock tier has no testTimeout, so every it passes one explicitly.
const MATRIX_TIMEOUT_MS = 600_000;
const CASE_TIMEOUT_MS = 120_000;
const STDIO_TIMEOUT_MS = 300_000;

const { createServer: realCreateServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { tokenGateBypass } = await import("../../packages/mcp-rks/src/shared/token-gate-bypass.mjs");
const { isProtectedTool, validateToken } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");
const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
const rag = await import("@routekit/rag");
const {
  connectInProcess, connectStdio, stdioEnv, makeFixtureRoot, withCaseEnv, replayCase, normaliseDecision,
  repoLeaks, sessionFilesMentioning, loadCorpus, ADMISSION_REASONS, LANES, FLOW_TYPES, CLIENT_PROFILES,
  parseBody, replayOnFreshFixture, FIXTURE_PROJECT_ID, FIXTURE_STORY_ID, CORPUS_PATH, REPO_ROOT,
  SCRUBBED_ENV, FIXTURE_ENV, repoAnchor, writeCorpusSections,
  classifyThrownMessage, THROWN_MESSAGE_PATTERNS, UNCLASSIFIED, SetupStepError, governorSessionTokens,
  FIXTURE_WORKTREE_CHANGE, auditFixtureSessions,
} = await import("../helpers/admission-conformance.mjs");

const UPDATE_CORPUS = process.env.UPDATE_ADMISSION_CORPUS === "1";
const corpusBytesAtStart = fs.existsSync(CORPUS_PATH) ? fs.readFileSync(CORPUS_PATH) : null;

// AC 13: every token any replay minted, scanned by repoLeaks in the AC13 isolation block.
const minted = [];
// AC 10: replayCase counts runAgent stub calls across the case call only.
const agentCallCount = () => runAgent.mock.calls.length;

// backlog.feat.admission-conformance-strict-baseline AC 3: a SIMULATED owner lockout, test-side only. It
// wraps a real server's tools/call handler so that a tokened ide-lane call to one of LOCKOUT_TOOLS throws
// McpError(-32603, "principal policy: owner identity not verified") before dispatch. It encodes no policy
// (F3): it is a control proving the AC7 baseline check can see a lockout that throws.
// backlog.feat.admission-conformance-hardening AC 4 (finding F3-review), the in-handler lockout limit: the
// simulated lockout throws in front of the whole tools/call handler, so it is seen. A real lockout placed
// inside a handler is a different matter. The chain gate (checkAllowedTool, called from the tools/call
// handler in packages/mcp-rks/src/server.mjs) runs first; handler dispatch follows it, and the handler's own
// zod argument parse runs inside the handler, after checkAllowedTool. That ordering is verified for
// rks_release (packages/mcp-rks/src/server/handlers/ship.mjs: the schema .parse(cleanArgs) runs before
// runRelease). So a lockout placed inside a handler, after the chain gate and after the handler's own
// argument parse, cannot be seen by the AC7 baseline for a member whose args fail that parse (every
// side-effecting member does, by design: ops:init:rks_release records thrown:-32603:zod:version before such
// a lockout could run). A lockout placed inside a handler before its parse would still be visible. No
// valid-args baseline member is added: every LOCKOUT_TOOLS member is side-effecting, and a valid-args call
// would run its effect.
const LOCKOUT_TOOLS = Object.freeze(["rks_release", "rks_promote", "rks_tag", "rks_sync_staging", "rks_git_commit", "rks_refine"]);
const LOCKOUT_CASES = Object.freeze(["ops:init:rks_release", "ops:init:rks_promote", "ops:init:rks_tag", "ops:init:rks_sync_staging", "ship:init:rks_git_commit", "story:init:rks_refine"]);
const LOCKOUT_MESSAGE = "principal policy: owner identity not verified";
function withSimulatedLockout(factory) {
  return () => {
    const server = factory();
    const handlers = server._requestHandlers;
    if (!(handlers instanceof Map) || typeof handlers.get("tools/call") !== "function") throw new Error("simulated lockout: no tools/call handler to wrap");
    const inner = handlers.get("tools/call");
    handlers.set("tools/call", async (request, extra) => {
      const name = request?.params?.name;
      const args = request?.params?.arguments ?? {};
      if (LOCKOUT_TOOLS.includes(name) && typeof args._governorToken === "string" && process.env.RKS_VIA === "ide") {
        throw new McpError(ErrorCode.InternalError, LOCKOUT_MESSAGE);
      }
      return inner(request, extra);
    });
    return server;
  };
}

// AC 13 / AC 10: every in-process boot is observed. The wrapper runs inside withCaseEnv, so it sees the
// case env: the fixture root the server boots against and the token-gate bypass state.
// AC 15 (strict baseline): every boot also records the SCRUBBED_ENV and FIXTURE_ENV values the server sees.
const OBSERVED_ENV = Object.freeze([...new Set([...SCRUBBED_ENV, ...FIXTURE_ENV])]);
const envSeen = (env) => Object.fromEntries(OBSERVED_ENV.map((k) => [k, env[k] ?? null]));
const bootLog = [];
const createServer = () => {
  const root = process.env.ROUTEKIT_PROJECT_ROOT ?? null;
  bootLog.push({
    transport: "in-process",
    root,
    kgPresent: Boolean(root) && fs.existsSync(path.join(root, "routekit", "kg.yaml")),
    bypassActive: tokenGateBypass(process.env).active,
    env: envSeen(process.env),
  });
  return realCreateServer();
};
const lockoutCreateServer = withSimulatedLockout(createServer);
const onBoot = ({ root, transport, env }) => {
  if (transport === "stdio") {
    bootLog.push({ transport, root, kgPresent: fs.existsSync(path.join(root, "routekit", "kg.yaml")), bypassActive: tokenGateBypass(env ?? {}).active, env: envSeen(env ?? {}) });
  }
};

// AC 10: network is forbidden. The stub rejects, and the suite asserts it was never called. The count is
// kept outside the mock, because the base config's clearMocks would reset mock.calls between tests.
let fetchCalls = 0;
const fetchStub = vi.fn(async () => { fetchCalls += 1; throw new Error("admission-conformance: network is forbidden"); });
beforeAll(() => { vi.stubGlobal("fetch", fetchStub); });
afterAll(() => { vi.unstubAllGlobals(); });

// ── Case inputs ─────────────────────────────────────────────────────────────────────────────────

const P = FIXTURE_PROJECT_ID;
const S = FIXTURE_STORY_ID;
const TOK = "$TOKEN";
const INVALID_TOKEN = "admission-conformance-not-a-live-token";

const PREFLIGHT_TOOLS = Object.freeze(["rks_plan", "rks_exec", "rks_apply", "rks_staging_merge", "rks_staging_pr", "rks_story_ship", "rks_release"]);

// AC 14: tools whose handler, if it ran, writes outside the session, touches git or a remote, toggles
// guardrails, ships, releases, runs an agent's code or reaches an LLM or the network. Every allow case
// naming one of them must carry a handler refusal.
// Strict baseline AC 13: SIDE_EFFECT_TOOLS and READ_ONLY_TOOLS are both hand-written and must partition
// tools/list exactly (a listed tool in neither or both fails). The dendron write tools are side-effecting.
const SIDE_EFFECT_TOOLS = new Set([
  "dendron_create_note", "dendron_edit_note", "dendron_update_field", "dendron_update_fields",
  "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_rename_note",
  "rks_guardrails_off", "rks_guardrails_on", "rks_guardrails_abort",
  "rks_release", "rks_promote", "rks_sync_staging", "rks_tag",
  "rks_ship", "rks_story_ship", "rks_staging_pr", "rks_staging_merge", "rks_cycle_complete", "rks_publish",
  "rks_git_commit", "rks_git_push", "rks_git_merge", "rks_git_branch", "rks_checkout", "rks_branch_repair",
  "rks_stash", "rks_restore", "rks_reset", "rks_revert", "rks_cherry_pick", "rks_resolve_conflict",
  "rks_exec", "rks_plan", "rks_refine", "rks_refine_apply", "rks_apply", "rks_approve",
  "rks_init", "rks_project_init", "rks_memory_save", "rks_onboarder", "rks_interview", "rks_story_create",
  "rks_rag_init", "rks_rag_embed", "rks_rag_compact", "rks_telemetry_export", "rks_fetch_raw",
  "rks_exec_abort", "rks_phase_repair", "rks_agent_run",
  // Strict baseline AC 13: writes a note's ARCH fields (arch_verdict), accepts an inbox note (write and
  // commit), commits a reviewed plan's phase, runs the reviewer, or stashes / cleans worktrees.
  "rks_arch_verdict", "rks_inbox_review", "rks_plan_review", "rks_review", "rks_git_preflight",
]);
// Tools with no side effect under this suite: the handler only reads the fixture or session, or reaches
// only the stubbed runAgent / @routekit/rag (the rks_agent_* wrappers other than rks_agent_run).
const READ_ONLY_TOOLS = new Set([
  "dendron_read_note", "dendron_validate_schema",
  "rks_agent_cycle_complete", "rks_agent_delivery", "rks_agent_dendron", "rks_agent_external_research",
  "rks_agent_git", "rks_agent_plan", "rks_agent_recovery", "rks_agent_research", "rks_agent_ship",
  "rks_agent_story", "rks_agent_telemetry", "rks_agent_validate_story",
  "rks_analyze", "rks_channel_preview", "rks_exhaustive_search",
  "rks_git_state", "rks_governor_end", "rks_governor_init", "rks_guardrails_simulate", "rks_guardrails_status",
  "rks_kg_query", "rks_plan_ready", "rks_preflight", "rks_project_get",
  "rks_publish_profiles", "rks_rag_query", "rks_telemetry_query", "rks_telemetry_report",
  "rks_templates_list", "rks_token_cost_report", "rks_validate_story",
]);
// A tool in neither set is treated as side-effecting (fail safe); the AC14 partition test fails on it.
const sideEffectOf = (tool) => !READ_ONLY_TOOLS.has(tool);

const INIT_ARGS = Object.freeze({
  story: { flowType: "story", problemId: S },
  open: { flowType: "open" },
  qa: { flowType: "qa", problemId: S },
  ship: { flowType: "ship" },
  ops: { flowType: "ops" },
});
const initStep = (extra = {}) => ({ tool: "rks_governor_init", args: { projectId: P, ...extra } });
const flowInit = (flow) => initStep(INIT_ARGS[flow]);
const researchStep = () => ({ tool: "rks_agent_research", args: { projectId: P, query: "admission conformance", _governorToken: TOK } });
// Strict baseline AC 5: a real rks_git_commit of the fixture's uncommitted worktree change (fixture git
// state, makeFixtureRoot({ worktreeChange })) moves a ship session init -> committed on git_commit.ok.
const commitStep = () => ({ tool: "rks_git_commit", args: { projectId: P, message: "admission conformance setup", type: "chore", files: [FIXTURE_WORKTREE_CHANGE], _governorToken: TOK } });
const COMMITTED = Object.freeze({ chainState: "committed", steps: [commitStep()], fixture: { worktreeChange: true } });

// Arguments for the tokenless sweeps. Admitted read-only tools run their handler against the fixture,
// so their arguments are real; every other tool is refused before its handler in the mcp and remote
// sweeps, or auto-routed to the stubbed runAgent / the verbatim create helper in the ide sweep.
const SWEEP_ARGS = Object.freeze({
  rks_project_get: { id: P },
  rks_kg_query: { projectId: P, key: "project" },
  rks_rag_query: { projectId: P, q: "fixture" },
  rks_exhaustive_search: { projectId: P, pattern: "Fixture", path: "notes" },
  dendron_read_note: { projectId: P, filename: S },
  rks_telemetry_query: { projectId: P, limit: 1 },
  rks_templates_list: {},
  dendron_create_note: { projectId: P, filename: "backlog.conformance.route-note", title: "Route note", content: "admission conformance route sample\n" },
  dendron_edit_note: { projectId: P, filename: S, patches: [] },
  dendron_update_field: { projectId: P, filename: S, field: "title", value: "x" },
  dendron_update_fields: { projectId: P, filename: S, fields: { title: "x" } },
  dendron_fix_frontmatter: { projectId: P, filename: S },
  dendron_mark_implemented: { projectId: P, filename: S },
  dendron_rename_note: { projectId: P, from: S, to: "backlog.conformance.renamed" },
  rks_plan: { projectId: P, problemId: S },
  rks_exec: { projectId: P, problemId: S },
  rks_apply: { projectId: P, problemId: S },
  rks_story_ship: { projectId: P, problemId: S },
  rks_agent_research: { projectId: P, query: "admission conformance" },
  rks_agent_run: { agent: "conformance-no-such-agent", input: {} },
  rks_inbox_review: { projectId: P, action: "list", branch: "staging" },
});
const sweepArgs = (tool) => SWEEP_ARGS[tool] ?? { projectId: P };

// Unprotected tools reached tokenless on the ide lane: their handler runs. A side-effecting one gets a
// wrong-typed projectId (or a missing required argument), which its zod parse refuses before any effect.
const IDE_UNPROTECTED_ARGS = Object.freeze({
  rks_governor_init: { projectId: P },
  rks_governor_end: { projectId: P },
  rks_project_get: { id: P },
  rks_guardrails_status: { projectId: P },
  rks_templates_list: {},
  rks_channel_preview: { projectId: P },
  rks_rag_query: { projectId: P, q: "fixture" },
  rks_telemetry_query: { projectId: P, limit: 1 },
  rks_guardrails_on: { projectId: 12345 },
  rks_guardrails_abort: { projectId: 12345 },
  rks_phase_repair: { projectId: P },
  rks_memory_save: { projectId: P },
  rks_init: {},
  rks_interview: { projectId: 12345 },
  rks_onboarder: { projectId: 12345 },
  rks_story_create: { projectId: P },
  rks_rag_init: { projectId: 12345 },
  rks_rag_embed: { projectId: 12345 },
  rks_rag_compact: { projectId: 12345 },
  rks_exec_abort: { projectId: 12345 },
  rks_telemetry_export: { projectId: 12345 },
});

function spec(id, tool, fields = {}) {
  const lane = fields.lane ?? "ide";
  return {
    id,
    tool,
    lane,
    lanesBlock: fields.lanesBlock ?? "ok",
    token: fields.token ?? "absent",
    flowType: fields.flowType ?? null,
    chainState: fields.chainState ?? null,
    lease: fields.lease ?? null,
    argCase: fields.argCase ?? null,
    preflight: fields.preflight ?? null,
    sideEffect: sideEffectOf(tool),
    ...(fields.fixture ? { fixture: fields.fixture } : {}),
    ...(fields.env ? { env: fields.env } : {}),
    setup: fields.setup ?? [],
    args: fields.args ?? {},
    ...(fields.ideBaseline ? { ideBaseline: fields.ideBaseline } : {}),
    ...(fields.ac5 ? { ac5: fields.ac5 } : {}),
    ...(fields.expectArgRefusal ? { expectArgRefusal: true } : {}),
    ...(fields.stdio ? { stdio: true } : {}),
  };
}

// A tokened case: setup is the flow's init (plus any further chain steps), args carry $TOKEN.
function tokened(id, flow, tool, args, fields = {}) {
  return spec(id, tool, {
    token: "valid",
    flowType: flow,
    chainState: fields.chainState ?? "init",
    setup: [flowInit(flow), ...(fields.steps ?? [])],
    args: { ...args, _governorToken: TOK },
    ...fields,
  });
}

function buildCaseSpecs(toolNames) {
  const cases = [];
  const add = (c) => cases.push(c);

  // AC 1: one tokenless case per listed tool on each of the mcp (repo lanes: read-only) and remote lanes,
  // and one per protected tool on the ide lane (token gate: auto-route or refusal).
  for (const tool of toolNames) add(spec(`mcp-sweep:${tool}`, tool, { lane: "mcp", args: sweepArgs(tool), stdio: tool === "rks_git_commit" }));
  for (const tool of toolNames) add(spec(`remote-sweep:${tool}`, tool, { lane: "remote", args: sweepArgs(tool), stdio: tool === "rks_git_commit" }));
  for (const tool of toolNames.filter((t) => isProtectedTool(t))) {
    add(spec(`ide-tokenless:${tool}`, tool, {
      args: sweepArgs(tool),
      preflight: PREFLIGHT_TOOLS.includes(tool) ? "passed" : null,
      stdio: tool === "dendron_create_note",
    }));
  }
  for (const [tool, args] of Object.entries(IDE_UNPROTECTED_ARGS)) {
    if (toolNames.includes(tool)) add(spec(`ide-unprotected:${tool}`, tool, { args, stdio: tool === "rks_project_get" }));
  }

  // Flow inits as the case call (each flow's Governor chain entry, AC 7).
  for (const flow of FLOW_TYPES) {
    add(spec(`init:${flow}`, "rks_governor_init", { flowType: flow, args: { projectId: P, ...INIT_ARGS[flow] }, ideBaseline: `chain:${flow}` }));
  }

  // Story flow.
  add(tokened("story:init:rks_refine", "story", "rks_refine", { projectId: P }, { ideBaseline: "chain:story" }));
  add(tokened("story:init:rks_agent_research", "story", "rks_agent_research", { projectId: P, query: "admission conformance" }));
  add(tokened("story:init:rks_plan", "story", "rks_plan", { projectId: P, problemId: S }, { preflight: "passed" }));
  add(tokened("story:init:rks_exec", "story", "rks_exec", { projectId: P }, { preflight: "passed" }));
  add(tokened("story:init:rks_apply", "story", "rks_apply", { projectId: P }, { preflight: "passed" }));
  add(tokened("story:init:rks_story_ship", "story", "rks_story_ship", { projectId: P, problemId: S }, { preflight: "passed" }));
  add(tokened("story:init:rks_ship", "story", "rks_ship", { projectId: P, message: "admission conformance" }));
  add(tokened("story:init:dendron_create_note:namespace", "story", "dendron_create_note", { projectId: P, filename: "research.conformance.story-ns", title: "x" }, { argCase: "namespace-per-flow", expectArgRefusal: true }));
  add(tokened("story:init:dendron_update_field:phase-ready", "story", "dendron_update_field", { projectId: P, filename: S, field: "phase", value: "ready" }, { argCase: "phase-ready-non-open-qa", expectArgRefusal: true }));
  add(tokened("story:refining:rks_exec", "story", "rks_exec", { projectId: P }, { chainState: "refining", steps: [researchStep()], preflight: "passed" }));
  add(tokened("story:refining:rks_refine_apply", "story", "rks_refine_apply", { projectId: P }, { chainState: "refining", steps: [researchStep()] }));

  // Open flow.
  add(tokened("open:init:rks_agent_research", "open", "rks_agent_research", { projectId: P, query: "admission conformance" }, { ideBaseline: "chain:open" }));
  // Strict baseline AC 13: dendron_create_note is side-effecting, so an admitted create carries a wrong-typed
  // title that the handler's zod parse refuses before any write (AC 14); admission is decided on filename.
  add(tokened("open:init:dendron_create_note:namespace", "open", "dendron_create_note", { projectId: P, filename: "research.conformance.open-ns", title: 12345 }, { argCase: "namespace-per-flow" }));
  add(tokened("open:init:dendron_create_note:backlog-before-chain", "open", "dendron_create_note", { projectId: P, filename: "backlog.conformance.before-chain", title: "x" }, { argCase: "open-backlog-create-before-po-chain", expectArgRefusal: true }));
  add(tokened("open:test-file-scanning:dendron_create_note:backlog-after-chain", "open", "dendron_create_note", { projectId: P, filename: "backlog.conformance.after-chain", title: 12345 }, { chainState: "test-file-scanning", steps: [researchStep(), researchStep(), researchStep()], argCase: "open-backlog-create-after-po-chain" }));
  add(tokened("open:researching:rks_plan_ready", "open", "rks_plan_ready", { projectId: P, problemId: S }, { chainState: "researching", steps: [researchStep()] }));
  add(tokened("open:concern-separating:rks_plan_ready", "open", "rks_plan_ready", { projectId: P, problemId: S }, { chainState: "concern-separating", steps: [researchStep(), researchStep()] }));
  add(tokened("open:writing:rks_exec", "open", "rks_exec", { projectId: P }, { chainState: "writing", steps: [{ tool: "dendron_create_note", args: { projectId: P, filename: "research.conformance.writing", title: "x", _governorToken: TOK } }], preflight: "passed" }));
  add(tokened("open:init:rks_exec", "open", "rks_exec", { projectId: P }, { preflight: "passed" }));
  add(tokened("open:init:rks_fetch_raw", "open", "rks_fetch_raw", { projectId: P, url: "http://conformance.invalid/" }));
  add(tokened("open:init:rks_exhaustive_search", "open", "rks_exhaustive_search", { projectId: P, pattern: "Fixture", path: "notes" }));

  // QA flow.
  add(tokened("qa:init:rks_agent_research", "qa", "rks_agent_research", { projectId: P, query: "admission conformance" }, { ideBaseline: "chain:qa" }));
  add(tokened("qa:init:dendron_update_field:namespace", "qa", "dendron_update_field", { projectId: P, filename: "research.conformance.qa-ns", field: "title", value: "x" }, { argCase: "namespace-per-flow", expectArgRefusal: true }));
  add(tokened("qa:researching:dendron_create_note:namespace", "qa", "dendron_create_note", { projectId: P, filename: "research.conformance.qa-ns", title: "x" }, { chainState: "researching", steps: [researchStep()], argCase: "namespace-per-flow", expectArgRefusal: true }));
  add(tokened("qa:init:rks_exec", "qa", "rks_exec", { projectId: P }, { preflight: "passed" }));

  // Ship flow.
  add(tokened("ship:init:rks_git_state", "ship", "rks_git_state", { projectId: P }, { ideBaseline: "chain:ship" }));
  // A wrong-typed commit type is refused by the handler's zod parse before any git call (AC 14).
  add(tokened("ship:init:rks_git_commit", "ship", "rks_git_commit", { projectId: P, message: "admission conformance", type: "conformance-invalid" }, { ideBaseline: "ship" }));
  add(tokened("ship:init:rks_git_push", "ship", "rks_git_push", { projectId: P }));
  add(tokened("ship:init:rks_staging_pr", "ship", "rks_staging_pr", { projectId: P }, { preflight: "passed" }));
  add(tokened("ship:init:rks_staging_merge", "ship", "rks_staging_merge", { projectId: P }, { preflight: "passed" }));
  add(tokened("ship:init:dendron_create_note:namespace", "ship", "dendron_create_note", { projectId: P, filename: "backlog.conformance.ship-ns", title: "x" }, { argCase: "namespace-per-flow" }));

  // Ops flow (release family).
  // Strict baseline AC 2: a registered agent with an unknown input key is refused by parseAgentInput with
  // the stable code invalid_agent_input before the agent runs (an unknown agent name was prose).
  add(tokened("ops:init:rks_agent_run", "ops", "rks_agent_run", { agent: "research", input: { conformanceUnknownKey: true } }, { ideBaseline: "chain:ops" }));
  add(tokened("ops:init:rks_release", "ops", "rks_release", { projectId: P, version: "conformance-invalid" }, { ideBaseline: "release", preflight: "passed" }));
  add(tokened("ops:init:rks_promote", "ops", "rks_promote", { projectId: P, push: "not-a-boolean" }, { ideBaseline: "release" }));
  add(tokened("ops:init:rks_tag", "ops", "rks_tag", { projectId: P, action: "conformance-invalid" }, { ideBaseline: "release" }));
  add(tokened("ops:init:rks_sync_staging", "ops", "rks_sync_staging", { projectId: 12345 }, { ideBaseline: "release" }));
  add(tokened("ops:init:dendron_create_note:namespace", "ops", "dendron_create_note", { projectId: P, filename: "backlog.conformance.ops-ns", title: "x" }, { argCase: "namespace-per-flow" }));

  // Strict baseline AC 5: allow cases deeper in the build and ship chain, reached only by tools/call setup
  // steps plus fixture git state. Each side-effecting call carries a wrong-typed argument that the
  // handler's zod parse refuses before any effect (AC 14), so the decision records admission and a named
  // handler class. Pairs no setup can reach are listed in CHAIN_UNREACHABLE.
  add(tokened("build-chain:refining:rks_plan", "story", "rks_plan", { projectId: P, problemId: S, autoEmbed: "not-a-boolean" }, { chainState: "refining", steps: [researchStep()], preflight: "passed", ideBaseline: "build-chain" }));
  add(tokened("ship-chain:committed:rks_git_push", "ship", "rks_git_push", { projectId: P, branch: 12345 }, { ...COMMITTED, ideBaseline: "ship-chain" }));
  add(tokened("ship-chain:committed:rks_staging_pr", "ship", "rks_staging_pr", { projectId: P, autoMerge: "not-a-boolean" }, { ...COMMITTED, preflight: "passed", ideBaseline: "ship-chain" }));
  add(tokened("ship-chain:committed:rks_git_merge", "ship", "rks_git_merge", { projectId: P, deleteBranch: "not-a-boolean" }, { ...COMMITTED, ideBaseline: "ship-chain" }));
  add(tokened("ship-chain:committed:rks_cycle_complete", "ship", "rks_cycle_complete", { projectId: P, discardLocalCommits: "not-a-boolean" }, { ...COMMITTED, ideBaseline: "ship-chain" }));

  // AC 6: rks_guardrails_off with a valid token from every flow, past the chain gate to the handler's gate.
  for (const flow of FLOW_TYPES) {
    add(tokened(`${flow}:init:rks_guardrails_off`, flow, "rks_guardrails_off", { projectId: P, reason: "admission conformance", problemId: S }, { ideBaseline: "guardrails_off" }));
  }

  // Token supplied but not a live session.
  add(spec("ide:invalid-token:dendron_create_note", "dendron_create_note", { token: "invalid", args: { ...SWEEP_ARGS.dendron_create_note, _governorToken: INVALID_TOKEN } }));
  add(spec("ide:invalid-token:rks_guardrails_off", "rks_guardrails_off", { token: "invalid", args: { projectId: P, reason: "admission conformance", problemId: S, _governorToken: INVALID_TOKEN } }));
  add(spec("ide:invalid-token:rks_project_get", "rks_project_get", { token: "invalid", args: { id: P, _governorToken: INVALID_TOKEN } }));
  add(spec("remote:invalid-token:rks_governor_init", "rks_governor_init", { lane: "remote", token: "invalid", args: { projectId: P, _governorToken: INVALID_TOKEN } }));

  // Lanes dispatch and call (repo lanes: dispatch full, call read-only).
  add(spec("dispatch:tokenless:rks_git_commit", "rks_git_commit", { lane: "dispatch", args: { projectId: P, message: "admission conformance" }, stdio: true }));
  add(spec("dispatch:tokenless:dendron_create_note", "dendron_create_note", { lane: "dispatch", args: SWEEP_ARGS.dendron_create_note }));
  add(tokened("dispatch:open:rks_agent_research", "open", "rks_agent_research", { projectId: P, query: "admission conformance" }, { lane: "dispatch" }));
  add(spec("call:tokenless:dendron_create_note", "dendron_create_note", { lane: "call", args: SWEEP_ARGS.dendron_create_note }));
  add(spec("call:tokenless:rks_project_get", "rks_project_get", { lane: "call", args: { id: P }, stdio: true }));
  add(tokened("call:open:dendron_create_note", "open", "dendron_create_note", { projectId: P, filename: "research.conformance.call", title: "x" }, { lane: "call" }));

  // Remote lane with a token and an actor.
  const remoteActor = { RKS_ACTOR: "conformance" };
  add(tokened("remote:open:dendron_create_note:inbox", "open", "dendron_create_note", { projectId: P, filename: "inbox.conformance.remote-note", title: 12345 }, { lane: "remote", env: remoteActor }));
  add(tokened("remote:open:dendron_create_note:outside-prefix", "open", "dendron_create_note", { projectId: P, filename: "research.conformance.remote", title: "x" }, { lane: "remote", env: remoteActor }));
  add(tokened("remote:open:dendron_create_note:actor-unset", "open", "dendron_create_note", { projectId: P, filename: "inbox.conformance.remote-note", title: "x" }, { lane: "remote" }));
  add(tokened("remote:open:dendron_read_note", "open", "dendron_read_note", { projectId: P, filename: S }, { lane: "remote" }));
  add(tokened("remote:open:rks_agent_research", "open", "rks_agent_research", { projectId: P, query: "admission conformance" }, { lane: "remote" }));
  add(spec("remote:init:story", "rks_governor_init", { lane: "remote", flowType: "story", args: { projectId: P, ...INIT_ARGS.story } }));

  // Lanes block absent (every lane full) and invalid (every lane read-only, invalid_lane_policy).
  add(spec("absent:mcp:dendron_create_note", "dendron_create_note", { lane: "mcp", lanesBlock: "absent", args: SWEEP_ARGS.dendron_create_note }));
  add(spec("absent:call:rks_git_commit", "rks_git_commit", { lane: "call", lanesBlock: "absent", args: { projectId: P, message: "admission conformance" } }));
  const invalidLanes = { fixture: { lanes: { ide: "conformance-bogus-mode" } }, lanesBlock: "invalid" };
  add(spec("invalid:ide:dendron_create_note", "dendron_create_note", { ...invalidLanes, args: SWEEP_ARGS.dendron_create_note }));
  add(spec("invalid:ide:rks_project_get", "rks_project_get", { ...invalidLanes, args: { id: P } }));
  add(spec("invalid:ide:init-story", "rks_governor_init", { ...invalidLanes, flowType: "story", args: { projectId: P, ...INIT_ARGS.story } }));
  add(spec("invalid:mcp:rks_git_commit", "rks_git_commit", { ...invalidLanes, lane: "mcp", args: { projectId: P, message: "admission conformance" } }));

  // Lease held: a live exclusive story session holds the project lease.
  add(spec("lease:story-held:init-qa", "rks_governor_init", { lease: "held", flowType: "qa", setup: [flowInit("story")], args: { projectId: P, ...INIT_ARGS.qa } }));
  add(spec("lease:story-held:init-open", "rks_governor_init", { lease: "held", flowType: "open", setup: [flowInit("story")], args: { projectId: P } }));
  add(spec("lease:story-held:rks_agent_research", "rks_agent_research", { lease: "held", setup: [flowInit("story")], args: { projectId: P, query: "admission conformance" } }));

  // Preflight refused, by argument or by the fixture branch override (AC 2).
  const offBranch = { branch: "feature/admission-conformance" };
  add(spec("preflight-refused:rks_plan:story_exists", "rks_plan", { preflight: "refused", args: { projectId: P, problemId: "backlog.conformance.missing-story" } }));
  add(spec("preflight-refused:rks_plan:branch", "rks_plan", { preflight: "refused", fixture: offBranch, args: { projectId: P, problemId: S } }));
  add(spec("preflight-refused:rks_exec:branch", "rks_exec", { preflight: "refused", fixture: offBranch, args: { projectId: P } }));
  add(spec("preflight-refused:rks_apply:branch", "rks_apply", { preflight: "refused", fixture: offBranch, args: { projectId: P } }));
  add(spec("preflight-refused:rks_staging_pr:base_branch", "rks_staging_pr", { preflight: "refused", args: { projectId: P, targetBranch: "main" } }));
  add(spec("preflight-refused:rks_staging_merge:branch", "rks_staging_merge", { preflight: "refused", fixture: offBranch, args: { projectId: P } }));
  add(spec("preflight-refused:rks_story_ship:branch", "rks_story_ship", { preflight: "refused", fixture: offBranch, args: { projectId: P, problemId: S } }));
  add(spec("preflight-refused:rks_release:release_ready", "rks_release", { preflight: "refused", fixture: offBranch, args: { projectId: P } }));

  // AC 5: the same probe from a session initialised with an owner-sounding actor and via: "ide", and from a
  // plain session, on the mcp lane (repo lanes: mcp read-only).
  const AC5_PROBES = [
    ["dendron_create_note", { projectId: P, filename: "research.conformance.ac5", title: "x" }],
    ["rks_git_commit", { projectId: P, message: "admission conformance" }],
    ["rks_guardrails_off", { projectId: P, reason: "admission conformance", problemId: S }],
    ["rks_agent_research", { projectId: P, query: "admission conformance" }],
    ["rks_exec", { projectId: P }],
    ["rks_exhaustive_search", { projectId: P, pattern: "Fixture", path: "notes" }],
    ["dendron_read_note", { projectId: P, filename: S }],
    // Strict baseline AC 11: a protected tool the read-only lane admits (lane-policy READ_ONLY_TOOLS) but
    // the open-flow init state does not, so the chain gate, not the lane gate, decides the pair.
    ["rks_kg_query", { projectId: P, key: "project" }],
  ];
  const SELF_REPORTED = { via: "ide", actor: "owner" };
  for (const [tool, args] of AC5_PROBES) {
    for (const variant of ["self-reported", "plain"]) {
      add(spec(`ac5:${variant}:${tool}`, tool, {
        lane: "mcp", token: "valid", flowType: "open", chainState: "init",
        setup: [initStep(variant === "self-reported" ? SELF_REPORTED : {})],
        args: { ...args, _governorToken: TOK },
        ac5: { probe: tool, variant },
      }));
    }
  }
  for (const variant of ["self-reported", "plain"]) {
    add(spec(`ac5:${variant}:rks_governor_init:story`, "rks_governor_init", {
      lane: "mcp", flowType: "story",
      args: { projectId: P, ...INIT_ARGS.story, ...(variant === "self-reported" ? SELF_REPORTED : {}) },
      ac5: { probe: "rks_governor_init:story", variant },
    }));
  }
  return cases;
}

// Anomalies: observed decisions that look like defects. Pinned as observed, not fixed here (AC 11).
const GUARDRAILS_OFF_ANOMALY_CASE = "ship:init:rks_guardrails_off";
const GUARDRAILS_OFF_ANOMALY_NOTE =
  "rks_guardrails_off passes the chain gate from every flow and chain state (this ship-flow case included, though no SHIP_STATES state lists it): it is in COMMON_TOOLS (packages/mcp-rks/src/shared/governor-token.mjs), so checkAllowedTool returns before the session and state-machine lookup. The comment beside UNPROTECTED_TOOLS, 'rks_guardrails_off is now PROTECTED — blocked by state machine (not in any flow)', is stale: the state machine never sees the call, and only the handler's own gates (problemId_required, story_not_ready and the rest) refuse it. Pinned as observed; changing it belongs to the later off-switch story.";

// AC 10 predicted that every agentCalls >= 1 case is a tokened rks_agent_* allow case or a non-create
// auto-route. A tokenless rks_agent_research is neither: server.mjs self-bootstraps an open-flow session
// for it (the research self-bootstrap ahead of the chain gate) and dispatches the agent under that token.
const SELF_BOOTSTRAP_ANOMALY_CASE = "ide-tokenless:rks_agent_research";
const SELF_BOOTSTRAP_ANOMALY_NOTE =
  "A tokenless rks_agent_research is admitted (allow) and reaches runAgent (agentCalls 1) although the call carries no token and is not auto-routed: server.mjs self-bootstraps an open-flow Governor session (createSession with a shared lease) for rks_agent_research when no token is supplied and the token gate is armed, then dispatches the agent under that server-minted token. This is a third agent-reaching class that AC 10's rule (tokened rks_agent_* allow, or a non-dendron_create_note auto-route) does not name. The harness finds that server-minted session in .rks/session/governor (a snapshot and diff of the record basenames around the case call) and ends it with rks_governor_end. Pinned as observed.";

// Strict baseline AC 12: tokenless dendron_read_note and rks_git_state on the mcp lane are auto-routed into
// runAgent. An ide-lane tokenless auto-route is the token gate's designed redirect; on another lane it is
// admitted by AC 10's agent-reaching rule only while listed here.
const AUTO_ROUTE_ANOMALY_CASES = Object.freeze(["mcp-sweep:dendron_read_note", "mcp-sweep:rks_git_state"]);
// backlog.feat.admission-conformance-hardening AC 1: the ids the auto-route rule may admit off the ide lane:
// the AUTO_ROUTE_ANOMALY_CASES members present in the corpus anomalies, never every anomaly caseId.
const autoRouteListedIds = (anomalies) => {
  const present = new Set((anomalies ?? []).map((a) => a.caseId));
  return new Set(AUTO_ROUTE_ANOMALY_CASES.filter((id) => present.has(id)));
};
// backlog.feat.admission-conformance-hardening AC 1: the one copy of the non-create auto-route rule (strict
// baseline AC 12). An auto-route into runAgent is admitted on the ide lane, and off the ide lane only while
// its id is in listedIds.
function agentReachingAdmitted(c, listedIds) {
  return c.expected.effect === "route" && c.tool !== "dendron_create_note" && (c.lane === "ide" || listedIds.has(c.id));
}
const autoRouteAnomalyNote = (c) =>
  `A tokenless ${c.tool} on the ${c.lane} lane (repo lanes: ${c.lane} read-only) is auto-routed (route auto_routed) into runAgent (agentCalls ${c.expected.agentCalls}): the token gate's auto-route redirect reaches an agent from a lane other than ide. AC 10's agent-reaching rule admits this case only while it is listed here. Pinned as observed.`;

// Strict baseline AC 7: the refused-preflight tools whose preflight layer cannot refuse by argument or
// fixture branch. Hand-written: for every other PREFLIGHT_TOOLS member the refused case must be observed
// as preflight:<check>, and buildAnomalies throws on any observation that contradicts this set.
const PREFLIGHT_UNREACHABLE = Object.freeze(new Set(["rks_staging_merge", "rks_story_ship"]));
const preflightAnomalyNote = (c) =>
  `The preflight layer does not refuse ${c.tool} on this input: its server/preflight.mjs TOOL_CHECKS entry yields no error for ${c.tool} here (the branch check only warns, or applies no rule, for this tool), so the call passes preflight and is decided by a later layer (observed ${c.expected.effect}${c.expected.reason ? ` ${c.expected.reason}` : ""}). The AC 2 refused-preflight value is unreachable for this tool by argument or fixture branch; ${c.tool} is listed in PREFLIGHT_UNREACHABLE. Pinned as observed.`;

// Strict baseline AC 6 (c): the anomaly caseIds, hand-written.
const EXPECTED_ANOMALY_IDS = Object.freeze([
  "ship:init:rks_guardrails_off",
  "ide-tokenless:rks_agent_research",
  "preflight-refused:rks_staging_merge:branch",
  "preflight-refused:rks_story_ship:branch",
  "mcp-sweep:dendron_read_note",
  "mcp-sweep:rks_git_state",
]);

function buildAnomalies(cases) {
  const anomalies = [{ caseId: GUARDRAILS_OFF_ANOMALY_CASE, note: GUARDRAILS_OFF_ANOMALY_NOTE }];
  const sb = cases.find((c) => c.id === SELF_BOOTSTRAP_ANOMALY_CASE);
  if (sb && sb.expected.agentCalls >= 1 && sb.expected.effect === "allow") anomalies.push({ caseId: SELF_BOOTSTRAP_ANOMALY_CASE, note: SELF_BOOTSTRAP_ANOMALY_NOTE });
  for (const c of cases) {
    if (c.preflight !== "refused") continue;
    const refused = String(c.expected.reason ?? "").startsWith("preflight:");
    if (PREFLIGHT_UNREACHABLE.has(c.tool)) {
      if (refused) throw new Error(`buildAnomalies: ${c.id} is refused by preflight (${c.expected.reason}) but ${c.tool} is listed in PREFLIGHT_UNREACHABLE`);
      anomalies.push({ caseId: c.id, note: preflightAnomalyNote(c) });
    } else if (!refused) {
      throw new Error(`buildAnomalies: ${c.id} is not refused by preflight (observed ${c.expected.effect} ${c.expected.reason ?? ""}) and ${c.tool} is not in PREFLIGHT_UNREACHABLE`);
    }
  }
  for (const id of AUTO_ROUTE_ANOMALY_CASES) {
    const c = cases.find((x) => x.id === id);
    if (c && c.expected.effect === "route" && c.expected.agentCalls >= 1) anomalies.push({ caseId: id, note: autoRouteAnomalyNote(c) });
  }
  return anomalies;
}

// Strict baseline AC 5: the build and ship chain (flow, state, tool) pairs that must carry an observed
// allow baseline case, or be listed in CHAIN_UNREACHABLE with a reason. "story:*:rks_apply" stands for
// every story state.
const REQUIRED_CHAIN_PAIRS = Object.freeze([
  "story:refining:rks_plan", "story:planned:rks_exec", "story:executing:rks_exec",
  "story:executed:rks_story_ship", "story:executed:rks_ship",
  "ship:committed:rks_git_push", "ship:committed:rks_staging_pr", "ship:committed:rks_git_merge", "ship:committed:rks_cycle_complete",
  "ship:pr_created:rks_staging_merge",
  "story:*:rks_apply",
]);
const PLAN_OK_UNREACHABLE = "planned is entered only on a plan.ok result. rks_plan produces it from its detached planner worker (an LLM run), or synchronously only under RKS_SKIP_LLM / RKS_SKIP_PREFLIGHT, env overrides this suite scrubs; tools/call setup plus fixture git state cannot produce it";
// backlog.feat.admission-conformance-hardening AC 7: observed support for a CHAIN_UNREACHABLE entry. Each
// observation returns the corpus cases it inspected (hits) and the ones that contradict it (failures).
// chainDenied: every tokened ide-lane case of the tool in the flow ("*" for any flow) is denied chain_violation.
const chainDenied = (flow, tool) => Object.freeze({
  label: `every tokened ide-lane ${flow === "*" ? "" : `${flow}-flow `}${tool} case is denied chain_violation`,
  check: (cases) => {
    const hits = cases.filter((c) => c.tool === tool && c.token === "valid" && c.lane === "ide" && (flow === "*" || c.flowType === flow));
    return { hits, failures: hits.filter((c) => c.expected.effect !== "deny" || c.expected.reason !== "chain_violation").map((c) => `${c.id}: ${c.expected.effect} ${c.expected.reason}`) };
  },
});
// stateNeverReached: no labelled case of the flow is observed in the state.
const stateNeverReached = (flow, state) => Object.freeze({
  label: `no ${flow}-flow case is observed in ${state}`,
  check: (cases) => {
    const hits = cases.filter((c) => c.flowType === flow && c.chainState !== null);
    return { hits, failures: hits.filter((c) => c.chainState === state).map((c) => `${c.id}: chainState ${state}`) };
  },
});
// handlerRefused: the case that would enter the next state records a handler refusal, not an ok result.
const handlerRefused = (id) => Object.freeze({
  label: `${id} records a handler refusal, not an ok result`,
  check: (cases) => {
    const hits = cases.filter((c) => c.id === id);
    return { hits, failures: hits.filter((c) => c.expected.effect !== "allow" || !recognisedHandlerClass(c.expected.handlerReason)).map((c) => `${c.id}: ${c.expected.effect} ${c.expected.handlerReason}`) };
  },
});
const CHAIN_UNREACHABLE = Object.freeze([
  Object.freeze({ pair: "story:planned:rks_exec", reason: PLAN_OK_UNREACHABLE, support: Object.freeze([chainDenied("story", "rks_exec"), stateNeverReached("story", "planned"), handlerRefused("build-chain:refining:rks_plan")]) }),
  Object.freeze({ pair: "story:executing:rks_exec", reason: `executing is entered only by rks_exec from planned, which is unreachable: ${PLAN_OK_UNREACHABLE}`, support: Object.freeze([chainDenied("story", "rks_exec"), stateNeverReached("story", "executing")]) }),
  Object.freeze({ pair: "story:executed:rks_story_ship", reason: "executed is entered only on an exec.ok result from executing, which is unreachable (it follows planned, which needs a plan.ok result from the planner worker)", support: Object.freeze([chainDenied("story", "rks_story_ship"), stateNeverReached("story", "executed")]) }),
  Object.freeze({ pair: "story:executed:rks_ship", reason: "executed is entered only on an exec.ok result from executing, which is unreachable (it follows planned, which needs a plan.ok result from the planner worker)", support: Object.freeze([chainDenied("story", "rks_ship"), stateNeverReached("story", "executed")]) }),
  Object.freeze({ pair: "ship:pr_created:rks_staging_merge", reason: "pr_created is entered only on a staging_pr.ok result, which needs a git remote and a created pull request; the hermetic fixture has no remote", support: Object.freeze([chainDenied("ship", "rks_staging_merge"), stateNeverReached("ship", "pr_created"), handlerRefused("ship-chain:committed:rks_staging_pr")]) }),
  Object.freeze({ pair: "story:*:rks_apply", reason: "no flow state admits rks_apply: it is in no allowed set of any governor-state flow, so a tokened rks_apply allow case is unreachable by construction", support: Object.freeze([chainDenied("*", "rks_apply")]) }),
]);

/**
 * AC 7: one failure per CHAIN_UNREACHABLE entry that has neither observed support nor an explicit
 * no-support marker ({ noSupport: <reason> }), or whose support is contradicted or inspects no case.
 */
function chainUnreachableSupportFailures(entries, cases) {
  const failures = [];
  for (const u of entries) {
    const hasSupport = Array.isArray(u.support) && u.support.length > 0;
    const marker = typeof u.noSupport === "string" && u.noSupport.trim().length > 20;
    if (!hasSupport && !marker) { failures.push(`${u.pair}: neither observed support nor a no-support marker with a reason`); continue; }
    if (hasSupport && u.noSupport !== undefined) failures.push(`${u.pair}: carries both observed support and a no-support marker`);
    if (!hasSupport) continue;
    for (const s of u.support) {
      const { hits, failures: contra } = s.check(cases);
      if (hits.length === 0) failures.push(`${u.pair}: ${s.label}: inspects no corpus case`);
      for (const f of contra) failures.push(`${u.pair}: ${s.label}: contradicted by ${f}`);
    }
  }
  return failures;
}

// backlog.feat.admission-conformance-hardening AC 3: the expected handlerReason of every side-effecting AC7
// baseline member, hand-written (values taken from the committed corpus, not from a brief). A regeneration
// that records a different named refusal, or adds or drops a side-effecting member, fails the suite.
const AC7_EXPECTED_HANDLER_REASONS = Object.freeze({
  "story:init:rks_refine": "thrown:-32603:zod:problemId",
  "ship:init:rks_git_commit": "thrown:-32603:zod:type",
  "ops:init:rks_agent_run": "invalid_agent_input",
  "ops:init:rks_release": "thrown:-32603:zod:version",
  "ops:init:rks_promote": "thrown:-32603:zod:push",
  "ops:init:rks_tag": "thrown:-32603:zod:action",
  "ops:init:rks_sync_staging": "thrown:-32603:zod:projectId",
  "build-chain:refining:rks_plan": "thrown:-32603:zod:autoEmbed",
  "ship-chain:committed:rks_git_push": "thrown:-32603:zod:branch",
  "ship-chain:committed:rks_staging_pr": "thrown:-32603:zod:autoMerge",
  "ship-chain:committed:rks_git_merge": "thrown:-32603:zod:deleteBranch",
  "ship-chain:committed:rks_cycle_complete": "thrown:-32603:zod:discardLocalCommits",
  "story:init:rks_guardrails_off": "story_not_ready",
  "open:init:rks_guardrails_off": "story_not_ready",
  "qa:init:rks_guardrails_off": "story_not_ready",
  "ship:init:rks_guardrails_off": "story_not_ready",
  "ops:init:rks_guardrails_off": "story_not_ready",
});

/** AC 3: failures where the side-effecting ideBaseline cases differ from the hand-written expected list. */
function ac7HandlerReasonFailures(cases, expected = AC7_EXPECTED_HANDLER_REASONS) {
  const failures = [];
  const members = cases.filter((c) => c.ideBaseline && c.sideEffect);
  const ids = new Set(members.map((c) => c.id));
  for (const id of Object.keys(expected)) if (!ids.has(id)) failures.push(`${id}: hand-written member missing from the corpus side-effecting baseline`);
  for (const c of members) {
    if (!Object.hasOwn(expected, c.id)) { failures.push(`${c.id}: side-effecting baseline member has no hand-written expected handlerReason`); continue; }
    if (c.expected.handlerReason !== expected[c.id]) failures.push(`${c.id}: records ${c.expected.handlerReason}, hand-written ${expected[c.id]}`);
  }
  return failures;
}

/** A handler class the AC7 baseline accepts for a side-effecting member: a named refusal, never a generic one. */
function recognisedHandlerClass(h) {
  if (typeof h !== "string" || h === "") return false;
  if (["ok_false", "error_message", "is_error"].includes(h)) return false;
  if (/^thrown:[^:]+$/.test(h)) return false;
  if (h.startsWith("thrown:") && h.endsWith(`:${UNCLASSIFIED}`)) return false;
  return true;
}

/**
 * Strict baseline AC 3: the AC7 owner-baseline check, factored so it runs on a supplied set of decisions.
 * decisions maps caseId -> { effect, reason, handlerReason, agentCalls } (or { replayError }). Returns
 * one failure string per violation, each prefixed by the caseId.
 */
function ac7BaselineFailures(cases, decisions) {
  const failures = [];
  for (const c of cases.filter((x) => x.ideBaseline)) {
    const d = decisions.get(c.id);
    if (!d) { failures.push(`${c.id}: no decision`); continue; }
    if (d.replayError) { failures.push(`${c.id}: replay failed: ${d.replayError}`); continue; }
    if (c.lane !== "ide") failures.push(`${c.id}: lane ${c.lane}, not ide`);
    if (c.lanesBlock !== "ok") failures.push(`${c.id}: lanesBlock ${c.lanesBlock}, not ok`);
    if ((c.fixture?.branch ?? null) !== null) failures.push(`${c.id}: fixture branch override`);
    if (d.effect !== "allow") failures.push(`${c.id}: effect ${d.effect} ${d.reason ?? ""}, not allow`);
    if (c.sideEffect && !recognisedHandlerClass(d.handlerReason)) failures.push(`${c.id}: side-effecting member records ${d.handlerReason}, not a recognised handler class`);
    // Hardening AC 3: the observed handlerReason also equals the hand-written expected value.
    if (c.sideEffect && d.handlerReason !== (AC7_EXPECTED_HANDLER_REASONS[c.id] ?? null)) failures.push(`${c.id}: side-effecting member records ${d.handlerReason}, hand-written ${AC7_EXPECTED_HANDLER_REASONS[c.id] ?? "(none)"}`);
    if (JSON.stringify(decisionOf(d)) !== JSON.stringify(c.expected)) failures.push(`${c.id}: decision ${JSON.stringify(decisionOf(d))} differs from recorded ${JSON.stringify(c.expected)}`);
  }
  return failures;
}

// ── Shared replay helpers ───────────────────────────────────────────────────────────────────────

async function listToolNames() {
  const fixture = makeFixtureRoot({ label: "tools-list" });
  try {
    return await withCaseEnv({ ROUTEKIT_PROJECT_ROOT: fixture.root, RKS_VIA: "ide" }, async () => {
      const conn = await connectInProcess(createServer, { clientName: "claude-code" });
      try {
        return (await conn.client.listTools()).tools.map((t) => t.name).sort();
      } finally {
        await conn.close();
      }
    });
  } finally {
    fixture.cleanup();
  }
}

// backlog.feat.admission-conformance-hardening AC 5: every replay records, before its fixture is removed, the
// session files under the fixture that still mention a token it minted (helper auditFixtureSessions). This
// works for stdio-minted tokens too, which validateToken cannot judge once the fixture root is gone.
const sessionAudits = [];
const liveMintedSessions = (audits) => audits.filter((a) => a.liveFiles.length > 0).map((a) => `${a.id} (${a.transport}): ${a.liveFiles.join(", ")}`);
const replayIn = (c, clientName = "claude-code") => replayOnFreshFixture(c, { clientName, createServer, minted, agentCallCount, onBoot, sessionAudit: sessionAudits });
const decisionOf = (d) => ({ effect: d.effect, reason: d.reason, handlerReason: d.handlerReason, agentCalls: d.agentCalls });
// In-process claude-code results, reused by the AC4 and AC9 comparisons.
const inProcessResults = new Map();
async function inProcessResult(c) {
  if (!inProcessResults.has(c.id)) inProcessResults.set(c.id, decisionOf(await replayIn(c)));
  return inProcessResults.get(c.id);
}

beforeAll(async () => {
  if (!UPDATE_CORPUS) return;
  const toolNames = await listToolNames();
  const specs = buildCaseSpecs(toolNames);
  const cases = [];
  for (const s of specs) cases.push({ ...s, expected: decisionOf(await replayIn(s)) });
  writeCorpusSections({ anchor: repoAnchor(), cases, anomalies: buildAnomalies(cases) });
}, MATRIX_TIMEOUT_MS);

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

describe("AC1 corpus completeness", () => {
  it("every tool listed by tools/list has at least one corpus case", async () => {
    const listed = await listToolNames();
    expect(listed.length).toBeGreaterThan(0);
    const covered = new Set(loadCorpus().cases.map((c) => c.tool));
    const missing = listed.filter((t) => !covered.has(t));
    expect(missing, `tools with no corpus case: ${missing.join(", ")}`).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("buildCaseSpecs ids and committed corpus ids are unique", async () => {
    const dupes = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);
    const specIds = buildCaseSpecs(await listToolNames()).map((c) => c.id);
    expect(specIds.length).toBeGreaterThan(0);
    expect(dupes(specIds)).toEqual([]);
    const corpusIds = loadCorpus().cases.map((c) => c.id);
    expect(dupes(corpusIds)).toEqual([]);
    // Positive control: the check reports a duplicate when one exists.
    expect(dupes(["a", "b", "a"])).toEqual(["a"]);
  }, CASE_TIMEOUT_MS);
});

describe("AC2 dimensions", () => {
  it("corpus cases cover every value of every admission dimension", () => {
    const { cases, anomalies } = loadCorpus();
    const uncovered = [];
    const need = (label, pred) => { if (!cases.some(pred)) uncovered.push(label); };
    for (const lane of LANES) need(`lane ${lane}`, (c) => c.lane === lane);
    for (const lb of ["absent", "ok", "invalid"]) need(`lanesBlock ${lb}`, (c) => c.lanesBlock === lb);
    for (const tk of ["absent", "valid", "invalid"]) need(`token ${tk}`, (c) => c.token === tk);
    for (const flow of FLOW_TYPES) need(`flowType ${flow}`, (c) => c.flowType === flow);
    need("lease held", (c) => c.lease === "held");
    for (const flow of FLOW_TYPES) need(`argCase namespace-per-flow (${flow})`, (c) => c.argCase === "namespace-per-flow" && c.flowType === flow);
    need("argCase open-backlog-create-before-po-chain", (c) => c.argCase === "open-backlog-create-before-po-chain");
    need("argCase open-backlog-create-after-po-chain", (c) => c.argCase === "open-backlog-create-after-po-chain");
    need("argCase phase-ready-non-open-qa", (c) => c.argCase === "phase-ready-non-open-qa" && !["open", "qa"].includes(c.flowType));
    const anomalous = new Set(anomalies.map((a) => a.caseId));
    for (const tool of PREFLIGHT_TOOLS) {
      need(`preflight passed (${tool})`, (c) => c.tool === tool && c.preflight === "passed" && !String(c.expected.reason ?? "").startsWith("preflight:"));
      need(`preflight refused (${tool})`, (c) => c.tool === tool && c.preflight === "refused");
      // Strict baseline AC 7: a refused-preflight case is observed as preflight:<check>. Only a tool in the
      // hand-written PREFLIGHT_UNREACHABLE set may instead be listed as an anomaly naming why not.
      for (const c of cases.filter((x) => x.tool === tool && x.preflight === "refused")) {
        const observed = String(c.expected.reason ?? "").startsWith("preflight:");
        if (PREFLIGHT_UNREACHABLE.has(tool)) {
          if (observed || !anomalous.has(c.id)) uncovered.push(`preflight refused (${tool}) is in PREFLIGHT_UNREACHABLE but is observed or not an anomaly: ${c.id}`);
        } else if (!observed) uncovered.push(`preflight refused (${tool}) not observed as preflight:<check>: ${c.id}`);
      }
    }
    expect(uncovered, `uncovered dimension values: ${uncovered.join("; ")}`).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("every chain-state case is reached by a non-empty MCP setup sequence", async () => {
    const { cases } = loadCorpus();
    for (const c of cases) {
      const dependsOnChain = c.token === "valid" || (c.chainState && c.chainState !== "init") || c.lease === "held";
      if (dependsOnChain) {
        expect(c.setup.length, c.id).toBeGreaterThan(0);
        expect(c.setup[0].tool, c.id).toBe("rks_governor_init");
      }
      if (c.chainState && c.chainState !== "init") expect(c.setup.length, c.id).toBeGreaterThan(1);
      // Setup is tools/call steps only: a tool name and its arguments, nothing that writes session state.
      for (const step of c.setup) expect(Object.keys(step).sort(), c.id).toEqual(["args", "tool"]);
      if (c.preflight === "refused") expect(c.setup, c.id).toEqual([]);
    }
    // The harness exports no function that writes session state directly.
    const helper = await import("../helpers/admission-conformance.mjs");
    const forbidden = Object.keys(helper).filter((k) => /createSession|setSession|writeSession|advanceState|persistSession/i.test(k));
    expect(forbidden).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("every refused-preflight case outside PREFLIGHT_UNREACHABLE is observed as preflight:<check>", () => {
    const { cases } = loadCorpus();
    expect([...PREFLIGHT_UNREACHABLE].sort()).toEqual(["rks_staging_merge", "rks_story_ship"]);
    for (const tool of PREFLIGHT_UNREACHABLE) expect(PREFLIGHT_TOOLS, tool).toContain(tool);
    const outside = PREFLIGHT_TOOLS.filter((t) => !PREFLIGHT_UNREACHABLE.has(t));
    expect(outside.length).toBeGreaterThan(0);
    for (const tool of outside) {
      const refused = cases.filter((c) => c.tool === tool && c.preflight === "refused");
      expect(refused.length, tool).toBeGreaterThan(0);
      for (const c of refused) {
        expect(c.expected.effect, c.id).toBe("deny");
        expect(c.expected.reason, c.id).toMatch(/^preflight:[A-Za-z0-9_.-]+$/);
      }
    }
  }, CASE_TIMEOUT_MS);

  it("buildAnomalies throws when a preflight observation contradicts PREFLIGHT_UNREACHABLE", () => {
    const { cases } = loadCorpus();
    expect(() => buildAnomalies(cases)).not.toThrow();
    const exp = (effect, reason) => ({ effect, reason, handlerReason: null, agentCalls: 0 });
    const outsideNotRefused = { id: "synthetic:rks_plan", tool: "rks_plan", preflight: "refused", expected: exp("deny", "unauthorized") };
    expect(() => buildAnomalies([outsideNotRefused])).toThrow(/not in PREFLIGHT_UNREACHABLE/);
    const unreachableRefused = { id: "synthetic:rks_story_ship", tool: "rks_story_ship", preflight: "refused", expected: exp("deny", "preflight:branch") };
    expect(() => buildAnomalies([unreachableRefused])).toThrow(/listed in PREFLIGHT_UNREACHABLE/);
    // Negative controls: consistent observations do not throw.
    expect(() => buildAnomalies([{ ...outsideNotRefused, expected: exp("deny", "preflight:branch") }])).not.toThrow();
    expect(() => buildAnomalies([{ ...unreachableRefused, expected: exp("deny", "unauthorized") }])).not.toThrow();
  }, CASE_TIMEOUT_MS);

  it("every chainState label equals the session state observed after setup", async () => {
    const { cases } = loadCorpus();
    const labelled = cases.filter((c) => c.chainState !== null);
    expect(labelled.length).toBeGreaterThan(0);
    // The observation covers every non-init label the corpus uses.
    for (const state of ["refining", "researching", "concern-separating", "test-file-scanning", "writing", "committed"]) {
      expect(labelled.some((c) => c.chainState === state), state).toBe(true);
    }
    const mismatches = [];
    for (const c of labelled) {
      const got = await replayOnFreshFixture(c, { clientName: "claude-code", createServer, minted, agentCallCount, onBoot, sessionAudit: sessionAudits, setupOnly: true });
      if (got.observedState !== c.chainState || got.observedFlowType !== c.flowType) {
        mismatches.push(`${c.id}: label ${c.flowType}/${c.chainState}, observed ${got.observedFlowType}/${got.observedState}`);
      }
    }
    expect(mismatches).toEqual([]);
  }, MATRIX_TIMEOUT_MS);
});

describe("AC3 decision shape", () => {
  it("normaliseDecision maps deny, route and allow responses to effect and reason", () => {
    const res = (body, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(body) }], ...extra });
    expect(normaliseDecision(res({ ok: true, _autoRouted: { originalTool: "x" } }))).toEqual({ effect: "route", reason: "auto_routed", handlerReason: null });
    expect(normaliseDecision(res({ ok: false, preflightFailed: true, errors: [{ check: "branch", message: "m" }] }))).toEqual({ effect: "deny", reason: "preflight:branch", handlerReason: null });
    for (const r of ADMISSION_REASONS) {
      expect(normaliseDecision(res({ ok: false, error: r }))).toEqual({ effect: "deny", reason: r, handlerReason: null });
      expect(normaliseDecision(res({ ok: false, reason: r }, { isError: true }))).toEqual({ effect: "deny", reason: r, handlerReason: null });
      expect(normaliseDecision(null, { thrown: new Error(`refused: ${r}`) })).toEqual({ effect: "deny", reason: r, handlerReason: null });
    }
    expect(normaliseDecision(res({ ok: false, reason: "story_not_ready", message: "m" }))).toEqual({ effect: "allow", reason: null, handlerReason: "story_not_ready" });
    expect(normaliseDecision(res({ ok: false, error: "A prose message naming /tmp/x" }))).toEqual({ effect: "allow", reason: null, handlerReason: "error_message" });
    expect(normaliseDecision(res({ ok: false }))).toEqual({ effect: "allow", reason: null, handlerReason: "ok_false" });
    expect(normaliseDecision(res({ some: "thing" }, { isError: true }))).toEqual({ effect: "allow", reason: null, handlerReason: "is_error" });
    expect(normaliseDecision(res({ ok: true }))).toEqual({ effect: "allow", reason: null, handlerReason: null });
    const thrown = Object.assign(new Error("Invalid arguments"), { code: -32603 });
    expect(normaliseDecision(null, { thrown })).toEqual({ effect: "allow", reason: null, handlerReason: "thrown:-32603:unclassified" });
    expect(parseBody(res({ a: 1 }))).toEqual({ a: 1 });
  }, CASE_TIMEOUT_MS);

  it("normaliseDecision classifies a thrown error as thrown:<code>:<class> with unclassified as the only fallback", () => {
    const mcpErr = (code, message) => Object.assign(new Error(`MCP error ${code}: MCP error ${code}: ${message}`), { code });
    const zodIssues = JSON.stringify([{ code: "invalid_type", expected: "string", received: "undefined", path: ["problemId"], message: "Required" }], null, 2);
    // A zod-style issue list: zod:<first issue path>.
    expect(normaliseDecision(null, { thrown: mcpErr(-32603, zodIssues) })).toEqual({ effect: "allow", reason: null, handlerReason: "thrown:-32603:zod:problemId" });
    const nested = JSON.stringify([{ code: "invalid_enum_value", path: ["refinements", 0, "type"], message: "x" }, { code: "invalid_type", path: ["other"], message: "y" }]);
    expect(classifyThrownMessage(mcpErr(-32603, nested).message)).toBe("zod:refinements.0.type");
    expect(classifyThrownMessage(JSON.stringify([{ code: "custom", path: [], message: "z" }]))).toBe("zod:root");
    expect(classifyThrownMessage(JSON.stringify([{ code: "custom", path: ["a b/c"], message: "z" }]))).toBe("zod:a_b_c");
    // A known non-zod pattern from the closed map.
    expect(normaliseDecision(null, { thrown: mcpErr(-32602, "Project not found: 12345") })).toEqual({ effect: "allow", reason: null, handlerReason: "thrown:-32602:project_not_found" });
    for (const { cls } of THROWN_MESSAGE_PATTERNS) expect(cls, cls).toMatch(/^[a-z_]+$/);
    // An unrecognised message: unclassified, the only fallback. The simulated lockout message is one.
    expect(normaliseDecision(null, { thrown: mcpErr(-32603, LOCKOUT_MESSAGE) })).toEqual({ effect: "allow", reason: null, handlerReason: `thrown:-32603:${UNCLASSIFIED}` });
    expect(classifyThrownMessage("[not json")).toBe(UNCLASSIFIED);
    expect(classifyThrownMessage(JSON.stringify([{ no: "code" }]))).toBe(UNCLASSIFIED);
    // No input yields a bare thrown:<code>, and every result is a stable code.
    const inputs = [
      mcpErr(-32603, zodIssues), mcpErr(-32602, "Project not found: x"), mcpErr(-32603, "anything else"),
      new Error(""), new Error("no code at all"), "a bare string", { code: -32603 }, Object.assign(new Error("x"), { code: "a code with spaces" }),
      mcpErr(-32603, JSON.stringify([{ code: "c", path: ["p".repeat(200)], message: "m" }])),
    ];
    for (const thrown of inputs) {
      const d = normaliseDecision(null, { thrown });
      expect(d.effect).toBe("allow");
      expect(d.handlerReason).toMatch(/^thrown:[^:]+:.+$/);
      expect(d.handlerReason).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
    }
  }, CASE_TIMEOUT_MS);

  it("normaliseDecision matches admission reasons by whole token in every response shape", () => {
    const res = (body, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(body) }], ...extra });
    for (const r of ADMISSION_REASONS) {
      // reason or error, whether or not ok is false, an isError body included.
      expect(normaliseDecision(res({ error: r }))).toEqual({ effect: "deny", reason: r, handlerReason: null });
      expect(normaliseDecision(res({ reason: r }, { isError: true }))).toEqual({ effect: "deny", reason: r, handlerReason: null });
      expect(normaliseDecision(res({ ok: true, reason: r }))).toEqual({ effect: "deny", reason: r, handlerReason: null });
      expect(normaliseDecision(res({ ok: false, error: r }, { isError: true }))).toEqual({ effect: "deny", reason: r, handlerReason: null });
      // A thrown message names a reason only as a whole token.
      expect(normaliseDecision(null, { thrown: Object.assign(new Error(`MCP error -32603: refused (${r}).`), { code: -32603 }) }).reason).toBe(r);
      expect(normaliseDecision(null, { thrown: Object.assign(new Error(`MCP error -32603: not_${r}_here`), { code: -32603 }) }).effect).toBe("allow");
      expect(normaliseDecision(null, { thrown: new Error(`${r}x`) }).effect).toBe("allow");
    }
    expect(normaliseDecision(null, { thrown: new Error("not_unauthorized_here") })).toEqual({ effect: "allow", reason: null, handlerReason: "thrown:error:unclassified" });
    // A non-member code in an isError body is not an admission reason.
    expect(normaliseDecision(res({ reason: "story_not_ready" }, { isError: true }))).toEqual({ effect: "allow", reason: null, handlerReason: "is_error" });
  }, CASE_TIMEOUT_MS);

  it("replayCase throws when a setup step is refused, errors or returns no token", async () => {
    const res = (body, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(body) }], ...extra });
    // A scripted client: setup responses by tool name; rks_governor_end always ends.
    const fakeClient = (script) => {
      const calls = [];
      return {
        calls,
        callTool: async ({ name, arguments: args }) => {
          calls.push({ name, args });
          if (name === "rks_governor_end") return res({ ok: true, ended: true, flowType: "open", state: "init" });
          const r = script[name];
          if (r instanceof Error) throw r;
          return r ?? res({ ok: true });
        },
      };
    };
    const kase = (setup) => ({ id: "synthetic", tool: "rks_project_get", args: { _governorToken: TOK }, setup });
    const init = initStep({ flowType: "open" });
    const step = { tool: "rks_agent_research", args: { _governorToken: TOK } };
    const goodInit = res({ ok: true, token: "tok-1" });
    const failing = [
      ["init refused", [init], { rks_governor_init: res({ ok: false, reason: "project_leased" }) }],
      ["init errors", [init], { rks_governor_init: res({ token: "tok-1" }, { isError: true }) }],
      ["init throws", [init], { rks_governor_init: new Error("boom") }],
      ["init returns no token", [init], { rks_governor_init: res({ ok: true }) }],
      ["step throws", [init, step], { rks_governor_init: goodInit, rks_agent_research: new Error("boom") }],
      ["step isError", [init, step], { rks_governor_init: goodInit, rks_agent_research: res({ x: 1 }, { isError: true }) }],
      ["step ok false", [init, step], { rks_governor_init: goodInit, rks_agent_research: res({ ok: false, error: "nope" }) }],
    ];
    for (const [label, setup, script] of failing) {
      const client = fakeClient(script);
      await expect(replayCase(client, kase(setup)), label).rejects.toBeInstanceOf(SetupStepError);
      expect(client.calls.some((c) => c.name === "rks_project_get"), `${label}: the case call never runs`).toBe(false);
    }
    // A refused init that still minted a token is ended.
    const leaky = fakeClient({ rks_governor_init: res({ ok: false, reason: "x", token: "tok-9" }) });
    await expect(replayCase(leaky, kase([init]))).rejects.toBeInstanceOf(SetupStepError);
    expect(leaky.calls.some((c) => c.name === "rks_governor_end" && c.args._governorToken === "tok-9")).toBe(true);
    // Negative controls: a clean setup, and a step that declares it expects a refusal, record a decision.
    const ok = await replayCase(fakeClient({ rks_governor_init: goodInit }), kase([init, step]));
    expect(ok.effect).toBe("allow");
    const declared = await replayCase(fakeClient({ rks_governor_init: goodInit, rks_agent_research: res({ ok: false, error: "nope" }) }), kase([init, { ...step, expectRefusal: true }]));
    expect(declared.effect).toBe("allow");
  }, CASE_TIMEOUT_MS);

  it("every corpus reason and handlerReason is a stable code and none is a bare thrown:<code>", () => {
    const { cases } = loadCorpus();
    const bad = [];
    for (const c of cases) {
      for (const v of [c.expected.reason, c.expected.handlerReason]) {
        if (v !== null && !/^[A-Za-z0-9_.:-]{1,80}$/.test(v)) bad.push(`${c.id}: ${v}`);
      }
      const h = c.expected.handlerReason;
      if (typeof h === "string" && /^thrown:[^:]+$/.test(h)) bad.push(`${c.id}: bare ${h}`);
    }
    expect(cases.some((c) => String(c.expected.handlerReason ?? "").startsWith("thrown:"))).toBe(true);
    expect(bad).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("every corpus case replays in-process to its recorded effect and reason", async () => {
    const { cases } = loadCorpus();
    expect(cases.length).toBeGreaterThan(0);
    const mismatches = [];
    for (const c of cases) {
      const got = await inProcessResult(c);
      if (JSON.stringify(got) !== JSON.stringify(c.expected)) mismatches.push(`${c.id}: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(got)}`);
      if (c.expectArgRefusal && c.expected.effect !== "deny") mismatches.push(`${c.id}: checkToolArgs refusal case classified ${c.expected.effect}, not deny`);
      if (c.expected.effect !== "allow") expect(c.expected.handlerReason, c.id).toBeNull();
    }
    expect(mismatches).toEqual([]);
  }, MATRIX_TIMEOUT_MS);
});

describe("AC4 client invariance", () => {
  it("every case yields identical decisions under the claude-code, routekit-call and cursor client names", async () => {
    const { cases } = loadCorpus();
    expect(CLIENT_PROFILES.map((p) => p.name)).toEqual(["claude-code", "routekit-call", "cursor"]);
    const differences = [];
    for (const c of cases) {
      expect(Object.keys(c.expected).sort(), c.id).toEqual(["agentCalls", "effect", "handlerReason", "reason"]);
      const baseline = await inProcessResult(c);
      for (const profile of CLIENT_PROFILES.slice(1)) {
        const got = decisionOf(await replayIn(c, profile.name));
        if (JSON.stringify(got) !== JSON.stringify(baseline)) differences.push(`${c.id} under ${profile.name}: ${JSON.stringify(got)} vs claude-code ${JSON.stringify(baseline)}`);
      }
    }
    for (const lane of LANES) expect(cases.some((c) => c.lane === lane), lane).toBe(true);
    expect(differences).toEqual([]);
  }, MATRIX_TIMEOUT_MS);
});

describe("AC5 narrow-only", () => {
  it("self-reported via and actor on rks_governor_init never widen admission", async () => {
    const { cases } = loadCorpus();
    const pairs = new Map();
    for (const c of cases.filter((x) => x.ac5)) {
      expect(c.lane, c.id).toBe("mcp");
      const entry = pairs.get(c.ac5.probe) ?? {};
      entry[c.ac5.variant] = c;
      pairs.set(c.ac5.probe, entry);
    }
    expect(pairs.size).toBeGreaterThanOrEqual(5);
    const widened = [];
    let plainDenied = 0;
    for (const [probe, { plain, "self-reported": self }] of pairs) {
      expect(plain && self, probe).toBeTruthy();
      const p = await inProcessResult(plain);
      const s = await inProcessResult(self);
      if (p.effect === "deny") {
        plainDenied += 1;
        if (s.effect !== "deny") widened.push(`${probe}: plain ${JSON.stringify(p)} but self-reported ${JSON.stringify(s)}`);
      }
    }
    // The comparison observes something: the read-only lane denies at least one plain probe.
    expect(plainDenied).toBeGreaterThan(0);
    expect(widened).toEqual([]);
  }, MATRIX_TIMEOUT_MS);

  it("a chain-gate-decided probe pair stays denied under self-reported via and actor", async () => {
    const { cases } = loadCorpus();
    const plains = cases.filter((c) => c.ac5?.variant === "plain" && c.expected.effect === "deny" && c.expected.reason === "chain_violation");
    expect(plains.length, "an AC5 probe whose plain variant the chain gate denies").toBeGreaterThan(0);
    for (const plain of plains) {
      const self = cases.find((c) => c.ac5?.probe === plain.ac5.probe && c.ac5.variant === "self-reported");
      expect(self, plain.ac5.probe).toBeTruthy();
      expect(self.expected.effect, self.id).toBe("deny");
      const p = await inProcessResult(plain);
      const sr = await inProcessResult(self);
      expect(p, plain.id).toEqual(plain.expected);
      expect(sr.effect, self.id).toBe("deny");
    }
  }, MATRIX_TIMEOUT_MS);
});

describe("AC6 rks_guardrails_off admission", () => {
  it("a valid-token call passes the chain gate from every flowType", async () => {
    const { cases } = loadCorpus();
    for (const flow of FLOW_TYPES) {
      const c = cases.find((x) => x.tool === "rks_guardrails_off" && x.token === "valid" && x.flowType === flow && x.lane === "ide");
      expect(c, flow).toBeTruthy();
      expect(c.expected.effect, c.id).toBe("allow");
      expect(c.expected.reason, c.id).not.toBe("chain_violation");
      expect(c.expected.handlerReason, c.id).not.toBeNull();
      expect(await inProcessResult(c), c.id).toEqual(c.expected);
    }
  }, CASE_TIMEOUT_MS);

  it("a tokenless call is decided by the token gate", async () => {
    const { cases } = loadCorpus();
    const c = cases.find((x) => x.tool === "rks_guardrails_off" && x.token === "absent" && x.lane === "ide" && x.lanesBlock === "ok");
    expect(c).toBeTruthy();
    expect(["deny", "route"]).toContain(c.expected.effect);
    if (c.expected.effect === "deny") expect(c.expected.reason).toBe("unauthorized");
    expect(await inProcessResult(c)).toEqual(c.expected);
  }, CASE_TIMEOUT_MS);
});

describe("AC7 owner baseline", () => {
  it("every IDE-lane baseline category is present and allowed", async () => {
    const { cases } = loadCorpus();
    const CATEGORIES = [...FLOW_TYPES.map((f) => `chain:${f}`), "guardrails_off", "ship", "release", "build-chain", "ship-chain"];
    // Strict baseline: every ideBaseline member belongs to a known category.
    for (const c of cases.filter((x) => x.ideBaseline)) expect(CATEGORIES, c.id).toContain(c.ideBaseline);
    const repoLanes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".rks", "project.json"), "utf8")).lanes;
    for (const category of CATEGORIES) {
      const members = cases.filter((c) => c.ideBaseline === category);
      expect(members.length, `baseline category ${category}`).toBeGreaterThan(0);
      for (const c of members) {
        expect(c.lane, c.id).toBe("ide");
        expect(c.lanesBlock, c.id).toBe("ok");
        expect(c.fixture?.branch ?? null, c.id).toBeNull();
        expect(c.expected.effect, c.id).toBe("allow");
        if (c.sideEffect) expect(c.expected.handlerReason, c.id).not.toBeNull();
      }
    }
    if (repoLanes) expect(repoLanes.ide).toBe("full");
    const sample = CATEGORIES.map((cat) => cases.find((c) => c.ideBaseline === cat));
    for (const c of sample) expect(await inProcessResult(c), c.id).toEqual(c.expected);
    // Strict baseline AC 3: the factored check passes on every member's replayed decision.
    const decisions = new Map();
    for (const c of cases.filter((x) => x.ideBaseline)) decisions.set(c.id, await inProcessResult(c));
    expect(ac7BaselineFailures(cases, decisions)).toEqual([]);
  }, MATRIX_TIMEOUT_MS);

  it("every side-effecting baseline member records a recognised handler class", () => {
    const { cases } = loadCorpus();
    const members = cases.filter((c) => c.ideBaseline && c.sideEffect);
    for (const id of ["story:init:rks_refine", "ship:init:rks_git_commit", "ops:init:rks_release", "ops:init:rks_promote", "ops:init:rks_tag", "ops:init:rks_sync_staging", "ops:init:rks_agent_run"]) {
      expect(members.some((c) => c.id === id), id).toBe(true);
    }
    const unrecognised = members.filter((c) => !recognisedHandlerClass(c.expected.handlerReason)).map((c) => `${c.id}: ${c.expected.handlerReason}`);
    expect(unrecognised).toEqual([]);
    // Positive control: the generic codes are not recognised.
    for (const h of [null, "ok_false", "error_message", "is_error", "thrown:-32603", `thrown:-32603:${UNCLASSIFIED}`]) expect(recognisedHandlerClass(h), String(h)).toBe(false);
    for (const h of ["story_not_ready", "invalid_agent_input", "thrown:-32603:zod:problemId", "thrown:-32602:project_not_found"]) expect(recognisedHandlerClass(h), h).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("every side-effecting baseline member records its hand-written expected handlerReason", () => {
    const { cases } = loadCorpus();
    const members = cases.filter((c) => c.ideBaseline && c.sideEffect);
    expect(members.map((c) => c.id).sort()).toEqual(Object.keys(AC7_EXPECTED_HANDLER_REASONS).sort());
    for (const c of members) expect(c.expected.handlerReason, c.id).toBe(AC7_EXPECTED_HANDLER_REASONS[c.id]);
    expect(AC7_EXPECTED_HANDLER_REASONS["ops:init:rks_release"]).toBe("thrown:-32603:zod:version");
    expect(ac7HandlerReasonFailures(cases)).toEqual([]);
    // Positive controls: a regenerated value, a dropped member and an extra member each fail the check.
    const release = cases.find((c) => c.id === "ops:init:rks_release");
    const regenerated = cases.map((c) => (c === release ? { ...c, expected: { ...c.expected, handlerReason: "thrown:-32603:zod:projectId" } } : c));
    expect(ac7HandlerReasonFailures(regenerated)).toEqual(["ops:init:rks_release: records thrown:-32603:zod:projectId, hand-written thrown:-32603:zod:version"]);
    expect(ac7HandlerReasonFailures(cases.filter((c) => c !== release))).toEqual(["ops:init:rks_release: hand-written member missing from the corpus side-effecting baseline"]);
    const extra = { ...release, id: "synthetic:extra-member" };
    expect(ac7HandlerReasonFailures([...cases, extra])).toEqual(["synthetic:extra-member: side-effecting baseline member has no hand-written expected handlerReason"]);
    // The factored AC7 check also pins the value on a supplied decision.
    const decisions = new Map(cases.filter((c) => c.ideBaseline).map((c) => [c.id, { ...c.expected }]));
    expect(ac7BaselineFailures(cases, decisions)).toEqual([]);
    decisions.set(release.id, { ...release.expected, handlerReason: "thrown:-32603:zod:projectId" });
    expect(ac7BaselineFailures(cases, decisions).some((f) => f.startsWith("ops:init:rks_release:") && f.includes("hand-written thrown:-32603:zod:version"))).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("the AC7 check fails each of the 6 lockout cases under a simulated owner lockout and passes on unmutated decisions", async () => {
    const { cases } = loadCorpus();
    const members = cases.filter((c) => c.ideBaseline);
    for (const id of LOCKOUT_CASES) expect(members.some((c) => c.id === id), id).toBe(true);
    const unmutated = new Map();
    const mutant = new Map();
    for (const c of members) {
      unmutated.set(c.id, decisionOf(await replayIn(c)));
      try {
        mutant.set(c.id, decisionOf(await replayOnFreshFixture(c, { clientName: "claude-code", createServer: lockoutCreateServer, minted, agentCallCount, onBoot, sessionAudit: sessionAudits })));
      } catch (err) {
        mutant.set(c.id, { replayError: String(err?.message ?? err).slice(0, 200) });
      }
    }
    // Negative control: no failure on the unmutated decisions.
    expect(ac7BaselineFailures(cases, unmutated)).toEqual([]);
    // Positive control: a failure for each of the 6 lockout cases.
    const failures = ac7BaselineFailures(cases, mutant);
    for (const id of LOCKOUT_CASES) expect(failures.some((f) => f.startsWith(`${id}:`)), `${id} under the simulated lockout; failures: ${failures.join(" | ")}`).toBe(true);
    for (const id of LOCKOUT_CASES) expect(mutant.get(id)?.handlerReason, id).toBe(`thrown:-32603:${UNCLASSIFIED}`);
    // The lockout reached only tokened ide-lane calls to the 6 tools: a member calling another tool is unchanged.
    for (const c of members.filter((x) => !LOCKOUT_TOOLS.includes(x.tool) && !x.setup.some((st) => LOCKOUT_TOOLS.includes(st.tool)))) {
      expect(mutant.get(c.id), c.id).toEqual(unmutated.get(c.id));
    }
  }, MATRIX_TIMEOUT_MS);

  it("every reachable build and ship chain pair has an observed allow baseline case", () => {
    const { cases } = loadCorpus();
    const unreachable = new Set(CHAIN_UNREACHABLE.map((u) => u.pair));
    const reachable = REQUIRED_CHAIN_PAIRS.filter((p) => !unreachable.has(p));
    expect(reachable.length).toBeGreaterThan(0);
    const missing = [];
    for (const pair of reachable) {
      const [flow, state, tool] = pair.split(":");
      const hit = cases.find((c) => c.flowType === flow && c.chainState === state && c.tool === tool && c.token === "valid" && ["build-chain", "ship-chain"].includes(c.ideBaseline));
      if (!hit) { missing.push(`${pair}: no baseline case`); continue; }
      if (hit.expected.effect !== "allow") missing.push(`${pair}: ${hit.id} observed ${hit.expected.effect} ${hit.expected.reason}`);
      if (hit.sideEffect && !recognisedHandlerClass(hit.expected.handlerReason)) missing.push(`${pair}: ${hit.id} records ${hit.expected.handlerReason}`);
      // Reached only by tools/call setup steps (plus fixture git state): init first, then further steps.
      if (hit.setup[0]?.tool !== "rks_governor_init" || hit.setup.length < 2) missing.push(`${pair}: ${hit.id} setup does not reach ${state} by tools/call`);
      if (Object.keys(hit.fixture ?? {}).some((k) => k !== "worktreeChange")) missing.push(`${pair}: ${hit.id} fixture overrides more than git state`);
      if (hit.env) missing.push(`${pair}: ${hit.id} carries an env override`);
    }
    expect(missing).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("CHAIN_UNREACHABLE closes the build and ship chain pair set and lists rks_apply", () => {
    const { cases } = loadCorpus();
    const reached = new Set(cases.filter((c) => ["build-chain", "ship-chain"].includes(c.ideBaseline) && c.expected.effect === "allow").map((c) => `${c.flowType}:${c.chainState}:${c.tool}`));
    const unreachable = CHAIN_UNREACHABLE.map((u) => u.pair);
    expect(new Set(unreachable).size).toBe(unreachable.length);
    for (const u of CHAIN_UNREACHABLE) expect(typeof u.reason === "string" && u.reason.trim().length > 20, u.pair).toBe(true);
    for (const p of unreachable) expect(reached.has(p), `${p} is both reached and listed unreachable`).toBe(false);
    expect([...new Set([...reached, ...unreachable])].sort()).toEqual([...REQUIRED_CHAIN_PAIRS].sort());
    const apply = CHAIN_UNREACHABLE.find((u) => u.pair.endsWith(":rks_apply"));
    expect(apply).toBeTruthy();
    expect(apply.reason).toMatch(/no flow state admits rks_apply/);
    // Observed support: every tokened rks_apply case is denied by the chain gate.
    const tokenedApply = cases.filter((c) => c.tool === "rks_apply" && c.token === "valid");
    expect(tokenedApply.length).toBeGreaterThan(0);
    for (const c of tokenedApply) expect([c.expected.effect, c.expected.reason], c.id).toEqual(["deny", "chain_violation"]);
  }, CASE_TIMEOUT_MS);

  it("every CHAIN_UNREACHABLE entry has observed support or a no-support marker with a reason", () => {
    const { cases } = loadCorpus();
    expect(CHAIN_UNREACHABLE.length).toBe(6);
    expect(chainUnreachableSupportFailures(CHAIN_UNREACHABLE, cases)).toEqual([]);
    // Every entry carries observed support today; none relies on a no-support marker.
    for (const u of CHAIN_UNREACHABLE) {
      expect(Array.isArray(u.support) && u.support.length > 0, u.pair).toBe(true);
      for (const s of u.support) expect(s.check(cases).hits.length, `${u.pair}: ${s.label}`).toBeGreaterThan(0);
    }
    // Positive controls: an entry with neither fails, a marker without a reason fails, a marker with a
    // reason passes, support that inspects no case fails, and contradicted support fails.
    const base = { pair: "synthetic:none:rks_none", reason: "synthetic entry for the AC 7 positive control" };
    expect(chainUnreachableSupportFailures([base], cases)).toEqual(["synthetic:none:rks_none: neither observed support nor a no-support marker with a reason"]);
    expect(chainUnreachableSupportFailures([{ ...base, noSupport: "" }], cases)).toHaveLength(1);
    expect(chainUnreachableSupportFailures([{ ...base, noSupport: "no corpus observation can bear on this synthetic pair" }], cases)).toEqual([]);
    expect(chainUnreachableSupportFailures([{ ...base, support: [chainDenied("story", "rks_no_such_tool")] }], cases)).toEqual([`synthetic:none:rks_none: ${chainDenied("story", "rks_no_such_tool").label}: inspects no corpus case`]);
    const contradicted = chainUnreachableSupportFailures([{ ...base, support: [chainDenied("open", "rks_agent_research")] }], cases);
    expect(contradicted.length).toBeGreaterThan(0);
    expect(contradicted.every((f) => f.includes("contradicted by"))).toBe(true);
    expect(chainUnreachableSupportFailures([{ ...base, support: [stateNeverReached("story", "refining")] }], cases).some((f) => f.includes("contradicted by"))).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe("AC9 transport agreement", () => {
  it("sampled stdio replay matches in-process decisions per effect and per lane", async () => {
    const { cases } = loadCorpus();
    const sample = cases.filter((c) => c.stdio);
    for (const effect of ["allow", "deny", "route"]) expect(sample.some((c) => c.expected.effect === effect), effect).toBe(true);
    for (const lane of LANES) expect(sample.some((c) => c.lane === lane), lane).toBe(true);
    const routes = sample.filter((c) => c.expected.effect === "route");
    for (const c of routes) { expect(c.tool, c.id).toBe("dendron_create_note"); expect(c.token, c.id).toBe("absent"); }
    const ragTools = new Set(["rks_rag_query", "rks_rag_embed", "rks_rag_init", "rks_rag_compact", "rks_fetch_raw", "rks_agent_external_research"]);
    const differences = [];
    for (const c of sample) {
      expect(c.expected.agentCalls, c.id).toBe(0);
      expect(ragTools.has(c.tool), c.id).toBe(false);
      const inProc = await inProcessResult(c);
      const viaStdio = await replayOnFreshFixture(c, { clientName: "claude-code", transport: "stdio", minted, onBoot, sessionAudit: sessionAudits });
      const strip = ({ effect, reason, handlerReason }) => ({ effect, reason, handlerReason });
      if (JSON.stringify(strip(viaStdio)) !== JSON.stringify(strip(inProc))) differences.push(`${c.id}: stdio ${JSON.stringify(strip(viaStdio))} vs in-process ${JSON.stringify(strip(inProc))}`);
    }
    expect(differences).toEqual([]);
  }, STDIO_TIMEOUT_MS);
});

describe("AC10 hermetic", () => {
  it("token-gate bypass is inactive and no network or real agent call occurs", async () => {
    const { cases } = loadCorpus();
    // Replay a sample here so the check observes boots even when this block runs alone.
    for (const c of cases.filter((x) => x.ideBaseline).slice(0, 4)) await inProcessResult(c);
    const boots = bootLog.filter((b) => b.transport === "in-process");
    expect(boots.length).toBeGreaterThan(0);
    expect(boots.filter((b) => b.bypassActive)).toEqual([]);
    expect(tokenGateBypass({ NODE_ENV: "test" }).active).toBe(true); // positive control: the probe can observe a bypass
    expect(fetchCalls).toBe(0);
    expect(globalThis.fetch).toBe(fetchStub);
    expect(vi.isMockFunction(runAgent)).toBe(true);
    for (const name of ["runRagEmbed", "runRagInit", "runRagReset", "runRagQuery", "runRagCompact", "ensureRagIndex"]) {
      expect(vi.isMockFunction(rag[name]), name).toBe(true);
    }
  }, MATRIX_TIMEOUT_MS);
  // QA retitled (AC10-1): agentCalls is recorded per case and reproduced by the replay; tokened rks_agent_*
  // allow cases reach runAgent, the dendron_create_note route does not.
  it("every case reproduces its recorded agentCalls, and the dendron_create_note route and every deny case record zero", async () => {
    const { cases, anomalies } = loadCorpus();
    // ARCH v2 item 10 (b): a control that can observe a non-zero count. Every agentCalls >= 1 case is a
    // tokened rks_agent_* allow case (agent-tools.mjs:14, :33) or a non-dendron_create_note auto-route (server.mjs:366).
    // The one observed exception, the server's rks_agent_research self-bootstrap, is admitted only while it
    // is listed in the corpus anomalies (see SELF_BOOTSTRAP_ANOMALY_NOTE); any other exception fails.
    const reaching = cases.filter((c) => c.expected.agentCalls >= 1);
    expect(reaching.length).toBeGreaterThanOrEqual(1);
    expect(reaching.some((c) => c.tool.startsWith("rks_agent_") && c.token === "valid" && c.expected.effect === "allow")).toBe(true);
    const listedSelfBootstrap = anomalies.some((a) => a.caseId === SELF_BOOTSTRAP_ANOMALY_CASE);
    // Hardening AC 1: only the AUTO_ROUTE_ANOMALY_CASES members present in the anomalies, not every anomaly caseId.
    const listed = autoRouteListedIds(anomalies);
    for (const c of reaching) {
      const tokenedAgentAllow = c.tool.startsWith("rks_agent_") && c.token === "valid" && c.expected.effect === "allow";
      // Strict baseline AC 12: an auto-route into runAgent off the ide lane is admitted only while listed.
      const nonCreateRoute = agentReachingAdmitted(c, listed);
      const selfBootstrap = listedSelfBootstrap && c.id === SELF_BOOTSTRAP_ANOMALY_CASE && c.tool === "rks_agent_research" && c.token === "absent";
      expect(tokenedAgentAllow || nonCreateRoute || selfBootstrap, c.id).toBe(true);
    }
    for (const c of cases) {
      if (c.expected.effect === "deny" || (c.expected.effect === "route" && c.tool === "dendron_create_note")) {
        expect(c.expected.agentCalls, c.id).toBe(0);
      }
      const got = await replayOnFreshFixture(c, { clientName: "claude-code", createServer, minted, agentCallCount, onBoot, sessionAudit: sessionAudits });
      expect(got.agentCalls, c.id).toBe(c.expected.agentCalls);
    }
    expect(fetchCalls).toBe(0);
  }, MATRIX_TIMEOUT_MS);

  it("auto-routed runAgent cases are admitted only while listed as anomalies", () => {
    const { cases, anomalies } = loadCorpus();
    const listed = new Map(anomalies.map((a) => [a.caseId, a.note]));
    for (const id of AUTO_ROUTE_ANOMALY_CASES) {
      const c = cases.find((x) => x.id === id);
      expect(c, id).toBeTruthy();
      expect([c.lane, c.token, c.expected.effect, c.expected.agentCalls], id).toEqual(["mcp", "absent", "route", 1]);
      expect(typeof listed.get(id) === "string" && listed.get(id).includes("runAgent"), id).toBe(true);
    }
    // Every off-ide-lane auto-route that reaches runAgent is listed.
    const offIde = cases.filter((c) => c.expected.effect === "route" && c.expected.agentCalls >= 1 && c.lane !== "ide").map((c) => c.id).sort();
    expect(offIde).toEqual([...AUTO_ROUTE_ANOMALY_CASES].sort());
    // The rule admits them only while listed: without the anomaly entries the same rule rejects them.
    // Hardening AC 1: this calls the module-scope agentReachingAdmitted, the rule the agentCalls test uses.
    const listedIds = autoRouteListedIds(anomalies);
    for (const id of AUTO_ROUTE_ANOMALY_CASES) {
      const c = cases.find((x) => x.id === id);
      expect(c.lane, id).not.toBe("ide");
      expect(agentReachingAdmitted(c, listedIds), id).toBe(true);
      expect(agentReachingAdmitted(c, new Set()), id).toBe(false);
      expect(agentReachingAdmitted(c, new Set([...listedIds].filter((k) => k !== id))), id).toBe(false);
    }
    // Negative control: an ide-lane non-create auto-route is admitted with nothing listed.
    const ideRoute = cases.find((c) => c.lane === "ide" && c.expected.effect === "route" && c.tool !== "dendron_create_note" && c.expected.agentCalls >= 1);
    expect(ideRoute).toBeTruthy();
    expect(agentReachingAdmitted(ideRoute, new Set()), ideRoute.id).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("the auto-route listed set holds only AUTO_ROUTE_ANOMALY_CASES members present in the anomalies", () => {
    const { anomalies } = loadCorpus();
    const present = new Set(anomalies.map((a) => a.caseId));
    const listedIds = autoRouteListedIds(anomalies);
    expect([...listedIds].sort()).toEqual(AUTO_ROUTE_ANOMALY_CASES.filter((id) => present.has(id)).sort());
    expect(listedIds.size).toBeGreaterThan(0);
    // No guardrails-off, self-bootstrap or preflight anomaly caseId is in the set, though each is an anomaly.
    const others = [GUARDRAILS_OFF_ANOMALY_CASE, SELF_BOOTSTRAP_ANOMALY_CASE, ...anomalies.map((a) => a.caseId).filter((id) => id.startsWith("preflight-refused:"))];
    expect(others.filter((id) => id.startsWith("preflight-refused:")).length).toBeGreaterThan(0);
    for (const id of others) {
      expect(present.has(id), id).toBe(true);
      expect(listedIds.has(id), id).toBe(false);
    }
    for (const id of listedIds) expect(AUTO_ROUTE_ANOMALY_CASES, id).toContain(id);
    // Positive control: a member absent from the anomalies is not listed.
    const dropped = AUTO_ROUTE_ANOMALY_CASES[0];
    expect(autoRouteListedIds(anomalies.filter((a) => a.caseId !== dropped)).has(dropped)).toBe(false);
    expect(autoRouteListedIds([]).size).toBe(0);
  }, CASE_TIMEOUT_MS);
});

describe("AC11 corpus regeneration", () => {
  it("a normal run leaves the corpus byte-identical", () => {
    if (UPDATE_CORPUS) {
      expect(fs.existsSync(CORPUS_PATH)).toBe(true);
      return;
    }
    expect(corpusBytesAtStart, "corpus must exist for a normal run").not.toBeNull();
    expect(Buffer.compare(fs.readFileSync(CORPUS_PATH), corpusBytesAtStart)).toBe(0);
  }, CASE_TIMEOUT_MS);
  it("every anomaly names an existing case and the rks_guardrails_off chain-gate admission is listed", () => {
    const { cases, anomalies } = loadCorpus();
    const ids = new Set(cases.map((c) => c.id));
    expect(Array.isArray(anomalies)).toBe(true);
    for (const a of anomalies) {
      expect(ids.has(a.caseId), a.caseId).toBe(true);
      expect(typeof a.note === "string" && a.note.trim().length > 0, a.caseId).toBe(true);
    }
    const gr = anomalies.find((a) => a.caseId === GUARDRAILS_OFF_ANOMALY_CASE);
    expect(gr).toBeTruthy();
    expect(gr.note).toContain("COMMON_TOOLS");
    expect(cases.find((c) => c.id === GUARDRAILS_OFF_ANOMALY_CASE).tool).toBe("rks_guardrails_off");
  }, CASE_TIMEOUT_MS);

  it("committed case inputs equal buildCaseSpecs output in order", async () => {
    const { cases } = loadCorpus();
    const inputs = cases.map(({ expected, ...rest }) => rest);
    const specs = JSON.parse(JSON.stringify(buildCaseSpecs(await listToolNames())));
    expect(inputs.map((c) => c.id)).toEqual(specs.map((c) => c.id));
    expect(inputs).toEqual(specs);
    for (const c of cases) expect(c.expected, c.id).toBeTruthy();
  }, CASE_TIMEOUT_MS);

  it("committed anomalies equal buildAnomalies output and the hand-written anomaly id list", () => {
    const { cases, anomalies } = loadCorpus();
    expect(anomalies).toEqual(buildAnomalies(cases));
    expect(anomalies.map((a) => a.caseId)).toEqual([...EXPECTED_ANOMALY_IDS]);
    const sb = anomalies.find((a) => a.caseId === SELF_BOOTSTRAP_ANOMALY_CASE);
    expect(sb.note).toContain(".rks/session/governor");
    expect(sb.note).not.toContain("does not end that server-minted session");
  }, CASE_TIMEOUT_MS);
  // QA accepted (AC 11 amendment).
  it("the committed corpus is generated output with cases, hook-oracle entries and an anchor", () => {
    const corpus = loadCorpus();
    expect(corpus.regenerateWith).toBe("UPDATE_ADMISSION_CORPUS=1");
    expect(corpus.cases.length).toBeGreaterThan(0);
    expect(corpus.hookOracle.length).toBeGreaterThan(0);
    expect(corpus.anchor).not.toBeNull();
    expect(typeof corpus.anchor).toBe("string");
    for (const c of corpus.cases) {
      expect(c.expected, c.id).toBeTruthy();
      for (const v of [c.expected.reason, c.expected.handlerReason]) {
        if (v !== null) expect(v, c.id).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
      }
    }
  }, CASE_TIMEOUT_MS);
});

// QA accepted (AC 13).
describe("AC13 isolation", () => {
  it("every server boots against a mkdtemp fixture root and the case env is restored", async () => {
    const { cases } = loadCorpus();
    const keys = [...new Set([...SCRUBBED_ENV, ...FIXTURE_ENV])];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const sentinel = Object.fromEntries(keys.map((k) => [k, `admission-conformance-sentinel-${k}`]));
    const bootsBefore = bootLog.length;
    try {
      Object.assign(process.env, sentinel);
      for (const c of cases.filter((x) => x.ideBaseline).slice(0, 3)) await replayIn(c);
      for (const k of keys) expect(process.env[k], k).toBe(sentinel[k]);
    } finally {
      for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
    }
    expect(bootLog.length).toBeGreaterThan(bootsBefore);
    const tmp = fs.realpathSync(os.tmpdir());
    const roots = bootLog.map((b) => b.root);
    for (const b of bootLog) {
      expect(b.root, JSON.stringify(b)).toBeTruthy();
      expect(b.root.startsWith(tmp + path.sep), b.root).toBe(true);
      expect(path.basename(b.root).startsWith("admission-conformance-"), b.root).toBe(true);
      expect(b.root.startsWith(REPO_ROOT), b.root).toBe(false);
      expect(b.kgPresent, b.root).toBe(true);
    }
    expect(new Set(roots).size).toBe(roots.length);
    // Every session the suite minted has been ended. validateToken judges in-process sessions; for a
    // stdio-minted token it validates false once the fixture is gone whether or not the session was ended
    // (hardening AC 5), so every replay's own fixture audit, taken before cleanup, is checked as well.
    const live = minted.filter((t) => validateToken(t));
    expect(live).toEqual([]);
    expect(sessionAudits.length).toBeGreaterThan(0);
    expect(liveMintedSessions(sessionAudits)).toEqual([]);
  }, MATRIX_TIMEOUT_MS);

  it("the minted-session-ended check reports a deliberately un-ended stdio session as live", async () => {
    // Hardening AC 5 positive control. The helper ends every session it mints, so this stdio session is
    // minted here, outside replayOnFreshFixture, and left un-ended while the check observes it.
    const fixture = makeFixtureRoot({ label: "stdio-live-control" });
    let token = null;
    let conn = null;
    try {
      await withCaseEnv({ ROUTEKIT_PROJECT_ROOT: fixture.root, RKS_VIA: "ide" }, async () => {
        conn = await connectStdio({ env: stdioEnv({ root: fixture.root, home: fixture.root, via: "ide" }), cwd: fixture.root, clientName: "claude-code" });
        try {
          token = parseBody(await conn.client.callTool({ name: "rks_governor_init", arguments: { projectId: FIXTURE_PROJECT_ID, flowType: "open" } }))?.token ?? null;
          expect(token).toBeTruthy();
          minted.push(token);
          const liveAudit = auditFixtureSessions({ id: "stdio-live-control", transport: "stdio", root: fixture.root, tokens: [token] });
          expect(liveAudit.liveFiles.length).toBeGreaterThan(0);
          const reported = liveMintedSessions([liveAudit]);
          expect(reported).toHaveLength(1);
          expect(reported[0]).toContain("stdio-live-control (stdio)");
          // Ended after the observation, so no session or lease leaks.
          const endBody = parseBody(await conn.client.callTool({ name: "rks_governor_end", arguments: { projectId: FIXTURE_PROJECT_ID, _governorToken: token } }));
          expect(endBody?.ended).toBe(true);
          const endedAudit = auditFixtureSessions({ id: "stdio-live-control", transport: "stdio", root: fixture.root, tokens: [token] });
          expect(liveMintedSessions([endedAudit])).toEqual([]);
          sessionAudits.push(endedAudit);
        } finally {
          await conn.close();
        }
      });
    } finally {
      fixture.cleanup();
    }
  }, STDIO_TIMEOUT_MS);
  it("no minted token or conformance note reaches the real repo, and the scan finds fixture tokens", async () => {
    // ARCH v2 item 10 (a): the positive control is taken while the session is live. endSession removes the
    // token's persisted record (governor-token.mjs:855 -> removePersistedSession, :260-265) and releaseLease
    // drops it from the lease record (project-lease.mjs:681, :693), so a post-run fixture scan is always empty.
    const fixture = makeFixtureRoot({ label: "live-control" });
    try {
      await withCaseEnv({ ROUTEKIT_PROJECT_ROOT: fixture.root, RKS_VIA: "ide" }, async () => {
        const { client, close } = await connectInProcess(createServer, { clientName: "claude-code" });
        try {
          const token = parseBody(await client.callTool({ name: "rks_governor_init", arguments: { projectId: FIXTURE_PROJECT_ID } }))?.token ?? null;
          expect(token).toBeTruthy();
          minted.push(token);
          expect(sessionFilesMentioning(fixture.root, [token]).length).toBeGreaterThan(0);
          await client.callTool({ name: "rks_governor_end", arguments: { projectId: FIXTURE_PROJECT_ID, _governorToken: token } });
          expect(sessionFilesMentioning(fixture.root, [token])).toEqual([]);
        } finally {
          await close();
        }
      });
    } finally {
      fixture.cleanup();
    }
    expect(repoLeaks(minted)).toEqual([]);
  }, MATRIX_TIMEOUT_MS);

  it("the rks_agent_research self-bootstrap session is discovered while live and ended after replay", async () => {
    const { cases } = loadCorpus();
    const c = cases.find((x) => x.id === SELF_BOOTSTRAP_ANOMALY_CASE);
    expect(c).toBeTruthy();
    const seen = [];
    const got = await replayOnFreshFixture(c, {
      clientName: "claude-code", createServer, minted, agentCallCount, onBoot, sessionAudit: sessionAudits,
      onSessionsDiscovered: ({ tokens, root }) => {
        for (const t of tokens) seen.push({ t, liveFiles: sessionFilesMentioning(root, [t]).length, liveValid: Boolean(validateToken(t)), listed: governorSessionTokens(root).includes(t) });
      },
      onSessionsEnded: ({ tokens, root }) => {
        for (const t of tokens) {
          const e = seen.find((x) => x.t === t);
          e.afterFiles = sessionFilesMentioning(root, [t]);
          e.afterValid = Boolean(validateToken(t));
        }
      },
    });
    expect(decisionOf(got)).toEqual(c.expected);
    // Positive control: the discovery finds the server-minted session while it is live.
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) {
      expect(e.liveFiles, e.t).toBeGreaterThan(0);
      expect(e.liveValid, e.t).toBe(true);
      expect(e.listed, e.t).toBe(true);
      // Ended after replay, and covered by the AC13 every-minted-session-ended check.
      expect(e.afterFiles, e.t).toEqual([]);
      expect(e.afterValid, e.t).toBe(false);
      expect(minted, e.t).toContain(e.t);
    }
    expect(minted.filter((t) => validateToken(t))).toEqual([]);
    // Hardening AC 5: this replay's own fixture audit, taken before cleanup, covers the discovered token
    // and finds no live session file.
    const audit = sessionAudits.findLast((a) => a.id === c.id);
    expect(audit).toBeTruthy();
    for (const e of seen) expect(audit.tokens, e.t).toContain(e.t);
    expect(liveMintedSessions([audit])).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("no in-process or stdio boot observes a sentinel value of a scrubbed or fixture env var", async () => {
    const { cases } = loadCorpus();
    const keys = [...OBSERVED_ENV];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const sentinel = Object.fromEntries(keys.map((k) => [k, `admission-conformance-sentinel-${k}`]));
    const bootsBefore = bootLog.length;
    try {
      Object.assign(process.env, sentinel);
      for (const c of cases.filter((x) => x.ideBaseline).slice(0, 3)) await replayIn(c);
      const stdioCase = cases.find((x) => x.stdio && x.lane === "ide");
      expect(stdioCase).toBeTruthy();
      await replayOnFreshFixture(stdioCase, { clientName: "claude-code", transport: "stdio", minted, onBoot, sessionAudit: sessionAudits });
      for (const k of keys) expect(process.env[k], k).toBe(sentinel[k]);
    } finally {
      for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
    }
    const boots = bootLog.slice(bootsBefore);
    expect(boots.some((b) => b.transport === "in-process")).toBe(true);
    expect(boots.some((b) => b.transport === "stdio")).toBe(true);
    const leaked = [];
    for (const b of boots) {
      expect(Object.keys(b.env ?? {}).sort(), b.transport).toEqual([...keys].sort());
      for (const k of keys) if (b.env[k] === sentinel[k]) leaked.push(`${b.transport} ${b.root}: ${k}`);
      // Non-evidential consistency check (hardening AC 6): b.root and b.env.ROUTEKIT_PROJECT_ROOT come from
      // the same source (process.env in the createServer wrapper, the same onBoot argument for stdio), so
      // this cannot fail and proves nothing about the env. The envSeen positive control is the next test.
      expect(b.env.ROUTEKIT_PROJECT_ROOT, b.transport).toBe(b.root);
      expect(b.env.ROUTEKIT_PROJECT_ID, b.transport).toBe(FIXTURE_PROJECT_ID);
    }
    expect(leaked).toEqual([]);
    // Every boot the suite has observed so far records the env it saw.
    for (const b of bootLog) expect(b.env, b.root).toBeTruthy();
  }, MATRIX_TIMEOUT_MS);

  it("the boot env record captures a known non-sentinel case env value (envSeen)", async () => {
    // Hardening AC 6: envSeen records only OBSERVED_ENV keys, so the control sets a known value under one
    // (RKS_ACTOR, a SCRUBBED_ENV key) in the case env, while every OBSERVED_ENV key holds a sentinel in the
    // test process. Each boot record must show the case value, not the sentinel and not null.
    const KEY = "RKS_ACTOR";
    const VALUE = "admission-conformance-envseen-actor";
    expect(OBSERVED_ENV).toContain(KEY);
    expect(SCRUBBED_ENV).toContain(KEY);
    const { cases } = loadCorpus();
    const inProcCase = cases.find((x) => x.ideBaseline && !x.sideEffect && x.lane === "ide" && !x.env);
    const stdioCase = cases.find((x) => x.stdio && x.lane === "ide" && x.token === "absent" && !x.sideEffect);
    expect(inProcCase).toBeTruthy();
    expect(stdioCase).toBeTruthy();
    const withActor = (c) => ({ ...c, env: { ...(c.env ?? {}), [KEY]: VALUE } });
    const keys = [...OBSERVED_ENV];
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const sentinel = Object.fromEntries(keys.map((k) => [k, `admission-conformance-sentinel-${k}`]));
    const bootsBefore = bootLog.length;
    try {
      Object.assign(process.env, sentinel);
      await replayIn(inProcCase);
      await replayIn(withActor(inProcCase));
      await replayOnFreshFixture(withActor(stdioCase), { clientName: "claude-code", transport: "stdio", minted, onBoot, sessionAudit: sessionAudits });
    } finally {
      for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
    }
    const [plainBoot, ...boots] = bootLog.slice(bootsBefore);
    // Negative control: the same case without the case value records null (scrubbed), not the sentinel.
    expect(plainBoot?.transport).toBe("in-process");
    expect(plainBoot.env[KEY]).toBeNull();
    for (const transport of ["in-process", "stdio"]) {
      const b = boots.find((x) => x.transport === transport);
      expect(b, transport).toBeTruthy();
      expect(b.env[KEY], transport).toBe(VALUE);
      expect(b.env[KEY], transport).not.toBe(sentinel[KEY]);
      // The case lane is case env too: RKS_VIA (a SCRUBBED_ENV key) shows the case's lane.
      expect(b.env.RKS_VIA, transport).toBe("ide");
    }
  }, STDIO_TIMEOUT_MS);
});

// QA accepted (AC 14).
describe("AC14 side effects", () => {
  it("every sideEffect allow case records a handler refusal", () => {
    const { cases } = loadCorpus();
    expect(cases.some((c) => c.sideEffect && c.expected.effect === "allow")).toBe(true);
    const unrefused = cases.filter((c) => c.sideEffect && c.expected.effect === "allow" && c.expected.handlerReason === null).map((c) => c.id);
    expect(unrefused, `sideEffect allow cases with no handler refusal: ${unrefused.join(", ")}`).toEqual([]);
    for (const c of cases) expect(c.sideEffect, c.id).toBe(SIDE_EFFECT_TOOLS.has(c.tool));
  }, CASE_TIMEOUT_MS);

  it("every listed tool is in exactly one of the side-effecting and read-only sets", async () => {
    const listed = await listToolNames();
    expect(listed.length).toBeGreaterThan(0);
    const neither = listed.filter((t) => !SIDE_EFFECT_TOOLS.has(t) && !READ_ONLY_TOOLS.has(t));
    const both = listed.filter((t) => SIDE_EFFECT_TOOLS.has(t) && READ_ONLY_TOOLS.has(t));
    expect(neither, `in neither set: ${neither.join(", ")}`).toEqual([]);
    expect(both, `in both sets: ${both.join(", ")}`).toEqual([]);
    // No stale entries: every hand-written member is a listed tool.
    const stale = [...SIDE_EFFECT_TOOLS, ...READ_ONLY_TOOLS].filter((t) => !listed.includes(t));
    expect(stale).toEqual([]);
    // The dendron write tools are side-effecting, and so is every other listed dendron write tool.
    for (const t of ["dendron_create_note", "dendron_edit_note", "dendron_update_field", "dendron_update_fields", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_rename_note"]) {
      expect(listed, t).toContain(t);
      expect(SIDE_EFFECT_TOOLS.has(t), t).toBe(true);
    }
    const DENDRON_READ = new Set(["dendron_read_note", "dendron_validate_schema"]);
    for (const t of listed.filter((x) => x.startsWith("dendron_") && !DENDRON_READ.has(x))) expect(SIDE_EFFECT_TOOLS.has(t), t).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("every corpus sideEffect flag agrees with the hand-written partition", () => {
    const { cases } = loadCorpus();
    const disagree = cases.filter((c) => c.sideEffect !== SIDE_EFFECT_TOOLS.has(c.tool) || c.sideEffect === READ_ONLY_TOOLS.has(c.tool)).map((c) => `${c.id}: ${c.sideEffect}`);
    expect(disagree).toEqual([]);
    expect(cases.some((c) => c.sideEffect)).toBe(true);
    expect(cases.some((c) => !c.sideEffect)).toBe(true);
  }, CASE_TIMEOUT_MS);
});
