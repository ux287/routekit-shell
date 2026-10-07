/**
 * backlog.fix.upgrade-leaves-child-tree-dirty — INTEGRATION tier (real git; every spawn
 * carries an explicit timeout). upgradeProject runs with its DEFAULT git primitive; every
 * other reconciler is stubbed so the footprint each test writes is known exactly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";

const created = [];
const tmp = (p) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  created.push(d);
  return d;
};

function gitRaw(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const git = (cwd, args) => gitRaw(cwd, args).trim();
const lines = (s) => s.split("\n").filter(Boolean);
const head = (cwd) => git(cwd, ["rev-parse", "HEAD"]);
const porcelain = (cwd) => lines(gitRaw(cwd, ["status", "--porcelain", "--untracked-files=all"]));
const staged = (cwd) => lines(git(cwd, ["diff", "--cached", "--name-only"]));
const filesIn = (cwd, sha) => lines(git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]));
const tree = (cwd) => lines(git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]));
const subject = (cwd) => git(cwd, ["log", "-1", "--format=%s"]);

const ENV_KEYS = ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: tmp("rks-upg-home-"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** A child committed on `branch`, stamped `from`. `at` places it at an explicit path. */
function makeChild({ from = "0.59.6", branch = "feature/work", projectJson = {}, gitignore = "node_modules/\n", init = true, at } = {}) {
  const root = at || tmp("rks-upg-child-");
  write(root, ".rks/project.json", JSON.stringify({ id: "child", rksVersion: from, ...projectJson }, null, 2) + "\n");
  write(root, ".routekit/hooks/read/a.mjs", "// old hook\n");
  write(root, ".claude/skills/old/SKILL.md", "old skill\n");
  write(root, ".claude/settings.json", JSON.stringify({ hooks: {} }, null, 2) + "\n");
  write(root, ".mcp.json", JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  write(root, "src/app.js", "export const a = 1;\n");
  write(root, ".gitignore", gitignore);
  if (init) {
    git(root, ["init", "-q", "-b", branch]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fixture"]);
  }
  return root;
}

function makeShell() {
  const shell = tmp("rks-upg-shell-");
  write(shell, ".routekit/hooks-manifest.json", "{}\n");
  return shell;
}

/** Stubbed reconcilers: sync rewrites a hook, adds a skill and deletes the old one. */
function deps(to = "0.59.7", { sync } = {}) {
  return {
    readRksVersion: () => to,
    syncProject:
      sync ||
      (({ projectRoot }) => {
        write(projectRoot, ".routekit/hooks/read/a.mjs", `// hook ${to}\n`);
        write(projectRoot, ".claude/skills/new/SKILL.md", `new skill ${to}\n`);
        fs.rmSync(path.join(projectRoot, ".claude/skills/old"), { recursive: true, force: true });
        return [];
      }),
    repinMcpServer: () => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] }),
    migrateChildSettingsHookPaths: () => false,
    ensureHookRegistration: () => ({ changed: false }),
    mergeRksPermissionAllow: () => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] }),
    migrateConfig: () => ({ ok: true, applied: [], noOp: true }),
    seedVitestFiles: () => ({ created: [], templateMissing: [] }),
    now: () => "TS",
  };
}
const upgrade = (root, d = deps(), opts) =>
  upgradeProject({ projectRoot: root, projectId: "child", shellRoot: makeShell(), opts }, d);
const HEALED = "node_modules/\n.rks/.upgrade-backup/\n.rks/.backup/\n";

describe("upgradeProject commits its own footprint (real git)", () => {
  it("makes one commit of the footprint, observed not intended, and leaves a clean tree clean", () => {
    const root = makeChild();
    const before = head(root);
    const r = upgrade(root);
    expect(r.ok).toBe(true);
    expect(r.committed).toBe(true);
    const after = head(root);
    expect(after).not.toBe(before);
    expect(git(root, ["rev-parse", `${after}^`])).toBe(before);
    expect(r.commitSha).toBe(after);
    expect(subject(root)).toBe("chore(rks): upgrade scaffolding 0.59.6 -> 0.59.7");
    expect([...r.committedFiles].sort()).toEqual(filesIn(root, after).sort());
    expect(r.committedFiles).toEqual(
      expect.arrayContaining([
        ".rks/project.json",
        ".routekit/hooks/read/a.mjs",
        ".claude/skills/new/SKILL.md",
        ".claude/skills/old/SKILL.md",
        ".gitignore",
      ]),
    );
    expect(tree(root)).not.toContain(".claude/skills/old/SKILL.md");
    expect(porcelain(root)).toEqual([]);
  });

  it("never stages or commits operator work outside the footprint", () => {
    const root = makeChild();
    write(root, "src/app.js", "export const a = 2;\n");
    write(root, "src/new.js", "untracked\n");
    write(root, "src/staged.js", "staged\n");
    git(root, ["add", "src/staged.js"]);
    const r = upgrade(root);
    expect(r.committed).toBe(true);
    expect(filesIn(root, head(root)).filter((f) => f.startsWith("src/"))).toEqual([]);
    expect(r.committedFiles.filter((f) => f.startsWith("src/"))).toEqual([]);
    const status = porcelain(root);
    expect(status).toContain(" M src/app.js");
    expect(status).toContain("?? src/new.js");
    expect(staged(root)).toContain("src/staged.js");
  });

  it("excludes a footprint file that was already dirty before the upgrade, and names it", () => {
    const root = makeChild();
    write(root, ".claude/settings.json", JSON.stringify({ hooks: {}, operator: true }, null, 2) + "\n");
    const r = upgrade(root);
    expect(r.committed).toBe(true);
    expect(r.committedFiles).not.toContain(".claude/settings.json");
    expect(porcelain(root)).toContain(" M .claude/settings.json");
    expect(r.warnings.some((w) => w.includes(".claude/settings.json"))).toBe(true);
  });

  it("a second upgrade does not re-commit .gitignore", () => {
    const root = makeChild();
    upgrade(root, deps("0.59.7"));
    const r2 = upgrade(root, deps("0.59.8"));
    expect(r2.committed).toBe(true);
    expect(r2.committedFiles).not.toContain(".gitignore");
    expect(subject(root)).toBe("chore(rks): upgrade scaffolding 0.59.7 -> 0.59.8");
  });

  it("creates no empty commit when nothing in the footprint changed", () => {
    const root = makeChild({ gitignore: HEALED });
    write(root, ".rks/project.json", JSON.stringify({ id: "child", rksVersion: "0.59.6", operator: true }, null, 2) + "\n");
    const before = head(root);
    const r = upgrade(root, deps("0.59.7", { sync: () => [] }));
    expect(r.ok).toBe(true);
    expect(r.committed).toBe(false);
    expect(r.commitSkipped).toBe("nothing_to_commit");
    expect(head(root)).toBe(before);
  });
});

describe("commit refusals leave the upgrade successful and HEAD untouched", () => {
  const expectRefused = (repo, before, r, reason) => {
    expect(r.ok).toBe(true);
    expect(r.stampAdvanced).toBe(true);
    expect(r.committed).toBe(false);
    expect(r.commitSha).toBeNull();
    expect(r.committedFiles).toEqual([]);
    expect(r.commitSkipped).toBe(reason);
    if (before) expect(head(repo)).toBe(before);
  };

  it("refuses on a protected branch and names it", () => {
    const root = makeChild({ branch: "main" });
    const before = head(root);
    const r = upgrade(root);
    expectRefused(root, before, r, "protected_branch");
    expect(r.warnings.some((w) => w.includes("main"))).toBe(true);
  });

  it("refuses on a detached HEAD", () => {
    const root = makeChild();
    git(root, ["checkout", "-q", "--detach"]);
    const before = head(root);
    expectRefused(root, before, upgrade(root), "detached_head");
  });

  it("honours the child's opt-out (.rks/project.json upgrade.commit: false)", () => {
    const root = makeChild({ projectJson: { upgrade: { commit: false } } });
    const before = head(root);
    expectRefused(root, before, upgrade(root), "opted_out");
  });

  it("does not commit when the child is not a git repository", () => {
    const root = makeChild({ init: false });
    expectRefused(root, null, upgrade(root), "not_git_repo");
  });

  it("never commits into an enclosing repository", () => {
    const parent = tmp("rks-upg-parent-");
    write(parent, "README.md", "parent\n");
    git(parent, ["init", "-q", "-b", "feature/parent"]);
    git(parent, ["add", "-A"]);
    git(parent, ["commit", "-q", "-m", "parent"]);
    const before = head(parent);
    const root = makeChild({ init: false, at: path.join(parent, "child") });
    const r = upgrade(root);
    expectRefused(parent, before, r, "not_repo_root");
    expect(staged(parent)).toEqual([]);
  });

  it("reports a failed commit without failing the upgrade, and restores the index", () => {
    const root = makeChild();
    write(root, ".git/hooks/pre-commit", "#!/bin/sh\necho rejected >&2\nexit 1\n");
    fs.chmodSync(path.join(root, ".git", "hooks", "pre-commit"), 0o755);
    const before = head(root);
    const r = upgrade(root);
    expectRefused(root, before, r, "commit_failed");
    expect(r.warnings.some((w) => /commit/i.test(w))).toBe(true);
    expect(staged(root)).toEqual([]);
  });

  it("a failed commit restores the index path-scoped: operator work and the upgraded files survive", () => {
    const root = makeChild();
    write(root, ".git/hooks/pre-commit", "#!/bin/sh\necho rejected >&2\nexit 1\n");
    fs.chmodSync(path.join(root, ".git", "hooks", "pre-commit"), 0o755);
    write(root, "src/app.js", "export const a = 2;\n");
    write(root, "src/staged.js", "staged\n");
    git(root, ["add", "src/staged.js"]);
    const before = head(root);
    const r = upgrade(root);
    expectRefused(root, before, r, "commit_failed");
    expect(staged(root)).toEqual(["src/staged.js"]);
    expect(porcelain(root)).toContain(" M src/app.js");
    expect(fs.readFileSync(path.join(root, ".routekit/hooks/read/a.mjs"), "utf8")).toBe("// hook 0.59.7\n");
  });

  it("refuses on a branch the child's branch-policy.yaml blocks, naming branch, file and key", () => {
    const root = makeChild({ branch: "dev" });
    write(root, ".routekit/branch-policy.yaml", "block_direct_commits_to:\n  - dev\n");
    const before = head(root);
    const r = upgrade(root);
    expectRefused(root, before, r, "policy_blocked_branch");
    expect(
      r.warnings.some(
        (w) => w.includes("dev") && w.includes(".routekit/branch-policy.yaml") && w.includes("block_direct_commits_to"),
      ),
    ).toBe(true);
  });

  it("exempt_branches never grants commit permission", () => {
    const root = makeChild({ branch: "dev" });
    write(root, ".routekit/branch-policy.yaml", "block_direct_commits_to:\n  - dev\nexempt_branches:\n  - dev\n");
    const before = head(root);
    expectRefused(root, before, upgrade(root), "policy_blocked_branch");
  });

  it("with no branch-policy.yaml the hook default applies: dev is refused, feature/work is committed", () => {
    const dev = makeChild({ branch: "dev" });
    const devBefore = head(dev);
    const r = upgrade(dev);
    expectRefused(dev, devBefore, r, "policy_blocked_branch");
    expect(r.warnings.some((w) => w.includes("dev") && w.includes("branch-policy.yaml"))).toBe(true);
    const feat = makeChild({ branch: "feature/work" });
    const featBefore = head(feat);
    const r2 = upgrade(feat);
    expect(r2.committed).toBe(true);
    expect(head(feat)).not.toBe(featBefore);
  });

  it("refuses on a branch listed only in git-policy.yaml protected_branches", () => {
    const root = makeChild({ branch: "release/1" });
    write(root, ".routekit/git-policy.yaml", "protected_branches:\n  - release/1\n");
    const before = head(root);
    const r = upgrade(root);
    expectRefused(root, before, r, "policy_blocked_branch");
    expect(r.warnings.some((w) => w.includes("release/1") && w.includes(".routekit/git-policy.yaml"))).toBe(true);
  });

  it("fails closed on an unparseable branch-policy.yaml", () => {
    const root = makeChild();
    write(root, ".routekit/branch-policy.yaml", "block_direct_commits_to: [dev, main\n");
    const before = head(root);
    const r = upgrade(root);
    expectRefused(root, before, r, "branch_policy_unreadable");
    expect(r.warnings.some((w) => w.includes(".routekit/branch-policy.yaml"))).toBe(true);
  });

  it("fails closed when a policy key is present but not an array of strings", () => {
    const root = makeChild();
    write(root, ".routekit/branch-policy.yaml", "block_direct_commits_to: dev\n");
    const before = head(root);
    expectRefused(root, before, upgrade(root), "branch_policy_unreadable");
  });
});
