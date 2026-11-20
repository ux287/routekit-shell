import fs from "fs/promises";
import path from "path";
import { redactEventSecretsOnly } from "./redact.mjs";

const DEFAULT_RETENTION_DAYS = 30;

export class TelemetryStorage {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.telemetryDir = path.join(projectRoot, ".rks", "telemetry");
    this.retentionDays = parseInt(
      process.env.RKS_TELEMETRY_RETENTION_DAYS || DEFAULT_RETENTION_DAYS,
      10
    );
  }

  /**
   * Ensure telemetry directory exists
   */
  async ensureDir() {
    await fs.mkdir(this.telemetryDir, { recursive: true });
  }

  /**
   * Get filename for a given date
   */
  getFilename(date = new Date()) {
    const dateStr = date.toISOString().split("T")[0];
    return path.join(this.telemetryDir, `events-${dateStr}.jsonl`);
  }

  /**
   * Write events to storage (append mode)
   */
  async write(events) {
    if (!events || events.length === 0) return;
    
    await this.ensureDir();

    // Group events by date. Redact secret VALUES on the way in — this is the last gate
    // before disk, so no live token can be persisted to .rks/telemetry/events-*.jsonl.
    // redactEventSecretsOnly preserves correlationId/telemetryId (v4 UUIDs) so the store
    // stays queryable; full redactEvent is reserved for the shareable export bundle.
    const byDate = new Map();
    for (const rawEvent of events) {
      const event = redactEventSecretsOnly(rawEvent);
      const date = event.timestamp.split("T")[0];
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(event);
    }
    
    // Write each date's events to its file
    for (const [date, dateEvents] of byDate) {
      const filename = path.join(this.telemetryDir, `events-${date}.jsonl`);
      const lines = dateEvents.map(e => JSON.stringify(e)).join("\n") + "\n";
      await fs.appendFile(filename, lines, "utf8");
    }
  }

  /**
   * Read events from storage
   * @param {Object} options - Query options
   * @param {string} options.startDate - Start date (YYYY-MM-DD)
   * @param {string} options.endDate - End date (YYYY-MM-DD)
   * @param {string} options.type - Filter by event type
   * @param {string} options.projectId - Filter by project
   * @param {string} options.correlationId - Filter by correlation
   * @param {number} options.limit - Max events to return
   */
  async read(options = {}) {
    await this.ensureDir();
    
    const files = await this.listFiles(options.startDate, options.endDate);
    const events = [];
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            
            // Apply filters
            if (options.type && event.type !== options.type) continue;
            if (options.projectId && event.projectId !== options.projectId) continue;
            if (options.correlationId && event.correlationId !== options.correlationId) continue;
            
            events.push(event);
            
            if (options.limit && events.length >= options.limit) {
              return events;
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
    
    return events;
  }

  /**
   * List telemetry files in date range
   */
  async listFiles(startDate, endDate) {
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    const files = [];
    const current = new Date(start);
    
    while (current <= end) {
      const dateStr = current.toISOString().split("T")[0];
      files.push(path.join(this.telemetryDir, `events-${dateStr}.jsonl`));
      current.setDate(current.getDate() + 1);
    }
    
    return files;
  }

  /**
   * Clean up old telemetry files
   */
  async cleanup() {
    try {
      const entries = await fs.readdir(this.telemetryDir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.retentionDays);
      const cutoffStr = cutoff.toISOString().split("T")[0];
      
      for (const entry of entries) {
        const match = entry.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (match && match[1] < cutoffStr) {
          await fs.unlink(path.join(this.telemetryDir, entry));
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  /**
   * Get storage stats
   */
  async getStats() {
    try {
      const entries = await fs.readdir(this.telemetryDir);
      const files = entries.filter(e => e.endsWith(".jsonl"));
      
      let totalSize = 0;
      let totalEvents = 0;
      
      for (const file of files) {
        const stat = await fs.stat(path.join(this.telemetryDir, file));
        totalSize += stat.size;
        
        const content = await fs.readFile(path.join(this.telemetryDir, file), "utf8");
        totalEvents += content.trim().split("\n").filter(Boolean).length;
      }
      
      return {
        fileCount: files.length,
        totalSizeBytes: totalSize,
        totalEvents,
        oldestFile: files.sort()[0] || null,
        newestFile: files.sort().pop() || null,
      };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { fileCount: 0, totalSizeBytes: 0, totalEvents: 0 };
      }
      throw err;
    }
  }
}

/**
 * Create storage instance for a project
 */
export function createTelemetryStorage(projectRoot) {
  return new TelemetryStorage(projectRoot);
}
