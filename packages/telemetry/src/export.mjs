/**
 * Telemetry export — bundle a project's telemetry into ONE shareable, REDACTED artifact
 * pair (.json + .md) suitable for UAT reports and attaching to a GitHub issue.
 *
 * Reuses the existing readers rather than reimplementing aggregation:
 *   - queryTelemetry (./query.mjs)      → events + counts
 *   - generateCostReport (./cost-report.mjs) → token/cost summary (degrades gracefully)
 * and runs everything through the redaction core (./redact.mjs) before writing, so no
 * secret ever lands in a file meant to be shared.
 *
 * MVP: local file output only — NO network / NO upload. The deferred opt-in "share
 * anonymous usage data" uploader reuses redactValue + this bundle shape verbatim.
 */
import fs from "fs";
import path from "path";
import { queryTelemetry } from "./query.mjs";
import { generateCostReport } from "./cost-report.mjs";
import { redactValue, redactEvent } from "./redact.mjs";

const SCHEMA_VERSION = 1;
const TIMELINE_LIMIT = 100;

function eventTimestamp(ev) {
  return ev.timestamp || ev.ts || "";
}

/**
 * Produce a redacted telemetry export bundle.
 *
 * @param {string} projectRoot absolute project root (its `.rks/telemetry` is read)
 * @param {object} [opts]
 * @param {string} [opts.projectId] project id (recorded in meta; NOT a secret in MVP)
 * @param {string} [opts.storyId]   scope the export to one story (else whole project)
 * @param {string} [opts.outDir]    output dir (default `<projectRoot>/.rks/exports`)
 * @param {string} [opts.timestamp] ISO generatedAt (default now) — injectable for tests
 * @param {string} [opts.stamp]     filename stamp (default derived from timestamp) — injectable
 * @param {number} [opts.limit]     max events to read (default 1000)
 * @returns {{ok:true, jsonPath:string, mdPath:string, eventCount:number, degraded:boolean, cost:object}}
 */
export async function exportTelemetry(projectRoot, opts = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    return { ok: false, error: "exportTelemetry: projectRoot is required" };
  }
  const timestamp = opts.timestamp || new Date().toISOString();
  const stamp = opts.stamp || timestamp.replace(/[:.]/g, "-");
  const outDir = opts.outDir || path.join(projectRoot, ".rks", "exports");
  const storyId = opts.storyId || null;
  const limit = opts.limit || 1000;

  // --- gather (reuse existing readers) ---
  const q = await queryTelemetry(projectRoot, { limit, storyId: storyId || undefined });
  const events = Array.isArray(q?.events) ? q.events : [];
  const total = typeof q?.total === "number" ? q.total : events.length;

  const countsByType = {};
  for (const ev of events) {
    const t = ev.type || "(unknown)";
    countsByType[t] = (countsByType[t] || 0) + 1;
  }

  const cost = generateCostReport(projectRoot, { scope: "story", storyId: storyId || undefined });
  const costDegraded = !cost || cost.ok !== true || cost.noData === true;
  const costSection = costDegraded
    ? { degraded: true, reason: "no token/cost events found for this scope" }
    : cost;

  const timeline = [...events]
    .sort((a, b) => (eventTimestamp(a) < eventTimestamp(b) ? -1 : 1))
    .slice(-TIMELINE_LIMIT)
    .map((ev) => ({
      ts: eventTimestamp(ev),
      type: ev.type || "(unknown)",
      storyId: ev.payload?.problemId || ev.payload?.storyId || null,
      correlationId: ev.correlationId || null,
    }));

  // --- build report, then REDACT the whole thing before it touches disk ---
  const rawReport = {
    meta: {
      schema: SCHEMA_VERSION,
      tool: "rks_telemetry_export",
      generatedAt: timestamp,
      projectId: opts.projectId || null,
      storyId,
    },
    events: { total, sampled: events.length, countsByType },
    cost: costSection,
    timeline,
  };
  const report = redactValue(rawReport, { projectRoot });
  // events already summarized; redact the timeline entries defensively too (redactValue
  // above already handled them, but keep redactEvent in the reuse path for the uploader).
  report.timeline = report.timeline.map((t) => redactEvent(t, { projectRoot }));

  // --- write bundle ---
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `telemetry-${stamp}.json`);
  const mdPath = path.join(outDir, `telemetry-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(mdPath, renderMarkdown(report) + "\n");

  return {
    ok: true,
    jsonPath,
    mdPath,
    eventCount: total,
    degraded: costDegraded,
    cost: costSection,
  };
}

/** Human-readable summary built from the ALREADY-REDACTED report (no secrets reach here). */
function renderMarkdown(report) {
  const { meta, events, cost, timeline } = report;
  const lines = [];
  lines.push(`# Telemetry export`);
  lines.push("");
  lines.push(`- **Generated:** ${meta.generatedAt}`);
  lines.push(`- **Project:** ${meta.projectId || "(unspecified)"}`);
  lines.push(`- **Scope:** ${meta.storyId ? `story \`${meta.storyId}\`` : "whole project"}`);
  lines.push(`- **Events:** ${events.total} total (${events.sampled} sampled)`);
  lines.push("");

  lines.push(`## Event counts by type`);
  lines.push("");
  const entries = Object.entries(events.countsByType || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    lines.push("_No events._");
  } else {
    lines.push("| Type | Count |");
    lines.push("| --- | --- |");
    for (const [type, count] of entries) lines.push(`| ${type} | ${count} |`);
  }
  lines.push("");

  lines.push(`## Token cost`);
  lines.push("");
  if (cost?.degraded) {
    lines.push(`_Cost data unavailable — ${cost.reason}._`);
  } else {
    lines.push(`- **Total tokens (in+out):** ${cost.rawCost ?? "n/a"}`);
    if (cost.wasteRatio != null) lines.push(`- **Waste ratio:** ${(cost.wasteRatio * 100).toFixed(1)}%`);
    if (cost.cacheRatio != null) lines.push(`- **Cache ratio:** ${(cost.cacheRatio * 100).toFixed(1)}%`);
    if (cost.healthBand) lines.push(`- **Health:** ${cost.healthBand}`);
  }
  lines.push("");

  lines.push(`## Timeline (most recent ${timeline.length})`);
  lines.push("");
  if (timeline.length === 0) {
    lines.push("_No events._");
  } else {
    lines.push("| Time | Type | Story |");
    lines.push("| --- | --- | --- |");
    for (const t of timeline) lines.push(`| ${t.ts || ""} | ${t.type} | ${t.storyId || ""} |`);
  }
  return lines.join("\n");
}
