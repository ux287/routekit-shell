// backlog.feat.commit-provenance-trailer-remaining-sites
// Real git in temp repos under os.tmpdir(). gh is stubbed: spawnSync("gh", ...) is recorded and
// never run, and execSync("which gh" | "gh ...") throws so rks_init sees no gh. Non-git execSync
// commands are no-ops (as in tests/unit/init-*.test.mjs). Every real spawn carries a timeout.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const state = vi.hoisted(() => ({ ghCalls: [] }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => {
      if (cmd === "gh") {
        state.ghCalls.push([...args]);
        return { status: 0, stdout: "", stderr: "", output: [], pid: 0, signal: null };
      }
      return actual.spawnSync(cmd, args, { timeout: 15_000, ...opts });
    },
    execSync: (cmd, opts = {}) => {
      const c = String(cmd);
      if (/^\s*(which\s+gh|gh\s)/.test(c)) throw new Error("gh stubbed in test");
      if (/^\s*git\s/.test(c)) return actual.execSync(c, { timeout: 15_000, ...opts });
      return "";
    },
  };
});

// AC6 isolation (ARCH round 1, finding 1): runInitTool calls attachProject, the upsertProject
// fallback and getProjectById. Unmocked, they write a fixture entry into the live, gitignored
// registry projects/index.jsonl. Mocked as in tests/unit/init-verified-outcome.test.mjs:35/:39,
// with getProjectById returning a truthy record so the post-write readback passes.
vi.mock("../../packages/cli/src/project/bootstrap.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  attachProject: vi.fn(async () => undefined),
}));
vi.mock("../../packages/cli/src/project/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  upsertProject: vi.fn(),
  getProjectById: vi.fn((id) => ({ id })),
}));

import { spawnSync } from "child_process";
import { runGitRevert, runGitCherryPick } from "../../packages/mcp-rks/src/server/git/git-core.mjs";
import { ghPrMerge } from "../../packages/mcp-rks/src/server/gh-tools.mjs";
import { runResolveConflict } from "../../packages/mcp-rks/src/server/git/git-release.mjs";
import { runInitTool } from "../../packages/mcp-rks/src/server/init.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/mcp-rks/src");
const REGISTRY = path.resolve(SRC, "../../..", "projects", "index.jsonl");
const registrySnapshot = () => (fs.existsSync(REGISTRY) ? fs.readFileSync(REGISTRY, "utf8") : null);
const GIT_TIMEOUT_MS = 15_000;
const LINE = "Rks-Provenance: v1 session=none tool=rks_sync_staging client=c via=mcp actor=a run=none";

function git(dir, args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (!allowFail && r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}
const body = (dir, ref = "HEAD") => git(dir, ["log", "-1", "--format=%B", ref]).stdout;
const subject = (dir, ref = "HEAD") => git(dir, ["log", "-1", "--format=%s", ref]).stdout.trim();
const head = (dir) => git(dir, ["rev-parse", "HEAD"]).stdout.trim();
const provLines = (text) => String(text).split("\n").filter((l) => l.startsWith("Rks-Provenance: v1 "));
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const ENV_KEYS = ["RKS_VIA", "RKS_VIA_DEFAULT", "RKS_ACTOR", "RKS_DISPATCH_RUN_ID", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
let saved;
const dirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS.slice(0, 4)) delete process.env[k];
  const cfg = path.join(tmp("prov-cfg-"), "gitconfig");
  fs.writeFileSync(cfg, "[commit]\n\tgpgsign = false\n");
  Object.assign(process.env, { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@test.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@test.invalid", GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1" });
  state.ghCalls.length = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (dirs.length) { try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ } }
});

function initRepo() {
  const dir = tmp("prov-remaining-");
  git(dir, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}
function commitFile(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ["add", file]);
  git(dir, ["commit", "-m", msg]);
  return head(dir);
}

describe("ghPrMerge carries exactly one Rks-Provenance line in --body (AC2)", () => {
  for (const method of ["squash", "merge"]) {
    it(`--${method}: argv prefix unchanged and a single --body carries exactly one line`, async () => {
      await ghPrMerge({ projectRoot: os.tmpdir(), prNumber: 42, method });
      const argv = state.ghCalls.find((a) => a[0] === "pr" && a[1] === "merge");
      expect(argv, JSON.stringify(state.ghCalls)).toBeDefined();
      expect(argv.slice(0, 5)).toEqual(["pr", "merge", "42", `--${method}`, "--delete-branch"]);
      const bi = argv.indexOf("--body");
      expect(bi).toBeGreaterThan(-1);
      expect(argv.indexOf("--body", bi + 1)).toBe(-1);
      expect(provLines(argv[bi + 1])).toHaveLength(1);
    });
  }
  it("--rebase: argv unchanged, no --body", async () => {
    await ghPrMerge({ projectRoot: os.tmpdir(), prNumber: 42, method: "rebase" });
    const argv = state.ghCalls.find((a) => a[0] === "pr" && a[1] === "merge");
    expect(argv, JSON.stringify(state.ghCalls)).toBeDefined();
    expect(argv).toEqual(["pr", "merge", "42", "--rebase", "--delete-branch"]);
    expect(argv).not.toContain("--body");
  });
  it("deleteBranch false: no --delete-branch, still exactly one line in --body", async () => {
    await ghPrMerge({ projectRoot: os.tmpdir(), prNumber: 42, method: "squash", deleteBranch: false });
    const argv = state.ghCalls.find((a) => a[0] === "pr" && a[1] === "merge");
    expect(argv.slice(0, 4)).toEqual(["pr", "merge", "42", "--squash"]);
    expect(argv).not.toContain("--delete-branch");
    expect(provLines(argv[argv.indexOf("--body") + 1])).toHaveLength(1);
  });
});

describe("runGitRevert stamps the revert commit (AC3)", { timeout: 30_000 }, () => {
  it("noCommit false: keeps git's Revert subject and carries exactly one line", async () => {
    const dir = initRepo();
    const sha = commitFile(dir, "a.txt", "changed\n", "feat: x");
    const res = await runGitRevert({ projectRoot: dir, commit: sha });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(head(dir).startsWith(String(res.newCommit))).toBe(true);
    expect(subject(dir)).toBe('Revert "feat: x"');
    expect(provLines(body(dir))).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("base\n");
  });
  it("noCommit true: creates no commit", async () => {
    const dir = initRepo();
    const sha = commitFile(dir, "a.txt", "changed\n", "feat: x");
    const res = await runGitRevert({ projectRoot: dir, commit: sha, noCommit: true });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.action).toBe("revert_staged");
    expect(head(dir)).toBe(sha);
  });
});

describe("runGitCherryPick stamps the picked commit (AC4)", { timeout: 30_000 }, () => {
  it("source with no trailer: keeps the source subject and carries at least one line", async () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "side"]);
    const sha = commitFile(dir, "b.txt", "b\n", "feat: side");
    expect(provLines(body(dir, sha))).toHaveLength(0);
    git(dir, ["checkout", "main"]);
    const res = await runGitCherryPick({ projectRoot: dir, commit: sha });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(head(dir).startsWith(String(res.newCommit))).toBe(true);
    expect(subject(dir)).toBe("feat: side");
    expect(provLines(body(dir)).length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(true);
  });
  it("noCommit true: creates no commit", async () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "side"]);
    const sha = commitFile(dir, "b.txt", "b\n", "feat: side");
    git(dir, ["checkout", "main"]);
    const before = head(dir);
    const res = await runGitCherryPick({ projectRoot: dir, commit: sha, noCommit: true });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.action).toBe("cherry_pick_staged");
    expect(head(dir)).toBe(before);
  });
  it("conflict: reports hasConflict as before, and abort true restores the pre-pick state", async () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "side"]);
    const sha = commitFile(dir, "a.txt", "side\n", "side change");
    git(dir, ["checkout", "main"]);
    const before = commitFile(dir, "a.txt", "main\n", "main change");
    const res = await runGitCherryPick({ projectRoot: dir, commit: sha });
    expect(res.ok).toBe(false);
    expect(res.hasConflict, JSON.stringify(res)).toBe(true);
    const aborted = await runGitCherryPick({ projectRoot: dir, abort: true });
    expect(aborted.ok, JSON.stringify(aborted)).toBe(true);
    expect(head(dir)).toBe(before);
    expect(git(dir, ["status", "--porcelain"]).stdout.trim()).toBe("");
  });
});

describe("conflict finalisation produces exactly one line (AC7)", { timeout: 30_000 }, () => {
  function conflicted(msgArgs) {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "side"]);
    commitFile(dir, "a.txt", "side\n", "side change");
    git(dir, ["checkout", "main"]);
    commitFile(dir, "a.txt", "main\n", "main change");
    const r = git(dir, ["merge", "--no-ff", "side", ...msgArgs], { allowFail: true });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    return dir;
  }
  it("runResolveConflict: MERGE_MSG already carrying the trailer yields one line, not two", async () => {
    const dir = conflicted(["-m", "Merge side into main", "-m", LINE]);
    const res = await runResolveConflict({ projectRoot: dir, strategy: "theirs", files: ["a.txt"] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(git(dir, ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(/\s+/)).toHaveLength(3);
    expect(subject(dir)).toBe("Merge side into main");
    expect(provLines(body(dir)), body(dir)).toHaveLength(1);
  });
  it("runResolveConflict: MERGE_MSG with no trailer still yields exactly one line", async () => {
    const dir = conflicted(["-m", "Merge side into main"]);
    const res = await runResolveConflict({ projectRoot: dir, strategy: "theirs", files: ["a.txt"] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(provLines(body(dir)), body(dir)).toHaveLength(1);
  });
  it("the git agent merge-continue commit uses the same commit-trailer helper as runResolveConflict", () => {
    const helperOf = (src) => {
      const line = src.split("\n").find((l) => /["']commit["'],\s*["']--no-edit["']/.test(l));
      const m = line && line.match(/\.\.\.(\w+)\(/);
      return m ? m[1] : null;
    };
    const agent = helperOf(readSrc("agents/git.mjs"));
    expect(agent).toBeTruthy();
    expect(agent).toBe(helperOf(readSrc("server/git/git-release.mjs")));
  });
});

describe("rks_init root commit (AC6)", { timeout: 60_000 }, () => {
  it("keeps its subject, carries exactly one line, and leaves projects/index.jsonl unmodified", async () => {
    const registryBefore = registrySnapshot();
    const parent = tmp("prov-init-");
    const res = await runInitTool({ projectName: "prov-init-fixture", parentDir: parent });
    expect(registrySnapshot()).toBe(registryBefore);
    expect(res.success, JSON.stringify(res)).toBe(true);
    const dir = path.join(parent, "prov-init-fixture");
    expect(fs.existsSync(path.join(dir, ".git")), JSON.stringify(res)).toBe(true);
    const roots = git(dir, ["rev-list", "--max-parents=0", "HEAD"]).stdout.trim().split("\n");
    expect(roots).toHaveLength(1);
    expect(subject(dir, roots[0])).toBe("chore: initialize project from routekit-shell template");
    expect(provLines(body(dir, roots[0]))).toHaveLength(1);
  });
});

describe("source shape of the stamped sites (AC1, AC5)", () => {
  it("every git-ship.mjs --no-ff merge builds its message with provenanceMergeMessageArgs", () => {
    const lines = readSrc("server/git/git-ship.mjs").split("\n").filter((l) => /["']merge["'],\s*["']--no-ff["']/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l).toContain("provenanceMergeMessageArgs(");
  });
  it("the planner advance-to-planned commit is no longer a shell string and is stamped with provenanceTrailerLine", () => {
    const src = readSrc("server/handlers/planner.mjs");
    expect(src).not.toContain('git commit -m "chore(backlog): advance');
    expect(src).toMatch(/chore\(backlog\): advance \$\{[^}]+\} to planned/);
    expect((src.match(/provenanceTrailerLine\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
