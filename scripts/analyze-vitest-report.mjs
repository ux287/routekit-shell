#!/usr/bin/env node
/**
 * Read a vitest --reporter=json output file and emit a CI diagnostic report
 * (markdown) to either $GITHUB_STEP_SUMMARY (CI) or stdout (local).
 *
 * Sections, in order:
 *   1. ✖ Failures — failed assertion list (top 5 + "+N more"). Lede if any.
 *   2. ⚠ Timeouts — failures whose message matches /timed out|timeout/i. Often
 *      a different fix from regular failures (raise the timeout vs fix the test).
 *   3. Run summary — one line: tests, passed, failed, skipped, wall-clock, tier.
 *   4. ⏱ Slowness watch — top 10 slowest files (≥1000ms threshold).
 *   5. Long-tail warning — appears if wall-clock > 30min, with headroom against
 *      the 60min spawn-managed wrapper cap.
 *
 * Usage:
 *   node scripts/analyze-vitest-report.mjs <path-to-report.json>
 *   ROUTEKIT_VITEST_JSON_OUTPUT=<path> node scripts/analyze-vitest-report.mjs
 *
 * Behavior on edge cases:
 *   - Missing report file: "No JSON report found" notice, exit 0.
 *   - Malformed JSON: parse-error notice, exit 0.
 *   - Empty/recognized-but-no-data: documented "schema may have shifted" notice.
 *
 * No subprocess spawns. Pure JSON read + markdown emit. See
 * backlog.feat.capture-per-test-timing-in-ci.
 */

import fs from "node:fs";
import path from "node:path";

const reportPath =
  process.argv[2] ||
  process.env.ROUTEKIT_VITEST_JSON_OUTPUT ||
  "";

// Resolve the output destination. In CI, $GITHUB_STEP_SUMMARY points to a file
// that's rendered as the job's summary. Locally, fall back to stdout.
const summaryFile = process.env.GITHUB_STEP_SUMMARY || "";

function emit(markdown) {
  const text = markdown.endsWith("\n") ? markdown : markdown + "\n";
  if (summaryFile) {
    fs.appendFileSync(summaryFile, text);
  } else {
    process.stdout.write(text);
  }
}

if (!reportPath) {
  emit("### Vitest timing report\n\nNo report path provided. Set `ROUTEKIT_VITEST_JSON_OUTPUT` or pass the path as the first argument.\n");
  process.exit(0);
}

if (!fs.existsSync(reportPath)) {
  emit(`### Vitest timing report\n\nNo JSON report found at \`${reportPath}\`. The test step likely crashed before the JSON write; check the test step logs for the underlying failure.\n`);
  process.exit(0);
}

let report;
try {
  const raw = fs.readFileSync(reportPath, "utf8");
  report = JSON.parse(raw);
} catch (err) {
  emit(`### Vitest timing report\n\nFailed to parse JSON at \`${reportPath}\`: ${err.message}\n`);
  process.exit(0);
}

// vitest's --reporter=json output shape (loose): top-level keys include
// `testResults` (array of suites). Each suite: `name`/`filepath`,
// `startTime`/`endTime`, `assertionResults: [{ status, title, ancestorTitles,
// failureMessages, duration }]`.
function extractFileSummaries(rep) {
  const out = [];
  const testResults = Array.isArray(rep.testResults) ? rep.testResults : null;
  if (testResults) {
    for (const suite of testResults) {
      const file = suite.name || suite.filepath || "<unknown>";
      const duration_ms =
        typeof suite.endTime === "number" && typeof suite.startTime === "number"
          ? Math.max(0, suite.endTime - suite.startTime)
          : typeof suite.duration === "number"
          ? Math.max(0, suite.duration)
          : 0;
      const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
      const tests_run = assertions.length;
      const tests_failed = assertions.filter((a) => a.status === "failed").length;
      out.push({ file, duration_ms, tests_run, tests_failed, assertions, startTime: suite.startTime, endTime: suite.endTime });
    }
  }
  return out;
}

const fileSummaries = extractFileSummaries(report);

if (fileSummaries.length === 0) {
  emit(`### Vitest timing report\n\nNo recognizable file summaries in \`${reportPath}\`. Schema may have shifted; investigate the JSON shape.\n`);
  process.exit(0);
}

function relativize(absOrRel) {
  try {
    const cwd = process.cwd();
    if (absOrRel.startsWith(cwd)) return absOrRel.slice(cwd.length + 1);
  } catch {
    /* fall through */
  }
  return absOrRel;
}

// Tier identification from report filename: "vitest-<tier>-<id>.json".
function deriveTier(reportPath) {
  const base = path.basename(reportPath);
  const m = base.match(/^vitest-([a-z]+)-/);
  return m ? m[1] : "unknown";
}
const tier = deriveTier(reportPath);

// ===== Aggregate stats =====
let totalRun = 0;
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const allFailures = []; // { file, suite (joined ancestor titles), title, failureMessages, duration_ms }
let minStartTime = Infinity;
let maxEndTime = -Infinity;

for (const f of fileSummaries) {
  if (typeof f.startTime === "number") minStartTime = Math.min(minStartTime, f.startTime);
  if (typeof f.endTime === "number") maxEndTime = Math.max(maxEndTime, f.endTime);
  for (const a of f.assertions) {
    totalRun++;
    if (a.status === "passed") totalPassed++;
    else if (a.status === "failed") {
      totalFailed++;
      allFailures.push({
        file: relativize(f.file),
        suite: Array.isArray(a.ancestorTitles) ? a.ancestorTitles.join(" > ") : "",
        title: a.title || "<unnamed>",
        failureMessages: Array.isArray(a.failureMessages) ? a.failureMessages : [],
        duration_ms: typeof a.duration === "number" ? a.duration : 0,
      });
    } else if (a.status === "skipped" || a.status === "todo" || a.status === "pending") {
      totalSkipped++;
    }
  }
}

const wallClockMs = isFinite(minStartTime) && isFinite(maxEndTime) ? Math.max(0, maxEndTime - minStartTime) : 0;
const wallClockMin = wallClockMs / 60_000;

function firstLine(s) {
  if (!s) return "";
  const lines = String(s).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 200 ? trimmed.slice(0, 197) + "..." : trimmed;
  }
  return "";
}

function isTimeoutFailure(f) {
  const joined = (f.failureMessages || []).join("\n");
  return /\btimed out|\btimeout\b/i.test(joined);
}

const timeoutFailures = allFailures.filter(isTimeoutFailure);
const regularFailures = allFailures.filter((f) => !isTimeoutFailure(f));

// ===== Build the markdown =====
const lines = [];

// Section 1 — Failures (lede if any)
if (regularFailures.length > 0) {
  lines.push(`### ✖ Failures (${regularFailures.length})`);
  lines.push("");
  const shown = regularFailures.slice(0, 5);
  for (const f of shown) {
    const suitePath = f.suite ? `${f.suite} > ` : "";
    lines.push(`- **${relativize(f.file)}** — ${suitePath}\`${f.title}\``);
    const msg = firstLine(f.failureMessages[0] || "");
    if (msg) lines.push(`  - \`${msg}\``);
  }
  if (regularFailures.length > shown.length) {
    lines.push(`- _+${regularFailures.length - shown.length} more — see the failed-step log for the full list._`);
  }
  lines.push("");
}

// Section 2 — Timeouts (separate section if any, since the fix is different)
if (timeoutFailures.length > 0) {
  lines.push(`### ⚠ Timeouts (${timeoutFailures.length})`);
  lines.push("");
  lines.push("_These tests exceeded their configured timeout. Often the right fix is to raise the per-test timeout or break the test up, not to fix the test logic._");
  lines.push("");
  const shown = timeoutFailures.slice(0, 5);
  for (const f of shown) {
    const suitePath = f.suite ? `${f.suite} > ` : "";
    lines.push(`- **${relativize(f.file)}** — ${suitePath}\`${f.title}\``);
    const msg = firstLine(f.failureMessages[0] || "");
    if (msg) lines.push(`  - \`${msg}\``);
  }
  if (timeoutFailures.length > shown.length) {
    lines.push(`- _+${timeoutFailures.length - shown.length} more._`);
  }
  lines.push("");
}

// Section 3 — Run summary (always)
{
  const wallMmSs = `${Math.floor(wallClockMin)}m ${Math.floor((wallClockMs % 60_000) / 1000)}s`;
  const filesShown = `${fileSummaries.length} file${fileSummaries.length === 1 ? "" : "s"}`;
  lines.push(`### Run summary`);
  lines.push("");
  lines.push(`Tier: **${tier}** · ${filesShown} · ${totalRun} tests · ✅ ${totalPassed} passed · ❌ ${totalFailed} failed · ↓ ${totalSkipped} skipped · ⏱ ${wallMmSs} wall-clock`);
  lines.push("");
}

// Section 4 — Slowness watch (always)
{
  const interesting = fileSummaries
    .filter((s) => s.duration_ms >= 1000)
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 10);
  lines.push(`### ⏱ Slowness watch — top 10 slowest files`);
  lines.push("");
  lines.push(`Report: \`${path.basename(reportPath)}\``);
  lines.push("");
  if (interesting.length === 0) {
    lines.push(`_All files completed in under 1000ms. Nothing worth flagging._`);
  } else {
    lines.push(`| file | duration_ms | tests_run | tests_failed |`);
    lines.push(`|---|---:|---:|---:|`);
    for (const s of interesting) {
      lines.push(`| \`${relativize(s.file)}\` | ${s.duration_ms.toFixed(0)} | ${s.tests_run} | ${s.tests_failed} |`);
    }
  }
  lines.push("");
}

// Section 5 — Long-tail warning (only when wall-clock > 30min)
if (wallClockMin > 30) {
  const cap = 60; // spawn-managed wrapper timeout in minutes
  const headroom = (cap - wallClockMin).toFixed(1);
  const warningEmoji = wallClockMin > 50 ? "🚨" : "⚠️";
  lines.push(`### ${warningEmoji} Long-tail warning`);
  lines.push("");
  lines.push(`Wall-clock **${wallClockMin.toFixed(1)} min** of the **${cap} min** spawn-managed wrapper cap. Headroom: **${headroom} min**.`);
  if (wallClockMin > 50) {
    lines.push("");
    lines.push("Approaching the cap. Consider quarantining the slowest files into their own tier, parallelizing, or paying down skip-debt that's blocking re-enables.");
  }
  lines.push("");
}

emit(lines.join("\n"));
process.exit(0);
