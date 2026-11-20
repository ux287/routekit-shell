import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const readme = read('README.md');
const contributing = read('CONTRIBUTING.md');

// Section slice: from the heading line to the next H2, or to end of file.
// Deliberately NOT a regex ending in \Z. JavaScript has no \Z anchor, so /\Z/
// matches a literal 'Z' and would end a slice early on any line containing one.
const sectionSlice = (src, heading) => {
  const start = src.indexOf('\n' + heading + '\n');
  if (start === -1) return '';
  const next = src.indexOf('\n## ', start + heading.length + 1);
  return src.slice(start + 1, next === -1 ? src.length : next + 1);
};

// --------------------------------------------------------------------------
// DERIVED publish set. The rks-public allowlist is the single source of truth;
// no package name is written as a literal below.
// --------------------------------------------------------------------------
const config = yaml.load(read('.routekit/publish-profiles.yaml'));
const profile = config.profiles['rks-public'];
const PKG_GLOB = /^packages\/([^/*]+)\/\*\*$/;

const allowlisted = new Set();
for (const g of profile.include ?? []) {
  const m = PKG_GLOB.exec(g);
  if (m) allowlisted.add(m[1]);
}
for (const g of profile.exclude ?? []) {
  const m = PKG_GLOB.exec(g);
  if (m) allowlisted.delete(m[1]);
}

const onDisk = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

// Publishes AND exists — precisely what the reader's clone will contain.
const shipped = onDisk.filter((n) => allowlisted.has(n)).sort();
// Exists but does not publish — must never be named in a public tree.
const unshipped = onDisk.filter((n) => !allowlisted.has(n)).sort();

const section = sectionSlice(readme, '## Project Structure');
const tree = section.match(/```[\s\S]*?```/)?.[0] ?? '';
// Indented entries are the packages/ children; column-0 entries are top level.
const treePackages = [...tree.matchAll(/^[│ ]+[├└]──\s+([A-Za-z0-9._-]+)\//gm)]
  .map((m) => m[1]).sort();
const treeTopLevel = [...tree.matchAll(/^[├└]──\s+([A-Za-z0-9._-]+)\//gm)]
  .map((m) => m[1]);

describe('Project Structure describes the PUBLIC tree', () => {
  it('the derivation is non-vacuous (positive control)', () => {
    expect(section).not.toBe('');
    expect(allowlisted.size).toBeGreaterThan(0);
    expect(shipped.length).toBeGreaterThan(0);
    expect(unshipped.length).toBeGreaterThan(0);
    expect(tree).not.toBe('');
    expect(treePackages.length).toBeGreaterThan(0);
  });

  it('names exactly the packages resolving into the rks-public publish set', () => {
    expect(treePackages).toEqual(shipped);
  });

  it('names no package directory that does not publish', () => {
    for (const name of unshipped) {
      expect(tree, name + ' does not publish but is named in the README tree')
        .not.toMatch(new RegExp('\\b' + name + '/'));
    }
  });

  it('every top-level directory in the tree exists on disk', () => {
    expect(treeTopLevel.length).toBeGreaterThan(0);
    for (const d of treeTopLevel) {
      expect(existsSync(join(ROOT, d)), d + ' named in tree but absent on disk').toBe(true);
    }
  });

  it('D1 — drops the stale RAG description of mcp-rks', () => {
    expect(readme).not.toContain('# MCP server (planning, execution, RAG)');
    expect(readme).toContain('mcp-rks/');
  });
});

describe('D2 — Learn More points only at namespaces that publish', () => {
  it('no longer sends readers to canon.*', () => {
    expect(readme).not.toContain('canon.*');
    expect(readme).not.toContain('canon.**');
    // Positive control on the SAME scope: 'canon' as a bare substring still
    // occurs (README.md:58 'npm-canonical'), which is why the token is tested.
    expect(readme).toMatch(/canonical/);
  });
  it('names the public.* namespace', () => {
    expect(readme).toContain('public.*');
  });
  it('does not present how-to.* as a browsable namespace', () => {
    expect(readme).not.toMatch(/browse the `how-to\.\*` and/);
    expect(readme).toMatch(/nine/);
  });
});

describe('D3 — npm test is described as the smoke alias it is', () => {
  // AGENTS.md carries the same defect. It is fixed and witnessed by
  // backlog.fix.agents-md-token-and-hook-claims, not by this story.
  for (const [label, src] of [['README.md', readme]]) {
    it(label + ' does not annotate npm test as running all tests', () => {
      const lines = src.split('\n').filter((l) => /^npm test\b/.test(l.trim()));
      expect(lines.length, label + ' no longer mentions npm test — check the anchor')
        .toBeGreaterThan(0);
      for (const l of lines) expect(l.toLowerCase()).not.toContain('all tests');
    });
    it(label + ' documents npm run test:all', () => {
      expect(src).toContain('npm run test:all');
    });
  }
});

describe('D4 — version prose does not overclaim', () => {
  it('drops the single-source-of-truth conclusion', () => {
    expect(readme).not.toContain('single source of truth');
  });
  it('names the story that owns widening the bump', () => {
    expect(readme).toContain('backlog.fix.release-version-bump-package-glob');
  });
  it('leaves every pin version-sync.test.mjs asserts on the Versioning section', () => {
    expect(readme).toMatch(/## Versioning/);
    for (const b of ['PATCH', 'MINOR', 'MAJOR']) expect(readme).toContain(b);
    expect(readme).toMatch(/fixing broken behavior is a patch/i);
    expect(readme).toMatch(/changing or adding intended behavior is a minor/i);
  });
});

describe('D5 — the governed loop includes /arch', () => {
  it('README loop lists /arch between /qa and /build', () => {
    // Sliced, not whole-file: '/build <storyId>' also occurs in Quick Start
    // (README.md:121), which a whole-file indexOf would find first.
    const contrib = sectionSlice(readme, '## Contributing');
    expect(contrib).not.toBe('');
    const q = contrib.indexOf('/qa <storyId>');
    const a = contrib.indexOf('/arch <storyId>');
    const b = contrib.indexOf('/build <storyId>');
    expect(q).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(q);
    expect(a).toBeLessThan(b);
  });
  it('CONTRIBUTING internal-loop string carries /arch', () => {
    expect(contributing).toContain('/po → /qa → /arch → /build → /ship → /release');
  });
  it('CONTRIBUTING keeps both phrases pinned by licensing-docs-agpl-sync', () => {
    expect(contributing).toContain('internal dogfood loop');
    expect(contributing).toContain('**not** a contribution path for outside contributors');
  });
});

describe('D6/D7 — Status & Maturity is current', () => {
  const status = sectionSlice(readme, '## Status & Maturity');
  it('the slice is non-empty (positive control)', () => {
    expect(status).not.toBe('');
  });
  it('does not list the dashboard as Forthcoming', () => {
    const forth = status.match(/\*\*Forthcoming\*\*[^\n]*/)?.[0] ?? '';
    expect(forth).not.toBe('');
    expect(forth.toLowerCase()).not.toContain('dashboard');
  });
  it('does not describe cost reporting as landing soon', () => {
    expect(status).not.toContain('landing soon');
  });
});

describe('D8 — no unsubstantiated metric claim', () => {
  it('cost reports no longer claim a retrieval-vs-context ratio', () => {
    expect(readme).not.toContain('cache-hit and retrieval-vs-context ratios');
    expect(readme).toContain('cache-hit');
  });
  it('the blog-series sentence is deliberately retained', () => {
    expect(readme).toContain('The token-economy design');
  });
});

describe('D9-D11 — copy defects', () => {
  it('free rein, not free reign', () => {
    expect(readme).not.toContain('free reign');
    expect(readme).toContain('free rein');
  });
  it('reads "your favorite chat agent"', () => {
    expect(readme).toContain('your favorite chat agent');
  });
  it('GitHub is capitalised correctly', () => {
    expect(readme).not.toContain('Github');
    expect(readme).toContain('GitHub');
  });
});

describe('adopted PRs surface as closed, not merged', () => {
  it('README Contributing section states it and links CONTRIBUTING.md', () => {
    const contrib = sectionSlice(readme, '## Contributing');
    expect(contrib).not.toBe('');
    expect(contrib).toMatch(/closed[^.]*not merged|not merged[^.]*closed/i);
    expect(contrib).toContain('[CONTRIBUTING.md](CONTRIBUTING.md)');
  });
});

describe('section ordering', () => {
  const idx = (s) => readme.indexOf(s);
  it('Project Structure precedes Learn More', () => {
    expect(idx('## Project Structure')).toBeGreaterThan(-1);
    expect(idx('## Learn More')).toBeGreaterThan(-1);
    expect(idx('## Project Structure')).toBeLessThan(idx('## Learn More'));
  });
  it('Contributing precedes RKS Pro', () => {
    expect(idx('## Contributing')).toBeGreaterThan(-1);
    expect(idx('## RKS Pro')).toBeGreaterThan(-1);
    expect(idx('## Contributing')).toBeLessThan(idx('## RKS Pro'));
  });
  it('the agency CTA sits below The Problem', () => {
    expect(idx('## The Problem')).toBeGreaterThan(-1);
    expect(idx('Work with UX287')).toBeGreaterThan(idx('## The Problem'));
  });
});

describe('collateral guarantees', () => {
  it('README introduces no MIT reference', () => {
    expect(readme).not.toMatch(/\bMIT\b/);
    expect(readme).toMatch(/AGPL-3\.0-or-later/);
  });
  it('the Quick Start slice stays free of the forbidden tool-call forms', () => {
    const qs = sectionSlice(readme, '## Quick Start');
    expect(qs).not.toBe('');
    expect(qs).not.toContain('dendron_create_note {');
    expect(qs).not.toMatch(/rks_plan \{[\s\S]*?projectId/);
  });
  it('publish-profiles.yaml still carries its tripwire exclusions', () => {
    const src = read('.routekit/publish-profiles.yaml');
    expect(src).toContain('packages/whitepaper/**');
    expect(src).toContain('packages/*/src/presentations/**');
  });
});
