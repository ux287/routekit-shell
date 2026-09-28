import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProjectTests } from "../../packages/mcp-rks/src/exec/command-runner.mjs";
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
  return { status: exitCode, signal: null, stdout: "✓ tests passed\n", stderr: "" };
}

describe("runProjectTests — scoped testPaths routes through vitest-runner.mjs", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    spawnSync.mockReturnValue(makeSpawnResult(0));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses node (not npx) as the command for scoped runs", () => {
    runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(spawnSync.mock.calls[0][0]).toBe("node");
  });

  it("passes scripts/vitest-runner.mjs as the first arg for scoped runs", () => {
    runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(spawnSync.mock.calls[0][1][0]).toBe("scripts/vitest-runner.mjs");
  });

  it("includes --config vitest.config.unit.mjs in scoped run args", () => {
    runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    const args = spawnSync.mock.calls[0][1];
    const configIdx = args.indexOf("--config");
    expect(configIdx).toBeGreaterThan(-1);
    expect(args[configIdx + 1]).toBe("vitest.config.unit.mjs");
  });

  it("appends test paths as positional args after the config flag", () => {
    const paths = ["tests/unit/foo.test.mjs", "tests/unit/bar.test.mjs"];
    runProjectTests(ROOT, { testPaths: paths });
    const args = spawnSync.mock.calls[0][1];
    expect(args).toContain("tests/unit/foo.test.mjs");
    expect(args).toContain("tests/unit/bar.test.mjs");
  });

  it("full scoped invocation is: node scripts/vitest-runner.mjs --config vitest.config.unit.mjs <paths>", () => {
    const paths = ["tests/unit/foo.test.mjs"];
    runProjectTests(ROOT, { testPaths: paths });
    expect(spawnSync).toHaveBeenCalledWith(
      "node",
      ["scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", "295000", ...paths],
      expect.any(Object)
    );
  });

  it("returns passed: true when vitest-runner exits 0", () => {
    const result = runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(result.passed).toBe(true);
  });
});
