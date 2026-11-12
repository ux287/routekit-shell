import fs from "fs";
import path from "path";

function parseSince(since) {
  if (!since || typeof since !== "string") return null;
  const match = since.trim().match(/^(\d+)(h|d|w)$/i);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const msMap = { h: 3600000, d: 86400000, w: 604800000 };
  return new Date(Date.now() - amount * msMap[unit]);
}

export async function queryTelemetry(projectRoot, opts = {}) {
  const telemetryDir = path.join(projectRoot, ".rks", "telemetry");
  const limit = Math.min(Number(opts.limit || 100), 1000);
  const typeFilter = opts.type;
  const correlationId = opts.correlationId;
  const storyIdFilter = opts.storyId || opts.problemId || null;
  // since takes precedence over startDate
  const sinceDate = opts.since ? parseSince(opts.since) : null;
  const startDate = sinceDate || (opts.startDate ? new Date(opts.startDate) : null);
  const endDate = opts.endDate ? new Date(opts.endDate) : null;
  const lastNCycles = opts.lastNCycles ? Math.max(1, parseInt(opts.lastNCycles, 10)) : null;
  const format = opts.format || "json";

  let total = 0;
  const returnedEvents = [];
  const countsByType = {};

  try {
    if (!fs.existsSync(telemetryDir)) {
      return {
        ok: true,
        total: 0,
        limit,
        returned: 0,
        events: [],
        summary: {},
      };
    }

    const allFiles = fs.readdirSync(telemetryDir).filter((f) => f.endsWith(".jsonl")).sort();
    const files = lastNCycles ? allFiles.slice(-lastNCycles) : allFiles;

    for (const file of files) {
      const filePath = path.join(telemetryDir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        if (!line || !line.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (e) {
          // skip invalid json lines
          continue;
        }

        // Filter by type
        if (typeFilter && ev.type !== typeFilter) continue;

        // Filter by correlationId
        if (correlationId && ev.correlationId !== correlationId) continue;

        // Filter by storyId/problemId
        if (storyIdFilter) {
          const evStory = ev.payload?.storyId || ev.payload?.problemId;
          if (evStory !== storyIdFilter) continue;
        }

        // Filter by date range. Support common timestamp keys.
        if (startDate || endDate) {
          const ts = ev.time || ev.timestamp || ev.ts || ev.date || ev.createdAt || null;
          if (ts) {
            const t = new Date(ts);
            if (startDate && t < startDate) continue;
            if (endDate && t > endDate) continue;
          }
        }

        total += 1;

        // track counts by type for the overall matched set
        const tKey = ev.type || "<unknown>";
        countsByType[tKey] = (countsByType[tKey] || 0) + 1;

        // collect up to limit events
        if (returnedEvents.length < limit) {
          returnedEvents.push(ev);
        }
      }
    }

    return {
      ok: true,
      total,
      limit,
      returned: returnedEvents.length,
      events: format === "summary" ? [] : returnedEvents,
      summary: countsByType,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
    };
  }
}
