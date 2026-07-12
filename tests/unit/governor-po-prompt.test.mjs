/**
 * Tests for governor-po-prompt — verifies that the PO Governor prompt
 * contains the full set of decomposition rules as directives.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function readSource(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("governor-po.md — Decomposition Rules section", () => {
  const src = readSource(".rks/prompts/governor-po.md");

  it("contains a ## Decomposition Rules section", () => {
    expect(src).toMatch(/^## Decomposition Rules/m);
  });

  it("Decomposition Rules section appears before ## Chain", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    expect(decompIdx).toBeGreaterThan(-1);
    expect(chainIdx).toBeGreaterThan(-1);
    expect(decompIdx).toBeLessThan(chainIdx);
  });

  it("contains semantic naming directive with MUST language", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/Semantic naming/i);
    expect(section).toMatch(/MUST/);
    expect(section).toMatch(/sub-feature|form-shell|sqlite-write/i);
  });

  it("semantic naming directive explicitly rejects ordinal names (child-1/2/3)", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/child-1|child-2|child-N|ordinal/i);
  });

  it("contains independent value directive", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/Independent value/i);
    expect(section).toMatch(/MUST/);
    expect(section).toMatch(/if this.*shipped alone|independently/i);
  });

  it("contains complete test coverage directive with MUST language", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/test coverage/i);
    expect(section).toMatch(/MUST/);
    expect(section).toMatch(/sibling|defer/i);
  });

  it("contains stale snapshot hazard directive with MUST NOT language", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/[Ss]tale.*snapshot|snapshot.*hazard/i);
    expect(section).toMatch(/MUST NOT/);
  });

  it("stale snapshot directive names the specific hazard (second child overwrites first)", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/second child|overwrite|destructive/i);
  });

  it("contains dependency ordering directive with MUST language", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    expect(section).toMatch(/[Dd]ependency ordering/i);
    expect(section).toMatch(/MUST/);
    expect(section).toMatch(/build.first|build-first|dependency order/i);
  });

  it("uses MUST and MUST NOT language throughout (not suggestions)", () => {
    const decompIdx = src.indexOf("## Decomposition Rules");
    const chainIdx = src.indexOf("## Chain");
    const section = src.slice(decompIdx, chainIdx);
    const mustCount = (section.match(/\bMUST\b/g) || []).length;
    expect(mustCount).toBeGreaterThanOrEqual(4);
  });
});
