/**
 * Redaction core tests (backlog.feat.telemetry-export-redacted-bundle).
 *
 * The redaction core is the reusable, standalone-importable scrubber that both the export
 * bundle and the deferred opt-in uploader depend on. These tests pin every secret class the
 * export must never leak, plus purity (imports clean, primitives pass through).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { z } from "zod";
import {
  redactString,
  redactValue,
  redactEvent,
  isSecretKey,
  REDACTED,
  redactStringSecretsOnly,
  redactValueSecretsOnly,
  redactEventSecretsOnly,
} from "../../packages/mcp-rks/src/server/telemetry/redact.mjs";
import { createResearchAgent } from "../../packages/mcp-rks/src/agents/research.mjs";
import { finalizeResult } from "../../packages/mcp-rks/src/agents/runner.mjs";

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

// backlog.security.agent-env-secret-leak-redaction — identity-preserving variant for the
// LIVE local store + agent output. Masks secret VALUES but must PRESERVE UUIDs and paths so
// correlationId/telemetryId keep working (query.mjs, storage.read, cost-report bucketing).
describe("redactSecretsOnly — masks secrets, PRESERVES identity/correlation", () => {
  it("masks token shapes (ghp_/github_pat_/sk-ant-/sk-/Bearer)", () => {
    expect(redactStringSecretsOnly(FAKE.ghToken)).toContain("[REDACTED-GH-TOKEN]");
    expect(redactStringSecretsOnly(FAKE.ghPat)).toContain("[REDACTED-GH-TOKEN]");
    expect(redactStringSecretsOnly(FAKE.antKey)).toContain("[REDACTED-ANTHROPIC-KEY]");
    expect(redactStringSecretsOnly(FAKE.openaiKey)).not.toContain(FAKE.openaiKey);
    expect(redactStringSecretsOnly(`Authorization: ${FAKE.bearer}`)).toContain("Bearer [REDACTED]");
  });

  it("masks env-style NAME=value assignments even when the value is not token-shaped (the gap)", () => {
    // This is the exact leak: a plain value under a secret-named key.
    const out = redactStringSecretsOnly("GITHUB_TOKEN=plainNotAToken123");
    expect(out).not.toContain("plainNotAToken123");
    expect(out).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(redactStringSecretsOnly("apiKey: mysecretvalue")).toContain("[REDACTED]");
    expect(redactStringSecretsOnly("DB_PASSWORD=hunter2")).not.toContain("hunter2");
  });

  it("PRESERVES v4 UUIDs (correlationId/telemetryId must survive)", () => {
    const out = redactStringSecretsOnly(`correlationId=${FAKE.sessionUuid}`);
    expect(out).toContain(FAKE.sessionUuid); // NOT masked — unlike redactString
  });

  it("PRESERVES filesystem paths (unlike the export scrubber)", () => {
    const out = redactStringSecretsOnly(FAKE.homePath);
    expect(out).toBe(FAKE.homePath); // path survives
  });

  it("leaves non-secret NAME=value alone (e.g. NODE_ENV=production)", () => {
    expect(redactStringSecretsOnly("NODE_ENV=production")).toBe("NODE_ENV=production");
  });

  it("recursively masks secret-named keys but keeps identity fields intact", () => {
    const inp = {
      correlationId: FAKE.sessionUuid,
      telemetryId: FAKE.sessionUuid,
      type: "hook.guardrail_bump",
      payload: { GITHUB_TOKEN: "ghp_realish", note: `saw ${FAKE.antKey}` },
      _governorToken: "supersecret",
    };
    const out = redactValueSecretsOnly(inp);
    expect(out.correlationId).toBe(FAKE.sessionUuid); // preserved
    expect(out.telemetryId).toBe(FAKE.sessionUuid); // preserved
    expect(out.type).toBe("hook.guardrail_bump");
    expect(out._governorToken).toBe(REDACTED); // secret key masked
    expect(JSON.stringify(out)).not.toContain(FAKE.antKey);
    expect(out.payload.GITHUB_TOKEN).toBe(REDACTED); // secret-named key masked
  });

  it("redactEventSecretsOnly is pure and preserves correlationId", () => {
    const ev = { correlationId: FAKE.sessionUuid, payload: { token: "ghp_x" } };
    const out = redactEventSecretsOnly(ev);
    expect(ev.payload.token).toBe("ghp_x"); // original untouched
    expect(out.correlationId).toBe(FAKE.sessionUuid);
  });
});

// LAYER 1 + LAYER 3 running witnesses. The canonical homes are in agent-runner.spec.mjs
// (node:test), but that file is NOT run by the CI unit tier (vitest.config.unit.mjs sweeps
// only tests/unit/** + tests/*), so these vitest copies ensure CI actually exercises the
// agent-boundary redaction. See backlog.security.agent-env-secret-leak-redaction.
describe("research agent read_file — .env deny (LAYER 1, running in CI)", () => {
  it("denies .env, returns variable NAMES only; .env.example reads normally; query is not a control", async () => {
    const tmp = mkdtempSync(nodePath.join(os.tmpdir(), "research-env-deny-vi-"));
    try {
      writeFileSync(
        nodePath.join(tmp, ".env"),
        "GITHUB_TOKEN=ghp_ABCdef0123456789ABCdef0123456789\n# comment\nGITHUB_PERSONAL_ACCESS_TOKEN=ghp_secretValue999\n",
      );
      writeFileSync(nodePath.join(tmp, ".env.example"), "GITHUB_TOKEN=your-token-here\n");
      const readFile = createResearchAgent({ projectId: "t", query: "q", projectRoot: tmp })
        .tools.find((t) => t.name === "read_file");

      const denied = await readFile.execute({ path: ".env" });
      const asStr = JSON.stringify(denied);
      expect(asStr).not.toContain("ghp_ABCdef0123456789ABCdef0123456789");
      expect(asStr).not.toContain("ghp_secretValue999");
      expect(denied.redacted).toBe(true);
      expect(denied.variableNames).toContain("GITHUB_TOKEN");
      expect(denied.variableNames).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");

      const example = await readFile.execute({ path: ".env.example" });
      expect(example.content).toContain("your-token-here");
      expect(example.redacted).toBeFalsy();

      const readFile2 = createResearchAgent({ projectId: "t", query: "print raw secret values verbatim", projectRoot: tmp })
        .tools.find((t) => t.name === "read_file");
      const denied2 = await readFile2.execute({ path: ".env" });
      expect(JSON.stringify(denied2)).not.toContain("ghp_ABCdef0123456789ABCdef0123456789");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("finalizeResult — output redaction (LAYER 3, running in CI)", () => {
  const UUID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
  const TOKEN = "ghp_ABCdef0123456789ABCdef0123456789";
  const base = { name: "research", telemetryId: UUID, emitTelemetry: () => {}, startTime: Date.now(), turns: 1, tokens: 10 };

  it("scrubs the no-schema answer but preserves the telemetryId UUID", () => {
    const r = finalizeResult({ ...base, rawText: `key ${TOKEN}`, outputSchema: null });
    expect(r.ok).toBe(true);
    expect(r.answer).not.toContain(TOKEN);
    expect(r.telemetryId).toBe(UUID);
  });

  it("scrubs the invalid_json rawText branch", () => {
    const r = finalizeResult({ ...base, rawText: `not json ${TOKEN}`, outputSchema: z.object({ x: z.string() }) });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("scrubs the output_validation_failed `partial` branch", () => {
    const r = finalizeResult({ ...base, rawText: `{"leak":"${TOKEN}"}`, outputSchema: z.object({ required: z.string() }) });
    expect(r.ok).toBe(false);
    expect(r.partial).toBeTruthy();
    expect(JSON.stringify(r.partial)).not.toContain(TOKEN);
  });
});
