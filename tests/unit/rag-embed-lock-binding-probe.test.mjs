/**
 * Tests for backlog.design.rag-embed-lock-kernel-binding-spike.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-binding-probe.test.mjs
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINDINGS,
  CHECKS,
  CHILD_TIMEOUT_MS,
  probeBinding,
  runChild,
} from "../../scripts/spike/embed-lock-binding-probe.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE = path.join(REPO_ROOT, "scripts", "spike", "embed-lock-binding-probe.mjs");

describe("embed-lock binding probe", () => {
  it("exports the four bindings and four checks", () => {
    expect([...BINDINGS]).toEqual(["flock-addon", "better-sqlite3", "node-sqlite", "loopback-port"]);
    expect([...CHECKS]).toEqual(["cross-process-refused", "same-process-refused", "sigkill-recovery", "synchronous"]);
  });

  it("bounds every child with a finite timeout", () => {
    expect(Number.isFinite(CHILD_TIMEOUT_MS)).toBe(true);
    expect(CHILD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CHILD_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("reports loopback-port identity fields", async () => {
    const r = await probeBinding("loopback-port");
    expect(r.binding).toBe("loopback-port");
    expect(r.platform).toBe(process.platform);
    expect(r.arch).toBe(process.arch);
    expect(r.node).toBe(process.version);
    expect(r.available).toBe(true);
    expect(r.error).toBeNull();
  }, 120_000);

  it("records all four checks for loopback-port", async () => {
    const r = await probeBinding("loopback-port");
    expect(Object.keys(r.results).sort()).toEqual([...CHECKS].sort());
    for (const check of CHECKS) {
      expect(typeof r.results[check].pass).toBe("boolean");
      expect("observed" in r.results[check]).toBe(true);
    }
    expect(r.results["cross-process-refused"].pass).toBe(true);
    expect(r.results["same-process-refused"].pass).toBe(true);
    expect(r.results["sigkill-recovery"].pass).toBe(true);
    expect(r.results.synchronous.pass).toBe(false);
    expect(r.results.synchronous.observed.acquireReturnedPromise).toBe(true);
  }, 120_000);

  it("reports an unknown binding as unavailable with an error", async () => {
    const r = await probeBinding("not-a-real-binding");
    expect(r.available).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  }, 30_000);

  it("kills a child that outlives its timeout", async () => {
    const started = Date.now();
    const r = await runChild(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it("has exactly one child-process call site", () => {
    const src = fs.readFileSync(PROBE, "utf8");
    const sites = src.match(/\b(?:spawn|spawnSync|fork|execFile|execFileSync|execSync)\s*\(/g) ?? [];
    expect(sites).toHaveLength(1);
  });

  it("prints one JSON line per binding when run as a script", () => {
    const r = spawnSync(process.execPath, [PROBE], { cwd: REPO_ROOT, encoding: "utf8", timeout: 150_000 });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    const lines = r.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.binding)).toEqual([...BINDINGS]);
    for (const l of lines) {
      if (l.available) {
        expect(l.error).toBeNull();
        expect(Object.keys(l.results).sort()).toEqual([...CHECKS].sort());
      } else {
        expect(typeof l.error).toBe("string");
        expect(l.error.length).toBeGreaterThan(0);
      }
    }
  }, 180_000);
});
