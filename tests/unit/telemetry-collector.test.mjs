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

// backlog.fix.governor-end-dispatch-ended-count-deterministic: flush() reschedules itself when the
// buffer is non-empty after a write (0 ms or FLUSH_INTERVAL_MS after success, always
// FLUSH_INTERVAL_MS after failure). Only setTimeout/clearTimeout are faked; setImmediate stays real.
describe('TelemetryCollector.flush — follow-up scheduling (no stranded events)', () => {
  const FLUSH_INTERVAL_MS = 5000;
  const ev = (n) => ({ type: 'test.event', payload: { n } });
  const drain = () => new Promise((r) => setImmediate(r));
  const heldStorage = () => {
    const batches = [];
    const pending = [];
    const storage = {
      write: vi.fn((events) => {
        batches.push(events.map((e) => e.payload.n));
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      }),
    };
    return { storage, batches, pending };
  };
  let collectors;
  const make = (storage, bufferSize) => {
    const c = new TelemetryCollector({ bufferSize, storage });
    collectors.push(c);
    return c;
  };

  beforeEach(() => {
    collectors = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const c of collectors) c.clearBuffer();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists an event buffered during an in-flight write with no further emit', async () => {
    const { storage, batches, pending } = heldStorage();
    const c = make(storage, 1);
    c.buffer.push(ev('A'));
    const first = c.flush();
    c.buffer.push(ev('B'));
    await c.flush(); // skipped: a write is in flight
    expect(storage.write).toHaveBeenCalledTimes(1);
    pending[0].resolve();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.write).toHaveBeenCalledTimes(2);
    expect(batches).toEqual([['A'], ['B']]);
    pending[1].resolve();
    await drain();
  });

  it('schedules the follow-up at 0 ms after a successful write when the buffer is at least bufferSize', async () => {
    const { storage, pending } = heldStorage();
    const c = make(storage, 1);
    const spy = vi.spyOn(c, '_scheduleFlush');
    c.buffer.push(ev('A'));
    const first = c.flush();
    c.buffer.push(ev('B'));
    pending[0].resolve();
    await first;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0);
  });

  it('schedules the follow-up at FLUSH_INTERVAL_MS after a successful write when the buffer is below bufferSize', async () => {
    const { storage, pending } = heldStorage();
    const c = make(storage, 3);
    const spy = vi.spyOn(c, '_scheduleFlush');
    c.buffer.push(ev('A'));
    const first = c.flush();
    c.buffer.push(ev('B'));
    pending[0].resolve();
    await first;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(FLUSH_INTERVAL_MS);
  });

  it('leaves no flush timer scheduled when the buffer is empty after a successful write', async () => {
    const { storage, pending } = heldStorage();
    const c = make(storage, 1);
    const spy = vi.spyOn(c, '_scheduleFlush');
    c.buffer.push(ev('A'));
    const first = c.flush();
    pending[0].resolve();
    await first;
    expect(spy).not.toHaveBeenCalled();
    expect(c._flushTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves FIFO order across overlapping flushes', async () => {
    const { storage, batches, pending } = heldStorage();
    const c = make(storage, 1);
    c.buffer.push(ev('A'));
    const first = c.flush();
    c.buffer.push(ev('B'));
    c.buffer.push(ev('C'));
    pending[0].resolve();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    pending[1].resolve();
    await drain();
    expect(batches.flat()).toEqual(['A', 'B', 'C']);
  });

  it('write-failure path preserves FIFO and reschedules itself at FLUSH_INTERVAL_MS', async () => {
    const { storage, batches, pending } = heldStorage();
    const c = make(storage, 1);
    const spy = vi.spyOn(c, '_scheduleFlush');
    c.buffer.push(ev('A'));
    const first = c.flush();
    c.buffer.push(ev('B'));
    pending[0].reject(new Error('disk full'));
    await first;
    expect(spy).toHaveBeenCalledWith(FLUSH_INTERVAL_MS);
    expect(spy).not.toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(batches).toEqual([['A'], ['A', 'B']]);
    pending[1].resolve();
    await drain();
  });

  it('a write that keeps failing never schedules repeated 0 ms timers', async () => {
    const storage = { write: vi.fn(() => Promise.reject(new Error('disk gone'))) };
    const c = make(storage, 1);
    const spy = vi.spyOn(c, '_scheduleFlush');
    c.buffer.push(ev('A'));
    await c.flush();
    expect(storage.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 1);
    expect(storage.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(storage.write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);
    expect(storage.write).toHaveBeenCalledTimes(5);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.every(([delay]) => delay === FLUSH_INTERVAL_MS)).toBe(true);
  });

  it('does not busy-loop while a write is in flight', async () => {
    const { storage, pending } = heldStorage();
    const c = make(storage, 1);
    c.buffer.push(ev('A'));
    const first = c.flush();
    c.buffer.push(ev('B'));
    c._scheduleFlush(0); // what emit() does when the buffer is full
    await vi.advanceTimersByTimeAsync(100);
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    pending[0].resolve();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.write).toHaveBeenCalledTimes(2);
    pending[1].resolve();
    await drain();
  });
});
