/**
 * backlog.feat.eval-rag-retrieval-runner — deterministic in-process runner for eval rag-retrieval-v1.
 * tools.mjs is mocked (no ONNX / LanceDB). Fixture repos are temp git repos; every spawn has a timeout.
 * NEVER paste a real rag-retrieval-v1 question string into this file: tests/ is indexed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const hooks = vi.hoisted(() => ({ current: {}, skipEmitFor: null }));
vi.mock('../../packages/rag/src/tools.mjs', () => ({
  setRagHostHooks: vi.fn((h = {}) => {
    hooks.current = h;
  }),
  runRagQuery: vi.fn(async (_root, opts) => {
    // Simulates tools.mjs's best-effort emit failing silently for one question.
    if (opts.q === hooks.skipEmitFor) return { results: [] };
    hooks.current.getTelemetryCollector?.().emit('rag.query', 'fixture', {
      query: opts.q,
      k: opts.k,
      intent: 'neutral',
      ranked: [
        { rank: 1, path: 'notes/other.note.md' },
        { rank: 2, path: 'notes/gold.one.md' },
      ],
      candidates: [{ semanticRank: 4, id: 'c1', path: 'notes/gold.one.md', semanticScore: 0.5 }],
    });
    return { results: [] };
  }),
}));

const tools = await import('../../packages/rag/src/tools.mjs');
const runQueryCallsAtImport = tools.runRagQuery.mock.calls.length;
const setHooksCallsAtImport = tools.setRagHostHooks.mock.calls.length;
const mod = await import('../../scripts/eval-rag-retrieval.mjs');
const runQueryCallsAfterImport = tools.runRagQuery.mock.calls.length;
const setHooksCallsAfterImport = tools.setRagHostHooks.mock.calls.length;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/eval-rag-retrieval.mjs';
const RESULTS_REL = 'evals/rag-retrieval-v1/results';
const dirs = [];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A committed, clean fixture repo. .rks/ and the results dir are gitignored, as .rks/rag/ is in this repo. */
function makeRepo({ manifest = true } = {}) {
  const root = tmp('rks-eval-rag-');
  mkdirSync(join(root, 'evals/rag-retrieval-v1'), { recursive: true });
  writeFileSync(
    join(root, 'evals/rag-retrieval-v1/questions.json'),
    JSON.stringify({
      id: 'rag-retrieval-v1',
      questions: [
        { id: 'Q01', category: 'fixture', q: 'synthetic fixture prompt alpha', gold: ['gold.one'] },
        { id: 'Q02', category: 'fixture', q: 'synthetic fixture prompt beta', gold: ['gold.two'] },
      ],
    }),
  );
  writeFileSync(join(root, '.gitignore'), `.rks/\n${RESULTS_REL}/\n`);
  if (manifest) {
    mkdirSync(join(root, '.rks/rag'), { recursive: true });
    writeFileSync(join(root, '.rks/rag/embed-manifest.json'), JSON.stringify({ hashes: { 'notes/a.md': 'h1' } }));
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=qa@example.invalid', '-c', 'user.name=qa', 'commit', '-q', '-m', 'fixture');
  return root;
}

const today = () => new Date().toISOString().slice(0, 10);
const resultsFileOf = (root) =>
  join(root, RESULTS_REL, `${today()}-${git(root, 'rev-parse', '--short=9', 'HEAD')}.json`);

let consoleSpies = [];
beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  // Restore only the console spies: restoring every mock would strip the tools.mjs mock implementations.
  for (const s of consoleSpies) s.mockRestore();
  tools.runRagQuery.mockClear();
  tools.setRagHostHooks.mockClear();
  hooks.skipEmitFor = null;
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('eval-rag-retrieval module', () => {
  it('exports the eight functions and importing it does not run main', () => {
    for (const name of [
      'slugOf',
      'goldMatches',
      'scoreQuestion',
      'aggregate',
      'indexDigestOf',
      'questionSetDigestOf',
      'writeResultsAppendOnly',
      'main',
    ]) {
      expect(typeof mod[name], name).toBe('function');
    }
    expect(runQueryCallsAfterImport).toBe(runQueryCallsAtImport);
    expect(setHooksCallsAfterImport).toBe(setHooksCallsAtImport);
  });

  it('source wires no provenance hook and imports nothing from packages/mcp-rks', () => {
    const src = readFileSync(resolve(ROOT, SCRIPT), 'utf8');
    expect(src).toContain('setRagHostHooks(');
    expect(src).not.toContain('addRagSourcedPath');
    expect(src).not.toMatch(/from\s+['"][^'"]*packages\/mcp-rks\//);
    expect(src).not.toMatch(/import\(\s*['"][^'"]*packages\/mcp-rks\//);
    expect(src).not.toMatch(/import\s+['"][^'"]*packages\/mcp-rks\//);
  });
});

describe('goldMatches', () => {
  it('matches exactly, by prefix only for a trailing *, and never for a null slug', () => {
    expect(mod.goldMatches('how-to.x', ['how-to.x'])).toBe(true);
    expect(mod.goldMatches('how-to.x.y', ['how-to.x'])).toBe(false);
    expect(mod.goldMatches('how-to.x.y', ['how-to.x*'])).toBe(true);
    expect(mod.goldMatches('other.x', ['how-to.x*'])).toBe(false);
    expect(mod.goldMatches(null, ['how-to.x', 'how-to*'])).toBe(false);
  });
});

describe('scoreQuestion', () => {
  const payloadWithGoldAt = (rank) => ({
    k: 10,
    intent: 'neutral',
    ranked: Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      path: i + 1 === rank ? 'notes/gold.note.md' : `notes/filler.${i + 1}.md`,
    })),
    candidates: [],
  });

  it('scores a gold note at rank 3 as hit5, hit10 and rr10 1/3', () => {
    const s = mod.scoreQuestion(payloadWithGoldAt(3), ['gold.note']);
    expect(s.rank).toBe(3);
    expect(s.hit5).toBe(true);
    expect(s.hit10).toBe(true);
    expect(s.rr10).toBeCloseTo(1 / 3, 10);
  });

  it('scores a gold note at rank 8 as hit10 but not hit5', () => {
    const s = mod.scoreQuestion(payloadWithGoldAt(8), ['gold.note']);
    expect(s.rank).toBe(8);
    expect(s.hit5).toBe(false);
    expect(s.hit10).toBe(true);
  });

  it('returns the no-hit result when no gold note is ranked, and throws for a null payload', () => {
    const noHit = { rank: null, hit5: false, hit10: false, rr10: 0 };
    expect(mod.scoreQuestion(payloadWithGoldAt(3), ['absent.note'])).toMatchObject(noHit);
    expect(() => mod.scoreQuestion(null, ['gold.note'])).toThrow(TypeError);
    expect(() => mod.scoreQuestion(undefined, ['gold.note'])).toThrow(TypeError);
  });
});

describe('aggregate', () => {
  it('returns n, hit5 and hit10 counts, and mrr10 as the mean rr10 rounded to 3 decimals', () => {
    const rows = [
      { hit5: true, hit10: true, rr10: 1 / 3 },
      { hit5: false, hit10: true, rr10: 1 / 8 },
      { hit5: false, hit10: false, rr10: 0 },
    ];
    expect(mod.aggregate(rows)).toEqual({ n: 3, hit5: 1, hit10: 2, mrr10: 0.153 });
  });
});

describe('indexDigestOf', () => {
  it('is independent of key order and changes when any hash changes', () => {
    const a = mod.indexDigestOf({ hashes: { 'notes/a.md': 'h1', 'notes/b.md': 'h2' } });
    const b = mod.indexDigestOf({ hashes: { 'notes/b.md': 'h2', 'notes/a.md': 'h1' } });
    const c = mod.indexDigestOf({ hashes: { 'notes/a.md': 'h1', 'notes/b.md': 'h3' } });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});

describe('writeResultsAppendOnly', () => {
  it('writes a new file, then refuses the same path and leaves its bytes unchanged', () => {
    const file = join(tmp('rks-eval-wx-'), 'nested', 'r.json');
    expect(mod.writeResultsAppendOnly(file, { first: true })).toBe(true);
    const before = readFileSync(file);
    expect(mod.writeResultsAppendOnly(file, { second: true })).toBe(false);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe('main', () => {
  it('returns 2 and writes no results file when the working tree is dirty', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'untracked.txt'), 'dirty\n');
    expect(await mod.main(root)).toBe(2);
    expect(existsSync(join(root, RESULTS_REL))).toBe(false);
    expect(tools.runRagQuery).not.toHaveBeenCalled();
  });

  it('returns 2 and writes no results file when the embed manifest is absent', async () => {
    const root = makeRepo({ manifest: false });
    expect(await mod.main(root)).toBe(2);
    expect(existsSync(join(root, RESULTS_REL))).toBe(false);
    expect(tools.runRagQuery).not.toHaveBeenCalled();
  });

  it('returns 3 and leaves an existing results file for today and HEAD unchanged', async () => {
    const root = makeRepo();
    const file = resultsFileOf(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"existing":true}\n');
    const before = readFileSync(file);
    expect(await mod.main(root)).toBe(3);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('returns 4, writes no results file and names the question when its rag.query payload is not captured', async () => {
    const root = makeRepo();
    hooks.skipEmitFor = 'synthetic fixture prompt beta';
    expect(mod.EXIT_UNCAPTURED).toBe(4);
    expect(await mod.main(root)).toBe(4);
    expect(existsSync(join(root, RESULTS_REL))).toBe(false);
    expect(tools.runRagQuery).toHaveBeenCalledTimes(2);
    const errs = consoleSpies[0].mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errs).toContain('Q02');
    expect(consoleSpies[1]).not.toHaveBeenCalled();
  });

  it('writes a results file with the recorded fields and id-only rows', async () => {
    const root = makeRepo();
    expect(await mod.main(root)).toBe(0);
    const file = resultsFileOf(root);
    expect(existsSync(file)).toBe(true);
    const r = JSON.parse(readFileSync(file, 'utf8'));
    const sha = git(root, 'rev-parse', '--short=9', 'HEAD');
    expect(r.anchor).toBe(`@${sha}`);
    expect(r.indexDigest).toBe(mod.indexDigestOf({ hashes: { 'notes/a.md': 'h1' } }));
    expect(r.questionSet).toBe('rag-retrieval-v1');
    expect(r.questionSetDigest).toBe(
      mod.questionSetDigestOf(readFileSync(join(root, 'evals/rag-retrieval-v1/questions.json'))),
    );
    expect(r.runner).toBe('script');
    expect(r.k).toBe(10);
    expect(r.aggregate).toEqual({ n: 2, hit5: 1, hit10: 1, mrr10: 0.25 });
    expect(r.rows.map((x) => x.id)).toEqual(['Q01', 'Q02']);
    for (const row of r.rows) {
      for (const f of ['q', 'path', 'ranked', 'candidates']) expect(row, `${row.id} ${f}`).not.toHaveProperty(f);
    }
    expect(readFileSync(file, 'utf8')).not.toContain('synthetic fixture prompt');
    expect(tools.runRagQuery).toHaveBeenCalledTimes(2);
    for (const [, opts] of tools.runRagQuery.mock.calls) {
      expect(opts.k).toBe(10);
      expect(opts).not.toHaveProperty('intent');
    }
  });

  it('calls setRagHostHooks with getTelemetryCollector only', async () => {
    const root = makeRepo();
    expect(await mod.main(root)).toBe(0);
    expect(tools.setRagHostHooks).toHaveBeenCalled();
    for (const [arg] of tools.setRagHostHooks.mock.calls) {
      expect(Object.keys(arg)).toEqual(['getTelemetryCollector']);
    }
  });
});

describe('eval:rag registration', () => {
  it('root package.json declares eval:rag as the only eval script and keeps the rag scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['eval:rag']).toBe('node scripts/eval-rag-retrieval.mjs');
    expect(Object.keys(pkg.scripts).filter((k) => k.startsWith('eval'))).toEqual(['eval:rag']);
    expect(pkg.scripts['rag:init']).toBe('node packages/rag/src/init.mjs');
    expect(pkg.scripts['rag:embed']).toBe('node packages/rag/src/embed.mjs');
    expect(pkg.scripts['rag:query']).toBe('node packages/rag/src/query.mjs');
  });

  it('catalog lists rag-retrieval-v1 with runner [governor, script] and the other entries unchanged', () => {
    const byId = Object.fromEntries(
      yaml.load(readFileSync(resolve(ROOT, 'evals/catalog.yaml'), 'utf8')).evals.map((e) => [e.id, e]),
    );
    const e = byId['rag-retrieval-v1'];
    expect(e.runner).toEqual(['governor', 'script']);
    expect(e.subject).toBe('retrieval');
    expect(e.status).toBe('active');
    expect(e.gate).toBeNull();
    expect(e.goldFile).toBe('evals/rag-retrieval-v1/questions.json');
    expect(e.baseline.results).toBe('evals/rag-retrieval-v1/results/2026-11-10-f9d04b7f7.json');
    expect(byId['answer-quality-v0'].runner).toEqual(['script']);
    expect(byId['answer-quality-v0'].status).toBe('candidate');
    expect(byId['telemetry-health'].runner).toBeNull();
    expect(byId['telemetry-health'].status).toBe('planned');
  });

  it('README names the script and its command as the script runner', () => {
    const md = readFileSync(resolve(ROOT, 'evals/README.md'), 'utf8');
    expect(md).toContain('scripts/eval-rag-retrieval.mjs');
    expect(md).toContain('npm run eval:rag');
    expect(md).toContain('exit 4');
    expect(md).toContain('`indexDigest` is a sha256 of `.rks/rag/embed-manifest.json`');
  });
});
