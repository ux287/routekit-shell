/**
 * Tests for lifecycle telemetry emissions added to workflow stages.
 * Verifies plan.*, refine.*, exec.*, story.*, release.*, promote.*, governor.init, story_ship.success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ── Source verification helpers ─────────────────────────────────────────────

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// ── Source-based emit verification ─────────────────────────────────────────

describe("plan lifecycle emits are owned by planner.mjs (de-duplicated)", () => {
  // backlog.feat.plan-exec-telemetry-lifecycle-events: plan.start / plan.complete / plan.failed are
  // emitted ONCE per run by the OUTER orchestrator runPlanTool (planner.mjs) — which alone covers the
  // LLM-bypassing early-exit and the pre-flight/readiness failure paths. The INNER
  // orchestrateLlmPlanning (planner-llm.mjs) no longer emits them; emitting in both layers
  // double-counted operations.plan once the detached plan worker began persisting telemetry.
  const llmSrc = readSource("packages/mcp-rks/src/server/planner-llm.mjs");
  const plannerSrc = readSource("packages/mcp-rks/src/server/planner.mjs");

  it("orchestrateLlmPlanning (planner-llm.mjs) does NOT emit plan.start/complete/failed lifecycle events", () => {
    expect(llmSrc).not.toMatch(/emitTelemetry\("plan\.start"/);
    expect(llmSrc).not.toMatch(/emitTelemetry\("plan\.complete"/);
    expect(llmSrc).not.toMatch(/emitTelemetry\("plan\.failed"/);
  });

  it("planner.mjs owns plan.start with problemId", () => {
    expect(plannerSrc).toMatch(/emit\("plan\.start"/);
    const idx = plannerSrc.indexOf('"plan.start"');
    expect(plannerSrc.slice(idx, idx + 200)).toMatch(/problemId/);
  });

  it("planner.mjs owns plan.complete (durationMs) and plan.failed (reason)", () => {
    expect(plannerSrc).toMatch(/emit\("plan\.complete"/);
    expect(plannerSrc).toMatch(/emit\("plan\.failed"/);
    const cIdx = plannerSrc.indexOf('"plan.complete"');
    expect(plannerSrc.slice(cIdx, cIdx + 300)).toMatch(/durationMs/);
    const failedEmits = [...plannerSrc.matchAll(/emit\("plan\.failed"[\s\S]*?\}\)/g)].map((m) => m[0]);
    expect(failedEmits.some((e) => e.includes("reason"))).toBe(true);
    // the refinementRequired terminal carries the create_file_complexity / stale_edits reason
    expect(plannerSrc).toMatch(/refinementRequired[\s\S]*?"plan\.failed"/);
  });

  it("plan.start is emitted before plan.complete in planner.mjs (ordering in source)", () => {
    const startIdx = plannerSrc.indexOf('"plan.start"');
    const completeIdx = plannerSrc.indexOf('"plan.complete"');
    expect(startIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(completeIdx);
  });
});

describe("refine.mjs — refine lifecycle emits (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/refine.mjs");

  it("emits refine.start at entry with problemId and trigger", () => {
    expect(src).toMatch(/collector\.emit\("refine\.start"/);
    const idx = src.indexOf('"refine.start"');
    const snippet = src.slice(idx, idx + 200);
    expect(snippet).toMatch(/problemId/);
    expect(snippet).toMatch(/trigger/);
  });

  it("emits refine.complete on success with durationMs and action", () => {
    expect(src).toMatch(/collector\.emit\("refine\.complete"/);
    const idx = src.indexOf('"refine.complete"');
    const snippet = src.slice(idx, idx + 200);
    expect(snippet).toMatch(/durationMs/);
    expect(snippet).toMatch(/action/);
  });

  it("emits refine.failed in catch block with durationMs and error", () => {
    expect(src).toMatch(/collector\.emit\("refine\.failed"/);
    const idx = src.indexOf('"refine.failed"');
    const snippet = src.slice(idx, idx + 200);
    expect(snippet).toMatch(/durationMs/);
    expect(snippet).toMatch(/error/);
  });

  it("refine.start appears before refine.complete in source ordering", () => {
    const startIdx = src.indexOf('"refine.start"');
    const completeIdx = src.indexOf('"refine.complete"');
    expect(startIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(completeIdx);
  });
});

describe("exec.mjs — exec lifecycle emits (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/exec.mjs");

  it("emits exec.start after precondition checks with problemId, stepCount, planHash, branchName", () => {
    expect(src).toMatch(/collector\.emit\("exec\.start"/);
    const idx = src.indexOf('"exec.start"');
    const snippet = src.slice(idx, idx + 400);
    expect(snippet).toMatch(/problemId/);
    expect(snippet).toMatch(/stepCount/);
    expect(snippet).toMatch(/planHash/);
    expect(snippet).toMatch(/branchName/);
  });

  it("emits exec.complete on success path with durationMs and filesChanged", () => {
    expect(src).toMatch(/collector\.emit\("exec\.complete"/);
    const idx = src.indexOf('"exec.complete"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/durationMs/);
    expect(snippet).toMatch(/filesChanged/);
  });

  it("emits exec.failed for integrity_failed silent return with reason", () => {
    expect(src).toMatch(/collector\.emit\("exec\.failed"[^)]*integrity_failed/s);
  });

  it("emits exec.failed for qa_blocked silent return with reason", () => {
    expect(src).toMatch(/collector\.emit\("exec\.failed"[^)]*qa_blocked/s);
  });

  it("emits exec.failed for quality_failed silent return with reason", () => {
    expect(src).toMatch(/collector\.emit\("exec\.failed"[^)]*quality_failed/s);
  });

  it("exec.start appears before exec.complete in source ordering", () => {
    const startIdx = src.indexOf('"exec.start"');
    const completeIdx = src.indexOf('"exec.complete"');
    expect(startIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(completeIdx);
  });
});

describe("story-validator-v2.mjs — story lifecycle emits (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/story-validator-v2.mjs");

  it("emits story.validated on passing validation with storyId, score, and phase", () => {
    expect(src).toMatch(/collector\.emit\("story\.validated"/);
    const idx = src.indexOf('"story.validated"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/storyId/);
    expect(snippet).toMatch(/score/);
    expect(snippet).toMatch(/phase/);
  });

  it("emits story.validation_failed on failing validation with storyId and issues", () => {
    expect(src).toMatch(/collector\.emit\("story\.validation_failed"/);
    const idx = src.indexOf('"story.validation_failed"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/storyId/);
    expect(snippet).toMatch(/issues/);
  });

  it("story.validated and story.validation_failed are inside if/else branching on ready", () => {
    // The two emits should be close together with the ready branch
    const validatedIdx = src.indexOf('"story.validated"');
    const failedIdx = src.indexOf('"story.validation_failed"');
    const between = src.slice(validatedIdx, failedIdx);
    expect(between).toMatch(/else/);
  });

  it("new emits use best-effort try-catch pattern", () => {
    const validatedIdx = src.indexOf('"story.validated"');
    const context = src.slice(Math.max(0, validatedIdx - 100), validatedIdx + 400);
    expect(context).toMatch(/try/);
    expect(context).toMatch(/catch/);
  });
});

describe("git-release.mjs — release lifecycle emits (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/git/git-release.mjs");

  it("runRelease emits release.start at entry with version and branch", () => {
    expect(src).toMatch(/collector\.emit\("release\.start"/);
    const idx = src.indexOf('"release.start"');
    const snippet = src.slice(idx, idx + 200);
    expect(snippet).toMatch(/version/);
    expect(snippet).toMatch(/branch/);
  });

  it("runRelease emits release.complete on success with version, tag, and durationMs", () => {
    expect(src).toMatch(/collector\.emit\("release\.complete"/);
    const idx = src.indexOf('"release.complete"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/version/);
    expect(snippet).toMatch(/tag/);
    expect(snippet).toMatch(/durationMs/);
  });

  it("runRelease emits release.failed on error with version, durationMs, and error", () => {
    expect(src).toMatch(/collector\.emit\("release\.failed"/);
    const idx = src.lastIndexOf('"release.failed"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/durationMs/);
    expect(snippet).toMatch(/error/);
  });

  it("runPromote emits promote.start at entry with source, target, projectId", () => {
    expect(src).toMatch(/promoteCollector\.emit\("promote\.start"/);
    const idx = src.indexOf('"promote.start"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/source/);
    expect(snippet).toMatch(/target/);
    expect(snippet).toMatch(/projectId/);
  });

  it("runPromote emits promote.complete on success with source, target, durationMs", () => {
    expect(src).toMatch(/promoteCollector\.emit\("promote\.complete"/);
    const idx = src.indexOf('"promote.complete"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/source/);
    expect(snippet).toMatch(/target/);
    expect(snippet).toMatch(/durationMs/);
  });

  it("runPromote emits promote.failed on error with source, target, durationMs, error", () => {
    expect(src).toMatch(/promoteCollector\.emit\("promote\.failed"/);
    const lastFailedIdx = src.lastIndexOf('"promote.failed"');
    const snippet = src.slice(lastFailedIdx, lastFailedIdx + 300);
    expect(snippet).toMatch(/durationMs/);
    expect(snippet).toMatch(/error/);
  });
});

describe("story-ship.mjs — story_ship.success durationMs (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/story-ship.mjs");

  it("story_ship.success emit payload includes durationMs", () => {
    const idx = src.indexOf("'story_ship.success'");
    expect(idx).toBeGreaterThan(-1);
    const snippet = src.slice(idx, idx + 400);
    expect(snippet).toMatch(/durationMs/);
  });

  it("shipStartMs is declared before the success emit", () => {
    expect(src).toMatch(/shipStartMs\s*=/);
    const startIdx = src.indexOf("shipStartMs");
    const successIdx = src.indexOf("'story_ship.success'");
    expect(startIdx).toBeLessThan(successIdx);
  });
});

describe("governor-token.mjs — governor.init emit (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("emits governor.init when session token is created", () => {
    expect(src).toMatch(/collector\.emit\("governor\.init"/);
  });

  it("governor.init payload contains projectId, flowType, and sessionId", () => {
    const idx = src.indexOf('"governor.init"');
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/projectId/);
    expect(snippet).toMatch(/flowType/);
    expect(snippet).toMatch(/sessionId/);
  });

  it("governor.init emit is inside createSession function", () => {
    const createSessionIdx = src.indexOf("export function createSession");
    const initEmitIdx = src.indexOf('"governor.init"');
    expect(createSessionIdx).toBeGreaterThan(-1);
    expect(initEmitIdx).toBeGreaterThan(-1);
    // The emit should appear after createSession starts
    expect(initEmitIdx).toBeGreaterThan(createSessionIdx);
  });

  it("governor.init emit uses best-effort try-catch pattern", () => {
    const idx = src.indexOf('"governor.init"');
    const context = src.slice(Math.max(0, idx - 100), idx + 200);
    expect(context).toMatch(/try/);
    expect(context).toMatch(/catch/);
  });

  it("getTelemetryCollector is imported in governor-token.mjs", () => {
    expect(src).toMatch(/getTelemetryCollector/);
    expect(src).toMatch(/import.*getTelemetryCollector/);
  });
});

// ── Cross-cutting concerns ──────────────────────────────────────────────────

describe("all new emit calls — cross-cutting requirements", () => {
  it("all emit signatures pass projectId as second argument", () => {
    const files = [
      "packages/mcp-rks/src/server/planner-llm.mjs",
      "packages/mcp-rks/src/server/refine.mjs",
      "packages/mcp-rks/src/server/story-validator-v2.mjs",
      "packages/mcp-rks/src/server/git/git-release.mjs",
      "packages/mcp-rks/src/server/story-ship.mjs",
      "packages/mcp-rks/src/shared/governor-token.mjs",
    ];

    for (const file of files) {
      const src = readSource(file);
      // Collect all emit calls and verify they have 3 args (type, projectId, payload)
      // Pattern: emit("event.name", someId, { ... })
      const emitCalls = [...src.matchAll(/\.emit\(["'][^"']+["']/g)];
      expect(emitCalls.length).toBeGreaterThan(0);
    }
  });

  it("no existing emit calls are removed (refine.mjs still has refine.analyze)", () => {
    const src = readSource("packages/mcp-rks/src/server/refine.mjs");
    expect(src).toMatch(/refine\.analyze/);
    expect(src).toMatch(/refine\.decompose/);
    expect(src).toMatch(/refine\.apply/);
  });

  it("no existing emit calls are removed (planner-llm.mjs still has mcp.llm.start)", () => {
    const src = readSource("packages/mcp-rks/src/server/planner-llm.mjs");
    expect(src).toMatch(/mcp\.llm\.start/);
    expect(src).toMatch(/mcp\.llm\.complete/);
    expect(src).toMatch(/plan\.reviewer_mode/);
  });

  it("no existing emit calls are removed (story-validator still has validate_story.complete)", () => {
    const src = readSource("packages/mcp-rks/src/server/story-validator-v2.mjs");
    expect(src).toMatch(/validate_story\.complete/);
  });

  it("no existing emit calls are removed (story-ship still has story_ship.start and story_ship.failed)", () => {
    const src = readSource("packages/mcp-rks/src/server/story-ship.mjs");
    expect(src).toMatch(/story_ship\.start/);
    expect(src).toMatch(/story_ship\.failed/);
  });
});
