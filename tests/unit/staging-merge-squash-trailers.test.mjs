// backlog.feat.exec-plan-commit-linkage — AC5: runStagingMerge squash body carries provenance trailers.
// child_process spawnSync is mocked and routed by argv (gh-tools.mjs ghPrView imports spawnSync from
// the same module, so it is mocked separately here). No real subprocess is started by this file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSpawnSync, mockGhPrView } = vi.hoisted(() => ({ mockSpawnSync: vi.fn(), mockGhPrView: vi.fn() }));

vi.mock("child_process", () => ({ spawnSync: mockSpawnSync }));
vi.mock("../../packages/mcp-rks/src/server/gh-tools.mjs", () => ({ ghPrView: mockGhPrView }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  loadContext: vi.fn(() => ({})),
  getBranchConfig: vi.fn(() => ({})),
}));
vi.mock("../../packages/mcp-rks/src/dendron.mjs", () => ({
  updateField: vi.fn(),
  resolveNotesDir: vi.fn(() => "/mock/notes"),
}));
vi.mock("../../packages/mcp-rks/src/server/git/git-utils.mjs", () => ({
  runGit: vi.fn(() => "abc1234"),
  getCurrentBranch: vi.fn(() => "feat/test-branch"),
  VALID_UNLINKED_REASONS: ["hotfix", "dependency-update", "chore"],
}));

const { runStagingMerge } = await import("../../packages/mcp-rks/src/server/git/git-release.mjs");

const PR = 42;
const PARAMS = { projectRoot: "/mock/project", prNumber: PR, reason: "chore", projectId: "p" };
const reply = (status = 0, stdout = "", stderr = "", extra = {}) => ({ status, stdout, stderr, signal: null, error: null, ...extra });
const isCommitsRead = (cmd, args) => cmd === "gh" && args[0] === "pr" && args[1] === "view" && args.includes("commits");
const mergeCalls = () => mockSpawnSync.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[1] === "merge");
const commitsCalls = () => mockSpawnSync.mock.calls.filter(([cmd, args]) => isCommitsRead(cmd, args));

function route(commitsReply) {
  mockSpawnSync.mockImplementation((cmd, args) => {
    if (isCommitsRead(cmd, args)) return typeof commitsReply === "function" ? commitsReply() : commitsReply;
    if (cmd === "gh" && args[1] === "merge") return reply(0, "");
    return reply(0, "");
  });
}

const commitsJson = (...messages) =>
  JSON.stringify({
    commits: messages.map(([headline, body]) => ({ oid: "x", messageHeadline: headline, messageBody: body })),
  });

let errSpy;
beforeEach(() => {
  mockSpawnSync.mockReset();
  mockGhPrView.mockReset();
  mockGhPrView.mockReturnValue({ ok: true, pr: { checks: [], allChecksPassed: true } });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("runStagingMerge --squash", () => {
  it("reads commits with one spawnSync whose argv is [pr, view, <n>, --json, commits] and whose options carry a numeric timeout", async () => {
    route(reply(0, commitsJson(["feat(exec): a", "Story: s"])));
    await runStagingMerge(PARAMS);
    expect(commitsCalls()).toHaveLength(1);
    const [cmd, argv, opts] = commitsCalls()[0];
    expect(cmd).toBe("gh");
    expect(argv).toEqual(["pr", "view", String(PR), "--json", "commits"]);
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
    // The checks read is still the single ghPrView call, not a second commits read.
    expect(mockGhPrView).toHaveBeenCalledTimes(1);
  });

  it("passes --body whose final paragraph holds every distinct Story/Plan-Hash/Run-Id trailer from the PR commits", async () => {
    route(reply(0, commitsJson(
      ["feat(exec): a", "Story: s\nPlan-Hash: p1\nRun-Id: r1\nCo-Authored-By: A <a@b>"],
      ["feat(exec): b", "Story: s\nPlan-Hash: p2\nRun-Id: r2"],
      ["chore: notes", ""],
    )));
    const res = await runStagingMerge(PARAMS);
    expect(res.ok).toBe(true);
    expect(mergeCalls()).toHaveLength(1);
    const argv = mergeCalls()[0][1];
    expect(argv.slice(0, 5)).toEqual(["pr", "merge", String(PR), "--squash", "--delete-branch"]);
    const bodyAt = argv.indexOf("--body");
    expect(bodyAt).toBeGreaterThan(-1);
    const body = argv[bodyAt + 1];
    const finalParagraph = body.split("\n\n").pop().split("\n");
    const expected = ["Story: s", "Plan-Hash: p1", "Run-Id: r1", "Plan-Hash: p2", "Run-Id: r2"];
    expect(finalParagraph.sort()).toEqual([...expected].sort());
    expect(body).not.toContain("Co-Authored-By");
    expect(res.squashTrailers.status).toBe("applied");
    expect([...res.squashTrailers.lines].sort()).toEqual([...expected].sort());
    expect(res.squashTrailers.error).toBeNull();
  });

  it("with no provenance trailers on the PR commits, the gh pr merge argv is exactly [pr, merge, <n>, --squash, --delete-branch] and squashTrailers.status is none_found", async () => {
    route(reply(0, commitsJson(["chore: x", ""], ["fix: y", "Co-Authored-By: A <a@b>"])));
    const res = await runStagingMerge(PARAMS);
    expect(res.ok).toBe(true);
    expect(mergeCalls()).toHaveLength(1);
    expect(mergeCalls()[0][1]).toEqual(["pr", "merge", String(PR), "--squash", "--delete-branch"]);
    expect(res.squashTrailers).toEqual({ status: "none_found", lines: [], error: null });
    expect(errSpy.mock.calls.filter((c) => /could not read commits/.test(String(c[0])))).toHaveLength(0);
  });

  it.each([
    ["non-zero status", reply(1, "", "HTTP 502")],
    ["spawn error", reply(null, "", "", { error: new Error("spawn gh ENOENT") })],
    ["timeout signal", reply(null, "", "", { signal: "SIGTERM", error: Object.assign(new Error("spawnSync gh ETIMEDOUT"), { code: "ETIMEDOUT" }) })],
    ["signal only", reply(null, "", "", { signal: "SIGTERM" })],
    ["unparseable stdout", reply(0, "not json {")],
    ["no commits array", reply(0, JSON.stringify({ number: PR }))],
  ])("read failure (%s): argv unchanged, squashTrailers.status read_failed with an error, never none_found, one console.error naming the PR", async (_label, commitsReply) => {
    route(commitsReply);
    const res = await runStagingMerge(PARAMS);
    expect(res.ok).toBe(true);
    expect(res.merged).toBe(true);
    expect(mergeCalls()).toHaveLength(1);
    expect(mergeCalls()[0][1]).toEqual(["pr", "merge", String(PR), "--squash", "--delete-branch"]);
    expect(res.squashTrailers.status).toBe("read_failed");
    expect(res.squashTrailers.status).not.toBe("none_found");
    expect(typeof res.squashTrailers.error).toBe("string");
    expect(res.squashTrailers.error.length).toBeGreaterThan(0);
    const lines = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("rks_staging_merge") && l.includes(`#${PR}`) && l.includes("commits"));
    expect(lines).toHaveLength(1);
  });

  it("CI gate still blocks before any commits read or merge", async () => {
    route(reply(0, commitsJson(["feat: a", "Story: s"])));
    mockGhPrView.mockReturnValue({ ok: true, pr: { checks: [{ name: "ci", completed: true, passed: false }], allChecksPassed: false } });
    const res = await runStagingMerge(PARAMS);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("CI checks failed");
    expect(commitsCalls()).toHaveLength(0);
    expect(mergeCalls()).toHaveLength(0);
  });
});
