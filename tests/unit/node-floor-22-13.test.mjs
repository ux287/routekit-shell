/**
 * Node floor >=22.13.0 (backlog.chore.node-floor-raise-22-13).
 *
 * Static assertions only: reads workflow, package and doc files from disk.
 * Spawns no subprocess and imports no telemetry module.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const PIN_LINE_RE = /^\s*node-version:/;
const PIN_VALUE_RE = /^\s*node-version:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/;

function pinsIn(file) {
  const src = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
  return src
    .split('\n')
    .filter((line) => PIN_LINE_RE.test(line))
    .map((line) => {
      const m = line.match(PIN_VALUE_RE);
      return m ? m[1] : line.trim();
    });
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

const EXPECTED_PIN_COUNTS = {
  'check-hooks-drift.yml': 1,
  'check-licenses.yml': 1,
  'ci.yml': 4,
  'release-smoke.yml': 1,
};

const FLOOR_DOCS = [
  'notes/how-to.getting-started.prerequisites.md',
  'notes/how-to.getting-started.md',
  'notes/how-to.getting-started.installation.md',
  'notes/how-to.golden-path.md',
  'notes/how-to.surgical-install.procedure.md',
  'notes/docs.troubleshooting.md',
  'notes/docs.rag-system.mcp-integration.md',
  'notes/canon.getting-started.md',
  'notes/public.canon.getting-started.md',
  'notes/public.guide.surgical-install.md',
];

const STALE_FLOOR_LITERALS = [
  'Node.js 18',
  'Node.js 20',
  'Node.js version 18',
  'Node.js ≥18',
  '≥18',
  'nvm install 18',
  'nvm use 18',
  "node-version: '18'",
];

// Not every note ships to the public mirror; assert only the ones present.
function presentDocs() {
  return FLOOR_DOCS.filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));
}

describe('node floor 22.13 — CI workflow pins', () => {
  it('every node-version pin under .github/workflows names 22', () => {
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
    const pins = files.flatMap((f) => pinsIn(f).map((value) => ({ file: f, value })));
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin, pin.file).toEqual({ file: pin.file, value: '22' });
    }
  });

  it('the four pinned workflows keep their pin counts, 7 in total', () => {
    let total = 0;
    for (const [file, count] of Object.entries(EXPECTED_PIN_COUNTS)) {
      const pins = pinsIn(file);
      expect(pins, file).toHaveLength(count);
      total += pins.length;
    }
    expect(total).toBe(7);
  });
});

describe('node floor 22.13 — engines', () => {
  it('root package.json declares engines.node >=22.13.0', () => {
    const pkg = readJson('package.json');
    expect(pkg.engines?.node).toBe('>=22.13.0');
  });

  it('packages/rag/package.json declares engines.node >=22.13.0', () => {
    const pkg = readJson('packages/rag/package.json');
    expect(pkg.engines?.node).toBe('>=22.13.0');
  });
});

describe('node floor 22.13 — .nvmrc', () => {
  it('.nvmrc still reads 22', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8');
    expect(src.trim()).toBe('22');
  });
});

describe('node floor 22.13 — user-facing docs', () => {
  it('no listed doc states Node 18 or Node 20 as the minimum', () => {
    const docs = presentDocs();
    expect(docs.length).toBeGreaterThan(0);
    for (const rel of docs) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const literal of STALE_FLOOR_LITERALS) {
        expect(src.includes(literal), rel + ' still contains ' + literal).toBe(false);
      }
    }
  });

  it('every listed doc states Node 22.13 or later', () => {
    const docs = presentDocs();
    expect(docs.length).toBeGreaterThan(0);
    for (const rel of docs) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src.includes('22.13'), rel + ' does not state 22.13').toBe(true);
    }
  });
});
