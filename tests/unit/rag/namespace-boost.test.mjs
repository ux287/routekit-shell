import { describe, it, expect } from 'vitest';
import {
  isImplementationQuery,
  getNamespaceBoost,
  getCanonicalPathBoost,
  NAMESPACE_BOOST,
} from '../../../packages/mcp-rks/src/rag/query-intent.mjs';

describe('isImplementationQuery', () => {
  it.each([
    ['does cost-report.mjs exist', true],
    ['is rks_token_cost_report implemented', true],
    ['is the handler registered', true],
    ['was this feature built', true],
    ['has this been shipped', true],
    ['how does /build work', false],
    ['what is in the backlog', false],
    ['', false],
    ['backlog', false],
  ])('query %j → %s', (query, expected) => {
    expect(isImplementationQuery(query)).toBe(expected);
  });
});

describe('getNamespaceBoost', () => {
  it('returns z_implemented boost for backlog.z_implemented.* slugs on impl query', () => {
    expect(getNamespaceBoost('backlog.z_implemented.feat.foo', true)).toBe(NAMESPACE_BOOST.z_implemented);
  });

  it('works for nested z_implemented slugs', () => {
    expect(getNamespaceBoost('backlog.z_implemented.feat.foo.child', true)).toBe(NAMESPACE_BOOST.z_implemented);
  });

  it('returns research deprioritization for research.* slugs on impl query', () => {
    expect(getNamespaceBoost('research.2026.foo', true)).toBe(NAMESPACE_BOOST.research);
  });

  it('returns 1.0 for neutral slugs on impl query', () => {
    expect(getNamespaceBoost('backlog.feat.foo', true)).toBe(1.0);
  });

  it('returns 1.0 for all slugs when not an impl query', () => {
    expect(getNamespaceBoost('backlog.z_implemented.feat.foo', false)).toBe(1.0);
    expect(getNamespaceBoost('research.2026.foo', false)).toBe(1.0);
  });

  it('returns 1.0 for null/undefined slug', () => {
    expect(getNamespaceBoost(null, true)).toBe(1.0);
    expect(getNamespaceBoost(undefined, true)).toBe(1.0);
  });
});

describe('getCanonicalPathBoost', () => {
  it('returns >=1.3 for packages/mcp-rks/src/ paths', () => {
    expect(getCanonicalPathBoost('packages/mcp-rks/src/rag/tools.mjs')).toBeGreaterThanOrEqual(1.3);
  });

  it('applies regardless of query intent (unconditional)', () => {
    const boost = getCanonicalPathBoost('packages/mcp-rks/src/server.mjs');
    expect(boost).toBe(NAMESPACE_BOOST.canonical_source);
  });

  it('returns 1.0 for paths outside packages/mcp-rks/src/', () => {
    expect(getCanonicalPathBoost('scripts/rag/embed.mjs')).toBe(1.0);
    expect(getCanonicalPathBoost('notes/backlog.feat.foo.md')).toBe(1.0);
    expect(getCanonicalPathBoost('packages/mcp-rks/__tests__/foo.spec.mjs')).toBe(1.0);
  });

  it('returns 1.0 for null/undefined path', () => {
    expect(getCanonicalPathBoost(null)).toBe(1.0);
    expect(getCanonicalPathBoost(undefined)).toBe(1.0);
  });

  it('no regression: getNamespaceBoost still returns 1.4 for backlog.z_implemented.* on impl query', () => {
    expect(getNamespaceBoost('backlog.z_implemented.feat.foo', true)).toBe(1.4);
  });

  it('no regression: getNamespaceBoost still returns 0.85 for research.* on impl query', () => {
    expect(getNamespaceBoost('research.2026.foo', true)).toBe(0.85);
  });
});

describe('boostedScore chain', () => {
  it('applies namespace boost as a multiplier to the fused score', () => {
    const fusedScore = 0.8;
    const nsBoost = getNamespaceBoost('backlog.z_implemented.feat.x', true);
    expect(fusedScore * nsBoost).toBeCloseTo(0.8 * 1.4);
  });

  it('is a no-op (1.0×) for non-impl queries regardless of namespace', () => {
    const fusedScore = 0.8;
    expect(fusedScore * getNamespaceBoost('backlog.z_implemented.feat.x', false)).toBe(fusedScore);
    expect(fusedScore * getNamespaceBoost('research.foo', false)).toBe(fusedScore);
  });
});
