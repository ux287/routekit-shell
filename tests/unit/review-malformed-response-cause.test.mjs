/**
 * Tests for backlog.fix.review-malformed-response-indistinguishable.
 *
 * Three ships returned verdict 'unavailable' with cause 'call_failed' and
 *
 *   "Failed to parse reviewer response: Unexpected token 'I', \"I'll syste\"..."
 *
 * The reviewer RAN and ANSWERED — it just prefixed the requested JSON with
 * prose. callReviewer did one JSON.parse on a fence-stripped string, gave up
 * permanently, discarded the captured rawResponse, and stamped the same
 * 'call_failed' a transport failure stamps. So a reviewer that answered was
 * indistinguishable from one that never ran, and a parseable review was thrown
 * away.
 *
 * This file covers the three halves of the fix: salvage (parseReviewerResponse),
 * the exactly-one-retry contract, and the widened cause vocabulary surviving to
 * BOTH ship steps.
 *
 * TIERING: callReviewer is module-private and returns early without a
 * credential, so the retry CONTRACT is driven through the exported runReview
 * with its collaborators mocked. That keeps this file hermetic — no git, no
 * LanceDB, no network, no subprocess — which is what the unit tier requires.
 * This file must contain no spawn-family call (unit-tier purity guard,
 * tests/unit/unit-tier-purity.test.mjs rule (a)).
 *
 * BINDING CONSTRAINT (ARCH): this file must contain NO literal
 * '@routekit/telemetry' specifier. tests/unit/telemetry-global-mock-triage.test.mjs
 * classifies each test file by scanning its own source for that literal; a new
 * consumer without a VERDICTS entry reddens its untriaged guard and, under
 * bail:1, aborts the tier. review.mjs's telemetry use arrives transitively and is
 * already globally stubbed by tests/setup.mjs, so nothing here needs to mock it.
 *
 * ANTI-VACUITY: at the time of writing HEAD == staging, so a REAL
 * `git diff staging...HEAD` is empty and runReview returns at its
 * "No changes to review" early exit WITHOUT calling the reviewer. Every
 * call-count assertion below is therefore paired with an assertion on the
 * returned cause/verdict, which is only reachable past that early exit. A
 * mock that stopped supplying a diff would red these tests rather than
 * silently zero the counts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// A root with no .rks/review-policy.yaml, so loadReviewPolicy falls back to its
// defaults (enabled: true, and the canonical securityPatterns the scrub reuses).
// Nothing ever touches this path on disk — every disk/subprocess collaborator
// below is mocked.
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'review-malformed-nonexistent-root');

const chatMock = vi.fn();
const loadEnvMock = vi.fn(() => ({ anthropicKey: 'test-key-not-a-real-credential' }));

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', () => ({
  loadEnv: (...args) => loadEnvMock(...args),
  createAnthropicClient: vi.fn(() => ({ stub: true })),
  callAnthropicChat: (...args) => chatMock(...args),
  DEFAULT_LLM_TIMEOUT_MS: 30_000,
}));

vi.mock('../../packages/mcp-rks/src/server/project.mjs', () => ({
  loadContext: vi.fn(async () => ({ record: { root: FAKE_ROOT } })),
}));

vi.mock('@routekit/rag', () => ({
  runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })),
}));

// A benign, deterministic diff. Deliberately a .md file so runPatternChecks
// produces ZERO findings: no code file means no test_coverage warn, and the
// body matches no security or anti-pattern. That keeps the unavailable verdict
// exactly 'unavailable' rather than a pattern-derived 'block'.
const FAKE_DIFF = [
  'diff --git a/docs/notes.md b/docs/notes.md',
  '--- a/docs/notes.md',
  '+++ b/docs/notes.md',
  '@@ -1,1 +1,2 @@',
  ' existing line',
  '+an added documentation line',
].join('\n');

vi.mock('child_process', () => {
  const impl = (_cmd, args = []) =>
    args.includes('--name-only')
      ? { stdout: 'docs/notes.md\n', stderr: '', status: 0 }
      : { stdout: FAKE_DIFF, stderr: '', status: 0 };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

const {
  parseReviewerResponse,
  scrubSecretLiterals,
  buildUnavailableReview,
  loadReviewPolicy,
  runReview,
} = await import('../../packages/mcp-rks/src/server/review.mjs');
const { buildOffRailReviewStep } = await import(
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);
const { buildReviewStepEntry } = await import(
  '../../packages/mcp-rks/src/server/story-ship.mjs'
);

const REVIEW_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/review.mjs'),
  'utf8',
);

/** A valid reviewer payload, as the prompt asks for it. */
const VALID_REVIEW = {
  verdict: 'warn',
  summary: 'One concern about error handling',
  findings: [
    {
      category: 'missing_error_handling',
      severity: 'warn',
      file: 'docs/notes.md',
      line: null,
      message: 'no error path',
      suggestion: 'add one',
    },
  ],
  acCoverage: { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] },
};

const runReviewUnderTest = () =>
  runReview({ projectId: 'routekit-shell-core', branch: 'staging', targetBranch: 'staging' });

beforeEach(() => {
  chatMock.mockReset();
  loadEnvMock.mockReset();
  loadEnvMock.mockImplementation(() => ({ anthropicKey: 'test-key-not-a-real-credential' }));
});

describe('parseReviewerResponse — salvage a review the model wrapped in prose', () => {
  it('is a pure named export callable with no credential, no LLM and no disk', () => {
    expect(typeof parseReviewerResponse).toBe('function');
    expect(() => parseReviewerResponse('')).not.toThrow();
  });

  it('parses the literal incident shape: an "I\'ll syste..." preamble then JSON', () => {
    // The exact defect: the reviewer answered, prefixed by narration.
    const response =
      "I'll systematically review this diff against the acceptance criteria.\n\n" +
      JSON.stringify(VALID_REVIEW);
    const parsed = parseReviewerResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed.verdict).toBe('warn');
    expect(parsed.findings).toHaveLength(1);
  });

  it("still parses a fence-wrapped ```json block (happy-path regression)", () => {
    const response = '```json\n' + JSON.stringify(VALID_REVIEW) + '\n```';
    expect(parseReviewerResponse(response)).toEqual(VALID_REVIEW);
  });

  it('still parses bare JSON with no fence and no preamble (happy-path regression)', () => {
    expect(parseReviewerResponse(JSON.stringify(VALID_REVIEW))).toEqual(VALID_REVIEW);
  });

  it('extracts the FIRST balanced object across braces and escaped quotes inside strings', () => {
    // A finding message legitimately containing '{' and an escaped quote must
    // not truncate the extraction — a naive indexOf('}') stops here.
    const tricky = {
      verdict: 'block',
      summary: 'brace { and quote " inside',
      findings: [{ category: 'other', severity: 'block', message: 'saw a { and a \\" here' }],
    };
    const response = 'Preamble prose.\n' + JSON.stringify(tricky) + '\nTrailing prose.';
    const parsed = parseReviewerResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed.verdict).toBe('block');
    expect(parsed.findings[0].message).toContain('{');
  });

  it('returns null rather than throwing when there is no JSON object at all', () => {
    expect(parseReviewerResponse('I am unable to review this diff.')).toBeNull();
    expect(parseReviewerResponse('')).toBeNull();
    expect(parseReviewerResponse(null)).toBeNull();
  });
});

describe('scrubSecretLiterals — rawResponse is redacted, not merely truncated', () => {
  it('removes a secret-shaped literal using the policy securityPatterns vocabulary', () => {
    const policy = loadReviewPolicy(FAKE_ROOT);
    expect(policy.securityPatterns.length).toBeGreaterThan(0); // anti-vacuity
    const dirty = 'The diff adds api_key = "sk-ant-LEAKED-VALUE-0001" which is unsafe.';
    const clean = scrubSecretLiterals(dirty, policy);
    expect(clean).not.toContain('sk-ant-LEAKED-VALUE-0001');
  });

  it('leaves ordinary prose untouched', () => {
    const policy = loadReviewPolicy(FAKE_ROOT);
    const prose = 'This change looks reasonable and adds a documentation line.';
    expect(scrubSecretLiterals(prose, policy)).toBe(prose);
  });
});

describe('callReviewer retry contract, driven through runReview', () => {
  it('salvages a prose-wrapped response with NO retry — exactly one chat call', async () => {
    chatMock.mockResolvedValueOnce("I'll systematically review.\n" + JSON.stringify(VALID_REVIEW));
    const result = await runReviewUnderTest();

    expect(chatMock).toHaveBeenCalledTimes(1);
    // Anti-vacuity + AC: the review PROCEEDS as if nothing happened.
    expect(result.verdict).toBe('warn');
    expect(result.reviewerUnavailable).toBeUndefined();
    expect(result.cause).toBeUndefined();
  });

  it('retries exactly ONCE on an unsalvageable response, and a good retry recovers', async () => {
    chatMock
      .mockResolvedValueOnce('I cannot produce JSON for this diff.')
      .mockResolvedValueOnce(JSON.stringify(VALID_REVIEW));
    const result = await runReviewUnderTest();

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe('warn');
    expect(result.reviewerUnavailable).toBeUndefined();
    expect(result.cause).toBeUndefined();
  });

  it('sends a strict JSON-only reprompt that differs from the original prompt', async () => {
    chatMock
      .mockResolvedValueOnce('still prose, no object')
      .mockResolvedValueOnce(JSON.stringify(VALID_REVIEW));
    await runReviewUnderTest();

    expect(chatMock).toHaveBeenCalledTimes(2);
    const first = chatMock.mock.calls[0][0].prompt;
    const second = chatMock.mock.calls[1][0].prompt;
    expect(second).not.toBe(first);
    expect(second).toMatch(/JSON/);
    expect(second).toMatch(/only/i);
  });

  it("after salvage AND retry both fail: cause 'malformed_response', still exactly 2 calls", async () => {
    chatMock
      .mockResolvedValueOnce('prose one, no object')
      .mockResolvedValueOnce('prose two, still no object');
    const result = await runReviewUnderTest();

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(result.cause).toBe('malformed_response');
    expect(result.verdict).toBe('unavailable');
    expect(result.reviewerUnavailable).toBe(true);
    expect(result.llmFailed).toBe(true);
  });

  it('preserves a scrubbed, 500-char-capped rawResponse on the malformed exit', async () => {
    const leaky =
      'Here is my review. The diff contains api_key = "sk-ant-LEAKED-VALUE-0002" which worries me. ' +
      'x'.repeat(2000);
    chatMock.mockResolvedValueOnce(leaky).mockResolvedValueOnce(leaky);
    const result = await runReviewUnderTest();

    expect(result.cause).toBe('malformed_response'); // anti-vacuity
    expect(typeof result.rawResponse).toBe('string');
    expect(result.rawResponse.length).toBeLessThanOrEqual(500);
    // Truncation is NOT redaction: the secret sits well inside the first 500
    // chars, so only a real scrub removes it.
    expect(result.rawResponse).not.toContain('sk-ant-LEAKED-VALUE-0002');
  });

  it('a thrown transport call still reports call_failed and performs NO retry', async () => {
    chatMock.mockRejectedValueOnce(new Error('Anthropic error: 404 model not found'));
    const result = await runReviewUnderTest();

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.cause).toBe('call_failed');
    expect(result.verdict).toBe('unavailable');
    expect(result.error).toContain('404');
  });

  it('a missing credential still reports not_configured with zero chat calls', async () => {
    loadEnvMock.mockImplementation(() => ({}));
    const result = await runReviewUnderTest();

    expect(chatMock).toHaveBeenCalledTimes(0);
    // Anti-vacuity: zero calls ALSO happens on the "No changes to review" early
    // exit, which yields verdict 'pass' and no cause. This pins the real path.
    expect(result.cause).toBe('not_configured');
    expect(result.verdict).toBe('unavailable');
  });

  it('adds no new timeout budget — review.mjs still arms exactly one timer', () => {
    expect((REVIEW_SRC.match(/setTimeout\(/g) || []).length).toBe(1);
    expect(REVIEW_SRC).toContain('DEFAULT_LLM_TIMEOUT_MS');
    // No second timeout constant was introduced alongside it.
    expect(REVIEW_SRC).not.toMatch(/const\s+\w*RETRY\w*TIMEOUT\w*\s*=/i);
  });
});

describe('malformed_response survives to BOTH ship steps', () => {
  it('buildUnavailableReview preserves it instead of collapsing to call_failed', () => {
    expect(buildUnavailableReview({ cause: 'malformed_response' }).cause).toBe(
      'malformed_response',
    );
  });

  it('normalization is an ALLOWLIST of exactly three values, not blanket passthrough', () => {
    for (const cause of [undefined, null, '', 'nonsense', 404, {}]) {
      expect(['not_configured', 'call_failed']).toContain(
        buildUnavailableReview({ cause }).cause,
      );
    }
    expect(buildUnavailableReview({ cause: 'not_configured' }).cause).toBe('not_configured');
    expect(buildUnavailableReview({ cause: 'call_failed' }).cause).toBe('call_failed');
  });

  it('threads rawResponse when supplied and OMITS the key entirely when absent', () => {
    const withRaw = buildUnavailableReview({ cause: 'malformed_response', rawResponse: 'abc' });
    expect(withRaw.rawResponse).toBe('abc');
    const without = buildUnavailableReview({ cause: 'call_failed' });
    expect('rawResponse' in without).toBe(false);
  });

  it('buildOffRailReviewStep carries it through on the off-rail path', () => {
    const step = buildOffRailReviewStep({
      reviewerUnavailable: true,
      llmFailed: true,
      cause: 'malformed_response',
      rawResponse: 'prose the reviewer emitted',
    });
    expect(step.cause).toBe('malformed_response');
    expect(step.rawResponse).toBe('prose the reviewer emitted');
  });

  it('buildReviewStepEntry carries it through on the on-rail path', () => {
    const entry = buildReviewStepEntry({
      reviewerUnavailable: true,
      llmFailed: true,
      cause: 'malformed_response',
      rawResponse: 'prose the reviewer emitted',
    });
    expect(entry.cause).toBe('malformed_response');
    expect(entry.rawResponse).toBe('prose the reviewer emitted');
  });

  it('neither step builder gains a rawResponse key when none was supplied', () => {
    const step = buildOffRailReviewStep({ llmFailed: true, cause: 'call_failed' });
    expect('rawResponse' in step).toBe(false);
    const entry = buildReviewStepEntry({ llmFailed: true, cause: 'call_failed' });
    expect('rawResponse' in entry).toBe(false);
  });

  it('an unrecognized cause still normalizes to call_failed at both step builders', () => {
    expect(buildOffRailReviewStep({ llmFailed: true, cause: 'weird' }).cause).toBe('call_failed');
    expect(buildReviewStepEntry({ llmFailed: true, cause: 'weird' }).cause).toBe('call_failed');
  });
});
