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
import { generateReport } from "../../packages/mcp-rks/src/server/telemetry/reports.mjs";

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
  { type: "plan.start", status: "success" },
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
