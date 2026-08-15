/**
 * Structural validation for the global test setup infrastructure.
 * (backlog.feat.global-telemetry-mock.infra)
 *
 * NOTE: vi.mock() in setupFiles does not intercept module imports in Vitest 2.1.9
 * (no hoist transform applies to setupFiles). Per-file vi.mock() remains required.
 * This story ships two valuable changes that work correctly:
 *   1. clearMocks: true — resets spy call history before every test
 *   2. afterEach telemetry guard — cleans up accidental disk writes
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('tests/setup.mjs — source structure', () => {
  const setupSrc = fs.readFileSync(path.resolve('tests/setup.mjs'), 'utf8');

  it('exists and imports afterEach from vitest', () => {
    expect(setupSrc).toContain('afterEach');
    expect(setupSrc).toContain('vitest');
  });

  it('contains telemetry directory guard', () => {
    expect(setupSrc).toContain('.rks/telemetry');
  });

  it('cleans up leaked .jsonl files in afterEach', () => {
    expect(setupSrc).toContain('.jsonl');
    expect(setupSrc).toContain('unlinkSync');
  });
});

// B5 update: setupFiles and clearMocks now live in vitest.config.base.mjs
// (the shared base extracted per backlog.fix.vitest-config-drift-reconcile)
// rather than being inlined in each tier config. Assertions check the
// EFFECTIVE merged config via dynamic import, not the raw config source.
// Per the B5 hotfix #1 (commit 1d55f0bf), config imports are cached in
// beforeAll to avoid CI timeouts from Vite re-resolution under fork-contention.
describe('vitest fallback effective config — clearMocks and setupFiles', () => {
  let cfg;

  beforeAll(async () => {
    cfg = (await import('../../vitest.config.mjs')).default;
  }, 60_000);

  it('effective config includes setupFiles entry pointing to tests/setup.mjs', () => {
    const setupFiles = cfg.test?.setupFiles ?? [];
    expect(setupFiles).toContain('tests/setup.mjs');
  });

  it('effective config has clearMocks: true', () => {
    expect(cfg.test?.clearMocks).toBe(true);
  });
});
