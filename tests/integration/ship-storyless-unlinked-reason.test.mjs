/**
 * backlog.fix.ship-agent-storyless-unlinked-reason
 *
 * Storyless ship-agent create_pr and merge_pr must send a VALID unlinked reason
 * ('infrastructure') so runGitPR / runStagingMerge do not refuse them.
 * gh is stubbed and recorded here; the real gh binary is never run.
 * git runs for real against a temp bare origin under os.tmpdir() - no network remote.
 * Assumes backlog.fix.ship-agent-create-pr-arms-auto-merge has landed (autoMerge: false).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const state = vi.hoisted(() => ({ ghCalls: [], prArgs: [], mergeArgs: [], pr: null }));

// ship.mjs, gh-tools.mjs, git-workflow.mjs and git-release.mjs all import spawnSync from "child_process".
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => {
      if (cmd === "gh") {
        state.ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "create") return { status: 0, stdout: "https://github.com/t/t/pull/7\n", stderr: "" };
        if (args[0] === "pr" && args[1] === "merge") {
          if (state.pr) state.pr = { ...state.pr, state: "MERGED" };
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "view") {
          // create_pr cases: no existing PR. merge_pr cases: PR state as configured.
          if (state.pr === null) return { status: 1, stdout: "", stderr: "no pull requests found" };
          return { status: 0, stdout: JSON.stringify(state.pr), stderr: "" };
        }
        // Aligned with ship-create-pr-no-auto-merge.test.mjs: any other gh call is unexpected.
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      }
      return actual.spawnSync(cmd, args, { timeout: 15_000, ...opts });
    },
  };
});

// Record the arguments ship.mjs passes, then delegate to the real implementations.
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runGitPR: vi.fn(async (opts) => {
      state.prArgs.push(opts);
      return actual.runGitPR(opts);
    }),
    runStagingMerge: vi.fn(async (opts) => {
      state.mergeArgs.push(opts);
      return actual.runStagingMerge(opts);
    }),
  };
});

const { spawnSync: realSpawn } = await vi.importActual("child_process");
const shipModule = await import("../../packages/mcp-rks/src/agents/ship.mjs");
const { VALID_UNLINKED_REASONS } = await import("../../packages/mcp-rks/src/server/git/git-utils.mjs");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHIP_SRC = path.join(REPO_ROOT, "packages/mcp-rks/src/agents/ship.mjs");
const STORY = "backlog.t.s";
const GREEN = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];

function git(cwd, ...args) {
  const r = realSpawn("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepoWithOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-storyless-"));
  expect(fs.realpathSync(base).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  git(base, "init", "-q", "--bare", origin);
  git(base, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "staging");
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "staging");
  git(work, "checkout", "-q", "-b", "feature/x");
  fs.writeFileSync(path.join(work, "b.txt"), "b\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "feature");
  return { base, origin, work };
}

const tool = (cfg, name) => cfg.tools.find((t) => t.name === name);
const isPr = (sub) => (a) => a[0] === "pr" && a[1] === sub;
// Storyless: no storyId key at all.
const storyless = () => shipModule.createShipAgent({ projectId: "t", projectRoot: repo.work });
const linked = () => shipModule.createShipAgent({ projectId: "t", projectRoot: repo.work, storyId: STORY });

let repo;
beforeEach(() => {
  state.ghCalls.length = 0;
  state.prArgs.length = 0;
  state.mergeArgs.length = 0;
  state.pr = null;
  repo = makeRepoWithOrigin();
});
afterEach(() => {
  fs.rmSync(repo.base, { recursive: true, force: true });
});

describe("storyless ship agent sends a valid unlinked reason", { timeout: 30_000 }, () => {
  it("create_pr without storyId reaches gh pr create with reason infrastructure", async () => {
    const res = await tool(storyless(), "create_pr").execute({ body: "summary" });
    // Fails before the fix: { error: "Invalid reason 'infra-improvement'..." } and no gh pr create.
    expect(JSON.stringify(res)).not.toMatch(/Invalid reason/);
    expect(res.created).toBe(true);
    expect(state.ghCalls.some(isPr("create"))).toBe(true);
    expect(state.prArgs).toHaveLength(1);
    expect(state.prArgs[0].reason).toBe("infrastructure");
    expect(state.prArgs[0].problemId).toBeUndefined();
    // Dependency guard: storyless create_pr must not arm auto-merge (backlog.fix.ship-agent-create-pr-arms-auto-merge).
    expect(state.prArgs[0].autoMerge).toBe(false);
    expect(state.ghCalls.filter(isPr("merge"))).toEqual([]);
  });

  it("merge_pr without storyId passes the guards and merges once with reason infrastructure", async () => {
    state.pr = { number: 7, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: GREEN };
    const res = await tool(storyless(), "merge_pr").execute({ prNumber: 7 });
    // Fails before the fix: { error: "Invalid reason 'infra-improvement'..." } and zero gh pr merge calls.
    expect(JSON.stringify(res)).not.toMatch(/Invalid reason/);
    expect(res.merged).toBe(true);
    expect(state.ghCalls.filter(isPr("merge"))).toHaveLength(1);
    expect(state.mergeArgs).toHaveLength(1);
    expect(state.mergeArgs[0].reason).toBe("infrastructure");
    expect(state.mergeArgs[0].problemId).toBeUndefined();
  });

  it("create_pr with storyId still passes problemId storyId and reason undefined", async () => {
    const res = await tool(linked(), "create_pr").execute({ body: "summary" });
    expect(res.created).toBe(true);
    expect(state.prArgs).toHaveLength(1);
    expect(state.prArgs[0].problemId).toBe(STORY);
    expect(state.prArgs[0].reason).toBeUndefined();
  });

  it("merge_pr with storyId still passes problemId storyId and reason undefined", async () => {
    state.pr = { number: 7, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: GREEN };
    const res = await tool(linked(), "merge_pr").execute({ prNumber: 7 });
    expect(res.merged).toBe(true);
    expect(state.mergeArgs).toHaveLength(1);
    expect(state.mergeArgs[0].problemId).toBe(STORY);
    expect(state.mergeArgs[0].reason).toBeUndefined();
  });
});

describe("vocabulary is fixed, not widened", () => {
  it("ship.mjs no longer contains the invalid literal infra-improvement", () => {
    expect(fs.readFileSync(SHIP_SRC, "utf8")).not.toContain("infra-improvement");
  });

  it("VALID_UNLINKED_REASONS is unchanged and contains infrastructure", () => {
    expect(VALID_UNLINKED_REASONS).toEqual(["hotfix", "docs-only", "infrastructure", "off-rail"]);
  });
});
