/**
 * backlog.feat.routekit-dashboard-nav-shell — shell + presentations framework.
 *
 * Source-introspection suite (readFileSync + toContain/index checks, no React
 * render) matching the project's dashboard test convention. Covers the rebrand,
 * the extensible nav, HashRouter wiring, the TelemetryPage extraction, the
 * presentations framework (registry auto-discovery, index, deck renderer,
 * viewer), the ux287 visual + diagram primitives, the tailwind/globals tokens,
 * and the two repointed regression tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DASH = resolve(ROOT, "packages/telemetry-dashboard");
const read = (p) => readFileSync(resolve(DASH, p), "utf8");
const readRoot = (p) => readFileSync(resolve(ROOT, p), "utf8");

describe("rebrand → Routekit Dashboard", () => {
  it("Header.tsx brands 'Routekit Dashboard' and drops the old 'Telemetry Reporting'", () => {
    const src = read("src/components/layout/Header.tsx");
    expect(src).toContain("Routekit Dashboard");
    expect(src).not.toContain("Telemetry Reporting");
  });

  it("index.html <title> reads 'Routekit Dashboard'", () => {
    const src = read("index.html");
    expect(src).toContain("<title>Routekit Dashboard</title>");
    expect(src).not.toContain("Telemetry Reporting");
    expect(src).not.toContain("<title>Telemetry Dashboard</title>");
  });
});

describe("extensible top-level nav", () => {
  it("navSections.ts exports an {id,label,path,icon} array seeding Telemetry + Presentations", () => {
    const src = read("src/nav/navSections.ts");
    expect(src).toContain("export const navSections");
    for (const key of ["id", "label", "path", "icon"]) expect(src).toContain(key);
    expect(src).toContain("Telemetry");
    expect(src).toContain("Presentations");
    expect(src).toContain("/presentations");
  });

  it("TopNav renders by mapping the registry (not hardcoded) with active-route styling", () => {
    const src = read("src/components/layout/TopNav.tsx");
    expect(src).toContain("navSections.map");
    expect(src).toContain("NavLink");
    expect(src).toContain("isActive");
  });
});

describe("App.tsx is the router root", () => {
  const src = read("src/App.tsx");

  it("imports HashRouter from react-router-dom and defines the three routes", () => {
    expect(src).toContain("react-router-dom");
    expect(src).toContain("HashRouter");
    expect(src).toContain('path="/"');
    expect(src).toContain('path="/presentations"');
    expect(src).toContain('path="/presentations/:deckSlug"');
  });

  it("still wraps the tree in QueryClientProvider + FilterProvider", () => {
    expect(src).toContain("QueryClientProvider");
    expect(src).toContain("FilterProvider");
  });

  it("no longer composes the telemetry sections inline (they moved to TelemetryPage)", () => {
    expect(src).not.toContain("GuardrailBumps");
    expect(src).not.toContain("StoryActivityTable");
    expect(src).not.toContain("TokenCostSection");
  });
});

describe("TelemetryPage.tsx (extracted verbatim)", () => {
  const src = read("src/pages/TelemetryPage.tsx");

  it("composes the telemetry sections", () => {
    for (const c of [
      "FilterBar",
      "GuardrailBumps",
      "DashboardMetrics",
      "EventTimeline",
      "StoryActivityTable",
      "TokenCostSection",
    ]) {
      expect(src).toContain(c);
    }
  });

  it("preserves StoryActivityTable → TokenCostSection ordering", () => {
    expect(src.indexOf("TokenCostSection")).toBeGreaterThan(src.indexOf("StoryActivityTable"));
  });
});

describe("presentations framework", () => {
  it("types.ts defines the DeckModule + SlideSpec contract", () => {
    const src = read("src/presentations/types.ts");
    expect(src).toContain("interface DeckModule");
    expect(src).toContain("interface SlideSpec");
    for (const f of ["slug", "title", "audience", "slides"]) expect(src).toContain(f);
  });

  it("registry.ts auto-discovers decks via import.meta.glob('./decks/*.deck.tsx', { eager: true })", () => {
    const src = read("src/presentations/registry.ts");
    expect(src).toContain("import.meta.glob('./decks/*.deck.tsx', { eager: true })");
    expect(src).toContain("export const decks");
    expect(src).toContain("getDeck");
  });

  it("PresentationsIndex lists decks as cards with an empty state and deck links", () => {
    const src = read("src/presentations/PresentationsIndex.tsx");
    expect(src).toContain("decks.map");
    expect(src).toContain("decks.length === 0");
    expect(src).toContain("/presentations/${deck.slug}");
  });

  it("Deck renderer has keyboard + prev/next nav and a counter/progress footer", () => {
    const src = read("src/presentations/Deck.tsx");
    expect(src).toContain("ArrowLeft");
    expect(src).toContain("ArrowRight");
    expect(src).toContain("keydown");
    expect(src).toContain("{index + 1} / {total}");
    expect(src).toContain("Prev");
    expect(src).toContain("Next");
  });

  it("DeckViewer looks the deck up by slug, renders <Deck>, and 404s when missing", () => {
    const src = read("src/presentations/DeckViewer.tsx");
    expect(src).toContain("useParams");
    expect(src).toContain("getDeck");
    expect(src).toContain("<Deck");
    expect(src).toContain("404");
  });
});

describe("ux287 visual kit", () => {
  it("primitives.tsx exports the kit, uses the accent, and avoids airvoyant/Snacks", () => {
    const src = read("src/presentations/ui/primitives.tsx");
    for (const c of [
      "HeroSection",
      "TwoToneHeadline",
      "Eyebrow",
      "Badge",
      "Pill",
      "Card",
      "IconSquare",
      "Button",
      "Us287Shield",
    ]) {
      expect(src).toContain(c);
    }
    expect(src).toContain("'primary'");
    expect(src).toContain("'ghost'");
    expect(src).toContain("accent");
    expect(src.toLowerCase()).not.toContain("airvoyant");
    expect(src.toLowerCase()).not.toContain("snacks");
  });

  it("diagrams.tsx exports the diagram primitives and labels the state track 'state machine'", () => {
    const src = read("src/presentations/ui/diagrams.tsx");
    for (const c of [
      "FlowDiagram",
      "AltitudeStack",
      "ForkDiagram",
      "LoopDiagram",
      "StateTrack",
      "StatCards",
      "QuoteGrid",
    ]) {
      expect(src).toContain(c);
    }
    expect(src).toContain("state machine");
    expect(src).not.toContain("phase machine");
  });
});

describe("design tokens", () => {
  it("tailwind.config.js adds the #3b82f6 accent + dark-hero tokens and keeps the indigo brand", () => {
    const src = read("tailwind.config.js");
    expect(src).toContain("#3b82f6");
    expect(src).toContain("accent");
    expect(src).toContain("hero");
    expect(src).toContain("brand");
    expect(src).toContain("#6366f1"); // indigo brand-500 retained
  });

  it("globals.css adds the hero-gradient / two-tone headline utilities", () => {
    const src = read("src/styles/globals.css");
    expect(src).toContain("hero-gradient-dark");
    expect(src).toContain("hero-gradient-blue");
    expect(src).toContain("headline-two-tone");
  });
});

describe("sketch visual language", () => {
  it("Deck.tsx injects the hand-drawn roughen filter + blueprint grid", () => {
    const src = read("src/presentations/Deck.tsx");
    expect(src).toContain("feTurbulence");
    expect(src).toContain("feDisplacementMap");
    expect(src).toContain("rks-sketch");
    expect(src).toContain("sketch-grid");
  });

  it("globals.css defines the sketch treatment (roughen + desaturate + fade) and blueprint grid", () => {
    const src = read("src/styles/globals.css");
    expect(src).toContain("sketch-diagram");
    expect(src).toMatch(/filter:\s*url\(#rks-sketch\)/);
    expect(src).toMatch(/saturate\(/);
    expect(src).toMatch(/opacity:/);
    expect(src).toContain("sketch-grid");
  });

  it("diagrams.tsx applies the sketch treatment to the drawing primitives (not stat/quote cards)", () => {
    const src = read("src/presentations/ui/diagrams.tsx");
    expect(src).toContain("sketch-diagram");
  });
});

describe("regression tests repointed to TelemetryPage.tsx", () => {
  it("dashboard-token-costs.test.mjs follows the ordering assertion into TelemetryPage.tsx", () => {
    const src = readRoot("tests/unit/dashboard-token-costs.test.mjs");
    expect(src).toContain("pages/TelemetryPage.tsx");
    expect(src).toContain("indexOf");
  });

  it("dashboard-guardrail-events.test.mjs reads GuardrailBumps from TelemetryPage.tsx", () => {
    const src = readRoot("tests/unit/dashboard-guardrail-events.test.mjs");
    expect(src).toContain("src/pages/TelemetryPage.tsx");
    expect(src).toContain("<GuardrailBumps />");
  });
});
