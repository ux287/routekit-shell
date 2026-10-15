/**
 * Contract enforcement tests for External Research Agent
 *
 * These tests verify the Zod schemas reject invalid shapes, enforce required
 * fields, and guarantee structured failure. No external API calls needed —
 * these test the contract, not the integration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExternalResearchInputSchema,
  ExternalResearchOutputSchema,
  runExternalResearch,
} from '../../src/agents/external-research.mjs';

// --- Input Contract ---

describe('ExternalResearchInputSchema', () => {
  it('rejects missing query', () => {
    assert.throws(
      () => ExternalResearchInputSchema.parse({ projectId: 'test' }),
      /required/i
    );
  });

  it('rejects query under 5 characters', () => {
    assert.throws(
      () => ExternalResearchInputSchema.parse({ projectId: 'test', query: 'ab' }),
      /at least 5/i
    );
  });

  it('rejects maxSources over 20', () => {
    assert.throws(
      () => ExternalResearchInputSchema.parse({ projectId: 'test', query: 'valid query', maxSources: 25 }),
    );
  });

  it('rejects unknown provider', () => {
    assert.throws(
      () => ExternalResearchInputSchema.parse({ projectId: 'test', query: 'valid query', provider: 'google' }),
    );
  });

  it('accepts valid input and applies defaults', () => {
    const input = ExternalResearchInputSchema.parse({ projectId: 'test', query: 'AI coding tools market' });
    assert.equal(input.maxSources, 10);
    assert.equal(input.provider, 'brave');
  });

  it('accepts explicit maxSources within range', () => {
    const input = ExternalResearchInputSchema.parse({ projectId: 'test', query: 'valid query', maxSources: 5 });
    assert.equal(input.maxSources, 5);
  });
});

// --- Output Contract ---

describe('ExternalResearchOutputSchema', () => {
  it('validates proper success response', () => {
    const output = ExternalResearchOutputSchema.parse({
      ok: true,
      answer: 'Market analysis shows...',
      sources: [{ title: 'Source 1', url: 'https://example.com', snippet: 'relevant text' }],
      telemetryId: 'abc-123-def',
    });
    assert.equal(output.ok, true);
    assert.equal(output.sources.length, 1);
  });

  it('validates structured failure response', () => {
    const output = ExternalResearchOutputSchema.parse({
      ok: false,
      answer: '',
      sources: [],
      telemetryId: 'abc-123-def',
      error: 'No API key configured',
    });
    assert.equal(output.ok, false);
    assert.ok(output.error);
  });

  it('validates empty sources array', () => {
    const output = ExternalResearchOutputSchema.parse({
      ok: true,
      answer: 'No results found.',
      sources: [],
      telemetryId: 'abc-123',
    });
    assert.deepEqual(output.sources, []);
  });

  it('rejects output missing required fields', () => {
    assert.throws(() => ExternalResearchOutputSchema.parse({ ok: true }));
  });

  it('rejects output missing answer', () => {
    assert.throws(() => ExternalResearchOutputSchema.parse({
      ok: true,
      sources: [],
      telemetryId: 'abc',
    }));
  });

  it('rejects output missing telemetryId', () => {
    assert.throws(() => ExternalResearchOutputSchema.parse({
      ok: true,
      answer: 'test',
      sources: [],
    }));
  });

  it('rejects source with invalid URL', () => {
    assert.throws(() => ExternalResearchOutputSchema.parse({
      ok: true,
      answer: 'test',
      sources: [{ title: 'test', url: 'not-a-url', snippet: 'text' }],
      telemetryId: 'abc',
    }));
  });

  it('rejects source missing required fields', () => {
    assert.throws(() => ExternalResearchOutputSchema.parse({
      ok: true,
      answer: 'test',
      sources: [{ title: 'test' }],
      telemetryId: 'abc',
    }));
  });
});

// --- Structured Failure Guarantee ---

describe('runExternalResearch structured failures', () => {
  it('returns structured failure when BRAVE_SEARCH_API_KEY is missing', async () => {
    const original = process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const result = await runExternalResearch({ projectId: 'routekit-shell', query: 'test query here' });
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('BRAVE_SEARCH_API_KEY'));
      assert.ok(result.telemetryId, 'must include telemetryId even on failure');
      assert.deepEqual(result.sources, []);
      assert.equal(result.answer, '');
    } finally {
      if (original) process.env.BRAVE_SEARCH_API_KEY = original;
    }
  });

  it('never throws — always returns structured response', async () => {
    const original = process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const result = await runExternalResearch({ projectId: 'routekit-shell', query: 'test query here' });
      assert.equal(typeof result, 'object');
      assert.equal(result.ok, false);
      assert.equal(typeof result.telemetryId, 'string');
      assert.ok(result.telemetryId.length > 0, 'telemetryId must be non-empty');
    } finally {
      if (original) process.env.BRAVE_SEARCH_API_KEY = original;
    }
  });

  it('includes telemetryId as valid UUID on failure', async () => {
    const original = process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const result = await runExternalResearch({ projectId: 'routekit-shell', query: 'test query here' });
      assert.match(result.telemetryId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    } finally {
      if (original) process.env.BRAVE_SEARCH_API_KEY = original;
    }
  });
});
