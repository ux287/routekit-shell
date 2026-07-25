import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Set test environment
const TEST_PROJECT_DIR = path.join(process.cwd(), '.tmp-test-session');
process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;

// Import after setting env
const {
  loadSessionState,
  saveSessionState,
  addRagSourcedPath,
  addUserSpecifiedPath,
  setPlanContext,
  clearPlanContext,
  recordRead,
  recordWrittenPath,
  hasValidProvenance,
  clearSessionState,
  advanceTurn,
  getExplorationScore,
  WRITE_LEDGER_TTL_MS
} = await import('../../packages/mcp-rks/src/shared/session-state.mjs');

const TEST_STATE_DIR = path.join(TEST_PROJECT_DIR, '.rks', 'session');
const TEST_STATE_FILE = path.join(TEST_STATE_DIR, 'state.json');

describe('SessionState', () => {
  beforeEach(() => {
    // Clean state before each test
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (fs.existsSync(TEST_STATE_FILE)) {
      fs.unlinkSync(TEST_STATE_FILE);
    }
  });

  afterEach(() => {
    // Cleanup
    try {
      fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    } catch (e) { }
  });

  describe('loadSessionState', () => {
    it('returns default state when file missing', () => {
      const state = loadSessionState();
      expect(state.ragSourcedPaths).toEqual([]);
      expect(state.userSpecifiedPaths).toEqual([]);
      expect(state.planContext).toBeNull();
      expect(state.readHistory).toEqual([]);
      expect(state.turnCount).toBe(0);
    });

    it('loads existing state from file', () => {
      const testState = {
        // Use normalized path format (no leading slash) since that's how paths are stored
        ragSourcedPaths: [{ path: 'foo.mjs', query: 'test', timestamp: Date.now(), expiresAtTurn: 10 }],
        userSpecifiedPaths: [],
        planContext: null,
        readHistory: [],
        turnCount: 2,
        updatedAt: new Date().toISOString()
      };
      // fs.writeFileSync(TEST_STATE_FILE, JSON.stringify(testState));
      saveSessionState(testState);


      const state = loadSessionState();
      expect(state.ragSourcedPaths).toHaveLength(1);
      expect(state.ragSourcedPaths[0].path).toBe('foo.mjs');
    });
  });

  describe('addRagSourcedPath', () => {
    it('adds path with query', () => {
      addRagSourcedPath('/test.mjs', 'search query');
      const state = loadSessionState();
      expect(state.ragSourcedPaths.length).toBeGreaterThanOrEqual(1);
      // normalizePath strips leading slashes, so stored path is 'test.mjs'
      const found = state.ragSourcedPaths.find(p => p.path === 'test.mjs');
      expect(found).toBeDefined();
      expect(found.query).toBe('search query');
    });
  });

  describe('hasValidProvenance', () => {
    it('returns valid for RAG-sourced path', () => {
      addRagSourcedPath('/blessed.mjs', 'query');
      const result = hasValidProvenance('/blessed.mjs');
      expect(result.valid).toBe(true);
      expect(result.source).toBe('rag');
    });

    it('returns valid for user-specified path', () => {
      addUserSpecifiedPath('/user-file.mjs', 'user said so');
      const result = hasValidProvenance('/user-file.mjs');
      expect(result.valid).toBe(true);
      expect(result.source).toBe('user');
    });

    it('returns valid for plan target', () => {
      setPlanContext('plan-123', ['/target.mjs']);
      const result = hasValidProvenance('/target.mjs');
      expect(result.valid).toBe(true);
      expect(result.source).toBe('plan');
    });

    it('returns invalid for unknown path', () => {
      const result = hasValidProvenance('/unknown.mjs');
      expect(result.valid).toBe(false);
      expect(result.source).toBeNull();
    });

    // --- session write-ledger branch (read-what-you-just-wrote) ---
    // These drive hasValidProvenance DIRECTLY — the gate redirect-read-to-agent.mjs
    // fires FIRST. The inert v0.20.28 fix passed QA precisely because the original
    // tests only drove classifyReadIntent; these close that blind spot.

    it('ORIGINAL REPRO: grants session_write for a just-written non-source path within TTL', () => {
      // No rag/user/plan provenance — only a fresh write-ledger entry.
      recordWrittenPath('/output/result.dat');
      const result = hasValidProvenance('/output/result.dat');
      expect(result.valid).toBe(true);
      expect(result.source).toBe('session_write');
    });

    it('does NOT grant once the write-ledger entry is older than WRITE_LEDGER_TTL_MS', () => {
      recordWrittenPath('/output/stale.dat');
      const s = loadSessionState();
      const entry = s.writtenPaths.find(w => w.path === 'output/stale.dat');
      entry.timestamp = Date.now() - WRITE_LEDGER_TTL_MS - 5000;
      saveSessionState(s);
      const result = hasValidProvenance('/output/stale.dat');
      expect(result.valid).toBe(false);
      expect(result.source).toBeNull();
    });

    it('grants nothing for a DIFFERENT never-written path while the ledger is non-empty (membership scoping, not blanket write-allow)', () => {
      recordWrittenPath('/output/written.dat');
      const result = hasValidProvenance('/output/never-written.dat');
      expect(result.valid).toBe(false);
      expect(result.source).toBeNull();
    });

    it('grants nothing for a path absent from THIS session ledger (session scoping)', () => {
      recordWrittenPath('/output/session-a.dat');
      // Another session keeps its own .rks/session/state.json; simulate that
      // isolation by resetting this session's ledger to empty.
      saveSessionState({ ...loadSessionState(), writtenPaths: [] });
      const result = hasValidProvenance('/output/session-a.dat');
      expect(result.valid).toBe(false);
      expect(result.source).toBeNull();
    });

    it('clearSessionState() boundary: a write-ledger grant does not survive an embed/session reset', () => {
      recordWrittenPath('/output/boundary.dat');
      expect(hasValidProvenance('/output/boundary.dat').valid).toBe(true);
      clearSessionState();
      const result = hasValidProvenance('/output/boundary.dat');
      expect(result.valid).toBe(false);
      expect(result.source).toBeNull();
    });
  });

  describe('write-ledger branch byte-parity across vendored copies', () => {
    it('both session-state.mjs copies carry the identical session_write branch', () => {
      const durablePhrase = "source: 'session_write', detail: 'read-what-you-wrote'";
      const shared = fs.readFileSync(
        path.join(process.cwd(), 'packages/mcp-rks/src/shared/session-state.mjs'), 'utf8');
      const vendored = fs.readFileSync(
        path.join(process.cwd(), 'packages/hooks/lib/session-state.mjs'), 'utf8');
      expect(shared).toContain(durablePhrase);
      expect(vendored).toContain(durablePhrase);
    });
  });

  describe('getExplorationScore', () => {
    it('returns 0 for no reads', () => {
      expect(getExplorationScore()).toBe(0);
    });

    it('increases with uncontextualized reads', () => {
      recordRead('/file1.mjs', 'unknown');
      const score1 = getExplorationScore();
      expect(score1).toBeGreaterThan(0);
    });
  });

  describe('advanceTurn', () => {
    it('increments turn count', () => {
      const before = loadSessionState().turnCount;
      advanceTurn();
      const after = loadSessionState().turnCount;
      expect(after).toBe(before + 1);
    });
  });
});
