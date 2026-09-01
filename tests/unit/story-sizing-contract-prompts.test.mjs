/**
 * Witness for backlog.feat.reconcile-story-sizing-po-arch-planner.
 *
 * Static content on the governor prompts that implement the two-axis story-sizing contract
 * (notes/design.story-sizing-contract.md): value coherence decides story BOUNDARIES (PO);
 * plan tractability is resolved at the PLAN level (Planner), never by sibling stories.
 * Full-source toContain on durable phrases — no fixed-window src.slice() pins.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const poSrc = fs.readFileSync(path.resolve(".rks/prompts/governor-po.md"), "utf8");
const archSrc = fs.readFileSync(path.resolve(".rks/prompts/governor-arch.md"), "utf8");

describe("governor-po.md — decompose gating (two-axis contract)", () => {
  it("binds decompose creation to value coherence (not size) and references the contract by name", () => {
    expect(poSrc).toContain("design.story-sizing-contract.md");
    expect(poSrc).toContain("MUST NOT create sibling stories");
    expect(poSrc).toContain("INDEPENDENT-CONCERN break");
  });

  it("states the vertical-slice rule and the anti-horizontal (framework/service/UI) guard", () => {
    expect(poSrc).toContain("VERTICAL value slice");
    expect(poSrc).toMatch(/framework\s*\/\s*service\s*\/\s*UI/);
  });
});

describe("governor-arch.md — vertical-coherence checklist item", () => {
  it("adds a vertical value-coherence checklist item referencing the contract", () => {
    expect(archSrc).toContain("Vertical value coherence");
    expect(archSrc).toContain("design.story-sizing-contract.md");
  });

  it("distinguishes VERTICAL independent-value from the existing HORIZONTAL completeness checks", () => {
    expect(archSrc).toContain("horizontal stack-layer");
    expect(archSrc).toContain("VERTICAL independent-value delivery");
  });
});
