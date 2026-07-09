/**
 * Witness for backlog.chore.onboarder-copy-fixes.
 *
 * Static-content assertions on the hardcoded onboarder copy (packages/mcp-rks/src/server/onboarder.mjs):
 *  - the confusing "Software dev is where the current tooling lives." framing sentence is removed
 *  - the PO stance no longer claims "thirty seconds" or a specific token count; it states a realistic range
 *  - durable surrounding anchors are retained so the copy still flows
 * Full-source toContain / not.toContain on durable phrases — no fixed-size slices, no brittle pinning.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.resolve("packages/mcp-rks/src/server/onboarder.mjs"),
  "utf8"
);

describe("onboarder copy fixes — Stage 2 framing sentence", () => {
  it("removes 'Software dev is where the current tooling lives.'", () => {
    expect(src).not.toContain("Software dev is where the current tooling lives.");
  });

  it("keeps the surrounding Stage 2 copy so it still flows", () => {
    expect(src).toContain("research workflows, document automation, data pipelines.");
    expect(src).toContain("If you've worked in any domain where an AI agent ran off-script");
  });
});

describe("onboarder copy fixes — PO timing/token claim", () => {
  it("no longer states 'thirty seconds' or a specific token count", () => {
    expect(src).not.toContain("thirty seconds");
    expect(src).not.toContain("few hundred tokens");
    // no bare "<N> tokens" quantifier left in the Product Owner Governor stance sentence
    expect(src).not.toMatch(/Product Owner Governor[\s\S]{0,200}\d+\s+tokens/);
  });

  it("states a realistic range and keeps the durable stance anchors", () => {
    expect(src).toContain("Writing a quick story is cheap.");
    expect(src).toContain("We'll do exactly that in Stage 4.");
    expect(src).toContain("a minute or two");
    expect(src).toContain("multiple stories");
  });
});
