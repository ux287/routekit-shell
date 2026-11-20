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
import { finalizeResult, runAgent } from '../../packages/mcp-rks/src/agents/runner.mjs';

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

describe('agent.tool_call — ok derived from the result (API executor)', () => {
  // Drives runAgent through the _testClient / _testCollector seams: one scripted tool_use turn,
  // then an end_turn text turn. Tools are injected; nothing reaches a real model or index.
  const NAME = 'okderive';
  const USAGE = { input_tokens: 1, output_tokens: 1 };
  const injected = (name, execute) => ({
    name,
    description: `injected ${name}`,
    inputSchema: z.object({ q: z.string().optional(), path: z.string().optional() }),
    execute,
  });
  async function toolCallsFor(tools, toolUses) {
    const emits = [];
    let n = 0;
    const client = {
      messages: {
        create: async () => (++n === 1
          ? { content: toolUses.map((u, i) => ({ type: 'tool_use', id: `t${i}`, ...u })), stop_reason: 'tool_use', usage: USAGE }
          : { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: USAGE }),
      },
    };
    await runAgent({
      name: NAME,
      prompt: 'system',
      userMessage: 'hi',
      tools,
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      rawInput: { q: 'hi' },
      projectId: 'test',
      model: 'claude-haiku-4-5-20251001',
      maxTurns: 4,
      _testClient: client,
      _testCollector: { emit: (type, projectId, payload) => emits.push({ type, payload }) },
    });
    return emits.filter((e) => e.type === `agent.${NAME}.tool_call`).map((e) => e.payload);
  }

  it('a budget-refused rag_query and an error-result read_file emit ok false with budgetExhausted and error', async () => {
    const refusal = { ok: false, budgetExhausted: 'rag_query', error: 'rag_query budget exhausted (2/2). No further rag_query calls are available.' };
    const events = await toolCallsFor(
      [injected('rag_query', async () => refusal), injected('read_file', async () => ({ error: 'File not found: x' }))],
      [{ name: 'rag_query', input: { q: 'three' } }, { name: 'read_file', input: { path: 'x' } }],
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tool: 'rag_query', ok: false, budgetExhausted: 'rag_query', query: 'three' });
    expect(events[1]).toMatchObject({ tool: 'read_file', ok: false, error: 'File not found: x', path: 'x' });
    expect('budgetExhausted' in events[1]).toBe(false);
    for (const ev of events) expect(typeof ev.durationMs).toBe('number');
  });

  it('a successful rag_query still emits ok true with hitCount', async () => {
    const events = await toolCallsFor(
      [injected('rag_query', async () => ({ matches: ['a', 'b'] }))],
      [{ name: 'rag_query', input: { q: 'alpha' } }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: 'rag_query', ok: true, query: 'alpha', hitCount: 2 });
    expect('error' in events[0]).toBe(false);
    expect('budgetExhausted' in events[0]).toBe(false);
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
