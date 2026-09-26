/**
 * Tests for session-tool-telemetry — toolCallCounts tracking in Governor sessions
 * and governor.tool_summary emission on session end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/**
 * Index of the next TOP-LEVEL export declaration at or after `from`.
 *
 * WIDENED from a bare `"\nexport function"` literal by
 * backlog.fix.endsession-stash-autopop-unawaited. That narrow delimiter cannot
 * match `export async function`, so adding one to governor-token.mjs made every
 * window derived from it silently over-extend PAST the end of the function it
 * named — the assertions inside kept passing while no longer measuring what their
 * names claim. No red CI, just a guard quietly stopping being a guard.
 *
 * Returns `src.length` rather than `-1` when nothing follows, so a caller cannot
 * slice to `-1` and get an empty-ish window by accident.
 */
function nextExportIdx(src, from) {
  const candidates = [
    src.indexOf("\nexport function", from),
    src.indexOf("\nexport async function", from),
  ].filter((i) => i > -1);
  return candidates.length ? Math.min(...candidates) : src.length;
}

// ── Source-based verification ────────────────────────────────────────────────

describe("governor-token.mjs — toolCallCounts initialization (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("createSession initializes toolCallCounts as empty object", () => {
    expect(src).toMatch(/toolCallCounts:\s*\{\}/);
  });

  it("toolCallCounts is part of the session object (inside createSession)", () => {
    const createIdx = src.indexOf("export function createSession");
    const endIdx = src.indexOf("return { token, flowType, session };");
    const sessionBlock = src.slice(createIdx, endIdx);
    expect(sessionBlock).toMatch(/toolCallCounts/);
  });
});

describe("governor-token.mjs — checkAllowedTool increments counts (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("checkAllowedTool increments toolCallCounts on allowed tool", () => {
    const fnIdx = src.indexOf("export function checkAllowedTool");
    const nextFnIdx = nextExportIdx(src, fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    expect(fnBody).toMatch(/toolCallCounts/);
    expect(fnBody).toMatch(/\+ 1/);
  });

  it("checkAllowedTool only increments on allowed path (inside stateCheck.allowed block)", () => {
    const fnIdx = src.indexOf("export function checkAllowedTool");
    const nextFnIdx = nextExportIdx(src, fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    const allowedIdx = fnBody.indexOf("stateCheck.allowed");
    const countsIdx = fnBody.indexOf("toolCallCounts");
    // toolCallCounts increment appears after stateCheck.allowed check
    expect(countsIdx).toBeGreaterThan(allowedIdx);
  });
});

describe("governor-token.mjs — assertToolAllowed increments counts (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("assertToolAllowed increments toolCallCounts before final return null", () => {
    const fnIdx = src.indexOf("export function assertToolAllowed");
    const nextFnIdx = nextExportIdx(src, fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    expect(fnBody).toMatch(/toolCallCounts/);
    expect(fnBody).toMatch(/\+ 1/);
    // Increment appears before the final return null
    const countsIdx = fnBody.lastIndexOf("toolCallCounts");
    const returnNullIdx = fnBody.lastIndexOf("return null");
    expect(countsIdx).toBeLessThan(returnNullIdx);
  });
});

describe("governor-token.mjs — endSession emits governor.tool_summary (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("endSession emits governor.tool_summary", () => {
    expect(src).toMatch(/governor\.tool_summary/);
    const fnIdx = src.indexOf("export function endSession");
    const nextFnIdx = nextExportIdx(src, fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    expect(fnBody).toMatch(/governor\.tool_summary/);
  });

  it("governor.tool_summary payload includes sessionId, projectId, flowType, toolCallCounts, durationMs", () => {
    const emitIdx = src.indexOf('"governor.tool_summary"');
    const snippet = src.slice(emitIdx, emitIdx + 300);
    expect(snippet).toMatch(/sessionId/);
    expect(snippet).toMatch(/projectId/);
    expect(snippet).toMatch(/flowType/);
    expect(snippet).toMatch(/toolCallCounts/);
    expect(snippet).toMatch(/durationMs/);
  });

  it("governor.tool_summary emit is wrapped in try-catch (best-effort)", () => {
    const emitIdx = src.indexOf('"governor.tool_summary"');
    const context = src.slice(Math.max(0, emitIdx - 100), emitIdx + 300);
    expect(context).toMatch(/try/);
    expect(context).toMatch(/catch/);
  });

  it("endSession emits before deleting the session from governorSessions", () => {
    const fnIdx = src.indexOf("export function endSession");
    const nextFnIdx = nextExportIdx(src, fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    const emitIdx = fnBody.indexOf("governor.tool_summary");
    const deleteIdx = fnBody.indexOf("governorSessions.delete");
    expect(emitIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeLessThan(deleteIdx);
  });

  it("THE WINDOW TERMINATES AT endSession — over-extension reddens, it does not pass", () => {
    // The guard that makes every assertion above mean what it says.
    //
    // The delimiter used to be a bare "\nexport function", which
    // `export async function flushPendingStashPops` does not match. With that
    // delimiter the window silently ran PAST the end of endSession into whatever
    // followed — and every assertion above still passed, because it was searching
    // a superset. Nothing went red; the guards just stopped being guards.
    //
    // Asserting the window's CONTENT, not its index: it must end at endSession's
    // closing brace and must not have swallowed the next declaration.
    const fnIdx = src.indexOf("export function endSession");
    const nextFnIdx = nextExportIdx(src, fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);

    expect(fnIdx).toBeGreaterThan(-1);
    // Anti-vacuity: the window is real and holds the function it names.
    expect(fnBody).toContain("export function endSession");
    expect(fnBody).toContain("removePersistedSession()");
    // The next declaration is the async flush — proving the widened delimiter is
    // actually load-bearing here, not merely harmless.
    expect(src.slice(nextFnIdx)).toMatch(/^\nexport async function flushPendingStashPops/);
    // …and it is OUTSIDE the window.
    expect(fnBody).not.toContain("flushPendingStashPops");
  });
});

describe("telemetry/types.mjs — GOVERNOR_TOOL_SUMMARY in EventTypes (source)", () => {
  const src = readSource("packages/telemetry/src/types.mjs");

  it("EventTypes includes GOVERNOR_TOOL_SUMMARY constant", () => {
    expect(src).toMatch(/GOVERNOR_TOOL_SUMMARY/);
    expect(src).toMatch(/governor\.tool_summary/);
  });
});

// ── Behavioral unit tests ────────────────────────────────────────────────────

describe("createSession — toolCallCounts initialized to {}", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"));

  it("new session has toolCallCounts as empty object", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    expect(session.toolCallCounts).toEqual({});
    mod.endSession(token);
  });
});

describe("checkAllowedTool — increments toolCallCounts", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"));

  it("increments count for allowed tool call", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    // rks_agent_research is allowed in open flow
    mod.checkAllowedTool(token, "rks_agent_research");
    mod.checkAllowedTool(token, "rks_agent_research");
    expect(session.toolCallCounts["rks_agent_research"]).toBe(2);
    mod.endSession(token);
  });

  it("does not increment for tools in COMMON_TOOLS (they return early)", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    // rks_governor_init is in COMMON_TOOLS — bypasses session check
    mod.checkAllowedTool(token, "rks_governor_init");
    expect(session.toolCallCounts["rks_governor_init"]).toBeUndefined();
    mod.endSession(token);
  });
});
