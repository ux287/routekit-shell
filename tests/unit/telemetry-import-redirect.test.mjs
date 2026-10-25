import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This is the PACKAGE-BOUNDARY / contract suite — it must verify the REAL @routekit/telemetry surface
// (barrel↔subpath re-export IDENTITY + the full public export list), NOT the global test mock. The
// suite-wide tests/setup.mjs mocks `@routekit/telemetry` and `@routekit/telemetry/collector`; unmock
// them HERE so this file deterministically resolves the real package regardless of shard-neighbor mock
// priming. Without this, the file passes in isolation/small batches but fails in the full unit shard
// (a neighbor's static import primes the mock, and the mock can't satisfy the real re-export identity —
// notably `barrel.exportTelemetry === @routekit/telemetry/export`'s, since /export is never mocked).
// vi.unmock is hoisted and file-scoped (per-file module registry), so it does NOT leak to shard
// neighbors that rely on the shared mock. (backlog.fix.telemetry-barrel-mock-shard-completeness)
vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");

// backlog.feat.telemetry-package-extraction — telemetry now lives in the standalone @routekit/telemetry
// package at packages/telemetry/src. Host consumers import via the bare specifier `@routekit/telemetry`
// (barrel) or a DECLARED subpath `@routekit/telemetry/<module>`; a RELATIVE deep path into the moved
// code is forbidden. This suite pins that boundary, the package's cycle-freedom (no static import back
// into the host), and barrel export identity — mirroring tests/unit/rag-import-redirect.test.mjs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const HOST_SRC = resolve(ROOT, "packages/mcp-rks/src");
const TEL_SRC = resolve(ROOT, "packages/telemetry/src");

function walkMjs(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMjs(p, acc);
    else if (e.name.endsWith(".mjs")) acc.push(p);
  }
  return acc;
}

// Static import / export-from specifier extractor (dynamic import() and plain strings are ignored —
// they don't create a static module-graph edge, so they can't form a package cycle).
const fromRe = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
function specifiers(src) {
  const out = [];
  let m;
  fromRe.lastIndex = 0;
  while ((m = fromRe.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe("@routekit/telemetry extraction — package boundary", () => {
  it("no host file RELATIVE-deep-imports the moved telemetry code (consumers must use @routekit/telemetry)", () => {
    const offenders = [];
    for (const file of walkMjs(HOST_SRC)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue; // bare `@routekit/telemetry[/sub]`, npm, node: — fine
        const resolved = resolve(dirname(file), spec);
        if (resolved === TEL_SRC || resolved.startsWith(TEL_SRC + "/")) {
          offenders.push(`${file.slice(HOST_SRC.length + 1)} → ${spec}`);
        }
      }
    }
    expect(offenders, "host files must import telemetry via @routekit/telemetry, not a relative deep path").toEqual([]);
  });

  it("CYCLE-FREEDOM: no file under packages/telemetry/src statically imports outside the package", () => {
    // A static import escaping the package — especially back into mcp-rks — would form a cross-package
    // cycle. Telemetry is a leaf subsystem (zero outbound host edges by construction). Bare specifiers
    // (npm deps like `glob`, node: builtins) are allowed.
    const offenders = [];
    for (const file of walkMjs(TEL_SRC)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const resolved = resolve(dirname(file), spec);
        if (resolved !== TEL_SRC && !resolved.startsWith(TEL_SRC + "/")) {
          offenders.push(`${file.slice(TEL_SRC.length + 1)} → ${spec}`);
        }
      }
    }
    expect(offenders, "packages/telemetry/src must not statically import outside itself").toEqual([]);
  });

  it("the telemetry package never references the mcp-rks host (belt-and-suspenders)", () => {
    const offenders = [];
    for (const file of walkMjs(TEL_SRC)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (spec.includes("mcp-rks")) offenders.push(`${file.slice(TEL_SRC.length + 1)} → ${spec}`);
      }
    }
    expect(offenders, "@routekit/telemetry must not import the mcp-rks host").toEqual([]);
  });

  it("the barrel resolves via @routekit/telemetry and re-exports the public surface", async () => {
    const barrel = await import("@routekit/telemetry");
    for (const sym of [
      "getTelemetryCollector", "resetTelemetryCollector", "TelemetryCollector",
      "ensureTelemetryStorage", "TelemetryStorage", "createTelemetryStorage",
      "EventTypes", "createEvent", "createCorrelationId",
      "redactValue", "redactEvent", "redactString", "isSecretKey", "REDACTED",
      "exportTelemetry",
    ]) {
      expect(barrel[sym], `barrel must export ${sym}`).toBeDefined();
    }
    expect(barrel.ensureTelemetryStorage).toBeTypeOf("function");
  });

  it("declared subpaths resolve (query/cost/analysis/digest/reports) — internals reachable without a relative path", async () => {
    expect((await import("@routekit/telemetry/query")).queryTelemetry).toBeTypeOf("function");
    expect((await import("@routekit/telemetry/cost")).calculateCost).toBeTypeOf("function");
    expect((await import("@routekit/telemetry/analysis")).analyzeFailure).toBeTypeOf("function");
    expect((await import("@routekit/telemetry/digest")).generateDigest).toBeTypeOf("function");
    expect((await import("@routekit/telemetry/reports")).generateReport).toBeTypeOf("function");
  });

  it("behavior-preservation: barrel symbols are identical references to their source module", async () => {
    const barrel = await import("@routekit/telemetry");
    const collector = await import("@routekit/telemetry/collector");
    const exportMod = await import("@routekit/telemetry/export");
    expect(barrel.getTelemetryCollector).toBe(collector.getTelemetryCollector);
    expect(barrel.TelemetryCollector).toBe(collector.TelemetryCollector);
    expect(barrel.exportTelemetry).toBe(exportMod.exportTelemetry);
  });
});
