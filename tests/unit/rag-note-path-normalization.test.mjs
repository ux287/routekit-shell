import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Deep import is fine here: this is test infra, not a production consumer scanned by
// the rag-import-redirect sole-surface rule. tools.mjs has no top-level side effects.
import * as ragTools from '@routekit/rag/tools';

const { ragPathExists } = ragTools;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Hermetic project root. Since backlog.fix.embed-note-path-base-normalization, note rows and code
// rows share one project-root-relative base, so existence is checked on the stored path literally.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-note-path-'));
fs.mkdirSync(path.join(ROOT, 'notes'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'notes', 'backlog.feat.present.md'), '# present\n');
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src', 'kept.mjs'), 'export const kept = 1;\n');
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('single path base — no compensating normalizer', () => {
  it('ragPathExists imports without a live index and ragCanonicalPath is gone', () => {
    expect(typeof ragPathExists).toBe('function');
    expect(ragTools.ragCanonicalPath).toBeUndefined();
  });
});

describe('ragPathExists — the tension table', () => {
  it('PRECONDITION — fixture note exists under notes/ and NOT at the project root', () => {
    expect(fs.existsSync(path.join(ROOT, 'notes', 'backlog.feat.present.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'backlog.feat.present.md'))).toBe(false);
  });

  it('KEEPS an existing notes/-prefixed note path', () => {
    expect(ragPathExists(ROOT, 'notes/backlog.feat.present.md')).toBe(true);
  });

  it('DROPS a bare vault-relative slug — no notes/ prefix is re-added (literal existence only)', () => {
    expect(ragPathExists(ROOT, 'backlog.feat.present.md')).toBe(false);
  });

  it('(b) DROPS a bare slug that resolves nowhere, including under notes/', () => {
    expect(ragPathExists(ROOT, 'backlog.feat.absent.md')).toBe(false);
  });

  it('DROPS a notes/-prefixed path that does not exist', () => {
    expect(ragPathExists(ROOT, 'notes/backlog.feat.absent.md')).toBe(false);
  });

  it('DROPS an absolute path that does not exist, and never prefixes it', () => {
    expect(ragPathExists(ROOT, '/definitely/not/here/backlog.feat.absent.md')).toBe(false);
  });

  it('KEEPS an existing project-root-relative code path', () => {
    expect(ragPathExists(ROOT, 'src/kept.mjs')).toBe(true);
  });

  it('DROPS a code path deleted from disk — the guard still does its original job', () => {
    expect(ragPathExists(ROOT, 'src/deleted.mjs')).toBe(false);
  });

  it('KEEPS a match with no path field', () => {
    expect(ragPathExists(ROOT, undefined)).toBe(true);
    expect(ragPathExists(ROOT, '')).toBe(true);
  });
});

describe('the notes/ rule is removed from tools.mjs', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/rag/src/tools.mjs'), 'utf8');

  it('the notes/ prefix condition and the prefix concatenation appear zero times in tools.mjs', () => {
    expect(src.split("!p.startsWith('notes/')").length - 1).toBe(0);
    expect(src.split("'notes/' + ").length - 1).toBe(0);
    expect(src).not.toMatch(/ragCanonicalPath/);
  });

  it('ragPathExists is declared once and called from both converted sites', () => {
    expect(src.split('ragPathExists(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('the _addRagSourcedPath hook call site survives the refactor', () => {
    expect(src).toContain('_addRagSourcedPath(');
  });
});
