/**
 * git-evidence.mjs — evidence binding for the Git Agent's output contract.
 *
 * The Git Agent is permitted to QUOTE what a git tool actually returned on this
 * invocation, and to ASSERT conclusions drawn from those quotes — but the two
 * live in different fields, an assertion must name the quoted material it rests
 * on, and the mapping is checked HERE, in code, not by the model.
 *
 * The ledger is code-sourced on purpose. A model-authored evidence field is just
 * more prose and would reproduce the defect one level down.
 *
 * See notes/design.evidence-bound-reporting-invariant.md (R7, R8, R9) and the
 * positive exemplar packages/mcp-rks/src/agents/external-research.mjs.
 */

import { z } from 'zod';

/**
 * ADVISORY only. This mirrors an INSTRUCTION in the git agent's prompt
 * (`- Maximum 8 tool calls per request`, in GIT_SYSTEM_PROMPT in git.mjs and in
 * the project prompt .rks/prompts/agent-git.md, which replaces it when present).
 * It is not an enforced bound and must never be reported as one. It must equal
 * the prompt's N and stay below the git maxTurns.
 *
 * The only code-enforced bound is the runner's `while (turns < maxTurns)` loop in
 * _executeAgent (runner.mjs), with git `maxTurns: 10` from config.mjs DEFAULTS,
 * which .rks/agents.yaml overrides when it carries a git block.
 *
 * THE LOOP EXIT IS NOT OBSERVABLE FROM THIS SCHEMA. The runner observes it and
 * stamps `truncated: true` on its loop-exit result, OUTSIDE this schema, so a
 * ledger sealed inside the transform can never see it, and no field here asserts
 * it. Since backlog.fix.git-agent-max-turns-verified-final-state the git agent
 * does act on that exit, but in git.mjs, not here: the runner calls the config's
 * onMaxTurns hook, which reads HEAD, branch and porcelain status from git after
 * the loop, reads the recorded mutating calls (and git_commit's rawResult
 * fullCommitId) from this ledger, and derives ok from that observation.
 */
export const ADVISORY_CALL_BUDGET = 8;

/** Max characters retained per recorded tool result. */
export const DIGEST_MAX_CHARS = 4000;

/**
 * Floor for a quote to be worth checking. `"".includes()` is always true and so
 * is any one-character substring, so without a floor a model could zero out
 * findingsUnverified — and silence the banner — without quoting anything.
 * `degraded: false` is what callers branch on; it must not be this cheap.
 */
export const MIN_QUOTE_CHARS = 12;

/**
 * KNOWN COUPLING — keep this note while the ledger is shared across attempts.
 * createGitAgent builds ONE ledger and closes both the instrumented tools and the
 * output schema over it, and every attempt runAgent makes (primary, same-model
 * retry, escalation, self-escalation) reuses that same config, tools array and
 * ledger. The same-model retry needs no fallback model, so the coupling is live
 * for git regardless of its model config. Without a per-attempt reset, calls from
 * an abandoned attempt would be presented as evidence for the invocation, with
 * indices that do not start at 0.
 * The ledger is therefore registered with the runner attempt lifecycle
 * (attempt-state.mjs): the runner calls config.attemptState.beginAttempt(ctx)
 * before every attempt, and reset() below empties the ledger IN PLACE on a restart
 * (ctx.resumed false), keeping object identity so buildGitOutputSchema's closure
 * sees it. On a max-turns resume (ctx.resumed true) the ledger is CARRIED
 * (onResume 'carry'): the resumed transcript quotes the earlier calls by index,
 * and resetting would turn those honest quotes into audit failures.
 */

export const EvidenceCallSchema = z.object({
  i: z.number(),
  tool: z.string(),
  input: z.unknown().optional(),
  ok: z.boolean(),
  // Always present: the caller can always see WHICH calls ran and how big each
  // result was. The heavy digest text itself is carried only on a degraded
  // result — see shapeCallsForResponse.
  digestLength: z.number(),
  digestTruncated: z.boolean(),
  resultDigest: z.string().optional(),
});

export const EvidenceSchema = z.object({
  calls: z.array(EvidenceCallSchema),
  callCount: z.number(),
  // Named for what it measures: callCount >= ADVISORY_CALL_BUDGET. NOT truncation.
  advisoryCallBudgetExceeded: z.boolean(),
});

export const FindingSchema = z.object({
  evidenceIndex: z.number(),
  quote: z.string(),
});

export const ConclusionSchema = z.object({
  statement: z.string(),
  basis: z.array(z.number()).default([]),
});

/**
 * Per-invocation recorder. Never shared across invocations.
 */
export function createEvidenceLedger({ advisoryBudget = ADVISORY_CALL_BUDGET } = {}) {
  const calls = [];
  return {
    record(tool, input, result) {
      const raw = safeStringify(result);
      const digestTruncated = raw.length > DIGEST_MAX_CHARS;
      calls.push({
        i: calls.length,
        tool,
        input,
        // Derived by OBSERVING the returned shape, never from "a call was made".
        ok: isOkResult(result),
        resultDigest: digestTruncated ? raw.slice(0, DIGEST_MAX_CHARS) : raw,
        // The size of the RESULT, measured before the slice. Deriving it from the kept excerpt
        // would report DIGEST_MAX_CHARS for every truncated call — a field named for one
        // quantity sourced from another, and wrong precisely when truncation makes it matter.
        digestLength: raw.length,
        digestTruncated,
        // The raw, unstringified result (backlog.fix.git-agent-state-evidence-bound). Code that
        // binds state to the ledger reads THIS, never resultDigest: the digest is capped at
        // DIGEST_MAX_CHARS, and parsing a sliced string would bind a partial observation.
        // Ledger-internal only — shapeCallsForResponse drops it from the returned copy.
        rawResult: result,
      });
    },
    // Full digests — the audit always runs against THESE, never against the
    // trimmed copy that goes back to the caller.
    seal() {
      return {
        calls: calls.slice(),
        callCount: calls.length,
        advisoryCallBudgetExceeded: calls.length >= advisoryBudget,
      };
    },
    // In-place reset for the attempt lifecycle: empties the SAME array, so the
    // output schema's closure sees it. Earlier seals hold their own copies.
    reset() {
      calls.length = 0;
    },
  };
}

export function isOkResult(result) {
  if (result === null || typeof result !== 'object') return true;
  if ('error' in result) return false;
  if (typeof result.ok === 'boolean') return result.ok;
  return true;
}

export function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Wrap each tool's execute so every call lands in the ledger.
 * Transparent: same return value, same thrown error, same tool metadata.
 */
export function instrumentToolsWithLedger(tools, ledger) {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input) => {
      try {
        const result = await tool.execute(input);
        ledger.record(tool.name, input, result);
        return result;
      } catch (err) {
        ledger.record(tool.name, input, { error: err?.message ?? String(err) });
        throw err;
      }
    },
  }));
}

/**
 * Audit model claims against the sealed ledger.
 *
 * A quote that fails to match a TRUNCATED digest is 'unverifiable', not
 * 'not_in_output' — the auditor did not observe the whole result and therefore
 * may not assert absence. (R7 applied to this function itself.)
 */
export function auditGitClaims({ findings = [], conclusions = [], evidence, stateEvidenceIndex = null }) {
  const reasons = [];
  const checkedFindings = findings.map((f) => {
    const call = evidence.calls[f.evidenceIndex];
    if (!call) return { ...f, verified: false, reason: 'no_such_call' };
    // Substance floor first: an empty or near-empty quote is not a quote, and
    // must not be able to buy a clean audit via `includes('')`.
    const quote = typeof f.quote === 'string' ? f.quote : '';
    if (quote.trim().length === 0 || quote.length < MIN_QUOTE_CHARS) {
      return { ...f, verified: false, reason: 'quote_too_trivial' };
    }
    if (call.resultDigest.includes(quote)) return { ...f, verified: true };
    if (call.digestTruncated) return { ...f, verified: false, reason: 'unverifiable' };
    return { ...f, verified: false, reason: 'not_in_output' };
  });

  const checkedConclusions = conclusions.map((c) => {
    const basis = Array.isArray(c.basis) ? c.basis : [];
    const basisResolved = basis.length > 0 && basis.every((i) => Boolean(evidence.calls[i]));
    // Named for the observation, not for backing. All this observed is that the cited indices point
    // at calls that happened. Whether the evidence ENTAILS the statement is
    // never checked by any code path in this repo — which is why the constant
    // below is knowable without measuring (R1's stated exception). Do not
    // replace it with something that looks measured.
    return { ...c, basisResolved, entailmentChecked: false };
  });

  const findingsUnverified = checkedFindings.filter((f) => f.verified === false).length;
  const conclusionsWithUnresolvedBasis = checkedConclusions.filter(
    (c) => c.basisResolved === false,
  ).length;

  if (findingsUnverified > 0) reasons.push('unverified_findings');
  if (conclusionsWithUnresolvedBasis > 0) reasons.push('conclusions_with_unresolved_basis');
  if (evidence.advisoryCallBudgetExceeded) reasons.push('advisory_call_budget_reached');
  if (evidence.callCount === 0 && (findings.length > 0 || conclusions.length > 0)) {
    reasons.push('claims_without_any_git_call');
  }
  // A response that carries code-bound state (backlog.fix.git-agent-state-evidence-bound) is not
  // unbound even when the model quoted nothing: its state fields were copied from a recorded ok
  // git_state call by code. Without such a call the reason is raised exactly as before.
  const hasBoundState = Number.isInteger(stateEvidenceIndex);
  if (findings.length === 0 && conclusions.length === 0 && !hasBoundState) reasons.push('no_claims_declared');

  return {
    findings: checkedFindings,
    conclusions: checkedConclusions,
    audit: {
      callCount: evidence.callCount,
      advisoryCallBudgetExceeded: evidence.advisoryCallBudgetExceeded,
      findingsTotal: findings.length,
      findingsUnverified,
      conclusionsTotal: conclusions.length,
      conclusionsWithUnresolvedBasis,
      // The ledger index whose git_state result evidence.state was copied from, or null when no
      // ok git_state call was recorded. It names WHERE the state came from, not that the model's
      // prose agrees with it.
      stateEvidenceIndex: hasBoundState ? stateEvidenceIndex : null,
      // `degraded: false` means nothing mechanically checkable came back wrong.
      // It does NOT mean the conclusions are sound. No code checks that.
      degraded: reasons.length > 0,
      reasons,
    },
  };
}

/**
 * Cause, scope, magnitude, remedy — prepended, and silent when clean.
 * Shape copied from applyEgressWarning in external-research.mjs.
 */
export function buildDegradationBanner(audit) {
  if (!audit.degraded) return '';
  const parts = [];
  if (audit.conclusionsWithUnresolvedBasis > 0) {
    parts.push(
      `${audit.conclusionsWithUnresolvedBasis} of ${audit.conclusionsTotal} conclusion(s) cite no resolvable evidence index`,
    );
  }
  if (audit.findingsUnverified > 0) {
    parts.push(`${audit.findingsUnverified} of ${audit.findingsTotal} quoted finding(s) could not be matched to a recorded result`);
  }
  if (audit.advisoryCallBudgetExceeded) {
    // Deliberately NOT "the investigation stopped" / "was truncated" — nothing
    // here observed the loop exit. See ADVISORY_CALL_BUDGET above.
    parts.push(`the prompt's ${ADVISORY_CALL_BUDGET}-call advisory budget was reached, so the answer may be incomplete`);
  }
  if (audit.reasons.includes('claims_without_any_git_call')) {
    parts.push('no git tool was called on this invocation');
  }
  if (audit.reasons.includes('no_claims_declared')) {
    parts.push('the summary below declares no evidence-bound findings or conclusions');
  }
  return `> ⚠️ **Evidence notice** — ${parts.join('; ')}. Treat the summary below as the agent's reading, not as git output; re-run with a narrower request, or read \`evidence.calls\` directly.`;
}

/**
 * Trim the returned copy of the ledger. Never used for auditing.
 */
export function shapeCallsForResponse(calls, degraded) {
  return calls.map((c) => {
    // digestLength is carried through from the ledger, never recomputed here: resultDigest is
    // the truncated excerpt, so recomputing would silently cap the reported size.
    // rawResult is ledger-internal (backlog.fix.git-agent-state-evidence-bound) and never rides
    // back to the caller: the response carries at most the capped digest, as before.
    const { resultDigest, rawResult: _ledgerOnly, ...rest } = c;
    const base = { ...rest };
    // Every call is always named. The digest text rides along only when there is
    // something to report — the exemplar's "stay quiet when clean", applied to
    // payload size. server.mjs returns this whole object via
    // JSON.stringify(result, null, 2) and a Governor reads it mid-chain as prose.
    return degraded ? { ...base, resultDigest } : base;
  });
}

/**
 * The git_state result fields copied into evidence.state
 * (backlog.fix.git-agent-state-evidence-bound). A fixed list, not a spread of the
 * result: the bound surface stays stable when git_state grows a field, and the
 * file-list bookkeeping keys stay inside the recorded call rather than being
 * restated here. A field the recorded result does not carry is omitted.
 */
export const GIT_STATE_BOUND_FIELDS = Object.freeze([
  'branch', 'dirty', 'filesChanged', 'files', 'ahead', 'behind', 'mergeState', 'conflictFiles',
]);

function copyValue(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(safeStringify(value));
  }
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return safeStringify(a) === safeStringify(b);
}

/**
 * Code-sourced state from the sealed ledger (backlog.fix.git-agent-state-evidence-bound).
 *
 * Binds the LAST recorded git_state call whose result was observed ok — the most
 * recent state this invocation saw. Values come from that record's rawResult,
 * never from model output and never from the capped resultDigest. A git_state
 * that returned { error } or threw is recorded ok:false and binds nothing; with
 * no such call this returns null and the response is shaped exactly as before.
 *
 * A model `data` key is listed in dataFieldsBound only when its value equals the
 * same key of the recorded result; every other `data` key is listed in
 * dataFieldsUnbound. Nothing about the model's value is copied into the state.
 */
export function bindGitStateFromLedger(calls, data) {
  let call = null;
  for (let k = calls.length - 1; k >= 0; k--) {
    const c = calls[k];
    if (c.tool === 'git_state' && c.ok && c.rawResult !== null && typeof c.rawResult === 'object') {
      call = c;
      break;
    }
  }
  if (!call) return null;
  const recorded = call.rawResult;
  const state = { evidenceIndex: call.i, source: 'git_state' };
  for (const field of GIT_STATE_BOUND_FIELDS) {
    if (recorded[field] !== undefined) state[field] = copyValue(recorded[field]);
  }
  const dataFieldsBound = [];
  const dataFieldsUnbound = [];
  if (data !== null && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const matches = Object.prototype.hasOwnProperty.call(recorded, key) && sameValue(recorded[key], value);
      (matches ? dataFieldsBound : dataFieldsUnbound).push(key);
    }
  }
  state.dataFieldsBound = dataFieldsBound;
  state.dataFieldsUnbound = dataFieldsUnbound;
  return state;
}

/**
 * Per-invocation output schema. Strips any model-authored evidence, injects the
 * sealed ledger, binds git_state-derived state from it, annotates claims,
 * prepends the banner, and shapes the returned copy of the calls for size.
 */
export function buildGitOutputSchema({ baseSchema, ledger }) {
  return baseSchema.transform((parsed) => {
    const { evidence: _discardModelEvidence, evidenceAudit: _discardModelAudit, ...rest } = parsed;
    const sealed = ledger.seal();
    // Bound from the FULL ledger records, before any response trimming, so a degraded and a clean
    // response carry identical state (backlog.fix.git-agent-state-evidence-bound).
    const state = bindGitStateFromLedger(sealed.calls, rest.data);
    // Audit against the FULL digests, always — trimming the response copy below
    // must never be able to change a verdict.
    const { findings, conclusions, audit } = auditGitClaims({
      findings: rest.findings,
      conclusions: rest.conclusions,
      evidence: sealed,
      stateEvidenceIndex: state ? state.evidenceIndex : null,
    });
    const banner = buildDegradationBanner(audit);
    return {
      ...rest,
      summary: banner ? `${banner}\n\n${rest.summary}` : rest.summary,
      findings,
      conclusions,
      evidence: {
        calls: shapeCallsForResponse(sealed.calls, audit.degraded),
        callCount: sealed.callCount,
        advisoryCallBudgetExceeded: sealed.advisoryCallBudgetExceeded,
        // Nested, never spread: git_state's own keys must not become top-level evidence keys.
        ...(state ? { state } : {}),
      },
      evidenceAudit: audit,
    };
  });
}
