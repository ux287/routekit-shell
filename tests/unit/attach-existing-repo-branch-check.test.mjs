/**
 * backlog.feat.attach-existing-repo-branch-check
 *
 * attachProject onto a repo with history checks that every configured branch exists, reports
 * branchCheck { configured, missing, current }, warns when one is missing, and never creates a
 * branch. Real git in temp dirs; every spawn has an explicit timeout; git runs under an isolated
 * env (temp HOME, GIT_CONFIG_NOSYSTEM, fixed identity) restored in afterEach. Every attachProject
 * call passes a TEMP shellRoot and an installDependencies stub (no registry write, no npm).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { attachProject, checkConfiguredBranches } from "../../packages/cli/src/project/bootstrap.mjs";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

const TIMEOUT = 120_000;
const TEST_TIMEOUT = 60_000;
const REPO = path.resolve(import.meta.dirname, "../..");
const THREE = { working: "dev", integration: "staging", production: "main" };
const tmps = [];
const ENV_KEYS = ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
let savedEnv;

function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
function gitOk(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const branchList = (root) => gitOk(root, ["branch", "--list", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort();
const currentBranch = (root) => gitOk(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

/** A client repo with history on `main`, plus each extra branch created from main. */
function clientRepo(extraBranches = []) {
  const root = mkTmp("rks-bc-client-");
  gitOk(root, ["init", "-q"]);
  gitOk(root, ["checkout", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(root, "README.md"), "# client\n");
  gitOk(root, ["add", "README.md"]);
  gitOk(root, ["commit", "-q", "-m", "client baseline"]);
  for (const b of extraBranches) gitOk(root, ["branch", b, "main"]);
  return root;
}

/** Temp shellRoot holding what attachProject reads (same set as content-only-remote-init-attach). */
function makeShellRoot() {
  const root = mkTmp("rks-bc-shell-");
  for (const rel of ["templates/base", "templates/generic", ".rks/prompts", ".rks/project.json",
    ".claude/skills", ".claude/agents", ".routekit/hooks-manifest.json", ".routekit/skills-manifest.json",
    "scripts/vitest-runner.mjs", "scripts/lib/spawn-managed.mjs", "scripts/mcp/codex-shim.sh",
    "packages/hooks", "package.json"]) {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(root, rel), { recursive: true });
  }
  return root;
}
const installStub = () => ({ ran: false });
const branchWarnings = (spy) => spy.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("[rks.attach]") && l.includes("--branch-model"));

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = mkTmp("rks-bc-home-");
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    // Both spellings: on macOS os.tmpdir() is under /var, which realpaths to /private/var.
    GIT_CEILING_DIRECTORIES: [os.tmpdir(), fs.realpathSync(os.tmpdir())].join(path.delimiter),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("attachProject branchCheck on a repo with history", () => {
  it("3-branch default, only main+staging: missing [dev], current reported, one warning, no branch created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = clientRepo(["staging"]);
    const before = branchList(root);
    const res = await attachProject({ shellRoot: makeShellRoot(), projectRoot: root, projectId: "bc-missing", installDependencies: installStub });
    expect(res.ok).toBe(true);
    expect(res.gitBootstrap).toMatchObject({ bootstrapped: false, reason: "existing-history" });
    expect([...res.branchCheck.configured].sort()).toEqual(["dev", "main", "staging"]);
    expect(res.branchCheck.missing).toEqual(["dev"]);
    expect(res.branchCheck.current).toBe("main");
    const warned = branchWarnings(warn);
    expect(warned).toHaveLength(1);
    for (const s of ["dev", "git branch dev", "--branch-model 2-branch"]) expect(warned[0]).toContain(s);
    expect(res.branchCheck.warning).toContain("--branch-model 2-branch");
    expect(branchList(root)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8")).branches).toEqual(THREE);
  }, TEST_TIMEOUT);

  it("main, staging and dev all exist: missing [] and no branch warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = clientRepo(["staging", "dev"]);
    const before = branchList(root);
    const res = await attachProject({ shellRoot: makeShellRoot(), projectRoot: root, projectId: "bc-all", installDependencies: installStub });
    expect(res.branchCheck.missing).toEqual([]);
    expect(res.branchCheck.warning).toBeUndefined();
    expect(branchWarnings(warn)).toEqual([]);
    expect(branchList(root)).toEqual(before);
  }, TEST_TIMEOUT);

  it("2-branch onto a repo whose only branch is main: missing []", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = clientRepo();
    const res = await attachProject({ shellRoot: makeShellRoot(), projectRoot: root, projectId: "bc-two", branchModel: "2-branch", installDependencies: installStub });
    expect(res.branchCheck.configured).toEqual(["main"]);
    expect(res.branchCheck.missing).toEqual([]);
    expect(branchList(root)).toEqual(["main"]);
  }, TEST_TIMEOUT);

  it("content-only attach keeps the 3-branch default and still never creates a branch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = clientRepo(["staging"]);
    const before = branchList(root);
    const res = await attachProject({ shellRoot: makeShellRoot(), projectRoot: root, projectId: "bc-co", contentOnly: true, installDependencies: installStub });
    expect(res.branchCheck.missing).toEqual(["dev"]);
    expect(branchWarnings(warn)).toHaveLength(1);
    expect(branchList(root)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8")).branches).toEqual(THREE);
  }, TEST_TIMEOUT);
});

describe("attachProject branchCheck on a fresh directory", () => {
  it("ensureGitBootstrap still creates the 3 branches on dev; branchCheck reports none missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = mkTmp("rks-bc-fresh-");
    const res = await attachProject({ shellRoot: makeShellRoot(), projectRoot: root, projectId: "bc-fresh", installDependencies: installStub });
    expect(res.gitBootstrap.bootstrapped).toBe(true);
    expect(currentBranch(root)).toBe("dev");
    expect(branchList(root)).toEqual(["dev", "main", "staging"]);
    expect(res.branchCheck.missing).toEqual([]);
    expect(res.branchCheck.current).toBe("dev");
  }, TEST_TIMEOUT);
});

describe("checkConfiguredBranches failure is observed, not thrown", () => {
  it("pointed at a directory that is not a git repository: no throw, error string", () => {
    const notRepo = mkTmp("rks-bc-norepo-");
    let out;
    expect(() => { out = checkConfiguredBranches({ projectRoot: notRepo, branches: THREE }); }).not.toThrow();
    expect(typeof out.error).toBe("string");
    expect(out.error.length).toBeGreaterThan(0);
  });
});

describe("CLI prints branchCheck", () => {
  const BC = { configured: ["main", "staging", "dev"], missing: ["dev"], current: "main", warning: "w" };
  const deps = (exit) => ({
    processExit: (code) => exit.push(code),
    initProjectFromStack: async (args) => ({ targetPath: args.targetPath }),
    listTemplates: () => [{ stackId: "s" }],
    attachProject: async () => ({ ok: true, vendor: null, branchCheck: BC }),
    verifyProjectRoot: () => ({ status: "pass", checks: [] }),
  });
  const printedBranchCheck = (log) => {
    for (const c of log.mock.calls) {
      try {
        const j = JSON.parse(c[0]);
        if (j && j.branchCheck) return j.branchCheck;
      } catch { /* not JSON */ }
    }
    return undefined;
  };

  it("attach stdout JSON contains branchCheck", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = [];
    await handleProjectCommand({ sub: "attach", kv: { id: "p", path: mkTmp("rks-bc-cli-a-") }, SHELL_ROOT: mkTmp("rks-bc-cli-shell-"), args: [] }, deps(exit));
    expect(printedBranchCheck(log)).toEqual(BC);
    expect(exit).toEqual([0]);
  });

  it("init stdout JSON contains branchCheck", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = [];
    await handleProjectCommand({ sub: "init", kv: { id: "p", stack: "s", path: mkTmp("rks-bc-cli-i-") }, SHELL_ROOT: mkTmp("rks-bc-cli-shell-"), args: [] }, deps(exit));
    expect(printedBranchCheck(log)).toEqual(BC);
  });
});
