/**
 * MCP Tool Contract Tests
 *
 * Tests the MCP protocol boundary — verifying that every tool listed in
 * ListTools has a handler in CallTool, input schemas reject bad data,
 * responses follow the universal format, and protection levels are correct.
 *
 * NOT testing business logic — that's for golden-run replays.
 *
 * Run: node --test __tests__/mcp-contract.spec.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createTestClient,
  closeTestClient,
  createTempFixture,
  cleanupTempFixture,
  callTool,
  callToolSafe,
} from "./mcp-contract-helpers.mjs";

// ── Canonical tool list ──────────────────────────────────────────────
// This list IS the contract. If a tool is added or removed, this test
// must be updated. That's intentional — it forces conscious decisions.

const EXPECTED_CORE_TOOLS = [
  // Project management
  "rks_project_get",
  "rks_kg_query",
  "rks_analyze",
  "rks_preflight",
  "rks_project_init",
  "rks_templates_list",
  "rks_story_create",
  "rks_init",

  // Planning & execution
  "rks_plan",
  "rks_plan_review",
  "rks_plan_ready",
  "rks_validate_story",
  "rks_exec",
  "rks_exec_abort",
  "rks_apply",
  "rks_approve",
  "rks_guardrails_simulate",

  // Git operations
  "rks_git_state",
  "rks_git_branch",
  "rks_checkout",
  "rks_branch_repair",
  "rks_git_commit",
  "rks_git_push",
  "rks_git_preflight",
  "rks_git_merge",
  "rks_stash",
  "rks_restore",
  "rks_reset",
  "rks_revert",
  "rks_tag",
  "rks_cherry_pick",
  "rks_sync_staging",
  "rks_resolve_conflict",
  "rks_release",

  // PR & merge workflow
  "rks_staging_pr",
  "rks_staging_merge",
  "rks_story_ship",
  "rks_promote",
  "rks_ship",
  "rks_review",

  // RAG
  "rks_rag_init",
  "rks_rag_embed",
  "rks_rag_query",
  "rks_exhaustive_search",
  "rks_rag_compact",

  // Dendron (notes)
  "dendron_create_note",
  "dendron_fix_frontmatter",
  "dendron_validate_schema",
  "dendron_edit_note",
  "dendron_read_note",
  "dendron_update_field",
  "dendron_mark_implemented",

  // Guardrails
  "rks_guardrails_off",
  "rks_guardrails_on",
  "rks_guardrails_status",

  // Telemetry
  "rks_telemetry_query",
  "rks_telemetry_report",
  "rks_token_cost_report",
  "rks_telemetry_export",
  "rks_fetch_raw",
  // Note: rks_telemetry_analysis has a handler but is only in capabilities, not ListTools

  // Refinement
  "rks_refine",
  "rks_refine_apply",

  // Lifecycle
  "rks_cycle_complete",

  // Other
  "rks_interview",
  "rks_onboarder",
  "rks_publish",
  "rks_publish_profiles",
  "rks_agent_external_research",

  // Governor
  "rks_governor_init",
];

const EXPECTED_AGENT_TOOLS = [
  "rks_agent_run",
  "rks_agent_validate_story",
  "rks_agent_research",
  "rks_agent_git",
  "rks_agent_dendron",
  "rks_agent_telemetry",
  "rks_agent_ship",
  "rks_agent_cycle_complete",
  "rks_agent_story",
  "rks_agent_delivery",
  "rks_agent_recovery",
  "rks_agent_plan",
];

const ALL_EXPECTED_TOOLS = [...EXPECTED_CORE_TOOLS, ...EXPECTED_AGENT_TOOLS];

// Tools that do NOT require a governor token. This mirrors the authoritative
// UNPROTECTED_TOOLS set in shared/governor-token.mjs (the single source the
// server's isProtectedTool / schema-injection both derive from). Keep in sync.
const UNPROTECTED_TOOLS = new Set([
  "rks_governor_init",
  "rks_guardrails_on",
  "rks_guardrails_status",
  "rks_project_get",
  "rks_preflight",
  "rks_telemetry_query",
  "rks_telemetry_report",
  "rks_telemetry_export",
  "rks_init",
  "rks_interview",
  "rks_onboarder",
  "rks_templates_list",
  "rks_story_create",
  "rks_rag_init",
  "rks_rag_embed",
  "rks_rag_query",
  "rks_rag_compact",
  "rks_exec_abort",
  "rks_ship",
  "rks_story_ship",
]);

// Tools that ARE unprotected (isProtectedTool === false) yet whose ListTools
// schema nonetheless advertises a _governorToken — a KNOWN, tracked contract
// gap, not an intended state.
//
// Currently empty. The prior rks_preflight entry was resolved by
// backlog.fix.rks-preflight-double-registration: the git-preflight tool was
// renamed from "rks_preflight" to "rks_git_preflight" (tools/git-preflight.mjs),
// eliminating the name collision. rks_preflight is now solely the unprotected
// project-preflight tool, with no _governorToken in its schema.
const KNOWN_PROTECTION_GAPS = new Set([]);

// ── Test lifecycle ───────────────────────────────────────────────────

let client;
let transport;
let tmpDir;

// ── Suite 1: Tool Registration Contract ──────────────────────────────

describe("Tool Registration Contract", async () => {
  before(async () => {
    tmpDir = createTempFixture();
    const conn = await createTestClient({ projectRoot: tmpDir });
    client = conn.client;
    transport = conn.transport;
  });

  after(async () => {
    await closeTestClient({ client, transport });
    cleanupTempFixture(tmpDir);
  });

  it("ListTools returns all expected core tools", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    const missing = EXPECTED_CORE_TOOLS.filter((t) => !names.has(t));
    assert.deepStrictEqual(
      missing,
      [],
      `Missing core tools: ${missing.join(", ")}`
    );
  });

  it("ListTools returns all expected agent tools", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    const missing = EXPECTED_AGENT_TOOLS.filter((t) => !names.has(t));
    assert.deepStrictEqual(
      missing,
      [],
      `Missing agent tools: ${missing.join(", ")}`
    );
  });

  it("no unexpected tools appear (catch unregistered additions)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    const expectedSet = new Set(ALL_EXPECTED_TOOLS);

    const unexpected = names.filter((n) => !expectedSet.has(n));
    assert.deepStrictEqual(
      unexpected,
      [],
      `Unexpected tools found (add to contract list): ${unexpected.join(", ")}`
    );
  });

  it("every tool has name, description, and inputSchema", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.name, "Tool missing name");
      assert.ok(
        tool.description,
        `Tool ${tool.name} missing description`
      );
      assert.ok(
        tool.inputSchema,
        `Tool ${tool.name} missing inputSchema`
      );
      assert.strictEqual(
        tool.inputSchema.type,
        "object",
        `Tool ${tool.name} inputSchema.type should be "object"`
      );
    }
  });

  it("protected tools have _governorToken in schema", async () => {
    const { tools } = await client.listTools();
    // Deduplicate by name (rks_approve appears in both capabilities and tools array)
    const seen = new Set();
    for (const tool of tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);

      if (!UNPROTECTED_TOOLS.has(tool.name)) {
        assert.ok(
          tool.inputSchema.properties?._governorToken,
          `Protected tool ${tool.name} missing _governorToken in schema`
        );
      }
    }
  });

  it("unprotected tools do NOT have _governorToken injected", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (UNPROTECTED_TOOLS.has(tool.name) && !KNOWN_PROTECTION_GAPS.has(tool.name)) {
        // _governorToken should NOT be injected for unprotected tools.
        // KNOWN_PROTECTION_GAPS (e.g. rks_preflight double-registration) are
        // skipped here and tracked for a separate server-side fix.
        const hasToken = tool.inputSchema.properties?._governorToken;
        assert.ok(
          !hasToken,
          `Unprotected tool ${tool.name} should NOT have _governorToken injected`
        );
      }
    }
  });
});

// ── Suite 2: Schema Validation Contract ──────────────────────────────

describe("Schema Validation Contract", async () => {
  before(async () => {
    tmpDir = createTempFixture();
    const conn = await createTestClient({ projectRoot: tmpDir });
    client = conn.client;
    transport = conn.transport;
  });

  after(async () => {
    await closeTestClient({ client, transport });
    cleanupTempFixture(tmpDir);
  });

  // Tools listed in ListTools that have no handler in CallTool.
  // These are real contract gaps — the test documents them explicitly.
  // Currently empty: rks_ape (the last dead-tool gap) was removed by
  // backlog.chore.remove-rks-ape — it was an obsolete early-rks concept
  // superseded by /po -> /arch and /pipeline.
  const KNOWN_ROUTING_GAPS = new Set([]);

  it("tools with required params reject empty args (not Unknown tool)", async () => {
    const { tools } = await client.listTools();
    const seen = new Set();
    const routingFailures = [];

    for (const tool of tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      if (KNOWN_ROUTING_GAPS.has(tool.name)) continue;

      const required = tool.inputSchema.required || [];
      if (required.length === 0) continue;

      const { threw, error } = await callToolSafe(client, tool.name, {});

      if (threw && error.message?.includes("Unknown tool")) {
        routingFailures.push(tool.name);
      }
      // Not threw = tool handled the empty args itself (returned error response)
      // That's fine — the point is it didn't fail with "Unknown tool"
    }

    assert.deepStrictEqual(
      routingFailures,
      [],
      `Tools not routed (missing handler): ${routingFailures.join(", ")}`
    );
  });
});

// ── Suite 3: Dispatch Smoke Tests ────────────────────────────────────

describe("Dispatch Smoke Tests", async () => {
  before(async () => {
    tmpDir = createTempFixture();
    const conn = await createTestClient({ projectRoot: tmpDir });
    client = conn.client;
    transport = conn.transport;
  });

  after(async () => {
    await closeTestClient({ client, transport });
    cleanupTempFixture(tmpDir);
  });

  // Read-only / safe tools that can be called with minimal input
  const SMOKE_TESTS = [
    { tool: "rks_project_get", args: { id: "test-project" } },
    { tool: "rks_kg_query", args: { projectId: "test-project" } },
    { tool: "rks_preflight", args: { projectId: "test-project" } },
    { tool: "rks_templates_list", args: {} },
    { tool: "rks_onboarder", args: { projectId: "test-project" } },
    { tool: "rks_git_state", args: { projectId: "test-project" } },
    { tool: "rks_guardrails_status", args: { projectId: "test-project" } },
    {
      tool: "dendron_read_note",
      args: { filename: "backlog.feat.test-story" },
    },
  ];

  for (const { tool, args } of SMOKE_TESTS) {
    it(`${tool} returns valid MCP response with JSON text`, async () => {
      const result = await callTool(client, tool, args);

      // Response shape contract
      assert.ok(result.raw.content, `${tool}: missing content array`);
      assert.ok(
        result.raw.content.length > 0,
        `${tool}: empty content array`
      );
      assert.strictEqual(
        result.raw.content[0].type,
        "text",
        `${tool}: content[0].type should be "text"`
      );
      assert.strictEqual(
        typeof result.raw.content[0].text,
        "string",
        `${tool}: content[0].text should be a string`
      );

      // Text should be valid JSON
      let parsed;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(result.raw.content[0].text);
      }, `${tool}: response text is not valid JSON`);

      // Parsed result should be an object
      assert.strictEqual(
        typeof parsed,
        "object",
        `${tool}: parsed response should be an object`
      );
    });
  }
});

// ── Suite 4: Protection Contract ─────────────────────────────────────

describe("Protection Contract", async () => {
  before(async () => {
    tmpDir = createTempFixture();
    const conn = await createTestClient({ projectRoot: tmpDir });
    client = conn.client;
    transport = conn.transport;
  });

  after(async () => {
    await closeTestClient({ client, transport });
    cleanupTempFixture(tmpDir);
  });

  it("unprotected tool (rks_project_get) works without governor token", async () => {
    const result = await callTool(client, "rks_project_get", {
      id: "test-project",
    });
    assert.ok(result.parsed, "unprotected tool should return data");
    assert.ok(
      result.parsed.registry || result.parsed.projectJson,
      "rks_project_get should return project metadata"
    );
  });

  it("unprotected tool (rks_guardrails_status) works without governor token", async () => {
    const result = await callTool(client, "rks_guardrails_status", {
      projectId: "test-project",
    });
    // Should return data, not an auth error
    assert.ok(result.text, "should return a response");
  });

  it("protected tool without token returns auto-routed or unauthorized response", async () => {
    // rks_git_branch is protected — calling without token should auto-route
    // through the git agent or return unauthorized
    const { threw, error, result } = await callToolSafe(
      client,
      "rks_git_branch",
      {
        projectId: "test-project",
        name: "contract-test-branch",
        type: "feat",
      }
    );

    if (threw) {
      // MCP error thrown — that's acceptable for protected tools
      assert.ok(
        !error.message?.includes("Unknown tool"),
        "should not be a routing error"
      );
    } else {
      // Got a response — check it's either auto-routed or unauthorized
      const text = result.content?.[0]?.text;
      assert.ok(text, "should have response text");
      const data = JSON.parse(text);
      // Auto-routed responses have _autoRouted flag, unauthorized have error
      assert.ok(
        data._autoRouted || data.error || data.ok !== undefined,
        "protected tool response should indicate auto-route or auth status"
      );
    }
  });

  it("governor_init returns a session token", async () => {
    const result = await callTool(client, "rks_governor_init", {
      projectId: "test-project",
      flowType: "open",
    });

    assert.ok(result.parsed, "governor_init should return data");
    assert.ok(result.parsed.ok, "governor_init should succeed");
    assert.ok(result.parsed.token, "governor_init should return a token");
    assert.strictEqual(
      typeof result.parsed.token,
      "string",
      "token should be a string"
    );
  });
});
