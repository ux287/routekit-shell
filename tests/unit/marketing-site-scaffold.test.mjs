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

  it('Hero renders the verbatim two-tone thesis line', () => {
    expect(read('src/components/Hero.tsx')).toContain(
      "We don't need more AI, we need skills and governance."
    );
  });

  it('Hero has a prominent GitHub repo CTA (href to github.com)', () => {
    const hero = read('src/components/Hero.tsx');
    expect(hero).toMatch(/https?:\/\/github\.com\//);
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
