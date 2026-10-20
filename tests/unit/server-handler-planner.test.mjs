/**
 * S8 planner/exec handler family - unit tier (backlog.feat.server-mjs-planner-exec-handler-family).
 * Pattern: tests/unit/server-handler-ship.test.mjs. Unit tier: no unguarded spawn-family call,
 * no server.mjs import, no module-registry reset. createServer, real sessions and real git live in
 * tests/integration/server-handler-planner.test.mjs.
 *
 * Every entry point the sixteen bodies reach is a vi.fn keyed on its resolved module file, so a
 * lazy body that reaches its mock proves the re-pathed specifier. child_process.spawn is a vi.fn
 * (importOriginal spread), so no plan worker starts. loadContext is a vi.fn resolving to a fresh
 * os.tmpdir() root. The pending-plan helpers arrive as spies through the third argument.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const h = vi.hoisted(() => {
  // rag.mjs is imported for the coexistence check; keep @routekit/rag on its stub embedder.
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
  return {
    runAnalyzeTool: vi.fn(), runPlanTool: vi.fn(), runExecTool: vi.fn(), runApplyTool: vi.fn(),
    runExecAbortTool: vi.fn(), runRefineTool: vi.fn(), runRefineApplyTool: vi.fn(),
    runRksReadyTool: vi.fn(), runPlanReadyTool: vi.fn(), validateStory: vi.fn(),
    approve: vi.fn(), runReview: vi.fn(), simulateGuardrailPolicy: vi.fn(), loadContext: vi.fn(),
    spawn: vi.fn(), validateToken: vi.fn(), advanceStateOnResult: vi.fn(), getSession: vi.fn(),
    setChildQueue: vi.fn(), emit: vi.fn(),
  };
});

// Keyed on the resolved files. Each factory spreads importOriginal so only the named entry
// points are replaced.
vi.mock("../../packages/mcp-rks/src/server/planner.mjs", async (io) => ({ ...(await io()), runAnalyzeTool: h.runAnalyzeTool, runPlanTool: h.runPlanTool }));
vi.mock("../../packages/mcp-rks/src/server/exec.mjs", async (io) => ({ ...(await io()), runExecTool: h.runExecTool, runApplyTool: h.runApplyTool, runExecAbortTool: h.runExecAbortTool }));
vi.mock("../../packages/mcp-rks/src/server/refine.mjs", async (io) => ({ ...(await io()), runRefineTool: h.runRefineTool, runRefineApplyTool: h.runRefineApplyTool, runRksReadyTool: h.runRksReadyTool }));
vi.mock("../../packages/mcp-rks/src/server/plan-ready.mjs", async (io) => ({ ...(await io()), runPlanReadyTool: h.runPlanReadyTool }));
vi.mock("../../packages/mcp-rks/src/server/story-validator-v2.mjs", async (io) => ({ ...(await io()), validateStory: h.validateStory }));
vi.mock("../../packages/mcp-rks/src/server/approve.mjs", async (io) => ({ ...(await io()), approve: h.approve }));
vi.mock("../../packages/mcp-rks/src/server/review.mjs", async (io) => ({ ...(await io()), runReview: h.runReview }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (io) => ({ ...(await io()), loadContext: h.loadContext, simulateGuardrailPolicy: h.simulateGuardrailPolicy }));
vi.mock("../../packages/mcp-rks/src/shared/governor-token.mjs", async (io) => ({ ...(await io()), validateToken: h.validateToken, advanceStateOnResult: h.advanceStateOnResult, getSession: h.getSession, setChildQueue: h.setChildQueue }));
vi.mock("child_process", async (io) => ({ ...(await io()), spawn: h.spawn }));
vi.mock("@routekit/telemetry/collector", async (io) => ({ ...(await io()), getTelemetryCollector: () => ({ emit: h.emit }) }));

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerPlannerHandlers } from "../../packages/mcp-rks/src/server/handlers/planner.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { registerRagHandlers } from "../../packages/mcp-rks/src/server/handlers/rag.mjs";
import { registerGitHandlers } from "../../packages/mcp-rks/src/server/handlers/git.mjs";
import { registerShipHandlers } from "../../packages/mcp-rks/src/server/handlers/ship.mjs";
import { isPlanReadyReadOnly } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLANNER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers/planner.mjs");
const WORKER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/bin/plan-worker.mjs");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const SELF_ABS = fileURLToPath(import.meta.url);

// The S0 FAMILIES.planner table (tests/integration/mcp-surface-characterization.test.mjs).
const PLANNER_TOOLS = [
  "rks_analyze", "rks_plan", "rks_plan_review", "rks_preflight", "rks_validate_story", "rks_plan_ready",
  "rks_exec", "rks_exec_abort", "rks_apply", "rks_approve", "rks_refine", "rks_refine_apply", "rks_ready",
  "rks_review", "rks_story_create", "rks_guardrails_simulate",
];
const SCHEMA_KEY = {
  rks_analyze: "analyzeSchema",
  rks_plan: "planSchema",
  rks_plan_review: "planReviewSchema",
  rks_validate_story: "validateStorySchema",
  rks_plan_ready: "planReadySchema",
  rks_exec: "execSchema",
  rks_apply: "applySchema",
  rks_guardrails_simulate: "guardrailSimSchema",
  rks_refine: "refineSchema",
  rks_refine_apply: "refineApplySchema",
};
const ENTRY = [
  "runAnalyzeTool", "runPlanTool", "runExecTool", "runApplyTool", "runExecAbortTool", "runRefineTool",
  "runRefineApplyTool", "runRksReadyTool", "runPlanReadyTool", "validateStory", "approve", "runReview",
  "simulateGuardrailPolicy",
];
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_channel_preview", "rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_update_field", "dendron_validate_schema"];
const RAG_TOOLS = ["rks_exhaustive_search", "rks_fetch_raw", "rks_memory_save", "rks_rag_compact", "rks_rag_embed", "rks_rag_init", "rks_rag_query"];
const GIT_TOOLS = ["rks_branch_repair", "rks_checkout", "rks_cherry_pick", "rks_git_branch", "rks_git_commit", "rks_git_preflight", "rks_git_push", "rks_reset", "rks_resolve_conflict", "rks_restore", "rks_revert", "rks_stash", "rks_tag"];
const SHIP_TOOLS = ["rks_cycle_complete", "rks_git_merge", "rks_promote", "rks_release", "rks_ship", "rks_staging_merge", "rks_staging_pr", "rks_story_ship", "rks_sync_staging"];
const GIT_SCHEMA_KEYS = ["stashSchema", "restoreSchema", "resetSchema", "revertSchema", "tagSchema", "cherryPickSchema", "gitBranchSchema", "checkoutSchema", "branchRepairSchema", "gitCommitSchema", "gitPushSchema"];
const SHIP_SCHEMA_KEYS = ["cycleCompleteSchema", "promoteSchema", "shipSchema", "stagingPrSchema", "gitMergeSchema", "stagingMergeSchema"];

const PROJECT_ID = "s8-planner-handler-unit";
const TOKEN = "s8-request-governor-token";
const ACTIVE = "s8-active-token-is-not-the-request-token";
const CTX_TOOL = "s8-ctx-tool-sentinel";
const STORY = "backlog.s8-unit-story";

// projectId required, every other key reaches the body unchanged: projection assertions test
// the moved body, not a transcription of the server.mjs schema consts.
const passSchemas = () =>
  Object.fromEntries(Object.values(SCHEMA_KEY).map((key) => [key, z.object({ projectId: z.string() }).passthrough()]));

let FIX;
const saved = {};
const ENV_KEYS = ["RKS_SKIP_LLM", "RKS_SKIP_PREFLIGHT", "RKS_SKIP_READINESS"];

function makeHelpers(overrides = {}) {
  return {
    pendingPlans: new Map(),
    getPollHintMs: vi.fn(() => 4321),
    getPendingPlanPath: vi.fn((root) => path.join(root, ".rks", "pending-plan.json")),
    writePendingPlanMarker: vi.fn(),
    isProcessAlive: vi.fn(() => false),
    readPendingPlanMarker: vi.fn(() => null),
    removePendingPlanMarker: vi.fn(),
    ...overrides,
  };
}
const ctxFor = (args, governorToken, tool) => Object.freeze({ tool, args, activeToken: ACTIVE, governorToken });
const payload = (res) => JSON.parse(res.content[0].text);
function plannerRegistry({ schemas = passSchemas(), helpers = makeHelpers() } = {}) {
  const r = createHandlerRegistry();
  registerPlannerHandlers(r, schemas, helpers);
  return {
    r,
    helpers,
    call: (tool, args, governorToken, ctxTool = tool, ctxArgs = args) =>
      r.lookupHandler(tool)(args, ctxFor(ctxArgs, governorToken, ctxTool)),
  };
}
const importSpecifiers = (src) => [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
const isRelative = (s) => s.startsWith(".");
// Every `import <default> from "x"` / `import { a, b } from "x"` statement (multi-line braces allowed).
function importBindings(src) {
  const out = [];
  for (const m of src.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*from\s*["']([^"']+)["'];/gm)) {
    const names = m[1] ? ["default"] : m[2].split(",").map((s) => s.trim()).filter(Boolean);
    out.push({ spec: m[3], names, local: m[1] ?? null });
  }
  return out;
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  for (const name of ENTRY) h[name].mockImplementation(async () => ({ ok: true, via: name }));
  h.simulateGuardrailPolicy.mockImplementation(() => ({ via: "simulateGuardrailPolicy" }));
  h.validateToken.mockReturnValue(true);
  FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s8-planner-unit-")));
  h.loadContext.mockImplementation(async (projectId) => ({ record: { id: projectId, root: FIX }, projectJson: {} }));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(FIX, { recursive: true, force: true });
});

describe("S8 planner handler family (unit)", () => {
  it("PL-TR1 registers exactly the sixteen FAMILIES.planner tools", () => {
    const { r } = plannerRegistry();
    expect(PLANNER_TOOLS).toHaveLength(16);
    expect(r.registeredTools()).toEqual([...PLANNER_TOOLS].sort());
    for (const tool of PLANNER_TOOLS) expect(typeof r.lookupHandler(tool), tool).toBe("function");
  });

  it("PL-TR2 coexists with the other six families at 64 tools", () => {
    const r = createHandlerRegistry();
    const pid = z.object({ projectId: z.string() });
    const any = z.object({});
    expect(() => {
      registerTelemetryHandlers(r, { telemetryQuerySchema: pid, telemetryReportSchema: pid, telemetryAnalysisSchema: pid, tokenCostReportSchema: pid, telemetryExportSchema: pid });
      registerProjectMetaHandlers(r, { projectGetSchema: z.object({ id: z.string() }), kgQuerySchema: pid, templatesListSchema: any, gitStateSchema: pid, publishSchema: pid, publishProfilesSchema: pid });
      registerDendronHandlers(
        r,
        { createNoteSchema: any, fixFrontmatterSchema: any, validateSchemaSchema: any, editNoteSchema: any, updateFieldSchema: any, markImplementedSchema: any },
        { getDendronContext: vi.fn(), assertNotesDir: vi.fn(), notePathFromFilename: vi.fn(), commitDendronWriteResult: vi.fn() },
      );
      registerRagHandlers(
        r,
        { ragInitSchema: pid, ragEmbedSchema: pid, ragQuerySchema: pid, ragCompactSchema: pid, memorySaveSchema: pid, fetchRawSchema: pid },
        { getDendronContext: vi.fn() },
      );
      registerGitHandlers(r, Object.fromEntries(GIT_SCHEMA_KEYS.map((k) => [k, pid])));
      registerShipHandlers(r, Object.fromEntries(SHIP_SCHEMA_KEYS.map((k) => [k, pid])));
      registerPlannerHandlers(r, passSchemas(), makeHelpers());
    }).not.toThrow();
    const all = [...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS, ...GIT_TOOLS, ...SHIP_TOOLS, ...PLANNER_TOOLS];
    expect(new Set(all).size).toBe(65);
    expect(r.registeredTools()).toEqual([...all].sort());
    expect(r.registeredTools()).toHaveLength(65);
  });

  it("PL-TR3 parses with the injected schema before any entry point", async () => {
    const helpers = makeHelpers();
    for (const [tool, key] of Object.entries(SCHEMA_KEY)) {
      const sentinel = new ZodError([{ code: "custom", path: [`__s8_${key}`], message: `s8 sentinel ${key}` }]);
      const parse = vi.fn(() => { throw sentinel; });
      const schemas = { ...passSchemas(), [key]: { parse } };
      const { call } = plannerRegistry({ schemas, helpers });
      const args = { projectId: PROJECT_ID, problemId: STORY };
      const err = await call(tool, args, TOKEN).catch((e) => e);
      expect(err, tool).toBe(sentinel);
      expect(parse, tool).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0][0], tool).toBe(args);
    }
    expect(Object.keys(SCHEMA_KEY)).toHaveLength(10);
    for (const name of [...ENTRY, "loadContext", "spawn", "advanceStateOnResult", "getSession", "setChildQueue"]) {
      expect(h[name], name).not.toHaveBeenCalled();
    }
    for (const spy of Object.values(helpers)) if (typeof spy === "function") expect(spy).not.toHaveBeenCalled();
  });

  it("PL-TR4 rks_plan sync path projection and plan.ok/plan.failed", async () => {
    process.env.RKS_SKIP_LLM = "1";
    try {
      const { call } = plannerRegistry();
      // maxRefinements omitted -> 2; no problemId, so the readiness gate and the git commit are skipped.
      h.runPlanTool.mockImplementationOnce(async () => ({ ok: true, via: "runPlanTool" }));
      h.advanceStateOnResult.mockReturnValueOnce({ transitioned: true, previousState: "planning", newState: "planned" });
      const ok = payload(await call("rks_plan", { projectId: PROJECT_ID, task: "s8 task" }, TOKEN, CTX_TOOL));
      expect(h.runPlanTool).toHaveBeenCalledTimes(1);
      expect(h.runPlanTool.mock.calls[0][0]).toStrictEqual({ projectId: PROJECT_ID, task: "s8 task", maxRefinements: 2 });
      expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, "plan.ok"]]);
      expect(ok).toEqual({ ok: true, via: "runPlanTool", _governorState: { from: "planning", to: "planned" } });
      // tool for telemetry comes from handlerCtx.tool.
      expect(h.emit.mock.calls).toEqual([
        ["governor.state.transition", PROJECT_ID, { tool: CTX_TOOL, resultKey: "plan.ok", from: "planning", to: "planned", trigger: "tool_result" }],
      ]);

      // numeric maxRefinements passes through; ok false -> plan.failed.
      h.runPlanTool.mockImplementationOnce(async () => ({ ok: false, error: "s8" }));
      h.advanceStateOnResult.mockReturnValueOnce({ transitioned: false });
      expect(payload(await call("rks_plan", { projectId: PROJECT_ID, task: "s8 task", maxRefinements: 5 }, TOKEN))).toEqual({ ok: false, error: "s8" });
      expect(h.runPlanTool.mock.calls[1][0].maxRefinements).toBe(5);
      expect(h.advanceStateOnResult.mock.calls[1]).toEqual([TOKEN, "plan.failed"]);
      expect(h.validateToken).toHaveBeenCalledWith(TOKEN);

      // No token -> no chain state.
      h.validateToken.mockClear();
      h.advanceStateOnResult.mockClear();
      await call("rks_plan", { projectId: PROJECT_ID, task: "s8 task" }, undefined);
      expect(h.runPlanTool).toHaveBeenCalledTimes(3);
      expect(h.validateToken).not.toHaveBeenCalled();
      expect(h.advanceStateOnResult).not.toHaveBeenCalled();
      expect(h.spawn).not.toHaveBeenCalled();
    } finally {
      delete process.env.RKS_SKIP_LLM;
    }
  });

  it("PL-TR5 rks_plan not_ready short-circuit", async () => {
    delete process.env.RKS_SKIP_READINESS;
    const issues = [{ code: "s8_issue", message: "not ready" }];
    h.runPlanReadyTool.mockImplementation(async () => ({ ready: false, issues, warnings: [] }));
    const { call } = plannerRegistry();
    const p = payload(await call("rks_plan", { projectId: PROJECT_ID, problemId: STORY }, TOKEN));
    expect(p.ok).toBe(false);
    expect(p.status).toBe("not_ready");
    expect(p.issues).toEqual(issues);
    expect(p.problemId).toBe(STORY);
    expect(h.runPlanReadyTool).toHaveBeenCalledTimes(1);
    expect(h.runPlanReadyTool.mock.calls[0][0]).toStrictEqual({ projectId: PROJECT_ID, problemId: STORY, projectRoot: FIX });
    expect(h.runPlanTool).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
  });

  it("PL-TR6 rks_plan async path spawns the re-based worker through injected helpers", async () => {
    delete process.env.RKS_SKIP_LLM;
    delete process.env.RKS_SKIP_PREFLIGHT;
    expect(process.env.RKS_SKIP_LLM).toBeUndefined();
    expect(process.env.RKS_SKIP_PREFLIGHT).toBeUndefined();
    const child = { pid: 424242, on: vi.fn(), unref: vi.fn() };
    h.spawn.mockReturnValue(child);
    const markerPath = path.join(FIX, ".rks", "pending-plan.json");
    const helpers = makeHelpers();
    const { call } = plannerRegistry({ helpers });
    const p = payload(await call("rks_plan", { projectId: PROJECT_ID, task: "s8 async" }, undefined));
    expect(p).toMatchObject({ ok: true, status: "planning", workerPid: 424242, projectId: PROJECT_ID, problemId: null });

    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = h.spawn.mock.calls[0];
    expect(cmd).toBe("node");
    expect(argv[0]).toBe(WORKER_ABS);
    expect(fs.existsSync(argv[0])).toBe(true);
    expect(path.dirname(argv[1])).toBe(path.join(FIX, ".rks"));
    expect(JSON.parse(fs.readFileSync(argv[1], "utf8"))._markerPath).toBe(markerPath);
    expect(opts.env.ROUTEKIT_PROJECT_ROOT).toBe(FIX);
    expect(opts.cwd).toBe(FIX);
    expect(opts.detached).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);

    expect(helpers.getPendingPlanPath.mock.calls).toEqual([[FIX]]);
    expect(helpers.writePendingPlanMarker).toHaveBeenCalledTimes(1);
    expect(helpers.writePendingPlanMarker.mock.calls[0][0]).toBe(FIX);
    expect(helpers.writePendingPlanMarker.mock.calls[0][1]).toMatchObject({ projectId: PROJECT_ID, pid: 424242, planKey: `${PROJECT_ID}:s8 async` });
    expect(h.runPlanTool).not.toHaveBeenCalled();
  });

  it("PL-TR7 rks_plan_review uses only the injected helpers", async () => {
    const now = Date.now();
    // done-failed
    {
      const marker = { planKey: `${PROJECT_ID}:x`, projectId: PROJECT_ID, startedAt: now, done: true, ok: false, error: "s8-worker-failed", pid: 111 };
      const helpers = makeHelpers({ readPendingPlanMarker: vi.fn(() => marker) });
      const { call } = plannerRegistry({ helpers });
      const p = payload(await call("rks_plan_review", { projectId: PROJECT_ID }, undefined));
      expect(p).toMatchObject({ ok: false, error: "s8-worker-failed" });
      expect(helpers.readPendingPlanMarker.mock.calls).toEqual([[FIX]]);
      expect(helpers.removePendingPlanMarker.mock.calls).toEqual([[FIX]]);
      expect(helpers.isProcessAlive).not.toHaveBeenCalled();
    }
    // alive
    {
      const marker = { planKey: `${PROJECT_ID}:x`, projectId: PROJECT_ID, startedAt: now - 45_000, pid: 777 };
      const helpers = makeHelpers({ readPendingPlanMarker: vi.fn(() => marker), isProcessAlive: vi.fn(() => true) });
      const { call } = plannerRegistry({ helpers });
      const p = payload(await call("rks_plan_review", { projectId: PROJECT_ID }, undefined));
      expect(p).toMatchObject({ ok: true, status: "planning", workerPid: 777, recommendedNextPollMs: 4321 });
      expect(helpers.isProcessAlive.mock.calls).toEqual([[777]]);
      expect(helpers.getPollHintMs).toHaveBeenCalledTimes(1);
      expect(helpers.getPollHintMs.mock.calls[0][0]).toBe(p.elapsedSeconds);
      expect(helpers.removePendingPlanMarker).not.toHaveBeenCalled();
    }
    // orphaned (dead pid, no run dir in the tmp root)
    {
      const marker = { planKey: `${PROJECT_ID}:x`, projectId: PROJECT_ID, startedAt: now, pid: 888 };
      const helpers = makeHelpers({ readPendingPlanMarker: vi.fn(() => marker), isProcessAlive: vi.fn(() => false) });
      const { call } = plannerRegistry({ helpers });
      const p = payload(await call("rks_plan_review", { projectId: PROJECT_ID }, undefined));
      expect(p).toMatchObject({ ok: false, status: "failed", orphanedPlan: true });
      expect(helpers.isProcessAlive.mock.calls).toEqual([[888]]);
      expect(helpers.removePendingPlanMarker.mock.calls).toEqual([[FIX]]);
    }
    // the injected pendingPlans Map is the one iterated (its done/error entry is reported and deleted)
    {
      const pendingPlans = new Map([[`${PROJECT_ID}:s8`, { done: true, error: "s8-in-memory-error", startedAt: now }]]);
      const helpers = makeHelpers({ pendingPlans });
      const { call } = plannerRegistry({ helpers });
      const p = payload(await call("rks_plan_review", { projectId: PROJECT_ID }, undefined));
      expect(p).toEqual({ ok: false, status: "failed", error: "s8-in-memory-error", message: "Plan generation failed" });
      expect(pendingPlans.size).toBe(0);
      expect(helpers.readPendingPlanMarker).not.toHaveBeenCalled();
    }
  });

  it("PL-TR8 rks_plan_review plan.failed only on a valid token", async () => {
    const now = Date.now();
    const markers = {
      "done-failed": { planKey: `${PROJECT_ID}:x`, projectId: PROJECT_ID, startedAt: now, done: true, ok: false, pid: 1 },
      orphaned: { planKey: `${PROJECT_ID}:x`, projectId: PROJECT_ID, startedAt: now, pid: 2 },
    };
    for (const [label, marker] of Object.entries(markers)) {
      const helpers = makeHelpers({ readPendingPlanMarker: vi.fn(() => marker), isProcessAlive: vi.fn(() => false) });
      const { call } = plannerRegistry({ helpers });
      h.advanceStateOnResult.mockClear();
      h.validateToken.mockReset();
      h.validateToken.mockReturnValue(true);
      await call("rks_plan_review", { projectId: PROJECT_ID }, TOKEN);
      expect(h.advanceStateOnResult.mock.calls, label).toEqual([[TOKEN, "plan.failed"]]);
      expect(h.validateToken, label).toHaveBeenCalledWith(TOKEN);

      h.advanceStateOnResult.mockClear();
      h.validateToken.mockClear();
      await call("rks_plan_review", { projectId: PROJECT_ID }, undefined);
      expect(h.validateToken, label).not.toHaveBeenCalled();
      h.validateToken.mockReturnValue(false);
      await call("rks_plan_review", { projectId: PROJECT_ID }, TOKEN);
      expect(h.validateToken, label).toHaveBeenCalledWith(TOKEN);
      expect(h.advanceStateOnResult, label).not.toHaveBeenCalled();
    }
  });

  it("PL-TR9 rks_plan_ready readOnly by flow type", async () => {
    const { call } = plannerRegistry();
    const sessions = { story: { flowType: "story", state: "refining" }, open: { flowType: "open", state: "writing" } };
    for (const [flow, session] of Object.entries(sessions)) {
      h.getSession.mockReset();
      h.getSession.mockReturnValue(session);
      h.runPlanReadyTool.mockClear();
      expect(payload(await call("rks_plan_ready", { projectId: PROJECT_ID, problemId: STORY }, TOKEN))).toEqual({ ok: true, via: "runPlanReadyTool" });
      expect(h.getSession.mock.calls, flow).toEqual([[TOKEN]]);
      expect(h.runPlanReadyTool.mock.calls[0][0], flow).toStrictEqual({ projectId: PROJECT_ID, problemId: STORY, projectRoot: FIX, readOnly: isPlanReadyReadOnly(session) });
    }
    expect(isPlanReadyReadOnly(sessions.story)).toBe(false);
    expect(isPlanReadyReadOnly(sessions.open)).toBe(true);
  });

  it("PL-TR10 rks_exec result-key mapping and dryRun no-advance", async () => {
    const { call } = plannerRegistry();
    h.advanceStateOnResult.mockReturnValue({ transitioned: true, previousState: "executing", newState: "s8-next" });
    h.runExecTool.mockImplementationOnce(async () => ({ ok: true }));
    expect(payload(await call("rks_exec", { projectId: PROJECT_ID }, TOKEN, "rks_exec"))).toEqual({ ok: true, _governorState: { from: "executing", to: "s8-next" } });
    h.runExecTool.mockImplementationOnce(async () => ({ ok: false }));
    await call("rks_exec", { projectId: PROJECT_ID }, TOKEN, "rks_exec");
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, "exec.ok"], [TOKEN, "exec.failed"]]);
    expect(h.emit.mock.calls.map((c) => c[2].tool)).toEqual(["rks_exec", "rks_exec"]);

    h.advanceStateOnResult.mockClear();
    const noteStep = new McpError(ErrorCode.InvalidParams, "plan contains a note step; s8");
    h.runExecTool.mockImplementationOnce(async () => { throw noteStep; });
    await expect(call("rks_exec", { projectId: PROJECT_ID }, TOKEN, "rks_exec")).rejects.toBe(noteStep);
    const other = new Error("s8 boom");
    h.runExecTool.mockImplementationOnce(async () => { throw other; });
    await expect(call("rks_exec", { projectId: PROJECT_ID }, TOKEN, "rks_exec")).rejects.toBe(other);
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, "exec.no_actions"], [TOKEN, "exec.error"]]);

    h.advanceStateOnResult.mockClear();
    h.runExecTool.mockImplementationOnce(async () => ({ ok: true, dryRun: true }));
    expect(payload(await call("rks_exec", { projectId: PROJECT_ID, dryRun: true }, TOKEN, "rks_exec"))).toEqual({ ok: true, dryRun: true });
    expect(h.advanceStateOnResult).toHaveBeenCalledTimes(0);

    h.validateToken.mockClear();
    h.runExecTool.mockImplementationOnce(async () => ({ ok: true }));
    await call("rks_exec", { projectId: PROJECT_ID }, undefined, "rks_exec");
    h.runExecTool.mockImplementationOnce(async () => { throw new Error("s8 untokened"); });
    await expect(call("rks_exec", { projectId: PROJECT_ID }, undefined, "rks_exec")).rejects.toThrow("s8 untokened");
    expect(h.validateToken).not.toHaveBeenCalled();
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
  });

  it("PL-TR11 rks_refine_apply decomposed, inapplicable and noop keys", async () => {
    const { call } = plannerRegistry();
    const args = { projectId: PROJECT_ID, problemId: STORY, refinements: [] };
    const children = [{ childId: "backlog.s8-c1" }, { childId: "backlog.s8-c2" }];
    h.advanceStateOnResult.mockReturnValue({ transitioned: true, previousState: "refining", newState: "decomposing", effectiveResultKey: "refine_apply.decomposed" });
    h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, decomposed: true, children }));
    await call("rks_refine_apply", args, TOKEN, CTX_TOOL);
    expect(h.runRefineApplyTool.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, ...args });
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, "refine_apply.decomposed"]]);
    expect(h.setChildQueue.mock.calls).toEqual([[TOKEN, children]]);

    for (const [status, key] of [["refine_inapplicable", "refine_apply.inapplicable"], ["refine_noop", "refine_apply.noop"]]) {
      h.advanceStateOnResult.mockReset();
      h.advanceStateOnResult.mockReturnValue({ transitioned: false, previousState: "refining", newState: "refining", effectiveResultKey: key });
      h.runRefineApplyTool.mockImplementationOnce(async () => ({ ok: true, status }));
      const p = payload(await call("rks_refine_apply", args, TOKEN, CTX_TOOL));
      expect(h.advanceStateOnResult.mock.calls, status).toEqual([[TOKEN, key]]);
      expect(p._governorState).toEqual({ from: "refining", to: "refining", transitioned: false, resultKey: key });
    }
    expect(h.setChildQueue).toHaveBeenCalledTimes(1);

    h.advanceStateOnResult.mockReset();
    h.setChildQueue.mockClear();
    h.validateToken.mockClear();
    for (const res of [{ decomposed: true, children }, { status: "refine_noop" }, { status: "refine_inapplicable" }]) {
      h.runRefineApplyTool.mockImplementationOnce(async () => ({ ...res }));
      await call("rks_refine_apply", args, undefined, CTX_TOOL);
    }
    expect(h.validateToken).not.toHaveBeenCalled();
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
    expect(h.setChildQueue).not.toHaveBeenCalled();
  });

  it("PL-TR12 rks_approve reads ctx.args", async () => {
    const { call } = plannerRegistry();
    const ctxArgs = { projectId: PROJECT_ID, planId: "s8-plan", confirm: true, reason: "s8 reason" };
    expect(payload(await call("rks_approve", {}, undefined, "rks_approve", ctxArgs))).toEqual({ ok: true, via: "approve" });
    expect(h.loadContext.mock.calls).toEqual([[PROJECT_ID]]);
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.approve.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, planId: "s8-plan", confirm: true, reason: "s8 reason" });

    // planId absent from both cleanArgs and ctx.args: the unchanged validation failure (message text only).
    const err = await call("rks_approve", { projectId: PROJECT_ID }, undefined, "rks_approve", { projectId: PROJECT_ID, confirm: true }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain("rks_approve: required params projectId, planId, confirm");
    expect(h.approve).toHaveBeenCalledTimes(1);
  });

  it("PL-TR13 rks_ready and rks_review projection", async () => {
    const { call } = plannerRegistry();
    expect(payload(await call("rks_ready", { projectId: PROJECT_ID, problemId: STORY, stray: "dropped" }))).toEqual({ ok: true, via: "runRksReadyTool" });
    expect(h.runRksReadyTool.mock.calls).toEqual([[{ projectRoot: FIX, problemId: STORY, projectId: PROJECT_ID }]]);

    expect(payload(await call("rks_review", { projectId: PROJECT_ID, problemId: STORY }))).toEqual({ ok: true, via: "runReview" });
    await call("rks_review", { projectId: PROJECT_ID, targetBranch: "develop" });
    expect(h.runReview.mock.calls).toEqual([
      [{ projectId: PROJECT_ID, problemId: STORY, targetBranch: "staging" }],
      [{ projectId: PROJECT_ID, problemId: undefined, targetBranch: "develop" }],
    ]);
  });

  it("PL-TR14 simple entry-point projections", async () => {
    const cases = [
      ["rks_analyze", "runAnalyzeTool", { projectId: PROJECT_ID }, { projectId: PROJECT_ID }],
      ["rks_validate_story", "validateStory", { projectId: PROJECT_ID, problemId: STORY }, { projectId: PROJECT_ID, problemId: STORY, projectRoot: FIX }],
      ["rks_exec_abort", "runExecAbortTool", { projectId: PROJECT_ID, reason: "s8" }, { projectId: PROJECT_ID, reason: "s8" }],
      ["rks_apply", "runApplyTool", { projectId: PROJECT_ID, label: "s8" }, { projectId: PROJECT_ID, label: "s8" }],
      ["rks_refine", "runRefineTool", { projectId: PROJECT_ID, problemId: STORY, trigger: "design" }, { projectRoot: FIX, projectId: PROJECT_ID, problemId: STORY, trigger: "design" }],
    ];
    for (const [tool, fn, args, expected] of cases) {
      for (const name of ENTRY) h[name].mockClear();
      const { call } = plannerRegistry();
      expect(payload(await call(tool, args)), tool).toEqual({ ok: true, via: fn });
      expect(h[fn], tool).toHaveBeenCalledTimes(1);
      expect(h[fn].mock.calls[0][0], tool).toStrictEqual(expected);
      for (const other of ENTRY) if (other !== fn) expect(h[other], `${tool} -> ${other}`).not.toHaveBeenCalled();
    }

    for (const name of ENTRY) h[name].mockClear();
    const { call } = plannerRegistry();
    expect(payload(await call("rks_guardrails_simulate", { projectId: PROJECT_ID, label: "s8" }))).toEqual({ via: "simulateGuardrailPolicy" });
    await call("rks_guardrails_simulate", { projectId: PROJECT_ID });
    expect(h.simulateGuardrailPolicy.mock.calls).toEqual([[FIX, "s8"], [FIX, ""]]);
    for (const other of ENTRY) if (other !== "simulateGuardrailPolicy") expect(h[other], other).not.toHaveBeenCalled();
  });

  it("PL-TR15 static and lazy specifiers resolve; bound names are real exports", async () => {
    const src = fs.readFileSync(PLANNER_ABS, "utf8");
    const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");
    const keyOf = (spec, fromAbs) => (isRelative(spec) ? path.resolve(path.dirname(fromAbs), spec) : spec);
    const serverNames = new Map();
    for (const b of importBindings(serverSrc)) {
      const key = keyOf(b.spec, SERVER_ABS);
      serverNames.set(key, [...(serverNames.get(key) || []), ...b.names]);
    }
    const own = importBindings(src);
    expect(own.length).toBe(importSpecifiers(src).length);
    expect(own.length).toBeGreaterThan(0);
    for (const b of own) {
      const key = keyOf(b.spec, PLANNER_ABS);
      if (isRelative(b.spec)) expect(fs.existsSync(key), b.spec).toBe(true);
      expect(serverNames.has(key), `server.mjs statically imports ${b.spec}`).toBe(true);
      for (const n of b.names) expect(serverNames.get(key), `${b.spec} ${n}`).toContain(n);
      const real = await vi.importActual(key);
      for (const n of b.names) expect(real[n], `${b.spec} exports ${n}`).toBeDefined();
    }

    const lazy = [...src.matchAll(/await import\(\s*(["'])([^"']+)\1\s*\)/g)].map((m) => m[2]);
    expect(src.split("await import(").length - 1).toBe(4);
    const EXPECTED_LAZY = ["../approve.mjs", "../../shared/governor-token.mjs", "../refine.mjs", "../review.mjs"];
    expect(lazy).toEqual(EXPECTED_LAZY);
    const lazyExports = { "../approve.mjs": "approve", "../../shared/governor-token.mjs": "setChildQueue", "../refine.mjs": "runRksReadyTool", "../review.mjs": "runReview" };
    for (const spec of EXPECTED_LAZY) {
      const abs = path.resolve(path.dirname(PLANNER_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      const real = await vi.importActual(abs);
      expect(typeof real[lazyExports[spec]], `${spec} ${lazyExports[spec]}`).toBe("function");
    }

    // Literal-specifier escape, as SH-TR24: the mocked name must exist on the real collector.
    const realCollector = await vi.importActual("@routekit/telemetry/collector");
    expect(typeof realCollector.getTelemetryCollector).toBe("function");
  });

  it("PL-TR16 no server.mjs import, one function, worker path exists", () => {
    const src = fs.readFileSync(PLANNER_ABS, "utf8");
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src).not.toMatch(/import\(\s*["'][^"']*server\.mjs["']/);
    expect(src.match(/\bfunction\s+[\w$]+\s*\(/g)).toEqual(["function registerPlannerHandlers("]);
    const rebased = path.join(path.dirname(PLANNER_ABS), "..", "..", "..", "bin", "plan-worker.mjs");
    expect(rebased).toBe(WORKER_ABS);
    expect(fs.existsSync(rebased)).toBe(true);
    // The pre-move join, evaluated from the new module depth, would not exist.
    expect(fs.existsSync(path.join(path.dirname(PLANNER_ABS), "..", "bin", "plan-worker.mjs"))).toBe(false);
  });

  it("PL-TR17 unit tier purity", () => {
    const src = fs.readFileSync(SELF_ABS, "utf8");
    // Same spawn-family grammar as tests/unit/unit-tier-purity.test.mjs (Rule A), over code with
    // line comments and string literals removed.
    const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|exec|fork)\s*\(/;
    const code = src
      .split("\n")
      .map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, '""'))
      .map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    expect(code.filter((l) => SPAWN_FAMILY_RE.test(l))).toEqual([]);
    expect(src).not.toContain("vi." + "resetModules");
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src).not.toMatch(/import\(\s*["'][^"']*\/server\.mjs["']/);
  });
});
