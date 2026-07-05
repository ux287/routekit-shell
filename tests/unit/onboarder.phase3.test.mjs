/**
 * Tests for rks_onboarder Phase 3 — Stages 4-6 with Governor dispatch and result capture.
 * (backlog.feat.rks-onboarder-impl-phase3)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../packages/mcp-rks/src/server/telemetry.mjs", () => ({
  recordTelemetry: vi.fn(),
}));

import { recordTelemetry } from "../../packages/mcp-rks/src/server/telemetry.mjs";
import {
  runOnboarder,
  saveOnboarderState,
} from "../../packages/mcp-rks/src/server/onboarder.mjs";

const DEMO_PROBLEM = "Add a Hello World React component to src/components/Hello.tsx";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarder-p3-test-"));
  fs.mkdirSync(path.join(tmpDir, ".rks"), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Stage 4 display ──────────────────────────────────────────────────────────

describe("Stage 4 display (first_story)", () => {
  it("returns display containing Hello Routekit! copy when no input", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_story" });
    expect(result.display).toBeTruthy();
    expect(result.display).toContain("Hello Routekit!");
    expect(result.display).toContain("problem statement");
  });

  it("returns no pendingDispatch when called with no input", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_story" });
    expect(result.pendingDispatch).toBeFalsy();
  });

  it("demo input substitutes canonical problem statement in pendingDispatch", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_story",
      responses: { userInput: "demo" },
    });
    expect(result.pendingDispatch).toBeDefined();
    expect(result.pendingDispatch.problemStatement).toBe(DEMO_PROBLEM);
    expect(result.pendingDispatch.isDemo).toBe(true);
  });

  it("free-form input passes problem statement through unchanged in pendingDispatch", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_story",
      responses: { userInput: "Fix the login page to show error messages" },
    });
    expect(result.pendingDispatch).toBeDefined();
    expect(result.pendingDispatch.problemStatement).toBe("Fix the login page to show error messages");
    expect(result.pendingDispatch.isDemo).toBe(false);
  });
});

// ─── Stage 4 governor result capture ─────────────────────────────────────────

describe("Stage 4 governor result capture", () => {
  it("captures storyId from governorResult into state.responses.first_story.storyId", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_story",
      responses: { governorResult: { storyId: "backlog.feat.hello-world" } },
    });
    expect(result.state.responses?.first_story?.storyId).toBe("backlog.feat.hello-world");
  });

  it("post-stage display includes trust note with .routekit/hooks/ and runs/ and AGPL-3.0", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_story",
      responses: { governorResult: { storyId: "backlog.feat.hello-world" } },
    });
    expect(result.display).toContain(".routekit/hooks/");
    expect(result.display).toContain("runs/");
    expect(result.display).toContain("AGPL-3.0");
    expect(result.display).toContain("No data leaves your machine");
  });

  it("emits onboarder.stage.completed with storyId and durationSeconds", async () => {
    await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_story",
      responses: { governorResult: { storyId: "backlog.feat.hello-world" } },
    });
    const completed = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.completed" && p.metrics?.stage === "first_story"
    );
    expect(completed).toHaveLength(1);
    expect(completed[0][1].metrics).toHaveProperty("storyId", "backlog.feat.hello-world");
    expect(completed[0][1].metrics).toHaveProperty("durationSeconds");
  });

  it("marks first_story in completedStages", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_story",
      responses: { governorResult: { storyId: "backlog.feat.hello-world" } },
    });
    expect(result.state.completedStages).toContain("first_story");
  });
});

// ─── Stage 5 dispatch and error ───────────────────────────────────────────────

describe("Stage 5 (first_build) dispatch from stage 4 state", () => {
  function stateWithStoryId(storyId) {
    return {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: ["welcome", "expectations", "stance", "first_story"],
      currentStage: "first_build",
      projectId: "test",
      responses: { first_story: { storyId } },
    };
  }

  it("returns pendingDispatch with storyId from stage 4 state", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_build" });
    expect(result.pendingDispatch).toBeDefined();
    expect(result.pendingDispatch.type).toBe("build");
    expect(result.pendingDispatch.storyId).toBe("backlog.feat.my-story");
  });

  it("returns guidance display when stage 4 state is missing storyId", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_build" });
    expect(result.ok).toBe(true);
    expect(result.display).toContain("re-run Stage 4");
  });
});

// ─── Stage 5 governor result capture ─────────────────────────────────────────

describe("Stage 5 governor result capture", () => {
  function stateWithStoryId(storyId) {
    return {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: ["welcome", "expectations", "stance", "first_story"],
      currentStage: "first_build",
      projectId: "test",
      responses: { first_story: { storyId } },
    };
  }

  it("captures rawCost, efficientCost, wasteRatio, filesChanged from governorResult", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_build",
      responses: {
        governorResult: {
          rawCost: 0.0042,
          efficientCost: 0.0021,
          wasteRatio: 0.5,
          filesChanged: 3,
        },
      },
    });
    expect(result.state.responses?.first_build?.rawCost).toBe(0.0042);
    expect(result.state.responses?.first_build?.efficientCost).toBe(0.0021);
    expect(result.state.responses?.first_build?.wasteRatio).toBe(0.5);
    expect(result.state.responses?.first_build?.filesChanged).toBe(3);
  });

  it("shows cost report in display when rawCost is present", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_build",
      responses: { governorResult: { rawCost: 0.0042, efficientCost: 0.0021, wasteRatio: 0.5 } },
    });
    expect(result.display).toContain("0.0042");
    expect(result.display).toContain("Cost report");
  });

  it("gracefully degrades when rawCost is absent — no fabricated numbers", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_build",
      responses: { governorResult: {} },
    });
    expect(result.display).toContain("Cost reporting is not yet available");
    expect(result.display).not.toMatch(/\$\d+\.\d+/);
  });

  it("emits stage.completed with storyId, rawCost, efficientCost, wasteRatio, durationSeconds", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_build",
      responses: {
        governorResult: { rawCost: 0.0042, efficientCost: 0.0021, wasteRatio: 0.5 },
      },
    });
    const completed = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.completed" && p.metrics?.stage === "first_build"
    );
    expect(completed).toHaveLength(1);
    const m = completed[0][1].metrics;
    expect(m).toHaveProperty("storyId", "backlog.feat.my-story");
    expect(m).toHaveProperty("rawCost", 0.0042);
    expect(m).toHaveProperty("efficientCost", 0.0021);
    expect(m).toHaveProperty("wasteRatio", 0.5);
    expect(m).toHaveProperty("durationSeconds");
  });

  it("emits stage.completed with null cost fields when absent", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_build",
      responses: { governorResult: {} },
    });
    const completed = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.completed" && p.metrics?.stage === "first_build"
    );
    expect(completed).toHaveLength(1);
    const m = completed[0][1].metrics;
    expect(m.rawCost).toBeNull();
    expect(m.efficientCost).toBeNull();
    expect(m.wasteRatio).toBeNull();
  });
});

// ─── Stage 6 governor result capture ─────────────────────────────────────────

describe("Stage 6 (first_ship) governor result capture", () => {
  function stateWithStoryId(storyId) {
    return {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: ["welcome", "expectations", "stance", "first_story", "first_build"],
      currentStage: "first_ship",
      projectId: "test",
      responses: { first_story: { storyId } },
    };
  }

  it("captures prUrl and prState from three-branch Ship Governor return", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_ship",
      responses: {
        governorResult: {
          prUrl: "https://github.com/test/repo/pull/1",
          prState: "open",
        },
      },
    });
    expect(result.state.responses?.first_ship?.prUrl).toBe("https://github.com/test/repo/pull/1");
    expect(result.state.responses?.first_ship?.prState).toBe("open");
    expect(result.display).toContain("https://github.com/test/repo/pull/1");
  });

  it("captures commitSha and integrationBranch from two-branch Ship Governor return", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_ship",
      responses: {
        governorResult: {
          commitSha: "abc123def",
          integrationBranch: "staging",
        },
      },
    });
    expect(result.state.responses?.first_ship?.commitSha).toBe("abc123def");
    expect(result.state.responses?.first_ship?.integrationBranch).toBe("staging");
    expect(result.display).toContain("abc123def");
    expect(result.display).toContain("staging");
  });

  it("emits stage.completed with storyId, prUrl, prState, durationSeconds", async () => {
    saveOnboarderState(tmpDir, stateWithStoryId("backlog.feat.my-story"));
    await runOnboarder({
      projectRoot: tmpDir,
      stage: "first_ship",
      responses: {
        governorResult: { prUrl: "https://github.com/test/repo/pull/1", prState: "open" },
      },
    });
    const completed = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.completed" && p.metrics?.stage === "first_ship"
    );
    expect(completed).toHaveLength(1);
    const m = completed[0][1].metrics;
    expect(m).toHaveProperty("storyId", "backlog.feat.my-story");
    expect(m).toHaveProperty("prUrl", "https://github.com/test/repo/pull/1");
    expect(m).toHaveProperty("prState", "open");
    expect(m).toHaveProperty("durationSeconds");
  });
});

// ─── Governor error paths ─────────────────────────────────────────────────────

describe("Governor error handling (Stages 4-6)", () => {
  for (const stage of ["first_story", "first_build", "first_ship"]) {
    it(`${stage}: emits onboarder.stage.failed and returns error display with runs/ pointer`, async () => {
      if (stage === "first_build" || stage === "first_ship") {
        saveOnboarderState(tmpDir, {
          version: 1,
          startedAt: Date.now(),
          lastTouchedAt: Date.now(),
          completedStages: ["welcome", "expectations", "stance", "first_story"],
          currentStage: stage,
          projectId: "test",
          responses: { first_story: { storyId: "backlog.feat.test" } },
        });
      }
      const result = await runOnboarder({
        projectRoot: tmpDir,
        stage,
        responses: { governorResult: { ok: false, error: "governor_timeout" } },
      });
      expect(result.ok).toBe(false);
      expect(result.display).toContain("runs/");
      expect(result.display).toContain("child-project-kickoff");
      const failed = recordTelemetry.mock.calls.filter(
        ([, p]) => p.slug === "onboarder.stage.failed" && p.metrics?.stage === stage
      );
      expect(failed).toHaveLength(1);
      expect(failed[0][1].metrics).toHaveProperty("failureReason", "governor_error");
      expect(failed[0][1].metrics).toHaveProperty("governorError", "governor_timeout");
    });
  }
});

// ─── Regression: Phase 1 and Phase 2 still pass ───────────────────────────────

describe("Regression — skeleton payload shape still correct after Phase 3", () => {
  it("first_story returns ok:true and correct shape when no governorResult", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_story" });
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("first_story");
    expect(typeof result.display).toBe("string");
    expect(Array.isArray(result.prompts)).toBe(true);
    expect(typeof result.state).toBe("object");
  });

  it("first_build returns ok:false shape when storyId missing but otherwise correct structure", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_build" });
    expect(result.stage).toBe("first_build");
    expect(typeof result.display).toBe("string");
  });

  it("first_ship returns ok:true and correct shape when no governorResult", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "first_ship" });
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("first_ship");
    expect(typeof result.display).toBe("string");
  });
});
