import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import {
  generateAgentToolDefinitions,
  getAgent,
  getAgentByToolName,
  listAgents,
} from "../../../packages/mcp-rks/src/agents/registry.mjs";
import { zodToJsonSchema } from "../../../packages/mcp-rks/src/agents/zod-to-json-schema.mjs";

// Ported from the retired node:test suite packages/mcp-rks/__tests__/agent-runner.spec.mjs
// (`zodToJsonSchema`, `Agent Registry` and `generateAgentToolDefinitions — null/invalid inputSchema
// hardening` blocks; ran in no CI tier). backlog.chore.retire-agent-runner-node-test-spec.

afterEach(() => {
  vi.restoreAllMocks();
});

// backlog.feat.listtools-null-inputschema-guard: a child project's custom agent registers with
// inputSchema:null (discovery.mjs). The optional `registry` argument exercises the loop with
// crafted null / non-Zod schemas without mutating the module registry.
describe("generateAgentToolDefinitions — null/invalid inputSchema hardening", () => {
  it("emits a generic permissive schema for an agent with inputSchema:null", () => {
    const registry = {
      "proj-agent": {
        inputSchema: null,
        description: "A project agent using generic input",
        toolName: "rks_agent_proj_agent",
        source: "project",
      },
    };
    const tool = generateAgentToolDefinitions(registry).find((t) => t.name === "rks_agent_proj_agent");
    expect(tool).toBeTruthy();
    expect(tool.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
  });

  it("still converts a real Zod inputSchema unchanged", () => {
    const registry = {
      zsample: {
        inputSchema: z.object({ projectId: z.string(), count: z.number() }),
        description: "a core-like agent with a real Zod schema",
        toolName: "rks_agent_zsample",
        source: "core",
      },
    };
    const tool = generateAgentToolDefinitions(registry).find((t) => t.name === "rks_agent_zsample");
    expect(tool).toBeTruthy();
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { projectId: { type: "string" }, count: { type: "number" } },
      required: ["projectId", "count"],
    });
  });

  it("skips a malformed agent while the others still enumerate", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = {
      "good-null": { inputSchema: null, description: "d", toolName: "rks_agent_good_null", source: "project" },
      // truthy but non-Zod (no _def): zodToJsonSchema throws inside the loop
      bad: { inputSchema: {}, description: "d", toolName: "rks_agent_bad", source: "core" },
      "good-zod": { inputSchema: z.object({ x: z.string() }), description: "d", toolName: "rks_agent_good_zod", source: "core" },
    };
    let tools;
    expect(() => { tools = generateAgentToolDefinitions(registry); }).not.toThrow();
    const names = tools.map((t) => t.name);
    expect(names).toContain("rks_agent_run");
    expect(names).toContain("rks_agent_good_null");
    expect(names).toContain("rks_agent_good_zod");
    expect(names).not.toContain("rks_agent_bad");
  });

  it("logs the skipped malformed agent to stderr", () => {
    const logged = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args.map(String).join(" ")); });
    const registry = {
      bad: { inputSchema: {}, description: "d", toolName: "rks_agent_bad", source: "core" },
      ok: { inputSchema: null, description: "d", toolName: "rks_agent_ok", source: "project" },
    };
    const tools = generateAgentToolDefinitions(registry);
    expect(logged.some((l) => l.includes("'bad'"))).toBe(true);
    expect(tools.map((t) => t.name)).toContain("rks_agent_ok");
  });

  it("default (module registry) call enumerates the generic runner and the core convenience tools", () => {
    let tools;
    expect(() => { tools = generateAgentToolDefinitions(); }).not.toThrow();
    const names = tools.map((t) => t.name);
    for (const name of [
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
    ]) {
      expect(names, name).toContain(name);
    }
  });
});

describe("zodToJsonSchema", () => {
  it("throws on non-Zod input", () => {
    expect(() => zodToJsonSchema(null)).toThrow(/expected a Zod schema/);
    expect(() => zodToJsonSchema({})).toThrow(/expected a Zod schema/);
  });

  it("converts a simple object schema", () => {
    expect(zodToJsonSchema(z.object({ name: z.string(), age: z.number() }))).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
  });

  it("converts optional, default, enum, array, boolean, bounded integer, min-length string and described fields", () => {
    // optional: excluded from required, still present in properties
    const optional = zodToJsonSchema(z.object({ required: z.string(), optional: z.string().optional() }));
    expect(optional.required).toEqual(["required"]);
    expect(optional.properties.optional).toBeTruthy();

    // default: value carried, field not required
    const withDefault = zodToJsonSchema(z.object({ count: z.number().default(10) }));
    expect(withDefault.properties.count.default).toBe(10);
    expect(withDefault.required).toBeUndefined();

    // enum
    expect(zodToJsonSchema(z.object({ status: z.enum(["ready", "draft", "blocked"]) })).properties.status).toEqual({
      type: "string",
      enum: ["ready", "draft", "blocked"],
    });

    // array
    expect(zodToJsonSchema(z.object({ tags: z.array(z.string()) })).properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });

    // boolean
    expect(zodToJsonSchema(z.object({ enabled: z.boolean() })).properties.enabled).toEqual({ type: "boolean" });

    // bounded integer
    const int = zodToJsonSchema(z.object({ count: z.number().int().min(1).max(20) })).properties.count;
    expect(int.type).toBe("integer");
    expect(int.minimum).toBe(1);
    expect(int.maximum).toBe(20);

    // min-length string
    expect(zodToJsonSchema(z.object({ query: z.string().min(5) })).properties.query.minLength).toBe(5);

    // .describe() annotation
    expect(
      zodToJsonSchema(z.object({ projectId: z.string().describe("Project identifier") })).properties.projectId.description,
    ).toBe("Project identifier");
  });
});

describe("Agent Registry lookups", () => {
  it("listAgents includes the product-owner and research agents", () => {
    const agents = listAgents();
    expect(agents).toContain("product-owner");
    expect(agents).toContain("research");
  });

  it("getAgent returns a factory for known agents and null for an unknown name", () => {
    expect(typeof getAgent("product-owner")).toBe("function");
    expect(typeof getAgent("research")).toBe("function");
    expect(getAgent("nonexistent")).toBeNull();
  });

  it("getAgentByToolName resolves the convenience tool names to their agents", () => {
    expect(getAgentByToolName("rks_agent_validate_story")?.name).toBe("product-owner");
    expect(getAgentByToolName("rks_agent_research")?.name).toBe("research");
  });

  it("getAgentByToolName returns null for an unknown tool name", () => {
    expect(getAgentByToolName("rks_agent_nonexistent")).toBeNull();
  });
});
