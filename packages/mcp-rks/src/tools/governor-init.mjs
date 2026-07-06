import { generateToken, getToken, setToken, createSession, getSession, endSession } from "../shared/governor-token.mjs";

/**
 * MCP tool: rks_governor_init
 *
 * Initialize Governor session and obtain authentication token.
 * This is the bootstrap entry point — the first thing a Governor calls
 * when it starts a session.
 *
 * Phase 1 (state machine): accepts optional problemId to infer flowType.
 *   - problemId provided → flowType: 'story' (refine → plan → exec chain)
 *   - No problemId → flowType: 'open' (research → notes chain)
 *
 * Behavior:
 *   - If no token exists yet → create session, return token + flowType
 *   - If token already exists → return the existing session (idempotent)
 */

/** Tool name as it appears in the MCP tool list */
export const TOOL_NAME = "rks_governor_init";

/** Tool description for MCP discovery */
export const TOOL_DESCRIPTION = "Initialize Governor session and obtain authentication token";

/** JSON Schema for tool input */
export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectId: {
      type: "string",
      description: "Project identifier from registry",
    },
    problemId: {
      type: "string",
      description: "Backlog story ID — presence triggers 'story' flow, absence triggers 'open' flow",
    },
    flowType: {
      type: "string",
      enum: ["story", "open", "qa", "ship", "ops"],
      description: "Explicit flow type override. If omitted, inferred from problemId (present → 'story', absent → 'open').",
    },
  },
  required: ["projectId"],
};

/**
 * Handle the rks_governor_init tool call.
 * @param {{ projectId: string, problemId?: string }} input - Validated input
 * @returns {{ ok: boolean, token: string, flowType: string, message: string }}
 */
export function handleGovernorInit(input) {
  const existing = getToken();

  // If a session already exists, decide: reuse, replace, or create fresh.
  if (existing) {
    const session = getSession(existing);

    if (session) {
      const STALE_MS = 60_000; // 60 seconds
      const elapsed = Date.now() - (session.lastActivity || 0);
      const isStale = elapsed > STALE_MS;

      // Compute resolved flowType (explicit or inferred from problemId)
      const resolvedFlowType = input.flowType || (input.problemId ? 'story' : 'open');

      // Flow transition — end the old session and create a fresh one when:
      //   (a) Resolved flowType differs from the existing session, OR
      //   (b) A different problemId arrives for ANY problemId-bearing flow.
      // (b) is generalized from story-only to all flows (Finding 4): a qa/ship/ops
      // Governor carries a problemId too, so a different work-item must mint a new
      // session/token rather than reuse-and-mutate the prior one (which would carry
      // over toolCallCounts / childQueue / guardrailsDisabled / createdAt). Idempotent
      // reuse remains only when no incoming problemId distinguishes the work item
      // (e.g. open flow).
      const needsNewSession =
        (resolvedFlowType !== session.flowType) ||
        (input.problemId && session.problemId !== input.problemId);
      if (needsNewSession) {
        endSession(existing);
        // Fall through to createSession
      }
      // rks_governor_init is always an explicit "start fresh" signal — reset to init
      else {
        session.state = 'init';
        session.lastActivity = Date.now();
        // If caller provides a problemId, bind it to the reset session
        if (input.problemId) {
          session.problemId = input.problemId;
        }
        return {
          ok: true,
          token: existing,
          flowType: session.flowType,
          message: `Governor session reset → init — re-entered the existing ${session.flowType} session (token reused; a different problemId starts a new session)`,
        };
      }
    }
    // Token exists but no session in Map — orphaned legacy token, ignore it
  }

  // Create new session with flowType inference (or explicit override)
  const { token, flowType } = createSession({
    projectId: input.projectId,
    problemId: input.problemId,
    flowType: input.flowType,
  });

  return {
    ok: true,
    token,
    flowType,
    message: `Governor session initialized (${flowType} flow)`,
  };
}
