/**
 * backlog.feat.eval-suite-skeleton — structural assertions over the evals/ suite,
 * the rag-retrieval-v1 gold set and baseline, the README conventions, and the
 * research paper that no longer holds question text.
 * NEVER paste a question string into this file: tests/ is indexed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const FIELDS = ['id', 'subject', 'runner', 'goldFile', 'metrics', 'baseline', 'gate', 'owner', 'status'];
const IDS = Array.from({ length: 30 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`);
const PAPER = 'notes/research.2026.11.10.rag-retrieval-eval.md';
const QUESTIONS = 'evals/rag-retrieval-v1/questions.json';
const RESULTS = 'evals/rag-retrieval-v1/results/2026-11-10-f9d04b7f7.json';

const catalog = () => yaml.load(read('evals/catalog.yaml'));
const questions = () => JSON.parse(read(QUESTIONS)).questions;
const leakedIn = (text) =>
  questions()
    .filter((q) => typeof q.q === 'string' && q.q.length > 0 && text.includes(q.q))
    .map((q) => q.id);

describe('eval catalog', () => {
  it('parses and every entry carries all nine fields with unique ids', () => {
    const cat = catalog();
    expect(Array.isArray(cat.evals)).toBe(true);
    expect(cat.evals.length).toBeGreaterThan(0);
    for (const e of cat.evals) {
      for (const f of FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(e, f), `${e.id} missing ${f}`).toBe(true);
      }
    }
    const ids = cat.evals.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists rag-retrieval-v1 as an active governor retrieval eval whose gold and baseline files exist', () => {
    const e = catalog().evals.find((x) => x.id === 'rag-retrieval-v1');
    expect(e).toBeDefined();
    expect(e.subject).toBe('retrieval');
    expect(e.runner).toEqual(['governor', 'script']);
    expect(e.status).toBe('active');
    expect(existsSync(resolve(ROOT, e.goldFile))).toBe(true);
    expect(existsSync(resolve(ROOT, e.baseline.results))).toBe(true);
  });

  it('every runner is null or a non-empty list of governor or script', () => {
    for (const e of catalog().evals) {
      if (e.runner === null) continue;
      expect(Array.isArray(e.runner), `${e.id} runner`).toBe(true);
      expect(e.runner.length, `${e.id} runner`).toBeGreaterThan(0);
      for (const r of e.runner) expect(['governor', 'script']).toContain(r);
    }
  });

  it('lists non-retrieval subjects answer-quality-v0 and telemetry-health that are not active', () => {
    const byId = Object.fromEntries(catalog().evals.map((e) => [e.id, e]));
    for (const id of ['answer-quality-v0', 'telemetry-health']) {
      expect(byId[id], id).toBeDefined();
      expect(byId[id].subject).not.toBe('retrieval');
      expect(byId[id].status).not.toBe('active');
    }
  });
});

describe('rag-retrieval-v1 gold set', () => {
  it('has exactly 30 questions Q01-Q30 in order, each with a string q, a category and non-empty gold', () => {
    const qs = questions();
    expect(qs.map((q) => q.id)).toEqual(IDS);
    for (const q of qs) {
      expect(typeof q.q, q.id).toBe('string');
      expect(q.q.length, q.id).toBeGreaterThan(0);
      expect(typeof q.category, q.id).toBe('string');
      expect(Array.isArray(q.gold) && q.gold.length > 0, q.id).toBe(true);
    }
  });
});

describe('rag-retrieval-v1 baseline results', () => {
  it('parses with 30 id-keyed rows, no question text, and aggregates that agree with rows', () => {
    const raw = read(RESULTS);
    const r = JSON.parse(raw);
    expect(r.rows.map((x) => x.id)).toEqual(IDS);
    for (const row of r.rows) {
      expect(row).not.toHaveProperty('q');
      expect(row).not.toHaveProperty('question');
    }
    expect(leakedIn(raw)).toEqual([]);
    expect(r.aggregate.n).toBe(30);
    expect(r.rows.filter((x) => x.hit5 === true).length).toBe(9);
    expect(r.rows.filter((x) => x.hit10 === true).length).toBe(11);
    expect(r.aggregate.hit5).toBe(9);
    expect(r.aggregate.hit10).toBe(11);
  });
});

describe('research paper', () => {
  it('contains none of the 30 question strings', () => {
    const paper = read(PAPER);
    // positive control: the paper is read and still refers to questions by id
    expect(paper).toContain('Q01');
    expect(leakedIn(paper)).toEqual([]);
  });

  it('still states the baseline numbers and points to the gold file', () => {
    const paper = read(PAPER);
    expect(paper).toContain('9/30');
    expect(paper).toContain('11/30');
    expect(paper).toContain('0.191');
    expect(paper).toContain('evals/rag-retrieval-v1/questions.json');
  });
});

describe('evals README', () => {
  it('states the suite conventions and the five script-runner conditions', () => {
    const md = read('evals/README.md');
    expect(md).toContain('Definitions live outside the index');
    expect(md).toContain('evals/<id>/results/<YYYY-MM-DD>-<sha>.json');
    expect(md).toContain('never rewritten');
    expect(md).toContain('by ID only');
    expect(md).toContain('rks_exhaustive_search');
    for (const k of ['`anchor`', '`indexDigest`', '`questionSetDigest`', '`governor`', '`script`']) {
      expect(md).toContain(k);
    }
    expect(md).toMatch(/1\. It is not a Governor tool/);
    expect(md).toMatch(/2\. Every run writes one append-only results file/);
    expect(md).toMatch(/3\. Governors cite its results files/);
    expect(md).toMatch(/4\. Its question set lives under `evals\/`/);
    expect(md).toMatch(/5\. It grants no read provenance/);
    expect(md).toContain('rks_rag_query');
    expect(md).toContain('Governor tool list');
  });
});
