import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../../packages/mcp-rks/src/agents/runner.mjs";

// Ported from the retired node:test suite packages/mcp-rks/__tests__/agent-runner.spec.mjs
// (`Agent Runner` block, the `_testClient`-driven message-forwarding cases plus the two hermetic
// input-validation cases; ran in no CI tier). backlog.chore.retire-agent-runner-node-test-spec.
//
// scripts/backlog-archive-manifest.json evidence for backlog.feat.escalation-history-passthrough
// points at the first it( line below; keep that line verbatim.

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-20250514";
const usage = (i, o) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const VALID = '{"ok":true,"answer":"done","sources":[],"confidence":0.9}';
const OutputSchema = z.object({ ok: z.boolean(), answer: z.string(), sources: z.array(z.any()), confidence: z.number() });

describe("runAgent max-turns escalation message forwarding", () => {
  it("forwards accumulated messages to escalated call on max_turns_exceeded", async () => {
    let callCount = 0;
    let escalatedMessages = null;
    const mockClient = {
      messages: {
        create: async ({ messages: msgs }) => {
          callCount++;
          if (callCount === 1) {
            // Primary: a tool_use response exhausts maxTurns=1
            return {
              content: [{ type: "tool_use", id: "tu1", name: "test_tool", input: { x: 1 } }],
              stop_reason: "tool_use",
              usage: usage(10, 5),
            };
          }
          // Escalated call: capture what it received, return a valid answer
          escalatedMessages = [...msgs];
          return { content: [{ type: "text", text: VALID }], stop_reason: "end_turn", usage: usage(50, 20) };
        },
      },
    };

    const result = await runAgent({
      name: "test-history-passthrough",
      prompt: "You are a test agent.",
      userMessage: "Original question",
      tools: [{
        name: "test_tool",
        description: "A test tool",
        inputSchema: z.object({ x: z.number() }),
        execute: async () => ({ result: "tool ran" }),
      }],
      inputSchema: z.object({ q: z.string() }),
      outputSchema: OutputSchema,
      rawInput: { q: "hello" },
      model: HAIKU,
      fallbackModel: SONNET,
      maxTurns: 1,
      projectId: "test",
      _testClient: mockClient,
    });

    expect(callCount).toBe(2);
    expect(escalatedMessages).toBeTruthy();
    expect(escalatedMessages.length).toBeGreaterThan(1);
    expect(escalatedMessages[0].role).toBe("user");
    // Conversation-prefix caching (backlog.fix.conversation-prefix-caching) puts the initial user
    // message in block form; on the _resumeMessages path it must stay a SINGLE text block.
    expect(Array.isArray(escalatedMessages[0].content)).toBe(true);
    expect(escalatedMessages[0].content).toHaveLength(1);
    expect(escalatedMessages[0].content[0].type).toBe("text");
    expect(escalatedMessages[0].content[0].text).toContain("Original question");
    expect(escalatedMessages.some((m) => m.role === "assistant")).toBe(true);
    expect(result.ok).toBe(true);
    expect(result._escalated).toBeTruthy();
    expect(result._escalated.from).toBe(HAIKU);
  });

  it("does not forward messages to escalated call for non-max-turns failures", async () => {
    let callCount = 0;
    let laterCallMessages = null;
    const mockClient = {
      messages: {
        create: async ({ messages: msgs }) => {
          callCount++;
          if (callCount === 1) {
            // Primary: invalid JSON (an output failure, not max_turns)
            return { content: [{ type: "text", text: "not valid json at all" }], stop_reason: "end_turn", usage: usage(10, 5) };
          }
          laterCallMessages = [...msgs];
          return { content: [{ type: "text", text: VALID }], stop_reason: "end_turn", usage: usage(50, 20) };
        },
      },
    };

    await runAgent({
      name: "test-no-history-passthrough",
      prompt: "You are a test agent.",
      userMessage: "Original question",
      tools: [],
      inputSchema: z.object({ q: z.string() }),
      outputSchema: OutputSchema,
      rawInput: { q: "hello" },
      model: HAIKU,
      fallbackModel: SONNET,
      projectId: "test",
      _testClient: mockClient,
    });

    // The follow-up call sees only the original user message, never the failed attempt's history.
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(laterCallMessages).toBeTruthy();
    expect(laterCallMessages).toHaveLength(1);
    expect(laterCallMessages[0].role).toBe("user");
  });
});

describe("runAgent input validation", () => {
  // Input parsing precedes any model call; a client that counts calls proves none is made.
  const noCallClient = () => {
    const c = { calls: 0, messages: { create: async () => { c.calls++; throw new Error("no model call expected"); } } };
    return c;
  };

  it("fails fast with a structured failure on invalid input", async () => {
    const client = noCallClient();
    const result = await runAgent({
      name: "test-agent",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ required: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: {},
      projectId: "test",
      _testClient: client,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.telemetryId).toBeTruthy();
    expect(client.calls).toBe(0);
  });

  it("still records an escalation attempt when input validation fails and a distinct fallbackModel is set", async () => {
    const client = noCallClient();
    const result = await runAgent({
      name: "test-input-fail",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ required: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: {},
      model: HAIKU,
      fallbackModel: SONNET,
      projectId: "test",
      _testClient: client,
    });
    expect(result.ok).toBe(false);
    expect(result._escalated).toBeTruthy();
    expect(client.calls).toBe(0);
  });
});
