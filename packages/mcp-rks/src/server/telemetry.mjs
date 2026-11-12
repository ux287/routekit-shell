import path from "path";
import fs from "fs";
import { ensureDir } from "./project.mjs";

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function appendCsvRow(filePath, headers, values) {
  ensureDir(path.dirname(filePath));
  const headerLine = `${headers.join(",")}`;
  const bodyLine = values
    .map((value) => {
      if (value === null || value === undefined) return "";
      const str = String(value).replace(/"/g, '""');
      return str.includes(",") ? `"${str}"` : str;
    })
    .join(",");
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${headerLine}\n`);
  }
  fs.appendFileSync(filePath, `${bodyLine}\n`);
}

export function buildTelemetryMetrics(plan, appliedFileCount) {
  const summary = plan?.ragContextSummary || {};
  return {
    ragNotes: summary.notesHitCount ?? null,
    ragCode: summary.codeHitCount ?? null,
    ragKg: summary.kgHitCount ?? null,
    appliedFiles: appliedFileCount,
  };
}

// Onboarder telemetry payload shapes (metrics field contents):
//   onboarder.session.started:   { projectId, version, source }
//   onboarder.stage.started:     { stage }
//   onboarder.stage.completed:   { stage, durationSeconds, [storyId], [rawCost], [efficientCost], [wasteRatio], [prUrl], [prState] }
//   onboarder.stage.skipped:     { stage, reason }
//   onboarder.stage.failed:      { stage, failureReason, governorError }
//   onboarder.completed:         { totalDurationSeconds, totalTokens, storiesShipped, stagesSkipped }
//   onboarder.abandoned:         { stuckAt, lastTouchedAt }
export function recordTelemetry(projectRoot, payload) {
  // Use imported fs (ESM) instead of require. Be defensive about missing fields.
  const telemetryDir = path.join(projectRoot, ".rks", "telemetry");
  ensureDir(telemetryDir);
  const timestamp = payload && payload.timestamp ? String(payload.timestamp) : new Date().toISOString();
  const safeStamp = timestamp.replace(/[:.]/g, "-");
  const fileName = `${safeStamp}_${payload?.slug || payload?.runId || "run"}.json`;
  const filePath = path.join(telemetryDir, fileName);
  // Write full payload JSON
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

  // Append a summary CSV row (keep original schema). Be defensive if metrics missing.
  const summaryPath = path.join(telemetryDir, "summary.csv");
  const metrics = payload?.metrics || {};
  appendCsvRow(
    summaryPath,
    [
      "timestamp",
      "runId",
      "slug",
      "ragNotes",
      "ragCode",
      "ragKg",
      "appliedFiles",
      "guardrailScenario",
      "guardrailStatus",
    ],
    [
      timestamp,
      payload?.runId || "",
      payload?.slug || "",
      metrics.ragNotes ?? "",
      metrics.ragCode ?? "",
      metrics.ragKg ?? "",
      metrics.appliedFiles ?? "",
      payload?.guardrail?.scenario || "",
      payload?.guardrail?.status || "",
    ]
  );
}
