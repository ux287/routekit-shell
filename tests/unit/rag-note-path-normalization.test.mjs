import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Deep import is fine here: this is test infra, not a production consumer scanned by
// the rag-import-redirect sole-surface rule. tools.mjs has no top-level side effects.
import { ragCanonicalPath, ragPathExists } from '@routekit/rag/tools';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Hermetic project root reproducing the exact asymmetry embed.mjs writes:
// vault-relative from the note loop, project-root-relative from the code walk.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-note-path-'));
fs.mkdirSync(path.join(ROOT, 'notes'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'notes', 'backlog.feat.present.md'), '# present\n');
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src', 'kept.mjs'), 'export const kept = 1;\n');
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('ragCanonicalPath — the notes/ prefix rule, written once', () => {
  it('both helpers import without a live index', () => {
    expect(typeof ragCanonicalPath).toBe('function');
    expect(typeof ragPathExists).toBe('function');
  });

  it('prefixes a bare vault-relative .md slug', () => {
    expect(ragCanonicalPath('backlog.feat.present.md')).toBe('notes/backlog.feat.present.md');
  });

  it('leaves an already-prefixed, an absolute, and a non-.md path unchanged', () => {
    expect(ragCanonicalPath('notes/backlog.feat.present.md')).toBe('notes/backlog.feat.present.md');
    expect(ragCanonicalPath('/tmp/backlog.feat.present.md')).toBe('/tmp/backlog.feat.present.md');
    expect(ragCanonicalPath('packages/rag/src/tools.mjs')).toBe('packages/rag/src/tools.mjs');
  });
});

describe('ragPathExists — the tension table', () => {
  it('PRECONDITION — fixture note exists under notes/ and NOT at the project root', () => {
    expect(fs.existsSync(path.join(ROOT, 'notes', 'backlog.feat.present.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'backlog.feat.present.md'))).toBe(false);
  });

  it('(a) KEEPS a bare slug whose notes/ form exists — the defect being fixed', () => {
    expect(ragPathExists(ROOT, 'backlog.feat.present.md')).toBe(true);
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

describe('the rule lives in exactly one place', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/rag/src/tools.mjs'), 'utf8');

  it('the notes/ prefix condition appears exactly once in tools.mjs', () => {
    expect(src.split("!p.startsWith('notes/')").length - 1).toBe(1);
  });

  it('ragPathExists is declared once and called from both converted sites', () => {
    expect(src.split('ragPathExists(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('the _addRagSourcedPath hook call site survives the refactor', () => {
    expect(src).toContain('_addRagSourcedPath(');
  });
});
