/**
 * backlog.feat.presentation-how-rks-works — "How does RouteKit-shell work?" deck.
 *
 * Source-introspection suite (readFileSync + toContain/toMatch, no React render,
 * no runtime import of the deck module) matching the project's dashboard test
 * convention. Asserts registration, the mapped diagram primitives, the
 * higher-altitude substitutions (plan→review→exec→ship arc, redirect motif),
 * the state-machine track, the terminology + license guards, the leave-behinds,
 * and the three-act arc.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK = resolve(
  __dirname,
  "../../packages/telemetry-dashboard/src/presentations/decks/how-rks-works.deck.tsx"
);
const src = readFileSync(DECK, "utf8");

describe("how-rks-works deck — registration + contract", () => {
  it("lives at the auto-discovery path and default-exports a DeckModule", () => {
    expect(DECK.endsWith("/decks/how-rks-works.deck.tsx")).toBe(true);
    expect(src).toContain("export default deck");
    expect(src).toContain("DeckModule");
  });

  it("declares slug 'how-rks-works', the title, a mechanism/practitioner audience, and slides", () => {
    expect(src).toContain("slug: 'how-rks-works'");
    expect(src).toContain("How does RouteKit-shell work?");
    expect(src).toContain("audience:");
    expect(src).toMatch(/mechanism|practitioner/i);
    expect(src).toContain("slides:");
  });
});

describe("how-rks-works deck — mapped primitives", () => {
  it("the pipeline spine is a PipelineGateSketch (PO → QA → ARCH → Build → Ship); Build keeps its FlowDiagram", () => {
    expect(src).toContain("PipelineGateSketch");
    for (const node of ["PO", "QA", "ARCH", "Build", "Ship"]) expect(src).toContain(node);
    expect(src).toContain("FlowDiagram"); // the Build slide's plan → review → exec → ship arc
  });

  it("on-rail / off-rail uses the GuardrailsRoadSketch illustration", () => {
    expect(src).toContain("GuardrailsRoadSketch");
    expect(src).toContain("On-rail");
    expect(src).toContain("Off-rail");
  });

  it("slide 13 uses StatCards for telemetry / cost / CI", () => {
    expect(src).toContain("StatCards");
    expect(src).toContain("/ci");
  });
});

describe("how-rks-works deck — higher-altitude substitutions", () => {
  it("slide 8 (Build) collapses to plan → review → exec → ship with self-heal (no 6-step chain)", () => {
    for (const step of ["plan", "review", "exec", "ship"]) expect(src).toContain(step);
    expect(src).toContain("self-heal");
    expect(src).not.toContain("init → refine → research");
  });

  it("slide 11 renders an inline redirect / bounce / deflect motif", () => {
    expect(src).toContain("RedirectMotif");
    expect(src).toContain("redirect");
    expect(src).toContain("bounce");
    expect(src).toContain("deflect");
  });
});

describe("how-rks-works deck — state machine track", () => {
  it("the state machine uses StateLineSketch, labelled 'state machine', with the full state set + (committed) branch", () => {
    expect(src).toContain("StateLineSketch");
    expect(src).toContain("state machine");
    for (const state of [
      "draft",
      "ready",
      "arch-approved",
      "executing",
      "executed",
      "integrated",
      "released",
    ]) {
      expect(src).toContain(state);
    }
    expect(src).toContain("committed");
  });
});

describe("how-rks-works deck — terminology + license guards", () => {
  it("carries the model-economics beat", () => {
    expect(src).toContain("the fallback, not the default.");
    expect(src).toMatch(/retr(y|ies)/i);
    expect(src).toMatch(/resum/i);
    expect(src).toMatch(/cach/i);
  });

  it("never says 'phase machine' (case-insensitive)", () => {
    expect(src.toLowerCase()).not.toContain("phase machine");
  });

  it("badges AGPL-3.0 and never MIT", () => {
    expect(src).toContain("AGPL-3.0");
    expect(src).not.toContain("MIT");
  });
});

describe("how-rks-works deck — leave-behinds + close", () => {
  it("links the §D deep-dive leave-behinds (blog + research)", () => {
    expect(src).toContain("blog.2026.02.21.rks-agentified-workflow-deep-dive");
    expect(src).toContain("blog.2026.05.09.rks-deep-dive-release-ready");
    expect(src).toContain("research.2026.04.29.governor-observability-and-token-economy");
    expect(src).toContain("research.2026.06.30.rks-deep-dive-refresh-content-source");
  });

  it("includes the verbatim close-slide copy", () => {
    expect(src).toContain(
      "Want to really nerd out? Start with 'The Current Architecture' (ux287.com/thinking), then follow the workflow and token-economy deep dives."
    );
  });
});

describe("how-rks-works deck — import hygiene + three-act arc", () => {
  it("imports only from the presentations kit (ui/* + types), not the airvoyant/Snacks system", () => {
    expect(src).toContain("../ui/primitives");
    expect(src).toContain("../ui/diagrams");
    expect(src).toContain("../types");
    expect(src.toLowerCase()).not.toContain("airvoyant");
    expect(src.toLowerCase()).not.toContain("snacks");
  });

  it("spans the loop → pipeline → guarantees arc", () => {
    expect(src).toContain("The loop end-to-end");
    expect(src).toContain("The pipeline mechanism");
    expect(src).toContain("The guarantees underneath");
  });
});
