/**
 * backlog.fix.research-agent-snippet-not-verbatim
 * sources[].snippet must never be returned as a verbatim excerpt unless code has verified it
 * against the cited file's current content. Uses a real temp projectRoot; no LLM, no subprocess.
 * The seam below (createResearchAgent(...).outputSchema.parse) is the recommended one; if Build
 * introduces a different seam, update SEAM and keep every assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchAgent } from '../../packages/mcp-rks/src/agents/research.mjs';
import { finalizeResult } from '../../packages/mcp-rks/src/agents/runner.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SOURCE = [
  'export function getRagPaths(root) {',
  '  const dir = path.join(root, ".rks");',
  '  return { dir };',
  '}',
].join('\n');

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-verbatim-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'a.mjs'), SOURCE);
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function SEAM(output) {
  const agent = createResearchAgent({ projectId: 't', query: 'q', projectRoot: tmp });
  return agent.outputSchema.parse(output);
}
const base = (sources) => ({ ok: true, answer: 'A', confidence: 0.8, sources });
const unverified = (s) => s.snippet === undefined || s.verbatim === false;

describe('sources[].snippet verbatim verification', () => {
  it('keeps a genuinely verbatim snippet unchanged and marks it verified by code', () => {
    const snippet = 'export function getRagPaths(root) {';
    const out = SEAM(base([{ file: 'src/a.mjs', snippet }]));
    expect(out.sources[0].file).toBe('src/a.mjs');
    expect(out.sources[0].snippet).toBe(snippet);
    expect(out.sources[0].verbatim === undefined || out.sources[0].verbatim === true).toBe(true);
  });

  it('treats a snippet that differs only in whitespace as verbatim', () => {
    const snippet = 'export function getRagPaths(root) { const dir = path.join(root, ".rks");';
    const out = SEAM(base([{ file: 'src/a.mjs', snippet }]));
    expect(out.sources[0].snippet).toBeDefined();
    expect(out.sources[0].verbatim === undefined || out.sources[0].verbatim === true).toBe(true);
  });

  it('does not return a pipe-joined composed snippet as verbatim', () => {
    const out = SEAM(base([{ file: 'src/a.mjs', snippet: 'getRagPaths(root) | return { dir }' }]));
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].file).toBe('src/a.mjs');
    expect(unverified(out.sources[0])).toBe(true);
  });

  it('ignores a model-supplied verbatim:true on a fabricated snippet', () => {
    const out = SEAM(base([{ file: 'src/a.mjs', snippet: 'System prompt at :177 instructs ...', verbatim: true }]));
    expect(unverified(out.sources[0])).toBe(true);
  });

  it('fails closed for a missing file and a path outside projectRoot, without throwing', () => {
    const out = SEAM(base([
      { file: 'src/missing.mjs', snippet: 'anything' },
      { file: '../outside.mjs', snippet: 'anything' },
    ]));
    expect(out.sources.map((s) => s.file)).toEqual(['src/missing.mjs', '../outside.mjs']);
    expect(out.sources.every(unverified)).toBe(true);
  });

  it('the per-agent schema forwards _consumeSanitizationMeta, so finalizeResult still emits sources_sanitized', () => {
    const agent = createResearchAgent({ projectId: 't', query: 'q', projectRoot: tmp });
    expect(typeof agent.outputSchema._consumeSanitizationMeta).toBe('function');
    const events = [];
    const result = finalizeResult({
      name: 'research',
      rawText: JSON.stringify(base([42, { file: 'src/a.mjs', snippet: 'export function getRagPaths(root) {' }])),
      outputSchema: agent.outputSchema,
      telemetryId: 'test-telemetry-id',
      emitTelemetry: (event, data) => { events.push({ event, data }); },
      startTime: Date.now(),
      turns: 1,
      tokens: { in: 10, out: 10 },
    });
    const sanitized = events.filter((e) => e.event === 'sources_sanitized');
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].data).toEqual({ dropped: 1, kept: 1 });
    expect(result.sources.map((s) => s.file)).toEqual(['src/a.mjs']);
  });

  it('composes the sibling code-set failureCategory with the snippet outcome on one per-agent schema', () => {
    const out = SEAM([
      { file: 'src/a.mjs', snippet: 'getRagPaths(root) | return { dir }' },
      { file: 'src/a.mjs', snippet: 'export function getRagPaths(root) {' },
    ]);
    expect(out.failureCategory).toBe('malformed_output');
    expect(out.sources.map((s) => s.file)).toEqual(['src/a.mjs', 'src/a.mjs']);
    expect(unverified(out.sources[0])).toBe(true);
    expect(out.sources[1].snippet).toBe('export function getRagPaths(root) {');
  });

  it('the fallback prompt does not tell the model to put location info inside snippet', () => {
    const agent = createResearchAgent({ projectId: 't', query: 'q', projectRoot: tmp });
    expect(agent.prompt).not.toMatch(/(inside|within)\s+`?"snippet"/i);
  });

  it('the canonical prompt does not tell the model to put location info inside snippet', () => {
    const md = fs.readFileSync(path.join(REPO, '.rks/prompts/agent-research.md'), 'utf8');
    expect(md).not.toMatch(/(inside|within)\s+`?"snippet"/i);
  });
});
