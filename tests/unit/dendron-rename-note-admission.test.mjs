// backlog.feat.dendron-rename-note-wikilinks — admission, schema and commit-verb tests (pure)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  OPEN_FLOW_TOOLS,
  STORY_FLOW_TOOLS,
  DENDRON_WRITE_TOOLS,
  isProtectedTool,
  assertToolAllowed,
  createSession,
  resetToken,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { getStates } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { buildDendronCommitMessage } from "../../packages/mcp-rks/src/shared/dendron-commit-message.mjs";
import { TOOL_AGENTS } from "../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs";
import {
  CHILD_RKS_ALLOW_TOOLS,
  CHILD_RKS_PROMPT_TOOLS,
  CHILD_RKS_ASK_RULES,
} from "../../packages/cli/src/project/child-permissions.mjs";
import { TOOL_ARG_SCHEMAS, TOOL_TO_AGENT_MAP, createServer } from "../../packages/mcp-rks/src/server.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TOOL = "dendron_rename_note";

describe("dendron_rename_note admission", () => {
  it("is open-flow only, a dendron write tool, and protected", () => {
    expect(OPEN_FLOW_TOOLS.has(TOOL)).toBe(true);
    expect(DENDRON_WRITE_TOOLS.has(TOOL)).toBe(true);
    expect(STORY_FLOW_TOOLS.has(TOOL)).toBe(false);
    expect(isProtectedTool(TOOL)).toBe(true);
  });

  it("has no TOOL_TO_AGENT_MAP entry, so an untokened call is never auto-routed", () => {
    expect(Object.prototype.hasOwnProperty.call(TOOL_TO_AGENT_MAP, TOOL)).toBe(false);
  });

  it("no non-open flow state admits it", () => {
    for (const flow of ["story", "qa", "ship", "ops"]) {
      for (const [state, def] of Object.entries(getStates(flow))) {
        expect(def.allowed?.has(TOOL) ?? false, `${flow}/${state}`).toBe(false);
      }
    }
  });

  it("in the open flow it is admitted exactly where dendron_edit_note is admitted and leads to writing; writing carries the writing transition", () => {
    const open = getStates("open");
    const admitting = [];
    for (const [state, def] of Object.entries(open)) {
      const editWrites = Boolean(def.allowed?.has("dendron_edit_note")) && def.transitions?.dendron_edit_note === "writing";
      expect(def.allowed?.has(TOOL) ?? false, `open/${state}`).toBe(editWrites);
      if (editWrites) admitting.push(state);
      // Never a transition anywhere but `writing` (init's edge set is pinned by governor-state.test.mjs AC9).
      if (state !== "writing") expect(def.transitions?.[TOOL], `open/${state} transition`).toBeUndefined();
    }
    expect(open.writing.transitions[TOOL]).toBe("writing");
    // Positive control: the rule is not vacuous.
    expect(admitting.sort()).toEqual(["init", "writing"]);
  });

  it("uses a registered commit verb", () => {
    expect(buildDendronCommitMessage(TOOL, "vendors.b")).not.toBe(buildDendronCommitMessage("__unknown_tool__", "vendors.b"));
    expect(buildDendronCommitMessage(TOOL, "vendors.b")).toBe("docs(notes): rename vendors.b");
  });

  it("TOOL_AGENTS.dendron_rename_note is []", () => {
    expect(TOOL_AGENTS[TOOL]).toEqual([]);
  });
});

describe("assertToolAllowed(dendron_rename_note)", () => {
  beforeEach(() => resetToken());
  afterEach(() => resetToken());

  it("refuses an untokened call as unauthorized", () => {
    expect(assertToolAllowed(null, TOOL)).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("refuses a story-flow session with chain_violation", () => {
    const { token } = createSession({ projectId: "proj-1", problemId: "story-1" });
    expect(assertToolAllowed(token, TOOL, { from: "docs.a.b", to: "vendors.b" })).toMatchObject({ ok: false, error: "chain_violation" });
  });

  it("admits an open-flow session in a state that admits dendron_edit_note, with no filename argument", () => {
    for (const state of ["init", "writing"]) {
      const { token } = createSession({ projectId: "proj-1", initialState: state });
      expect(assertToolAllowed(token, "dendron_edit_note", { filename: "x" }), `${state} control`).toBeNull();
      expect(assertToolAllowed(token, TOOL, { from: "docs.a.b", to: "vendors.b" }), state).toBeNull();
    }
  });
});

describe("dendron_rename_note schema", () => {
  const schema = TOOL_ARG_SCHEMAS[TOOL];

  it("rejects {} and a call missing to", () => {
    expect(schema).toBeDefined();
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ from: "docs.a.b" }).success).toBe(false);
  });

  it("accepts { from, to } with optional includeChildren and dryRun booleans", () => {
    expect(schema.safeParse({ from: "docs.a.b", to: "vendors.b" }).success).toBe(true);
    expect(schema.safeParse({ from: "docs.a.b", to: "vendors.b", includeChildren: true, dryRun: false }).success).toBe(true);
    expect(schema.safeParse({ from: "docs.a.b", to: "vendors.b", includeChildren: "yes" }).success).toBe(false);
    expect(schema.safeParse({ from: "docs.a.b", to: "vendors.b", dryRun: 1 }).success).toBe(false);
  });

  it("ListTools advertises dendron_rename_note with a _governorToken property", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === TOOL);
      expect(t).toBeDefined();
      expect(t.inputSchema.properties._governorToken).toBeDefined();
      expect(t.inputSchema.required).toEqual(["from", "to"]);
    } finally {
      await client.close();
    }
  });
});

describe("child permission classification", () => {
  it("CHILD_RKS_ALLOW_TOOLS contains mcp__rks__dendron_rename_note exactly once; PROMPT and ASK do not", () => {
    const name = "mcp__rks__dendron_rename_note";
    expect(CHILD_RKS_ALLOW_TOOLS.filter((t) => t === name).length).toBe(1);
    expect(Object.keys(CHILD_RKS_PROMPT_TOOLS)).not.toContain(name);
    expect(CHILD_RKS_ASK_RULES.some((r) => String(r).includes("dendron_rename_note"))).toBe(false);
  });
});
