import { describe, it, expect } from 'vitest';
import { inferQueryIntent } from '../../../packages/mcp-rks/src/rag/query-intent.mjs';

describe('inferQueryIntent', () => {
  describe('current-state', () => {
    it('detects "how does" queries', () => {
      expect(inferQueryIntent('how does /build work?')).toBe('current-state');
    });
    it('detects "how do I" queries', () => {
      expect(inferQueryIntent('how do I run the ship skill?')).toBe('current-state');
    });
    it('detects "show me" queries', () => {
      expect(inferQueryIntent('show me the research agent config')).toBe('current-state');
    });
    it('detects "where is" queries', () => {
      expect(inferQueryIntent('where is the query.mjs file?')).toBe('current-state');
    });
    it('detects "what is the current" queries', () => {
      expect(inferQueryIntent('what is the current branch config?')).toBe('current-state');
    });
  });

  describe('planning', () => {
    it('detects "backlog" queries', () => {
      expect(inferQueryIntent('what is in the backlog for rag?')).toBe('planning');
    });
    it('detects "plan" queries', () => {
      expect(inferQueryIntent('what is the plan for phase 4?')).toBe('planning');
    });
    it('detects "story" queries', () => {
      expect(inferQueryIntent('what story covers rag-content-type-tagging?')).toBe('planning');
    });
    it('detects "roadmap" queries', () => {
      expect(inferQueryIntent('what is on the roadmap?')).toBe('planning');
    });
    it('detects "what should" queries', () => {
      expect(inferQueryIntent('what should we build next?')).toBe('planning');
    });
  });

  describe('neutral', () => {
    it('returns neutral for unmatched queries', () => {
      expect(inferQueryIntent('list all files in the project')).toBe('neutral');
    });
    it('returns neutral for empty string', () => {
      expect(inferQueryIntent('')).toBe('neutral');
    });
    it('returns neutral for null/undefined', () => {
      expect(inferQueryIntent(null)).toBe('neutral');
      expect(inferQueryIntent(undefined)).toBe('neutral');
    });
  });

  describe('return value contract', () => {
    it('always returns one of exactly three values', () => {
      const valid = new Set(['current-state', 'planning', 'neutral']);
      const queries = [
        'how does X work?', 'what is in the backlog?', 'random query', '',
        'show me the config', 'design a new feature', 'how do I build this?',
      ];
      for (const q of queries) {
        expect(valid.has(inferQueryIntent(q))).toBe(true);
      }
    });
  });
});
