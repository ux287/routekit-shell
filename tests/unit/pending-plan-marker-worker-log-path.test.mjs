/**
 * backlog.fix.pending-plan-marker-drops-worker-log-path
 *
 * The launch marker must persist workerLogPath so rks_plan_review's failure payload can
 * relay it. Behavioral: imports the pure builder; composes it with the worker's update
 * and the plan_review failure response exactly as the real path does.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPendingPlanMarker, buildMarkerUpdate } from "../../packages/mcp-rks/src/server/plan-marker.mjs";
import {
  classifyMarkerFailure,
  buildPlanReviewFailureResponse,
} from "../../packages/mcp-rks/src/server/failure-classification.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "../../packages/mcp-rks/src/server.mjs");

const LOG = "/x/.rks/plan-logs/1.log";
const BASE = { planKey: "k", projectId: "p", problemId: "backlog.fix.x", startedAt: 1, pid: 4242 };
const roundTrip = (o) => JSON.parse(JSON.stringify(o));

describe("buildPendingPlanMarker persists workerLogPath", () => {
  it("carries the supplied workerLogPath through JSON serialization", () => {
    const marker = roundTrip(buildPendingPlanMarker({ ...BASE, workerLogPath: LOG }));
    expect(marker.workerLogPath).toBe(LOG);
  });

  it("writes workerLogPath null when absent and leaves the other fields unchanged", () => {
    const marker = roundTrip(buildPendingPlanMarker({ ...BASE }));
    expect(marker.workerLogPath).toBeNull();
    expect(marker).toEqual({ ...BASE, workerLogPath: null });
  });

  it("defaults pid to process.pid when not supplied", () => {
    const { pid, ...rest } = BASE;
    expect(buildPendingPlanMarker({ ...rest }).pid).toBe(process.pid);
  });
});

describe("workerLogPath survives to the rks_plan_review failure payload", () => {
  it("launch marker -> worker failure update -> failure response reports the launch log path", () => {
    const launched = roundTrip(buildPendingPlanMarker({ ...BASE, workerLogPath: LOG }));
    // plan-worker.mjs updateMarker: { ...marker, ...updates }
    const updated = roundTrip({ ...launched, ...buildMarkerUpdate({ ok: false, error: "boom" }) });
    expect(updated.workerLogPath).toBe(LOG);
    const res = buildPlanReviewFailureResponse(updated, 1, classifyMarkerFailure(updated));
    expect(res.workerLogPath).toBe(LOG);
  });
});

describe("server.mjs wiring", () => {
  const src = fs.readFileSync(SERVER, "utf8");

  it("writePendingPlanMarker accepts workerLogPath and serializes via buildPendingPlanMarker", () => {
    expect(src).toMatch(/function writePendingPlanMarker\(projectRoot, \{[^}]*workerLogPath/);
    expect(src).toMatch(/JSON\.stringify\(buildPendingPlanMarker\(\{[^}]*workerLogPath[^}]*\}\)/);
    expect(src).toMatch(/import \{[^}]*buildPendingPlanMarker[^}]*\} from "\.\/server\/plan-marker\.mjs"/);
  });

  it("the rks_plan launch still passes workerLogPath to writePendingPlanMarker", () => {
    expect(src).toMatch(/writePendingPlanMarker\(ctx\.record\.root, \{[^}]*workerLogPath:/);
  });
});
