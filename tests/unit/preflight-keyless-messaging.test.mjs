/**
 * backlog.fix.keyless-rag-uat-quickfixes — AC2
 *
 * When the RAG index is initialized but no LLM credential is present, preflight must NOT imply RAG
 * is dead — retrieval is fully keyless (local embedder + LanceDB); only synthesis and governed
 * workflows need a key. The decision is extracted to a pure, unit-drivable helper in
 * server/preflight.mjs (the inline rks_preflight handler in server.mjs is not unit-drivable and
 * source-slice pinning is banned), which this test drives behaviorally.
 */
import { describe, it, expect } from "vitest";
import { ragKeylessPreflightMessage } from "../../packages/mcp-rks/src/server/preflight.mjs";

describe("ragKeylessPreflightMessage (AC2)", () => {
  it("rag initialized + no key → keyless-available message + honest, key-name-only hint", () => {
    const r = ragKeylessPreflightMessage({ ragInitialized: true, hasApiKey: false });
    expect(r.message).toMatch(/keyless/i);
    expect(r.hint).toMatch(/without a key|keyless/i);
    expect(r.hint).toMatch(/ANTHROPIC_API_KEY/);
    // Says retrieval works; must not leak a credential value.
    expect(r.hint).not.toMatch(/sk-/);
  });

  it("no rag index + no key → nulls (caller falls back to the plain 'set your key' hint)", () => {
    expect(ragKeylessPreflightMessage({ ragInitialized: false, hasApiKey: false })).toEqual({
      message: null,
      hint: null,
    });
  });

  it("key present → nulls regardless of rag state", () => {
    expect(ragKeylessPreflightMessage({ ragInitialized: true, hasApiKey: true })).toEqual({
      message: null,
      hint: null,
    });
    expect(ragKeylessPreflightMessage({ ragInitialized: false, hasApiKey: true })).toEqual({
      message: null,
      hint: null,
    });
  });

  it("defensive: a no-arg call does not throw", () => {
    expect(() => ragKeylessPreflightMessage()).not.toThrow();
  });
});
