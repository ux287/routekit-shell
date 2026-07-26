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
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    expect(fnBody).toMatch(/toolCallCounts/);
    expect(fnBody).toMatch(/\+ 1/);
  });

  it("checkAllowedTool only increments on allowed path (inside stateCheck.allowed block)", () => {
    const fnIdx = src.indexOf("export function checkAllowedTool");
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
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
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx > 0 ? nextFnIdx : src.length);
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
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
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
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx);
    const emitIdx = fnBody.indexOf("governor.tool_summary");
    const deleteIdx = fnBody.indexOf("governorSessions.delete");
    expect(emitIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeLessThan(deleteIdx);
  });
});

describe("telemetry/types.mjs — GOVERNOR_TOOL_SUMMARY in EventTypes (source)", () => {
  const src = readSource("packages/mcp-rks/src/server/telemetry/types.mjs");

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
