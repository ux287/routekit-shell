/**
 * backlog.feat.keyless-backend-aware-credential-presence - AC10 (D-2).
 * Pure helper plus full-source structural checks over guardrails-audit.mjs. Static import only (no
 * module-registry reset, unit-tier-purity Rule B). No telemetry stub is read; the emit checks split
 * the full source on each emit opener, as off-rail-enforcement-helpers.test.mjs does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOffRailReviewNotice, buildOffRailReviewStep, resolveOffRailPosture, resolveOffRailHalt,
} from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');

describe('off-rail review notice (AC10)', () => {
  it('a reviewerUnavailable step -> reviewed false and a plain not-reviewed notice; a completed review -> reviewed true and no notice', () => {
    const unavailable = buildOffRailReviewStep({ reviewerUnavailable: true, llmFailed: true, cause: 'not_configured', error: 'no key' });
    expect(unavailable.reviewerUnavailable).toBe(true);
    const n = buildOffRailReviewNotice(unavailable);
    expect(n.reviewed).toBe(false);
    expect(n.reviewNotice).toMatch(/reviewer was unavailable/i);
    expect(n.reviewNotice).toMatch(/not reviewed/i);

    const completed = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] });
    const c = buildOffRailReviewNotice(completed);
    expect(c.reviewed).toBe(true);
    expect(c.reviewNotice).toBeNull();

    const skipped = buildOffRailReviewNotice(buildOffRailReviewStep({ skipped: true, reason: 'review_disabled' }));
    expect(skipped.reviewed).toBe(false);
    expect(skipped.reviewNotice).toMatch(/not reviewed/i);
  });

  it('the gate return, both response assignments and every auto_shipped / direct_pushed emit carry reviewed and reviewNotice', () => {
    const gateAt = AUDIT_SRC.indexOf('async function runOffRailEnforcementGate(');
    expect(gateAt).toBeGreaterThan(-1);
    const gateBody = AUDIT_SRC.slice(gateAt, AUDIT_SRC.indexOf('\n}\n', gateAt));
    const returnLiteral = gateBody.slice(gateBody.lastIndexOf('return {'));
    expect(returnLiteral).toMatch(/\breviewed: reviewNoticeOutcome\.reviewed,/);
    expect(returnLiteral).toMatch(/\breviewNotice: reviewNoticeOutcome\.reviewNotice,/);
    expect(gateBody).toContain('const reviewNoticeOutcome = buildOffRailReviewNotice(reviewStep);');

    for (const gate of ['gateAlpha', 'gateBeta']) {
      expect(AUDIT_SRC).toContain(`response.reviewed = ${gate}.reviewed;`);
      expect(AUDIT_SRC).toContain(`response.reviewNotice = ${gate}.reviewNotice;`);
    }

    let emits = 0;
    for (const event of ['guardrails.direct_pushed', 'guardrails.auto_shipped']) {
      const blocks = AUDIT_SRC.split(`collector.emit("${event}"`).slice(1);
      expect(blocks.length, event).toBeGreaterThan(0);
      for (const block of blocks) {
        // Sliced at the first '});' exactly as off-rail-enforcement-helpers.test.mjs does. The last
        // field (enforcementPosture) still being inside the slice proves no new field holds '});'.
        const emit = block.slice(0, block.indexOf('});'));
        expect(emit).toMatch(/\breviewed: gate(Alpha|Beta)\.reviewed,/);
        expect(emit).toMatch(/\breviewNotice: gate(Alpha|Beta)\.reviewNotice,/);
        expect(emit).toContain('reviewVerdict');
        expect(emit).toContain('enforcementPosture');
        emits++;
      }
    }
    expect(emits).toBe(3);
  });

  it('posture stays advisory: an unavailable reviewer does not halt an advisory ship, and buildOffRailReviewStep keeps its shape', () => {
    expect(resolveOffRailPosture(undefined)).toBe('advisory');
    expect(resolveOffRailPosture({})).toBe('advisory');
    expect(resolveOffRailPosture({ offRail: 'block' })).toBe('block');
    const step = buildOffRailReviewStep({ reviewerUnavailable: true, cause: 'not_configured' });
    expect(step).toEqual({ step: 'review', ok: false, verdict: 'unavailable', findingCount: 0, reviewerUnavailable: true, cause: 'not_configured' });
    expect('reviewed' in step).toBe(false);
    expect('reviewNotice' in step).toBe(false);
    expect(resolveOffRailHalt({ posture: 'advisory', reviewStep: step, scopeStep: { ok: true } })).toBeNull();
    expect(resolveOffRailHalt({ posture: 'block', reviewStep: step, scopeStep: { ok: true } })).toBe('review_unavailable');
  });
});
