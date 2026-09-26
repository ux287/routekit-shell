/**
 * Tests for rks_onboarder Phase 2 — Stages 1-3 dialogue, telemetry, generateProjectFiles.
 * (backlog.feat.rks-onboarder-impl-phase2)
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
  generateProjectFiles,
  saveOnboarderState,
} from "../../packages/mcp-rks/src/server/onboarder.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarder-p2-test-"));
  fs.mkdirSync(path.join(tmpDir, ".rks"), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Display content ──────────────────────────────────────────────────────────

describe("Stage 1 display", () => {
  it("handleWelcome returns non-empty display with welcome copy", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome" });
    expect(result.display).toBeTruthy();
    expect(result.display).toContain("routekit-shell");
    expect(result.display).toContain("The agent doesn't freelance");
  });

  it("handleWelcome includes closed-ended prompt", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome" });
    expect(result.display).toContain("Ready to continue?");
    expect(result.display).toContain("/rks-onboard --bounce");
  });
});

describe("Stage 2 display", () => {
  it("handleExpectations returns non-empty display with expectations copy", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "expectations" });
    expect(result.display).toBeTruthy();
    expect(result.display).toContain("Layer one");
    expect(result.display).toContain("Layer two");
  });

  it("handleExpectations includes closed-ended prompt", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "expectations" });
    expect(result.display).toContain("Does that make sense?");
    expect(result.display).toContain("/rks-onboard --skip-tour");
  });
});

describe("Stage 3 display", () => {
  it("handleStance returns non-empty display with stance copy", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "stance" });
    expect(result.display).toBeTruthy();
    expect(result.display).toContain("every change is either a story or a framework update");
    expect(result.display).toContain("agent doesn't freelance");
  });

  it("handleStance includes closed-ended prompt", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "stance" });
    expect(result.display).toContain("Type **ready**");
  });
});

// ─── Telemetry ────────────────────────────────────────────────────────────────

describe("telemetry — session.started", () => {
  it("emits onboarder.session.started exactly once on fresh Stage 1", async () => {
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome" });
    const sessionStartedCalls = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.session.started"
    );
    expect(sessionStartedCalls).toHaveLength(1);
  });

  it("does NOT emit onboarder.session.started on resumed session", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: ["welcome"],
      currentStage: "expectations",
      projectId: "test",
    });
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "expectations" });
    const sessionStartedCalls = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.session.started"
    );
    expect(sessionStartedCalls).toHaveLength(0);
  });
});

describe("telemetry — stage events", () => {
  for (const stage of ["welcome", "expectations", "stance"]) {
    it(`emits onboarder.stage.started for ${stage}`, async () => {
      await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage });
      const startedCalls = recordTelemetry.mock.calls.filter(
        ([, p]) => p.slug === "onboarder.stage.started" && p.metrics?.stage === stage
      );
      expect(startedCalls.length).toBeGreaterThan(0);
    });

    it(`emits onboarder.stage.completed with durationSeconds for ${stage}`, async () => {
      await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage });
      const completedCalls = recordTelemetry.mock.calls.filter(
        ([, p]) => p.slug === "onboarder.stage.completed" && p.metrics?.stage === stage
      );
      expect(completedCalls.length).toBeGreaterThan(0);
      expect(completedCalls[0][1].metrics).toHaveProperty("durationSeconds");
    });
  }
});

// ─── Skip paths ───────────────────────────────────────────────────────────────

describe("skipTour", () => {
  it("marks all stages except next_steps as skipped and advances to next_steps (which then completes)", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, skipTour: true });
    expect(result.stage).toBe("next_steps");
    const skippedStages = ["welcome", "expectations", "stance", "first_story", "first_build", "first_ship"];
    for (const s of skippedStages) {
      expect(result.state.completedStages).toContain(s);
    }
  });

  it("emits onboarder.stage.skipped with reason dismissed for each skipped stage", async () => {
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, skipTour: true });
    const skippedCalls = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.skipped" && p.metrics?.reason === "dismissed"
    );
    expect(skippedCalls.length).toBeGreaterThanOrEqual(6);
  });

  it("sets completedAt and completedVersion on project.json", async () => {
    fs.writeFileSync(path.join(tmpDir, ".rks/project.json"), JSON.stringify({ id: "test" }), "utf8");
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, skipTour: true });
    const proj = JSON.parse(fs.readFileSync(path.join(tmpDir, ".rks/project.json"), "utf8"));
    expect(proj.onboarder.completedVersion).toBe("skipped-as-power-user");
    expect(typeof proj.onboarder.completedAt).toBe("number");
  });
});

describe("skipStage", () => {
  it("skips current stage and advances to next", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome", skipStage: true });
    expect(result.stage).toBe("expectations");
  });

  it("emits onboarder.stage.skipped with reason user-skip", async () => {
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome", skipStage: true });
    const skippedCalls = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.skipped" && p.metrics?.reason === "user-skip"
    );
    expect(skippedCalls.length).toBeGreaterThan(0);
  });
});

describe("bounce", () => {
  it("sets dismissed:true on project.json onboarder field", async () => {
    fs.writeFileSync(path.join(tmpDir, ".rks/project.json"), JSON.stringify({ id: "test" }), "utf8");
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome", bounce: true });
    const proj = JSON.parse(fs.readFileSync(path.join(tmpDir, ".rks/project.json"), "utf8"));
    expect(proj.onboarder.dismissed).toBe(true);
  });

  it("emits onboarder.stage.skipped with reason bounced", async () => {
    await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome", bounce: true });
    const bouncedCalls = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.stage.skipped" && p.metrics?.reason === "bounced"
    );
    expect(bouncedCalls.length).toBeGreaterThan(0);
  });

  it("returns UX287 exit message", async () => {
    const result = await runOnboarder({ projectId: "test", projectRoot: tmpDir, stage: "welcome", bounce: true });
    expect(result.display).toContain("Thanks for trying rks");
    expect(result.display).toContain("UX287");
  });
});

// ─── generateProjectFiles ─────────────────────────────────────────────────────

describe("generateProjectFiles", () => {
  it("is exported from onboarder.mjs", () => {
    expect(typeof generateProjectFiles).toBe("function");
  });

  it("creates project.overview.md when it does not exist", () => {
    generateProjectFiles(tmpDir, { projectId: "test-project" });
    expect(fs.existsSync(path.join(tmpDir, "notes/project.overview.md"))).toBe(true);
  });

  it("does NOT overwrite project.overview.md when it already exists (idempotent)", () => {
    const overviewPath = path.join(tmpDir, "notes/project.overview.md");
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fs.writeFileSync(overviewPath, "ORIGINAL", "utf8");
    generateProjectFiles(tmpDir, { projectId: "test-project" });
    expect(fs.readFileSync(overviewPath, "utf8")).toBe("ORIGINAL");
  });

  it("creates AGENTS.md when it does not exist", () => {
    generateProjectFiles(tmpDir, { projectId: "test-project" });
    expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
  });

  it("does NOT overwrite AGENTS.md when it already exists (idempotent)", () => {
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "ORIGINAL", "utf8");
    generateProjectFiles(tmpDir, { projectId: "test-project" });
    expect(fs.readFileSync(agentsPath, "utf8")).toBe("ORIGINAL");
  });
});

// ─── interview.mjs delegation ─────────────────────────────────────────────────

describe("interview.mjs delegation", () => {
  it("runInterview completion delegates to generateProjectFiles (no inline generation)", async () => {
    const interviewModule = await import("../../packages/mcp-rks/src/server/interview.mjs");
    const src = fs.readFileSync(
      new URL("../../packages/mcp-rks/src/server/interview.mjs", import.meta.url),
      "utf8"
    );
    expect(src).toContain("generateProjectFiles");
    expect(src).not.toContain("fs.writeFileSync(path.join(notesDir");
  });
});
