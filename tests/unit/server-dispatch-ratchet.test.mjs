/**
 * S2 regrowth ratchet (backlog.feat.server-mjs-handler-registry-telemetry-pilot), part of
 * research.2026.10.05.server-mjs-safe-decomposition.
 *
 * Later move stories lower DISPATCH_HEAD_BASELINE by exactly the count they move. The
 * "equals the baseline" pin (TR9) is deliberately exact: it goes red when ANY story adds or
 * removes an `if (tool === …)` head in server.mjs without updating the baseline here. That is
 * intended — the baseline is a recorded fact about HEAD, not a soft ceiling.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverSurfaceFiles } from "../_helpers/server-source.mjs";

export const DISPATCH_HEAD_BASELINE = 0;

// Same head definition as tests/_helpers/server-source.mjs: compound conditions are not heads.
const HEAD_RE = /if \(tool === (?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_$][\w$]*))\)/g;
// String-literal registrations.
const REGISTRATION_RE = /(?<![\w$])registerHandler\(\s*(?:"([^"\n]+)"|'([^'\n]+)')/g;
// S6: identifier registrations, e.g. `registerHandler(GIT_PREFLIGHT_TOOL, async (cleanArgs, ctx) => {`.
// `, async` is required after the identifier so the registry.mjs method definition
// `registerHandler(tool, handler) {` is not counted as a registration.
const IDENTIFIER_REGISTRATION_RE = /(?<![\w$])registerHandler\(\s*([A-Za-z_$][\w$]*)\s*,\s*async\b/g;

// S6 (backlog.feat.server-mjs-git-handler-family): declared identifier -> tool-name map. Each
// value is checked against the constant's source module below. An identifier registration whose
// identifier is not a key here fails closed.
export const IDENTIFIER_TOOL_NAMES = Object.freeze({
  GIT_PREFLIGHT_TOOL: "rks_git_preflight",
  // S9b (backlog.feat.server-mjs-governance-handler-family).
  ARCH_VERDICT_TOOL: "rks_arch_verdict",
  GOVERNOR_INIT_TOOL: "rks_governor_init",
});
const IDENTIFIER_SOURCES = {
  GIT_PREFLIGHT_TOOL: "packages/mcp-rks/src/tools/git-preflight.mjs",
  ARCH_VERDICT_TOOL: "packages/mcp-rks/src/workflow/arch-verdict.mjs",
  GOVERNOR_INIT_TOOL: "packages/mcp-rks/src/tools/governor-init.mjs",
};

function resolveRegistrationIdentifier(identifier) {
  if (!Object.prototype.hasOwnProperty.call(IDENTIFIER_TOOL_NAMES, identifier)) {
    throw new Error(`registerHandler identifier ${identifier} is not in IDENTIFIER_TOOL_NAMES`);
  }
  return IDENTIFIER_TOOL_NAMES[identifier];
}

// Raw heads: identifier heads are reported as the identifier (TR9/TR10 count heads, not names).
export function dispatchHeads(src) {
  return [...src.matchAll(HEAD_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
}

// Heads with mapped identifiers resolved to their tool names; unmapped identifier heads are
// reported as-is. Since S9b no identifier head remains in server.mjs.
export function resolvedDispatchHeads(src) {
  return dispatchHeads(src).map((h) =>
    Object.prototype.hasOwnProperty.call(IDENTIFIER_TOOL_NAMES, h) ? IDENTIFIER_TOOL_NAMES[h] : h,
  );
}

export function registeredToolNames(sources) {
  const names = [];
  for (const src of sources) {
    for (const m of src.matchAll(REGISTRATION_RE)) names.push(m[1] ?? m[2]);
    for (const m of src.matchAll(IDENTIFIER_REGISTRATION_RE)) names.push(resolveRegistrationIdentifier(m[1]));
  }
  return names;
}

export function dualDispatch(serverSrc, handlerSources) {
  const heads = new Set(resolvedDispatchHeads(serverSrc));
  return [...new Set(registeredToolNames(handlerSources))].filter((t) => heads.has(t)).sort();
}

const TELEMETRY_TOOLS = [
  "rks_telemetry_analysis",
  "rks_telemetry_digest",
  "rks_telemetry_export",
  "rks_telemetry_query",
  "rks_telemetry_report",
  "rks_token_cost_report",
];
const TELEMETRY_SUBPATHS = ["digest", "query", "reports", "analysis", "cost-report", "export"];
// S3 (backlog.feat.server-mjs-project-meta-handler-family).
const PROJECT_META_TOOLS = [
  "rks_git_state",
  "rks_kg_query",
  "rks_project_get",
  "rks_publish",
  "rks_publish_profiles",
  "rks_channel_preview",
  "rks_templates_list",
];

// S4 (backlog.feat.server-mjs-dendron-handler-family).
const DENDRON_TOOLS = [
  "dendron_create_note",
  "dendron_edit_note",
  "dendron_fix_frontmatter",
  "dendron_mark_implemented",
  "dendron_read_note",
  "dendron_update_field",
  "dendron_validate_schema",
];

// S5 (backlog.feat.server-mjs-rag-handler-family).
const RAG_TOOLS = [
  "rks_exhaustive_search",
  "rks_fetch_raw",
  "rks_memory_save",
  "rks_rag_compact",
  "rks_rag_embed",
  "rks_rag_init",
  "rks_rag_query",
];

// S6 (backlog.feat.server-mjs-git-handler-family).
const GIT_TOOLS = [
  "rks_branch_repair",
  "rks_checkout",
  "rks_cherry_pick",
  "rks_git_branch",
  "rks_git_commit",
  "rks_git_preflight",
  "rks_git_push",
  "rks_reset",
  "rks_resolve_conflict",
  "rks_restore",
  "rks_revert",
  "rks_stash",
  "rks_tag",
];

// S7 (backlog.feat.server-mjs-ship-handler-family).
const SHIP_TOOLS = [
  "rks_cycle_complete",
  "rks_git_merge",
  "rks_promote",
  "rks_release",
  "rks_ship",
  "rks_staging_merge",
  "rks_staging_pr",
  "rks_story_ship",
  "rks_sync_staging",
];

// S8 (backlog.feat.server-mjs-planner-exec-handler-family).
const PLANNER_TOOLS = [
  "rks_analyze",
  "rks_apply",
  "rks_approve",
  "rks_exec",
  "rks_exec_abort",
  "rks_guardrails_simulate",
  "rks_plan",
  "rks_plan_ready",
  "rks_plan_review",
  "rks_preflight",
  "rks_ready",
  "rks_refine",
  "rks_refine_apply",
  "rks_review",
  "rks_story_create",
  "rks_validate_story",
];

// S9a (backlog.feat.server-mjs-agent-bootstrap-handler-family). The per-agent rks_agent_* tools
// have no if-head; they reach the getAgentByToolName fallthrough, which stays in server.mjs until S10.
const AGENT_BOOTSTRAP_TOOLS = [
  "rks_agent_external_research",
  "rks_agent_run",
  "rks_init",
  "rks_interview",
  "rks_onboarder",
  "rks_project_init",
];

// S9b (backlog.feat.server-mjs-governance-handler-family). rks_arch_verdict and rks_governor_init
// register under the ARCH_VERDICT_TOOL and GOVERNOR_INIT_TOOL identifiers.
const GOVERNANCE_TOOLS = [
  "rks_arch_verdict",
  "rks_governor_init",
  "rks_guardrails_abort",
  "rks_guardrails_off",
  "rks_guardrails_on",
  "rks_guardrails_status",
  "rks_phase_repair",
];

const [SERVER_ABS, ...HANDLER_FILES] = serverSurfaceFiles();
const REPO_ROOT = path.resolve(path.dirname(SERVER_ABS), "../../..");
const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");
const handlerSources = HANDLER_FILES.map((f) => fs.readFileSync(f, "utf8"));

function countOccurrences(src, needle) {
  let n = 0;
  let at = src.indexOf(needle);
  while (at !== -1) {
    n++;
    at = src.indexOf(needle, at + 1);
  }
  return n;
}

describe("server.mjs dispatch regrowth ratchet", () => {
  it("TR8 the six telemetry tools have no if-head and no lazy telemetry import left in server.mjs", () => {
    const heads = new Set(dispatchHeads(serverSrc));
    for (const tool of TELEMETRY_TOOLS) {
      expect(heads.has(tool)).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
    for (const sub of TELEMETRY_SUBPATHS) {
      expect(serverSrc).not.toMatch(
        new RegExp(`await\\s+import\\(\\s*["'\`]@routekit/telemetry/${sub}["'\`]`),
      );
    }
  });

  it("TR8b the six project/meta tools have no if-head left in server.mjs", () => {
    const heads = new Set(dispatchHeads(serverSrc));
    for (const tool of PROJECT_META_TOOLS) {
      expect(heads.has(tool)).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
  });

  it("TR8c the seven dendron tools have no if-head left in server.mjs", () => {
    const heads = new Set(dispatchHeads(serverSrc));
    for (const tool of DENDRON_TOOLS) {
      expect(heads.has(tool)).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
  });

  it("TR8d the seven RAG tools have no if-head left in server.mjs", () => {
    const heads = new Set(dispatchHeads(serverSrc));
    for (const tool of RAG_TOOLS) {
      expect(heads.has(tool)).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
  });

  it("TR8e the thirteen git tools have no if-head left in server.mjs, in literal or identifier form", () => {
    const rawHeads = new Set(dispatchHeads(serverSrc));
    const heads = new Set(resolvedDispatchHeads(serverSrc));
    for (const tool of GIT_TOOLS) {
      expect(heads.has(tool), tool).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
    expect(rawHeads.has("GIT_PREFLIGHT_TOOL")).toBe(false);
    expect(serverSrc).not.toContain("if (tool === GIT_PREFLIGHT_TOOL)");
  });

  it("TR8f identifier resolution: the declared map matches TOOL_NAME, resolves registrations and heads, and fails closed", () => {
    expect(Object.keys(IDENTIFIER_TOOL_NAMES).sort()).toEqual(Object.keys(IDENTIFIER_SOURCES).sort());
    for (const [identifier, rel] of Object.entries(IDENTIFIER_SOURCES)) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const m = src.match(/^export const TOOL_NAME = "([^"\n]+)";$/m);
      expect(m, rel).not.toBeNull();
      expect(IDENTIFIER_TOOL_NAMES[identifier]).toBe(m[1]);
    }
    expect(IDENTIFIER_TOOL_NAMES.GIT_PREFLIGHT_TOOL).toBe("rks_git_preflight");

    const idReg = "  registerHandler(GIT_PREFLIGHT_TOOL, async (cleanArgs, ctx) => {\n  });\n";
    expect(registeredToolNames([idReg])).toEqual(["rks_git_preflight"]);
    expect(resolvedDispatchHeads("    if (tool === GIT_PREFLIGHT_TOOL) {\n    }\n")).toEqual(["rks_git_preflight"]);
    expect(dispatchHeads("    if (tool === GIT_PREFLIGHT_TOOL) {\n    }\n")).toEqual(["GIT_PREFLIGHT_TOOL"]);

    // Fail-closed: an identifier registration absent from the map throws, naming the identifier.
    expect(() => registeredToolNames(["  registerHandler(UNMAPPED_TOOL, async (cleanArgs, ctx) => {});\n"])).toThrow(/UNMAPPED_TOOL/);

    // The registry.mjs method definition is still not a registration.
    expect(registeredToolNames(["    registerHandler(tool, handler) {\n"])).toEqual([]);
  });

  it("TR8g dual dispatch is detected through identifier resolution", () => {
    const idReg = "  registerHandler(GIT_PREFLIGHT_TOOL, async (cleanArgs, ctx) => {\n  });\n";
    const identifierHead = "async function d(tool) {\n    if (tool === GIT_PREFLIGHT_TOOL) {\n    }\n}\n";
    const literalHead = 'async function d(tool) {\n    if (tool === "rks_git_preflight") {\n    }\n}\n';
    expect(dualDispatch(identifierHead, [idReg])).toEqual(["rks_git_preflight"]);
    expect(dualDispatch(literalHead, [idReg])).toEqual(["rks_git_preflight"]);
  });

  it("TR8h the nine ship tools have no if-head left in server.mjs and no lazy git-tools or story-ship import", () => {
    const heads = new Set(resolvedDispatchHeads(serverSrc));
    for (const tool of SHIP_TOOLS) {
      expect(heads.has(tool), tool).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
    expect(serverSrc).not.toContain('await import("./server/git-tools.mjs")');
    expect(serverSrc).not.toContain("await import('./server/story-ship.mjs')");
  });

  it(`TR9 has at most ${DISPATCH_HEAD_BASELINE} if (tool === …) dispatch heads, and exactly that many at this HEAD`, () => {
    const count = dispatchHeads(serverSrc).length;
    expect(count).toBeLessThanOrEqual(DISPATCH_HEAD_BASELINE);
    expect(count).toBe(DISPATCH_HEAD_BASELINE);
  });

  it(`TR10 negative control: a ${DISPATCH_HEAD_BASELINE + 1}-head fixture exceeds the baseline; a compound condition adds zero`, () => {
    const heads = Array.from({ length: DISPATCH_HEAD_BASELINE + 1 }, (_, i) =>
      `    if (tool === "fixture_tool_${i}") {\n      return {};\n    }\n`,
    ).join("");
    const fixture = `async function d(tool) {\n${heads}}\n`;
    expect(dispatchHeads(fixture)).toHaveLength(DISPATCH_HEAD_BASELINE + 1);
    expect(dispatchHeads(fixture).length > DISPATCH_HEAD_BASELINE).toBe(true);
    // The ratchet assertion itself fails on this fixture.
    expect(() => expect(dispatchHeads(fixture).length).toBeLessThanOrEqual(DISPATCH_HEAD_BASELINE)).toThrow();

    const compound = `${fixture}    if (tool === 'x' && y) {\n    }\n`;
    expect(dispatchHeads(compound)).toHaveLength(DISPATCH_HEAD_BASELINE + 1);
    // Mixed quote / identifier heads are counted.
    expect(dispatchHeads(`if (tool === 'a') {} if (tool === B_TOOL) {}`)).toEqual(["a", "B_TOOL"]);
  });

  it("TR8i the sixteen planner tools have no if-head left in server.mjs, no planner lazy import, no plan-worker path and no advanceStateOnResult( call", () => {
    expect(PLANNER_TOOLS).toHaveLength(16);
    const heads = new Set(resolvedDispatchHeads(serverSrc));
    for (const tool of PLANNER_TOOLS) {
      expect(heads.has(tool), tool).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
    expect(serverSrc).not.toContain('await import("./server/approve.mjs")');
    expect(serverSrc).not.toContain('await import("./shared/governor-token.mjs")');
    expect(serverSrc).not.toContain('await import("./server/refine.mjs")');
    expect(serverSrc).not.toContain("await import('./server/review.mjs')");
    expect(serverSrc).not.toContain("'bin', 'plan-worker.mjs'");
    expect(serverSrc).not.toContain("advanceStateOnResult(");
    // Positive control: the import name stays in server.mjs (import lines are not edited).
    expect(serverSrc).toMatch(/import \{[^}\n]*\badvanceStateOnResult\b[^}\n]*\} from "\.\/shared\/governor-token\.mjs";/);
  });

  it("TR8j the six agent/bootstrap tools have no if-head left in server.mjs and server.mjs has no await import( site", () => {
    expect(AGENT_BOOTSTRAP_TOOLS).toHaveLength(6);
    const heads = new Set(resolvedDispatchHeads(serverSrc));
    for (const tool of AGENT_BOOTSTRAP_TOOLS) {
      expect(heads.has(tool), tool).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
    expect(serverSrc).not.toContain("await import('./server/init.mjs')");
    expect(serverSrc).not.toContain("await import('./agents/external-research.mjs')");
    expect(serverSrc).not.toContain("await import(");
    // Positive control: the per-agent fallthrough stays in server.mjs until S10.
    expect(serverSrc).toContain("const agentEntry = getAgentByToolName(tool);");
  });

  it("TR8k the seven governance tools have no if-head left in server.mjs, in literal or identifier form, and no full head remains at all", () => {
    expect(GOVERNANCE_TOOLS).toHaveLength(7);
    const rawHeads = new Set(dispatchHeads(serverSrc));
    const heads = new Set(resolvedDispatchHeads(serverSrc));
    for (const tool of GOVERNANCE_TOOLS) {
      expect(heads.has(tool), tool).toBe(false);
      expect(serverSrc).not.toContain(`if (tool === "${tool}")`);
      expect(serverSrc).not.toContain(`if (tool === '${tool}')`);
    }
    expect(rawHeads.has("ARCH_VERDICT_TOOL")).toBe(false);
    expect(rawHeads.has("GOVERNOR_INIT_TOOL")).toBe(false);
    expect(serverSrc).not.toContain("if (tool === ARCH_VERDICT_TOOL)");
    expect(serverSrc).not.toContain("if (tool === GOVERNOR_INIT_TOOL)");
    expect(dispatchHeads(serverSrc)).toEqual([]);
    // Positive controls: the per-agent fallthrough and its compound (non-head) condition stay until S10.
    expect(serverSrc).toContain("const agentEntry = getAgentByToolName(tool);");
    expect(serverSrc).toContain("if (tool === 'rks_agent_research' && shouldEmitResearchFailureEvent(");
  });

  it("TR11 no dual dispatch: registered tools are disjoint from server.mjs heads and equal the telemetry six plus the project/meta six plus the dendron seven plus the RAG seven plus the git thirteen plus the ship nine plus the planner sixteen plus the agent/bootstrap six plus the governance seven", () => {
    expect(HANDLER_FILES.map((f) => path.basename(f))).toContain("registry.mjs");
    const registered = registeredToolNames(handlerSources);
    expect([...registered].sort()).toEqual([...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS, ...GIT_TOOLS, ...SHIP_TOOLS, ...PLANNER_TOOLS, ...AGENT_BOOTSTRAP_TOOLS, ...GOVERNANCE_TOOLS].sort());
    expect(registered).toHaveLength(78);
    const heads = new Set(resolvedDispatchHeads(serverSrc));
    for (const tool of registered) expect(heads.has(tool), tool).toBe(false);
    expect(dualDispatch(serverSrc, handlerSources)).toEqual([]);

    // The registry.mjs method definition is not counted as a registration.
    expect(registeredToolNames(["    registerHandler(tool, handler) {\n"])).toEqual([]);

    // Fixture: a tool both registered and if-headed makes the check fail.
    const fixtureServer = 'async function d(tool) {\n    if (tool === "both_tool") {\n    }\n}\n';
    const fixtureHandler = 'r.registerHandler("both_tool", async (cleanArgs, ctx) => {});\n';
    expect(dualDispatch(fixtureServer, [fixtureHandler])).toEqual(["both_tool"]);
    expect(() => expect(dualDispatch(fixtureServer, [fixtureHandler])).toEqual([])).toThrow();
  });

  it("TR12 one lookupHandler(tool) after the protected-tool gate and before the per-agent fallthrough; no if-head remains; registry built in createServer()", () => {
    expect(countOccurrences(serverSrc, "lookupHandler(tool)")).toBe(1);
    const lookupAt = serverSrc.indexOf("lookupHandler(tool)");
    const gateAt = serverSrc.indexOf("if (!_skipTokenValidation && isProtectedTool(tool)) {");
    // S9b moved the last if-heads (governance) into handlers/governance.mjs. The lookup now precedes
    // the per-agent fallthrough, which stays in server.mjs until S10.
    const fallthroughAt = serverSrc.indexOf("const agentEntry = getAgentByToolName(tool);");
    expect(gateAt).toBeGreaterThan(-1);
    expect(fallthroughAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeGreaterThan(gateAt);
    expect(lookupAt).toBeLessThan(fallthroughAt);

    const createAt = serverSrc.indexOf("export function createServer() {");
    const newServerAt = serverSrc.indexOf("const server = new Server(", createAt);
    expect(createAt).toBeGreaterThan(-1);
    expect(newServerAt).toBeGreaterThan(createAt);
    for (const needle of ["createHandlerRegistry()", "registerTelemetryHandlers(", "registerProjectMetaHandlers(", "registerDendronHandlers(", "registerRagHandlers(", "registerGitHandlers(", "registerShipHandlers(", "registerPlannerHandlers(", "registerAgentBootstrapHandlers(", "registerGovernanceHandlers("]) {
      const at = serverSrc.indexOf(needle);
      expect(at).toBeGreaterThan(createAt);
      expect(at).toBeLessThan(newServerAt);
    }

    expect(countOccurrences(serverSrc, "registerProjectMetaHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerProjectMetaHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerTelemetryHandlers("),
    );

    expect(countOccurrences(serverSrc, "registerDendronHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerDendronHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerProjectMetaHandlers("),
    );

    expect(countOccurrences(serverSrc, "registerRagHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerRagHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerDendronHandlers("),
    );
    expect(serverSrc.indexOf("registerRagHandlers(")).toBeLessThan(newServerAt);

    expect(countOccurrences(serverSrc, "registerGitHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerGitHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerRagHandlers("),
    );
    expect(serverSrc.indexOf("registerGitHandlers(")).toBeLessThan(newServerAt);

    expect(countOccurrences(serverSrc, "registerShipHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerShipHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerGitHandlers("),
    );
    expect(serverSrc.indexOf("registerShipHandlers(")).toBeLessThan(newServerAt);

    expect(countOccurrences(serverSrc, "registerPlannerHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerPlannerHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerShipHandlers("),
    );
    expect(serverSrc.indexOf("registerPlannerHandlers(")).toBeLessThan(newServerAt);

    expect(countOccurrences(serverSrc, "registerAgentBootstrapHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerAgentBootstrapHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerPlannerHandlers("),
    );
    expect(serverSrc.indexOf("registerAgentBootstrapHandlers(")).toBeLessThan(newServerAt);

    expect(countOccurrences(serverSrc, "registerGovernanceHandlers(")).toBe(1);
    expect(serverSrc.indexOf("registerGovernanceHandlers(")).toBeGreaterThan(
      serverSrc.indexOf("registerAgentBootstrapHandlers("),
    );
    expect(serverSrc.indexOf("registerGovernanceHandlers(")).toBeLessThan(newServerAt);

    // S9b: no full dispatch head remains, and server.mjs registers nothing itself.
    expect(serverSrc.search(HEAD_RE)).toBe(-1);
    expect(serverSrc).not.toContain("registerHandler(");
  });
});
