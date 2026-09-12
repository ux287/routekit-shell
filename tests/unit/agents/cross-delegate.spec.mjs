/**
 * Tests for cross-delegation infrastructure
 *
 * @see backlog.agents.agent-cross-delegation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCrossDelegationTool,
  createDelegationCounter,
} from "../../../packages/mcp-rks/src/agents/cross-delegate.mjs";
import { z } from "zod";

// Mock runAgent to avoid real API calls
vi.mock("../../../packages/mcp-rks/src/agents/runner.mjs", () => ({
  runAgent: vi.fn(),
}));


const { runAgent } = await import(
  "../../../packages/mcp-rks/src/agents/runner.mjs"
);

describe("cross-delegate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createDelegationCounter", () => {
    it("creates a counter with default max of 3", () => {
      const counter = createDelegationCounter();
      expect(counter.count).toBe(0);
      expect(counter.max).toBe(3);
    });

    it("creates a counter with custom max", () => {
      const counter = createDelegationCounter(5);
      expect(counter.max).toBe(5);
    });
  });

  describe("createCrossDelegationTool", () => {
    const baseOpts = {
      sourceAgent: "test-source",
      targetAgent: "test-target",
      toolName: "test_delegate",
      description: "Test delegation tool",
      inputSchema: z.object({
        query: z.string(),
      }),
      createTarget: (input) => ({
        name: "test-target",
        prompt: "test",
        userMessage: input.query,
        tools: [],
        inputSchema: z.object({}),
        rawInput: {},
        projectId: "test",
      }),
      projectId: "test-project",
      projectRoot: "/tmp/test",
    };

    it("creates a tool with the correct name and description", () => {
      const { tool } = createCrossDelegationTool(baseOpts);
      expect(tool.name).toBe("test_delegate");
      expect(tool.description).toBe("Test delegation tool");
    });

    it("creates a shared counter if none provided", () => {
      const { counter } = createCrossDelegationTool(baseOpts);
      expect(counter.count).toBe(0);
      expect(counter.max).toBe(3);
    });

    it("uses provided counter", () => {
      const sharedCounter = createDelegationCounter(5);
      const { counter } = createCrossDelegationTool({
        ...baseOpts,
        counter: sharedCounter,
      });
      expect(counter).toBe(sharedCounter);
      expect(counter.max).toBe(5);
    });

    it("calls runAgent and returns result on success", async () => {
      const mockResult = {
        ok: true,
        answer: "test answer",
        telemetryId: "t-123",
      };
      runAgent.mockResolvedValueOnce(mockResult);

      const { tool } = createCrossDelegationTool(baseOpts);
      const result = await tool.execute({ query: "test question" });

      expect(runAgent).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      expect(result.answer).toBe("test answer");
    });

    it("increments counter on each call", async () => {
      runAgent.mockResolvedValue({ ok: true });

      const counter = createDelegationCounter(5);
      const { tool } = createCrossDelegationTool({
        ...baseOpts,
        counter,
      });

      await tool.execute({ query: "q1" });
      expect(counter.count).toBe(1);

      await tool.execute({ query: "q2" });
      expect(counter.count).toBe(2);
    });

    it("enforces maxCrossDelegations limit", async () => {
      runAgent.mockResolvedValue({ ok: true });

      const counter = createDelegationCounter(2);
      const { tool } = createCrossDelegationTool({
        ...baseOpts,
        counter,
      });

      // First two calls succeed
      await tool.execute({ query: "q1" });
      await tool.execute({ query: "q2" });
      expect(counter.count).toBe(2);

      // Third call is blocked
      const result = await tool.execute({ query: "q3" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cross-delegation limit reached");
      expect(result.error).toContain("2/2");
      expect(runAgent).toHaveBeenCalledTimes(2); // NOT 3
    });

    it("shares counter across multiple tools", async () => {
      runAgent.mockResolvedValue({ ok: true });

      const counter = createDelegationCounter(2);

      const { tool: tool1 } = createCrossDelegationTool({
        ...baseOpts,
        toolName: "delegate_a",
        counter,
      });
      const { tool: tool2 } = createCrossDelegationTool({
        ...baseOpts,
        toolName: "delegate_b",
        targetAgent: "other-target",
        counter,
      });

      await tool1.execute({ query: "q1" });
      expect(counter.count).toBe(1);

      await tool2.execute({ query: "q2" });
      expect(counter.count).toBe(2);

      // Third call on either tool is blocked
      const result = await tool1.execute({ query: "q3" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cross-delegation limit reached");
    });

    it("returns structured error on runAgent failure", async () => {
      runAgent.mockResolvedValueOnce({
        ok: false,
        error: "Agent timed out",
        telemetryId: "t-456",
      });

      const { tool } = createCrossDelegationTool(baseOpts);
      const result = await tool.execute({ query: "test" });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Agent timed out");
    });

    it("catches thrown errors and returns structured error", async () => {
      runAgent.mockRejectedValueOnce(new Error("Network failure"));

      const { tool } = createCrossDelegationTool(baseOpts);
      const result = await tool.execute({ query: "test" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Cross-delegation to test-target failed");
      expect(result.error).toContain("Network failure");
    });

    it("passes correct config to createTarget", async () => {
      const createTarget = vi.fn().mockReturnValue({
        name: "mock",
        prompt: "mock",
        userMessage: "mock",
        tools: [],
        inputSchema: z.object({}),
        rawInput: {},
        projectId: "test",
      });
      runAgent.mockResolvedValueOnce({ ok: true });

      const { tool } = createCrossDelegationTool({
        ...baseOpts,
        createTarget,
      });
      await tool.execute({ query: "architecture question" });

      expect(createTarget).toHaveBeenCalledWith({
        query: "architecture question",
      });
    });
  });

  describe("DAG enforcement by construction", () => {
    it("tools have explicit source/target — no generic delegation", () => {
      const { tool } = createCrossDelegationTool({
        sourceAgent: "planner",
        targetAgent: "research",
        toolName: "research_architecture",
        description: "Research delegation",
        inputSchema: z.object({ query: z.string() }),
        createTarget: () => ({}),
        projectId: "test",
        projectRoot: "/tmp",
      });

      // The tool is named and scoped — no way to call an arbitrary agent
      expect(tool.name).toBe("research_architecture");
      // No "agent" parameter in the schema — the target is fixed
      expect(tool.inputSchema._def.shape().agent).toBeUndefined();
    });
  });
});
