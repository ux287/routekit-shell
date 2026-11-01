import crypto from "crypto";
import { createSession, getSession, endSession, isSessionTerminal, findOwnedSession, countConcurrentSessions, readStorySubject, getSessionProjectRoot } from "../shared/governor-token.mjs";
import { acquireLease, releaseLease, verifyLease, resolveAttribution, MEMORY_DEGRADATION } from "../shared/project-lease.mjs";
import { PHASE_GATE_EXEC } from "../workflow/phases.mjs";
import { isCurrentArchSubjectVersion } from "../workflow/arch-verdict.mjs";

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
 *     including one recovered from disk after an MCP restart. EXCEPT a story-flow session at
 *     'planned' whose plan is stale against the story
 *     (see backlog.fix.governor-init-resumes-session-stale-against-story): it is ended and
 *     replaced, mode 'stale_reset' with a NEW token, or, when ending it would restore guardrails
 *     or pop a pending stash, refused with ok: false and reason 'stale_reset_blocked', returning
 *     the OLD token still live.
 *   - Anything else gets a NEW token and session. Another Governor's live session is never
 *     reused, reset or ended, and when one is live the response says so (concurrentSessions).
 *
 * Project lease (backlog.feat.project-lease-actor-attribution): after every resume path has
 * returned and BEFORE createSession, the new session acquires the project lease
 * (shared/project-lease.mjs). An incompatible live holder refuses the init with
 * { ok: false, reason: "project_leased", holder, requested } and no token is minted. Every
 * successful new session echoes { actor, via, client, runId, lease: { mode, holderKey, store } }.
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
      description: "Force a fresh chain. Re-entering a live session that carries the SAME problemId RESUMES it at its current chain state by default, because discarding a chain silently costs a full refine → plan → exec run. Exception: a story-flow session at 'planned' whose plan is stale against the story (the story content changed since rks_plan was admitted, reason story_changed_since_plan, or its phase no longer admits rks_exec, reason chain_phase_mismatch) is not resumed. Init ends it and returns a NEW token with mode 'stale_reset'; or, when ending it would restore guardrails or pop a pending stash, init returns ok: false with reason 'stale_reset_blocked' and the OLD token still live, and passing reset: true is then the caller's decision. Pass reset: true to start the chain over instead; it ends the old session and returns a NEW token. Needed when re-running a step the current state does not admit — e.g. a QA re-run, whose chain begins at rks_agent_research, which qa_assessing does not allow.",
    },
    // backlog.feat.project-lease-actor-attribution §6 (kept in step with governorInitSchema in server.mjs).
    actor: {
      type: "string",
      description: "Who drives this session (self-reported attribution, not authentication). RKS_ACTOR in the server environment overrides it.",
    },
    via: {
      type: "string",
      enum: ["ide", "dispatch", "call", "mcp"],
      description: "The lane this session arrived through. A valid RKS_VIA in the server environment overrides it; defaults to 'mcp'.",
    },
  },
  required: ["projectId"],
};

/**
 * Handle the rks_governor_init tool call.
 * @param {{ projectId: string, problemId?: string, flowType?: string, reset?: boolean, actor?: string, via?: string }} input - Validated input
 * @param {{ clientName?: string|null }} [opts] - clientName: the MCP client name the handler read from
 *   ctx.clientName (backlog.feat.project-lease-actor-attribution §6).
 * @returns {{ ok: boolean, token: string, flowType: string, message: string }}
 */
export function handleGovernorInit(input, { clientName = null } = {}) {
  // 'new' unless a caller-forced reset replaced an owned session; see the re-entry contract.
  let newSessionMode = 'new';
  // Set only when a stale owned session was ended; carries the reason and evidence fields.
  let staleOutcome = null;

  // Resolved flowType (explicit or inferred from problemId).
  const resolvedFlowType = input.flowType || (input.problemId ? 'story' : 'open');

  // RE-ENTRY CONTRACT. Resume requires a work-item identity: the caller's problemId must match
  // a session it owns (same projectId + flowType + problemId). A bare flowType is NOT such an
  // identity — problemId-less (open-flow) inits always get their own fresh session, because
  // sharing one would let one Governor's chain move another's.
  // Resume is NOT unconditional. A story-flow session at 'planned' is first checked against the
  // story: the subject digest recorded at rks_plan admission, then the phase against
  // PHASE_GATE_EXEC. Stale -> 'stale_reset' (the owned session is ended and a NEW token minted),
  // or ok: false with reason 'stale_reset_blocked' (the OLD token stays live) when ending it would
  // restore guardrails or pop a pending stash.
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
      const staleness = assessPlannedStaleness(session);
      if (staleness.staleReason) {
        // Ending the session restores guardrails / pops a pending stash. Those are worktree
        // side effects, so a stale session carrying either flag is refused, not ended.
        const blockedBy = [];
        if (session.guardrailsDisabled) blockedBy.push('guardrailsDisabled');
        if (session.pendingStash) blockedBy.push('pendingStash');
        if (blockedBy.length > 0) {
          return {
            ok: false,
            reason: 'stale_reset_blocked',
            staleReason: staleness.staleReason,
            blockedBy,
            ...staleness.evidence,
            token: owned,
            flowType: session.flowType,
            state: session.state,
            message: `Governor session for ${session.problemId} is stale (${staleness.staleReason}) but was NOT ended: ending it would act on ${blockedBy.join(' and ')}. The old token is still live. To discard the stale chain and start over, call again with reset: true.`,
          };
        }
        endSession(owned); // the caller OWNS this session — never a stranger's
        newSessionMode = 'stale_reset';
        staleOutcome = staleness;
      } else {
        // Resume is the default because it is the non-destructive branch. A reset here would
        // return ok:true and only surface as chain_violation several calls later, after a full
        // refine → plan → exec run had already been thrown away.
        const { digest, phase } = staleness.check;
        if (digest.startsWith('skipped_') || phase.startsWith('skipped_')) {
          console.error(`[governor-init] resumed ${session.problemId} at '${session.state}' without a full staleness check: digest=${digest} phase=${phase}`);
        }
        // backlog.fix.project-lease-post-init-verification-and-conversion-window (D3): re-verify the
        // lease before resuming. A holder reclaimed while this session was idle is re-acquired when
        // nothing conflicting is live; otherwise the init is refused with the acquire's refusal and
        // the session is NOT resumed (its token is not returned). A held or never-held lease, or one
        // ended deliberately, resumes unchanged.
        const leaseCheck = verifyLease({ projectRoot: getSessionProjectRoot(), token: owned });
        if (!leaseCheck.ok) {
          const holder = leaseCheck.holder;
          return {
            ok: false,
            reason: leaseCheck.reason,
            holder,
            requested: leaseCheck.requested,
            ...(leaseCheck.store === 'memory' ? { lease: { ...MEMORY_DEGRADATION } } : {}),
            message: leaseCheck.reason === 'project_leased'
              ? `Governor session for ${session.problemId} was NOT resumed: its project lease was reclaimed while it was idle and project ${input.projectId} is now leased by another live Governor (${holder?.flowType ?? 'off-rail'} flow${holder?.problemId ? ` for ${holder.problemId}` : ''}, since ${holder?.since ?? 'unknown'}). Wait for it to end and retry.`
              : `Governor session for ${session.problemId} was NOT resumed: re-acquiring its project lease is in progress in another process; retry.`,
          };
        }
        const concurrent = countConcurrentSessions(input.projectId, owned);
        return {
          ok: true,
          token: owned,
          flowType: session.flowType,
          mode: 'resumed',
          state: session.state,
          stalenessCheck: staleness.check,
          ...(concurrent > 0 ? { concurrentSessions: concurrent } : {}),
          message: `Governor session resumed at '${session.state}' — re-entered the existing ${session.flowType} session for ${session.problemId} (token reused, chain state preserved). To start the chain over instead, call again with reset: true.`,
        };
      }
    }
  }

  // Counted BEFORE the new session exists, so it is always "other" live sessions.
  const concurrent = countConcurrentSessions(input.projectId);

  // backlog.fix.story-ship-unreachable-from-fresh-session: SEED. A story's phase (executed,
  // committed to the note) outlives the session that ran rks_exec, and only the chain state of
  // the same name admits rks_story_ship. Every resume path has returned above, so this is a NEW
  // session. Seed it from the phase observed on disk on THIS call, and only when all hold: the
  // resolved flow is story, the caller did not ask to start over (reset: true starts at init,
  // which keeps the refine/plan rebuild route open), no stale session was ended on this call (a
  // stale_reset tells the caller to start the chain from the beginning, so it starts at init), and
  // readStorySubject reads phase executed.
  // Any other phase, a missing or unparseable note (phase null), or any other flow starts at init.
  const observed = resolvedFlowType === 'story' && input.reset !== true && staleOutcome === null
    ? readStorySubject(input.problemId)
    : null;
  const seedRequested = observed !== null && observed.phase === 'executed';

  // backlog.feat.project-lease-actor-attribution: acquire the project lease BEFORE the session
  // exists. Every resume path has returned above, and a reset / stale_reset / terminal auto-reset
  // already ended (and so released) the caller's own session, so self-replacement is never refused.
  const attribution = resolveAttribution({ actor: input.actor, via: input.via, clientName });
  const newToken = crypto.randomUUID();
  const lease = acquireLease({
    projectRoot: getSessionProjectRoot(),
    projectId: input.projectId,
    flowType: resolvedFlowType,
    problemId: input.problemId ?? null,
    token: newToken,
    runId: attribution.runId,
    actor: attribution.actor,
    via: attribution.via,
    client: attribution.client,
  });
  const leaseEcho = lease.store === 'memory' ? { ...MEMORY_DEGRADATION } : null;
  if (!lease.ok) {
    const holder = lease.holder;
    return {
      ok: false,
      reason: lease.reason,
      holder,
      requested: lease.requested,
      ...(leaseEcho ? { lease: leaseEcho } : {}),
      message: lease.reason === 'project_leased'
        ? `Project ${input.projectId} is leased by another live Governor (${holder?.flowType ?? 'off-rail'} flow${holder?.problemId ? ` for ${holder.problemId}` : ''}, via ${holder?.via ?? 'unknown'}${holder?.actor ? `, actor ${holder.actor}` : ''}, since ${holder?.since ?? 'unknown'}). No session was created. Wait for it to end (rks_governor_end, rks_guardrails_on, or 30 minutes of idle time) and retry.`
        : `Project ${input.projectId} lease acquisition is in progress in another process. No session was created; retry.`,
    };
  }

  // Create new session with flowType inference (or explicit override). A throw here must not
  // leave the lease just acquired held by a session that never came to exist.
  let created;
  try {
    created = createSession({
      projectId: input.projectId,
      problemId: input.problemId,
      flowType: input.flowType,
      ...(seedRequested ? { initialState: 'executed' } : {}),
      token: newToken,
      actor: attribution.actor,
      via: attribution.via,
      client: attribution.client,
      runId: attribution.runId,
      lease: { mode: lease.mode, holderKey: lease.holderKey },
    });
  } catch (e) {
    releaseLease({ projectRoot: getSessionProjectRoot(), token: newToken, reason: 'session_end' });
    throw e;
  }
  const { token, flowType } = created;

  // Evidence-bound: the state is read back from the session, and seededFrom carries the phase
  // value readStorySubject returned on this call. Present only when the session really started
  // somewhere other than init.
  const startedState = getSession(token)?.state ?? 'init';
  const seededFrom = seedRequested && startedState !== 'init'
    ? { phase: observed.phase, chainState: startedState }
    : null;

  const baseMessage = concurrent > 0
    ? `Governor session initialized (${flowType} flow) — ${concurrent} other live session(s) on this project; each keeps its own token and chain`
    : `Governor session initialized (${flowType} flow)`;
  const seedMessage = seededFrom
    ? ` — started at chain state '${seededFrom.chainState}' because the story note reads phase '${seededFrom.phase}'; rks_story_ship is admissible from here. To start the chain at init instead, call again with reset: true.`
    : '';

  return {
    ok: true,
    token,
    flowType,
    mode: newSessionMode,
    state: startedState,
    ...(seededFrom ? { seededFrom } : {}),
    ...(staleOutcome ? { reason: staleOutcome.staleReason, ...staleOutcome.evidence } : {}),
    ...(concurrent > 0 ? { concurrentSessions: concurrent } : {}),
    actor: attribution.actor,
    via: attribution.via,
    client: attribution.client,
    runId: attribution.runId,
    lease: { mode: lease.mode, holderKey: lease.holderKey, store: lease.store, ...(leaseEcho ? { degraded: leaseEcho.degraded } : {}) },
    message: (staleOutcome
      ? `${baseMessage} — the previous planned session for ${input.problemId} was stale (${staleOutcome.staleReason}) and was ended; this is a NEW token, start the chain from the beginning.`
      : baseMessage) + seedMessage,
  };
}

/**
 * backlog.fix.governor-init-resumes-session-stale-against-story
 *
 * Staleness of an owned session against its story. Checked ONLY for the story flow at
 * 'planned'; everything else is 'not_applicable'. The digest check runs first (and wins when
 * both fail); an unobservable value is skipped, never treated as stale, and never reported as
 * evidence with a placeholder.
 *
 * @returns {{ check: { digest: string, phase: string }, staleReason: string|null, evidence: object }}
 */
function assessPlannedStaleness(session) {
  if (session.flowType !== 'story' || session.state !== 'planned') {
    return { check: { digest: 'not_applicable', phase: 'not_applicable' }, staleReason: null, evidence: {} };
  }
  const { phase, digest, v1Digest, legacyDigest, preCarveOutDigest } = readStorySubject(session.problemId);
  const recorded = typeof session.planSubjectDigest === 'string' && session.planSubjectDigest !== ''
    ? session.planSubjectDigest
    : null;

  let staleReason = null;
  const check = { digest: 'passed', phase: 'passed' };

  if (recorded === null) check.digest = 'skipped_no_recorded_digest';
  else if (digest === null) check.digest = 'skipped_digest_unobservable';
  // A planSubjectDigest persisted before backlog.fix.arch-subject-digest-guidance-boundary-whitespace
  // equals the LEGACY digest of unchanged content, and one persisted before
  // backlog.fix.arch-subject-digest-excludes-refine-context-sections equals the PRE-CARVE-OUT
  // digest; a match on any of the three is not stale.
  //
  // FINGERPRINT VERSION (backlog.fix.arch-subject-digest-whitespace-robust). A planSubjectDigest
  // recorded with the current planSubjectVersion is compared against the current digest ONLY. An
  // unversioned one (persisted before the version existed) gets the previous acceptance exactly,
  // with the version-1 digest in place of the current one.
  else if (isCurrentArchSubjectVersion(session.planSubjectVersion)) {
    if (digest !== recorded) staleReason = 'story_changed_since_plan';
  } else if (v1Digest !== recorded && legacyDigest !== recorded && preCarveOutDigest !== recorded) staleReason = 'story_changed_since_plan';

  if (phase === null) check.phase = 'skipped_phase_unobservable';
  else if (phase !== PHASE_GATE_EXEC && staleReason === null) staleReason = 'chain_phase_mismatch';

  const evidence = {
    chainState: session.state,
    ...(recorded !== null ? { recordedDigest: recorded } : {}),
    ...(digest !== null ? { currentDigest: digest } : {}),
    ...(phase !== null ? { storyPhase: phase } : {}),
  };
  return { check, staleReason, evidence };
}
