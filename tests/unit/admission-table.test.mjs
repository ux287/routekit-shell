// backlog.feat.admission-decision-table-decide: admission decision table and pure decide().
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The chain-admission effect applier requirement spies on getTelemetryCollector().emit, so this file
// needs the REAL collector rather than the suite-wide stub (tests/setup.mjs). vi.unmock is one of the
// sanctioned escapes, hoisted above the imports; escaping both specifiers keeps this file classified
// UN-SHADOWED by tests/unit/telemetry-global-mock-triage.test.mjs.
vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as table from "../../packages/mcp-rks/src/shared/admission-table.mjs";
import {
  ADMISSION_TABLE,
  EFFECTS,
  STAGES,
  LAYERS,
  PREDICATES,
  validateAdmissionTable,
  evaluateRows,
  decide,
  chainStateTools,
  COMMON_TOOL_NAMES,
  UNPROTECTED_TOOL_NAMES,
  STATE_BYPASS_TOOL_NAMES,
  READ_ONLY_EXEMPT_TOOL_NAMES,
} from "../../packages/mcp-rks/src/shared/admission-table.mjs";
import {
  CHAIN_MACHINE,
  validateChainMachine,
  getStates,
  checkStateAllowed,
  classifyChainRefusal,
  STATE_BYPASS_TOOLS,
  READ_ONLY_EXEMPT_TOOLS,
  QA_FLOW_TOOLS,
  SHIP_FLOW_TOOLS,
  SHIP_STATES,
  OPS_STATES,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import {
  COMMON_TOOLS,
  UNPROTECTED_TOOLS,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
  OPS_FLOW_TOOLS,
  isProtectedTool,
  checkAllowedTool,
  requireToken,
  createSession,
  getSession,
  resetToken,
  setProjectRoot,
  applyChainAdmissionEffects,
  chainAdmissionRefusal,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { acquireLease } from "../../packages/mcp-rks/src/shared/project-lease.mjs";
import { REMOTE_LANE_TOOLS, loadBootLanePolicy, readLanePolicy } from "../../packages/mcp-rks/src/shared/lane-policy.mjs";
import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry";
import { serverSurfaceFiles } from "../_helpers/server-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server.mjs"), "utf8");
const FLOWS = Object.keys(CHAIN_MACHINE);
const ROW_IDS = ADMISSION_TABLE.map((r) => r.id);

// The universe tests/unit/server-dispatch-ratchet.test.mjs registeredToolNames enumerates (string and
// identifier registrations across server.mjs and server/handlers/), re-derived here because importing
// that test module would re-register its suites. Unioned with every tool the table names, so the
// rks_agent_* resolver tools and the remote-lane tools are covered too.
const IDENTIFIER_SOURCES = {
  GIT_PREFLIGHT_TOOL: "packages/mcp-rks/src/tools/git-preflight.mjs",
  ARCH_VERDICT_TOOL: "packages/mcp-rks/src/workflow/arch-verdict.mjs",
  GOVERNOR_INIT_TOOL: "packages/mcp-rks/src/tools/governor-init.mjs",
  GOVERNOR_END_TOOL: "packages/mcp-rks/src/tools/governor-end.mjs",
};
function registeredToolNames() {
  const names = [];
  for (const file of serverSurfaceFiles()) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?<![\w$])registerHandler\(\s*(?:"([^"\n]+)"|'([^'\n]+)')/g)) names.push(m[1] ?? m[2]);
    for (const m of src.matchAll(/(?<![\w$])registerHandler\(\s*([A-Za-z_$][\w$]*)\s*,\s*async\b/g)) {
      const rel = IDENTIFIER_SOURCES[m[1]];
      if (!rel) throw new Error(`registerHandler identifier ${m[1]} is not mapped`);
      names.push(fs.readFileSync(path.join(ROOT, rel), "utf8").match(/^export const TOOL_NAME = "([^"\n]+)";$/m)[1]);
    }
  }
  return names;
}
const REGISTERED = [...new Set(registeredToolNames())];
const UNIVERSE = [...new Set([
  ...REGISTERED,
  ...ADMISSION_TABLE.flatMap((r) => r.tools ?? []),
  ...REMOTE_LANE_TOOLS,
  "no_such_tool_x",
])].sort();

const sessionInput = ({ tool, args, session = null, tokenPresent = true, tokenValid = tokenPresent, tokenGateArmed = true, leaseRefused = false }) => ({
  tool, args, session, context: { stage: "session", tokenPresent, tokenValid, tokenGateArmed, leaseRefused },
});

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admission-table-"));
  setProjectRoot(tmpRoot);
  resetToken();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetToken();
  resetTelemetryCollector();
  setProjectRoot(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ADMISSION_TABLE structure", () => {
  it("is frozen and every row has a unique id, a known layer and a known effect", () => {
    expect(Object.isFrozen(ADMISSION_TABLE)).toBe(true);
    expect(new Set(ROW_IDS).size).toBe(ROW_IDS.length);
    expect([...LAYERS].sort()).toEqual(["args", "chain", "lane", "lease", "route", "token"]);
    expect([...EFFECTS].sort()).toEqual(["allow", "deny", "route"]);
    expect([...STAGES]).toEqual(["lane", "bootstrap", "session"]);
    for (const row of ADMISSION_TABLE) {
      expect(Object.isFrozen(row), row.id).toBe(true);
      expect(typeof row.id, row.id).toBe("string");
      expect(STAGES, row.id).toContain(row.stage);
      expect(LAYERS, row.id).toContain(row.layer);
      expect(EFFECTS, row.id).toContain(row.effect);
      if (row.tools) expect(Object.isFrozen(row.tools), row.id).toBe(true);
    }
    // Every CHAIN_MACHINE state has its per-state chain row.
    for (const f of FLOWS) {
      for (const s of Object.keys(CHAIN_MACHINE[f].states)) expect(ROW_IDS, `${f}/${s}`).toContain(`session.chain.${f}.${s}`);
    }
  });

  it("every named argument predicate is an exported function and every row reference resolves", () => {
    for (const name of ["isDendronWriteCall", "namespaceAllowlistRefusal", "openBacklogCreateRefusal", "protoStoryGuardRefusal"]) {
      expect(typeof table[name], name).toBe("function");
      expect(PREDICATES[name], name).toBe(table[name]);
    }
    expect(table.NAMESPACE_ALLOWLIST.story).toBeInstanceOf(Set);
    expect(table.DENDRON_WRITE_TOOLS).toBeInstanceOf(Set);
    for (const [name, fn] of Object.entries(PREDICATES)) expect(table[name], name).toBe(fn);
    for (const row of ADMISSION_TABLE) {
      for (const ref of [...(row.if ?? []), ...(row.detail ? [row.detail] : [])]) {
        const name = ref.replace(/^!/, "");
        expect(typeof table[name], `${row.id}: ${name}`).toBe("function");
      }
    }
    // The named predicates are the checkToolArgs cases.
    const story = { flowType: "story", state: "refining" };
    expect(table.isDendronWriteCall({ tool: "dendron_create_note", args: {} })).toBe(true);
    expect(table.isDendronWriteCall({ tool: "rks_plan", args: {} })).toBe(false);
    expect(table.namespaceAllowlistRefusal({ tool: "dendron_create_note", args: { filename: "research.x" }, session: story }))
      .toMatchObject({ error: "namespace_violation", violationKind: "namespace" });
    expect(table.namespaceAllowlistRefusal({ tool: "dendron_create_note", args: { filename: "backlog.x" }, session: story })).toBeNull();
    expect(table.openBacklogCreateRefusal({ tool: "dendron_create_note", args: { filename: "backlog.x" }, session: { flowType: "open", state: "writing" } }))
      .toMatchObject({ error: "namespace_violation" });
    expect(table.protoStoryGuardRefusal({ tool: "dendron_update_field", args: { filename: "backlog.x", field: "phase", value: "ready" }, session: story }))
      .toMatchObject({ error: "proto_story_guard", violationKind: "proto_story_guard" });
  });
});

describe("decide combining rule", () => {
  const row = (id, effect, layer, extra = {}) => ({ id, stage: "session", layer, effect, tools: ["x"], reason: `r-${id}`, remedy: `m-${id}`, ...extra });
  const input = { tool: "x", context: { stage: "session" } };

  it("deny beats route and allow, route beats allow", () => {
    const allow = row("a", "allow", "chain");
    const route = row("b", "route", "route");
    const deny = row("c", "deny", "token");
    expect(evaluateRows([allow, route, deny], input)).toEqual({ effect: "deny", reason: "r-c", layer: "token", remedy: "m-c", matchedRule: "c" });
    expect(evaluateRows([allow, route], input)).toEqual({ effect: "route", reason: "r-b", layer: "route", remedy: "m-b", matchedRule: "b" });
    expect(evaluateRows([allow], input).effect).toBe("allow");
    // Deny rows of different layers: lane > lease > chain > args > token.
    const rank = ["lane", "lease", "chain", "args", "token"];
    for (let i = 0; i < rank.length; i++) {
      for (let j = i + 1; j < rank.length; j++) {
        const hi = row(`z-${rank[i]}`, "deny", rank[i]);
        const lo = row(`a-${rank[j]}`, "deny", rank[j]);
        const res = evaluateRows([lo, hi], input);
        expect(res.matchedRule, `${rank[i]} over ${rank[j]}`).toBe(hi.id);
        expect(res.layer).toBe(rank[i]);
        expect(Object.keys(res).sort()).toEqual(["effect", "layer", "matchedRule", "reason", "remedy"]);
      }
    }
    // Rows of another stage never take part.
    expect(evaluateRows([allow, row("d", "deny", "lane", { stage: "lane" })], input).effect).toBe("allow");
  });

  it("no matching row yields deny with matchedRule null", () => {
    expect(evaluateRows([row("a", "allow", "chain", { tools: ["y"] })], input)).toMatchObject({ effect: "deny", matchedRule: null });
    expect(evaluateRows([], input)).toMatchObject({ effect: "deny", matchedRule: null });
    expect(decide({ tool: "x", context: { stage: "no-such-stage" } })).toMatchObject({ effect: "deny", matchedRule: null });
  });

  it("the result does not depend on row order", () => {
    const rows = [
      row("a", "allow", "chain"),
      row("b", "route", "route"),
      row("c", "deny", "token"),
      row("d", "deny", "args"),
      row("e", "deny", "args"),
    ];
    const want = evaluateRows(rows, input);
    expect(want.matchedRule).toBe("d");
    for (const p of permutations(rows)) expect(evaluateRows(p, input)).toEqual(want);
    // The same holds over the shipped table's session rows for a co-matching input (lease + chain deny).
    const sessionRows = ADMISSION_TABLE.filter((r) => r.stage === "session");
    const co = sessionInput({ tool: "rks_ship", session: { flowType: "story", state: "init" }, leaseRefused: true });
    const shipped = evaluateRows(ADMISSION_TABLE, co);
    expect(evaluateRows([...sessionRows].reverse(), co)).toEqual(shipped);
  });
});

describe("validateAdmissionTable", () => {
  it("rejects each single-defect table and accepts ADMISSION_TABLE", () => {
    expect(() => validateAdmissionTable(ADMISSION_TABLE)).not.toThrow();
    expect(() => validateAdmissionTable(ADMISSION_TABLE, CHAIN_MACHINE)).not.toThrow();
    const chainRowAt = ADMISSION_TABLE.findIndex((r) => r.id === "session.chain.qa.init");
    const withRow = (i, patch) => ADMISSION_TABLE.map((r, k) => (k === i ? { ...r, ...patch } : r));
    const cases = [
      { name: "duplicate row id", table: [...ADMISSION_TABLE, { ...ADMISSION_TABLE[0] }], needle: "duplicate row id" },
      { name: "unknown effect", table: withRow(0, { effect: "maybe" }), needle: "unknown effect" },
      { name: "unknown stage", table: withRow(0, { stage: "nowhere" }), needle: "unknown stage" },
      { name: "unknown predicate name", table: withRow(0, { if: ["noSuchPredicate"] }), needle: "noSuchPredicate" },
      { name: "unknown flowType", table: withRow(chainRowAt, { flowType: "no-such-flow" }), needle: "no-such-flow" },
      { name: "unknown state", table: withRow(chainRowAt, { state: "no-such-state" }), needle: "no-such-state" },
    ];
    for (const c of cases) {
      let thrown = null;
      try { validateAdmissionTable(c.table, CHAIN_MACHINE); } catch (e) { thrown = e; }
      expect(thrown, c.name).toBeInstanceOf(Error);
      expect(thrown.message, c.name).toContain(c.needle);
    }
  });
});

describe("decide purity", () => {
  it("never mutates principal, args, session, context or the lease store", () => {
    const { token } = createSession({ projectId: "p", flowType: "story", problemId: "backlog.fix.purity" });
    expect(acquireLease({ projectRoot: tmpRoot, projectId: "p", flowType: "story", token, runId: null }).ok).toBe(true);
    const live = getSession(token);
    const sessionBefore = structuredClone(live);
    const storeBefore = snapshotTree(tmpRoot);
    const calls = [
      { stage: "lane", lane: "mcp", policy: { status: "ok", lanes: { mcp: "read-only" } }, tokenPresent: true },
      { stage: "lane", lane: "remote", policy: { status: "absent", lanes: null }, tokenPresent: true, tokenValid: false, bootProjectId: "p", env: { RKS_ACTOR: "a" } },
      { stage: "bootstrap", tokenPresent: false, tokenGateArmed: true },
      { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true, leaseRefused: true },
      { stage: "session", tokenPresent: true, tokenValid: true, tokenGateArmed: true, leaseRefused: false },
      { stage: "session", tokenPresent: false, tokenValid: false, tokenGateArmed: true, leaseRefused: false },
    ];
    for (const tool of ["dendron_create_note", "rks_exec", "rks_agent_research", "rks_project_get"]) {
      for (const context of calls) {
        const input = deepFreeze({
          principal: { kind: "unknown" },
          tool,
          args: { projectId: "p", filename: "research.x", nested: { a: [1] } },
          session: structuredClone(live),
          context: structuredClone(context),
        });
        expect(() => decide(input)).not.toThrow();
      }
    }
    // The live record passed unfrozen is not mutated either.
    decide(sessionInput({ tool: "rks_exec", session: live }));
    expect(getSession(token)).toEqual(sessionBefore);
    expect(snapshotTree(tmpRoot)).toEqual(storeBefore);
  });
});

describe("server.mjs admission site", () => {
  it("has three staged decide() call sites (lane before preflight, bootstrap, session) and no checkAllowedTool( or requireToken( call site", () => {
    const calls = [...SERVER_SRC.matchAll(/(?<![\w$.])decide\(/g)].map((m) => m.index);
    expect(calls).toHaveLength(3);
    const stages = calls.map((at) => SERVER_SRC.slice(at, at + 600).match(/stage: '([a-z]+)'/)?.[1]);
    expect(stages).toEqual(["lane", "bootstrap", "session"]);
    const preflightAt = SERVER_SRC.indexOf("if (hasPreflightChecks(tool)) {");
    expect(preflightAt).toBeGreaterThan(-1);
    expect(calls[0]).toBeLessThan(preflightAt);
    expect(calls[1]).toBeGreaterThan(preflightAt);
    expect(SERVER_SRC).not.toMatch(/(?<![\w$.])checkAllowedTool\(/);
    expect(SERVER_SRC).not.toMatch(/(?<![\w$.])requireToken\(/);
    expect(SERVER_SRC).toMatch(/import \{ decide \} from "\.\/shared\/admission-table\.mjs";/);
    // The side effects are triggered from the decision.
    expect(SERVER_SRC).toContain("if (_bootstrapDecision.action === 'bootstrap_session') {");
    expect(SERVER_SRC).toContain("applyChainAdmissionEffects(_session, tool, cleanArgs, _admission)");
    expect(SERVER_SRC.indexOf("() => autoRouteUnauthorized(tool, cleanArgs)")).toBeGreaterThan(calls[2]);
  });
});

describe("CHAIN_MACHINE without allowed Sets", () => {
  it("no state definition carries allowed and validateChainMachine accepts the machine", () => {
    for (const f of FLOWS) {
      for (const [s, def] of Object.entries(CHAIN_MACHINE[f].states)) {
        expect(Object.hasOwn(def, "allowed"), `${f}/${s}`).toBe(false);
        // The derived view still carries the Set.
        expect(getStates(f)[s].allowed, `${f}/${s}`).toBeInstanceOf(Set);
        expect([...getStates(f)[s].allowed], `${f}/${s}`).toEqual([...chainStateTools(f, s)]);
      }
    }
    expect(() => validateChainMachine(CHAIN_MACHINE)).not.toThrow();
  });
});

// Captured from the PRE-change modules (git HEAD before this story), never regenerated.
const PRE_CHANGE = {
  COMMON_TOOLS: ["rks_governor_init","rks_governor_end","rks_project_get","rks_guardrails_on","rks_guardrails_abort","rks_guardrails_off","rks_guardrails_status","rks_phase_repair","rks_agent_visual","rks_onboarder","rks_templates_list"],
  UNPROTECTED_TOOLS: ["rks_governor_init","rks_governor_end","rks_guardrails_on","rks_guardrails_abort","rks_guardrails_status","rks_phase_repair","rks_project_get","rks_preflight","rks_telemetry_query","rks_telemetry_report","rks_telemetry_export","rks_channel_preview","rks_memory_save","rks_init","rks_interview","rks_onboarder","rks_templates_list","rks_story_create","rks_rag_init","rks_rag_embed","rks_rag_query","rks_rag_compact","rks_exec_abort"],
  STORY_FLOW_TOOLS: ["rks_refine","rks_refine_apply","rks_agent_research","rks_agent_external_research","rks_exhaustive_search","rks_agent_git","rks_agent_visual","rks_plan","rks_plan_review","rks_plan_ready","rks_exec","rks_exec_abort","rks_preflight","rks_analyze","rks_agent_dendron","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields"],
  OPEN_FLOW_TOOLS: ["rks_agent_research","rks_agent_external_research","rks_fetch_raw","rks_exhaustive_search","rks_agent_recovery","rks_agent_git","rks_agent_visual","rks_agent_dendron","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","dendron_rename_note","rks_inbox_review","rks_arch_verdict","rks_preflight","rks_plan_ready"],
  OPS_FLOW_TOOLS: ["rks_agent_run","rks_agent_git","rks_agent_research","rks_agent_external_research","rks_exhaustive_search","rks_agent_recovery","rks_project_get","rks_preflight","rks_telemetry_query","rks_telemetry_report","rks_rag_query","rks_release","rks_promote","rks_sync_staging","rks_tag","dendron_read_note"],
  STATE_BYPASS_TOOLS: ["rks_governor_init","rks_guardrails_on","rks_guardrails_status","rks_phase_repair","rks_stash"],
  READ_ONLY_EXEMPT_TOOLS: ["rks_git_state","rks_publish_profiles"],
  QA_FLOW_TOOLS: ["rks_governor_init","rks_agent_research","rks_agent_external_research","rks_exhaustive_search","rks_agent_git","rks_agent_run","rks_project_get","rks_preflight","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields"],
  SHIP_FLOW_TOOLS: ["rks_governor_init","rks_git_state","rks_git_commit","rks_git_push","rks_staging_pr","rks_git_merge","rks_staging_merge","rks_cycle_complete","rks_agent_git","rks_project_get"],
};

describe("derived projections", () => {
  it("the legacy admission exports remain and isProtectedTool agrees with the token rows", () => {
    const exported = { COMMON_TOOLS, UNPROTECTED_TOOLS, STORY_FLOW_TOOLS, OPEN_FLOW_TOOLS, OPS_FLOW_TOOLS, STATE_BYPASS_TOOLS, READ_ONLY_EXEMPT_TOOLS, QA_FLOW_TOOLS, SHIP_FLOW_TOOLS };
    for (const [name, set] of Object.entries(exported)) {
      expect(set, name).toBeInstanceOf(Set);
      expect([...set], name).toEqual(PRE_CHANGE[name]);
    }
    expect([...COMMON_TOOLS]).toEqual([...COMMON_TOOL_NAMES]);
    expect([...UNPROTECTED_TOOLS]).toEqual([...UNPROTECTED_TOOL_NAMES]);
    expect([...STATE_BYPASS_TOOLS]).toEqual([...STATE_BYPASS_TOOL_NAMES]);
    expect([...READ_ONLY_EXEMPT_TOOLS]).toEqual([...READ_ONLY_EXEMPT_TOOL_NAMES]);
    expect(SHIP_STATES).toBe(getStates("ship"));
    expect(OPS_STATES).toBe(getStates("ops"));
    for (const fn of [isProtectedTool, checkAllowedTool, requireToken, classifyChainRefusal, checkStateAllowed]) expect(typeof fn).toBe("function");
    // requireToken keeps its results: null for a live token, the unauthorized body otherwise.
    const { token } = createSession({ projectId: "p", flowType: "open" });
    expect(requireToken(token, "rks_plan")).toBeNull();
    expect(requireToken(undefined, "rks_plan")).toMatchObject({ ok: false, error: "unauthorized", tokenStatus: "missing" });
    expect(requireToken("not-a-token", "rks_plan")).toMatchObject({ ok: false, error: "unauthorized", tokenStatus: "not_found_or_expired" });
    // isProtectedTool agrees with the token rows: a tokenless gate-armed call matches the unprotected
    // allow row exactly when the tool is unprotected, and is otherwise routed.
    for (const tool of UNIVERSE) {
      const d = decide(sessionInput({ tool, tokenPresent: false }));
      expect(d.matchedRule === "session.token.unprotected", tool).toBe(!isProtectedTool(tool));
      if (isProtectedTool(tool)) expect(d.matchedRule, tool).toBe("session.route.tokenless");
    }
  });

  it("classifyChainRefusal stateBlocks agrees with the chain rows for every flow, state and tool", () => {
    for (const f of FLOWS) {
      for (const s of Object.keys(CHAIN_MACHINE[f].states)) {
        const row = ADMISSION_TABLE.find((r) => r.id === `session.chain.${f}.${s}`);
        expect(row, `${f}/${s}`).toBeDefined();
        for (const tool of UNIVERSE) {
          const res = classifyChainRefusal({ flowType: f, chainState: s, tool });
          expect(res.blockedBy, `${f}/${s}/${tool}`).toBe(row.tools.includes(tool) ? "neither" : "state");
        }
      }
    }
  });
});

describe("remote lane rows", () => {
  const remoteAdmitted = (policy) => new Set(UNIVERSE.filter((tool) => decide({
    tool,
    args: { projectId: "p", filename: "inbox.actor.note" },
    context: { stage: "lane", lane: "remote", policy, tokenPresent: true, tokenValid: true, bootProjectId: "p", env: { RKS_ACTOR: "actor" } },
  }).effect === "allow"));

  it("the remote admitted set equals REMOTE_LANE_TOOLS and a widened project.json policy does not change it", () => {
    const base = remoteAdmitted({ status: "absent", lanes: null });
    expect([...base].sort()).toEqual([...REMOTE_LANE_TOOLS].sort());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-remote-"));
    const saved = { ROUTEKIT_PROJECT_ROOT: process.env.ROUTEKIT_PROJECT_ROOT, RKS_PROJECT_ROOT: process.env.RKS_PROJECT_ROOT };
    try {
      fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify({
        id: "p",
        lanes: { remote: ["rks_exec", "rks_ship", "dendron_update_field"], ide: "full", mcp: "full" },
      }));
      process.env.ROUTEKIT_PROJECT_ROOT = dir;
      delete process.env.RKS_PROJECT_ROOT;
      const widened = loadBootLanePolicy();
      expect(widened.root).toBe(dir);
      expect([...remoteAdmitted(widened)].sort()).toEqual([...REMOTE_LANE_TOOLS].sort());
      expect([...remoteAdmitted(readLanePolicy({ lanes: { remote: "full" } }))].sort()).toEqual([...REMOTE_LANE_TOOLS].sort());
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The enumerated completeness inputs: every tool x flow x state x token presence, plus the
// lease / gate / invalid-token / no-session / argument / lane / bootstrap variants that reach the
// remaining rows.
function completenessInputs() {
  const inputs = [];
  for (const tool of UNIVERSE) {
    for (const f of FLOWS) {
      for (const s of Object.keys(CHAIN_MACHINE[f].states)) {
        inputs.push(sessionInput({ tool, session: { flowType: f, state: s, problemId: null } }));
        inputs.push(sessionInput({ tool, session: { flowType: f, state: s, problemId: null }, leaseRefused: true }));
      }
    }
    inputs.push(sessionInput({ tool, tokenPresent: false }));
    inputs.push(sessionInput({ tool, tokenPresent: false, tokenGateArmed: false }));
    inputs.push(sessionInput({ tool, tokenPresent: true, tokenValid: false }));
    inputs.push(sessionInput({ tool, tokenPresent: true, tokenValid: true, session: null }));
  }
  const story = { flowType: "story", state: "refining" };
  inputs.push(sessionInput({ tool: "dendron_create_note", args: { filename: "research.x" }, session: story }));
  inputs.push(sessionInput({ tool: "dendron_create_note", args: { filename: "backlog.x" }, session: { flowType: "open", state: "writing" } }));
  inputs.push(sessionInput({ tool: "dendron_update_field", args: { filename: "backlog.x", field: "phase", value: "ready" }, session: story }));
  for (const tool of ["rks_exec", "rks_governor_init", "rks_rag_query"]) {
    inputs.push({ tool, args: { projectId: "p" }, context: { stage: "lane", lane: "ide", policy: { status: "absent", lanes: null } } });
    inputs.push({ tool, args: { projectId: "p" }, context: { stage: "lane", lane: "mcp", policy: { status: "ok", lanes: { mcp: "read-only" } } } });
    inputs.push({ tool, args: { projectId: "p" }, context: { stage: "lane", lane: "remote", policy: { status: "absent", lanes: null }, tokenPresent: true, tokenValid: false, bootProjectId: "p" } });
  }
  for (const tool of ["rks_agent_research", "rks_exec"]) {
    for (const tokenPresent of [true, false]) {
      for (const tokenGateArmed of [true, false]) {
        for (const args of [{ projectId: "p" }, {}]) inputs.push({ tool, args, context: { stage: "bootstrap", tokenPresent, tokenGateArmed } });
      }
    }
  }
  return inputs;
}

describe("completeness", () => {
  it("every registered tool x flow x state x token presence yields exactly one winning effect", () => {
    expect(REGISTERED.length).toBeGreaterThanOrEqual(82);
    for (const tool of UNIVERSE) {
      for (const f of FLOWS) {
        for (const s of Object.keys(CHAIN_MACHINE[f].states)) {
          for (const tokenPresent of [true, false]) {
            const d = decide(sessionInput({ tool, tokenPresent, session: tokenPresent ? { flowType: f, state: s } : null }));
            expect(EFFECTS, `${tool} ${f}/${s} ${tokenPresent}`).toContain(d.effect);
            // A row decided it (never the default deny).
            expect(d.matchedRule, `${tool} ${f}/${s} ${tokenPresent}`).not.toBeNull();
            expect(ROW_IDS).toContain(d.matchedRule);
          }
        }
      }
    }
  });

  it("every ADMISSION_TABLE row is reachable", () => {
    const hit = new Set();
    const stages = new Set();
    for (const input of completenessInputs()) {
      const d = decide(input);
      expect(d.matchedRule, JSON.stringify(input)).not.toBeNull();
      hit.add(d.matchedRule);
      stages.add(input.context.stage);
    }
    expect([...stages].sort()).toEqual(["bootstrap", "lane", "session"]);
    expect(ROW_IDS.filter((id) => !hit.has(id))).toEqual([]);
  });
});

describe("self-bootstrap row", () => {
  it("a tokenless ide-lane rks_agent_research call matches the one named self-bootstrap row", () => {
    const bootRows = ADMISSION_TABLE.filter((r) => r.action === "bootstrap_session");
    expect(bootRows.map((r) => r.id)).toEqual(["bootstrap.open.research-self-bootstrap"]);
    expect(bootRows[0].stage).toBe("bootstrap");
    const boot = (args, tokenGateArmed = true) => decide({ tool: "rks_agent_research", args, context: { stage: "bootstrap", lane: "ide", tokenPresent: false, tokenGateArmed } });
    expect(boot({ projectId: "p" })).toEqual({
      effect: "allow", reason: "research_self_bootstrap", layer: "token", remedy: null,
      matchedRule: "bootstrap.open.research-self-bootstrap", action: "bootstrap_session",
    });
    expect(boot({ projectId: "p" }, false).matchedRule).toBe("bootstrap.passthrough");
    expect(boot({ projectId: "p" }, false).action).toBeUndefined();
    expect(boot({}).matchedRule).toBe("bootstrap.passthrough");
    // The bootstrapped call then carries a fresh open-flow session at its start state.
    const { token } = createSession({ projectId: "p", flowType: "open" });
    const after = decide({ tool: "rks_agent_research", args: { projectId: "p" }, session: getSession(token), context: { stage: "session", lane: "ide", tokenPresent: true, tokenValid: true, tokenGateArmed: true, leaseRefused: false } });
    expect(after.effect).toBe("allow");
    expect(after.matchedRule).toBe("session.chain.open.init");
  });
});

describe("chain-admission effect applier", () => {
  const collect = () => {
    const events = [];
    const spy = vi.spyOn(getTelemetryCollector(), "emit").mockImplementation((name, projectId, payload) => { events.push({ name, payload }); });
    return { events, restore: () => spy.mockRestore() };
  };

  it("sets lastActivity, counts an admitted call once, skips COMMON_TOOLS and refusals, and emits one chain.violation on a state refusal", () => {
    const tel = collect();
    try {
      const { token } = createSession({ projectId: "p", flowType: "story", problemId: "backlog.fix.applier" });
      const session = getSession(token);
      session.state = "refining";
      const run = (tool, args) => {
        const d = decide(sessionInput({ tool, args, session }));
        applyChainAdmissionEffects(session, tool, args, d);
        return d;
      };
      session.lastActivity = 0;
      expect(run("rks_plan").effect).toBe("allow");
      expect(session.lastActivity).toBeGreaterThan(0);
      expect(session.toolCallCounts.rks_plan).toBe(1);
      expect(decide(sessionInput({ tool: "rks_plan", session })).effect).toBe("allow");
      expect(session.toolCallCounts.rks_plan).toBe(1); // decide alone counts nothing

      // COMMON tool: no effect at all.
      session.lastActivity = 0;
      run("rks_project_get");
      expect(session.lastActivity).toBe(0);
      expect(session.toolCallCounts.rks_project_get).toBeUndefined();

      // Chain-state refusal: lastActivity, no increment, one chain.violation (state_machine).
      tel.events.length = 0;
      session.lastActivity = 0;
      expect(run("rks_ship").layer).toBe("chain");
      expect(session.lastActivity).toBeGreaterThan(0);
      expect(session.toolCallCounts.rks_ship).toBeUndefined();
      const v = tel.events.filter((e) => e.name === "chain.violation");
      expect(v).toHaveLength(1);
      expect(v[0].payload).toMatchObject({ blockedTool: "rks_ship", violationKind: "state_machine", flowType: "story", state: "refining" });

      // Args refusal: no increment, the checkToolArgs chain.violation.
      tel.events.length = 0;
      expect(run("dendron_create_note", { filename: "research.x" }).layer).toBe("args");
      expect(session.toolCallCounts.dendron_create_note).toBeUndefined();
      expect(tel.events.filter((e) => e.name === "chain.violation").map((e) => e.payload.violationKind)).toEqual(["namespace"]);

      // checkAllowedTool called directly: same returns and session mutations as before.
      tel.events.length = 0;
      expect(checkAllowedTool(token, "rks_plan")).toBeNull();
      expect(session.toolCallCounts.rks_plan).toBe(2);
      expect(checkAllowedTool(token, "rks_project_get")).toBeNull();
      expect(session.toolCallCounts.rks_project_get).toBeUndefined();
      const refused = checkAllowedTool(token, "rks_ship");
      expect(refused).toMatchObject({ ok: false, error: "chain_violation", tool: "rks_ship", flowType: "story", state: "refining", blockedBy: "state" });
      expect(refused.message).toBe(checkStateAllowed("story", "refining", "rks_ship").error);
      expect(refused).toEqual(chainAdmissionRefusal(session, "rks_ship", undefined, decide(sessionInput({ tool: "rks_ship", session }))));
      expect(checkAllowedTool(token, "dendron_create_note", { filename: "research.x" })).toMatchObject({ ok: false, error: "namespace_violation" });
      expect(tel.events.filter((e) => e.name === "chain.violation")).toHaveLength(2);
      expect(checkAllowedTool("00000000-0000-0000-0000-00000000dead", "rks_plan")).toEqual({
        ok: false, error: "unauthorized", tool: "rks_plan",
        message: "No active Governor session for token. Call rks_governor_init first.",
      });
    } finally {
      tel.restore();
    }
  });
});

describe("staged precedence", () => {
  it("lease beats chain, a supplied-invalid token is denied not routed, a tokenless protected call is routed, and a lane refusal precedes preflight", () => {
    // Lease + chain refusal on the same protected tool: the lease refusal wins.
    const both = decide(sessionInput({ tool: "rks_ship", session: { flowType: "story", state: "init" }, leaseRefused: true }));
    expect(both).toMatchObject({ effect: "deny", layer: "lease", matchedRule: "session.lease.lost" });
    expect(decide(sessionInput({ tool: "rks_ship", session: { flowType: "story", state: "init" } }))).toMatchObject({ effect: "deny", layer: "chain" });
    // A lost lease does not refuse an unprotected tool.
    expect(decide(sessionInput({ tool: "rks_governor_end", session: { flowType: "story", state: "init" }, leaseRefused: true })).effect).toBe("allow");
    // Supplied-but-invalid token: denied, never routed.
    expect(decide(sessionInput({ tool: "rks_release", tokenPresent: true, tokenValid: false }))).toMatchObject({ effect: "deny", layer: "token", matchedRule: "session.token.supplied-invalid" });
    // Tokenless protected call with the gate armed: routed; with the gate bypassed: allowed.
    expect(decide(sessionInput({ tool: "rks_release", tokenPresent: false }))).toMatchObject({ effect: "route", matchedRule: "session.route.tokenless" });
    expect(decide(sessionInput({ tool: "rks_release", tokenPresent: false, tokenGateArmed: false })).effect).toBe("allow");
    // Lane refusal: decided at the lane stage, whose call site precedes the preflight block.
    expect(decide({ tool: "rks_exec", args: {}, context: { stage: "lane", lane: "mcp", policy: { status: "ok", lanes: { mcp: "read-only" } } } }))
      .toMatchObject({ effect: "deny", layer: "lane", matchedRule: "lane.policy-refusal" });
    expect(decide({ tool: "rks_governor_init", args: { projectId: "p" }, context: { stage: "lane", lane: "remote", policy: { status: "absent" }, tokenPresent: true, tokenValid: false, bootProjectId: "p" } }))
      .toMatchObject({ effect: "deny", matchedRule: "lane.remote-token-required" });
    const laneAt = SERVER_SRC.search(/(?<![\w$.])decide\(\{ principal: null, tool, args: cleanArgs, session: null, context: \{ stage: 'lane'/);
    expect(laneAt).toBeGreaterThan(-1);
    const laneReturn = SERVER_SRC.indexOf("return { content: [{ type: \"text\", text: JSON.stringify(_laneRefusal, null, 2) }], isError: true };", laneAt);
    expect(laneReturn).toBeGreaterThan(laneAt);
    expect(laneReturn).toBeLessThan(SERVER_SRC.indexOf("if (hasPreflightChecks(tool)) {"));
  });
});
