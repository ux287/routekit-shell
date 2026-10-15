/**
 * S3 of research.2026.10.05.server-mjs-safe-decomposition
 * (backlog.feat.server-mjs-project-meta-handler-family): the project/meta family registration
 * (PM-TR1..PM-TR6). Mirrors the S2 layout of tests/unit/server-handler-registry.test.mjs,
 * which this story does not edit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { readToolHandlerSource } from "../_helpers/server-source.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const PROJECT_META_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers/project-meta.mjs");

// server.mjs order (PM-TR5).
const SOURCE_ORDER = [
  "rks_project_get",
  "rks_kg_query",
  "rks_templates_list",
  "rks_git_state",
  "rks_publish",
  "rks_publish_profiles",
  "rks_channel_preview",
];
const PROJECT_META_TOOLS = [...SOURCE_ORDER].sort();
// Relative imports added AFTER the S3 move (new modules, not moved code): exempt from the
// "server.mjs imports it too" half of PM-TR4, but each must exist and be imported.
const POST_MOVE_SPECIFIERS = ["../channel-preview.mjs"];
const SCHEMA_KEY = {
  rks_project_get: "projectGetSchema",
  rks_kg_query: "kgQuerySchema",
  rks_templates_list: "templatesListSchema",
  rks_git_state: "gitStateSchema",
  rks_publish: "publishSchema",
  rks_publish_profiles: "publishProfilesSchema",
  rks_channel_preview: "channelPreviewSchema",
};
const TELEMETRY_TOOLS = [
  "rks_telemetry_analysis",
  "rks_telemetry_digest",
  "rks_telemetry_export",
  "rks_telemetry_query",
  "rks_telemetry_report",
  "rks_token_cost_report",
];

const marker = (tool) => `injectedMarker_${tool}`;
// Each injected schema requires a field only that tool's schema knows, so a ZodError naming it
// proves the handler parsed with the schema passed in at registration.
const schemas = () =>
  Object.fromEntries(
    Object.entries(SCHEMA_KEY).map(([tool, key]) => [key, z.object({ [marker(tool)]: z.string() })]),
  );
const telemetrySchemas = () => {
  const strict = () => z.object({ projectId: z.string() });
  return {
    telemetryQuerySchema: strict(),
    telemetryReportSchema: strict(),
    telemetryAnalysisSchema: strict(),
    tokenCostReportSchema: strict(),
    telemetryExportSchema: strict(),
  };
};

// Static `import ... from "spec"` specifiers (multi-line import lists included).
function importSpecifiers(src) {
  return [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");

describe("registerProjectMetaHandlers", () => {
  it("PM-TR1 registers exactly the six project/meta tools, each as a function", () => {
    const r = createHandlerRegistry();
    registerProjectMetaHandlers(r, schemas());
    expect(r.registeredTools()).toEqual(PROJECT_META_TOOLS);
    for (const tool of PROJECT_META_TOOLS) {
      expect(typeof r.lookupHandler(tool)).toBe("function");
    }
  });

  it("PM-TR2 coexists with the telemetry family on one registry and registers cleanly on fresh registries", () => {
    const r = createHandlerRegistry();
    registerTelemetryHandlers(r, telemetrySchemas());
    expect(() => registerProjectMetaHandlers(r, schemas())).not.toThrow();
    expect(r.registeredTools()).toEqual([...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS].sort());
    expect(() => registerProjectMetaHandlers(createHandlerRegistry(), schemas())).not.toThrow();
    expect(() => registerProjectMetaHandlers(createHandlerRegistry(), schemas())).not.toThrow();
  });

  it.each(SOURCE_ORDER)("PM-TR3 %s rejects {} with a ZodError from its injected schema (no IO)", async (tool) => {
    const r = createHandlerRegistry();
    registerProjectMetaHandlers(r, schemas());
    const ctx = Object.freeze({ tool, args: {}, activeToken: undefined, governorToken: undefined });
    const err = await r.lookupHandler(tool)({}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(err.issues.map((i) => i.path.join("."))).toContain(marker(tool));
  });
});

describe("project-meta.mjs source", () => {
  const src = fs.readFileSync(PROJECT_META_ABS, "utf8");
  const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");

  it("PM-TR4 bare specifiers are byte-identical to server.mjs; relative specifiers resolve to files server.mjs imports", () => {
    expect(src).toMatch(/from\s+"child_process"/);
    expect(src).not.toContain("node:child_process");
    expect(src).toMatch(/from\s+"@modelcontextprotocol\/sdk\/types\.js"/);

    const own = importSpecifiers(src);
    const server = importSpecifiers(serverSrc);
    expect(own.length).toBeGreaterThan(0);
    expect(server.length).toBeGreaterThan(0);

    const serverBare = new Set(server.filter((s) => !isRelative(s)));
    for (const spec of own.filter((s) => !isRelative(s))) {
      expect(serverBare.has(spec), spec).toBe(true);
    }

    const serverResolved = new Set(
      server.filter(isRelative).map((s) => path.resolve(path.dirname(SERVER_ABS), s)),
    );
    const ownRelative = own.filter(isRelative);
    expect(ownRelative.length).toBeGreaterThan(0);
    for (const spec of ownRelative) {
      const abs = path.resolve(path.dirname(PROJECT_META_ABS), spec);
      expect(fs.existsSync(abs), spec).toBe(true);
      if (POST_MOVE_SPECIFIERS.includes(spec)) continue;
      expect(serverResolved.has(abs), spec).toBe(true);
    }
    for (const spec of POST_MOVE_SPECIFIERS) expect(ownRelative, spec).toContain(spec);
  });

  it("PM-TR5 registers the six in server.mjs order, each exactly once", () => {
    const positions = SOURCE_ORDER.map((tool) => {
      const head = `registerHandler("${tool}"`;
      const at = src.indexOf(head);
      expect(at, tool).toBeGreaterThan(-1);
      expect(src.indexOf(head, at + 1), tool).toBe(-1);
      return at;
    });
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it.each(SOURCE_ORDER)("PM-TR6 %s keeps the frozen wrapper and reads no ctx or chain state", (tool) => {
    const wrapper = `registerHandler("${tool}", async (cleanArgs, ctx) =>`;
    const slice = readToolHandlerSource(tool);
    expect(slice.startsWith(wrapper)).toBe(true);
    const body = slice.slice(wrapper.length);
    expect(body).not.toMatch(/\bctx\b/);
    expect(body).not.toMatch(
      /activeToken|governorToken|advanceStateOnResult|revertStateOnFailure|pendingPlans|getTelemetryCollector/,
    );
  });
});
