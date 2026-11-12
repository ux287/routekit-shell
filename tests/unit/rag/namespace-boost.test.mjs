import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  isImplementationQuery,
  getNamespaceBoost,
  getCanonicalPathBoost,
  NAMESPACE_BOOST,
  getCurrentCanonBoost,
  CURRENT_CANON_BOOST,
  orderBoostedMatches,
  getBoostWindow,
} from '@routekit/rag/query-intent';

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
    expect(getCanonicalPathBoost('packages/mcp-rks/src/rag-context.mjs')).toBeGreaterThanOrEqual(1.3);
  });

  // Stage 3: the boost prefix set was broadened when the RAG pipeline relocated into
  // packages/rag/src/. All canonical package roots must now carry the boost so the moved
  // canonical code is not silently under-ranked.
  it('returns the canonical_source boost for packages/rag/src/ paths (relocated canonical code)', () => {
    expect(getCanonicalPathBoost('packages/rag/src/query.mjs')).toBe(NAMESPACE_BOOST.canonical_source);
    expect(getCanonicalPathBoost('packages/rag/src/embed.mjs')).toBeGreaterThanOrEqual(1.3);
  });

  it('returns the canonical_source boost for packages/cli/src/ paths', () => {
    expect(getCanonicalPathBoost('packages/cli/src/rag/config.mjs')).toBe(NAMESPACE_BOOST.canonical_source);
  });

  it('applies regardless of query intent (unconditional)', () => {
    const boost = getCanonicalPathBoost('packages/mcp-rks/src/server.mjs');
    expect(boost).toBe(NAMESPACE_BOOST.canonical_source);
  });

  it('returns 1.0 for paths outside the canonical package roots', () => {
    // scripts/mcp/ is a genuinely non-canonical path (the old scripts/rag/* fixture was relocated
    // INTO a now-canonical root, so it can no longer stand in for "non-canonical").
    expect(getCanonicalPathBoost('scripts/mcp/rag-server.mjs')).toBe(1.0);
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

// Stage 3 wiring-liveness: getCanonicalPathBoost was DORMANT (defined + exported + unit-tested, but
// never imported into the query scoring chain). Assert it is now wired LIVE into query.mjs via
// durable source phrases (toContain/toMatch) rather than a brittle fixed-window slice.
describe('canonical boost is wired live into query.mjs scoring', () => {
  const querySrc = fs.readFileSync(path.resolve('packages/rag/src/query.mjs'), 'utf8');

  it('imports getCanonicalPathBoost from @routekit/rag/query-intent', () => {
    expect(querySrc).toMatch(/import\s*\{[^}]*getCanonicalPathBoost[^}]*\}\s*from\s*['"]@routekit\/rag\/query-intent['"]/);
  });

  it('invokes getCanonicalPathBoost within the score-multiplier chain (alongside getNamespaceBoost)', () => {
    expect(querySrc).toContain('getCanonicalPathBoost(');
    expect(querySrc).toMatch(/score:\s*r\.score\s*\*\s*nsBoost\s*\*\s*canonicalBoost/);
  });
});

// backlog.fix.rag-current-canon-outranked-by-stale-notes — current-canon ranking signal.
describe('getCurrentCanonBoost', () => {
  it('returns CURRENT_CANON_BOOST of exactly 1.3 for public.canon slugs on neutral intent', () => {
    expect(CURRENT_CANON_BOOST).toBe(1.3);
    expect(getCurrentCanonBoost('public.canon.what-is-rks', 'neutral')).toBe(CURRENT_CANON_BOOST);
  });

  it('returns 1.0 for private canon slugs on neutral and current-state intent', () => {
    for (const slug of ['canon.getting-started', 'canon.what-is-rks']) {
      for (const intent of ['neutral', 'current-state']) {
        expect(getCurrentCanonBoost(slug, intent), `${slug} / ${intent}`).toBe(1.0);
      }
    }
  });

  it('applies the same boost for current-state intent as for neutral intent', () => {
    const cs = getCurrentCanonBoost('public.canon.what-is-rks', 'current-state');
    expect(cs).toBe(getCurrentCanonBoost('public.canon.what-is-rks', 'neutral'));
    expect(cs).toBeGreaterThan(1.0);
  });

  it('returns 1.0 for non-canon slugs and for null or undefined slugs', () => {
    for (const slug of ['backlog.feat.foo', 'research.2026.foo', 'backlog.z_implemented.feat.foo', 'public.guide.notes-structure', null, undefined]) {
      for (const intent of ['neutral', 'current-state']) {
        expect(getCurrentCanonBoost(slug, intent), `${slug} / ${intent}`).toBe(1.0);
      }
    }
  });

  it('returns 1.0 for public.canon slugs on planning intent', () => {
    expect(getCurrentCanonBoost('public.canon.what-is-rks', 'planning')).toBe(1.0);
  });

  it('treats undefined and unknown intent as neutral', () => {
    const neutral = getCurrentCanonBoost('public.canon.what-is-rks', 'neutral');
    expect(getCurrentCanonBoost('public.canon.what-is-rks', undefined)).toBe(CURRENT_CANON_BOOST);
    expect(getCurrentCanonBoost('public.canon.what-is-rks', 'unknown-intent')).toBe(CURRENT_CANON_BOOST);
    expect(getCurrentCanonBoost('public.canon.what-is-rks', undefined)).toBe(neutral);
    expect(getCurrentCanonBoost('public.canon.what-is-rks', 'unknown-intent')).toBe(neutral);
  });
});

describe('current-canon boostedScore chain', () => {
  it('a public.canon note outranks a non-canon note with an equal base score', () => {
    const base = 0.8;
    const isImpl = isImplementationQuery('What is routekit shell?');
    const scoreOf = (slug) =>
      base * getNamespaceBoost(slug, isImpl) * getCanonicalPathBoost(`notes/${slug}.md`) * getCurrentCanonBoost(slug, 'neutral');
    expect(scoreOf('public.canon.what-is-rks')).toBeGreaterThan(scoreOf('public.guide.notes-structure'));
  });
});

describe('current-canon boost leaves existing boosts unchanged', () => {
  it('getNamespaceBoost returns 1.4, 0.85 and 1.0 on impl queries and 1.0 on non-impl queries', () => {
    expect(getNamespaceBoost('backlog.z_implemented.feat.foo', true)).toBe(1.4);
    expect(getNamespaceBoost('research.2026.foo', true)).toBe(0.85);
    expect(getNamespaceBoost('backlog.feat.foo', true)).toBe(1.0);
    for (const slug of ['backlog.z_implemented.feat.foo', 'research.2026.foo', 'backlog.feat.foo']) {
      expect(getNamespaceBoost(slug, false), slug).toBe(1.0);
    }
  });

  it('getCanonicalPathBoost returns 1.3 for package source roots and 1.0 for a canon note path', () => {
    expect(getCanonicalPathBoost('packages/mcp-rks/src/server.mjs')).toBe(1.3);
    expect(getCanonicalPathBoost('packages/rag/src/query.mjs')).toBe(1.3);
    expect(getCanonicalPathBoost('packages/cli/src/rag/config.mjs')).toBe(1.3);
    expect(getCanonicalPathBoost('notes/public.canon.what-is-rks.md')).toBe(1.0);
  });
});

describe('orderBoostedMatches', () => {
  it('orders a public.canon entry with a lower fused score and a higher boosted score first', () => {
    const fused = [
      { id: 'public.guide.notes-structure', fused: 0.80 },
      { id: 'public.canon.what-is-rks', fused: 0.70 },
    ];
    const entries = fused.map(e => ({ id: e.id, score: e.fused * getCurrentCanonBoost(e.id, 'neutral') }));
    expect(entries[1].score).toBeGreaterThan(entries[0].score); // non-vacuity: boost overturns fused order
    const out = orderBoostedMatches(entries, []);
    expect(out.map(e => e.id)).toEqual(['public.canon.what-is-rks', 'public.guide.notes-structure']);
  });

  it('keeps pinned entries at the head in input order', () => {
    const entries = [
      { id: 'p2', score: 0.1 },
      { id: 'a', score: 0.9 },
      { id: 'p1', score: 0.2 },
      { id: 'b', score: 0.5 },
    ];
    const out = orderBoostedMatches(entries, ['p1', 'p2']);
    expect(out.map(e => e.id)).toEqual(['p2', 'p1', 'a', 'b']);
  });

  it('keeps input order for equal boosted scores', () => {
    const entries = ['x', 'y', 'z', 'w'].map(id => ({ id, score: 0.5 }));
    expect(orderBoostedMatches(entries, []).map(e => e.id)).toEqual(['x', 'y', 'z', 'w']);
  });

  it('returns every entry and does not mutate the input', () => {
    const entries = [
      { id: 'a', score: 0.1 },
      { id: 'b', score: 0.9 },
      { id: 'p', score: 0.05 },
      { id: 'c', score: 0.5 },
    ];
    const snapshot = JSON.parse(JSON.stringify(entries));
    const before = [...entries];
    const out = orderBoostedMatches(entries, ['p']);
    expect(out).not.toBe(entries);
    expect(out.length).toBe(entries.length);
    expect([...out].sort((l, r) => l.id.localeCompare(r.id))).toEqual([...entries].sort((l, r) => l.id.localeCompare(r.id)));
    expect(entries).toEqual(snapshot);
    entries.forEach((e, i) => expect(e).toBe(before[i]));
  });
});

describe('getBoostWindow', () => {
  it('returns the larger of k and semanticCount plus pinnedCount', () => {
    expect(getBoostWindow(10, 25, 3)).toBe(28);
    expect(getBoostWindow(10, 2, 3)).toBe(10);
    expect(getBoostWindow(10, 0, 0)).toBe(10);
  });
});

describe('current-canon boost is wired live into query.mjs scoring', () => {
  const querySrc = fs.readFileSync(path.resolve('packages/rag/src/query.mjs'), 'utf8');

  it('imports the helpers and multiplies canonBoost into the fused score', () => {
    for (const name of ['getCurrentCanonBoost', 'orderBoostedMatches', 'getBoostWindow']) {
      expect(querySrc, name).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]@routekit/rag/query-intent['"]`));
    }
    expect(querySrc).toMatch(/canonBoost\s*=\s*getCurrentCanonBoost\(\s*original\.slug\s*,\s*intent\s*\)/);
    expect(querySrc).toMatch(/score:\s*r\.score\s*\*\s*nsBoost\s*\*\s*canonicalBoost\s*\*\s*canonBoost\b/);
  });

  it('passes the widened window as limit, keeps the pre-boost hybridRank, and orders before slicing to k', () => {
    const call = querySrc.match(/hybridSearch\(\{([\s\S]*?)\}\)/);
    expect(call, 'hybridSearch({ ... }) call').not.toBeNull();
    const args = call[1];
    expect(args).toMatch(/\blimit:\s*getBoostWindow\(\s*k\s*,\s*semanticList\.length\s*,\s*pinnedIds\.length\s*\)/);
    expect(args).toMatch(/(^|[\s,{])k\s*,/); // k passed unchanged (shorthand)
    expect(args).not.toMatch(/\bk:\s*getBoostWindow/);
    expect(querySrc).toMatch(/hybridRes\.results[^\n]*\.map\(\(r,\s*idx\)\s*=>/);
    expect(querySrc).toMatch(/hybridRank:\s*idx\s*\+\s*1/);
    expect(querySrc).toMatch(/orderBoostedMatches\([^)]*\)\.slice\(0,\s*k\)/);
  });
});
