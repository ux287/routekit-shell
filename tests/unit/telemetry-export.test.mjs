/**
 * End-to-end export witness (backlog.feat.telemetry-export-redacted-bundle).
 *
 * Seeds REAL telemetry JSONL in a temp project, runs the REAL exportTelemetry (imported
 * directly, not via the globally-mocked barrel), and asserts:
 *  - both .json and .md are written and the JSON round-trips;
 *  - cost is REUSED from generateCostReport (rawCost matches in+out), degrades gracefully;
 *  - the leak witness: no seeded secret survives in EITHER output file;
 *  - scope guard: no network/fetch during export.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { withTempDir } from "../_helpers/with-temp-dir.mjs";
import { exportTelemetry } from "../../packages/mcp-rks/src/server/telemetry/export.mjs";

const STORY = "backlog.feat.telemetry-export-redacted-bundle";
const SECRETS = {
  session: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  antKey: "sk-ant-api03-ABCdef0123456789ABCdef",
  absPath: "/Users/dev/abs/secret.txt",
};

function seed(dir, events) {
  const telDir = path.join(dir, ".rks", "telemetry");
  fs.mkdirSync(telDir, { recursive: true });
  fs.writeFileSync(
    path.join(telDir, "events-2026-01-01.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

const tokenEvent = (id, tin, tout) => ({
  id,
  type: "plan.complete",
  timestamp: "2026-01-01T00:00:00Z",
  correlationId: "corr-1",
  payload: { problemId: STORY, tokens: { in: tin, out: tout, cacheRead: 0 } },
});

const secretEvent = {
  id: "secret-ev",
  type: "exec.start",
  timestamp: "2026-01-01T00:00:01Z",
  payload: {
    problemId: STORY,
    reason: `session ${SECRETS.session} using ${SECRETS.antKey}`,
    ANTHROPIC_API_KEY: SECRETS.antKey,
    path: SECRETS.absPath,
  },
};

afterEach(() => vi.restoreAllMocks());

describe("exportTelemetry — bundle + reuse + degrade", () => {
  it("writes a json+md bundle, reuses generateCostReport for a non-null cost, no secret leaks", async () => {
    await withTempDir("tel-export-", async (dir) => {
      seed(dir, [tokenEvent("e1", 100, 50), tokenEvent("e2", 200, 80), secretEvent]);
      const outDir = path.join(dir, "exports");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("network access is not allowed during export");
      });

      const res = await exportTelemetry(dir, { projectId: "routekit-shell", outDir, stamp: "t" });

      expect(res.ok).toBe(true);
      expect(fs.existsSync(res.jsonPath)).toBe(true);
      expect(fs.existsSync(res.mdPath)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled(); // scope guard: no network

      // JSON round-trips with the expected sections
      const json = JSON.parse(fs.readFileSync(res.jsonPath, "utf8"));
      expect(json.events.countsByType["plan.complete"]).toBe(2);
      expect(json.timeline.length).toBe(3);

      // Cost REUSED from generateCostReport: rawCost === sum of in+out (100+50+200+80)
      expect(res.degraded).toBe(false);
      expect(res.cost.rawCost).toBe(430);
      expect(json.cost.rawCost).toBe(430);

      // MD is human-readable
      const md = fs.readFileSync(res.mdPath, "utf8");
      expect(md).toContain("# Telemetry export");
      expect(md).toContain("Event counts by type");

      // LEAK WITNESS: no seeded secret survives in EITHER file
      const jsonText = fs.readFileSync(res.jsonPath, "utf8");
      for (const blob of [jsonText, md]) {
        expect(blob).not.toContain(SECRETS.session);
        expect(blob).not.toContain(SECRETS.antKey);
        expect(blob).not.toContain(SECRETS.absPath);
      }
    });
  });

  it("degrades gracefully when there are no token events (cost section marked degraded, still ok)", async () => {
    await withTempDir("tel-export-deg-", async (dir) => {
      seed(dir, [{ id: "n1", type: "note.saved", timestamp: "2026-01-01T00:00:00Z", payload: { problemId: STORY } }]);
      const outDir = path.join(dir, "exports");

      const res = await exportTelemetry(dir, { projectId: "routekit-shell", outDir, stamp: "d" });

      expect(res.ok).toBe(true);
      expect(res.degraded).toBe(true);
      expect(fs.existsSync(res.jsonPath)).toBe(true);
      const md = fs.readFileSync(res.mdPath, "utf8");
      expect(md).toContain("Cost data unavailable");
    });
  });
});
