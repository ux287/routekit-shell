import fs from "fs/promises";
import path from "path";

function resolveSince(since) {
  if (!since || typeof since !== "string") return null;
  const match = since.trim().match(/^(\d+)(h|d|w)$/i);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const msMap = { h: 3600000, d: 86400000, w: 604800000 };
  return new Date(Date.now() - amount * msMap[unit]).toISOString();
}

function normalizeReason(reason) {
  if (!reason || typeof reason !== "string") return "UNKNOWN";
  const r = reason.toLowerCase();
  if (r.includes("dirty") || r.includes("uncommitted")) return "DIRTY_TREE";
  if (r.includes("worktree") && (r.includes("exist") || r.includes("already"))) return "WORKTREE_EXISTS";
  if (r.includes("merge conflict") || r.includes("conflict")) return "MERGE_CONFLICT";
  if (r.includes("auth") || r.includes("unauthorized") || r.includes("forbidden")) return "AUTH_ERROR";
  if (r.includes("timeout") || r.includes("timed out")) return "TIMEOUT";
  if (r.includes("test") && r.includes("fail")) return "TEST_FAILED";
  if (r === "unspecified" || r === "") return "UNKNOWN";
  const truncated = reason.slice(0, 40).replace(/\s+/g, " ").trim();
  return `OTHER:${truncated}`;
}

function toDateKey(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Read events from the JSONL event store (.rks/telemetry/events-*.jsonl)
 * and the legacy telemetry.json file. Merges both sources.
 */
async function loadEvents(projectRoot, startDate, endDate, lastNCycles) {
  const events = [];

  // 1. Read from JSONL event store (new system - agents, tool calls)
  const telemetryDir = path.join(projectRoot, ".rks", "telemetry");
  try {
    const entries = await fs.readdir(telemetryDir);
    const allJsonlFiles = entries.filter(e => e.endsWith(".jsonl")).sort();
    const jsonlFiles = lastNCycles ? allJsonlFiles.slice(-lastNCycles) : allJsonlFiles;
    for (const file of jsonlFiles) {
      const dateMatch = file.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (dateMatch) {
        const fileDate = dateMatch[1];
        if (startDate && fileDate < startDate) continue;
        if (endDate && fileDate > endDate) continue;
      }
      try {
        const content = await fs.readFile(path.join(telemetryDir, file), "utf8");
        for (const line of content.trim().split("\n").filter(Boolean)) {
          try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* no telemetry dir yet */ }

  // 2. Read from legacy telemetry.json (old system - plan/exec)
  try {
    const txt = await fs.readFile(path.join(projectRoot, "telemetry.json"), "utf8");
    const legacy = JSON.parse(txt);
    if (Array.isArray(legacy)) events.push(...legacy);
  } catch { /* no legacy file */ }

  // Filter by date range
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  return events.filter(ev => {
    if (!ev) return false;
    const ts = ev.timestamp || ev.ts || ev.time;
    if (!ts) return false;
    const t = new Date(ts);
    if (isNaN(t)) return false;
    if (start && t < start) return false;
    if (end && t > end) return false;
    return true;
  });
}

export async function generateReport(projectRoot, opts = {}) {
  const { reportType = "summary", startDate, endDate, since, lastNCycles } = opts || {};
  const effectiveStartDate = since ? resolveSince(since) : startDate;
  const events = await loadEvents(projectRoot, effectiveStartDate, endDate, lastNCycles);

  if (reportType === "summary") return buildSummary(events, startDate, endDate);
  if (reportType === "failures") return buildFailures(events);
  if (reportType === "trends") return buildTrends(events);
  if (reportType === "guardrails") return buildGuardrails(events);
  return { error: `unknown reportType: ${reportType}` };
}

function buildSummary(events, startDate, endDate) {
  const period = `${startDate || "(all)"} to ${endDate || "(all)"}`;

  // Plan/exec operations (legacy compat)
  const ops = { plan: { total: 0, success: 0, failed: 0 }, exec: { total: 0, success: 0, failed: 0 } };
  // Agent activity
  const agents = {};
  // Tool calls within agents
  let totalToolCalls = 0;
  let failedToolCalls = 0;
  // Guardrail/trust events — flat totals so the summary is no longer blind to them
  // (grouped detail lives in the dedicated `guardrails` report). Mirrors the dashboard's
  // aggregateTrustCounters flat counters.
  let chainViolations = 0;
  let guardrailBumps = 0;

  for (const ev of events) {
    const type = String(ev.type || ev.event || ev.name || "").toLowerCase();

    // Guardrail/trust events (do not collide with plan/exec/agent classification below)
    if (type === "chain.violation") chainViolations++;
    else if (type === "hook.guardrail_bump") guardrailBumps++;

    // Classify legacy plan/exec events
    if (type.includes("plan") && !type.includes("agent.")) {
      ops.plan.total++;
      if (isSuccess(ev)) ops.plan.success++;
      else if (isFailure(ev)) ops.plan.failed++;
    } else if (type === "exec.start") {
      ops.exec.total++;
    } else if (type === "exec.complete") {
      ops.exec.success++;
    } else if (type === "exec.failed") {
      ops.exec.failed++;
    }

    // Agent events: agent.<name>.started / .complete / .failed / .tool_call
    const agentMatch = type.match(/^agent\.([^.]+)\.(.+)$/);
    if (agentMatch) {
      const [, agentName, eventType] = agentMatch;
      if (!agents[agentName]) {
        agents[agentName] = { invocations: 0, completed: 0, failed: 0, toolCalls: 0, failedToolCalls: 0, totalDurationMs: 0, escalations: 0, selfEscalations: 0 };
      }
      const a = agents[agentName];
      if (eventType === "started") a.invocations++;
      else if (eventType === "complete") {
        a.completed++;
        const dur = ev.payload?.durationMs || ev.payload?.latencyMs || ev.durationMs || ev.latencyMs || 0;
        a.totalDurationMs += dur;
      }
      else if (eventType === "failed") a.failed++;
      else if (eventType === "escalation") a.escalations++;
      // Self-escalation is a DISTINCT signal from failure-escalation (backlog.feat.telemetry-report-escalation-structural-rollup):
      // agent.<name>.self_escalation {from,to,reason:'self_signal'} fires when a successful Haiku result
      // carried escalate:true. Counted separately from `escalations` (never summed/conflated).
      else if (eventType === "self_escalation") a.selfEscalations++;
      else if (eventType === "tool_call") {
        a.toolCalls++;
        totalToolCalls++;
        const payload = ev.payload || ev;
        if (payload.ok === false) {
          a.failedToolCalls++;
          failedToolCalls++;
        }
      }
    }
  }

  const toPct = (ok, tot) => (tot === 0 ? "0%" : `${Math.round((ok / tot) * 100)}%`);
  const operations = {};
  for (const k of Object.keys(ops)) {
    const v = ops[k];
    operations[k] = { total: v.total, success: v.success, failed: v.failed, successRate: toPct(v.success, v.total) };
  }

  const agentSummary = {};
  for (const [name, a] of Object.entries(agents)) {
    agentSummary[name] = {
      invocations: a.invocations,
      completed: a.completed,
      failed: a.failed,
      successRate: toPct(a.completed, a.invocations),
      toolCalls: a.toolCalls,
      failedToolCalls: a.failedToolCalls,
      avgDurationMs: a.completed > 0 ? Math.round(a.totalDurationMs / a.completed) : 0,
      escalations: a.escalations,
      selfEscalations: a.selfEscalations,
      // invocations = agent.<name>.started count; guard divide-by-zero → finite 0.
      selfEscalationRate: a.invocations > 0 ? a.selfEscalations / a.invocations : 0,
    };
  }

  const agentInvocations = Object.values(agents).reduce((s, a) => s + a.invocations, 0);
  const totalSelfEscalations = Object.values(agents).reduce((s, a) => s + a.selfEscalations, 0);

  return {
    period,
    operations,
    agents: agentSummary,
    totals: {
      agentInvocations,
      toolCalls: totalToolCalls,
      failedToolCalls,
      // Overall self-escalation rollup (backlog.feat.telemetry-report-escalation-structural-rollup):
      // THE metric for whether haiku-first economics stay net-positive. Denominator is
      // totals.agentInvocations (agent.<name>.started count); guard divide-by-zero → finite 0.
      selfEscalations: totalSelfEscalations,
      selfEscalationRate: agentInvocations > 0 ? totalSelfEscalations / agentInvocations : 0,
    },
    guardrails: {
      chainViolations,
      guardrailBumps,
      total: chainViolations + guardrailBumps,
    },
  };
}

/**
 * Guardrail/trust report: chain.violation + hook.guardrail_bump events.
 *
 * Flat totals (chainViolations, guardrailBumps) mirror the telemetry dashboard's
 * aggregateTrustCounters — same store, equivalent totals. The per-hook / per-blockedTool /
 * per-redirectAgent grouping is NET-NEW behavior beyond the dashboard (which reports flat
 * totals only): it buckets each trust event by the payload fields written at emit time so a
 * reader can see WHICH hooks and tools drive the bumps, not just how many there are.
 */
function buildGuardrails(events) {
  let chainViolations = 0;
  let guardrailBumps = 0;
  const byHook = {};
  const byBlockedTool = {};
  const byRedirectAgent = {};

  const bump = (bucket, key) => {
    if (key === undefined || key === null || key === "") return;
    const k = String(key);
    bucket[k] = (bucket[k] || 0) + 1;
  };

  for (const ev of events) {
    const type = String(ev.type || ev.event || ev.name || "");
    const isChain = type === "chain.violation";
    const isBump = type === "hook.guardrail_bump";
    if (!isChain && !isBump) continue;

    if (isChain) chainViolations++;
    else guardrailBumps++;

    const p = ev.payload || ev;
    bump(byHook, p.hookName);
    bump(byBlockedTool, p.blockedTool);
    bump(byRedirectAgent, p.redirectAgent);
  }

  return {
    totals: {
      chainViolations,
      guardrailBumps,
      total: chainViolations + guardrailBumps,
    },
    byHook,
    byBlockedTool,
    byRedirectAgent,
  };
}

function buildFailures(events) {
  const failures = {};
  for (const ev of events) {
    const type = String(ev.type || ev.event || ev.name || "");
    const payload = ev.payload || {};
    // Structural planner give-up (backlog.feat.telemetry-report-escalation-structural-rollup):
    // plan.failed{reason:'structural_create_unauthorable'} OR plan.retry.exhausted{failureClass:'structural'}
    // is a DETERMINISTIC unauthorable-create failure. Surface it in its OWN bucket rather than the generic
    // plan-failure count — and count plan.retry.exhausted, which the isFailure/.failed gate below would skip.
    const isStructural = payload.reason === "structural_create_unauthorable" || payload.failureClass === "structural";
    if (isStructural) {
      const skey = "structural_create_unauthorable";
      if (!failures[skey]) failures[skey] = { total: 0, byReason: {} };
      failures[skey].total++;
      const scode = payload.reason === "structural_create_unauthorable" ? "structural_create_unauthorable" : `structural:${type}`;
      if (!failures[skey].byReason[scode]) {
        failures[skey].byReason[scode] = { count: 0, example: String(payload.reason || payload.failureClass || type).slice(0, 200) };
      }
      failures[skey].byReason[scode].count++;
      continue; // do not ALSO count into the generic plan.failed bucket
    }
    if (!isFailure(ev) && !type.includes(".failed")) continue;
    const key = type || "unknown";
    if (!failures[key]) failures[key] = { total: 0, byReason: {} };
    failures[key].total++;
    const rawReason = String(ev.payload?.error || ev.error || ev.reason || ev.code || "unspecified");
    const code = normalizeReason(rawReason);
    if (!failures[key].byReason[code]) {
      failures[key].byReason[code] = { count: 0, example: rawReason.slice(0, 200) };
    }
    failures[key].byReason[code].count++;
  }
  return { failures };
}

function buildTrends(events) {
  const daily = {};
  for (const ev of events) {
    const ts = ev.timestamp || ev.ts || ev.time;
    const t = new Date(ts);
    if (isNaN(t)) continue;
    const key = toDateKey(t);
    if (!daily[key]) daily[key] = { date: key, plans: 0, execs: 0, agentCalls: 0, toolCalls: 0, failures: 0 };
    const type = String(ev.type || ev.event || ev.name || "").toLowerCase();

    if (type.includes("plan") && !type.includes("agent.")) daily[key].plans++;
    else if (type.includes("exec") && !type.includes("agent.")) daily[key].execs++;

    if (type.match(/^agent\.[^.]+\.started$/)) daily[key].agentCalls++;
    if (type.match(/^agent\.[^.]+\.tool_call$/)) daily[key].toolCalls++;
    if (type.includes(".failed") || isFailure(ev)) daily[key].failures++;
  }
  return { daily: Object.values(daily).sort((a, b) => a.date < b.date ? -1 : 1) };
}

function isSuccess(ev) {
  const s = ev.status || ev.outcome || ev.result;
  if (typeof s === "boolean") return s;
  if (typeof s === "string") return ["success", "ok", "passed"].includes(s.toLowerCase());
  return false;
}

function isFailure(ev) {
  const s = ev.status || ev.outcome || ev.result;
  if (s === false) return true;
  if (typeof s === "string") return ["failed", "error", "fail"].includes(s.toLowerCase());
  return false;
}
