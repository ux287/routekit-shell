// packages/mcp-rks/src/server/telemetry/collector.mjs

import { createEvent, createCorrelationId, EventTypes } from "./types.mjs";

let instance = null;
const DEFAULT_BUFFER_SIZE = 10;
const FLUSH_INTERVAL_MS = 5_000;

export class TelemetryCollector {
  constructor(options = {}) {
    this.buffer = [];
    this.bufferSize = options.bufferSize ||
      parseInt(process.env.RKS_TELEMETRY_BUFFER_SIZE || DEFAULT_BUFFER_SIZE, 10);
    this.enabled = process.env.RKS_TELEMETRY !== "off";
    this.storage = options.storage || null; // Injected by 03-local-storage
    this.listeners = [];
    this._flushing = false;
    this._flushTimer = null;
  }

  /**
   * Emit a telemetry event
   */
  emit(type, projectId, payload, options = {}) {
    if (!this.enabled) return null;

    const event = createEvent(type, projectId, payload, options);
    this.buffer.push(event);

    // Notify listeners (for real-time processing)
    this.listeners.forEach(fn => fn(event));

    // Auto-flush if buffer full
    if (this.buffer.length >= this.bufferSize) {
      this._scheduleFlush(0);
    } else {
      this._scheduleFlush(FLUSH_INTERVAL_MS);
    }

    return event;
  }

  /**
   * Schedule a flush after delay (deduped — only one pending flush at a time)
   */
  _scheduleFlush(delayMs) {
    if (this._flushTimer) return; // Already scheduled
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(err => console.error("[telemetry] flush error:", err.message));
    }, delayMs).unref();
  }

  /**
   * Start a correlated sequence of events
   */
  startCorrelation() {
    return createCorrelationId();
  }

  /**
   * Helper for timed operations
   */
  startTimer(type, projectId, initialPayload = {}, options = {}) {
    const startTime = Date.now();
    const correlationId = options.correlationId || this.startCorrelation();

    // Emit start event
    const startType = type.includes(".") ? type : type + ".start";
    this.emit(startType, projectId, initialPayload, { ...options, correlationId });

    return {
      complete: (additionalPayload = {}) => {
        const latencyMs = Date.now() - startTime;
        const completeType = type.replace(".start", ".complete").replace(/\.$/, "") + ".complete";
        return this.emit(
          completeType.replace(".complete.complete", ".complete"),
          projectId,
          { ...initialPayload, ...additionalPayload, latencyMs },
          { ...options, correlationId }
        );
      },
      fail: (errorPayload = {}) => {
        const latencyMs = Date.now() - startTime;
        const failType = type.replace(".start", ".failed").replace(/\.$/, "") + ".failed";
        return this.emit(
          failType.replace(".failed.failed", ".failed"),
          projectId,
          { ...initialPayload, ...errorPayload, latencyMs },
          { ...options, correlationId }
        );
      },
      correlationId,
    };
  }

  /**
   * Add a listener for real-time event processing
   */
  addListener(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  /**
   * Flush buffered events to storage
   */
  async flush() {
    if (this.buffer.length === 0) return;
    if (this._flushing) return; // Prevent concurrent flushes
    if (!this.storage) {
      return; // Keep events buffered until storage is connected
    }

    this._flushing = true;
    const events = [...this.buffer];
    this.buffer = [];

    try {
      await this.storage.write(events);
    } catch (err) {
      // Re-add events on failure (best effort)
      this.buffer = [...events, ...this.buffer].slice(0, this.bufferSize * 2);
      console.error("[telemetry] flush failed:", err.message);
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Set storage backend
   */
  setStorage(storage) {
    this.storage = storage;
  }

  /**
   * Get buffer contents (for testing/debugging)
   */
  getBuffer() {
    return [...this.buffer];
  }

  /**
   * Clear buffer without flushing
   */
  clearBuffer() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this.buffer = [];
  }
}

/**
 * Get singleton collector instance
 */
export function getTelemetryCollector(options = {}) {
  if (!instance) {
    instance = new TelemetryCollector(options);
  }
  return instance;
}

/**
 * Reset singleton (for testing)
 */
export function resetTelemetryCollector() {
  if (instance) {
    instance.clearBuffer();
  }
  instance = null;
}
