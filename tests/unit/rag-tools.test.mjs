/**
 * Tests for RAG tools telemetry
 * (backlog.feat.telemetry-rag)
 *
 * Verifies rag.init, rag.embed, and rag.query emit calls in rag/tools.mjs.
 * All assertions are source-code based — no mocking required.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ragToolsSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/rag/tools.mjs'),
  'utf8'
);

describe('telemetry import', () => {
  it('imports getTelemetryCollector from ../server/telemetry/collector.mjs', () => {
    expect(ragToolsSrc).toContain('getTelemetryCollector');
    expect(ragToolsSrc).toContain('../server/telemetry/collector.mjs');
  });
});

describe('rag.init telemetry (runRagInit)', () => {
  it('emits rag.init event', () => {
    expect(ragToolsSrc).toContain('"rag.init"');
  });

  it('rag.init payload includes projectId derived from path.basename(projectRoot)', () => {
    const initBlock = ragToolsSrc.match(/emit\("rag\.init"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(initBlock).toContain('projectId');
    expect(ragToolsSrc).toMatch(/path\.basename\(projectRoot\)/);
  });

  it('rag.init payload includes durationMs', () => {
    const initBlock = ragToolsSrc.match(/emit\("rag\.init"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(initBlock).toContain('durationMs');
  });

  it('rag.init emits ok: true on success', () => {
    expect(ragToolsSrc).toContain('ok: true');
  });

  it('rag.init emits ok: false on failure', () => {
    expect(ragToolsSrc).toContain('ok: false');
  });

  it('rag.init telemetry errors are swallowed', () => {
    expect(ragToolsSrc).toMatch(/emit\("rag\.init"[\s\S]*?catch\s*\([^)]*\)\s*\{\s*\/\* telemetry/);
  });

  it('runRagInit public signature (projectRoot) is unchanged', () => {
    expect(ragToolsSrc).toContain('export async function runRagInit(projectRoot)');
  });
});

describe('rag.embed telemetry (runRagEmbed)', () => {
  it('emits rag.embed event', () => {
    expect(ragToolsSrc).toContain('"rag.embed"');
  });

  it('rag.embed payload includes filesProcessed from processedNotes + processedCodeFiles', () => {
    expect(ragToolsSrc).toContain('processedNotes');
    expect(ragToolsSrc).toContain('processedCodeFiles');
    expect(ragToolsSrc).toMatch(/filesProcessed.*processedNotes.*processedCodeFiles|processedNotes.*processedCodeFiles.*filesProcessed/s);
  });

  it('rag.embed payload includes chunksCreated from addedEmbeddings', () => {
    expect(ragToolsSrc).toContain('chunksCreated');
    expect(ragToolsSrc).toContain('addedEmbeddings');
  });

  it('rag.embed payload includes durationMs using startTime', () => {
    const embedBlock = ragToolsSrc.match(/emit\("rag\.embed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(embedBlock).toContain('durationMs');
    expect(embedBlock).toContain('startTime');
  });

  it('rag.embed derives projectId as path.basename(projectRoot)', () => {
    const embedBlock = ragToolsSrc.match(/emit\("rag\.embed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(embedBlock).toContain('path.basename(projectRoot)');
  });

  it('rag.embed telemetry errors are swallowed', () => {
    expect(ragToolsSrc).toMatch(/emit\("rag\.embed"[\s\S]*?catch\s*\([^)]*\)\s*\{\s*\/\* telemetry/);
  });

  it('runRagEmbed public signature (projectRoot, options = {}) is unchanged', () => {
    expect(ragToolsSrc).toContain('export async function runRagEmbed(projectRoot, options = {})');
  });
});

describe('rag.query telemetry (runRagQuery)', () => {
  it('emits rag.query event', () => {
    expect(ragToolsSrc).toContain('"rag.query"');
  });

  it('rag.query payload includes query field truncated to 200 chars', () => {
    const queryBlock = ragToolsSrc.match(/emit\("rag\.query"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(queryBlock).toContain('query:');
    expect(queryBlock).toContain('.slice(0, 200)');
  });

  it('rag.query payload includes resultsReturned from result.matches.length', () => {
    const queryBlock = ragToolsSrc.match(/emit\("rag\.query"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(queryBlock).toContain('resultsReturned');
    expect(queryBlock).toContain('matches');
  });

  it('rag.query payload includes durationMs', () => {
    const queryBlock = ragToolsSrc.match(/emit\("rag\.query"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(queryBlock).toContain('durationMs');
  });

  it('rag.query payload includes indexSize: null', () => {
    const queryBlock = ragToolsSrc.match(/emit\("rag\.query"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(queryBlock).toContain('indexSize: null');
  });

  it('rag.query telemetry errors are swallowed', () => {
    expect(ragToolsSrc).toMatch(/emit\("rag\.query"[\s\S]*?catch\s*\([^)]*\)\s*\{\s*\/\* telemetry/);
  });

  it('runRagQuery public signature (projectRoot, options) is unchanged', () => {
    expect(ragToolsSrc).toContain('export async function runRagQuery(projectRoot, options)');
  });
});

describe('collector call pattern', () => {
  it('all emits use getTelemetryCollector().emit(...) pattern', () => {
    expect(ragToolsSrc).toContain('getTelemetryCollector().emit(');
  });
});
