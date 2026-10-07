#!/usr/bin/env node

// ── Plan Worker: Detached child process for plan generation ──────────
// Spawned by rks_plan in server.mjs with { detached: true, unref() }.
// Survives MCP server restarts — writes results to pending-plan.json
// and plan.json on disk. plan_review reads from disk.
//
// Usage: node plan-worker.mjs <params-file-path>

// Defensive: redirect console.log to stderr (not strictly needed since
// this process is not an MCP server, but runPlanTool and its deps use
// console.error already — this catches any stray console.log calls).
console.log = (...args) => console.error(...args);

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (same as mcp-rks.mjs: bin → mcp-rks → packages → root)
const projectRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

// Ensure ROUTEKIT_PROJECT_ROOT is set. The server passes the planned project's root in
// the spawn env and also spawns with cwd = that root, so a manual run falls back to the
// cwd. Never the install root above: for a child project that would point the worker at
// the shell's notes (backlog.fix.plan-worker-project-root-defaults-to-install-dir).
if (!process.env.ROUTEKIT_PROJECT_ROOT) {
  process.env.ROUTEKIT_PROJECT_ROOT = process.cwd();
}

// Skip preflight checks (branch, clean tree, RAG auto-embed). The worker's job
// is LLM plan generation only. Preflight ran in the MCP server before spawning us,
// and the ONNX embedding model causes SIGILL in detached processes.
process.env.RKS_SKIP_PREFLIGHT = '1';

// ── Read params ──────────────────────────────────────────────────────
const paramsPath = process.argv[2];
if (!paramsPath || !fs.existsSync(paramsPath)) {
  console.error('[plan-worker] FATAL: params file not found:', paramsPath);
  process.exit(1);
}

let params;
try {
  params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  // Clean up params file immediately
  try { fs.unlinkSync(paramsPath); } catch { /* best-effort */ }
} catch (err) {
  console.error('[plan-worker] FATAL: failed to read params:', err.message);
  process.exit(1);
}

const markerPath = params._markerPath;

// ── Telemetry (best-effort, never throws) ────────────────────────────
// The detached worker MUST connect the per-project telemetry store, else collector.flush() silently
// no-ops (storage is null) and every plan.* event buffers and dies at process.exit — the cause of
// operations.plan reading 0/0/0. Connect ctx.record.root/.rks/telemetry (the SAME store the
// main-process reader + cost-report query — NOT the install-root `projectRoot` above), and flush
// before exit (the scheduled flush timer is .unref()'d, so process.exit would kill it).
// See backlog.feat.plan-exec-telemetry-lifecycle-events.
let emitTelemetry = () => {};
let telemetryCollector = null;
try {
  const { getTelemetryCollector, ensureTelemetryStorage } = await import('@routekit/telemetry');
  const { loadContext } = await import('../src/server/project.mjs');
  const collector = getTelemetryCollector();
  const ctx = await loadContext(params.input?.projectId);
  ensureTelemetryStorage(ctx.record.root);
  telemetryCollector = collector;
  emitTelemetry = (event, data) => {
    try { collector.emit(event, params.input?.projectId, data); } catch { /* best-effort */ }
  };
} catch {
  emitTelemetry = () => {}; // Telemetry unavailable — silently no-op
  telemetryCollector = null;
}

// Bound on how long the worker waits, after the done marker is written, for LLM requests a
// caller stopped awaiting (a planner call that lost callOnce's withTimeout race) so their
// llm.token_usage events reach the store. Equals the planner's TEST_GEN_TIMEOUT_MS; deliberately
// not DEFAULT_LLM_TIMEOUT_MS. See backlog.fix.llm-token-usage-complete-coverage.
const LLM_DRAIN_TIMEOUT_MS = 60000;

async function flushTelemetry() {
  if (!telemetryCollector) return;
  // Drain outstanding LLM requests (best-effort). clients.mjs is loaded with a dynamic import
  // here, never statically: it reads RKS_LLM_* at module load, so it must first evaluate after
  // dotenv.config above. ESM caches by URL, so this is the planner's instance and registry.
  try {
    const { awaitOutstandingLlmRequests } = await import('../src/llm/clients.mjs');
    const { drained, abandoned } = await awaitOutstandingLlmRequests({ timeoutMs: LLM_DRAIN_TIMEOUT_MS });
    if (abandoned > 0) {
      console.error(`[plan-worker] ${abandoned} LLM request(s) still outstanding after ${LLM_DRAIN_TIMEOUT_MS}ms; their token usage is not recorded (drained: ${drained})`);
      emitTelemetry('plan.worker.llm_drain_abandoned', { abandoned, drained, timeoutMs: LLM_DRAIN_TIMEOUT_MS, problemId: params.input?.problemId });
    }
  } catch (err) {
    console.error('[plan-worker] llm drain failed:', err?.message ?? err);
  }
  try { await telemetryCollector.flush(); } catch { /* best-effort */ }
}

function updateMarker(updates) {
  try {
    let marker = {};
    if (fs.existsSync(markerPath)) {
      marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    }
    fs.writeFileSync(markerPath, JSON.stringify({ ...marker, ...updates }, null, 2));
  } catch (err) {
    console.error('[plan-worker] failed to update marker:', err.message);
  }
}

// ── Run plan generation ──────────────────────────────────────────────
console.error(`[plan-worker] Starting plan generation (pid: ${process.pid})`);
console.error(`[plan-worker] projectId: ${params.input?.projectId}, problemId: ${params.input?.problemId}`);
emitTelemetry('plan.worker.start', { pid: process.pid, problemId: params.input?.problemId });
const startTime = Date.now();

try {
  const { runPlanTool } = await import('../src/server/planner.mjs');
  const { loadContext } = await import('../src/server/project.mjs');

  const res = await runPlanTool(params.input);

  // Post-plan: git commit phase change (belt-and-suspenders — runPlanTool
  // may have already committed, but this catches edge cases).
  if (res.ok && res.problemId) {
    try {
      const ctx = await loadContext(params.input.projectId);
      execSync(`git add notes/${res.problemId}.md && git commit -m "chore(backlog): advance ${res.problemId} to planned"`, {
        cwd: ctx.record.root, stdio: 'pipe',
      });
    } catch { /* Non-fatal: runPlanTool may have already committed */ }
  }

  // Update marker: done + ok. Shape is built by the SHARED helper so the test can
  // assert against the real code path rather than a simulation that drifts.
  const { buildMarkerUpdate } = await import('../src/server/plan-marker.mjs');
  const markerUpdate = buildMarkerUpdate(res);
  updateMarker(markerUpdate);
  emitTelemetry('plan.worker.done', { pid: process.pid, ok: res.ok !== false, problemId: params.input?.problemId, durationMs: Date.now() - startTime });
  console.error(`[plan-worker] Plan generation completed (ok: ${res.ok !== false})`);
  await flushTelemetry();
  process.exit(0);

} catch (err) {
  // Update marker: done + failed
  updateMarker({ done: true, ok: false, failureClass: "worker_crashed", error: err.message || String(err), completedAt: Date.now() });
  emitTelemetry('plan.worker.done', { pid: process.pid, ok: false, error: err.message || String(err), problemId: params.input?.problemId, durationMs: Date.now() - startTime });
  console.error(`[plan-worker] Plan generation failed: ${err.message || err}`);
  await flushTelemetry();
  process.exit(1);
}
