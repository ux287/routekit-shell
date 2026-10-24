/**
 * Witness for backlog.feat.channel-link-frontmatter.
 * The per-note `channel:` link block (system, publish, key): readChannel validation,
 * serializeFrontmatterYaml map rendering, the setChannelKey byte-preserving splice,
 * validateNoteFrontmatter reporting, the dendron_update_field refusal, and the
 * dendron_create_note opt-in path. Unit tier: no subprocess, no server.mjs import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  readChannel,
  setChannelKey,
  CHANNEL_KEYS,
  CHANNEL_SYSTEMS,
} from "../../packages/mcp-rks/src/shared/channel-frontmatter.mjs";
import {
  serializeFrontmatterYaml,
  formatWithFrontmatter,
  parseFrontmatter,
  splitNoteFrontmatter,
} from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { validateNoteFrontmatter, updateField, updateFieldDirect } from "../../packages/mcp-rks/src/dendron.mjs";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";

const AGREED = Object.freeze({ system: "jira", publish: true, key: "PROJ-123" });
const codes = (data) => readChannel(data).issues.map((i) => i.code);

const tmpDirs = [];
function tempNotesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-channel-fm-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const noteWith = (channelLines) =>
  [
    "---",
    'id: "backlog.feat.channel-x"',
    "title: Channel X",
    "created: 1",
    "updated: 2",
    ...channelLines,
    "retrieved: 2026-09-29",
    "---",
    "",
    "## Body",
    "",
    "Body text that must not move.",
    "",
  ].join("\n");

const UNKEYED = noteWith(["channel:", "  system: jira", "  publish: true"]);
const KEYED = noteWith(["channel:", "  system: jira", "  publish: true", "  key: PROJ-123"]);
const INVALID = noteWith(["channel:", "  system: github", "  publish: true"]);
const NO_CHANNEL = noteWith([]);

describe("readChannel", () => {
  it("exports the agreed key and system vocabularies", () => {
    expect([...CHANNEL_KEYS]).toEqual(["system", "publish", "key"]);
    expect([...CHANNEL_SYSTEMS]).toEqual(["jira", "confluence"]);
  });

  it("treats a note without channel as absent and valid", () => {
    expect(readChannel({})).toEqual({ present: false, ok: true, channel: null, issues: [] });
  });

  it("accepts the agreed jira shape with a key", () => {
    const r = readChannel({ channel: { ...AGREED } });
    expect(r.ok).toBe(true);
    expect(r.present).toBe(true);
    expect(r.channel).toEqual(AGREED);
  });

  it("accepts a confluence channel with no key", () => {
    const r = readChannel({ channel: { system: "confluence", publish: false } });
    expect(r.ok).toBe(true);
    expect(r.channel).toEqual({ system: "confluence", publish: false });
    expect(Object.hasOwn(r.channel, "key")).toBe(false);
  });

  it("reports channel_not_a_map for a string or an array", () => {
    expect(codes({ channel: "jira" })).toEqual(["channel_not_a_map"]);
    expect(codes({ channel: ["jira"] })).toEqual(["channel_not_a_map"]);
  });

  it("fails closed on an unknown key", () => {
    const r = readChannel({ channel: { ...AGREED, url: "https://example.invalid" } });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("channel_unknown_key");
  });

  it("reports channel_invalid_system for an unknown or missing system", () => {
    expect(codes({ channel: { system: "github", publish: true } })).toContain("channel_invalid_system");
    expect(codes({ channel: { publish: true } })).toContain("channel_invalid_system");
  });

  it("reports channel_invalid_publish for a missing or non-boolean publish", () => {
    expect(codes({ channel: { system: "jira" } })).toContain("channel_invalid_publish");
    expect(codes({ channel: { system: "jira", publish: "true" } })).toContain("channel_invalid_publish");
  });

  it("reports channel_invalid_key for an empty or whitespace-containing key", () => {
    expect(codes({ channel: { system: "jira", publish: true, key: "" } })).toContain("channel_invalid_key");
    expect(codes({ channel: { system: "jira", publish: true, key: "PROJ 123" } })).toContain("channel_invalid_key");
  });

  it("normalizes a numeric key to its string form", () => {
    const r = readChannel({ channel: { system: "confluence", publish: true, key: 123456 } });
    expect(r.ok).toBe(true);
    expect(r.channel.key).toBe("123456");
  });
});

describe("serializeFrontmatterYaml map values", () => {
  it("renders the agreed channel map as nested YAML that parses back equal", () => {
    const out = serializeFrontmatterYaml({ channel: { ...AGREED } });
    expect(out).toBe('channel:\n  system: "jira"\n  publish: true\n  key: "PROJ-123"');
    expect(out).not.toContain("[object Object]");
    expect(parseFrontmatter(`---\n${out}\n---\n`).data.channel).toEqual(AGREED);
  });

  it("renders an empty map as {}", () => {
    expect(serializeFrontmatterYaml({ m: {} })).toBe("m: {}");
  });

  it("leaves scalars, string arrays, arrays of objects and Dates unchanged", () => {
    expect(
      serializeFrontmatterYaml({
        id: "x",
        n: 5,
        b: true,
        tags: ["a", "b"],
        none: [],
        targetFiles: [{ path: "p.mjs", op: "edit" }],
      }),
    ).toBe('id: "x"\nn: 5\nb: true\ntags:\n  - a\n  - b\nnone: []\ntargetFiles:\n  - path: "p.mjs"\n    op: "edit"');
    const d = new Date(0);
    expect(serializeFrontmatterYaml({ d })).toBe(`d: ${String(d)}`);
  });

  it("formatWithFrontmatter round-trips a channel map", () => {
    const channel = { system: "confluence", publish: false, key: "98765" };
    const first = formatWithFrontmatter({ id: "n", title: "T", created: 1, updated: 2, channel }, "Body\n");
    const p1 = parseFrontmatter(first);
    expect(p1.data.channel).toEqual(channel);
    const second = formatWithFrontmatter(p1.data, p1.content);
    expect(parseFrontmatter(second).data.channel).toEqual(channel);
  });
});

describe("setChannelKey", () => {
  const outside = (raw) =>
    splitNoteFrontmatter(raw)
      .frontmatter.split("\n")
      .filter((l) => !/^(channel:|updated:|\s)/.test(l));

  it("records the key and leaves every other frontmatter line and the body byte-identical", () => {
    const res = setChannelKey(UNKEYED, "PROJ-123");
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.content).toContain('  key: "PROJ-123"');
    expect(parseFrontmatter(res.content).data.channel).toEqual(AGREED);
    expect(outside(res.content)).toEqual(outside(UNKEYED));
    expect(outside(res.content)).toContain("retrieved: 2026-09-29");
    expect(splitNoteFrontmatter(res.content).body).toBe(splitNoteFrontmatter(UNKEYED).body);
  });

  it("refuses channel_key_already_set when a different key is present", () => {
    expect(setChannelKey(KEYED, "PROJ-999")).toMatchObject({ ok: false, reason: "channel_key_already_set" });
  });

  it("is a no-op when the same key is already present", () => {
    expect(setChannelKey(KEYED, "PROJ-123")).toEqual({ ok: true, changed: false, content: KEYED });
  });

  it("refuses channel_missing when there is no channel block or no frontmatter", () => {
    expect(setChannelKey(NO_CHANNEL, "PROJ-1")).toMatchObject({ ok: false, reason: "channel_missing" });
    expect(setChannelKey("just a body\n", "PROJ-1")).toMatchObject({ ok: false, reason: "channel_missing" });
  });

  it("refuses channel_invalid for an undefined or null key", () => {
    expect(setChannelKey(UNKEYED, undefined)).toMatchObject({ ok: false, reason: "channel_invalid" });
    expect(setChannelKey(UNKEYED, null)).toMatchObject({ ok: false, reason: "channel_invalid" });
  });

  it("refuses channel_invalid when the channel block itself is invalid", () => {
    expect(setChannelKey(INVALID, "PROJ-1")).toMatchObject({ ok: false, reason: "channel_invalid" });
  });
});

describe("validateNoteFrontmatter channel issues", () => {
  it("returns ok false with the readChannel issues for an invalid channel block", () => {
    const res = validateNoteFrontmatter(INVALID);
    expect(res.ok).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain("channel_invalid_system");
  });

  it("is unchanged for a note without channel and accepts a valid one", () => {
    const res = validateNoteFrontmatter(NO_CHANNEL);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(validateNoteFrontmatter(KEYED).ok).toBe(true);
  });
});

describe("dendron_update_field refuses channel", () => {
  for (const [name, write] of [
    ["updateField", updateField],
    ["updateFieldDirect", updateFieldDirect],
  ]) {
    it(`${name} throws and leaves the note byte-identical`, () => {
      const dir = tempNotesDir();
      const notePath = path.join(dir, "s.md");
      fs.writeFileSync(notePath, KEYED);
      expect(() => write(dir, "s.md", "channel", "jira")).toThrow(/channel/);
      expect(() => write(dir, "s.md", "channel", ["system: jira"])).toThrow(/channel/);
      expect(fs.readFileSync(notePath, "utf8")).toBe(KEYED);
    });

    it(`${name} refuses before the note is located or read`, () => {
      const dir = tempNotesDir();
      expect(() => write(dir, "missing.md", "channel", "jira")).toThrow(/Direct writes to 'channel' are refused/);
    });
  }
});

describe("dendron_create_note opt-in path", () => {
  // Same registration pattern as tests/unit/server-handler-dendron.test.mjs D-TR14.
  function stubHelpers(notesDir) {
    return {
      getDendronContext: vi.fn(() => ({ notesDir })),
      assertNotesDir: vi.fn(),
      notePathFromFilename: vi.fn((dir, filename) => path.join(dir, `${filename}.md`)),
      commitDendronWriteResult: vi.fn(async (arg) => ({ ...(arg && arg.innerResult), stubCommit: true })),
    };
  }
  const passthrough = () => z.object({}).passthrough();
  const schemas = () => ({
    createNoteSchema: z.object({
      filename: z.string(),
      title: z.string().optional(),
      desc: z.string().optional(),
      content: z.string().optional(),
      testFile: z.string().optional(),
    }),
    fixFrontmatterSchema: passthrough(),
    validateSchemaSchema: passthrough(),
    editNoteSchema: passthrough(),
    updateFieldSchema: passthrough(),
    markImplementedSchema: passthrough(),
  });
  const ctxFor = (tool, args = {}) => Object.freeze({ tool, args, activeToken: undefined, governorToken: undefined });

  it("writes a note whose agreed channel map survives creation", async () => {
    const dir = tempNotesDir();
    const filename = "backlog.feat.channel-optin";
    const r = createHandlerRegistry();
    registerDendronHandlers(r, schemas(), stubHelpers(dir));
    const content = ["---", "channel:", "  system: jira", "  publish: true", "  key: PROJ-123", "---", "", "## Body", ""].join("\n");
    const args = { filename, title: "Opt in", content };
    const res = await r.lookupHandler("dendron_create_note")(args, ctxFor("dendron_create_note", args));
    expect(JSON.parse(res.content[0].text).ok).toBe(true);
    const raw = fs.readFileSync(path.join(dir, `${filename}.md`), "utf8");
    expect(raw).not.toContain("[object Object]");
    expect(parseFrontmatter(raw).data.channel).toEqual(AGREED);
  });
});
