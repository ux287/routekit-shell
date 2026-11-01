/**
 * Unit tests for TelemetryCollector._scheduleFlush — verifies the flush
 * setTimeout is .unref()'d so it cannot hold the event loop open in tests.
 *
 * MUST use vi.importActual: tests/setup.mjs registers a suite-wide
 * vi.mock('@routekit/telemetry/collector') whose TelemetryCollector is
 * vi.fn(() => sharedMockCollector) — a stub with no _scheduleFlush and no
 * _flushTimer. A plain `await import(...)` here resolves that stub and this
 * file dies with "collector._scheduleFlush is not a function". The mock is
 * load-bearing suite-wide (tests/setup.mjs:19-27, :72-74), so the opt-out
 * belongs here, per-test — not in setup.mjs.
 * (backlog.fix.telemetry-global-mock-shadowing-sweep)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { TelemetryCollector } = await vi.importActual('@routekit/telemetry/collector');

describe('TelemetryCollector._scheduleFlush — timer unref', () => {
  let originalSetTimeout;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = vi.fn((fn, delay) => {
      const timer = originalSetTimeout(fn, delay);
      // .unref() must return the timer (chaining contract) so _flushTimer is set correctly
      timer.unref = vi.fn(() => timer);
      return timer;
    });
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  // Mutation witness: proves this file is bound to the REAL class and not to the
  // suite-wide stub. Under the global mock, TelemetryCollector is
  // vi.fn(() => sharedMockCollector) — isMockFunction returns true, and the plain
  // object it returns is not an instance of it. Both assertions flip RED if the
  // vi.importActual above ever regresses to a plain import. A comment claiming the
  // binding is real is not evidence; these assertions are.
  it('is bound to the REAL TelemetryCollector, not the suite-wide stub', () => {
    expect(vi.isMockFunction(TelemetryCollector)).toBe(false);
    expect(typeof TelemetryCollector.prototype._scheduleFlush).toBe('function');
    const collector = new TelemetryCollector({ bufferSize: 100 });
    expect(collector).toBeInstanceOf(TelemetryCollector);
  });

  it('calls .unref() on the flush timer so it cannot hold the event loop', () => {
    const collector = new TelemetryCollector({ bufferSize: 100 });
    collector._scheduleFlush(5000);
    expect(collector._flushTimer).toBeTruthy();
    expect(collector._flushTimer.unref).toHaveBeenCalledTimes(1);
    clearTimeout(collector._flushTimer);
  });

  it('does not schedule a second timer when one is already pending', () => {
    const collector = new TelemetryCollector({ bufferSize: 100 });
    collector._scheduleFlush(5000);
    collector._scheduleFlush(5000);
    expect(globalThis.setTimeout).toHaveBeenCalledTimes(1);
    clearTimeout(collector._flushTimer);
  });
});
