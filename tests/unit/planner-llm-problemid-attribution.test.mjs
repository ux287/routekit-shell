/**
 * Caller-chain attribution witness (backlog.fix.token-cost-telemetry-null-schema).
 *
 * The token emitter (clients.mjs) already reads context.problemId and puts it at the event
 * payload top-level — but on the hot path it was ALWAYS undefined, because the caller
 * invokeLlmPlanner called runLlmPlanner with NO llmContext (defaulting to {}), so problemId
 * never reached the client `context`. Fixing only the emitter is a no-op for attribution;
 * the real defect is the missing forwarding in planner-llm.mjs.
 *
 * This exercises the REAL caller (invokeLlmPlanner) with runLlmPlanner mocked at the seam,
 * and asserts invokeLlmPlanner threads { problemId: slug, projectId } into the runLlmPlanner
 * llmContext — the exact value runLlmPlanner forwards as the client `context` (planner.mjs)
 * and the emitter consumes. It REDDENS on the pre-fix code: without the planner-llm.mjs edit
 * `arg.llmContext` is undefined, so token events bucket to '(off-rail)'.
 *
 * (The end-to-end emitter->reader half — that a supplied problemId survives to a non-null
 * story cost — is covered by tests/unit/token-cost-emitter-reader-seam.test.mjs.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../packages/mcp-rks/src/llm/planner.mjs", () => ({
  runLlmPlanner: vi.fn().mockResolvedValue({ status: "note_only", actions: [] }),
}));

import { invokeLlmPlanner } from "../../packages/mcp-rks/src/server/planner-llm.mjs";
import { runLlmPlanner } from "../../packages/mcp-rks/src/llm/planner.mjs";

describe("planner-llm caller-chain problemId attribution", () => {
  const PROBLEM_ID = "backlog.fix.token-cost-telemetry-null-schema";
  const PROJECT_ID = "routekit-shell";

  beforeEach(() => {
    runLlmPlanner.mockClear();
  });

  it("invokeLlmPlanner threads { problemId: slug, projectId } into the runLlmPlanner llmContext", async () => {
    await invokeLlmPlanner({
      enhancedRequirements: "r",
      planningText: "t",
      planningSource: "s",
      enhancedEditableTargets: [],
      contextualRefs: [],
      plannerMode: "full",
      runFolder: null,
      slug: PROBLEM_ID,
      projectId: PROJECT_ID,
    });

    expect(runLlmPlanner).toHaveBeenCalledTimes(1);
    const arg = runLlmPlanner.mock.calls[0][0];

    // The wiring that was missing: without it, arg.llmContext is undefined and problemId
    // never reaches the token emitter -> cost buckets to '(off-rail)' in both readers.
    expect(arg.llmContext, "invokeLlmPlanner must forward an llmContext for token attribution").toBeDefined();
    expect(arg.llmContext.problemId).toBe(PROBLEM_ID); // slug === problemId
    expect(arg.llmContext.projectId).toBe(PROJECT_ID);
  });
});
