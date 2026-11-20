import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProjectTests, detectTestRunner } from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

import { spawnSync } from "child_process";

function makeSpawnResult(exitCode = 0) {
  return { status: exitCode, signal: null, stdout: "✓ all tests passed\n", stderr: "" };
}

describe("runProjectTests — testPaths option", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue(makeSpawnResult(0));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts optional testPaths array without breaking existing signature", () => {
    expect(() => runProjectTests(ROOT, {})).not.toThrow();
    expect(() => runProjectTests(ROOT, { testPaths: [] })).not.toThrow();
    expect(() => runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] })).not.toThrow();
  });

  it("when testPaths is provided and non-empty, spawnSync is called with node and vitest-runner.mjs", () => {
    const paths = ["tests/unit/foo.test.mjs", "tests/unit/bar.test.mjs"];
    runProjectTests(ROOT, { testPaths: paths });
    expect(spawnSync).toHaveBeenCalledWith(
      "node",
      expect.arrayContaining(["scripts/vitest-runner.mjs", "--timeout", ...paths]),
      expect.any(Object)
    );
  });

  it("when testPaths is empty array, falls back to full npm run test:unit suite", () => {
    runProjectTests(ROOT, { testPaths: [] });
    const call = spawnSync.mock.calls[0];
    expect(call[0]).toBe("npm");
    expect(call[1]).toContain("test:unit");
  });

  it("when testPaths is absent (undefined), falls back to full npm run test:unit suite", () => {
    runProjectTests(ROOT, {});
    const call = spawnSync.mock.calls[0];
    expect(call[0]).toBe("npm");
    expect(call[1]).toContain("test:unit");
  });

  it("when testPaths is null, falls back to full npm run test:unit suite", () => {
    runProjectTests(ROOT, { testPaths: null });
    const call = spawnSync.mock.calls[0];
    expect(call[0]).toBe("npm");
    expect(call[1]).toContain("test:unit");
  });
});

describe("exec.mjs testFiles wiring — governor-build.md tier docs", () => {
  it("governor-build.md step 6 documents Tier 1 (unit, scoped), Tier 2 (mock, staging merge), Tier 3 (e2e, manual)", () => {
    const src = readFileSync(join(ROOT, ".rks/prompts/governor-build.md"), "utf8");
    expect(src).toMatch(/Tier 1.*unit/i);
    expect(src).toMatch(/Tier 2.*mock/i);
    expect(src).toMatch(/Tier 3.*e2e/i);
    expect(src).toMatch(/testFiles/);
  });
});

describe("detectTestRunner regression", () => {
  it("still resolves test:unit as first-priority script after package.json update", () => {
    const result = detectTestRunner(ROOT);
    expect(result).toEqual({ cmd: "npm", args: ["run", "test:unit"] });
  });
});
