import { validateToken, getSession, endSession } from "../shared/governor-token.mjs";

/**
 * MCP tool: rks_governor_end
 *
 * Ends the CALLER'S OWN Governor session. A Governor calls it as the last MCP call of its chain,
 * on every return path. Contract: backlog.feat.governor-session-end (D8).
 *
 * Outcomes, in evaluation order:
 *   1. No token: { ok: false, reason: "token_required" }.
 *   2. Token not live (unknown, expired, already ended): { ok: true, ended: false, reason: "session_not_live" }.
 *   3. Session projectId differs from input: { ok: false, reason: "project_mismatch" }, untouched.
 *   4. guardrailsDisabled and/or pendingStash: { ok: false, reason: "end_blocked", blockedBy, flowType, state },
 *      untouched, because endSession restores guardrails and pops a pending stash as side effects
 *      (mirrors stale_reset_blocked in governor-init.mjs).
 *   5. Otherwise endSession(token); `ended` is OBSERVED afterwards (getSession(token) === null, D20).
 *      An observed end returns { ok: true, ended: true, flowType, state, lease }, where lease is
 *      exactly what endSession returned (its single releaseLease result, or null when the session
 *      held no lease) — backlog.feat.project-lease-actor-attribution §4a Carrier.
 */

/** Tool name as it appears in the MCP tool list */
export const TOOL_NAME = "rks_governor_end";

/** Tool description for MCP discovery */
export const TOOL_DESCRIPTION = "End your own Governor session. Call it as the LAST MCP call of every Governor chain, on every return path. Idempotent: a token that is no longer live returns ok: true, ended: false. Refuses (end_blocked) while the session has guardrails disabled or a pending stash.";

/**
 * JSON Schema for tool input. The tool is UNPROTECTED (so a not-live token reaches the handler),
 * and server.mjs injects _governorToken only into protected schemas, so it is declared here (D16).
 */
export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectId: {
      type: "string",
      description: "Project identifier from registry",
    },
    _governorToken: {
      type: "string",
      description: "Your own Governor session token, as returned by rks_governor_init",
    },
  },
  required: ["projectId"],
};

/**
 * @param {{ projectId: string }} input - Validated input
 * @param {string | undefined} token - ctx.governorToken
 */
export function handleGovernorEnd(input, token) {
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "token_required", message: "rks_governor_end needs your _governorToken." };
  }
  // validateToken rehydrates a session persisted on disk (MCP restart) before the lookup.
  const session = validateToken(token) ? getSession(token) : null;
  if (!session) {
    return { ok: true, ended: false, reason: "session_not_live", message: "No live session for this token; nothing to end." };
  }
  if (session.projectId !== input.projectId) {
    return { ok: false, reason: "project_mismatch", message: `Session belongs to ${session.projectId}, not ${input.projectId}. Nothing was ended.` };
  }
  const blockedBy = [];
  if (session.guardrailsDisabled) blockedBy.push("guardrailsDisabled");
  if (session.pendingStash) blockedBy.push("pendingStash");
  if (blockedBy.length > 0) {
    return { ok: false, reason: "end_blocked", blockedBy, flowType: session.flowType, state: session.state, message: `Session NOT ended: ending it would act on ${blockedBy.join(" and ")}.` };
  }
  const { flowType, state } = session;
  // Carrier (backlog.feat.project-lease-actor-attribution §4a): endSession returns releaseLease's result, or null.
  const lease = endSession(token);
  // Observed, not assumed: the session must actually be gone (D20).
  if (getSession(token) !== null) {
    return { ok: false, ended: false, reason: "end_not_observed", flowType, state };
  }
  // Only ended: true carries lease; end_not_observed above and every pre-end outcome carry none (§4a).
  return { ok: true, ended: true, flowType, state, lease };
}
