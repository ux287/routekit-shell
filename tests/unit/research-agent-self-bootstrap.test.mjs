/**
 * Tests for research-agent-self-bootstrap — rks_agent_research auto-creates an
 * open-flow Governor session when called without a token, enabling fluid UX
 * escalation from conversation to research task.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// ── Source-based verification: server.mjs ────────────────────────────────────

describe("server.mjs — createSession import and self-bootstrap (source)", () => {
  const src = readSource("packages/mcp-rks/src/server.mjs");

  it("imports createSession from governor-token.mjs", () => {
    const importLine = src.match(/import\s*\{[^}]+\}\s*from\s*["']\.\/shared\/governor-token\.mjs["']/s)?.[0] || "";
    expect(importLine).toMatch(/createSession/);
  });

  it("defines activeToken variable for self-bootstrap", () => {
    expect(src).toMatch(/let activeToken\s*=/);
  });

  it("self-bootstrap block checks for rks_agent_research", () => {
    const bootstrapIdx = src.indexOf("Self-bootstrap: rks_agent_research");
    expect(bootstrapIdx).toBeGreaterThan(-1);
    const snippet = src.slice(bootstrapIdx, bootstrapIdx + 700);
    expect(snippet).toMatch(/rks_agent_research/);
    expect(snippet).toMatch(/createSession/);
    expect(snippet).toMatch(/flowType.*open/);
  });

  it("self-bootstrap only runs when no existing token is present", () => {
    const bootstrapIdx = src.indexOf("let activeToken = _governorToken");
    expect(bootstrapIdx).toBeGreaterThan(-1);
    const snippet = src.slice(bootstrapIdx, bootstrapIdx + 200);
    expect(snippet).toMatch(/!activeToken/);
  });

  it("self-bootstrap is fail-open (try-catch)", () => {
    const bootstrapIdx = src.indexOf("Self-bootstrap: rks_agent_research");
    const snippet = src.slice(bootstrapIdx, bootstrapIdx + 800);
    expect(snippet).toMatch(/try/);
    expect(snippet).toMatch(/catch/);
    expect(snippet).toMatch(/fail-open/);
  });

  it("uses activeToken (not _governorToken) for validateToken check", () => {
    const validateIdx = src.indexOf("validateToken(activeToken)");
    expect(validateIdx).toBeGreaterThan(-1);
  });

  it("uses activeToken (not _governorToken) for checkAllowedTool call", () => {
    const checkIdx = src.indexOf("checkAllowedTool(activeToken, tool)");
    expect(checkIdx).toBeGreaterThan(-1);
  });

  it("uses activeToken (not _governorToken) for requireToken call", () => {
    const requireIdx = src.indexOf("requireToken(activeToken, tool)");
    expect(requireIdx).toBeGreaterThan(-1);
  });

  it("self-bootstrap uses open flowType (research is read-only)", () => {
    const bootstrapIdx = src.indexOf("Self-bootstrap: rks_agent_research");
    const snippet = src.slice(bootstrapIdx, bootstrapIdx + 700);
    expect(snippet).toMatch(/['"]open['"]/);
  });
});

// ── Source-based verification: governor-token.mjs ────────────────────────────

describe("governor-token.mjs — checkAllowedTool rejects missing session (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("checkAllowedTool does NOT have legacy allow-fallback comment", () => {
    const fnIdx = src.indexOf("export function checkAllowedTool");
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx > 0 ? nextFnIdx : src.length);
    expect(fnBody).not.toMatch(/fall back to legacy behavior \(allow\)/);
  });

  it("checkAllowedTool returns error object when session not in Map", () => {
    const fnIdx = src.indexOf("export function checkAllowedTool");
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx > 0 ? nextFnIdx : src.length);
    // After the session null check, should return an error (not null)
    const noSessionIdx = fnBody.indexOf("if (!session)");
    const snippet = fnBody.slice(noSessionIdx, noSessionIdx + 400);
    expect(snippet).toMatch(/ok:\s*false/);
    expect(snippet).toMatch(/error:\s*['"]unauthorized['"]/);
    expect(snippet).not.toMatch(/return null/);
  });

  it("error message mentions rks_governor_init", () => {
    const fnIdx = src.indexOf("export function checkAllowedTool");
    const nextFnIdx = src.indexOf("\nexport function", fnIdx + 1);
    const fnBody = src.slice(fnIdx, nextFnIdx > 0 ? nextFnIdx : src.length);
    const noSessionIdx = fnBody.indexOf("if (!session)");
    const snippet = fnBody.slice(noSessionIdx, noSessionIdx + 400);
    expect(snippet).toMatch(/rks_governor_init/);
  });
});

// ── Behavioral unit tests ────────────────────────────────────────────────────

describe("checkAllowedTool — rejects token with no session in Map", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"));

  it("returns error when token is not in governorSessions", () => {
    const fakeToken = "00000000-0000-0000-0000-000000000000";
    const result = mod.checkAllowedTool(fakeToken, "rks_agent_research");
    expect(result).not.toBeNull();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unauthorized");
  });

  it("returns null for COMMON_TOOLS even without a session", () => {
    const fakeToken = "00000000-0000-0000-0000-000000000001";
    // rks_governor_init is a COMMON_TOOL — always allowed
    const result = mod.checkAllowedTool(fakeToken, "rks_governor_init");
    expect(result).toBeNull();
  });
});

describe("createSession — open flowType for self-bootstrap", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"));

  it("createSession with flowType 'open' succeeds", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj", flowType: "open" });
    expect(token).toBeDefined();
    expect(session.flowType).toBe("open");
    mod.endSession(token);
  });

  it("open-flow session allows rks_agent_research", () => {
    const { token } = mod.createSession({ projectId: "test-proj", flowType: "open" });
    const result = mod.checkAllowedTool(token, "rks_agent_research");
    expect(result).toBeNull(); // null = allowed
    mod.endSession(token);
  });
});
