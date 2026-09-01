/**
 * backlog.fix.autoroute-substitutes-llm-for-deterministic-retrieval — structural coverage.
 *
 * When the governor token check rejects a protected tool, the server used to hand the call to
 * an LLM agent and return the agent's prose AS IF it were the tool's own result. For
 * `rks_exhaustive_search` that converts a deterministic literal search into a hallucination
 * wearing the same return shape: `ok: true`, plus an appended `_autoRouted` field that a caller
 * checking `ok` will never look at.
 *
 * The fix is a deletion — an unmapped tool already falls through to an honest refusal. This
 * file pins the map's contents so that (a) the three retrieval tools cannot come back, and
 * (b) over-deletion fails as loudly as under-deletion.
 */
import { describe, it, expect } from "vitest";
import { TOOL_TO_AGENT_MAP } from "../../packages/mcp-rks/src/server.mjs";

const RETRIEVAL_TOOLS = ["rks_exhaustive_search", "rks_rag_query", "rks_kg_query"];

describe("retrieval tools are not in the auto-route map", () => {
  it.each(RETRIEVAL_TOOLS)("%s has no map entry", (tool) => {
    expect(TOOL_TO_AGENT_MAP[tool]).toBeUndefined();
  });

  it("no entry routes to the research agent at all", () => {
    // The research agent is the LLM substitute. Nothing deterministic may route to it, so this
    // catches a future entry pointed at it under a different tool name.
    const routedToResearch = Object.entries(TOOL_TO_AGENT_MAP)
      .filter(([, v]) => v?.agent === "research")
      .map(([k]) => k);
    expect(routedToResearch).toEqual([]);
  });
});

describe("the map still routes everything it legitimately should", () => {
  it("pins the exact remaining key set", () => {
    // Deleting a map entry is easy to over-do. Asserting the full sorted set means removing a
    // git or dendron entry fails here just as loudly as re-adding a retrieval one.
    expect(Object.keys(TOOL_TO_AGENT_MAP).sort()).toEqual([
      "dendron_edit_note",
      "dendron_fix_frontmatter",
      "dendron_mark_implemented",
      "dendron_read_note",
      "dendron_update_field",
      "dendron_validate_schema",
      "dendron_create_note",
      "rks_agent_visual",
      "rks_branch_repair",
      "rks_checkout",
      "rks_cherry_pick",
      "rks_cycle_complete",
      "rks_git_branch",
      "rks_git_commit",
      "rks_git_merge",
      "rks_git_state",
      "rks_release",
      "rks_reset",
      "rks_resolve_conflict",
      "rks_revert",
      "rks_staging_merge",
      "rks_staging_pr",
      "rks_sync_staging",
      "rks_tag",
      "rks_validate_story",
    ].sort());
  });

  it("every surviving entry is well-formed", () => {
    for (const [tool, entry] of Object.entries(TOOL_TO_AGENT_MAP)) {
      expect(typeof entry.agent, `${tool}.agent`).toBe("string");
      expect(typeof entry.buildInput, `${tool}.buildInput`).toBe("function");
    }
  });

  it("dendron_create_note keeps its directHandler bypass", () => {
    // The verbatim-write precedent from backlog.fix.dendron-agent-rewrites-content. It is the
    // existing answer to this same bug class for one tool, and must not be collateral damage.
    expect(TOOL_TO_AGENT_MAP.dendron_create_note.directHandler).toBe("dendron_create_note");
  });
});
