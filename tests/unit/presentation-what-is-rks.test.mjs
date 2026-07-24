/**
 * backlog.feat.presentation-what-is-rks — "What is RouteKit-shell?" deck.
 *
 * Source-introspection suite (readFileSync + toContain/toMatch, no React render,
 * no runtime import of the deck module) matching the project's dashboard test
 * convention. Asserts registration, the verbatim hero line + two-tone accent,
 * the terminology + license guards, the mapped diagram primitives, the
 * leave-behind links, and the three-act arc.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK = resolve(
  __dirname,
  "../../packages/telemetry-dashboard/src/presentations/decks/what-is-rks.deck.tsx"
);
const src = readFileSync(DECK, "utf8");

describe("what-is-rks deck — registration + contract", () => {
  it("lives at the auto-discovery path and default-exports a DeckModule", () => {
    expect(DECK.endsWith("/decks/what-is-rks.deck.tsx")).toBe(true);
    expect(src).toContain("export default deck");
    expect(src).toContain("DeckModule");
  });

  it("declares slug 'what-is-rks', the title, a newcomer/evaluator audience, and slides", () => {
    expect(src).toContain("slug: 'what-is-rks'");
    expect(src).toContain("What is RouteKit-shell?");
    expect(src).toContain("audience:");
    expect(src).toMatch(/newcomer|evaluator/i);
    expect(src).toContain("slides:");
  });
});

describe("what-is-rks deck — hero line + two-tone accent", () => {
  it("contains the exact hero line verbatim", () => {
    expect(src).toContain("We don't need more AI, we need skills and governance.");
  });

  it("renders 'skills and governance' via TwoToneHeadline in the #3b82f6 accent", () => {
    expect(src).toContain("TwoToneHeadline");
    expect(src).toContain("skills and governance");
    expect(src).toContain("#3b82f6");
  });
});

describe("what-is-rks deck — terminology + license guards", () => {
  it("never says 'phase machine' (case-insensitive)", () => {
    expect(src.toLowerCase()).not.toContain("phase machine");
  });

  it("badges AGPL-3.0 and never MIT", () => {
    expect(src).toContain("AGPL-3.0");
    expect(src).not.toContain("MIT");
  });
});

describe("what-is-rks deck — mapped primitives", () => {
  it("slide 2 uses QuoteGrid with the exact tension quote", () => {
    expect(src).toContain("QuoteGrid");
    expect(src).toContain("Capability isn't the gap. Confidence without correctness is.");
  });

  it("slide 3 builds an inline before/after split from Card (ungoverned vs governed)", () => {
    expect(src).toContain("Card");
    expect(src).toContain("Ungoverned");
    expect(src).toContain("Governed");
  });

  it("uses the hero sketch illustrations (loop, tiers, pipeline, guardrails, state) + StatCards", () => {
    for (const primitive of [
      "LoopSketch",
      "TierStackSketch",
      "PipelineGateSketch",
      "GuardrailsRoadSketch",
      "StateLineSketch",
      "StatCards",
    ]) {
      expect(src).toContain(primitive);
    }
  });
});

describe("what-is-rks deck — leave-behinds + close", () => {
  it("links the §D deep-dive leave-behinds", () => {
    expect(src).toContain("blog.2026.05.09.rks-deep-dive-release-ready");
    expect(src).toContain("research.2026.04.29.governor-observability-and-token-economy");
  });

  it("includes the verbatim close-slide copy", () => {
    expect(src).toContain(
      "Want to really nerd out? Start with 'The Current Architecture' (ux287.com/thinking), then follow the workflow and token-economy deep dives."
    );
  });
});

describe("what-is-rks deck — import hygiene + three-act arc", () => {
  it("imports only from the presentations kit (ui/* + types), not the airvoyant/Snacks system", () => {
    expect(src).toContain("../ui/primitives");
    expect(src).toContain("../ui/diagrams");
    expect(src).toContain("../types");
    expect(src.toLowerCase()).not.toContain("airvoyant");
    expect(src.toLowerCase()).not.toContain("snacks");
  });

  it("spans the Situation → Model → Moving Forward arc", () => {
    expect(src).toContain("Situation");
    expect(src).toContain("The Model");
    expect(src).toContain("Moving Forward");
  });
});
