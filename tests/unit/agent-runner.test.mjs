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
  it('schema-validated complete includes outputSummary', () => {
    expect(runnerSrc).toContain('validated: true, outputSummary: rawText.slice(0, 200)');
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
