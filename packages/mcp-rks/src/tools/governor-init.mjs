import { createSession, getSession, endSession, isSessionTerminal, findOwnedSession, countConcurrentSessions } from "../shared/governor-token.mjs";

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
 * Behavior (backlog.fix.governor-session-identity-process-global — CALLER-SCOPED):
 *   - The session under decision is the one the CALLER owns: same projectId, flowType and
 *     problemId. It is never "the last session created in this process".
 *   - A matching owned session resumes (or is replaced on reset: true / when terminal),
 *     including one recovered from disk after an MCP restart.
 *   - Anything else gets a NEW token and session. Another Governor's live session is never
 *     reused, reset or ended, and when one is live the response says so (concurrentSessions).
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
  // 'new' unless a caller-forced reset replaced an owned session; see the re-entry contract.
  let newSessionMode = 'new';

  // Resolved flowType (explicit or inferred from problemId).
  const resolvedFlowType = input.flowType || (input.problemId ? 'story' : 'open');

  // RE-ENTRY CONTRACT. Resume requires a work-item identity: the caller's problemId must match
  // a session it owns (same projectId + flowType + problemId). A bare flowType is NOT such an
  // identity — problemId-less (open-flow) inits always get their own fresh session, because
  // sharing one would let one Governor's chain move another's.
  const owned = findOwnedSession({
    projectId: input.projectId,
    flowType: resolvedFlowType,
    problemId: input.problemId,
  });

  if (owned) {
    const session = getSession(owned);
    // A fresh chain is minted when the caller asks for one (reset: true) or the owned session
    // has already reached a TERMINAL state for its flow — terminality is read through
    // isSessionTerminal so the per-flow terminal sets stay in governor-state.mjs.
    const forcedReset = input.reset === true;
    if (forcedReset || isSessionTerminal(owned)) {
      if (forcedReset) newSessionMode = 'reset';
      endSession(owned); // the caller OWNS this session — never a stranger's
    } else if (session) {
      session.lastActivity = Date.now();
      // Resume is the default because it is the non-destructive branch. A reset here would
      // return ok:true and only surface as chain_violation several calls later, after a full
      // refine → plan → exec run had already been thrown away.
      const concurrent = countConcurrentSessions(input.projectId, owned);
      return {
        ok: true,
        token: owned,
        flowType: session.flowType,
        mode: 'resumed',
        state: session.state,
        ...(concurrent > 0 ? { concurrentSessions: concurrent } : {}),
        message: `Governor session resumed at '${session.state}' — re-entered the existing ${session.flowType} session for ${session.problemId} (token reused, chain state preserved). To start the chain over instead, call again with reset: true.`,
      };
    }
  }

  // Counted BEFORE the new session exists, so it is always "other" live sessions.
  const concurrent = countConcurrentSessions(input.projectId);

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
    ...(concurrent > 0 ? { concurrentSessions: concurrent } : {}),
    message: concurrent > 0
      ? `Governor session initialized (${flowType} flow) — ${concurrent} other live session(s) on this project; each keeps its own token and chain`
      : `Governor session initialized (${flowType} flow)`,
  };
}
