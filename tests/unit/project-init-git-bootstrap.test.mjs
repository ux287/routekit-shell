/**
 * Story: backlog.fix.project-init-no-git-bootstrap
 *
 * Asserts ensureGitBootstrap() (called at the end of attachProject) leaves a
 * freshly-scaffolded project build-ready: a git repo on the configured working
 * branch with a clean baseline commit and the branch-model branches present —
 * so no manual git surgery is required before rks_plan.
 *
 * Fast unit test: drives ensureGitBootstrap() directly against tmp dirs. Every
 * subprocess spawn passes an explicit timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ensureGitBootstrap } from "../../packages/cli/src/project/bootstrap.mjs";

const TIMEOUT = 15_000;
const tmps = [];

function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
}

afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("ensureGitBootstrap", () => {
  it("3-branch: inits repo, baseline commit (clean tree), dev/staging/main branches, checks out dev", () => {
    const root = mkTmp("gitboot-3b-");
    fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "project.json"), "{}\n");

    const res = ensureGitBootstrap({
      projectRoot: root,
      branches: { working: "dev", integration: "staging", production: "main" },
    });

    expect(res.bootstrapped).toBe(true);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    // current branch is the working branch
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("dev");
    // baseline commit exists with scaffold tracked, tree clean
    expect(Number(git(root, ["rev-list", "--count", "HEAD"]).stdout.trim())).toBeGreaterThanOrEqual(1);
    expect(git(root, ["ls-files"]).stdout).toContain("file.txt");
    expect(git(root, ["status", "--porcelain"]).stdout.trim()).toBe("");
    // all three branch-model branches exist
    for (const b of ["dev", "staging", "main"]) {
      expect(git(root, ["branch", "--list", b]).stdout.trim(), `branch ${b} should exist`).not.toBe("");
    }
  }, TIMEOUT);

  it("2-branch: single main working branch, no dev/staging", () => {
    const root = mkTmp("gitboot-2b-");
    fs.writeFileSync(path.join(root, "file.txt"), "hi\n");

    const res = ensureGitBootstrap({
      projectRoot: root,
      branches: { working: "main", integration: "main", production: "main" },
    });

    expect(res.bootstrapped).toBe(true);
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("main");
    expect(git(root, ["branch", "--list", "dev"]).stdout.trim()).toBe("");
    expect(git(root, ["branch", "--list", "staging"]).stdout.trim()).toBe("");
  }, TIMEOUT);

  it("honors branchModel — working branch is derived, not hardcoded", () => {
    const root = mkTmp("gitboot-honor-");
    fs.writeFileSync(path.join(root, "f"), "x");
    ensureGitBootstrap({
      projectRoot: root,
      branches: { working: "dev", integration: "staging", production: "main" },
    });
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("dev");
  }, TIMEOUT);

  it("idempotent/safe: an existing repo WITH history is not clobbered", () => {
    const root = mkTmp("gitboot-existing-");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    fs.writeFileSync(path.join(root, "orig.txt"), "orig\n");
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "orig"], { cwd: root, stdio: "ignore" });
    const headBefore = git(root, ["rev-parse", "HEAD"]).stdout.trim();

    const res = ensureGitBootstrap({
      projectRoot: root,
      branches: { working: "dev", integration: "staging", production: "main" },
    });

    expect(res.bootstrapped).toBe(false);
    expect(res.reason).toBe("existing-history");
    expect(git(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore);
  }, TIMEOUT);
});
