/**
 * embedNotes must derive vaultPath, dbPath and targetRoot from the TARGET project, not
 * from module-level values captured at import time.
 *
 * Leak 2 of backlog.fix.rag-embed-honours-explicit-project-root. `runRagEmbed` never
 * passes `vault`, so `vaultPath` fell back to DEFAULT_VAULT_PATH — destructured once at
 * module import from a context built around process.cwd(). An embed scoped to project B
 * therefore read project A's notes. Independent of Leak 1: this fires even when the
 * target has a package.json.
 *
 * embedNotes is deliberately NOT exported (a story constraint), so everything here drives
 * the exported embed(). The instrumented getProjectContext records the root it was asked
 * for and then throws, which aborts the run the instant the contract has been observed.
 * That is deliberate: an earlier draft of this file let embed() proceed and it walked the
 * entire repository, generating 99 embeddings — the very defect under repair, reproduced
 * inside its own test. A unit test must never be able to reach the real corpus.
 *
 * Story: backlog.fix.rag-embed-honours-explicit-project-root
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const CTX_SENTINEL = 'context-resolved-abort-by-test';
const UTILS = '../../../packages/rag/src/utils.mjs';

let fixtures = [];
/** Roots getProjectContext was asked to resolve, in call order. */
let requestedRoots = [];
/** Only throw once module initialisation is done — :83 resolves at import time. */
let armed = false;

function makeProject(name) {
  const dir = mkdtempSync(join(tmpdir(), `rks-embed-${name}-`));
  fixtures.push(dir);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }), 'utf8');
  return dir;
}

async function loadEmbed() {
  vi.resetModules();
  requestedRoots = [];
  armed = false;

  vi.doMock(UTILS, async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      getProjectContext: (root) => {
        requestedRoots.push(root);
        if (armed) throw new Error(CTX_SENTINEL);
        return actual.getProjectContext(root);
      },
    };
  });

  const mod = await import('../../../packages/rag/src/embed.mjs?target-scoped');
  armed = true;
  return mod.embed;
}

/** The root embedNotes resolved for this run. */
function targetRoot() {
  return requestedRoots[requestedRoots.length - 1];
}

let savedEnv;

beforeEach(() => {
  savedEnv = process.env.ROUTEKIT_PROJECT_ROOT;
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = 'stub';
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = savedEnv;
  delete process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE;

  armed = false;
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
  vi.doUnmock(UTILS);
  vi.resetModules();
});

describe('embed() — an explicit projectRoot scopes the run', () => {
  it('resolves the target context from projectRoot, not the import-time capture', async () => {
    const b = makeProject('project-b');
    delete process.env.ROUTEKIT_PROJECT_ROOT;

    const embed = await loadEmbed();
    await embed({ projectRoot: b, db: join(b, '.rks', 'rag', 'b.lancedb') });

    expect(targetRoot()).toBe(b);
    expect(targetRoot()).not.toBe(process.cwd());
  });

  it('scopes the run to the target even when a bystander project is the cwd', async () => {
    // The production shape: server scoped to B via an explicit root, process.cwd() in A.
    // Everything downstream — the note glob, the code walk, saveManifest — derives from
    // this one value, so pinning it pins the containment.
    const b = makeProject('project-b');
    delete process.env.ROUTEKIT_PROJECT_ROOT;

    const embed = await loadEmbed();
    await embed({ projectRoot: b, db: join(b, '.rks', 'rag', 'b.lancedb') });

    expect(targetRoot()).toBe(b);
    expect(targetRoot()).not.toContain('routekit-shell-core');
  });
});

describe('embed() — vault without projectRoot', () => {
  it('resolves the target context from dirname(vault)', async () => {
    // RED AT HEAD BY DESIGN. Before the fix, embedNotes' `targetRoot` parameter carried an
    // import-time default (`projectContext.projectRoot`), so it was always truthy and the
    // `|| dirname(vaultPath)` arm was unreachable. This passes only once that default is
    // removed, and must never be satisfied by reintroducing a truthy default.
    const b = makeProject('project-b');
    delete process.env.ROUTEKIT_PROJECT_ROOT;

    const embed = await loadEmbed();
    await embed({ vault: join(b, 'notes'), db: join(b, '.rks', 'rag', 'b.lancedb') });

    expect(targetRoot()).toBe(dirname(join(b, 'notes')));
    expect(targetRoot()).toBe(b);
  });
});

describe('embed() — no projectRoot and no vault', () => {
  it('honours ROUTEKIT_PROJECT_ROOT when it is set', async () => {
    // The arm taken by the two in-repo zero-argument callers: the CLI main guard in
    // embed.mjs (reached in production via packages/mcp-rks/src/dendron.mjs) and
    // packages/hooks/system/rag-embed-on-commit.mjs. A test asserting the env var is
    // IGNORED here would pin the very regression this story closes.
    const b = makeProject('project-b');
    process.env.ROUTEKIT_PROJECT_ROOT = b;

    const embed = await loadEmbed();
    await embed({ db: join(b, '.rks', 'rag', 'b.lancedb') });

    expect(targetRoot()).toBe(resolve(b));
    expect(targetRoot()).not.toBe(process.cwd());
  });

  it('passes undefined — the discovery signal — when ROUTEKIT_PROJECT_ROOT is absent', async () => {
    delete process.env.ROUTEKIT_PROJECT_ROOT;

    const embed = await loadEmbed();
    await embed({ db: join(tmpdir(), 'unused.lancedb') });

    // undefined means "discover at call time". Passing process.cwd() here instead is what
    // made the resolver treat a bystander root as authoritative.
    expect(targetRoot()).toBeUndefined();
  });
});

describe('embed.mjs — exported surface is unchanged', () => {
  it('does not export embedNotes', async () => {
    const mod = await import('../../../packages/rag/src/embed.mjs');

    expect(mod.embedNotes).toBeUndefined();
    expect(typeof mod.embed).toBe('function');
  });
});
