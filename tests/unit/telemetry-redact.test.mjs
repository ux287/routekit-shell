/**
 * Redaction core tests (backlog.feat.telemetry-export-redacted-bundle).
 *
 * The redaction core is the reusable, standalone-importable scrubber that both the export
 * bundle and the deferred opt-in uploader depend on. These tests pin every secret class the
 * export must never leak, plus purity (imports clean, primitives pass through).
 */
import { describe, it, expect } from "vitest";
import {
  redactString,
  redactValue,
  redactEvent,
  isSecretKey,
  REDACTED,
} from "../../packages/mcp-rks/src/server/telemetry/redact.mjs";

// Fake/synthetic secrets — NOT real. Must never survive redaction.
const FAKE = {
  sessionUuid: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  antKey: "sk-ant-api03-ABCdef0123456789ABCdef",
  ghToken: "ghp_ABCdef0123456789ABCdef0123456789",
  ghPat: "github_pat_11ABCDEF0123456789_abcDEF0123456789abcDEF",
  openaiKey: "sk-ABCdef0123456789ABCdef0123456789",
  bearer: "Bearer abcDEF0123456789.tokenpart_x",
  homePath: "/Users/someone/Documents/secret/place.txt",
};

describe("redactString — secret classes", () => {
  it("scrubs a v4 UUID (governor/session token)", () => {
    const out = redactString(`session=${FAKE.sessionUuid} done`);
    expect(out).not.toContain(FAKE.sessionUuid);
    expect(out).toContain("[REDACTED-UUID]");
  });

  it("scrubs an Anthropic key (sk-ant-…)", () => {
    const out = redactString(`key ${FAKE.antKey}`);
    expect(out).not.toContain(FAKE.antKey);
    expect(out).toContain("[REDACTED-ANTHROPIC-KEY]");
  });

  it("scrubs GitHub tokens (ghp_… and github_pat_…)", () => {
    expect(redactString(FAKE.ghToken)).not.toContain(FAKE.ghToken);
    expect(redactString(FAKE.ghPat)).not.toContain(FAKE.ghPat);
    expect(redactString(FAKE.ghToken)).toContain("[REDACTED-GH-TOKEN]");
  });

  it("scrubs a generic sk- key and a Bearer token", () => {
    expect(redactString(FAKE.openaiKey)).not.toContain(FAKE.openaiKey);
    const b = redactString(`Authorization: ${FAKE.bearer}`);
    expect(b).not.toContain("abcDEF0123456789.tokenpart_x");
    expect(b).toContain("Bearer [REDACTED]");
  });

  it("rewrites a projectRoot-absolute path to repo-relative", () => {
    const root = "/tmp/proj-xyz";
    const out = redactString(`${root}/notes/foo.md`, root);
    expect(out).toBe("./notes/foo.md");
  });

  it("rewrites a home-dir absolute path to a placeholder", () => {
    const out = redactString(FAKE.homePath);
    expect(out).not.toContain("/Users/someone");
    expect(out).toContain("<path>");
  });
});

describe("redactValue / redactEvent — recursion, secret keys, purity", () => {
  it("masks values under secret-looking KEYS wholesale", () => {
    const inp = {
      ANTHROPIC_API_KEY: "sk-ant-whatever",
      MY_SECRET: "hunter2",
      accessToken: "abc",
      _governorToken: FAKE.sessionUuid,
      sessionId: FAKE.sessionUuid,
      keep: "visible",
    };
    const out = redactValue(inp);
    expect(out.ANTHROPIC_API_KEY).toBe(REDACTED);
    expect(out.MY_SECRET).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
    expect(out._governorToken).toBe(REDACTED);
    expect(out.sessionId).toBe(REDACTED);
    expect(out.keep).toBe("visible");
    expect(isSecretKey("FOO_TOKEN")).toBe(true);
    expect(isSecretKey("type")).toBe(false);
  });

  it("recurses into nested objects/arrays and scrubs string secrets", () => {
    const inp = { a: { b: [`x ${FAKE.antKey}`, { c: FAKE.sessionUuid }] } };
    const out = redactValue(inp);
    const flat = JSON.stringify(out);
    expect(flat).not.toContain(FAKE.antKey);
    expect(flat).not.toContain(FAKE.sessionUuid);
  });

  it("is pure — primitives pass through, input is not mutated", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    const inp = { k: FAKE.antKey };
    const out = redactEvent(inp);
    expect(inp.k).toBe(FAKE.antKey); // original untouched
    expect(out.k).not.toContain(FAKE.antKey);
  });
});
