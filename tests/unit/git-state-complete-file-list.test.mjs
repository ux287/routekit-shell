/**
 * backlog.fix.git-state-complete-file-list
 *
 * git_state (git agent tool), rks_git_state (MCP handler) and check_state (ship agent tool) must
 * report the complete dirty set:
 * -uall (files inside new untracked directories are listed individually), no silent 20-entry cap,
 * per-entry porcelain status, and paths containing spaces returned intact.
 * Real git in an os.tmpdir() fixture. Every subprocess spawn carries an explicit timeout.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, loadContext: async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: {}, kg: {} }) };
});

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { createGitAgent } from "../../packages/mcp-rks/src/agents/git.mjs";
import { createShipAgent } from "../../packages/mcp-rks/src/agents/ship.mjs";

const GIT_TIMEOUT_MS = 15_000;
const made = [];

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

function write(dir, rel, content = "x\n") {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeRepo() {
  const dir = makeTempDir("git-state-complete");
  made.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  write(dir, "tracked.txt", "v1\n");
  git(dir, ["add", "tracked.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function agentState(dir) {
  const config = createGitAgent({ projectId: "t", request: "r", projectRoot: dir });
  const tool = config.tools.find((t) => t.name === "git_state");
  return tool.execute({});
}

async function handlerState(dir) {
  h.root = dir;
  const r = createHandlerRegistry();
  const pid = z.object({ projectId: z.string() });
  registerProjectMetaHandlers(r, { projectGetSchema: z.object({ id: z.string() }), kgQuerySchema: pid, templatesListSchema: z.any(), gitStateSchema: pid, publishSchema: pid, publishProfilesSchema: pid });
  const res = await r.lookupHandler("rks_git_state")({ projectId: "git-state-fixture" }, {});
  return JSON.parse(res.content[0].text);
}

afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

describe("git_state (agent tool) reports the complete dirty set", () => {
  it("returns every one of 25 changed paths, or flags truncation with the true total", async () => {
    const dir = makeRepo();
    for (let i = 0; i < 25; i++) write(dir, `f${String(i).padStart(2, "0")}.txt`);
    const s = await agentState(dir);
    expect(s.filesChanged).toBe(25);
    expect(typeof s.truncated).toBe("boolean");
    if (s.truncated) {
      expect(s.total).toBe(25);
      expect(s.returned).toBe(s.files.length);
      expect(s.files.length).toBeLessThan(25);
    } else {
      expect(s.files).toHaveLength(25);
      expect(s.filesChanged).toBe(s.files.length);
    }
  });

  it("lists a file inside a new untracked directory individually", async () => {
    const dir = makeRepo();
    write(dir, "newdir/a.txt");
    const paths = (await agentState(dir)).files.map((f) => f.path);
    expect(paths).toContain("newdir/a.txt");
    expect(paths).not.toContain("newdir/");
  });

  it("marks untracked entries ?? and modified entries M", async () => {
    const dir = makeRepo();
    write(dir, "tracked.txt", "v2\n");
    write(dir, "new.txt");
    const byPath = Object.fromEntries((await agentState(dir)).files.map((f) => [f.path, f.status]));
    expect(byPath["new.txt"]).toBe("??");
    expect(byPath["tracked.txt"]).toBe("M");
  });

  it("returns a path containing a space intact", async () => {
    const dir = makeRepo();
    write(dir, "dir with space/my file.txt");
    const paths = (await agentState(dir)).files.map((f) => f.path);
    expect(paths).toContain("dir with space/my file.txt");
  });

  it("keeps dirty semantics: clean tree is not dirty, untracked-only tree is dirty", async () => {
    const dir = makeRepo();
    const clean = await agentState(dir);
    expect(clean.dirty).toBe(false);
    expect(clean.files).toEqual([]);
    write(dir, "only-untracked.txt");
    expect((await agentState(dir)).dirty).toBe(true);
  });
});

describe("rks_git_state (MCP handler) reports the complete dirty set", () => {
  it("returns every one of 25 changed paths, or flags truncation with the true total", async () => {
    const dir = makeRepo();
    for (let i = 0; i < 25; i++) write(dir, `f${String(i).padStart(2, "0")}.txt`);
    const s = await handlerState(dir);
    expect(typeof s.uncommittedTruncated).toBe("boolean");
    expect(s.uncommittedTotal).toBe(25);
    if (s.uncommittedTruncated) {
      expect(s.uncommittedFiles.length).toBeLessThan(25);
    } else {
      expect(s.uncommittedFiles).toHaveLength(25);
      expect(s.uncommittedEntries).toHaveLength(25);
    }
  });

  it("lists a file inside a new untracked directory individually", async () => {
    const dir = makeRepo();
    write(dir, "newdir/a.txt");
    const s = await handlerState(dir);
    expect(s.uncommittedFiles).toContain("newdir/a.txt");
    expect(s.uncommittedFiles).not.toContain("newdir/");
  });

  it("exposes per-entry status: untracked ?? and modified M", async () => {
    const dir = makeRepo();
    write(dir, "tracked.txt", "v2\n");
    write(dir, "new.txt");
    const byPath = Object.fromEntries((await handlerState(dir)).uncommittedEntries.map((e) => [e.path, e.status]));
    expect(byPath["new.txt"]).toBe("??");
    expect(byPath["tracked.txt"]).toBe("M");
  });

  it("returns the first entry intact when its porcelain line starts with a space (unstaged modification)", async () => {
    const dir = makeRepo();
    write(dir, "tracked.txt", "v2\n");
    const s = await handlerState(dir);
    expect(s.uncommittedFiles).toEqual(["tracked.txt"]);
  });

  it("returns a path containing a space intact", async () => {
    const dir = makeRepo();
    write(dir, "dir with space/my file.txt");
    expect((await handlerState(dir)).uncommittedFiles).toContain("dir with space/my file.txt");
  });

  it("keeps isClean semantics: clean tree is clean, untracked-only tree is not", async () => {
    const dir = makeRepo();
    const clean = await handlerState(dir);
    expect(clean.isClean).toBe(true);
    expect(clean.uncommittedFiles).toEqual([]);
    write(dir, "only-untracked.txt");
    expect((await handlerState(dir)).isClean).toBe(false);
  });
});

async function shipState(dir) {
  // No .rks/project.json in the fixture: resolveShipTarget defaults baseBranch to "staging"
  // (agents/project-config.mjs:35, :41), so the factory returns the real tool list.
  const config = createShipAgent({ projectId: "t", title: "t", projectRoot: dir });
  const tool = config.tools.find((t) => t.name === "check_state");
  expect(tool, "check_state tool present").toBeTruthy();
  return tool.execute({});
}

describe("check_state (ship agent tool) reports the complete dirty set", () => {
  it("returns every one of 25 changed paths, or flags truncation with the true total", async () => {
    const dir = makeRepo();
    for (let i = 0; i < 25; i++) write(dir, `f${String(i).padStart(2, "0")}.txt`);
    const s = await shipState(dir);
    expect(s.filesChanged).toBe(25);
    expect(typeof s.truncated).toBe("boolean");
    if (s.truncated) {
      expect(s.total).toBe(25);
      expect(s.returned).toBe(s.files.length);
      expect(s.files.length).toBeLessThan(25);
    } else {
      expect(s.files).toHaveLength(25);
      expect(s.filesChanged).toBe(s.files.length);
    }
  });

  it("lists a file inside a new untracked directory individually", async () => {
    const dir = makeRepo();
    write(dir, "newdir/a.txt");
    const paths = (await shipState(dir)).files.map((f) => f.path);
    expect(paths).toContain("newdir/a.txt");
    expect(paths).not.toContain("newdir/");
  });

  it("returns { status, path } entries: untracked ?? and modified M (status column not eaten by trim)", async () => {
    const dir = makeRepo();
    write(dir, "tracked.txt", "v2\n");
    write(dir, "new.txt");
    const byPath = Object.fromEntries((await shipState(dir)).files.map((f) => [f.path, f.status]));
    expect(byPath["new.txt"]).toBe("??");
    expect(byPath["tracked.txt"]).toBe("M");
  });

  it("returns a path containing a space intact", async () => {
    const dir = makeRepo();
    write(dir, "dir with space/my file.txt");
    const paths = (await shipState(dir)).files.map((f) => f.path);
    expect(paths).toContain("dir with space/my file.txt");
  });

  it("keeps dirty semantics: clean tree is not dirty, untracked-only tree is dirty", async () => {
    const dir = makeRepo();
    const clean = await shipState(dir);
    expect(clean.dirty).toBe(false);
    expect(clean.files).toEqual([]);
    write(dir, "only-untracked.txt");
    expect((await shipState(dir)).dirty).toBe(true);
  });
});

describe("a failed git status is reported, never read as a clean tree", () => {
  it("git_state and check_state return an error, not dirty:false, outside a git repo", async () => {
    const dir = makeTempDir("git-state-not-a-repo");
    made.push(dir);
    const agent = await agentState(dir);
    expect(agent.error).toMatch(/git/i);
    expect(agent.dirty).toBeUndefined();
    const ship = await shipState(dir);
    expect(ship.error).toMatch(/git/i);
    expect(ship.dirty).toBeUndefined();
  });

  it("a staged rename is listed once, under its new path", async () => {
    const dir = makeRepo();
    git(dir, ["mv", "tracked.txt", "renamed.txt"]);
    const agent = await agentState(dir);
    expect(agent.files).toEqual([{ status: "R", path: "renamed.txt" }]);
    expect(agent.truncated).toBe(false);
  });
});

describe("readPorcelainEntries", () => {
  it("throws on a failed git status instead of returning an empty (clean-looking) list", async () => {
    const { readPorcelainEntries } = await import("../../packages/mcp-rks/src/agents/git.mjs");
    const dir = makeTempDir("porcelain-not-a-repo");
    made.push(dir);
    expect(() => readPorcelainEntries(dir)).toThrow(/git status failed/);
    // Positive control: the same call in a real repo returns entries.
    const repo = makeRepo();
    write(repo, "new.txt");
    expect(readPorcelainEntries(repo)).toEqual([{ status: "??", path: "new.txt" }]);
  });
});
