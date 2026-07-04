export { EventTypes, createEvent, createCorrelationId } from "./types.mjs";
export {
  TelemetryCollector,
  getTelemetryCollector,
  resetTelemetryCollector
} from "./collector.mjs";
export { TelemetryStorage, createTelemetryStorage } from "./storage.mjs";

// Import for local use in ensureTelemetryStorage
import { getTelemetryCollector } from "./collector.mjs";
import { createTelemetryStorage } from "./storage.mjs";

// Re-export for convenience
export * from "./types.mjs";

/**
 * Ensure telemetry storage is configured for the given project.
 * Call this before emitting telemetry events to ensure persistence.
 * Safe to call multiple times - will only configure storage once.
 *
 * @param {string} projectRoot - Absolute path to project root
 */
export function ensureTelemetryStorage(projectRoot) {
  const collector = getTelemetryCollector();
  if (!collector.storage && projectRoot) {
    collector.setStorage(createTelemetryStorage(projectRoot));
  }
  return collector;
}
