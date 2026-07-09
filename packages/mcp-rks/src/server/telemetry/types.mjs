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
