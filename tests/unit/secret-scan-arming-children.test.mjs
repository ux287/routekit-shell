// tests/unit/secret-scan-arming-children.test.mjs
// backlog.security.gitleaks-gate-arming — hook copy and arming in attachProject and upgradeProject.
// Arming is reached only through the injected seam or a FAKE installer in a temp shellRoot: no network.
// Real git runs in temp dirs under an isolated env (temp HOME, GIT_CONFIG_NOSYSTEM, fixed identity);
// every spawn carries an explicit timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachProject } from "../../packages/cli/src/project/bootstrap.mjs";
import { upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const T = 15_000;
const TEST_TIMEOUT = 90_000;
const HOOK_REL = ".routekit/git-hooks/pre-commit";
const HOOK_BODY = "#!/bin/sh\n# test hook\nexit 0\n";
const OVERRIDE = "RKS_ALLOW_UNSCANNED_COMMIT";
const dirs = [];
const tmp = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); dirs.push(d); return d; };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf-8", timeout: T }).trim();
const porcelain = (cwd) => git(cwd, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
const trackedInHead = (cwd, rel) =>
  spawnSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd, encoding: "utf-8", timeout: T }).status === 0;
const installStub = () => ({ ran: false });
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const ENV_KEYS = ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CEILING_DIRECTORIES",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", OVERRIDE];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = tmp("rks-ssa-home-");
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CEILING_DIRECTORIES: [os.tmpdir(), fs.realpathSync(os.tmpdir())].join(path.delimiter),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  delete process.env[OVERRIDE];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// attachProject
// ---------------------------------------------------------------------------------------------

/** Temp shellRoot holding what attachProject reads (same set as attach-existing-repo-branch-check). */
function makeShellRoot({ hook = true } = {}) {
  const root = tmp("rks-ssa-shell-");
  for (const rel of ["templates/base", "templates/generic", ".rks/prompts", ".rks/project.json",
    ".claude/skills", ".claude/agents", ".routekit/hooks-manifest.json", ".routekit/skills-manifest.json",
    "scripts/vitest-runner.mjs", "scripts/lib/spawn-managed.mjs", "scripts/mcp/codex-shim.sh",
    "packages/hooks", "package.json"]) {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(root, rel), { recursive: true });
  }
  if (hook) write(root, HOOK_REL, HOOK_BODY);
  return root;
}
const freshChild = () => path.join(tmp("rks-ssa-parent-"), "child");
const notArmedWarnings = (spy) =>
  spy.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("[rks.attach]") && l.includes("NOT armed"));

describe("attachProject — secret scan", () => {
  it("copies the shell hook byte-identical and tracks it in the baseline commit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const shell = makeShellRoot();
    const child = freshChild();
    const res = await attachProject({
      shellRoot: shell, projectRoot: child, projectId: "ssa-copy",
      installDependencies: installStub, armSecretScan: () => ({ armed: true }),
    });
    expect(res.gitBootstrap.bootstrapped).toBe(true);
    expect(fs.readFileSync(path.join(child, HOOK_REL)).equals(fs.readFileSync(path.join(shell, HOOK_REL)))).toBe(true);
    expect(trackedInHead(child, HOOK_REL)).toBe(true);
  }, TEST_TIMEOUT);

  it("calls the injected seam once after .git exists and returns its result as secretScan", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = freshChild();
    const calls = [];
    const result = { armed: true, scannerSource: "rks_tools", marker: Symbol("seam") };
    const seam = vi.fn((root) => {
      calls.push({ root, gitExists: fs.existsSync(path.join(root, ".git")) });
      return result;
    });
    const res = await attachProject({
      shellRoot: makeShellRoot(), projectRoot: child, projectId: "ssa-seam",
      installDependencies: installStub, armSecretScan: seam,
    });
    expect(seam).toHaveBeenCalledTimes(1);
    expect(calls[0].root).toBe(path.resolve(child));
    expect(path.isAbsolute(calls[0].root)).toBe(true);
    expect(calls[0].gitExists).toBe(true);
    expect(res.secretScan).toBe(result);
  }, TEST_TIMEOUT);

  it("a not-armed or throwing seam is a warning, never a failed attach", async () => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r1 = await attachProject({
      shellRoot: makeShellRoot(), projectRoot: freshChild(), projectId: "ssa-na",
      installDependencies: installStub, armSecretScan: () => ({ armed: false, reason: "download_failed" }),
    });
    expect(r1.secretScan).toMatchObject({ armed: false, reason: "download_failed" });
    let w = notArmedWarnings(warn);
    expect(w.length).toBe(1);
    expect(w[0]).toContain("download_failed");
    expect(w[0]).toContain("RKS_ALLOW_UNSCANNED_COMMIT=1");
    vi.restoreAllMocks();

    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r2 = await attachProject({
      shellRoot: makeShellRoot(), projectRoot: freshChild(), projectId: "ssa-throw",
      installDependencies: installStub, armSecretScan: () => { throw new Error("boom"); },
    });
    expect(r2.secretScan.armed).toBe(false);
    expect(typeof r2.secretScan.reason).toBe("string");
    expect(r2.secretScan.reason.length).toBeGreaterThan(0);
    w = notArmedWarnings(warn);
    expect(w.length).toBe(1);
    expect(w[0]).toContain(r2.secretScan.reason);
    expect(w[0]).toContain("RKS_ALLOW_UNSCANNED_COMMIT=1");
  }, TEST_TIMEOUT);

  it("default seam with no installer and no hook in the shell resolves not armed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const shell = makeShellRoot({ hook: false });
    expect(fs.existsSync(path.join(shell, "scripts", "install-git-hooks.mjs"))).toBe(false);
    const child = freshChild();
    const res = await attachProject({ shellRoot: shell, projectRoot: child, projectId: "ssa-none", installDependencies: installStub });
    expect(fs.existsSync(path.join(child, HOOK_REL))).toBe(false);
    expect(res.secretScan.armed).toBe(false);
    expect(typeof res.secretScan.reason).toBe("string");
    expect(res.secretScan.reason.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  it("default seam spawns the shell installer with --project, --json and --cache-dir and parses its JSON", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const shell = makeShellRoot();
    git(shell, ["init", "-q"]);
    const argvFile = path.join(tmp("rks-ssa-argv-"), "argv.json");
    write(
      shell,
      "scripts/install-git-hooks.mjs",
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n` +
        `process.stdout.write(JSON.stringify({ armed: true, scannerSource: "path", fake: true }) + "\\n");\n`,
    );
    const child = freshChild();
    const res = await attachProject({ shellRoot: shell, projectRoot: child, projectId: "ssa-fake", installDependencies: installStub });
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf-8"));
    const valueOf = (flag) => argv[argv.indexOf(flag) + 1];
    expect(argv).toContain("--json");
    expect(valueOf("--project")).toBe(path.resolve(child));
    const shellCommon = path.resolve(shell, git(shell, ["rev-parse", "--git-common-dir"]));
    expect(valueOf("--cache-dir")).toBe(path.join(shellCommon, "rks-tools", "cache"));
    expect(res.secretScan).toEqual({ armed: true, scannerSource: "path", fake: true });

    // A fake printing non-JSON yields a not-armed result with a reason.
    write(shell, "scripts/install-git-hooks.mjs", `process.stdout.write("definitely not json\\n");\n`);
    const res2 = await attachProject({ shellRoot: shell, projectRoot: freshChild(), projectId: "ssa-fake2", installDependencies: installStub });
    expect(res2.secretScan.armed).toBe(false);
    expect(typeof res2.secretScan.reason).toBe("string");
    expect(res2.secretScan.reason.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------------------------
// upgradeProject
// ---------------------------------------------------------------------------------------------

/** A child committed on `feature/work`, stamped `from`. */
function makeChild({ from = "0.59.6", contentOnly = false } = {}) {
  const root = tmp("rks-ssa-child-");
  const pj = { id: "child", rksVersion: from, ...(contentOnly ? { vcs: { contentOnly: true } } : {}) };
  write(root, ".rks/project.json", JSON.stringify(pj, null, 2) + "\n");
  write(root, "src/app.js", "export const a = 1;\n");
  git(root, ["init", "-q", "-b", "feature/work"]);
  if (contentOnly) {
    git(root, ["add", "src/app.js"]);
  } else {
    write(root, ".routekit/hooks/read/a.mjs", "// old hook\n");
    write(root, ".claude/settings.json", JSON.stringify({ hooks: {} }, null, 2) + "\n");
    write(root, ".mcp.json", JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
    write(root, ".gitignore", "node_modules/\n.rks/.upgrade-backup/\n.rks/.backup/\n");
    git(root, ["add", "-A"]);
  }
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}
function makeUpgradeShell({ hook = true } = {}) {
  const shell = tmp("rks-ssa-ushell-");
  write(shell, ".routekit/hooks-manifest.json", "{}\n");
  if (hook) write(shell, HOOK_REL, HOOK_BODY);
  return shell;
}
function deps(to = "0.59.7", extra = {}) {
  return {
    readRksVersion: () => to,
    syncProject: () => [],
    repinMcpServer: () => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] }),
    migrateChildSettingsHookPaths: () => false,
    ensureHookRegistration: () => ({ changed: false }),
    mergeRksPermissionAllow: () => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] }),
    migrateConfig: () => ({ ok: true, applied: [], noOp: true }),
    seedVitestFiles: () => ({ created: [], templateMissing: [] }),
    installProvenanceWorkflow: () => ({ written: [], skipped: [] }),
    listVaultRootExcludes: () => ({ entries: [] }),
    now: () => "TS",
    ...extra,
  };
}
const armedSpy = () => vi.fn(() => ({ armed: true, scannerSource: "rks_tools" }));
const upgrade = (root, shell, d, opts) => upgradeProject({ projectRoot: root, projectId: "child", shellRoot: shell, opts }, d);
const hookEntries = (r) => r.reconciled.filter((e) => e.includes(HOOK_REL));
function installChildPreCommit(root, body) {
  const hooksDir = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), body, { mode: 0o755 });
  fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
}

describe("upgradeProject — secret scan", () => {
  it("copies the hook, reports it in reconciled and calls the seam once", () => {
    const root = makeChild();
    const shell = makeUpgradeShell();
    const seam = armedSpy();
    const r = upgrade(root, shell, deps("0.59.7", { armSecretScan: seam }));
    expect(fs.readFileSync(path.join(root, HOOK_REL)).equals(fs.readFileSync(path.join(shell, HOOK_REL)))).toBe(true);
    expect(hookEntries(r)).toHaveLength(1);
    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam.mock.calls[0][0]).toBe(root);
  }, TEST_TIMEOUT);

  it("an identical hook is not re-reported; a differing hook is overwritten", () => {
    const root = makeChild();
    const shell = makeUpgradeShell();
    upgrade(root, shell, deps("0.59.7", { armSecretScan: armedSpy() }));
    const before = fs.readFileSync(path.join(root, HOOK_REL));
    const mtime = fs.statSync(path.join(root, HOOK_REL)).mtimeMs;
    const r2 = upgrade(root, shell, deps("0.59.8", { armSecretScan: armedSpy() }));
    expect(hookEntries(r2)).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, HOOK_REL)).equals(before)).toBe(true);
    expect(fs.statSync(path.join(root, HOOK_REL)).mtimeMs).toBe(mtime);

    fs.writeFileSync(path.join(root, HOOK_REL), "#!/bin/sh\n# drifted\nexit 0\n");
    const r3 = upgrade(root, shell, deps("0.59.9", { armSecretScan: armedSpy() }));
    expect(hookEntries(r3)).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, HOOK_REL), "utf-8")).toBe(HOOK_BODY);
  }, TEST_TIMEOUT);

  it("a not-armed seam result is a warning and the stamp still advances", () => {
    const root = makeChild();
    const r = upgrade(root, makeUpgradeShell(), deps("0.59.7", { armSecretScan: () => ({ armed: false, reason: "download_failed" }) }));
    expect(r.warnings.some((w) => w.includes("download_failed") && w.includes("NOT armed"))).toBe(true);
    expect(r.stampAdvanced).toBe(true);
    expect(r.secretScan).toMatchObject({ armed: false, reason: "download_failed" });
  }, TEST_TIMEOUT);

  it("a dry run writes no hook and never arms", () => {
    const root = makeChild();
    const seam = armedSpy();
    const r = upgrade(root, makeUpgradeShell(), deps("0.59.7", { armSecretScan: seam }), { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(fs.existsSync(path.join(root, HOOK_REL))).toBe(false);
    expect(seam).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it("non-content-only child commits the hook and stays clean; content-only never tracks it", () => {
    const root = makeChild();
    const r = upgrade(root, makeUpgradeShell(), deps("0.59.7", { armSecretScan: armedSpy() }));
    expect(r.committed).toBe(true);
    expect(trackedInHead(root, HOOK_REL)).toBe(true);
    expect(r.committedFiles).toContain(HOOK_REL);
    expect(porcelain(root)).toEqual([]);

    const co = makeChild({ contentOnly: true });
    const r2 = upgrade(co, makeUpgradeShell(), deps("0.59.7", { armSecretScan: armedSpy() }));
    expect(r2.stampAdvanced).toBe(true);
    expect(fs.existsSync(path.join(co, HOOK_REL))).toBe(true);
    expect(trackedInHead(co, HOOK_REL)).toBe(false);
    expect(git(co, ["ls-files", "--", HOOK_REL])).toBe("");
    expect(porcelain(co)).toEqual([]);
  }, TEST_TIMEOUT);

  it("a refusing pre-commit installed by arming never blocks the upgrade's own commit", () => {
    expect(process.env[OVERRIDE]).toBeUndefined(); // precondition
    const root = makeChild();
    const sentinel = path.join(tmp("rks-ssa-sent-"), "ran");
    const seam = vi.fn((r) => {
      installChildPreCommit(
        r,
        `#!/bin/sh\necho ran >> "${sentinel}"\n[ "$${OVERRIDE}" = "1" ] && exit 0\nexit 1\n`,
      );
      return { armed: false, reason: "download_failed" };
    });
    const before = git(root, ["rev-parse", "HEAD"]);
    const r = upgrade(root, makeUpgradeShell(), deps("0.59.7", { armSecretScan: seam }));
    expect(fs.existsSync(sentinel)).toBe(true); // the hook really ran on the footprint commit
    expect(r.committed).toBe(true);
    expect(r.footprintCommitScanned).toBe(false);
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(porcelain(root)).toEqual([]);
  }, TEST_TIMEOUT);

  it("a foreign pre-commit that always refuses still blocks the commit, and the stamp advances", () => {
    const root = makeChild();
    const seam = vi.fn((r) => {
      installChildPreCommit(r, "#!/bin/sh\nexit 1\n");
      return { armed: false, reason: "foreign_pre_commit" };
    });
    const r = upgrade(root, makeUpgradeShell(), deps("0.59.7", { armSecretScan: seam }));
    expect(r.committed).toBe(false);
    expect(r.commitSkipped).toBe("commit_failed");
    expect(r.stampAdvanced).toBe(true);
    expect(r.footprintCommitScanned).not.toBe(false);
  }, TEST_TIMEOUT);

  it("only the commit invocation carries RKS_ALLOW_UNSCANNED_COMMIT=1", () => {
    const root = makeChild();
    const calls = [];
    const spyGit = (args, opts = {}) => {
      calls.push({ args, opts });
      return execFileSync("git", args, {
        cwd: opts.cwd || root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: T,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
    };
    const r = upgrade(root, makeUpgradeShell(), deps("0.59.7", { armSecretScan: armedSpy(), git: spyGit }));
    expect(r.committed).toBe(true);
    const commits = calls.filter((c) => c.args[0] === "commit");
    expect(commits).toHaveLength(1);
    expect(commits[0].opts.env?.[OVERRIDE]).toBe("1");
    const others = calls.filter((c) => c.args[0] !== "commit");
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) expect(c.opts.env?.[OVERRIDE]).toBeUndefined();
  }, TEST_TIMEOUT);

  it("no seam and a shell without installer or hook completes with a not-armed warning", () => {
    const root = makeChild();
    const shell = makeUpgradeShell({ hook: false });
    const r = upgrade(root, shell, deps("0.59.7"));
    expect(r.ok).toBe(true);
    expect(r.stampAdvanced).toBe(true);
    expect(fs.existsSync(path.join(root, HOOK_REL))).toBe(false);
    expect(r.warnings.some((w) => w.includes("NOT armed"))).toBe(true);
  }, TEST_TIMEOUT);
});
