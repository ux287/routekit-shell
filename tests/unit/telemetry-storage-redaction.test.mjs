/**
 * Witness for backlog.security.agent-env-secret-leak-redaction — LAYER 4.
 *
 * TelemetryStorage.write() is the last gate before disk. It must mask secret VALUES so no
 * live token is persisted to .rks/telemetry/events-*.jsonl, while PRESERVING correlationId/
 * telemetryId (v4 UUIDs) so storage.read()/query.mjs/cost-report.mjs can still correlate.
 *
 * Imports createTelemetryStorage DIRECTLY from storage.mjs (the real module) — the global
 * setup.mjs mock replaces the telemetry BARREL (index.mjs), not storage.mjs, so this exercises
 * real redaction end-to-end.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTelemetryStorage } from "../../packages/mcp-rks/src/server/telemetry/storage.mjs";

// Synthetic secrets — NOT real.
const CORRELATION = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const SECRET_TOKEN = "ghp_ABCdef0123456789ABCdef0123456789";
const PLAIN_SECRET = "supersecretplainvalue"; // not token-shaped — only the NAME=value rule catches it

describe("TelemetryStorage.write — secret redaction gate (LAYER 4)", () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("masks secret values on disk but PRESERVES correlationId so the store stays queryable", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "tel-store-redact-"));
    const storage = createTelemetryStorage(root);
    const ev = {
      type: "agent.research.tool_call",
      projectId: "routekit-shell-core",
      timestamp: "2026-07-06T12:00:00.000Z",
      correlationId: CORRELATION,
      payload: {
        outputSummary: `read .env and got ${SECRET_TOKEN}`,
        line: `GITHUB_TOKEN=${PLAIN_SECRET}`,
      },
    };

    await storage.write([ev]);

    // 1. Raw file on disk carries NO secret value.
    const dir = path.join(root, ".rks", "telemetry");
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    const raw = readFileSync(path.join(dir, file), "utf8");
    expect(raw).not.toContain(SECRET_TOKEN);
    expect(raw).not.toContain(PLAIN_SECRET);
    expect(raw).toContain("[REDACTED-GH-TOKEN]");

    // 2. correlationId survived → the store is still queryable by it.
    expect(raw).toContain(CORRELATION);
    const back = await storage.read({
      correlationId: CORRELATION,
      startDate: "2026-07-06",
      endDate: "2026-07-06",
    });
    expect(back.length).toBe(1);
    expect(back[0].correlationId).toBe(CORRELATION);
    expect(JSON.stringify(back[0])).not.toContain(SECRET_TOKEN);
  });

  it("does not mutate the caller's event object (pure redaction)", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "tel-store-redact-"));
    const storage = createTelemetryStorage(root);
    const ev = {
      type: "x",
      timestamp: "2026-07-06T12:00:00.000Z",
      correlationId: CORRELATION,
      payload: { token: SECRET_TOKEN },
    };
    await storage.write([ev]);
    expect(ev.payload.token).toBe(SECRET_TOKEN); // original untouched
  });
});
