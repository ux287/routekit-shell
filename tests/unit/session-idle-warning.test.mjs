/**
 * Tests for session-idle-warning — _sessionWarning attached when Governor session
 * exceeds 80% of MAX_AGE_MS TTL.
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

describe("governor-token.mjs — session idle warning (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("defines MAX_AGE_MS at module level", () => {
    expect(src).toMatch(/const MAX_AGE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  });

  it("defines WARN_THRESHOLD at module level", () => {
    expect(src).toMatch(/const WARN_THRESHOLD\s*=\s*0\.8/);
  });

  it("assertToolAllowed checks age against MAX_AGE_MS * WARN_THRESHOLD", () => {
    const fnIdx = src.indexOf("export function assertToolAllowed");
    const fnBody = src.slice(fnIdx, src.length);
    expect(fnBody).toMatch(/MAX_AGE_MS\s*\*\s*WARN_THRESHOLD/);
  });

  it("assertToolAllowed sets _sessionWarning when age exceeds threshold", () => {
    const fnIdx = src.indexOf("export function assertToolAllowed");
    const fnBody = src.slice(fnIdx, src.length);
    expect(fnBody).toMatch(/_sessionWarning/);
    expect(fnBody).toMatch(/Session expires in/);
  });

  it("warning message uses Math.ceil and shows minutes", () => {
    const fnIdx = src.indexOf("export function assertToolAllowed");
    const fnBody = src.slice(fnIdx, src.length);
    expect(fnBody).toMatch(/Math\.ceil/);
    expect(fnBody).toMatch(/minsRemaining/);
  });

  it("_sessionWarning is cleared (set to undefined) when age is below threshold", () => {
    const fnIdx = src.indexOf("export function assertToolAllowed");
    const fnBody = src.slice(fnIdx, src.length);
    expect(fnBody).toMatch(/_sessionWarning\s*=\s*undefined/);
  });

  it("_sessionWarning is attached without blocking the tool call (return null still present)", () => {
    const warnIdx = src.lastIndexOf("_sessionWarning");
    const returnNullIdx = src.lastIndexOf("return null;");
    expect(warnIdx).toBeLessThan(returnNullIdx);
  });
});

// ── Behavioral unit tests ────────────────────────────────────────────────────

describe("assertToolAllowed — _sessionWarning behavior", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"));

  it("no _sessionWarning when session is freshly created", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    const result = mod.assertToolAllowed(token, "rks_agent_research", {});
    expect(result).toBeNull(); // still allowed
    expect(session._sessionWarning).toBeUndefined();
    mod.endSession(token);
  });

  it("_sessionWarning is present when session age exceeds 80% of TTL", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    // Fake session age to 25 minutes (> 24 min threshold)
    session.createdAt = Date.now() - 25 * 60 * 1000;
    const result = mod.assertToolAllowed(token, "rks_agent_research", {});
    expect(result).toBeNull(); // still allowed
    expect(session._sessionWarning).toBeDefined();
    expect(session._sessionWarning).toMatch(/Session expires in \dm/);
    mod.endSession(token);
  });

  it("_sessionWarning shows correct minutes remaining", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    // 25 minutes old → 5 minutes remaining → warns "Session expires in 5m"
    session.createdAt = Date.now() - 25 * 60 * 1000;
    mod.assertToolAllowed(token, "rks_agent_research", {});
    expect(session._sessionWarning).toBe("Session expires in 5m");
    mod.endSession(token);
  });

  it("_sessionWarning shows minimum 1m when session is very close to expiry", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    // 29 minutes 50 seconds old → ~10s remaining → warns "Session expires in 1m"
    session.createdAt = Date.now() - (29 * 60 + 50) * 1000;
    mod.assertToolAllowed(token, "rks_agent_research", {});
    expect(session._sessionWarning).toBe("Session expires in 1m");
    mod.endSession(token);
  });

  it("tool call is not blocked when _sessionWarning is present", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    session.createdAt = Date.now() - 25 * 60 * 1000;
    const result = mod.assertToolAllowed(token, "rks_agent_research", {});
    expect(result).toBeNull(); // null = allowed
    mod.endSession(token);
  });

      it("no _sessionWarning 30s below 80% threshold (safe margin — warning not triggered below threshold)", () => {
        const { token, session } = mod.createSession({ projectId: "test-proj" });
        // 23.5 minutes = 30s below 80% of 30 minutes
        session.createdAt = Date.now() - (24 * 60 * 1000 - 30_000);
    mod.assertToolAllowed(token, "rks_agent_research", {});
    expect(session._sessionWarning).toBeUndefined();
    mod.endSession(token);
  });
});
