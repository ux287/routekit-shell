/**
 * Live coverage for the @routekit/telemetry dynamic-import tool-handler paths.
 *
 * `telemetry_analyze` and `telemetry_digest` reach the extracted package through
 * `await import('@routekit/telemetry/analysis' | '/digest')` INSIDE the handler
 * body. Before this file, the only coverage was a resolution check asserting the
 * exports are functions — so an exports-map regression or a provider signature
 * change surfaced at runtime in a user's session, never in CI.
 *
 * These tests invoke the handlers themselves, via `execute`, so the dynamic
 * import actually runs. Calling the provider modules directly instead would
 * exercise the providers but NOT the import path, and would miss exactly the
 * regression this file exists to catch.
 *
 * NON-VACUITY. Every assertion is fixture-derived and would fail against an
 * empty or placeholder result:
 *   - analyze asserts the seeded status, a unique token from the seeded errors,
 *     and the category/confidence those inputs deterministically derive;
 *   - digest asserts counts computed from the seeded events, plus a filtering
 *     witness — an out-of-window distractor excluded from `yesterday` but
 *     included in `last-30-days`, so the second total is strictly larger. No
 *     canned string passes both.
 *
 * NO MOCKING. `/analysis` and `/digest` are deliberately absent from the
 * suite-wide mocks in tests/setup.mjs, so they resolve the real modules. Adding
 * a stub for either would mock the module under test and reproduce the vacuous
 * -test defect fixed in backlog.fix.telemetry-global-mock-shadowing-sweep.
 *
 * STATED LIMITATION. The two server.mjs call sites are NOT booted — standing up
 * the full MCP server is out of proportion here. They are covered two ways
 * instead: a source-pin on the dynamic-import form (so a specifier drift fails
 * CI), and provider calls using the exact argument shapes server.mjs passes (so
 * a signature regression fails CI). The server handler bodies themselves remain
 * uncovered; booting them is a separate concern.
 *
 * Timestamps are computed at runtime, never hardcoded: the digest window is
 * derived from `now` at call time, so fixed ISO strings would drift out of range.
 *
 * (backlog.feat.telemetry-dynamic-import-handler-coverage)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RUN_ID = 'run-dynamic-import-fixture';
/** Unique enough that a placeholder result cannot contain it by accident. */
const ERROR_TOKEN = 'ZQ7X-stale-pattern-witness';

let projectRoot;

/** Milliseconds since epoch for a point safely inside yesterday's window. */
function yesterdayMidday() {
  const midnightToday = new Date();
  midnightToday.setHours(0, 0, 0, 0);
  return new Date(midnightToday.getTime() - 12 * 60 * 60 * 1000).toISOString();
}

/** A point well outside the `yesterday` window but inside `last-30-days`. */
function tenDaysAgo() {
  return new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Seeds a plan.json whose text triggers exactly ONE failure category.
 *
 * Category matching is a first-match-wins substring scan over the lowercased
 * failure JSON, in FAILURE_CATEGORIES insertion order, so the fixture must
 * contain no earlier category's pattern. `stale_search_pattern` is second; the
 * text below deliberately avoids the first category's patterns ("note_only",
 * "no targetFiles", "not listed as editable") and every later one.
 */
function seedFailedPlan() {
  const runDir = path.join(projectRoot, '.rks', 'runs', RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'plan.json'),
    JSON.stringify(
      {
        status: 'blocked',
        qualityReview: {
          errors: [`Search pattern not found in src/example.mjs: ${ERROR_TOKEN}`],
          warnings: [],
        },
      },
      null,
      2,
    ),
  );
}

function seedTelemetryEvents() {
  const telemetryDir = path.join(projectRoot, '.rks', 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });

  const inWindow = yesterdayMidday();
  const outOfWindow = tenDaysAgo();

  const lines = [
    // 3 events inside yesterday's window
    { timestamp: inWindow, type: 'plan.start' },
    { timestamp: inWindow, type: 'exec.start' },
    { timestamp: inWindow, type: 'exec.complete' },
    // 2 distractors outside it — the filtering witness
    { timestamp: outOfWindow, type: 'plan.start' },
    { timestamp: outOfWindow, type: 'exec.start' },
  ].map((e) => JSON.stringify(e));

  fs.writeFileSync(path.join(telemetryDir, 'events-fixture.jsonl'), lines.join('\n') + '\n');
}

/** The handler under test, reached exactly as the agent exposes it. */
async function getTool(name) {
  const { createTelemetryAgent } = await import(
    '../../packages/mcp-rks/src/agents/telemetry.mjs'
  );
  const agent = createTelemetryAgent({
    projectId: 'routekit-shell-core',
    query: 'integration fixture',
    projectRoot,
  });
  const tool = agent.tools.find((t) => t.name === name);
  expect(tool, `agent must expose a ${name} tool`).toBeDefined();
  expect(typeof tool.execute).toBe('function');
  return tool;
}

beforeEach(() => {
  // Temp root, never the repository's own .rks/ — tests/setup.mjs has an
  // afterEach that unlinks .rks/telemetry/*.jsonl at the real path.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-dyn-import-'));
  seedFailedPlan();
  seedTelemetryEvents();
});

afterEach(() => {
  if (projectRoot && fs.existsSync(projectRoot)) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('telemetry_analyze — live dynamic import of @routekit/telemetry/analysis', () => {
  it('invokes the handler, which imports and runs the REAL analyzeFailure', async () => {
    const tool = await getTool('telemetry_analyze');

    const res = await tool.execute({ runId: RUN_ID });

    expect(res.ok).toBe(true);
    // Fixture-derived: proves the handler read OUR plan.json, not a placeholder.
    expect(res.failure.type).toBe('plan.failed');
    expect(res.failure.status).toBe('blocked');
    expect(res.failure.errors[0]).toContain(ERROR_TOKEN);
    // Derived by the real categoriser from the seeded text.
    expect(res.analysis.category).toBe('stale_search_pattern');
    expect(res.analysis.confidence).toBe('high');
    expect(res.analysis.suggestions).toContain(
      'Update SEARCH blocks in story with exact current code',
    );
  });

  it('returns the no-failure shape when the seeded plan is executable', async () => {
    // Negative control: same handler, different fixture. Proves the result
    // tracks the fixture rather than being constant.
    const runDir = path.join(projectRoot, '.rks', 'runs', RUN_ID);
    fs.writeFileSync(
      path.join(runDir, 'plan.json'),
      JSON.stringify({ status: 'executable', qualityReview: { errors: [], warnings: [] } }),
    );

    const tool = await getTool('telemetry_analyze');
    const res = await tool.execute({ runId: RUN_ID });

    expect(res.ok).toBe(true);
    expect(res.analysis).toBeNull();
    expect(res.message).toBe('No failure found for given parameters');
  });
});

describe('telemetry_digest — live dynamic import of @routekit/telemetry/digest', () => {
  it('invokes the handler, which imports and runs the REAL generateDigest', async () => {
    const tool = await getTool('telemetry_digest');

    const res = await tool.execute({ timeframe: 'yesterday' });

    expect(res.ok).toBe(true);
    expect(res.markdown).toContain('## RKS Usage Digest: Yesterday');
    // Counts derived from the 3 in-window seeded events.
    expect(res.markdown).toContain('- Total events: 3');
    expect(res.markdown).toContain('- Plans generated: 1');
    expect(res.markdown).toContain('- Executions started: 1');
    expect(res.markdown).toContain('- Executions succeeded: 1');
  });

  it('filtering witness: last-30-days includes the out-of-window distractors', async () => {
    // The pair of assertions no stub or canned string can satisfy: the same
    // fixture must yield a strictly larger total over the wider window.
    const tool = await getTool('telemetry_digest');

    const yesterday = await tool.execute({ timeframe: 'yesterday' });
    const month = await tool.execute({ timeframe: 'last-30-days' });

    expect(yesterday.markdown).toContain('- Total events: 3');
    expect(month.markdown).toContain('## RKS Usage Digest: Last 30 Days');
    expect(month.markdown).toContain('- Total events: 5');
  });

  it('defaults to yesterday when no timeframe is supplied', async () => {
    const tool = await getTool('telemetry_digest');

    const res = await tool.execute({});

    expect(res.markdown).toContain('## RKS Usage Digest: Yesterday');
    expect(res.markdown).toContain('- Total events: 3');
  });
});

describe('server.mjs handler sites — source-pinned and signature-covered', () => {
  // Deliberately NOT line-pinned: unrelated movement in server.mjs must not
  // break this, but a specifier drift must.
  const serverSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'mcp-rks', 'src', 'server.mjs'),
    'utf8',
  );

  it('still dynamically imports @routekit/telemetry/analysis', () => {
    expect(serverSrc).toMatch(
      /await\s+import\(\s*['"`]@routekit\/telemetry\/analysis['"`]\s*\)/,
    );
  });

  it('still dynamically imports @routekit/telemetry/digest', () => {
    expect(serverSrc).toMatch(/await\s+import\(\s*['"`]@routekit\/telemetry\/digest['"`]\s*\)/);
  });

  it('the providers accept the exact argument shapes server.mjs passes', async () => {
    // server.mjs calls analyzeFailure(projectRoot, input) and
    // generateDigest(projectRoot, { timeframe: input.timeframe || "yesterday" }).
    const { analyzeFailure } = await import('@routekit/telemetry/analysis');
    const { generateDigest } = await import('@routekit/telemetry/digest');

    const analysis = await analyzeFailure(projectRoot, { runId: RUN_ID });
    expect(analysis.ok).toBe(true);
    expect(analysis.analysis.category).toBe('stale_search_pattern');

    const digest = await generateDigest(projectRoot, { timeframe: 'yesterday' });
    expect(digest.events).toBe(3);
    expect(digest.timeframe).toBe('yesterday');
    expect(digest.markdown).toContain('- Total events: 3');
  });
});
