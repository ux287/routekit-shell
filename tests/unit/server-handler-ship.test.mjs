/**
 * S7 ship/workflow family handlers (backlog.feat.server-mjs-ship-handler-family), part of
 * research.2026.10.05.server-mjs-safe-decomposition (SH-TR1..SH-TR25). Mirrors
 * tests/unit/server-handler-git.test.mjs. Unit tier: no subprocess, no server.mjs import,
 * no vi.resetModules. Every entry point the nine bodies reach (server/git-tools.mjs and
 * server/story-ship.mjs) is a vi.fn; the five chain-state helpers of shared/governor-token.mjs
 * and the telemetry collector's emit are vi.fn spies. No git, no gh, no network, no session.
 * Real-session and remote-less real-git evidence: tests/integration/server-handler-ship.test.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";

const h = vi.hoisted(() => {
  // rag.mjs is imported for the coexistence check; keep @routekit/rag on its stub embedder.
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
  return {
    runShip: vi.fn(),
    runGitPR: vi.fn(),
    runGitMerge: vi.fn(),
    runCycleComplete: vi.fn(),
    runPromote: vi.fn(),
    runSyncStaging: vi.fn(),
    runStagingMerge: vi.fn(),
    runRelease: vi.fn(),
    runStoryShipTool: vi.fn(),
    validateToken: vi.fn(),
    advanceStateOnResult: vi.fn(),
    getSession: vi.fn(),
    updateChildState: vi.fn(),
    advanceToNextChild: vi.fn(),
    emit: vi.fn(),
  };
});

// Keyed on the resolved files: the moved lazy imports are "../git-tools.mjs" and
// '../story-ship.mjs' relative to handlers/, so reaching these mocks from a lazy body proves
// the re-path.
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runShip: h.runShip,
  runGitPR: h.runGitPR,
  runGitMerge: h.runGitMerge,
  runCycleComplete: h.runCycleComplete,
  runPromote: h.runPromote,
  runSyncStaging: h.runSyncStaging,
  runStagingMerge: h.runStagingMerge,
  runRelease: h.runRelease,
}));
vi.mock("../../packages/mcp-rks/src/server/story-ship.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runStoryShipTool: h.runStoryShipTool,
}));
vi.mock("../../packages/mcp-rks/src/shared/governor-token.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  validateToken: h.validateToken,
  advanceStateOnResult: h.advanceStateOnResult,
  getSession: h.getSession,
  updateChildState: h.updateChildState,
  advanceToNextChild: h.advanceToNextChild,
}));
vi.mock("@routekit/telemetry/collector", async (importOriginal) => ({
  ...(await importOriginal()),
  getTelemetryCollector: () => ({ emit: h.emit }),
}));

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { registerRagHandlers } from "../../packages/mcp-rks/src/server/handlers/rag.mjs";
import { registerGitHandlers } from "../../packages/mcp-rks/src/server/handlers/git.mjs";
import { registerShipHandlers } from "../../packages/mcp-rks/src/server/handlers/ship.mjs";
import { getBranchConfig, loadContext } from "../../packages/mcp-rks/src/server/project.mjs";
import { readToolHandlerSource } from "../_helpers/server-source.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const HANDLERS_DIR = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers");
const SHIP_ABS = path.join(HANDLERS_DIR, "ship.mjs");

// server.mjs head order at the build base (Runs A-C).
const SOURCE_ORDER = [
  "rks_story_ship",
  "rks_cycle_complete",
  "rks_promote",
  "rks_ship",
  "rks_staging_pr",
  "rks_git_merge",
  "rks_sync_staging",
  "rks_staging_merge",
  "rks_release",
];
const SHIP_TOOLS = [...SOURCE_ORDER].sort();
// backlog.fix.ship-governor-2branch-pr-merge-wrong-tool-args: rks_staging_merge joins the readers (seven).
const TOKEN_READERS = ["rks_story_ship", "rks_cycle_complete", "rks_ship", "rks_staging_pr", "rks_git_merge", "rks_sync_staging", "rks_staging_merge"];
const TOOL_READERS = ["rks_story_ship", "rks_ship"];
const SCHEMA_KEY = {
  rks_cycle_complete: "cycleCompleteSchema",
  rks_promote: "promoteSchema",
  rks_ship: "shipSchema",
  rks_staging_pr: "stagingPrSchema",
  rks_git_merge: "gitMergeSchema",
  rks_staging_merge: "stagingMergeSchema",
};
const ENTRY = ["runShip", "runGitPR", "runGitMerge", "runCycleComplete", "runPromote", "runSyncStaging", "runStagingMerge", "runRelease", "runStoryShipTool"];
const LAZY = ["runCycleComplete", "runPromote", "runStoryShipTool"];
const CALLED = [
  "advanceStateOnResult", "advanceToNextChild", "getBranchConfig", "getSession", "getTelemetryCollector", "loadContext",
  "runCycleComplete", "runGitMerge", "runGitPR", "runPromote", "runRelease", "runShip", "runStagingMerge", "runStoryShipTool",
  "runSyncStaging", "updateChildState", "validateToken",
];
const GIT_SCHEMA_KEYS = ["stashSchema", "restoreSchema", "resetSchema", "revertSchema", "tagSchema", "cherryPickSchema", "gitBranchSchema", "checkoutSchema", "branchRepairSchema", "gitCommitSchema", "gitPushSchema"];
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_channel_preview", "rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_update_field", "dendron_validate_schema"];
const RAG_TOOLS = ["rks_exhaustive_search", "rks_fetch_raw", "rks_memory_save", "rks_rag_compact", "rks_rag_embed", "rks_rag_init", "rks_rag_query"];
const GIT_TOOLS = [
  "rks_stash", "rks_restore", "rks_reset", "rks_revert", "rks_tag", "rks_cherry_pick", "rks_git_branch",
  "rks_checkout", "rks_branch_repair", "rks_git_commit", "rks_git_push", "rks_git_preflight", "rks_resolve_conflict",
].sort();

const marker = (tool) => `__s7_marker_${tool}`;
const markerSchemas = () =>
  Object.fromEntries(Object.entries(SCHEMA_KEY).map(([tool, key]) => [key, z.object({ [marker(tool)]: z.string() })]));
// projectId required, every other key reaches the body unchanged: projection assertions test
// the moved body, not a transcription of the server.mjs schema consts.
const passSchemas = () =>
  Object.fromEntries(Object.values(SCHEMA_KEY).map((key) => [key, z.object({ projectId: z.string() }).passthrough()]));

const PROJECT_ID = "s7-ship-handler-fixture";
const TOKEN = "s7-request-governor-token";
const ACTIVE = "s7-active-token-is-not-the-request-token";
const CTX_TOOL = "s7-ctx-tool-sentinel";
const BASE = "s7-base";
const saved = {};
let FIX;
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  // A fresh object per call: rks_ship attaches _governorState / _childComplete to its result.
  for (const name of ENTRY) h[name].mockImplementation(async () => ({ ok: true, via: name }));
  h.validateToken.mockReturnValue(true);
  // Non-git temp project for loadContext only; nothing here runs git.
  FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s7-ship-unit-")));
  fs.mkdirSync(path.join(FIX, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(FIX, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(FIX, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: FIX, kgFile: "routekit/kg.yaml", baseBranch: BASE }));
  fs.writeFileSync(path.join(FIX, "routekit", "kg.yaml"), "project: fixture\n");
  saved.root = process.env.ROUTEKIT_PROJECT_ROOT;
  saved.id = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = FIX;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
});
afterEach(() => {
  if (saved.root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = saved.root;
  if (saved.id === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = saved.id;
  fs.rmSync(FIX, { recursive: true, force: true });
});

const ctxFor = (args, governorToken, tool) => Object.freeze({ tool, args, activeToken: ACTIVE, governorToken });
const payload = (res) => JSON.parse(res.content[0].text);
function shipRegistry(schemas = passSchemas()) {
  const r = createHandlerRegistry();
  registerShipHandlers(r, schemas);
  return {
    r,
    call: (tool, args, governorToken, ctxTool = tool) => r.lookupHandler(tool)(args, ctxFor(args, governorToken, ctxTool)),
  };
}
function countOccurrences(src, needle) {
  let n = 0;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) n++;
  return n;
}
const importSpecifiers = (src) => [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
const isRelative = (s) => s.startsWith(".");
const namedImports = (text, spec) => {
  const esc = spec.replace(/[.*+?^$()|[\]\\/{}]/g, "\\$&");
  const m = text.match(new RegExp("import\\s*\\{([^}]*)\\}\\s*from\\s*\"" + esc + "\""));
  expect(m, spec).not.toBeNull();
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("registerShipHandlers", () => {
  it("SH-TR1 registers exactly the nine ship tools, each a function", () => {
    const { r } = shipRegistry(markerSchemas());
    expect(r.registeredTools()).toEqual(SHIP_TOOLS);
    for (const tool of SHIP_TOOLS) expect(typeof r.lookupHandler(tool), tool).toBe("function");
  });

  it("SH-TR2 coexists with the telemetry, project/meta, dendron, RAG and git families (48 tools)", () => {
    const r = createHandlerRegistry();
    const pid = z.object({ projectId: z.string() });
    const any = z.object({});
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
    expect(() => registerShipHandlers(r, markerSchemas())).not.toThrow();
    expect(r.registeredTools()).toEqual([...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS, ...GIT_TOOLS, ...SHIP_TOOLS].sort());
    expect(r.registeredTools()).toHaveLength(49);
  });

  it.each(Object.keys(SCHEMA_KEY))("SH-TR3 %s rejects {} with a ZodError from its injected schema before any dependency runs", async (tool) => {
    const { call } = shipRegistry(markerSchemas());
    const err = await call(tool, {}, TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain(marker(tool));
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it("SH-TR4 the inline schemas of rks_story_ship, rks_sync_staging and rks_release stay inline and reject before any dependency", async () => {
    const { call } = shipRegistry();
    const cases = [
      ["rks_story_ship", {}, "projectId"],
      ["rks_sync_staging", { projectId: PROJECT_ID, strategy: "force" }, "strategy"],
      ["rks_release", { projectId: PROJECT_ID, version: "huge" }, "version"],
      ["rks_release", { projectId: PROJECT_ID, enforcementOverride: { enabled: false, reason: "r" } }, "enforcementOverride.enabled"],
      ["rks_release", { projectId: PROJECT_ID, enforcementOverride: { enabled: true, reason: "   " } }, "enforcementOverride.reason"],
    ];
    for (const [tool, args, issuePath] of cases) {
      const err = await call(tool, args, TOKEN).catch((e) => e);
      expect(err, tool).toBeInstanceOf(ZodError);
      expect(err.issues.map((i) => i.path.join(".")), `${tool} ${issuePath}`).toContain(issuePath);
    }
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it("SH-TR5 rks_story_ship reaches the mocked runStoryShipTool through the re-pathed lazy import with exactly projectId and problemId", async () => {
    h.runStoryShipTool.mockResolvedValue({ ok: false, error: "s7", steps: [] });
    const { call } = shipRegistry();
    const p = payload(await call("rks_story_ship", { projectId: PROJECT_ID, problemId: "backlog.s7", stray: "dropped" }));
    expect(p).toEqual({ ok: false, error: "s7", steps: [] });
    expect(h.runStoryShipTool).toHaveBeenCalledTimes(1);
    expect(h.runStoryShipTool.mock.calls[0][0]).toStrictEqual({ projectId: PROJECT_ID, problemId: "backlog.s7" });
    await call("rks_story_ship", { projectId: PROJECT_ID });
    expect(h.runStoryShipTool.mock.calls[1][0]).toStrictEqual({ projectId: PROJECT_ID, problemId: undefined });
  });

  it("SH-TR6 rks_cycle_complete passes discardLocalCommits true only for a literal true, via the re-pathed lazy git-tools import", async () => {
    const { call } = shipRegistry();
    for (const [given, expected] of [[undefined, false], [false, false], ["yes", false], [true, true]]) {
      h.runCycleComplete.mockClear();
      const args = given === undefined ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, discardLocalCommits: given };
      expect(payload(await call("rks_cycle_complete", args))).toEqual({ ok: true, via: "runCycleComplete" });
      expect(h.runCycleComplete).toHaveBeenCalledTimes(1);
      expect(h.runCycleComplete.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, projectId: PROJECT_ID, discardLocalCommits: expected });
    }
  });

  it("SH-TR7 rks_promote reaches the mocked runPromote through the re-pathed lazy git-tools import and projects only its keys", async () => {
    const { call } = shipRegistry();
    await call("rks_promote", { projectId: PROJECT_ID, from: "feature/s7", to: "develop", push: false, stray: "dropped" });
    expect(h.runPromote).toHaveBeenCalledTimes(1);
    expect(h.runPromote.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, projectId: PROJECT_ID, from: "feature/s7", to: "develop", push: false });
  });

  it("SH-TR8 rks_ship projects its input and sends stageAll only when files is omitted", async () => {
    const { call } = shipRegistry();
    const base = { projectId: PROJECT_ID, message: "m", scope: "s7", type: "fix", branchName: "b", branchType: "fix", prTitle: "t", problemId: "backlog.s7" };
    const expected = { projectRoot: FIX, projectId: PROJECT_ID, message: "m", scope: "s7", type: "fix", branchName: "b", branchType: "fix", prTitle: "t", problemId: "backlog.s7" };
    await call("rks_ship", { ...base, stray: "dropped" });
    expect(h.runShip.mock.calls[0][0]).toStrictEqual({ ...expected, files: undefined, stageAll: true });
    await call("rks_ship", { ...base, files: ["a.txt"] });
    expect(h.runShip.mock.calls[1][0]).toStrictEqual({ ...expected, files: ["a.txt"], stageAll: false });
  });

  it("SH-TR9 rks_staging_pr resolves targetBranch from getBranchConfig, spreads its input and forces autoMerge false", async () => {
    const { call } = shipRegistry();
    const context = await loadContext(PROJECT_ID);
    const integration = getBranchConfig(context.record, context.projectJson).integration;
    await call("rks_staging_pr", { projectId: PROJECT_ID, title: "t", problemId: "backlog.s7", autoMerge: true });
    expect(h.runGitPR.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, targetBranch: integration, projectId: PROJECT_ID, title: "t", problemId: "backlog.s7", autoMerge: false });
    await call("rks_staging_pr", { projectId: PROJECT_ID, targetBranch: "release/s7", reason: "hotfix" });
    expect(h.runGitPR.mock.calls[1][0]).toStrictEqual({ projectRoot: FIX, targetBranch: "release/s7", projectId: PROJECT_ID, reason: "hotfix", autoMerge: false });
  });

  it("SH-TR10 rks_git_merge resolves targetBranch as explicit, else projectJson.baseBranch, and passes deleteBranch", async () => {
    const { call } = shipRegistry();
    const context = await loadContext(PROJECT_ID);
    expect(context.projectJson?.baseBranch, "fixture precondition: project.json declares baseBranch").toBe(BASE);
    await call("rks_git_merge", { projectId: PROJECT_ID });
    expect(h.runGitMerge.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, targetBranch: BASE, deleteBranch: undefined });
    await call("rks_git_merge", { projectId: PROJECT_ID, targetBranch: "develop", deleteBranch: true });
    expect(h.runGitMerge.mock.calls[1][0]).toStrictEqual({ projectRoot: FIX, targetBranch: "develop", deleteBranch: true });
  });

  it("SH-TR11 rks_sync_staging locks on token PRESENCE: push-only forced, other strategies refused before any git call", async () => {
    const { call } = shipRegistry();
    const context = await loadContext(PROJECT_ID);
    await call("rks_sync_staging", { projectId: PROJECT_ID });
    expect(h.runSyncStaging.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, strategy: "auto", projectRecord: context.record, projectJson: context.projectJson });
    await call("rks_sync_staging", { projectId: PROJECT_ID, strategy: "rebase" });
    expect(h.runSyncStaging.mock.calls[1][0].strategy).toBe("rebase");
    // A present-but-invalid token must still lock: the body never consults validateToken.
    h.validateToken.mockReturnValue(false);
    await call("rks_sync_staging", { projectId: PROJECT_ID }, TOKEN);
    await call("rks_sync_staging", { projectId: PROJECT_ID, strategy: "push-only" }, TOKEN);
    expect(h.runSyncStaging.mock.calls.slice(2).map(([a]) => a.strategy)).toEqual(["push-only", "push-only"]);
    for (const strategy of ["rebase", "merge", "auto"]) {
      const p = payload(await call("rks_sync_staging", { projectId: PROJECT_ID, strategy }, TOKEN));
      expect(p).toEqual({
        ok: false,
        error: "strategy_not_allowed_under_governor",
        message: expect.stringContaining(`'${strategy}' was refused`),
        requestedStrategy: strategy,
        allowedStrategy: "push-only",
      });
    }
    expect(h.runSyncStaging).toHaveBeenCalledTimes(4);
    expect(h.validateToken).not.toHaveBeenCalled();
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
  });

  it("SH-TR12 rks_staging_merge projects its keys; rks_release defaults version and enforcementOverride", async () => {
    const { call } = shipRegistry();
    await call("rks_staging_merge", { projectId: PROJECT_ID, prNumber: 7, problemId: "backlog.s7", reason: "hotfix", stray: "dropped" });
    expect(h.runStagingMerge.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, prNumber: 7, problemId: "backlog.s7", reason: "hotfix" });
    const context = await loadContext(PROJECT_ID);
    const common = { projectRoot: FIX, projectId: PROJECT_ID, projectRecord: context.record, projectJson: context.projectJson };
    await call("rks_release", { projectId: PROJECT_ID });
    expect(h.runRelease.mock.calls[0][0]).toStrictEqual({ ...common, version: "patch", changelog: undefined, enforcementOverride: null });
    const override = { enabled: true, reason: "s7 override" };
    await call("rks_release", { projectId: PROJECT_ID, version: "minor", changelog: "c", enforcementOverride: override });
    expect(h.runRelease.mock.calls[1][0]).toStrictEqual({ ...common, version: "minor", changelog: "c", enforcementOverride: override });
  });
});

describe("chain state through ctx.governorToken and ctx.tool", () => {
  const RESULT = {
    rks_cycle_complete: { fn: "runCycleComplete", prefix: "cycle_complete" },
    rks_staging_pr: { fn: "runGitPR", prefix: "staging_pr" },
    rks_git_merge: { fn: "runGitMerge", prefix: "git_merge" },
    rks_staging_merge: { fn: "runStagingMerge", prefix: "staging_merge" },
  };
  const CHAIN_ARGS = {
    rks_story_ship: { projectId: PROJECT_ID },
    rks_cycle_complete: { projectId: PROJECT_ID },
    rks_ship: { projectId: PROJECT_ID, message: "m" },
    rks_staging_pr: { projectId: PROJECT_ID },
    rks_git_merge: { projectId: PROJECT_ID },
    rks_staging_merge: { projectId: PROJECT_ID, reason: "infrastructure" },
  };

  it.each(Object.keys(RESULT))("SH-TR13 %s advances the REQUEST token with .ok / .error matching result.ok", async (tool) => {
    const { fn, prefix } = RESULT[tool];
    const { call } = shipRegistry();
    h[fn].mockImplementation(async () => ({ ok: true }));
    await call(tool, { projectId: PROJECT_ID }, TOKEN);
    expect(h.validateToken).toHaveBeenCalledWith(TOKEN);
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, `${prefix}.ok`]]);
    h[fn].mockImplementation(async () => ({ ok: false }));
    await call(tool, { projectId: PROJECT_ID }, TOKEN);
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, `${prefix}.ok`], [TOKEN, `${prefix}.error`]]);
    for (const [t] of [...h.validateToken.mock.calls, ...h.advanceStateOnResult.mock.calls]) expect(t).not.toBe(ACTIVE);
    // backlog.fix.ship-flow-deterministic-no-llm (AC9 option A): rks_cycle_complete reads the
    // REQUEST token's session to decide requireWorkingBranch; the other two never read a session.
    if (tool === "rks_cycle_complete") {
      expect(h.getSession).toHaveBeenCalledWith(TOKEN);
      for (const [t] of h.getSession.mock.calls) expect(t).toBe(TOKEN);
    } else {
      expect(h.getSession).not.toHaveBeenCalled();
    }
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("AC9 rks_cycle_complete passes requireWorkingBranch true only for a ship session at committed", async () => {
    const { call } = shipRegistry();
    h.getSession.mockReturnValue({ flowType: "ship", state: "committed" });
    await call("rks_cycle_complete", { projectId: PROJECT_ID }, TOKEN);
    expect(h.runCycleComplete.mock.calls[0][0]).toStrictEqual({ projectRoot: FIX, projectId: PROJECT_ID, discardLocalCommits: false, requireWorkingBranch: true });
    for (const session of [{ flowType: "ship", state: "merging" }, null, { flowType: "story", state: "committed" }]) {
      h.runCycleComplete.mockClear();
      h.getSession.mockReturnValue(session);
      await call("rks_cycle_complete", { projectId: PROJECT_ID }, TOKEN);
      expect(h.runCycleComplete.mock.calls[0][0], JSON.stringify(session)).toStrictEqual({ projectRoot: FIX, projectId: PROJECT_ID, discardLocalCommits: false });
    }
  });

  it.each(Object.keys(CHAIN_ARGS))("SH-TR14 %s touches no chain state or telemetry without a request token, or with one that does not validate", async (tool) => {
    const { call } = shipRegistry();
    await call(tool, CHAIN_ARGS[tool], undefined);
    expect(h.validateToken).not.toHaveBeenCalled();
    h.validateToken.mockReturnValue(false);
    await call(tool, CHAIN_ARGS[tool], TOKEN);
    expect(h.validateToken).toHaveBeenCalledWith(TOKEN);
    for (const fn of [h.advanceStateOnResult, h.getSession, h.updateChildState, h.advanceToNextChild, h.emit]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: true }, "ship.ok"],
    [{ ok: true, idempotent: true }, "ship.failed"],
    [{ ok: false, error: "x" }, "ship.failed"],
    [null, "ship.failed"],
  ])("SH-TR15 rks_story_ship result %j maps to %s; ctx.tool reaches telemetry only on a transition", async (result, key) => {
    h.runStoryShipTool.mockResolvedValue(result);
    h.advanceStateOnResult.mockReturnValue({ transitioned: true, previousState: "shipping", newState: "s7-next" });
    const { call } = shipRegistry();
    expect(payload(await call("rks_story_ship", { projectId: PROJECT_ID, problemId: "backlog.s7" }, TOKEN, CTX_TOOL))).toEqual(result);
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, key]]);
    expect(h.emit.mock.calls).toEqual([
      ["governor.state.transition", PROJECT_ID, { tool: CTX_TOOL, resultKey: key, from: "shipping", to: "s7-next", trigger: "tool_result" }],
    ]);
    h.emit.mockClear();
    h.advanceStateOnResult.mockReturnValue({ transitioned: false });
    await call("rks_story_ship", { projectId: PROJECT_ID }, TOKEN, CTX_TOOL);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("SH-TR16 rks_ship outside child_active advances ship.ok / ship.failed and attaches _governorState only on a transition", async () => {
    const session = { state: "shipping" };
    h.getSession.mockReturnValue(session);
    h.advanceStateOnResult.mockReturnValue({ transitioned: true, previousState: "shipping", newState: "shipped" });
    const { call } = shipRegistry();
    const ok = payload(await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN, CTX_TOOL));
    expect(ok).toEqual({ ok: true, via: "runShip", _governorState: { from: "shipping", to: "shipped" } });
    expect(h.getSession).toHaveBeenCalledWith(TOKEN);
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, "ship.ok"]]);
    expect(h.emit.mock.calls).toEqual([
      ["governor.state.transition", PROJECT_ID, { tool: CTX_TOOL, resultKey: "ship.ok", from: "shipping", to: "shipped", trigger: "tool_result" }],
    ]);
    h.runShip.mockImplementation(async () => ({ ok: false, error: "s7" }));
    h.advanceStateOnResult.mockReturnValue({ transitioned: false });
    h.emit.mockClear();
    expect(payload(await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN, CTX_TOOL))).toEqual({ ok: false, error: "s7" });
    expect(h.advanceStateOnResult).toHaveBeenLastCalledWith(TOKEN, "ship.failed");
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.updateChildState).not.toHaveBeenCalled();
    expect(h.advanceToNextChild).not.toHaveBeenCalled();
    expect(session.state).toBe("shipping");
  });

  it("SH-TR17 rks_ship in child_active with ok completes the child, advances, and on the last child sets session.state shipped directly", async () => {
    const session = { state: "child_active" };
    h.getSession.mockReturnValue(session);
    const { call } = shipRegistry();
    h.advanceToNextChild.mockReturnValueOnce({ childId: "c2", index: 1, total: 2, allComplete: false });
    const mid = payload(await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN, CTX_TOOL));
    expect(mid).toEqual({ ok: true, via: "runShip", _childComplete: { nextChildId: "c2", index: 1, total: 2 } });
    expect(h.updateChildState.mock.calls).toEqual([[TOKEN, "complete"]]);
    expect(h.advanceToNextChild.mock.calls).toEqual([[TOKEN]]);
    expect(session.state).toBe("child_active");
    expect(h.emit.mock.calls).toEqual([
      ["governor.state.transition", PROJECT_ID, { tool: CTX_TOOL, resultKey: "child.complete", from: "child_active", to: "child_active", trigger: "child_advance", nextChildId: "c2", childIndex: 1, childrenTotal: 2 }],
    ]);
    h.emit.mockClear();
    h.advanceToNextChild.mockReturnValueOnce({ childId: null, index: 2, total: 2, allComplete: true });
    const last = payload(await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN, CTX_TOOL));
    expect(last).toEqual({ ok: true, via: "runShip", _governorState: { from: "child_active", to: "shipped" }, _childComplete: { allComplete: true, total: 2 } });
    expect(session.state).toBe("shipped");
    expect(h.emit.mock.calls).toEqual([
      ["governor.state.transition", PROJECT_ID, { tool: CTX_TOOL, resultKey: "children.all_complete", from: "child_active", to: "shipped", trigger: "child_complete", childrenTotal: 2 }],
    ]);
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
  });

  it("SH-TR18 rks_ship in child_active - a null advance attaches nothing; a failed ship takes the ship.failed path and touches no child", async () => {
    const session = { state: "child_active" };
    h.getSession.mockReturnValue(session);
    h.advanceToNextChild.mockReturnValueOnce(null);
    const { call } = shipRegistry();
    expect(payload(await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN))).toEqual({ ok: true, via: "runShip" });
    expect(h.updateChildState).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
    expect(session.state).toBe("child_active");
    h.updateChildState.mockClear();
    h.advanceToNextChild.mockClear();
    h.runShip.mockImplementation(async () => ({ ok: false }));
    await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN);
    expect(h.advanceStateOnResult.mock.calls).toEqual([[TOKEN, "ship.failed"]]);
    expect(h.updateChildState).not.toHaveBeenCalled();
    expect(h.advanceToNextChild).not.toHaveBeenCalled();
  });

  it("SH-TR19 a throwing telemetry emit does not fail rks_story_ship or rks_ship", async () => {
    h.emit.mockImplementation(() => { throw new Error("s7-telemetry-down"); });
    h.advanceStateOnResult.mockReturnValue({ transitioned: true, previousState: "shipping", newState: "shipped" });
    h.getSession.mockReturnValue({ state: "shipping" });
    const { call } = shipRegistry();
    expect(payload(await call("rks_story_ship", { projectId: PROJECT_ID }, TOKEN))).toEqual({ ok: true, via: "runStoryShipTool" });
    expect(payload(await call("rks_ship", { projectId: PROJECT_ID, message: "m" }, TOKEN))).toEqual({ ok: true, via: "runShip", _governorState: { from: "shipping", to: "shipped" } });
    expect(h.emit).toHaveBeenCalledTimes(2);
  });
});

describe("ship.mjs source", () => {
  const src = fs.readFileSync(SHIP_ABS, "utf8");
  const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");
  const head = (tool) => `registerHandler("${tool}",`;
  const wrapperOf = (tool) => `${head(tool)} async (cleanArgs, ctx) =>`;
  const bodyOf = (tool) => readToolHandlerSource(tool).slice(wrapperOf(tool).length);

  it("SH-TR20 registers the nine in server.mjs order, each once, as string literals behind the frozen wrapper", () => {
    const positions = SOURCE_ORDER.map((tool) => {
      const at = src.indexOf(head(tool));
      expect(at, tool).toBeGreaterThan(-1);
      expect(src.indexOf(head(tool), at + 1), tool).toBe(-1);
      return at;
    });
    for (let i = 1; i < positions.length; i++) expect(positions[i], SOURCE_ORDER[i]).toBeGreaterThan(positions[i - 1]);
    expect(stripComments(src).match(/(?<![\w$])registerHandler\(/g)).toHaveLength(9);
    for (const tool of SOURCE_ORDER) {
      const slice = readToolHandlerSource(tool);
      expect(slice.startsWith(wrapperOf(tool)), tool).toBe(true);
      expect(src.includes(slice), tool).toBe(true);
    }
  });

  it("SH-TR21 ctx.tool / ctx.governorToken are bound as leading statements by exactly the readers; no body reaches IIFE locals", () => {
    for (const tool of SOURCE_ORDER) {
      const body = stripComments(bodyOf(tool));
      const expected = [];
      if (TOOL_READERS.includes(tool)) expected.push("const tool = ctx.tool;");
      if (TOKEN_READERS.includes(tool)) expected.push("const _governorToken = ctx.governorToken;");
      expect(body.match(/\bctx\b/g) || [], tool).toHaveLength(expected.length);
      let rest = body.slice(body.indexOf("{") + 1).trimStart();
      for (const stmt of expected) {
        expect(rest.startsWith(stmt), `${tool} leads with ${stmt}`).toBe(true);
        rest = rest.slice(stmt.length).trimStart();
      }
      if (!TOKEN_READERS.includes(tool)) {
        expect(body, tool).not.toMatch(/_governorToken|validateToken|advanceStateOnResult|getSession|updateChildState|advanceToNextChild/);
      }
      if (!TOOL_READERS.includes(tool)) expect(body, tool).not.toMatch(/getTelemetryCollector/);
      expect(body, tool).not.toMatch(/(?<![\w$.])args\b/);
      expect(body, tool).not.toMatch(/activeToken|revertStateOnFailure|pendingPlans|flushPendingStashPops|_entryTransition|req\.params/);
    }
  });

  it("SH-TR22 specifiers resolve to the files server.mjs imports; exactly three re-pathed lazy imports", () => {
    const own = importSpecifiers(src);
    const server = importSpecifiers(serverSrc);
    const serverBare = new Set(server.filter((s) => !isRelative(s)));
    for (const spec of own.filter((s) => !isRelative(s))) expect(serverBare.has(spec), spec).toBe(true);
    const serverResolved = new Set(server.filter(isRelative).map((s) => path.resolve(path.dirname(SERVER_ABS), s)));
    const ownRelative = own.filter(isRelative);
    expect(ownRelative.length).toBeGreaterThan(0);
    for (const spec of ownRelative) {
      const abs = path.resolve(path.dirname(SHIP_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      expect(serverResolved.has(abs), spec).toBe(true);
    }
    expect(countOccurrences(src, "await import(")).toBe(3);
    expect(countOccurrences(bodyOf("rks_story_ship"), "await import('../story-ship.mjs')")).toBe(1);
    for (const tool of ["rks_cycle_complete", "rks_promote"]) {
      expect(countOccurrences(bodyOf(tool), 'await import("../git-tools.mjs")'), tool).toBe(1);
    }
    expect(path.resolve(path.dirname(SHIP_ABS), "../story-ship.mjs")).toBe(path.join(REPO_ROOT, "packages/mcp-rks/src/server/story-ship.mjs"));
    expect(path.resolve(path.dirname(SHIP_ABS), "../git-tools.mjs")).toBe(path.join(REPO_ROOT, "packages/mcp-rks/src/server/git-tools.mjs"));
    expect(serverSrc).not.toContain('await import("./server/git-tools.mjs")');
    expect(serverSrc).not.toContain("await import('./server/story-ship.mjs')");
  });

  it("SH-TR23 every function the bodies call is imported or lazily destructured; every schema they parse is a parameter", () => {
    const bodies = SOURCE_ORDER.map((tool) => stripComments(bodyOf(tool))).join("\n");
    const called = new Set([...bodies.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    for (const kw of ["if", "import", "catch", "function", "return", "async"]) called.delete(kw);
    expect([...called].sort()).toEqual(CALLED);
    const staticNames = new Set([
      ...namedImports(src, "../git-tools.mjs"),
      ...namedImports(src, "../project.mjs"),
      ...namedImports(src, "../../shared/governor-token.mjs"),
      ...namedImports(src, "@routekit/telemetry/collector"),
    ]);
    const lazyNames = new Set([...src.matchAll(/const\s*\{\s*([\w$]+)\s*\}\s*=\s*await import\(/g)].map((m) => m[1]));
    expect([...lazyNames].sort()).toEqual(LAZY);
    for (const name of called) expect(staticNames.has(name) || lazyNames.has(name), name).toBe(true);
    const parsed = new Set([...bodies.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*Schema)\.parse\(/g)].map((m) => m[1]));
    expect([...parsed].sort()).toEqual(Object.values(SCHEMA_KEY).sort());
    const params = src.match(/export function registerShipHandlers\(\{\s*registerHandler\s*\},\s*\{([^}]*)\}\)/);
    expect(params, "registerShipHandlers({ registerHandler }, { ...schemas })").not.toBeNull();
    expect(params[1].split(",").map((s) => s.trim()).filter(Boolean).sort()).toEqual(Object.values(SCHEMA_KEY).sort());
    expect(bodies).toMatch(/(?<![\w$.])z\.object\(/);
    expect(namedImports(src, "zod")).toContain("z");
  });

  it("SH-TR24 every bound name is a real export; static git-tools imports are a subset of server.mjs's", async () => {
    const staticGit = namedImports(src, "../git-tools.mjs");
    expect([...staticGit].sort()).toEqual(["runGitMerge", "runGitPR", "runRelease", "runShip", "runStagingMerge", "runSyncStaging"]);
    const serverStaticGit = namedImports(serverSrc, "./server/git-tools.mjs");
    for (const n of staticGit) expect(serverStaticGit, n).toContain(n);
    const realGit = await vi.importActual("../../packages/mcp-rks/src/server/git-tools.mjs");
    for (const n of [...staticGit, "runCycleComplete", "runPromote"]) expect(typeof realGit[n], n).toBe("function");
    const realStoryShip = await vi.importActual("../../packages/mcp-rks/src/server/story-ship.mjs");
    expect(typeof realStoryShip.runStoryShipTool).toBe("function");
    expect(namedImports(src, "../project.mjs")).toEqual(expect.arrayContaining(["loadContext", "getBranchConfig"]));
    const realProject = await vi.importActual("../../packages/mcp-rks/src/server/project.mjs");
    for (const n of ["loadContext", "getBranchConfig"]) expect(typeof realProject[n], n).toBe("function");
    const tokenNames = ["validateToken", "advanceStateOnResult", "getSession", "updateChildState", "advanceToNextChild"];
    expect(namedImports(src, "../../shared/governor-token.mjs")).toEqual(expect.arrayContaining(tokenNames));
    const realTok = await vi.importActual("../../packages/mcp-rks/src/shared/governor-token.mjs");
    for (const n of tokenNames) expect(typeof realTok[n], n).toBe("function");
    expect(namedImports(src, "@routekit/telemetry/collector")).toContain("getTelemetryCollector");
    const realCollector = await vi.importActual("@routekit/telemetry/collector");
    expect(typeof realCollector.getTelemetryCollector).toBe("function");
  });

  it("SH-TR25 ship.mjs imports nothing from server.mjs and defines no function besides registerShipHandlers", () => {
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src.match(/\bfunction\s+[\w$]+\s*\(/g)).toEqual(["function registerShipHandlers("]);
  });
});
