/**
 * getProjectContext must honour an explicitly-supplied project root.
 *
 * The defect: `getProjectContext(customProjectRoot)` treated "no package.json anywhere
 * above the supplied root" as "the caller gave me nothing" and substituted
 * `process.cwd()`. An embed scoped to project B therefore read project A's content and
 * overwrote A's embed-manifest.json — silently, persistently, across project boundaries.
 * Observed in CI run 31500617443: a unit test operating on a mkdtemp fixture embedded
 * 34867 chunks of the real repository.
 *
 * Greenfield coverage — before this file, zero tests exercised getProjectContext with an
 * explicit root (40 references across 17 source files, none in tests/).
 *
 * Story: backlog.fix.rag-embed-honours-explicit-project-root
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getProjectContext, getDefaultRagConfig } from '../../../packages/rag/src/utils.mjs';

const TEMPLATE_UTILS = resolve(
  process.cwd(),
  'templates/app-web/scripts/rag/utils.mjs',
);

/** Tracks every fixture so afterEach can remove them. */
let fixtures = [];

function makeDir(...segments) {
  const dir = mkdtempSync(join(tmpdir(), 'rks-getctx-'));
  fixtures.push(dir);
  const target = segments.length ? join(dir, ...segments) : dir;
  if (segments.length) mkdirSync(target, { recursive: true });
  return { root: dir, target };
}

function withPackageJson(dir, name = 'fixture-pkg') {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
  vi.restoreAllMocks();
});

describe('getProjectContext — an explicit root is authoritative', () => {
  it('returns the supplied root verbatim when it has no package.json, never process.cwd()', () => {
    const { root } = makeDir();

    const ctx = getProjectContext(root);

    expect(ctx.projectRoot).toBe(resolve(root));
    expect(ctx.projectRoot).not.toBe(process.cwd());
  });

  it('does NOT widen an explicit root to an ancestor package.json', () => {
    // The walk-up previously climbed until it found a package.json, silently replacing an
    // explicit root with its monorepo ancestor. No warning was ever printed for this case.
    const { root, target } = makeDir('nested', 'deeper');
    withPackageJson(root, 'the-ancestor');

    const ctx = getProjectContext(target);

    expect(ctx.projectRoot).toBe(resolve(target));
    expect(ctx.projectRoot).not.toBe(resolve(root));
  });

  it('returns exactly the supplied root when it has its own package.json', () => {
    const { root } = makeDir();
    withPackageJson(root);

    expect(getProjectContext(root).projectRoot).toBe(resolve(root));
  });

  it('normalises a relative explicit root to an absolute path', () => {
    const { root } = makeDir();
    const relativeRoot = relative(process.cwd(), root);

    // Guard the guard: if the fixture is not actually relative the assertion is vacuous.
    expect(relativeRoot).not.toBe(resolve(root));

    expect(getProjectContext(relativeRoot).projectRoot).toBe(resolve(root));
  });

  it('derives vaultPath, projectSlug and ragDbPath from the explicit root', () => {
    const { root } = makeDir();

    const ctx = getProjectContext(root);

    expect(ctx.vaultPath).toBe(join(resolve(root), 'notes'));
    expect(ctx.projectSlug).toBe(basename(resolve(root)));
    expect(ctx.ragDbPath).toBe(
      join(resolve(root), '.rks', 'rag', `${basename(resolve(root))}.lancedb`),
    );
  });

  it('honours the explicit root from the catch fallback too', async () => {
    // The catch block had the same defect as the happy path: `process.cwd()` unconditionally.
    // Force a throw inside the try by making the notes-dir probe explode.
    const { root } = makeDir();

    vi.resetModules();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        existsSync: () => {
          throw new Error('forced failure inside getProjectContext');
        },
      };
    });

    const mod = await import('../../../packages/rag/src/utils.mjs?catch-path');
    const ctx = mod.getProjectContext(root);

    expect(ctx.projectRoot).toBe(resolve(root));
    expect(ctx.vaultPath).toBe(join(resolve(root), 'notes'));

    vi.doUnmock('fs');
    vi.resetModules();
  });
});

describe('getProjectContext — zero-argument discovery is unchanged', () => {
  it('walks up from process.cwd() to the nearest package.json', () => {
    // This repo has a package.json at its root, so discovery must land on the repo root.
    const ctx = getProjectContext();

    expect(ctx.projectRoot).toBe(process.cwd());
  });

  it('getDefaultRagConfig — the zero-argument discovery caller — is unaffected', () => {
    const config = getDefaultRagConfig();
    const discovered = getProjectContext();

    expect(config.db).toBe(discovered.ragDbPath);
    expect(config.vault).toBe(discovered.vaultPath);
    expect(config.glob).toBe(discovered.noteGlob);
    expect(config.projectSlug).toBe(discovered.projectSlug);
  });

  it('a non-string argument falls through to discovery rather than throwing', () => {
    // resolve() runs before the try block, so a non-string must not reach it.
    expect(() => getProjectContext(0)).not.toThrow();
    expect(getProjectContext(0).projectRoot).toBe(process.cwd());
  });
});

describe('templates/app-web/scripts/rag/utils.mjs — the mirrored resolver', () => {
  let templateCtx;

  beforeEach(async () => {
    const mod = await import(pathToFileURL(TEMPLATE_UTILS).href);
    templateCtx = mod.getProjectContext;
  });

  it('honours an explicit root without package.json', async () => {
    const { root } = makeDir();

    expect(templateCtx(root).projectRoot).toBe(resolve(root));
  });

  it('does not widen an explicit root to an ancestor package.json', async () => {
    const { root, target } = makeDir('nested');
    withPackageJson(root);

    expect(templateCtx(target).projectRoot).toBe(resolve(target));
  });

  it('retains its divergent ragDbPath and noteGlob semantics after the mirror', async () => {
    // The template deliberately differs from packages/rag: a homedir-based shared RAG
    // directory and a slug-prefixed note glob. Converging them is a separate concern and
    // must not be smuggled in with the resolver fix.
    const { root } = makeDir();
    withPackageJson(root);

    const ctx = templateCtx(root);

    expect(ctx.ragDbPath).toContain(join('.routekit', 'rag'));
    expect(ctx.ragDbPath).not.toContain(join('.rks', 'rag'));
    expect(ctx.noteGlob).toBe(`${basename(resolve(root))}.*`);
  });
});
