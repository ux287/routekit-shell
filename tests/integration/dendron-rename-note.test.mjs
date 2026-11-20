// backlog.feat.dendron-rename-note-wikilinks — real-server rename against a temp git vault.
// Every git spawn passes an explicit timeout (spawnSync timeout: 15_000).
//
// The server is the real createServer() over InMemoryTransport; token validation is skipped under
// the test env (NODE_ENV=test / VITEST), except in the untokened-refusal case, which forces
// NODE_ENV=production for that one call. Evidence is read from disk and from git, never only from
// the response envelope.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseWikilinks } from "../../packages/mcp-rks/src/shared/wikilinks.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
const gitOut = (cwd, ...args) => {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

const PROJECT_ID = "rename-note-fixture";

const note = (id, body) => `---\nid: "${id}"\ntitle: "${id}"\ndesc: ""\nupdated: 1\ncreated: 1\n---\n\n${body}`;

const INDEX_BODY = [
  "# Index",
  "",
  "Plain [[docs.a.b]], labelled [[Label|docs.a.b]], anchored [[docs.a.b#sec]],",
  "labelled+anchored [[Label|docs.a.b#sec]] and embedded ![[docs.a.b]].",
  "",
  "Not renamed: [[docs.a.bc]] [[docs.a]] [[docs.a.b.c]] [[other.note]].",
  "",
  "```",
  "[[docs.a.b]] inside a fence stays",
  "```",
  "",
].join("\n");

const FIXTURE = {
  "docs.a.b.md": note("docs.a.b", "Parent note. Child: [[docs.a.b.c]]. Self: [[docs.a.b#top]].\n"),
  // id deliberately differs from the filename: it must be preserved on rename.
  "docs.a.b.c.md": note("custom-id", "Child note.\n"),
  "docs.a.bc.md": note("docs.a.bc", "Prefix-collision sibling.\n"),
  "index.md": note("index", INDEX_BODY),
  "other.md": note("other", "See [[Label|docs.a.b#sec]] and [[other.note]].\n"),
  "unrelated.md": note("unrelated", "No links at all.\n"),
};
const CACHE = '{"version":1,"notes":{"docs.a.b":{}}}\n';

async function callTool(name, args, { production = false } = {}) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
  if (production) {
    process.env.NODE_ENV = "production";
    delete process.env.RKS_SKIP_PREFLIGHT;
  }
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r?.content?.[0]?.text ?? "";
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { raw: r, text, json };
  } finally {
    if (production) {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
      if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT; else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
    }
    await client.close().catch(() => {});
  }
}

describe("dendron_rename_note", () => {
  const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  const prevId = process.env.ROUTEKIT_PROJECT_ID;
  let root;
  let notesDir;

  const head = () => gitOut(root, "rev-parse", "HEAD").trim();
  const commitCount = () => Number(gitOut(root, "rev-list", "--count", "HEAD").trim());
  const read = (name) => fs.readFileSync(path.join(notesDir, name), "utf8");
  const exists = (name) => fs.existsSync(path.join(notesDir, name));
  // Every file under notes/ (the cache included), as bytes.
  const snapshot = () => {
    const out = {};
    for (const name of fs.readdirSync(notesDir).sort()) {
      const abs = path.join(notesDir, name);
      if (fs.statSync(abs).isFile()) out[name] = fs.readFileSync(abs, "utf8");
    }
    return out;
  };
  const body = (raw) => raw.slice(raw.indexOf("\n---\n") + 5);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rename-note-"));
    notesDir = path.join(root, "notes");
    fs.mkdirSync(notesDir);
    fs.mkdirSync(path.join(root, ".rks"));
    fs.mkdirSync(path.join(root, "routekit"));
    fs.writeFileSync(path.join(root, ".rks", "project.json"),
      JSON.stringify({ id: PROJECT_ID, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
    fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), "project: fixture\n");
    for (const [name, raw] of Object.entries(FIXTURE)) fs.writeFileSync(path.join(notesDir, name), raw);
    fs.writeFileSync(path.join(notesDir, ".dendron.cache.json"), CACHE);
    // Unprotected branch: dendron commits refuse on protected branches (main is always protected).
    gitOut(root, "init", "-q", "-b", "feature/rename-note");
    gitOut(root, "config", "user.email", "test@test.com");
    gitOut(root, "config", "user.name", "Test");
    gitOut(root, "config", "commit.gpgsign", "false");
    gitOut(root, "add", "-A");
    gitOut(root, "commit", "-q", "-m", "fixture");
    process.env.ROUTEKIT_PROJECT_ROOT = root;
    process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
    if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevId;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("moves the note and rewrites every covered link form in one commit", async () => {
    const before = snapshot();
    const startCount = commitCount();
    const { json: res } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b" });
    expect(res.ok).toBe(true);
    expect(res.commitOk).toBe(true);

    // Moved; body byte-identical (it holds no link to a renamed note: the child is not renamed and
    // [[docs.a.b#top]] is a self-link, which IS rewritten).
    expect(exists("docs.a.b.md")).toBe(false);
    expect(exists("vendors.b.md")).toBe(true);
    expect(body(read("vendors.b.md"))).toBe(body(before["docs.a.b.md"]).replace("[[docs.a.b#top]]", "[[vendors.b#top]]"));

    // Every covered form rewritten, labels and anchors preserved; collisions, other notes and the
    // fenced link untouched.
    expect(read("index.md")).toBe(before["index.md"]
      .replace("Plain [[docs.a.b]], labelled [[Label|docs.a.b]], anchored [[docs.a.b#sec]],", "Plain [[vendors.b]], labelled [[Label|vendors.b]], anchored [[vendors.b#sec]],")
      .replace("labelled+anchored [[Label|docs.a.b#sec]] and embedded ![[docs.a.b]].", "labelled+anchored [[Label|vendors.b#sec]] and embedded ![[vendors.b]]."));
    expect(read("index.md")).toContain("```\n[[docs.a.b]] inside a fence stays\n```");
    expect(read("other.md")).toBe(before["other.md"].replace("[[Label|docs.a.b#sec]]", "[[Label|vendors.b#sec]]"));

    // includeChildren false (default): the child is not moved and links to it are untouched.
    expect(exists("docs.a.b.c.md")).toBe(true);
    expect(read("docs.a.b.c.md")).toBe(before["docs.a.b.c.md"]);
    expect(read("index.md")).toContain("[[docs.a.b.c]]");
    expect(read("vendors.b.md")).toContain("[[docs.a.b.c]]");
    for (const name of ["docs.a.bc.md", "unrelated.md", ".dendron.cache.json"]) expect(read(name), name).toBe(before[name]);

    expect(res.renamed).toEqual([{ from: "docs.a.b", to: "vendors.b" }]);
    expect(res.linksRewritten).toEqual([
      { file: "index.md", count: 5 },
      { file: "other.md", count: 1 },
      { file: "vendors.b.md", count: 1 },
    ]);

    // Exactly one new commit.
    expect(commitCount()).toBe(startCount + 1);
    expect(res.commitId).toBe(head());

    // name-status: the rename plus exactly the files reported in linksRewritten.
    const entries = gitOut(root, "show", "--name-status", "--format=", "-M", "HEAD").trim().split("\n").map((l) => l.split("\t"));
    // git reports the move as R<score> when similarity clears its threshold, else as D + A;
    // either is the rename. These fixture notes are tiny, so the score is not pinned.
    const renames = entries.filter((e) => e[0].startsWith("R")).map((e) => [e[1], e[2]]);
    const deleted = entries.filter((e) => e[0] === "D").map((e) => e[1]);
    const added = entries.filter((e) => e[0] === "A").map((e) => e[1]);
    const moves = [...renames, ...deleted.map((d, i) => [d, added[i]])];
    expect(moves).toEqual([["notes/docs.a.b.md", "notes/vendors.b.md"]]);
    expect(deleted.length).toBe(added.length);
    const touched = new Set(entries.flatMap((e) => e.slice(1)));
    for (const { file } of res.linksRewritten) expect(touched.has(`notes/${file}`), file).toBe(true);
    const modified = entries.filter((e) => e[0] === "M").map((e) => e[1].replace(/^notes\//, ""));
    expect(new Set([...modified, "vendors.b.md"])).toEqual(new Set(res.linksRewritten.map((l) => l.file)));
    expect(touched.has("notes/.dendron.cache.json")).toBe(false);

    // Counts equal the rewrites in the commit, measured from the committed blobs.
    const sum = res.linksRewritten.reduce((n, l) => n + l.count, 0);
    expect(res.totalLinks).toBe(sum);
    let measured = 0;
    for (const { file, count } of res.linksRewritten) {
      const oldPath = file === "vendors.b.md" ? "notes/docs.a.b.md" : `notes/${file}`;
      const after = gitOut(root, "show", `HEAD:notes/${file}`);
      const prior = gitOut(root, "show", `HEAD~1:${oldPath}`);
      const toNew = parseWikilinks(after).filter((l) => l.target === "vendors.b").length
        - parseWikilinks(prior).filter((l) => l.target === "vendors.b").length;
      expect(toNew, file).toBe(count);
      measured += toNew;
    }
    expect(measured).toBe(res.totalLinks);
  });

  it("includeChildren renames descendants and rewrites their links", async () => {
    const before = snapshot();
    const { json: res } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b", includeChildren: true });
    expect(res.ok).toBe(true);
    expect(res.renamed).toEqual([
      { from: "docs.a.b", to: "vendors.b" },
      { from: "docs.a.b.c", to: "vendors.b.c" },
    ]);
    expect(exists("docs.a.b.c.md")).toBe(false);
    expect(exists("vendors.b.c.md")).toBe(true);
    // The prefix-collision sibling is not a descendant.
    expect(exists("docs.a.bc.md")).toBe(true);
    expect(read("index.md")).toContain("[[vendors.b.c]]");
    expect(read("index.md")).not.toContain("[[docs.a.b.c]]");
    expect(read("index.md")).toContain("[[docs.a.bc]]");
    expect(read("vendors.b.md")).toContain("Child: [[vendors.b.c]].");
    expect(res.linksRewritten).toEqual([
      { file: "index.md", count: 6 },
      { file: "other.md", count: 1 },
      { file: "vendors.b.md", count: 2 },
    ]);
    expect(body(read("vendors.b.c.md"))).toBe(body(before["docs.a.b.c.md"]));
  });

  it("updates a filename-equal id and preserves any other id", async () => {
    const { json: res } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b", includeChildren: true });
    expect(res.ok).toBe(true);
    expect(parseFrontmatter(read("vendors.b.md")).data.id).toBe("vendors.b");
    expect(parseFrontmatter(read("vendors.b.c.md")).data.id).toBe("custom-id");
    expect(res.idUpdated).toEqual(["vendors.b"]);
  });

  it("refusals write nothing and leave HEAD unchanged", async () => {
    // A committed note that collides with the child's rename target.
    fs.writeFileSync(path.join(notesDir, "vendors.b.c.md"), note("vendors.b.c", "Pre-existing.\n"));
    gitOut(root, "add", "-A");
    gitOut(root, "commit", "-q", "-m", "collision fixture");
    const cases = [
      [{ from: "docs.nope", to: "vendors.b" }, "source_not_found"],
      [{ from: "docs.a.b", to: "docs.a.bc" }, "target_exists"],
      [{ from: "docs.a.b", to: "vendors.b", includeChildren: true }, "child_target_exists"],
      [{ from: "docs/a.b", to: "vendors.b" }, "malformed_name"],
      [{ from: "docs.a.b", to: "bad..name" }, "malformed_name"],
      [{ from: "docs.a.b", to: "vendors.b.md/" }, "malformed_name"],
    ];
    for (const [args, reason] of cases) {
      const before = snapshot();
      const startHead = head();
      const { json: res } = await callTool("dendron_rename_note", args);
      expect(res.ok, JSON.stringify(args)).toBe(false);
      expect(res.reason, JSON.stringify(args)).toBe(reason);
      expect(snapshot(), JSON.stringify(args)).toEqual(before);
      expect(head(), JSON.stringify(args)).toBe(startHead);
    }
  });

  it("dryRun reports the same plan a real run reports and writes nothing", async () => {
    const before = snapshot();
    const startHead = head();
    const { json: dry } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b", includeChildren: true, dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(head()).toBe(startHead);
    const { json: real } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b", includeChildren: true });
    expect(real.ok).toBe(true);
    expect(dry.renamed).toEqual(real.renamed);
    expect(dry.linksRewritten).toEqual(real.linksRewritten);
    expect(dry.totalLinks).toBe(real.totalLinks);
    expect(dry.idUpdated).toEqual(real.idUpdated);
  });

  it("rolls back on an injected write failure", async () => {
    // writeNoteRaw writes <note>.md.tmp and renames it over the note; a DIRECTORY at that temp path
    // makes the other.md write fail AFTER the rename and the index.md rewrite have both landed.
    fs.mkdirSync(path.join(notesDir, "other.md.tmp"));
    const before = snapshot();
    const startHead = head();
    const { json: res } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("write_failed");
    expect(res.rolledBack).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(exists("vendors.b.md")).toBe(false);
    expect(read("docs.a.b.md")).toBe(FIXTURE["docs.a.b.md"]);
    expect(head()).toBe(startHead);
    expect(gitOut(root, "status", "--porcelain", "--", "notes").trim()).toBe("");
  });

  it("never writes notes/.dendron.cache.json", async () => {
    const cachePath = path.join(notesDir, ".dendron.cache.json");
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(cachePath, past, past);
    const { json: res } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b", includeChildren: true });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(CACHE);
    expect(fs.statSync(cachePath).mtimeMs).toBe(past.getTime());
    const committed = gitOut(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(committed).not.toContain("notes/.dendron.cache.json");
    expect(res.committedPaths ?? committed).not.toContain("notes/.dendron.cache.json");
  });

  it("an untokened call is refused, never auto-routed, and writes nothing", async () => {
    const before = snapshot();
    const startHead = head();
    const { text, json } = await callTool("dendron_rename_note", { from: "docs.a.b", to: "vendors.b" }, { production: true });
    expect(text.length).toBeGreaterThan(0);
    expect(json).toMatchObject({ ok: false, error: "unauthorized", tool: "dendron_rename_note" });
    expect(json?._autoRouted).toBeUndefined();
    expect(json?.renamed).toBeUndefined();
    expect(snapshot()).toEqual(before);
    expect(head()).toBe(startHead);
  });
});
