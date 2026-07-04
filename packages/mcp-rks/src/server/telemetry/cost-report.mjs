/**
 * Token cost aggregation engine
 *
 * Aggregates per-event token counts into per-phase totals with waste
 * categorization and health bands for rks_token_cost_report.
 */
import fs from "fs";
import path from "path";

const TELEMETRY_DIR = ".rks/telemetry";

// Waste categories
const WASTE_RETRY = "retry";
const WASTE_FAILED_PLAN = "failed_plan";
const WASTE_FAILED_EXEC = "failed_exec";

function readEventsForStory(projectRoot, storyId) {
  const telemetryDir = path.join(projectRoot, TELEMETRY_DIR);
  if (!fs.existsSync(telemetryDir)) return [];
  const events = [];
  try {
    const files = fs.readdirSync(telemetryDir).filter(f => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(telemetryDir, file), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (!storyId || ev.payload?.problemId === storyId || ev.payload?.storyId === storyId) {
            events.push(ev);
          }
        } catch { /* skip bad lines */ }
      }
    }
  } catch { /* best effort */ }
  return events;
}

function readEventsForCommit(projectRoot, commitSha) {
  const telemetryDir = path.join(projectRoot, TELEMETRY_DIR);
  if (!fs.existsSync(telemetryDir)) return [];
  const events = [];
  const shortSha = commitSha?.slice(0, 8);
  try {
    const files = fs.readdirSync(telemetryDir).filter(f => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const content = fs.readFileSync(path.join(telemetryDir, file), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const evSha = ev.payload?.commitSha || ev.payload?.commitId;
          if (evSha && (evSha === commitSha || evSha === shortSha)) {
            events.push(ev);
          }
        } catch { /* skip bad lines */ }
      }
    }
  } catch { /* best effort */ }
  return events;
}

function categorizeWaste(events) {
  const sorted = [...events].sort((a, b) => {
    const ta = a.timestamp || a.ts || "";
    const tb = b.timestamp || b.ts || "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  const waste = [];

  // Index by correlationId for fast lookup
  const byCorrelation = new Map();
  for (const ev of sorted) {
    const cid = ev.correlationId;
    if (!cid) continue;
    if (!byCorrelation.has(cid)) byCorrelation.set(cid, []);
    byCorrelation.get(cid).push(ev);
  }

  // plan.failed → failed_plan
  for (const ev of sorted) {
    if (ev.type === "plan.failed") {
      waste.push({ eventId: ev.id, type: WASTE_FAILED_PLAN, correlationId: ev.correlationId });
    }
  }

  // plan.complete with ok:false or status:error followed by refine.start on same correlationId → retry
  for (const ev of sorted) {
    if (ev.type !== "plan.complete") continue;
    const failed = ev.payload?.ok === false || ev.payload?.status === "error";
    if (!failed) continue;
    const cid = ev.correlationId;
    if (!cid) continue;
    const siblings = byCorrelation.get(cid) || [];
    const hasRefine = siblings.some(s => s.type === "refine.start" && s.timestamp > ev.timestamp);
    if (hasRefine) {
      waste.push({ eventId: ev.id, type: WASTE_RETRY, correlationId: cid });
    }
  }

  // exec.failed where a subsequent exec.complete exists on same correlationId → failed_exec
  for (const ev of sorted) {
    if (ev.type !== "exec.failed") continue;
    const cid = ev.correlationId;
    if (!cid) continue;
    const siblings = byCorrelation.get(cid) || [];
    const hasSuccessLater = siblings.some(
      s => s.type === "exec.complete" && s.timestamp > ev.timestamp
    );
    if (hasSuccessLater) {
      waste.push({ eventId: ev.id, type: WASTE_FAILED_EXEC, correlationId: cid });
    }
  }

  return waste;
}

function formatMarkdown(report) {
  const pct = (r) => `${(r * 100).toFixed(1)}%`;
  const healthEmoji = { green: "🟢", yellow: "🟡", red: "🔴" };
  const emoji = healthEmoji[report.healthBand] || "⚪";
  const wasteCount = report.wasteEvents?.length || 0;
  const lines = [
    `## Token Cost & Efficiency`,
    ``,
    `**Total tokens:** ${report.rawCost.toLocaleString()} (in + out)`,
    `**Waste ratio:** ${pct(report.wasteRatio)} ${emoji} ${report.healthBand}`,
    `**Cache ratio:** ${pct(report.cacheRatio)}`,
    `**Efficient tokens:** ${report.efficientCost.toLocaleString()}`,
    `**Waste events:** ${wasteCount}`,
  ];
  return lines.join("\n");
}

/**
 * Generate a cost and efficiency report for a given scope.
 *
 * @param {string} projectRoot
 * @param {object} opts
 * @param {'commit'|'story'} opts.scope
 * @param {string} [opts.commitSha]
 * @param {string} [opts.storyId]
 * @param {'summary'|'json'|'markdown'} [opts.format]
 * @returns {object}
 */
export function generateCostReport(projectRoot, opts = {}) {
  const { scope, commitSha, storyId, format = "json" } = opts;

  let events;
  if (scope === "commit" && commitSha) {
    events = readEventsForCommit(projectRoot, commitSha);
  } else {
    events = readEventsForStory(projectRoot, storyId || null);
  }

  // Only consider events that have token data
  const tokenEvents = events.filter(ev => ev.payload?.tokens != null);

  if (tokenEvents.length === 0) {
    return { ok: true, noData: true, scope, storyId: storyId || null, commitSha: commitSha || null };
  }

  const wasteEvents = categorizeWaste(events);
  const wastedIds = new Set(wasteEvents.map(w => w.eventId));

  let rawCost = 0;
  let wastedCost = 0;
  let cacheReadTotal = 0;
  let inputTotal = 0;

  // Phase grouping: accumulate per event
  const phases = {};
  for (const ev of tokenEvents) {
    const tokens = ev.payload.tokens;
    const tokIn = tokens.in || 0;
    const tokOut = tokens.out || 0;
    const tokCacheRead = tokens.cacheRead || 0;
    const eventCost = tokIn + tokOut;

    rawCost += eventCost;
    inputTotal += tokIn;
    cacheReadTotal += tokCacheRead;

    if (wastedIds.has(ev.id)) {
      wastedCost += eventCost;
    }

    // Group by event type prefix as phase
    const phase = ev.type?.split(".")[0] || "unknown";
    if (!phases[phase]) phases[phase] = { calls: 0, tokens: 0, wastedTokens: 0, wastedCalls: 0 };
    phases[phase].calls += 1;
    phases[phase].tokens += eventCost;
    if (wastedIds.has(ev.id)) {
      phases[phase].wastedTokens += eventCost;
      phases[phase].wastedCalls += 1;
    }
  }

  const efficientCost = rawCost - wastedCost;
  const wasteRatio = rawCost > 0 ? (rawCost - efficientCost) / rawCost : 0;
  const totalInputTokens = inputTotal + cacheReadTotal;
  const cacheRatio = totalInputTokens > 0 ? cacheReadTotal / totalInputTokens : 0;
  const healthBand = wasteRatio < 0.10 ? "green" : wasteRatio <= 0.30 ? "yellow" : "red";

  const phaseSummary = Object.entries(phases)
    .map(([name, p]) =>
      p.wastedCalls > 0
        ? `${name} x${p.calls} (${p.wastedCalls} failed)`
        : `${name} x${p.calls} ok`
    )
    .join(' | ');

  const result = {
    ok: true,
    noData: false,
    scope,
    storyId: storyId || null,
    commitSha: commitSha || null,
    rawCost,
    efficientCost,
    wasteRatio,
    cacheRatio,
    healthBand,
    phaseSummary,
    phases,
    wasteEvents,
    totalEvents: tokenEvents.length,
  };

  if (format === "markdown") {
    result.markdown = formatMarkdown(result);
  }

  return result;
}

/**
 * Generate per-day token cost series for trend charts.
 *
 * @param {string} projectRoot
 * @param {object} opts
 * @param {number} [opts.days=14]
 * @returns {Array<{ date: string, rawCost: number, wasteRatio: number, cacheRatio: number, noData: boolean }>}
 */
export function generateDailyCostSeries(projectRoot, { days = 14 } = {}) {
  const telemetryDir = path.join(projectRoot, TELEMETRY_DIR);

  // Build ordered date array oldest → newest
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }

  const byDate = Object.fromEntries(dates.map(d => [d, []]));

  if (fs.existsSync(telemetryDir)) {
    try {
      const files = fs.readdirSync(telemetryDir).filter(f => f.endsWith(".jsonl")).sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(telemetryDir, file), "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            const evDate = ev.timestamp?.split("T")[0];
            if (evDate && byDate[evDate] !== undefined) byDate[evDate].push(ev);
          } catch { /* skip bad lines */ }
        }
      }
    } catch { /* best effort */ }
  }

  return dates.map(date => {
    const events = byDate[date];
    const tokenEvents = events.filter(ev => ev.payload?.tokens != null);
    if (tokenEvents.length === 0) return { date, rawCost: 0, wasteRatio: 0, cacheRatio: 0, noData: true };

    let rawCost = 0, wastedCost = 0, cacheReadTotal = 0, inputTotal = 0;
    const wasteEvents = categorizeWaste(events);
    const wastedIds = new Set(wasteEvents.map(w => w.eventId));

    for (const ev of tokenEvents) {
      const t = ev.payload.tokens;
      const cost = (t.in || 0) + (t.out || 0);
      rawCost += cost;
      inputTotal += t.in || 0;
      cacheReadTotal += t.cacheRead || 0;
      if (wastedIds.has(ev.id)) wastedCost += cost;
    }

    const totalInput = inputTotal + cacheReadTotal;
    return {
      date,
      rawCost,
      wasteRatio: rawCost > 0 ? wastedCost / rawCost : 0,
      cacheRatio: totalInput > 0 ? cacheReadTotal / totalInput : 0,
      noData: false,
    };
  });
}
