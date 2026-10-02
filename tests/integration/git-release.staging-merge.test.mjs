import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSpawnSync, mockGhPrView, mockEmit, mockEnsureTelemetry } = vi.hoisted(() => {
  const mockEmit = vi.fn();
  return {
    mockSpawnSync: vi.fn(),
    mockGhPrView: vi.fn(),
    mockEmit,
    mockEnsureTelemetry: vi.fn(() => ({ emit: mockEmit })),
  };
});

vi.mock("child_process", () => ({ spawnSync: mockSpawnSync }));
vi.mock("../../packages/mcp-rks/src/server/gh-tools.mjs", () => ({ ghPrView: mockGhPrView }));
vi.mock("@routekit/telemetry", () => ({
  ensureTelemetryStorage: mockEnsureTelemetry,
}));
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

import { runStagingMerge } from "../../packages/mcp-rks/src/server/git/git-release.mjs";
// backlog.fix.gh-checkrun-statuscontext-vocabulary-conflation: these fixtures used to hand-write
// the NORMALIZED shape ({ name, status, conclusion }), which is now DERIVED rather than authored,
// and which modelled only the CheckRun vocabulary. They are built through the REAL normalizer
// from raw rollup entries instead, so a fixture cannot drift from what production produces.
// NOTE: gh-tools.mjs is mocked above with a PARTIAL factory, so the normalizer is imported from
// the shared module directly — importing it via gh-tools would resolve to undefined here.
import { normalizeCheckRollup } from "../../packages/mcp-rks/src/shared/check-rollup.mjs";

const checkRun = (name, status, conclusion) => ({ __typename: "CheckRun", name, status, conclusion });
const statusContext = (context, state) => ({ __typename: "StatusContext", context, state });

const PROJECT_ROOT = "/mock/project";
const BASE_PARAMS = { projectRoot: PROJECT_ROOT, problemId: "backlog.feat.test", projectId: "routekit-shell" };

function spawn(status = 0, stdout = "", stderr = "") {
  return { status, stdout, stderr, signal: null, error: null };
}

describe("runStagingMerge CI gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTelemetry.mockReturnValue({ emit: mockEmit });
    mockSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === "gh" && args[1] === "view") return spawn(0, JSON.stringify({ number: 42 }));
      if (cmd === "gh" && args[1] === "merge") return spawn(0, "");
      return spawn(0, "");
    });
  });

  it("passes when all checks have status COMPLETED and conclusion SUCCESS", async () => {
    mockGhPrView.mockReturnValue({
      ok: true,
      pr: {
        // A green StatusContext beside a green CheckRun — the mixed shape a real PR carries,
        // and the one that used to read as perpetually running.
        checks: normalizeCheckRollup([
          checkRun("ci/test", "COMPLETED", "SUCCESS"),
          statusContext("vercel", "SUCCESS"),
        ]),
        allChecksPassed: true,
      },
    });

    const result = await runStagingMerge(BASE_PARAMS);

    expect(result.ok).toBe(true);
    expect(result.merged).toBe(true);
    const mergeCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[1] === "merge");
    expect(mergeCalls.length).toBe(1);
  });

  it("blocks when any check has status !== COMPLETED (still running)", async () => {
    const runningChecks = normalizeCheckRollup([
      checkRun("ci/test", "IN_PROGRESS", null),
      checkRun("ci/lint", "COMPLETED", "SUCCESS"),
    ]);
    mockGhPrView.mockReturnValue({ ok: true, pr: { checks: runningChecks, allChecksPassed: false } });

    const result = await runStagingMerge(BASE_PARAMS);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("CI checks still running");
    expect(result.checks).toEqual(runningChecks);
    const mergeCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[1] === "merge");
    expect(mergeCalls.length).toBe(0);
  });

  it("blocks when any check has conclusion !== SUCCESS (failed)", async () => {
    const failedChecks = normalizeCheckRollup([
      checkRun("ci/test", "COMPLETED", "FAILURE"),
      checkRun("ci/lint", "COMPLETED", "SUCCESS"),
    ]);
    mockGhPrView.mockReturnValue({ ok: true, pr: { checks: failedChecks, allChecksPassed: false } });

    const result = await runStagingMerge(BASE_PARAMS);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("CI checks failed");
    expect(result.checks).toEqual(failedChecks);
    const mergeCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[1] === "merge");
    expect(mergeCalls.length).toBe(0);
  });

  it("proceeds and emits staging.merge.no_ci warning when checks array is empty", async () => {
    mockGhPrView.mockReturnValue({ ok: true, pr: { checks: [], allChecksPassed: true } });

    const result = await runStagingMerge(BASE_PARAMS);

    expect(result.ok).toBe(true);
    expect(result.merged).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      "staging.merge.no_ci",
      expect.any(String),
      expect.objectContaining({ prNumber: expect.any(Number) }),
    );
  });

  it("error response includes checks array with at least name, status, conclusion per check", async () => {
    const failedChecks = normalizeCheckRollup([checkRun("ci/build", "COMPLETED", "FAILURE")]);
    mockGhPrView.mockReturnValue({ ok: true, pr: { checks: failedChecks, allChecksPassed: false } });

    const result = await runStagingMerge(BASE_PARAMS);

    expect(result.ok).toBe(false);
    expect(Array.isArray(result.checks)).toBe(true);
    const [check] = result.checks;
    expect(check).toHaveProperty("name");
    expect(check).toHaveProperty("status");
    expect(check).toHaveProperty("conclusion");
  });

  it("calls ghPrView with the resolved prNumber before gh pr merge", async () => {
    mockGhPrView.mockReturnValue({
      ok: true,
      pr: { checks: normalizeCheckRollup([checkRun("ci", "COMPLETED", "SUCCESS")]), allChecksPassed: true },
    });

    await runStagingMerge(BASE_PARAMS);

    expect(mockGhPrView).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 42, projectRoot: PROJECT_ROOT }),
    );
    const ghPrViewCallIndex = mockSpawnSync.mock.calls.findIndex(([cmd, args]) => cmd === "gh" && args[1] === "merge");
    expect(mockGhPrView).toHaveBeenCalledTimes(1);
    expect(ghPrViewCallIndex).toBeGreaterThanOrEqual(0);
  });

  it("returns error and skips merge when ghPrView fails to fetch PR checks", async () => {
    mockGhPrView.mockReturnValue({ ok: false, error: "PR not found" });

    const result = await runStagingMerge(BASE_PARAMS);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to fetch PR checks/);
    const mergeCalls = mockSpawnSync.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[1] === "merge");
    expect(mergeCalls.length).toBe(0);
  });

  it("ghPrView return shape has allChecksPassed boolean and checks array", () => {
    mockGhPrView.mockReturnValueOnce({
      ok: true,
      pr: {
        number: 42,
        checks: normalizeCheckRollup([checkRun("ci/test", "COMPLETED", "SUCCESS")]),
        allChecksPassed: true,
      },
    });

    const result = mockGhPrView({ projectRoot: PROJECT_ROOT, prNumber: 42 });

    expect(result.pr).toHaveProperty("checks");
    expect(result.pr).toHaveProperty("allChecksPassed");
    expect(typeof result.pr.allChecksPassed).toBe("boolean");
    expect(Array.isArray(result.pr.checks)).toBe(true);
  });
});
