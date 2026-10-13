/**
 * S9b governance handler family - unit tier (backlog.feat.server-mjs-governance-handler-family).
 * Pattern: tests/unit/server-handler-planner.test.mjs and server-handler-agent-bootstrap.test.mjs.
 * Unit tier: no unguarded spawn-family call, no server.mjs import (read as text only), no module-registry
 * reset. Every entry point the seven bodies reach is a vi.fn keyed on its resolved module file.
 * Telemetry: this file mocks the collector subpath and escapes the global-mock triage with the literal
 * vi.importActual("@routekit/telemetry/collector") in GV-TR14 (server-handler-planner.test.mjs:548 precedent).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const h = vi.hoisted(() => {
  // rag.mjs is imported for the coexistence check; keep @routekit/rag on its stub embedder.
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
  return {
    loadContext: vi.fn(), getBranchConfig: vi.fn(),
    guardrailsOff: vi.fn(), guardrailsOn: vi.fn(), guardrailsAbort: vi.fn(), getSessionHistory: vi.fn(), commitAndPushNote: vi.fn(),
    repairPhaseToIntegrated: vi.fn(), runGitCheckout: vi.fn(), getCurrentBranch: vi.fn(),
    handleGovernorInit: vi.fn(), setProjectRoot: vi.fn(), detectOrphanedGuardrails: vi.fn(),
    writeNoteRaw: vi.fn(), realWriteNoteRaw: null, findGate: vi.fn(), spawnSync: vi.fn(), emit: vi.fn(),
  };
});

vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (io) => ({ ...(await io()), loadContext: h.loadContext, getBranchConfig: h.getBranchConfig }));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (io) => ({ ...(await io()), guardrailsOff: h.guardrailsOff, guardrailsOn: h.guardrailsOn, guardrailsAbort: h.guardrailsAbort, getSessionHistory: h.getSessionHistory, commitAndPushNote: h.commitAndPushNote }));
vi.mock("../../packages/mcp-rks/src/workflow/auto-phase.mjs", async (io) => ({ ...(await io()), repairPhaseToIntegrated: h.repairPhaseToIntegrated }));
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (io) => ({ ...(await io()), runGitCheckout: h.runGitCheckout }));
vi.mock("../../packages/mcp-rks/src/server/exec.mjs", async (io) => ({ ...(await io()), getCurrentBranch: h.getCurrentBranch }));
vi.mock("../../packages/mcp-rks/src/tools/governor-init.mjs", async (io) => ({ ...(await io()), handleGovernorInit: h.handleGovernorInit }));
vi.mock("../../packages/mcp-rks/src/shared/governor-token.mjs", async (io) => ({ ...(await io()), setProjectRoot: h.setProjectRoot, detectOrphanedGuardrails: h.detectOrphanedGuardrails }));
vi.mock("../../packages/mcp-rks/src/dendron.mjs", async (io) => { const real = await io(); h.realWriteNoteRaw = real.writeNoteRaw; return { ...real, writeNoteRaw: h.writeNoteRaw }; });
vi.mock("../../packages/mcp-rks/src/server/plan-ready.mjs", async (io) => ({ ...(await io()), findCreateTargetNoAuthorableBlockIssues: h.findGate }));
vi.mock("child_process", async (io) => ({ ...(await io()), spawnSync: h.spawnSync }));
vi.mock("@routekit/telemetry/collector", async (io) => ({ ...(await io()), getTelemetryCollector: () => ({ emit: h.emit }) }));

import { createHandlerRegistry } from "../../packages/mcp-rks/src/server/handlers/registry.mjs";
import { registerGovernanceHandlers } from "../../packages/mcp-rks/src/server/handlers/governance.mjs";
import { registerTelemetryHandlers } from "../../packages/mcp-rks/src/server/handlers/telemetry.mjs";
import { registerProjectMetaHandlers } from "../../packages/mcp-rks/src/server/handlers/project-meta.mjs";
import { registerDendronHandlers } from "../../packages/mcp-rks/src/server/handlers/dendron.mjs";
import { registerRagHandlers } from "../../packages/mcp-rks/src/server/handlers/rag.mjs";
import { registerGitHandlers } from "../../packages/mcp-rks/src/server/handlers/git.mjs";
import { registerShipHandlers } from "../../packages/mcp-rks/src/server/handlers/ship.mjs";
import { registerPlannerHandlers } from "../../packages/mcp-rks/src/server/handlers/planner.mjs";
import { registerAgentBootstrapHandlers } from "../../packages/mcp-rks/src/server/handlers/agent-bootstrap.mjs";
import { CO_AUTHOR_REJECTED_WARNING, coAuthorTrailer } from "../../packages/mcp-rks/src/shared/commit-attribution.mjs";
import { ARCH_MAX_ROUNDS } from "../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { resolveNotesDir, readNoteRaw, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GOV_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server/handlers/governance.mjs");
const SERVER_ABS = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const SELF_ABS = fileURLToPath(import.meta.url);

const GOVERNANCE_TOOLS = ["rks_arch_verdict", "rks_governor_init", "rks_guardrails_abort", "rks_guardrails_off", "rks_guardrails_on", "rks_guardrails_status", "rks_phase_repair"];
const SCHEMA_KEY = {
  rks_guardrails_off: "guardrailsOffSchema", rks_guardrails_on: "guardrailsOnSchema", rks_guardrails_abort: "guardrailsAbortSchema",
  rks_guardrails_status: "guardrailsStatusSchema", rks_phase_repair: "phaseRepairSchema", rks_arch_verdict: "archVerdictSchema", rks_governor_init: "governorInitSchema",
};

// The other eight S0 families (tests/unit/server-handler-agent-bootstrap.test.mjs AB-TR2).
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_update_field", "dendron_validate_schema"];
const RAG_TOOLS = ["rks_exhaustive_search", "rks_fetch_raw", "rks_memory_save", "rks_rag_compact", "rks_rag_embed", "rks_rag_init", "rks_rag_query"];
const GIT_TOOLS = ["rks_branch_repair", "rks_checkout", "rks_cherry_pick", "rks_git_branch", "rks_git_commit", "rks_git_preflight", "rks_git_push", "rks_reset", "rks_resolve_conflict", "rks_restore", "rks_revert", "rks_stash", "rks_tag"];
const SHIP_TOOLS = ["rks_cycle_complete", "rks_git_merge", "rks_promote", "rks_release", "rks_ship", "rks_staging_merge", "rks_staging_pr", "rks_story_ship", "rks_sync_staging"];
const PLANNER_TOOLS = [
  "rks_analyze", "rks_plan", "rks_plan_review", "rks_preflight", "rks_validate_story", "rks_plan_ready",
  "rks_exec", "rks_exec_abort", "rks_apply", "rks_approve", "rks_refine", "rks_refine_apply", "rks_ready",
  "rks_review", "rks_story_create", "rks_guardrails_simulate",
];
const AGENT_BOOTSTRAP_TOOLS = ["rks_init", "rks_project_init", "rks_agent_external_research", "rks_onboarder", "rks_interview", "rks_agent_run"];
const GIT_SCHEMA_KEYS = ["stashSchema", "restoreSchema", "resetSchema", "revertSchema", "tagSchema", "cherryPickSchema", "gitBranchSchema", "checkoutSchema", "branchRepairSchema", "gitCommitSchema", "gitPushSchema"];
const SHIP_SCHEMA_KEYS = ["cycleCompleteSchema", "promoteSchema", "shipSchema", "stagingPrSchema", "gitMergeSchema", "stagingMergeSchema"];
const PLANNER_SCHEMA_KEYS = ["analyzeSchema", "planSchema", "planReviewSchema", "validateStorySchema", "planReadySchema", "execSchema", "applySchema", "guardrailSimSchema", "refineSchema", "refineApplySchema"];
const AB_SCHEMA_KEYS = ["rksInitSchema", "projectInitSchema", "onboarderSchema", "interviewSchema"];

// Expected bytes: committed literals captured by the builder from the PRE-MOVE build-base server.mjs.
// Capture sha: b1ae5e490fefb33f5f94e39ed614b785f6524bce (git show <sha>:packages/mcp-rks/src/server.mjs).
// Sources at that sha (same line numbers as @cad8c73be): server.mjs:2685 (invalid_arch_round detail),
// :2647 (not_on_integration_branch skip object), :2644 (commit subject), :2925 (auto-checkout suffix).
// Pasted verbatim; never read from governance.mjs and never computed from the code under test.
const INVALID_ARCH_ROUND_DETAIL_AT_BASE = "arch_round must be a finite numeric scalar. Refusing rather than coercing to 0, which would silently restart the round counter and re-freeze the ledger.";
const SKIP_NOTE_AT_BASE = (currentBranch, integrationBranch) => ({ ok: false, skipped: true, reason: "not_on_integration_branch", currentBranch, integrationBranch });
const SKIP_NOTE_KEYS_AT_BASE = ["ok", "skipped", "reason", "currentBranch", "integrationBranch"];
const COMMIT_SUBJECT_AT_BASE = (storyId) => `chore(story): advance ${storyId} to integrated (rks_phase_repair)`;
const AUTO_CHECKOUT_SUFFIX_AT_BASE = (from, to) => ` (auto-checkout: ${from} → ${to})`;

const PROJECT_ID = "s9b-governance-unit";
const ROOT = "/s9b/fixture-root";
const ctxFor = (args) => Object.freeze({ tool: "s9b-ctx-tool", args, activeToken: "s9b-active", governorToken: "s9b-token" });
const payload = (res) => JSON.parse(res.content[0].text);
const passSchemas = () => Object.fromEntries(Object.values(SCHEMA_KEY).map((k) => [k, z.object({}).passthrough()]));
const tmpNotes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s9b-gov-unit-")));
const helperStubs = () => ({
  getDendronContext: vi.fn(() => ({ notesDir: tmpNotes, projectRoot: tmpNotes })),
  assertNotesDir: vi.fn(),
  notePathFromFilename: vi.fn((dir, id) => path.join(dir, `${id}.md`)),
  commitDendronWriteResult: vi.fn(async (arg) => ({ wrapped: true, inner: arg.innerResult })),
  reconcileActiveScopeOnInit: vi.fn(() => ({ removed: false, reason: "s9b-reason", extra: "not-copied" })),
});
function govRegistry(schemas = passSchemas(), helpers = helperStubs()) {
  const r = createHandlerRegistry();
  registerGovernanceHandlers(r, schemas, helpers);
  return { r, helpers, call: (tool, args) => r.lookupHandler(tool)(args, ctxFor(args)) };
}
const importSpecifiers = (src) => [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
const isRelative = (s) => s.startsWith(".");
// Every `import <default> from "x"` / `import { a, b as c } from "x"` statement (multi-line braces allowed).
function importBindings(src) {
  const out = [];
  for (const m of src.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*from\s*["']([^"']+)["'];/gm)) {
    const names = m[1]
      ? [{ imported: "default", local: m[1] }]
      : m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const [imported, local] = s.split(/\s+as\s+/);
        return { imported, local: local ?? imported };
      });
    out.push({ spec: m[3], names });
  }
  return out;
}

let noteSeq = 0;
function writeNote({ phase = "draft", extra = "" } = {}) {
  const id = `backlog.feat.s9b-unit-note-${++noteSeq}`;
  const p = path.join(tmpNotes, `${id}.md`);
  fs.writeFileSync(p, `---\nid: "${id}"\ntitle: "S9b"\ncreated: 1\nupdated: 2\nphase: "${phase}"\n${extra}---\n\n## Problem\n\nbody ${noteSeq}\n`);
  return { id, p };
}
const fmOf = (p) => parseFrontmatter(readNoteRaw(p))?.data || {};

beforeEach(() => {
  for (const fn of Object.values(h)) if (typeof fn === "function" && fn.mockReset) fn.mockReset();
  h.loadContext.mockImplementation(async (projectId) => ({ record: { id: projectId, root: ROOT }, projectJson: {} }));
  h.getBranchConfig.mockReturnValue({ integration: "staging" });
  h.writeNoteRaw.mockImplementation((...a) => h.realWriteNoteRaw(...a));
  h.findGate.mockReturnValue([]);
  h.spawnSync.mockReturnValue({ status: 1, stdout: "" });
});
afterAll(() => fs.rmSync(tmpNotes, { recursive: true, force: true }));

describe("S9b governance handlers (unit)", () => {
  it("GV-TR1 registers exactly the seven governance tools under their TOOL_NAME values", () => {
    const { r } = govRegistry();
    expect(GOVERNANCE_TOOLS).toHaveLength(7);
    expect(r.registeredTools()).toEqual([...GOVERNANCE_TOOLS].sort());
    expect(r.registeredTools()).not.toContain("ARCH_VERDICT_TOOL");
    expect(r.registeredTools()).not.toContain("GOVERNOR_INIT_TOOL");
    for (const tool of GOVERNANCE_TOOLS) expect(typeof r.lookupHandler(tool), tool).toBe("function");
  });

  it("GV-TR2 coexists with the other eight families at 77 tools", () => {
    const r = createHandlerRegistry();
    const pid = z.object({ projectId: z.string() });
    const any = z.object({});
    expect(() => {
      registerTelemetryHandlers(r, { telemetryQuerySchema: pid, telemetryReportSchema: pid, telemetryAnalysisSchema: pid, tokenCostReportSchema: pid, telemetryExportSchema: pid });
      registerProjectMetaHandlers(r, { projectGetSchema: z.object({ id: z.string() }), kgQuerySchema: pid, templatesListSchema: any, gitStateSchema: pid, publishSchema: pid, publishProfilesSchema: pid });
      registerDendronHandlers(
        r,
        { createNoteSchema: any, fixFrontmatterSchema: any, validateSchemaSchema: any, editNoteSchema: any, updateFieldSchema: any, markImplementedSchema: any },
        { getDendronContext: vi.fn(), assertNotesDir: vi.fn(), notePathFromFilename: vi.fn(), commitDendronWriteResult: vi.fn() },
      );
      registerRagHandlers(
        r,
        { ragInitSchema: pid, ragEmbedSchema: pid, ragQuerySchema: pid, ragCompactSchema: pid, memorySaveSchema: pid, fetchRawSchema: pid },
        { getDendronContext: vi.fn() },
      );
      registerGitHandlers(r, Object.fromEntries(GIT_SCHEMA_KEYS.map((k) => [k, pid])));
      registerShipHandlers(r, Object.fromEntries(SHIP_SCHEMA_KEYS.map((k) => [k, pid])));
      registerPlannerHandlers(r, Object.fromEntries(PLANNER_SCHEMA_KEYS.map((k) => [k, z.object({ projectId: z.string() }).passthrough()])), {
        pendingPlans: new Map(),
        getPollHintMs: vi.fn(() => 4321),
        getPendingPlanPath: vi.fn((root) => path.join(root, ".rks", "pending-plan.json")),
        writePendingPlanMarker: vi.fn(),
        isProcessAlive: vi.fn(() => false),
        readPendingPlanMarker: vi.fn(() => null),
        removePendingPlanMarker: vi.fn(),
      });
      registerAgentBootstrapHandlers(r, Object.fromEntries(AB_SCHEMA_KEYS.map((k) => [k, z.object({}).passthrough()])));
      registerGovernanceHandlers(r, passSchemas(), helperStubs());
    }).not.toThrow();
    const all = [...TELEMETRY_TOOLS, ...PROJECT_META_TOOLS, ...DENDRON_TOOLS, ...RAG_TOOLS, ...GIT_TOOLS, ...SHIP_TOOLS, ...PLANNER_TOOLS, ...AGENT_BOOTSTRAP_TOOLS, ...GOVERNANCE_TOOLS];
    expect(new Set(all).size).toBe(77);
    expect(r.registeredTools()).toEqual([...all].sort());
    expect(r.registeredTools()).toHaveLength(77);
  });

  it("GV-TR3 parses with the injected schema before any entry point", async () => {
    for (const [tool, key] of Object.entries(SCHEMA_KEY)) {
      const sentinel = new Error(`s9b sentinel ${key}`);
      const parse = vi.fn(() => { throw sentinel; });
      const { call, helpers } = govRegistry({ ...passSchemas(), [key]: { parse } });
      const args = { projectId: PROJECT_ID, storyId: "backlog.feat.s9b-x", reason: "s9b", findings: [] };
      const err = await call(tool, args).catch((e) => e);
      expect(err, tool).toBe(sentinel);
      expect(parse, tool).toHaveBeenCalledTimes(1);
      expect(parse.mock.calls[0][0], tool).toBe(args);
      for (const name of ["getDendronContext", "assertNotesDir", "notePathFromFilename", "commitDendronWriteResult", "reconcileActiveScopeOnInit"]) {
        expect(helpers[name], `${tool} ${name}`).not.toHaveBeenCalled();
      }
    }
    expect(Object.keys(SCHEMA_KEY)).toHaveLength(7);
    for (const name of ["loadContext", "guardrailsOff", "guardrailsOn", "guardrailsAbort", "getSessionHistory", "repairPhaseToIntegrated", "handleGovernorInit", "setProjectRoot", "detectOrphanedGuardrails"]) {
      expect(h[name], name).not.toHaveBeenCalled();
    }
  });

  it("GV-TR4 rks_guardrails_off projection", async () => {
    const { call } = govRegistry();
    const res = { ok: true, s9b: "off" };
    h.guardrailsOff.mockResolvedValue(res);
    const p = payload(await call("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b reason", problemId: "backlog.feat.s9b" }));
    expect(h.loadContext.mock.calls).toEqual([[PROJECT_ID]]);
    expect(h.guardrailsOff).toHaveBeenCalledTimes(1);
    expect(h.guardrailsOff.mock.calls[0]).toEqual([ROOT, "s9b reason", "all", "backlog.feat.s9b", PROJECT_ID]);
    expect(p).toEqual(res);

    await call("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b two", scope: "write" });
    expect(h.guardrailsOff).toHaveBeenCalledTimes(2);
    expect(h.guardrailsOff.mock.calls[1]).toEqual([ROOT, "s9b two", "write", undefined, PROJECT_ID]);
  });

  it("GV-TR5 rks_guardrails_on option spread and coAuthor rejection", async () => {
    const { call } = govRegistry();
    const res = { ok: true, s9b: "on" };
    h.guardrailsOn.mockResolvedValue(res);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Absent options: empty object.
      expect(payload(await call("rks_guardrails_on", { projectId: PROJECT_ID }))).toEqual(res);
      expect(h.guardrailsOn.mock.calls[0]).toEqual([ROOT, {}, PROJECT_ID]);
      expect(Object.keys(h.guardrailsOn.mock.calls[0][1])).toEqual([]);

      // restoreFromTemplate false leaves the key out; true carries it.
      await call("rks_guardrails_on", { projectId: PROJECT_ID, restoreFromTemplate: false });
      expect(Object.keys(h.guardrailsOn.mock.calls[1][1])).toEqual([]);
      await call("rks_guardrails_on", { projectId: PROJECT_ID, restoreFromTemplate: true });
      expect(h.guardrailsOn.mock.calls[2][1]).toStrictEqual({ restoreFromTemplate: true });
      await call("rks_guardrails_on", { projectId: PROJECT_ID, restoreFromTemplate: "true" });
      expect(Object.keys(h.guardrailsOn.mock.calls[3][1])).toEqual([]);

      // enforcementOverride and an accepted coAuthor spread when truthy.
      const override = { enabled: true, reason: "s9b override" };
      const accepted = "S9b Builder <s9b@example.com>";
      expect(coAuthorTrailer(accepted)).not.toBe("");
      const ok = payload(await call("rks_guardrails_on", { projectId: PROJECT_ID, enforcementOverride: override, coAuthor: accepted }));
      expect(h.guardrailsOn.mock.calls[4]).toEqual([ROOT, { enforcementOverride: override, coAuthor: accepted }, PROJECT_ID]);
      expect(ok).toEqual(res);
      expect(ok).not.toHaveProperty("coAuthorRejected");
      expect(errSpy).not.toHaveBeenCalledWith(CO_AUTHOR_REJECTED_WARNING);

      // Falsy coAuthor ("") is not spread.
      await call("rks_guardrails_on", { projectId: PROJECT_ID, coAuthor: "" });
      expect(Object.keys(h.guardrailsOn.mock.calls[5][1])).toEqual([]);

      // A coAuthor the real trailer rejects: guardrailsOn still runs, the payload reports it.
      const rejected = "not-a-name-and-email";
      expect(coAuthorTrailer(rejected)).toBe("");
      const before = h.guardrailsOn.mock.calls.length;
      const r = payload(await call("rks_guardrails_on", { projectId: PROJECT_ID, coAuthor: rejected }));
      expect(h.guardrailsOn.mock.calls.length).toBe(before + 1);
      expect(h.guardrailsOn.mock.calls[before]).toEqual([ROOT, { coAuthor: rejected }, PROJECT_ID]);
      expect(r).toEqual({ ...res, coAuthorRejected: true, coAuthorWarning: CO_AUTHOR_REJECTED_WARNING });
      expect(errSpy).toHaveBeenCalledWith(CO_AUTHOR_REJECTED_WARNING);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("GV-TR6 rks_guardrails_abort discardPreExisting coercion", async () => {
    const { call } = govRegistry();
    h.guardrailsAbort.mockResolvedValue({ ok: true, s9b: "abort" });
    expect(payload(await call("rks_guardrails_abort", { projectId: PROJECT_ID }))).toEqual({ ok: true, s9b: "abort" });
    expect(h.guardrailsAbort).toHaveBeenCalledTimes(1);
    expect(h.guardrailsAbort.mock.calls[0]).toEqual([ROOT, { discardPreExisting: false }, PROJECT_ID]);
    expect(Object.keys(h.guardrailsAbort.mock.calls[0][1])).toEqual(["discardPreExisting"]);
    await call("rks_guardrails_abort", { projectId: PROJECT_ID, discardPreExisting: true });
    expect(h.guardrailsAbort.mock.calls[1]).toEqual([ROOT, { discardPreExisting: true }, PROJECT_ID]);
    await call("rks_guardrails_abort", { projectId: PROJECT_ID, discardPreExisting: "true" });
    expect(h.guardrailsAbort.mock.calls[2]).toEqual([ROOT, { discardPreExisting: false }, PROJECT_ID]);
  });

  it("GV-TR7 rks_guardrails_status limit default", async () => {
    const { call } = govRegistry();
    const history = { sessions: [{ id: "s9b" }] };
    h.getSessionHistory.mockReturnValue(history);
    expect(payload(await call("rks_guardrails_status", { projectId: PROJECT_ID }))).toEqual(history);
    expect(h.getSessionHistory.mock.calls).toEqual([[ROOT, 10]]);
    await call("rks_guardrails_status", { projectId: PROJECT_ID, limit: 4 });
    expect(h.getSessionHistory.mock.calls[1]).toEqual([ROOT, 4]);
    expect(h.getSessionHistory).toHaveBeenCalledTimes(2);
  });

  it("GV-TR8 rks_phase_repair commit gating on the integration branch", async () => {
    const { call } = govRegistry();
    const storyId = "backlog.feat.s9b-repair";
    const args = { projectId: PROJECT_ID, storyId };
    const ctx = { record: { id: PROJECT_ID, root: ROOT, s9b: "record" }, projectJson: { s9b: "json" } };
    h.loadContext.mockResolvedValue(ctx);
    h.getBranchConfig.mockReturnValue({ integration: "s9b-integration" });

    // repaired false, absent, or the string "true": no git call, no note key.
    for (const res of [{ repaired: false }, { ok: false }, { repaired: "true" }]) {
      h.repairPhaseToIntegrated.mockResolvedValueOnce({ ...res });
      const p = payload(await call("rks_phase_repair", args));
      expect(p).not.toHaveProperty("note");
      expect(p).toEqual(res);
    }
    expect(h.spawnSync).not.toHaveBeenCalled();
    expect(h.commitAndPushNote).not.toHaveBeenCalled();
    expect(h.getBranchConfig.mock.calls[0]).toEqual([ctx.record, ctx.projectJson]);
    expect(h.repairPhaseToIntegrated).toHaveBeenCalledTimes(3);
    expect(h.repairPhaseToIntegrated.mock.calls[0]).toEqual([ROOT, storyId, PROJECT_ID, { integrationBranch: "s9b-integration" }]);

    // repaired true on the integration branch: commit through commitAndPushNote.
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: true });
    h.spawnSync.mockReturnValueOnce({ status: 0, stdout: "s9b-integration\n" });
    const committed = { ok: true, commitId: "abc1234", pushed: true };
    h.commitAndPushNote.mockReturnValueOnce(committed);
    const on = payload(await call("rks_phase_repair", args));
    expect(h.spawnSync).toHaveBeenCalledTimes(1);
    expect(h.spawnSync.mock.calls[0]).toEqual(["git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8", timeout: 15000 }]);
    expect(h.commitAndPushNote).toHaveBeenCalledTimes(1);
    expect(h.commitAndPushNote.mock.calls[0]).toEqual([
      ROOT,
      path.join(resolveNotesDir(ROOT), `${storyId}.md`),
      "s9b-integration",
      COMMIT_SUBJECT_AT_BASE(storyId),
    ]);
    expect(on.note).toEqual(committed);

    // repaired true on another branch: skip object, no commit.
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: true });
    h.spawnSync.mockReturnValueOnce({ status: 0, stdout: "feature/s9b\n" });
    const off = payload(await call("rks_phase_repair", args));
    expect(h.commitAndPushNote).toHaveBeenCalledTimes(1);
    expect(off.note).toEqual(SKIP_NOTE_AT_BASE("feature/s9b", "s9b-integration"));
    expect(Object.keys(off.note)).toEqual(SKIP_NOTE_KEYS_AT_BASE);

    // repaired true and a failed branch probe: currentBranch is "", no commit.
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: true });
    h.spawnSync.mockReturnValueOnce({ status: 128, stdout: "s9b-integration\n" });
    const failedProbe = payload(await call("rks_phase_repair", args));
    expect(h.commitAndPushNote).toHaveBeenCalledTimes(1);
    expect(failedProbe.note).toEqual(SKIP_NOTE_AT_BASE("", "s9b-integration"));
    expect(Object.keys(failedProbe.note)).toEqual(SKIP_NOTE_KEYS_AT_BASE);
  });

  it("GV-TR9 rks_arch_verdict refusals and write failures", async () => {
    const { call, helpers } = govRegistry();

    // Missing note.
    const missing = await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: "backlog.feat.s9b-missing", findings: [] }).catch((e) => e);
    expect(missing).toBeInstanceOf(McpError);
    expect(missing.code).toBe(ErrorCode.InvalidParams);
    expect(missing.message).toContain("Note not found");
    expect(helpers.getDendronContext).toHaveBeenCalled();
    expect(helpers.assertNotesDir).toHaveBeenCalledWith(tmpNotes);

    // Non-finite and non-scalar arch_round: refused, note bytes unchanged.
    for (const [extra, value] of [["arch_round: \"abc\"\n", "abc"], ["arch_round:\n  - x\n  - y\n", ["x", "y"]]]) {
      const { id, p } = writeNote({ extra });
      const bytes = fs.readFileSync(p);
      const r = payload(await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [] }));
      expect(r).toEqual({ ok: false, error: "invalid_arch_round", field: "arch_round", value, storyId: id, detail: INVALID_ARCH_ROUND_DETAIL_AT_BASE });
      expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    }
    expect(h.writeNoteRaw).not.toHaveBeenCalled();

    // write_failed.
    {
      const { id, p } = writeNote();
      const bytes = fs.readFileSync(p);
      h.writeNoteRaw.mockImplementationOnce(() => { throw new Error("s9b-boom"); });
      const r = payload(await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [] }));
      expect(r).toStrictEqual({ ok: false, error: "write_failed", detail: "s9b-boom", storyId: id });
      expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    }

    // read_back_mismatch: the write lands nothing.
    {
      const { id } = writeNote();
      h.writeNoteRaw.mockImplementationOnce(() => {});
      const r = payload(await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [] }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe("read_back_mismatch");
      expect(r.mismatches).toContain("arch_round");
      expect(r.storyId).toBe(id);
    }
    expect(helpers.commitDendronWriteResult).not.toHaveBeenCalled();
  });

  it("GV-TR10 rks_arch_verdict approved, gate, retraction and draft paths", async () => {
    // Approved, no findings, gate clean.
    {
      const { call, helpers } = govRegistry();
      const { id, p } = writeNote({ phase: "ready" });
      const res = await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [] });
      const fm = fmOf(p);
      expect(fm.arch_verdict).toBe("approved");
      expect(fm.phase).toBe("arch-approved");
      expect(h.findGate).toHaveBeenCalledTimes(1);
      expect(helpers.commitDendronWriteResult).toHaveBeenCalledTimes(1);
      const arg = helpers.commitDendronWriteResult.mock.calls[0][0];
      expect(arg.tool).toBe("rks_arch_verdict");
      expect(arg.skipCommit).toBe(false);
      expect(arg.innerResult.ok).toBe(true);
      expect(arg.innerResult.path).toBe(path.relative(tmpNotes, p));
      expect(arg.innerResult.maxRounds).toBe(ARCH_MAX_ROUNDS);
      expect(arg.innerResult.gateIssues).toEqual([]);
      expect(arg.innerResult.verdict).toBe("approved");
      expect(payload(res)).toEqual(JSON.parse(JSON.stringify(await helpers.commitDendronWriteResult.mock.results[0].value)));
    }

    // skipCommit true is forwarded.
    {
      const { call, helpers } = govRegistry();
      const { id } = writeNote({ phase: "ready" });
      await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [], skipCommit: true });
      expect(helpers.commitDendronWriteResult.mock.calls[0][0].skipCommit).toBe(true);
    }

    // Gate issue with an extra key: needs-revision, projected keys only.
    {
      const { call, helpers } = govRegistry();
      const { id, p } = writeNote({ phase: "ready" });
      h.findGate.mockReturnValueOnce([{ check: "create_target_no_authorable_block", file: "s9b/x.mjs", suggestion: "s9b fix", extra: "dropped" }]);
      await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [] });
      const fm = fmOf(p);
      expect(fm.arch_verdict).toBe("needs-revision");
      expect(fm.phase).not.toBe("arch-approved");
      const inner = helpers.commitDendronWriteResult.mock.calls[0][0].innerResult;
      expect(inner.findingsCount).toBe(1);
      expect(inner.gateIssues).toHaveLength(1);
      for (const issue of inner.gateIssues) expect(Object.keys(issue)).toEqual(["check", "file", "suggestion"]);
      expect(inner.gateIssues[0]).toEqual({ check: "create_target_no_authorable_block", file: "s9b/x.mjs", suggestion: "s9b fix" });
    }

    // Retraction: arch-approved with one round-1 finding goes back to ready.
    {
      const { call } = govRegistry();
      const { id, p } = writeNote({ phase: "arch-approved" });
      await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [{ item: 1, file: "s9b/a.mjs" }] });
      const fm = fmOf(p);
      expect(fm.arch_verdict).toBe("needs-revision");
      expect(fm.phase).toBe("ready");
    }

    // Draft keeps its phase under a needs-revision verdict.
    {
      const { call } = govRegistry();
      const { id, p } = writeNote({ phase: "draft" });
      await call("rks_arch_verdict", { projectId: PROJECT_ID, storyId: id, findings: [{ item: 1, file: "s9b/a.mjs" }] });
      const fm = fmOf(p);
      expect(fm.arch_verdict).toBe("needs-revision");
      expect(fm.phase).toBe("draft");
    }
  });

  it("GV-TR11 rks_governor_init call order and reconcile fields", async () => {
    const { call, helpers } = govRegistry();
    const orphan = { restored: false, reason: "s9b no hooks.bak", provenance: null };
    h.detectOrphanedGuardrails.mockReturnValue(orphan);
    const initResult = { ok: true, token: "s9b-tok", flowType: "open", mode: "new", message: "Governor session initialized (open flow)" };
    h.handleGovernorInit.mockReturnValue(initResult);
    const args = { projectId: PROJECT_ID };
    const p = payload(await call("rks_governor_init", args));

    expect(h.setProjectRoot.mock.calls).toEqual([[ROOT]]);
    expect(h.detectOrphanedGuardrails.mock.calls).toEqual([[{ outcome: true, projectId: PROJECT_ID, caller: "rks_governor_init" }]]);
    expect(h.handleGovernorInit).toHaveBeenCalledTimes(1);
    expect(h.handleGovernorInit.mock.calls[0][0]).toEqual(args);
    expect(helpers.reconcileActiveScopeOnInit).toHaveBeenCalledTimes(1);
    const recArg = helpers.reconcileActiveScopeOnInit.mock.calls[0][0];
    expect(recArg.projectRoot).toBe(ROOT);
    expect(recArg.initResult).toBe(h.handleGovernorInit.mock.results[0].value);

    const order = [
      h.setProjectRoot.mock.invocationCallOrder[0],
      h.detectOrphanedGuardrails.mock.invocationCallOrder[0],
      h.handleGovernorInit.mock.invocationCallOrder[0],
      helpers.reconcileActiveScopeOnInit.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(p.scopeFileRemoved).toBe(false);
    expect(p.scopeFileReconcile).toStrictEqual({ removed: false, reason: "s9b-reason" });
    expect(Object.keys(p.scopeFileReconcile)).toEqual(["removed", "reason"]);
    expect(p.orphanGuardrails).toEqual(orphan);
    expect(p.token).toBe("s9b-tok");
  });

  it("GV-TR12 rks_governor_init branch handling", async () => {
    const PID = "backlog.feat.s9b-branch";
    const fresh = () => ({ ok: true, token: "s9b-tok", flowType: "story", mode: "new", message: "Governor session initialized (story flow)" });
    h.detectOrphanedGuardrails.mockReturnValue({ restored: false, reason: "s9b", provenance: null });
    h.handleGovernorInit.mockImplementation(() => fresh());

    // Without problemId: no branch work.
    {
      const { call } = govRegistry();
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID }));
      expect(h.getCurrentBranch).not.toHaveBeenCalled();
      expect(h.runGitCheckout).not.toHaveBeenCalled();
      for (const k of ["branch", "baseBranch", "branchCorrected"]) expect(p).not.toHaveProperty(k);
    }

    // With problemId, off the default base (staging): checkout ok.
    {
      const { call } = govRegistry();
      h.getCurrentBranch.mockReturnValue("feature/s9b");
      h.runGitCheckout.mockResolvedValueOnce({ ok: true });
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID }));
      expect(h.getCurrentBranch.mock.calls).toEqual([[ROOT, { throwOnError: false }]]);
      expect(h.runGitCheckout.mock.calls).toEqual([[{ projectRoot: ROOT, branch: "staging" }]]);
      expect(p.branchCorrected).toEqual({ from: "feature/s9b", to: "staging" });
      expect(p.branch).toBe("staging");
      expect(p.baseBranch).toBe("staging");
      expect(p.message.endsWith(AUTO_CHECKOUT_SUFFIX_AT_BASE("feature/s9b", "staging"))).toBe(true);
      expect(p.message).toBe(fresh().message + AUTO_CHECKOUT_SUFFIX_AT_BASE("feature/s9b", "staging"));
    }

    // Declared baseBranch is used when present.
    {
      const { call } = govRegistry();
      h.loadContext.mockImplementation(async (projectId) => ({ record: { id: projectId, root: ROOT }, projectJson: { baseBranch: "s9b-develop" } }));
      h.getCurrentBranch.mockReturnValue("staging");
      h.runGitCheckout.mockClear();
      h.runGitCheckout.mockResolvedValueOnce({ ok: true });
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID }));
      expect(h.runGitCheckout.mock.calls).toEqual([[{ projectRoot: ROOT, branch: "s9b-develop" }]]);
      expect(p.branchCorrected).toEqual({ from: "staging", to: "s9b-develop" });
      expect(p.branch).toBe("s9b-develop");
      expect(p.baseBranch).toBe("s9b-develop");
      h.loadContext.mockImplementation(async (projectId) => ({ record: { id: projectId, root: ROOT }, projectJson: {} }));
    }

    // Checkout ok false, and checkout throws: no correction, branch stays current.
    for (const outcome of ["notOk", "throws"]) {
      const { call } = govRegistry();
      h.getCurrentBranch.mockReturnValue("feature/s9b");
      h.runGitCheckout.mockClear();
      if (outcome === "notOk") h.runGitCheckout.mockResolvedValueOnce({ ok: false, error: "s9b" });
      else h.runGitCheckout.mockRejectedValueOnce(new Error("s9b checkout boom"));
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID }));
      expect(h.runGitCheckout, outcome).toHaveBeenCalledTimes(1);
      expect(p, outcome).not.toHaveProperty("branchCorrected");
      expect(p.branch, outcome).toBe("feature/s9b");
      expect(p.baseBranch, outcome).toBe("staging");
      expect(p.message, outcome).toBe(fresh().message);
    }

    // On the base branch, or an rks/ branch: no checkout.
    for (const current of ["staging", "rks/s9b-build"]) {
      const { call } = govRegistry();
      h.getCurrentBranch.mockReturnValue(current);
      h.runGitCheckout.mockClear();
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID }));
      expect(h.runGitCheckout, current).not.toHaveBeenCalled();
      expect(p, current).not.toHaveProperty("branchCorrected");
      expect(p.branch, current).toBe(current);
      expect(p.baseBranch, current).toBe("staging");
    }

    // handleGovernorInit ok false: no branch or baseBranch key.
    {
      const { call } = govRegistry();
      h.getCurrentBranch.mockClear();
      h.runGitCheckout.mockClear();
      h.handleGovernorInit.mockImplementationOnce(() => ({ ok: false, reason: "stale_reset_blocked", message: "s9b blocked" }));
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID }));
      expect(p.ok).toBe(false);
      for (const k of ["branch", "baseBranch", "branchCorrected"]) expect(p).not.toHaveProperty(k);
      expect(h.getCurrentBranch).not.toHaveBeenCalled();
      expect(h.runGitCheckout).not.toHaveBeenCalled();
    }
  });

  it("GV-TR13 rks_governor_init telemetry emits", async () => {
    const PID = "backlog.feat.s9b-telemetry";
    h.detectOrphanedGuardrails.mockReturnValue({ restored: false, reason: "s9b", provenance: null });
    const eventsOf = (name) => h.emit.mock.calls.filter((c) => c[0] === name);

    // Successful auto-checkout: branch.corrected once, then session.created once.
    {
      const { call } = govRegistry();
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "t1", flowType: "story", message: "Governor session initialized (story flow)" });
      h.getCurrentBranch.mockReturnValue("feature/s9b");
      h.runGitCheckout.mockResolvedValueOnce({ ok: true });
      await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID });
      const corrected = eventsOf("governor.branch.corrected");
      expect(corrected).toHaveLength(1);
      expect(corrected[0][1]).toBe(PROJECT_ID);
      expect(corrected[0][2]).toStrictEqual({ from: "feature/s9b", to: "staging", problemId: PID });
      const created = eventsOf("governor.session.created");
      expect(created).toHaveLength(1);
      expect(created[0][1]).toBe(PROJECT_ID);
      expect(created[0][2]).toStrictEqual({ flowType: "story", problemId: PID });
      expect(h.emit).toHaveBeenCalledTimes(2);
    }

    // No problemId: session.created with problemId null, never branch.corrected.
    {
      h.emit.mockClear();
      const { call } = govRegistry();
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "t2", flowType: "open", message: "Governor session initialized (open flow)" });
      await call("rks_governor_init", { projectId: PROJECT_ID });
      expect(eventsOf("governor.branch.corrected")).toHaveLength(0);
      const created = eventsOf("governor.session.created");
      expect(created).toHaveLength(1);
      expect(created[0][2]).toStrictEqual({ flowType: "open", problemId: null });
    }

    // Failed checkout: no branch.corrected.
    {
      h.emit.mockClear();
      const { call } = govRegistry();
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "t3", flowType: "story", message: "Governor session initialized (story flow)" });
      h.getCurrentBranch.mockReturnValue("feature/s9b");
      h.runGitCheckout.mockResolvedValueOnce({ ok: false });
      await call("rks_governor_init", { projectId: PROJECT_ID, problemId: PID });
      expect(eventsOf("governor.branch.corrected")).toHaveLength(0);
      expect(eventsOf("governor.session.created")).toHaveLength(1);
    }

    // Resumed (message without "initialized"), and ok false: no session.created.
    for (const result of [
      { ok: true, token: "t4", flowType: "open", mode: "resumed", message: "Governor session resumed at 'init'" },
      { ok: false, reason: "s9b", message: "Governor session initialized but refused" },
    ]) {
      h.emit.mockClear();
      const { call } = govRegistry();
      h.handleGovernorInit.mockReturnValueOnce(result);
      await call("rks_governor_init", { projectId: PROJECT_ID });
      expect(h.emit).not.toHaveBeenCalled();
    }

    // An emit that throws on session.created still returns the payload.
    {
      h.emit.mockReset();
      h.emit.mockImplementation((name) => { if (name === "governor.session.created") throw new Error("s9b telemetry boom"); });
      const { call } = govRegistry();
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "t5", flowType: "open", message: "Governor session initialized (open flow)" });
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID }));
      expect(p.ok).toBe(true);
      expect(p.token).toBe("t5");
      expect(eventsOf("governor.session.created")).toHaveLength(1);
    }
  });

  it("GV-TR14 static imports resolve to server.mjs's files and real exports", async () => {
    const realCollector = await vi.importActual("@routekit/telemetry/collector");
    expect(typeof realCollector.getTelemetryCollector).toBe("function");

    const src = fs.readFileSync(GOV_ABS, "utf8");
    const serverSrc = fs.readFileSync(SERVER_ABS, "utf8");
    const keyOf = (spec, fromAbs) => (isRelative(spec) ? path.resolve(path.dirname(fromAbs), spec) : spec);
    const serverNames = new Map();
    for (const b of importBindings(serverSrc)) {
      const key = keyOf(b.spec, SERVER_ABS);
      serverNames.set(key, [...(serverNames.get(key) || []), ...b.names.map((n) => `${n.imported} as ${n.local}`)]);
    }
    const own = importBindings(src);
    expect(own.length).toBe(importSpecifiers(src).length);
    const bound = own.flatMap((b) => b.names.map((n) => n.local)).sort();
    expect(bound).toEqual([
      "ARCH_MAX_ROUNDS", "ARCH_VERDICT_TOOL", "CO_AUTHOR_REJECTED_WARNING", "ErrorCode", "GOVERNOR_INIT_TOOL", "McpError",
      "canonicalIdFromFilename", "coAuthorTrailer", "commitAndPushNote", "computeArchVerdict", "detectOrphanedGuardrails",
      "findCreateTargetNoAuthorableBlockIssues", "formatWithFrontmatter", "fs", "getBranchConfig", "getCurrentBranch",
      "getSessionHistory", "getTelemetryCollector", "guardrailsAbort", "guardrailsOff", "guardrailsOn", "handleGovernorInit",
      "loadContext", "noteLegacySubjectDigest", "noteSubjectDigest", "parseFrontmatter", "path", "readNoteRaw",
      "repairPhaseToIntegrated", "resolveNotesDir", "runGitCheckout", "setProjectRoot", "spawnSync", "spliceNoteFrontmatter",
      "splitNoteFrontmatter", "writeNoteRaw",
    ]);
    for (const b of own) {
      const key = keyOf(b.spec, GOV_ABS);
      if (isRelative(b.spec)) expect(fs.existsSync(key), b.spec).toBe(true);
      expect(serverNames.has(key), `server.mjs statically imports ${b.spec}`).toBe(true);
      for (const n of b.names) expect(serverNames.get(key), `${b.spec} ${n.imported} as ${n.local}`).toContain(`${n.imported} as ${n.local}`);
      const real = await vi.importActual(key);
      for (const n of b.names) expect(real[n.imported], `${b.spec} exports ${n.imported}`).toBeDefined();
    }
    // getTelemetryCollector comes from the collector subpath, never from the telemetry barrel.
    const collectorBinding = own.find((b) => b.names.some((n) => n.local === "getTelemetryCollector"));
    expect(collectorBinding.spec).toBe(["@routekit", "telemetry", "collector"].join("/"));
    expect(own.filter((b) => b.spec === ["@routekit", "telemetry"].join("/"))).toEqual([]);
  });

  it("GV-TR15 governance.mjs shape", () => {
    const src = fs.readFileSync(GOV_ABS, "utf8");
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src).not.toMatch(/import\(\s*["'][^"']*server\.mjs["']/);
    expect(src).not.toContain("await import(");
    expect(src.match(/\bfunction\s+[\w$]+\s*\(/g)).toEqual(["function registerGovernanceHandlers("]);
    for (const name of ["getDendronContext", "assertNotesDir", "notePathFromFilename", "commitDendronWriteResult", "reconcileActiveScopeOnInit"]) {
      expect(src, name).not.toMatch(new RegExp(`function\\s+${name}\\b`));
      expect(src, name).not.toMatch(new RegExp(`(?:const|let|var)\\s+${name}\\s*=`));
    }
    // Over code only: the module docblock's prose ("No body reads ctx.") is not a property access.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("registerHandler(");
    expect(code).not.toMatch(/\bctx\s*\??\.\s*[A-Za-z_$]/);
    expect(code).not.toMatch(/\bctx\s*\[/);
    for (const call of ["advanceStateOnResult(", "revertStateOnFailure(", "setChildQueue("]) expect(src).not.toContain(call);
    // The first argument of every registerHandler( call, verbatim and in server.mjs head order.
    const registrations = [...src.matchAll(/registerHandler\(\s*([^,\s)]+)/g)].map((m) => m[1]);
    expect(registrations).toEqual([
      '"rks_guardrails_off"', '"rks_guardrails_on"', '"rks_guardrails_abort"', '"rks_guardrails_status"', '"rks_phase_repair"',
      "ARCH_VERDICT_TOOL", "GOVERNOR_INIT_TOOL",
    ]);
    // The two moved section comments sit on the lines directly above the identifier registrations.
    const lines = src.split("\n");
    const archAt = lines.findIndex((l) => l.startsWith("  registerHandler(ARCH_VERDICT_TOOL,"));
    const govAt = lines.findIndex((l) => l.startsWith("  registerHandler(GOVERNOR_INIT_TOOL,"));
    expect(archAt).toBeGreaterThan(0);
    expect(govAt).toBeGreaterThan(0);
    expect(lines[archAt - 1]).toBe("  // --- ARCH verdict (computed, never asserted) ---");
    expect(lines[govAt - 1]).toBe("  // --- Governor session tools ---");
  });

  it("GV-TR16 unit-tier purity of this file", () => {
    const src = fs.readFileSync(SELF_ABS, "utf8");
    // Same spawn-family grammar as tests/unit/unit-tier-purity.test.mjs (Rule A), over code with
    // line comments and string literals removed.
    const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|exec|fork)\s*\(/;
    const code = src
      .split("\n")
      .map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, '""'))
      .map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    expect(code.filter((l) => SPAWN_FAMILY_RE.test(l))).toEqual([]);
    expect(src).not.toContain("vi." + "resetModules");
    expect(importSpecifiers(src).filter((s) => /server\.mjs$/.test(s))).toEqual([]);
    expect(src).not.toMatch(/import\(\s*["'][^"']*\/server\.mjs["']/);
    // The literal collector escape (telemetry-global-mock-triage ESCAPE_CTX).
    expect(src).toContain("vi.importActual(" + JSON.stringify(["@routekit", "telemetry", "collector"].join("/")) + ")");
  });
});
