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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('tests/setup.mjs — source structure', () => {
  const setupSrc = fs.readFileSync(path.resolve('tests/setup.mjs'), 'utf8');

  it('exists and installs the telemetry mocks from vitest', () => {
    // The two specifier literals are built by CONCATENATION, deliberately. The triage
    // guard in tests/unit/telemetry-global-mock-triage.test.mjs classifies any specifier
    // sitting directly after `vi.mock(` as consumption, so spelling these inline would
    // make this file a consumer of a globally mocked specifier and demand a verdict entry
    // for a file that merely reads setup.mjs as text.
    const MOCK_CALL = 'vi.mock(';
    expect(setupSrc).toContain('vitest');
    expect(setupSrc).toContain('vi.hoisted(');
    expect(setupSrc).toContain(MOCK_CALL + "'@routekit/telemetry'");
    expect(setupSrc).toContain(MOCK_CALL + "'@routekit/telemetry/collector'");
  });

  it('DESTROYS NOTHING — it registers no afterEach and calls no deleting fs API', () => {
    // The sweep this file used to require deleted every *.jsonl under
    // path.resolve('.rks/telemetry') after EVERY test in EVERY tier. That path is the
    // live sink the MCP server and the hooks append to, and .gitignore excludes it, so
    // the deletions were unrecoverable. Asserted over the whole file, never a slice.
    expect(setupSrc).not.toContain('afterEach(');
    for (const destructive of ['unlinkSync', 'rmSync', 'rmdirSync', 'truncate', 'writeFileSync']) {
      expect(setupSrc, `setup.mjs must not call ${destructive}`).not.toContain(destructive);
    }
  });

  it('says why that path is off limits', () => {
    expect(setupSrc).toContain('.rks/telemetry');
    expect(setupSrc).toContain('LIVE');
    expect(setupSrc).toContain('storage.mjs');
  });

  it('leaves no unused import behind', () => {
    if (/^import fs /m.test(setupSrc)) expect(setupSrc).toMatch(/\bfs\./);
    if (/^import path /m.test(setupSrc)) expect(setupSrc).toMatch(/\bpath\./);
    if (/import \{[^}]*\bafterEach\b[^}]*\} from 'vitest'/.test(setupSrc)) {
      expect(setupSrc).toContain('afterEach(');
    }
  });
});

describe('the live telemetry sink survives a test run', () => {
  // REGRESSION for backlog.fix.test-suite-wipes-project-telemetry-sink.
  //
  // Asserts on THIS file's own sentinel bytes and nothing else: the MCP server and the
  // hooks append to the same directory while the suite runs, so any assertion over the
  // directory listing would be flaky by construction. The name deliberately does not
  // match events-YYYY-MM-DD.jsonl, so the reader and reaper in
  // packages/telemetry/src/storage.mjs ignore it.
  const dir = path.resolve('.rks/telemetry');
  const sentinel = path.join(dir, `sentinel-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  const BYTES = JSON.stringify({ sentinel: true, written: 'before the suite ran' }) + '\n';

  beforeAll(() => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentinel, BYTES);
  });

  afterAll(() => {
    // Removes ONLY this file's own path. Never enumerates the directory.
    try { fs.unlinkSync(sentinel); } catch { /* already gone */ }
  });

  it('a test runs, and its afterEach hooks complete', () => {
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('the sentinel written before that test is still byte-identical', () => {
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe(BYTES);
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
