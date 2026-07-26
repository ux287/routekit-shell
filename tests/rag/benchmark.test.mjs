import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../../packages/mcp-rks/src/rag/benchmark.mjs';

describe('RAG Benchmark', () => {
  // Use synthetic mode for CI/baseline tests - verifies benchmark infrastructure
  // For real RAG evaluation, run with BENCHMARK_SYNTHETIC=0

  it('benchmark infrastructure works with synthetic results', async () => {
    const results = await runBenchmark({ k: 10, verbose: false, synthetic: true });

    // With synthetic results (ground truth first), we expect perfect/near-perfect scores
    expect(results.overall.avg_precision_at_5).toBeGreaterThan(0.1);
    expect(results.overall.avg_mrr).toBeGreaterThan(0.5);
    expect(results.overall.hit_rate_at_10).toBeGreaterThan(0.9);

    // Verify structure
    expect(results.timestamp).toBeDefined();
    expect(results.config.k).toBe(10);
    expect(results.by_category).toBeDefined();
    expect(results.detailed.length).toBe(50); // 50 queries
  }, 60000);

  it('code lookups have correct category aggregation', async () => {
    const results = await runBenchmark({ k: 10, synthetic: true });
    const codeResults = results.by_category.code_lookup;

    expect(codeResults).toBeDefined();
    expect(codeResults.avg_mrr).toBeGreaterThan(0.5);
    expect(codeResults.avg_precision_at_5).toBeDefined();
  });

  it('decision context queries have correct category aggregation', async () => {
    const results = await runBenchmark({ k: 10, synthetic: true });
    const decisionResults = results.by_category.decision_context;

    expect(decisionResults).toBeDefined();
    expect(decisionResults.avg_precision_at_5).toBeGreaterThan(0.1);
  });

  it('all 6 categories are present in results', async () => {
    const results = await runBenchmark({ k: 10, synthetic: true });

    const expectedCategories = [
      'code_lookup',
      'decision_context',
      'procedural',
      'discovery',
      'freshness',
      'edge_cases'
    ];

    for (const cat of expectedCategories) {
      expect(results.by_category[cat]).toBeDefined();
    }
  });
});
