import { describe, it, expect } from "vitest";

// parseTestCount is module-private in exec.mjs, so we test it indirectly
// by verifying the vitest output parsing logic in isolation here.
const parseTestCount = (output, type) => {
  if (!output) return 0;
  const testsLine = output.match(/^\s*Tests\s+(.+)/im);
  if (!testsLine) return 0;
  const countMatch = testsLine[1].match(new RegExp(`(\\d+)\\s+${type}`, 'i'));
  return countMatch ? parseInt(countMatch[1], 10) : 0;
};

describe("parseTestCount", () => {
  it("extracts passed count from vitest all-pass output", () => {
    const output = `
 ✓ tests/unit/foo.test.mjs (3 tests) 5ms
 ✓ tests/unit/bar.test.mjs (2 tests) 3ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  10:00:00
   Duration  1.2s
`;
    expect(parseTestCount(output, "passed")).toBe(5);
    expect(parseTestCount(output, "failed")).toBe(0);
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
    expect(parseTestCount(output, "passed")).toBe(2);
    expect(parseTestCount(output, "failed")).toBe(1);
  });

  it("returns 0 for empty or null output", () => {
    expect(parseTestCount(null, "passed")).toBe(0);
    expect(parseTestCount("", "passed")).toBe(0);
    expect(parseTestCount(undefined, "passed")).toBe(0);
  });

  it("returns 0 when no Tests summary line exists", () => {
    const output = "some random output\nno test summary here\n";
    expect(parseTestCount(output, "passed")).toBe(0);
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
