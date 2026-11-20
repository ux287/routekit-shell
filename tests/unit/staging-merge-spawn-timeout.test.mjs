// backlog.fix.ship-merge-gh-git-spawns-unbounded — runStagingMerge bounds its gh/git spawns and a gh pr merge
// timeout is a named failure that skips the local post-merge steps. spawnSync is mocked; no real subprocess.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSpawnSync, mockGhPrView } = vi.hoisted(() => ({ mockSpawnSync: vi.fn(), mockGhPrView: vi.fn() }));
vi.mock("child_process", () => ({ spawnSync: mockSpawnSync }));
vi.mock("../../packages/mcp-rks/src/server/gh-tools.mjs", () => ({ ghPrView: mockGhPrView }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({ loadContext: vi.fn(() => ({})), getBranchConfig: vi.fn(() => ({})) }));
vi.mock("../../packages/mcp-rks/src/dendron.mjs", () => ({ updateField: vi.fn(), resolveNotesDir: vi.fn(() => "/mock/notes") }));
vi.mock("../../packages/mcp-rks/src/server/git/git-utils.mjs", () => ({
  runGit: vi.fn(() => "abc1234"),
  getCurrentBranch: vi.fn(() => "feat/test-branch"),
  VALID_UNLINKED_REASONS: ["hotfix", "dependency-update", "chore"],
}));

const { runStagingMerge } = await import("../../packages/mcp-rks/src/server/git/git-release.mjs");

const PARAMS = { projectRoot: "/mock/project", prNumber: 42, reason: "chore", projectId: "p" };
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", signal: null, error: null });
const timedOut = () => ({
  status: null, stdout: "", stderr: "", signal: "SIGTERM",
  error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }),
});
const isMerge = (cmd, args) => cmd === "gh" && args[1] === "merge";
const gitCalls = (sub) => mockSpawnSync.mock.calls.filter(([cmd, args]) => cmd === "git" && args[0] === sub);

beforeEach(() => {
  mockSpawnSync.mockReset();
  mockGhPrView.mockReset();
  mockGhPrView.mockReturnValue({ ok: true, pr: { checks: [], allChecksPassed: true } });
});

describe("runStagingMerge spawn timeouts", () => {
  it("every gh/git spawnSync on the success path carries a positive numeric timeout", async () => {
    mockSpawnSync.mockImplementation(() => ok(JSON.stringify({ number: 42, commits: [] })));
    const r = await runStagingMerge({ ...PARAMS, prNumber: null });
    expect(r.ok).toBe(true);
    const seen = mockSpawnSync.mock.calls.map(([cmd, args]) => `${cmd} ${args.slice(0, 2).join(" ")}`);
    expect(seen).toEqual(expect.arrayContaining(["gh pr view", "gh pr merge", "git checkout staging", "git pull", "git branch -d"]));
    for (const [, , opts] of mockSpawnSync.mock.calls) {
      expect(typeof opts?.timeout).toBe("number");
      expect(opts.timeout).toBeGreaterThan(0);
    }
  });

  it("a timed-out gh pr merge returns ok:false naming the merge step and runs no local post-merge git", async () => {
    mockSpawnSync.mockImplementation((cmd, args) => (isMerge(cmd, args) ? timedOut() : ok(JSON.stringify({ commits: [] }))));
    const r = await runStagingMerge(PARAMS);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/gh_pr_merge/);
    expect(JSON.stringify(r)).toMatch(/tim(ed )?out/i);
    expect(gitCalls("checkout")).toHaveLength(0);
    expect(gitCalls("pull")).toHaveLength(0);
    expect(gitCalls("branch")).toHaveLength(0);
  });

  it("a timed-out gh pr view number lookup returns ok:false naming gh_pr_view, not No PR found", async () => {
    mockSpawnSync.mockImplementation((cmd, args) => (cmd === "gh" && args[1] === "view" && args.includes("number") ? timedOut() : ok(JSON.stringify({ commits: [] }))));
    const r = await runStagingMerge({ ...PARAMS, prNumber: null });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(/gh_pr_view/);
    expect(JSON.stringify(r)).toMatch(/tim(ed )?out/i);
    expect(JSON.stringify(r)).not.toMatch(/No PR found/);
  });

  it("a timed-out git pull after a successful merge keeps ok:true/merged:true, records the step and logs once", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSpawnSync.mockImplementation((cmd, args) => (cmd === "git" && args[0] === "pull" ? timedOut() : ok(JSON.stringify({ commits: [] }))));
    const r = await runStagingMerge(PARAMS);
    expect(r.ok).toBe(true);
    expect(r.merged).toBe(true);
    expect(JSON.stringify(r)).toMatch(/git_pull/);
    expect(JSON.stringify(r)).toMatch(/tim(ed )?out/i);
    expect(errSpy.mock.calls.filter((c) => /git_pull/.test(c.join(" ")))).toHaveLength(1);
    // QA resolution: post-merge local steps are independent best-effort steps; a timed-out pull does not skip branch -d.
    expect(gitCalls("branch")).toHaveLength(1);
    errSpy.mockRestore();
  });

  it("fast successful gh/git calls still merge and run checkout, pull and branch -d", async () => {
    mockSpawnSync.mockImplementation(() => ok(JSON.stringify({ commits: [] })));
    const r = await runStagingMerge(PARAMS);
    expect(r.ok).toBe(true);
    expect(r.postMergeTimeouts).toBeUndefined();
    expect(gitCalls("checkout")).toHaveLength(1);
    expect(gitCalls("pull")).toHaveLength(1);
    expect(gitCalls("branch")).toHaveLength(1);
  });
});
