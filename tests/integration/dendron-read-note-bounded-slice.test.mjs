/**
 * Tests for backlog.fix.dendron-read-note-bounded-slice.
 *
 * dendron_read_note returned the whole note. On a large story that overflowed the
 * caller's token budget and the harness substituted a file path for the content,
 * so a Governor dispatched to work on a story could not read that story. Observed
 * at 52.9KB here and 80,010 characters in a child project.
 *
 * ASSERTS ON WHAT THE CALLER RECEIVES. Every case here boots the real server with
 * createServer() over an InMemoryTransport and reads the emitted MCP text block.
 * A test that exercised the sliceNote helper alone would leave the defect
 * uncovered — the defect is in what crosses the wire, not in what the helper
 * computes.
 *
 * The spawn-based harness in tests/mcp-dendron-binding.test.mjs is guarded with
 * it.skipIf(!!process.env.CI), so a witness built on it would be silently skipped
 * in CI and prove nothing. In-process is mandatory here, not merely preferred.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTempDir } from "../helpers/tmp.mjs";

const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
let root;

// A note large enough to exceed the default cap today, with real headings and
// frontmatter so the manifest has something to name. Multi-byte characters are
// deliberate: on pure ASCII, String.length and Buffer.byteLength agree and the
// byte-accounting assertions degrade to shape pins.
const BIG_SECTION = "Lorem ipsum dolor sit amet — consectetur adipiscing elit. ".repeat(1400);

const NOTE = [
  "---",
  'id: "backlog.fix.fixture"',
  'title: "Fixture note"',
  "targetFiles:",
  '  - path: "src/one.mjs"',
  '    op: "edit"',
  "testRequirements:",
  "  - first requirement",
  "  - second requirement",
  "---",
  "",
  "## Problem",
  BIG_SECTION,
  "",
  "## Solution",
  "The solution section — with a multi-byte dash.",
  "",
  "## Acceptance Criteria",
  "- [ ] something",
  "",
].join("\n");

const SMALL_NOTE = "---\nid: \"backlog.fix.small\"\n---\n\n## Only\ntiny\n";

// THE MID-SEQUENCE FIXTURE, added by backlog.fix.post-ship-review-findings-batch.
//
// Suite-local ON PURPOSE. The defect was found against a real note under notes/,
// but a test asserting that note's byte layout would break the day someone edits
// a word in its heading. Everything this witness needs is written by this suite
// into its own temp root, and the expected byte count is derived from the fixture
// at run time rather than pasted in as a literal.
const CUT_NOTE = [
  "---",
  'id: "backlog.fix.cut"',
  "---",
  "",
  "## Cut",
  "abcdefghij\u2014klmnop",
  "",
].join("\n");

async function callTool(args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name: "dendron_read_note", arguments: args });
    return JSON.parse(r?.content?.[0]?.text ?? "{}");
  } finally {
    await client.close();
  }
}

async function listReadNoteSchema() {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { tools } = await client.listTools();
    return tools.find((t) => t.name === "dendron_read_note");
  } finally {
    await client.close();
  }
}

beforeAll(() => {
  root = makeTempDir("dendron-read-note-slice");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "backlog.fix.fixture.md"), NOTE);
  fs.writeFileSync(path.join(root, "notes", "backlog.fix.small.md"), SMALL_NOTE);
  fs.writeFileSync(path.join(root, "notes", "backlog.fix.cut.md"), CUT_NOTE);
  process.env.ROUTEKIT_PROJECT_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("the oversized read no longer overflows the caller", () => {
  it("FIXTURE PRECONDITION — the note really does exceed the default cap", async () => {
    // Anti-vacuity: if the fixture shrinks under the cap, every assertion below
    // silently tests the unbounded path instead.
    const { DEFAULT_MAX_BYTES } = await import("../../packages/mcp-rks/src/shared/note-slice.mjs");
    expect(Buffer.byteLength(NOTE, "utf8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
  });

  it("THE DEFECT — an unselected oversized read returns far fewer bytes than the note", async () => {
    // This is the load-bearing case. Before the fix the handler emitted the whole
    // note, so the emitted payload was strictly larger than the raw note.
    const res = await callTool({ filename: "backlog.fix.fixture" });
    const emitted = Buffer.byteLength(JSON.stringify(res), "utf8");
    expect(res.ok).toBe(true);
    expect(emitted).toBeLessThan(Buffer.byteLength(NOTE, "utf8"));
  });

  it("returns a NAVIGABLE manifest, not a bare failure — the first call always succeeds", async () => {
    const res = await callTool({ filename: "backlog.fix.fixture" });
    expect(res.truncated).toBe(true);
    expect(res.content).toBeUndefined();
    expect(res.manifest.headings).toEqual(
      expect.arrayContaining(["Problem", "Solution", "Acceptance Criteria"]),
    );
    expect(res.manifest.frontmatterKeys).toEqual(
      expect.arrayContaining(["id", "title", "targetFiles", "testRequirements"]),
    );
  });
});

describe("the unbounded path is byte-identical to today", () => {
  it("an under-cap read with no selector returns EXACTLY { ok, filename, content }", async () => {
    // Deep key equality, not a subset check: this tool is the only route a
    // Governor has to its own story note, and every existing caller parses that
    // shape. An implementation that attaches size fields everywhere reds here.
    const res = await callTool({ filename: "backlog.fix.small" });
    expect(Object.keys(res).sort()).toEqual(["content", "filename", "ok"]);
    expect(res.content).toBe(SMALL_NOTE);
  });
});

describe("selectors reach the handler and are observed, not assumed", () => {
  it("sections returns only the named section", async () => {
    const res = await callTool({ filename: "backlog.fix.fixture", sections: ["Solution"] });
    expect(res.content).toContain("## Solution");
    expect(res.content).toContain("multi-byte dash");
    expect(res.content).not.toContain("## Acceptance Criteria");
  });

  it("fields returns only the named frontmatter entries, with their indented blocks", async () => {
    const res = await callTool({ filename: "backlog.fix.fixture", fields: ["targetFiles"] });
    expect(res.content).toContain("targetFiles:");
    expect(res.content).toContain('path: "src/one.mjs"');
    expect(res.content).not.toContain("testRequirements:");
  });

  it("offset/limit slices by line without an off-by-one", async () => {
    const res = await callTool({ filename: "backlog.fix.fixture", offset: 1, limit: 2 });
    const lines = res.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('id: "backlog.fix.fixture"');
    expect(lines[1]).toBe('title: "Fixture note"');
  });

  it("COERCES string arguments — nothing upstream validates or casts them", async () => {
    // dendron_read_note is in TOOLS_WITHOUT_ZOD_SCHEMA and TOOL_ARG_SCHEMAS has
    // no production consumer, so selectors arrive as raw req.params.arguments.
    const res = await callTool({ filename: "backlog.fix.fixture", offset: "1", limit: "2" });
    expect(res.content.split("\n")).toHaveLength(2);
    const one = await callTool({ filename: "backlog.fix.fixture", sections: "Solution" });
    expect(one.content).toContain("## Solution");
  });

  it("TRUNCATED IS OBSERVED, NOT INTENT-SOURCED — a selected read of a big note reports it", async () => {
    // The discriminating case. Asserting truncated:true on the manifest branch
    // and false on the small-note branch does NOT discriminate — an
    // intent-sourced implementation passes both. This one only passes if the flag
    // is derived from returnedBytes < totalBytes.
    const res = await callTool({ filename: "backlog.fix.fixture", sections: ["Solution"] });
    expect(res.returnedBytes).toBeLessThan(res.totalBytes);
    expect(res.truncated).toBe(true);
  });

  it("maxBytes ALONE requests bounded mode, even when the note fits under it", async () => {
    const res = await callTool({ filename: "backlog.fix.small", maxBytes: 100000 });
    expect(res.totalBytes).toBe(Buffer.byteLength(SMALL_NOTE, "utf8"));
    expect(res.returnedBytes).toBe(res.totalBytes);
    expect(res.truncated).toBe(false);
    expect(res.content).toBe(SMALL_NOTE);
  });

  it("byte accounting is BYTES, not characters", async () => {
    const res = await callTool({ filename: "backlog.fix.fixture", sections: ["Solution"] });
    expect(res.returnedBytes).toBe(Buffer.byteLength(res.content, "utf8"));
    // Multi-byte content: the byte count must exceed the character count.
    expect(res.returnedBytes).toBeGreaterThan(res.content.length);
  });
});

describe("a cap landing INSIDE a character cuts cleanly and reports the truth", () => {
  // backlog.fix.post-ship-review-findings-batch, Finding 1.
  //
  // THE DEFECT. The byte cap was `subarray(0, maxBytes).toString("utf8")`. When
  // the cap fell inside a multi-byte sequence the decoder replaced the orphaned
  // bytes with U+FFFD — so the read both CORRUPTED the text and, because U+FFFD
  // is three bytes wide, reported MORE bytes than the caller's own cap allowed.
  //
  // Note the case above at "byte accounting is BYTES, not characters" could not
  // catch it: that call passes no maxBytes at all, so the cap path never runs.
  // Its fixture does contain multi-byte characters, but no cut is ever taken
  // through one.

  /** Read the whole section, then locate the multi-byte character inside it. */
  async function cutPoints() {
    const full = await callTool({ filename: "backlog.fix.cut", sections: ["Cut"] });
    expect(full.ok).toBe(true);
    const buf = Buffer.from(full.content, "utf8");
    const dashAt = buf.indexOf(Buffer.from("\u2014", "utf8"));
    return { full, buf, dashAt, cap: dashAt + 1 };
  }

  it("FIXTURE PRECONDITION — the chosen cap really does land mid-character", async () => {
    // Without this the witness below could go vacuous: if the fixture were later
    // edited to all-ASCII, the cap would fall on a clean boundary and the exact
    // count would pass for the wrong reason.
    const { buf, dashAt, cap } = await cutPoints();
    expect(dashAt).toBeGreaterThan(-1);
    // A UTF-8 continuation byte is 0b10xxxxxx. The byte sitting AT the cap is the
    // first excluded one, so this is exactly "the cut would split a character".
    expect(buf[cap] & 0xc0).toBe(0x80);
  });

  it("AC3 WITNESS — returnedBytes is the EXACT count returned, strictly below the cap", async () => {
    const { full, dashAt, cap } = await cutPoints();
    const res = await callTool({
      filename: "backlog.fix.cut",
      sections: ["Cut"],
      maxBytes: cap,
    });

    // EXACT EQUALITY, not toBeLessThanOrEqual. The mutation this kills is
    //   returnedBytes = truncated ? maxBytes : Buffer.byteLength(content, "utf8")
    // which answers the CAP rather than the true count. A <= assertion passes
    // against that clamp; only the exact value separates a measurement from a
    // permission. The expected number comes from the fixture, not from res.
    expect(res.returnedBytes).toBe(dashAt);
    // Asserted separately, because "below the cap" is the property that makes the
    // exact value meaningful — a clamp can never produce it.
    expect(res.returnedBytes).toBeLessThan(cap);

    // The content is clean: no replacement character was introduced.
    expect(res.content).not.toContain("\uFFFD");
    expect(res.content).toBe(full.content.slice(0, res.content.length));
    expect(Buffer.byteLength(res.content, "utf8")).toBe(res.returnedBytes);

    // truncated and totalBytes are unchanged by the boundary back-off.
    expect(res.truncated).toBe(true);
    expect(res.totalBytes).toBe(full.totalBytes);
  });

  it("the whole multi-byte character is kept when the cap clears it", async () => {
    // The complement: back off only when the cut would split. One byte further on
    // and the character fits, so it must be present and counted in full.
    const { dashAt } = await cutPoints();
    const cap = dashAt + 3;
    const res = await callTool({
      filename: "backlog.fix.cut",
      sections: ["Cut"],
      maxBytes: cap,
    });
    expect(res.returnedBytes).toBe(cap);
    expect(res.content.endsWith("\u2014")).toBe(true);
    expect(res.content).not.toContain("\uFFFD");
  });
});

describe("the advertised schema matches what the handler accepts", () => {
  it("advertises every selector, so a caller reading the schema can discover them", async () => {
    // SHAPE PIN, and labelled. It cannot prove the selectors work — the cases
    // above do that. It catches the other half-fix: a handler that accepts the
    // arguments while the advertised schema never mentions them, leaving every
    // LLM caller unable to find them.
    const tool = await listReadNoteSchema();
    const props = Object.keys(tool.inputSchema.properties);
    // Containment, not exact equality: the server injects `_governorToken` into
    // every protected tool's advertised schema, so pinning the exact key set
    // would red on an unrelated wrapper change.
    for (const p of ["filename", "sections", "fields", "offset", "limit", "maxBytes"]) {
      expect(props, `selector not advertised: ${p}`).toContain(p);
    }
  });

  it("keeps filename as the ONLY required argument", async () => {
    const tool = await listReadNoteSchema();
    expect(tool.inputSchema.required).toEqual(["filename"]);
  });
});
