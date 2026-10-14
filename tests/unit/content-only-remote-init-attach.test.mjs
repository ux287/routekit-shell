/**
 * backlog.feat.content-only-remote.init-attach-exclude
 *
 * Content-only remote mode: `routekit project init|attach --content-only` keeps every rks-owned
 * path out of git (a managed .git/info/exclude block written before the baseline staging, a
 * fail-closed pre-push hook, an already-tracked audit), `routekit project upgrade` never commits
 * for such a child, and content-only + --vendor is refused before any write.
 *
 * Real git in temp dirs. Every subprocess spawn passes an explicit timeout; git runs under an
 * isolated environment (temp HOME, GIT_CONFIG_NOSYSTEM, fixed author/committer) restored in
 * afterEach, and every temp dir is removed in afterEach.
 *
 * ISOLATION (ARCH round-2 Item 3): every in-process attachProject call — direct, or reached
 * through handleProjectCommand — passes a TEMP shellRoot fixture (so upsertProject writes
 * <tmp>/projects/index.jsonl, never the repo's registry) and an installDependencies recording stub
 * (so no `npm install` is ever spawned). The repo's own projects/index.jsonl bytes are recorded at
 * load and asserted identical by the last test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  CONTENT_ONLY_RUNTIME_PATHS,
  CONTENT_ONLY_TEMPLATE_PATHS,
  CONTENT_ONLY_VENDOR_CONFLICT,
  EXCLUDE_BLOCK_BEGIN,
  EXCLUDE_BLOCK_END,
  PRE_PUSH_MARKER,
  listSeededNotePaths,
  readContentOnly,
  writeContentOnlyExclude,
  installContentOnlyPrePush,
  listTrackedRksPaths,
  matchesContentOnlyEntry,
  renderPrePushHook,
  applyContentOnlyOffRail,
  VAULT_ROOT_NOTE_PATHS,
  listVaultRootExcludes,
} from "../../packages/cli/src/project/content-only.mjs";
import { ensureGitBootstrap, attachProject } from "../../packages/cli/src/project/bootstrap.mjs";
import { initProjectFromStack } from "../../packages/cli/src/project/init-stack.js";
import { upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

const TIMEOUT = 120_000;
const TEST_TIMEOUT = 60_000;
const STACK = "app.web.react.spa";
const BRANCHES = { working: "dev", integration: "staging", production: "main" };
const tmps = [];
const REPO = path.resolve(import.meta.dirname, "../..");
const REPO_REGISTRY = path.join(REPO, "projects", "index.jsonl");
const registryBefore = fs.existsSync(REPO_REGISTRY) ? fs.readFileSync(REPO_REGISTRY) : null;
const BOOTSTRAP_SRC = path.join(REPO, "packages", "cli", "src", "project", "bootstrap.mjs");
const PROJECT_CLI_SRC = path.join(REPO, "packages", "cli", "src", "cli", "project.js");

// Every in-process attachProject call passes one of these: no npm install is ever spawned.
function makeInstallStub() {
  const calls = [];
  const fn = (root) => {
    calls.push(root);
    return { ran: false };
  };
  fn.calls = calls;
  return fn;
}

// Temp shellRoot so upsertProject writes <tmp>/projects/index.jsonl, never the repo's registry.
// Copies what attachProject reads from shellRoot (after tests/project-bootstrap.test.mjs:113-136,
// plus templates/base and the ARCH build-note reads): the WHOLE packages/hooks tree, so
// ensureHooksDir (bootstrap.mjs ensureHooksDir) picks the canonical source exactly as in the real
// shell rather than a sparse lib-only dir; .claude/agents; scripts/mcp/codex-shim.sh;
// .routekit/hooks-manifest.json; package.json (readRksVersion); .rks/project.json
// (readShellIdentity). Read-only against the repo.
function makeShellRoot(stackId = null) {
  const root = mkTmp("rks-co-shell-");
  const copy = (rel) => {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(root, rel), { recursive: true });
  };
  for (const rel of [
    "templates/base",
    "templates/generic",
    ".rks/prompts",
    ".rks/project.json",
    ".claude/skills",
    ".claude/agents",
    ".routekit/hooks-manifest.json",
    ".routekit/skills-manifest.json",
    "scripts/vitest-runner.mjs",
    "scripts/lib/spawn-managed.mjs",
    "scripts/mcp/codex-shim.sh",
    "packages/hooks",
    "package.json",
  ]) copy(rel);
  if (stackId) copy(path.join("templates", stackId));
  return root;
}

const ENV_KEYS = [
  "HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];
let savedEnv;

function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
function git(cwd, args, extra = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT, ...extra });
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const lsTree = (root) => gitOk(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
const porcelain = (root) =>
  gitOk(root, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
const headSha = (root) => gitOk(root, ["rev-parse", "HEAD"]).trim();
const ALL_GROUP_ENTRIES = [...CONTENT_ONLY_RUNTIME_PATHS, ...CONTENT_ONLY_TEMPLATE_PATHS];
const matchesGroup = (rel) => ALL_GROUP_ENTRIES.some((e) => matchesContentOnlyEntry(rel, e));

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** A client repository with history: one committed client file on `main`. */
function clientRepo(name = "rks-co-client-") {
  const root = mkTmp(name);
  gitOk(root, ["init", "-q"]);
  gitOk(root, ["checkout", "-q", "-b", "main"]);
  write(root, "README.md", "# client\n");
  gitOk(root, ["add", "README.md"]);
  gitOk(root, ["commit", "-q", "-m", "client baseline"]);
  return root;
}

/** Recursive listing + content hash of every file (the .git dir included). */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        out[rel + "/"] = "dir";
        walk(abs);
      } else {
        out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

const countBlocks = (text) => text.split("\n").filter((l) => l === EXCLUDE_BLOCK_BEGIN).length;
const excludePath = (root) => path.resolve(root, gitOk(root, ["rev-parse", "--git-path", "info/exclude"]).trim());
function hookPathOf(root) {
  const dir = path.resolve(root, gitOk(root, ["rev-parse", "--git-path", "hooks"]).trim());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "pre-push");
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const home = mkTmp("rks-co-home-");
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
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

describe("content-only: path sets and flag reader", () => {
  it("runtime and template groups hold the specified entries and share none", () => {
    for (const e of ["/.rks/", "/.routekit/", "/.claude/", "/.codex/", "/routekit/", "/.mcp.json", "/dendron.yml"]) {
      expect(CONTENT_ONLY_RUNTIME_PATHS).toContain(e);
    }
    for (const e of [
      "/CLAUDE.md",
      "/AGENTS.md",
      "/vitest.config.unit.mjs",
      "/vitest.config.base.mjs",
      "/scripts/vitest-runner.mjs",
      "/scripts/lib/spawn-managed.mjs",
    ]) {
      expect(CONTENT_ONLY_TEMPLATE_PATHS).toContain(e);
    }
    expect(CONTENT_ONLY_RUNTIME_PATHS.filter((e) => CONTENT_ONLY_TEMPLATE_PATHS.includes(e))).toEqual([]);
  });

  it("exports CONTENT_ONLY_VENDOR_CONFLICT as content_only_vendor_conflict", () => {
    expect(CONTENT_ONLY_VENDOR_CONFLICT).toBe("content_only_vendor_conflict");
  });

  it("readContentOnly is true only for a parsed vcs.contentOnly === true", () => {
    const root = mkTmp("rks-co-flag-");
    expect(readContentOnly(root)).toBe(false); // missing file
    write(root, ".rks/project.json", "{ not json");
    expect(readContentOnly(root)).toBe(false);
    write(root, ".rks/project.json", JSON.stringify({ id: "x" }));
    expect(readContentOnly(root)).toBe(false); // missing vcs
    write(root, ".rks/project.json", JSON.stringify({ vcs: { contentOnly: "true" } }));
    expect(readContentOnly(root)).toBe(false);
    write(root, ".rks/project.json", JSON.stringify({ vcs: { contentOnly: true } }));
    expect(readContentOnly(root)).toBe(true);
  });
});

describe("content-only: listSeededNotePaths", () => {
  function fixture() {
    const shell = mkTmp("rks-co-notes-shell-");
    write(shell, "templates/base/notes/top.md", "t");
    write(shell, "templates/base/notes/sub/nested.md", "n");
    write(shell, "templates/st.k/skeleton/notes/stack.note.md", "s");
    return shell;
  }

  it("returns one /notes/<rel> entry per base-notes FILE, POSIX + leading slash, no directories", () => {
    const shell = fixture();
    const got = listSeededNotePaths({ shellRoot: shell, stackId: null });
    expect(got.sort()).toEqual(["/notes/sub/nested.md", "/notes/top.md"]);
    expect(got.every((e) => e.startsWith("/notes/") && !e.includes("\\"))).toBe(true);
    expect(got).not.toContain("/notes/sub");
    expect(got).not.toContain("/notes/sub/");
  });

  it("adds the stack skeleton notes only when stackId is set", () => {
    const shell = fixture();
    expect(listSeededNotePaths({ shellRoot: shell, stackId: "st.k" })).toContain("/notes/stack.note.md");
    expect(listSeededNotePaths({ shellRoot: shell, stackId: null })).not.toContain("/notes/stack.note.md");
  });

  it("never returns a bare notes entry and tolerates missing sources", () => {
    const shell = fixture();
    for (const list of [
      listSeededNotePaths({ shellRoot: shell, stackId: "st.k" }),
      listSeededNotePaths({ shellRoot: shell, stackId: null }),
    ]) {
      expect(list).not.toContain("/notes/");
      expect(list).not.toContain("notes/");
    }
    const empty = mkTmp("rks-co-notes-empty-");
    expect(() => listSeededNotePaths({ shellRoot: empty, stackId: "missing.stack" })).not.toThrow();
    expect(listSeededNotePaths({ shellRoot: empty, stackId: "missing.stack" })).toEqual([]);
    // base missing, stack present: only the stack contributes
    const stackOnly = mkTmp("rks-co-notes-stackonly-");
    write(stackOnly, "templates/st.k/skeleton/notes/a.md", "a");
    expect(listSeededNotePaths({ shellRoot: stackOnly, stackId: "st.k" })).toEqual(["/notes/a.md"]);
  });

  it("against the real shell root (read-only) includes backlog.md and the stack welcome note", () => {
    expect(listSeededNotePaths({ shellRoot: REPO, stackId: null })).toContain("/notes/backlog.md");
    const withStack = listSeededNotePaths({ shellRoot: REPO, stackId: STACK });
    expect(withStack).toContain("/notes/backlog.md");
    expect(withStack).toContain("/notes/stack.welcome.md");
  });
});

describe("content-only: .git/info/exclude managed block", () => {
  it("writes exactly one delimited block holding every runtime, template and extra entry", () => {
    const root = mkTmp("rks-co-excl-");
    gitOk(root, ["init", "-q"]);
    const res = writeContentOnlyExclude(root, { extraPaths: ["/notes/a.md", "/notes/b.md"] });
    const p = excludePath(root);
    expect(res.path).toBe(p);
    const text = fs.readFileSync(p, "utf8");
    expect(countBlocks(text)).toBe(1);
    const lines = text.split("\n");
    const begin = lines.indexOf(EXCLUDE_BLOCK_BEGIN);
    const end = lines.indexOf(EXCLUDE_BLOCK_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const inside = lines.slice(begin + 1, end);
    for (const e of [...ALL_GROUP_ENTRIES, "/notes/a.md", "/notes/b.md"]) expect(inside).toContain(e);
  });

  it("is idempotent and preserves surrounding lines byte-for-byte", () => {
    const root = mkTmp("rks-co-excl-idem-");
    gitOk(root, ["init", "-q"]);
    const p = excludePath(root);
    const before = "# user rule before\n*.log\n";
    fs.writeFileSync(p, before);
    writeContentOnlyExclude(root, { extraPaths: ["/notes/a.md"] });
    const afterFirst = fs.readFileSync(p, "utf8");
    // append a user line AFTER the block, then rewrite twice
    fs.writeFileSync(p, afterFirst + "tmp/\n# trailing\n");
    writeContentOnlyExclude(root, { extraPaths: ["/notes/a.md"] });
    writeContentOnlyExclude(root, { extraPaths: ["/notes/a.md"] });
    const text = fs.readFileSync(p, "utf8");
    expect(countBlocks(text)).toBe(1);
    expect(text.startsWith(before)).toBe(true);
    expect(text.endsWith(`${EXCLUDE_BLOCK_END}\ntmp/\n# trailing\n`)).toBe(true);
    expect(text).toBe(afterFirst + "tmp/\n# trailing\n");
  });

  it("seeded-note entries are per-file; a client note stays visible to git", () => {
    const shell = mkTmp("rks-co-excl-shell-");
    write(shell, "templates/base/notes/how-to.md", "h");
    write(shell, "templates/st.k/skeleton/notes/root.md", "r");
    const extra = listSeededNotePaths({ shellRoot: shell, stackId: "st.k" });
    const root = mkTmp("rks-co-excl-notes-");
    gitOk(root, ["init", "-q"]);
    writeContentOnlyExclude(root, { extraPaths: extra });
    const text = fs.readFileSync(excludePath(root), "utf8");
    expect(text.split("\n")).toContain("/notes/how-to.md");
    expect(text.split("\n")).toContain("/notes/root.md");
    expect(text.split("\n")).not.toContain("/notes/");
    expect(text.split("\n")).not.toContain("notes/");
    write(root, "notes/how-to.md", "h");
    write(root, "notes/root.md", "r");
    write(root, "notes/client.md", "client");
    const st = porcelain(root);
    expect(st).toContain("?? notes/client.md");
    expect(st.join("\n")).not.toContain("how-to.md");
    expect(st.join("\n")).not.toContain("notes/root.md");
  });
});

describe("content-only: ensureGitBootstrap", () => {
  function seedRksFiles(root) {
    for (const rel of [
      ".rks/project.json",
      ".routekit/state.json",
      ".claude/settings.json",
      ".codex/config.toml",
      "routekit/project.json",
      ".mcp.json",
      "dendron.yml",
      "CLAUDE.md",
      "AGENTS.md",
      "vitest.config.unit.mjs",
      "vitest.config.base.mjs",
      "scripts/vitest-runner.mjs",
      "scripts/lib/spawn-managed.mjs",
    ]) write(root, rel, "rks\n");
    write(root, "src/app.js", "client\n");
  }

  it("baseline commit holds no runtime/template path while the files stay on disk", () => {
    const root = mkTmp("rks-co-boot-");
    seedRksFiles(root);
    const res = ensureGitBootstrap({ projectRoot: root, branches: BRANCHES, contentOnly: true });
    expect(res.bootstrapped).toBe(true);
    const tree = lsTree(root);
    expect(tree.filter(matchesGroup)).toEqual([]);
    expect(tree).toContain("src/app.js");
    expect(fs.existsSync(path.join(root, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".rks", "project.json"))).toBe(true);
  }, TEST_TIMEOUT);

  it("extraPaths reach the block before staging: seeded note omitted, client note committed", () => {
    const root = mkTmp("rks-co-boot-extra-");
    write(root, "notes/seeded.md", "seed\n");
    write(root, "notes/client.md", "client\n");
    const res = ensureGitBootstrap({
      projectRoot: root,
      branches: BRANCHES,
      contentOnly: true,
      extraPaths: ["/notes/seeded.md"],
    });
    expect(res.bootstrapped).toBe(true);
    const tree = lsTree(root);
    expect(tree).not.toContain("notes/seeded.md");
    expect(tree).toContain("notes/client.md");
    expect(fs.readFileSync(excludePath(root), "utf8").split("\n")).toContain("/notes/seeded.md");
  }, TEST_TIMEOUT);

  it("an exclude write failure makes no commit and reports content_only_exclude_failed", () => {
    const root = mkTmp("rks-co-boot-fail-");
    gitOk(root, ["init", "-q"]);
    write(root, ".mcp.json", "{}\n");
    // replace info/exclude with a directory so the write cannot succeed
    const p = excludePath(root);
    fs.rmSync(p, { force: true });
    fs.mkdirSync(p, { recursive: true });
    const res = ensureGitBootstrap({ projectRoot: root, branches: BRANCHES, contentOnly: true });
    expect(res.bootstrapped).toBe(false);
    expect(res.reason).toBe("content_only_exclude_failed");
    expect(git(root, ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  }, TEST_TIMEOUT);
});

describe("content-only: attachProject", () => {
  it("fresh init with a stack: the baseline commit holds none of the seeded template notes", async () => {
    const shellRoot = makeShellRoot(STACK);
    expect(shellRoot).not.toBe(REPO);
    // ARCH build note: the fixture must steer ensureHooksDir to the canonical packages/hooks source.
    expect(fs.existsSync(path.join(shellRoot, "packages", "hooks", "read"))).toBe(true);
    const targetPath = path.join(mkTmp("rks-co-init-"), "proj");
    await initProjectFromStack({ shellRoot, id: "co-init", stackId: STACK, targetPath });
    const install = makeInstallStub();
    const res = await attachProject({
      shellRoot,
      projectRoot: targetPath,
      projectId: "co-init",
      stackId: STACK,
      stackTemplate: { stackId: STACK },
      contentOnly: true,
      installDependencies: install,
    });
    expect(res.gitBootstrap.bootstrapped).toBe(true);
    expect(install.calls).toEqual([path.resolve(targetPath)]);
    // the registry row landed in the FIXTURE
    expect(fs.readFileSync(path.join(shellRoot, "projects", "index.jsonl"), "utf8")).toContain("co-init");

    const tree = lsTree(targetPath);
    const baseNotes = fs.readdirSync(path.join(shellRoot, "templates", "base", "notes"), { recursive: true })
      .filter((r) => fs.statSync(path.join(shellRoot, "templates", "base", "notes", r)).isFile());
    const stackNotes = fs.readdirSync(path.join(shellRoot, "templates", STACK, "skeleton", "notes"));
    expect(stackNotes).toEqual(expect.arrayContaining(["root.md", "root.schema.yml", "stack.welcome.md"]));
    for (const f of [...baseNotes, ...stackNotes]) {
      const rel = "notes/" + String(f).split(path.sep).join("/");
      expect(tree, `${rel} must not be committed`).not.toContain(rel);
      expect(fs.existsSync(path.join(targetPath, rel)), `${rel} must exist on disk`).toBe(true);
    }
    expect(tree.filter(matchesGroup)).toEqual([]);
    expect(tree).toContain("package.json"); // stack skeleton source is client content
    // The hooks dir got the canonical tiered tree (fixture verified).
    expect(fs.existsSync(path.join(targetPath, ".routekit", "hooks", "read"))).toBe(true);

    expect(porcelain(targetPath)).toEqual([]);
    write(targetPath, "notes/client.md", "client\n");
    expect(porcelain(targetPath)).toContain("?? notes/client.md");
  }, TEST_TIMEOUT);

  it("onto a repo with history: no new commit, block + hook installed, rks-written paths invisible", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    const before = headSha(root);
    const install = makeInstallStub();
    const res = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-existing",
      contentOnly: true,
      installDependencies: install,
    });
    expect(res.gitBootstrap).toMatchObject({ bootstrapped: false, reason: "existing-history" });
    expect(headSha(root)).toBe(before);
    expect(install.calls).toEqual([path.resolve(root)]);
    expect(countBlocks(fs.readFileSync(excludePath(root), "utf8"))).toBe(1);
    expect(fs.readFileSync(hookPathOf(root), "utf8")).toContain(PRE_PUSH_MARKER);
    expect(res.contentOnly.prePush.installed).toBe(true);
    // the rks-written paths all exist ...
    for (const rel of [
      ".rks/project.json",
      ".routekit/state.json",
      ".claude/settings.json",
      ".codex/config.toml",
      "routekit/project.json",
      ".mcp.json",
      "dendron.yml",
      "CLAUDE.md",
      "vitest.config.unit.mjs",
      "scripts/vitest-runner.mjs",
      "notes/backlog.md",
    ]) expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    // ... and git status lists none of them (or anything else)
    expect(porcelain(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(false);
  }, TEST_TIMEOUT);

  it("persists vcs.contentOnly and returns { exclude, prePush, alreadyTracked }", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    const res = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-flag",
      contentOnly: true,
      installDependencies: makeInstallStub(),
    });
    const pj = JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8"));
    expect(pj.vcs.contentOnly).toBe(true);
    expect(res.contentOnly).toEqual(
      expect.objectContaining({ exclude: expect.anything(), prePush: expect.anything(), alreadyTracked: [] }),
    );
    expect(res.contentOnly.exclude.ok).toBe(true);
  }, TEST_TIMEOUT);

  it("a re-attach WITHOUT the flag keeps the posture and the guards (one block, rks hook)", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    await attachProject({ shellRoot, projectRoot: root, projectId: "co-re", contentOnly: true, installDependencies: makeInstallStub() });
    const res = await attachProject({ shellRoot, projectRoot: root, projectId: "co-re", installDependencies: makeInstallStub() });
    const pj = JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8"));
    expect(pj.vcs.contentOnly).toBe(true);
    expect(countBlocks(fs.readFileSync(excludePath(root), "utf8"))).toBe(1);
    expect(fs.readFileSync(hookPathOf(root), "utf8")).toContain(PRE_PUSH_MARKER);
    expect(res.contentOnly.prePush.installed).toBe(true);
    expect(porcelain(root)).toEqual([]);
  }, TEST_TIMEOUT);

  it("seeds no .gitignore, no welcome.md (even with empty notes/), no rks:* script", async () => {
    const shellRoot = makeShellRoot();
    // no base notes in this fixture, so notes/ stays empty and the empty-notes fallback is reachable
    fs.rmSync(path.join(shellRoot, "templates", "base", "notes"), { recursive: true, force: true });
    const root = clientRepo();
    const pkg = JSON.stringify({ name: "client", version: "1.0.0", scripts: { test: "echo ok" } }, null, 2) + "\n";
    write(root, "package.json", pkg);
    gitOk(root, ["add", "package.json"]);
    gitOk(root, ["commit", "-q", "-m", "client package"]);
    const install = makeInstallStub();
    await attachProject({ shellRoot, projectRoot: root, projectId: "co-seed", contentOnly: true, installDependencies: install });
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(root, "notes", "welcome.md"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "notes"))).toEqual([]);
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(pkg);
    expect(install.calls).toEqual([path.resolve(root)]);
  }, TEST_TIMEOUT);

  it("reports an already-tracked rks path with a git rm --cached warning and leaves it tracked", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    write(root, ".mcp.json", JSON.stringify({ mcpServers: {} }) + "\n");
    gitOk(root, ["add", ".mcp.json"]);
    gitOk(root, ["commit", "-q", "-m", "tracked rks file"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-tracked",
      contentOnly: true,
      installDependencies: makeInstallStub(),
    });
    expect(res.contentOnly.alreadyTracked).toContain(".mcp.json");
    const warned = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("git rm --cached");
    expect(warned).toContain(".mcp.json");
    expect(gitOk(root, ["ls-files"]).split("\n")).toContain(".mcp.json");
    expect(listTrackedRksPaths(root)).toContain(".mcp.json");
  }, TEST_TIMEOUT);

  it("contentOnly + vendor 'copy' rejects with content_only_vendor_conflict before any write", async () => {
    const shellRoot = makeShellRoot();
    const root = mkTmp("rks-co-vendor-copy-");
    write(root, "README.md", "client\n");
    write(root, "src/a.js", "a\n");
    const before = snapshot(root);
    const install = makeInstallStub();
    const err = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-vc",
      contentOnly: true,
      vendor: "copy",
      installDependencies: install,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(CONTENT_ONLY_VENDOR_CONFLICT);
    expect(err.message).toContain("content_only_vendor_conflict");
    expect(err.message).toContain("--content-only");
    expect(err.message).toContain("--vendor");
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "tools", "routekit-shell"))).toBe(false);
    expect(install.calls).toEqual([]);
    expect(fs.existsSync(path.join(shellRoot, "projects", "index.jsonl"))).toBe(false);
  }, TEST_TIMEOUT);

  it("contentOnly + vendor 'subtree' rejects before any write, commit or remote", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    const before = snapshot(root);
    const head = headSha(root);
    const remotes = gitOk(root, ["remote"]);
    const install = makeInstallStub();
    const err = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-vs",
      contentOnly: true,
      vendor: "subtree",
      vendorRemote: "https://example.invalid/rks.git",
      installDependencies: install,
    }).catch((e) => e);
    expect(err.code).toBe(CONTENT_ONLY_VENDOR_CONFLICT);
    expect(snapshot(root)).toEqual(before);
    expect(headSha(root)).toBe(head);
    expect(gitOk(root, ["remote"])).toBe(remotes);
    expect(fs.existsSync(path.join(root, "tools", "routekit-shell"))).toBe(false);
    expect(install.calls).toEqual([]);
  }, TEST_TIMEOUT);

  it("the on-disk flag alone (no option) + vendor 'copy' rejects and leaves every byte unchanged", async () => {
    const shellRoot = makeShellRoot();
    const root = mkTmp("rks-co-vendor-disk-");
    write(root, ".rks/project.json", JSON.stringify({ id: "co-disk", vcs: { contentOnly: true } }, null, 2) + "\n");
    write(root, "README.md", "client\n");
    const before = snapshot(root);
    const install = makeInstallStub();
    const err = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-disk",
      vendor: "copy",
      installDependencies: install,
    }).catch((e) => e);
    expect(err.code).toBe(CONTENT_ONLY_VENDOR_CONFLICT);
    expect(snapshot(root)).toEqual(before);
    expect(install.calls).toEqual([]);
  }, TEST_TIMEOUT);

  it("regression: vendor 'copy' WITHOUT content-only still proceeds", async () => {
    const shellRoot = makeShellRoot();
    const root = mkTmp("rks-co-vendor-plain-");
    write(root, "README.md", "client\n");
    const install = makeInstallStub();
    const res = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-plain-vendor",
      vendor: "copy",
      installDependencies: install,
    });
    expect(res.ok).toBe(true);
    expect(res.vendor?.ok).toBe(true);
    expect(res.contentOnly).toBeNull();
    expect(fs.existsSync(path.join(root, "tools", "routekit-shell"))).toBe(true);
    expect(install.calls).toEqual([path.resolve(root)]);
  }, TEST_TIMEOUT);

  it("full-source: installDependencies defaults to runDependencyInstall; the direct call is gone", () => {
    const src = fs.readFileSync(BOOTSTRAP_SRC, "utf8");
    const start = src.indexOf("export async function attachProject(");
    expect(start).toBeGreaterThan(-1);
    const params = src.slice(start, src.indexOf("} = {}) {", start));
    expect(params).toMatch(/installDependencies\s*=\s*runDependencyInstall\s*,/);
    expect(src).not.toContain("runDependencyInstall(absProjectRoot)");
    expect(src).toMatch(/installDependencies\(absProjectRoot\)/);
  });
});

// backlog.feat.content-only-remote.offrail-disabled — content-only implies off-rail disabled.
describe("content-only: applyContentOnlyOffRail", () => {
  it("absent offRail -> {enabled:false}, changed true, previous undefined", () => {
    const input = { id: "x", vcs: { contentOnly: true } };
    const r = applyContentOnlyOffRail(input);
    expect(r.json.offRail).toEqual({ enabled: false });
    expect(r.changed).toBe(true);
    expect(r.previous).toBeUndefined();
    expect(r.json.id).toBe("x");
    expect(r.json.vcs).toEqual({ contentOnly: true });
    expect(input).not.toHaveProperty("offRail"); // input not mutated
  });

  for (const bad of [null, "enabled", 42, true, ["components/*"]]) {
    it(`non-object offRail ${JSON.stringify(bad)} -> {enabled:false}, changed true, previous reported`, () => {
      const r = applyContentOnlyOffRail({ offRail: bad });
      expect(r.json.offRail).toEqual({ enabled: false });
      expect(r.changed).toBe(true);
      expect(r.previous).toEqual(bad);
    });
  }

  it("{enabled:true, roots} -> enabled false, roots preserved, previous reported", () => {
    const prev = { enabled: true, roots: ["components/*", "lib/*"] };
    const r = applyContentOnlyOffRail({ offRail: prev });
    expect(r.json.offRail).toEqual({ enabled: false, roots: ["components/*", "lib/*"] });
    expect(r.changed).toBe(true);
    expect(r.previous).toEqual({ enabled: true, roots: ["components/*", "lib/*"] });
    expect(prev.enabled).toBe(true); // input not mutated
  });

  it("{enabled:false} already -> changed false, json.offRail deep-equal, previous reported", () => {
    const prev = { enabled: false, roots: ["components/*"] };
    const r = applyContentOnlyOffRail({ offRail: prev });
    expect(r.changed).toBe(false);
    expect(r.json.offRail).toEqual({ enabled: false, roots: ["components/*"] });
    expect(r.previous).toEqual(prev);
  });

  it("malformed enabled ('yes') -> forced to false, changed true", () => {
    const r = applyContentOnlyOffRail({ offRail: { enabled: "yes", roots: ["x/*"] } });
    expect(r.json.offRail).toEqual({ enabled: false, roots: ["x/*"] });
    expect(r.changed).toBe(true);
    expect(r.previous).toEqual({ enabled: "yes", roots: ["x/*"] });
  });
});

describe("content-only: attachProject offRail", () => {
  const readPj = (root) => JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8"));
  const offRailWarnings = (res) => (res.contentOnly?.warnings || []).filter((w) => /offRail/.test(w));

  it("contentOnly on a fresh child writes offRail.enabled false and vcs.contentOnly true", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    expect(fs.existsSync(path.join(root, ".rks", "project.json"))).toBe(false);
    const res = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-offrail-fresh",
      contentOnly: true,
      installDependencies: makeInstallStub(),
    });
    const pj = readPj(root);
    expect(pj.offRail.enabled).toBe(false);
    expect(pj.vcs.contentOnly).toBe(true);
    expect(offRailWarnings(res)).toEqual([]); // nothing was overridden
  }, TEST_TIMEOUT);

  it("contentOnly over an existing offRail {enabled:true, roots} forces false, keeps roots, and warns with the previous value", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    const prev = { enabled: true, roots: ["components/*", "lib/*"] };
    write(root, ".rks/project.json", JSON.stringify({ id: "co-offrail-override", offRail: prev }, null, 2));
    const res = await attachProject({
      shellRoot,
      projectRoot: root,
      projectId: "co-offrail-override",
      contentOnly: true,
      installDependencies: makeInstallStub(),
    });
    const pj = readPj(root);
    expect(pj.offRail.enabled).toBe(false);
    expect(pj.offRail.roots).toEqual(["components/*", "lib/*"]);
    expect(pj.vcs.contentOnly).toBe(true);
    const warns = offRailWarnings(res);
    expect(warns).toHaveLength(1);
    expect(typeof warns[0]).toBe("string");
    expect(warns[0]).toContain(JSON.stringify(prev));
  }, TEST_TIMEOUT);

  it("a re-attach WITHOUT contentOnly on an on-disk content-only child still leaves offRail.enabled false", async () => {
    const shellRoot = makeShellRoot();
    const root = clientRepo();
    await attachProject({ shellRoot, projectRoot: root, projectId: "co-offrail-sticky", contentOnly: true, installDependencies: makeInstallStub() });
    // flip it on disk between attaches, so the re-attach has something to restore
    const pjPath = path.join(root, ".rks", "project.json");
    fs.writeFileSync(pjPath, JSON.stringify({ ...readPj(root), offRail: { enabled: true, roots: ["src/*"] } }, null, 2));
    const res = await attachProject({ shellRoot, projectRoot: root, projectId: "co-offrail-sticky", installDependencies: makeInstallStub() });
    const pj = readPj(root);
    expect(pj.vcs.contentOnly).toBe(true);
    expect(pj.offRail.enabled).toBe(false);
    expect(pj.offRail.roots).toEqual(["src/*"]);
    expect(offRailWarnings(res)).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("without contentOnly (no on-disk posture): an absent offRail stays absent", async () => {
    const shellRoot = makeShellRoot();
    const root = mkTmp("rks-co-offrail-plain-");
    write(root, "README.md", "client\n");
    const res = await attachProject({ shellRoot, projectRoot: root, projectId: "co-offrail-plain", installDependencies: makeInstallStub() });
    expect(res.contentOnly).toBeNull();
    expect(readPj(root)).not.toHaveProperty("offRail");
  }, TEST_TIMEOUT);

  it("without contentOnly (no on-disk posture): an existing {enabled:true, roots} offRail is deep-equal unchanged", async () => {
    const shellRoot = makeShellRoot();
    const root = mkTmp("rks-co-offrail-plain2-");
    write(root, "README.md", "client\n");
    const prev = { enabled: true, roots: ["components/*"] };
    write(root, ".rks/project.json", JSON.stringify({ id: "co-offrail-plain2", offRail: prev }, null, 2));
    const res = await attachProject({ shellRoot, projectRoot: root, projectId: "co-offrail-plain2", installDependencies: makeInstallStub() });
    expect(res.contentOnly).toBeNull();
    expect(readPj(root).offRail).toEqual(prev);
    expect(readPj(root)).not.toHaveProperty("vcs");
  }, TEST_TIMEOUT);
});

describe("content-only: pre-push hook", () => {
  it("installs an executable marked hook into git rev-parse --git-path hooks", () => {
    const root = clientRepo();
    const res = installContentOnlyPrePush(root);
    expect(res.installed).toBe(true);
    const p = hookPathOf(root);
    expect(res.path).toBe(p);
    expect(fs.readFileSync(p, "utf8")).toContain(PRE_PUSH_MARKER);
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  }, TEST_TIMEOUT);

  it("refuses core.hooksPath and foreign hooks; refreshes its own", () => {
    const a = clientRepo();
    gitOk(a, ["config", "core.hooksPath", ".githooks"]);
    const ra = installContentOnlyPrePush(a);
    expect(ra).toMatchObject({ installed: false, reason: "core_hooks_path" });
    expect(fs.existsSync(path.join(a, ".githooks"))).toBe(false);
    expect(fs.existsSync(path.join(a, ".git", "hooks", "pre-push"))).toBe(false);

    const b = clientRepo();
    const foreign = "#!/bin/sh\necho foreign\nexit 0\n";
    fs.writeFileSync(hookPathOf(b), foreign, { mode: 0o755 });
    expect(installContentOnlyPrePush(b)).toMatchObject({ installed: false, reason: "existing_hook" });
    expect(fs.readFileSync(hookPathOf(b), "utf8")).toBe(foreign);

    const c = clientRepo();
    fs.writeFileSync(hookPathOf(c), `#!/bin/sh\n${PRE_PUSH_MARKER}\nexit 0\n`, { mode: 0o755 });
    const rc = installContentOnlyPrePush(c, { extraPaths: ["/notes/x.md"] });
    expect(rc).toMatchObject({ installed: true, refreshed: true });
    expect(fs.readFileSync(hookPathOf(c), "utf8")).toBe(renderPrePushHook(["/notes/x.md"]));
  }, TEST_TIMEOUT);

  function repoWithRemote() {
    const root = clientRepo();
    const bare = mkTmp("rks-co-bare-");
    gitOk(bare, ["init", "-q", "--bare"]);
    gitOk(root, ["remote", "add", "origin", bare]);
    return { root, bare };
  }
  const push = (root, ...args) => git(root, ["push", "origin", ...args]);

  it("rejects a push whose outgoing commit adds an rks-owned path; client-only pushes pass", () => {
    const { root } = repoWithRemote();
    installContentOnlyPrePush(root);
    const ok = push(root, "main:refs/heads/main");
    expect(ok.status, ok.stderr).toBe(0);
    write(root, "docs.md", "client\n");
    gitOk(root, ["add", "docs.md"]);
    gitOk(root, ["commit", "-q", "-m", "client change"]);
    expect(push(root, "main:refs/heads/main").status).toBe(0);
    write(root, ".mcp.json", "{}\n");
    gitOk(root, ["add", "-f", ".mcp.json"]);
    gitOk(root, ["commit", "-q", "-m", "oops"]);
    const bad = push(root, "main:refs/heads/main");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain(".mcp.json");
  }, TEST_TIMEOUT);

  it("rejects when the tip tree holds an rks path committed earlier; new branches check every unpushed commit", () => {
    // (a) tip tree: .rks/project.json was pushed BEFORE the hook existed
    const { root } = repoWithRemote();
    write(root, ".rks/project.json", "{}\n");
    gitOk(root, ["add", "-f", ".rks/project.json"]);
    gitOk(root, ["commit", "-q", "-m", "pre-hook rks file"]);
    expect(push(root, "main:refs/heads/main").status).toBe(0);
    installContentOnlyPrePush(root);
    write(root, "docs.md", "client\n");
    gitOk(root, ["add", "docs.md"]);
    gitOk(root, ["commit", "-q", "-m", "client only"]);
    const tip = push(root, "main:refs/heads/main");
    expect(tip.status).not.toBe(0);
    expect(tip.stderr).toContain(".rks/project.json");

    // (b) new remote branch: an rks path added then removed in unpushed commits is still caught
    const { root: r2 } = repoWithRemote();
    installContentOnlyPrePush(r2);
    expect(push(r2, "main:refs/heads/main").status).toBe(0);
    gitOk(r2, ["checkout", "-q", "-b", "feature"]);
    write(r2, "CLAUDE.md", "rks\n");
    gitOk(r2, ["add", "-f", "CLAUDE.md"]);
    gitOk(r2, ["commit", "-q", "-m", "add rks"]);
    gitOk(r2, ["rm", "-q", "CLAUDE.md"]);
    gitOk(r2, ["commit", "-q", "-m", "remove rks"]);
    expect(lsTree(r2)).not.toContain("CLAUDE.md");
    const nb = push(r2, "feature:refs/heads/feature");
    expect(nb.status).not.toBe(0);
    expect(nb.stderr).toContain("CLAUDE.md");
  }, TEST_TIMEOUT);

  const Z40 = "0".repeat(40);
  const Z64 = "0".repeat(64);
  function runHook(root, stdin) {
    return spawnSync("sh", [hookPathOf(root), "origin", "file:///nowhere"], {
      cwd: root,
      input: stdin,
      encoding: "utf8",
      timeout: TIMEOUT,
    });
  }

  it("allows a branch deletion and treats 40- and 64-char all-zero SHAs as null", () => {
    const root = clientRepo();
    installContentOnlyPrePush(root);
    const head = headSha(root);
    expect(runHook(root, `(delete) ${Z40} refs/heads/x ${head}\n`).status).toBe(0);
    expect(runHook(root, `(delete) ${Z64} refs/heads/x ${head}\n`).status).toBe(0);
    // a zero REMOTE sha means a new branch: only treated correctly when recognised as null
    expect(runHook(root, `refs/heads/main ${head} refs/heads/main ${Z40}\n`).status).toBe(0);
    expect(runHook(root, `refs/heads/main ${head} refs/heads/main ${Z64}\n`).status).toBe(0);
    // control: the same new-branch line is rejected once an rks path is in the commits
    write(root, ".mcp.json", "{}\n");
    gitOk(root, ["add", "-f", ".mcp.json"]);
    gitOk(root, ["commit", "-q", "-m", "rks"]);
    const bad = runHook(root, `refs/heads/main ${headSha(root)} refs/heads/main ${Z64}\n`);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain(".mcp.json");
  }, TEST_TIMEOUT);

  it("fails closed when a git command it runs fails", () => {
    const root = clientRepo();
    installContentOnlyPrePush(root);
    const missing = "1234567890abcdef1234567890abcdef12345678";
    const r = runHook(root, `refs/heads/main ${headSha(root)} refs/heads/main ${missing}\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("failing closed");
  }, TEST_TIMEOUT);
});

describe("content-only: upgradeProject", () => {
  // contentOnly / offRail parameterise .rks/project.json for the offRail restore cases
  // (backlog.feat.content-only-remote.offrail-disabled); the defaults reproduce the original fixture.
  function setupChild({ gitignore, contentOnly = true, offRail } = {}) {
    const shellRoot = mkTmp("rks-co-upg-shell-");
    write(shellRoot, "templates/base/notes/backlog.md", "b");
    write(shellRoot, `templates/${STACK}/skeleton/notes/stack.welcome.md`, "w");
    write(shellRoot, ".routekit/hooks-manifest.json", "{}");
    const root = clientRepo("rks-co-upg-child-");
    write(
      root,
      ".rks/project.json",
      JSON.stringify(
        {
          id: "calc",
          rksVersion: "0.20.18",
          ...(contentOnly ? { vcs: { contentOnly: true } } : {}),
          ...(offRail !== undefined ? { offRail } : {}),
        },
        null,
        2,
      ),
    );
    write(root, "routekit/project.json", JSON.stringify({ id: "calc", stack: STACK }, null, 2));
    write(root, ".mcp.json", JSON.stringify({ mcpServers: {} }));
    write(root, ".claude/settings.json", JSON.stringify({ hooks: {} }));
    if (gitignore !== undefined) {
      write(root, ".gitignore", gitignore);
      gitOk(root, ["add", ".gitignore"]);
      gitOk(root, ["commit", "-q", "-m", "client gitignore"]);
    }
    // stale guards
    fs.writeFileSync(excludePath(root), `# mine\n${EXCLUDE_BLOCK_BEGIN}\n/stale-entry\n${EXCLUDE_BLOCK_END}\n`);
    fs.writeFileSync(hookPathOf(root), `#!/bin/sh\n${PRE_PUSH_MARKER}\nexit 0\n`, { mode: 0o755 });
    return { shellRoot, root };
  }
  const deps = (gitFn) => ({
    readRksVersion: vi.fn(() => "0.20.19"),
    syncProject: vi.fn(() => []),
    repinMcpServer: vi.fn(() => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] })),
    migrateChildSettingsHookPaths: vi.fn(() => false),
    ensureHookRegistration: vi.fn(() => ({ changed: false })),
    mergeRksPermissionAllow: vi.fn(() => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] })),
    migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true })),
    seedVitestFiles: vi.fn(() => ({ created: [], templateMissing: [] })),
    now: () => "TS",
    git: gitFn,
  });

  for (const variant of [{ gitignore: "node_modules/\n" }, {}]) {
    const label = variant.gitignore === undefined ? ".gitignore absent" : ".gitignore present";
    it(`no commit (content_only), .gitignore untouched, guards refreshed — ${label}`, () => {
      const { shellRoot, root } = setupChild(variant);
      const head = headSha(root);
      const gitFn = vi.fn((args, { cwd } = {}) => gitOk(cwd || root, args));
      const report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, deps(gitFn));
      expect(report.ok).toBe(true);
      expect(report.committed).toBe(false);
      expect(report.commitSkipped).toBe("content_only");
      expect(headSha(root)).toBe(head);
      expect(gitFn).not.toHaveBeenCalled();
      if (variant.gitignore === undefined) expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(false);
      else expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe(variant.gitignore);

      const text = fs.readFileSync(excludePath(root), "utf8");
      expect(countBlocks(text)).toBe(1);
      expect(text.startsWith("# mine\n")).toBe(true);
      expect(text).not.toContain("/stale-entry");
      // backlog.feat.content-only-remote.exclude-dendron-runtime: the vault root notes are untracked
      // in this child, so the refreshed entry list is the seeded notes plus both vault-root entries.
      const expected = Array.from(
        new Set([...listSeededNotePaths({ shellRoot, stackId: STACK }), "/notes/root.md", "/notes/root.schema.yml"]),
      ).sort();
      expect(expected).toEqual(expect.arrayContaining(["/notes/backlog.md", "/notes/stack.welcome.md"]));
      for (const e of [...ALL_GROUP_ENTRIES, ...expected]) expect(text.split("\n")).toContain(e);
      expect(fs.readFileSync(hookPathOf(root), "utf8")).toBe(renderPrePushHook(expected));
    }, TEST_TIMEOUT);
  }

  // backlog.feat.content-only-remote.offrail-disabled — offRail restore on a reconciling boundary.
  describe("offRail restore", () => {
    const OFFRAIL_ENTRY = ".rks/project.json (offRail disabled: content-only)";
    const readPj = (root) => JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8"));
    // Counts fs.writeFileSync calls (default node:fs export, the one upgrade.mjs and advanceStamp
    // use) whose path resolves to the child's .rks/project.json. Restored by vi.restoreAllMocks()
    // in the top-level afterEach.
    function spyProjectJsonWrites(root) {
      const target = path.resolve(root, ".rks", "project.json");
      const spy = vi.spyOn(fs, "writeFileSync");
      return () =>
        spy.mock.calls.filter(([p]) => typeof p === "string" && path.resolve(p) === target).length;
    }
    const noGit = () => vi.fn(() => {
      throw new Error("git must not be called");
    });

    it("patch boundary, offRail absent: writes offRail {enabled:false} and reports it (spy counts 2: offRail + stamp)", () => {
      const { shellRoot, root } = setupChild();
      expect(readPj(root).offRail).toBeUndefined();
      const count = spyProjectJsonWrites(root);
      const report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, deps(noGit()));
      expect(report.ok).toBe(true);
      expect(report.boundary).toBe("patch");
      expect(readPj(root).offRail).toEqual({ enabled: false });
      expect(readPj(root).vcs.contentOnly).toBe(true);
      expect(report.reconciled).toContain(OFFRAIL_ENTRY);
      expect(count()).toBe(2);
    }, TEST_TIMEOUT);

    it("patch boundary, offRail enabled true: forces enabled false and preserves roots", () => {
      const { shellRoot, root } = setupChild({ offRail: { enabled: true, roots: ["components/*", "lib/*"] } });
      const report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, deps(noGit()));
      expect(report.ok).toBe(true);
      expect(readPj(root).offRail).toEqual({ enabled: false, roots: ["components/*", "lib/*"] });
      expect(report.reconciled).toContain(OFFRAIL_ENTRY);
    }, TEST_TIMEOUT);

    it("patch boundary, offRail already {enabled:false, roots}: unchanged, not reported, no offRail-step write (spy counts 1: stamp only)", () => {
      const original = { enabled: false, roots: ["components/*"] };
      const { shellRoot, root } = setupChild({ offRail: original });
      const count = spyProjectJsonWrites(root);
      const report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, deps(noGit()));
      expect(report.ok).toBe(true);
      expect(report.stampAdvanced).toBe(true);
      expect(readPj(root).offRail).toEqual(original);
      expect(report.reconciled.filter((r) => /offRail/.test(r))).toEqual([]);
      expect(count()).toBe(1);
    }, TEST_TIMEOUT);

    it("project.json unparseable AFTER the content-only decision (injected via deps.now): warns, no throw, no offRail write", () => {
      const { shellRoot, root } = setupChild();
      const pjPath = path.join(root, ".rks", "project.json");
      const d = deps(noGit());
      // deps.now is called only as backupFootprint's argument: after the readContentOnly branch,
      // before the offRail step. Do NOT pass noBackup, or it is never called.
      d.now = () => {
        fs.writeFileSync(pjPath, "{ not json");
        return "TS";
      };
      let report;
      expect(() => {
        report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, d);
      }).not.toThrow();
      expect(report.ok).toBe(true);
      expect(report.backupPath).toBeTruthy();
      expect(report.warnings.some((w) => /offRail/.test(w) && /project\.json/.test(w))).toBe(true);
      expect(report.reconciled.filter((r) => /offRail/.test(r))).toEqual([]);
      // advanceStamp falls back to {} on a parse failure and writes {rksVersion} only, so an
      // offRail write by the offRail step would have survived into this result.
      expect(readPj(root)).not.toHaveProperty("offRail");
    }, TEST_TIMEOUT);

    for (const offRail of [undefined, { enabled: true, roots: ["components/*"] }]) {
      const label = offRail === undefined ? "offRail absent stays absent" : "offRail {enabled:true, roots} unchanged";
      it(`non-content-only child: never adds or changes offRail — ${label}`, () => {
        const { shellRoot, root } = setupChild({ contentOnly: false, offRail });
        const report = upgradeProject(
          { projectRoot: root, projectId: "calc", shellRoot, opts: { noCommit: true } },
          deps(noGit()),
        );
        expect(report.ok).toBe(true);
        expect(report.stampAdvanced).toBe(true);
        const pj = readPj(root);
        if (offRail === undefined) expect(pj).not.toHaveProperty("offRail");
        else expect(pj.offRail).toEqual(offRail);
        expect(report.reconciled.filter((r) => /offRail/.test(r))).toEqual([]);
      }, TEST_TIMEOUT);
    }
  });
});

describe("content-only: project init/attach CLI flag", () => {
  function cliDeps(overrides = {}) {
    const calls = { attach: [], init: [], exit: [] };
    const d = {
      processExit: (code) => calls.exit.push(code),
      initProjectFromStack: async (args) => {
        calls.init.push(args);
        return { targetPath: args.targetPath };
      },
      listTemplates: () => [{ stackId: "s" }],
      attachProject: async (args) => {
        calls.attach.push(args);
        return { vendor: null };
      },
      verifyProjectRoot: () => ({ status: "pass", checks: [] }),
      ...overrides,
    };
    return { d, calls };
  }

  it("init and attach pass contentOnly through; usage strings name --content-only", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const shellRoot = mkTmp("rks-co-cli-shell-");
    for (const flag of [true, undefined]) {
      const target = mkTmp("rks-co-cli-init-");
      const { d, calls } = cliDeps();
      const kv = { id: "p", stack: "s", path: target, ...(flag ? { "content-only": true } : {}) };
      await handleProjectCommand({ sub: "init", kv, SHELL_ROOT: shellRoot, args: [] }, d);
      expect(calls.attach).toHaveLength(1);
      if (flag) expect(calls.attach[0].contentOnly).toBe(true);
      else expect(calls.attach[0].contentOnly).toBeFalsy();
      expect(calls.exit).toEqual([0]);

      const target2 = mkTmp("rks-co-cli-attach-");
      const a = cliDeps();
      const kv2 = { id: "p", path: target2, ...(flag ? { "content-only": true } : {}) };
      await handleProjectCommand({ sub: "attach", kv: kv2, SHELL_ROOT: shellRoot, args: [] }, a.d);
      expect(a.calls.attach).toHaveLength(1);
      if (flag) expect(a.calls.attach[0].contentOnly).toBe(true);
      else expect(a.calls.attach[0].contentOnly).toBeFalsy();
    }
    const src = fs.readFileSync(PROJECT_CLI_SRC, "utf8");
    const usages = src.split("\n").filter((l) => /"usage: routekit project (init|attach) /.test(l));
    expect(usages).toHaveLength(2);
    for (const u of usages) expect(u).toContain("--content-only");
  }, TEST_TIMEOUT);

  it("init --content-only --vendor refuses before scaffolding and exits 2 once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const vendor of ["copy", true]) {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const target = path.join(mkTmp("rks-co-cli-refuse-"), "proj");
      const { d, calls } = cliDeps();
      await handleProjectCommand(
        { sub: "init", kv: { id: "p", stack: "s", path: target, "content-only": true, vendor }, SHELL_ROOT: mkTmp("rks-co-cli-sr-"), args: [] },
        d,
      );
      expect(calls.init).toEqual([]);
      expect(calls.attach).toEqual([]);
      expect(calls.exit).toEqual([2]);
      expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("content_only_vendor_conflict");
      expect(fs.existsSync(target)).toBe(false);
      errors.mockRestore();
    }
  }, TEST_TIMEOUT);

  it("attach --content-only --vendor: the real attachProject refuses, exit 1, nothing written", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const shellRoot = makeShellRoot();
    const target = mkTmp("rks-co-cli-attach-refuse-");
    write(target, "README.md", "client\n");
    const before = snapshot(target);
    const install = makeInstallStub();
    const wrapped = [];
    const { d, calls } = cliDeps({
      attachProject: (args) => {
        wrapped.push(args);
        return attachProject({ ...args, shellRoot, installDependencies: install });
      },
    });
    await handleProjectCommand(
      { sub: "attach", kv: { id: "p", path: target, "content-only": true, vendor: "copy" }, SHELL_ROOT: shellRoot, args: [] },
      d,
    );
    expect(wrapped).toHaveLength(1);
    expect(errors.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("content_only_vendor_conflict");
    expect(calls.exit).toEqual([1]);
    expect(install.calls).toEqual([]);
    expect(snapshot(target)).toEqual(before);
  }, TEST_TIMEOUT);
});

// backlog.feat.content-only-remote.exclude-dendron-runtime — Dendron runtime artifacts are always
// excluded; the vault root notes are excluded only when the project's own repo does not track them.
describe("content-only: Dendron runtime + vault root notes", () => {
  const RUNTIME_NEW = ["/.dendron.port", "/.dendron.ws", "/notes/.dendron.cache.json"];
  const FIVE = [".dendron.port", ".dendron.ws", "notes/.dendron.cache.json", "notes/root.md", "notes/root.schema.yml"];

  /** The non-comment lines of the managed block in `root`'s info/exclude. */
  function blockLines(root) {
    const lines = fs.readFileSync(excludePath(root), "utf8").split("\n");
    const b = lines.indexOf(EXCLUDE_BLOCK_BEGIN);
    const e = lines.indexOf(EXCLUDE_BLOCK_END);
    expect(b).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(b);
    return lines.slice(b + 1, e).filter((l) => l && !l.startsWith("#"));
  }
  const commitFiles = (root, files, msg, { force = false } = {}) => {
    gitOk(root, ["add", ...(force ? ["-f"] : []), "--", ...files]);
    gitOk(root, ["commit", "-q", "-m", msg]);
  };
  /** clientRepo plus committed vault-root files. */
  function repoTracking(rels, name) {
    const root = clientRepo(name);
    for (const rel of rels) write(root, rel, `client ${rel}\n`);
    if (rels.length) commitFiles(root, rels, "client vault root");
    return root;
  }
  function withBare(root) {
    const bare = mkTmp("rks-co-vr-bare-");
    gitOk(bare, ["init", "-q", "--bare"]);
    gitOk(root, ["remote", "add", "origin", bare]);
    return bare;
  }
  const pushMain = (root) => git(root, ["push", "origin", "HEAD:refs/heads/main"]);
  const hookPattern = (root) => {
    const line = fs.readFileSync(hookPathOf(root), "utf8").split("\n").find((l) => l.startsWith("RKS_PATTERN="));
    expect(line).toBeTruthy();
    return new RegExp(line.slice("RKS_PATTERN='".length, -1));
  };
  const vaultWarnings = (ws) => (ws || []).filter((w) => /vault-root/i.test(w));
  const attach = (opts) =>
    attachProject({ projectId: "co-vr", contentOnly: true, installDependencies: makeInstallStub(), ...opts });

  it("runtime group gains the three Dendron artifacts, keeps its seven entries, shares none with the template group", () => {
    for (const e of [...RUNTIME_NEW, "/.rks/", "/.routekit/", "/.claude/", "/.codex/", "/routekit/", "/.mcp.json", "/dendron.yml"]) {
      expect(CONTENT_ONLY_RUNTIME_PATHS).toContain(e);
    }
    expect(CONTENT_ONLY_RUNTIME_PATHS.filter((e) => CONTENT_ONLY_TEMPLATE_PATHS.includes(e))).toEqual([]);
  });

  it("writeContentOnlyExclude with no extraPaths writes the three Dendron runtime entries", () => {
    const root = clientRepo();
    writeContentOnlyExclude(root);
    const lines = blockLines(root);
    for (const e of RUNTIME_NEW) expect(lines).toContain(e);
  }, TEST_TIMEOUT);

  it("VAULT_ROOT_NOTE_PATHS is exactly the two vault root entries", () => {
    expect(VAULT_ROOT_NOTE_PATHS).toEqual(["/notes/root.md", "/notes/root.schema.yml"]);
  });

  describe("listVaultRootExcludes", () => {
    it("repo with history, neither tracked: both entries, no error", () => {
      const r = listVaultRootExcludes(clientRepo());
      expect(r.entries).toEqual(["/notes/root.md", "/notes/root.schema.yml"]);
      expect(r.error).toBeUndefined();
    }, TEST_TIMEOUT);

    it("tracks root.md only: [/notes/root.schema.yml]; tracks both: []; no error either way", () => {
      const one = listVaultRootExcludes(repoTracking(["notes/root.md"]));
      expect(one.entries).toEqual(["/notes/root.schema.yml"]);
      expect(one.error).toBeUndefined();
      const both = listVaultRootExcludes(repoTracking(["notes/root.md", "notes/root.schema.yml"]));
      expect(both.entries).toEqual([]);
      expect(both.error).toBeUndefined();
    }, TEST_TIMEOUT);

    it("no .git: both entries without consulting a parent repo that tracks the files at both levels", () => {
      const lone = mkTmp("rks-co-vr-nogit-");
      expect(listVaultRootExcludes(lone)).toEqual({ entries: ["/notes/root.md", "/notes/root.schema.yml"] });
      const parent = repoTracking([
        "notes/root.md",
        "notes/root.schema.yml",
        "sub/notes/root.md",
        "sub/notes/root.schema.yml",
      ]);
      const sub = path.join(parent, "sub");
      expect(fs.existsSync(path.join(sub, ".git"))).toBe(false);
      const r = listVaultRootExcludes(sub);
      expect(r.entries).toEqual(["/notes/root.md", "/notes/root.schema.yml"]);
      expect(r.error).toBeUndefined();
    }, TEST_TIMEOUT);

    it("resolves a .git FILE of a linked worktree whose branch tracks notes/root.md", () => {
      const main = clientRepo();
      gitOk(main, ["checkout", "-q", "-b", "vault"]);
      write(main, "notes/root.md", "root\n");
      commitFiles(main, ["notes/root.md"], "vault root");
      gitOk(main, ["checkout", "-q", "main"]);
      const wt = path.join(mkTmp("rks-co-vr-wt-"), "wt");
      gitOk(main, ["worktree", "add", "-q", wt, "vault"]);
      expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
      const r = listVaultRootExcludes(wt);
      expect(r.entries).toEqual(["/notes/root.schema.yml"]);
      expect(r.error).toBeUndefined();
    }, TEST_TIMEOUT);

    it("a failing git (broken .git file) does not throw: entries [] and a non-empty error", () => {
      const root = mkTmp("rks-co-vr-broken-");
      fs.writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(root, "nonexistent", "gitdir")}\n`);
      let r;
      expect(() => {
        r = listVaultRootExcludes(root);
      }).not.toThrow();
      expect(r.entries).toEqual([]);
      expect(typeof r.error).toBe("string");
      expect(r.error.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);
  });

  describe("attachProject", () => {
    it("repo with history, vault root untracked: both entries excluded; the five files stay invisible", async () => {
      const root = clientRepo();
      const res = await attach({ shellRoot: makeShellRoot(), projectRoot: root });
      const lines = blockLines(root);
      for (const e of [...RUNTIME_NEW, ...VAULT_ROOT_NOTE_PATHS]) expect(lines).toContain(e);
      expect(vaultWarnings(res.contentOnly.warnings)).toEqual([]);
      for (const rel of FIVE) write(root, rel, "runtime\n");
      const st = porcelain(root);
      for (const rel of FIVE) expect(st.join("\n")).not.toContain(rel);
    }, TEST_TIMEOUT);

    it("no stack, repo already tracks notes/root.md: not excluded, not in the hook, not audited, push passes", async () => {
      const root = repoTracking(["notes/root.md"]);
      withBare(root);
      const res = await attach({ shellRoot: makeShellRoot(), projectRoot: root });
      const lines = blockLines(root);
      expect(lines).not.toContain("/notes/root.md");
      expect(lines).toContain("/notes/root.schema.yml");
      expect(fs.readFileSync(hookPathOf(root), "utf8")).toBe(renderPrePushHook(lines));
      expect(hookPattern(root).test("notes/root.md")).toBe(false);
      expect(res.contentOnly.alreadyTracked).not.toContain("notes/root.md");
      const base = pushMain(root);
      expect(base.status, base.stderr).toBe(0);
      write(root, "notes/root.md", "client root, edited\n");
      commitFiles(root, ["notes/root.md"], "edit vault root");
      const r = pushMain(root);
      expect(r.status, r.stderr).toBe(0);
    }, TEST_TIMEOUT);

    it("WITH a stack seeding notes/root.md, repo already tracks notes/root.md: not excluded, not audited, push passes", async () => {
      const shellRoot = makeShellRoot(STACK);
      expect(listSeededNotePaths({ shellRoot, stackId: STACK })).toEqual(
        expect.arrayContaining(["/notes/root.md", "/notes/root.schema.yml"]),
      );
      const root = repoTracking(["notes/root.md"]);
      withBare(root);
      const res = await attach({ shellRoot, projectRoot: root, stackId: STACK, stackTemplate: { stackId: STACK } });
      const lines = blockLines(root);
      expect(lines).not.toContain("/notes/root.md");
      expect(lines).toContain("/notes/root.schema.yml");
      expect(hookPattern(root).test("notes/root.md")).toBe(false);
      expect(res.contentOnly.alreadyTracked).not.toContain("notes/root.md");
      const base = pushMain(root);
      expect(base.status, base.stderr).toBe(0);
      write(root, "notes/root.md", "client root, edited\n");
      commitFiles(root, ["notes/root.md"], "edit vault root");
      const r = pushMain(root);
      expect(r.status, r.stderr).toBe(0);
    }, TEST_TIMEOUT);

    it("the installed pre-push hook rejects a push adding .dendron.port, and one adding notes/.dendron.cache.json", async () => {
      const root = clientRepo();
      withBare(root);
      await attach({ shellRoot: makeShellRoot(), projectRoot: root });
      const base = pushMain(root);
      expect(base.status, base.stderr).toBe(0);
      for (const rel of [".dendron.port", "notes/.dendron.cache.json"]) {
        write(root, rel, "runtime\n");
        commitFiles(root, [rel], `add ${rel}`, { force: true });
        const bad = pushMain(root);
        expect(bad.status, rel).not.toBe(0);
        expect(bad.stderr).toContain(rel);
        gitOk(root, ["reset", "-q", "--hard", "HEAD~1"]);
      }
    }, TEST_TIMEOUT);

    it("fresh init (no .git before attach): both vault-root entries, no vault-root warning", async () => {
      const root = path.join(mkTmp("rks-co-vr-fresh-"), "proj");
      // client content, so the content-only baseline commit has something to hold
      write(root, "README.md", "# fresh client\n");
      const res = await attach({ shellRoot: makeShellRoot(), projectRoot: root });
      expect(res.gitBootstrap.bootstrapped, JSON.stringify(res.gitBootstrap)).toBe(true);
      const lines = blockLines(root);
      for (const e of VAULT_ROOT_NOTE_PATHS) expect(lines).toContain(e);
      expect(vaultWarnings(res.contentOnly.warnings)).toEqual([]);
    }, TEST_TIMEOUT);

    it("fresh init nested in a parent repo tracking the vault root at both levels: both entries, no warning", async () => {
      const parent = repoTracking([
        "notes/root.md",
        "notes/root.schema.yml",
        "sub/notes/root.md",
        "sub/notes/root.schema.yml",
      ]);
      const sub = path.join(parent, "sub");
      expect(fs.existsSync(path.join(sub, ".git"))).toBe(false);
      // client content outside the vault root, so the content-only baseline commit has something to hold
      write(sub, "README.md", "# nested client\n");
      const res = await attach({ shellRoot: makeShellRoot(), projectRoot: sub });
      expect(res.gitBootstrap.bootstrapped, JSON.stringify(res.gitBootstrap)).toBe(true);
      expect(fs.existsSync(path.join(sub, ".git"))).toBe(true);
      expect(fs.realpathSync(excludePath(sub))).toBe(fs.realpathSync(path.join(sub, ".git", "info", "exclude")));
      const lines = blockLines(sub);
      for (const e of VAULT_ROOT_NOTE_PATHS) expect(lines).toContain(e);
      expect(vaultWarnings(res.contentOnly.warnings)).toEqual([]);
    }, TEST_TIMEOUT);

    it("a failing vault-root lookup (seam) does not throw: no vault-root entries, runtime entries kept, warning carries the error", async () => {
      const root = clientRepo();
      const lookup = vi.fn(() => ({ entries: [], error: "forced-lookup-failure-xyz" }));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await attach({ shellRoot: makeShellRoot(), projectRoot: root, lookupVaultRootExcludes: lookup });
      expect(lookup).toHaveBeenCalledTimes(1);
      const lines = blockLines(root);
      for (const e of VAULT_ROOT_NOTE_PATHS) expect(lines).not.toContain(e);
      for (const e of RUNTIME_NEW) expect(lines).toContain(e);
      const vw = vaultWarnings(res.contentOnly.warnings);
      expect(vw.length).toBe(1);
      expect(vw[0]).toContain("forced-lookup-failure-xyz");
    }, TEST_TIMEOUT);

    it("a successful lookup returning [] (both tracked) adds no vault-root warning", async () => {
      const root = repoTracking(["notes/root.md", "notes/root.schema.yml"]);
      const res = await attach({ shellRoot: makeShellRoot(), projectRoot: root });
      const lines = blockLines(root);
      for (const e of VAULT_ROOT_NOTE_PATHS) expect(lines).not.toContain(e);
      expect(vaultWarnings(res.contentOnly.warnings)).toEqual([]);
    }, TEST_TIMEOUT);
  });

  describe("upgradeProject", () => {
    // Mirrors the content-only upgradeProject fixture above, with a block written before this change.
    function child(trackedRels = []) {
      const shellRoot = mkTmp("rks-co-vr-upg-shell-");
      write(shellRoot, "templates/base/notes/backlog.md", "b");
      write(shellRoot, `templates/${STACK}/skeleton/notes/stack.welcome.md`, "w");
      write(shellRoot, ".routekit/hooks-manifest.json", "{}");
      const root = repoTracking(trackedRels, "rks-co-vr-upg-child-");
      write(root, ".rks/project.json", JSON.stringify({ id: "calc", rksVersion: "0.20.18", vcs: { contentOnly: true } }, null, 2));
      write(root, "routekit/project.json", JSON.stringify({ id: "calc", stack: STACK }, null, 2));
      // No Dendron runtime entries and no vault-root entries, as before this change.
      const old = [EXCLUDE_BLOCK_BEGIN, "# old", "/.rks/", "/.mcp.json", "/notes/backlog.md", EXCLUDE_BLOCK_END].join("\n") + "\n";
      fs.writeFileSync(excludePath(root), old);
      return { shellRoot, root };
    }
    const upDeps = (version, extra = {}) => ({
      readRksVersion: vi.fn(() => version),
      syncProject: vi.fn(() => []),
      repinMcpServer: vi.fn(() => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] })),
      migrateChildSettingsHookPaths: vi.fn(() => false),
      ensureHookRegistration: vi.fn(() => ({ changed: false })),
      mergeRksPermissionAllow: vi.fn(() => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] })),
      migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true })),
      seedVitestFiles: vi.fn(() => ({ created: [], templateMissing: [] })),
      now: () => "TS",
      git: vi.fn(() => {
        throw new Error("git must not be called");
      }),
      ...extra,
    });
    const EXCLUDE_RECONCILED = ".git/info/exclude (content-only block refreshed)";

    it("rewrites a pre-change block to the new entries (one block); a second run is byte-identical and unchanged", () => {
      const { shellRoot, root } = child();
      const first = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, upDeps("0.20.19"));
      expect(first.ok).toBe(true);
      const text = fs.readFileSync(excludePath(root), "utf8");
      expect(countBlocks(text)).toBe(1);
      const lines = blockLines(root);
      for (const e of [...RUNTIME_NEW, ...VAULT_ROOT_NOTE_PATHS]) expect(lines).toContain(e);
      expect(first.reconciled).toContain(EXCLUDE_RECONCILED);
      expect(vaultWarnings(first.warnings)).toEqual([]);

      const second = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, upDeps("0.20.20"));
      expect(second.ok).toBe(true);
      expect(second.boundary).toBe("patch");
      expect(fs.readFileSync(excludePath(root), "utf8")).toBe(text);
      expect(second.contentOnly.exclude.changed).toBe(false);
      expect(second.reconciled).not.toContain(EXCLUDE_RECONCILED);
    }, TEST_TIMEOUT);

    it("a child tracking notes/root.md: /notes/root.md not added, /notes/root.schema.yml added", () => {
      const { shellRoot, root } = child(["notes/root.md"]);
      const report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, upDeps("0.20.19"));
      expect(report.ok).toBe(true);
      const lines = blockLines(root);
      expect(lines).not.toContain("/notes/root.md");
      expect(lines).toContain("/notes/root.schema.yml");
    }, TEST_TIMEOUT);

    it("a failing vault-root lookup (deps seam) does not throw and adds a vault-root warning to report.warnings", () => {
      const { shellRoot, root } = child();
      const lookup = vi.fn(() => ({ entries: [], error: "forced-upgrade-lookup-failure" }));
      let report;
      expect(() => {
        report = upgradeProject(
          { projectRoot: root, projectId: "calc", shellRoot },
          upDeps("0.20.19", { listVaultRootExcludes: lookup }),
        );
      }).not.toThrow();
      expect(lookup).toHaveBeenCalledTimes(1);
      const vw = vaultWarnings(report.warnings);
      expect(vw.length).toBe(1);
      expect(vw[0]).toContain("forced-upgrade-lookup-failure");
      const lines = blockLines(root);
      for (const e of VAULT_ROOT_NOTE_PATHS) expect(lines).not.toContain(e);
      for (const e of RUNTIME_NEW) expect(lines).toContain(e);
    }, TEST_TIMEOUT);

    it("a successful lookup returning [] (both tracked) adds no vault-root warning", () => {
      const { shellRoot, root } = child(["notes/root.md", "notes/root.schema.yml"]);
      const report = upgradeProject({ projectRoot: root, projectId: "calc", shellRoot }, upDeps("0.20.19"));
      expect(report.ok).toBe(true);
      expect(vaultWarnings(report.warnings)).toEqual([]);
      const lines = blockLines(root);
      for (const e of VAULT_ROOT_NOTE_PATHS) expect(lines).not.toContain(e);
    }, TEST_TIMEOUT);
  });
});

// backlog.feat.content-only-remote.attach-outcome-reporting — attachProject fails closed when the
// content-only exclude block is not written (no install), and the CLI prints the content-only
// result and git bootstrap status, exiting 1 only when attachProject returns ok:false.
describe("content-only: attach outcome reporting", () => {
  /** Replace the repo's info/exclude with a directory so writeContentOnlyExclude throws. */
  function breakExclude(root) {
    const p = excludePath(root);
    fs.rmSync(p, { recursive: true, force: true });
    fs.mkdirSync(p, { recursive: true });
  }
  /** A fresh git-initialised directory (no commits) whose exclude write cannot succeed. */
  function freshBrokenRepo(name) {
    const root = mkTmp(name);
    gitOk(root, ["init", "-q"]);
    write(root, "README.md", "client\n");
    breakExclude(root);
    return root;
  }
  const logged = (spy) => spy.mock.calls.map((c) => c.join(" "));
  /** The one console.log call that is the result JSON object. */
  function printedJson(spy) {
    const objs = logged(spy)
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l));
    expect(objs).toHaveLength(1);
    return objs[0];
  }

  describe("attachProject", () => {
    it("fresh repo, exclude write fails: ok false, content_only_exclude_failed, guards ran, no install", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const shellRoot = makeShellRoot();
      const root = freshBrokenRepo("rks-co-out-fresh-");
      const install = makeInstallStub();
      const res = await attachProject({
        shellRoot,
        projectRoot: root,
        projectId: "co-out-fresh",
        contentOnly: true,
        installDependencies: install,
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("content_only_exclude_failed");
      expect(res.gitBootstrap.reason).toBe("content_only_exclude_failed");
      expect(install.calls).toEqual([]);
      // the guards still ran
      expect(res.contentOnly).not.toBeNull();
      expect(res.contentOnly.exclude.ok).toBe(false);
      expect(res.contentOnly.prePush).toBeTruthy();
      expect(typeof res.contentOnly.prePush.installed).toBe("boolean");
      expect(git(root, ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
    }, TEST_TIMEOUT);

    it("repo with history, exclude write throws: ok false, exclude.ok false, prePush populated, no install", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const shellRoot = makeShellRoot();
      const root = clientRepo("rks-co-out-hist-");
      breakExclude(root);
      const install = makeInstallStub();
      const res = await attachProject({
        shellRoot,
        projectRoot: root,
        projectId: "co-out-hist",
        contentOnly: true,
        installDependencies: install,
      });
      expect(res.gitBootstrap).toMatchObject({ bootstrapped: false, reason: "existing-history" });
      expect(res.ok).toBe(false);
      expect(res.contentOnly.exclude.ok).toBe(false);
      expect(res.error).toContain("content_only_exclude_failed");
      expect(res.contentOnly.prePush).toBeTruthy();
      expect(typeof res.contentOnly.prePush.installed).toBe("boolean");
      expect(install.calls).toEqual([]);
    }, TEST_TIMEOUT);

    it("successful content-only attach: ok true, exclude.ok true, install called once with the root", async () => {
      const shellRoot = makeShellRoot();
      const root = clientRepo("rks-co-out-ok-");
      const install = makeInstallStub();
      const res = await attachProject({
        shellRoot,
        projectRoot: root,
        projectId: "co-out-ok",
        contentOnly: true,
        installDependencies: install,
      });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
      expect(res.contentOnly.exclude.ok).toBe(true);
      expect(install.calls).toEqual([path.resolve(root)]);
    }, TEST_TIMEOUT);

    it("non-content-only attach: ok true, install called once (unchanged)", async () => {
      const shellRoot = makeShellRoot();
      const root = clientRepo("rks-co-out-plain-");
      const install = makeInstallStub();
      const res = await attachProject({
        shellRoot,
        projectRoot: root,
        projectId: "co-out-plain",
        installDependencies: install,
      });
      expect(res.ok).toBe(true);
      expect(res.contentOnly).toBeNull();
      expect(install.calls).toEqual([path.resolve(root)]);
    }, TEST_TIMEOUT);
  });

  describe("CLI", () => {
    function deps(attachImpl) {
      const calls = { attach: [], init: [], exit: [] };
      const d = {
        processExit: (code) => calls.exit.push(code),
        initProjectFromStack: async (args) => {
          calls.init.push(args);
          return { targetPath: args.targetPath };
        },
        listTemplates: () => [{ stackId: "s" }],
        attachProject: async (args) => {
          calls.attach.push(args);
          return attachImpl(args);
        },
        verifyProjectRoot: () => ({ status: "pass", checks: [] }),
      };
      return { d, calls };
    }
    const CO_RESULT = {
      exclude: { ok: true, path: "/x/.git/info/exclude", changed: true },
      prePush: { installed: true, path: "/x/.git/hooks/pre-push" },
      alreadyTracked: [],
      warnings: [],
    };

    it("attach --content-only with the real attachProject prints contentOnly + gitBootstrap and exits 0", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const shellRoot = makeShellRoot();
      const root = clientRepo("rks-co-out-cli-ok-");
      const install = makeInstallStub();
      const { d, calls } = deps((args) => attachProject({ ...args, shellRoot, installDependencies: install }));
      await handleProjectCommand(
        { sub: "attach", kv: { id: "co-out-cli", path: root, "content-only": true }, SHELL_ROOT: shellRoot, args: [] },
        d,
      );
      expect(calls.exit).toEqual([0]);
      const out = printedJson(log);
      expect(out).toHaveProperty("verify");
      expect(out).toHaveProperty("vendor");
      expect(out.contentOnly.exclude).toMatchObject({ ok: true });
      expect(out.contentOnly.prePush).toMatchObject({ installed: true });
      expect(Array.isArray(out.contentOnly.alreadyTracked)).toBe(true);
      expect(Array.isArray(out.contentOnly.warnings)).toBe(true);
      expect(out.gitBootstrap).toMatchObject({ bootstrapped: false, reason: "existing-history" });
      expect(install.calls).toEqual([path.resolve(root)]);
    }, TEST_TIMEOUT);

    it("attach where the real attachProject returns ok false: exit [1], no 'Attached project', JSON still printed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const shellRoot = makeShellRoot();
      const root = clientRepo("rks-co-out-cli-fail-");
      breakExclude(root);
      const install = makeInstallStub();
      const { d, calls } = deps((args) => attachProject({ ...args, shellRoot, installDependencies: install }));
      await handleProjectCommand(
        { sub: "attach", kv: { id: "co-out-cli-f", path: root, "content-only": true }, SHELL_ROOT: shellRoot, args: [] },
        d,
      );
      expect(calls.exit).toEqual([1]);
      expect(logged(log).some((l) => l.includes("Attached project"))).toBe(false);
      const out = printedJson(log);
      expect(out.contentOnly.exclude.ok).toBe(false);
      expect(out).toHaveProperty("gitBootstrap");
      expect(logged(errors).join("\n")).toContain("content_only_exclude_failed");
      expect(install.calls).toEqual([]);
    }, TEST_TIMEOUT);

    it("attach where a stubbed attachProject returns ok false: exit [1] once, JSON printed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const target = mkTmp("rks-co-out-cli-stub-");
      const { d, calls } = deps(() => ({
        ok: false,
        error: "content_only_exclude_failed: boom",
        vendor: null,
        gitBootstrap: { bootstrapped: false, reason: "existing-history" },
        contentOnly: { ...CO_RESULT, exclude: { ok: false, error: "boom" } },
      }));
      await handleProjectCommand(
        { sub: "attach", kv: { id: "p", path: target, "content-only": true }, SHELL_ROOT: mkTmp("rks-co-out-sr-"), args: [] },
        d,
      );
      expect(calls.exit).toEqual([1]);
      expect(logged(log).some((l) => l.includes("Attached project"))).toBe(false);
      const out = printedJson(log);
      expect(out.contentOnly.exclude.ok).toBe(false);
      expect(out.gitBootstrap).toMatchObject({ reason: "existing-history" });
    }, TEST_TIMEOUT);

    it("init --content-only prints contentOnly + gitBootstrap and exits [0] on success", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const target = mkTmp("rks-co-out-init-ok-");
      const { d, calls } = deps(() => ({
        ok: true,
        vendor: null,
        gitBootstrap: { bootstrapped: true, working: "dev", branches: ["main", "staging", "dev"] },
        contentOnly: CO_RESULT,
      }));
      await handleProjectCommand(
        { sub: "init", kv: { id: "p", stack: "s", path: target, "content-only": true }, SHELL_ROOT: mkTmp("rks-co-out-sr-"), args: [] },
        d,
      );
      expect(calls.exit).toEqual([0]);
      const out = printedJson(log);
      expect(out.contentOnly).toEqual(CO_RESULT);
      expect(out.gitBootstrap).toMatchObject({ bootstrapped: true });
      expect(logged(log).some((l) => l.startsWith("Next steps"))).toBe(true);
    }, TEST_TIMEOUT);

    it("init --content-only where attachProject returns ok false: exit [1] only, no Next steps line", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const target = mkTmp("rks-co-out-init-fail-");
      const { d, calls } = deps(() => ({
        ok: false,
        error: "content_only_exclude_failed: boom",
        vendor: null,
        gitBootstrap: { bootstrapped: false, reason: "content_only_exclude_failed", error: "boom" },
        contentOnly: { ...CO_RESULT, exclude: { ok: false, error: "boom" } },
      }));
      await handleProjectCommand(
        { sub: "init", kv: { id: "p", stack: "s", path: target, "content-only": true }, SHELL_ROOT: mkTmp("rks-co-out-sr-"), args: [] },
        d,
      );
      expect(calls.exit).toEqual([1]);
      expect(calls.exit).not.toContain(0);
      expect(logged(log).some((l) => l.includes("Next steps"))).toBe(false);
      const out = printedJson(log);
      expect(out).toHaveProperty("contentOnly");
      expect(out.gitBootstrap).toMatchObject({ reason: "content_only_exclude_failed" });
    }, TEST_TIMEOUT);

    it("non-content-only attach: no contentOnly key (or null), gitBootstrap printed, exit [0]", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const shellRoot = makeShellRoot();
      const root = clientRepo("rks-co-out-cli-plain-");
      const install = makeInstallStub();
      const { d, calls } = deps((args) => attachProject({ ...args, shellRoot, installDependencies: install }));
      await handleProjectCommand(
        { sub: "attach", kv: { id: "co-out-cli-p", path: root }, SHELL_ROOT: shellRoot, args: [] },
        d,
      );
      expect(calls.exit).toEqual([0]);
      const out = printedJson(log);
      expect(out.contentOnly ?? null).toBeNull();
      expect(out).toHaveProperty("gitBootstrap");
      expect(out.gitBootstrap).toMatchObject({ reason: "existing-history" });
      expect(install.calls).toEqual([path.resolve(root)]);
    }, TEST_TIMEOUT);

    it("only boot.ok === false is failure: a stub result without ok exits [0] for init and attach", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const a = deps(() => ({ vendor: null }));
      await handleProjectCommand(
        { sub: "attach", kv: { id: "p", path: mkTmp("rks-co-out-nook-a-"), "content-only": true }, SHELL_ROOT: mkTmp("rks-co-out-sr-"), args: [] },
        a.d,
      );
      expect(a.calls.exit).toEqual([0]);
      const i = deps(() => ({ vendor: null }));
      await handleProjectCommand(
        { sub: "init", kv: { id: "p", stack: "s", path: mkTmp("rks-co-out-nook-i-"), "content-only": true }, SHELL_ROOT: mkTmp("rks-co-out-sr-"), args: [] },
        i.d,
      );
      expect(i.calls.exit).toEqual([0]);
      expect(logged(log).some((l) => l.includes("Attached project"))).toBe(true);
    }, TEST_TIMEOUT);
  });
});

describe("content-only: test isolation", () => {
  it("left the repo's own projects/index.jsonl byte-identical", () => {
    const after = fs.existsSync(REPO_REGISTRY) ? fs.readFileSync(REPO_REGISTRY) : null;
    if (registryBefore === null) expect(after).toBeNull();
    else expect(Buffer.compare(after, registryBefore)).toBe(0);
  });
});
