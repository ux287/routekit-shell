import { describe, it, expect } from 'vitest';
import {
  applyFidelity,
  getEffectiveFidelity,
  filterByFidelity,
  FIDELITY_LEVELS,
  DEFAULT_FIDELITY
} from '../../packages/mcp-rks/src/rag/fidelity-filter.mjs';

describe('applyFidelity', () => {
  const sampleResult = {
    id: 'chunk-123',
    path: 'notes/backlog.feature.test.md',
    score: 0.85,
    source_class: 'project',
    text: 'This is the full content with password: hunter2 and more text here that goes on...',
    title: 'Test Feature'
  };

  describe('L0 - Metadata only', () => {
    it('returns only metadata without text', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L0_METADATA);
      expect(result.text).toBeNull();
      expect(result.preview).toBeNull();
      expect(result.fidelity).toBe('L0');
      expect(result.path).toBe(sampleResult.path);
      expect(result.score).toBe(sampleResult.score);
    });

    it('preserves id and source_class', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L0_METADATA);
      expect(result.id).toBe(sampleResult.id);
      expect(result.source_class).toBe(sampleResult.source_class);
    });
  });

  describe('L1 - Abstracted', () => {
    it('returns summary without raw content', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L1_ABSTRACTED);
      expect(result.text).toBeNull();
      expect(result.summary).toContain(sampleResult.path);
      expect(result.fidelity).toBe('L1');
    });

    it('includes character count in summary', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L1_ABSTRACTED);
      expect(result.summary).toContain(`${sampleResult.text.length} chars`);
    });
  });

  describe('L2 - Redacted preview', () => {
    it('returns capped preview with redactions', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L2_REDACTED);
      expect(result.text).toBeNull();
      expect(result.preview).toBeDefined();
      expect(result.preview).toContain('[REDACTED]');
      expect(result.fidelity).toBe('L2');
    });

    it('caps preview at 200 chars plus ellipsis', () => {
      const longText = 'x'.repeat(300);
      const longResult = { ...sampleResult, text: longText };
      const result = applyFidelity(longResult, FIDELITY_LEVELS.L2_REDACTED);
      expect(result.preview.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(result.preview).toContain('...');
    });

    it('includes fullLength for reference', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L2_REDACTED);
      expect(result.fullLength).toBe(sampleResult.text.length);
    });

    it('redacts password patterns', () => {
      const secretResult = { ...sampleResult, text: 'config: password=s3cr3t and token: abc123' };
      const result = applyFidelity(secretResult, FIDELITY_LEVELS.L2_REDACTED);
      expect(result.preview).toContain('[REDACTED]');
      expect(result.preview).not.toContain('s3cr3t');
    });
  });

  describe('L3 - Full text', () => {
    it('returns complete content', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L3_FULL);
      expect(result.text).toBe(sampleResult.text);
      expect(result.fidelity).toBe('L3');
    });

    it('preserves all metadata', () => {
      const result = applyFidelity(sampleResult, FIDELITY_LEVELS.L3_FULL);
      expect(result.path).toBe(sampleResult.path);
      expect(result.score).toBe(sampleResult.score);
      expect(result.title).toBe(sampleResult.title);
    });
  });

  describe('edge cases', () => {
    it('handles undefined text gracefully', () => {
      const noText = { ...sampleResult, text: undefined };
      const result = applyFidelity(noText, FIDELITY_LEVELS.L2_REDACTED);
      expect(result.preview).toBe('');
      expect(result.fullLength).toBe(0);
    });

    it('handles null text gracefully', () => {
      const nullText = { ...sampleResult, text: null };
      const result = applyFidelity(nullText, FIDELITY_LEVELS.L2_REDACTED);
      expect(result.preview).toBe('');
    });

    it('defaults to L2 when no fidelity specified', () => {
      const result = applyFidelity(sampleResult);
      expect(result.fidelity).toBe('L2');
    });
  });
});

describe('getEffectiveFidelity', () => {
  it('caps fidelity by source class ceiling', () => {
    // Sensitive defaults to L0
    expect(getEffectiveFidelity('sensitive', FIDELITY_LEVELS.L3_FULL)).toBe(FIDELITY_LEVELS.L0_METADATA);

    // Project defaults to L2
    expect(getEffectiveFidelity('project', FIDELITY_LEVELS.L3_FULL)).toBe(FIDELITY_LEVELS.L2_REDACTED);

    // Public allows L3
    expect(getEffectiveFidelity('public', FIDELITY_LEVELS.L3_FULL)).toBe(FIDELITY_LEVELS.L3_FULL);
  });

  it('respects legal source class ceiling', () => {
    expect(getEffectiveFidelity('legal', FIDELITY_LEVELS.L3_FULL)).toBe(FIDELITY_LEVELS.L0_METADATA);
  });

  it('respects client source class ceiling', () => {
    expect(getEffectiveFidelity('client', FIDELITY_LEVELS.L3_FULL)).toBe(FIDELITY_LEVELS.L1_ABSTRACTED);
  });

  it('respects overrides from capability token', () => {
    const overrides = { project: FIDELITY_LEVELS.L3_FULL };
    expect(getEffectiveFidelity('project', FIDELITY_LEVELS.L3_FULL, overrides)).toBe(FIDELITY_LEVELS.L3_FULL);
  });

  it('never exceeds requested fidelity', () => {
    // Even if override allows L3, if L1 requested, return L1
    const overrides = { project: FIDELITY_LEVELS.L3_FULL };
    expect(getEffectiveFidelity('project', FIDELITY_LEVELS.L1_ABSTRACTED, overrides)).toBe(FIDELITY_LEVELS.L1_ABSTRACTED);
  });

  it('defaults to L2 for unknown source class', () => {
    expect(getEffectiveFidelity('unknown-class', FIDELITY_LEVELS.L3_FULL)).toBe(FIDELITY_LEVELS.L2_REDACTED);
  });
});

describe('filterByFidelity', () => {
  it('applies fidelity to all results', () => {
    const results = [
      { id: '1', path: 'a.md', text: 'content a', source_class: 'project' },
      { id: '2', path: 'b.md', text: 'content b', source_class: 'public' }
    ];

    const filtered = filterByFidelity(results, FIDELITY_LEVELS.L2_REDACTED);
    expect(filtered[0].fidelity).toBe('L2');
    expect(filtered[1].fidelity).toBe('L2');
  });

  it('applies different fidelity based on source class', () => {
    const results = [
      { id: '1', path: 'public.md', text: 'public content', source_class: 'public' },
      { id: '2', path: 'secret.md', text: 'secret content', source_class: 'sensitive' }
    ];

    const filtered = filterByFidelity(results, FIDELITY_LEVELS.L3_FULL);
    expect(filtered[0].fidelity).toBe('L3'); // public allows L3
    expect(filtered[1].fidelity).toBe('L0'); // sensitive capped at L0
  });

  it('emits telemetry when fidelity is degraded', () => {
    const telemetryEvents = [];
    const telemetryFn = (event, data) => telemetryEvents.push({ event, data });

    const results = [
      { id: '1', path: 'secret.md', text: 'secret content', source_class: 'sensitive' }
    ];

    filterByFidelity(results, FIDELITY_LEVELS.L3_FULL, { telemetryFn });

    expect(telemetryEvents.length).toBe(1);
    expect(telemetryEvents[0].event).toBe('rag.fidelity.degraded');
    expect(telemetryEvents[0].data.requested).toBe(FIDELITY_LEVELS.L3_FULL);
    expect(telemetryEvents[0].data.effective).toBe(FIDELITY_LEVELS.L0_METADATA);
  });

  it('does not emit telemetry when fidelity is not degraded', () => {
    const telemetryEvents = [];
    const telemetryFn = (event, data) => telemetryEvents.push({ event, data });

    const results = [
      { id: '1', path: 'public.md', text: 'public content', source_class: 'public' }
    ];

    filterByFidelity(results, FIDELITY_LEVELS.L3_FULL, { telemetryFn });

    expect(telemetryEvents.length).toBe(0);
  });

  it('defaults to project source class if not specified', () => {
    const results = [
      { id: '1', path: 'unknown.md', text: 'content' } // no source_class
    ];

    const filtered = filterByFidelity(results, FIDELITY_LEVELS.L3_FULL);
    // project defaults to L2
    expect(filtered[0].fidelity).toBe('L2');
  });

  it('respects overrides for specific source classes', () => {
    const results = [
      { id: '1', path: 'secret.md', text: 'secret content', source_class: 'sensitive' }
    ];

    // Override allows L3 for sensitive
    const overrides = { sensitive: FIDELITY_LEVELS.L3_FULL };
    const filtered = filterByFidelity(results, FIDELITY_LEVELS.L3_FULL, { overrides });

    expect(filtered[0].fidelity).toBe('L3');
  });
});

describe('FIDELITY_LEVELS', () => {
  it('exports all expected fidelity levels', () => {
    expect(FIDELITY_LEVELS.L0_METADATA).toBe(0);
    expect(FIDELITY_LEVELS.L1_ABSTRACTED).toBe(1);
    expect(FIDELITY_LEVELS.L2_REDACTED).toBe(2);
    expect(FIDELITY_LEVELS.L3_FULL).toBe(3);
  });
});

describe('DEFAULT_FIDELITY', () => {
  it('defines defaults for all source classes', () => {
    expect(DEFAULT_FIDELITY.public).toBe(FIDELITY_LEVELS.L3_FULL);
    expect(DEFAULT_FIDELITY.project).toBe(FIDELITY_LEVELS.L2_REDACTED);
    expect(DEFAULT_FIDELITY.client).toBe(FIDELITY_LEVELS.L1_ABSTRACTED);
    expect(DEFAULT_FIDELITY.sensitive).toBe(FIDELITY_LEVELS.L0_METADATA);
    expect(DEFAULT_FIDELITY.legal).toBe(FIDELITY_LEVELS.L0_METADATA);
  });
});
