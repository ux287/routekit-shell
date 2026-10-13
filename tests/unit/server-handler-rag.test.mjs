/**
 * S5 RAG family handlers (backlog.feat.server-mjs-rag-handler-family), part of
 * research.2026.10.05.server-mjs-safe-decomposition. Mirrors
 * tests/unit/server-handler-dendron.test.mjs. Unit tier: no subprocess, no server.mjs import,
 * no vi.resetModules. Every RAG entry point is a vi.fn: no model download, no embed, no index
 * write, no network, no git (the real runExhaustiveSearch spawns git via computeGitAnchor).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";

const h = vi.hoisted(() => {
  // Belt and braces: set before any import resolves @routekit/rag.
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
  return {
    runRagEmbed: vi.fn(),
    runRagInit: vi.fn(),
    runRagReset: vi.fn(),
    runRagQuery: vi.fn(),
    runRagCompact: vi.fn(),
    ensureRagIndex: vi.fn(),
    runExhaustiveSearch: vi.fn(),
    resolveFidelityCeiling: vi.fn(),
    commitAndEmbedNote: vi.fn(),
    fetchRaw: vi.fn(),
  };
});

vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  runRagEmbed: h.runRagEmbed,
  runRagInit: h.runRagInit,
  runRagReset: h.runRagReset,
  runRagQuery: h.runRagQuery,
  runRagCompact: h.runRagCompact,
  ensureRagIndex: h.ensureRagIndex,
  runExhaustiveSearch: h.runExhaustiveSearch,
  resolveFidelityCeiling: h.resolveFidelityCeiling,
}));
vi.mock("../../packages/mcp-rks/src/shared/commit-and-embed-note.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  commitAndEmbedNote: h.commitAndEmbedNote,
}));
// The lazy import in the moved rks_fetch_raw body is "../../agents/fetch-raw.mjs" relative to
// handlers/; this mock is keyed on the resolved file, so reaching it proves the re-path.
vi.mock("../../packages/mcp-rks/src/agents/fetch-raw.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchRaw: h.fetchRaw,
}));

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { registerRagHandlers } from "../../packages/mcp-rks/src/server/handlers/rag.mjs";
import { readToolHandlerSource } from "../_helpers/server-source.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const HANDLERS_DIR = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers");
const RAG_ABS = path.join(HANDLERS_DIR, "rag.mjs");

const SOURCE_ORDER = [
  "rks_rag_init",
  "rks_rag_embed",
  "rks_rag_query",
  "rks_exhaustive_search",
  "rks_rag_compact",
  "rks_memory_save",
  "rks_fetch_raw",
];
const RAG_TOOLS = [...SOURCE_ORDER].sort();
const SCHEMA_KEY = {
  rks_rag_init: "ragInitSchema",
  rks_rag_embed: "ragEmbedSchema",
  rks_rag_query: "ragQuerySchema",
  rks_rag_compact: "ragCompactSchema",
  rks_memory_save: "memorySaveSchema",
  rks_fetch_raw: "fetchRawSchema",
};
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_update_field", "dendron_validate_schema"];

const marker = (tool) => `__s5_marker_${tool}`;
const markerSchemas = () =>
  Object.fromEntries(Object.entries(SCHEMA_KEY).map(([tool, key]) => [key, z.object({ [marker(tool)]: z.string() })]));
// Transcribed from server.mjs (ragInitSchema .. ragCompactSchema, memorySaveSchema, fetchRawSchema).
const realSchemas = () => ({
  ragInitSchema: z.object({ projectId: z.string(), reset: z.boolean().optional() }),
  ragEmbedSchema: z.object({ projectId: z.string(), glob: z.string().optional(), files: z.array(z.string()).optional() }),
  ragQuerySchema: z.object({
    projectId: z.string(),
    q: z.string(),
    k: z.number().int().positive().max(20).optional(),
    role: z.enum(["scout", "planner", "executor", "auditor"]).optional(),
  }),
  ragCompactSchema: z.object({ projectId: z.string() }),
  memorySaveSchema: z.object({ projectId: z.string(), slug: z.string(), content: z.string(), title: z.string().optional(), desc: z.string().optional() }),
  fetchRawSchema: z.object({ projectId: z.string(), url: z.string(), timeoutMs: z.number().optional(), maxBytes: z.number().optional() }),
});
const stubHelpers = () => ({
  getDendronContext: vi.fn(() => ({ projectRoot: "/injected/s5-root", notesDir: "/injected/s5-root/notes" })),
});

const PROJECT_ID = "s5-rag-handler-fixture";
const saved = {};
let FIX;
beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.ensureRagIndex.mockResolvedValue(undefined);
  h.runRagQuery.mockResolvedValue({ ok: true, matches: [{ id: "m1" }] });
  h.resolveFidelityCeiling.mockReturnValue("full");
  // Non-git temp project (hasGitRepo is an fs check); realpath so /var vs /private/var never differs.
  FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s5-rag-")));
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

const ctxFor = (tool, args = {}) => Object.freeze({ tool, args, activeToken: undefined, governorToken: undefined });
const payload = (res) => JSON.parse(res.content[0].text);
function ragRegistry(schemas = realSchemas(), helpers = stubHelpers()) {
  const r = createHandlerRegistry();
  registerRagHandlers(r, schemas, helpers);
  return { r, helpers, call: (tool, args) => r.lookupHandler(tool)(args, ctxFor(tool, args)) };
}
const RAG_STUBS = () => [h.runRagEmbed, h.runRagInit, h.runRagReset, h.runRagQuery, h.runRagCompact, h.ensureRagIndex, h.runExhaustiveSearch];
function countOccurrences(src, needle) {
  let n = 0;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) n++;
  return n;
}
const importSpecifiers = (src) => [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
const isRelative = (s) => s.startsWith(".");

describe("registerRagHandlers", () => {
  it("R-TR1 registers exactly the seven RAG tools, each as a function", () => {
    const { r } = ragRegistry(markerSchemas());
    expect(r.registeredTools()).toEqual(RAG_TOOLS);
    for (const tool of RAG_TOOLS) expect(typeof r.lookupHandler(tool)).toBe("function");
  });

  it("R-TR2 coexists with the telemetry, project/meta and dendron families (26 tools)", () => {
    const r = createHandlerRegistry();
    const pid = z.object({ projectId: z.string() });
    registerTelemetryHandlers(r, { telemetryQuerySchema: pid, telemetryReportSchema: pid, telemetryAnalysisSchema: pid, tokenCostReportSchema: pid, telemetryExportSchema: pid });
    registerProjectMetaHandlers(r, { projectGetSchema: z.object({ id: z.string() }), kgQuerySchema: pid, templatesListSchema: z.object({}), gitStateSchema: pid, publishSchema: pid, publishProfilesSchema: pid });
    const any = z.object({});
    registerDendronHandlers(
      r,
      { createNoteSchema: any, fixFrontmatterSchema: any, validateSchemaSchema: any, editNoteSchema: any, updateFieldSchema: any, markImplementedSchema: any },
      { getDendronContext: vi.fn(), assertNotesDir: vi.fn(), notePathFromFilename: vi.fn(), commitDendronWriteResult: vi.fn() },
    );
    expect(() => registerRagHandlers(r, markerSchemas(), stubHelpers())).not.toThrow();
    expect(r.registeredTools()).toEqual([...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS].sort());
    expect(r.registeredTools()).toHaveLength(26);
    expect(() => registerRagHandlers(createHandlerRegistry(), markerSchemas(), stubHelpers())).not.toThrow();
  });

  it.each(Object.keys(SCHEMA_KEY))("R-TR3 %s rejects {} with a ZodError from its injected schema before any dependency runs", async (tool) => {
    const { call, helpers } = ragRegistry(markerSchemas());
    const err = await call(tool, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain(marker(tool));
    for (const fn of RAG_STUBS()) expect(fn).not.toHaveBeenCalled();
    expect(helpers.getDendronContext).not.toHaveBeenCalled();
    expect(h.commitAndEmbedNote).not.toHaveBeenCalled();
    expect(h.fetchRaw).not.toHaveBeenCalled();
  });

  it("R-TR4 rks_exhaustive_search with {} returns ok:false naming projectId and never searches", async () => {
    const { call } = ragRegistry();
    const p = payload(await call("rks_exhaustive_search", {}));
    expect(p.ok).toBe(false);
    expect(p.error).toContain("projectId is required");
    expect(h.runExhaustiveSearch).not.toHaveBeenCalled();
  });

  it("R-TR5 rks_exhaustive_search projects cleanArgs into runExhaustiveSearch and returns its result; a throw becomes ok:false", async () => {
    const result = { ok: true, exhaustive: true, matchCount: 1, results: [{ file: "a.md", line: 1, text: "x" }] };
    h.runExhaustiveSearch.mockReturnValue(result);
    const { call } = ragRegistry();
    const args = { projectId: PROJECT_ID, pattern: "needle", path: "notes", countOnly: true, maxResults: 5 };
    expect(payload(await call("rks_exhaustive_search", args))).toEqual(result);
    expect(h.runExhaustiveSearch).toHaveBeenCalledTimes(1);
    expect(h.runExhaustiveSearch).toHaveBeenCalledWith(FIX, { pattern: "needle", path: "notes", countOnly: true, maxResults: 5 });
    h.runExhaustiveSearch.mockImplementation(() => { throw new Error("s5 search exploded"); });
    expect(payload(await call("rks_exhaustive_search", args))).toEqual({ ok: false, error: "s5 search exploded" });
  });

  it("R-TR6 rks_rag_query ensures the index, does not embed, and queries with a null capability token", async () => {
    const { call } = ragRegistry();
    const p = payload(await call("rks_rag_query", { projectId: PROJECT_ID, q: "registerRagHandlers", k: 3 }));
    expect(h.ensureRagIndex).toHaveBeenCalledTimes(1);
    expect(h.ensureRagIndex).toHaveBeenCalledWith(FIX);
    expect(h.runRagEmbed).not.toHaveBeenCalled();
    expect(h.runRagQuery).toHaveBeenCalledWith(FIX, { q: "registerRagHandlers", k: 3, capabilityToken: null });
    expect(p).toMatchObject({ ok: true, projectId: PROJECT_ID, matches: [{ id: "m1" }], role: null, fidelityApplied: "L3 (owned corpus)" });
  });

  it("R-TR7 rks_rag_query with role scout mints a capability token and reports L<n>", async () => {
    const { call } = ragRegistry();
    const p = payload(await call("rks_rag_query", { projectId: PROJECT_ID, q: "x", role: "scout" }));
    expect(h.runRagQuery.mock.calls[0][1].capabilityToken).not.toBeNull();
    expect(p.role).toBe("scout");
    expect(p.fidelityApplied).toMatch(/^L\d+$/);
  });

  it("R-TR8 rks_rag_query auto-embed fallback: ensure rejects then embeds notes; both reject then ok:false", async () => {
    const { call } = ragRegistry();
    h.ensureRagIndex.mockRejectedValue(new Error("stale"));
    h.runRagEmbed.mockResolvedValue({ ok: true });
    await call("rks_rag_query", { projectId: PROJECT_ID, q: "x" });
    expect(h.runRagEmbed).toHaveBeenCalledWith(FIX, { glob: "notes/**/*.md" });
    expect(h.runRagQuery).toHaveBeenCalledTimes(1);

    h.runRagQuery.mockClear();
    h.runRagEmbed.mockRejectedValue(new Error("s5 embed exploded"));
    const p = payload(await call("rks_rag_query", { projectId: PROJECT_ID, q: "x" }));
    expect(p).toEqual({ ok: false, error: "RAG index stale and auto-embed failed: s5 embed exploded" });
    expect(h.runRagQuery).not.toHaveBeenCalled();
  });

  it("R-TR9 rks_rag_embed on a non-git fixture passes glob/files positionally and echoes files", async () => {
    h.runRagEmbed.mockResolvedValue({ ok: true, indexed: 10, corpusRowTotal: 10, processedNotes: 1, fileOutcomes: [{ file: "notes/a.md", outcome: "embedded" }] });
    const { call } = ragRegistry();
    const p = payload(await call("rks_rag_embed", { projectId: PROJECT_ID, files: ["notes/a.md"] }));
    expect(h.runRagEmbed).toHaveBeenCalledTimes(1);
    expect(h.runRagEmbed).toHaveBeenCalledWith(FIX, { glob: undefined, files: ["notes/a.md"] });
    expect(p).toMatchObject({ ok: true, projectId: PROJECT_ID, projectRoot: FIX, glob: null, files: ["notes/a.md"], indexed: 10, corpusRowTotal: 10, processedNotes: 1 });
    expect(p.fileOutcomes).toEqual([{ file: "notes/a.md", outcome: "embedded" }]);
  });

  it("R-TR10 rks_rag_init routes reset:true to runRagReset and the default to runRagInit", async () => {
    h.runRagReset.mockResolvedValue({ ok: true, db: "db", rowsBeforeReset: 4, tableDropped: true, manifestPath: "m" });
    h.runRagInit.mockResolvedValue({ ok: true, db: "db" });
    const { call } = ragRegistry();
    const reset = payload(await call("rks_rag_init", { projectId: PROJECT_ID, reset: true }));
    expect(h.runRagReset).toHaveBeenCalledWith(FIX);
    expect(h.runRagInit).not.toHaveBeenCalled();
    expect(reset).toMatchObject({ ok: true, reset: true, rowsBeforeReset: 4, tableDropped: true });
    expect(reset.message).toContain("dropped 4 row(s)");
    h.runRagReset.mockClear();
    const init = payload(await call("rks_rag_init", { projectId: PROJECT_ID }));
    expect(h.runRagInit).toHaveBeenCalledWith(FIX);
    expect(h.runRagReset).not.toHaveBeenCalled();
    expect(init).toMatchObject({ ok: true, reset: false, message: "RAG database initialized" });
  });

  it("R-TR11 rks_rag_compact spreads the result on success and reports ok:false on throw", async () => {
    h.runRagCompact.mockResolvedValue({ compacted: 3 });
    const { call } = ragRegistry();
    expect(payload(await call("rks_rag_compact", { projectId: PROJECT_ID }))).toEqual({ ok: true, projectId: PROJECT_ID, compacted: 3 });
    expect(h.runRagCompact).toHaveBeenCalledWith(FIX);
    h.runRagCompact.mockRejectedValue(new Error("s5 compact exploded"));
    expect(payload(await call("rks_rag_compact", { projectId: PROJECT_ID }))).toEqual({ ok: false, error: "s5 compact exploded" });
  });

  it("R-TR12 rks_memory_save takes its root from the INJECTED getDendronContext and calls commitAndEmbedNote once", async () => {
    h.commitAndEmbedNote.mockResolvedValue({ ok: true, notePath: "notes/memory.s5.md" });
    const { call, helpers } = ragRegistry();
    const args = { projectId: "ignored-for-root", slug: "s5-slug", content: "c", title: "T", desc: "D" };
    const p = payload(await call("rks_memory_save", args));
    expect(helpers.getDendronContext).toHaveBeenCalledTimes(1);
    expect(h.commitAndEmbedNote).toHaveBeenCalledTimes(1);
    expect(h.commitAndEmbedNote).toHaveBeenCalledWith({ projectRoot: "/injected/s5-root", slug: "s5-slug", content: "c", title: "T", desc: "D" });
    expect(p).toEqual({ ok: true, notePath: "notes/memory.s5.md" });
  });

  it("R-TR13 rks_fetch_raw reaches the mocked agents/fetch-raw.mjs through the re-pathed lazy import", async () => {
    h.fetchRaw.mockResolvedValue({ ok: false, reason: "host_not_allowlisted" });
    const { call } = ragRegistry();
    const args = { projectId: PROJECT_ID, url: "https://example.invalid/s5", timeoutMs: 1000, maxBytes: 2048 };
    const p = payload(await call("rks_fetch_raw", args));
    expect(h.fetchRaw).toHaveBeenCalledTimes(1);
    expect(h.fetchRaw).toHaveBeenCalledWith("https://example.invalid/s5", { projectRoot: FIX, projectId: PROJECT_ID, timeoutMs: 1000, maxBytes: 2048 });
    expect(p).toEqual({ ok: false, reason: "host_not_allowlisted" });
  });
});

describe("rag.mjs source", () => {
  const src = fs.readFileSync(RAG_ABS, "utf8");
  const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");

  it("R-TR14 registers the seven in server.mjs order, each once, behind the frozen wrapper, reading no ctx or chain state", () => {
    const positions = SOURCE_ORDER.map((tool) => {
      const head = `registerHandler("${tool}"`;
      const at = src.indexOf(head);
      expect(at, tool).toBeGreaterThan(-1);
      expect(src.indexOf(head, at + 1), tool).toBe(-1);
      return at;
    });
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    for (const tool of SOURCE_ORDER) {
      const wrapper = `registerHandler("${tool}", async (cleanArgs, ctx) =>`;
      const slice = readToolHandlerSource(tool);
      expect(slice.startsWith(wrapper), tool).toBe(true);
      const body = slice.slice(wrapper.length);
      expect(body, tool).not.toMatch(/\bctx\b/);
      expect(body, tool).not.toMatch(/(?<![\w$.])args\b/);
      expect(body, tool).not.toMatch(/activeToken|governorToken|advanceStateOnResult|revertStateOnFailure|pendingPlans|getTelemetryCollector|req\.params/);
    }
  });

  it("R-TR15 bare specifiers byte-identical to server.mjs; relative specifiers resolve to files server.mjs imports; one lazy import", () => {
    const own = importSpecifiers(src);
    const server = importSpecifiers(serverSrc);
    const serverBare = new Set(server.filter((s) => !isRelative(s)));
    for (const spec of own.filter((s) => !isRelative(s))) expect(serverBare.has(spec), spec).toBe(true);
    const serverResolved = new Set(server.filter(isRelative).map((s) => path.resolve(path.dirname(SERVER_ABS), s)));
    const ownRelative = own.filter(isRelative);
    expect(ownRelative.length).toBeGreaterThan(0);
    for (const spec of ownRelative) {
      const abs = path.resolve(path.dirname(RAG_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      expect(serverResolved.has(abs), spec).toBe(true);
    }
    expect(countOccurrences(src, "await import(")).toBe(1);
    expect(countOccurrences(src, 'await import("../../agents/fetch-raw.mjs")')).toBe(1);
    expect(fs.existsSync(path.resolve(path.dirname(RAG_ABS), "../../agents/fetch-raw.mjs"))).toBe(true);
    expect(countOccurrences(serverSrc, 'await import("./agents/fetch-raw.mjs")')).toBe(0);
  });

  it("R-TR16 rag.mjs names every binding the seven bodies use, and each is a real export", async () => {
    const namedFrom = (spec) => {
      const esc = spec.replace(/[.*+?^$()|[\]\\/{}]/g, "\\$&");
      const m = src.match(new RegExp("import\\s*\\{([^}]*)\\}\\s*from\\s*\"" + esc + "\""));
      expect(m, spec).not.toBeNull();
      return m[1].split(",").map((s) => s.trim()).filter(Boolean);
    };
    const RAG_NAMES = ["runRagEmbed", "runRagInit", "runRagReset", "runRagQuery", "runRagCompact", "ensureRagIndex", "runExhaustiveSearch", "resolveFidelityCeiling"];
    const fromRag = namedFrom("@routekit/rag");
    const realRag = await vi.importActual("@routekit/rag");
    for (const name of RAG_NAMES) {
      expect(fromRag, name).toContain(name);
      expect(typeof realRag[name], name).toBe("function");
    }
    expect(fromRag).not.toContain("setRagHostHooks");
    expect(namedFrom("@routekit/rag/capability-token")).toContain("createCapabilityToken");
    expect(namedFrom("@routekit/rag/capability-profiles")).toContain("AGENT_ROLES");
    expect(namedFrom("../exec.mjs")).toEqual(expect.arrayContaining(["hasGitRepo", "getCurrentBranch"]));
    expect(namedFrom("../project.mjs")).toEqual(expect.arrayContaining(["loadContext", "getBranchConfig"]));
    expect(namedFrom("../../shared/commit-and-embed-note.mjs")).toContain("commitAndEmbedNote");
    expect(namedFrom("@modelcontextprotocol/sdk/types.js")).toEqual(expect.arrayContaining(["ErrorCode", "McpError"]));
  });

  it("R-TR17 getDendronContext stays defined once in server.mjs and in no handler module; setRagHostHooks stays in server.mjs", () => {
    expect(countOccurrences(serverSrc, "function getDendronContext(")).toBe(1);
    for (const f of fs.readdirSync(HANDLERS_DIR).filter((n) => n.endsWith(".mjs"))) {
      const hs = fs.readFileSync(path.join(HANDLERS_DIR, f), "utf8");
      expect(hs.includes("function getDendronContext("), f).toBe(false);
    }
    expect(serverSrc).toContain("setRagHostHooks(");
    expect(src).not.toContain("setRagHostHooks");
  });

  it("R-TR18 neither rag.mjs nor server.mjs writes the bare short path the call-sites guard forbids", () => {
    const short = "server/" + "rag.mjs";
    for (const [name, text] of [["rag.mjs", src], ["server.mjs", serverSrc]]) {
      const hits = text.split("\n").filter((l) => l.includes(short));
      expect(hits, name).toEqual([]);
    }
  });
});
