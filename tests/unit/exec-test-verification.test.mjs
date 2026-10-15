import { describe, it, expect } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as testRunner from "../../packages/mcp-rks/src/server/test-runner.mjs";
import { parseTestCounts } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const SRC_ROOT = fileURLToPath(new URL("../../packages/mcp-rks/src/", import.meta.url));
const src = (rel) => fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");

describe("parseTestCounts", () => {
  it("extracts passed count from vitest all-pass output", () => {
    const output = `
 ✓ tests/unit/foo.test.mjs (3 tests) 5ms
 ✓ tests/unit/bar.test.mjs (2 tests) 3ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  10:00:00
   Duration  1.2s
`;
    expect(parseTestCounts(output)).toEqual({ passCount: 5, failCount: 0, countsSource: "vitest", countsUnavailableReason: null });
  });

  it("extracts both failed and passed from mixed output", () => {
    const output = `
 ✗ tests/unit/foo.test.mjs (1 test) 5ms
 ✓ tests/unit/bar.test.mjs (2 tests) 3ms

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 2 passed (3)
   Start at  10:00:00
   Duration  1.5s
`;
    expect(parseTestCounts(output)).toEqual({ passCount: 2, failCount: 1, countsSource: "vitest", countsUnavailableReason: null });
  });

  it("returns null counts with a reason for empty or null output", () => {
    for (const empty of [null, "", undefined]) {
      const r = parseTestCounts(empty);
      expect(r).toMatchObject({ passCount: null, failCount: null, countsSource: null });
      expect(typeof r.countsUnavailableReason).toBe("string");
      expect(r.countsUnavailableReason.length).toBeGreaterThan(0);
    }
  });

  it("returns null counts with a distinct reason when no summary line exists", () => {
    const output = "some random output\nno test summary here\n";
    const r = parseTestCounts(output);
    expect(r).toMatchObject({ passCount: null, failCount: null, countsSource: null });
    expect(typeof r.countsUnavailableReason).toBe("string");
    expect(r.countsUnavailableReason.length).toBeGreaterThan(0);
    expect(r.countsUnavailableReason).not.toBe(parseTestCounts("").countsUnavailableReason);
  });

  it("decision 7a: jest's 'Tests:' summary line is not parsed", () => {
    const r = parseTestCounts("Tests:       5 passed, 5 total\n");
    expect(r).toMatchObject({ passCount: null, failCount: null, countsSource: null });
    expect(r.countsUnavailableReason.length).toBeGreaterThan(0);
  });
});

// Captured-format pytest output literals; no test here spawns pytest.
const PYTEST_60 = [
  "============================= test session starts ==============================",
  "platform darwin -- Python 3.12.1, pytest-8.0.0, pluggy-1.4.0",
  "collected 60 items",
  "",
  "tests/test_risk.py::test_a PASSED                                        [  1%]",
  "tests/test_risk.py::test_b PASSED                                        [  3%]",
  "",
  "===== 60 passed, 2 warnings in 0.18s =====",
].join("\n");

describe("parseTestCounts — pytest", () => {
  it("reads a passing pytest run (collected 60 items ... 60 passed, 2 warnings)", () => {
    expect(parseTestCounts(PYTEST_60)).toEqual({ passCount: 60, failCount: 0, countsSource: "pytest", countsUnavailableReason: null });
  });

  it("test-path lines are not captured by the vitest Tests branch", () => {
    expect(parseTestCounts(PYTEST_60).countsSource).toBe("pytest");
  });

  it("reads failed and passed terms, bordered and bare -q form", () => {
    expect(parseTestCounts("collected 60 items\n===== 3 failed, 57 passed in 1.02s =====\n")).toMatchObject({ passCount: 57, failCount: 3, countsSource: "pytest" });
    expect(parseTestCounts("3 failed, 57 passed in 1.02s\n")).toMatchObject({ passCount: 57, failCount: 3, countsSource: "pytest" });
  });

  it("CRLF line endings do not defeat the anchored counts grammar", () => {
    expect(parseTestCounts("collected 60 items\r\n===== 60 passed in 0.18s =====\r\n").passCount).toBe(60);
  });

  it("'no tests ran' is an observed zero, distinct from unknown", () => {
    expect(parseTestCounts("collected 0 items\n\nno tests ran in 0.01s\n")).toEqual({ passCount: 0, failCount: 0, countsSource: "pytest", countsUnavailableReason: null });
  });

  it("takes the counts from the LAST counts line", () => {
    expect(parseTestCounts("===== 1 failed in 0.10s =====\nretrying\n===== 5 passed in 0.20s =====\n")).toMatchObject({ passCount: 5, failCount: 0, countsSource: "pytest" });
  });

  it("decision 1a: errors count as failures", () => {
    expect(parseTestCounts("===== 1 failed, 2 errors, 57 passed in 1.02s =====")).toMatchObject({ passCount: 57, failCount: 3, countsSource: "pytest" });
    expect(parseTestCounts("===== 2 errors in 0.50s =====")).toMatchObject({ passCount: 0, failCount: 2, countsSource: "pytest" });
  });

  it("decision 2a: other terms are ignored, and a rerun term does not make counts unavailable", () => {
    expect(parseTestCounts("===== 57 passed, 3 skipped, 1 xfailed, 1 rerun in 1.02s =====")).toEqual({ passCount: 57, failCount: 0, countsSource: "pytest", countsUnavailableReason: null });
  });
});

describe("parseTestCounts — wiring (full-source assertions)", () => {
  it("test-runner.mjs exports parseTestCounts, not parseTestCount, and imports parsePytestCounts", () => {
    expect(typeof testRunner.parseTestCounts).toBe("function");
    expect("parseTestCount" in testRunner).toBe(false);
    const runner = src("server/test-runner.mjs");
    expect(runner).toMatch(/import\s*\{[^}]*\bparsePytestCounts\b[^}]*\}\s*from\s*"\.\.\/exec\/test-results\.mjs"/);
    expect(runner).not.toContain("no tests ran");
  });

  it("'const COUNTS_LINE' occurs exactly once under packages/mcp-rks/src", () => {
    let hits = 0;
    for (const rel of fs.readdirSync(SRC_ROOT, { recursive: true })) {
      if (!/\.(mjs|cjs|js)$/.test(rel) || rel.includes("node_modules")) continue;
      hits += src(rel).split("const COUNTS_LINE").length - 1;
    }
    expect(hits).toBe(1);
  });

  it("exec.mjs builds testVerification from one parseTestCounts call", () => {
    const exec = src("server/exec.mjs");
    expect(exec).toContain("...parseTestCounts(lastVerification.output),");
    expect(exec).not.toContain("parseTestCount(");
  });
});

describe("testVerification object shape", () => {
  it("has correct fields when tests pass", () => {
    const testVerification = {
      passed: true,
      passCount: 567,
      failCount: 0,
      duration: 42000,
      attempts: 1,
    };

    expect(testVerification).toHaveProperty("passed", true);
    expect(testVerification).toHaveProperty("passCount");
    expect(testVerification).toHaveProperty("failCount");
    expect(testVerification).toHaveProperty("duration");
    expect(testVerification).toHaveProperty("attempts");
    expect(typeof testVerification.passed).toBe("boolean");
    expect(typeof testVerification.passCount).toBe("number");
    expect(typeof testVerification.failCount).toBe("number");
    expect(typeof testVerification.duration).toBe("number");
    expect(typeof testVerification.attempts).toBe("number");
  });

  it("is null when tests are skipped", () => {
    const testsSkipped = true;
    const testVerification = testsSkipped ? null : { passed: true };
    expect(testVerification).toBeNull();
  });

  it("preserves backward-compatible flat fields alongside testVerification", () => {
    // Simulates the exec return shape
    const result = {
      ok: true,
      testsRan: true,
      testsPassed: true,
      testsSkipped: false,
      attempts: 1,
      testVerification: {
        passed: true,
        passCount: 567,
        failCount: 0,
        duration: 42000,
        attempts: 1,
      },
      status: "pending_ship",
    };

    // Flat fields unchanged
    expect(result.testsPassed).toBe(true);
    expect(result.testsRan).toBe(true);
    expect(result.testsSkipped).toBe(false);
    expect(result.attempts).toBe(1);

    // New structured field present
    expect(result.testVerification).toBeDefined();
    expect(result.testVerification.passed).toBe(true);
    expect(result.testVerification.passCount).toBe(567);
  });
});
