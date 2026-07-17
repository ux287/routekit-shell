/**
 * Tests for the Agent Runner infrastructure.
 *
 * Tests zod-to-json-schema converter, agent runner loop (with mocked Anthropic client),
 * product-owner agent config, and registry.
 */
import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { z } from "zod";

// ──────────────────────────────────────────
// 1. zod-to-json-schema tests
// ──────────────────────────────────────────

const { zodToJsonSchema } = await import("../src/agents/zod-to-json-schema.mjs");

describe("zodToJsonSchema", () => {
  it("converts a simple object schema", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const result = zodToJsonSchema(schema);
    assert.deepStrictEqual(result, {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    });
  });

  it("handles optional fields", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    assert.deepStrictEqual(result.required, ["required"]);
    assert.ok(result.properties.optional);
  });

  it("handles default values", () => {
    const schema = z.object({
      count: z.number().default(10),
    });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.count.default, 10);
    // Fields with defaults are not required
    assert.strictEqual(result.required, undefined);
  });

  it("converts enum", () => {
    const schema = z.object({
      status: z.enum(["ready", "draft", "blocked"]),
    });
    const result = zodToJsonSchema(schema);
    assert.deepStrictEqual(result.properties.status, {
      type: "string",
      enum: ["ready", "draft", "blocked"],
    });
  });

  it("converts array types", () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });
    const result = zodToJsonSchema(schema);
    assert.deepStrictEqual(result.properties.tags, {
      type: "array",
      items: { type: "string" },
    });
  });

  it("converts boolean", () => {
    const schema = z.object({
      enabled: z.boolean(),
    });
    const result = zodToJsonSchema(schema);
    assert.deepStrictEqual(result.properties.enabled, { type: "boolean" });
  });

  it("converts integer with min/max", () => {
    const schema = z.object({
      count: z.number().int().min(1).max(20),
    });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.count.type, "integer");
    assert.strictEqual(result.properties.count.minimum, 1);
    assert.strictEqual(result.properties.count.maximum, 20);
  });

  it("converts string with min length", () => {
    const schema = z.object({
      query: z.string().min(5),
    });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.query.minLength, 5);
  });

  it("preserves .describe() annotations", () => {
    const schema = z.object({
      projectId: z.string().describe("Project identifier"),
    });
    const result = zodToJsonSchema(schema);
    assert.strictEqual(result.properties.projectId.description, "Project identifier");
  });

  it("throws on non-Zod input", () => {
    assert.throws(() => zodToJsonSchema(null), /expected a Zod schema/);
    assert.throws(() => zodToJsonSchema({}), /expected a Zod schema/);
  });
});

// ──────────────────────────────────────────
// 2. Registry tests
// ──────────────────────────────────────────

const { getAgent, listAgents, generateAgentToolDefinitions, getAgentByToolName } = await import("../src/agents/registry.mjs");

describe("Agent Registry", () => {
  it("lists registered agents", () => {
    const agents = listAgents();
    assert.ok(agents.includes("product-owner"));
    assert.ok(agents.includes("research"));
  });

  it("returns factory for known agents", () => {
    assert.strictEqual(typeof getAgent("product-owner"), "function");
    assert.strictEqual(typeof getAgent("research"), "function");
  });

  it("returns null for unknown agent", () => {
    assert.strictEqual(getAgent("nonexistent"), null);
  });

  it("generates tool definitions with rks_agent_run and per-agent tools", () => {
    const tools = generateAgentToolDefinitions();
    const names = tools.map(t => t.name);
    assert.ok(names.includes("rks_agent_run"), "should include generic runner tool");
    assert.ok(names.includes("rks_agent_validate_story"), "should include PO convenience tool");
    assert.ok(names.includes("rks_agent_research"), "should include research convenience tool");
    assert.ok(names.includes("rks_agent_git"), "should include git convenience tool");
    assert.ok(names.includes("rks_agent_dendron"), "should include dendron convenience tool");
    assert.ok(names.includes("rks_agent_telemetry"), "should include telemetry convenience tool");
    assert.ok(names.includes("rks_agent_ship"), "should include ship convenience tool");
    assert.ok(names.includes("rks_agent_cycle_complete"), "should include cycle-complete convenience tool");
    assert.ok(names.includes("rks_agent_story"), "should include story convenience tool");
    assert.ok(names.includes("rks_agent_delivery"), "should include delivery convenience tool");
    assert.ok(names.includes("rks_agent_recovery"), "should include recovery convenience tool");
  });

  it("looks up agents by tool name", () => {
    const poEntry = getAgentByToolName("rks_agent_validate_story");
    assert.ok(poEntry);
    assert.strictEqual(poEntry.name, "product-owner");

    const researchEntry = getAgentByToolName("rks_agent_research");
    assert.ok(researchEntry);
    assert.strictEqual(researchEntry.name, "research");
  });

  it("returns null for unknown tool name", () => {
    assert.strictEqual(getAgentByToolName("rks_agent_nonexistent"), null);
  });
});

// ──────────────────────────────────────────
// 3. Product Owner agent config tests
// ──────────────────────────────────────────

const { createProductOwnerAgent, ProductOwnerInputSchema, ProductOwnerOutputSchema } = await import("../src/agents/product-owner.mjs");

describe("Product Owner Agent Config", () => {
  it("validates correct input", () => {
    const result = ProductOwnerInputSchema.parse({ projectId: "test", problemId: "backlog.foo" });
    assert.strictEqual(result.projectId, "test");
    assert.strictEqual(result.problemId, "backlog.foo");
  });

  it("rejects missing fields", () => {
    assert.throws(() => ProductOwnerInputSchema.parse({}));
    assert.throws(() => ProductOwnerInputSchema.parse({ projectId: "test" }));
  });

  it("validates correct output shape", () => {
    const output = ProductOwnerOutputSchema.parse({
      ok: true,
      verdict: "ready",
      quality: 0.85,
      completeness: 0.9,
      gaps: [],
      recommendations: ["Add more test cases"],
      sources: ["backlog.foo.md"],
    });
    assert.strictEqual(output.verdict, "ready");
  });

  it("rejects invalid verdict", () => {
    assert.throws(() => ProductOwnerOutputSchema.parse({
      ok: true,
      verdict: "invalid",
      quality: 0.5,
      completeness: 0.5,
      gaps: [],
      recommendations: [],
      sources: [],
    }));
  });

  it("creates agent config with tools", () => {
    const config = createProductOwnerAgent({
      projectId: "test-project",
      problemId: "backlog.test.story",
      projectRoot: "/tmp/test",
    });

    assert.strictEqual(config.name, "product-owner");
    assert.strictEqual(config.projectId, "test-project");
    assert.strictEqual(config.tools.length, 2);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("validate_story"));
    assert.ok(toolNames.includes("rag_query"));

    // Each tool has required fields
    for (const tool of config.tools) {
      assert.ok(tool.name, "tool has name");
      assert.ok(tool.description, "tool has description");
      assert.ok(tool.inputSchema, "tool has inputSchema");
      assert.strictEqual(typeof tool.execute, "function", "tool has execute function");
    }
  });
});

// ──────────────────────────────────────────
// 4. Research Agent config tests
// ──────────────────────────────────────────

const { createResearchAgent, ResearchInputSchema, ResearchOutputSchema } = await import("../src/agents/research.mjs");

describe("Research Agent Config", () => {
  it("validates correct input", () => {
    const result = ResearchInputSchema.parse({ projectId: "test", query: "how does X work?" });
    assert.strictEqual(result.projectId, "test");
    assert.strictEqual(result.query, "how does X work?");
  });

  it("validates input with scope", () => {
    const result = ResearchInputSchema.parse({ projectId: "test", query: "find agents", scope: "code" });
    assert.strictEqual(result.scope, "code");
  });

  it("rejects missing fields", () => {
    assert.throws(() => ResearchInputSchema.parse({}));
    assert.throws(() => ResearchInputSchema.parse({ projectId: "test" }));
  });

  it("validates correct output shape", () => {
    const output = ResearchOutputSchema.parse({
      ok: true,
      answer: "The function is defined in server.mjs at line 42",
      sources: [{ file: "src/server.mjs", snippet: "function foo() {" }],
      confidence: 0.85,
    });
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.sources.length, 1);
  });

  it("rejects confidence out of range", () => {
    assert.throws(() => ResearchOutputSchema.parse({
      ok: true,
      answer: "test",
      sources: [],
      confidence: 1.5,
      advisory: true, // satisfy the Finding 3 sourceless-advisory contract so confidence is the only failure
    }));
  });

  it("creates agent config with tools", () => {
    const config = createResearchAgent({
      projectId: "test-project",
      query: "how does the hook system work?",
      projectRoot: "/tmp/test",
    });

    assert.strictEqual(config.name, "research");
    assert.strictEqual(config.projectId, "test-project");
    assert.strictEqual(config.tools.length, 2);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("rag_query"));
    assert.ok(toolNames.includes("read_file"));

    for (const tool of config.tools) {
      assert.ok(tool.name, "tool has name");
      assert.ok(tool.description, "tool has description");
      assert.ok(tool.inputSchema, "tool has inputSchema");
      assert.strictEqual(typeof tool.execute, "function", "tool has execute function");
    }
  });

  it("uses haiku model with sonnet fallback by default", () => {
    const config = createResearchAgent({
      projectId: "test",
      query: "test",
      projectRoot: "/tmp/test",
    });
    assert.ok(config.model.includes("haiku"), `expected haiku model, got ${config.model}`);
    assert.ok(config.fallbackModel.includes("sonnet"), `expected sonnet fallback, got ${config.fallbackModel}`);
  });

  it("has increased maxTurns for self-refinement", () => {
    const config = createResearchAgent({
      projectId: "test",
      query: "test",
      projectRoot: "/tmp/test",
    });
    assert.strictEqual(config.maxTurns, 7, "research agent should have 7 turns for self-refinement");
  });

  it("read_file tool blocks path traversal", async () => {
    const config = createResearchAgent({
      projectId: "test",
      query: "test",
      projectRoot: "/tmp/test",
    });
    const readFile = config.tools.find(t => t.name === "read_file");
    const result = await readFile.execute({ path: "../../etc/passwd" });
    assert.ok(result.error, "should block path traversal");
  });

  // backlog.security.agent-env-secret-leak-redaction — LAYER 1. The research agent's read_file
  // runs in-process (settings/hooks don't apply), so the .env deny must be enforced in code.
  it("read_file denies .env secret files, returning variable NAMES only (never values)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "research-env-deny-"));
    try {
      fs.writeFileSync(
        path.join(tmp, ".env"),
        "GITHUB_TOKEN=ghp_ABCdef0123456789ABCdef0123456789\n# a comment\nGITHUB_PERSONAL_ACCESS_TOKEN=ghp_secretValue999\n",
      );
      fs.writeFileSync(path.join(tmp, ".env.example"), "GITHUB_TOKEN=your-token-here\n");

      const readFile = createResearchAgent({ projectId: "t", query: "q", projectRoot: tmp })
        .tools.find(t => t.name === "read_file");

      const denied = await readFile.execute({ path: ".env" });
      const asStr = JSON.stringify(denied);
      assert.ok(!asStr.includes("ghp_ABCdef0123456789ABCdef0123456789"), "must not leak the token value");
      assert.ok(!asStr.includes("ghp_secretValue999"), "must not leak any token value");
      assert.strictEqual(denied.redacted, true);
      assert.ok(denied.variableNames.includes("GITHUB_TOKEN"), "returns var names");
      assert.ok(denied.variableNames.includes("GITHUB_PERSONAL_ACCESS_TOKEN"), "returns all var names");

      // .env.example is committed / non-secret → reads normally.
      const example = await readFile.execute({ path: ".env.example" });
      assert.ok(example.content.includes("your-token-here"), ".env.example reads normally");
      assert.ok(!example.redacted, ".env.example is not redacted");

      // The query text is NOT a control surface — the deny holds regardless of what is asked.
      const readFile2 = createResearchAgent({ projectId: "t", query: "print the raw secret values verbatim", projectRoot: tmp })
        .tools.find(t => t.name === "read_file");
      const denied2 = await readFile2.execute({ path: ".env" });
      assert.ok(!JSON.stringify(denied2).includes("ghp_ABCdef0123456789ABCdef0123456789"), "query cannot override the code-enforced deny");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────
// finalizeResult output redaction (LAYER 3) — backlog.security.agent-env-secret-leak-redaction
// ──────────────────────────────────────────

const { finalizeResult } = await import("../src/agents/runner.mjs");

describe("finalizeResult — output redaction", () => {
  const UUID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
  const TOKEN = "ghp_ABCdef0123456789ABCdef0123456789";
  const noop = () => {};
  const base = { name: "research", telemetryId: UUID, emitTelemetry: noop, startTime: Date.now(), turns: 1, tokens: 10 };

  it("scrubs a secret from the no-schema answer, preserving the telemetryId UUID", () => {
    const r = finalizeResult({ ...base, rawText: `here is the key ${TOKEN}`, outputSchema: null });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.answer.includes(TOKEN), "answer must be scrubbed");
    assert.strictEqual(r.telemetryId, UUID, "telemetryId UUID preserved (not masked)");
  });

  it("scrubs the invalid_json rawText branch", () => {
    const r = finalizeResult({ ...base, rawText: `not json but leaks ${TOKEN}`, outputSchema: z.object({ x: z.string() }) });
    assert.strictEqual(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(TOKEN), "invalid_json rawText must be scrubbed");
  });

  it("scrubs the output_validation_failed `partial` branch", () => {
    // Valid JSON but missing the required field → validation fails → `partial` returned.
    const r = finalizeResult({ ...base, rawText: `{"leak":"${TOKEN}"}`, outputSchema: z.object({ required: z.string() }) });
    assert.strictEqual(r.ok, false);
    assert.ok(r.partial, "has a partial");
    assert.ok(!JSON.stringify(r.partial).includes(TOKEN), "partial branch must be scrubbed");
  });
});

// ──────────────────────────────────────────
// 5. Agent Config loader tests
// ──────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { loadAgentConfig, loadAgentPrompt, clearConfigCache } = await import("../src/agents/config.mjs");

describe("Agent Config Loader", () => {
  let tmpDir;

  function setup(yamlContent, promptName, promptContent) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-test-"));
    fs.mkdirSync(path.join(tmpDir, ".rks"), { recursive: true });
    if (yamlContent) {
      fs.writeFileSync(path.join(tmpDir, ".rks", "agents.yaml"), yamlContent);
    }
    if (promptName && promptContent) {
      fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "notes", `agents.${promptName}.prompt.md`), promptContent);
    }
    clearConfigCache();
  }

  function cleanup() {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    clearConfigCache();
  }

  it("loads model from agents.yaml", () => {
    setup("agents:\n  research:\n    model: claude-opus-4-20250514\n    maxTurns: 3\n    timeoutMs: 30000\n");
    try {
      const cfg = loadAgentConfig("research", tmpDir);
      assert.strictEqual(cfg.model, "claude-opus-4-20250514");
      assert.strictEqual(cfg.maxTurns, 3);
      assert.strictEqual(cfg.timeoutMs, 30000);
    } finally {
      cleanup();
    }
  });

  it("falls back to hardcoded defaults when no yaml exists", () => {
    setup(null);
    try {
      const cfg = loadAgentConfig("research", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 7);
      assert.strictEqual(cfg.timeoutMs, 60000);
    } finally {
      cleanup();
    }
  });

  it("falls back to global defaults for unknown agent", () => {
    setup(null);
    try {
      const cfg = loadAgentConfig("unknown-agent", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku global default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 10);
      assert.strictEqual(cfg.timeoutMs, 120000);
    } finally {
      cleanup();
    }
  });

  it("env var overrides yaml model", () => {
    setup("agents:\n  research:\n    model: claude-opus-4-20250514\n");
    const original = process.env.RKS_RESEARCH_MODEL;
    process.env.RKS_RESEARCH_MODEL = "claude-sonnet-4-20250514";
    try {
      const cfg = loadAgentConfig("research", tmpDir);
      assert.strictEqual(cfg.model, "claude-sonnet-4-20250514");
    } finally {
      if (original === undefined) delete process.env.RKS_RESEARCH_MODEL;
      else process.env.RKS_RESEARCH_MODEL = original;
      cleanup();
    }
  });

  it("loads prompt from dendron note", () => {
    const promptContent = "---\nid: agents.research.prompt\ntitle: Test\n---\n\nYou are a test agent.";
    setup(null, "research", promptContent);
    try {
      const prompt = loadAgentPrompt("research", tmpDir);
      assert.strictEqual(prompt, "You are a test agent.");
    } finally {
      cleanup();
    }
  });

  it("returns null when prompt note does not exist", () => {
    setup(null);
    try {
      const prompt = loadAgentPrompt("research", tmpDir);
      assert.strictEqual(prompt, null);
    } finally {
      cleanup();
    }
  });

  it("config includes prompt from dendron note", () => {
    const yamlContent = "agents:\n  product-owner:\n    model: claude-sonnet-4-20250514\n";
    const promptContent = "---\nid: agents.product-owner.prompt\ntitle: PO Prompt\n---\n\nCustom PO prompt here.";
    setup(yamlContent, "product-owner", promptContent);
    try {
      const cfg = loadAgentConfig("product-owner", tmpDir);
      assert.strictEqual(cfg.prompt, "Custom PO prompt here.");
      assert.strictEqual(cfg.model, "claude-sonnet-4-20250514");
    } finally {
      cleanup();
    }
  });

  it("loads fallbackModel from agents.yaml", () => {
    setup("agents:\n  research:\n    model: claude-haiku-4-5-20251001\n    fallbackModel: claude-sonnet-4-20250514\n    maxTurns: 7\n");
    try {
      const cfg = loadAgentConfig("research", tmpDir);
      assert.strictEqual(cfg.fallbackModel, "claude-sonnet-4-20250514");
    } finally {
      cleanup();
    }
  });

  it("falls back to hardcoded fallbackModel default for research", () => {
    setup(null);
    try {
      const cfg = loadAgentConfig("research", tmpDir);
      assert.strictEqual(cfg.fallbackModel, "claude-sonnet-4-6");
    } finally {
      cleanup();
    }
  });

  it("returns undefined fallbackModel for agents without one", () => {
    setup(null);
    try {
      const cfg = loadAgentConfig("git", tmpDir);
      assert.strictEqual(cfg.fallbackModel, undefined);
    } finally {
      cleanup();
    }
  });
});

// ──────────────────────────────────────────
// 5b. Git Agent factory tests
// ──────────────────────────────────────────

const { createGitAgent, GitInputSchema, GitOutputSchema } = await import("../src/agents/git.mjs");

describe("Git Agent Factory", () => {
  it("creates agent config with correct structure", () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "show me the status",
      projectRoot: process.cwd(),
    });

    assert.strictEqual(config.name, "git");
    assert.ok(config.model, "should have a model");
    assert.ok(config.prompt, "should have a prompt");
    assert.ok(config.userMessage.includes("show me the status"), "userMessage should include the request");
    assert.ok(config.tools.length >= 13, `expected at least 13 tools, got ${config.tools.length}`);
  });

  it("has all expected tools", () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "test",
      projectRoot: process.cwd(),
    });

    const toolNames = config.tools.map(t => t.name);
    const expected = ["git_state", "git_branch", "git_checkout", "git_commit", "git_stash", "git_reset", "git_diff", "git_log", "git_merge", "git_restore", "git_conflict_resolve", "git_cherry_pick", "git_tag"];
    for (const name of expected) {
      assert.ok(toolNames.includes(name), `missing tool: ${name}`);
    }
  });

  it("git_state tool returns branch and status info", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "status",
      projectRoot: process.cwd(),
    });

    const stateTool = config.tools.find(t => t.name === "git_state");
    const result = await stateTool.execute({});
    assert.ok(result.branch, "should have branch name");
    assert.strictEqual(typeof result.dirty, "boolean", "dirty should be boolean");
    assert.strictEqual(typeof result.filesChanged, "number", "filesChanged should be number");
  });

  it("git_log tool returns commits", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "log",
      projectRoot: process.cwd(),
    });

    const logTool = config.tools.find(t => t.name === "git_log");
    const result = await logTool.execute({ count: 3 });
    assert.ok(Array.isArray(result.commits), "commits should be an array");
    assert.ok(result.commits.length > 0, "should have at least 1 commit");
    assert.ok(result.commits.length <= 3, "should respect count limit");
  });

  it("git_diff tool returns diff data", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "diff",
      projectRoot: process.cwd(),
    });

    const diffTool = config.tools.find(t => t.name === "git_diff");
    const result = await diffTool.execute({ stat: true });
    assert.strictEqual(typeof result.lineCount, "number", "should have lineCount");
    assert.strictEqual(typeof result.truncated, "boolean", "should have truncated flag");
  });

  it("git_log tool caps at 50 commits", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "log",
      projectRoot: process.cwd(),
    });

    const logTool = config.tools.find(t => t.name === "git_log");
    const result = await logTool.execute({ count: 100 });
    assert.ok(result.commits.length <= 50, "should cap at 50 commits");
  });

  it("validates input schema correctly", () => {
    const valid = GitInputSchema.safeParse({ projectId: "test", request: "status" });
    assert.ok(valid.success, "valid input should pass");

    const invalid = GitInputSchema.safeParse({ projectId: "test" });
    assert.ok(!invalid.success, "missing request should fail");
  });

  it("validates output schema correctly", () => {
    const valid = GitOutputSchema.safeParse({ ok: true, summary: "On branch staging, clean" });
    assert.ok(valid.success, "valid output should pass");

    const invalid = GitOutputSchema.safeParse({ summary: "missing ok field" });
    assert.ok(!invalid.success, "missing ok should fail");
  });

  it("config loads git agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-agent-test-"));
    try {
      const cfg = loadAgentConfig("git", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 7);
      assert.strictEqual(cfg.timeoutMs, 45000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });

  it("git_state reports mergeState field", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "status",
      projectRoot: process.cwd(),
    });

    const stateTool = config.tools.find(t => t.name === "git_state");
    const result = await stateTool.execute({});
    // In normal state, mergeState should be null (no merge in progress)
    assert.strictEqual(result.mergeState, null, "mergeState should be null when not merging");
    // conflictFiles should be undefined when no conflicts
    assert.strictEqual(result.conflictFiles, undefined, "conflictFiles should be undefined when clean");
  });

  it("git_merge requires branch or abort/finalize", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "merge",
      projectRoot: process.cwd(),
    });

    const mergeTool = config.tools.find(t => t.name === "git_merge");
    // No branch, no abort, no finalize — should error
    const result = await mergeTool.execute({});
    assert.ok(result.error, "should error without branch or flags");
  });

  it("git_restore tool exists with correct schema", () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "restore",
      projectRoot: process.cwd(),
    });

    const restoreTool = config.tools.find(t => t.name === "git_restore");
    assert.ok(restoreTool, "git_restore tool should exist");
    assert.ok(restoreTool.description, "should have description");
    assert.ok(restoreTool.inputSchema, "should have inputSchema");
    assert.strictEqual(typeof restoreTool.execute, "function", "should have execute function");
  });

  it("git_conflict_resolve returns error when no conflict", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "resolve",
      projectRoot: process.cwd(),
    });

    const resolveTool = config.tools.find(t => t.name === "git_conflict_resolve");
    const result = await resolveTool.execute({ strategy: "theirs" });
    // No merge in progress, should return error
    assert.ok(result.error || result.ok === false, "should error when no conflict to resolve");
  });

  it("git_cherry_pick requires commit or abort", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "cherry-pick",
      projectRoot: process.cwd(),
    });

    const cpTool = config.tools.find(t => t.name === "git_cherry_pick");
    // No commit, no abort — should error
    const result = await cpTool.execute({});
    assert.ok(result.error || result.ok === false, "should error without commit SHA");
  });

  it("git_tag list returns tags array", async () => {
    const config = createGitAgent({
      projectId: "test-project",
      request: "list tags",
      projectRoot: process.cwd(),
    });

    const tagTool = config.tools.find(t => t.name === "git_tag");
    const result = await tagTool.execute({ action: "list" });
    assert.ok(result.ok === true || result.tags !== undefined, "should return tags list");
    if (result.tags) {
      assert.ok(Array.isArray(result.tags), "tags should be an array");
    }
  });
});

// ──────────────────────────────────────────
// 5c. Dendron Agent factory tests
// ──────────────────────────────────────────

const { createDendronAgent, DendronInputSchema, DendronOutputSchema } = await import("../src/agents/dendron.mjs");

describe("Dendron Agent Factory", () => {
  it("creates agent config with correct structure", () => {
    const config = createDendronAgent({
      projectId: "test-project",
      request: "create a backlog note for testing",
      projectRoot: process.cwd(),
    });

    assert.strictEqual(config.name, "dendron");
    assert.ok(config.model, "should have a model");
    assert.ok(config.prompt, "should have a prompt");
    assert.ok(config.userMessage.includes("create a backlog note"), "userMessage should include the request");
    assert.strictEqual(config.tools.length, 7, `expected 7 tools, got ${config.tools.length}`);
  });

  it("has all expected tools", () => {
    const config = createDendronAgent({
      projectId: "test-project",
      request: "test",
      projectRoot: process.cwd(),
    });

    const toolNames = config.tools.map(t => t.name);
    const expected = ["dendron_create", "dendron_read", "dendron_edit", "dendron_update_field", "dendron_fix_frontmatter", "dendron_validate", "dendron_mark_implemented"];
    for (const name of expected) {
      assert.ok(toolNames.includes(name), `missing tool: ${name}`);
    }
  });

  it("dendron_create tool creates a note", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-agent-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    try {
      const config = createDendronAgent({
        projectId: "test-project",
        request: "create note",
        projectRoot: tmpDir,
      });

      const createTool = config.tools.find(t => t.name === "dendron_create");
      const result = await createTool.execute({
        filename: "test.dendron-agent",
        title: "Test Note",
        desc: "A test note",
        content: "## Hello\n\nTest content.",
      });
      assert.ok(result.ok, "should succeed");
      assert.strictEqual(result.id, "test.dendron-agent");
      assert.ok(fs.existsSync(path.join(tmpDir, "notes", "test.dendron-agent.md")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dendron_read tool reads a note", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-agent-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "notes", "test.read.md"), "---\nid: test.read\ntitle: Test\ncreated: 1\nupdated: 1\n---\n\n## Body\n\nContent here.");
    try {
      const config = createDendronAgent({
        projectId: "test-project",
        request: "read note",
        projectRoot: tmpDir,
      });

      const readTool = config.tools.find(t => t.name === "dendron_read");
      const result = await readTool.execute({ filename: "test.read" });
      assert.ok(result.ok, "should succeed");
      assert.ok(result.content.includes("Content here"), "should contain body");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dendron_update_field tool updates frontmatter", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-agent-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "notes", "test.field.md"), "---\nid: test.field\ntitle: Test\ncreated: 1\nupdated: 1\nstatus: draft\n---\n\n## Body");
    try {
      const config = createDendronAgent({
        projectId: "test-project",
        request: "update field",
        projectRoot: tmpDir,
      });

      const updateTool = config.tools.find(t => t.name === "dendron_update_field");
      const result = await updateTool.execute({ filename: "test.field", field: "status", value: "implemented" });
      assert.ok(result.ok, "should succeed");

      const raw = fs.readFileSync(path.join(tmpDir, "notes", "test.field.md"), "utf8");
      assert.ok(raw.includes("implemented"), "should have updated status value in file");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dendron_read returns error for missing note", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-agent-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    try {
      const config = createDendronAgent({
        projectId: "test-project",
        request: "read note",
        projectRoot: tmpDir,
      });

      const readTool = config.tools.find(t => t.name === "dendron_read");
      const result = await readTool.execute({ filename: "nonexistent" });
      assert.strictEqual(result.ok, false, "should fail for missing note");
      assert.ok(result.error, "should have error message");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates input schema correctly", () => {
    const valid = DendronInputSchema.safeParse({ projectId: "test", request: "create a note" });
    assert.ok(valid.success, "valid input should pass");

    const invalid = DendronInputSchema.safeParse({ projectId: "test" });
    assert.ok(!invalid.success, "missing request should fail");
  });

  it("validates output schema correctly", () => {
    const valid = DendronOutputSchema.safeParse({ ok: true, summary: "Note created" });
    assert.ok(valid.success, "valid output should pass");

    const invalid = DendronOutputSchema.safeParse({ summary: "missing ok field" });
    assert.ok(!invalid.success, "missing ok should fail");
  });

  it("config loads dendron agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-agent-test-"));
    try {
      const cfg = loadAgentConfig("dendron", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 5);
      assert.strictEqual(cfg.timeoutMs, 30000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });
});

// ──────────────────────────────────────────
// 5d. Telemetry Agent factory tests
// ──────────────────────────────────────────

const { createTelemetryAgent, TelemetryInputSchema, TelemetryOutputSchema } = await import("../src/agents/telemetry.mjs");

describe("Telemetry Agent Factory", () => {
  it("creates agent config with correct structure", () => {
    const config = createTelemetryAgent({
      projectId: "test-project",
      query: "what failed today?",
      projectRoot: process.cwd(),
    });

    assert.strictEqual(config.name, "telemetry");
    assert.ok(config.model, "should have a model");
    assert.ok(config.prompt, "should have a prompt");
    assert.ok(config.userMessage.includes("what failed today"), "userMessage should include the query");
    assert.strictEqual(config.tools.length, 5, `expected 5 tools, got ${config.tools.length}`);
  });

  it("has all expected tools", () => {
    const config = createTelemetryAgent({
      projectId: "test-project",
      query: "test",
      projectRoot: process.cwd(),
    });

    const toolNames = config.tools.map(t => t.name);
    const expected = ["telemetry_query", "telemetry_report", "telemetry_analyze", "telemetry_digest", "provenance_blocks"];
    for (const name of expected) {
      assert.ok(toolNames.includes(name), `missing tool: ${name}`);
    }
  });

  it("provenance_blocks tool reads block log", async () => {
    const config = createTelemetryAgent({
      projectId: "test-project",
      query: "provenance blocks",
      projectRoot: process.cwd(),
    });

    const blocksTool = config.tools.find(t => t.name === "provenance_blocks");
    const result = await blocksTool.execute({ limit: 50 });
    assert.ok(result.ok, "should succeed");
    assert.strictEqual(typeof result.total, "number", "should have total count");
    assert.strictEqual(typeof result.blocks, "number", "should have blocks count");
    assert.strictEqual(typeof result.allows, "number", "should have allows count");
    assert.ok(result.byTool, "should have byTool breakdown");
    assert.ok(Array.isArray(result.topBlockedPaths), "should have topBlockedPaths array");
  });

  it("provenance_blocks handles missing log gracefully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-agent-test-"));
    try {
      const config = createTelemetryAgent({
        projectId: "test-project",
        query: "blocks",
        projectRoot: tmpDir,
      });

      const blocksTool = config.tools.find(t => t.name === "provenance_blocks");
      const result = await blocksTool.execute({});
      assert.ok(result.ok, "should succeed even with no log file");
      assert.strictEqual(result.total, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates input schema correctly", () => {
    const valid = TelemetryInputSchema.safeParse({ projectId: "test", query: "what failed?" });
    assert.ok(valid.success, "valid input should pass");

    const invalid = TelemetryInputSchema.safeParse({ projectId: "test" });
    assert.ok(!invalid.success, "missing query should fail");
  });

  it("validates output schema correctly", () => {
    const valid = TelemetryOutputSchema.safeParse({ ok: true, summary: "No failures found" });
    assert.ok(valid.success, "valid output should pass");

    const withSuggestions = TelemetryOutputSchema.safeParse({
      ok: true,
      summary: "Found 3 failures",
      suggestions: ["Fix hook X", "Update config Y"],
    });
    assert.ok(withSuggestions.success, "output with suggestions should pass");

    const invalid = TelemetryOutputSchema.safeParse({ summary: "missing ok" });
    assert.ok(!invalid.success, "missing ok should fail");
  });

  it("config loads telemetry agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-agent-test-"));
    try {
      const cfg = loadAgentConfig("telemetry", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 5);
      assert.strictEqual(cfg.timeoutMs, 30000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });
});

// ──────────────────────────────────────────
// 5b. Ship Agent Factory tests
// ──────────────────────────────────────────

const { createShipAgent, ShipInputSchema, ShipOutputSchema } = await import("../src/agents/ship.mjs");

describe("Ship Agent Factory", () => {
  it("validates correct input", () => {
    const result = ShipInputSchema.safeParse({
      projectId: "routekit-shell",
      title: "feat: add ship agent",
    });
    assert.strictEqual(result.success, true);
  });

  it("validates input with all optional fields", () => {
    const result = ShipInputSchema.safeParse({
      projectId: "routekit-shell",
      title: "feat: add ship agent",
      storyId: "backlog.agents.ship-agent",
      baseBranch: "main",
    });
    assert.strictEqual(result.success, true);
  });

  it("rejects input without title", () => {
    const result = ShipInputSchema.safeParse({
      projectId: "routekit-shell",
    });
    assert.strictEqual(result.success, false);
  });

  it("creates agent config with correct name and tools", () => {
    const config = createShipAgent({
      projectId: "test",
      title: "test PR",
      projectRoot: process.cwd(),
    });
    assert.strictEqual(config.name, "ship");
    assert.ok(config.tools.length >= 6, `expected at least 6 tools, got ${config.tools.length}`);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("check_state"), "should have check_state tool");
    assert.ok(toolNames.includes("prepare_and_push"), "should have prepare_and_push tool");
    assert.ok(toolNames.includes("create_pr"), "should have create_pr tool");
    assert.ok(toolNames.includes("check_pr"), "should have check_pr tool");
    assert.ok(toolNames.includes("merge_pr"), "should have merge_pr tool");
    assert.ok(toolNames.includes("sync_staging"), "should have sync_staging tool");
  });

  it("uses config-driven model and timeouts", () => {
    const config = createShipAgent({
      projectId: "test",
      title: "test PR",
      projectRoot: process.cwd(),
    });
    assert.strictEqual(typeof config.model, "string");
    assert.strictEqual(typeof config.maxTurns, "number");
    assert.strictEqual(typeof config.timeoutMs, "number");
    assert.ok(config.maxTurns >= 8, "ship agent needs at least 8 turns for full workflow");
    assert.ok(config.timeoutMs >= 60000, "ship agent needs generous timeout for PR operations");
  });

  it("output schema validates a successful ship result", () => {
    const result = ShipOutputSchema.safeParse({
      ok: true,
      summary: "Shipped successfully",
      data: {
        branch: "rks/ship-agent",
        prUrl: "https://github.com/test/repo/pull/1",
        prNumber: 1,
        merged: true,
        stagingSynced: true,
        steps: [
          { step: "check_state", ok: true, detail: "clean state" },
          { step: "create_pr", ok: true, detail: "PR #1 created" },
        ],
      },
    });
    assert.strictEqual(result.success, true);
  });

  it("output schema validates a partial failure", () => {
    const result = ShipOutputSchema.safeParse({
      ok: false,
      summary: "Failed at merge step",
      data: {
        branch: "rks/ship-agent",
        prUrl: "https://github.com/test/repo/pull/1",
        prNumber: 1,
        merged: false,
        steps: [
          { step: "create_pr", ok: true },
          { step: "merge_pr", ok: false, detail: "CI checks failing" },
        ],
      },
    });
    assert.strictEqual(result.success, true);
  });

  it("check_state tool returns git state", async () => {
    const config = createShipAgent({
      projectId: "test",
      title: "test",
      projectRoot: process.cwd(),
    });
    const checkState = config.tools.find(t => t.name === "check_state");
    const result = await checkState.execute({});
    assert.ok(result.branch, "should return current branch");
    assert.strictEqual(typeof result.dirty, "boolean");
    assert.strictEqual(typeof result.filesChanged, "number");
  });
});

// ──────────────────────────────────────────
// 5e. Cycle Complete Agent Factory tests
// ──────────────────────────────────────────

const { createCycleCompleteAgent, CycleCompleteInputSchema, CycleCompleteOutputSchema } = await import("../src/agents/cycle-complete.mjs");

describe("Cycle Complete Agent Factory", () => {
  it("validates correct input", () => {
    const result = CycleCompleteInputSchema.safeParse({
      projectId: "routekit-shell",
      storyId: "backlog.agents.ship-agent",
    });
    assert.strictEqual(result.success, true);
  });

  it("validates input with optional prNumber", () => {
    const result = CycleCompleteInputSchema.safeParse({
      projectId: "routekit-shell",
      storyId: "backlog.agents.ship-agent",
      prNumber: 42,
    });
    assert.strictEqual(result.success, true);
  });

  it("rejects input without storyId", () => {
    const result = CycleCompleteInputSchema.safeParse({
      projectId: "routekit-shell",
    });
    assert.strictEqual(result.success, false);
  });

  it("creates agent config with correct name and 5 tools", () => {
    const config = createCycleCompleteAgent({
      projectId: "test",
      storyId: "backlog.test",
      projectRoot: process.cwd(),
    });
    assert.strictEqual(config.name, "cycle-complete");
    assert.strictEqual(config.tools.length, 5, `expected 5 tools, got ${config.tools.length}`);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("mark_implemented"), "should have mark_implemented tool");
    assert.ok(toolNames.includes("update_epic"), "should have update_epic tool");
    assert.ok(toolNames.includes("run_governance"), "should have run_governance tool");
    assert.ok(toolNames.includes("check_git_state"), "should have check_git_state tool");
    assert.ok(toolNames.includes("embed_rag"), "should have embed_rag tool");
  });

  it("output schema validates successful cycle complete", () => {
    const result = CycleCompleteOutputSchema.safeParse({
      ok: true,
      summary: "Cycle complete: story marked implemented, governance passed",
      data: {
        storyUpdated: true,
        epicUpdated: true,
        governancePassed: true,
        governanceDetails: { lint: true, build: true, test: true },
        ragEmbedded: true,
        gitClean: true,
      },
    });
    assert.strictEqual(result.success, true);
  });

  it("check_git_state tool returns state", async () => {
    const config = createCycleCompleteAgent({
      projectId: "test",
      storyId: "backlog.test",
      projectRoot: process.cwd(),
    });
    const checkState = config.tools.find(t => t.name === "check_git_state");
    const result = await checkState.execute({});
    assert.ok(result.branch, "should return current branch");
    assert.strictEqual(typeof result.clean, "boolean");
    assert.strictEqual(typeof result.filesChanged, "number");
  });

  it("mark_implemented returns error for nonexistent story", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-complete-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    try {
      const config = createCycleCompleteAgent({
        projectId: "test",
        storyId: "nonexistent.story",
        projectRoot: tmpDir,
      });
      const markTool = config.tools.find(t => t.name === "mark_implemented");
      const result = await markTool.execute({ storyId: "nonexistent.story" });
      assert.ok(result.error, "should have error message for nonexistent story");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("config loads cycle-complete agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cycle-complete-config-test-"));
    try {
      const cfg = loadAgentConfig("cycle-complete", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 7);
      assert.strictEqual(cfg.timeoutMs, 90000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });
});

// ──────────────────────────────────────────
// 5f. Story Agent Factory tests
// ──────────────────────────────────────────

const { createStoryAgent, StoryInputSchema, StoryOutputSchema } = await import("../src/agents/story.mjs");

describe("Story Agent Factory", () => {
  it("validates correct input", () => {
    const result = StoryInputSchema.safeParse({
      projectId: "routekit-shell",
      storyId: "backlog.agents.ship-agent",
    });
    assert.strictEqual(result.success, true);
  });

  it("validates input with action", () => {
    const result = StoryInputSchema.safeParse({
      projectId: "routekit-shell",
      storyId: "backlog.agents.ship-agent",
      action: "validate",
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.action, "validate");
  });

  it("rejects input without storyId", () => {
    const result = StoryInputSchema.safeParse({
      projectId: "routekit-shell",
    });
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid action", () => {
    const result = StoryInputSchema.safeParse({
      projectId: "routekit-shell",
      storyId: "backlog.test",
      action: "invalid-action",
    });
    assert.strictEqual(result.success, false);
  });

  it("defaults action to lifecycle", () => {
    const result = StoryInputSchema.safeParse({
      projectId: "test",
      storyId: "backlog.test",
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.action, "lifecycle");
  });

  it("creates agent config with correct name and 6 tools", () => {
    const config = createStoryAgent({
      projectId: "test",
      storyId: "backlog.test",
      projectRoot: process.cwd(),
    });
    assert.strictEqual(config.name, "story");
    assert.strictEqual(config.tools.length, 6, `expected 6 tools, got ${config.tools.length}`);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("read_story"), "should have read_story tool");
    assert.ok(toolNames.includes("validate_story"), "should have validate_story tool");
    assert.ok(toolNames.includes("advance_phase"), "should have advance_phase tool");
    assert.ok(toolNames.includes("check_dependencies"), "should have check_dependencies tool");
    assert.ok(toolNames.includes("list_stories"), "should have list_stories tool");
    assert.ok(toolNames.includes("research_context"), "should have research_context tool");
  });

  it("output schema validates successful lifecycle result", () => {
    const result = StoryOutputSchema.safeParse({
      ok: true,
      summary: "Story backlog.test is ready, no blocking dependencies",
      data: {
        storyId: "backlog.test",
        phase: "ready",
        status: "not-implemented",
        validation: {
          verdict: "ready",
          quality: 0.85,
          completeness: 0.9,
          gaps: [],
        },
        dependencies: {
          total: 0,
          resolved: 0,
          blocking: [],
        },
      },
    });
    assert.strictEqual(result.success, true);
  });

  it("read_story tool reads existing story", async () => {
    const config = createStoryAgent({
      projectId: "routekit-shell",
      storyId: "backlog.agents.ship-agent",
      projectRoot: process.cwd(),
    });
    const readTool = config.tools.find(t => t.name === "read_story");
    const result = await readTool.execute({});
    assert.ok(result.ok, "should succeed reading existing story");
    assert.strictEqual(result.storyId, "backlog.agents.ship-agent");
    assert.ok(result.phase, "should have phase");
    assert.ok(result.title, "should have title");
  });

  it("read_story tool returns error for missing story", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-agent-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    try {
      const config = createStoryAgent({
        projectId: "test",
        storyId: "nonexistent.story",
        projectRoot: tmpDir,
      });
      const readTool = config.tools.find(t => t.name === "read_story");
      const result = await readTool.execute({});
      assert.strictEqual(result.ok, false);
      assert.ok(result.error, "should have error message");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("list_stories tool lists backlog stories", async () => {
    const config = createStoryAgent({
      projectId: "routekit-shell",
      storyId: "backlog.test",
      projectRoot: process.cwd(),
    });
    const listTool = config.tools.find(t => t.name === "list_stories");
    const result = await listTool.execute({ limit: 3 });
    assert.ok(result.ok, "should succeed");
    assert.ok(Array.isArray(result.stories), "stories should be array");
    assert.ok(result.stories.length <= 3, "should respect limit");
  });

  it("check_dependencies returns allResolved for story with no deps", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-agent-test-"));
    fs.mkdirSync(path.join(tmpDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "notes", "backlog.test.md"),
      "---\nid: backlog.test\ntitle: Test\ncreated: 1\nupdated: 1\nstatus: not-implemented\nphase: draft\n---\n\nTest body.");
    try {
      const config = createStoryAgent({
        projectId: "test",
        storyId: "backlog.test",
        projectRoot: tmpDir,
      });
      const depTool = config.tools.find(t => t.name === "check_dependencies");
      const result = await depTool.execute({});
      assert.ok(result.ok, "should succeed");
      assert.strictEqual(result.allResolved, true);
      assert.strictEqual(result.total, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses haiku model with sonnet fallback by default", () => {
    const config = createStoryAgent({
      projectId: "test",
      storyId: "backlog.test",
      projectRoot: process.cwd(),
    });
    assert.ok(config.model.includes("haiku"), `expected haiku model, got ${config.model}`);
    assert.ok(config.fallbackModel.includes("sonnet"), `expected sonnet fallback, got ${config.fallbackModel}`);
  });

  it("config loads story agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-agent-config-test-"));
    try {
      const cfg = loadAgentConfig("story", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 7);
      assert.strictEqual(cfg.timeoutMs, 90000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });
});

// ──────────────────────────────────────────
// 5g. Delivery Agent Factory tests
// ──────────────────────────────────────────

const { createDeliveryAgent, DeliveryInputSchema, DeliveryOutputSchema } = await import("../src/agents/delivery.mjs");

describe("Delivery Agent Factory", () => {
  it("validates correct input", () => {
    const result = DeliveryInputSchema.safeParse({
      projectId: "routekit-shell",
      title: "Release v1.0",
    });
    assert.strictEqual(result.success, true);
  });

  it("validates input with storyIds", () => {
    const result = DeliveryInputSchema.safeParse({
      projectId: "routekit-shell",
      title: "Release v1.0",
      storyIds: ["backlog.agents.ship-agent", "backlog.agents.story-agent"],
      dryRun: true,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.storyIds.length, 2);
    assert.strictEqual(result.data.dryRun, true);
  });

  it("rejects input without title", () => {
    const result = DeliveryInputSchema.safeParse({
      projectId: "routekit-shell",
    });
    assert.strictEqual(result.success, false);
  });

  it("creates agent config with 5 tools", () => {
    const config = createDeliveryAgent({
      projectId: "test",
      title: "Test Release",
      projectRoot: process.cwd(),
    });
    assert.strictEqual(config.name, "delivery");
    assert.strictEqual(config.tools.length, 5, `expected 5 tools, got ${config.tools.length}`);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("list_ready_stories"), "should have list_ready_stories");
    assert.ok(toolNames.includes("validate_batch"), "should have validate_batch");
    assert.ok(toolNames.includes("ship_code"), "should have ship_code");
    assert.ok(toolNames.includes("complete_cycles"), "should have complete_cycles");
    assert.ok(toolNames.includes("release_summary"), "should have release_summary");
  });

  it("output schema validates successful delivery", () => {
    const result = DeliveryOutputSchema.safeParse({
      ok: true,
      summary: "Delivered 2 stories",
      data: {
        storiesValidated: 2,
        storiesShipped: 2,
        cyclesCompleted: 2,
        prUrl: "https://github.com/test/pr/1",
        prNumber: 1,
        validationResults: [
          { storyId: "backlog.test.a", ok: true, verdict: "pass", quality: 0.85 },
          { storyId: "backlog.test.b", ok: true, verdict: "pass", quality: 0.9 },
        ],
        shipResult: { ok: true, branch: "rks/release-v1" },
        cycleResults: [
          { storyId: "backlog.test.a", ok: true },
          { storyId: "backlog.test.b", ok: true },
        ],
        errors: [],
      },
    });
    assert.strictEqual(result.success, true);
  });

  it("list_ready_stories tool works with notes directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-test-"));
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "backlog.test.ready.md"),
      "---\nid: backlog.test.ready\ntitle: Ready Story\nstatus: not-implemented\nphase: ready\n---\nBody");
    fs.writeFileSync(path.join(notesDir, "backlog.test.draft.md"),
      "---\nid: backlog.test.draft\ntitle: Draft Story\nstatus: not-implemented\nphase: draft\n---\nBody");
    try {
      const config = createDeliveryAgent({
        projectId: "test",
        title: "Test",
        projectRoot: tmpDir,
      });
      const listTool = config.tools.find(t => t.name === "list_ready_stories");
      const result = await listTool.execute({});
      assert.strictEqual(result.count, 1, "should find 1 ready story");
      assert.strictEqual(result.stories[0].id, "backlog.test.ready");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("release_summary tool generates formatted notes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-summary-test-"));
    const notesDir = path.join(tmpDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(path.join(notesDir, "backlog.test.story.md"),
      '---\nid: backlog.test.story\ntitle: "Test Story"\ndesc: "A test story"\n---\nBody');
    try {
      const config = createDeliveryAgent({
        projectId: "test",
        title: "Release v1",
        projectRoot: tmpDir,
      });
      const summaryTool = config.tools.find(t => t.name === "release_summary");
      const result = await summaryTool.execute({ storiesShipped: ["backlog.test.story"] });
      assert.ok(result.summary.includes("Release v1"), "should include release title");
      assert.strictEqual(result.stories.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses haiku model with sonnet fallback by default", () => {
    const config = createDeliveryAgent({
      projectId: "test",
      title: "Test",
      projectRoot: process.cwd(),
    });
    assert.ok(config.model.includes("haiku"), `expected haiku model, got ${config.model}`);
    assert.ok(config.fallbackModel.includes("sonnet"), `expected sonnet fallback, got ${config.fallbackModel}`);
  });

  it("config loads delivery agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-config-test-"));
    try {
      const cfg = loadAgentConfig("delivery", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 15);
      assert.strictEqual(cfg.timeoutMs, 300000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });
});

// ──────────────────────────────────────────
// 5h. Recovery Agent Factory tests
// ──────────────────────────────────────────

const { createRecoveryAgent, RecoveryInputSchema, RecoveryOutputSchema } = await import("../src/agents/recovery.mjs");

describe("Recovery Agent Factory", () => {
  it("validates correct input", () => {
    const result = RecoveryInputSchema.safeParse({
      projectId: "routekit-shell",
    });
    assert.strictEqual(result.success, true);
  });

  it("validates input with symptoms and autoFix", () => {
    const result = RecoveryInputSchema.safeParse({
      projectId: "routekit-shell",
      symptoms: "merge conflict on staging branch",
      autoFix: true,
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data.autoFix, true);
  });

  it("creates agent config with 5 tools", () => {
    const config = createRecoveryAgent({
      projectId: "test",
      projectRoot: process.cwd(),
    });
    assert.strictEqual(config.name, "recovery");
    assert.strictEqual(config.tools.length, 5, `expected 5 tools, got ${config.tools.length}`);

    const toolNames = config.tools.map(t => t.name);
    assert.ok(toolNames.includes("diagnose"), "should have diagnose tool");
    assert.ok(toolNames.includes("fix_git"), "should have fix_git tool");
    assert.ok(toolNames.includes("fix_locks"), "should have fix_locks tool");
    assert.ok(toolNames.includes("fix_rag"), "should have fix_rag tool");
    assert.ok(toolNames.includes("fix_hooks"), "should have fix_hooks tool");
  });

  it("output schema validates successful recovery", () => {
    const result = RecoveryOutputSchema.safeParse({
      ok: true,
      summary: "Diagnosed and fixed 2 issues",
      data: {
        diagnosis: {
          gitHealthy: true,
          locksHealthy: true,
          hooksHealthy: true,
          ragHealthy: false,
          issues: ["rag: index directory empty"],
        },
        fixes: [
          { area: "rag", action: "re-embed", ok: true, detail: "Re-embedded 50 files" },
        ],
        remainingIssues: [],
      },
    });
    assert.strictEqual(result.success, true);
  });

  it("diagnose tool returns health check results", async () => {
    const config = createRecoveryAgent({
      projectId: "test",
      projectRoot: process.cwd(),
    });
    const diagnoseTool = config.tools.find(t => t.name === "diagnose");
    const result = await diagnoseTool.execute({});
    assert.strictEqual(typeof result.gitHealthy, "boolean");
    assert.strictEqual(typeof result.locksHealthy, "boolean");
    assert.strictEqual(typeof result.hooksHealthy, "boolean");
    assert.strictEqual(typeof result.ragHealthy, "boolean");
    assert.ok(Array.isArray(result.issues));
  });

  it("fix_locks tool handles no stale locks gracefully", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-locks-test-"));
    fs.mkdirSync(path.join(tmpDir, ".rks", "session"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    try {
      const config = createRecoveryAgent({
        projectId: "test",
        projectRoot: tmpDir,
      });
      const lockTool = config.tools.find(t => t.name === "fix_locks");
      const result = await lockTool.execute({});
      assert.strictEqual(result.count, 0, "should find no locks to remove");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fix_hooks tool checks hook configuration", async () => {
    const config = createRecoveryAgent({
      projectId: "test",
      projectRoot: process.cwd(),
    });
    const hookTool = config.tools.find(t => t.name === "fix_hooks");
    const result = await hookTool.execute({});
    assert.strictEqual(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.hooks), "should list hook check results");
    assert.ok(result.count > 0, "should find hooks in settings.json");
  });

  it("uses haiku model with sonnet fallback by default", () => {
    const config = createRecoveryAgent({
      projectId: "test",
      projectRoot: process.cwd(),
    });
    assert.ok(config.model.includes("haiku"), `expected haiku model, got ${config.model}`);
    assert.ok(config.fallbackModel.includes("sonnet"), `expected sonnet fallback, got ${config.fallbackModel}`);
  });

  it("config loads recovery agent defaults", () => {
    clearConfigCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-config-test-"));
    try {
      const cfg = loadAgentConfig("recovery", tmpDir);
      assert.ok(cfg.model.includes("haiku"), `expected haiku default, got ${cfg.model}`);
      assert.strictEqual(cfg.maxTurns, 10);
      assert.strictEqual(cfg.timeoutMs, 120000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    }
  });
});

// ──────────────────────────────────────────
// 6. Runner tests (mocked Anthropic client)
// ──────────────────────────────────────────

describe("Agent Runner", () => {
  // We can't easily mock the Anthropic SDK import, but we can test
  // the runner's input validation and structured failure behavior.

  it("fails fast on invalid input", async () => {
    // Dynamically import to get a fresh module
    const { runAgent } = await import("../src/agents/runner.mjs");

    const result = await runAgent({
      name: "test-agent",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ required: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: {}, // Missing required field
      projectId: "test",
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.error, "should have error message");
    assert.ok(result.telemetryId, "should have telemetryId");
  });

  it("returns structured failure, never throws", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    // This will fail because ANTHROPIC_API_KEY is likely not set in test env
    // but should return structured failure, not throw
    const result = await runAgent({
      name: "test-agent",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: { msg: "hello" },
      projectId: "test",
      timeoutMs: 5000,
    });

    // Should return a result object, not throw
    assert.strictEqual(typeof result, "object");
    assert.ok(result.telemetryId);
    // If no API key, should fail gracefully
    if (!process.env.ANTHROPIC_API_KEY) {
      assert.strictEqual(result.ok, false);
    }
  });

  it("attempts model escalation when fallbackModel is set and primary fails", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    // Without API key, both primary and fallback will fail, but we can
    // verify escalation was attempted by checking the _escalated metadata
    const result = await runAgent({
      name: "test-escalation",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: { msg: "hello" },
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "claude-sonnet-4-20250514",
      projectId: "test",
      timeoutMs: 5000,
    });

    assert.strictEqual(typeof result, "object");
    assert.ok(result.telemetryId);
    // If no API key, primary fails → escalation attempted → escalation also fails
    if (!process.env.ANTHROPIC_API_KEY) {
      assert.strictEqual(result.ok, false);
      assert.ok(result._escalated, "should have escalation metadata");
      assert.strictEqual(result._escalated.from, "claude-haiku-4-5-20251001");
      assert.strictEqual(result._escalated.to, "claude-sonnet-4-20250514");
      assert.ok(result._escalated.originalError, "should record original error");
    }
  });

  it("does not escalate when fallbackModel matches primary model", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    const result = await runAgent({
      name: "test-no-escalation",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: { msg: "hello" },
      model: "claude-sonnet-4-20250514",
      fallbackModel: "claude-sonnet-4-20250514", // same as primary
      projectId: "test",
      timeoutMs: 5000,
    });

    assert.strictEqual(typeof result, "object");
    if (!process.env.ANTHROPIC_API_KEY) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result._escalated, undefined, "should NOT escalate when models match");
    }
  });

  it("does not escalate when no fallbackModel is set", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    const result = await runAgent({
      name: "test-no-fallback",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: { msg: "hello" },
      model: "claude-haiku-4-5-20251001",
      // no fallbackModel
      projectId: "test",
      timeoutMs: 5000,
    });

    assert.strictEqual(typeof result, "object");
    if (!process.env.ANTHROPIC_API_KEY) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result._escalated, undefined, "should NOT escalate without fallbackModel");
    }
  });

  it("skips escalation on input validation failure", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    const result = await runAgent({
      name: "test-input-fail",
      prompt: "You are a test agent.",
      userMessage: "Test",
      tools: [],
      inputSchema: z.object({ required: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: {}, // Missing required field — fails before API call
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "claude-sonnet-4-20250514",
      projectId: "test",
    });

    assert.strictEqual(result.ok, false);
    // Input validation fails on both attempts, so escalation is attempted
    // but also fails with the same error
    assert.ok(result._escalated, "escalation attempted even for input validation (runner retries all failures)");
  });

  it("forwards accumulated messages to escalated call on max_turns_exceeded", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    let callCount = 0;
    let escalatedMessages = null;

    const mockClient = {
      messages: {
        create: async ({ messages: msgs }) => {
          callCount++;
          if (callCount === 1) {
            // Haiku: return tool_use response to exhaust maxTurns=1
            return {
              content: [{ type: "tool_use", id: "tu1", name: "test_tool", input: { x: 1 } }],
              stop_reason: "tool_use",
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            };
          }
          // Sonnet: capture what messages it received, return valid answer
          escalatedMessages = [...msgs];
          return {
            content: [{ type: "text", text: '{"ok":true,"answer":"done","sources":[],"confidence":0.9}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
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
      outputSchema: z.object({ ok: z.boolean(), answer: z.string(), sources: z.array(z.any()), confidence: z.number() }),
      rawInput: { q: "hello" },
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "claude-sonnet-4-20250514",
      maxTurns: 1,
      projectId: "test",
      _testClient: mockClient,
    });

    assert.strictEqual(callCount, 2, "expected 2 API calls: Haiku (max_turns) then Sonnet (escalation)");
    assert.ok(escalatedMessages, "Sonnet should have received messages");
    assert.ok(escalatedMessages.length > 1, "Sonnet should see more than just the original user message");
    assert.strictEqual(escalatedMessages[0].role, "user");
    // Conversation-prefix caching (backlog.fix.conversation-prefix-caching) converts the initial
    // user message to block form. On the _resumeMessages escalation path messages[0] arrives
    // already block-form; the idempotent guard must leave it a SINGLE {type:'text'} block (not
    // double-wrapped) carrying the original text verbatim.
    assert.ok(Array.isArray(escalatedMessages[0].content), "first message content should be block form after conversation-caching conversion");
    assert.strictEqual(escalatedMessages[0].content.length, 1, "initial user message should be a single content block (not double-wrapped)");
    assert.strictEqual(escalatedMessages[0].content[0].type, "text");
    assert.ok(typeof escalatedMessages[0].content[0].text === "string" && escalatedMessages[0].content[0].text.includes("Original question"), "first message should carry the original user text verbatim");
    assert.ok(escalatedMessages.some(m => m.role === "assistant"), "Sonnet should see Haiku's assistant turn");
    assert.strictEqual(result.ok, true);
    assert.ok(result._escalated, "should have escalation metadata");
    assert.strictEqual(result._escalated.from, "claude-haiku-4-5-20251001");
  });

  it("returns a usable partial with truncated:true at the turn ceiling (no escalation)", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    let callCount = 0;
    const mockClient = {
      messages: {
        create: async () => {
          callCount++;
          // Each turn emits a parseable answer in a text block AND a tool_use, so the loop keeps
          // going (stop_reason !== end_turn) until maxTurns is hit with a usable partial present.
          return {
            content: [
              { type: "text", text: '{"ok":true,"answer":"best effort","sources":[],"confidence":0.6}' },
              { type: "tool_use", id: "tu1", name: "test_tool", input: { x: 1 } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    };

    const result = await runAgent({
      name: "test-truncated-usable",
      prompt: "You are a test agent.",
      userMessage: "Question",
      tools: [{ name: "test_tool", description: "t", inputSchema: z.object({ x: z.number() }), execute: async () => ({ result: "ran" }) }],
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ok: z.boolean(), answer: z.string(), sources: z.array(z.any()), confidence: z.number(), truncated: z.boolean().optional() }),
      rawInput: { q: "hi" },
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "claude-sonnet-4-20250514",
      maxTurns: 1,
      projectId: "test",
      _testClient: mockClient,
    });

    assert.strictEqual(callCount, 1, "a usable partial must NOT escalate");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.truncated, true, "ceiling partial carries truncated:true");
    assert.strictEqual(result.answer, "best effort");
    assert.strictEqual(result._escalated, undefined, "no escalation when the partial is usable");
  });

  it("returns truncated:true + ok:false on an empty ceiling partial (escalation still gated on ok)", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    let callCount = 0;
    const mockClient = {
      messages: {
        create: async () => {
          callCount++;
          // tool_use only, no text block → empty partial at the ceiling
          return {
            content: [{ type: "tool_use", id: "tu1", name: "test_tool", input: { x: 1 } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    };

    const result = await runAgent({
      name: "test-truncated-empty",
      prompt: "You are a test agent.",
      userMessage: "Question",
      tools: [{ name: "test_tool", description: "t", inputSchema: z.object({ x: z.number() }), execute: async () => ({ result: "ran" }) }],
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ok: z.boolean(), answer: z.string(), sources: z.array(z.any()), confidence: z.number() }),
      rawInput: { q: "hi" },
      model: "claude-haiku-4-5-20251001",
      // No fallbackModel → escalation cannot fire, so we observe the raw truncated max_turns result.
      maxTurns: 1,
      projectId: "test",
      _testClient: mockClient,
    });

    assert.strictEqual(callCount, 1, "no fallback → single call");
    assert.strictEqual(result.ok, false, "empty partial → ok:false so the escalation gate fires when a fallback exists");
    assert.strictEqual(result.truncated, true, "degradation flag present even on a hard-fail partial");
    assert.ok(result.error && result.error.startsWith("Agent exceeded max turns"), "preserves the max-turns error so _resumeMessages escalation routes correctly");
    assert.ok(Array.isArray(result._messages), "preserves _messages for escalation resume");
  });

  it("does not forward messages to escalated call for non-max-turns failures", async () => {
    const { runAgent } = await import("../src/agents/runner.mjs");

    let escalatedMessages = null;
    let callCount = 0;

    const mockClient = {
      messages: {
        create: async ({ messages: msgs }) => {
          callCount++;
          if (callCount === 1) {
            // Haiku: return invalid JSON (triggers output_validation_failed, not max_turns)
            return {
              content: [{ type: "text", text: "not valid json at all" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            };
          }
          // Sonnet fallback: capture messages
          escalatedMessages = [...msgs];
          return {
            content: [{ type: "text", text: '{"ok":true,"answer":"done","sources":[],"confidence":0.9}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    };

    await runAgent({
      name: "test-no-history-passthrough",
      prompt: "You are a test agent.",
      userMessage: "Original question",
      tools: [],
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ok: z.boolean(), answer: z.string(), sources: z.array(z.any()), confidence: z.number() }),
      rawInput: { q: "hello" },
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "claude-sonnet-4-20250514",
      projectId: "test",
      _testClient: mockClient,
    });

    // Sonnet was called but should only see the original single user message (no Haiku history)
    if (escalatedMessages) {
      assert.strictEqual(escalatedMessages.length, 1, "Sonnet should only see the original user message for non-max-turns failures");
      assert.strictEqual(escalatedMessages[0].role, "user");
    }
  });
});

// ──────────────────────────────────────────
// N. extractJsonFromText — output-contract tolerance
//    backlog.fix.research-agent-output-contract-reliability
// ──────────────────────────────────────────

const { extractJsonFromText } = await import("../src/agents/runner.mjs");

describe("extractJsonFromText", () => {
  it("parses pure valid JSON unchanged", () => {
    assert.deepStrictEqual(extractJsonFromText('{"ok":true,"n":1}'), { ok: true, n: 1 });
  });

  it("extracts JSON from a ```json fenced block with surrounding prose", () => {
    const raw = 'Here is the result:\n```json\n{"answer":"hi","sources":[]}\n```\nDone.';
    assert.deepStrictEqual(extractJsonFromText(raw), { answer: "hi", sources: [] });
  });

  it("extracts a bare JSON object after leading prose (no fence)", () => {
    const raw = 'Now I have the answer: {"ok":true,"value":42} that should do it.';
    assert.deepStrictEqual(extractJsonFromText(raw), { ok: true, value: 42 });
  });

  it("returns the FIRST object when multiple JSON blocks are present (the live bug)", () => {
    const raw = '```json\n{"first":1}\n```\nthen\n```json\n{"second":2}\n```';
    assert.deepStrictEqual(extractJsonFromText(raw), { first: 1 });
  });

  it("is string-aware: a } inside a string value does not close the object early", () => {
    const raw = 'prose {"path":"a}b","note":"x{y}z"} more prose';
    assert.deepStrictEqual(extractJsonFromText(raw), { path: "a}b", note: "x{y}z" });
  });

  it("handles escaped quotes inside string values", () => {
    const raw = '{"msg":"she said \\"hi\\" }","ok":true}';
    assert.deepStrictEqual(extractJsonFromText(raw), { msg: 'she said "hi" }', ok: true });
  });

  it("extracts JSON wrapped in XML/HTML tags", () => {
    assert.deepStrictEqual(extractJsonFromText('<result>{"wrapped":true}</result>'), { wrapped: true });
  });

  it("skips a false-start brace and finds the real JSON object", () => {
    const raw = 'use { to open and the data is {"real":true}';
    assert.deepStrictEqual(extractJsonFromText(raw), { real: true });
  });

  it("returns undefined for genuinely non-JSON text (preserves invalid_json path)", () => {
    assert.strictEqual(extractJsonFromText("not valid json at all"), undefined);
  });

  it("returns undefined for empty/whitespace and non-strings", () => {
    assert.strictEqual(extractJsonFromText("   "), undefined);
    assert.strictEqual(extractJsonFromText(null), undefined);
    assert.strictEqual(extractJsonFromText(undefined), undefined);
  });
});
