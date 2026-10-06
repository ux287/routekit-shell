/**
 * Tests for getCodeSnippetsWithScores in rag-context.mjs
 * (backlog.feat.telemetry-planner-snippets)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ragContextSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/rag-context.mjs'),
  'utf8'
);

describe('getCodeSnippetsWithScores export', () => {
  it('exports getCodeSnippetsWithScores', () => {
    expect(ragContextSrc).toContain('export async function getCodeSnippetsWithScores');
  });

  it('getCodeSnippets is still exported unchanged', () => {
    expect(ragContextSrc).toContain('export async function getCodeSnippets');
  });

  it('getCodeSnippetsWithScores returns text and score fields', () => {
    const fn = ragContextSrc.match(/export async function getCodeSnippetsWithScores[\s\S]*?^}/m)?.[0] ?? '';
    expect(fn).toContain('_rankSnippets');
  });

  it('_rankSnippets returns {text, score} objects', () => {
    expect(ragContextSrc).toContain('{ text, score: row._score }');
  });

  it('both functions use _rankSnippets for scoring', () => {
    expect(ragContextSrc).toContain('_rankSnippets(fileChunks, queryText, k).map(s => s.text)');
    expect(ragContextSrc).toContain('return _rankSnippets(fileChunks, queryText, k)');
  });

  it('scores sorted descending (highest relevance first)', () => {
    const rankFn = ragContextSrc.match(/function _rankSnippets[\s\S]*?^}/m)?.[0] ?? '';
    expect(rankFn).toContain('b._score');
    expect(rankFn).toContain('a._score');
  });

  it('results capped at k', () => {
    const rankFn = ragContextSrc.match(/function _rankSnippets[\s\S]*?^}/m)?.[0] ?? '';
    expect(rankFn).toContain('result.length >= k');
  });

  it('empty array returned when no chunks found', () => {
    const fn = ragContextSrc.match(/export async function getCodeSnippetsWithScores[\s\S]*?^}/m)?.[0] ?? '';
    expect(fn).toContain('if (fileChunks.length === 0) return []');
  });
});
