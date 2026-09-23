/**
 * Tests for Lifecycle Agent — composite story automation
 *
 * @see backlog.agents.full-lifecycle-composite
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  LifecycleInputSchema,
  LifecycleOutputSchema,
  createLifecycleAgent,
} from "../../../packages/mcp-rks/src/agents/lifecycle.mjs";

// Mock agent config loader
vi.mock("../../../packages/mcp-rks/src/agents/config.mjs", () => ({
  loadAgentConfig: () => ({
    model: "claude-sonnet-4-20250514",
    maxTurns: 12,
    timeoutMs: 300000,
    prompt: null,
  }),
}));

// Mock runner
vi.mock("../../../packages/mcp-rks/src/agents/runner.mjs", () => ({
  runAgent: vi.fn(),
}));

// Mock story agent
vi.mock("../../../packages/mcp-rks/src/agents/story.mjs", () => ({
  createStoryAgent: vi.fn(() => ({ name: "story-mock" })),
}));

// Mock ship agent
vi.mock("../../../packages/mcp-rks/src/agents/ship.mjs", () => ({
  createShipAgent: vi.fn(() => ({ name: "ship-mock" })),
}));

// Mock cycle-complete agent
vi.mock("../../../packages/mcp-rks/src/agents/cycle-complete.mjs", () => ({
  createCycleCompleteAgent: vi.fn(() => ({ name: "cycle-mock" })),
}));

const { runAgent } = await import(
  "../../../packages/mcp-rks/src/agents/runner.mjs"
);
const { createStoryAgent } = await import(
  "../../../packages/mcp-rks/src/agents/story.mjs"
);
const { createShipAgent } = await import(
  "../../../packages/mcp-rks/src/agents/ship.mjs"
);
const { createCycleCompleteAgent } = await import(
  "../../../packages/mcp-rks/src/agents/cycle-complete.mjs"
);

describe("Lifecycle Agent", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-lifecycle-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("LifecycleInputSchema", () => {
    it("requires projectId and storyId", () => {
      const result = LifecycleInputSchema.safeParse({
        projectId: "test",
        storyId: "backlog.agents.foo",
      });
      expect(result.success).toBe(true);
    });

    it("defaults mode to full", () => {
      const result = LifecycleInputSchema.parse({
        projectId: "test",
        storyId: "backlog.agents.foo",
      });
      expect(result.mode).toBe("full");
    });

    it("accepts all valid modes", () => {
      for (const mode of ["full", "draft", "plan", "ship", "resume"]) {
        const result = LifecycleInputSchema.safeParse({
          projectId: "test",
          storyId: "backlog.agents.foo",
          mode,
        });
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid modes", () => {
      const result = LifecycleInputSchema.safeParse({
        projectId: "test",
        storyId: "backlog.agents.foo",
        mode: "invalid",
      });
      expect(result.success).toBe(false);
    });

    it("accepts approvalGates configuration", () => {
      const result = LifecycleInputSchema.safeParse({
        projectId: "test",
        storyId: "backlog.agents.foo",
        approvalGates: { plan: false, exec: true, ship: false },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("createLifecycleAgent", () => {
    it("creates agent config with correct name", () => {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.my-story",
        projectRoot: tmpDir,
      });
      expect(config.name).toBe("lifecycle");
      expect(config.projectId).toBe("test");
    });

    it("includes storyId in user message", () => {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.my-story",
        projectRoot: tmpDir,
      });
      expect(config.userMessage).toContain("backlog.agents.my-story");
    });

    it("includes mode in user message", () => {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.foo",
        mode: "draft",
        projectRoot: tmpDir,
      });
      expect(config.userMessage).toContain("Mode: draft");
      expect(config.userMessage).toContain("Draft mode");
    });

    it("includes approval gate info in full mode", () => {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.foo",
        mode: "full",
        projectRoot: tmpDir,
      });
      // Default gate: plan is enabled
      expect(config.userMessage).toContain("Approval gates enabled at: plan");
    });

    it("reports no gates when all disabled", () => {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.foo",
        mode: "full",
        approvalGates: { plan: false },
        projectRoot: tmpDir,
      });
      expect(config.userMessage).toContain("No approval gates");
    });

    it("provides 6 tools", () => {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.foo",
        projectRoot: tmpDir,
      });
      expect(config.tools).toHaveLength(6);
      const toolNames = config.tools.map((t) => t.name);
      expect(toolNames).toContain("check_phase");
      expect(toolNames).toContain("validate_story");
      expect(toolNames).toContain("run_plan");
      expect(toolNames).toContain("run_exec");
      expect(toolNames).toContain("ship_changes");
      expect(toolNames).toContain("complete_cycle");
    });
  });

  describe("tools", () => {
    function getTools(overrides = {}) {
      const config = createLifecycleAgent({
        projectId: "test",
        storyId: "backlog.agents.my-story",
        projectRoot: tmpDir,
        ...overrides,
      });
      const toolMap = {};
      for (const t of config.tools) toolMap[t.name] = t;
      return toolMap;
    }

    function seedCheckpoint(phases, artifacts = {}) {
      const cpDir = path.join(tmpDir, ".rks", "lifecycle");
      fs.mkdirSync(cpDir, { recursive: true });
      fs.writeFileSync(
        path.join(cpDir, "backlog-agents-my-story.json"),
        JSON.stringify({
          completedPhases: phases,
          currentPhase: phases[phases.length - 1] || "validate",
          lastUpdated: new Date().toISOString(),
          artifacts,
        })
      );
    }

    describe("check_phase", () => {
      it("returns empty state when no checkpoint exists", async () => {
        const tools = getTools();
        const result = await tools.check_phase.execute({});
        expect(result.hasCheckpoint).toBe(false);
        expect(result.completedPhases).toEqual([]);
        expect(result.currentPhase).toBe("validate");
      });

      it("reads existing checkpoint", async () => {
        const cpDir = path.join(tmpDir, ".rks", "lifecycle");
        fs.mkdirSync(cpDir, { recursive: true });
        fs.writeFileSync(
          path.join(cpDir, "backlog-agents-my-story.json"),
          JSON.stringify({
            completedPhases: ["validate", "plan"],
            currentPhase: "exec",
            lastUpdated: "2026-01-01T00:00:00Z",
            artifacts: { plan: { slug: "my-story" } },
          })
        );

        const tools = getTools();
        const result = await tools.check_phase.execute({});
        expect(result.hasCheckpoint).toBe(true);
        expect(result.completedPhases).toEqual(["validate", "plan"]);
        expect(result.currentPhase).toBe("exec");
        expect(result.artifacts.plan.slug).toBe("my-story");
      });
    });

    describe("validate_story", () => {
      it("delegates to Story Agent", async () => {
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: {
            validation: {
              verdict: "pass",
              quality: 0.85,
              completeness: 0.9,
              gaps: [],
            },
          },
        });

        const tools = getTools();
        const result = await tools.validate_story.execute({});

        expect(createStoryAgent).toHaveBeenCalledWith({
          projectId: "test",
          storyId: "backlog.agents.my-story",
          action: "validate",
          projectRoot: tmpDir,
        });
        expect(runAgent).toHaveBeenCalledOnce();
        expect(result.ok).toBe(true);
        expect(result.verdict).toBe("pass");
        expect(result.quality).toBe(0.85);
      });

      it("saves checkpoint on success", async () => {
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: { validation: { verdict: "pass", quality: 0.8, gaps: [] } },
        });

        const tools = getTools();
        await tools.validate_story.execute({});

        const cpPath = path.join(
          tmpDir,
          ".rks",
          "lifecycle",
          "backlog-agents-my-story.json"
        );
        expect(fs.existsSync(cpPath)).toBe(true);
        const cp = JSON.parse(fs.readFileSync(cpPath, "utf8"));
        expect(cp.completedPhases).toContain("validate");
        expect(cp.currentPhase).toBe("plan");
      });

      it("returns error on failure", async () => {
        runAgent.mockResolvedValueOnce({
          ok: false,
          error: "Story has gaps",
        });

        const tools = getTools();
        const result = await tools.validate_story.execute({});
        expect(result.ok).toBe(false);
      });
    });

    describe("ship_changes", () => {
      it("delegates to Ship Agent", async () => {
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: {
            prUrl: "https://github.com/test/pr/1",
            prNumber: 1,
            merged: true,
            branch: "rks/my-story",
          },
        });

        // mode: 'ship' bypasses circuit breaker and zero-files guard
        const tools = getTools({ mode: "ship" });
        const result = await tools.ship_changes.execute({});

        expect(createShipAgent).toHaveBeenCalledWith({
          projectId: "test",
          storyId: "backlog.agents.my-story",
          projectRoot: tmpDir,
        });
        expect(result.ok).toBe(true);
        expect(result.prUrl).toBe("https://github.com/test/pr/1");
        expect(result.merged).toBe(true);
      });

      it("returns approval gate when configured", async () => {
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: {
            prUrl: "https://github.com/test/pr/2",
            prNumber: 2,
          },
        });

        // mode: 'ship' bypasses circuit breaker and zero-files guard
        const tools = getTools({ mode: "ship", approvalGates: { ship: true } });
        const result = await tools.ship_changes.execute({});

        expect(result.ok).toBe(true);
        expect(result.needsApproval).toBe(true);
        expect(result.phase).toBe("ship");
      });
    });

    describe("complete_cycle", () => {
      it("delegates to Cycle Complete Agent", async () => {
        seedCheckpoint(["validate", "plan", "exec", "ship"]);
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: {
            storyUpdated: true,
            epicUpdated: true,
            governancePassed: true,
          },
        });

        const tools = getTools();
        const result = await tools.complete_cycle.execute({ prNumber: 42 });

        expect(createCycleCompleteAgent).toHaveBeenCalledWith({
          projectId: "test",
          storyId: "backlog.agents.my-story",
          prNumber: 42,
          projectRoot: tmpDir,
        });
        expect(result.ok).toBe(true);
        expect(result.storyUpdated).toBe(true);
      });
    });

    describe("checkpoint accumulation", () => {
      it("accumulates phases across tool calls", async () => {
        // Validate
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: { validation: { verdict: "pass", quality: 0.8, gaps: [] } },
        });
        // mode: 'ship' bypasses circuit breaker and zero-files guard on ship_changes
        const tools = getTools({ mode: "ship" });
        await tools.validate_story.execute({});

        // Ship
        runAgent.mockResolvedValueOnce({
          ok: true,
          data: { prUrl: "https://github.com/pr/1", prNumber: 1, merged: true },
        });
        await tools.ship_changes.execute({});

        // Check accumulated state
        const cpPath = path.join(
          tmpDir,
          ".rks",
          "lifecycle",
          "backlog-agents-my-story.json"
        );
        const cp = JSON.parse(fs.readFileSync(cpPath, "utf8"));
        expect(cp.completedPhases).toContain("validate");
        expect(cp.completedPhases).toContain("ship");
        expect(cp.artifacts.validation).toBeDefined();
        expect(cp.artifacts.ship).toBeDefined();
      });
    });
  });
});
