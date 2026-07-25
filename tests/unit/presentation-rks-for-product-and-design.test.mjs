/**
 * backlog.feat.presentation-rks-for-product-and-design — the product/design deck.
 *
 * Source-introspection suite (readFileSync + toContain/toMatch, no React render,
 * no runtime import), modeled on presentation-what-is-rks.test.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECK = resolve(
  __dirname,
  '../../packages/telemetry-dashboard/src/presentations/decks/rks-for-product-and-design.deck.tsx'
);
const src = readFileSync(DECK, 'utf8');

describe('rks-for-product-and-design deck — registration + contract', () => {
  it('lives at the auto-discovery path and default-exports a DeckModule', () => {
    expect(DECK.endsWith('/decks/rks-for-product-and-design.deck.tsx')).toBe(true);
    expect(src).toContain('export default deck');
    expect(src).toContain('DeckModule');
  });

  it('declares the slug, title, a product/design audience, and slides', () => {
    expect(src).toContain("slug: 'rks-for-product-and-design'");
    expect(src).toContain('rks for Product & Design');
    expect(src).toContain('audience:');
    expect(src).toMatch(/product|design/i);
    expect(src).toContain('slides:');
  });
});

describe('rks-for-product-and-design deck — hero + guards', () => {
  it('renders a two-tone hero headline in the #3b82f6 accent', () => {
    expect(src).toContain('TwoToneHeadline');
    expect(src).toContain('#3b82f6');
  });

  it('carries the model-economics beat', () => {
    expect(src).toContain('the fallback, not the default.');
    expect(src).toMatch(/retr(y|ies)/i);
    expect(src).toMatch(/resum/i);
    expect(src).toMatch(/cach/i);
  });

  it('never says "phase machine" (case-insensitive) and does use "state machine"', () => {
    expect(src.toLowerCase()).not.toContain('phase machine');
    expect(src).toContain('state machine');
  });

  it('badges AGPL-3.0 and never MIT', () => {
    expect(src).toContain('AGPL-3.0');
    expect(src).not.toContain('MIT');
  });
});

describe('rks-for-product-and-design deck — two-column hero visuals', () => {
  it('uses the SlideSpec visual slot for two-column hero slides', () => {
    expect(src).toContain('visual:');
  });

  it('composes hero illustrations / kit primitives from ui/diagrams', () => {
    // at least some of the shipped hero illustrations + kit
    const used = ['StateLineSketch', 'GuardrailsRoadSketch', 'StatCards', 'QuoteGrid'].filter((c) =>
      src.includes(c)
    );
    expect(used.length).toBeGreaterThanOrEqual(2);
  });
});

describe('rks-for-product-and-design deck — import hygiene + leave-behinds', () => {
  it('imports only the presentations kit (ui/* + types), not the airvoyant/Snacks system', () => {
    expect(src).toContain('../ui/primitives');
    expect(src).toContain('../ui/diagrams');
    expect(src).toContain('../types');
    expect(src.toLowerCase()).not.toContain('airvoyant');
    expect(src.toLowerCase()).not.toContain('snacks');
  });

  it('links the §D leave-behind and the verbatim close-slide copy', () => {
    expect(src).toContain('blog.2026.07.01.rks-for-product-and-design');
    expect(src).toContain(
      "Want to really nerd out? Start with 'The Current Architecture' (ux287.com/thinking), then follow the workflow and token-economy deep dives."
    );
  });
});
