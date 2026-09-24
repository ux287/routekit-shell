import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateSearchReplacePatterns } from '../../packages/mcp-rks/src/validation/search-replace.mjs';

// File content with two identical single-line patterns in different CREATE TABLE blocks
const AMBIGUOUS_FILE_CONTENT = `CREATE TABLE milestones (
  id INTEGER PRIMARY KEY,
  description TEXT,
  title TEXT
);

CREATE TABLE discrepancies (
  id INTEGER PRIMARY KEY,
  description TEXT,
  severity TEXT
);`;

function makeTempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-sr-test-'));
  fs.writeFileSync(path.join(dir, 'schema.sql'), content);
  return { dir, file: 'schema.sql' };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('search-replace multiline anchor', () => {
  it('ambiguous_pattern hint contains "context" and a multi-line SEARCH example', () => {
    const { dir, file } = makeTempFile(AMBIGUOUS_FILE_CONTENT);
    try {
      const plan = {
        steps: [{ id: 1, action: 'search_replace', target: file,
          edits: [{ search: '  description TEXT,', replace: '  description VARCHAR(255),' }] }]
      };
      const result = validateSearchReplacePatterns(plan, dir);
      const err = result.validationErrors?.find(e => e.refinementType === 'ambiguous_pattern');
      expect(err).toBeDefined();
      expect(err.hint).toContain('context');
      expect(err.hint.split('\n').length).toBeGreaterThanOrEqual(3);
    } finally {
      cleanup(dir);
    }
  });

  it('multi-line SEARCH uniquely matching one of two identical single lines — no ambiguous_pattern error', () => {
    const { dir, file } = makeTempFile(AMBIGUOUS_FILE_CONTENT);
    try {
      const plan = {
        steps: [{ id: 1, action: 'search_replace', target: file,
          edits: [{
            search: 'CREATE TABLE discrepancies (\n  id INTEGER PRIMARY KEY,\n  description TEXT,',
            replace: 'CREATE TABLE discrepancies (\n  id INTEGER PRIMARY KEY,\n  description VARCHAR(255),'
          }] }]
      };
      const result = validateSearchReplacePatterns(plan, dir);
      const ambiguous = result.validationErrors?.find(e => e.refinementType === 'ambiguous_pattern');
      expect(ambiguous).toBeUndefined();
    } finally {
      cleanup(dir);
    }
  });

  it('single-line SEARCH matching 2 locations still returns ambiguous_pattern (regression guard)', () => {
    const { dir, file } = makeTempFile(AMBIGUOUS_FILE_CONTENT);
    try {
      const plan = {
        steps: [{ id: 1, action: 'search_replace', target: file,
          edits: [{ search: '  description TEXT,', replace: '  description VARCHAR(255),' }] }]
      };
      const result = validateSearchReplacePatterns(plan, dir);
      const ambiguous = result.validationErrors?.find(e => e.refinementType === 'ambiguous_pattern');
      expect(ambiguous).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  it('unambiguous single-line SEARCH returns no error (regression guard)', () => {
    const { dir, file } = makeTempFile(AMBIGUOUS_FILE_CONTENT);
    try {
      const plan = {
        steps: [{ id: 1, action: 'search_replace', target: file,
          edits: [{ search: '  severity TEXT', replace: '  severity VARCHAR(255)' }] }]
      };
      const result = validateSearchReplacePatterns(plan, dir);
      expect(result.validationErrors ?? []).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});
