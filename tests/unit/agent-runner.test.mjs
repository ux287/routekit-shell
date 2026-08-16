/**
 * Source-code assertions for agent runner telemetry enrichments.
 * (backlog.feat.telemetry-agent-runner)
 *
 * Verifies inputSummary on started, outputSummary on complete variants,
 * and tool-specific fields on tool_call events.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { finalizeResult } from '../../packages/mcp-rks/src/agents/runner.mjs';

const runnerSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/agents/runner.mjs'),
  'utf8'
);

describe('agent.started — inputSummary', () => {
  it('emits inputSummary on started event', () => {
    const startedBlock = runnerSrc.match(/emitTelemetry\('started'[\s\S]*?\)\s*;/)?.[0] ?? '';
    expect(startedBlock).toContain('inputSummary');
  });

  it('inputSummary is first 200 chars of userMessage', () => {
    expect(runnerSrc).toContain("inputSummary: (userMessage || '').slice(0, 200)");
  });
});

describe('agent.complete — outputSummary', () => {
  // Behavioral: the schema-validated + no-schema complete paths must still EMIT an
  // outputSummary, and it must be REDACTED (security fix backlog.security.agent-env-secret-
  // leak-redaction — outputSummary is now safeSummary = redactStringSecretsOnly(rawText…)).
  // These replace the old brittle source-substring pin on `rawText.slice(0, 200)`, which broke
  // the moment the summary was routed through redaction. Assert behavior, not source text.
  const TOKEN = 'ghp_ABCdef0123456789ABCdef0123456789'; // synthetic — not a real credential

  function captureComplete({ rawText, outputSchema }) {
    const events = [];
    finalizeResult({
      name: 'research',
      rawText,
      outputSchema,
      telemetryId: 'tid-1',
      emitTelemetry: (type, payload) => events.push({ type, payload }),
      startTime: Date.now(),
      turns: 1,
      tokens: 5,
    });
    return events.find((e) => e.type === 'complete');
  }

  it('schema-validated complete emits a redacted outputSummary (present, secret scrubbed)', () => {
    const complete = captureComplete({
      rawText: JSON.stringify({ answer: `leaked ${TOKEN} here` }),
      outputSchema: z.object({ answer: z.string() }),
    });
    expect(complete).toBeTruthy();
    expect(complete.payload.validated).toBe(true);
    expect(complete.payload.outputSummary).toBeTruthy();          // still emitted, not dropped
    expect(complete.payload.outputSummary).not.toContain(TOKEN);  // redacted
  });

  it('no-schema complete emits a redacted outputSummary', () => {
    const complete = captureComplete({
      rawText: `plain prose answer with ${TOKEN} inside`,
      outputSchema: null,
    });
    expect(complete).toBeTruthy();
    expect(complete.payload.outputSummary).toBeTruthy();
    expect(complete.payload.outputSummary).not.toContain(TOKEN);
  });

  it('all complete variants include outputSummary', () => {
    const matches = [...runnerSrc.matchAll(/outputSummary:/g)];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('short-circuit complete includes outputSummary from shortResult', () => {
    expect(runnerSrc).toContain('shortCircuit: true, outputSummary: JSON.stringify(shortResult).slice(0, 200)');
  });
});

describe('agent.tool_call — tool-specific fields', () => {
  it('read_file calls include path field', () => {
    expect(runnerSrc).toContain("toolUse.name === 'read_file'");
    expect(runnerSrc).toContain('toolExtras.path = toolUse.input.path');
  });

  it('rag_query calls include query field', () => {
    expect(runnerSrc).toContain("toolUse.name === 'rag_query'");
    expect(runnerSrc).toContain('toolExtras.query = toolUse.input.q');
  });

  it('rag_query success includes hitCount from result.matches', () => {
    expect(runnerSrc).toContain('result?.matches');
    expect(runnerSrc).toContain('hitCount');
  });

  it('tool_call error path omits hitCount', () => {
    // The catch block builds toolExtras without hitCount (only success path has it)
    const catchStart = runnerSrc.indexOf("} catch (err) {\n            const toolExtras");
    const catchEnd = runnerSrc.indexOf('emitTelemetry(\'tool_call\'', catchStart);
    const catchBlock = runnerSrc.slice(catchStart, catchEnd + 100);
    expect(catchBlock).toContain('toolExtras');
    expect(catchBlock).not.toContain('hitCount');
  });

  it('unknown tool path produces no toolExtras', () => {
    const unknownBlock = runnerSrc.match(/emitTelemetry\('tool_call',\s*\{[^}]*unknown_tool[^}]*\}\)/)?.[0] ?? '';
    expect(unknownBlock).not.toContain('toolExtras');
  });

  it('toolExtras spread into emit payload', () => {
    expect(runnerSrc).toContain('...toolExtras');
  });
});
