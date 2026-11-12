/**
 * backlog.feat.dendron-update-fields-multi-field
 *
 * dendron_update_fields({ filename, fields, acknowledgeRemoval? }) sets N frontmatter fields in
 * ONE write and ONE commit, through updateField's own validation and emission path, and is
 * admitted exactly where dendron_update_field is. A new write tool that skips any admission
 * table is a bypass, so parity is asserted by enumeration, not by spot checks.
 *
 * Unit tier: no subprocess is spawned here. server.mjs is imported (for TOOL_ARG_SCHEMAS,
 * TOOL_TO_AGENT_MAP and an in-process ListTools/CallTool) with ROUTEKIT_PROJECT_ROOT pointed at a
 * temp root, so nothing touches this repository.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import { updateField, updateFields, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";
import { getStates, QA_FLOW_TOOLS } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import {
  setProjectRoot,
  resetToken,
  createSession,
  getSession,
  assertToolAllowed,
  isProtectedTool,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
  DENDRON_WRITE_TOOLS,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { TOOL_AGENTS } from "../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs";
import { buildDendronCommitMessage } from "../../packages/mcp-rks/src/shared/dendron-commit-message.mjs";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";

const NOTE = "backlog.feat.multi";
const BASE = "---\nid: \"backlog.feat.multi\"\ntitle: \"t\"\nphase: \"draft\"\ntestRequirements:\n  - \"one\"\n  - \"two\"\n---\n\nbody\n";

const notePath = (dir) => path.join(dir, `${NOTE}.md`);
const readNote = (dir) => fs.readFileSync(notePath(dir), "utf8");
const readFm = (dir) => parseFrontmatter(readNote(dir)).data;

/** The column-0 line(s) of one key's block in the raw frontmatter. */
function keyBlock(raw, key) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)[1].split("\n");
  const start = fm.findIndex((l) => l.startsWith(`${key}:`));
  if (start === -1) return null;
  let end = start + 1;
  while (end < fm.length && (/^[ \t]/.test(fm[end]) || /^-( |$)/.test(fm[end]))) end += 1;
  return fm.slice(start, end).join("\n");
}

// server.mjs is imported once, against a temp project root.
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
let serverRoot;
let server;

beforeAll(async () => {
  serverRoot = makeTempDir("dendron_update_fields_server");
  fs.mkdirSync(path.join(serverRoot, "notes"), { recursive: true });
  writeFile(path.join(serverRoot, "notes", `${NOTE}.md`), BASE);
  process.env.ROUTEKIT_PROJECT_ROOT = serverRoot;
  server = await import("../../packages/mcp-rks/src/server.mjs");
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
});

async function withClient(fn) {
  const srv = server.createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([srv.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

describe("updateFields — one write, same emission path as updateField", () => {
  let notesDir;
  beforeEach(() => {
    notesDir = makeTempDir("dendron_update_fields");
    writeFile(notePath(notesDir), BASE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a string field and an array field in a single file write", () => {
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    const res = updateFields(notesDir, NOTE, { title: "x", testFiles: ["y"] });
    expect(res.ok).toBe(true);
    const noteWrites = writeSpy.mock.calls.filter(([p]) => String(p).startsWith(notePath(notesDir)));
    expect(noteWrites).toHaveLength(1);
    writeSpy.mockRestore();
    const fm = readFm(notesDir);
    expect(fm.title).toBe("x");
    expect(fm.testFiles).toEqual(["y"]);
    // One per-field entry for each written field, in call order.
    expect(res.fields.map((f) => f.field)).toEqual(["title", "testFiles"]);
  });

  it("YAML-hazard values parse back exactly and emit the line updateField emits", () => {
    const hazards = { desc: '"quoted start', title: "{ braces }", status: "a: b" };
    expect(updateFields(notesDir, NOTE, hazards).ok).toBe(true);
    const multiRaw = readNote(notesDir);
    const fm = parseFrontmatter(multiRaw).data;
    for (const [k, v] of Object.entries(hazards)) expect(fm[k]).toBe(v);

    for (const [k, v] of Object.entries(hazards)) {
      const singleDir = makeTempDir("dendron_update_field_single");
      writeFile(notePath(singleDir), BASE);
      expect(updateField(singleDir, NOTE, k, v).ok).toBe(true);
      const singleLine = keyBlock(readNote(singleDir), k);
      expect(singleLine, k).not.toBeNull();
      expect(keyBlock(multiRaw, k), k).toBe(singleLine);
    }
  });

  it("refuses all-or-nothing and names every refused field with a reason", () => {
    const before = readNote(notesDir);
    const res = updateFields(notesDir, NOTE, { title: "ok", arch_verdict: "approved", testRequirements: ["one"] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("fields_refused");
    expect(readNote(notesDir)).toBe(before);
    const byField = Object.fromEntries(res.refused.map((r) => [r.field, r]));
    expect(Object.keys(byField).sort()).toEqual(["arch_verdict", "testRequirements"]);
    expect(byField.arch_verdict.reason).toBe("arch_reserved_field");
    expect(byField.testRequirements.reason).toBe("array_entries_removed");
    for (const r of res.refused) expect(typeof r.detail).toBe("string");
  });

  it("with acknowledgeRemoval an array shrink is written and reported per field", () => {
    const res = updateFields(notesDir, NOTE, { testRequirements: ["one"], title: "z" }, { acknowledgeRemoval: true });
    expect(res.ok).toBe(true);
    const entry = res.fields.find((f) => f.field === "testRequirements");
    expect(entry).toMatchObject({ beforeCount: 2, afterCount: 1, removed: ["two"] });
    expect(readFm(notesDir).testRequirements).toEqual(["one"]);
  });
});

describe("dendron_update_fields handler", () => {
  let notesDir;
  beforeEach(() => {
    notesDir = makeTempDir("dendron_update_fields_handler");
    writeFile(notePath(notesDir), BASE);
  });

  function setup() {
    const helpers = {
      getDendronContext: vi.fn(() => ({ notesDir })),
      assertNotesDir: vi.fn(),
      notePathFromFilename: vi.fn((dir, filename) => path.join(dir, `${filename}.md`)),
      commitDendronWriteResult: vi.fn(async ({ innerResult }) => ({
        ...innerResult,
        writeOk: true,
        commitOk: true,
        commitId: "abc1234",
      })),
    };
    const any = z.any();
    const r = createHandlerRegistry();
    registerDendronHandlers(
      r,
      {
        createNoteSchema: any,
        fixFrontmatterSchema: any,
        validateSchemaSchema: any,
        editNoteSchema: any,
        updateFieldSchema: any,
        updateFieldsSchema: server.TOOL_ARG_SCHEMAS.dendron_update_fields,
        markImplementedSchema: any,
      },
      helpers,
    );
    const call = async (args) => {
      const res = await r.lookupHandler("dendron_update_fields")(args, Object.freeze({ tool: "dendron_update_fields", args }));
      return JSON.parse(res.content[0].text);
    };
    return { helpers, call };
  }

  it("commits exactly once through the injected commitDendronWriteResult and reports per field", async () => {
    const { helpers, call } = setup();
    const p = await call({ filename: NOTE, fields: { title: "x", testFiles: ["y"] } });
    expect(helpers.commitDendronWriteResult).toHaveBeenCalledTimes(1);
    expect(helpers.commitDendronWriteResult.mock.calls[0][0].tool).toBe("dendron_update_fields");
    expect(p).toMatchObject({ writeOk: true, commitOk: true, commitId: "abc1234" });
    expect(p.fields.map((f) => f.field)).toEqual(["title", "testFiles"]);
  });

  it("a refusal leaves the note unchanged and never reaches commitDendronWriteResult", async () => {
    const { helpers, call } = setup();
    const before = readNote(notesDir);
    const p = await call({ filename: NOTE, fields: { arch_verdict: "approved", testRequirements: ["one"] } });
    expect(p.ok).toBe(false);
    expect(p.writeOk).toBe(false);
    expect(p.commitOk).toBe(false);
    expect(p.refused.map((r) => r.field).sort()).toEqual(["arch_verdict", "testRequirements"]);
    for (const r of p.refused) expect(r.reason).toBeTruthy();
    expect(readNote(notesDir)).toBe(before);
    expect(helpers.commitDendronWriteResult).not.toHaveBeenCalled();
  });
});

describe("assertToolAllowed parity with dendron_update_field", () => {
  beforeEach(() => {
    resetToken();
    // Session records persist under the project root; keep them out of this repository.
    setProjectRoot(makeTempDir("dendron_update_fields_sessions"));
  });
  afterEach(() => {
    resetToken();
  });

  function session(opts, state) {
    const { token } = createSession({ projectId: "p", ...opts });
    getSession(token).state = state;
    return token;
  }
  const single = (token, filename, field, value) => assertToolAllowed(token, "dendron_update_field", { filename, field, value });
  const multi = (token, filename, fields) => assertToolAllowed(token, "dendron_update_fields", { filename, fields });

  it("fields.phase 'ready' is refused with proto_story_guard outside open/qa, admitted from qa and open", () => {
    const story = () => session({ problemId: "story-1" }, "refining");
    const sm = multi(story(), "backlog.feat.x", { phase: "ready", title: "t" });
    const ss = single(story(), "backlog.feat.x", "phase", "ready");
    expect(sm?.error).toBe("proto_story_guard");
    expect(ss?.error).toBe("proto_story_guard");

    for (const [opts, state] of [[{ flowType: "qa", problemId: "story-1" }, "init"], [{}, "writing"]]) {
      const m = multi(session(opts, state), "backlog.feat.x", { phase: "ready" });
      const s = single(session(opts, state), "backlog.feat.x", "phase", "ready");
      expect(m, JSON.stringify(opts)).toBeNull();
      expect(s, JSON.stringify(opts)).toBeNull();
    }
  });

  it("story-flow namespace enforcement matches dendron_update_field", () => {
    const story = () => session({ problemId: "story-1" }, "refining");
    const m = multi(story(), "research.topic.foo", { title: "t" });
    const s = single(story(), "research.topic.foo", "title", "t");
    expect(m?.error).toBe("namespace_violation");
    expect(s?.error).toBe("namespace_violation");
    expect(multi(story(), "backlog.feat.x", { title: "t" })).toBeNull();
    expect(single(story(), "backlog.feat.x", "title", "t")).toBeNull();
  });
});

describe("admission tables: parity with dendron_update_field", () => {
  it("every flow/state admits dendron_update_fields iff it admits dendron_update_field", () => {
    for (const flow of ["story", "open", "qa", "ship", "ops"]) {
      const states = getStates(flow) || {};
      expect(Object.keys(states).length, flow).toBeGreaterThan(0);
      for (const [name, def] of Object.entries(states)) {
        const single = def.allowed?.has("dendron_update_field") ?? false;
        const multi = def.allowed?.has("dendron_update_fields") ?? false;
        expect(multi, `${flow}/${name}`).toBe(single);
        expect(def.transitions?.dendron_update_fields, `${flow}/${name} transition`).toBe(def.transitions?.dendron_update_field);
      }
    }
  });

  it("the flow tool sets and DENDRON_WRITE_TOOLS contain it iff they contain dendron_update_field", () => {
    for (const [name, set] of Object.entries({ STORY_FLOW_TOOLS, OPEN_FLOW_TOOLS, QA_FLOW_TOOLS, DENDRON_WRITE_TOOLS })) {
      expect(set.has("dendron_update_fields"), name).toBe(set.has("dendron_update_field"));
    }
    // Positive control: the single-field tool is in every one of them today.
    for (const set of [STORY_FLOW_TOOLS, OPEN_FLOW_TOOLS, QA_FLOW_TOOLS, DENDRON_WRITE_TOOLS]) {
      expect(set.has("dendron_update_field")).toBe(true);
    }
  });

  it("is protected and has no TOOL_TO_AGENT_MAP entry", () => {
    expect(isProtectedTool("dendron_update_fields")).toBe(true);
    expect(Object.hasOwn(server.TOOL_TO_AGENT_MAP, "dendron_update_fields")).toBe(false);
  });

  it("TOOL_AGENTS classifies dendron_update_fields like dendron_update_field", () => {
    expect(TOOL_AGENTS.dendron_update_fields).toEqual(TOOL_AGENTS.dendron_update_field);
    expect(TOOL_AGENTS.dendron_update_fields).toEqual([]);
  });

  it("buildDendronCommitMessage uses the registered verb, not the unknown-tool fallback", () => {
    const msg = buildDendronCommitMessage("dendron_update_fields", NOTE);
    const fallback = buildDendronCommitMessage("__no_such_dendron_tool__", NOTE);
    expect(msg).not.toBe(fallback);
    expect(msg).toBe(`docs(backlog): update-fields ${NOTE}`);
  });
});

describe("schema and MCP surface", () => {
  it("TOOL_ARG_SCHEMAS.dendron_update_fields rejects {} and a call missing fields; accepts a map", () => {
    const schema = server.TOOL_ARG_SCHEMAS.dendron_update_fields;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ filename: "x" }).success).toBe(false);
    expect(schema.safeParse({ filename: "x", fields: { a: "x", b: ["y"] } }).success).toBe(true);
    expect(schema.safeParse({ filename: "x", fields: { a: "x" }, acknowledgeRemoval: true }).success).toBe(true);
  });

  it("ListTools advertises dendron_update_fields with a _governorToken property", async () => {
    const tool = await withClient(async (client) => (await client.listTools()).tools.find((t) => t.name === "dendron_update_fields"));
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties._governorToken).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["filename", "fields"]);
  });

  it("an untokened call is refused and the note is untouched", async () => {
    const target = path.join(serverRoot, "notes", `${NOTE}.md`);
    const before = fs.readFileSync(target, "utf8");
    // Token validation is skipped under NODE_ENV=test / RKS_SKIP_PREFLIGHT / RKS_TEST_MODE, so
    // force production for the call (as dendron-update-field-autoroute-refusal.test.mjs does).
    const prev = { NODE_ENV: process.env.NODE_ENV, RKS_SKIP_PREFLIGHT: process.env.RKS_SKIP_PREFLIGHT, RKS_TEST_MODE: process.env.RKS_TEST_MODE };
    process.env.NODE_ENV = "production";
    delete process.env.RKS_SKIP_PREFLIGHT;
    delete process.env.RKS_TEST_MODE;
    let p;
    try {
      p = await withClient(async (client) => {
        const r = await client.callTool({ name: "dendron_update_fields", arguments: { filename: NOTE, fields: { title: "x" } } });
        return JSON.parse(r?.content?.[0]?.text ?? "{}");
      });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(p.ok).toBe(false);
    expect(p.error).toBe("unauthorized");
    expect(p._autoRouted).toBeUndefined();
    expect(fs.readFileSync(target, "utf8")).toBe(before);
  });
});
