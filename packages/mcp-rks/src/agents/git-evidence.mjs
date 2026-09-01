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
 * ADVISORY only. This mirrors an INSTRUCTION inside GIT_SYSTEM_PROMPT
 * (git.mjs:111 `- Maximum 6 tool calls per request`) — it is not an enforced
 * bound and must never be reported as one.
 *
 * The only code-enforced bound is runner.mjs:433 `while (turns < maxTurns)`,
 * with config.mjs:40 giving git `maxTurns: 7`.
 *
 * TRUNCATION IS NOT OBSERVABLE FROM HERE. The runner observes the loop exit and
 * stamps `truncated: true` at runner.mjs:545, returning it alongside the
 * finalized partial (runner.mjs:541-547) with
 * `error: 'Agent exceeded max turns (N)'`. That happens OUTSIDE this schema, so
 * a ledger sealed inside the transform can never see it. We therefore do not
 * claim it: there is no field here asserting truncation, and none is named for a
 * bound this code does not enforce.
 * The caller already gets the real signal on the same response object.
 */
export const ADVISORY_CALL_BUDGET = 6;

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
 * KNOWN COUPLING, not live for git today — do not remove when it becomes live.
 * runner.mjs:201-207 retries via `_executeAgent({ ...config, model: fallbackModel })`,
 * which passes the SAME tools array and therefore the SAME ledger into the second
 * attempt. Calls from an abandoned attempt would then be presented as evidence for
 * the invocation. Git is safe on two independent counts: DEFAULTS['git']
 * (config.mjs:40) declares no fallbackModel, config.mjs:169 resolves
 * `DEFAULTS[agentName] || GLOBAL_DEFAULTS` so the global fallback is NOT merged in,
 * and `fallbackModel` has zero occurrences in git.mjs so createGitAgent never puts
 * one on the config runner.mjs:163 destructures. Every other agent in
 * config.mjs:38-50 has one. If `fallbackModel` is ever added to git, the ledger must
 * be reset per attempt before that lands.
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
export function auditGitClaims({ findings = [], conclusions = [], evidence }) {
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
  if (findings.length === 0 && conclusions.length === 0) reasons.push('no_claims_declared');

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
    const { resultDigest, ...rest } = c;
    const base = { ...rest };
    // Every call is always named. The digest text rides along only when there is
    // something to report — the exemplar's "stay quiet when clean", applied to
    // payload size. server.mjs returns this whole object via
    // JSON.stringify(result, null, 2) and a Governor reads it mid-chain as prose.
    return degraded ? { ...base, resultDigest } : base;
  });
}

/**
 * Per-invocation output schema. Strips any model-authored evidence, injects the
 * sealed ledger, annotates claims, prepends the banner, and shapes the returned
 * copy of the calls for size.
 */
export function buildGitOutputSchema({ baseSchema, ledger }) {
  return baseSchema.transform((parsed) => {
    const { evidence: _discardModelEvidence, evidenceAudit: _discardModelAudit, ...rest } = parsed;
    const sealed = ledger.seal();
    // Audit against the FULL digests, always — trimming the response copy below
    // must never be able to change a verdict.
    const { findings, conclusions, audit } = auditGitClaims({
      findings: rest.findings,
      conclusions: rest.conclusions,
      evidence: sealed,
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
      },
      evidenceAudit: audit,
    };
  });
}
