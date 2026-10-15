/**
 * backlog.fix.upgrade-leaves-child-tree-dirty — UNIT tier.
 *
 * Covers the .gitignore self-heal, the commit gating (dry-run, --no-commit, non-reconciling
 * boundaries, not-a-repo), the not-committed report defaults and the CLI surface. The git
 * primitive is INJECTED (deps.git), so nothing here spawns a subprocess (tests/unit/README.md
 * criterion 1). Behaviour that needs a real repository lives in
 * tests/integration/upgrade-leaves-child-tree-clean.test.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

const ENTRIES = [".rks/.upgrade-backup/", ".rks/.backup/"];
const MUTATING = new Set(["add", "commit", "reset", "rm", "stash", "checkout"]);
const created = [];
afterEach(() => {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
});

function setupChild({ from = "0.20.18", gitignore } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), "rks-upg-commit-child-"));
  const shellRoot = mkdtempSync(join(tmpdir(), "rks-upg-commit-shell-"));
  created.push(projectRoot, shellRoot);
  mkdirSync(join(projectRoot, ".rks"), { recursive: true });
  writeFileSync(join(projectRoot, ".rks", "project.json"), JSON.stringify({ id: "calc", rksVersion: from }, null, 2));
  writeFileSync(join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
  writeFileSync(join(projectRoot, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
  if (gitignore !== undefined) writeFileSync(join(projectRoot, ".gitignore"), gitignore);
  mkdirSync(join(shellRoot, ".routekit"), { recursive: true });
  writeFileSync(join(shellRoot, ".routekit", "hooks-manifest.json"), JSON.stringify({}));
  return { projectRoot, shellRoot };
}

/** A git primitive that records every call and fails every call, as in a non-repository. */
const notARepoGit = () =>
  vi.fn(() => {
    throw new Error("fatal: not a git repository (or any of the parent directories): .git");
  });

function spies(to, git = notARepoGit()) {
  return {
    readRksVersion: vi.fn(() => to),
    syncProject: vi.fn(() => []),
    repinMcpServer: vi.fn(() => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] })),
    migrateChildSettingsHookPaths: vi.fn(() => false),
    ensureHookRegistration: vi.fn(() => ({ changed: false })),
    mergeRksPermissionAllow: vi.fn(() => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] })),
    migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true })),
    seedVitestFiles: vi.fn(() => ({ created: [], templateMissing: [] })),
    now: () => "TS",
    git,
  };
}

const readIgnore = (root) => readFileSync(join(root, ".gitignore"), "utf8");
const ruleLines = (root) => readIgnore(root).split("\n").map((l) => l.trim());
const mutatingCalls = (git) => git.mock.calls.filter(([args]) => MUTATING.has(args[0]));
const run = (projectRoot, shellRoot, to, opts, git) =>
  upgradeProject({ projectRoot, projectId: "calc", shellRoot, opts }, spies(to, git));

describe("upgradeProject — .gitignore self-heal", () => {
  it("appends both backup rules on a patch boundary, preserving existing content as a prefix", () => {
    const original = "node_modules/\n# operator note\n.env\n";
    const { projectRoot, shellRoot } = setupChild({ gitignore: original });
    const r = run(projectRoot, shellRoot, "0.20.19");
    expect(r.ok).toBe(true);
    expect(readIgnore(projectRoot).startsWith(original)).toBe(true);
    for (const e of ENTRIES) expect(ruleLines(projectRoot)).toContain(e);
  });

  it("creates .gitignore when the child has none", () => {
    const { projectRoot, shellRoot } = setupChild();
    run(projectRoot, shellRoot, "0.20.19");
    expect(existsSync(join(projectRoot, ".gitignore"))).toBe(true);
    for (const e of ENTRIES) expect(ruleLines(projectRoot)).toContain(e);
  });

  it("treats a slashless rule as already present and does not duplicate it", () => {
    const { projectRoot, shellRoot } = setupChild({ gitignore: ".rks/.upgrade-backup\n" });
    run(projectRoot, shellRoot, "0.20.19");
    const hits = ruleLines(projectRoot).filter((l) => /^\.rks\/\.upgrade-backup\/?$/.test(l));
    expect(hits).toHaveLength(1);
    expect(ruleLines(projectRoot)).toContain(".rks/.backup/");
  });

  it("is idempotent: a second upgrade changes no byte and reports no .gitignore entry", () => {
    const { projectRoot, shellRoot } = setupChild({ gitignore: "node_modules/\n" });
    const r1 = run(projectRoot, shellRoot, "0.20.19");
    expect(r1.reconciled.some((e) => e.startsWith(".gitignore"))).toBe(true);
    const after1 = readIgnore(projectRoot);
    const r2 = run(projectRoot, shellRoot, "0.20.20");
    expect(r2.stampAdvanced).toBe(true);
    expect(readIgnore(projectRoot)).toBe(after1);
    expect(r2.reconciled.some((e) => e.startsWith(".gitignore"))).toBe(false);
  });

  it.each([
    ["none", "0.20.18", "0.20.18"],
    ["downgrade", "0.20.18", "0.20.17"],
    ["major", "1.2.3", "2.0.0"],
  ])("a %s boundary neither touches .gitignore nor calls git", (_boundary, from, to) => {
    const { projectRoot, shellRoot } = setupChild({ from, gitignore: "node_modules/\n" });
    const git = notARepoGit();
    run(projectRoot, shellRoot, to, {}, git);
    expect(readIgnore(projectRoot)).toBe("node_modules/\n");
    expect(git).not.toHaveBeenCalled();
  });
});

describe("upgradeProject — commit gating and not-committed report defaults", () => {
  it("an early-return report carries the commit fields with not-committed defaults", () => {
    const { projectRoot, shellRoot } = setupChild({ from: "0.20.18" });
    const r = run(projectRoot, shellRoot, "0.20.18");
    expect(r.committed).toBe(false);
    expect(r.commitSha).toBeNull();
    expect(r.committedFiles).toEqual([]);
    expect(r).toHaveProperty("commitSkipped");
  });

  it("--dry-run writes no .gitignore, makes no mutating git call, and says a commit would be made", () => {
    const { projectRoot, shellRoot } = setupChild({ gitignore: "node_modules/\n" });
    const git = notARepoGit();
    const r = run(projectRoot, shellRoot, "0.20.19", { dryRun: true }, git);
    expect(readIgnore(projectRoot)).toBe("node_modules/\n");
    expect(mutatingCalls(git)).toEqual([]);
    expect(r.committed).toBe(false);
    expect(r.commitSkipped).toBe("dry_run");
    expect(r.warnings.join("\n")).toMatch(/would commit/i);
  });

  it("--no-commit still heals .gitignore but makes no mutating git call", () => {
    const { projectRoot, shellRoot } = setupChild({ gitignore: "node_modules/\n" });
    const git = notARepoGit();
    const r = run(projectRoot, shellRoot, "0.20.19", { noCommit: true }, git);
    for (const e of ENTRIES) expect(ruleLines(projectRoot)).toContain(e);
    expect(mutatingCalls(git)).toEqual([]);
    expect(r.committed).toBe(false);
    expect(r.commitSkipped).toBe("no_commit");
  });

  it("a child that is not a git repository still upgrades: ok, stamped, not committed, warned", () => {
    const { projectRoot, shellRoot } = setupChild();
    const r = run(projectRoot, shellRoot, "0.20.19");
    expect(r.ok).toBe(true);
    expect(r.stampAdvanced).toBe(true);
    expect(r.committed).toBe(false);
    expect(r.commitSha).toBeNull();
    expect(r.committedFiles).toEqual([]);
    expect(r.commitSkipped).toBe("not_git_repo");
    expect(r.warnings.some((w) => /commit/i.test(w))).toBe(true);
  });
});

const SHELL_ROOT = "/tmp/shell-root";
function okReport(over = {}) {
  return {
    ok: true, projectId: "fixture-child", from: "0.20.18", to: "0.20.19", boundary: "patch", gated: false,
    dryRun: false, backupPath: null, reconciled: [], migrationsApplied: [], preserved: [],
    stampAdvanced: true, restartRequired: true, warnings: [], ...over,
  };
}

describe("project upgrade CLI — --no-commit and the commit outcome", () => {
  let logs;
  let errs;
  let logSpy;
  let errSpy;
  beforeEach(() => {
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  const makeDeps = (over = {}) => ({
    processExit: vi.fn(),
    upgradeProject: vi.fn(() => okReport()),
    getProjectById: vi.fn(() => ({ id: "fixture-child", root: "/tmp/child-root" })),
    ...over,
  });
  function makeChildren(n) {
    const kids = Array.from({ length: n }, (_, i) => ({ id: `child-${i}`, root: mkdtempSync(join(tmpdir(), `commit-kid-${i}-`)) }));
    created.push(...kids.map((k) => k.root));
    return kids;
  }

  it("threads --no-commit into opts for --id, defaulting to false when absent", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child", "no-commit": true }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { dryRun: false, noBackup: false, noCommit: true } }),
    );
    const deps2 = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps2);
    expect(deps2.upgradeProject).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ noCommit: false }) }),
    );
  });

  it("threads --no-commit into every child's opts under --all", async () => {
    const children = makeChildren(2);
    const deps = makeDeps({ loadProjects: vi.fn(() => children) });
    await handleProjectCommand({ sub: "upgrade", kv: { all: true, "no-commit": true }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).toHaveBeenCalledTimes(2);
    for (const [arg] of deps.upgradeProject.mock.calls) expect(arg.opts.noCommit).toBe(true);
  });

  it("names --no-commit in the upgrade usage string", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: {}, SHELL_ROOT }, deps);
    expect(errs.join("\n")).toContain("--no-commit");
  });

  it("names --no-commit in the --all-only usage string (--all combined with --id)", async () => {
    const deps = makeDeps();
    await handleProjectCommand({ sub: "upgrade", kv: { all: true, id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(errs.join("\n")).toContain("--no-commit");
    expect(deps.upgradeProject).not.toHaveBeenCalled();
  });

  it("--id output surfaces the commit sha when committed", async () => {
    const deps = makeDeps({
      upgradeProject: vi.fn(() =>
        okReport({ committed: true, commitSha: "abc1234def5678", committedFiles: [".rks/project.json"], commitSkipped: null }),
      ),
    });
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, deps);
    expect(logs.join("\n")).toContain("abc1234");
  });

  it("--all: one child's commit failure neither aborts the loop nor affects the others", async () => {
    const children = makeChildren(3);
    const reports = [
      okReport({ projectId: "child-0", committed: false, commitSha: null, committedFiles: [], commitSkipped: "commit_failed", warnings: ["upgrade commit failed: pre-commit hook rejected"] }),
      okReport({ projectId: "child-1", committed: true, commitSha: "1111111aaaa", committedFiles: [".rks/project.json"], commitSkipped: null }),
      okReport({ projectId: "child-2", committed: true, commitSha: "2222222bbbb", committedFiles: [".rks/project.json"], commitSkipped: null }),
    ];
    const deps = makeDeps({ loadProjects: vi.fn(() => children), upgradeProject: vi.fn(() => reports.shift()) });
    await handleProjectCommand({ sub: "upgrade", kv: { all: true }, SHELL_ROOT }, deps);
    expect(deps.upgradeProject).toHaveBeenCalledTimes(3);
    const out = logs.join("\n");
    expect(out).toContain("1111111");
    expect(out).toContain("2222222");
    expect(out).toMatch(/commit_failed|not committed/i);
    expect(logs.find((l) => l.startsWith("Upgraded ")) || "").toContain("Upgraded 3/3 children");
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it("a report without commit fields prints no 'undefined' on any commit line", async () => {
    const children = makeChildren(1);
    await handleProjectCommand({ sub: "upgrade", kv: { all: true }, SHELL_ROOT }, makeDeps({ loadProjects: vi.fn(() => children) }));
    await handleProjectCommand({ sub: "upgrade", kv: { id: "fixture-child" }, SHELL_ROOT }, makeDeps());
    expect(logs.filter((l) => /commit/i.test(l)).join("\n")).not.toContain("undefined");
  });
});
