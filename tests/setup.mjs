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

vi.mock('packages/mcp-rks/src/server/telemetry/index.mjs', () => {
  const mockCollector = {
    emit: vi.fn(),
    flush: vi.fn(),
    clearBuffer: vi.fn(),
    startTimer: vi.fn(() => ({ complete: vi.fn() })),
    addListener: vi.fn(),
    setStorage: vi.fn(),
    getBuffer: vi.fn(() => []),
  };
  const mockStorage = {
    emit: vi.fn(),
    flush: vi.fn(),
    clearBuffer: vi.fn(),
  };
  return {
    getTelemetryCollector: vi.fn(() => mockCollector),
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
// index.mjs — mock it separately so real _flushTimer timers are never created.
vi.mock('packages/mcp-rks/src/server/telemetry/collector.mjs', () => {
  const mockCollector = {
    emit: vi.fn(),
    flush: vi.fn(),
    clearBuffer: vi.fn(),
    startTimer: vi.fn(() => ({ complete: vi.fn() })),
    addListener: vi.fn(),
    setStorage: vi.fn(),
    getBuffer: vi.fn(() => []),
  };
  return {
    getTelemetryCollector: vi.fn(() => mockCollector),
    TelemetryCollector: vi.fn(() => mockCollector),
    resetTelemetryCollector: vi.fn(),
  };
});

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
