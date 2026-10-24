// Pure builders for exec plan-commit linkage (backlog.feat.exec-plan-commit-linkage).
// No I/O except writePlanArchive and checkPlanArchiveIgnored; everything else is unit-testable without git.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computePlanHash } from "./plan-quality.mjs";

export const PROVENANCE_TRAILER_KEYS = ["Story", "Plan-Hash", "Run-Id"];

/** Plan hash over the plan WITHOUT qualityReview — the same input exec's integrity gate uses. */
export function planHashFor(plan) {
  const { qualityReview, ...withoutReview } = plan || {};
  return computePlanHash(withoutReview);
}

/** [{ key, value }] for the exec commit; entries with an empty value are dropped. */
export function buildExecTrailers({ planHash, runId }) {
  return [
    { key: "Plan-Hash", value: planHash },
    { key: "Run-Id", value: runId },
  ].filter((t) => typeof t.value === "string" && t.value.length > 0);
}

export function buildPlanArchive({ runId, plan, fixPlans = [], archivedAt = new Date().toISOString() }) {
  return {
    runId,
    planHash: planHashFor(plan),
    problemId: plan?.problemId || null,
    archivedAt,
    plan,
    fixPlans: Array.isArray(fixPlans) ? [...fixPlans] : [],
  };
}

export function planArchiveRelPath(runId) {
  return path.posix.join(".rks", "plans", `${runId}.json`);
}

export function writePlanArchive(projectRoot, archive) {
  const rel = planArchiveRelPath(archive.runId);
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(archive, null, 2) + "\n", "utf8");
  return rel;
}

/**
 * Map a `git check-ignore -q` spawnSync result to the archive disposition (AC14).
 * Exit 0 = ignored, exit 1 = not ignored, anything else (exit 128, spawn error, timeout) = check_failed.
 * A failed check is never reported as ignored or not_ignored.
 */
export function classifyIgnoreCheck({ status = null, error = null, signal = null, stderr = "" } = {}) {
  if (error) {
    const msg = error?.message ?? String(error);
    return { status: "check_failed", error: msg && msg.length > 0 ? msg : "git check-ignore spawn error" };
  }
  if (status === 0) return { status: "ignored", error: null };
  if (status === 1) return { status: "not_ignored", error: null };
  const why = signal ? `signal ${signal}` : `exit ${status}`;
  const detail = String(stderr || "").trim();
  return { status: "check_failed", error: `git check-ignore ${why}${detail ? `: ${detail}` : ""}` };
}

/** One spawnSync of `git check-ignore -q -- <relPath>` with an explicit timeout, classified by classifyIgnoreCheck. */
export function checkPlanArchiveIgnored(projectRoot, relPath, { timeoutMs = 10000 } = {}) {
  const r = spawnSync("git", ["check-ignore", "-q", "--", relPath], { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs });
  return classifyIgnoreCheck(r || {});
}

export function buildExecCompletePayload(fields) {
  return { ...fields };
}

/** Payload for a genuine failure: never carries a resumable flag or a correlationId (that is the 4th argument). */
export function buildExecFailedPayload(fields) {
  const { resumable, correlationId, ...rest } = fields || {};
  return { ...rest };
}

/** Payload for a resumable pause (needs_approval, incomplete_previous_story): runId, planHash, reason. */
export function buildExecPausedPayload(fields) {
  const { correlationId, ...rest } = fields || {};
  return { ...rest };
}

/**
 * Terminal-outcome seam: the ONLY producer of exec.failed and exec.paused.
 * runExecTool calls it on every ok:false return and on every throw (before recoverExecFailure).
 * collector and isPause are injected so tests drive it without running exec.
 * Returns null for a no-op, else { event, emitted, flushed, error } as OBSERVED on this call:
 * a thrown emit returns emitted: false and logs one console.error line (R4/R8/R9).
 */
export async function emitTerminalOutcome({ collector, projectId, ctx, result = null, err = null, isPause }) {
  if (!collector || !ctx || ctx.terminalEmitted) return null;
  if (!err && result?.ok !== false) return null;
  const paused = !err && typeof isPause === "function" && isPause(result) === true;
  const detail = ctx.terminalDetail || {};
  const runId = ctx.runId ?? null;
  const planHash = ctx.planHash ?? null;
  const event = paused ? "exec.paused" : "exec.failed";
  let emitError = null;
  let correlationId = ctx.correlationId ?? null;
  try {
    if (!correlationId) correlationId = collector.startCorrelation();
    if (paused) {
      collector.emit("exec.paused", projectId, { ...buildExecPausedPayload({ runId, planHash, reason: result.reason ?? result.status }) }, { correlationId });
    } else {
      const reason = detail.reason ?? (err ? `exec_threw: ${err?.message ?? String(err)}` : (result.reason ?? result.status ?? result.error ?? null));
      const durationMs = typeof ctx.execStartMs === "number" ? Date.now() - ctx.execStartMs : null;
      collector.emit("exec.failed", projectId, { ...buildExecFailedPayload({ durationMs, ...detail, runId, planHash, reason }) }, { correlationId });
    }
    ctx.terminalEmitted = true;
  } catch (e) {
    // Telemetry never alters the result or the throw, but a failed emit is reported, not hidden.
    emitError = e?.message ?? String(e);
    console.error(`[rks.exec] emitTerminalOutcome: ${event} emit failed; no terminal event recorded: ${emitError}`);
  }
  let flushError = null;
  try {
    await collector.flush();
  } catch (e) {
    flushError = e?.message ?? String(e);
    console.error(`[rks.exec] emitTerminalOutcome: telemetry flush failed after ${event}: ${flushError}`);
  }
  return { event, emitted: emitError === null, flushed: flushError === null, error: emitError ?? flushError };
}

const PROVENANCE_TRAILER_LINE_RE = new RegExp(`^(${PROVENANCE_TRAILER_KEYS.map((k) => k.replace(/-/g, "\\-")).join("|")}):\\s*(\\S.*?)\\s*$`);

/** Distinct provenance trailer lines across commit messages, as one trailer block (or "" when none). */
export function buildSquashTrailerBlock(commitMessages = []) {
  const seen = new Set();
  const lines = [];
  for (const msg of Array.isArray(commitMessages) ? commitMessages : []) {
    if (typeof msg !== "string") continue;
    for (const raw of msg.split(/\r?\n/)) {
      const m = PROVENANCE_TRAILER_LINE_RE.exec(raw.trim());
      if (!m) continue;
      const line = `${m[1]}: ${m[2]}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join("\n");
}
