/**
 * S9a agent/bootstrap handler family - unit tier (backlog.feat.server-mjs-agent-bootstrap-handler-family).
 * Pattern: tests/unit/server-handler-planner.test.mjs. Unit tier: no unguarded spawn-family call,
 * no server.mjs import, no module-registry reset. Every entry point the six bodies reach is a vi.fn
 * keyed on its resolved module file, so a lazy body that reaches its mock proves the re-pathed specifier.
 * No quoted telemetry-package specifier appears in this file (telemetry-global-mock-triage).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const h = vi.hoisted(() => {
  // rag.mjs is imported for the coexistence check; keep @routekit/rag on its stub embedder.
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
  return {
    runInitTool: vi.fn(), runProjectInit: vi.fn(), runExternalResearch: vi.fn(), runOnboarder: vi.fn(),
    loadContext: vi.fn(), hasGitRepo: vi.fn(), getCurrentBranch: vi.fn(), assertCleanWorkingTree: vi.fn(),
    runAgent: vi.fn(), getAgent: vi.fn(), listAgents: vi.fn(), parseAgentInput: vi.fn(),
  };
});

vi.mock("../../packages/mcp-rks/src/server/init.mjs", async (io) => ({ ...(await io()), runInitTool: h.runInitTool }));
vi.mock("../../packages/mcp-rks/src/project-init.mjs", async (io) => ({ ...(await io()), runProjectInit: h.runProjectInit }));
vi.mock("../../packages/mcp-rks/src/agents/external-research.mjs", async (io) => ({ ...(await io()), runExternalResearch: h.runExternalResearch }));
vi.mock("../../packages/mcp-rks/src/server/onboarder.mjs", async (io) => ({ ...(await io()), runOnboarder: h.runOnboarder }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (io) => ({ ...(await io()), loadContext: h.loadContext }));
vi.mock("../../packages/mcp-rks/src/server/exec.mjs", async (io) => ({ ...(await io()), hasGitRepo: h.hasGitRepo, getCurrentBranch: h.getCurrentBranch, assertCleanWorkingTree: h.assertCleanWorkingTree }));
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (io) => ({ ...(await io()), runAgent: h.runAgent }));
vi.mock("../../packages/mcp-rks/src/agents/registry.mjs", async (io) => ({ ...(await io()), getAgent: h.getAgent, listAgents: h.listAgents, parseAgentInput: h.parseAgentInput }));

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerAgentBootstrapHandlers } from "../../packages/mcp-rks/src/server/handlers/agent-bootstrap.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { registerRagHandlers } from "../../packages/mcp-rks/src/server/handlers/rag.mjs";
import { registerGitHandlers } from "../../packages/mcp-rks/src/server/handlers/git.mjs";
import { registerShipHandlers } from "../../packages/mcp-rks/src/server/handlers/ship.mjs";
import { registerPlannerHandlers } from "../../packages/mcp-rks/src/server/handlers/planner.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AB_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers/agent-bootstrap.mjs");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const SELF_ABS = fileURLToPath(import.meta.url);

const AGENT_BOOTSTRAP_TOOLS = ["rks_init", "rks_project_init", "rks_agent_external_research", "rks_onboarder", "rks_interview", "rks_agent_run"];
const SCHEMA_KEY = { rks_init: "rksInitSchema", rks_project_init: "projectInitSchema", rks_onboarder: "onboarderSchema", rks_interview: "interviewSchema" };
const LAZY_EXPECTED = ["../init.mjs", "../../agents/external-research.mjs"];

// The other seven S0 families (tests/unit/server-handler-planner.test.mjs).
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_update_field", "dendron_validate_schema"];
const RAG_TOOLS = ["rks_exhaustive_search", "rks_fetch_raw", "rks_memory_save", "rks_rag_compact", "rks_rag_embed", "rks_rag_init", "rks_rag_query"];
const GIT_TOOLS = ["rks_branch_repair", "rks_checkout", "rks_cherry_pick", "rks_git_branch", "rks_git_commit", "rks_git_preflight", "rks_git_push", "rks_reset", "rks_resolve_conflict", "rks_restore", "rks_revert", "rks_stash", "rks_tag"];
const SHIP_TOOLS = ["rks_cycle_complete", "rks_git_merge", "rks_promote", "rks_release", "rks_ship", "rks_staging_merge", "rks_staging_pr", "rks_story_ship", "rks_sync_staging"];
const PLANNER_TOOLS = [
  "rks_analyze", "rks_plan", "rks_plan_review", "rks_preflight", "rks_validate_story", "rks_plan_ready",
  "rks_exec", "rks_exec_abort", "rks_apply", "rks_approve", "rks_refine", "rks_refine_apply", "rks_ready",
  "rks_review", "rks_story_create", "rks_guardrails_simulate",
];
const GIT_SCHEMA_KEYS = ["stashSchema", "restoreSchema", "resetSchema", "revertSchema", "tagSchema", "cherryPickSchema", "gitBranchSchema", "checkoutSchema", "branchRepairSchema", "gitCommitSchema", "gitPushSchema"];
const SHIP_SCHEMA_KEYS = ["cycleCompleteSchema", "promoteSchema", "shipSchema", "stagingPrSchema", "gitMergeSchema", "stagingMergeSchema"];
const PLANNER_SCHEMA_KEYS = ["analyzeSchema", "planSchema", "planReviewSchema", "validateStorySchema", "planReadySchema", "execSchema", "applySchema", "guardrailSimSchema", "refineSchema", "refineApplySchema"];

// Expected bytes: committed literals captured by the builder from the PRE-MOVE build-base server.mjs.
// Capture sha: 67523a45ad4bf2ea551eda26f3b1fec3f6b6719b (git show <sha>:packages/mcp-rks/src/server.mjs).
// Sources at that sha: server.mjs:2666 (DEPRECATION_WARNING) and :2623-2624 (instructions), pasted
// verbatim. Never read from agent-bootstrap.mjs and never computed from the code under test.
const DEPRECATION_WARNING_AT_BASE = "⚠️ `rks_interview` is deprecated and will be removed in v0.21.0. Use `/rks-onboard` instead. Forwarding you to the new onboarding experience now.\n\n";
const INSTRUCTIONS_AT_BASE = (root) => [
  "Use rks_templates_list to discover stack ids before init.",
  `Run npm install inside ${root} once scaffolding completes.`,
];

const PROJECT_ID = "s9a-agent-bootstrap-unit";
const ROOT = "/s9a/fixture-root";
const ctxFor = (args) => Object.freeze({ tool: "s9a-ctx-tool", args, activeToken: "s9a-active", governorToken: "s9a-token" });
const payload = (res) => JSON.parse(res.content[0].text);
const passSchemas = () => Object.fromEntries(Object.values(SCHEMA_KEY).map((k) => [k, z.object({}).passthrough()]));
function abRegistry(schemas = passSchemas()) {
  const r = createHandlerRegistry();
  registerAgentBootstrapHandlers(r, schemas);
  return { r, call: (tool, args) => r.lookupHandler(tool)(args, ctxFor(args)) };
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
  h.loadContext.mockImplementation(async (projectId) => ({ record: { id: projectId, root: ROOT }, projectJson: {} }));
  h.listAgents.mockReturnValue(["alpha", "beta"]);
});

describe("S9a agent/bootstrap handlers (unit)", () => {
  it("AB-TR1 registers exactly the six agent/bootstrap tools", () => {
    const { r } = abRegistry();
    expect(AGENT_BOOTSTRAP_TOOLS).toHaveLength(6);
    expect(r.registeredTools()).toEqual([...AGENT_BOOTSTRAP_TOOLS].sort());
    for (const tool of AGENT_BOOTSTRAP_TOOLS) expect(typeof r.lookupHandler(tool), tool).toBe("function");
  });

  it("AB-TR2 coexists with the other seven families at 70 tools", () => {
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
      registerPlannerHandlers(r, Object.fromEntries(PLANNER_SCHEMA_KEYS.map((k) => [k, z.object({ projectId: z.string() }).passthrough()])), {
        pendingPlans: new Map(),
        getPollHintMs: vi.fn(() => 4321),
        getPendingPlanPath: vi.fn((root) => path.join(root, ".rks", "pending-plan.json")),
        writePendingPlanMarker: vi.fn(),
        isProcessAlive: vi.fn(() => false),
        readPendingPlanMarker: vi.fn(() => null),
        removePendingPlanMarker: vi.fn(),
      });
      registerAgentBootstrapHandlers(r, passSchemas());
    }).not.toThrow();
    const all = [...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS, ...GIT_TOOLS, ...SHIP_TOOLS, ...PLANNER_TOOLS, ...AGENT_BOOTSTRAP_TOOLS];
    expect(new Set(all).size).toBe(70);
    expect(r.registeredTools()).toEqual([...all].sort());
    expect(r.registeredTools()).toHaveLength(70);
  });

  it("AB-TR3 parses with the injected schema before any entry point", async () => {
    for (const [tool, key] of Object.entries(SCHEMA_KEY)) {
      const sentinel = new ZodError([{ code: "custom", path: [`__s9a_${key}`], message: `s9a sentinel ${key}` }]);
      const parse = vi.fn(() => { throw sentinel; });
      const { call } = abRegistry({ ...passSchemas(), [key]: { parse } });
      const args = { projectId: PROJECT_ID, projectName: "s9a-proj", id: "s9a-new", stack: "base", path: "/s9a/target" };
      const err = await call(tool, args).catch((e) => e);
      expect(err, tool).toBe(sentinel);
      expect(parse, tool).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0][0], tool).toBe(args);
    }
    expect(Object.keys(SCHEMA_KEY)).toHaveLength(4);
    for (const name of ["runInitTool", "runProjectInit", "runOnboarder", "loadContext", "hasGitRepo", "getCurrentBranch", "assertCleanWorkingTree"]) {
      expect(h[name], name).not.toHaveBeenCalled();
    }
  });

  it("AB-TR4 rks_init projection, onboarder gating and nextStep fallback", async () => {
    const { call } = abRegistry();
    const NEW_PATH = "/s9a/returned-by-runInitTool/s9a-proj";
    const onboarded = { ok: true, stage: "welcome", display: "s9a onboarder" };

    // Defaults applied when omitted; success with a path triggers the onboarder at that path.
    h.runInitTool.mockResolvedValueOnce({ success: true, path: NEW_PATH });
    h.runOnboarder.mockResolvedValueOnce(onboarded);
    const ok = payload(await call("rks_init", { projectName: "s9a-proj" }));
    expect(h.runInitTool).toHaveBeenCalledTimes(1);
    expect(h.runInitTool.mock.calls[0][0]).toStrictEqual({ projectName: "s9a-proj", parentDir: "..", dev: false, branchModel: "3-branch" });
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(h.runOnboarder.mock.calls[0][0]).toStrictEqual({ projectId: "s9a-proj", projectRoot: NEW_PATH, stage: "welcome" });
    expect(NEW_PATH).not.toBe(path.resolve("..", "s9a-proj"));
    expect(ok).toEqual({ success: true, path: NEW_PATH, onboarder: onboarded });

    // Supplied values pass through unchanged.
    h.runInitTool.mockResolvedValueOnce({ success: false, error: "s9a init failed" });
    const failed = payload(await call("rks_init", { projectName: "s9a-two", parentDir: "/s9a/parent", dev: true, branchModel: "2-branch" }));
    expect(h.runInitTool.mock.calls[1][0]).toStrictEqual({ projectName: "s9a-two", parentDir: "/s9a/parent", dev: true, branchModel: "2-branch" });
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(failed).toEqual({ success: false, error: "s9a init failed" });
    expect(failed).not.toHaveProperty("onboarder");
    expect(failed).not.toHaveProperty("nextStep");

    // success true but no path: no onboarder either.
    h.runInitTool.mockResolvedValueOnce({ success: true });
    const noPath = payload(await call("rks_init", { projectName: "s9a-three" }));
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(noPath).toEqual({ success: true });

    // runOnboarder throws: nextStep fallback, no onboarder.
    h.runInitTool.mockResolvedValueOnce({ success: true, path: NEW_PATH });
    h.runOnboarder.mockRejectedValueOnce(new Error("s9a onboarder boom"));
    const thrown = payload(await call("rks_init", { projectName: "s9a-proj" }));
    expect(h.runOnboarder).toHaveBeenCalledTimes(2);
    expect(thrown.nextStep).toEqual({ command: "/rks-onboard", reason: "first-run" });
    expect(thrown).not.toHaveProperty("onboarder");
  });

  it("AB-TR5 rks_project_init branch gate, register-without-apply and payload", async () => {
    const { call } = abRegistry();
    const args = { projectId: PROJECT_ID, id: "s9a-new", stack: "app.web.react.spa", path: "/s9a/target" };

    // Off the default base branch (staging, baseBranch absent).
    h.hasGitRepo.mockReturnValue(true);
    h.getCurrentBranch.mockReturnValue("feature/s9a");
    let err = await call("rks_project_init", args).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain(`rks.project_init: expected to run from base branch "staging" but you're on "feature/s9a".`);
    expect(h.assertCleanWorkingTree.mock.calls).toEqual([[ROOT, { toolName: "rks_project_init" }]]);
    expect(h.loadContext.mock.calls).toEqual([[PROJECT_ID]]);
    expect(h.runProjectInit).not.toHaveBeenCalled();

    // Off a declared baseBranch, including when the branch is staging.
    h.loadContext.mockImplementation(async (projectId) => ({ record: { id: projectId, root: ROOT }, projectJson: { baseBranch: "develop" } }));
    h.getCurrentBranch.mockReturnValue("staging");
    err = await call("rks_project_init", args).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidRequest);
    expect(err.message).toContain(`rks.project_init: expected to run from base branch "develop" but you're on "staging".`);
    expect(h.runProjectInit).not.toHaveBeenCalled();

    // register without apply.
    h.getCurrentBranch.mockReturnValue("develop");
    err = await call("rks_project_init", { ...args, register: true }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain("rks.project_init: apply must be true when register is requested.");
    expect(h.runProjectInit).not.toHaveBeenCalled();

    // No git repo: neither branch helper is called.
    h.hasGitRepo.mockReturnValue(false);
    h.assertCleanWorkingTree.mockClear();
    h.getCurrentBranch.mockClear();
    const NEW_ROOT = "/s9a/scaffolded-root";
    const initResult = { applied: true, project: { id: "s9a-new", root: NEW_ROOT }, registryRecord: { id: "s9a-new" }, message: "s9a scaffolded" };
    h.runProjectInit.mockResolvedValueOnce(initResult);
    const p = payload(await call("rks_project_init", { ...args, apply: "yes", register: 0 }));
    expect(h.assertCleanWorkingTree).not.toHaveBeenCalled();
    expect(h.getCurrentBranch).not.toHaveBeenCalled();
    expect(h.runProjectInit).toHaveBeenCalledTimes(1);
    expect(h.runProjectInit.mock.calls[0][0]).toStrictEqual({
      shellRoot: ROOT, id: "s9a-new", stackId: "app.web.react.spa", targetPath: "/s9a/target", apply: true, register: false,
    });
    expect(p).toStrictEqual({
      ok: true,
      applied: true,
      project: { id: "s9a-new", root: NEW_ROOT },
      registryRecord: { id: "s9a-new" },
      message: "s9a scaffolded",
      instructions: INSTRUCTIONS_AT_BASE(NEW_ROOT),
    });
  });

  it("AB-TR6 rks_agent_external_research passes cleanArgs through the re-pathed lazy import", async () => {
    const { call } = abRegistry();
    const result = { ok: true, findings: ["s9a"] };
    h.runExternalResearch.mockResolvedValueOnce(result);
    const args = { projectId: PROJECT_ID, query: "s9a external" };
    const p = payload(await call("rks_agent_external_research", args));
    expect(h.runExternalResearch).toHaveBeenCalledTimes(1);
    const passed = h.runExternalResearch.mock.calls[0][0];
    expect(passed).toStrictEqual(args);
    expect(passed).not.toBe(args);
    expect(p).toEqual(result);
  });

  it("AB-TR7 rks_onboarder projects flags with defaults", async () => {
    const { call } = abRegistry();
    h.runOnboarder.mockResolvedValue({ ok: true, via: "runOnboarder" });
    expect(payload(await call("rks_onboarder", { projectId: PROJECT_ID }))).toEqual({ ok: true, via: "runOnboarder" });
    expect(h.loadContext.mock.calls).toEqual([[PROJECT_ID]]);
    expect(h.runOnboarder.mock.calls[0][0]).toStrictEqual({
      projectId: PROJECT_ID, projectRoot: ROOT, stage: undefined, responses: {},
      skipTour: false, skipStage: false, bounce: false, resume: false, reset: false,
    });

    const responses = { one_liner: "s9a" };
    await call("rks_onboarder", { projectId: PROJECT_ID, stage: "stance", responses, skipTour: true, skipStage: true, bounce: true, resume: true, reset: true });
    expect(h.runOnboarder).toHaveBeenCalledTimes(2);
    expect(h.runOnboarder.mock.calls[1][0]).toStrictEqual({
      projectId: PROJECT_ID, projectRoot: ROOT, stage: "stance", responses,
      skipTour: true, skipStage: true, bounce: true, resume: true, reset: true,
    });
    expect(h.runOnboarder.mock.calls[1][0].responses).toBe(responses);
  });

  it("AB-TR8 rks_interview forwards to the onboarder with the build-base warning", async () => {
    const { call } = abRegistry();
    h.runOnboarder.mockResolvedValueOnce({ ok: true, stage: "welcome", display: "s9a display" });
    const p = payload(await call("rks_interview", { projectId: PROJECT_ID }));
    expect(h.loadContext.mock.calls).toEqual([[PROJECT_ID]]);
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(h.runOnboarder.mock.calls[0][0]).toStrictEqual({ projectId: PROJECT_ID, projectRoot: ROOT, stage: "welcome" });
    expect(p).toEqual({ ok: true, stage: "welcome", display: DEPRECATION_WARNING_AT_BASE + "s9a display" });

    h.runOnboarder.mockResolvedValueOnce({ ok: true, stage: "welcome" });
    const bare = payload(await call("rks_interview", { projectId: PROJECT_ID }));
    expect(bare).toEqual({ ok: true, stage: "welcome", display: DEPRECATION_WARNING_AT_BASE });
    expect(DEPRECATION_WARNING_AT_BASE.length).toBeGreaterThan(0);
  });

  it("AB-TR9 rks_agent_run unknown agent, invalid input and valid run", async () => {
    const { call } = abRegistry();
    // Unknown agent.
    h.getAgent.mockReturnValue(null);
    const unknown = payload(await call("rks_agent_run", { agent: "s9a-nope", input: { projectId: PROJECT_ID } }));
    expect(unknown).toEqual({ ok: false, error: "Unknown agent: s9a-nope. Available: alpha, beta" });
    expect(h.getAgent.mock.calls).toEqual([["s9a-nope"]]);
    for (const name of ["parseAgentInput", "loadContext", "runAgent"]) expect(h[name], name).not.toHaveBeenCalled();

    // Invalid input.
    const factory = vi.fn(() => ({ s9a: "config" }));
    h.getAgent.mockReturnValue(factory);
    const inputError = { ok: false, error: "s9a unknown key", unknownKeys: ["bogus"] };
    h.parseAgentInput.mockReturnValueOnce({ ok: false, error: inputError });
    const agentInput = { projectId: PROJECT_ID, bogus: 1 };
    const invalid = payload(await call("rks_agent_run", { agent: "alpha", input: agentInput }));
    expect(invalid).toEqual(inputError);
    expect(h.parseAgentInput.mock.calls).toEqual([["alpha", agentInput]]);
    expect(h.loadContext).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();

    // Valid run.
    const data = { projectId: "s9a-parsed-project", extra: "kept" };
    h.parseAgentInput.mockReturnValueOnce({ ok: true, data });
    const result = { ok: true, ran: "alpha" };
    h.runAgent.mockResolvedValueOnce(result);
    const ran = payload(await call("rks_agent_run", { agent: "alpha", input: { projectId: "raw" } }));
    expect(h.loadContext.mock.calls).toEqual([["s9a-parsed-project"]]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toStrictEqual({ projectId: "s9a-parsed-project", extra: "kept", projectRoot: ROOT });
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.runAgent.mock.calls[0][0]).toBe(factory.mock.results[0].value);
    expect(ran).toEqual(result);
  });

  it("AB-TR10 static imports resolve to server.mjs's files and real exports; exactly two lazy imports", async () => {
    const src = fs.readFileSync(AB_ABS, "utf8");
    const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");
    const keyOf = (spec, fromAbs) => (isRelative(spec) ? path.resolve(path.dirname(fromAbs), spec) : spec);
    const serverNames = new Map();
    for (const b of importBindings(serverSrc)) {
      const key = keyOf(b.spec, SERVER_ABS);
      serverNames.set(key, [...(serverNames.get(key) || []), ...b.names]);
    }
    const own = importBindings(src);
    expect(own.length).toBe(importSpecifiers(src).length);
    const bound = own.flatMap((b) => b.names).sort();
    expect(bound).toEqual([
      "ErrorCode", "McpError", "assertCleanWorkingTree", "getAgent", "getCurrentBranch", "hasGitRepo",
      "listAgents", "loadContext", "parseAgentInput", "runAgent", "runOnboarder", "runProjectInit",
    ]);
    for (const b of own) {
      const key = keyOf(b.spec, AB_ABS);
      if (isRelative(b.spec)) expect(fs.existsSync(key), b.spec).toBe(true);
      expect(serverNames.has(key), `server.mjs statically imports ${b.spec}`).toBe(true);
      for (const n of b.names) expect(serverNames.get(key), `${b.spec} ${n}`).toContain(n);
      const real = await vi.importActual(key);
      for (const n of b.names) expect(real[n], `${b.spec} exports ${n}`).toBeDefined();
    }

    const lazy = [...src.matchAll(/await import\(\s*(["'])([^"']+)\1\s*\)/g)].map((m) => m[2]);
    expect(src.split("await import(").length - 1).toBe(2);
    expect(lazy).toEqual(LAZY_EXPECTED);
    const lazyExports = { "../init.mjs": "runInitTool", "../../agents/external-research.mjs": "runExternalResearch" };
    for (const spec of LAZY_EXPECTED) {
      const abs = path.resolve(path.dirname(AB_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      const real = await vi.importActual(abs);
      expect(typeof real[lazyExports[spec]], `${spec} ${lazyExports[spec]}`).toBe("function");
    }
  });

  it("AB-TR11 agent-bootstrap.mjs shape: one function, no server.mjs, no telemetry, no ctx, no chain-state calls", () => {
    const src = fs.readFileSync(AB_ABS, "utf8");
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src).not.toMatch(/import\(\s*["'][^"']*server\.mjs["']/);
    expect(src).not.toMatch(/@routekit\/telemetry/);
    expect(src.match(/\bfunction\s+[\w$]+\s*\(/g)).toEqual(["function registerAgentBootstrapHandlers("]);
    // Over code only: the module docblock's prose ("No body reads ctx.") is not a property access.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("registerHandler(");
    expect(code).not.toMatch(/\bctx\s*\??\.\s*[A-Za-z_$]/);
    expect(code).not.toMatch(/\bctx\s*\[/);
    for (const call of ["advanceStateOnResult(", "revertStateOnFailure(", "setChildQueue("]) expect(src).not.toContain(call);
    // The first argument of every registerHandler( call, verbatim: six double-quoted literals in head order.
    const registrations = [...src.matchAll(/registerHandler\(\s*([^,\s)]+)/g)].map((m) => m[1]);
    expect(registrations).toEqual(AGENT_BOOTSTRAP_TOOLS.map((t) => JSON.stringify(t)));
  });

  it("AB-TR12 unit-tier purity of this file", () => {
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
    // telemetry-global-mock-triage SPECIFIER_LITERAL (:89): no quoted or backticked telemetry specifier.
    expect(src).not.toMatch(new RegExp("(['\"\\x60])@routekit" + "\\/telemetry(?:\\/[A-Za-z0-9._-]+)*\\1"));
  });
});
