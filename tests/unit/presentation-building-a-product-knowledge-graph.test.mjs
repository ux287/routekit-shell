/**
 * backlog.feat.presentation-building-a-product-knowledge-graph — AAR demo deck.
 *
 * Source-introspection suite (readFileSync + toContain/toMatch, no React render).
 * Enforces the framing safeguard (neutral cover) and the faithful narrative beats.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK = resolve(
  __dirname,
  '../../packages/telemetry-dashboard/src/presentations/decks/building-a-product-knowledge-graph.deck.tsx'
);
const src = readFileSync(DECK, 'utf8');

// Everything before the Act II reveal — the neutral on-ramp (cover + Act I).
const onramp = src.slice(0, src.indexOf("id: 'what-we-have'"));

describe('building-a-product-knowledge-graph deck — registration + contract', () => {
  it('lives at the auto-discovery path and default-exports a DeckModule', () => {
    expect(DECK.endsWith('/decks/building-a-product-knowledge-graph.deck.tsx')).toBe(true);
    expect(src).toContain('export default deck');
    expect(src).toContain('DeckModule');
  });

  it('declares the slug, a title, an audience, and slides', () => {
    expect(src).toContain("slug: 'building-a-product-knowledge-graph'");
    expect(src).toContain("title: 'Building a Product Knowledge Graph'");
    expect(src).toContain('audience:');
    expect(src).toContain('slides:');
  });
});

describe('building-a-product-knowledge-graph deck — cover neutrality (framing safeguard)', () => {
  it('the neutral title/cover names neither the product nor "AI"', () => {
    // The deck title metadata is neutral.
    expect(src).toMatch(/title: 'Building a Product Knowledge Graph'/);
    // The on-ramp (cover + Act I, up to the reveal) never names the product "rks"
    // or the token "AI". Both use word boundaries so incidental substrings
    // (e.g. "marks", "works", "again") don't trip the framing safeguard.
    expect(onramp).not.toMatch(/\brks\b/i);
    expect(onramp).not.toMatch(/\bAI\b/);
  });

  it('the cover renders no product/brand marks (no shield, no badge)', () => {
    expect(src).not.toContain('Us287Shield');
    expect(src).not.toContain('Badge');
  });
});

describe('building-a-product-knowledge-graph deck — terminology + narrative beats', () => {
  it('uses "state machine", never "phase machine", and never MIT', () => {
    expect(src).toContain('state machine');
    expect(src.toLowerCase()).not.toContain('phase machine');
    expect(src).not.toContain('MIT');
  });

  it('renders the actual origin-story beats (faithful to the outline)', () => {
    for (const beat of [
      'Figma Make',
      'Inspection Queue',
      'RFD',
      'SQLite',
      'What if I prototyped this feature?',
      'knowledge graph',
      'opinionated',
      'Vince',
      'Git',
    ]) {
      expect(src).toContain(beat);
    }
  });
});

describe('building-a-product-knowledge-graph deck — visuals + close + hygiene', () => {
  it('uses two-column hero visuals from the kit', () => {
    expect(src).toContain('visual:');
    const used = ['StateLineSketch', 'PipelineGateSketch', 'TierStackSketch', 'StatCards', 'QuoteGrid'].filter((c) =>
      src.includes(c)
    );
    expect(used.length).toBeGreaterThanOrEqual(3);
  });

  it('closes on a demo hand-off into the prototype', () => {
    expect(src).toContain('prototype');
  });

  it('imports only the presentations kit and no third-party design system', () => {
    expect(src).toContain('../ui/primitives');
    expect(src).toContain('../ui/diagrams');
    expect(src).toContain('../types');
    expect(src.toLowerCase()).not.toContain('airvoyant');
    expect(src.toLowerCase()).not.toContain('snacks');
  });
});
