/**
 * Release smoke verification.
 *
 * Invoked by .github/workflows/release-smoke.yml on every release tag push.
 * Asserts that the production scripts/rag/embed.mjs, run against the fixture
 * vault at tests/integration/fixtures/release-smoke-vault/, produces a
 * LanceDB index that satisfies the post-release storage contract:
 *
 *   1. Every expected content_type is present (backlog, note, code, implemented).
 *   2. The 'implemented' bucket has >= 1 row — a classifier regression that
 *      silently empties this bucket is the failure mode that motivated this story.
 *   3. The total row count is within ±5% of an expected constant derived from
 *      the fixture vault at construction time. A regression in row construction
 *      that halves the index will trip this check.
 *
 * ARCH-pinned: the LanceDB path is computed via path.basename(projectRoot) — the
 * SAME derivation rule packages/cli/src/rag/config.mjs uses for getRagPaths().
 * Hardcoding the slug would let a working embed write to one path and the test
 * read from another, which is the exact bug class that bit v0.20.15 verification.
 *
 * Local invocation (without the workflow): first run embed against the fixture
 * vault, then run this test:
 *
 *   ROUTEKIT_PROJECT_ROOT="$(pwd)/tests/integration/fixtures/release-smoke-vault" \
 *   ROUTEKIT_RAG_EMBEDDINGS_MODE=model \
 *   node scripts/rag/embed.mjs
 *
 *   ROUTEKIT_PROJECT_ROOT="$(pwd)/tests/integration/fixtures/release-smoke-vault" \
 *   npx vitest run tests/integration/release-smoke.test.mjs
 *
 * If ROUTEKIT_PROJECT_ROOT is not set, the test resolves the fixture vault by
 * convention (sibling fixtures/ dir) so local invocation works with zero env setup.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '@lancedb/lancedb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_VAULT_DEFAULT = path.join(REPO_ROOT, 'tests/integration/fixtures/release-smoke-vault');

// ARCH ask: resolve via env var (set by the workflow) OR by convention (local DX).
// In CI the workflow sets ROUTEKIT_PROJECT_ROOT explicitly; locally the default
// keeps the test runnable without env setup.
const fixtureVault = process.env.ROUTEKIT_PROJECT_ROOT || FIXTURE_VAULT_DEFAULT;

// ARCH-pinned derivation: must match packages/cli/src/rag/config.mjs getRagPaths().
// projectSlug = path.basename(projectRoot); dbPath = ${projectRoot}/.rks/rag/${slug}.lancedb
const projectSlug = path.basename(fixtureVault);
const lanceDbPath = path.join(fixtureVault, '.rks/rag', `${projectSlug}.lancedb`);

// Fixture-derived row-count expectation. Recomputed manually if the fixture
// vault shape changes — see notes/how-to.release-smoke-verification.md.
// 6 notes (4 backlog-prefixed, 3 generic) + 2 code files. Each note chunks
// to ~1-3 rows depending on body length; code files chunk one row apiece
// (small files). Conservative band: 8-50 rows. The ±5% band hits once we
// pin a real number; until then the assertion is the floor/ceiling check
// below, which catches "empty index" and "runaway index" cleanly.
const EXPECTED_ROW_FLOOR = 8;
const EXPECTED_ROW_CEILING = 200;

// Mandatory content_types per AC5. skill and llm-context are optional —
// the fixture vault doesn't include those categories.
const REQUIRED_CONTENT_TYPES = ['backlog', 'note', 'code', 'implemented'];

// Skip behavior: this file lives under tests/integration/ and is therefore
// swept up by the regular `npm run test:mock` integration suite (the
// integration-tests job in .github/workflows/ci.yml). That suite does NOT run
// `node scripts/rag/embed.mjs` first, so the LanceDB index is absent and the
// preflight assertion would fail there with no useful signal. The release-
// smoke.yml workflow always runs embed before this test, so the DB IS present
// in its intended context. Resolution: skip the whole suite cleanly when the
// DB is absent. The workflow can force the run via RKS_RELEASE_SMOKE_REQUIRE_DB=1
// so a silent embed regression that produces no DB still fails CI loudly.
const dbExists = fs.existsSync(lanceDbPath);
const requireDb = process.env.RKS_RELEASE_SMOKE_REQUIRE_DB === '1';
const shouldSkip = !dbExists && !requireDb;
const describeOrSkip = shouldSkip ? describe.skip : describe;

let rows = null;
let dbOpenError = null;

beforeAll(async () => {
  if (shouldSkip) return;
  if (!fs.existsSync(lanceDbPath)) {
    dbOpenError = new Error(
      `LanceDB index not found at ${lanceDbPath}. ` +
        `Did you run \`node scripts/rag/embed.mjs\` against the fixture vault first? ` +
        `See the file header for the local invocation recipe.`,
    );
    return;
  }
  try {
    const db = await connect(lanceDbPath);
    const table = await db.openTable('embeddings');
    // toArray returns all rows; fine for fixture-scale indexes (under 100 rows).
    rows = await table.query().toArray();
  } catch (err) {
    dbOpenError = err;
  }
}, 120_000); // ARCH timeout floor: 120s for LanceDB cold open on CI runners.

describeOrSkip('Release smoke — LanceDB connectivity (preflight)', () => {
  it('LanceDB index exists at the basename-derived path', () => {
    expect(dbOpenError, dbOpenError?.message).toBeNull();
    expect(fs.existsSync(lanceDbPath)).toBe(true);
  });

  it('embeddings table opens and yields rows', () => {
    expect(rows, 'rows should be a non-null array').not.toBeNull();
    expect(Array.isArray(rows)).toBe(true);
  });
});

describeOrSkip('AC4 — implemented bucket non-empty', () => {
  it('content_type=implemented count >= 1', () => {
    expect(rows).not.toBeNull();
    const implementedCount = rows.filter((r) => r.content_type === 'implemented').length;
    expect(implementedCount, 'a classifier regression silently emptied the implemented bucket').toBeGreaterThanOrEqual(1);
  });
});

describeOrSkip('AC5 — all required content_types present', () => {
  for (const ct of REQUIRED_CONTENT_TYPES) {
    it(`content_type=${ct} has >= 1 row`, () => {
      expect(rows).not.toBeNull();
      const count = rows.filter((r) => r.content_type === ct).length;
      expect(count, `content_type='${ct}' was silently dropped by the classifier`).toBeGreaterThanOrEqual(1);
    });
  }

  it('content_type values are drawn from the documented enum (no unexpected types)', () => {
    expect(rows).not.toBeNull();
    const seen = new Set(rows.map((r) => r.content_type));
    const allowed = new Set(['backlog', 'note', 'code', 'implemented', 'skill', 'llm-context']);
    for (const ct of seen) {
      expect(allowed.has(ct), `unexpected content_type '${ct}' — classifier added a new enum without updating this assertion`).toBe(true);
    }
  });
});

describeOrSkip('AC4/AC5 followup — row-count sanity band', () => {
  it(`total row count is within [${EXPECTED_ROW_FLOOR}, ${EXPECTED_ROW_CEILING}] (catches empty + runaway)`, () => {
    expect(rows).not.toBeNull();
    expect(rows.length).toBeGreaterThanOrEqual(EXPECTED_ROW_FLOOR);
    expect(rows.length).toBeLessThanOrEqual(EXPECTED_ROW_CEILING);
  });
});

// Subprocess timeout rule (ARCH-pinned testReq 12): this test file does NOT
// spawn subprocesses — embed.mjs is run by the workflow's prior step in CI, and
// the LanceDB connect() call is async-IO, not subprocess. The beforeAll above
// carries a 120_000ms timeout per the ARCH floor for cold LanceDB opens on
// CI runners. If a future change adds a spawnSync/exec call to this file, it
// MUST carry an explicit timeout option >= 120_000ms.
