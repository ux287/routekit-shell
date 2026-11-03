/**
 * Tests for relevanceScores in planning.snippets telemetry emit
 * (backlog.feat.telemetry-planner-snippets)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const plannerCtxSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/planner-context.mjs'),
  'utf8'
);

describe('planning.snippets — relevanceScores', () => {
  it('imports getCodeSnippetsWithScores from rag-context', () => {
    expect(plannerCtxSrc).toContain('getCodeSnippetsWithScores');
    expect(plannerCtxSrc).toContain('../rag-context.mjs');
  });

  it('fetchCodeSnippets uses getCodeSnippetsWithScores', () => {
    expect(plannerCtxSrc).toContain('await getCodeSnippetsWithScores(projectRoot, targetPath, queryText, k)');
  });

  it('success emit includes relevanceScores array', () => {
    const successBlock = plannerCtxSrc.match(/emit\("planning\.snippets"[\s\S]*?status: "success"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(successBlock).toContain('relevanceScores');
  });

  it('relevanceScores maps scoredSnippets to score values', () => {
    expect(plannerCtxSrc).toContain('relevanceScores: scoredSnippets.map(s => s.score)');
  });

  it('snippets still returned as string array (backwards compat)', () => {
    expect(plannerCtxSrc).toContain('const snippets = scoredSnippets.map(s => s.text)');
  });

  it('failure emit does NOT include relevanceScores', () => {
    // Find the failure emit by locating the catch block's emit call
    const catchIdx = plannerCtxSrc.indexOf('status: "failed"');
    const failBlock = catchIdx !== -1 ? plannerCtxSrc.slice(Math.max(0, catchIdx - 300), catchIdx + 50) : '';
    expect(failBlock).not.toContain('relevanceScores');
  });

  it('snippetsReturned uses snippets.length (not scoredSnippets)', () => {
    const successBlock = plannerCtxSrc.match(/emit\("planning\.snippets"[\s\S]*?status: "success"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(successBlock).toContain('snippetsReturned: snippets.length');
  });
});
