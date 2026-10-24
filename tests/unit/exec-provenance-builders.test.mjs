// backlog.feat.exec-plan-commit-linkage — AC3 (pure half), AC10 and AC14 (classifyIgnoreCheck,
// checkPlanArchiveIgnored with child_process mocked): the builders in exec-provenance.mjs.
// This file makes no subprocess call: checkPlanArchiveIgnored runs against a mocked spawnSync.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVENANCE_TRAILER_KEYS,
  planHashFor,
  buildExecTrailers,
  buildPlanArchive,
  planArchiveRelPath,
  writePlanArchive,
  buildExecFailedPayload,
  buildExecPausedPayload,
  buildSquashTrailerBlock,
  classifyIgnoreCheck,
} from "../../packages/mcp-rks/src/server/exec-provenance.mjs";
import { computePlanHash } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

const PLAN = { problemId: "backlog.feat.x", steps: [{ action: "edit_file", path: "a.mjs" }] };

describe("planHashFor", () => {
  it("hashes the plan with qualityReview removed", () => {
    const withReview = { ...PLAN, qualityReview: { hash: "h", score: 9 } };
    expect(planHashFor(withReview)).toBe(computePlanHash(PLAN));
    expect(planHashFor(withReview)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a plan with and without qualityReview hash identically", () => {
    expect(planHashFor({ ...PLAN, qualityReview: { hash: "zzz" } })).toBe(planHashFor(PLAN));
    // Positive control: a different plan hashes differently, so equality above is a measurement.
    expect(planHashFor({ ...PLAN, problemId: "backlog.feat.y" })).not.toBe(planHashFor(PLAN));
  });
});

describe("buildExecTrailers", () => {
  it("emits Plan-Hash then Run-Id and drops empty values", () => {
    expect(buildExecTrailers({ planHash: "p", runId: "r" })).toEqual([
      { key: "Plan-Hash", value: "p" },
      { key: "Run-Id", value: "r" },
    ]);
    expect(buildExecTrailers({ planHash: "", runId: null })).toEqual([]);
    expect(PROVENANCE_TRAILER_KEYS).toEqual(["Story", "Plan-Hash", "Run-Id"]);
  });
});

describe("plan archive", () => {
  const roots = [];
  afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

  it("has exactly the archive keys and is self-verifying", () => {
    const plan = { ...PLAN, qualityReview: { hash: "x" } };
    const a = buildPlanArchive({ runId: "run-1", plan, fixPlans: [], archivedAt: "2026-10-22T00:00:00.000Z" });
    expect(Object.keys(a).sort()).toEqual(["archivedAt", "fixPlans", "plan", "planHash", "problemId", "runId"]);
    expect(planHashFor(a.plan)).toBe(a.planHash);
    const { qualityReview, ...withoutReview } = plan;
    expect(a.planHash).toBe(computePlanHash(withoutReview));
    expect(a.runId).toBe("run-1");
    expect(a.problemId).toBe("backlog.feat.x");
    expect(a.archivedAt).toBe("2026-10-22T00:00:00.000Z");
  });

  it("keeps fixPlans in the given order and defaults fixPlans to an empty array", () => {
    const fixPlans = [{ attempt: 2 }, { attempt: 3 }];
    const a = buildPlanArchive({ runId: "run-1", plan: PLAN, fixPlans });
    expect(a.fixPlans).toEqual(fixPlans);
    expect(a.fixPlans.map((f) => f.attempt)).toEqual([2, 3]);
    expect(buildPlanArchive({ runId: "run-2", plan: PLAN }).fixPlans).toEqual([]);
  });

  it("writes .rks/plans/<runId>.json and round-trips", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-archive-"));
    roots.push(root);
    const a = buildPlanArchive({ runId: "run-9", plan: PLAN });
    const rel = writePlanArchive(root, a);
    expect(rel).toBe(planArchiveRelPath("run-9"));
    expect(rel).toBe(".rks/plans/run-9.json");
    expect(JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"))).toEqual(a);
  });
});

describe("event payload builders", () => {
  it("exec.failed payload carries runId, planHash, reason and no resumable or correlationId field", () => {
    const p = buildExecFailedPayload({ runId: "r", planHash: null, reason: "scope_violation" });
    expect(p).toEqual({ runId: "r", planHash: null, reason: "scope_violation" });
    expect(p).not.toHaveProperty("resumable");
    expect(p).not.toHaveProperty("correlationId");
    // Even a caller that passes them does not get them through.
    const leaky = buildExecFailedPayload({ runId: "r", planHash: "p", reason: "x", resumable: true, correlationId: "c" });
    expect(leaky).not.toHaveProperty("resumable");
    expect(leaky).not.toHaveProperty("correlationId");
    expect(leaky).toEqual({ runId: "r", planHash: "p", reason: "x" });
  });

  it("exec.paused payload carries runId, planHash and reason", () => {
    expect(buildExecPausedPayload({ runId: "r", planHash: null, reason: "needs_approval" })).toEqual({ runId: "r", planHash: null, reason: "needs_approval" });
  });
});

describe("buildSquashTrailerBlock", () => {
  it("collects distinct provenance trailers across commit messages", () => {
    const block = buildSquashTrailerBlock([
      "feat(exec): a\n\nStory: s\nPlan-Hash: p1\nRun-Id: r1",
      "feat(exec): b\n\nStory: s\nPlan-Hash: p2\nRun-Id: r2",
    ]);
    const lines = block.split("\n");
    expect(lines.filter((l) => l === "Story: s")).toHaveLength(1);
    expect(lines).toEqual(expect.arrayContaining(["Plan-Hash: p1", "Run-Id: r1", "Plan-Hash: p2", "Run-Id: r2"]));
    expect(lines).toHaveLength(5);
  });

  it("deduplicates identical lines and ignores non-provenance trailers such as Co-Authored-By", () => {
    const block = buildSquashTrailerBlock([
      "feat: a\n\nStory: s\nCo-Authored-By: A <a@b>",
      "feat: a again\n\nStory: s\nCo-Authored-By: A <a@b>",
    ]);
    expect(block).toBe("Story: s");
  });

  it("returns empty string when no provenance trailers are present", () => {
    expect(buildSquashTrailerBlock(["chore: x", "fix: y\n\nCo-Authored-By: A <a@b>"])).toBe("");
    expect(buildSquashTrailerBlock([])).toBe("");
  });
});

// AC14 (QA 2026-10-24): classifyIgnoreCheck is pure; a failed check is never ignored or not_ignored.
describe("classifyIgnoreCheck", () => {
  it("maps exit 0 to ignored, exit 1 to not_ignored, everything else to check_failed", () => {
    expect(classifyIgnoreCheck({ status: 0 })).toEqual({ status: "ignored", error: null });
    expect(classifyIgnoreCheck({ status: 1 })).toEqual({ status: "not_ignored", error: null });
    const failed = [
      { status: 128, stderr: "fatal: not a git repository" },
      { status: 2 },
      { status: null, error: new Error("spawn git ENOENT") },
      { status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) },
      { status: null, signal: "SIGTERM", error: null },
      undefined,
    ];
    for (const r of failed) {
      const c = classifyIgnoreCheck(r);
      expect(c.status).toBe("check_failed");
      expect(typeof c.error).toBe("string");
      expect(c.error.length).toBeGreaterThan(0);
    }
    expect(classifyIgnoreCheck({ status: 128, stderr: "fatal: not a git repository" }).error).toMatch(/exit 128.*not a git repository/);
    expect(classifyIgnoreCheck({ status: null, error: new Error("spawn git ENOENT") }).error).toMatch(/ENOENT/);
    expect(classifyIgnoreCheck({ status: null, signal: "SIGTERM", error: null }).error).toMatch(/SIGTERM/);
    expect(classifyIgnoreCheck().status).toBe("check_failed");
  });
});

describe("checkPlanArchiveIgnored (node:child_process spawnSync mocked)", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  async function loadWith(result) {
    const spawnSyncMock = vi.fn(() => result);
    vi.resetModules();
    vi.doMock("node:child_process", async (orig) => ({ ...(await orig()), spawnSync: spawnSyncMock, default: { ...(await orig()).default, spawnSync: spawnSyncMock } }));
    const mod = await import("../../packages/mcp-rks/src/server/exec-provenance.mjs");
    return { mod, spawnSyncMock };
  }

  it("makes exactly one git check-ignore -q -- <path> call with cwd root and a numeric timeout", async () => {
    const { mod, spawnSyncMock } = await loadWith({ status: 1, stdout: "", stderr: "" });
    const root = "/some/root";
    const out = mod.checkPlanArchiveIgnored(root, ".rks/plans/run-x.json");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe("git");
    expect(argv).toEqual(["check-ignore", "-q", "--", ".rks/plans/run-x.json"]);
    expect(opts.cwd).toBe(root);
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
    expect(out).toEqual({ status: "not_ignored", error: null });
  });

  it.each([
    [{ status: 0, stdout: "", stderr: "" }, { status: "ignored", error: null }],
    [{ status: 1, stdout: "", stderr: "" }, { status: "not_ignored", error: null }],
  ])("returns classifyIgnoreCheck of the mocked result (%o)", async (result, expected) => {
    const { mod } = await loadWith(result);
    expect(mod.checkPlanArchiveIgnored("/r", ".rks/plans/run-x.json")).toEqual(expected);
  });

  it("exit 128 gives check_failed with a non-empty error", async () => {
    const { mod } = await loadWith({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    const out = mod.checkPlanArchiveIgnored("/r", ".rks/plans/run-x.json");
    expect(out.status).toBe("check_failed");
    expect(out.error).toMatch(/exit 128/);
  });
});
