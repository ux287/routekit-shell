/**
 * Unit tests for TelemetryCollector._scheduleFlush — verifies the flush
 * setTimeout is .unref()'d so it cannot hold the event loop open in tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { TelemetryCollector } = await import('../../packages/mcp-rks/src/server/telemetry/collector.mjs');

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
