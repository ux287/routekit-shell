/**
 * backlog.fix.ship-agent-create-pr-arms-auto-merge
 *
 * Drives the ship agent's create_pr through the REAL runGitPR with a stubbed gh.
 * Every gh call is recorded and answered here; the real gh binary is never run.
 * git runs for real against a temp bare origin under os.tmpdir() - no network remote.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const state = vi.hoisted(() => ({ ghCalls: [], prArgs: [], ghMergeStatus: 0 }));

// ship.mjs and git-workflow.mjs both import spawnSync from the bare "child_process" specifier.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => {
      if (cmd === "gh") {
        state.ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view") return { status: 1, stdout: "", stderr: "no pull requests found" };
        if (args[0] === "pr" && args[1] === "create") return { status: 0, stdout: "https://github.com/t/t/pull/7\n", stderr: "" };
        if (args[0] === "pr" && args[1] === "merge") {
          return { status: state.ghMergeStatus, stdout: "", stderr: state.ghMergeStatus ? "auto-merge is not allowed" : "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
      }
      return actual.spawnSync(cmd, args, { timeout: 15_000, ...opts });
    },
  };
});

// Record runGitPR's argument, then delegate to the real implementation.
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runGitPR: vi.fn(async (opts) => {
      state.prArgs.push(opts);
      return actual.runGitPR(opts);
    }),
  };
});

const { spawnSync: realSpawn } = await vi.importActual("child_process");
const shipModule = await import("../../packages/mcp-rks/src/agents/ship.mjs");
// The real runGitPR (not the recording wrapper above), for the direct AC3/AC4 cases.
const { runGitPR: realRunGitPR } = await vi.importActual("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
// @routekit/telemetry is globally mocked in tests/setup.mjs; ensureTelemetryStorage returns one shared mock storage.
const { ensureTelemetryStorage } = await import("@routekit/telemetry");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORY = "backlog.t.s";

function git(cwd, ...args) {
  const r = realSpawn("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepoWithOrigin() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-create-pr-"));
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
const prCreatedPayloads = () =>
  ensureTelemetryStorage().emit.mock.calls.filter((c) => c[0] === "pr.created").map((c) => c[2]);

let repo;
beforeEach(() => {
  state.ghCalls.length = 0;
  state.prArgs.length = 0;
  state.ghMergeStatus = 0;
  ensureTelemetryStorage().emit.mockClear();
  repo = makeRepoWithOrigin();
});
afterEach(() => {
  fs.rmSync(repo.base, { recursive: true, force: true });
});

describe("ship agent create_pr does not arm GitHub auto-merge", { timeout: 30_000 }, () => {
  it("creates the PR through the real runGitPR and never invokes gh pr merge", async () => {
    const cfg = shipModule.createShipAgent({ projectId: "t", projectRoot: repo.work, storyId: STORY });
    const res = await tool(cfg, "create_pr").execute({ body: "summary" });
    // Positive witness: runGitPR reached gh pr create, so the merge assertion cannot pass vacuously.
    expect(res.created).toBe(true);
    expect(state.ghCalls.some(isPr("create"))).toBe(true);
    expect(state.ghCalls.filter(isPr("merge"))).toEqual([]);
  });

  it("passes autoMerge false and problemId storyId to runGitPR, with targetBranch unchanged", async () => {
    const cfg = shipModule.createShipAgent({ projectId: "t", projectRoot: repo.work, storyId: STORY });
    await tool(cfg, "create_pr").execute({ body: "summary" });
    expect(state.prArgs).toHaveLength(1);
    const arg = state.prArgs[0];
    expect(arg.autoMerge).toBe(false);
    expect(arg.problemId).toBe(STORY);
    expect(arg.reason).toBeUndefined();
    expect(arg.projectRoot).toBe(repo.work);
    const create = state.ghCalls.find(isPr("create"));
    expect(create[create.indexOf("--base") + 1]).toBe("staging");
  });
});

describe("runGitPR autoMerge default (AC3 option B)", { timeout: 30_000 }, () => {
  it("with no autoMerge key, never invokes gh pr merge and does not report autoMerge true", async () => {
    const res = await realRunGitPR({ projectRoot: repo.work, targetBranch: "staging", problemId: STORY, projectId: "t" });
    expect(res.ok).toBe(true);
    expect(state.ghCalls.some(isPr("create"))).toBe(true);
    expect(state.ghCalls.filter(isPr("merge"))).toEqual([]);
    expect(res.autoMerge).not.toBe(true);
    expect(res.autoMerge).toBe(false);
    expect(res.autoMergeError).toBeUndefined();
  });
});

describe("runGitPR reports the observed auto-merge state (AC4 option A)", { timeout: 30_000 }, () => {
  it("gh pr merge failing: result and pr.created telemetry report autoMerge false plus autoMergeError", async () => {
    state.ghMergeStatus = 1;
    const res = await realRunGitPR({ projectRoot: repo.work, targetBranch: "staging", problemId: STORY, projectId: "t", autoMerge: true });
    expect(res.ok).toBe(true);
    expect(state.ghCalls.filter(isPr("merge"))).toHaveLength(1);
    expect(res.autoMerge).toBe(false);
    expect(res.autoMergeError).toContain("auto-merge is not allowed");
    const payloads = prCreatedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].autoMerge).toBe(false);
    expect(payloads[0].autoMergeError).toContain("auto-merge is not allowed");
  });

  it("gh pr merge succeeding: result and pr.created telemetry report autoMerge true", async () => {
    state.ghMergeStatus = 0;
    const res = await realRunGitPR({ projectRoot: repo.work, targetBranch: "staging", problemId: STORY, projectId: "t", autoMerge: true });
    expect(res.ok).toBe(true);
    expect(state.ghCalls.filter(isPr("merge"))).toHaveLength(1);
    expect(res.autoMerge).toBe(true);
    expect(res.autoMergeError).toBeUndefined();
    const payloads = prCreatedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].autoMerge).toBe(true);
    expect(payloads[0].autoMergeError).toBeUndefined();
  });
});
