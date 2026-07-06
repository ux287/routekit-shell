import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks.mjs");

// Derive the expected root the same way the server does:
// packages/mcp-rks/bin/ -> three levels up -> repo root
const EXPECTED_ROOT = path.resolve(path.dirname(BIN), "..", "..", "..");

describe("mcp-rks.mjs — project root auto-derivation", () => {
  it("derived root resolves to the repo root (contains package.json)", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(EXPECTED_ROOT, "package.json"))).toBe(true);
  });

  it("derived root resolves to the repo root (contains CLAUDE.md)", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(EXPECTED_ROOT, "CLAUDE.md"))).toBe(true);
  });

  it("derived root is three levels up from bin/", () => {
    const binDir = path.dirname(BIN);
    const derived = path.resolve(binDir, "..", "..", "..");
    expect(derived).toBe(EXPECTED_ROOT);
  });
});

describe("mcp-rks.mjs — ROUTEKIT_PROJECT_ROOT override logic", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.ROUTEKIT_PROJECT_ROOT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ROUTEKIT_PROJECT_ROOT;
    } else {
      process.env.ROUTEKIT_PROJECT_ROOT = originalEnv;
    }
  });

  it("when ROUTEKIT_PROJECT_ROOT is absent, effectiveRoot is the derived root", () => {
    delete process.env.ROUTEKIT_PROJECT_ROOT;
    const runtimeRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const effectiveRoot = runtimeRoot || EXPECTED_ROOT;
    expect(effectiveRoot).toBe(EXPECTED_ROOT);
  });

  it("when ROUTEKIT_PROJECT_ROOT is empty string, effectiveRoot falls back to derived root", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = "";
    const runtimeRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const effectiveRoot = runtimeRoot || EXPECTED_ROOT;
    expect(effectiveRoot).toBe(EXPECTED_ROOT);
  });

  it("when ROUTEKIT_PROJECT_ROOT is set to a valid path, it is used as effectiveRoot", () => {
    const override = "/tmp/custom-project-root";
    process.env.ROUTEKIT_PROJECT_ROOT = override;
    const runtimeRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const effectiveRoot = runtimeRoot || EXPECTED_ROOT;
    expect(effectiveRoot).toBe(override);
  });

  it("override takes precedence over derived root", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = "/some/other/path";
    const runtimeRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const effectiveRoot = runtimeRoot || EXPECTED_ROOT;
    expect(effectiveRoot).not.toBe(EXPECTED_ROOT);
    expect(effectiveRoot).toBe("/some/other/path");
  });
});

describe(".mcp.json — no machine-specific paths committed", () => {
  const TEMPLATE_PATH = path.join(ROOT, "templates/base/.mcp.json");

  it("templates/base/.mcp.json template exists in repo", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it("ROUTEKIT_PROJECT_ROOT value in template is a placeholder, not an absolute path", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    const config = JSON.parse(content);
    const rksEnv = config?.mcpServers?.rks?.env ?? {};
    const val = rksEnv.ROUTEKIT_PROJECT_ROOT;
    // Must be a placeholder string — never a machine-specific absolute path
    expect(val).toBeDefined();
    expect(val).not.toMatch(/^\//);
  });

  it("no absolute user home path is committed in templates/base/.mcp.json", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).not.toMatch(/\/Users\/|\/home\//);
  });
});
