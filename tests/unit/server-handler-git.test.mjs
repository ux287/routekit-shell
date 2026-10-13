/**
 * S6 git family handlers (backlog.feat.server-mjs-git-handler-family), part of
 * research.2026.10.05.server-mjs-safe-decomposition (G-TR1..G-TR19). Mirrors
 * tests/unit/server-handler-rag.test.mjs. Unit tier: no subprocess, no server.mjs import,
 * no vi.resetModules. Every git entry point the thirteen bodies reach (server/git-tools.mjs,
 * tools/git-push.mjs, tools/git-preflight.mjs) is a vi.fn, and the four chain-state helpers of
 * shared/governor-token.mjs are vi.fn spies: no git, no worktree, no remote, no session.
 * Real-git and real-session evidence: tests/integration/server-handler-git.test.mjs.
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
    runGitStash: vi.fn(),
    runGitRestore: vi.fn(),
    runGitReset: vi.fn(),
    runGitRevert: vi.fn(),
    runGitTag: vi.fn(),
    runGitCherryPick: vi.fn(),
    runGitBranch: vi.fn(),
    runGitCheckout: vi.fn(),
    runBranchRepair: vi.fn(),
    runGitCommit: vi.fn(),
    runResolveConflict: vi.fn(),
    runGitPush: vi.fn(),
    runGitPreflight: vi.fn(),
    validateToken: vi.fn(),
    advanceStateOnResult: vi.fn(),
    setPendingStash: vi.fn(),
    clearPendingStash: vi.fn(),
  };
});

// Keyed on the resolved files: the moved lazy imports are "../git-tools.mjs" relative to
// handlers/, so reaching these mocks from a lazy body proves the re-path.
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runGitStash: h.runGitStash,
  runGitRestore: h.runGitRestore,
  runGitReset: h.runGitReset,
  runGitRevert: h.runGitRevert,
  runGitTag: h.runGitTag,
  runGitCherryPick: h.runGitCherryPick,
  runGitBranch: h.runGitBranch,
  runGitCheckout: h.runGitCheckout,
  runBranchRepair: h.runBranchRepair,
  runGitCommit: h.runGitCommit,
  runResolveConflict: h.runResolveConflict,
}));
vi.mock("../../packages/mcp-rks/src/tools/git-push.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runGitPush: h.runGitPush,
}));
vi.mock("../../packages/mcp-rks/src/tools/git-preflight.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runGitPreflight: h.runGitPreflight,
}));
vi.mock("../../packages/mcp-rks/src/shared/governor-token.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  validateToken: h.validateToken,
  advanceStateOnResult: h.advanceStateOnResult,
  setPendingStash: h.setPendingStash,
  clearPendingStash: h.clearPendingStash,
}));

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { registerRagHandlers } from "../../packages/mcp-rks/src/server/handlers/rag.mjs";
import { registerGitHandlers } from "../../packages/mcp-rks/src/server/handlers/git.mjs";
import { getBranchConfig, loadContext } from "../../packages/mcp-rks/src/server/project.mjs";
import { TOOL_NAME as GIT_PREFLIGHT_NAME } from "../../packages/mcp-rks/src/tools/git-preflight.mjs";
import { coAuthorTrailer, CO_AUTHOR_REJECTED_WARNING } from "../../packages/mcp-rks/src/shared/commit-attribution.mjs";
import { readToolHandlerSource } from "../_helpers/server-source.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const HANDLERS_DIR = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers");
const GIT_ABS = path.join(HANDLERS_DIR, "git.mjs");

// server.mjs head order at the build base (Runs A-E).
const SOURCE_ORDER = [
  "rks_stash",
  "rks_restore",
  "rks_reset",
  "rks_revert",
  "rks_tag",
  "rks_cherry_pick",
  "rks_git_branch",
  "rks_checkout",
  "rks_branch_repair",
  "rks_git_commit",
  "rks_git_push",
  "rks_git_preflight",
  "rks_resolve_conflict",
];
const GIT_TOOLS = [...SOURCE_ORDER].sort();
const IDENTIFIER = { rks_git_preflight: "GIT_PREFLIGHT_TOOL" };
const CTX_READERS = ["rks_stash", "rks_git_commit", "rks_git_push"];
const SCHEMA_KEY = {
  rks_stash: "stashSchema",
  rks_restore: "restoreSchema",
  rks_reset: "resetSchema",
  rks_revert: "revertSchema",
  rks_tag: "tagSchema",
  rks_cherry_pick: "cherryPickSchema",
  rks_git_branch: "gitBranchSchema",
  rks_checkout: "checkoutSchema",
  rks_branch_repair: "branchRepairSchema",
  rks_git_commit: "gitCommitSchema",
  rks_git_push: "gitPushSchema",
};
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_update_field", "dendron_validate_schema"];
const RAG_TOOLS = ["rks_exhaustive_search", "rks_fetch_raw", "rks_memory_save", "rks_rag_compact", "rks_rag_embed", "rks_rag_init", "rks_rag_query"];

const marker = (tool) => `__s6_marker_${tool}`;
const markerSchemas = () =>
  Object.fromEntries(Object.entries(SCHEMA_KEY).map(([tool, key]) => [key, z.object({ [marker(tool)]: z.string() })]));
// projectId required, every other key reaches the body unchanged: projection assertions test
// the moved body, not a transcription of the server.mjs schema consts.
const passSchemas = () =>
  Object.fromEntries(Object.values(SCHEMA_KEY).map((key) => [key, z.object({ projectId: z.string() }).passthrough()]));

const PROJECT_ID = "s6-git-handler-fixture";
const TOKEN = "s6-request-governor-token";
const ACTIVE = "s6-active-token-is-not-the-request-token";
const saved = {};
let FIX;
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  for (const name of ["runGitStash", "runGitRestore", "runGitReset", "runGitRevert", "runGitTag", "runGitCherryPick", "runGitBranch", "runGitCheckout", "runBranchRepair", "runGitCommit", "runResolveConflict"]) {
    h[name].mockResolvedValue({ ok: true, via: name });
  }
  h.runGitPush.mockReturnValue({ ok: true, via: "runGitPush" });
  h.runGitPreflight.mockReturnValue({ ok: true, via: "runGitPreflight" });
  h.validateToken.mockReturnValue(true);
  // Non-git temp project for loadContext only; nothing here runs git.
  FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s6-git-unit-")));
  fs.mkdirSync(path.join(FIX, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(FIX, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(FIX, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: FIX, kgFile: "routekit/kg.yaml" }));
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

const ctxFor = (tool, args, governorToken) => Object.freeze({ tool, args, activeToken: ACTIVE, governorToken });
const payload = (res) => JSON.parse(res.content[0].text);
function gitRegistry(schemas = passSchemas()) {
  const r = createHandlerRegistry();
  registerGitHandlers(r, schemas);
  return { r, call: (tool, args, governorToken) => r.lookupHandler(tool)(args, ctxFor(tool, args, governorToken)) };
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

describe("registerGitHandlers", () => {
  it("G-TR1 registers exactly the thirteen git tools, each a function, rks_git_preflight under TOOL_NAME", () => {
    const { r } = gitRegistry(markerSchemas());
    expect(GIT_PREFLIGHT_NAME).toBe("rks_git_preflight");
    expect(r.registeredTools()).toEqual(GIT_TOOLS);
    for (const tool of GIT_TOOLS) expect(typeof r.lookupHandler(tool), tool).toBe("function");
  });

  it("G-TR2 coexists with the telemetry, project/meta, dendron and RAG families (39 tools)", () => {
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
    expect(() => registerGitHandlers(r, markerSchemas())).not.toThrow();
    expect(r.registeredTools()).toEqual([...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS, ...GIT_TOOLS].sort());
    expect(r.registeredTools()).toHaveLength(39);
  });

  it.each(Object.keys(SCHEMA_KEY))("G-TR3 %s rejects {} with a ZodError from its injected schema before any dependency runs", async (tool) => {
    const { call } = gitRegistry(markerSchemas());
    const err = await call(tool, {}, TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain(marker(tool));
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it("G-TR4 rks_resolve_conflict keeps its inline schema and defaults strategy to theirs and files to []", async () => {
    const { call } = gitRegistry();
    const missing = await call("rks_resolve_conflict", {}).catch((e) => e);
    expect(missing).toBeInstanceOf(ZodError);
    expect(missing.issues.map((i) => i.path.join("."))).toContain("projectId");
    const badStrategy = await call("rks_resolve_conflict", { projectId: PROJECT_ID, strategy: "rebase" }).catch((e) => e);
    expect(badStrategy).toBeInstanceOf(ZodError);
    expect(h.runResolveConflict).not.toHaveBeenCalled();
    await call("rks_resolve_conflict", { projectId: PROJECT_ID });
    expect(h.runResolveConflict).toHaveBeenLastCalledWith({ projectRoot: FIX, strategy: "theirs", files: [] });
    await call("rks_resolve_conflict", { projectId: PROJECT_ID, strategy: "ours", files: ["a.txt"] });
    expect(h.runResolveConflict).toHaveBeenLastCalledWith({ projectRoot: FIX, strategy: "ours", files: ["a.txt"] });
  });

  it("G-TR5 rks_git_preflight reads cleanArgs directly and defaults cleanWorktrees to true", async () => {
    const { call } = gitRegistry();
    const p = payload(await call(GIT_PREFLIGHT_NAME, { projectId: PROJECT_ID, expectedBranch: "staging", autoStash: true }));
    expect(p).toEqual({ ok: true, via: "runGitPreflight" });
    expect(h.runGitPreflight).toHaveBeenLastCalledWith(FIX, { expectedBranch: "staging", autoStash: true, cleanWorktrees: true });
    await call(GIT_PREFLIGHT_NAME, { projectId: PROJECT_ID, cleanWorktrees: false });
    expect(h.runGitPreflight).toHaveBeenLastCalledWith(FIX, { expectedBranch: undefined, autoStash: undefined, cleanWorktrees: false });
  });

  it("G-TR6 rks_tag projects its args and productionBranch from getBranchConfig, else main", async () => {
    const { call } = gitRegistry();
    const args = { projectId: PROJECT_ID, action: "list", name: "v1", message: "m", commit: "abc", pattern: "v*", stray: "dropped" };
    await call("rks_tag", args);
    const context = await loadContext(PROJECT_ID);
    const productionBranch = getBranchConfig(context.record, context.projectJson).production || "main";
    expect(h.runGitTag).toHaveBeenCalledTimes(1);
    expect(h.runGitTag).toHaveBeenCalledWith({ projectRoot: FIX, action: "list", name: "v1", message: "m", commit: "abc", pattern: "v*", productionBranch });
  });

  it.each([
    ["rks_restore", "runGitRestore", { files: ["a.txt"], staged: true, source: "HEAD" }],
    ["rks_reset", "runGitReset", { mode: "soft", target: "HEAD~1", confirm: true }],
    ["rks_revert", "runGitRevert", { commit: "abc", noCommit: true }],
    ["rks_cherry_pick", "runGitCherryPick", { commit: "abc", noCommit: false, abort: false }],
  ])("G-TR7 %s reaches the mocked git-tools.mjs through its re-pathed lazy import and projects only its keys", async (tool, fn, extra) => {
    const { call } = gitRegistry();
    const p = payload(await call(tool, { projectId: PROJECT_ID, ...extra, stray: "dropped" }));
    expect(p).toEqual({ ok: true, via: fn });
    expect(h[fn]).toHaveBeenCalledTimes(1);
    expect(h[fn]).toHaveBeenCalledWith({ projectRoot: FIX, ...extra });
  });

  it("G-TR8 rks_git_branch defaults baseBranch to staging; rks_checkout and rks_branch_repair project their input", async () => {
    const { call } = gitRegistry();
    await call("rks_git_branch", { projectId: PROJECT_ID, name: "s6", type: "feature" });
    expect(h.runGitBranch).toHaveBeenCalledWith({ projectRoot: FIX, name: "s6", type: "feature", baseBranch: "staging" });
    await call("rks_checkout", { projectId: PROJECT_ID, branch: "staging", force: false });
    expect(h.runGitCheckout).toHaveBeenCalledWith({ projectRoot: FIX, branch: "staging", force: false });
    await call("rks_branch_repair", { projectId: PROJECT_ID, dryRun: true });
    expect(h.runBranchRepair).toHaveBeenCalledWith({ projectRoot: FIX, projectId: PROJECT_ID, dryRun: true });
  });

  it("G-TR9 rks_git_commit sends stageAll only when files is omitted and reports a rejected coAuthor", async () => {
    h.runGitCommit.mockResolvedValue({ ok: true, sha: "s6" });
    const { call } = gitRegistry();
    await call("rks_git_commit", { projectId: PROJECT_ID, message: "m" });
    expect(h.runGitCommit).toHaveBeenLastCalledWith({ projectRoot: FIX, projectId: PROJECT_ID, message: "m", stageAll: true });
    await call("rks_git_commit", { projectId: PROJECT_ID, message: "m", files: ["a.txt"] });
    expect(h.runGitCommit).toHaveBeenLastCalledWith({ projectRoot: FIX, projectId: PROJECT_ID, message: "m", files: ["a.txt"], stageAll: false });

    const BAD = "not an identity";
    expect(coAuthorTrailer(BAD), "fixture precondition: BAD must be rejected").toBe("");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = payload(await call("rks_git_commit", { projectId: PROJECT_ID, message: "m", files: ["a.txt"], coAuthor: BAD }));
      expect(p).toEqual({ ok: true, sha: "s6", coAuthorRejected: true, coAuthorWarning: CO_AUTHOR_REJECTED_WARNING });
      expect(errSpy).toHaveBeenCalledWith(CO_AUTHOR_REJECTED_WARNING);
    } finally {
      errSpy.mockRestore();
    }
    const GOOD = "S6 Tester <s6@example.com>";
    expect(coAuthorTrailer(GOOD), "fixture precondition: GOOD must be accepted").not.toBe("");
    expect(payload(await call("rks_git_commit", { projectId: PROJECT_ID, message: "m", files: ["a.txt"], coAuthor: GOOD }))).toEqual({ ok: true, sha: "s6" });
  });

  it("G-TR10 rks_git_push calls runGitPush synchronously with (projectRoot, { branch })", async () => {
    h.runGitPush.mockReturnValue({ ok: true, branch: "s6", remote: "origin" });
    const { call } = gitRegistry();
    expect(payload(await call("rks_git_push", { projectId: PROJECT_ID, branch: "s6" }))).toEqual({ ok: true, branch: "s6", remote: "origin" });
    expect(h.runGitPush).toHaveBeenCalledTimes(1);
    expect(h.runGitPush).toHaveBeenCalledWith(FIX, { branch: "s6" });
  });
});

describe("chain state through ctx.governorToken", () => {
  const RESULT = {
    rks_git_commit: { fn: "runGitCommit", prefix: "git_commit", extra: { message: "m", files: ["a.txt"] } },
    rks_git_push: { fn: "runGitPush", prefix: "git_push", extra: { branch: "s6" } },
  };
  const setOk = (fn, ok) => (fn === "runGitPush" ? h[fn].mockReturnValue({ ok }) : h[fn].mockResolvedValue({ ok }));

  it.each(Object.keys(RESULT))("G-TR11 %s advances the REQUEST token with .ok / .error matching result.ok", async (tool) => {
    const { fn, prefix, extra } = RESULT[tool];
    const { call } = gitRegistry();
    setOk(fn, true);
    await call(tool, { projectId: PROJECT_ID, ...extra }, TOKEN);
    expect(h.validateToken).toHaveBeenCalledWith(TOKEN);
    expect(h.advanceStateOnResult).toHaveBeenCalledTimes(1);
    expect(h.advanceStateOnResult).toHaveBeenLastCalledWith(TOKEN, `${prefix}.ok`);
    setOk(fn, false);
    await call(tool, { projectId: PROJECT_ID, ...extra }, TOKEN);
    expect(h.advanceStateOnResult).toHaveBeenCalledTimes(2);
    expect(h.advanceStateOnResult).toHaveBeenLastCalledWith(TOKEN, `${prefix}.error`);
    for (const [t] of [...h.validateToken.mock.calls, ...h.advanceStateOnResult.mock.calls]) expect(t).not.toBe(ACTIVE);
  });

  it.each(Object.keys(RESULT))("G-TR12 %s touches no chain state without a request token or with one that does not validate", async (tool) => {
    const { fn, extra } = RESULT[tool];
    const { call } = gitRegistry();
    setOk(fn, true);
    await call(tool, { projectId: PROJECT_ID, ...extra }, undefined);
    expect(h.validateToken).not.toHaveBeenCalled();
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
    h.validateToken.mockReturnValue(false);
    await call(tool, { projectId: PROJECT_ID, ...extra }, TOKEN);
    expect(h.validateToken).toHaveBeenCalledWith(TOKEN);
    expect(h.advanceStateOnResult).not.toHaveBeenCalled();
  });

  it("G-TR13 rks_stash save/push arm an auto-pop for the request token; pop/drop clear it; list touches neither", async () => {
    const { call } = gitRegistry();
    const save = { projectId: PROJECT_ID, action: "save", message: "s6", stashIndex: 0, includeUntracked: true };
    expect(payload(await call("rks_stash", save, TOKEN))).toEqual({ ok: true, via: "runGitStash" });
    expect(h.runGitStash).toHaveBeenCalledWith({ projectRoot: FIX, action: "save", message: "s6", stashIndex: 0, includeUntracked: true });
    expect(h.setPendingStash).toHaveBeenCalledTimes(1);
    const [armedFor, popFn] = h.setPendingStash.mock.calls[0];
    expect(armedFor).toBe(TOKEN);
    expect(typeof popFn).toBe("function");
    h.runGitStash.mockClear();
    await popFn();
    expect(h.runGitStash).toHaveBeenCalledTimes(1);
    expect(h.runGitStash).toHaveBeenCalledWith({ projectRoot: FIX, action: "pop" });

    await call("rks_stash", { ...save, action: "push" }, TOKEN);
    expect(h.setPendingStash).toHaveBeenCalledTimes(2);
    expect(h.clearPendingStash).not.toHaveBeenCalled();
    for (const action of ["pop", "drop"]) await call("rks_stash", { projectId: PROJECT_ID, action }, TOKEN);
    expect(h.clearPendingStash.mock.calls).toEqual([[TOKEN], [TOKEN]]);
    await call("rks_stash", { projectId: PROJECT_ID, action: "list" }, TOKEN);
    expect(h.setPendingStash).toHaveBeenCalledTimes(2);
    expect(h.clearPendingStash).toHaveBeenCalledTimes(2);
  });

  it("G-TR14 rks_stash without a request token, or with one that does not validate, arms and clears nothing", async () => {
    const { call } = gitRegistry();
    for (const action of ["save", "push", "pop", "drop"]) {
      expect(payload(await call("rks_stash", { projectId: PROJECT_ID, action }, undefined))).toEqual({ ok: true, via: "runGitStash" });
    }
    expect(h.validateToken).not.toHaveBeenCalled();
    h.validateToken.mockReturnValue(false);
    for (const action of ["save", "pop"]) await call("rks_stash", { projectId: PROJECT_ID, action }, TOKEN);
    expect(h.setPendingStash).not.toHaveBeenCalled();
    expect(h.clearPendingStash).not.toHaveBeenCalled();
    expect(h.runGitStash).toHaveBeenCalledTimes(6);
  });
});

describe("git.mjs source", () => {
  const src = fs.readFileSync(GIT_ABS, "utf8");
  const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");
  const head = (tool) => (IDENTIFIER[tool] ? `registerHandler(${IDENTIFIER[tool]},` : `registerHandler("${tool}",`);
  const wrapperOf = (tool) => `${head(tool)} async (cleanArgs, ctx) =>`;
  const sliceOf = (tool) => readToolHandlerSource(tool, IDENTIFIER[tool] ? { identifier: IDENTIFIER[tool] } : {});

  it("G-TR15 registers the thirteen in server.mjs order, each once, behind the frozen wrapper; rks_git_preflight only under its identifier", () => {
    const positions = SOURCE_ORDER.map((tool) => {
      const at = src.indexOf(head(tool));
      expect(at, tool).toBeGreaterThan(-1);
      expect(src.indexOf(head(tool), at + 1), tool).toBe(-1);
      return at;
    });
    for (let i = 1; i < positions.length; i++) expect(positions[i], SOURCE_ORDER[i]).toBeGreaterThan(positions[i - 1]);
    expect(src).not.toContain('registerHandler("rks_git_preflight"');
    expect(src).not.toContain("registerHandler('rks_git_preflight'");
    for (const tool of SOURCE_ORDER) {
      const slice = sliceOf(tool);
      expect(slice.startsWith(wrapperOf(tool)), tool).toBe(true);
      expect(src.includes(slice), tool).toBe(true);
    }
  });

  it("G-TR16 only rks_stash, rks_git_commit and rks_git_push read ctx, once, as their first statement", () => {
    for (const tool of SOURCE_ORDER) {
      const body = sliceOf(tool).slice(wrapperOf(tool).length);
      const ctxReads = body.match(/\bctx\b/g) || [];
      if (CTX_READERS.includes(tool)) {
        expect(ctxReads, tool).toHaveLength(1);
        expect(body.slice(body.indexOf("{") + 1).trimStart().startsWith("const _governorToken = ctx.governorToken;"), tool).toBe(true);
      } else {
        expect(ctxReads, tool).toHaveLength(0);
        expect(body, tool).not.toMatch(/_governorToken|validateToken|advanceStateOnResult|setPendingStash|clearPendingStash/);
      }
      expect(body, tool).not.toMatch(/(?<![\w$.])args\b/);
      expect(body, tool).not.toMatch(/activeToken|revertStateOnFailure|pendingPlans|flushPendingStashPops|getTelemetryCollector|req\.params/);
    }
  });

  it("G-TR17 bare specifiers appear in server.mjs; relative specifiers resolve to files server.mjs imports; seven re-pathed lazy git-tools imports", () => {
    const own = importSpecifiers(src);
    const server = importSpecifiers(serverSrc);
    const serverBare = new Set(server.filter((s) => !isRelative(s)));
    for (const spec of own.filter((s) => !isRelative(s))) expect(serverBare.has(spec), spec).toBe(true);
    const serverResolved = new Set(server.filter(isRelative).map((s) => path.resolve(path.dirname(SERVER_ABS), s)));
    const ownRelative = own.filter(isRelative);
    expect(ownRelative.length).toBeGreaterThan(0);
    for (const spec of ownRelative) {
      const abs = path.resolve(path.dirname(GIT_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      expect(serverResolved.has(abs), spec).toBe(true);
    }
    expect(countOccurrences(src, "await import(")).toBe(7);
    expect(countOccurrences(src, 'await import("../git-tools.mjs")')).toBe(7);
    for (const name of ["runGitStash", "runGitRestore", "runGitReset", "runGitRevert", "runGitTag", "runGitCherryPick"]) {
      expect(serverSrc, name).not.toMatch(new RegExp(`\\{\\s*${name}\\b[^}]*\\}\\s*=\\s*await import\\(`));
    }
  });

  it("G-TR18 every name git.mjs imports is a real export; static git-tools imports are a subset of server.mjs's", async () => {
    const staticGit = namedImports(src, "../git-tools.mjs");
    expect([...staticGit].sort()).toEqual(["runBranchRepair", "runGitBranch", "runGitCheckout", "runGitCommit", "runResolveConflict"]);
    const serverStaticGit = namedImports(serverSrc, "./server/git-tools.mjs");
    for (const n of staticGit) expect(serverStaticGit, n).toContain(n);
    const realGit = await vi.importActual("../../packages/mcp-rks/src/server/git-tools.mjs");
    for (const n of [...staticGit, "runGitStash", "runGitRestore", "runGitReset", "runGitRevert", "runGitTag", "runGitCherryPick"]) {
      expect(typeof realGit[n], n).toBe("function");
    }
    expect(namedImports(src, "../project.mjs")).toEqual(expect.arrayContaining(["loadContext", "getBranchConfig"]));
    expect(namedImports(src, "../../tools/git-push.mjs")).toContain("runGitPush");
    expect(namedImports(src, "../../tools/git-preflight.mjs")).toEqual(expect.arrayContaining(["runGitPreflight", "TOOL_NAME as GIT_PREFLIGHT_TOOL"]));
    expect(namedImports(src, "../../shared/commit-attribution.mjs")).toEqual(expect.arrayContaining(["coAuthorTrailer", "CO_AUTHOR_REJECTED_WARNING"]));
    const tokenNames = ["validateToken", "advanceStateOnResult", "setPendingStash", "clearPendingStash"];
    expect(namedImports(src, "../../shared/governor-token.mjs")).toEqual(expect.arrayContaining(tokenNames));
    const realTok = await vi.importActual("../../packages/mcp-rks/src/shared/governor-token.mjs");
    for (const n of tokenNames) expect(typeof realTok[n], n).toBe("function");
    const realPush = await vi.importActual("../../packages/mcp-rks/src/tools/git-push.mjs");
    expect(typeof realPush.runGitPush).toBe("function");
    const realPreflight = await vi.importActual("../../packages/mcp-rks/src/tools/git-preflight.mjs");
    expect(typeof realPreflight.runGitPreflight).toBe("function");
    expect(realPreflight.TOOL_NAME).toBe("rks_git_preflight");
  });

  it("G-TR19 git.mjs imports nothing from server.mjs and defines no function besides registerGitHandlers", () => {
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src.match(/\bfunction\s+[\w$]+\s*\(/g)).toEqual(["function registerGitHandlers("]);
  });
});
