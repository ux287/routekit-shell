/**
 * Witness for backlog.fix.phase-repair-leaves-note-write-uncommitted.
 *
 * rks_phase_repair wrote the story note to `phase: integrated` and returned, leaving the note
 * dirty for the next off-rail session to inherit. repairPhaseToIntegrated is git-free BY DESIGN
 * (pinned in tests/unit/offrail-phase-repair-evidence-bound.test.mjs); the MCP handler is the
 * caller that owns persisting the write. These cases drive the HANDLER through an in-process MCP
 * client against a throwaway git repo, and assert on what git observes afterwards.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Mock only the embedding step (as server-handler-git.test.mjs does); every git call runs for real.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

const TIMEOUT = 20_000;
const g = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

/** A project repo on `staging`, optionally with a bare origin, everything committed. */
function initProject({ projectJson = {}, withOrigin = true } = {}) {
  // realpath: on macOS os.tmpdir() is a symlink, and the handler's projectRoot must equal git's view.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-phase-repair-commit-")));
  tmpDirs.push(root);
  g(root, ["init", "-b", "staging"]);
  g(root, ["config", "user.email", "t@t"]);
  g(root, ["config", "user.name", "t"]);
  g(root, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".rks", "project.json"),
    JSON.stringify({ id: "test-project", root, kgFile: ".rks/kg.yaml", ...projectJson }),
  );
  fs.writeFileSync(path.join(root, ".rks", "kg.yaml"), "{}\n");
  fs.writeFileSync(path.join(root, "README.md"), "# t\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-m", "init"]);
  let bare = null;
  if (withOrigin) {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-phase-repair-bare-"));
    tmpDirs.push(bare);
    g(bare, ["init", "--bare", "-b", "staging"]);
    g(root, ["remote", "add", "origin", bare]);
    g(root, ["push", "-u", "origin", "staging"]);
  } else {
    g(root, ["remote", "add", "origin", path.join(os.tmpdir(), `no-such-remote-${process.pid}`)]);
  }
  return { root, bare };
}

function writeStory(root, id, phase, extra = "") {
  fs.writeFileSync(
    path.join(root, "notes", `${id}.md`),
    `---\nid: "${id}"\ntitle: "T"\ncreated: 1\nupdated: 2\nphase: "${phase}"\n${extra}---\n\n## Problem\n\nbody\n`,
  );
}

/** backlog.fix.offrail-ship-and-phase-repair-skip-archive: a successful repair archives the note. */
const archivedId = (id) => id.replace(/^backlog\./, "backlog.z_implemented.");
/** The repair commit's file set: the live path deleted and the archived path added, sorted. */
const renameSet = (id) => [`notes/${archivedId(id)}.md`, `notes/${id}.md`].sort();

/** The off-rail evidence: a commit carrying the `Story:` trailer. Commits the note with it. */
function commitWithTrailer(root, storyId) {
  fs.writeFileSync(path.join(root, `src-${Math.random().toString(36).slice(2)}.mjs`), "// work\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-m", `feat(off-rail): work\n\nSession: abc\nStory: ${storyId}`]);
}

const head = (root) => g(root, ["rev-parse", "HEAD"]).trim();
const shortHead = (root) => g(root, ["rev-parse", "--short", "HEAD"]).trim();
const porcelain = (root, p) => g(root, ["status", "--porcelain", ...(p ? ["--", p] : [])]).trim();
const headFiles = (root) => g(root, ["show", "--name-only", "--no-renames", "--format=", "HEAD"]).split("\n").filter(Boolean);

async function withClient(root, fn) {
  const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  const prevId = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  process.env.ROUTEKIT_PROJECT_ID = "test-project";
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
    if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevId;
  }
}

const repair = (root, storyId) =>
  withClient(root, async (c) => {
    const r = await c.callTool({ name: "rks_phase_repair", arguments: { projectId: "test-project", storyId } });
    return JSON.parse(r.content[0].text);
  });

describe("a successful rks_phase_repair commits the story note", { timeout: 60_000 }, () => {
  it("leaves the note committed at integrated, with commitId equal to the new HEAD, and pushes it", async () => {
    const { root, bare } = initProject();
    const id = "backlog.fix.repair-commits";
    writeStory(root, id, "arch-approved");
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    const before = head(root);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    expect(head(root)).not.toBe(before);
    expect(porcelain(root, `notes/${archivedId(id)}.md`)).toBe("");
    expect(g(root, ["show", `HEAD:notes/${archivedId(id)}.md`])).toContain('phase: "integrated"');
    expect(res.note.ok).toBe(true);
    expect(res.note.commitId).toBe(shortHead(root));
    expect([...headFiles(root)].sort()).toEqual(renameSet(id));
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(head(root));
    // The persistence commit must not mint its own phase-repair evidence.
    const body = g(root, ["log", "-1", "--format=%B", "HEAD"]);
    expect(body.split("\n").map((l) => l.trim())).not.toContain(`Story: ${id}`);
    expect(body.startsWith("feat(exec): ")).toBe(false);
  });

  it("does not sweep a previously STAGED unrelated path into the note commit", async () => {
    const { root } = initProject();
    const id = "backlog.fix.repair-staged-other";
    writeStory(root, id, "arch-approved");
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    fs.writeFileSync(path.join(root, "staged-other.txt"), "staged\n");
    g(root, ["add", "--", "staged-other.txt"]);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    // ARCH Q1: the commit is pathspec-limited to the note inside commitAndPushNote.
    expect(res.note.ok).toBe(true);
    expect([...headFiles(root)].sort()).toEqual(renameSet(id));
    expect(g(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean)).toContain("staged-other.txt");
  });

  it("does not sweep an unstaged unrelated file into the note commit", async () => {
    const { root } = initProject();
    const id = "backlog.fix.repair-unstaged-other";
    writeStory(root, id, "arch-approved");
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    fs.writeFileSync(path.join(root, "unrelated.txt"), "dirty\n");

    const res = await repair(root, id);

    expect(res.note.ok).toBe(true);
    expect([...headFiles(root)].sort()).toEqual(renameSet(id));
    expect(porcelain(root)).toContain("unrelated.txt");
  });

  it("reports a push failure instead of omitting it; the commit still landed and repaired stays true", async () => {
    const { root } = initProject({ withOrigin: false });
    const id = "backlog.fix.repair-push-fails";
    writeStory(root, id, "arch-approved");
    commitWithTrailer(root, id);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    expect(res.note.ok).toBe(false);
    expect(typeof res.note.error).toBe("string");
    expect(res.note.error.length).toBeGreaterThan(0);
    expect(res.note.commitId).toBe(shortHead(root));
    expect(porcelain(root, `notes/${id}.md`)).toBe("");
    expect(porcelain(root, `notes/${archivedId(id)}.md`)).toBe("");
  });

  it("archives the note to backlog.z_implemented in the repair commit and pushes it", async () => {
    const { root, bare } = initProject();
    const id = "backlog.fix.repair-archives";
    writeStory(root, id, "arch-approved", 'status: "not-implemented"\n');
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    const before = head(root);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    expect(head(root)).not.toBe(before);
    // One HEAD commit deletes the live path and adds the archived path.
    const nameStatus = g(root, ["show", "--name-status", "--no-renames", "--format=", "HEAD"]).split("\n").filter(Boolean).map((l) => l.split(/\s+/));
    expect(nameStatus).toContainEqual(["D", `notes/${id}.md`]);
    expect(nameStatus).toContainEqual(["A", `notes/${archivedId(id)}.md`]);
    expect(nameStatus.length).toBe(2);
    expect(g(root, ["rev-parse", "HEAD~1"]).trim()).toBe(before);
    const archived = g(root, ["show", `HEAD:notes/${archivedId(id)}.md`]);
    expect(archived).toMatch(/^status: "?implemented"?$/m);
    expect(archived).toContain('phase: "integrated"');
    expect(archived).toMatch(new RegExp(`^id: "?${archivedId(id).replace(/\./g, "\\.")}"?$`, "m"));
    expect(fs.existsSync(path.join(root, "notes", `${id}.md`))).toBe(false);
    expect(porcelain(root)).toBe("");
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(head(root));
  });

  it("reports the archive outcome from the observed rename", async () => {
    const { root } = initProject();
    const id = "backlog.fix.repair-archive-outcome";
    writeStory(root, id, "arch-approved", 'status: "not-implemented"\n');
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);

    const res = await repair(root, id);

    expect(res.archive).toBeTruthy();
    const onDiskNew = fs.existsSync(res.archive.newPath);
    const onDiskOld = fs.existsSync(res.archive.oldPath);
    expect(res.archive.archived).toBe(onDiskNew && !onDiskOld);
    expect(res.archive.archived).toBe(true);
    expect(res.archive.newPath).toBe(path.join(root, "notes", `${archivedId(id)}.md`));
    expect(res.archive.oldPath).toBe(path.join(root, "notes", `${id}.md`));
  });

  it("leaves an existing backlog.z_implemented counterpart untouched", async () => {
    const { root } = initProject();
    const id = "backlog.fix.repair-already-archived";
    writeStory(root, id, "arch-approved", 'status: "not-implemented"\n');
    const counterpart = path.join(root, "notes", `${archivedId(id)}.md`);
    const counterpartBytes = `---\nid: "${archivedId(id)}"\ntitle: "T"\nstatus: "implemented"\nphase: "integrated"\n---\n\nshipped earlier\n`;
    fs.writeFileSync(counterpart, counterpartBytes);
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    expect(res.archive.archived).toBe(false);
    expect(res.archive.skipped).toBe(true);
    expect(res.archive.reason).toBe("already_implemented");
    expect(fs.readFileSync(counterpart, "utf8")).toBe(counterpartBytes);
    expect(g(root, ["show", `HEAD:notes/${archivedId(id)}.md`])).toBe(counterpartBytes);
    // The live note's phase write is still persisted, and only it is in the commit.
    expect(headFiles(root)).toEqual([`notes/${id}.md`]);
    expect(fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8")).toMatch(/^status: "?not-implemented"?$/m);
  });
});

describe("a failed note commit is reported, not omitted", { timeout: 60_000 }, () => {
  it.skipIf(process.platform === "win32")("commit vetoed by a pre-commit hook: repaired true, note.ok false with the commit error, no commitId, HEAD and origin unchanged, note dirty", async () => {
    const { root, bare } = initProject();
    const id = "backlog.fix.repair-commit-fails";
    writeStory(root, id, "arch-approved");
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    // Make the COMMIT step fail (not add, not push): commitAndPushNote runs `git commit` without
    // --no-verify, so a pre-commit hook that exits 1 vetoes it. Installed AFTER the fixture's own
    // commits, through a repo-local core.hooksPath, which overrides any global hooksPath, so the
    // veto is deterministic on every machine. The dir lives under .git so it never shows as dirty.
    const hooksDir = path.join(root, ".git", "rks-test-hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho rks-test-precommit-veto >&2\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    g(root, ["config", "core.hooksPath", hooksDir]);
    const before = head(root);

    const res = await repair(root, id);

    // The phase write happened, so repaired stays true; the failed commit is reported, not omitted.
    expect(res.repaired).toBe(true);
    expect(res.note.ok).toBe(false);
    expect(typeof res.note.error).toBe("string");
    // The hook's own stderr marker proves it was the commit step that failed.
    expect(res.note.error).toContain("rks-test-precommit-veto");
    // No commit landed, so no commitId may be claimed (contrast the push-failure case).
    expect(res.note.commitId).toBeUndefined();
    expect(head(root)).toBe(before);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(before);
    // The archive ran before the vetoed commit, so the archived note is left uncommitted at the new path.
    expect(porcelain(root, `notes/${archivedId(id)}.md`)).not.toBe("");
    expect(fs.readFileSync(path.join(root, "notes", `${archivedId(id)}.md`), "utf8")).toContain('phase: "integrated"');
    expect(res.archive.archived).toBe(true);
  });
});

describe("off the integration branch the repair makes no commit and says so", { timeout: 60_000 }, () => {
  it("feature branch checked out: repaired true, note skipped with not_on_integration_branch, HEAD unchanged, note dirty", async () => {
    const { root } = initProject();
    const id = "backlog.fix.repair-off-integration";
    writeStory(root, id, "arch-approved");
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    g(root, ["checkout", "-b", "feature/x"]);
    const before = head(root);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    expect(res.note.ok).toBe(false);
    expect(res.note.skipped).toBe(true);
    expect(res.note.reason).toBe("not_on_integration_branch");
    expect(res.note.currentBranch).toBe("feature/x");
    expect(res.note.integrationBranch).toBe("staging");
    expect(res.note.commitId).toBeUndefined();
    expect(head(root)).toBe(before);
    expect(porcelain(root, `notes/${id}.md`)).not.toBe("");
    expect(fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8")).toContain('phase: "integrated"');
  });

  it("feature branch checked out: the note is not renamed and its status is unchanged", async () => {
    const { root } = initProject();
    const id = "backlog.fix.repair-off-integration-no-archive";
    writeStory(root, id, "arch-approved", 'status: "not-implemented"\n');
    commitWithTrailer(root, id);
    g(root, ["push", "origin", "staging"]);
    g(root, ["checkout", "-b", "feature/y"]);

    const res = await repair(root, id);

    expect(res.repaired).toBe(true);
    expect(res.archive).toBeUndefined();
    expect(fs.existsSync(path.join(root, "notes", `${id}.md`))).toBe(true);
    expect(fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8")).toMatch(/^status: "?not-implemented"?$/m);
    expect(fs.readdirSync(path.join(root, "notes")).filter((f) => f.startsWith("backlog.z_implemented."))).toEqual([]);
  });
});

describe("refusals and the no-op create no commit", { timeout: 60_000 }, () => {
  const cases = [
    ["story_not_found", () => "backlog.fix.absent", {}],
    ["no_merged_commit_for_story", (root) => {
      const id = "backlog.fix.never-merged";
      writeStory(root, id, "arch-approved");
      commitWithTrailer(root, "backlog.fix.someone-else");
      return id;
    }, {}],
    ["phase_not_on_off_rail_ladder", (root) => {
      const id = "backlog.fix.still-draft";
      writeStory(root, id, "draft");
      commitWithTrailer(root, id);
      return id;
    }, {}],
    ["evidence_unreadable", (root) => {
      const id = "backlog.fix.bad-ref";
      writeStory(root, id, "arch-approved");
      commitWithTrailer(root, id);
      return id;
    }, { branches: { integration: "no-such-branch" } }],
    ["already_advanced", (root) => {
      const id = "backlog.fix.already-integrated";
      writeStory(root, id, "integrated");
      commitWithTrailer(root, id);
      return id;
    }, {}],
  ];

  it.each(cases)("%s: HEAD unchanged, no commitId in the result", async (reason, setup, projectJson) => {
    const { root } = initProject({ projectJson });
    const id = setup(root);
    const before = head(root);

    const res = await repair(root, id);

    expect(res.reason).toBe(reason);
    expect(res.repaired).toBe(false);
    expect(head(root)).toBe(before);
    expect(res.note?.commitId).toBeUndefined();
  });
});

describe("the tool description states the persistence contract", () => {
  it("says a successful repair commits the story note", async () => {
    const { root } = initProject();
    const tools = await withClient(root, async (c) => (await c.listTools()).tools);
    const tool = tools.find((t) => t.name === "rks_phase_repair");
    expect(tool, "rks_phase_repair listed").toBeTruthy();
    expect(tool.description).toContain("commits the story note");
    expect(tool.description).toContain("only when the integration branch is checked out");
  });
});
