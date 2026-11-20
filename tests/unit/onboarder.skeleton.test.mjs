/**
 * Tests for rks_onboarder skeleton — state file and stage stubs.
 * (backlog.feat.rks-onboarder-impl-phase1)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STAGES, getOnboarderState, saveOnboarderState, runOnboarder } from "../../packages/mcp-rks/src/server/onboarder.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarder-test-"));
  fs.mkdirSync(path.join(tmpDir, ".rks"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("STAGES", () => {
  it("exports exactly 7 stages in correct order", () => {
    expect(STAGES).toEqual([
      "welcome",
      "expectations",
      "stance",
      "first_story",
      "first_build",
      "first_ship",
      "next_steps",
    ]);
  });
});

describe("getOnboarderState", () => {
  it("returns valid default state when file is absent", () => {
    const state = getOnboarderState(tmpDir);
    expect(state.version).toBe(1);
    expect(typeof state.startedAt).toBe("number");
    expect(typeof state.lastTouchedAt).toBe("number");
    expect(state.completedStages).toEqual([]);
    expect(state.currentStage).toBe("welcome");
    expect("projectId" in state).toBe(true);
  });
});

describe("saveOnboarderState", () => {
  it("writes all required fields and updates lastTouchedAt", () => {
    const before = Date.now();
    const saved = saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: before - 1000,
      lastTouchedAt: before - 1000,
      completedStages: [],
      currentStage: "welcome",
      projectId: "test-project",
    });
    expect(saved.lastTouchedAt).toBeGreaterThanOrEqual(before);
    expect(saved.version).toBe(1);
    expect(saved.projectId).toBe("test-project");
    const statePath = path.join(tmpDir, ".rks/onboarder-state.json");
    expect(fs.existsSync(statePath)).toBe(true);
  });
});

describe("state round-trip", () => {
  it("write then read returns all original fields intact", () => {
    const original = {
      version: 1,
      startedAt: 1000000,
      lastTouchedAt: 1000001,
      completedStages: ["welcome"],
      currentStage: "expectations",
      projectId: "round-trip-test",
    };
    saveOnboarderState(tmpDir, original);
    const read = getOnboarderState(tmpDir);
    expect(read.version).toBe(original.version);
    expect(read.startedAt).toBe(original.startedAt);
    expect(read.completedStages).toEqual(original.completedStages);
    expect(read.currentStage).toBe(original.currentStage);
    expect(read.projectId).toBe(original.projectId);
  });
});

describe("stub handlers", () => {
  const STAGE_NAMES = STAGES;

  for (const stage of STAGE_NAMES) {
    it(`${stage} handler returns correct payload shape`, async () => {
      const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage });
      expect(result.ok).toBe(true);
      expect(result.stage).toBe(stage);
      expect(typeof result.display).toBe("string");
      expect(Array.isArray(result.prompts)).toBe(true);
      expect(typeof result.nextAction).toBe("object");
      expect(typeof result.state).toBe("object");
    });
  }
});

describe("runOnboarder routing", () => {
  it("routes to correct handler when explicit stage is provided", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "stance" });
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("stance");
  });

  it("resume logic: selects next incomplete stage from completedStages", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: ["welcome", "expectations"],
      currentStage: "expectations",
      projectId: "test",
    });
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir });
    expect(result.stage).toBe("stance");
  });
});
