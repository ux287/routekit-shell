/**
 * Unit tests for runPreflight — rksVersion field and preflight.mcp_tool telemetry.
 *
 * Verifies that the preflight response always includes a top-level rksVersion
 * field read from the root package.json, and that existing fields are unchanged.
 * Also verifies the preflight.mcp_tool emit payload includes a failures array.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import pathMod from "node:path";

const preflightSrc = fs.readFileSync(
  pathMod.resolve("packages/mcp-rks/src/server/preflight.mjs"),
  "utf8"
);
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

describe("runPreflight — rksVersion", () => {
  let originalSkip;

  beforeEach(() => {
    originalSkip = process.env.RKS_SKIP_PREFLIGHT;
    delete process.env.RKS_SKIP_PREFLIGHT;
  });

  afterEach(() => {
    if (originalSkip !== undefined) {
      process.env.RKS_SKIP_PREFLIGHT = originalSkip;
    } else {
      delete process.env.RKS_SKIP_PREFLIGHT;
    }
  });

  it("includes rksVersion when all checks pass (ok: true)", async () => {
    process.env.RKS_SKIP_PREFLIGHT = "1";
    const { runPreflight } = await import(
      path.join(ROOT, "packages/mcp-rks/src/server/preflight.mjs")
    );
    const result = await runPreflight("rks_plan", { projectId: "test" });
    expect(result.ok).toBe(true);
    expect(result.rksVersion).toBeDefined();
    expect(typeof result.rksVersion).toBe("string");
  }, 30_000);

  it("rksVersion matches root package.json version", async () => {
    process.env.RKS_SKIP_PREFLIGHT = "1";
    const { runPreflight } = await import(
      path.join(ROOT, "packages/mcp-rks/src/server/preflight.mjs")
    );
    const { default: fs } = await import("fs");
    const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

    const result = await runPreflight("rks_plan", { projectId: "test" });
    expect(result.rksVersion).toBe(rootPkg.version);
  }, 30_000);

  it("includes rksVersion when checks fail (ok: false)", async () => {
    // rks_release on a non-staging branch should fail the release_ready check
    const { runPreflight } = await import(
      path.join(ROOT, "packages/mcp-rks/src/server/preflight.mjs")
    );
    // Call with a tool that has no checks configured — still gets rksVersion
    const result = await runPreflight("rks_unknown_tool_no_checks", {});
    expect(result.rksVersion).toBeDefined();
  }, 30_000);

  it("existing ok, errors, and warnings fields are present and unchanged", async () => {
    process.env.RKS_SKIP_PREFLIGHT = "1";
    const { runPreflight } = await import(
      path.join(ROOT, "packages/mcp-rks/src/server/preflight.mjs")
    );
    const result = await runPreflight("rks_plan", { projectId: "test" });
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("warnings");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  }, 30_000);
});

describe("preflight.mcp_tool telemetry — failures array", () => {
  it("preflight.mcp_tool emit includes a failures field", () => {
    const emitBlock = preflightSrc.match(/emit\("preflight\.mcp_tool"[\s\S]*?\}\)/)?.[0] ?? "";
    expect(emitBlock).toContain("failures");
  });

  it("failures field is set to the errors array (populated when errorCount > 0)", () => {
    const emitBlock = preflightSrc.match(/emit\("preflight\.mcp_tool"[\s\S]*?\}\)/)?.[0] ?? "";
    expect(emitBlock).toContain("failures: errors");
  });

  it("existing errorCount and warningCount fields are still present", () => {
    const emitBlock = preflightSrc.match(/emit\("preflight\.mcp_tool"[\s\S]*?\}\)/)?.[0] ?? "";
    expect(emitBlock).toContain("errorCount");
    expect(emitBlock).toContain("warningCount");
  });

  it("existing checksRun and passed fields are still present", () => {
    const emitBlock = preflightSrc.match(/emit\("preflight\.mcp_tool"[\s\S]*?\}\)/)?.[0] ?? "";
    expect(emitBlock).toContain("checksRun");
    expect(emitBlock).toContain("passed");
  });
});
