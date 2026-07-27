/**
 * Emit-seam witness for backlog.fix.research-agent-sources-sanitized-emit.
 *
 * The research agent's ResearchOutputSchema silently drops bare-primitive sources[] entries.
 * This change records the drop count in a same-frame, consume-once slot (research.mjs) and emits
 * exactly one agent.research.sources_sanitized event at the finalizeResult call site (runner.mjs),
 * which runs once per run and owns emitTelemetry.
 *
 * These tests drive the REAL exported finalizeResult with the REAL ResearchOutputSchema and a
 * capturing emitTelemetry (no live LLM, no subprocess) — the pattern the story sanctions
 * ("call the exported finalizeResult directly with a capture emitTelemetry"). Note: finalizeResult
 * receives emitTelemetry already scoped to `agent.<name>.` by the runner closure, so it calls
 * emitTelemetry('sources_sanitized', …) — the agent.research. prefix is applied by that closure.
 */
import { describe, it, expect } from 'vitest';
import { finalizeResult } from '../../packages/mcp-rks/src/agents/runner.mjs';
import { ResearchOutputSchema } from '../../packages/mcp-rks/src/agents/research.mjs';

function drive(output, { throwOnEmit = false } = {}) {
  const events = [];
  const emitTelemetry = (event, data) => {
    events.push({ event, data });
    if (throwOnEmit && event === 'sources_sanitized') throw new Error('sink boom');
  };
  const result = finalizeResult({
    name: 'research',
    rawText: JSON.stringify(output),
    outputSchema: ResearchOutputSchema,
    telemetryId: 'test-telemetry-id',
    emitTelemetry,
    startTime: Date.now(),
    turns: 1,
    tokens: { in: 10, out: 10 },
  });
  const sanitizedEvents = events.filter(e => e.event === 'sources_sanitized');
  return { result, events, sanitizedEvents };
}

describe('sources_sanitized emit — finalizeResult seam', () => {
  it('EMIT ON DROP: one event whose dropped/kept match the real sanitized result', () => {
    const { result, sanitizedEvents } = drive({
      ok: true, answer: 'A', confidence: 0.9,
      sources: [{ file: 'a.mjs' }, 42, { file: 'b.mjs', snippet: 'x' }, 'bare-line'],
    });
    expect(sanitizedEvents).toHaveLength(1);
    expect(sanitizedEvents[0].data.dropped).toBe(2); // 42 and 'bare-line'
    expect(sanitizedEvents[0].data.kept).toBe(2);    // the two well-formed objects
    // counts match the actual validated output
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual([{ file: 'a.mjs' }, { file: 'b.mjs', snippet: 'x' }]);
    expect(sanitizedEvents[0].data.kept).toBe(result.sources.length);
  });

  it('NO EMIT WHEN CLEAN: a well-formed sources[] emits zero sources_sanitized events', () => {
    const { result, sanitizedEvents } = drive({
      ok: true, answer: 'A', confidence: 0.9,
      sources: [{ file: 'a.mjs' }, { file: 'b.mjs', snippet: 'x' }],
    });
    expect(sanitizedEvents).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual([{ file: 'a.mjs' }, { file: 'b.mjs', snippet: 'x' }]);
  });

  it('BEHAVIOR UNCHANGED: well-formed preserved+ordered, primitives dropped, all-primitive → [] + advisory', () => {
    // mixed: order preserved, primitives dropped
    const mixed = drive({
      ok: true, answer: 'A', confidence: 0.5,
      sources: [{ file: 'first.mjs' }, 7, { file: 'second.mjs' }],
    });
    expect(mixed.result.sources).toEqual([{ file: 'first.mjs' }, { file: 'second.mjs' }]);
    // all-primitive → normalized to [] and advisory:true (transform), answer preserved, ok:true
    const allPrim = drive({ ok: true, answer: 'design opinion', confidence: 0.4, sources: [1, 2, 'x'] });
    expect(allPrim.result.ok).toBe(true);
    expect(allPrim.result.sources).toEqual([]);
    expect(allPrim.result.advisory).toBe(true);
    expect(allPrim.result.answer).toBe('design opinion');
    expect(allPrim.sanitizedEvents[0].data).toEqual({ dropped: 3, kept: 0 });
  });

  it('SINGLE-EMIT-PER-RUN: exactly one event per finalize, and consume-once clears the record', () => {
    const { sanitizedEvents } = drive({
      ok: true, answer: 'A', confidence: 0.9, sources: [{ file: 'a.mjs' }, 'x', 'y'],
    });
    expect(sanitizedEvents).toHaveLength(1);
    // consume-once: the record was cleared by finalize, so a second consume yields null
    expect(ResearchOutputSchema._consumeSanitizationMeta()).toBeNull();
  });

  it('BEST-EFFORT: a throwing sink does not break the validated result or throw', () => {
    let result;
    expect(() => {
      ({ result } = drive(
        { ok: true, answer: 'A', confidence: 0.9, sources: [{ file: 'a.mjs' }, 'x'] },
        { throwOnEmit: true },
      ));
    }).not.toThrow();
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual([{ file: 'a.mjs' }]);
  });

  it('DIRECT PARSE DOES NOT EMIT: parse drops primitives, records meta, but has no emit path', () => {
    const parsed = ResearchOutputSchema.parse({
      ok: true, answer: 'A', confidence: 0.9, sources: [{ file: 'a.mjs' }, 99],
    });
    expect(parsed.sources).toEqual([{ file: 'a.mjs' }]); // identical sanitized output
    // The drop is recorded (so finalize CAN emit), but parse itself has no emitTelemetry — the
    // emit lives only at the finalize call site. Consuming here proves the record exists and clears it.
    const meta = ResearchOutputSchema._consumeSanitizationMeta();
    expect(meta).toEqual({ dropped: 1, kept: 1 });
    expect(ResearchOutputSchema._consumeSanitizationMeta()).toBeNull();
  });
});
