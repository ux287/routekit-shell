/**
 * Drift guard for the MCP tool argument contract.
 *
 * Every tool carries TWO independent hand-maintained descriptions of one
 * contract: the zod schema that PARSES arguments, and the hand-written JSON
 * Schema `inputSchema` literal that tells clients what to SEND. Nothing linked
 * them, so they drifted silently. A census found 10 instances, including a
 * user-facing bug where `rks_init.branchModel` was advertised but stripped by
 * zod — so asking for a 2-branch project always produced a 3-branch one.
 *
 * The drift is asymmetric, which is how it survived ~80 tools:
 *   - a NEW tool missing its advertised half is uncallable — loud, caught at once
 *   - a field added to an EXISTING tool's zod schema is merely unreachable —
 *     silent, forever
 *
 * WHY THIS FILE LIVES HERE. The obvious host, packages/mcp-rks/__tests__/
 * mcp-contract.spec.mjs, imports from `node:test` and runs NOWHERE: no vitest
 * config globs packages/**, and .github contains zero occurrences of
 * packages/mcp-rks. Hosting the guard there would have produced a guard that
 * never executes — precisely the failure this story exists to prevent.
 * vitest.config.mock.mjs includes "tests/integration/ * * / *.spec.*" and CI runs
 * `npm run test:mock`, so this file is live on every commit.
 *
 * The advertised side is always read from a LIVE listTools() call, never by
 * re-parsing server.mjs source. That is what makes the guard observe the
 * post-hoc _governorToken injection and the agent-tool spread exactly as a real
 * client does.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  createTestClient,
  closeTestClient,
} from "../../packages/mcp-rks/__tests__/mcp-contract-helpers.mjs";
import { TOOL_ARG_SCHEMAS } from "../../packages/mcp-rks/src/server.mjs";

// A real stdio MCP client well exceeds vitest's 5s default. The mock tier also
// runs pool:"forks" with bail:1, so a held-open client would strand a fork slot
// — the failure mode behind backlog.z_implemented.fix.ci-timeout-mcp-dendron-binding.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Injected into every protected tool's advertised properties at runtime and
 * present in NO zod shape. Excluded UNCONDITIONALLY rather than per-tool,
 * because rks_git_preflight pre-declares it in its own imported INPUT_SCHEMA
 * instead of receiving the injection — a per-origin rule would report that tool
 * as false drift.
 */
const IGNORED_KEYS = new Set(["_governorToken"]);

/**
 * Advertised tools with no zod schema at all. Their arguments are read straight
 * off the raw args object, so there is no second description to drift from.
 * Backfilling these is tracked separately and deliberately out of scope here.
 */
const TOOLS_WITHOUT_ZOD_SCHEMA = Object.freeze([
  "rks_preflight",
  "rks_exec_abort",
  "rks_approve",
  "rks_story_create",
  "rks_exhaustive_search",
  "rks_review",
  "rks_agent_external_research",
  "rks_sync_staging",
  "rks_resolve_conflict",
  "rks_release",
  "rks_story_ship",
  "rks_story_create",
  "dendron_read_note",
  "rks_git_preflight",
]);

/**
 * Agent tools spread in from generateAgentToolDefinitions(). Their advertised
 * schema is GENERATED from their zod schema by agents/zod-to-json-schema.mjs, so
 * the two sides cannot drift by construction — there is only one source. They
 * are recorded here explicitly rather than left unclassified, so that a future
 * change to how agent tools are advertised surfaces as a decision rather than a
 * silent gap.
 */
const AGENT_GENERATED_TOOLS_PREFIX = "rks_agent_";

function isAgentGenerated(name) {
  return name.startsWith(AGENT_GENERATED_TOOLS_PREFIX);
}

/**
 * Compare one advertised JSON Schema against one zod schema.
 *
 * PURE — takes plain data, returns a findings array. Every negative case below
 * is asserted against synthetic fixtures, so proving the guard actually fires
 * never requires mutating server.mjs.
 *
 * Classes:
 *   A  key in zod, absent from advertised  -> silently unreachable
 *   B  key advertised, absent from zod     -> silently DISCARDED (zod strips)
 *   B' enum value sets differ either way   -> fails LOUDLY (z.enum rejects)
 *   C  advertised `required` disagrees with zod optionality
 */
export function compareToolSchemas(toolName, advertised, zodSchema) {
  const findings = [];
  const advertisedProps = (advertised && advertised.properties) || {};
  const zodShape = (zodSchema && zodSchema.shape) || {};

  const advertisedKeys = Object.keys(advertisedProps).filter((k) => !IGNORED_KEYS.has(k));
  const zodKeys = Object.keys(zodShape).filter((k) => !IGNORED_KEYS.has(k));

  for (const key of zodKeys) {
    if (!advertisedKeys.includes(key)) {
      findings.push({ tool: toolName, key, cls: "A", detail: "in zod, not advertised — unreachable by any client" });
    }
  }

  for (const key of advertisedKeys) {
    if (!zodKeys.includes(key)) {
      findings.push({ tool: toolName, key, cls: "B", detail: "advertised, not in zod — silently discarded by .parse()" });
    }
  }

  // B-prime: enum value sets, compared in BOTH directions.
  for (const key of advertisedKeys) {
    if (!zodKeys.includes(key)) continue;
    const advertisedEnum = advertisedProps[key]?.enum;
    const zodEnum = zodEnumValues(zodShape[key]);
    if (!advertisedEnum || !zodEnum) continue;
    const a = [...advertisedEnum].sort();
    const z = [...zodEnum].sort();
    if (a.length !== z.length || a.some((v, i) => v !== z[i])) {
      findings.push({
        tool: toolName,
        key,
        cls: "B-prime",
        detail: `enum mismatch — advertised [${a.join(", ")}] vs zod [${z.join(", ")}]`,
      });
    }
  }

  // C: required-ness. A key is required only when it is neither .optional() nor
  // .default(). This class is currently at zero across every pair; asserting it
  // locks that baseline in.
  const advertisedRequired = new Set((advertised?.required || []).filter((k) => !IGNORED_KEYS.has(k)));
  for (const key of zodKeys) {
    if (!advertisedKeys.includes(key)) continue;
    const zodRequired = !isZodOptional(zodShape[key]);
    if (zodRequired !== advertisedRequired.has(key)) {
      findings.push({
        tool: toolName,
        key,
        cls: "C",
        detail: `required mismatch — advertised ${advertisedRequired.has(key)}, zod ${zodRequired}`,
      });
    }
  }

  return findings;
}

/** Unwrap optional/default/nullable wrappers to find an underlying enum. */
function zodEnumValues(def) {
  let node = def;
  for (let i = 0; i < 10 && node; i++) {
    if (Array.isArray(node?._def?.values)) return node._def.values;
    node = node?._def?.innerType ?? node?._def?.schema ?? null;
  }
  return null;
}

function isZodOptional(def) {
  let node = def;
  for (let i = 0; i < 10 && node; i++) {
    const name = node?._def?.typeName;
    if (name === "ZodOptional" || name === "ZodDefault" || name === "ZodNullable") return true;
    node = node?._def?.innerType ?? node?._def?.schema ?? null;
  }
  return false;
}

// --- Synthetic fixtures. These prove the comparison is not vacuous. ---

const z = (await import("zod")).z;

describe("compareToolSchemas — fires on each drift class", () => {
  it("Class A: reports a key present in zod but not advertised", () => {
    const findings = compareToolSchemas(
      "t",
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      z.object({ a: z.string(), ghost: z.boolean().optional() }),
    );
    expect(findings.some((f) => f.cls === "A" && f.key === "ghost")).toBe(true);
  });

  it("Class B: reports a key advertised but absent from zod", () => {
    const findings = compareToolSchemas(
      "t",
      { type: "object", properties: { a: { type: "string" }, phantom: { type: "string" } }, required: ["a"] },
      z.object({ a: z.string() }),
    );
    expect(findings.some((f) => f.cls === "B" && f.key === "phantom")).toBe(true);
  });

  it("Class B-prime: reports an enum value-set mismatch in either direction", () => {
    const shrunk = compareToolSchemas(
      "t",
      { type: "object", properties: { mode: { type: "string", enum: ["x", "y", "z"] } }, required: [] },
      z.object({ mode: z.enum(["x", "y"]).optional() }),
    );
    expect(shrunk.some((f) => f.cls === "B-prime")).toBe(true);

    const grown = compareToolSchemas(
      "t",
      { type: "object", properties: { mode: { type: "string", enum: ["x"] } }, required: [] },
      z.object({ mode: z.enum(["x", "y"]).optional() }),
    );
    expect(grown.some((f) => f.cls === "B-prime")).toBe(true);
  });

  it("Class C: reports a required-ness mismatch", () => {
    const findings = compareToolSchemas(
      "t",
      { type: "object", properties: { a: { type: "string" } }, required: [] },
      z.object({ a: z.string() }),
    );
    expect(findings.some((f) => f.cls === "C" && f.key === "a")).toBe(true);
  });

  it("reports nothing for a matching pair, and never reports _governorToken", () => {
    const findings = compareToolSchemas(
      "t",
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "boolean" }, _governorToken: { type: "string" } },
        required: ["a"],
      },
      z.object({ a: z.string(), b: z.boolean().optional() }),
    );
    expect(findings).toEqual([]);
  });
});

// --- The live guard. ---

describe("MCP tool contract — no zod/inputSchema drift", () => {
  let session = null;
  let advertisedTools = [];

  beforeAll(async () => {
    session = await createTestClient();
    const listed = await session.client.listTools();
    advertisedTools = listed.tools;
  });

  afterAll(async () => {
    if (session) await closeTestClient(session);
    session = null;
  });

  it("advertises tools at all (guards against a vacuous pass)", () => {
    expect(advertisedTools.length).toBeGreaterThan(50);
  });

  it("rks_exhaustive_search discloses that its pattern match is case-sensitive", () => {
    // backlog.fix.exhaustive-search-case-sensitivity-undisclosed.
    //
    // The matcher is a case-sensitive substring test (packages/rag/src/tools.mjs uses
    // indexOf/includes), and nothing told a caller. "Literal string to search for."
    // says NOT-A-REGEX; it does not say case-sensitive. Every Governor is instructed to
    // treat a controlled zero as proven absence, and a case mismatch survives that
    // control — so the undisclosed behaviour actively produced false absence claims.
    //
    // Asserted against the LIVE advertised schema rather than the source literal:
    // source extraction witnesses what the file says, whereas listTools() witnesses
    // what a client actually receives, which is the thing that was undisclosed.
    const advertised = advertisedTools.find((t) => t.name === "rks_exhaustive_search");
    expect(advertised).toBeDefined();

    const description = advertised.inputSchema?.properties?.pattern?.description;
    expect(description, "the pattern property must carry a description").toBeTruthy();

    // POSITIVE: the disclosure is present, read off the property value specifically so
    // no nearby comment or sibling field could satisfy it.
    expect(description).toMatch(/case-sensitive/i);

    // POLARITY: the unamended value is gone. Asserted as EQUALITY-absence, not
    // substring-absence — the amendment keeps the original sentence and appends to it,
    // so forbidding the substring would force a needless rewrite of correct prose.
    expect(description).not.toBe("Literal string to search for.");
  });

  it("TOOL_ARG_SCHEMAS is frozen, non-empty, and every value is a zod object", () => {
    expect(Object.isFrozen(TOOL_ARG_SCHEMAS)).toBe(true);
    const entries = Object.entries(TOOL_ARG_SCHEMAS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, schema] of entries) {
      expect(schema, `${name} has no zod schema`).toBeTruthy();
      expect(typeof schema.shape, `${name} exposes no .shape`).toBe("object");
    }
  });

  it("every TOOL_ARG_SCHEMAS key is a tool that is actually advertised", () => {
    const advertisedNames = new Set(advertisedTools.map((t) => t.name));
    const orphans = Object.keys(TOOL_ARG_SCHEMAS).filter((n) => !advertisedNames.has(n));
    expect(orphans, `mapped but not advertised: ${orphans.join(", ")}`).toEqual([]);
  });

  it("COMPLETENESS: no advertised tool is left unclassified", () => {
    // Adding a tool without either mapping it or allowlisting it is a FAILURE,
    // not a silent pass. This is the hole that would otherwise let the guard rot
    // exactly like the thing it guards.
    const unclassified = advertisedTools
      .map((t) => t.name)
      .filter(
        (n) =>
          !(n in TOOL_ARG_SCHEMAS) &&
          !TOOLS_WITHOUT_ZOD_SCHEMA.includes(n) &&
          !isAgentGenerated(n),
      );
    expect(
      unclassified,
      `unclassified tools — add to TOOL_ARG_SCHEMAS or TOOLS_WITHOUT_ZOD_SCHEMA: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("STALENESS 1: every allowlisted name is still an advertised tool", () => {
    const advertisedNames = new Set(advertisedTools.map((t) => t.name));
    const dangling = TOOLS_WITHOUT_ZOD_SCHEMA.filter((n) => !advertisedNames.has(n));
    expect(dangling, `allowlist names a tool that no longer exists: ${dangling.join(", ")}`).toEqual([]);
  });

  it("STALENESS 2: no name is in both the allowlist and TOOL_ARG_SCHEMAS", () => {
    const both = TOOLS_WITHOUT_ZOD_SCHEMA.filter((n) => n in TOOL_ARG_SCHEMAS);
    expect(both, `tool gained a zod schema but stayed allowlisted: ${both.join(", ")}`).toEqual([]);
  });

  it("AGENT-SPREAD TOOLS: advertised schemas are generated from zod, so they are not compared", () => {
    // Disposition asserted explicitly, with its reason, so these cannot fall
    // through as unclassified: agents/zod-to-json-schema.mjs generates the
    // advertised half from the zod half, so there is one source of truth and no
    // second description to drift from.
    const agentTools = advertisedTools.map((t) => t.name).filter(isAgentGenerated);
    expect(agentTools.length).toBeGreaterThan(0);
    for (const name of agentTools) {
      expect(name in TOOL_ARG_SCHEMAS, `${name} should not be hand-mapped`).toBe(false);
    }
  });

  it("reports ZERO drift findings across every mapped tool", () => {
    const byName = new Map(advertisedTools.map((t) => [t.name, t]));
    const all = [];
    for (const [name, zodSchema] of Object.entries(TOOL_ARG_SCHEMAS)) {
      const advertised = byName.get(name)?.inputSchema;
      if (!advertised) continue; // covered by the orphan test above
      all.push(...compareToolSchemas(name, advertised, zodSchema));
    }
    const rendered = all.map((f) => `${f.tool}.${f.key} [${f.cls}] ${f.detail}`).join("\n");
    expect(all, `schema drift detected:\n${rendered}`).toEqual([]);
  });

  it("CROSS-FILE PAIR: rks_governor_init is compared, not skipped", () => {
    // Its zod lives in server.mjs while its advertised literal is an imported
    // INPUT_SCHEMA from tools/governor-init.mjs. It is a real pair and must not
    // be silently excluded just for spanning two files.
    const advertised = advertisedTools.find((t) => t.name === "rks_governor_init");
    expect(advertised).toBeDefined();
    expect(TOOL_ARG_SCHEMAS.rks_governor_init).toBeTruthy();
    expect(compareToolSchemas("rks_governor_init", advertised.inputSchema, TOOL_ARG_SCHEMAS.rks_governor_init)).toEqual([]);
  });

  it("TOKEN EXCLUSION IS UNCONDITIONAL: rks_git_preflight pre-declares its own token", () => {
    // It declares _governorToken in its own imported INPUT_SCHEMA rather than
    // receiving the runtime injection. A per-origin exclusion rule would report
    // it as Class B drift; an unconditional one does not.
    const advertised = advertisedTools.find((t) => t.name === "rks_git_preflight");
    expect(advertised).toBeDefined();
    expect(Object.keys(advertised.inputSchema.properties || {})).toContain("_governorToken");
    // It has no zod schema, so an empty-shape comparison must still be clean.
    expect(compareToolSchemas("rks_git_preflight", advertised.inputSchema, { shape: {} }).filter((f) => f.key === "_governorToken")).toEqual([]);
  });

  it("LINK INTEGRITY: the fixed fields are genuinely advertised now", () => {
    const byName = new Map(advertisedTools.map((t) => [t.name, t]));
    const props = (n) => Object.keys(byName.get(n)?.inputSchema?.properties || {});

    // Class A — were in zod, unreachable because no client could learn of them.
    expect(props("rks_guardrails_on")).toContain("enforcementOverride");
    expect(props("rks_onboarder")).toEqual(expect.arrayContaining(["skipStage", "bounce"]));
    expect(props("rks_telemetry_query")).toEqual(expect.arrayContaining(["since", "lastNCycles"]));
    expect(props("rks_telemetry_report")).toEqual(expect.arrayContaining(["since", "lastNCycles"]));

    // Class B — were advertised, silently discarded by zod .parse().
    expect(Object.keys(TOOL_ARG_SCHEMAS.rks_init.shape)).toContain("branchModel");
    expect(Object.keys(TOOL_ARG_SCHEMAS.rks_rag_embed.shape)).toContain("files");

    // backlog.feat.governor-init-resume-vs-reset-contract — `reset` must be declared on BOTH
    // sides. The compareToolSchemas assertion above is SYMMETRIC: it returns [] when both
    // sides declare it AND when neither does, so doing nothing satisfies it. These are the
    // asymmetric witnesses.
    expect(props("rks_governor_init")).toContain("reset");
    expect(Object.keys(TOOL_ARG_SCHEMAS.rks_governor_init.shape)).toContain("reset");
    // Behavioural, not structural: governorInitSchema is a plain z.object(), which STRIPS
    // unknown keys — a reset declared only in INPUT_SCHEMA would parse away to undefined and
    // never reach handleGovernorInit.
    expect(
      TOOL_ARG_SCHEMAS.rks_governor_init.parse({ projectId: "p", reset: true }).reset,
      "reset was stripped by zod — it would never reach handleGovernorInit",
    ).toBe(true);

    // Class B-prime — z.enum REJECTS rather than strips, so this one failed loudly.
    const refineEnum = zodEnumValues(TOOL_ARG_SCHEMAS.rks_refine_apply.shape.refinements);
    const advertisedRefine = byName.get("rks_refine_apply")?.inputSchema;
    expect(advertisedRefine).toBeDefined();
    // The enum is nested one level down (refinements[].type), below this guard's
    // field granularity, so assert the zod side directly.
    const typeEnum = TOOL_ARG_SCHEMAS.rks_refine_apply.shape.refinements._def.type.shape.type._def.values;
    expect(typeEnum).toContain("fix_duplicate_frontmatter");
    expect(refineEnum).toBeNull();
  });
});
