/**
 * Tests for QA Agent Review
 *
 * Tests the falsification-minded QA agent that reviews planned tests:
 * - Identifies exploitable gaps in test coverage
 * - Blocks exec when critical gaps found
 * - Uses TDD classification in assessment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Anthropic before importing the module
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ text: JSON.stringify({
          verdict: 'pass',
          exploitableGaps: [],
          missingTestCases: [],
          reasoning: 'Tests appear adequate',
          disappointment: 'Could not find exploitable gap in null handling',
        })}],
      }),
    },
  })),
}));


describe('QA Agent Review', () => {
  // The QA agent now enforces a shared invoke-time credential gate (assertAnthropicCredential)
  // before constructing the Anthropic SDK. These tests mock the SDK to exercise the happy path
  // (verdict parse / telemetry / block logic), so provide a value-free dummy key: the guard checks
  // presence only, so this lets the gate pass and the mocked client run. afterEach restores the
  // original value, keeping the spec hermetic to ambient CI keys.
  // Regression fix for backlog.feat.mcp-boot-keyfree-credential-gate.
  let _savedAnthropicKey;
  beforeEach(() => {
    vi.clearAllMocks();
    _savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  });
  afterEach(() => {
    if (_savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = _savedAnthropicKey;
  });

  it('returns pass when no exploitable gaps found', async () => {
    const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');

    const result = await runQaAgentReview({
      plan: { steps: [] },
      tddApplicable: 'strong',
      testCode: 'it("handles null", () => { expect(fn(null)).toThrow(); })',
      implementationCode: 'function fn(x) { if (!x) throw new Error(); }',
      projectId: 'test',
    });

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.disappointment).toBeDefined();
  });

  it('blocks when critical gaps found', async () => {
    // Re-mock with blocking response
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ text: JSON.stringify({
              verdict: 'block',
              exploitableGaps: ['No null check on user input'],
              missingTestCases: ['Test null user ID'],
              reasoning: 'User ID is passed to DB without validation',
            })}],
          }),
        },
      })),
    }));

    const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');

    const result = await runQaAgentReview({
      plan: { steps: [] },
      tddApplicable: 'strong',
      testCode: 'it("creates user", () => { expect(createUser({name: "test"})).toBeDefined(); })',
      implementationCode: 'function createUser(user) { db.insert(user); }',
      projectId: 'test',
    });

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.exploitableGaps).toContain('No null check on user input');
  });

  it('returns warn verdict without blocking', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ text: JSON.stringify({
              verdict: 'warn',
              exploitableGaps: ['Edge case not covered'],
              missingTestCases: ['Test with empty array'],
              reasoning: 'Empty array case could behave unexpectedly',
            })}],
          }),
        },
      })),
    }));

    const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');

    const result = await runQaAgentReview({
      plan: { steps: [] },
      tddApplicable: 'moderate',
      testCode: 'it("processes items", () => { expect(process([1,2])).toEqual([2,4]); })',
      implementationCode: 'function process(items) { return items.map(x => x * 2); }',
      projectId: 'test',
    });

    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.verdict).toBe('warn');
    expect(result.exploitableGaps).toContain('Edge case not covered');
  });

  it('handles API errors gracefully without blocking', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
        },
      })),
    }));

    const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');

    const result = await runQaAgentReview({
      plan: { steps: [] },
      tddApplicable: 'strong',
      testCode: 'some test code',
      implementationCode: 'some impl code',
      projectId: 'test',
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(false); // Don't block on API errors
    expect(result.error).toContain('rate limit');
  });

  it('handles non-JSON response gracefully', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ text: 'This is not valid JSON but contains useful feedback' }],
          }),
        },
      })),
    }));

    const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');

    const result = await runQaAgentReview({
      plan: { steps: [] },
      tddApplicable: 'unknown',
      testCode: 'test code',
      implementationCode: 'impl code',
      projectId: 'test',
    });

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('warn');
    expect(result.reasoning).toContain('useful feedback');
  });

  it('uses tddApplicable classification in prompt', async () => {
    vi.resetModules();
    let capturedPrompt = '';
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockImplementation(async (params) => {
            capturedPrompt = params.messages[0].content;
            return {
              content: [{ text: JSON.stringify({ verdict: 'pass', exploitableGaps: [] }) }],
            };
          }),
        },
      })),
    }));

    const { runQaAgentReview } = await import('../../packages/mcp-rks/src/server/qa-agent.mjs');

    await runQaAgentReview({
      plan: { steps: [] },
      tddApplicable: 'strong',
      testCode: 'test',
      implementationCode: 'impl',
      projectId: 'test',
    });

    expect(capturedPrompt).toContain('STORY CLASSIFICATION: strong');
  });
});
