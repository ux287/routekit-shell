/**
 * Tests for cascade-state workflow module
 *
 * @see backlog.agents.cascade-failure-recovery
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../../helpers/tmp.mjs";
import {
  CascadeStatus,
  createCascadeRun,
  getCascadeState,
  recordPhase,
  requestApproval,
  markCascadeComplete,
  findIncompleteCascades,
  getResumeInfo,
  buildDispatcherResponse,
} from "../../../packages/mcp-rks/src/workflow/cascade-state.mjs";

describe("cascade-state", () => {
  let projectRoot;
  let runsDir;

  beforeEach(() => {
    projectRoot = makeTempDir("cascade-state-test");
    runsDir = path.join(projectRoot, ".rks", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
  });

  describe("createCascadeRun", () => {
    it("creates a cascade.json in a new run directory", () => {
      const { runId, runDir } = createCascadeRun(projectRoot, "backlog.foo.bar");

      expect(runId).toBeTruthy();
      expect(fs.existsSync(runDir)).toBe(true);

      const state = getCascadeState(runDir);
      expect(state).not.toBeNull();
      expect(state.runId).toBe(runId);
      expect(state.storyId).toBe("backlog.foo.bar");
      expect(state.status).toBe(CascadeStatus.RUNNING);
      expect(state.phases).toEqual([]);
      expect(state.artifacts).toEqual({});
      expect(state.canResume).toBe(false);
    });

    it("uses existing runDir when provided", () => {
      const existingDir = path.join(runsDir, "existing-run");
      fs.mkdirSync(existingDir, { recursive: true });

      const { runDir } = createCascadeRun(projectRoot, "backlog.foo", existingDir);
      expect(runDir).toBe(existingDir);
      expect(getCascadeState(existingDir)).not.toBeNull();
    });

    it("run directory name contains story slug", () => {
      const { runDir } = createCascadeRun(projectRoot, "backlog.agents.my-feature");
      const dirName = path.basename(runDir);
      expect(dirName).toContain("backlog-agents-my-feature");
    });
  });

  describe("recordPhase", () => {
    let runDir;

    beforeEach(() => {
      ({ runDir } = createCascadeRun(projectRoot, "backlog.test"));
    });

    it("records a successful phase", () => {
      const state = recordPhase(runDir, "validate", {
        ok: true,
        duration: 5000,
        data: { quality: 0.85 },
      });

      expect(state.phases).toHaveLength(1);
      expect(state.phases[0].name).toBe("validate");
      expect(state.phases[0].status).toBe("complete");
      expect(state.phases[0].duration).toBe(5000);
      expect(state.status).toBe(CascadeStatus.RUNNING);
    });

    it("records a failed phase and updates cascade status", () => {
      // First record a success
      recordPhase(runDir, "validate", { ok: true });

      // Then record a failure
      const state = recordPhase(runDir, "exec", {
        ok: false,
        error: "Test compilation failed",
      });

      expect(state.phases).toHaveLength(2);
      expect(state.phases[1].status).toBe("failed");
      expect(state.phases[1].error).toBe("Test compilation failed");
      expect(state.status).toBe(CascadeStatus.FAILED);
      expect(state.retryFrom).toBe("exec");
      expect(state.canResume).toBe(true);
    });

    it("merges artifacts from successful phase results", () => {
      recordPhase(runDir, "exec", {
        ok: true,
        data: { branch: "rks/story-123", commitId: "abc1234" },
      });

      const state = getCascadeState(runDir);
      expect(state.artifacts.branch).toBe("rks/story-123");
      expect(state.artifacts.commitId).toBe("abc1234");
    });

    it("accumulates artifacts across phases", () => {
      recordPhase(runDir, "exec", {
        ok: true,
        data: { branch: "rks/story-123", commitId: "abc1234" },
      });
      recordPhase(runDir, "ship", {
        ok: true,
        data: { prNumber: 42, prUrl: "https://github.com/test/pull/42" },
      });

      const state = getCascadeState(runDir);
      expect(state.artifacts.branch).toBe("rks/story-123");
      expect(state.artifacts.commitId).toBe("abc1234");
      expect(state.artifacts.prNumber).toBe(42);
      expect(state.artifacts.prUrl).toBe("https://github.com/test/pull/42");
    });

    it("throws if no cascade state exists", () => {
      const emptyDir = path.join(runsDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      expect(() => recordPhase(emptyDir, "validate", { ok: true })).toThrow(
        /No cascade state found/
      );
    });
  });

  describe("requestApproval", () => {
    let runDir;

    beforeEach(() => {
      ({ runDir } = createCascadeRun(projectRoot, "backlog.test"));
      recordPhase(runDir, "validate", { ok: true });
      recordPhase(runDir, "plan", { ok: true, data: { planFile: "plan.yaml" } });
    });

    it("sets needs_approval status with approval context", () => {
      const state = requestApproval(runDir, "exec", {
        summary: "Plan ready for review. 3 files, 47 lines changed.",
        question: "Approve this plan for execution?",
        options: ["approve", "modify", "abort"],
      });

      expect(state.status).toBe(CascadeStatus.NEEDS_APPROVAL);
      expect(state.retryFrom).toBe("exec");
      expect(state.canResume).toBe(true);
      expect(state.approval.phase).toBe("exec");
      expect(state.approval.question).toBe("Approve this plan for execution?");
      expect(state.approval.options).toEqual(["approve", "modify", "abort"]);
    });
  });

  describe("markCascadeComplete", () => {
    let runDir;

    beforeEach(() => {
      ({ runDir } = createCascadeRun(projectRoot, "backlog.test"));
      recordPhase(runDir, "validate", { ok: true });
      recordPhase(runDir, "ship", { ok: true, data: { prNumber: 99 } });
    });

    it("marks cascade as complete", () => {
      const state = markCascadeComplete(runDir);

      expect(state.status).toBe(CascadeStatus.COMPLETE);
      expect(state.completedAt).toBeTruthy();
      expect(state.canResume).toBe(false);
      expect(state.retryFrom).toBeNull();
    });

    it("merges final result artifacts", () => {
      const state = markCascadeComplete(runDir, { merged: true });
      expect(state.artifacts.merged).toBe(true);
    });
  });

  describe("findIncompleteCascades", () => {
    it("returns empty for fresh project", () => {
      const result = findIncompleteCascades(projectRoot);
      expect(result).toEqual([]);
    });

    it("finds failed cascades", () => {
      const { runDir } = createCascadeRun(projectRoot, "backlog.story-a");
      recordPhase(runDir, "validate", { ok: true });
      recordPhase(runDir, "ship", { ok: false, error: "timeout" });

      const incomplete = findIncompleteCascades(projectRoot);
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].state.storyId).toBe("backlog.story-a");
      expect(incomplete[0].state.status).toBe(CascadeStatus.FAILED);
    });

    it("finds needs_approval cascades", () => {
      const { runDir } = createCascadeRun(projectRoot, "backlog.story-b");
      recordPhase(runDir, "validate", { ok: true });
      requestApproval(runDir, "exec", { summary: "Review plan" });

      const incomplete = findIncompleteCascades(projectRoot);
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].state.status).toBe(CascadeStatus.NEEDS_APPROVAL);
    });

    it("excludes completed cascades", () => {
      const { runDir: dir1 } = createCascadeRun(projectRoot, "backlog.done");
      recordPhase(dir1, "validate", { ok: true });
      markCascadeComplete(dir1);

      const { runDir: dir2 } = createCascadeRun(projectRoot, "backlog.failed");
      recordPhase(dir2, "ship", { ok: false, error: "oops" });

      const incomplete = findIncompleteCascades(projectRoot);
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].state.storyId).toBe("backlog.failed");
    });

    it("sorts most recent first", () => {
      const { runDir: dir1 } = createCascadeRun(projectRoot, "backlog.old");
      recordPhase(dir1, "validate", { ok: false, error: "old" });

      const { runDir: dir2 } = createCascadeRun(projectRoot, "backlog.new");
      recordPhase(dir2, "ship", { ok: false, error: "new" });

      // Ensure timestamps differ — both runs may share the same millisecond,
      // making the sort a tie (stable sort preserves readdirSync order).
      // Bump the newer run's updatedAt so the sort is deterministic.
      const statePath = path.join(dir2, "cascade.json");
      const newState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      newState.updatedAt = new Date(Date.now() + 1000).toISOString();
      fs.writeFileSync(statePath, JSON.stringify(newState, null, 2));

      const incomplete = findIncompleteCascades(projectRoot);
      expect(incomplete).toHaveLength(2);
      expect(incomplete[0].state.storyId).toBe("backlog.new");
    });

    it("returns empty when no .rks/runs directory exists", () => {
      const emptyRoot = makeTempDir("cascade-empty");
      expect(findIncompleteCascades(emptyRoot)).toEqual([]);
    });
  });

  describe("getResumeInfo", () => {
    it("returns canResume:false for null state", () => {
      expect(getResumeInfo(null).canResume).toBe(false);
    });

    it("returns canResume:false for completed cascade", () => {
      const info = getResumeInfo({ status: CascadeStatus.COMPLETE, phases: [] });
      expect(info.canResume).toBe(false);
    });

    it("returns canResume:false for aborted cascade", () => {
      const info = getResumeInfo({ status: CascadeStatus.ABORTED, phases: [] });
      expect(info.canResume).toBe(false);
    });

    it("returns canResume:false when no phases completed", () => {
      const info = getResumeInfo({
        status: CascadeStatus.FAILED,
        phases: [{ name: "validate", status: "failed" }],
      });
      expect(info.canResume).toBe(false);
    });

    it("returns canResume:true with completed phases for needs_approval", () => {
      const info = getResumeInfo({
        status: CascadeStatus.NEEDS_APPROVAL,
        phases: [{ name: "validate", status: "complete" }, { name: "plan", status: "complete" }],
        retryFrom: "exec",
        artifacts: { planFile: "plan.yaml" },
        storyId: "backlog.test",
        approval: { phase: "exec", question: "Approve?" },
      });

      expect(info.canResume).toBe(true);
      expect(info.completedPhases).toEqual(["validate", "plan"]);
      expect(info.retryFrom).toBe("exec");
      expect(info.approval).toBeTruthy();
    });

    it("returns resume info for failed cascade", () => {
      const info = getResumeInfo({
        status: CascadeStatus.FAILED,
        phases: [
          { name: "validate", status: "complete" },
          { name: "exec", status: "complete" },
          { name: "ship", status: "failed" },
        ],
        retryFrom: "ship",
        artifacts: { branch: "rks/test", commitId: "abc" },
        storyId: "backlog.test",
      });

      expect(info.canResume).toBe(true);
      expect(info.completedPhases).toEqual(["validate", "exec"]);
      expect(info.retryFrom).toBe("ship");
      expect(info.artifacts.branch).toBe("rks/test");
    });
  });

  describe("buildDispatcherResponse", () => {
    it("returns complete response for finished cascade", () => {
      const resp = buildDispatcherResponse({
        status: CascadeStatus.COMPLETE,
        phases: [
          { name: "validate", status: "complete" },
          { name: "ship", status: "complete" },
        ],
        artifacts: { prNumber: 42 },
      });

      expect(resp.ok).toBe(true);
      expect(resp.status).toBe("complete");
      expect(resp.completedPhases).toEqual(["validate", "ship"]);
      expect(resp.artifacts.prNumber).toBe(42);
    });

    it("returns structured failure for failed cascade", () => {
      const resp = buildDispatcherResponse({
        status: CascadeStatus.FAILED,
        phases: [
          { name: "validate", status: "complete" },
          { name: "exec", status: "complete" },
          { name: "ship", status: "failed", error: "PR creation failed: network timeout" },
        ],
        artifacts: { branch: "rks/test", commitId: "abc" },
        retryFrom: "ship",
        canResume: true,
      });

      expect(resp.ok).toBe(false);
      expect(resp.status).toBe("failed");
      expect(resp.phase).toBe("ship");
      expect(resp.completedPhases).toEqual(["validate", "exec"]);
      expect(resp.error).toContain("network timeout");
      expect(resp.recoverable).toBe(true);
      expect(resp.retryFrom).toBe("ship");
      expect(resp.hint).toContain("Transient");
    });

    it("returns needs_approval response", () => {
      const resp = buildDispatcherResponse({
        status: CascadeStatus.NEEDS_APPROVAL,
        phases: [{ name: "validate", status: "complete" }],
        artifacts: { planFile: "plan.yaml" },
        retryFrom: "exec",
        approval: {
          summary: "Plan ready",
          question: "Approve execution?",
          options: ["approve", "abort"],
        },
      });

      expect(resp.ok).toBe(true);
      expect(resp.status).toBe("needs_approval");
      expect(resp.phase).toBe("exec");
      expect(resp.question).toBe("Approve execution?");
      expect(resp.options).toEqual(["approve", "abort"]);
    });

    it("returns error for null state", () => {
      const resp = buildDispatcherResponse(null);
      expect(resp.ok).toBe(false);
      expect(resp.error).toContain("No cascade state");
    });
  });

  describe("unified protocol: failures and approvals use same structure", () => {
    it("both failed and needs_approval responses have phase, completedPhases, artifacts", () => {
      const failedResp = buildDispatcherResponse({
        status: CascadeStatus.FAILED,
        phases: [
          { name: "validate", status: "complete" },
          { name: "ship", status: "failed", error: "oops" },
        ],
        artifacts: { branch: "rks/test" },
        retryFrom: "ship",
        canResume: true,
      });

      const approvalResp = buildDispatcherResponse({
        status: CascadeStatus.NEEDS_APPROVAL,
        phases: [{ name: "validate", status: "complete" }],
        artifacts: { planFile: "plan.yaml" },
        retryFrom: "exec",
        approval: { question: "Approve?" },
      });

      // Both have the same structural fields
      for (const resp of [failedResp, approvalResp]) {
        expect(resp).toHaveProperty("status");
        expect(resp).toHaveProperty("phase");
        expect(resp).toHaveProperty("completedPhases");
        expect(resp).toHaveProperty("artifacts");
      }
    });
  });
});
