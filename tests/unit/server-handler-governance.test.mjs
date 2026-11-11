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
    // backlog.feat.keyless-backend-aware-credential-presence: a non-spawning fake, so rks_governor_init in
    // this suite never probes the claude CLI and never writes a status file.
    resolveInitCredential: vi.fn(),
    // backlog.feat.project-lease-actor-attribution: the guardrails handlers' lease operations. Mocked so
    // GV-TR4/5/6 touch no real lease store; beforeEach makes them report store "disk" by default.
    convertToOffRail: vi.fn(), revertOffRail: vi.fn(), releaseOffRail: vi.fn(),
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
vi.mock("../../packages/mcp-rks/src/llm/claude-cli/subscription-status.mjs", async (io) => ({ ...(await io()), resolveInitCredential: h.resolveInitCredential }));
vi.mock("@routekit/telemetry/collector", async (io) => ({ ...(await io()), getTelemetryCollector: () => ({ emit: h.emit }) }));
vi.mock("../../packages/mcp-rks/src/shared/project-lease.mjs", async (io) => ({ ...(await io()), convertToOffRail: h.convertToOffRail, revertOffRail: h.revertOffRail, releaseOffRail: h.releaseOffRail }));

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

const GOVERNANCE_TOOLS = ["rks_arch_verdict", "rks_governor_end", "rks_governor_init", "rks_guardrails_abort", "rks_guardrails_off", "rks_guardrails_on", "rks_guardrails_status", "rks_phase_repair"];
const SCHEMA_KEY = {
  rks_guardrails_off: "guardrailsOffSchema", rks_guardrails_on: "guardrailsOnSchema", rks_guardrails_abort: "guardrailsAbortSchema",
  rks_guardrails_status: "guardrailsStatusSchema", rks_phase_repair: "phaseRepairSchema", rks_arch_verdict: "archVerdictSchema", rks_governor_init: "governorInitSchema",
  // backlog.feat.governor-session-end
  rks_governor_end: "governorEndSchema",
};

// The other eight S0 families (tests/unit/server-handler-agent-bootstrap.test.mjs AB-TR2).
const TELEMETRY_TOOLS = ["rks_telemetry_analysis", "rks_telemetry_digest", "rks_telemetry_export", "rks_telemetry_query", "rks_telemetry_report", "rks_token_cost_report"];
const PROJECT_META_TOOLS = ["rks_channel_preview", "rks_git_state", "rks_kg_query", "rks_project_get", "rks_publish", "rks_publish_profiles", "rks_templates_list"];
// backlog.feat.dendron-rename-note-wikilinks: + dendron_rename_note.
const DENDRON_TOOLS = ["dendron_create_note", "dendron_edit_note", "dendron_fix_frontmatter", "dendron_mark_implemented", "dendron_read_note", "dendron_rename_note", "dendron_update_field", "dendron_update_fields", "dendron_validate_schema"];
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
  h.resolveInitCredential.mockResolvedValue({ credential: "none", capabilities: { research: { blocked: "no_credential" } } });
  h.convertToOffRail.mockReturnValue({ ok: true, holderKey: "offrail:s9b", converted: false, created: true, store: "disk" });
  h.revertOffRail.mockReturnValue({ reverted: true, holderKey: "offrail:s9b", store: "disk" });
  h.releaseOffRail.mockReturnValue({ released: true, holderKey: "offrail:s9b", store: "disk" });
});
afterAll(() => fs.rmSync(tmpNotes, { recursive: true, force: true }));

describe("S9b governance handlers (unit)", () => {
  it("GV-TR1 registers exactly the eight governance tools under their TOOL_NAME values", () => {
    const { r } = govRegistry();
    expect(GOVERNANCE_TOOLS).toHaveLength(8);
    expect(r.registeredTools()).toEqual([...GOVERNANCE_TOOLS].sort());
    expect(r.registeredTools()).not.toContain("ARCH_VERDICT_TOOL");
    expect(r.registeredTools()).not.toContain("GOVERNOR_INIT_TOOL");
    expect(r.registeredTools()).not.toContain("GOVERNOR_END_TOOL");
    for (const tool of GOVERNANCE_TOOLS) expect(typeof r.lookupHandler(tool), tool).toBe("function");
  });

  it("GV-TR2 coexists with the other eight families at 81 tools", () => {
    const r = createHandlerRegistry();
    const pid = z.object({ projectId: z.string() });
    const any = z.object({});
    expect(() => {
      registerTelemetryHandlers(r, { telemetryQuerySchema: pid, telemetryReportSchema: pid, telemetryAnalysisSchema: pid, tokenCostReportSchema: pid, telemetryExportSchema: pid });
      registerProjectMetaHandlers(r, { projectGetSchema: z.object({ id: z.string() }), kgQuerySchema: pid, templatesListSchema: any, gitStateSchema: pid, publishSchema: pid, publishProfilesSchema: pid });
      registerDendronHandlers(
        r,
        { createNoteSchema: any, fixFrontmatterSchema: any, validateSchemaSchema: any, editNoteSchema: any, updateFieldSchema: any, updateFieldsSchema: any, markImplementedSchema: any },
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
    expect(new Set(all).size).toBe(81);
    expect(r.registeredTools()).toEqual([...all].sort());
    expect(r.registeredTools()).toHaveLength(81);
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
    expect(Object.keys(SCHEMA_KEY)).toHaveLength(8);
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
    // backlog.feat.project-lease-actor-attribution: the off-rail lease is taken BEFORE guardrailsOff.
    expect(h.convertToOffRail).toHaveBeenCalledTimes(1);
    expect(h.convertToOffRail.mock.invocationCallOrder[0]).toBeLessThan(h.guardrailsOff.mock.invocationCallOrder[0]);
    expect(h.convertToOffRail.mock.calls[0][0]).toMatchObject({ projectId: PROJECT_ID, token: null, problemId: "backlog.feat.s9b" });
    expect(h.revertOffRail).not.toHaveBeenCalled();

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
      expect(payload(await call("rks_guardrails_on", { projectId: PROJECT_ID, detail: "full" }))).toEqual(res);
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

    // repaired true on the integration branch: commit through commitAndPushNote. A repair that
    // reached integrated archives first (backlog.fix.offrail-ship-and-phase-repair-skip-archive)
    // and passes BOTH the live and the z_implemented path. ROOT holds no note, so the real
    // archiveShippedStory reports an error without throwing and without a git call.
    h.repairPhaseToIntegrated.mockResolvedValueOnce({ repaired: true, to: "integrated" });
    h.spawnSync.mockReturnValueOnce({ status: 0, stdout: "s9b-integration\n" });
    const committed = { ok: true, commitId: "abc1234", pushed: true };
    h.commitAndPushNote.mockReturnValueOnce(committed);
    const on = payload(await call("rks_phase_repair", args));
    expect(h.spawnSync).toHaveBeenCalledTimes(1);
    expect(h.spawnSync.mock.calls[0]).toEqual(["git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8", timeout: 15000 }]);
    expect(h.commitAndPushNote).toHaveBeenCalledTimes(1);
    expect(h.commitAndPushNote.mock.calls[0]).toEqual([
      ROOT,
      [
        path.join(resolveNotesDir(ROOT), `${storyId}.md`),
        path.join(resolveNotesDir(ROOT), `${storyId.replace(/^backlog\./, "backlog.z_implemented.")}.md`),
      ],
      "s9b-integration",
      COMMIT_SUBJECT_AT_BASE(storyId),
    ]);
    expect(on.note).toEqual(committed);
    expect(on.archive.archived).toBe(false);
    expect(typeof on.archive.error).toBe("string");

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
    // backlog.feat.project-lease-actor-attribution §6: the handler passes ctx.clientName (null when absent).
    expect(h.handleGovernorInit.mock.calls[0]).toEqual([args, { clientName: null }]);
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

    // Credential state and per-flow capabilities ride beside orphanGuardrails, from ONE call.
    expect(h.resolveInitCredential).toHaveBeenCalledTimes(1);
    expect(h.resolveInitCredential.mock.calls[0][0]).toEqual({ projectRoot: ROOT });
    expect(p.credential).toBe("none");
    expect(p.capabilities).toEqual({ research: { blocked: "no_credential" } });
    expect(h.resolveInitCredential.mock.invocationCallOrder[0]).toBeGreaterThan(helpers.reconcileActiveScopeOnInit.mock.invocationCallOrder[0]);
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

  // backlog.fix.remote-lane-init-capabilities-overstate-admission (RLC). Fixtures shaped like
  // resolveInitCredential's three credential states; the handler is called directly, so the server's
  // remote-lane tool gate is not in the path.
  const RLC_FLOWS = ["research", "po", "qa", "arch", "build-offrail", "build-onrail", "ship", "release", "external-research"];
  const RLC_STATES = {
    api: { credential: "api", capabilities: Object.fromEntries(RLC_FLOWS.map((f) => [f, "admitted"])) },
    subscription: {
      credential: "subscription",
      capabilities: { ...Object.fromEntries(RLC_FLOWS.map((f) => [f, "admitted"])), "build-onrail": { blocked: "llm-planner" }, "external-research": { blocked: "external-research" } },
    },
    none: { credential: "none", capabilities: Object.fromEntries(RLC_FLOWS.map((f) => [f, { blocked: "no_credential" }])) },
  };
  const NON_REMOTE_LANES = ["ide", "dispatch", "call", "mcp"];
  const rlcInit = async (state, args = {}) => {
    const { call } = govRegistry();
    h.resolveInitCredential.mockReset();
    h.resolveInitCredential.mockResolvedValue(structuredClone(RLC_STATES[state]));
    h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: `rlc-${state}`, flowType: "open", message: "Governor session initialized (open flow)" });
    return payload(await call("rks_governor_init", { projectId: PROJECT_ID, ...args }));
  };

  it("RLC-AC1 remote lane reports every flow blocked remote_lane for every credential state", async () => {
    try {
      vi.stubEnv("RKS_VIA", "remote");
      for (const state of ["api", "subscription", "none"]) {
        const p = await rlcInit(state);
        const values = Object.values(p.capabilities);
        expect(values.length, state).toBe(RLC_FLOWS.length);
        expect(values.every((v) => JSON.stringify(v) === JSON.stringify({ blocked: "remote_lane" })), state).toBe(true);
        expect(p.capabilities.research, state).toEqual({ blocked: "remote_lane" });
        expect(p.capabilities.ship, state).toEqual({ blocked: "remote_lane" });
        expect(p.capabilities, state).not.toEqual(RLC_STATES[state].capabilities);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RLC-AC1 remote lane keeps the flow keys resolveInitCredential returned", async () => {
    try {
      vi.stubEnv("RKS_VIA", "remote");
      for (const state of ["api", "subscription", "none"]) {
        const p = await rlcInit(state);
        expect(Object.keys(p.capabilities).sort(), state).toEqual(Object.keys(RLC_STATES[state].capabilities).sort());
      }
      // A map with a different key set: the result follows the mock's keys, not a fixed list.
      const { call } = govRegistry();
      h.resolveInitCredential.mockReset();
      h.resolveInitCredential.mockResolvedValue({ credential: "api", capabilities: { research: "admitted", "rlc-extra-flow": "admitted" } });
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "rlc-keys", flowType: "open", message: "Governor session initialized (open flow)" });
      const p = payload(await call("rks_governor_init", { projectId: PROJECT_ID }));
      expect(p.capabilities).toEqual({ research: { blocked: "remote_lane" }, "rlc-extra-flow": { blocked: "remote_lane" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RLC-AC2 non-remote lanes report the resolveInitCredential capabilities map unchanged", async () => {
    try {
      for (const lane of NON_REMOTE_LANES) {
        vi.stubEnv("RKS_VIA", lane);
        for (const state of ["api", "subscription", "none"]) {
          const p = await rlcInit(state);
          expect(p.capabilities, `${lane}/${state}`).toEqual(RLC_STATES[state].capabilities);
        }
      }
      expect(process.env.RKS_VIA).toBe("mcp");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RLC-AC3 the lane comes from envLane, not the via argument", async () => {
    try {
      vi.stubEnv("RKS_VIA", "ide");
      const viaRemote = await rlcInit("api", { via: "remote" });
      expect(viaRemote.capabilities).toEqual(RLC_STATES.api.capabilities);
      expect(viaRemote.credential).toBe("api");
      expect(h.handleGovernorInit.mock.calls.at(-1)[0].via).toBe("remote");

      vi.stubEnv("RKS_VIA", "remote");
      const viaIde = await rlcInit("api", { via: "ide" });
      expect(Object.keys(viaIde.capabilities).sort()).toEqual([...RLC_FLOWS].sort());
      expect(Object.values(viaIde.capabilities).every((v) => JSON.stringify(v) === JSON.stringify({ blocked: "remote_lane" }))).toBe(true);
      expect(viaIde.credential).toBe("not_applicable");
      expect(h.handleGovernorInit.mock.calls.at(-1)[0].via).toBe("ide");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RLC-AC4 resolveInitCredential is still called once in the remote lane", async () => {
    try {
      vi.stubEnv("RKS_VIA", "remote");
      for (const state of ["api", "subscription", "none"]) {
        const p = await rlcInit(state);
        expect(h.resolveInitCredential, state).toHaveBeenCalledTimes(1);
        expect(h.resolveInitCredential, state).toHaveBeenCalledWith({ projectRoot: ROOT });
        expect(p, state).toHaveProperty("credential");
        expect(typeof p.credential, state).toBe("string");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("RLC-AC5 remote lane reports credential not_applicable, other lanes report the resolved credential", async () => {
    try {
      vi.stubEnv("RKS_VIA", "remote");
      for (const state of ["api", "subscription", "none"]) {
        const p = await rlcInit(state);
        expect(p.credential, `remote/${state}`).toBe("not_applicable");
      }
      for (const lane of NON_REMOTE_LANES) {
        vi.stubEnv("RKS_VIA", lane);
        for (const state of ["api", "subscription", "none"]) {
          const p = await rlcInit(state);
          expect(p.credential, `${lane}/${state}`).toBe(state);
        }
      }
      expect((await rlcInit("api")).credential).toBe("api");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("TGB-AC5 rks_governor_init reports tokenGate beside capabilities", async () => {
    // backlog.feat.token-gate-bypass-visible AC5. The handler is called directly (no server gate),
    // so clearing the bypass variables here does not refuse the call.
    const keys = ["RKS_SKIP_PREFLIGHT", "NODE_ENV", "RKS_TEST_MODE"];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const { call } = govRegistry();
    try {
      for (const k of keys) delete process.env[k];
      process.env.RKS_SKIP_PREFLIGHT = "1";
      process.env.RKS_TEST_MODE = "1";
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "tg1", flowType: "open", message: "Governor session initialized (open flow)" });
      const bypassed = payload(await call("rks_governor_init", { projectId: PROJECT_ID }));
      expect(bypassed.tokenGate).toEqual({ enforced: false, bypassVars: ["RKS_SKIP_PREFLIGHT=1", "RKS_TEST_MODE=1"] });

      for (const k of keys) delete process.env[k];
      h.handleGovernorInit.mockReturnValueOnce({ ok: true, token: "tg2", flowType: "open", message: "Governor session initialized (open flow)" });
      const enforced = payload(await call("rks_governor_init", { projectId: PROJECT_ID }));
      expect(enforced.tokenGate).toEqual({ enforced: true });
      expect(enforced.tokenGate).not.toHaveProperty("bypassVars");
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
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
    // backlog.feat.project-lease-actor-attribution: + validateToken, getSession, isSessionTerminal,
    // getSessionProjectRoot (governor-token) and the six project-lease.mjs bindings.
    expect(bound).toEqual([
      "ARCH_MAX_ROUNDS", "ARCH_VERDICT_TOOL", "CO_AUTHOR_REJECTED_WARNING", "ErrorCode", "GOVERNOR_END_TOOL", "GOVERNOR_INIT_TOOL",
      "LEASE_MAX_AGE_MS", "MEMORY_DEGRADATION", "McpError", "archiveShippedStory", "buildToolResponse", "canonicalIdFromFilename", "coAuthorTrailer",
      "commitAndPushNote", "computeArchVerdict", "convertToOffRail", "detectOrphanedGuardrails", "envLane", "findCreateTargetNoAuthorableBlockIssues",
      "formatWithFrontmatter", "fs", "getBranchConfig", "getCurrentBranch", "getSession", "getSessionHistory", "getSessionProjectRoot",
      "getTelemetryCollector", "guardrailsAbort", "guardrailsOff", "guardrailsOn", "guardrailsOnMustInline", "handleGovernorEnd",
      "handleGovernorInit", "isSessionTerminal", "loadContext", "noteLegacySubjectDigest", "notePreCarveOutSubjectDigest",
      "noteSubjectDigest", "noteV1SubjectDigest", "parseFrontmatter", "path", "readNoteRaw", "releaseOffRail", "repairPhaseToIntegrated",
      "resolveAttribution", "resolveInitCredential", "resolveNotesDir", "revertOffRail", "runGitCheckout", "setProjectRoot", "spawnSync",
      "spliceNoteFrontmatter", "splitNoteFrontmatter", "summarizeGuardrailsOnResponse", "tokenGateBypass", "validateToken", "writeNoteRaw",
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
    // Named exemptions: the rks_governor_end handler reads ctx.governorToken (backlog.feat.governor-session-end,
    // D17); backlog.feat.project-lease-actor-attribution adds ctx.governorToken in rks_guardrails_off (the
    // off-rail lease conversion) and ctx.clientName (attribution) there and in rks_governor_init. Exactly
    // these two ctx fields are admitted; every other ctx read is still refused.
    const ctxReads = code.match(/\bctx\s*\??\.\s*[A-Za-z_$][\w$]*/g);
    expect([...new Set(ctxReads)].sort()).toEqual(["ctx.clientName", "ctx.governorToken"]);
    expect(ctxReads.filter((r) => r === "ctx.governorToken")).toHaveLength(2);
    expect(ctxReads.filter((r) => r === "ctx.clientName")).toHaveLength(2);
    const codeWithoutExemption = code.replace(/\bctx\.(governorToken|clientName)\b/g, "");
    expect(codeWithoutExemption).not.toMatch(/\bctx\s*\??\.\s*[A-Za-z_$]/);
    expect(code).not.toMatch(/\bctx\s*\[/);
    for (const call of ["advanceStateOnResult(", "revertStateOnFailure(", "setChildQueue("]) expect(src).not.toContain(call);
    // The first argument of every registerHandler( call, verbatim and in server.mjs head order.
    const registrations = [...src.matchAll(/registerHandler\(\s*([^,\s)]+)/g)].map((m) => m[1]);
    expect(registrations).toEqual([
      '"rks_guardrails_off"', '"rks_guardrails_on"', '"rks_guardrails_abort"', '"rks_guardrails_status"', '"rks_phase_repair"',
      "ARCH_VERDICT_TOOL", "GOVERNOR_INIT_TOOL", "GOVERNOR_END_TOOL",
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

// backlog.feat.project-lease-actor-attribution: the guardrails handlers' lease wiring (§5, §5a, §5c) and
// the init refusal shape (AC15), with project-lease.mjs mocked. Real lease behaviour behind these
// handlers is exercised in tests/unit/project-lease.test.mjs.
describe("project lease wiring in the governance handlers (backlog.feat.project-lease-actor-attribution)", () => {
  const MEMORY = { store: "memory", degraded: "no_project_root" };
  const ctxWith = (args, extra) => Object.freeze({ tool: "s9b-ctx-tool", args, activeToken: undefined, governorToken: undefined, ...extra });
  const callWith = (tool, args, extra = {}) => govRegistry().r.lookupHandler(tool)(args, ctxWith(args, extra));
  const refusalFromLease = (store) => ({
    ok: false, reason: "project_leased", store,
    holder: { holderKey: "session:other", actor: null, via: "mcp", client: null, flowType: "story", problemId: "backlog.feat.other", runId: null, since: "2026-10-31T00:00:00.000Z", offRail: false },
    requested: { flowType: null, problemId: "backlog.feat.s9b", offRail: true },
  });

  it("AC11/AC17: a project_leased conversion refuses rks_guardrails_off as an error and never calls guardrailsOff", async () => {
    h.convertToOffRail.mockReturnValue(refusalFromLease("disk"));
    const res = await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b", problemId: "backlog.feat.s9b" }, { clientName: "s9b-client" });
    const p = payload(res);
    expect(res.isError).toBe(true);
    expect(p).toMatchObject({ ok: false, reason: "project_leased", requested: { flowType: null, offRail: true } });
    expect(p.holder.flowType).toBe("story");
    expect(p).not.toHaveProperty("lease");
    expect(h.guardrailsOff).not.toHaveBeenCalled();
    expect(h.convertToOffRail.mock.calls[0][0]).toMatchObject({ projectId: PROJECT_ID, token: null, client: "s9b-client" });
  });

  it("AC12: an ok guardrailsOn / guardrailsAbort releases the project's off-rail holder, token or not; a non-ok one leaves it held", async () => {
    h.guardrailsOn.mockResolvedValue({ ok: true, s9b: "on" });
    expect(payload(await callWith("rks_guardrails_on", { projectId: PROJECT_ID, detail: "full" }))).toEqual({ ok: true, s9b: "on" });
    expect(h.releaseOffRail.mock.calls).toEqual([[expect.objectContaining({ projectId: PROJECT_ID, reason: "guardrails_on" })]]);
    expect(h.releaseOffRail.mock.invocationCallOrder[0]).toBeGreaterThan(h.guardrailsOn.mock.invocationCallOrder[0]);
    await callWith("rks_guardrails_on", { projectId: PROJECT_ID, detail: "full" }, { governorToken: "s9b-holder-token" });
    expect(h.releaseOffRail).toHaveBeenCalledTimes(2);

    h.guardrailsAbort.mockResolvedValue({ ok: true, s9b: "abort" });
    expect(payload(await callWith("rks_guardrails_abort", { projectId: PROJECT_ID }))).toEqual({ ok: true, s9b: "abort" });
    expect(h.releaseOffRail.mock.calls[2][0]).toMatchObject({ projectId: PROJECT_ID, reason: "guardrails_abort" });

    h.releaseOffRail.mockClear();
    h.guardrailsOn.mockResolvedValue({ ok: false, error: "s9b ship failed" });
    expect(payload(await callWith("rks_guardrails_on", { projectId: PROJECT_ID, detail: "full" }))).toEqual({ ok: false, error: "s9b ship failed" });
    h.guardrailsAbort.mockResolvedValue({ ok: false, error: "s9b abort failed" });
    expect(payload(await callWith("rks_guardrails_abort", { projectId: PROJECT_ID }))).toEqual({ ok: false, error: "s9b abort failed" });
    expect(h.releaseOffRail).not.toHaveBeenCalled();

    // An ok call with no off-rail holder is a no-op release that still returns the underlying result.
    h.releaseOffRail.mockReturnValue({ released: false, holderKey: null, store: "disk" });
    h.guardrailsAbort.mockResolvedValue({ ok: true, s9b: "abort-none" });
    expect(payload(await callWith("rks_guardrails_abort", { projectId: PROJECT_ID }))).toEqual({ ok: true, s9b: "abort-none" });
  });

  it("D2: an already-off-rail conversion is restored to its prior off-rail state, never cleared, on a non-ok or throwing guardrailsOff", async () => {
    const prior = { offRail: true, offRailProblemId: "backlog.feat.p1" };
    h.convertToOffRail.mockReturnValue({ ok: true, holderKey: "session:caller", converted: true, created: false, alreadyOffRail: true, prior, store: "disk" });
    h.guardrailsOff.mockResolvedValue({ ok: false, message: "Guardrails already off (scope=all)" });
    expect(payload(await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b", problemId: "backlog.feat.p2" }))).toEqual({ ok: false, message: "Guardrails already off (scope=all)" });
    expect(h.revertOffRail.mock.calls).toEqual([[expect.objectContaining({ projectId: PROJECT_ID, holderKey: "session:caller", created: false, prior })]]);

    h.revertOffRail.mockClear();
    const boom = new Error("s9b already-off boom");
    h.guardrailsOff.mockRejectedValue(boom);
    await expect(callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b", problemId: "backlog.feat.p2" })).rejects.toBe(boom);
    expect(h.revertOffRail.mock.calls).toEqual([[expect.objectContaining({ projectId: PROJECT_ID, holderKey: "session:caller", created: false, prior })]]);

    // A first conversion (alreadyOffRail false) carries no prior, so revertOffRail clears it as before.
    h.revertOffRail.mockClear();
    h.convertToOffRail.mockReturnValue({ ok: true, holderKey: "session:caller", converted: true, created: false, alreadyOffRail: false, store: "disk" });
    h.guardrailsOff.mockResolvedValue({ ok: false, reason: "story_not_ready" });
    await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b" });
    expect(h.revertOffRail.mock.calls[0][0]).not.toHaveProperty("prior");
  });

  it("AC19: a non-ok or throwing guardrailsOff rolls the conversion back; disk-store responses are the underlying result exactly", async () => {
    h.convertToOffRail.mockReturnValue({ ok: true, holderKey: "session:caller", converted: true, created: false, store: "disk" });
    h.guardrailsOff.mockResolvedValue({ ok: false, reason: "story_not_ready" });
    expect(payload(await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b", problemId: "backlog.feat.s9b" }))).toEqual({ ok: false, reason: "story_not_ready" });
    expect(h.revertOffRail.mock.calls).toEqual([[expect.objectContaining({ projectId: PROJECT_ID, holderKey: "session:caller", created: false })]]);

    h.revertOffRail.mockClear();
    h.convertToOffRail.mockReturnValue({ ok: true, holderKey: "offrail:anon", converted: false, created: true, store: "disk" });
    const boom = new Error("s9b guardrailsOff boom");
    h.guardrailsOff.mockRejectedValue(boom);
    await expect(callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b" })).rejects.toBe(boom);
    expect(h.revertOffRail.mock.calls).toEqual([[expect.objectContaining({ holderKey: "offrail:anon", created: true })]]);

    h.revertOffRail.mockClear();
    h.guardrailsOff.mockResolvedValue({ ok: true, s9b: "off" });
    const ok = payload(await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b" }));
    expect(ok).toEqual({ ok: true, s9b: "off" });
    expect(Object.keys(ok)).toEqual(["ok", "s9b"]);
    expect(h.revertOffRail).not.toHaveBeenCalled();
  });

  it("AC22: on the memory store each guardrails response is the underlying result plus exactly one key, lease", async () => {
    const keysDiff = (p, base) => Object.keys(p).filter((k) => !(k in base));

    h.convertToOffRail.mockReturnValue({ ok: true, holderKey: "offrail:mem", converted: false, created: true, store: "memory" });
    const offRes = { ok: true, s9b: "off" };
    h.guardrailsOff.mockResolvedValue(offRes);
    const off = payload(await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b" }));
    expect(off).toEqual({ ...offRes, lease: MEMORY });
    expect(keysDiff(off, offRes)).toEqual(["lease"]);

    h.guardrailsOff.mockClear();
    h.convertToOffRail.mockReturnValue(refusalFromLease("memory"));
    const refusedRes = await callWith("rks_guardrails_off", { projectId: PROJECT_ID, reason: "s9b", problemId: "backlog.feat.s9b" });
    const refused = payload(refusedRes);
    expect(refusedRes.isError).toBe(true);
    expect(refused.lease).toEqual(MEMORY);
    expect(refused.reason).toBe("project_leased");
    expect(h.guardrailsOff).not.toHaveBeenCalled();

    h.releaseOffRail.mockReturnValue({ released: true, holderKey: "offrail:mem", store: "memory" });
    const onRes = { ok: true, s9b: "on" };
    h.guardrailsOn.mockResolvedValue(onRes);
    for (const detail of ["full", undefined]) {
      const on = payload(await callWith("rks_guardrails_on", { projectId: PROJECT_ID, ...(detail ? { detail } : {}) }));
      expect(on, String(detail)).toEqual({ ...onRes, lease: MEMORY });
      expect(keysDiff(on, onRes), String(detail)).toEqual(["lease"]);
    }
    // Whether or not a holder was released, the memory store volunteers the key.
    h.releaseOffRail.mockReturnValue({ released: false, holderKey: null, store: "memory" });
    const abortRes = { ok: true, s9b: "abort" };
    h.guardrailsAbort.mockResolvedValue(abortRes);
    const abort = payload(await callWith("rks_guardrails_abort", { projectId: PROJECT_ID }));
    expect(abort).toEqual({ ...abortRes, lease: MEMORY });
    expect(keysDiff(abort, abortRes)).toEqual(["lease"]);

    // Disk store: exactly the underlying result, no lease key.
    h.releaseOffRail.mockReturnValue({ released: true, holderKey: "offrail:disk", store: "disk" });
    expect(payload(await callWith("rks_guardrails_on", { projectId: PROJECT_ID }))).toEqual(onRes);
    expect(payload(await callWith("rks_guardrails_abort", { projectId: PROJECT_ID }))).toEqual(abortRes);
  });

  it("AC15: a project_leased init result is returned ok:false, marked as an MCP error, with no reconcile and no success envelope", async () => {
    h.detectOrphanedGuardrails.mockReturnValue({ restored: false, reason: "s9b", provenance: null });
    const refusal = {
      ok: false, reason: "project_leased",
      holder: { holderKey: "session:x", actor: null, via: "mcp", client: null, flowType: "qa", problemId: "story-A", runId: null, since: "2026-10-31T00:00:00.000Z", offRail: false },
      requested: { flowType: "story", problemId: "story-B" },
      message: "leased",
    };
    h.handleGovernorInit.mockReturnValue(refusal);
    const { r, helpers } = govRegistry();
    const res = await r.lookupHandler("rks_governor_init")({ projectId: PROJECT_ID, problemId: "story-B" }, ctxWith({}, { clientName: "s9b-client" }));
    expect(res.isError).toBe(true);
    const p = payload(res);
    expect(p).toEqual(refusal);
    expect(p).not.toHaveProperty("_autoRouted");
    expect(p).not.toHaveProperty("token");
    expect(helpers.reconcileActiveScopeOnInit).not.toHaveBeenCalled();
    expect(h.resolveInitCredential).not.toHaveBeenCalled();
    expect(h.emit.mock.calls.filter((c) => c[0] === "governor.session.created")).toEqual([]);
    expect(h.handleGovernorInit.mock.calls[0][1]).toEqual({ clientName: "s9b-client" });
  });
});
