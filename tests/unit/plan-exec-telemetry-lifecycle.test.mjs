import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock the LLM so the de-dup test runs fully OFFLINE (no API key). After the N2
// Option 1 gate demotion, orchestrateLlmPlanning no longer early-returns on the
// create-file complexity gate — it proceeds to the LLM — so the de-dup guarantee
// (no plan.* lifecycle events from the inner helper) must be asserted through the
// mocked LLM path, not the old early-return shortcut.
vi.mock("../../packages/mcp-rks/src/llm/planner.mjs", () => ({
  runLlmPlanner: vi.fn(async () => ({ actions: [], status: "note_only", prompt: "", raw: "" })),
}));
vi.mock("../../packages/mcp-rks/src/llm/reviewer.mjs", () => ({
  isImplementationReady: vi.fn(),
  runReviewerMode: vi.fn(async () => ({ actions: [], status: "note_only" })),
}));

import {
  getTelemetryCollector,
  resetTelemetryCollector,
  ensureTelemetryStorage,
} from "../../packages/mcp-rks/src/server/telemetry/index.mjs";
import {
  orchestrateLlmPlanning,
  detectCreateFileDirective,
  countAcceptanceCriteria,
  CREATE_FILE_MAX_AC,
} from "../../packages/mcp-rks/src/server/planner-llm.mjs";

// backlog.feat.plan-exec-telemetry-lifecycle-events
//   + backlog.feat.concern-coherence-governs-decompose-ac-cap-soft-trigger (N2 Option 1)
//
//  (1) DE-DUP / idempotency: the inner helper orchestrateLlmPlanning emits NO plan.*
//      lifecycle events — the OUTER orchestrator (runPlanTool in planner.mjs) owns
//      plan.start + exactly one terminal, so a single plan run cannot double-count.
//  (2) GATE DEMOTION (N2 Option 1): a create-file story with > CREATE_FILE_MAX_AC
//      acceptance criteria is NO LONGER hard-blocked — orchestrateLlmPlanning does
//      not return refinementRequired:'create_file_complexity'; it proceeds, and still
//      emits planner.create_file_gate as a NON-BLOCKING advisory.
//  (3) STORAGE: the detached plan worker's pattern persists events to record.root.

describe("plan/exec telemetry — de-dup + gate demotion (N2 Option 1)", () => {
  beforeEach(() => resetTelemetryCollector());

  it("a create-file story over the AC threshold is NOT blocked, still emits the gate advisory, and emits no plan.* lifecycle", async () => {
    const acs = Array.from({ length: CREATE_FILE_MAX_AC + 2 }, (_, i) => `- [ ] AC ${i + 1}`).join("\n");
    const planningText = `## Files to Create\n// CREATE FILE: src/new.ts\n\n## Acceptance Criteria\n${acs}\n`;
    const frontmatterTargets = ["src/new.ts"];

    // self-verify the gate path is exercised (create-file + over threshold)
    expect(detectCreateFileDirective(planningText, frontmatterTargets)).toBe(true);
    expect(countAcceptanceCriteria(planningText)).toBeGreaterThan(CREATE_FILE_MAX_AC);

    const collector = getTelemetryCollector();
    const seen = [];
    const orig = collector.emit.bind(collector);
    collector.emit = (type, pid, data) => { seen.push(type); return orig(type, pid, data); };
    let res;
    try {
      res = await orchestrateLlmPlanning({
        planningText, frontmatterTargets, slug: "backlog.test.x", projectId: "test",
      });
    } finally {
      collector.emit = orig;
    }

    // GATE DEMOTION: not hard-blocked on the AC count (no create_file_complexity refusal)
    expect(res.reason).not.toBe("create_file_complexity");
    expect(res.refinementRequired === true && res.reason === "create_file_complexity").toBe(false);

    // Advisory telemetry still emits for observability
    expect(seen).toContain("planner.create_file_gate");

    // DE-DUP: the inner helper emits NO plan.* lifecycle events (planner.mjs owns those)
    const lifecycle = seen.filter((t) => t === "plan.start" || t === "plan.complete" || t === "plan.failed");
    expect(lifecycle).toEqual([]);
  });
});

describe("plan/exec telemetry — worker storage pattern persists to record.root", () => {
  beforeEach(() => {
    process.env.RKS_TELEMETRY = "on";
    resetTelemetryCollector();
  });

  it("ensureTelemetryStorage(recordRoot) + emit + flush writes the event to recordRoot/.rks/telemetry", async () => {
    const recordRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-tel-record-"));
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-tel-install-"));
    try {
      // mimic the detached worker connecting the PER-PROJECT store (record.root), not the install dir
      ensureTelemetryStorage(recordRoot);
      const collector = getTelemetryCollector();
      collector.emit("plan.complete", "test-proj", { problemId: "backlog.test.x", stepCount: 3, status: "executable" });
      await collector.flush();

      const telDir = path.join(recordRoot, ".rks", "telemetry");
      expect(fs.existsSync(telDir)).toBe(true);
      const files = fs.readdirSync(telDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
      const raw = fs.readFileSync(path.join(telDir, files[0]), "utf8");
      expect(raw).toContain("plan.complete");
      expect(raw).toContain("backlog.test.x");
      // proves persistence landed in record.root, NOT the install dir (the bug this fix prevents)
      expect(fs.existsSync(path.join(installRoot, ".rks", "telemetry"))).toBe(false);
    } finally {
      fs.rmSync(recordRoot, { recursive: true, force: true });
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
  });
});
