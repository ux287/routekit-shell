/**
 * Story: backlog.fix.preflight-false-green-on-unvalidated-preconditions
 *
 * Asserts checkGitReadiness() (the extracted, exported helper the rks_preflight
 * handler now calls) validates VALIDITY, not mere presence: a placeholder or
 * unreachable origin, a missing working branch, or a missing baseline commit
 * each yield a NOT-ready check with an actionable hint; green only when all hold.
 *
 * Reachability is exercised offline via local bare-repo paths — never the
 * network. Every subprocess spawn passes an explicit timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { checkGitReadiness, isPlaceholderRemote, isNoPushRemote } from "../../packages/mcp-rks/src/server/preflight.mjs";

const TIMEOUT = 20_000;
const tmps = [];

function mkTmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmps.push(d);
  return d;
}
function g(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
}
function initRepo(root, { branch = "dev", commit = true } = {}) {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  if (commit) {
    fs.writeFileSync(path.join(root, "f.txt"), "x\n");
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", branch], { cwd: root, stdio: "ignore" });
  }
}
function find(checks, name) {
  return checks.find((c) => c.name === name);
}

afterEach(() => {
  for (const d of tmps.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("isPlaceholderRemote", () => {
  it("detects YOUR-ORG/YOUR-REPO placeholders (ssh + https), passes real URLs", () => {
    expect(isPlaceholderRemote("git@github.com:YOUR-ORG/YOUR-REPO.git")).toBe(true);
    expect(isPlaceholderRemote("https://github.com/YOUR-ORG/my-repo.git")).toBe(true);
    expect(isPlaceholderRemote("https://github.com/acme/calculator.git")).toBe(false);
    expect(isPlaceholderRemote("")).toBe(false);
    expect(isPlaceholderRemote(null)).toBe(false);
  });
});

describe("isNoPushRemote", () => {
  it("detects the `no_push` push-disabled sentinel (case/space-insensitive), passes real URLs", () => {
    expect(isNoPushRemote("no_push")).toBe(true);
    expect(isNoPushRemote("  NO_PUSH  ")).toBe(true);
    expect(isNoPushRemote("https://github.com/acme/calculator.git")).toBe(false);
    expect(isNoPushRemote("")).toBe(false);
    expect(isNoPushRemote(null)).toBe(false);
  });
});

describe("checkGitReadiness", () => {
  // backlog.fix.preflight-github-remote-push-url-semantics — a public-mirror clone fetches from a
  // real upstream but has its PUSH url set to `no_push`. Reading the fetch url would falsely read
  // green; github_remote must read the push url and report the push-disabled clone as not-ready.
  it("push-disabled clone (fetch real, push=no_push) → github_remote NOT-ready, detail null", () => {
    const root = mkTmp("pfr-nopush-");
    initRepo(root, { branch: "dev" });
    g(root, ["remote", "add", "origin", "https://github.com/acme/upstream.git"]);
    g(root, ["remote", "set-url", "--push", "origin", "no_push"]);
    const checks = checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } } });
    const r = find(checks, "github_remote");
    expect(r.passed).toBe(false);
    expect(r.detail).toBeNull(); // not the green public-upstream URL
    expect(r.hint).toMatch(/push.*disabled|disabled.*push/i);
  }, TIMEOUT);

  it("reads the PUSH url specifically: explicit placeholder push url → NOT-ready", () => {
    const root = mkTmp("pfr-pushph-");
    initRepo(root, { branch: "dev" });
    // fetch url is real; only the PUSH url is a placeholder — proves --push is read, not fetch.
    g(root, ["remote", "add", "origin", "https://github.com/acme/real.git"]);
    g(root, ["remote", "set-url", "--push", "origin", "git@github.com:YOUR-ORG/YOUR-REPO.git"]);
    const r = find(checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } } }), "github_remote");
    expect(r.passed).toBe(false);
    expect(r.hint).toMatch(/placeholder/i);
  }, TIMEOUT);

  it("placeholder remote → github_remote NOT-ready with actionable hint", () => {
    const root = mkTmp("pfr-ph-");
    initRepo(root, { branch: "dev" });
    g(root, ["remote", "add", "origin", "git@github.com:YOUR-ORG/YOUR-REPO.git"]);
    const checks = checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } } });
    const r = find(checks, "github_remote");
    expect(r.passed).toBe(false);
    expect(r.hint).toMatch(/placeholder/i);
  }, TIMEOUT);

  it("unreachable remote (non-existent local bare path) → NOT-ready, offline", () => {
    const root = mkTmp("pfr-unreach-");
    initRepo(root, { branch: "dev" });
    g(root, ["remote", "add", "origin", path.join(os.tmpdir(), `nope-${Date.now()}.git`)]);
    const checks = checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } }, timeoutMs: 10_000 });
    expect(find(checks, "github_remote").passed).toBe(false);
  }, TIMEOUT);

  it("missing working branch (on main, config wants dev) → working_branch NOT-ready", () => {
    const root = mkTmp("pfr-wb-");
    initRepo(root, { branch: "main" });
    const checks = checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } } });
    const r = find(checks, "working_branch");
    expect(r.passed).toBe(false);
    expect(r.hint).toMatch(/dev/);
  }, TIMEOUT);

  it("missing baseline commit (unborn HEAD) → baseline_commit NOT-ready", () => {
    const root = mkTmp("pfr-nobase-");
    initRepo(root, { commit: false });
    const checks = checkGitReadiness({ projectRoot: root, projectJson: {} });
    expect(find(checks, "baseline_commit").passed).toBe(false);
  }, TIMEOUT);

  it("non-repo dir → git_repo NOT-ready", () => {
    const root = mkTmp("pfr-norepo-");
    const checks = checkGitReadiness({ projectRoot: root, projectJson: {} });
    expect(find(checks, "git_repo").passed).toBe(false);
  }, TIMEOUT);

  it("all green when remote real+reachable (local bare), working branch checked out, baseline exists", () => {
    const bare = path.join(os.tmpdir(), `pfr-bare-${Date.now()}.git`);
    execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
    tmps.push(bare);
    const root = mkTmp("pfr-green-");
    initRepo(root, { branch: "dev" });
    g(root, ["remote", "add", "origin", bare]);
    g(root, ["push", "origin", "dev"]);

    const checks = checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } } });
    expect(find(checks, "baseline_commit").passed).toBe(true);
    expect(find(checks, "working_branch").passed).toBe(true);
    expect(find(checks, "github_remote").passed).toBe(true);
    expect(checks.every((c) => c.passed)).toBe(true);
  }, TIMEOUT);

  it("multiple failures surface as independent findings each with a hint", () => {
    const root = mkTmp("pfr-multi-");
    initRepo(root, { branch: "main" }); // wrong working branch
    g(root, ["remote", "add", "origin", "git@github.com:YOUR-ORG/YOUR-REPO.git"]); // placeholder
    const checks = checkGitReadiness({ projectRoot: root, projectJson: { branches: { working: "dev" } } });
    const failed = checks.filter((c) => !c.passed);
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.every((c) => typeof c.hint === "string" && c.hint.length > 0)).toBe(true);
  }, TIMEOUT);
});
