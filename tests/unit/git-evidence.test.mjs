/**
 * backlog.feat.git-agent-evidence-bound-output-contract — the pure functions.
 *
 * rks_agent_git returned conclusions that contradicted the evidence in the same payload: a unique
 * stash declared "safely droppable", git diff's blindness to untracked files reported as absence,
 * blame line numbers off by 34. Its contract was `summary: z.string()`, which accepts a true and a
 * false narration with equal validity.
 *
 * WHAT THESE ASSERT ON. Never `summary` prose — that is precisely the unconstrained channel this
 * story exists to stop relying on. The only permitted `summary` assertions here are mechanical
 * (prefix, containment, byte-identity). Every real guarantee is asserted on `evidence` or
 * `evidenceAudit`.
 *
 * BACK-COMPAT LIVES HERE, NOT IN __tests__. packages/mcp-rks/__tests__/ is matched by NONE of
 * vitest.config.unit.mjs, vitest.config.mock.mjs, vitest.config.e2e.mjs or the fallback
 * vitest.config.mjs — all four scope their include globs to the tests/ root — so
 * agent-runner.spec.mjs:746/:749 cannot fail because it cannot run.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADVISORY_CALL_BUDGET,
  DIGEST_MAX_CHARS,
  MIN_QUOTE_CHARS,
  createEvidenceLedger,
  instrumentToolsWithLedger,
  auditGitClaims,
  buildDegradationBanner,
  shapeCallsForResponse,
  buildGitOutputSchema,
  EvidenceCallSchema,
  isOkResult,
} from "../../packages/mcp-rks/src/agents/git-evidence.mjs";
import { GitOutputSchema } from "../../packages/mcp-rks/src/agents/git.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE_SRC = fs.readFileSync(
  path.join(ROOT, "packages/mcp-rks/src/agents/git-evidence.mjs"),
  "utf8",
);

const QUOTE = "line two of the output"; // comfortably above MIN_QUOTE_CHARS
const DIGEST = `line one\n${QUOTE}\nline three`;

/** A ledger with n recorded calls, each returning a distinct known digest. */
function ledgerWith(results) {
  const l = createEvidenceLedger();
  results.forEach((r, i) => l.record(`tool_${i}`, { i }, r));
  return l;
}
function sealedWith(results) {
  return ledgerWith(results).seal();
}
/** A sealed ledger with a hand-set digestTruncated, for the truncation pair. */
function sealedDigest(text, truncated) {
  return {
    calls: [{ i: 0, tool: "t", input: {}, ok: true, resultDigest: text, digestTruncated: truncated }],
    callCount: 1,
    advisoryCallBudgetExceeded: false,
  };
}

describe("forgery resistance — the model cannot author the ledger or its verdict", () => {
  it("a fabricated evidence key is DISCARDED, not merged", () => {
    const ledger = ledgerWith(["first result body here", "second result body here"]);
    const schema = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger });
    const out = schema.parse({
      ok: true,
      summary: "s",
      evidence: {
        calls: [{ i: 0, tool: "x", ok: true, digestLength: 1, digestTruncated: false, resultDigest: "FABRICATED-NEVER-RETURNED" }],
        callCount: 99,
        advisoryCallBudgetExceeded: false,
      },
    });
    expect(out.evidence.callCount, "the model's callCount was honoured").toBe(2);
    for (const c of out.evidence.calls) {
      expect(c.resultDigest ?? "").not.toBe("FABRICATED-NEVER-RETURNED");
    }
  });

  it("a fabricated evidenceAudit cannot self-certify a clean result", () => {
    const ledger = ledgerWith(["a result body long enough"]);
    const schema = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger });
    const out = schema.parse({
      ok: true,
      summary: "s",
      conclusions: [{ statement: "unfounded", basis: [7] }],
      evidenceAudit: { degraded: false, reasons: [] },
    });
    expect(out.evidenceAudit.degraded).toBe(true);
    expect(out.evidenceAudit.reasons.length).toBeGreaterThan(0);
  });

  it("a quote no tool returned is not_in_output, and the audit counts it", () => {
    const evidence = sealedWith([DIGEST, "another complete result body"]);
    const r = auditGitClaims({
      findings: [{ evidenceIndex: 0, quote: "text that was never returned at all" }],
      conclusions: [],
      evidence,
    });
    expect(r.findings[0].verified).toBe(false);
    expect(r.findings[0].reason).toBe("not_in_output");
    expect(r.audit.findingsUnverified).toBe(1);
  });

  it("an unresolvable basis index is basisResolved false — and a resolvable one is true, same payload", () => {
    const evidence = sealedWith(["result body one here", "result body two here"]);
    const r = auditGitClaims({
      findings: [],
      conclusions: [
        { statement: "cites nothing real", basis: [7] },
        { statement: "cites real calls", basis: [0, 1] },
      ],
      evidence,
    });
    // Both in one payload: the difference can only come from index resolution.
    expect(r.conclusions[0].basisResolved).toBe(false);
    expect(r.conclusions[1].basisResolved).toBe(true);
    expect(r.audit.conclusionsWithUnresolvedBasis).toBe(1);
  });

  it("an empty basis is never treated as resolved, even on a healthy ledger", () => {
    const evidence = sealedWith(["a perfectly good result body"]);
    const r = auditGitClaims({ findings: [], conclusions: [{ statement: "bare assertion", basis: [] }], evidence });
    expect(r.conclusions[0].basisResolved).toBe(false);
  });

  it("an out-of-range evidenceIndex is no_such_call — DISTINCT from not_in_output", () => {
    const evidence = sealedWith(["body one is long enough", "body two is long enough"]);
    const r = auditGitClaims({ findings: [{ evidenceIndex: 5, quote: QUOTE }], conclusions: [], evidence });
    expect(r.findings[0].reason).toBe("no_such_call");
    expect(r.findings[0].reason, "the two failure modes collapsed into one").not.toBe("not_in_output");
  });

  it("claims made with zero recorded calls are flagged", () => {
    const evidence = sealedWith([]);
    const r = auditGitClaims({ findings: [{ evidenceIndex: 0, quote: QUOTE }], conclusions: [], evidence });
    expect(r.audit.reasons).toContain("claims_without_any_git_call");
    expect(r.audit.degraded).toBe(true);
  });

  it("a trivial quote cannot buy a clean audit", () => {
    // resultDigest.includes("") is ALWAYS true, and so is any one-char substring that is present.
    // Without the floor a model could zero findingsUnverified and silence the banner while
    // quoting nothing at all.
    const evidence = sealedWith([DIGEST]);
    const empty = auditGitClaims({ findings: [{ evidenceIndex: 0, quote: "" }], conclusions: [], evidence });
    expect(empty.findings[0].reason).toBe("quote_too_trivial");
    expect(empty.audit.degraded).toBe(true);

    const oneChar = auditGitClaims({ findings: [{ evidenceIndex: 0, quote: "l" }], conclusions: [], evidence });
    expect(DIGEST.includes("l"), "the one-char quote must genuinely be present, or this proves nothing").toBe(true);
    expect(oneChar.findings[0].reason).toBe("quote_too_trivial");
    expect(oneChar.audit.degraded).toBe(true);
  });
});

describe("the auditor obeys the invariant it enforces", () => {
  // Both directions from entries differing ONLY in digestTruncated: identical quote, identical
  // digest text. That makes the verdict provably a function of truncation state, not of the quote.
  const MISSING = "a quote that is not in the digest";

  it("DIRECTION A — a miss against a TRUNCATED digest is unverifiable, never absence", () => {
    const r = auditGitClaims({
      findings: [{ evidenceIndex: 0, quote: MISSING }],
      conclusions: [],
      evidence: sealedDigest(DIGEST, true),
    });
    expect(r.findings[0].reason).toBe("unverifiable");
    expect(r.findings[0].reason, "asserted absence from a partial observation").not.toBe("not_in_output");
    expect(JSON.stringify(r.findings[0])).not.toContain("fabricated");
  });

  it("DIRECTION B — the SAME quote against a COMPLETE digest is not_in_output", () => {
    const r = auditGitClaims({
      findings: [{ evidenceIndex: 0, quote: MISSING }],
      conclusions: [],
      evidence: sealedDigest(DIGEST, false),
    });
    expect(r.findings[0].reason).toBe("not_in_output");
  });

  it("digest boundary — exactly DIGEST_MAX_CHARS is not truncated; one more is", () => {
    const exact = createEvidenceLedger();
    exact.record("t", {}, "x".repeat(DIGEST_MAX_CHARS));
    const a = exact.seal().calls[0];
    expect(a.digestTruncated).toBe(false);
    expect(a.resultDigest.length).toBe(DIGEST_MAX_CHARS);

    const over = createEvidenceLedger();
    over.record("t", {}, "x".repeat(DIGEST_MAX_CHARS + 1));
    const b = over.seal().calls[0];
    expect(b.digestTruncated).toBe(true);
    expect(b.resultDigest.length).toBe(DIGEST_MAX_CHARS);
  });
});

describe("no truncation claim anywhere — name discipline", () => {
  it("neither evidence nor evidenceAudit carries a key implying the run stopped early", () => {
    const ledger = ledgerWith(["a result body long enough"]);
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({ ok: true, summary: "s" });
    for (const obj of [out.evidence, out.evidenceAudit]) {
      for (const k of Object.keys(obj)) {
        expect(k, `key ${k} implies truncation the ledger never observed`).not.toMatch(/capped|truncated|stopped/i);
      }
    }
  });

  it.each(["TOOL_CALL_CAP", "tool_call_cap_reached", "conclusionsUnsupported", "supported"])(
    "the identifier %s appears nowhere in git-evidence.mjs",
    (token) => {
      // The tripwire against re-introducing a field that names more than it measures.
      expect(EVIDENCE_SRC).not.toContain(token);
    },
  );
});

describe("advisory budget — a budget, not a cap", () => {
  it("false one below ADVISORY_CALL_BUDGET, true at it", () => {
    const below = sealedWith(Array.from({ length: ADVISORY_CALL_BUDGET - 1 }, (_, i) => `result body number ${i}`));
    expect(below.advisoryCallBudgetExceeded).toBe(false);
    const at = sealedWith(Array.from({ length: ADVISORY_CALL_BUDGET }, (_, i) => `result body number ${i}`));
    expect(at.advisoryCallBudgetExceeded).toBe(true);
  });

  it("a budget-exhausted run degrades, and says so WITHOUT claiming truncation", () => {
    const evidence = sealedWith(Array.from({ length: ADVISORY_CALL_BUDGET }, (_, i) => `result body ${i}`));
    const r = auditGitClaims({ findings: [], conclusions: [], evidence });
    expect(r.audit.reasons).toContain("advisory_call_budget_reached");
    expect(r.audit.degraded).toBe(true);

    const banner = buildDegradationBanner(r.audit);
    expect(banner).toMatch(/advisory budget/i);
    for (const forbidden of [/truncated/i, /capped/i, /investigation stopped/i]) {
      expect(banner, "the banner claims a loop exit the ledger never observed").not.toMatch(forbidden);
    }
    // The degradation reported is budget exhaustion — which the ledger DID observe.
    expect(JSON.stringify(r.audit)).not.toMatch(/truncat/i);
  });
});

describe("entailment is never checked", () => {
  it("every conclusion carries entailmentChecked false, even when its basis fully resolves", () => {
    const evidence = sealedWith([DIGEST]);
    const r = auditGitClaims({
      findings: [{ evidenceIndex: 0, quote: QUOTE }],
      conclusions: [{ statement: "therefore X", basis: [0] }],
      evidence,
    });
    expect(r.conclusions[0].basisResolved).toBe(true);
    expect(r.conclusions[0].entailmentChecked).toBe(false);
    // degraded:false means nothing mechanically checkable came back wrong. It does NOT mean the
    // conclusion is sound — this is the exact case the first draft returned clean on.
    expect(r.audit.degraded).toBe(false);
    for (const k of Object.keys(r.audit)) {
      expect(k).not.toMatch(/supported|sound|correct/i);
    }
  });
});

describe("response shaping", () => {
  it("calls are always named; digests ride along only when degraded", () => {
    const sealed = sealedWith([DIGEST, "second complete result body"]);
    const clean = shapeCallsForResponse(sealed.calls, false);
    expect(clean).toHaveLength(2);
    for (const c of clean) {
      expect(c).toHaveProperty("i");
      expect(c).toHaveProperty("tool");
      expect(c).toHaveProperty("ok");
      expect(c).toHaveProperty("digestTruncated");
      expect(c.resultDigest, "a clean result carried the heavy digest").toBeUndefined();
    }
    expect(clean[0].digestLength).toBe(DIGEST.length);

    const dirty = shapeCallsForResponse(sealed.calls, true);
    for (const c of dirty) expect(typeof c.resultDigest).toBe("string");
    expect(dirty[0].digestLength).toBe(DIGEST.length);
  });

  it("digestLength measures the RESULT, not the excerpt we kept", () => {
    // The reviewer's catch, and it is this story's own invariant turned on itself: computing
    // digestLength from the truncated resultDigest names the size of the result while measuring
    // the size of the excerpt, and diverges exactly when truncation makes the number matter.
    // Asserting only the non-truncated case passes spuriously, because there the two coincide.
    const ledger = createEvidenceLedger();
    const big = "y".repeat(DIGEST_MAX_CHARS + 500);
    ledger.record("t", {}, big);
    const sealed = ledger.seal();
    expect(sealed.calls[0].digestTruncated).toBe(true);
    expect(sealed.calls[0].digestLength, "reported the excerpt length, not the result length").toBe(big.length);
    expect(sealed.calls[0].resultDigest.length).toBe(DIGEST_MAX_CHARS);

    for (const degraded of [false, true]) {
      const shaped = shapeCallsForResponse(sealed.calls, degraded);
      expect(shaped[0].digestLength, `digestLength wrong on the degraded=${degraded} path`).toBe(big.length);
    }
  });

  it("a sealed ledger entry satisfies EvidenceCallSchema", () => {
    // The schema declares digestLength required; record() must actually set it.
    const ledger = createEvidenceLedger();
    ledger.record("t", {}, "a result body long enough");
    expect(EvidenceCallSchema.safeParse(ledger.seal().calls[0]).success).toBe(true);
  });

  it("trimming can never change a verdict — the audit reads the sealed digests", () => {
    const ledger = ledgerWith([DIGEST]);
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true,
      summary: "s",
      findings: [{ evidenceIndex: 0, quote: QUOTE }],
      conclusions: [{ statement: "c", basis: [0] }],
    });
    expect(out.evidenceAudit.degraded, "expected a clean parse for this fixture").toBe(false);
    // Clean, so the response omits resultDigest — yet the finding still verified.
    expect(out.evidence.calls[0].resultDigest).toBeUndefined();
    expect(out.findings[0].verified).toBe(true);
  });
});

describe("the ledger is code-sourced, not model-sourced", () => {
  it("SUBSTITUTION WITNESS — execute-observed values replace the model's", async () => {
    // Shape inspection alone would pass on a model that wrote the field. This substitutes a
    // sentinel only the real execute can produce.
    const ledger = createEvidenceLedger();
    const [probe] = instrumentToolsWithLedger(
      [{ name: "probe_tool", description: "d", inputSchema: {}, execute: async () => "LEDGER-SOURCED-FROM-EXECUTE" }],
      ledger,
    );
    await probe.execute({});
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true,
      summary: "s",
      // degraded, so resultDigest is returned and can be inspected
      conclusions: [{ statement: "x", basis: [9] }],
      evidence: { calls: [{ i: 0, tool: "git_log", ok: true, digestLength: 1, digestTruncated: false, resultDigest: "MODEL-AUTHORED" }], callCount: 1, advisoryCallBudgetExceeded: false },
    });
    expect(out.evidence.calls[0].tool).toBe("probe_tool");
    expect(out.evidence.calls[0].tool).not.toBe("git_log");
    expect(out.evidence.calls[0].resultDigest).toContain("LEDGER-SOURCED-FROM-EXECUTE");
    expect(out.evidence.calls[0].resultDigest).not.toBe("MODEL-AUTHORED");
  });

  it("callCount comes from invocation, not from the payload", async () => {
    const ledger = createEvidenceLedger();
    const [t] = instrumentToolsWithLedger(
      [{ name: "t", description: "d", inputSchema: {}, execute: async () => "some result body here" }],
      ledger,
    );
    await t.execute({}); await t.execute({}); await t.execute({});
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true, summary: "s",
      evidence: { calls: [], callCount: 42, advisoryCallBudgetExceeded: false },
    });
    expect(out.evidence.callCount).toBe(3);
    expect(out.evidence.callCount, "the model's declared count was used").not.toBe(42);
  });

  it("ok is derived from the returned SHAPE — both shapes through the same tool", async () => {
    const ledger = createEvidenceLedger();
    let next = { ok: true, data: "fine" };
    const [t] = instrumentToolsWithLedger(
      [{ name: "t", description: "d", inputSchema: {}, execute: async () => next }],
      ledger,
    );
    await t.execute({});
    next = { error: "it went wrong" };
    await t.execute({});
    const sealed = ledger.seal();
    // Same tool, same wrapper — the difference can only come from the observed return value.
    expect(sealed.calls[0].ok).toBe(true);
    expect(sealed.calls[1].ok).toBe(false);
  });

  it("the git_stash refusal shape is recorded ok:false — a refusal cannot be quoted as success", () => {
    expect(isOkResult({ ok: false, error: "cannot create", hint: "use rks_stash" })).toBe(false);
  });

  it("a throwing execute is recorded ok:false AND the error propagates unchanged", async () => {
    const ledger = createEvidenceLedger();
    const [t] = instrumentToolsWithLedger(
      [{ name: "t", description: "d", inputSchema: {}, execute: async () => { throw new Error("boom from the tool"); } }],
      ledger,
    );
    await expect(t.execute({})).rejects.toThrow("boom from the tool");
    const sealed = ledger.seal();
    expect(sealed.callCount).toBe(1);
    expect(sealed.calls[0].ok).toBe(false);
  });

  it("TRANSPARENCY — a wrapped execute resolves to the IDENTICAL value", async () => {
    const ledger = createEvidenceLedger();
    const returned = { ok: true, data: {} };
    const [t] = instrumentToolsWithLedger(
      [{ name: "t", description: "d", inputSchema: {}, execute: async () => returned }],
      ledger,
    );
    expect(await t.execute({})).toBe(returned);
  });
});

describe("the banner", () => {
  it("is empty for a clean audit", () => {
    const r = auditGitClaims({
      findings: [{ evidenceIndex: 0, quote: QUOTE }],
      conclusions: [{ statement: "c", basis: [0] }],
      evidence: sealedWith([DIGEST]),
    });
    expect(buildDegradationBanner(r.audit)).toBe("");
  });

  it("names cause, scope, magnitude and remedy — asserted on durable substrings", () => {
    const r = auditGitClaims({
      findings: [{ evidenceIndex: 0, quote: "absent from the recorded output" }],
      conclusions: [{ statement: "c", basis: [] }],
      evidence: sealedWith([DIGEST]),
    });
    const b = buildDegradationBanner(r.audit);
    expect(b, "cause").toMatch(/evidence/i);
    expect(b, "scope").toMatch(/conclusion|finding/i);
    expect(b, "magnitude").toMatch(/\d+ of \d+/);
    expect(b, "remedy").toMatch(/re-run|read/i);
  });

  it("is PREPENDED and preserves the model's original prose", () => {
    const ledger = ledgerWith([DIGEST]);
    const original = "the model's own words, verbatim";
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true, summary: original, conclusions: [{ statement: "c", basis: [9] }],
    });
    expect(out.evidenceAudit.degraded).toBe(true);
    expect(out.summary.startsWith("> ⚠️")).toBe(true);
    expect(out.summary).toContain(original);
  });

  it("is SILENT when clean — summary byte-identical", () => {
    const ledger = ledgerWith([DIGEST]);
    const original = "nothing to report here";
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true, summary: original,
      findings: [{ evidenceIndex: 0, quote: QUOTE }],
      conclusions: [{ statement: "c", basis: [0] }],
    });
    expect(out.evidenceAudit.degraded).toBe(false);
    expect(out.summary).toBe(original);
  });
});

describe("audit surface and back-compat", () => {
  it("all eight audit keys are present on EVERY parse, including the clean case", () => {
    const ledger = ledgerWith([DIGEST]);
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true, summary: "s",
      findings: [{ evidenceIndex: 0, quote: QUOTE }],
      conclusions: [{ statement: "c", basis: [0] }],
    });
    for (const k of ["callCount", "advisoryCallBudgetExceeded", "findingsTotal", "findingsUnverified",
      "conclusionsTotal", "conclusionsWithUnresolvedBasis", "degraded", "reasons"]) {
      expect(out.evidenceAudit, `missing audit key ${k}`).toHaveProperty(k);
    }
  });

  it("BACK-COMPAT PROOF — this file, not the dead __tests__ root", () => {
    expect(GitOutputSchema.safeParse({ ok: true, summary: "On branch staging, clean" }).success).toBe(true);
    expect(GitOutputSchema.safeParse({ summary: "missing ok field" }).success).toBe(false);
  });

  it("pre-change fields keep their names and types", () => {
    const p = GitOutputSchema.parse({ ok: true, summary: "text", data: { branch: "staging" } });
    expect(typeof p.summary).toBe("string");
    expect(p.data).toEqual({ branch: "staging" });
  });

  it("omitting findings and conclusions does NOT throw — no new hard failure for any caller", () => {
    const ledger = ledgerWith([DIGEST]);
    const schema = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger });
    let out;
    expect(() => { out = schema.parse({ ok: true, summary: "s" }); }).not.toThrow();
    expect(out.findings).toEqual([]);
    expect(out.conclusions).toEqual([]);
    expect(out.evidenceAudit.reasons).toContain("no_claims_declared");
  });

  it("CLAIMS SURVIVE THE BASE SCHEMA — strip mode would silently discard them", () => {
    // If findings/conclusions are not DECLARED on GitOutputSchema, z.object() strips them before
    // the transform and every invocation degrades with no_claims_declared — a permanently vacuous
    // contract reporting itself as working. A verified finding is impossible if that happened.
    const ledger = ledgerWith([DIGEST]);
    const out = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger }).parse({
      ok: true, summary: "s",
      findings: [{ evidenceIndex: 0, quote: QUOTE }],
      conclusions: [{ statement: "c", basis: [0] }],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.conclusions).toHaveLength(1);
    expect(out.findings[0].verified, "the claims were stripped by the base schema").toBe(true);
  });

  it("REPEAT-SAFE — runner.mjs parses at both :370 and :722", () => {
    const ledger = ledgerWith([DIGEST]);
    const schema = buildGitOutputSchema({ baseSchema: GitOutputSchema, ledger });
    const payload = { ok: true, summary: "s", conclusions: [{ statement: "c", basis: [9] }] };
    const a = schema.parse(payload);
    const b = schema.parse(payload);
    expect(b.summary, "the banner was prepended twice").toBe(a.summary);
    expect(b.evidence.callCount).toBe(a.evidence.callCount);
  });
});
