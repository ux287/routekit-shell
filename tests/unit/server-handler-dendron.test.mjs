/**
 * S4 dendron family handlers (backlog.feat.server-mjs-dendron-handler-family), part of
 * research.2026.10.05.server-mjs-safe-decomposition (D-TR1..D-TR16). Mirrors
 * tests/unit/server-handler-project-meta.test.mjs. Unit tier: no subprocess, no server.mjs import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import * as dendronLib from "../../packages/mcp-rks/src/dendron.mjs";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { readToolHandlerSource } from "../_helpers/server-source.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const HANDLERS_DIR = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers");
const DENDRON_ABS = path.join(HANDLERS_DIR, "dendron.mjs");

// server.mjs order (D-TR11).
const SOURCE_ORDER = [
  "dendron_create_note",
  "dendron_fix_frontmatter",
  "dendron_validate_schema",
  "dendron_edit_note",
  "dendron_read_note",
  "dendron_update_field",
  "dendron_mark_implemented",
];
const DENDRON_TOOLS = [...SOURCE_ORDER].sort();

const SCHEMA_KEY = {
  dendron_create_note: "createNoteSchema",
  dendron_fix_frontmatter: "fixFrontmatterSchema",
  dendron_validate_schema: "validateSchemaSchema",
  dendron_edit_note: "editNoteSchema",
  dendron_update_field: "updateFieldSchema",
  dendron_mark_implemented: "markImplementedSchema",
};

const TELEMETRY_TOOLS = [
  "rks_telemetry_analysis",
  "rks_telemetry_digest",
  "rks_telemetry_export",
  "rks_telemetry_query",
  "rks_telemetry_report",
  "rks_token_cost_report",
];
const PROJECT_META_TOOLS = [
  "rks_git_state",
  "rks_kg_query",
  "rks_project_get",
  "rks_publish",
  "rks_publish_profiles",
  "rks_channel_preview",
  "rks_templates_list",
];

const marker = (tool) => `__s4_marker_${tool}`;

// One required marker key per schema: a {} call fails in zod, naming WHICH injected schema ran.
function markerSchemas() {
  return Object.fromEntries(
    Object.entries(SCHEMA_KEY).map(([tool, key]) => [key, z.object({ [marker(tool)]: z.string() })]),
  );
}

// Real-shaped schemas transcribed from server.mjs for the bodies driven past parse.
function realSchemas() {
  return {
    ...markerSchemas(),
    createNoteSchema: z.object({
      filename: z.string(),
      title: z.string().optional(),
      desc: z.string().optional(),
      content: z.string().optional(),
      testFile: z.string().optional(),
    }),
    fixFrontmatterSchema: z.object({ filename: z.string() }),
    validateSchemaSchema: z.object({ pattern: z.string().optional() }),
    updateFieldSchema: z.object({
      filename: z.string(),
      field: z.string(),
      value: z.union([z.string(), z.array(z.unknown())]),
      acknowledgeRemoval: z.boolean().optional(),
    }),
  };
}

const telemetrySchemas = () => ({
  telemetryQuerySchema: z.object({ projectId: z.string() }),
  telemetryReportSchema: z.object({ projectId: z.string() }),
  telemetryAnalysisSchema: z.object({ projectId: z.string() }),
  tokenCostReportSchema: z.object({ projectId: z.string() }),
  telemetryExportSchema: z.object({ projectId: z.string() }),
});
const projectMetaSchemas = () => ({
  projectGetSchema: z.object({ id: z.string() }),
  kgQuerySchema: z.object({ projectId: z.string() }),
  templatesListSchema: z.object({ prefix: z.string().optional() }),
  gitStateSchema: z.object({ projectId: z.string() }),
  publishSchema: z.object({ projectId: z.string() }),
  publishProfilesSchema: z.object({ projectId: z.string() }),
});

// Stub helpers: the handler must call THESE objects (registration-time injection, not ctx).
function stubHelpers(notesDir) {
  return {
    getDendronContext: vi.fn(() => ({ notesDir })),
    assertNotesDir: vi.fn(),
    notePathFromFilename: vi.fn((dir, filename) => path.join(dir, `${filename}.md`)),
    commitDendronWriteResult: vi.fn(async (arg) => ({ ...(arg && arg.innerResult), stubCommit: true })),
  };
}

const tmpDirs = [];
function tempNotesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-s4-dendron-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOTE = [
  "---",
  'id: "x"',
  'title: "X"',
  'desc: ""',
  "updated: 1",
  "created: 1",
  "---",
  "",
  "hello-dendron-s4",
  "",
  "## Lifecycle",
  "",
  "- s4 lifecycle line",
  "",
].join("\n");

const ctxFor = (tool, args = {}) => Object.freeze({ tool, args, activeToken: undefined, governorToken: undefined });
const payload = (res) => JSON.parse(res.content[0].text);

function countOccurrences(src, needle) {
  let n = 0;
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) n++;
  return n;
}

function importSpecifiers(src) {
  return [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}
const isRelative = (s) => s.startsWith(".");

describe("registerDendronHandlers", () => {
  it("D-TR1 registers exactly the seven dendron tools, each as a function", () => {
    const r = createHandlerRegistry();
    registerDendronHandlers(r, markerSchemas(), stubHelpers("/nonexistent"));
    expect(r.registeredTools()).toEqual(DENDRON_TOOLS);
    for (const tool of DENDRON_TOOLS) expect(typeof r.lookupHandler(tool)).toBe("function");
  });

  it("D-TR2 coexists with the telemetry and project/meta families on one registry (19 tools)", () => {
    const r = createHandlerRegistry();
    registerTelemetryHandlers(r, telemetrySchemas());
    registerProjectMetaHandlers(r, projectMetaSchemas());
    expect(() => registerDendronHandlers(r, markerSchemas(), stubHelpers("/nonexistent"))).not.toThrow();
    expect(r.registeredTools()).toEqual([...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS].sort());
    expect(r.registeredTools()).toHaveLength(20);
    expect(() => registerDendronHandlers(createHandlerRegistry(), markerSchemas(), stubHelpers("/x"))).not.toThrow();
    expect(() => registerDendronHandlers(createHandlerRegistry(), markerSchemas(), stubHelpers("/x"))).not.toThrow();
  });

  it.each(Object.keys(SCHEMA_KEY))("D-TR3 %s rejects {} with a ZodError from its injected schema before any helper runs", async (tool) => {
    const r = createHandlerRegistry();
    const helpers = stubHelpers("/nonexistent");
    registerDendronHandlers(r, markerSchemas(), helpers);
    const err = await r.lookupHandler(tool)({}, ctxFor(tool)).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain(marker(tool));
    expect(helpers.getDendronContext).not.toHaveBeenCalled();
  });

  it("D-TR4 dendron_read_note with no filename returns Missing filename without calling a helper", async () => {
    const r = createHandlerRegistry();
    const helpers = stubHelpers("/nonexistent");
    registerDendronHandlers(r, markerSchemas(), helpers);
    const res = await r.lookupHandler("dendron_read_note")({}, ctxFor("dendron_read_note"));
    expect(payload(res)).toMatchObject({ ok: false, error: "Missing filename" });
    expect(helpers.getDendronContext).not.toHaveBeenCalled();
  });

  it("D-TR5 dendron_read_note calls the INJECTED getDendronContext, assertNotesDir and notePathFromFilename", async () => {
    const dir = tempNotesDir();
    fs.writeFileSync(path.join(dir, "x.md"), NOTE, "utf8");
    const r = createHandlerRegistry();
    const helpers = stubHelpers(dir);
    registerDendronHandlers(r, markerSchemas(), helpers);
    const res = await r.lookupHandler("dendron_read_note")({ filename: "x" }, ctxFor("dendron_read_note", { filename: "x" }));
    const p = payload(res);
    expect(p.ok).toBe(true);
    expect(p.content).toContain("hello-dendron-s4");
    expect(helpers.getDendronContext).toHaveBeenCalledTimes(1);
    expect(helpers.assertNotesDir).toHaveBeenCalledWith(dir);
    expect(helpers.notePathFromFilename).toHaveBeenCalledWith(dir, "x");
  });

  it("D-TR6 dendron_read_note slices from cleanArgs, not ctx.args (the b2 substitution)", async () => {
    const dir = tempNotesDir();
    fs.writeFileSync(path.join(dir, "x.md"), NOTE, "utf8");
    const r = createHandlerRegistry();
    registerDendronHandlers(r, markerSchemas(), stubHelpers(dir));
    // ctx.args deliberately carries NO selection: only cleanArgs can produce the slice.
    const res = await r.lookupHandler("dendron_read_note")(
      { filename: "x", sections: ["Lifecycle"] },
      ctxFor("dendron_read_note", {}),
    );
    const p = payload(res);
    expect(p.ok).toBe(true);
    expect(p.selectionComplete).toBe(true);
    expect(p.content).toContain("## Lifecycle");
    expect(p.content).not.toContain("hello-dendron-s4");
  });

  it("D-TR7 dendron_create_note on an existing note throws McpError through the injected helpers", async () => {
    const dir = tempNotesDir();
    fs.writeFileSync(path.join(dir, "x.md"), NOTE, "utf8");
    const r = createHandlerRegistry();
    const helpers = stubHelpers(dir);
    registerDendronHandlers(r, realSchemas(), helpers);
    const err = await r.lookupHandler("dendron_create_note")({ filename: "x" }, ctxFor("dendron_create_note")).catch((e) => e);
    // By name and code, not instanceof: a second installed copy of the SDK must not redden this.
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("McpError");
    expect(err.code).toBe(-32600); // ErrorCode.InvalidRequest
    expect(err.message).toContain("Note already exists");
    expect(helpers.notePathFromFilename).toHaveBeenCalledWith(dir, "x");
    expect(fs.readFileSync(path.join(dir, "x.md"), "utf8")).toBe(NOTE);
    expect(helpers.commitDendronWriteResult).not.toHaveBeenCalled();
  });

  // ARCH round 1 item 3(a): the create_note success path, no schema in the notes dir.
  it("D-TR14 dendron_create_note writes a new note (no schema) and commits through the INJECTED commitDendronWriteResult", async () => {
    const dir = tempNotesDir();
    const filename = "backlog.feat.s4-fresh";
    const r = createHandlerRegistry();
    const helpers = stubHelpers(dir);
    registerDendronHandlers(r, realSchemas(), helpers);
    const args = { filename, title: "S4 fresh", content: "body-s4-fresh" };
    const res = await r.lookupHandler("dendron_create_note")(args, ctxFor("dendron_create_note", args));
    const p = payload(res);
    expect(p).toMatchObject({ ok: true, id: filename, wrote_verbatim: true });
    expect(p.schema).toBeUndefined();
    const written = path.join(dir, `${filename}.md`);
    expect(fs.existsSync(written)).toBe(true);
    const parsed = dendronLib.parseFrontmatter(fs.readFileSync(written, "utf8"));
    expect(parsed.data.id).toBe(filename);
    expect(parsed.data.title).toBe("S4 fresh");
    expect(parsed.data.phase).toBe("draft");
    expect(parsed.content).toContain("body-s4-fresh");
    expect(helpers.notePathFromFilename).toHaveBeenCalledWith(dir, filename);
    expect(helpers.commitDendronWriteResult).toHaveBeenCalledTimes(1);
    const commitArg = helpers.commitDendronWriteResult.mock.calls[0][0];
    expect(commitArg.tool).toBe("dendron_create_note");
    expect(commitArg.skipCommit).toBe(false);
    expect(commitArg.innerResult).toMatchObject({ ok: true, id: filename });
  });

  // ARCH round 1 item 3(b): the schema-template branch, with caller content that carries its own
  // frontmatter. Exercises hasFrontmatter, parseFrontmatter, findMatchingSchema, loadSchemaTemplate,
  // mergeTemplateWithGenerated, formatWithFrontmatter and writeNoteRaw from the moved body.
  it("D-TR15 dendron_create_note merges a matching schema template", async () => {
    const dir = tempNotesDir();
    fs.writeFileSync(
      path.join(dir, "schema.s4.yml"),
      ["version: 1", "schemas:", "  - id: s4", "    namespace: false", "    template: templates.s4", ""].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "templates.s4.md"),
      [
        "---",
        'id: "templates.s4"',
        'title: "S4 template"',
        'desc: ""',
        "created: 1",
        "updated: 1",
        'templateKey: "from-template"',
        "---",
        "",
        "template-body-s4",
        "",
      ].join("\n"),
      "utf8",
    );
    const filename = "s4.child";
    const content = ["---", 'callerKey: "from-caller"', "---", "", "caller-body-s4", ""].join("\n");
    const r = createHandlerRegistry();
    const helpers = stubHelpers(dir);
    registerDendronHandlers(r, realSchemas(), helpers);
    const args = { filename, content };
    const res = await r.lookupHandler("dendron_create_note")(args, ctxFor("dendron_create_note", args));
    const p = payload(res);
    expect(p).toMatchObject({ ok: true, id: filename, schema: "s4", wrote_verbatim: true });
    const written = path.join(dir, `${filename}.md`);
    expect(fs.existsSync(written)).toBe(true);
    const parsed = dendronLib.parseFrontmatter(fs.readFileSync(written, "utf8"));
    expect(parsed.data.id).toBe(filename);
    expect(parsed.data.templateKey).toBe("from-template");
    expect(parsed.data.callerKey).toBe("from-caller");
    expect(parsed.content).toContain("caller-body-s4");
    expect(parsed.content).not.toContain("template-body-s4");
    expect(helpers.commitDendronWriteResult).toHaveBeenCalledTimes(1);
    const commitArg = helpers.commitDendronWriteResult.mock.calls[0][0];
    expect(commitArg.tool).toBe("dendron_create_note");
    expect(commitArg.innerResult).toMatchObject({ ok: true, schema: "s4" });
  });

  it.each([
    ["dendron_fix_frontmatter", { filename: "x" }],
    ["dendron_update_field", { filename: "x", field: "title", value: "Y" }],
  ])("D-TR8 %s commits through the INJECTED commitDendronWriteResult", async (tool, args) => {
    const dir = tempNotesDir();
    fs.writeFileSync(path.join(dir, "x.md"), NOTE, "utf8");
    const r = createHandlerRegistry();
    const helpers = stubHelpers(dir);
    registerDendronHandlers(r, realSchemas(), helpers);
    await r.lookupHandler(tool)(args, ctxFor(tool, args));
    expect(helpers.commitDendronWriteResult).toHaveBeenCalledTimes(1);
    expect(helpers.commitDendronWriteResult.mock.calls[0][0].tool).toBe(tool);
  });

  // AC8: the S0 sweep fails in zod before the lazy import, so drive the body to success here.
  it("D-TR9 dendron_validate_schema resolves glob from handlers/dendron.mjs and reports the note", async () => {
    const dir = tempNotesDir();
    fs.writeFileSync(path.join(dir, "a.md"), NOTE, "utf8");
    const r = createHandlerRegistry();
    registerDendronHandlers(r, realSchemas(), stubHelpers(dir));
    const res = await r.lookupHandler("dendron_validate_schema")({ pattern: "*.md" }, ctxFor("dendron_validate_schema"));
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("a.md");
  });
});

describe("dendron.mjs source", () => {
  const src = fs.readFileSync(DENDRON_ABS, "utf8");
  const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");

  it("D-TR10 specifiers are byte-identical to server.mjs; relative specifiers resolve to files server.mjs imports; one lazy glob import", () => {
    expect(src).toMatch(/import fs from "fs";/);
    expect(src).toMatch(/import path from "path";/);
    expect(src).not.toMatch(/from "node:(fs|path)"/);
    expect(src).toMatch(/from\s+"@modelcontextprotocol\/sdk\/types\.js"/);
    expect(countOccurrences(src, 'await import("glob")')).toBe(1);
    expect(countOccurrences(serverSrc, 'await import("glob")')).toBe(0);

    const own = importSpecifiers(src);
    const server = importSpecifiers(serverSrc);
    expect(own.length).toBeGreaterThan(0);
    const serverBare = new Set(server.filter((s) => !isRelative(s)));
    for (const spec of own.filter((s) => !isRelative(s))) expect(serverBare.has(spec), spec).toBe(true);
    const serverResolved = new Set(server.filter(isRelative).map((s) => path.resolve(path.dirname(SERVER_ABS), s)));
    const ownRelative = own.filter(isRelative);
    expect(ownRelative.length).toBeGreaterThan(0);
    for (const spec of ownRelative) {
      const abs = path.resolve(path.dirname(DENDRON_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      expect(serverResolved.has(abs), spec).toBe(true);
    }
  });

  it("D-TR11 registers the seven in server.mjs order, each exactly once", () => {
    const positions = SOURCE_ORDER.map((tool) => {
      const head = `registerHandler("${tool}"`;
      const at = src.indexOf(head);
      expect(at, tool).toBeGreaterThan(-1);
      expect(src.indexOf(head, at + 1), tool).toBe(-1);
      return at;
    });
    for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
  });

  it.each(SOURCE_ORDER)("D-TR12 %s keeps the frozen wrapper and reads no ctx, raw args or chain state", (tool) => {
    const wrapper = `registerHandler("${tool}", async (cleanArgs, ctx) =>`;
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(wrapper)).toBe(true);
    const body = slice.slice(wrapper.length);
    expect(body).not.toMatch(/\bctx\b/);
    expect(body).not.toMatch(/(?<![\w$.])args\b/);
    expect(body).not.toMatch(
      /activeToken|governorToken|advanceStateOnResult|revertStateOnFailure|pendingPlans|getTelemetryCollector|req\.params/,
    );
  });

  it("D-TR13 the four helpers stay defined once in server.mjs and are defined in no handler module", () => {
    const defs = [
      "function getDendronContext(",
      "function assertNotesDir(",
      "function notePathFromFilename(",
      "async function commitDendronWriteResult(",
    ];
    for (const d of defs) expect(countOccurrences(serverSrc, d), d).toBe(1);
    for (const f of fs.readdirSync(HANDLERS_DIR).filter((n) => n.endsWith(".mjs"))) {
      const hs = fs.readFileSync(path.join(HANDLERS_DIR, f), "utf8");
      for (const d of defs) expect(hs.includes(d), `${f} defines ${d}`).toBe(false);
    }
  });

  // ARCH round 1 item 3(b), static half: a dropped import fails here even on a branch no case runs.
  it("D-TR16 dendron.mjs names every library binding the seven bodies use, and each is exported", () => {
    const DENDRON_LIB_NAMES = [
      "readNoteRaw",
      "writeNoteRaw",
      "hasFrontmatter",
      "frontmatterDefaults",
      "formatWithFrontmatter",
      "parseFrontmatter",
      "validateNoteFrontmatter",
      "canonicalIdFromFilename",
      "findMatchingSchema",
      "loadSchemaTemplate",
      "mergeTemplateWithGenerated",
      "updateField",
      "updateFieldDirect",
    ];
    const namedFrom = (spec) => {
      const esc = spec.replace(/[.*+?^$()|[\]\\/{}]/g, "\\$&");
      const m = src.match(new RegExp("import\\s*\\{([^}]*)\\}\\s*from\\s*\"" + esc + "\""));
      expect(m, spec).not.toBeNull();
      return m[1].split(",").map((s) => s.trim()).filter(Boolean);
    };
    const fromDendron = namedFrom("../../dendron.mjs");
    expect(DENDRON_LIB_NAMES).toHaveLength(13);
    for (const name of DENDRON_LIB_NAMES) {
      expect(fromDendron, name).toContain(name);
      expect(typeof dendronLib[name], name).toBe("function");
    }
    expect(namedFrom("../../shared/frontmatter.mjs")).toEqual(
      expect.arrayContaining(["spliceNoteFrontmatter", "spliceNoteFrontmatterWithBody"]),
    );
    expect(namedFrom("../../shared/note-slice.mjs")).toContain("sliceNote");
    expect(namedFrom("@modelcontextprotocol/sdk/types.js")).toEqual(expect.arrayContaining(["ErrorCode", "McpError"]));
  });
});
