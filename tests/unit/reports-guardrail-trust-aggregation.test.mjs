/**
 * Witness for backlog.fix.telemetry-report-aggregate-trust-events.
 *
 * Proves rks_telemetry_report (generateReport) is no longer blind to guardrail/trust
 * events — the exact blind spot that made the Dispatcher wrongly conclude chain.violation
 * and hook.guardrail_bump "aren't instrumented." See
 * notes/research.2026.07.06.chain-violation-and-bump-observability.md.
 *
 * Coverage:
 *  - guardrails report: flat totals (mirror the dashboard's aggregateTrustCounters)
 *  - guardrails report: NET-NEW grouping by hookName / blockedTool / redirectAgent
 *  - summary: new guardrails section so `reportType: 'summary'` stops under-reporting
 *  - backward compat: plan/exec/agent summary aggregation unchanged (additive only)
 *  - edge case: a store with ONLY trust events still yields non-empty counts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateReport } from "@routekit/telemetry/reports";

const TS = "2026-07-06T12:00:00.000Z";

/** Write a synthetic .rks/telemetry/events-*.jsonl store under a fresh temp projectRoot. */
function makeProject(events) {
  const root = mkdtempSync(path.join(os.tmpdir(), "reports-trust-"));
  const dir = path.join(root, ".rks", "telemetry");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify({ timestamp: TS, ...e })).join("\n");
  writeFileSync(path.join(dir, "events-2026-07-06.jsonl"), lines + "\n");
  return root;
}

// A representative store: 2 chain violations + 3 guardrail bumps across 2 hooks/tools/agents,
// plus some plan/exec/agent traffic to prove the trust aggregation doesn't disturb it.
const TRUST_EVENTS = [
  { type: "chain.violation", payload: { expectedTools: [] } },
  { type: "chain.violation", payload: { expectedTools: [] } },
  { type: "hook.guardrail_bump", payload: { hookName: "redirect-bash-to-governor", blockedTool: "Bash", redirectAgent: "rks_agent_run" } },
  { type: "hook.guardrail_bump", payload: { hookName: "redirect-bash-to-governor", blockedTool: "Bash", redirectAgent: "rks_agent_run" } },
  { type: "hook.guardrail_bump", payload: { hookName: "redirect-git-tools-to-agent", blockedTool: "rks_git_state", redirectAgent: "rks_agent_git" } },
];

const LEGACY_EVENTS = [
  // `status: "success"` was removed here. createEvent (packages/telemetry/src/types.mjs) has
  // never emitted a top-level status field — this fixture manufactured one, which was the only
  // thing making the dead isSuccess predicate fire anywhere. The predicate looked functional in
  // tests while being permanently false in production.
  { type: "plan.start" },
  { type: "exec.start" },
  { type: "exec.complete" },
  { type: "agent.git.started" },
  { type: "agent.git.complete", payload: { durationMs: 1000 } },
  { type: "agent.git.tool_call", payload: { ok: true } },
];

describe("generateReport — guardrail/trust aggregation", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  describe("reportType: 'guardrails' — flat totals (mirror dashboard)", () => {
    beforeEach(() => { root = makeProject([...TRUST_EVENTS, ...LEGACY_EVENTS]); });

    it("counts chain.violation and hook.guardrail_bump as flat totals", async () => {
      const rep = await generateReport(root, { reportType: "guardrails" });
      expect(rep.totals.chainViolations).toBe(2);
      expect(rep.totals.guardrailBumps).toBe(3);
      expect(rep.totals.total).toBe(5);
    });
  });

  describe("reportType: 'guardrails' — NET-NEW grouping beyond the dashboard", () => {
    beforeEach(() => { root = makeProject([...TRUST_EVENTS, ...LEGACY_EVENTS]); });

    it("groups bumps into distinct buckets by payload.hookName", async () => {
      const rep = await generateReport(root, { reportType: "guardrails" });
      expect(rep.byHook).toEqual({
        "redirect-bash-to-governor": 2,
        "redirect-git-tools-to-agent": 1,
      });
    });

    it("groups by payload.blockedTool", async () => {
      const rep = await generateReport(root, { reportType: "guardrails" });
      expect(rep.byBlockedTool).toEqual({ Bash: 2, rks_git_state: 1 });
    });

    it("buckets execution path by payload.redirectAgent", async () => {
      const rep = await generateReport(root, { reportType: "guardrails" });
      expect(rep.byRedirectAgent).toEqual({ rks_agent_run: 2, rks_agent_git: 1 });
    });

    it("does not create buckets for trust events lacking grouping fields (chain violations)", async () => {
      const rep = await generateReport(root, { reportType: "guardrails" });
      // Only the 3 bumps carry hookName; the 2 chain violations must not pollute the buckets.
      const totalBucketed = Object.values(rep.byHook).reduce((s, n) => s + n, 0);
      expect(totalBucketed).toBe(3);
    });
  });

  describe("reportType: 'summary' — no longer blind", () => {
    beforeEach(() => { root = makeProject([...TRUST_EVENTS, ...LEGACY_EVENTS]); });

    it("surfaces a guardrails section with the flat totals", async () => {
      const rep = await generateReport(root, { reportType: "summary" });
      expect(rep.guardrails).toEqual({ chainViolations: 2, guardrailBumps: 3, total: 5 });
    });

    // backlog.feat.offrail-governance-refusal-telemetry: the hook writes `event:`, the server writes
    // `type:`; both are classified by exact type string. Near-miss types must count nothing.
    const GOVERNANCE_EVENTS = [
      { event: "offrail.scope_violation", payload: { violation: "deny_list" } },
      { event: "offrail.scope_violation", payload: { violation: "not_in_target_files" } },
      { event: "offrail.scope_violation", payload: { violation: "not_in_target_files" } },
      { event: "offrail.scope_violation", payload: { violation: "read_only" } },
      { type: "guardrails.off_refused", payload: { stage: "gate", reason: "story_changed_since_arch" } },
      { type: "guardrails.off_refused", payload: { stage: "gate", reason: "story_changed_since_arch" } },
      { type: "guardrails.off_refused", payload: { stage: "lease", reason: "project_leased" } },
      { type: "offrail.scope_violation.extra", payload: { violation: "deny_list" } },
      { type: "guardrails.off", payload: { reason: "x" } },
    ];

    it("summary governance block counts offrail.scope_violation and guardrails.off_refused by exact type", async () => {
      rmSync(root, { recursive: true, force: true });
      root = makeProject([...TRUST_EVENTS, ...LEGACY_EVENTS, ...GOVERNANCE_EVENTS]);
      const rep = await generateReport(root, { reportType: "summary" });
      expect(rep.governance).toEqual({
        scopeViolations: 4,
        scopeViolationsByKind: { deny_list: 1, read_only: 1, not_in_target_files: 2 },
        offRailRefusals: 3,
        offRailRefusalsByReason: { story_changed_since_arch: 2, project_leased: 1 },
      });
    });

    it("summary guardrails section is unchanged by governance event types", async () => {
      const before = (await generateReport(root, { reportType: "summary" })).guardrails;
      rmSync(root, { recursive: true, force: true });
      root = makeProject([...TRUST_EVENTS, ...LEGACY_EVENTS, ...GOVERNANCE_EVENTS]);
      const after = await generateReport(root, { reportType: "summary" });
      expect(after.guardrails).toEqual({ chainViolations: 2, guardrailBumps: 3, total: 5 });
      expect(after.guardrails).toEqual(before);
      // A governance-only store reports zero guardrails totals and an all-zero-kind governance block.
      rmSync(root, { recursive: true, force: true });
      root = makeProject(GOVERNANCE_EVENTS);
      const only = await generateReport(root, { reportType: "summary" });
      expect(only.guardrails).toEqual({ chainViolations: 0, guardrailBumps: 0, total: 0 });
      expect(only.governance.scopeViolations).toBe(4);
    });
  });

  describe("offRailRefusalsByReason — prototype-safe reason keys", () => {
    const refused = (reason) => ({ type: "guardrails.off_refused", payload: { stage: "gate", reason } });
    const ORDINARY = [refused("story_changed_since_arch"), refused("story_changed_since_arch"), refused("project_leased")];

    it("offRailRefusalsByReason has a null prototype", async () => {
      root = makeProject(ORDINARY);
      const rep = await generateReport(root, { reportType: "summary" });
      expect(Object.getPrototypeOf(rep.governance.offRailRefusalsByReason)).toBe(null);
    });

    it("inherited member names constructor, toString and hasOwnProperty are counted as numbers", async () => {
      root = makeProject([refused("constructor"), refused("toString"), refused("hasOwnProperty")]);
      const rep = await generateReport(root, { reportType: "summary" });
      const byReason = rep.governance.offRailRefusalsByReason;
      for (const key of ["constructor", "toString", "hasOwnProperty"]) {
        expect(Object.hasOwn(byReason, key)).toBe(true);
        expect(byReason[key]).toBe(1);
      }
      expect(rep.governance.offRailRefusals).toBe(3);
    });

    it("__proto__ reason is an own key counted once and offRailRefusals equals the per-reason sum", async () => {
      root = makeProject([refused("__proto__"), refused("project_leased")]);
      const rep = await generateReport(root, { reportType: "summary" });
      const byReason = rep.governance.offRailRefusalsByReason;
      expect(Object.hasOwn(byReason, "__proto__")).toBe(true);
      expect(byReason["__proto__"]).toBe(1);
      const sum = Object.keys(byReason).reduce((n, k) => n + byReason[k], 0);
      expect(rep.governance.offRailRefusals).toBe(sum);
      expect(sum).toBe(2);
    });

    it("JSON round-trip of the governance block keeps ordinary reason counts", async () => {
      root = makeProject(ORDINARY);
      const rep = await generateReport(root, { reportType: "summary" });
      const parsed = JSON.parse(JSON.stringify(rep.governance));
      expect(parsed.offRailRefusalsByReason).toEqual({ story_changed_since_arch: 2, project_leased: 1 });
    });

    it("missing and empty reasons are counted under unknown", async () => {
      root = makeProject([
        { type: "guardrails.off_refused", payload: { stage: "gate" } },
        refused(""),
      ]);
      const rep = await generateReport(root, { reportType: "summary" });
      expect(rep.governance.offRailRefusalsByReason.unknown).toBe(2);
      expect(rep.governance.offRailRefusals).toBe(2);
    });
  });

  describe("backward compatibility — plan/exec/agent aggregation unchanged", () => {
    beforeEach(() => { root = makeProject([...TRUST_EVENTS, ...LEGACY_EVENTS]); });

    it("still aggregates plan/exec operations and agents (additive only)", async () => {
      const rep = await generateReport(root, { reportType: "summary" });
      expect(rep.operations.plan.total).toBe(1);
      expect(rep.operations.exec.total).toBe(1);
      expect(rep.operations.exec.success).toBe(1);
      expect(rep.agents.git.invocations).toBe(1);
      expect(rep.agents.git.completed).toBe(1);
      expect(rep.totals.agentInvocations).toBe(1);
      expect(rep.totals.toolCalls).toBe(1);
      // Additive self-escalation fields (backlog.feat.telemetry-report-escalation-structural-rollup)
      // are present and zero for this fixture — they do not disturb the existing aggregation.
      expect(rep.agents.git.selfEscalations).toBe(0);
      expect(rep.agents.git.selfEscalationRate).toBe(0);
      expect(rep.totals.selfEscalations).toBe(0);
      expect(rep.totals.selfEscalationRate).toBe(0);
    });

    it("failures report is unaffected by trust events (they are not failures)", async () => {
      const rep = await generateReport(root, { reportType: "failures" });
      // No *.failed / isFailure events in the fixture → empty failures map.
      expect(rep.failures).toEqual({});
    });
  });

  describe("edge case — a store with ONLY trust events", () => {
    beforeEach(() => { root = makeProject(TRUST_EVENTS); });

    it("summary guardrails section is non-empty even with zero plan/exec/agent traffic", async () => {
      const rep = await generateReport(root, { reportType: "summary" });
      expect(rep.guardrails.total).toBe(5);
      // and the legacy aggregations are correctly all-zero, not errored
      expect(rep.operations.plan.total).toBe(0);
      expect(rep.operations.exec.total).toBe(0);
      expect(rep.agents).toEqual({});
    });

    it("guardrails report is fully populated from a trust-only store", async () => {
      const rep = await generateReport(root, { reportType: "guardrails" });
      expect(rep.totals.total).toBe(5);
      expect(rep.byHook["redirect-bash-to-governor"]).toBe(2);
    });
  });
});
