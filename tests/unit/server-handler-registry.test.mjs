/**
 * S2 of research.2026.10.05.server-mjs-safe-decomposition
 * (backlog.feat.server-mjs-handler-registry-telemetry-pilot): per-server handler registry
 * contract (TR1-TR4) and the telemetry family registration (TR5-TR7).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY_REL = "packages/mcp-rks/src/server/handlers/registry.mjs";
const TELEMETRY_REL = "packages/mcp-rks/src/server/handlers/telemetry.mjs";
const TELEMETRY_TOOLS = [
  "rks_telemetry_analysis",
  "rks_telemetry_digest",
  "rks_telemetry_export",
  "rks_telemetry_query",
  "rks_telemetry_report",
  "rks_token_cost_report",
];
const LAZY_SUBPATHS = ["digest", "query", "reports", "analysis", "cost-report", "export"];

const strict = () => z.object({ projectId: z.string() });
const schemas = (overrides = {}) => ({
  telemetryQuerySchema: strict(),
  telemetryReportSchema: strict(),
  telemetryAnalysisSchema: strict(),
  tokenCostReportSchema: strict(),
  telemetryExportSchema: strict(),
  ...overrides,
});

describe("createHandlerRegistry", () => {
  it("TR1 registers, looks up and lists tools; unknown lookup is null", () => {
    const r = createHandlerRegistry();
    expect(typeof r.registerHandler).toBe("function");
    expect(typeof r.lookupHandler).toBe("function");
    expect(typeof r.registeredTools).toBe("function");
    const hb = async () => ({ content: [{ type: "text", text: "b" }] });
    const ha = async () => ({ content: [{ type: "text", text: "a" }] });
    r.registerHandler("b_tool", hb);
    r.registerHandler("a_tool", ha);
    expect(r.lookupHandler("a_tool")).toBe(ha);
    expect(r.lookupHandler("b_tool")).toBe(hb);
    expect(r.lookupHandler("nope")).toBeNull();
    expect(r.registeredTools()).toEqual(["a_tool", "b_tool"]);
  });

  it("TR2 duplicate registration throws naming the tool; invalid name or handler throws TypeError", () => {
    const r = createHandlerRegistry();
    const h = async () => ({ content: [] });
    r.registerHandler("dup_tool", h);
    expect(() => r.registerHandler("dup_tool", h)).toThrow(Error);
    expect(() => r.registerHandler("dup_tool", h)).toThrow(/dup_tool/);
    expect(() => r.registerHandler("", h)).toThrow(TypeError);
    expect(() => r.registerHandler(42, h)).toThrow(TypeError);
    expect(() => r.registerHandler(undefined, h)).toThrow(TypeError);
    expect(() => r.registerHandler("ok_tool", "not a function")).toThrow(TypeError);
    expect(() => r.registerHandler("ok_tool", null)).toThrow(TypeError);
    expect(r.registeredTools()).toEqual(["dup_tool"]);
  });

  it("TR3 two registries are independent (per-server, no double-registration across createServer calls)", () => {
    const one = createHandlerRegistry();
    const two = createHandlerRegistry();
    const h = async () => ({ content: [] });
    one.registerHandler("solo_tool", h);
    expect(two.lookupHandler("solo_tool")).toBeNull();
    expect(two.registeredTools()).toEqual([]);
    expect(() => two.registerHandler("solo_tool", h)).not.toThrow();
    expect(one.registeredTools()).toEqual(["solo_tool"]);
    expect(two.registeredTools()).toEqual(["solo_tool"]);

    // The telemetry family registers cleanly on two fresh registries as well.
    expect(() => registerTelemetryHandlers(createHandlerRegistry(), schemas())).not.toThrow();
    expect(() => registerTelemetryHandlers(createHandlerRegistry(), schemas())).not.toThrow();
  });

  it("TR4 / RR6 the module header documents the frozen handler contract, the resolver and the additive ctx key", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, REGISTRY_REL), "utf8");
    const header = src.slice(0, src.indexOf("export function createHandlerRegistry"));
    for (const token of ["cleanArgs", "ctx", "activeToken", "governorToken", "revertEntryTransition", "registerResolver"]) {
      expect(header).toContain(token);
    }
    expect(header).toMatch(/returns .* or throws/);
    // S10: the registry is the only dispatch path; the chain is retired.
    expect(header).not.toContain("legacy if-chain");
  });
});

// S10 (backlog.feat.server-mjs-registry-only-dispatch): single lazy resolver consulted on a name-map miss.
describe("createHandlerRegistry registerResolver", () => {
  it("RR1 a named registration wins over the resolver; the resolver is consulted only on a name-map miss", () => {
    const r = createHandlerRegistry();
    const named = async () => ({ content: [] });
    const resolved = async () => ({ content: [] });
    const resolver = vi.fn(() => resolved);
    r.registerHandler("both_tool", named);
    r.registerResolver(resolver);
    expect(r.lookupHandler("both_tool")).toBe(named);
    expect(resolver).not.toHaveBeenCalled();
    expect(r.lookupHandler("other_tool")).toBe(resolved);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("other_tool");
    expect(resolver).not.toHaveBeenCalledWith("both_tool");
  });

  it("RR2 on a name miss lookupHandler returns exactly the resolver value, null for a null/undefined resolver value, null with no resolver", () => {
    const h = async () => ({ content: [] });
    const r = createHandlerRegistry();
    r.registerResolver((t) => (t === "res_tool" ? h : t === "undef_tool" ? undefined : null));
    expect(r.lookupHandler("res_tool")).toBe(h);
    expect(r.lookupHandler("null_tool")).toBeNull();
    expect(r.lookupHandler("undef_tool")).toBeNull();
    // TR1 unchanged: no resolver installed, unknown name is null.
    expect(createHandlerRegistry().lookupHandler("nope")).toBeNull();
  });

  it("RR3 the resolver is invoked with the requested name on every lookup (no caching)", () => {
    const h = async () => ({ content: [] });
    const resolver = vi.fn(() => h);
    const r = createHandlerRegistry();
    r.registerResolver(resolver);
    r.lookupHandler("lazy_tool");
    r.lookupHandler("lazy_tool");
    r.lookupHandler("lazy_tool");
    expect(resolver).toHaveBeenCalledTimes(3);
    for (const call of resolver.mock.calls) expect(call).toEqual(["lazy_tool"]);
  });

  it("RR4 registeredTools() lists named registrations only", () => {
    const h = async () => ({ content: [] });
    const r = createHandlerRegistry();
    r.registerHandler("named_tool", h);
    r.registerResolver((t) => (t === "res_tool" ? h : null));
    expect(r.lookupHandler("res_tool")).toBe(h);
    expect(r.registeredTools()).toEqual(["named_tool"]);
    expect(r.registeredTools()).not.toContain("res_tool");
  });

  it("RR5 a second registerResolver throws Error; a non-function throws TypeError and installs nothing; registries are independent", () => {
    const h = async () => ({ content: [] });
    for (const bad of ["fn", 42, null, undefined]) {
      const r = createHandlerRegistry();
      expect(() => r.registerResolver(bad)).toThrow(TypeError);
      expect(r.lookupHandler("any_tool")).toBeNull();
      // Nothing was installed, so a valid resolver can still be registered.
      expect(() => r.registerResolver(() => h)).not.toThrow();
      expect(r.lookupHandler("any_tool")).toBe(h);
    }
    const r = createHandlerRegistry();
    r.registerResolver(() => null);
    expect(() => r.registerResolver(() => h)).toThrow(Error);
    expect(r.lookupHandler("any_tool")).toBeNull();

    const one = createHandlerRegistry();
    const two = createHandlerRegistry();
    const h1 = async () => ({ content: [] });
    const h2 = async () => ({ content: [] });
    one.registerResolver(() => h1);
    expect(two.lookupHandler("x_tool")).toBeNull();
    expect(() => two.registerResolver(() => h2)).not.toThrow();
    expect(one.lookupHandler("x_tool")).toBe(h1);
    expect(two.lookupHandler("x_tool")).toBe(h2);
  });
});

describe("registerTelemetryHandlers", () => {
  it("TR5 registers exactly the six telemetry tools, each as a function", () => {
    const r = createHandlerRegistry();
    registerTelemetryHandlers(r, schemas());
    expect(r.registeredTools()).toEqual(TELEMETRY_TOOLS);
    for (const tool of TELEMETRY_TOOLS) {
      expect(typeof r.lookupHandler(tool)).toBe("function");
    }
  });

  it("TR6 digest rejects {} with a ZodError from its inline schema (no IO)", async () => {
    const r = createHandlerRegistry();
    registerTelemetryHandlers(r, schemas());
    const ctx = Object.freeze({ tool: "rks_telemetry_digest", args: {}, activeToken: undefined, governorToken: undefined });
    const err = await r.lookupHandler("rks_telemetry_digest")({}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain("projectId");
  });

  it("TR6 query rejects {} with a ZodError raised by the injected telemetryQuerySchema", async () => {
    const injected = z.object({ projectId: z.string(), injectedQueryMarker: z.string() });
    const r = createHandlerRegistry();
    registerTelemetryHandlers(r, schemas({ telemetryQuerySchema: injected }));
    const ctx = Object.freeze({ tool: "rks_telemetry_query", args: {}, activeToken: undefined, governorToken: undefined });
    const err = await r.lookupHandler("rks_telemetry_query")({}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    const paths = err.issues.map((i) => i.path.join("."));
    expect(paths).toContain("projectId");
    // Only the injected schema knows this field, so the issue proves the argument is used.
    expect(paths).toContain("injectedQueryMarker");
  });

  it("TR7 has no static @routekit/telemetry import and keeps the six lazy specifiers byte-identical", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, TELEMETRY_REL), "utf8");
    expect(src).not.toMatch(/^\s*import\s[^;]*?from\s+["']@routekit\/telemetry/m);
    expect(src).not.toMatch(/^\s*import\s+["']@routekit\/telemetry/m);
    for (const sub of LAZY_SUBPATHS) {
      expect(src).toContain(`await import("@routekit/telemetry/${sub}")`);
    }
  });
});
