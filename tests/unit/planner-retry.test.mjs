import { describe, it, expect } from 'vitest';
import { getRetryPrompt, shouldEscalateToRefine, buildRefineContext } from '../../packages/mcp-rks/src/server/planner-retry.mjs';

describe('planner-retry', () => {
  describe('getRetryPrompt', () => {
    const originalPrompt = 'Original prompt text\n\n# Problem\nSample problem description';

    it('should add JSON formatting reminder for attempt 1', () => {
      const result = getRetryPrompt(originalPrompt, 1);
      expect(result).toContain('CRITICAL: Your response MUST be valid JSON');
      expect(result).toContain('Do not include markdown code fences');
    });

    it('should provide explicit format template for attempt 2', () => {
      const result = getRetryPrompt(originalPrompt, 2);
      expect(result).toContain('IMPORTANT: Previous response failed to parse');
      expect(result).toContain('"planSummary": "short summary"');
      expect(result).toContain('"steps": [');
    });

    it('should use minimal prompt for attempt 3', () => {
      const result = getRetryPrompt(originalPrompt, 3);
      expect(result).toContain('Generate a JSON plan');
      expect(result).toContain('Original request: Sample problem description');
    });

    it('should return original prompt for attempts beyond 3', () => {
      const result = getRetryPrompt(originalPrompt, 4);
      expect(result).toBe(originalPrompt);
    });
  });

  describe('shouldEscalateToRefine', () => {
    it('should return false for attempts < 3', () => {
      expect(shouldEscalateToRefine(1, 'parse_failed')).toBe(false);
      expect(shouldEscalateToRefine(2, 'invalid_json')).toBe(false);
    });

    it('should return true for attempt 3+ with parse errors', () => {
      expect(shouldEscalateToRefine(3, 'parse_failed')).toBe(true);
      expect(shouldEscalateToRefine(4, 'invalid_json')).toBe(true);
    });

    it('should return false for non-parse errors', () => {
      expect(shouldEscalateToRefine(3, 'network_error')).toBe(false);
      expect(shouldEscalateToRefine(5, 'timeout')).toBe(false);
    });
  });

  describe('buildRefineContext', () => {
    it('should build proper context from failed attempts', () => {
      const attempts = [
        { error: 'JSON parse error' },
        { error: 'Invalid format' },
        { error: 'Syntax error' }
      ];

      const context = buildRefineContext(attempts);

      expect(context.trigger).toBe('planner_parse_failures');
      expect(context.failedAttempts).toBe(3);
      expect(context.lastError).toBe('Syntax error');
      expect(context.suggestion).toContain('more explicit SEARCH/REPLACE');
    });

    it('should handle empty attempts array', () => {
      const context = buildRefineContext([]);

      expect(context.trigger).toBe('planner_parse_failures');
      expect(context.failedAttempts).toBe(0);
      expect(context.lastError).toBeUndefined();
    });
  });
});