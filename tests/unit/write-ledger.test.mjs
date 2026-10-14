/**
 * Tests for the session write-ledger — Finding #1 of the clean-machine UAT triage
 * (backlog.feat.read-provenance-session-write-ledger).
 *
 * The read-provenance guardrail used to block a session from reading a file it
 * JUST WROTE. The fix records Edit/Write paths in a session write-ledger and adds
 * a narrow allow branch in classifyReadIntent, immediately before the default
 * block. This suite pins the four security-relevant scenarios:
 *   1. a ledgered path is ALLOWED without provenance (reason `session_write`)
 *   2. a non-ledgered path still hits the default block (no regression)
 *   3. a written path older than WRITE_LEDGER_TTL_MS no longer grants the read
 *   4. the exemption is scoped to actual ledger membership + wiped at the session
 *      boundary (clearSessionState / embed) — it does not leak
 *
 * Non-code (.dat) paths are used throughout so the project_source heuristic
 * (which would allow any .mjs/.js/... regardless) can't mask the ledger behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Set test environment BEFORE importing the modules (both compute PROJECT_DIR at import)
const TEST_PROJECT_DIR = path.join(process.cwd(), '.tmp-test-write-ledger');
process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;

const TEST_STATE_DIR = path.join(TEST_PROJECT_DIR, '.rks', 'session');
const TEST_STATE_FILE = path.join(TEST_STATE_DIR, 'state.json');

const {
  loadSessionState,
  saveSessionState,
  recordWrittenPath,
  clearSessionState,
  WRITE_LEDGER_TTL_MS,
} = await import('../../packages/mcp-rks/src/shared/session-state.mjs');
const { classifyReadIntent } = await import('../../packages/mcp-rks/src/shared/read-classification.mjs');

const blockConfig = { mode: 'block', strict_rag_paths: [], runtime_paths: [] };

function classify(targetPath) {
  return classifyReadIntent({
    targetPath,
    toolName: 'Read',
    toolInput: { file_path: targetPath },
    config: blockConfig,
  });
}

describe('session write-ledger', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
    if (fs.existsSync(TEST_STATE_FILE)) fs.unlinkSync(TEST_STATE_FILE);
  });

  afterEach(() => {
    try { fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true }); } catch (e) {}
  });

  it('Scenario 1: a ledgered path is ALLOWED without provenance (reason session_write)', () => {
    recordWrittenPath('/output/result.dat');
    const result = classify('/output/result.dat');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('session_write');
    expect(result.metadata.provenanceSource).toBe('session_write');
    expect(result.metadata.matchedRule).toBe('writtenPaths');
  });

  it('Scenario 2: a non-ledgered path still hits the default block (no regression)', () => {
    recordWrittenPath('/output/result.dat');           // ledger is non-empty…
    const result = classify('/some/other.dat');        // …but this path was never written
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unknown');
    expect(result.suggestion).toMatch(/Path has no provenance/);
    expect(result.metadata.matchedRule).toBe('default:mode=block');
  });

  it('Scenario 3: a written path older than WRITE_LEDGER_TTL_MS no longer grants the read', () => {
    recordWrittenPath('/output/stale.dat');
    // Age the entry past the TTL by rewriting its timestamp (timestamp-compare, like GIT_CACHE_TTL_MS)
    const state = loadSessionState();
    const entry = state.writtenPaths.find(p => p.path === 'output/stale.dat');
    expect(entry).toBeDefined();
    entry.timestamp = Date.now() - WRITE_LEDGER_TTL_MS - 1000;
    saveSessionState(state);

    const result = classify('/output/stale.dat');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unknown');
  });

  it('Scenario 3b: a fresh (within-TTL) written path is still granted', () => {
    recordWrittenPath('/output/fresh.dat');
    const state = loadSessionState();
    const entry = state.writtenPaths.find(p => p.path === 'output/fresh.dat');
    entry.timestamp = Date.now() - (WRITE_LEDGER_TTL_MS - 5000); // just inside the window
    saveSessionState(state);

    const result = classify('/output/fresh.dat');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('session_write');
  });

  it('Scenario 4: the exemption is scoped to actual ledger membership, not a blanket write-allow', () => {
    recordWrittenPath('/output/a.dat');
    expect(classify('/output/a.dat').allowed).toBe(true);   // recorded → allowed
    expect(classify('/output/b.dat').allowed).toBe(false);  // sibling, never recorded → blocked
  });

  it('Scenario 4b: the ledger is wiped at the session boundary (clearSessionState / embed)', () => {
    recordWrittenPath('/output/boundary.dat');
    expect(classify('/output/boundary.dat').allowed).toBe(true);

    clearSessionState(); // simulate embed-on-commit session reset

    const result = classify('/output/boundary.dat');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unknown');
    // ledger field is emptied, and clearSessionState reports it
    expect(loadSessionState().writtenPaths).toEqual([]);
    expect(clearSessionState().cleared).toContain('writtenPaths');
  });

  describe('recordWrittenPath', () => {
    it('normalizes the leading slash before storing', () => {
      recordWrittenPath('/foo/bar.dat');
      const found = loadSessionState().writtenPaths.find(p => p.path === 'foo/bar.dat');
      expect(found).toBeDefined();
      expect(found.timestamp).toBeGreaterThan(0);
    });

    it('dedupes by path and refreshes the timestamp instead of appending', () => {
      recordWrittenPath('/dup/file.dat');
      const first = loadSessionState().writtenPaths.find(p => p.path === 'dup/file.dat');
      const firstTs = first.timestamp;
      // backdate so a refresh is observable
      const s = loadSessionState();
      s.writtenPaths.find(p => p.path === 'dup/file.dat').timestamp = firstTs - 10_000;
      saveSessionState(s);

      recordWrittenPath('/dup/file.dat');
      const entries = loadSessionState().writtenPaths.filter(p => p.path === 'dup/file.dat');
      expect(entries).toHaveLength(1);                       // no duplicate
      expect(entries[0].timestamp).toBeGreaterThan(firstTs - 10_000); // refreshed
    });

    it('writtenPaths is present on a fresh default state', () => {
      const state = loadSessionState();
      expect(state.writtenPaths).toEqual([]);
    });
  });
});
