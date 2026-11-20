/**
 * Session idle warning — retired.
 *
 * backlog.feat.assert-tool-allowed-wire-or-delete: `_sessionWarning` was written only by the
 * uncalled second admission function, and nothing in packages/mcp-rks/src read it, so the
 * feature had no runtime effect. It was deleted with that function (and WARN_THRESHOLD with
 * it). Whether to surface an idle warning in tool responses is a recorded follow-up.
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

// ── Source-based verification ────────────────────────────────────────────────

describe("governor-token.mjs — session idle warning (source)", () => {
  const src = readSource("packages/mcp-rks/src/shared/governor-token.mjs");

  it("defines MAX_AGE_MS at module level", () => {
    expect(src).toMatch(/const MAX_AGE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  });

  it("governor-token.mjs no longer writes _sessionWarning", () => {
    // Positive control: the file read is the real module (it declares checkAllowedTool).
    expect(src).toContain("\nexport function checkAllowedTool(");
    expect(src).not.toMatch(/_sessionWarning\s*=/);
    expect(src).not.toMatch(/WARN_THRESHOLD/);
  });
});

// ── Behavioral unit tests ────────────────────────────────────────────────────

describe("checkAllowedTool — an aged session is neither warned nor blocked", async () => {
  const mod = await import(path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"));

  it("a session past 80% of its TTL is still admitted and carries no _sessionWarning", () => {
    const { token, session } = mod.createSession({ projectId: "test-proj" });
    session.createdAt = Date.now() - 25 * 60 * 1000;
    expect(mod.checkAllowedTool(token, "rks_agent_research", {})).toBeNull();
    expect(session._sessionWarning).toBeUndefined();
    mod.endSession(token);
  });
});
