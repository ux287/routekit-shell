/**
 * backlog.feat.escalation-safe-side-effecting-agents - guard 2 for recovery fix_git.
 * Mock tier: real git in an os.tmpdir() repo; the delegated Git Agent run is a spy.
 * Run: npx vitest run --config vitest.config.mock.mjs tests/integration/recovery-fix-git-uncommitted-guard.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const delegated = [];
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: async (cfg) => { delegated.push(cfg?.name); return { ok: true, summary: "delegated", data: {} }; } };
});

const { createRecoveryAgent } = await import("../../packages/mcp-rks/src/agents/recovery.mjs");
import { fileURLToPath } from "node:url";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let root;
beforeEach(() => {
  delegated.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-recovery-guard-"));
  expect(fs.realpathSync(root).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  git(root, "init", "-q", "-b", "staging");
  fs.writeFileSync(path.join(root, "keep.txt"), "committed\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const fixGit = () => createRecoveryAgent({ projectId: "t", projectRoot: root, autoFix: true }).tools.find((t) => t.name === "fix_git");

describe("fix_git clean/reset path refuses on unnamed uncommitted work", () => {
  it("modified tracked file, request does not name it -> structured refusal, file intact, no delegation", async () => {
    fs.writeFileSync(path.join(root, "keep.txt"), "precious edit\n");
    const res = await fixGit().execute({ request: "clean dirty state" });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toMatch(/uncommitted/i);
    expect(JSON.stringify(res)).toContain("keep.txt");
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("precious edit\n");
    expect(delegated).toHaveLength(0);
  });

  it("untracked file, request does not name it -> refusal, file still present", async () => {
    fs.writeFileSync(path.join(root, "new.txt"), "untracked\n");
    const res = await fixGit().execute({ request: "reset to HEAD and clean" });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(true);
    expect(delegated).toHaveLength(0);
  });

  it("request explicitly names the uncommitted file -> proceeds to the Git Agent", async () => {
    fs.writeFileSync(path.join(root, "keep.txt"), "discard me\n");
    await fixGit().execute({ request: "discard uncommitted changes to keep.txt" });
    expect(delegated).toEqual(["git"]);
  });

  it("clean tree -> no refusal, delegation proceeds", async () => {
    await fixGit().execute({ request: "clean dirty state" });
    expect(delegated).toEqual(["git"]);
  });

  it("non-destructive request (abort a merge) on a dirty tree is not refused by this guard", async () => {
    fs.writeFileSync(path.join(root, "keep.txt"), "edit\n");
    await fixGit().execute({ request: "abort the in-progress merge" });
    expect(delegated).toEqual(["git"]);
  });
});
