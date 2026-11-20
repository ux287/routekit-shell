// tests/unit/gitleaks-pre-commit-hook.test.mjs
// backlog.security.gitleaks-gate-arming — the POSIX hook, run in a temp repo with stub gitleaks binaries.
// PATH is controlled so a real gitleaks on the developer machine is never found (asserted as a precondition).
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPreCommitShim } from "../../scripts/install-git-hooks.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(REPO, ".routekit", "git-hooks", "pre-commit");
const T = 15_000;
const TEST_TIMEOUT = 30_000;
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8", timeout: T }).trim();
const dirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

// A bin dir holding only a git symlink, so PATH = bin:/usr/bin:/bin finds git but no gitleaks.
function cleanBin() { const b = tmp("rks-hook-bin-"); fs.symlinkSync(GIT, path.join(b, "git")); return b; }
function stub(dir, code, sentinel) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "gitleaks");
  fs.writeFileSync(f, `#!/bin/sh\necho "$@" > "${sentinel}"\nexit ${code}\n`, { mode: 0o755 });
  return f;
}
function runHook(cwd, env) {
  return spawnSync("sh", [HOOK], { cwd, env, encoding: "utf-8", timeout: T });
}
function cleanPath() {
  const PATH = `${cleanBin()}:/usr/bin:/bin`;
  const pre = spawnSync("sh", ["-c", "command -v gitleaks"], { env: { PATH }, encoding: "utf-8", timeout: T });
  expect(pre.status).not.toBe(0); // precondition: no gitleaks on this PATH
  return PATH;
}
function newRepo() {
  const repo = tmp("rks-hook-repo-");
  execFileSync(GIT, ["init", "-q"], { cwd: repo, timeout: T });
  return repo;
}
const rksToolsDir = (repo) => path.join(repo, ".git", "rks-tools", "gitleaks");

describe.skipIf(process.platform === "win32")("gitleaks pre-commit hook", () => {
  it("override exits 0 with a warning and never invokes gitleaks", () => {
    const PATH = cleanPath();
    const repo = newRepo();
    const sentinel = path.join(tmp("rks-hook-sent-"), "called");
    stub(rksToolsDir(repo), 0, sentinel);
    const r = runHook(repo, { PATH, HOME: repo, RKS_ALLOW_UNSCANNED_COMMIT: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING/);
    expect(r.stderr).toContain("RKS_ALLOW_UNSCANNED_COMMIT=1");
    expect(fs.existsSync(sentinel)).toBe(false);
    // ... and also with no gitleaks anywhere.
    const bare = newRepo();
    const r2 = runHook(bare, { PATH, HOME: bare, RKS_ALLOW_UNSCANNED_COMMIT: "1" });
    expect(r2.status).toBe(0);
  }, TEST_TIMEOUT);

  it("prefers the rks-tools copy over PATH", () => {
    const repo = newRepo();
    const sentDir = tmp("rks-hook-sent-");
    stub(rksToolsDir(repo), 0, path.join(sentDir, "rks"));
    const pathBin = tmp("rks-hook-pathbin-");
    stub(pathBin, 0, path.join(sentDir, "path"));
    const r = runHook(repo, { PATH: `${pathBin}:${cleanBin()}:/usr/bin:/bin`, HOME: repo });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(sentDir, "rks"))).toBe(true);
    expect(fs.existsSync(path.join(sentDir, "path"))).toBe(false);
  }, TEST_TIMEOUT);

  it("falls back to PATH when no rks-tools copy exists", () => {
    const repo = newRepo();
    const sentinel = path.join(tmp("rks-hook-sent-"), "path");
    const pathBin = tmp("rks-hook-pathbin-");
    stub(pathBin, 0, sentinel);
    const r = runHook(repo, { PATH: `${pathBin}:${cleanBin()}:/usr/bin:/bin`, HOME: repo });
    expect(r.status).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(true);
  }, TEST_TIMEOUT);

  it("refuses with exit non-zero and names the override when no gitleaks is found", () => {
    const bin = cleanBin();
    const PATH = `${bin}:/usr/bin:/bin`;
    const pre = spawnSync("sh", ["-c", "command -v gitleaks"], { env: { PATH }, encoding: "utf-8", timeout: T });
    expect(pre.status).not.toBe(0); // precondition: no gitleaks on this PATH
    const repo = tmp("rks-hook-repo-");
    execFileSync(GIT, ["init", "-q"], { cwd: repo, timeout: T });
    const r = runHook(repo, { PATH, HOME: repo });
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("RKS_ALLOW_UNSCANNED_COMMIT=1");
    expect(out).toContain("npm install");
    expect(out).toContain("routekit project upgrade");
  }, TEST_TIMEOUT);

  it("propagates the scanner exit code and calls protect --staged", () => {
    const PATH = cleanPath();
    for (const [code, expectZero] of [[1, false], [0, true]]) {
      const repo = newRepo();
      const sentinel = path.join(tmp("rks-hook-sent-"), "args");
      stub(rksToolsDir(repo), code, sentinel);
      const r = runHook(repo, { PATH, HOME: repo });
      if (expectZero) expect(r.status).toBe(0);
      else expect(r.status).not.toBe(0);
      const args = fs.readFileSync(sentinel, "utf-8").trim().split(/\s+/);
      expect(args).toContain("protect");
      expect(args).toContain("--staged");
    }
  }, TEST_TIMEOUT);

  it("no longer advertises git commit --no-verify", () => {
    expect(fs.readFileSync(HOOK, "utf-8")).not.toContain("git commit --no-verify");
  });

  it("an armed repo refuses a commit without gitleaks and accepts it with the override", () => {
    const PATH = cleanPath();
    const repo = newRepo();
    const g = (args, env = {}) =>
      spawnSync(GIT, args, {
        cwd: repo,
        encoding: "utf-8",
        timeout: T,
        env: {
          PATH, HOME: repo,
          GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
          ...env,
        },
      });
    fs.mkdirSync(path.join(repo, ".routekit", "git-hooks"), { recursive: true });
    fs.copyFileSync(HOOK, path.join(repo, ".routekit", "git-hooks", "pre-commit"));
    expect(installPreCommitShim(repo).armed).toBe(true);
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    expect(g(["add", "-A"]).status).toBe(0);
    const head = () => g(["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim();
    const before = head();
    const refused = g(["commit", "-q", "-m", "first"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("RKS_ALLOW_UNSCANNED_COMMIT=1");
    expect(head()).toBe(before);
    const allowed = g(["commit", "-q", "-m", "first"], { RKS_ALLOW_UNSCANNED_COMMIT: "1" });
    expect(allowed.status).toBe(0);
    expect(head()).not.toBe(before);
  }, TEST_TIMEOUT);
});
