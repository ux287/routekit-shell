/**
 * Tests for rks_onboarder Phase 4 — Stage 7, telemetry completion/abandoned, verbosity detection.
 * (backlog.feat.rks-onboarder-impl-phase4)
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
  STAGES,
} from "../../packages/mcp-rks/src/server/onboarder.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarder-p4-test-"));
  fs.mkdirSync(path.join(tmpDir, ".rks"), { recursive: true });
  vi.clearAllMocks();
  // Clear RKS_VERBOSITY env var between tests
  delete process.env.RKS_VERBOSITY;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RKS_VERBOSITY;
});

// ─── Stage 7 display ──────────────────────────────────────────────────────────

describe("Stage 7 display (next_steps)", () => {
  it("contains slash command reference (/po, /build, /ship, /research, /release)", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("/po");
    expect(result.display).toContain("/build");
    expect(result.display).toContain("/ship");
    expect(result.display).toContain("/research");
    expect(result.display).toContain("/release");
  });

  it("contains UX287 callout", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("UX287");
  });

  it("contains 0.x maturity note with pin-to-tag guidance", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("0.x");
    expect(result.display).toContain("Pin");
  });

  it("contains papers-worth-reading list", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("Papers worth reading");
    expect(result.display).toContain("child-project-kickoff");
  });

  it("contains session summary panel with storyId placeholder when none completed", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("Session summary");
    expect(result.display).toContain("none (stages skipped)");
  });

  it("summary panel shows real storyId when first_story was completed", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now() - 60000,
      lastTouchedAt: Date.now(),
      completedStages: STAGES.filter((s) => s !== "next_steps"),
      currentStage: "next_steps",
      projectId: "test",
      responses: {
        first_story: { storyId: "backlog.feat.hello-world" },
        first_build: { rawCost: 0.0042 },
        first_ship: { prUrl: "https://github.com/test/repo/pull/1", prState: "open" },
      },
    });
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("backlog.feat.hello-world");
    expect(result.display).toContain("https://github.com/test/repo/pull/1");
  });
});

// ─── Stage 7 completedAt write ────────────────────────────────────────────────

describe("Stage 7 completedAt", () => {
  it("writes onboarder.completedAt to .rks/project.json", async () => {
    fs.writeFileSync(path.join(tmpDir, ".rks/project.json"), JSON.stringify({ id: "test" }), "utf8");
    const before = Date.now();
    await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    const proj = JSON.parse(fs.readFileSync(path.join(tmpDir, ".rks/project.json"), "utf8"));
    expect(typeof proj.onboarder?.completedAt).toBe("number");
    expect(proj.onboarder.completedAt).toBeGreaterThanOrEqual(before);
  });

  it("writes onboarder.completedVersion to .rks/project.json", async () => {
    fs.writeFileSync(path.join(tmpDir, ".rks/project.json"), JSON.stringify({ id: "test" }), "utf8");
    await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    const proj = JSON.parse(fs.readFileSync(path.join(tmpDir, ".rks/project.json"), "utf8"));
    expect(proj.onboarder?.completedVersion).toBeTruthy();
  });
});

// ─── onboarder.completed telemetry ───────────────────────────────────────────

describe("onboarder.completed telemetry", () => {
  it("emits onboarder.completed with totalDurationSeconds, storiesShipped, stagesSkipped, totalTokens", async () => {
    await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    const completed = recordTelemetry.mock.calls.filter(
      ([, p]) => p.slug === "onboarder.completed"
    );
    expect(completed).toHaveLength(1);
    const m = completed[0][1].metrics;
    expect(m).toHaveProperty("totalDurationSeconds");
    expect(m).toHaveProperty("storiesShipped");
    expect(m).toHaveProperty("stagesSkipped");
    expect(m).toHaveProperty("totalTokens");
  });

  it("storiesShipped is 1 when first_ship completed with prUrl", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now() - 60000,
      lastTouchedAt: Date.now(),
      completedStages: STAGES.filter((s) => s !== "next_steps"),
      currentStage: "next_steps",
      projectId: "test",
      responses: {
        first_story: { storyId: "backlog.feat.test" },
        first_ship: { prUrl: "https://github.com/test/repo/pull/1" },
      },
    });
    await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    const completed = recordTelemetry.mock.calls.filter(([, p]) => p.slug === "onboarder.completed");
    expect(completed[0][1].metrics.storiesShipped).toBe(1);
  });

  it("storiesShipped is 0 when stages were skipped (no ship data)", async () => {
    await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    const completed = recordTelemetry.mock.calls.filter(([, p]) => p.slug === "onboarder.completed");
    expect(completed[0][1].metrics.storiesShipped).toBe(0);
  });
});

// ─── Cost summary display ─────────────────────────────────────────────────────

describe("Stage 7 cost summary", () => {
  it("shows dollar amount and footnote when rawCost is present in state", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: [],
      currentStage: "next_steps",
      projectId: "test",
      responses: { first_build: { rawCost: 0.0042 } },
    });
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("$0.0042");
    expect(result.display).toContain("Approximate; actual cost depends on your Anthropic plan");
  });

  it("shows tokens and model name when no rawCost but inputTokens+modelName present with no rate card entry", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: [],
      currentStage: "next_steps",
      projectId: "test",
      responses: {
        first_build: { inputTokens: 5000, outputTokens: 1000, modelName: "claude-unknown-v99" },
      },
    });
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("6000 tokens");
    expect(result.display).toContain("claude-unknown-v99");
    expect(result.display).not.toMatch(/\$\d+\.\d+/);
  });

  it("shows dollar amount computed from rate card when known modelName+tokens provided", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
      completedStages: [],
      currentStage: "next_steps",
      projectId: "test",
      responses: {
        first_build: { inputTokens: 100000, outputTokens: 10000, modelName: "claude-sonnet-4-6" },
      },
    });
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    // 100k * 3/1e6 + 10k * 15/1e6 = 0.3 + 0.15 = 0.45
    expect(result.display).toContain("$0.4500");
    expect(result.display).toContain("Approximate; actual cost depends on your Anthropic plan");
  });

  it("shows 'not recorded' when no build data", async () => {
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "next_steps" });
    expect(result.display).toContain("not recorded");
  });
});

// ─── Abandoned inference ──────────────────────────────────────────────────────

describe("abandoned inference", () => {
  const STALE_MS = 25 * 60 * 60 * 1000; // 25 hours ago

  it("emits onboarder.abandoned when lastTouchedAt > 24h ago and completedAt absent", async () => {
    const staleTime = Date.now() - STALE_MS;
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: staleTime - 1000,
      lastTouchedAt: staleTime,
      completedStages: ["welcome"],
      currentStage: "expectations",
      projectId: "test",
    });
    // Override lastTouchedAt directly since saveOnboarderState updates it
    const statePath = path.join(tmpDir, ".rks/onboarder-state.json");
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    s.lastTouchedAt = staleTime;
    fs.writeFileSync(statePath, JSON.stringify(s, null, 2));

    await runOnboarder({ projectRoot: tmpDir, stage: "expectations" });
    const abandoned = recordTelemetry.mock.calls.filter(([, p]) => p.slug === "onboarder.abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0][1].metrics).toHaveProperty("stuckAt");
    expect(abandoned[0][1].metrics).toHaveProperty("lastTouchedAt");
  });

  it("does NOT emit onboarder.abandoned when lastTouchedAt is within 24 hours", async () => {
    saveOnboarderState(tmpDir, {
      version: 1,
      startedAt: Date.now() - 3600000,
      lastTouchedAt: Date.now() - 3600000,
      completedStages: ["welcome"],
      currentStage: "expectations",
      projectId: "test",
    });
    await runOnboarder({ projectRoot: tmpDir, stage: "expectations" });
    const abandoned = recordTelemetry.mock.calls.filter(([, p]) => p.slug === "onboarder.abandoned");
    expect(abandoned).toHaveLength(0);
  });

  it("does NOT emit onboarder.abandoned when abandonedEmitted:true is already in state", async () => {
    const staleTime = Date.now() - STALE_MS;
    const statePath = path.join(tmpDir, ".rks/onboarder-state.json");
    const staleState = {
      version: 1,
      startedAt: staleTime - 1000,
      lastTouchedAt: staleTime,
      completedStages: ["welcome"],
      currentStage: "expectations",
      projectId: "test",
      abandonedEmitted: true,
    };
    fs.writeFileSync(statePath, JSON.stringify(staleState, null, 2));
    await runOnboarder({ projectRoot: tmpDir, stage: "expectations" });
    const abandoned = recordTelemetry.mock.calls.filter(([, p]) => p.slug === "onboarder.abandoned");
    expect(abandoned).toHaveLength(0);
  });

  it("sets abandonedEmitted:true in state after emitting", async () => {
    const staleTime = Date.now() - STALE_MS;
    const statePath = path.join(tmpDir, ".rks/onboarder-state.json");
    const staleState = {
      version: 1,
      startedAt: staleTime - 1000,
      lastTouchedAt: staleTime,
      completedStages: ["welcome"],
      currentStage: "expectations",
      projectId: "test",
    };
    fs.writeFileSync(statePath, JSON.stringify(staleState, null, 2));
    await runOnboarder({ projectRoot: tmpDir, stage: "expectations" });
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(saved.abandonedEmitted).toBe(true);
  });
});

// ─── Verbosity detection ──────────────────────────────────────────────────────

describe("verbosity detection in handleWelcome", () => {
  it("presents verbose-switch prompt when project verbosity is non-verbose", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".rks/project.json"),
      JSON.stringify({ verbosity: "brief" }),
      "utf8"
    );
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    expect(result.display).toContain("verbose mode for this onboarding session");
    expect(result.display).toContain("brief");
  });

  it("skips verbosity prompt when project verbosity is already verbose", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".rks/project.json"),
      JSON.stringify({ verbosity: "verbose" }),
      "utf8"
    );
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    expect(result.display).not.toContain("verbose mode for this onboarding session");
  });

  it("treats missing verbosity config as verbose — skips the prompt", async () => {
    // No project.json at all
    const result = await runOnboarder({ projectRoot: tmpDir, stage: "welcome" });
    expect(result.display).not.toContain("verbose mode for this onboarding session");
  });

  it("captures verbosityChoice:yes and sets sessionVerbose:true in state", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "welcome",
      responses: { verbosityChoice: "yes" },
    });
    expect(result.state.responses?.verbosityChoice).toBe("yes");
    expect(result.state.sessionVerbose).toBe(true);
  });

  it("captures verbosityChoice:no and does NOT set sessionVerbose", async () => {
    const result = await runOnboarder({
      projectRoot: tmpDir,
      stage: "welcome",
      responses: { verbosityChoice: "no" },
    });
    expect(result.state.responses?.verbosityChoice).toBe("no");
    expect(result.state.sessionVerbose).toBeFalsy();
  });
});
