/**
 * backlog.feat.channel-publish-dry-run — read-only rks_channel_preview.
 * Unit tier: os.tmpdir() fixtures only; no server.mjs import, no subprocess, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";

const h = vi.hoisted(() => ({ root: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, loadContext: async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: {}, kg: {} }) };
});

import { previewChannelPublish } from "../../packages/mcp-rks/src/server/channel-preview.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { UNPROTECTED_TOOLS, isProtectedTool } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { CHILD_RKS_ALLOW_TOOLS, CHILD_RKS_PROMPT_TOOLS } from "../../packages/cli/src/project/child-permissions.mjs";

const NOTES = {
  "a.jira-create.md": "---\ntitle: Jira Create\nchannel:\n  system: jira\n  publish: true\n---\n\n# Jira body\n",
  "b.confluence-update.md": "---\ntitle: Confluence Update\nchannel:\n  system: confluence\n  publish: true\n  key: \"123456\"\n---\n\nConfluence body: café — naïve\n",
  "c.jira-off.md": "---\ntitle: Off\nchannel:\n  system: jira\n  publish: false\n---\nnot published\n",
  "d.no-channel.md": "---\ntitle: Plain\n---\nplain note\n",
};
const BAD_CHANNEL = {
  "e.bad-system.md": "---\ntitle: Bad\nchannel:\n  system: slack\n  publish: true\n---\nbad\n",
  "f.not-a-map.md": "---\nchannel: jira\n---\nscalar\n",
  "g.unknown-key.md": "---\nchannel:\n  system: jira\n  publish: true\n  space: ENG\n---\nunknown\n",
};
const BAD_YAML_NAME = "h.bad-yaml.md";
const BAD_YAML = "---\ntitle: [unclosed\n---\nbroken\n";
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

let tmp;
function writeNotes(dir, notes) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(notes)) fs.writeFileSync(path.join(dir, file), content);
}
function snapshot(dir) {
  return fs.readdirSync(dir).sort().map((f) => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    return [f, st.isFile() ? fs.readFileSync(p, "utf8") : null, st.mtimeMs, st.size];
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channel-preview-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("previewChannelPublish", () => {
  it("CP-TR1 returns exactly the publish:true notes in filename order: jira create (key null), confluence update (key 123456)", () => {
    writeNotes(tmp, NOTES);
    const r = previewChannelPublish(tmp);
    expect(r.items.map((i) => [i.note, i.system, i.action, i.key, i.title])).toEqual([
      ["a.jira-create", "jira", "create", null, "Jira Create"],
      ["b.confluence-update", "confluence", "update", "123456", "Confluence Update"],
    ]);
    expect(r.invalid).toEqual([]);
  });

  it("CP-TR2 localDigest is the sha256 hex of the gray-matter body and bodyBytes its UTF-8 byte length", () => {
    writeNotes(tmp, NOTES);
    const r = previewChannelPublish(tmp);
    expect(r.items).toHaveLength(2);
    for (const item of r.items) {
      const body = parseFrontmatter(NOTES[`${item.note}.md`]).content;
      expect(item.localDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(item.localDigest).toBe(sha256(body));
      expect(item.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
    }
    const conf = r.items.find((i) => i.system === "confluence");
    const confBody = parseFrontmatter(NOTES["b.confluence-update.md"]).content;
    expect(conf.bodyBytes).toBeGreaterThan(confBody.length);
  });

  it("CP-TR3 title falls back to the note name when frontmatter has no title", () => {
    writeNotes(tmp, { "u.untitled.md": "---\nchannel:\n  system: jira\n  publish: true\n---\nx\n" });
    expect(previewChannelPublish(tmp).items.map((i) => i.title)).toEqual(["u.untitled"]);
  });

  it("CP-TR4 invalid channel blocks go to invalid with readChannel's issue codes and never to items", () => {
    writeNotes(tmp, { ...NOTES, ...BAD_CHANNEL });
    const r = previewChannelPublish(tmp);
    expect(r.items.map((i) => i.note)).toEqual(["a.jira-create", "b.confluence-update"]);
    const codes = Object.fromEntries(r.invalid.map((i) => [i.note, i.issues.map((x) => x.code)]));
    expect(Object.keys(codes)).toEqual(["e.bad-system", "f.not-a-map", "g.unknown-key"]);
    expect(codes["e.bad-system"]).toContain("channel_invalid_system");
    expect(codes["f.not-a-map"]).toEqual(["channel_not_a_map"]);
    expect(codes["g.unknown-key"]).toContain("channel_unknown_key");
  });

  it("CP-TR5 unparseable frontmatter is frontmatter_parse_error on every call, even after a cached failed parse of the same bytes", () => {
    // Prime gray-matter's content cache with a failed parse of the same bytes (the long-lived server state).
    try {
      parseFrontmatter(BAD_YAML);
    } catch {
      // expected: the YAML does not parse
    }
    writeNotes(tmp, { ...NOTES, [BAD_YAML_NAME]: BAD_YAML });
    for (let call = 0; call < 2; call++) {
      const r = previewChannelPublish(tmp);
      expect(r.invalid.map((i) => [i.note, i.issues.map((x) => x.code)]), `call ${call}`).toEqual([["h.bad-yaml", ["frontmatter_parse_error"]]]);
      expect(r.items).toHaveLength(2);
      expect(r.scanned).toBe(5);
    }
  });

  it("CP-TR6 the system filter restricts items to that system", () => {
    writeNotes(tmp, NOTES);
    expect(previewChannelPublish(tmp, { system: "confluence" }).items.map((i) => i.note)).toEqual(["b.confluence-update"]);
    expect(previewChannelPublish(tmp, { system: "jira" }).items.map((i) => i.note)).toEqual(["a.jira-create"]);
  });

  it("CP-TR7 every result carries ok, dryRun, wrote false, remoteChecked false and scanned = top-level .md files read", () => {
    writeNotes(tmp, { ...NOTES, "README.txt": "not a note\n" });
    writeNotes(path.join(tmp, "nested"), { "z.nested.md": "---\nchannel:\n  system: jira\n  publish: true\n---\nnested\n" });
    for (const opts of [undefined, { system: "jira" }, { system: "confluence" }]) {
      const r = previewChannelPublish(tmp, opts);
      expect(Object.keys(r).sort()).toEqual(["dryRun", "invalid", "items", "ok", "remoteChecked", "scanned", "wrote"]);
      expect(r).toMatchObject({ ok: true, dryRun: true, wrote: false, remoteChecked: false, scanned: 4 });
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "channel-preview-empty-"));
    try {
      expect(previewChannelPublish(empty)).toEqual({ ok: true, dryRun: true, wrote: false, remoteChecked: false, scanned: 0, items: [], invalid: [] });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("CP-TR8 writes nothing: every file keeps its bytes and mtime and no file is added", () => {
    writeNotes(tmp, { ...NOTES, ...BAD_CHANNEL, [BAD_YAML_NAME]: BAD_YAML });
    const before = snapshot(tmp);
    previewChannelPublish(tmp);
    previewChannelPublish(tmp, { system: "jira" });
    previewChannelPublish(tmp, { system: "confluence" });
    expect(snapshot(tmp)).toEqual(before);
  });

  it("CP-TR9 works in a content-only project whose root holds nothing but notes/", () => {
    const notesDir = path.join(tmp, "notes");
    writeNotes(notesDir, NOTES);
    expect(fs.readdirSync(tmp)).toEqual(["notes"]);
    expect(previewChannelPublish(notesDir).items.map((i) => i.action)).toEqual(["create", "update"]);
  });
});

describe("rks_channel_preview handler (project-meta family)", () => {
  const ENV_KEYS = ["DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
  let saved;
  const channelPreviewSchema = z.object({ projectId: z.string(), system: z.enum(["jira", "confluence"]).optional() });
  const any = z.object({}).passthrough();
  const schemas = {
    projectGetSchema: any,
    kgQuerySchema: any,
    templatesListSchema: any,
    gitStateSchema: any,
    publishSchema: any,
    publishProfilesSchema: any,
    channelPreviewSchema,
  };
  const ctx = Object.freeze({ tool: "rks_channel_preview", args: {}, activeToken: undefined, governorToken: undefined });

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    h.root = tmp;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    h.root = null;
  });

  it("CP-TR10 is registered by registerProjectMetaHandlers and returns the preview of <root>/notes as JSON text", async () => {
    writeNotes(path.join(tmp, "notes"), NOTES);
    const r = createHandlerRegistry();
    registerProjectMetaHandlers(r, schemas);
    expect(r.registeredTools()).toContain("rks_channel_preview");
    const res = await r.lookupHandler("rks_channel_preview")({ projectId: "channel-fixture", system: "jira" }, ctx);
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    const payload = JSON.parse(res.content[0].text);
    expect(payload).toEqual(previewChannelPublish(path.join(tmp, "notes"), { system: "jira" }));
    expect(payload.items.map((i) => i.note)).toEqual(["a.jira-create"]);
    expect(payload.remoteChecked).toBe(false);
  });

  it("CP-TR11 rejects args without projectId with a ZodError before reading any note", async () => {
    const r = createHandlerRegistry();
    registerProjectMetaHandlers(r, schemas);
    const err = await r.lookupHandler("rks_channel_preview")({}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain("projectId");
  });
});

describe("rks_channel_preview classification", () => {
  it("CP-TR12 is unprotected (no Governor token) and allowed without a prompt in child projects", () => {
    expect(UNPROTECTED_TOOLS.has("rks_channel_preview")).toBe(true);
    expect(isProtectedTool("rks_channel_preview")).toBe(false);
    expect(CHILD_RKS_ALLOW_TOOLS).toContain("mcp__rks__rks_channel_preview");
    expect(Object.keys(CHILD_RKS_PROMPT_TOOLS)).not.toContain("mcp__rks__rks_channel_preview");
  });
});
