/**
 * Source-based tests for build-governor-semantic-slugs — verifies that
 * governor-build.md contains explicit data.children slug instruction with
 * MUST language and example semantic names.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const src = fs.readFileSync(path.join(ROOT, ".rks/prompts/governor-build.md"), "utf8");

describe("governor-build.md — decompose data.children slug instruction", () => {
  it("contains explicit instruction that rks_refine_apply MUST include a data.children array", () => {
    expect(src).toMatch(/data\.children/);
    expect(src).toMatch(/MUST/);
  });

  it("states each data.children entry MUST have a slug field", () => {
    expect(src).toMatch(/slug/);
    // Both MUST and slug should appear in the decompose call shape section
    const decomposeIdx = src.indexOf("## Decompose Call Shape");
    expect(decomposeIdx).toBeGreaterThan(-1);
    const section = src.slice(decomposeIdx, decomposeIdx + 1500);
    expect(section).toMatch(/MUST/);
    expect(section).toMatch(/slug/);
  });

  it("explicitly prohibits ordinal names (child-1, child-2, etc.)", () => {
    expect(src).toMatch(/FORBIDDEN|prohibited|not.*ordinal|ordinal.*not/i);
    expect(src).toMatch(/child-1|child-2/);
  });

  it("includes a concrete example call shape showing semantic slug values", () => {
    // The example should have at least one semantic slug that doesn't match child-N
    const exampleMatch = src.match(/slug:\s*["']?([a-z][a-z0-9-]+)["']?/g);
    expect(exampleMatch).not.toBeNull();
    const nonOrdinal = exampleMatch.filter(m => !m.match(/child-\d+/));
    expect(nonOrdinal.length).toBeGreaterThan(0);
  });

  it("example includes semantic slug names not matching the child-N ordinal pattern", () => {
    // Look for example slugs like form-shell, sqlite-write, manage-wire
    const ordinalPattern = /^slug:\s*["']?child-\d+/;
    const semanticPattern = /slug.*[a-z]+-[a-z]+/;
    expect(src).toMatch(semanticPattern);
    // The example section should NOT have only ordinal slugs
    const decomposeIdx = src.indexOf("## Decompose Call Shape");
    const section = src.slice(decomposeIdx, decomposeIdx + 1500);
    const slugMatches = section.match(/slug: "([^"]+)"/g) || [];
    const hasNonOrdinal = slugMatches.some(m => !ordinalPattern.test(m));
    expect(hasNonOrdinal).toBe(true);
  });
});
