#!/usr/bin/env node

/**
 * Telemetry Dashboard
 *
 * A terminal-based dashboard for viewing RKS telemetry events.
 *
 * Usage:
 *   node scripts/telemetry/dashboard.mjs              # Show today's events
 *   node scripts/telemetry/dashboard.mjs --watch      # Live mode (auto-refresh)
 *   node scripts/telemetry/dashboard.mjs --days 7     # Show last 7 days
 *   node scripts/telemetry/dashboard.mjs --type plan  # Filter by event type
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateCostReport, generateDailyCostSeries } from "../../packages/mcp-rks/src/server/telemetry/cost-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const TELEMETRY_DIR = path.join(PROJECT_ROOT, ".rks", "telemetry");

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

// Event type categories for coloring
const eventCategories = {
  success: ["plan.complete", "exec.complete", "refine.complete", "ship.success", "story_ship.success"],
  failure: ["plan.failed", "exec.failed", "refine.failed", "ship.failed", "story_ship.failed", "story.plan.quality_failed"],
  start: ["plan.start", "exec.start", "refine.start", "ship.start", "story_ship.start"],
  guardrails: ["guardrails.on", "guardrails.off"],
  git: ["git.commit", "git.branch", "ship.step.completed", "story_ship.step.completed"],
  rag: ["rag.query", "rag.embed"],
};

function getEventColor(type) {
  if (eventCategories.success.some(t => type.includes(t) || type === t)) return colors.green;
  if (eventCategories.failure.some(t => type.includes(t) || type === t)) return colors.red;
  if (eventCategories.start.some(t => type.includes(t) || type === t)) return colors.cyan;
  if (eventCategories.guardrails.some(t => type.includes(t) || type === t)) return colors.yellow;
  if (eventCategories.git.some(t => type.includes(t) || type === t)) return colors.blue;
  if (eventCategories.rag.some(t => type.includes(t) || type === t)) return colors.magenta;
  return colors.dim;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function getDateRange(days) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }
  return dates;
}

function readEvents(days = 1, typeFilter = null) {
  const events = [];
  const dates = getDateRange(days);

  for (const date of dates) {
    const filePath = path.join(TELEMETRY_DIR, `events-${date}.jsonl`);
    if (!fs.existsSync(filePath)) continue;

    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (typeFilter && !event.type.includes(typeFilter)) continue;
        events.push(event);
      } catch (e) {
        // Skip malformed lines
      }
    }
  }

  return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function aggregateByType(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));
}

function calculateStats(events) {
  const planStarts = events.filter(e => e.type === "plan.start").length;
  const planCompletes = events.filter(e => e.type === "plan.complete").length;
  const planFails = events.filter(e => e.type === "plan.failed").length;
  const execStarts = events.filter(e => e.type === "exec.start").length;
  const execCompletes = events.filter(e => e.type === "exec.complete").length;
  const execFails = events.filter(e => e.type === "exec.failed").length;
  const shipSuccess = events.filter(e => e.type === "ship.success" || e.type === "story_ship.success").length;
  const guardrailsOff = events.filter(e => e.type === "guardrails.off").length;
  const guardrailsOn = events.filter(e => e.type === "guardrails.on").length;

  return {
    plans: { starts: planStarts, completes: planCompletes, fails: planFails },
    execs: { starts: execStarts, completes: execCompletes, fails: execFails },
    ships: shipSuccess,
    guardrails: { off: guardrailsOff, on: guardrailsOn },
  };
}

export function renderActivityByStory(events, projectRoot) {
  const storyIds = [...new Set(events.filter(e => e.payload?.problemId).map(e => e.payload.problemId))];

  console.log(`\n${colors.bold}── Activity by Story ─────────────────────────────────────────────${colors.reset}`);

  if (storyIds.length === 0) {
    console.log(`  ${colors.dim}No story activity in this time range.${colors.reset}`);
    return;
  }

  const healthColor = { green: colors.green, yellow: colors.yellow, red: colors.red };
  const pct = r => `${(r * 100).toFixed(0)}%`;

  console.log(`  ${"Story ID".padEnd(45)} ${"Tokens".padStart(8)} ${"Waste".padStart(7)}  Health`);
  console.log(`  ${colors.dim}${"─".repeat(45)} ${"─".repeat(8)} ${"─".repeat(7)}  ──────${colors.reset}`);

  for (const storyId of storyIds.slice(0, 15)) {
    const report = generateCostReport(projectRoot, { scope: "story", storyId });
    if (report.noData) {
      console.log(`  ${colors.dim}${storyId.slice(0, 44).padEnd(45)} ${"—".padStart(8)} ${"—".padStart(7)}  —${colors.reset}`);
      continue;
    }
    const hc = healthColor[report.healthBand] || colors.dim;
    console.log(
      `  ${colors.cyan}${storyId.slice(0, 44).padEnd(45)}${colors.reset}` +
      ` ${report.rawCost.toLocaleString().padStart(8)}` +
      ` ${pct(report.wasteRatio).padStart(7)}` +
      `  ${hc}${report.healthBand}${colors.reset}`
    );
  }

  if (storyIds.length > 15) {
    console.log(`  ${colors.dim}... and ${storyIds.length - 15} more stories${colors.reset}`);
  }
}

export function renderTokenSpendAndEfficiency(projectRoot, days = 14) {
  const series = generateDailyCostSeries(projectRoot, { days });
  const activeDays = series.filter(d => !d.noData);

  console.log(`\n${colors.bold}── Token Spend & Efficiency ──────────────────────────────────────${colors.reset}`);

  if (activeDays.length === 0) {
    console.log(`  ${colors.dim}No token data available for this time range.${colors.reset}`);
    return;
  }

  const maxCost = Math.max(...series.map(d => d.rawCost), 1);
  const healthColor = r => r < 0.10 ? colors.green : r <= 0.30 ? colors.yellow : colors.red;

  console.log(`\n  ${colors.bold}Cost over time (last ${days} days):${colors.reset}`);
  for (const d of series) {
    const barLen = Math.round((d.rawCost / maxCost) * 30);
    const hc = healthColor(d.wasteRatio);
    const label = d.date.slice(5);
    const bar = "█".repeat(barLen).padEnd(30);
    const val = d.noData ? colors.dim + "—" : colors.dim + d.rawCost.toLocaleString();
    console.log(`  ${colors.dim}${label}${colors.reset} ${hc}${bar}${colors.reset} ${val}${colors.reset}`);
  }

  console.log(`\n  ${colors.bold}Efficiency trend (waste ratio):${colors.reset}`);
  for (const d of activeDays) {
    const hc = healthColor(d.wasteRatio);
    const barLen = Math.round(d.wasteRatio * 20);
    const bar = "▓".repeat(barLen).padEnd(20);
    const pct = `${(d.wasteRatio * 100).toFixed(0)}%`;
    console.log(`  ${colors.dim}${d.date.slice(5)}${colors.reset} ${hc}${bar} ${pct}${colors.reset}`);
  }

  const avgCacheRatio = activeDays.reduce((s, d) => s + d.cacheRatio, 0) / activeDays.length;
  const cacheBarLen = Math.round(avgCacheRatio * 20);
  const cacheBar = `${colors.cyan}${"█".repeat(cacheBarLen)}${colors.dim}${"░".repeat(20 - cacheBarLen)}${colors.reset}`;
  const totalCost = series.reduce((s, d) => s + d.rawCost, 0);

  console.log(`\n  ${colors.bold}Cache-hit ratio (avg):${colors.reset} ${cacheBar} ${colors.cyan}${(avgCacheRatio * 100).toFixed(1)}%${colors.reset}`);
  console.log(`  ${colors.bold}Total tokens (${days}d):${colors.reset}    ${colors.cyan}${totalCost.toLocaleString()}${colors.reset}`);
}

function renderDashboard(events, days, typeFilter) {
  const stats = calculateStats(events);
  const typeCounts = aggregateByType(events);

  // Clear screen in watch mode
  if (process.argv.includes("--watch")) {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  // Header
  console.log(`\n${colors.bold}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bold}║                    RKS TELEMETRY DASHBOARD                    ║${colors.reset}`);
  console.log(`${colors.bold}╚══════════════════════════════════════════════════════════════╝${colors.reset}\n`);

  const now = new Date().toLocaleString();
  console.log(`${colors.dim}Last updated: ${now} | Range: ${days} day(s)${typeFilter ? ` | Filter: ${typeFilter}` : ""}${colors.reset}\n`);

  // Summary stats
  console.log(`${colors.bold}── Summary ──────────────────────────────────────────────────────${colors.reset}`);
  console.log(`  Total Events: ${colors.cyan}${events.length}${colors.reset}`);

  const planRate = stats.plans.starts > 0 ? ((stats.plans.completes / stats.plans.starts) * 100).toFixed(0) : 0;
  const execRate = stats.execs.starts > 0 ? ((stats.execs.completes / stats.execs.starts) * 100).toFixed(0) : 0;

  console.log(`  Plans: ${colors.cyan}${stats.plans.starts}${colors.reset} started, ${colors.green}${stats.plans.completes}${colors.reset} completed, ${colors.red}${stats.plans.fails}${colors.reset} failed (${planRate}% success)`);
  console.log(`  Execs: ${colors.cyan}${stats.execs.starts}${colors.reset} started, ${colors.green}${stats.execs.completes}${colors.reset} completed, ${colors.red}${stats.execs.fails}${colors.reset} failed (${execRate}% success)`);
  console.log(`  Ships: ${colors.green}${stats.ships}${colors.reset} successful`);
  console.log(`  Guardrails: ${colors.yellow}${stats.guardrails.off}${colors.reset} off sessions, ${colors.green}${stats.guardrails.on}${colors.reset} restored`);

  // Event type breakdown
  console.log(`\n${colors.bold}── Event Types ──────────────────────────────────────────────────${colors.reset}`);
  const topTypes = typeCounts.slice(0, 12);
  for (const { type, count } of topTypes) {
    const color = getEventColor(type);
    const bar = "█".repeat(Math.min(count, 30));
    console.log(`  ${color}${type.padEnd(30)}${colors.reset} ${count.toString().padStart(4)} ${colors.dim}${bar}${colors.reset}`);
  }
  if (typeCounts.length > 12) {
    console.log(`  ${colors.dim}... and ${typeCounts.length - 12} more types${colors.reset}`);
  }

  // Recent events
  console.log(`\n${colors.bold}── Recent Events ────────────────────────────────────────────────${colors.reset}`);
  const recent = events.slice(0, 15);
  for (const event of recent) {
    const color = getEventColor(event.type);
    const time = formatTimestamp(event.timestamp);
    const payload = event.projectId || {};

    // Extract useful info from payload
    let info = "";
    if (payload.problemId) info = payload.problemId;
    else if (payload.message) info = payload.message.slice(0, 40);
    else if (payload.commitId) info = `commit: ${payload.commitId}`;
    else if (payload.branch) info = `branch: ${payload.branch}`;
    else if (payload.reason) info = payload.reason.slice(0, 40);
    else if (payload.step) info = `step: ${payload.step}`;
    else if (payload.durationMs) info = `duration: ${formatDuration(payload.durationMs)}`;

    console.log(`  ${colors.dim}${time}${colors.reset} ${color}${event.type.padEnd(25)}${colors.reset} ${colors.dim}${info}${colors.reset}`);
  }

  if (events.length > 15) {
    console.log(`  ${colors.dim}... and ${events.length - 15} more events${colors.reset}`);
  }

  renderActivityByStory(events, PROJECT_ROOT);
  renderTokenSpendAndEfficiency(PROJECT_ROOT, days);

  console.log("");
}

function watchMode(days, typeFilter, intervalMs = 5000) {
  console.log(`${colors.cyan}Starting watch mode (refresh every ${intervalMs / 1000}s, Ctrl+C to exit)${colors.reset}`);

  const refresh = () => {
    const events = readEvents(days, typeFilter);
    renderDashboard(events, days, typeFilter);
  };

  refresh();
  setInterval(refresh, intervalMs);
}

// Parse arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let days = 1;
  let typeFilter = null;
  let watch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--type" && args[i + 1]) {
      typeFilter = args[i + 1];
      i++;
    } else if (args[i] === "--watch" || args[i] === "-w") {
      watch = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
RKS Telemetry Dashboard

Usage:
  node scripts/telemetry/dashboard.mjs [options]

Options:
  --days <n>     Show events from last n days (default: 1)
  --type <str>   Filter events by type (e.g., "plan", "exec", "guardrails")
  --watch, -w    Live mode with auto-refresh every 5 seconds
  --help, -h     Show this help message

Examples:
  node scripts/telemetry/dashboard.mjs                    # Today's events
  node scripts/telemetry/dashboard.mjs --days 7           # Last 7 days
  node scripts/telemetry/dashboard.mjs --type ship        # Ship events only
  node scripts/telemetry/dashboard.mjs --watch --days 3   # Watch mode, 3 days
`);
      process.exit(0);
    }
  }

  return { days, typeFilter, watch };
}

// Main
function main() {
  if (!fs.existsSync(TELEMETRY_DIR)) {
    console.log(`${colors.yellow}No telemetry directory found at ${TELEMETRY_DIR}${colors.reset}`);
    console.log(`${colors.dim}Telemetry events are stored when using RKS tools.${colors.reset}`);
    process.exit(0);
  }

  const { days, typeFilter, watch } = parseArgs();

  if (watch) {
    watchMode(days, typeFilter);
  } else {
    const events = readEvents(days, typeFilter);
    renderDashboard(events, days, typeFilter);
  }
}

// Only run when executed directly, not when imported as a module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
