// backlog.feat.exec-plan-commit-linkage — AC8, AC9, AC11, AC12, AC13.
// Structural half: enumerate every non-success return in runExecToolInner and classify it with the
// real isResumablePause. Behavioral half: drive the terminal-outcome seam emitTerminalOutcome
// directly with a recording collector. This file makes no subprocess call.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitTerminalOutcome } from "../../packages/mcp-rks/src/server/exec-provenance.mjs";

// AC12 carve-out: a throw before loadContext returned leaves ctx.projectRoot null. loadContext is
// replaced so runExecTool can be driven down that path without ever resolving a real project.
const { loadContextMock } = vi.hoisted(() => ({ loadContextMock: vi.fn() }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (orig) => ({ ...(await orig()), loadContext: loadContextMock }));

import { isResumablePause, resolveTerminalCollector, runExecTool } from "../../packages/mcp-rks/src/server/exec.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const PROV_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec-provenance.mjs"), "utf8");
const RUNNER_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/test-runner.mjs"), "utf8");

/** Index of the brace that closes the one opening at `open` (skips comments and string/template contents). */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = src.indexOf(ch, i + 1);
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The function is bounded by the next top-level declaration (runApplyTool), and its body ends at
// the last column-0 closing brace before it.
const INNER_START = EXEC_SRC.indexOf("async function runExecToolInner(");
const INNER_BODY_OPEN = EXEC_SRC.indexOf(") {", EXEC_SRC.indexOf("}, ctx)", INNER_START)) + 2;
const INNER_END = EXEC_SRC.lastIndexOf("\n}", EXEC_SRC.indexOf("\nasync function runApplyTool(", INNER_START)) + 1;
const INNER = EXEC_SRC.slice(INNER_BODY_OPEN, INNER_END + 1);

/** Every `return` statement in runExecToolInner, with the returned expression's text. */
function enumerateReturns(body) {
  const out = [];
  const re = /\breturn\b\s*/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const at = m.index + m[0].length;
    if (body[at] === "{") {
      const close = matchBrace(body, at);
      out.push({ kind: "object", text: body.slice(at, close + 1), index: m.index });
    } else {
      const semi = body.indexOf(";", at);
      out.push({ kind: "expr", text: body.slice(at, semi).trim(), index: m.index });
    }
  }
  return out;
}

/** The checkForIncompletePreviousStory blocked reason, read from source (not restated). */
const INCOMPLETE_FN = EXEC_SRC.slice(EXEC_SRC.indexOf("async function checkForIncompletePreviousStory("), EXEC_SRC.indexOf("export function compareGitAnchors("));
const INCOMPLETE_REASON = /blocked:\s*true,\s*reason:\s*"([^"]+)"/.exec(INCOMPLETE_FN)?.[1];

/**
 * Build the synthetic result a return produces, from its literal fields, so the REAL
 * isResumablePause classifies it. null = a success return (ok: true, or the dry-run preview).
 */
function syntheticResult(ret) {
  if (ret.kind === "expr") {
    if (ret.text === "baseline.refusal") return { ok: false, reason: "baseline_failed" };
    if (ret.text === "applyResult") return { ok: false, error: "exec.diverged" };
    return undefined; // unknown expression: neither class
  }
  const t = ret.text;
  // Only the TOP-LEVEL keys matter; nested objects in these returns carry no ok/status/reason.
  if (/^\{\s*ok:\s*true\b/.test(t) || /\bok:\s*true,/.test(t)) return null;
  if (!/\bok:\s*false\b/.test(t)) {
    if (/status:\s*"dry_run"/.test(t)) return null;
    return undefined;
  }
  const lit = (k) => new RegExp(`\\b${k}:\\s*["']([^"']+)["']`).exec(t)?.[1];
  const result = { ok: false };
  const status = lit("status");
  if (status) result.status = status;
  let reason = lit("reason");
  if (!reason && /\breason:\s*incompleteCheck\.reason\b/.test(t)) reason = INCOMPLETE_REASON;
  if (reason) result.reason = reason;
  const error = lit("error");
  if (error) result.error = error;
  return result;
}

function classify(ret) {
  const r = syntheticResult(ret);
  if (r === null) return "success";
  if (r === undefined) return "unclassified";
  return isResumablePause(r) ? "paused" : "failed";
}

/** Comments removed (block and line), so a `return` mentioned in prose is never enumerated. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const RETURNS = enumerateReturns(stripComments(INNER));
const CLASSIFIED = RETURNS.map((r) => ({ ...r, cls: classify(r), synthetic: syntheticResult(r) }));
const NON_SUCCESS = CLASSIFIED.filter((r) => r.cls !== "success");

describe("every non-success return in runExecToolInner is classified failed or paused (AC9)", () => {
  it("the enumeration instrument is live (it finds returns, a success return, and the function bounds)", () => {
    expect(INNER_START).toBeGreaterThan(-1);
    expect(INNER_END).toBeGreaterThan(INNER_BODY_OPEN);
    expect(INNER).toContain("const collector = ensureTelemetryStorage(projectRoot);");
    // runApplyTool's divergence return is NOT inside runExecToolInner.
    expect(INNER).not.toContain("async function runApplyTool(");
    expect(CLASSIFIED.filter((r) => r.cls === "success").length).toBeGreaterThanOrEqual(2);
    expect(INCOMPLETE_REASON).toBe("incomplete_previous_story");
  });

  it("enumerates ok:false returns, returned refusals and divergence returns; pins the count per class; nothing is unclassified", () => {
    const unclassified = CLASSIFIED.filter((r) => r.cls === "unclassified").map((r) => r.text.slice(0, 120));
    expect(unclassified).toEqual([]);
    expect(NON_SUCCESS.filter((r) => r.kind === "expr").map((r) => r.text).sort()).toEqual(["applyResult", "baseline.refusal"]);
    const failed = NON_SUCCESS.filter((r) => r.cls === "failed");
    const paused = NON_SUCCESS.filter((r) => r.cls === "paused");
    expect(paused).toHaveLength(2);
    expect(failed).toHaveLength(11);
    expect(failed.length + paused.length).toBe(NON_SUCCESS.length);
  });

  it("exactly the needs_approval and incomplete_previous_story returns are classified paused", () => {
    const paused = NON_SUCCESS.filter((r) => r.cls === "paused").map((r) => r.synthetic.status ?? r.synthetic.reason).sort();
    expect(paused).toEqual(["incomplete_previous_story", "needs_approval"]);
    const failedKeys = NON_SUCCESS.filter((r) => r.cls === "failed").map((r) => r.synthetic.status ?? r.synthetic.reason ?? r.synthetic.error);
    for (const k of failedKeys) expect(["needs_approval", "incomplete_previous_story"]).not.toContain(k);
  });
});

// A recording collector stands in for telemetry: emit(type, projectId, payload, options),
// startCorrelation() and flush() are recorded, so no telemetry mock escape is needed.
function recorder({ emitThrows = null, flushThrows = null } = {}) {
  const rec = {
    events: [],
    minted: [],
    flushes: 0,
    emit(type, projectId, payload, options) {
      if (emitThrows) throw new Error(emitThrows);
      rec.events.push({ type, projectId, payload, options });
    },
    startCorrelation() {
      const id = `minted-${rec.minted.length + 1}`;
      rec.minted.push(id);
      return id;
    },
    async flush() {
      rec.flushes++;
      if (flushThrows) throw new Error(flushThrows);
    },
  };
  return rec;
}

const ctxOf = (over = {}) => ({ runId: "run-1", planHash: "a".repeat(64), correlationId: "corr-1", terminalDetail: null, terminalEmitted: false, ...over });
const ofType = (rec, t) => rec.events.filter((e) => e.type === t);

describe("emitTerminalOutcome seam (behavioral)", () => {
  let errSpy;
  afterEach(() => errSpy?.mockRestore());
  const spyErr = () => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); return errSpy; };

  it("a synthetic ok:false failure yields exactly one exec.failed (runId, planHash, reason; { correlationId } 4th arg; no resumable, no correlationId in payload) and zero exec.paused", async () => {
    const rec = recorder();
    const ctx = ctxOf();
    const out = await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result: { ok: false, status: "scope_violation_x", error: "e" }, isPause: isResumablePause });
    expect(ofType(rec, "exec.failed")).toHaveLength(1);
    expect(ofType(rec, "exec.paused")).toHaveLength(0);
    const [ev] = ofType(rec, "exec.failed");
    expect(ev.projectId).toBe("p");
    expect(ev.payload).toMatchObject({ runId: "run-1", planHash: "a".repeat(64), reason: "scope_violation_x" });
    expect(ev.payload).not.toHaveProperty("resumable");
    expect(ev.payload).not.toHaveProperty("correlationId");
    expect(ev.options).toEqual({ correlationId: "corr-1" });
    expect(out).toEqual({ event: "exec.failed", emitted: true, flushed: true, error: null });
  });

  it("reason falls back result.reason, then result.status, then result.error", async () => {
    for (const [result, reason] of [
      [{ ok: false, reason: "r1", status: "s1", error: "e1" }, "r1"],
      [{ ok: false, status: "s1", error: "e1" }, "s1"],
      [{ ok: false, error: "e1" }, "e1"],
    ]) {
      const rec = recorder();
      await emitTerminalOutcome({ collector: rec, projectId: "p", ctx: ctxOf(), result, isPause: isResumablePause });
      expect(ofType(rec, "exec.failed")[0].payload.reason).toBe(reason);
    }
  });

  it("a synthetic throw yields exactly one exec.failed with reason exec_threw: <msg>, zero exec.paused, does not throw, and leaves err.message untouched", async () => {
    const rec = recorder();
    const err = new Error("boom at step 3");
    const out = await emitTerminalOutcome({ collector: rec, projectId: "p", ctx: ctxOf(), err, isPause: isResumablePause });
    expect(ofType(rec, "exec.failed")).toHaveLength(1);
    expect(ofType(rec, "exec.paused")).toHaveLength(0);
    expect(ofType(rec, "exec.failed")[0].payload.reason).toBe("exec_threw: boom at step 3");
    expect(err.message).toBe("boom at step 3");
    expect(out.event).toBe("exec.failed");
  });

  it("ctx.terminalDetail fields are carried, its reason wins, and ctx runId/planHash override same-named detail keys", async () => {
    const rec = recorder();
    const ctx = ctxOf({ terminalDetail: { reason: "tests_exhausted", testsFailed: true, attempts: 3, runId: "detail-run", planHash: "detail-hash" } });
    await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result: { ok: false, testsFailed: true, reason: "other" }, isPause: isResumablePause });
    const [ev] = ofType(rec, "exec.failed");
    expect(ev.payload).toMatchObject({ reason: "tests_exhausted", testsFailed: true, attempts: 3, runId: "run-1", planHash: "a".repeat(64) });
    // Detail reason wins over a throw's exec_threw reason too.
    const rec2 = recorder();
    await emitTerminalOutcome({ collector: rec2, projectId: "p", ctx: ctxOf({ terminalDetail: { reason: "dirty_tree" } }), err: new Error("x"), isPause: isResumablePause });
    expect(ofType(rec2, "exec.failed")[0].payload.reason).toBe("dirty_tree");
  });

  it("durationMs is derived from ctx.execStartMs when set, else null (and a detail durationMs wins)", async () => {
    const rec = recorder();
    await emitTerminalOutcome({ collector: rec, projectId: "p", ctx: ctxOf({ execStartMs: Date.now() - 50 }), result: { ok: false, error: "e" }, isPause: isResumablePause });
    expect(ofType(rec, "exec.failed")[0].payload.durationMs).toBeGreaterThanOrEqual(0);
    const rec2 = recorder();
    await emitTerminalOutcome({ collector: rec2, projectId: "p", ctx: ctxOf(), result: { ok: false, error: "e" }, isPause: isResumablePause });
    expect(ofType(rec2, "exec.failed")[0].payload.durationMs).toBeNull();
  });

  it("AC11: a synthetic needs_approval result yields exactly one exec.paused and zero exec.failed; planHash is ctx.planHash, not the result's approval-flow planHash", async () => {
    const rec = recorder();
    const ctxHash = "c".repeat(64);
    const result = { ok: false, status: "needs_approval", planHash: "f".repeat(64), planId: "run-1" };
    const out = await emitTerminalOutcome({ collector: rec, projectId: "p", ctx: ctxOf({ planHash: ctxHash }), result, isPause: isResumablePause });
    expect(ofType(rec, "exec.paused")).toHaveLength(1);
    expect(ofType(rec, "exec.failed")).toHaveLength(0);
    const [ev] = ofType(rec, "exec.paused");
    expect(ev.payload).toEqual({ runId: "run-1", planHash: ctxHash, reason: "needs_approval" });
    expect(ev.payload.planHash).not.toBe(result.planHash);
    expect(ev.options).toEqual({ correlationId: "corr-1" });
    expect(out).toEqual({ event: "exec.paused", emitted: true, flushed: true, error: null });
  });

  it("AC11: a synthetic incomplete_previous_story result with null ctx runId/planHash/correlationId yields exactly one exec.paused with nulls and a minted correlationId, and zero exec.failed", async () => {
    const rec = recorder();
    const ctx = ctxOf({ runId: null, planHash: null, correlationId: null });
    await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result: { ok: false, reason: "incomplete_previous_story", error: "blocked" }, isPause: isResumablePause });
    expect(ofType(rec, "exec.paused")).toHaveLength(1);
    expect(ofType(rec, "exec.failed")).toHaveLength(0);
    const [ev] = ofType(rec, "exec.paused");
    expect(ev.payload).toEqual({ runId: null, planHash: null, reason: "incomplete_previous_story" });
    expect(rec.minted).toHaveLength(1);
    expect(ev.options).toEqual({ correlationId: rec.minted[0] });
  });

  it("a second call on the same ctx (terminalEmitted true) emits nothing; an ok result emits nothing; both return null", async () => {
    const rec = recorder();
    const ctx = ctxOf();
    await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result: { ok: false, error: "e" }, isPause: isResumablePause });
    expect(ctx.terminalEmitted).toBe(true);
    expect(await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, err: new Error("again"), isPause: isResumablePause })).toBeNull();
    expect(rec.events).toHaveLength(1);
    const rec2 = recorder();
    expect(await emitTerminalOutcome({ collector: rec2, projectId: "p", ctx: ctxOf(), result: { ok: true }, isPause: isResumablePause })).toBeNull();
    expect(await emitTerminalOutcome({ collector: rec2, projectId: "p", ctx: ctxOf(), result: { status: "dry_run" }, isPause: isResumablePause })).toBeNull();
    expect(await emitTerminalOutcome({ collector: null, projectId: "p", ctx: ctxOf(), result: { ok: false }, isPause: isResumablePause })).toBeNull();
    expect(rec2.events).toHaveLength(0);
    expect(rec2.flushes).toBe(0);
  });

  it("a successful emit sets ctx.terminalEmitted, flushes, and writes no console.error line", async () => {
    const spy = spyErr();
    const rec = recorder();
    const ctx = ctxOf();
    const out = await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result: { ok: false, error: "e" }, isPause: isResumablePause });
    expect(out).toEqual({ event: "exec.failed", emitted: true, flushed: true, error: null });
    expect(ctx.terminalEmitted).toBe(true);
    expect(rec.flushes).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, error: "e" }, "exec.failed"],
    [{ ok: false, status: "needs_approval" }, "exec.paused"],
  ])("a collector whose emit throws: no throw, emitted false, error is the message, terminalEmitted stays false, one console.error (%o)", async (result, event) => {
    const spy = spyErr();
    const rec = recorder({ emitThrows: "disk full" });
    const ctx = ctxOf();
    const out = await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result, isPause: isResumablePause });
    expect(out).toEqual({ event, emitted: false, flushed: true, error: "disk full" });
    expect(ctx.terminalEmitted).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("emitTerminalOutcome");
    expect(line).toContain(event);
    expect(line).toContain("disk full");
  });

  it("a collector whose flush throws: no throw, emitted true, flushed false, error is the flush message, one console.error naming the flush", async () => {
    const spy = spyErr();
    const rec = recorder({ flushThrows: "flush exploded" });
    const ctx = ctxOf();
    const out = await emitTerminalOutcome({ collector: rec, projectId: "p", ctx, result: { ok: false, error: "e" }, isPause: isResumablePause });
    expect(out).toEqual({ event: "exec.failed", emitted: true, flushed: false, error: "flush exploded" });
    expect(ctx.terminalEmitted).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/flush/);
    expect(String(spy.mock.calls[0][0])).toContain("flush exploded");
  });
});

describe("runExecTool wiring (structural, AC12/AC13)", () => {
  const TOOL_START = EXEC_SRC.indexOf("async function runExecTool(");
  const TOOL = EXEC_SRC.slice(TOOL_START, EXEC_SRC.indexOf("\nexport async function recoverExecFailure(", TOOL_START));

  it("runExecToolInner assigns ctx.collector, ctx.execStartMs, ctx.correlationId, ctx.runId and ctx.planHash after const runIdValue =", () => {
    const decl = INNER.indexOf("const runIdValue =");
    expect(decl).toBeGreaterThan(INNER.indexOf("const collector = ensureTelemetryStorage(projectRoot);"));
    expect(decl).toBeGreaterThan(INNER.indexOf("const correlationId = collector.startCorrelation();"));
    expect(decl).toBeGreaterThan(INNER.indexOf("loadPlan(projectRoot, slug)"));
    for (const line of [
      "ctx.collector = collector;",
      "ctx.execStartMs = execStartMs;",
      "ctx.correlationId = correlationId;",
      "ctx.runId = runIdValue;",
      "ctx.planHash = planHashFor(plan);",
    ]) {
      const at = INNER.indexOf(line);
      expect(at, line).toBeGreaterThan(decl);
    }
  });

  it("the ctx literal starts the seam fields at null / false", () => {
    for (const k of ["collector: null", "correlationId: null", "runId: null", "planHash: null", "execStartMs: null", "terminalDetail: null", "terminalEmitted: false"]) {
      expect(TOOL, k).toContain(k);
    }
  });

  it("calls emitTerminalOutcome on the return path and, on the throw path, before const phaseReset = await recoverExecFailure(ctx, err);", () => {
    const calls = [...TOOL.matchAll(/await emitTerminalOutcome\(\{([^;]*)\}\);/g)];
    expect(calls).toHaveLength(2);
    const [ret, thr] = calls;
    expect(ret[1]).toMatch(/\bresult\b/);
    expect(ret[1]).toMatch(/isPause:\s*isResumablePause/);
    expect(ret.index).toBeGreaterThan(TOOL.indexOf("const result = await runExecToolInner(params, ctx);"));
    expect(thr[1]).toMatch(/\berr\b/);
    expect(thr[1]).toMatch(/isPause:\s*isResumablePause/);
    const reset = TOOL.indexOf("const phaseReset = await recoverExecFailure(ctx, err);");
    expect(thr.index).toBeGreaterThan(TOOL.indexOf("} catch (err) {"));
    expect(thr.index).toBeLessThan(reset);
    // Nothing is inserted between the reset line and the err.message suffix (900-char window witness).
    expect(TOOL.slice(reset, TOOL.indexOf("err.message +=", reset))).not.toContain("emitTerminalOutcome");
  });

  it("resolves the collector as ctx.collector, else ensureTelemetryStorage(ctx.projectRoot), else logs the missing project root", () => {
    expect(TOOL).toContain("resolveTerminalCollector(ctx)");
    const fnStart = EXEC_SRC.indexOf("export function resolveTerminalCollector(ctx) {");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = EXEC_SRC.slice(fnStart, matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", fnStart)) + 1);
    expect(fn).toMatch(/if \(ctx\?\.collector\) return ctx\.collector;/);
    expect(fn).toMatch(/if \(ctx\?\.projectRoot\)[\s\S]*ensureTelemetryStorage\(ctx\.projectRoot\)/);
    expect(fn).toMatch(/console\.error\([^)]*no project root/);
  });

  it("exec.mjs has zero collector.emit(\"exec.failed\" calls and eight ctx.terminalDetail assignments; exec-provenance.mjs has exactly one exec.failed and one exec.paused emit site", () => {
    expect(EXEC_SRC).not.toMatch(/collector\.emit\(\s*"exec\.failed"/);
    expect(EXEC_SRC).not.toMatch(/emit\(\s*["']exec\.paused["']/);
    expect([...EXEC_SRC.matchAll(/ctx\.terminalDetail = \{/g)]).toHaveLength(8);
    for (const reason of ["dirty_tree", "integrity_failed", "anchor_mismatch", "qa_blocked", "quality_failed", "no_tests_found", "tests_exhausted"]) {
      expect(EXEC_SRC, reason).toMatch(new RegExp(`ctx\\.terminalDetail = \\{[^;]*reason: "${reason}"`));
    }
    expect(EXEC_SRC).toMatch(/ctx\.terminalDetail = \{[^;]*reason: baseline\.refusal\.reason/);
    expect([...PROV_SRC.matchAll(/emit\(\s*"exec\.failed"/g)]).toHaveLength(1);
    expect([...PROV_SRC.matchAll(/emit\(\s*"exec\.paused"/g)]).toHaveLength(1);
    // Every terminal detail precedes a return or throw (it is the last statement before the exit).
    for (const m of EXEC_SRC.matchAll(/ctx\.terminalDetail = \{/g)) {
      const close = matchBrace(EXEC_SRC, m.index + "ctx.terminalDetail = ".length);
      expect(EXEC_SRC.slice(close + 1, close + 200)).toMatch(/^;\s*(return\b|throw\b)/);
    }
  });
});

describe("exits before the collector exists (AC12, behavioral)", () => {
  let errSpy;
  afterEach(() => { errSpy?.mockRestore(); loadContextMock.mockReset(); });

  it("resolveTerminalCollector prefers ctx.collector, and with neither collector nor project root returns null and logs the missing root once", () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = { emit() {} };
    expect(resolveTerminalCollector({ collector: c, projectRoot: "/x" })).toBe(c);
    expect(errSpy).not.toHaveBeenCalled();
    expect(resolveTerminalCollector({ collector: null, projectRoot: null })).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toMatch(/no project root/);
  });

  it("a throw before loadContext returned emits no terminal event, logs one missing-root line, and the original throw propagates unchanged", async () => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("project context unavailable");
    loadContextMock.mockImplementation(async () => { throw original; });
    let caught = null;
    try {
      await runExecTool({ projectId: "no-such-project" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect(caught.message).toBe("project context unavailable");
    const rootLines = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => /no project root/.test(l));
    expect(rootLines).toHaveLength(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).filter((l) => /emitTerminalOutcome/.test(l))).toHaveLength(0);
  });
});

describe("exec.rollback carries runId and correlationId (AC8)", () => {
  it("every await rollback( call in exec.mjs passes correlationId; recoverExecFailure passes ctx.correlationId with a null fallback", () => {
    const calls = [...EXEC_SRC.matchAll(/await rollback\(([^;]*)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const c of calls) expect(c).toMatch(/\bcorrelationId\b/);
    const recover = EXEC_SRC.slice(EXEC_SRC.indexOf("export async function recoverExecFailure("), EXEC_SRC.indexOf("async function runExecToolInner("));
    expect(recover).toMatch(/correlationId:\s*ctx\.correlationId\s*\?\?\s*null/);
  });

  it("rollback() in test-runner.mjs takes correlationId and emits exec.rollback with runId and { correlationId } as the options argument", () => {
    expect(RUNNER_SRC).toMatch(/export async function rollback\(projectRoot, \{[^}]*\bcorrelationId = null\b[^}]*\} = \{\}\)/);
    const at = RUNNER_SRC.indexOf("collector.emit('exec.rollback', projectId, {");
    expect(at).toBeGreaterThan(-1);
    const close = matchBrace(RUNNER_SRC, RUNNER_SRC.indexOf("(", at));
    const call = RUNNER_SRC.slice(at, close + 1);
    expect(call).toMatch(/runId:\s*runDir \? path\.basename\(runDir\) : null/);
    expect(call).toMatch(/\},\s*\{\s*correlationId:\s*correlationId \?\? null\s*\}\)$/);
  });
});
