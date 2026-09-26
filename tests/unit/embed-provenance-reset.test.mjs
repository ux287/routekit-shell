import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  loadSessionState,
  saveSessionState,
  clearSessionState,
  addRagSourcedPath,
  addUserSpecifiedPath,
  advanceTurn
} from '../../packages/mcp-rks/src/shared/session-state.mjs';
import { classifyReadIntent } from '../../packages/mcp-rks/src/shared/read-classification.mjs';

const SESSION_DIR = path.join(process.cwd(), '.rks', 'session');

describe('Embed-based Provenance Reset', () => {
  beforeEach(() => {
    // Clear session state before each test
    clearSessionState();
  });

  afterEach(() => {
    // Clean up after each test
    clearSessionState();
  });

  describe('Provenance Persistence Without TTL', () => {
    it('should keep RAG-sourced paths valid across multiple turns', () => {
      // Add a RAG-sourced path
      addRagSourcedPath('/test/file.js', 'find JavaScript files');

      // Verify initial provenance
      let classification = classifyReadIntent({
        targetPath: '/test/file.js',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(true);
      expect(classification.reason).toBe('rag_sourced');

      // Advance many turns (old TTL would have expired after 5)
      for (let i = 0; i < 10; i++) {
        advanceTurn();
      }

      // Path should still be valid (no TTL decay)
      classification = classifyReadIntent({
        targetPath: '/test/file.js',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(true);
      expect(classification.reason).toBe('rag_sourced');
    });

    it('should keep user-specified paths valid across multiple turns', () => {
      // Add a user-specified path
      addUserSpecifiedPath('/src/utils.js', 'check the utility functions');

      // Verify initial provenance
      let classification = classifyReadIntent({
        targetPath: '/src/utils.js',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(true);
      expect(classification.reason).toBe('user_specified');

      // Advance many turns (old TTL would have expired after 5)
      for (let i = 0; i < 8; i++) {
        advanceTurn();
      }

      // Path should still be valid (no TTL decay)
      classification = classifyReadIntent({
        targetPath: '/src/utils.js',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(true);
      expect(classification.reason).toBe('user_specified');
    });
  });

  describe('Embed Event Reset', () => {
    it('should clear all provenance when clearSessionState is called', () => {
      // Setup initial state with multiple types of provenance
      addRagSourcedPath('/rag/file.js', 'RAG query result');
      addUserSpecifiedPath('/user/file.js', 'user mentioned this');
      advanceTurn();
      advanceTurn();

      // Verify provenance exists
      const stateBefore = loadSessionState();
      expect(stateBefore.ragSourcedPaths.length).toBeGreaterThan(0);
      expect(stateBefore.userSpecifiedPaths.length).toBeGreaterThan(0);
      expect(stateBefore.turnCount).toBeGreaterThan(0);

      // Clear session state (simulate embed event)
      clearSessionState();

      // Verify everything is cleared
      const stateAfter = loadSessionState();
      expect(stateAfter.ragSourcedPaths.length).toBe(0);
      expect(stateAfter.userSpecifiedPaths.length).toBe(0);
      expect(stateAfter.readHistory.length).toBe(0);
      expect(stateAfter.turnCount).toBe(0);
    });

    it('should require fresh provenance after session clear', () => {
      // Use a non-code-extension path to avoid project_source heuristic
      addRagSourcedPath('/cleared/data.dat', 'initial query');

      let classification = classifyReadIntent({
        targetPath: '/cleared/data.dat',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(true);

      // Clear session state
      clearSessionState();

      // Path should now be blocked (no provenance)
      // Using non-code extension avoids project_source heuristic which would allow .yaml/.json files
      classification = classifyReadIntent({
        targetPath: '/cleared/data.dat',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(false);
      expect(classification.reason).toBe('unknown');
      expect(classification.suggestion).toMatch(/Path has no provenance/);
    });

    it('should return result object from clearSessionState', () => {
      addRagSourcedPath('/test/file.js', 'test');

      const result = clearSessionState();

      expect(result.ok).toBe(true);
      expect(result.cleared).toContain('ragSourcedPaths');
      expect(result.cleared).toContain('userSpecifiedPaths');
      expect(result.cleared).toContain('readHistory');
      expect(result.cleared).toContain('turnCount');
    });
  });

  describe('Session Boundary Behavior', () => {
    it('should demonstrate complete work session cycle', () => {
      // Phase 1: Start new work session, query RAG
      addRagSourcedPath('/work/target.js', 'find implementation files');
      addUserSpecifiedPath('/work/config.dat', 'also check the config');

      // Phase 2: Work with discovered files across multiple turns
      for (let i = 0; i < 5; i++) {
        const ragClassification = classifyReadIntent({
          targetPath: '/work/target.js',
          toolName: 'Read',
          config: { mode: 'block' }
        });
        const userClassification = classifyReadIntent({
          targetPath: '/work/config.dat',
          toolName: 'Read',
          config: { mode: 'block' }
        });

        expect(ragClassification.allowed).toBe(true);
        expect(userClassification.allowed).toBe(true);

        advanceTurn();
      }

      // Phase 3: Complete work, commit triggers embed, session resets
      clearSessionState();

      // Phase 4: Next work session - need fresh provenance
      // Use non-code extension to test blocking (avoids project_source heuristic)
      const classification = classifyReadIntent({
        targetPath: '/work/config.dat',
        toolName: 'Read',
        config: { mode: 'block' }
      });
      expect(classification.allowed).toBe(false);
      expect(classification.suggestion).toMatch(/Path has no provenance/);
    });

    it('should handle multiple clear cycles', () => {
      // First work session
      addRagSourcedPath('/cycle1/file.js', 'first session');
      expect(loadSessionState().ragSourcedPaths.length).toBe(1);

      clearSessionState();
      expect(loadSessionState().ragSourcedPaths.length).toBe(0);

      // Second work session
      addRagSourcedPath('/cycle2/file.js', 'second session');
      addUserSpecifiedPath('/cycle2/other.js', 'second session user');
      expect(loadSessionState().ragSourcedPaths.length).toBe(1);
      expect(loadSessionState().userSpecifiedPaths.length).toBe(1);

      clearSessionState();
      expect(loadSessionState().ragSourcedPaths.length).toBe(0);
      expect(loadSessionState().userSpecifiedPaths.length).toBe(0);
    });
  });
});
