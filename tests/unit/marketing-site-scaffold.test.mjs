/**
 * backlog.feat.marketing-site-spa-scaffold — marketing site (channel #1) scaffold.
 *
 * Source-introspection suite (readFileSync + toContain/toMatch, no React render,
 * no runtime import). Modeled on tests/unit/presentation-what-is-rks.test.mjs.
 * The publish-exclusion and lockfile-drift guards live in their own existing
 * tests and are intentionally NOT duplicated here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SITE = resolve(ROOT, 'packages/marketing-site');

const read = (rel) => readFileSync(resolve(SITE, rel), 'utf8');

// The full SPA source, concatenated — for the cross-source terminology,
// license, and design-system hygiene guards.
const SOURCE_FILES = [
  'package.json',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tailwind.config.js',
  'postcss.config.js',
  'src/main.tsx',
  'src/App.tsx',
  'src/styles/globals.css',
  'src/components/ui.tsx',
  'src/components/Hero.tsx',
  'src/components/WhatIsRks.tsx',
  'src/components/HowItWorks.tsx',
  'src/components/ModelEconomics.tsx',
  'src/components/Proof.tsx',
  'src/components/DeepDives.tsx',
  'src/components/Footer.tsx',
];
const allSource = SOURCE_FILES.map(read).join('\n');

describe('marketing-site scaffold — package + workspace', () => {
  it('package.json is a valid @routekit/marketing-site module with vite dev/build scripts and react deps', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.name).toBe('@routekit/marketing-site');
    expect(pkg.type).toBe('module');
    expect(pkg.scripts.dev).toMatch(/vite/);
    expect(pkg.scripts.build).toMatch(/vite/);
    expect(pkg.dependencies).toHaveProperty('react');
    expect(pkg.dependencies).toHaveProperty('react-dom');
  });

  it('the root workspaces glob still discovers packages/* (root package.json left unedited)', () => {
    const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const workspaces = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : rootPkg.workspaces?.packages ?? [];
    expect(workspaces).toContain('packages/*');
  });
});

describe('marketing-site scaffold — composition + hero', () => {
  it('App composes the six sections in narrative order', () => {
    const app = read('src/App.tsx');
    const order = ['Hero', 'WhatIsRks', 'HowItWorks', 'Proof', 'DeepDives', 'Footer'];
    for (const s of order) expect(app).toContain(s);
    const positions = order.map((s) => app.indexOf(`<${s} />`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('the model-economics pane is composed between HowItWorks and Proof', () => {
    const app = read('src/App.tsx');
    const at = app.indexOf('<ModelEconomics />');
    expect(at).toBeGreaterThan(app.indexOf('<HowItWorks />'));
    expect(at).toBeLessThan(app.indexOf('<Proof />'));
  });

  it('the model-economics pane carries its copy and snaps like its siblings', () => {
    const me = read('src/components/ModelEconomics.tsx');
    expect(me).toContain('Model economics');
    expect(me).toContain('Your best model is the fallback, not the default.');
    expect(me).toContain('Every agent starts small.');
    // Uses the shared Section wrapper, so it inherits the full-viewport snap layout.
    expect(me).toContain('<Section');
  });

  it('Hero renders the verbatim two-tone thesis line', () => {
    expect(read('src/components/Hero.tsx')).toContain(
      "We don't need more AI, we need skills and governance."
    );
  });

  it('Hero has a prominent GitHub repo CTA (href to github.com)', () => {
    const hero = read('src/components/Hero.tsx');
    expect(hero).toMatch(/https?:\/\/github\.com\//);
  });

  it('loads the Plausible analytics snippet inside <head>', () => {
    const html = read('index.html');
    expect(html).toContain('https://plausible.io/js/pa-l4bjtXWjC5TCLexckEMSs.js');
    expect(html).toMatch(/<script\s+async\s+src="https:\/\/plausible\.io\/js\//);
    expect(html).toContain('plausible.init()');
    // The loader must sit inside <head> — not stray into <body>.
    const at = html.indexOf('plausible.io/js/');
    expect(at).toBeGreaterThan(html.indexOf('<head'));
    expect(at).toBeLessThan(html.indexOf('</head>'));
    // The existing shell metadata survives the insertion.
    expect(html).toContain('<title>Routekit Shell');
    expect(html).toContain('name="description"');
  });
});

describe('marketing-site scaffold — brand, terminology, license, hygiene', () => {
  it('establishes the #3b82f6 accent and a dark background token', () => {
    const tw = read('tailwind.config.js');
    const css = read('src/styles/globals.css');
    const brand = tw + '\n' + css;
    expect(brand).toContain('#3b82f6');
    expect(brand).toMatch(/#0a0a0a|#0b1220/);
  });

  it('uses "state machine", never "phase machine" (case-insensitive)', () => {
    const low = allSource.toLowerCase();
    expect(low).toContain('state machine');
    expect(low).not.toContain('phase machine');
  });

  it('is honest about the license: AGPL-3.0 present, MIT absent (case-sensitive)', () => {
    expect(allSource).toContain('AGPL-3.0');
    expect(allSource).not.toContain('MIT');
  });

  it('DeepDives links out to the UX287 blog in a new tab', () => {
    const dd = read('src/components/DeepDives.tsx');
    expect(dd).toContain('ux287.com');
    expect(dd).toContain('target="_blank"');
    expect(dd).not.toContain('notes/blog.');
  });

  it('the header wordmark and UX287 sub-brand are present in the hero', () => {
    const hero = read('src/components/Hero.tsx');
    expect(hero).toContain('Routekit Shell');
    expect(hero).toContain('from the team at');
  });

  it('the wordmark is set in the enlarged display face', () => {
    const hero = read('src/components/Hero.tsx');
    expect(hero).toContain('font-display');
    expect(hero).toMatch(/text-(3xl|4xl|5xl)/);
    // The band alone cannot witness the wordmark — the thesis headline already
    // carries text-4xl, so any band regex matches regardless of the wordmark.
    // text-2xl was the old wordmark's base and appears nowhere else in Hero,
    // so its absence is the assertion that actually fails on a regression.
    expect(hero).not.toMatch(/text-2xl/);
  });

  it('the display face is declared and self-hosted, never from a font CDN', () => {
    const css = read('src/styles/globals.css');
    const tw = read('tailwind.config.js');
    expect(css).toContain('@font-face');
    expect(css).toContain('/fonts/overpass-black.woff2');
    expect(css).toContain('font-display: swap');
    expect(tw).toContain('display:');
    expect(tw).toContain('Overpass');
    // Privacy guard: a third-party font CDN would leak visitor IPs, undercutting
    // the deliberate privacy-friendly analytics choice. Must stay self-hosted.
    expect(allSource).not.toContain('fonts.googleapis.com');
    expect(allSource).not.toContain('fonts.gstatic.com');
  });

  it('the fabricated Us287Shield is gone from the marketing site', () => {
    // The real UX287 mark is the logo image; the hand-drawn approximation is retired.
    // (packages/telemetry-dashboard keeps its own Us287Shield — different subsystem.)
    expect(allSource).not.toContain('Us287Shield');
  });

  it('the sub-brand renders the UX287 logo image, height-constrained', () => {
    const hero = read('src/components/Hero.tsx');
    expect(hero).toContain('/ux287-logo.png');
    expect(hero).toContain('alt="UX287"');
    // Scale by height, width auto — the mark must not be stretched.
    expect(hero).toMatch(/h-(9|10|11|12)/);
    expect(hero).toContain('w-auto');
  });

  it('all GitHub links point to the public routekit-shell repo (not -core)', () => {
    expect(allSource).toContain('github.com/ux287/routekit-shell');
    expect(allSource).not.toContain('routekit-shell-core');
  });

  it('imports no airvoyant/Snacks design system anywhere in the SPA (case-insensitive)', () => {
    const low = allSource.toLowerCase();
    expect(low).not.toContain('airvoyant');
    expect(low).not.toContain('snacks');
  });
});
