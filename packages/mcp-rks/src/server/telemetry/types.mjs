/**
 * @typedef {Object} TelemetryEvent
 * @property {string} id - UUID for this event
 * @property {string} type - Event type (e.g., "plan.start", "exec.failed")
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} projectId - Project identifier
 * @property {string} [correlationId] - Links related events (e.g., plan → exec)
 * @property {string} [runId] - RKS run folder ID
 * @property {Object} payload - Type-specific payload
 * @property {Object} [context] - Additional context (branch, user, etc.)
 */

import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * backlog.fix.clean-machine-honesty: the rks version this process is RUNNING, captured at module load.
 *
 * Read here rather than imported from preflight.mjs on purpose: preflight imports the telemetry
 * collector, and the collector imports this file — importing back would close an import cycle. The
 * four-line reader is duplicated; the value is not a list and cannot drift into disagreement, and a
 * cycle is a worse trade.
 *
 * Module-load, not per-call: this must name the code that actually ran, which after a `git checkout`
 * without an MCP-server restart is NOT what is sitting on disk.
 */
const __telemetryDirname = path.dirname(fileURLToPath(import.meta.url));
export const LOADED_RKS_VERSION = (() => {
  try {
    const pkgPath = path.resolve(__telemetryDirname, "../../../../../package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || null;
  } catch {
    return null;
  }
})();

/**
 * Event type constants
 */
export const EventTypes = {
  PLAN_START: "plan.start",
  PLAN_COMPLETE: "plan.complete",
  PLAN_FAILED: "plan.failed",
  EXEC_START: "exec.start",
  EXEC_STEP: "exec.step",
  EXEC_COMPLETE: "exec.complete",
  EXEC_FAILED: "exec.failed",
  REFINE_START: "refine.start",
  REFINE_COMPLETE: "refine.complete",
  RAG_QUERY: "rag.query",
  RAG_EMBED: "rag.embed",
  LLM_CALL: "llm.call",
  GIT_COMMIT: "git.commit",
  GIT_BRANCH: "git.branch",
  TEST_RUN: "test.run",
  STORY_PHASE_CHANGED: "story.phase.changed",
  STORY_PLAN_ATTEMPT: "story.plan.attempt",
  STORY_QUALITY_FAILED: "story.plan.quality_failed",
  // Governor state machine events
  GOVERNOR_STATE_TRANSITION: "governor.state.transition",
  GOVERNOR_SESSION_CREATED: "governor.session.created",
  GOVERNOR_CHAIN_VIOLATION: "governor.chain.violation",
  GOVERNOR_TOOL_SUMMARY: "governor.tool_summary",
  // Refine iteration events
  REFINE_ITERATION_START: "refine.iteration.start",
  REFINE_ITERATION_COMPLETE: "refine.iteration.complete",
  REFINE_DECOMPOSE: "refine.decompose",
  // Exec guardrails boundary events
  EXEC_GUARDRAILS_OFF: "exec.guardrails_off",
  EXEC_GUARDRAILS_ON: "exec.guardrails_on",
  // Exec divergence events (per-step detection)
  EXEC_DIVERGENCE_DETECTED: "exec.divergence_detected",
};

/**
 * Create a base telemetry event
 */
export function createEvent(type, projectId, payload, options = {}) {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    projectId,
    // backlog.fix.clean-machine-honesty: which rks actually produced this event.
    //
    // Without it a failure cannot be attributed to a version. A UAT reported a planner failure
    // against "0.26.0" while the install was really 0.27.2, and the same report's own version field
    // flip-flopped across five values — so nobody could say which build a bug belonged to. This is
    // the LOADED version (the code that ran), not the one on disk; they are not always the same, and
    // the one that produced the event is the only one worth recording.
    rksVersion: LOADED_RKS_VERSION,
    correlationId: options.correlationId || null,
    runId: options.runId || null,
    payload,
    context: options.context || {},
  };
}

/**
 * Generate a new correlation ID for linking events
 */
export function createCorrelationId() {
  return randomUUID();
}
