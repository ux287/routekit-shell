import { describe, it, expect } from "vitest";
import { coerceTestRequirements } from "../../packages/mcp-rks/src/server/refine.mjs";

// Robustness fix for the crash: "testRequirements.filter is not a function".
// coerceTestRequirements is the shared helper that guards BOTH refine crash sites:
//   - analyze path:   refine.mjs:219 -> .filter at :232
//   - decompose path: refine.mjs:~1753 (orphanedTests filter)
// A JSON-array STRING testRequirements is the observed corruption shape (root cause:
// testRequirements was missing from dendron ARRAY_FIELDS, so a stringified array
// could be persisted to a note). The `|| []` guards only caught null/undefined, so a
// truthy string slipped through to .filter and threw a TypeError.
describe("coerceTestRequirements — refine crash-fix", () => {
  it("returns an array unchanged (same reference)", () => {
    const arr = ["a", "b"];
    expect(coerceTestRequirements(arr)).toBe(arr);
  });

  it("parses a JSON-array STRING back to an array (the observed corruption shape)", () => {
    const out = coerceTestRequirements('["req one","req two"]');
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["req one", "req two"]);
  });

  it("returns [] for null, undefined, numbers, objects, and non-array strings", () => {
    expect(coerceTestRequirements(null)).toEqual([]);
    expect(coerceTestRequirements(undefined)).toEqual([]);
    expect(coerceTestRequirements(42)).toEqual([]);
    expect(coerceTestRequirements({})).toEqual([]);
    expect(coerceTestRequirements("not json at all")).toEqual([]);
    expect(coerceTestRequirements('{"a":1}')).toEqual([]); // JSON object, not an array
    expect(coerceTestRequirements("[bad json")).toEqual([]); // malformed JSON
  });

  it("output is ALWAYS .filter-able — never throws 'testRequirements.filter is not a function'", () => {
    for (const input of [["x"], '["y"]', "garbage", null, undefined, 7, {}, '{"k":1}']) {
      const out = coerceTestRequirements(input);
      expect(Array.isArray(out)).toBe(true);
      expect(() => out.filter(Boolean)).not.toThrow();
    }
  });

  it("regression: a JSON-STRING testRequirements no longer crashes the .filter used at both refine sites", () => {
    const corrupted = '["- [ ] AC one","- [ ] AC two"]';
    const coerced = coerceTestRequirements(corrupted);
    // analyze-path style (refine.mjs:232): vague-pattern filter over string requirements
    expect(() =>
      coerced.filter((req) => typeof req === "string" && /^add tests?$/i.test(req.trim())),
    ).not.toThrow();
    // decompose-path style (refine.mjs:~1753): token filter over requirements
    expect(() => coerced.filter((req) => String(req || "").length > 0)).not.toThrow();
    expect(coerced).toHaveLength(2);
  });
});
