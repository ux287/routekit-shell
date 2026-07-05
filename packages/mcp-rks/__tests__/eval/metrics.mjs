import { queryTelemetry } from '../../src/server/telemetry/query.mjs';

/**
 * Gather all events for given types from telemetry.
 * queryTelemetry returns { ok, events }; events have .type and .payload fields.
 */
async function getEvents(projectRoot, type) {
  const result = await queryTelemetry(projectRoot, { type, limit: 1000 });
  return result.ok ? result.events : [];
}

/**
 * Compute tool failure rate.
 * Returns { byToolName: { [name]: rate }, overall: rate }
 */
export async function computeToolFailureRate(projectRoot) {
  const [completes, failures] = await Promise.all([
    getEvents(projectRoot, 'mcp.tool.complete'),
    getEvents(projectRoot, 'mcp.tool.failed'),
  ]);

  const byToolName = {};
  for (const ev of completes) {
    const name = ev.payload?.tool || 'unknown';
    if (!byToolName[name]) byToolName[name] = { complete: 0, failed: 0 };
    byToolName[name].complete++;
  }
  for (const ev of failures) {
    const name = ev.payload?.tool || 'unknown';
    if (!byToolName[name]) byToolName[name] = { complete: 0, failed: 0 };
    byToolName[name].failed++;
  }

  let totalComplete = completes.length;
  let totalFailed = failures.length;
  const total = totalComplete + totalFailed;

  const rates = {};
  for (const [name, counts] of Object.entries(byToolName)) {
    const t = counts.complete + counts.failed;
    rates[name] = t > 0 ? counts.failed / t : 0;
  }

  return {
    byToolName: rates,
    overall: total > 0 ? totalFailed / total : 0,
  };
}

/**
 * Compute plan validation pass rate.
 * Returns { passCount, totalCount, rate }
 */
export async function computePlanPassRate(projectRoot) {
  const events = await getEvents(projectRoot, 'plan.complete');
  let passCount = 0;
  for (const ev of events) {
    if (ev.payload?.status === 'success' || ev.payload?.ok === true) passCount++;
  }
  return {
    passCount,
    totalCount: events.length,
    rate: events.length > 0 ? passCount / events.length : 0,
  };
}

/**
 * Compute exec success rate.
 * Returns { successCount, totalCount, rate }
 */
export async function computeExecSuccessRate(projectRoot) {
  const events = await getEvents(projectRoot, 'exec.off_rail.complete');
  let successCount = 0;
  for (const ev of events) {
    if (ev.payload?.testsPassed === true) successCount++;
  }
  return {
    successCount,
    totalCount: events.length,
    rate: events.length > 0 ? successCount / events.length : 0,
  };
}

/**
 * Compute average exec latency.
 * Returns { avgMs, minMs, maxMs, count }
 */
export async function computeExecLatency(projectRoot) {
  const events = await getEvents(projectRoot, 'exec.off_rail.complete');
  const durations = events
    .map(e => e.payload?.durationMs ?? e.payload?.latencyMs ?? 0)
    .filter(d => d > 0);

  if (durations.length === 0) {
    return { avgMs: 0, minMs: 0, maxMs: 0, count: events.length };
  }

  const sum = durations.reduce((a, b) => a + b, 0);
  return {
    avgMs: Math.round(sum / durations.length),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    count: events.length,
  };
}

/**
 * Compute guardrail violation frequency.
 * Returns { offCount, onCount, rate }
 */
export async function computeGuardrailViolations(projectRoot) {
  const [offs, ons] = await Promise.all([
    getEvents(projectRoot, 'guardrails.off'),
    getEvents(projectRoot, 'guardrails.on'),
  ]);
  const total = offs.length + ons.length;
  return {
    offCount: offs.length,
    onCount: ons.length,
    rate: total > 0 ? offs.length / total : 0,
  };
}

/**
 * Compute all metrics in one call.
 */
export async function computeAllMetrics(projectRoot) {
  const [toolFailureRate, planPassRate, execSuccessRate, execLatency, guardrailViolations] =
    await Promise.all([
      computeToolFailureRate(projectRoot),
      computePlanPassRate(projectRoot),
      computeExecSuccessRate(projectRoot),
      computeExecLatency(projectRoot),
      computeGuardrailViolations(projectRoot),
    ]);

  return {
    timestamp: new Date().toISOString(),
    toolFailureRate,
    planPassRate,
    execSuccessRate,
    execLatency,
    guardrailViolations,
  };
}

/**
 * Compare current metrics against baseline and check thresholds.
 * Returns { passed, violations[] }
 */
export function checkMetricThresholds(baseline, current) {
  const violations = [];

  // Tool failure rate: +5% absolute increase allowed
  const bTool = baseline.toolFailureRate?.overall ?? 0;
  const cTool = current.toolFailureRate?.overall ?? 0;
  if (cTool > bTool + 0.05) {
    violations.push({
      metric: 'toolFailureRate',
      baseline: bTool,
      current: cTool,
      threshold: bTool + 0.05,
      message: `Tool failure rate increased from ${(bTool * 100).toFixed(1)}% to ${(cTool * 100).toFixed(1)}% (threshold: +5pp)`,
    });
  }

  // Plan pass rate: -10pp decrease allowed
  const bPlan = baseline.planPassRate?.rate ?? 0;
  const cPlan = current.planPassRate?.rate ?? 0;
  if (cPlan < bPlan - 0.10) {
    violations.push({
      metric: 'planPassRate',
      baseline: bPlan,
      current: cPlan,
      threshold: bPlan - 0.10,
      message: `Plan pass rate decreased from ${(bPlan * 100).toFixed(1)}% to ${(cPlan * 100).toFixed(1)}% (threshold: -10pp)`,
    });
  }

  // Exec success rate: -10pp decrease allowed
  const bExec = baseline.execSuccessRate?.rate ?? 0;
  const cExec = current.execSuccessRate?.rate ?? 0;
  if (cExec < bExec - 0.10) {
    violations.push({
      metric: 'execSuccessRate',
      baseline: bExec,
      current: cExec,
      threshold: bExec - 0.10,
      message: `Exec success rate decreased from ${(bExec * 100).toFixed(1)}% to ${(cExec * 100).toFixed(1)}% (threshold: -10pp)`,
    });
  }

  // Exec latency: +20% relative increase allowed
  const bLat = baseline.execLatency?.avgMs ?? 0;
  const cLat = current.execLatency?.avgMs ?? 0;
  if (bLat > 0 && cLat > bLat * 1.2) {
    violations.push({
      metric: 'execLatency',
      baseline: bLat,
      current: cLat,
      threshold: Math.round(bLat * 1.2),
      message: `Exec latency increased from ${bLat}ms to ${cLat}ms (threshold: +20%)`,
    });
  }

  // Guardrail violations: +25% relative increase allowed
  const bGr = baseline.guardrailViolations?.rate ?? 0;
  const cGr = current.guardrailViolations?.rate ?? 0;
  if (bGr > 0 && cGr > bGr * 1.25) {
    violations.push({
      metric: 'guardrailViolations',
      baseline: bGr,
      current: cGr,
      threshold: +(bGr * 1.25).toFixed(4),
      message: `Guardrail violation rate increased from ${(bGr * 100).toFixed(1)}% to ${(cGr * 100).toFixed(1)}% (threshold: +25%)`,
    });
  }

  return { passed: violations.length === 0, violations };
}
