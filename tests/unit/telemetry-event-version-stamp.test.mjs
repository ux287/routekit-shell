/**
 * Witness for backlog.fix.clean-machine-honesty (D2/F7) — every telemetry event names its rks.
 *
 * Without this, a failure cannot be attributed to a version. A UAT reported a planner failure against
 * "0.26.0" while the install was actually 0.27.2, and the same report's version field flip-flopped
 * across five values in one session — so nobody could say which build a bug belonged to, and one fix
 * got credited to the wrong release.
 *
 * The stamp is the LOADED version (the code that actually ran), not whatever is on disk. After a
 * `git checkout` without an MCP-server restart those differ, and only the loaded one produced the
 * event.
 *
 * `createEvent` is imported directly rather than through the telemetry barrel: the global test setup
 * mocks `telemetry/index.mjs` and `collector.mjs`, not `types.mjs` (same precedent as
 * telemetry-storage-redaction.test.mjs).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvent, LOADED_RKS_VERSION } from "../../packages/mcp-rks/src/server/telemetry/types.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("telemetry events carry the rks version that produced them", () => {
  it("stamps rksVersion on every event", () => {
    const e = createEvent("plan.failed", "proj", { reason: "output_invalid" });
    expect(e.rksVersion).toBeTruthy();
    expect(e.rksVersion).toBe(LOADED_RKS_VERSION);
  });

  it("the stamped version is the REAL one from the shell's package.json", () => {
    // POSITIVE CONTROL: pin it to ground truth, so a stamp of `undefined`/`"unknown"`/`null` — all of
    // which are "truthy-ish" mistakes a careless implementation makes — cannot pass.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(LOADED_RKS_VERSION).toBe(pkg.version);
    expect(LOADED_RKS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("stamps failure events too — the ones that actually need attributing", () => {
    for (const type of ["plan.failed", "exec.failed", "plan.retry.exhausted"]) {
      expect(createEvent(type, "proj", {}).rksVersion).toBe(LOADED_RKS_VERSION);
    }
  });

  it("does not disturb the existing event shape", () => {
    const e = createEvent("plan.start", "proj", { slug: "x" }, { correlationId: "c1", runId: "r1" });
    expect(e).toMatchObject({
      type: "plan.start",
      projectId: "proj",
      payload: { slug: "x" },
      correlationId: "c1",
      runId: "r1",
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof e.timestamp).toBe("string");
  });
});
