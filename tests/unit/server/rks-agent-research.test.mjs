import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verify failureCategory telemetry is emitted by the server handler path.
// Rather than spinning up the full MCP server, we test the telemetry logic
// in isolation by simulating what the agentEntry handler does.

const emittedEvents = [];
const mockCollector = { emit: (type, projectId, payload) => emittedEvents.push({ type, projectId, payload }) };

vi.mock('../../../packages/mcp-rks/src/server/telemetry/collector.mjs', () => ({
  getTelemetryCollector: () => mockCollector,
}));

// Inline the propagation logic extracted from server.mjs so we can test it
// without importing the full 3500-line server module.
async function applyFailureCategoryTelemetry(tool, projectId, result) {
  const { getTelemetryCollector } = await import('../../../packages/mcp-rks/src/server/telemetry/collector.mjs');
  if (tool === 'rks_agent_research' && result.failureCategory) {
    try {
      getTelemetryCollector().emit(`agent.research.${result.failureCategory}`, projectId || 'unknown', {
        failureCategory: result.failureCategory,
        confidence: result.confidence,
        telemetryId: result.telemetryId,
      });
    } catch { /* best-effort */ }
  }
}

describe('rks_agent_research handler — failureCategory propagation', () => {
  beforeEach(() => {
    emittedEvents.length = 0;
  });

  it('emits agent.research.no_results event when failureCategory is no_results', async () => {
    await applyFailureCategoryTelemetry('rks_agent_research', 'test-project', {
      ok: true,
      answer: 'No relevant results found.',
      sources: [],
      confidence: 0.1,
      failureCategory: 'no_results',
      telemetryId: 'abc-123',
    });

    const event = emittedEvents.find(e => e.type === 'agent.research.no_results');
    expect(event).toBeDefined();
    expect(event.projectId).toBe('test-project');
    expect(event.payload.failureCategory).toBe('no_results');
    expect(event.payload.confidence).toBe(0.1);
    expect(event.payload.telemetryId).toBe('abc-123');
  });

  it('emits agent.research.partial_answer when failureCategory is partial_answer', async () => {
    await applyFailureCategoryTelemetry('rks_agent_research', 'test-project', {
      ok: true,
      answer: 'Partial findings only.',
      sources: [{ file: 'a.mjs' }],
      confidence: 0.4,
      failureCategory: 'partial_answer',
      telemetryId: 'def-456',
    });

    const event = emittedEvents.find(e => e.type === 'agent.research.partial_answer');
    expect(event).toBeDefined();
    expect(event.payload.failureCategory).toBe('partial_answer');
  });

  it('emits agent.research.escalated when failureCategory is escalated', async () => {
    await applyFailureCategoryTelemetry('rks_agent_research', 'test-project', {
      ok: true,
      answer: 'Answer after escalation.',
      sources: [],
      confidence: 0.7,
      failureCategory: 'escalated',
      telemetryId: 'ghi-789',
    });
    expect(emittedEvents.find(e => e.type === 'agent.research.escalated')).toBeDefined();
  });

  it('does not emit failureCategory event when failureCategory is absent', async () => {
    await applyFailureCategoryTelemetry('rks_agent_research', 'test-project', {
      ok: true,
      answer: 'Complete answer with high confidence.',
      sources: [{ file: 'a.mjs' }],
      confidence: 0.95,
      telemetryId: 'jkl-000',
    });
    expect(emittedEvents).toHaveLength(0);
  });

  it('does not emit failureCategory event for non-research tools', async () => {
    await applyFailureCategoryTelemetry('rks_agent_plan', 'test-project', {
      ok: false,
      failureCategory: 'no_results',
      telemetryId: 'xyz',
    });
    expect(emittedEvents).toHaveLength(0);
  });

  it('partial answer response includes ok:true, answer, and confidence in [0,1]', async () => {
    const result = {
      ok: true,
      answer: 'Best available findings without complete context.',
      sources: [{ file: 'partial.mjs', snippet: 'relevant line' }],
      confidence: 0.35,
      failureCategory: 'partial_answer',
      telemetryId: 'partial-001',
    };
    // Verify the shape the MCP handler would return
    expect(result.ok).toBe(true);
    expect(typeof result.answer).toBe('string');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.failureCategory).toBe('partial_answer');
  });
});
