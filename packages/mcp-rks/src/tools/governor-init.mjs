import { generateToken, getToken, setToken, createSession, getSession, endSession, isSessionTerminal } from "../shared/governor-token.mjs";

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
    reset: {
      type: "boolean",
      description: "Force a fresh chain. Re-entering a live session that carries the SAME problemId RESUMES it at its current chain state — that is the default, because discarding a chain silently costs a full refine → plan → exec run. Pass reset: true to start the chain over instead; it ends the old session and returns a NEW token. Needed when re-running a step the current state does not admit — e.g. a QA re-run, whose chain begins at rks_agent_research, which qa_assessing does not allow.",
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
  // 'new' unless a caller-forced reset replaced a live session; see the re-entry contract.
  let newSessionMode = 'new';

  // If a session already exists, decide: reuse, replace, or create fresh.
  if (existing) {
    const session = getSession(existing);

    if (session) {
      // backlog.fix.governor-init-dead-staleness-gate: a 60s STALE_MS / elapsed / isStale
      // trio used to live here. backlog.fix.governor-state-persists-across-sessions made the
      // reset below unconditional, which satisfied its acceptance criterion by ORPHANING the
      // timer rather than removing it: `isStale` was computed on every call and read by
      // nothing. Deleted here. The reset is no longer unconditional — see the re-entry
      // contract below — but no time arithmetic returned with it.
      //
      // Scope note: `isStale` also appears in packages/mcp-rks/src/agents/recovery.mjs, where
      // it is a LIVE and unrelated lock-staleness check with a real consumer. This deletion is
      // file-scoped for that reason; a package-wide sweep would remove working code.

      // Compute resolved flowType (explicit or inferred from problemId)
      const resolvedFlowType = input.flowType || (input.problemId ? 'story' : 'open');

      // Flow transition — end the old session and create a fresh one when:
      //   (a) Resolved flowType differs from the existing session, OR
      //   (b) A different problemId arrives for ANY problemId-bearing flow.
      //   (c) The caller asked for a fresh chain with reset: true, OR
      //   (d) The live session has already reached a TERMINAL state for its flow, so the
      //       prior work is finished and there is nothing to resume. Terminality is read
      //       through isSessionTerminal so the per-flow terminal sets stay in
      //       governor-state.mjs — an inlined list here would be wrong for ops, whose
      //       terminal set is {done} rather than {shipped, failed}.
      // (b) is generalized from story-only to all flows (Finding 4): a qa/ship/ops
      // Governor carries a problemId too, so a different work-item must mint a new
      // session/token rather than reuse-and-mutate the prior one (which would carry
      // over toolCallCounts / childQueue / guardrailsDisabled / createdAt). Idempotent
      // reuse remains only when no incoming problemId distinguishes the work item
      // (e.g. open flow).
      const forcedReset = input.reset === true;
      const needsNewSession =
        (resolvedFlowType !== session.flowType) ||
        (input.problemId && session.problemId !== input.problemId) ||
        forcedReset ||
        isSessionTerminal(existing);
      if (needsNewSession) {
        if (forcedReset) newSessionMode = 'reset';
        endSession(existing);
        // Fall through to createSession
      }
      else {
        session.lastActivity = Date.now();

        // RE-ENTRY CONTRACT. Resume requires a work-item identity on BOTH sides: the live
        // session must carry a problemId and the caller must supply the same one. That pair
        // is the only thing in the call that can mean "the work I am re-entering".
        //
        // A bare flowType is NOT such an identity. Open-flow sessions are ('open', undefined)
        // and are shared by every Research, PO and ARCH Governor, so a "match" there means
        // nothing — resuming would strand rks_agent_recovery, which the open flow admits only
        // at 'init'. problemId-less flows therefore keep the historical reset, unchanged.
        const isSameWorkItem = Boolean(session.problemId) && input.problemId === session.problemId;

        if (isSameWorkItem) {
          // Resume is the default because it is the non-destructive branch. A reset here
          // returns ok:true and only surfaces as chain_violation several calls later, after
          // a full refine → plan → exec run has already been thrown away.
          return {
            ok: true,
            token: existing,
            flowType: session.flowType,
            mode: 'resumed',
            state: session.state,
            message: `Governor session resumed at '${session.state}' — re-entered the existing ${session.flowType} session for ${session.problemId} (token reused, chain state preserved). To start the chain over instead, call again with reset: true.`,
          };
        }

        session.state = 'init';
        // problemId-less re-entry: no work item to bind, and nothing to preserve.
        return {
          ok: true,
          token: existing,
          flowType: session.flowType,
          mode: 'reset',
          state: session.state,
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
    mode: newSessionMode,
    state: getSession(token)?.state ?? 'init',
    message: `Governor session initialized (${flowType} flow)`,
  };
}
