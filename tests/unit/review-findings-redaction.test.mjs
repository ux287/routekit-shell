/**
 * Tests for backlog.fix.review-findings-actionable.
 *
 * Ship 54602ef4 returned verdict "block" with 21 findings and 15 blockers,
 * including a security_issue category — and the detail was irrecoverable.
 * runReview computes a findings array; both ship gates kept only the counts.
 *
 * Persisting them naively would have been worse than the silence. A finding's
 * `line` is NOT a line number: runPatternChecks sets it to
 * `line.slice(1).trim().slice(0, 100)`, up to 100 chars of the matched ADDED
 * diff line. The configured securityPatterns include password/api-key/secret
 * assignment patterns, so for a security finding that matched line IS the
 * assignment including its literal value.
 *
 * WHY THESE ASSERT ON WHOLE SERIALIZATION, NOT FIELDS: a check like
 * `expect(out.line).toBeUndefined()` passes while a future `raw`, `snippet` or
 * `context` field carries the same text. Every case here plants a
 * credential-shaped canary and asserts it does not survive JSON.stringify of
 * the output — so any leak path fails, including ones not yet invented.
 */

import { describe, it, expect } from "vitest";

import {
  redactFindings,
  redactReview,
  MAX_PERSISTED_FINDINGS,
} from "../../packages/mcp-rks/src/server/review.mjs";
import { buildReviewStepEntry } from "../../packages/mcp-rks/src/server/story-ship.mjs";
import { buildOffRailReviewStep } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

const CANARY = 'hunter2-CANARY-9f3a';

const secretFinding = () => ({
  category: "security_issue",
  severity: "block",
  file: "src/config.mjs",
  message: "Potential hardcoded secret matching pattern: password.*=.*['\"]",
  suggestion: "Move it to an environment variable",
  line: `password = "${CANARY}"`,
});

const llmFinding = () => ({
  category: "test_coverage",
  severity: "warn",
  file: "src/thing.mjs",
  message: "No test covers the error branch",
  suggestion: "Add one",
  line: 42, // model-authored; dropped, not validated
});

const leaked = (value) => JSON.stringify(value).includes(CANARY);

describe("redactFindings — the canary never survives", () => {
  it("drops the matched source line from a security finding", () => {
    const out = redactFindings([secretFinding()]);
    expect(leaked(out)).toBe(false);
    expect(out[0].category).toBe("security_issue");
    expect(out[0].severity).toBe("block");
    expect(out[0].file).toBe("src/config.mjs");
    // The message names the PATTERN, not the value — safe and the useful part.
    expect(out[0].message).toContain("password");
  });

  it("drops a plausible integer line too — drop, never validate", () => {
    const out = redactFindings([llmFinding()]);
    expect(out[0].line).toBeUndefined();
    expect(Object.keys(out[0])).not.toContain("line");
  });

  it("keeps every field that is actually safe", () => {
    const out = redactFindings([{
      category: "ac_coverage",
      severity: "warn",
      file: "a.mjs",
      message: "m",
      suggestion: "s",
      files: ["a.mjs", "b.mjs"],
    }]);
    expect(out[0]).toEqual({
      category: "ac_coverage",
      severity: "warn",
      file: "a.mjs",
      message: "m",
      suggestion: "s",
      files: ["a.mjs", "b.mjs"],
    });
  });

  it("never mutates its input", () => {
    const input = [secretFinding()];
    const before = JSON.stringify(input);
    redactFindings(input);
    expect(JSON.stringify(input)).toBe(before);
    // …and the original still has its line, so the copy is what was cleaned.
    expect(input[0].line).toContain(CANARY);
  });

  it("tolerates junk without throwing", () => {
    for (const junk of [null, undefined, "nope", 7, {}]) {
      expect(() => redactFindings(junk)).not.toThrow();
      expect(redactFindings(junk)).toEqual([]);
    }
    expect(() => redactFindings([null, undefined])).not.toThrow();
  });
});

describe("the cap keeps blockers", () => {
  it(`caps at ${MAX_PERSISTED_FINDINGS}`, () => {
    expect(MAX_PERSISTED_FINDINGS).toBe(25);
    const many = Array.from({ length: 50 }, (_, i) => ({
      category: "other",
      severity: i < 10 ? "warn" : "info",
      message: `m${i}`,
    }));
    expect(redactFindings(many)).toHaveLength(25);
  });

  it("orders blockers first so a truncated record still shows what blocked", () => {
    const findings = [
      ...Array.from({ length: 30 }, () => ({ category: "other", severity: "info", message: "noise" })),
      { category: "security_issue", severity: "block", message: "the blocker" },
    ];
    const out = redactFindings(findings);
    expect(out).toHaveLength(25);
    expect(out[0].severity).toBe("block");
    expect(out.some((f) => f.message === "the blocker")).toBe(true);
  });

  it("renders incident 54602ef4 in full — the cap must not bite on it", () => {
    const incident = Array.from({ length: 21 }, (_, i) => ({
      category: "other",
      severity: i < 15 ? "block" : "warn",
      message: `finding ${i}`,
    }));
    expect(redactFindings(incident)).toHaveLength(21);
  });

  it("preserves relative order within a severity band", () => {
    const out = redactFindings([
      { severity: "block", message: "first" },
      { severity: "block", message: "second" },
    ]);
    expect(out.map((f) => f.message)).toEqual(["first", "second"]);
  });
});

describe("redactReview — the whole object, not just one field", () => {
  it("cleans findings while preserving the rest of the result", () => {
    const result = {
      ok: true,
      verdict: "block",
      summary: "Code review blocked merge",
      findings: [secretFinding()],
    };
    const out = redactReview(result);
    expect(leaked(out)).toBe(false);
    expect(out.verdict).toBe("block");
    expect(out.summary).toBe("Code review blocked merge");
    expect(out.findings).toHaveLength(1);
  });

  it("never mutates its input", () => {
    const result = { verdict: "block", findings: [secretFinding()] };
    redactReview(result);
    expect(result.findings[0].line).toContain(CANARY);
  });

  it("passes non-objects through untouched", () => {
    expect(redactReview(null)).toBeNull();
    expect(redactReview(undefined)).toBeUndefined();
  });
});

describe("step builders — sinks 3 and 4", () => {
  it("buildReviewStepEntry carries findings on the success branch", () => {
    const step = buildReviewStepEntry(
      redactReview({ ok: true, verdict: "block", findings: [secretFinding()] }),
    );
    expect(leaked(step)).toBe(false);
    expect(step.findings).toHaveLength(1);
    expect(step.findingCount).toBe(1);
  });

  it("buildReviewStepEntry carries findings on the unavailable branch", () => {
    const step = buildReviewStepEntry(
      redactReview({
        reviewerUnavailable: true,
        llmFailed: true,
        verdict: "block",
        cause: "call_failed",
        findings: [secretFinding()],
      }),
    );
    expect(leaked(step)).toBe(false);
    expect(step.ok).toBe(false);
    expect(step.findings).toHaveLength(1);
  });

  it("buildOffRailReviewStep carries findings", () => {
    const step = buildOffRailReviewStep(
      redactReview({ ok: true, verdict: "warn", findings: [secretFinding()] }),
    );
    expect(leaked(step)).toBe(false);
    expect(step.findings).toHaveLength(1);
    expect(step.categories).toContain("security_issue");
  });

  it("keeps buildReviewStepEntry's single-argument signature", () => {
    // tests/unit/ship-review-fail-closed.test.mjs asserts the call site is
    // literally `buildReviewStepEntry(reviewResult)`.
    expect(buildReviewStepEntry.length).toBeLessThanOrEqual(1);
  });
});

describe("the skipped branch must stay exactly as it was", () => {
  it("gains no findings key — a strict toEqual pins this shape", () => {
    // tests/unit/off-rail-enforcement-helpers.test.mjs asserts
    // toEqual({ step, skipped, reason }). An extra key reddens it.
    const step = buildOffRailReviewStep({ skipped: true, reason: "policy_disabled" });
    expect(step).toEqual({ step: "review", skipped: true, reason: "policy_disabled" });
  });

  it("stays clean even if a skipped result somehow carries findings", () => {
    const step = buildOffRailReviewStep({
      skipped: true,
      reason: "no_project_context",
      findings: [secretFinding()],
    });
    expect(leaked(step)).toBe(false);
    expect(step.findings).toBeUndefined();
  });
});

describe("source wiring", () => {
  it("redacts at the runReview boundary on the on-rail path", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "packages/mcp-rks/src/server/story-ship.mjs",
      "utf8",
    );
    expect(src).toMatch(/redactReview\(await runReview\(/);
    // Both ship-failure payloads read the same already-redacted object.
    expect(src).toMatch(/review: reviewResult/);
  });

  it("redacts at the gate on the off-rail path", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "packages/mcp-rks/src/server/guardrails-audit.mjs",
      "utf8",
    );
    expect(src).toMatch(/redactReview\(reviewResult\)/);
  });

  it("keeps the degraded review.complete emit on one line per field", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "packages/mcp-rks/src/server/review.mjs",
      "utf8",
    );
    // ship-review-fail-closed.test.mjs slices that emit from its start to the
    // next `});` — a multi-line added expression containing `});` would
    // truncate the window and redden three assertions there.
    const idx = src.indexOf("collector.emit('review.complete'");
    const window = src.slice(idx, src.indexOf("});", idx));
    expect(window).toContain("findings: redactFindings(patternFindings)");
    expect(window).toContain("llmFailed: true");
    expect(window).toContain("cause: unavailable.cause");
  });
});
