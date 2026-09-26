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
// Exported for backlog.fix.agent-launch-telemetry-ledger: the ledger's load-bearing assertion is
// that an emitted launch is retrievable by the REAL reader, not merely present in the file. Without
// the export that assertion is unwritable — the symbol cannot be imported at all. Additive only.
export async function loadEvents(projectRoot, startDate, endDate, lastNCycles) {
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

  // backlog.fix.telemetry-report-window-labelling. Every report used to announce
  // `period: "(all) to (all)"` regardless of the window applied: `buildSummary` received the RAW
  // `startDate` rather than `effectiveStartDate`, so a `since` window resolved, filtered, and
  // then went unlabelled — and the other three builders were handed no dates at all. A report
  // that gives no signal about its own scope invites exactly the analysis error it exists to
  // prevent: comparing a 7d summary against an unfiltered failures report produces differences
  // that look like contradictions and are only elapsed time.
  //
  // The window is built from what was APPLIED, never from what was requested. Those differ: a
  // malformed `since` resolves to null and the ternary above still discards a co-supplied
  // `startDate`, so the report runs unfiltered. Reporting the discarded argument would be the
  // same false status one layer up. (That discard is a real defect; correcting the ternary is a
  // filtering change and is deliberately NOT in this story.)
  const window = {
    start: effectiveStartDate || null,
    end: endDate || null,
    // Only present when applied. lastNCycles slices FILES, not time (loadEvents takes the last
    // N jsonl files), so it cannot be resolved to a timestamp — reported verbatim instead of
    // fabricating a boundary it does not have.
    ...(lastNCycles ? { lastNCycles } : {}),
  };

  if (reportType === "summary") return buildSummary(events, window);
  if (reportType === "failures") return buildFailures(events, window);
  if (reportType === "trends") return buildTrends(events, window);
  if (reportType === "guardrails") return buildGuardrails(events, window);
  return { error: `unknown reportType: ${reportType}` };
}

function buildSummary(events, window = {}) {
  // Derived from the APPLIED window. An unfiltered report still reads "(all) to (all)"; a
  // windowed one no longer can, which is what makes the two distinguishable from output alone.
  const period = `${window.start || "(all)"} to ${window.end || "(all)"}`;

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

    // Classify plan/exec events BY EXACT TYPE.
    //
    // backlog.fix.telemetry-report-outcome-derivation. This read `type.includes("plan")` and
    // then classified outcomes with isSuccess/isFailure, which inspected a TOP-LEVEL
    // `status`/`outcome`/`result` field that `createEvent` (types.mjs) has never emitted. Both
    // halves were wrong and they compounded:
    //
    //   - The substring test counted every event whose type merely CONTAINS "plan" — including
    //     `planning.snippets` and `planner.create_file_gate`, which are not plan operations.
    //     Measured against a real store: 22 such types summed to exactly the reported 1148,
    //     while `plan.start` was 69.
    //   - The predicates were permanently false, so success and failed were both 0 and
    //     `successRate` rendered "0%" — indistinguishable from total failure. The true figures
    //     for that same store were 69 / 41 / 22, i.e. 59%.
    //
    // Exec, four lines below, was already correct because it classified by exact type. It is
    // the exemplar; plan now matches it.
    if (type === "plan.start") {
      ops.plan.total++;
    } else if (type === "plan.complete") {
      ops.plan.success++;
    } else if (type === "plan.failed") {
      ops.plan.failed++;
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

  // A rate over ZERO classified outcomes is null, never "0%". "0%" reads as "everything
  // failed" when it actually means "nothing was classified", and those are opposite facts.
  // Precedent: dashboard/src/components/StoryActivityTable.tsx nulls a zero-denominator rate
  // and renders conditionally.
  // Denominator is CLASSIFIED OUTCOMES (success + failed), never the start count. Dividing by
  // starts silently folds unaccounted operations in as failures: 2 succeeded of 3 classified is
  // 67%, but 2 of 10 started reads as 20% purely because 7 never reported a terminal. Those are
  // different facts and only one of them is a success rate.
  const toPct = (ok, classified) =>
    classified === 0 ? null : `${Math.round((ok / classified) * 100)}%`;
  const operations = {};
  for (const k of Object.keys(ops)) {
    const v = ops[k];
    operations[k] = {
      total: v.total,
      success: v.success,
      failed: v.failed,
      // Starts with no terminal event. Deliberately NOT clamped at zero: a negative value means
      // a terminal arrived whose start fell outside the window or was double-emitted, and
      // clamping would hide that inconsistency — the same concealment this fix removes.
      unaccounted: v.total - v.success - v.failed,
      successRate: toPct(v.success, v.success + v.failed),
    };
  }

  const agentSummary = {};
  for (const [name, a] of Object.entries(agents)) {
    agentSummary[name] = {
      invocations: a.invocations,
      completed: a.completed,
      failed: a.failed,
      // Invocations that reached neither `complete` nor `failed`. Some are genuinely missing
      // terminals; others resolved in a category this report has no column for — `denied` and
      // `degraded` are both emitted today and counted nowhere. Surfacing the residue is in
      // scope; giving those outcomes first-class columns is a taxonomy change and is not.
      unaccounted: a.invocations - a.completed - a.failed,
      successRate: toPct(a.completed, a.completed + a.failed),
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
    window,
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
function buildGuardrails(events, window = {}) {
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
    window,
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

function buildFailures(events, window = {}) {
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
    // `payload.reason` FIRST — that is what every emitter writes. This previously read
    // `payload.error` and then TOP-LEVEL `reason`/`code`, neither of which the canonical event
    // shape carries, so every generic failure fell through to "unspecified". All seven
    // plan.failed emit sites in planner.mjs write an explicit payload.reason; none of it
    // reached this report.
    const rawReason = String(
      ev.payload?.reason || ev.payload?.error || ev.error || ev.reason || ev.code || "unspecified",
    );
    const code = normalizeReason(rawReason);
    if (!failures[key].byReason[code]) {
      failures[key].byReason[code] = { count: 0, example: rawReason.slice(0, 200) };
    }
    failures[key].byReason[code].count++;
  }
  return { window, failures };
}

function buildTrends(events, window = {}) {
  const daily = {};
  for (const ev of events) {
    const ts = ev.timestamp || ev.ts || ev.time;
    const t = new Date(ts);
    if (isNaN(t)) continue;
    const key = toDateKey(t);
    if (!daily[key]) daily[key] = { date: key, plans: 0, execs: 0, agentCalls: 0, toolCalls: 0, failures: 0 };
    const type = String(ev.type || ev.event || ev.name || "").toLowerCase();

    // Exact type. These were substring tests, so `planning.snippets`,
    // `planner.create_file_gate` and `execution.note` all counted as operations.
    //
    // START ONLY, deliberately. `daily.plans` is a count of OPERATIONS begun that day, not of
    // plan-related events observed: counting `plan.start` + `plan.complete` + `plan.failed`
    // into one counter tallies a single operation two or three times. The convention is the
    // file's own — `agentCalls` two lines below counts `^agent\.[^.]+\.started$` and nothing
    // else. buildSummary recognises all six types because it has three separate counters to put
    // them in (total / success / failed); this has one, so it counts the one event that marks
    // an operation happening.
    if (type === "plan.start") daily[key].plans++;
    else if (type === "exec.start") daily[key].execs++;

    if (type.match(/^agent\.[^.]+\.started$/)) daily[key].agentCalls++;
    if (type.match(/^agent\.[^.]+\.tool_call$/)) daily[key].toolCalls++;
    if (type.includes(".failed") || isFailure(ev)) daily[key].failures++;
  }
  return { window, daily: Object.values(daily).sort((a, b) => a.date < b.date ? -1 : 1) };
}

// isSuccess was removed with the plan substring branch — its only caller. It read a top-level
// field the canonical event shape never carries, so it was permanently false.
//
// isFailure is KEPT: it has two live callers, the buildFailures admission gate and buildTrends.
// It now reads the PAYLOAD rather than the top level. Deliberately does NOT consider `ok`:
// agent.<name>.tool_call carries `payload.ok`, and admitting it here would drop every failed
// tool call into the failures report as though it were an operation failure.
function isFailure(ev) {
  const s = ev.payload?.status || ev.payload?.outcome || ev.payload?.result;
  if (s === false) return true;
  if (typeof s === "string") return ["failed", "error", "fail"].includes(s.toLowerCase());
  return false;
}
