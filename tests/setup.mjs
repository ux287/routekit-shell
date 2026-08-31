// Global test setup — runs before every test file.
//
// Provides a global mock for the telemetry module so per-file boilerplate
// is not needed. Per-file vi.mock() calls for telemetry override this global
// (Vitest resolution order: per-file > setupFiles).
//
// Exception: init-telemetry.test.mjs retains its own vi.mock() for named spy access.
//
// Tier-2 (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit): cleanup of
// tests/.tmp/ now lives in a vitest globalTeardown
// (tests/_helpers/with-temp-dir.mjs::globalTeardown) so it runs ONCE after
// all parallel forks finish. setup.mjs intentionally stays out of that
// concern — adding an afterAll sweep here would race against parallel forks
// that share tests/.tmp/.
import { vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// THESE TWO GLOBAL MOCKS SHADOW REAL TELEMETRY INTERNALS.
//
// Every test file in the suite resolves `@routekit/telemetry` and
// `@routekit/telemetry/collector` to the sharedMockCollector stub defined just
// below — a plain object with seven methods and nothing else. A test that
// asserts on REAL internals through that stub either fails loudly (see
// tests/unit/telemetry-collector.test.mjs, which lost its real binding in the
// @routekit/telemetry extraction repoint) or, far worse, PASSES VACUOUSLY with
// assertions that can no longer fail.
//
// => Any test asserting on REAL telemetry internals MUST opt out per-file, with
//    vi.importActual() or a file-top vi.unmock() for that specifier. Do NOT fix
//    such a test by growing the stub below: an internal added here is verified
//    against a hand-written double instead of the shipped class, which defeats
//    the purpose of the test. The stub's surface is locked by
//    tests/unit/telemetry-global-mock-triage.test.mjs, which also fails closed
//    on any newly added consumer that is neither un-shadowed nor triaged.
//
// These mocks are LOAD-BEARING — do not narrow or remove them. See the two
// rationales immediately below (shared instance) and above the /collector mock
// (real timers). (backlog.fix.telemetry-global-mock-shadowing-sweep)
// ---------------------------------------------------------------------------

// ONE shared mock collector instance, referenced by BOTH the barrel (@routekit/telemetry) and the
// subpath (@routekit/telemetry/collector) mocks. The REAL barrel re-exports getTelemetryCollector
// from ./collector, so in production both specifiers resolve to the SAME collector. Mocking them as
// two SEPARATE instances (the pre-@routekit/telemetry-extraction shape) meant a spy obtained via one
// specifier never saw emits routed through the other — which reddened llm-clients.test.mjs and
// token-cost-emitter-reader-seam.test.mjs deterministically in the full unit shard (a code module
// emits via the barrel; those tests spy via /collector). Sharing one instance restores the
// production invariant. Defined via vi.hoisted() because vi.mock factories are hoisted above
// module-level consts. (backlog.fix.telemetry-mock-shard-isolation)
const { sharedMockCollector } = vi.hoisted(() => ({
  sharedMockCollector: {
    emit: vi.fn(),
    flush: vi.fn(),
    clearBuffer: vi.fn(),
    startTimer: vi.fn(() => ({ complete: vi.fn() })),
    addListener: vi.fn(),
    setStorage: vi.fn(),
    getBuffer: vi.fn(() => []),
  },
}));

vi.mock('@routekit/telemetry', () => {
  const mockStorage = {
    emit: vi.fn(),
    flush: vi.fn(),
    clearBuffer: vi.fn(),
  };
  return {
    getTelemetryCollector: vi.fn(() => sharedMockCollector),
    ensureTelemetryStorage: vi.fn(() => mockStorage),
    createTelemetryStorage: vi.fn(() => ({
      write: vi.fn(),
      read: vi.fn(),
      getStats: vi.fn(),
      cleanup: vi.fn(),
    })),
    resetTelemetryCollector: vi.fn(),
    EventTypes: {},
    createEvent: vi.fn(),
    createCorrelationId: vi.fn(),
    // Shareable-export surface (backlog.feat.telemetry-export-redacted-bundle). Kept in
    // sync with the real barrel (index.mjs) so consumers importing these via the barrel
    // do not resolve to `undefined` under this global mock. Tests exercising REAL redaction
    // import from redact.mjs/export.mjs directly (those modules are not mocked here).
    redactValue: vi.fn((v) => v),
    redactEvent: vi.fn((v) => v),
    redactString: vi.fn((s) => s),
    isSecretKey: vi.fn(() => false),
    REDACTED: "[REDACTED]",
    exportTelemetry: vi.fn(async () => ({ ok: true, jsonPath: "", mdPath: "" })),
  };
});

// collector.mjs is imported directly by some modules (e.g. rag/tools.mjs) bypassing
// index.mjs — mock it with the SAME shared collector so real _flushTimer timers are never
// created AND a spy on either specifier observes every emit.
vi.mock('@routekit/telemetry/collector', () => ({
  getTelemetryCollector: vi.fn(() => sharedMockCollector),
  TelemetryCollector: vi.fn(() => sharedMockCollector),
  resetTelemetryCollector: vi.fn(),
}));

const telemetryDir = path.resolve('.rks/telemetry');

afterEach(() => {
  if (fs.existsSync(telemetryDir)) {
    const files = fs.readdirSync(telemetryDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) {
      for (const f of files) {
        try { fs.unlinkSync(path.join(telemetryDir, f)); } catch {}
      }
    }
  }
});

// Tier-2 (AC3): tests/.tmp/ cleanup runs as a vitest globalTeardown
// (tests/_helpers/with-temp-dir.mjs::globalTeardown), invoked ONCE after all
// forks finish. We cannot sweep here in setup.mjs because the unit + mock
// tiers run in parallel forks (maxForks=2 / 4) that share tests/.tmp/; a
// per-file afterAll would race and unlink scratch dirs that a parallel fork
// is still using. New call sites should prefer the withTempDir helper, which
// cleans up its own scratch dir in finally — leaks should be rare.
