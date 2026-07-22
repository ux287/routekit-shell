/**
 * backlog.feat.whitepaper-pdf-pipeline — @routekit/whitepaper package.
 *
 * Pure-function + source-introspection suite. The default `npx vitest run` runs
 * NO live Chromium render — the pure modules (markdown/template/brand) are
 * imported and exercised directly, and the renderer/cli are source-introspected.
 * The one live-render smoke test is gated behind `.skipIf` (WHITEPAPER_RENDER=1),
 * which is exempt from the skip-debt audit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNote, renderBodyHtml } from '../../packages/whitepaper/src/markdown.mjs';
import { renderWhitepaperHtml } from '../../packages/whitepaper/src/template.mjs';
import { US287_SHIELD_SVG } from '../../packages/whitepaper/src/brand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const PKG = resolve(ROOT, 'packages/whitepaper');
const read = (p) => readFileSync(resolve(PKG, p), 'utf8');

describe('package manifest + workspace posture', () => {
  const pkg = JSON.parse(read('package.json'));

  it('is @routekit/whitepaper, ESM, with a whitepaper bin → cli.mjs', () => {
    expect(pkg.name).toBe('@routekit/whitepaper');
    expect(pkg.type).toBe('module');
    expect(pkg.bin.whitepaper).toBe('./src/cli.mjs');
  });

  it('declares markdown-it + gray-matter as deps and playwright as a devDep only', () => {
    expect(pkg.dependencies).toHaveProperty('markdown-it');
    expect(pkg.dependencies).toHaveProperty('gray-matter');
    expect(pkg.devDependencies).toHaveProperty('playwright');
    expect(pkg.dependencies).not.toHaveProperty('playwright');
  });

  it('is auto-discovered: root workspaces still packages/* (unedited)', () => {
    const root = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(root.workspaces).toContain('packages/*');
  });
});

describe('markdown.mjs — pure transforms (no Chromium)', () => {
  it('renderBodyHtml transforms representative markdown to HTML', () => {
    const html = renderBodyHtml('# Heading\n\nA paragraph with `code`.\n\n- one\n- two');
    expect(html).toContain('<h1>');
    expect(html).toContain('<p>');
    expect(html).toContain('<code>');
    expect(html).toContain('<li>');
  });

  it('parseNote strips Dendron frontmatter and maps title/desc/date into cover', () => {
    const raw = [
      '---',
      'id: "backlog.feat.example"',
      'title: "My Note"',
      'desc: "A subtitle line"',
      'created: 1700000000000',
      'updated: 1700000100000',
      '---',
      '',
      '# Body heading',
      '',
      'body text',
    ].join('\n');
    const { cover, bodyMarkdown } = parseNote(raw);
    expect(cover.title).toBe('My Note');
    expect(cover.subtitle).toBe('A subtitle line');
    expect(cover.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bodyMarkdown).toContain('# Body heading');
    expect(bodyMarkdown).not.toContain('title:');
  });
});

describe('brand.mjs — shield SVG string', () => {
  it('exports the US-287 shield as an inline SVG string ported from the dashboard', () => {
    expect(typeof US287_SHIELD_SVG).toBe('string');
    expect(US287_SHIELD_SVG).toContain('viewBox="0 0 100 112"');
    expect(US287_SHIELD_SVG).toContain('#fff');
    expect(US287_SHIELD_SVG).toContain('#0a0a0a');
    expect(US287_SHIELD_SVG).toContain('>UX<');
    expect(US287_SHIELD_SVG).toContain('>287<');
  });
});

describe('ux287-print.css — grounded tokens + paged media', () => {
  const css = read('src/theme/ux287-print.css');

  it('carries the grounded ux287 tokens', () => {
    expect(css).toContain('#3b82f6');
    expect(css).toContain('rgba(59, 130, 246, 0.22)'); // hero-dark radial
    expect(css).toContain('rgba(59, 130, 246, 0.45)'); // hero-blue radial
    expect(css).toContain('#e2e8f0'); // slate-200 card border
    expect(css).toContain('#fff'); // white card
    expect(css).toContain('system-ui'); // font stack
  });

  it('includes @page paged-media with a page-number counter', () => {
    expect(css).toContain('@page');
    expect(css).toContain('counter(page)');
  });
});

describe('template.mjs — self-contained branded HTML', () => {
  it('assembles shield + cover + body + inlined CSS + header/footer', () => {
    const out = renderWhitepaperHtml({
      cover: { title: 'Deck Title', subtitle: 'The subtitle' },
      bodyHtml: '<p>BODY_MARKER</p>',
      css: '@page { size: Letter; }',
    });
    expect(out).toContain('Deck Title');
    expect(out).toContain('The subtitle');
    expect(out).toContain('BODY_MARKER');
    expect(out).toContain('@page { size: Letter; }');
    expect(out).toContain('<style>');
    expect(out).toContain('viewBox="0 0 100 112"'); // shield embedded
    expect(out).toContain('wp-running-header');
    expect(out).toContain('wp-running-footer');
  });
});

describe('renderer.mjs — import-safe, Chromium only inside the function', () => {
  const renderer = read('src/renderer.mjs');

  it('loads Playwright via dynamic import inside renderPdf, not at module load', () => {
    expect(renderer).toContain("await import('playwright')");
    expect(renderer).not.toMatch(/^\s*import\s+.*['"]playwright['"]/m);
    expect(renderer).toMatch(/export\s+async\s+function\s+renderPdf/);
    expect(renderer).toContain('page.pdf');
    expect(renderer).toContain('printBackground');
  });
});

describe('cli.mjs — import-safe, correct input/output paths', () => {
  const cli = read('src/cli.mjs');

  it('maps notes/<id>.md → dist/whitepapers/<id>.pdf and guards direct execution', () => {
    expect(cli).toContain('notes');
    expect(cli).toContain('dist');
    expect(cli).toContain('whitepapers');
    expect(cli).toContain('${noteId}.md');
    expect(cli).toContain('${noteId}.pdf');
    expect(cli).toContain('import.meta.url'); // import-safe direct-run guard
  });
});

describe('does not touch the shipped dashboard', () => {
  // Self-contained means it does not IMPORT from the dashboard. Provenance
  // comments that cite the source path are expected and fine — assert on imports.
  const noDashImport = (src) =>
    expect(src).not.toMatch(/(?:^|\n)\s*(?:import|@import|const|require)[^\n]*telemetry-dashboard/);

  it('the whitepaper theme/brand are self-contained (no telemetry-dashboard import)', () => {
    noDashImport(read('src/brand.mjs'));
    noDashImport(read('src/template.mjs'));
    noDashImport(read('src/theme/ux287-print.css'));
  });
});

describe('render quality — page breaks + mermaid', () => {
  it('renders a ```mermaid fence as a .mermaid container, not a code block', () => {
    const html = renderBodyHtml('```mermaid\ngraph TD\n  A --> B\n```\n');
    expect(html).toContain('class="mermaid"');
    expect(html).not.toContain('language-mermaid');
    expect(html).toContain('graph TD');
  });

  it('leaves a normal ```js fence as an ordinary code block', () => {
    const html = renderBodyHtml('```js\nconst x = 1;\n```\n');
    expect(html).toContain('<code');
    expect(html).not.toContain('class="mermaid"');
  });

  it('css adds page-break controls + mermaid portrait sizing without regressing @page/tokens', () => {
    const css = read('src/theme/ux287-print.css');
    expect(css).toContain('break-after: avoid');
    expect(css).toContain('break-inside: avoid');
    expect(css).toContain('orphans');
    expect(css).toContain('widows');
    expect(css).toContain('pre.mermaid');
    expect(css).toContain('@page');
    expect(css).toContain('counter(page)');
    expect(css).toContain('#3b82f6');
  });

  it('renderer injects mermaid from node_modules (no CDN) and runs it before page.pdf', () => {
    const r = read('src/renderer.mjs');
    expect(r).toMatch(/require\.resolve\(['"]mermaid/);
    expect(r).toContain('addScriptTag');
    expect(r).toContain('startOnLoad');
    expect(r).not.toMatch(/https?:\/\/[^'"]*mermaid/);
    expect(r.indexOf('addScriptTag')).toBeLessThan(r.indexOf('page.pdf'));
    expect(r).not.toMatch(/^\s*import\s+.*['"]mermaid['"]/m);
  });

  it('package.json adds mermaid as a dependency while playwright stays a devDep only', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies).toHaveProperty('mermaid');
    expect(pkg.devDependencies).toHaveProperty('playwright');
    expect(pkg.dependencies).not.toHaveProperty('playwright');
  });
});

// Opt-in live Chromium render. .skipIf keeps it out of the default run (and is
// exempt from the skip-debt audit). Run with: WHITEPAPER_RENDER=1 npx vitest run
describe.skipIf(process.env.WHITEPAPER_RENDER !== '1')('live render (opt-in)', () => {
  it('renders a PDF to disk', async () => {
    const { renderPdf } = await import('../../packages/whitepaper/src/renderer.mjs');
    const html = renderWhitepaperHtml({ cover: { title: 'Smoke' }, bodyHtml: '<p>hi</p>', css: '' });
    const out = resolve(ROOT, 'dist/whitepapers/__smoke.pdf');
    await renderPdf({ html, outPath: out });
    expect(readFileSync(out).length).toBeGreaterThan(0);
  }, 60000);
});
