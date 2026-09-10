/**
 * Guard: triage of every consumer of a GLOBALLY MOCKED telemetry specifier.
 *
 * tests/setup.mjs installs two suite-wide mocks — the barrel `@routekit/telemetry`
 * and the subpath `@routekit/telemetry/collector` — both resolving to ONE shared
 * stub with seven methods and no internals. Any test that asserts on REAL
 * telemetry internals through that stub either fails loudly (which is cheap) or
 * PASSES VACUOUSLY, with assertions that can no longer fail (which is not).
 *
 * Three concerns, in one file:
 *
 *   1. RUNTIME stub-surface lock — the non-goal of
 *      backlog.fix.telemetry-global-mock-shadowing-sweep made executable. The stub
 *      must NOT grow real-collector internals. Asserted at runtime against the
 *      resolved module, never as a source-text scan of tests/setup.mjs: that file
 *      legitimately NAMES the internals in its explanatory comment, so a text
 *      guard would false-positive.
 *
 *   2. DATA-DRIVEN triage — the tests/ tree is walked at runtime (no hardcoded
 *      consumer list) and every consumer must carry exactly one verdict:
 *      UN-SHADOWED, or a VERDICTS entry with a non-empty reason. Fails CLOSED, so
 *      a newly added test that imports a mocked specifier goes red until triaged.
 *
 *   3. NEGATIVE CONTROL — the classifier is a pure function and is proven able to
 *      fail in both directions. `expect(untriaged).toEqual([])` on its own would
 *      pass vacuously if the walker ever enumerated nothing.
 *
 * SELF-HANDLING: concerns (1) and (2) collide by construction. Concern (1) needs
 * this file to resolve the specifier THROUGH the global mock (so no vi.unmock or
 * vi.importActual appears anywhere in this file's scope), which makes this file a
 * consumer that its own scanner enumerates. It is resolved by SELF-TRIAGE — this
 * file appears in VERDICTS below like any other consumer. It is deliberately NOT
 * excluded via a SELF constant: an exclusion would drop the file out of coverage
 * accounting, which is the opposite of what a fail-closed triage guard is for.
 *
 * (backlog.fix.telemetry-global-mock-shadowing-sweep)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TESTS_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = path.resolve(TESTS_ROOT, '..');

const BARREL = '@routekit/telemetry';
const COLLECTOR = `${BARREL}/collector`;

/** The two specifiers tests/setup.mjs mocks suite-wide. */
const GLOBALLY_MOCKED = [BARREL, COLLECTOR];

/**
 * Subpaths tests/setup.mjs does NOT mock — tests importing these resolve the real
 * modules, and must not be shadowed by a per-file mock without a stated reason.
 */
const UNMOCKED_SUBPATHS = [
  'cost',
  'cost-report',
  'reports',
  'redact',
  'storage',
  'types',
  'export',
  'query',
  'commit-story-index',
].map((s) => `${BARREL}/${s}`);

/** The exact method surface of sharedMockCollector (tests/setup.mjs). */
const STUB_SURFACE = [
  'addListener',
  'clearBuffer',
  'emit',
  'flush',
  'getBuffer',
  'setStorage',
  'startTimer',
];

// ---------------------------------------------------------------------------
// Classifier — a PURE function over source text, so it can be tested directly
// against synthetic samples (concern 3) rather than only against the real tree.
// ---------------------------------------------------------------------------

// \x60 is a backtick. Written as an escape ON PURPOSE: a bare backtick here is a
// lone unpaired one in this file's own source, and the template-literal stripper
// below would pair it with the next backtick further down, silently deleting the
// code in between — including this guard's own imports. Fail-open, and it did.
const SPECIFIER_LITERAL = /(['"\x60])(@routekit\/telemetry(?:\/[A-Za-z0-9._-]+)*)\1/g;

// What precedes the opening quote decides the FORM of the reference.
const ESCAPE_CTX = /(?:vi|vitest)\s*\.\s*(?:importActual|unmock|doUnmock)\s*\(\s*$/;
const MOCK_CTX = /(?:vi|vitest)\s*\.\s*(?:mock|doMock)\s*\(\s*$/;
const IMPORT_CTX = /(?:\bfrom\s*$|\bimport\s*\(\s*$|\brequire\s*\(\s*$)/;

/**
 * Strip the positions where a specifier can LOOK like a module reference without
 * being one: comment lines, and backtick template literals.
 *
 * The template-literal case is not hypothetical. A neighbouring guard feeds
 * fixture strings such as `import { x } from "<specifier>";` to its own pure
 * regex classifier. Lexically the inner quote is preceded by `from `, so a
 * position-blind scan calls it an import — but it is an argument to a function
 * that only runs RegExp.test(). Treating it as consumption would demand a verdict
 * asserting that file wants the stub, which is simply false, and would put the
 * verdict map at odds with the module graph.
 *
 * Line comments are only stripped for whole-line comments, never mid-line, so a
 * `//` inside a string (a URL) cannot silently swallow real code after it.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripNonCodePositions(source) {
  const withoutComments = source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  // Single-line template literals only. A multi-line span would let ONE unpaired
  // backtick anywhere in a file swallow arbitrary code below it and hide a real
  // consumer — fail-open, the one direction a triage guard must never fail. Left
  // intact, a multi-line template can at worst produce a false positive, which
  // costs a verdict entry and nothing else.
  return withoutComments.replace(/`[^`\n]*`/g, '``');
}

/**
 * Classify one file's source.
 *
 * Conservative within genuine code positions: anything in `from` / `import(` /
 * `require(` / `vi.mock(` position counts as consumption and demands a verdict.
 * Fail-closed is the right bias — an over-triaged file costs one map entry, an
 * under-triaged one costs a silent vacuous pass.
 *
 * @param {string} rawSource
 * @returns {{consumed: string[], escaped: string[], shadowedUnmocked: string[], isConsumer: boolean, isUnshadowed: boolean}}
 */
export function classifySource(rawSource) {
  const source = stripNonCodePositions(rawSource);
  const consumed = new Set();
  const escaped = new Set();
  const shadowedUnmocked = new Set();

  for (const match of source.matchAll(SPECIFIER_LITERAL)) {
    const specifier = match[2];
    const before = source.slice(Math.max(0, match.index - 48), match.index);

    if (ESCAPE_CTX.test(before)) {
      escaped.add(specifier);
      continue;
    }

    const isMockTarget = MOCK_CTX.test(before);
    if (!isMockTarget && !IMPORT_CTX.test(before)) continue; // e.g. a bare string in an assertion

    if (GLOBALLY_MOCKED.includes(specifier)) {
      consumed.add(specifier);
    } else if (isMockTarget && UNMOCKED_SUBPATHS.includes(specifier)) {
      shadowedUnmocked.add(specifier);
    }
  }

  const consumedList = [...consumed].sort();
  return {
    consumed: consumedList,
    escaped: [...escaped].sort(),
    shadowedUnmocked: [...shadowedUnmocked].sort(),
    isConsumer: consumedList.length > 0,
    // Un-shadowed only if EVERY globally mocked specifier it consumes is escaped.
    // A file that unmocks the subpath but still imports the barrel is NOT clean.
    isUnshadowed: consumedList.length > 0 && consumedList.every((s) => escaped.has(s)),
  };
}

// ---------------------------------------------------------------------------
// Runtime enumeration of the tests/ tree. No hardcoded consumer list.
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(test|spec)\.mjs$/.test(entry.name) || entry.name === 'setup.mjs') out.push(full);
  }
  return out;
}

const scanned = walk(TESTS_ROOT).map((file) => ({
  rel: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
  ...classifySource(fs.readFileSync(file, 'utf8')),
}));

const consumers = scanned.filter((f) => f.isConsumer);

/**
 * A file needs an explicit verdict when it consumes a globally mocked specifier
 * without escaping it, OR when it shadows a subpath that setup.mjs deliberately
 * leaves un-mocked. Un-shadowed consumers need nothing — the escape IS the verdict.
 */
const needsVerdict = scanned.filter(
  (f) => (f.isConsumer && !f.isUnshadowed) || f.shadowedUnmocked.length > 0,
);

// ---------------------------------------------------------------------------
// The verdict record — MOCK-BY-DESIGN entries. Every consumer that is not
// UN-SHADOWED must appear here with a non-empty reason naming what the stub
// stands in for and which REAL module carries the file's substantive assertions.
// ---------------------------------------------------------------------------

const VERDICTS = {
  'tests/setup.mjs':
    'DEFINES the two global mocks and the shared stub; it is the source of the shadowing, not a victim of it. Triaged rather than excluded so it stays inside coverage accounting.',

  'tests/unit/telemetry-global-mock-triage.test.mjs':
    'SELF: this guard intentionally resolves the stub through the global mock in order to assert the stub surface (concern 1). Escaping the mock here would defeat its own purpose. No real-module clause applies — asserting ON the stub IS the intent.',

  'tests/unit/git-release-ci-gate-fail-closed.test.mjs':
    'READS the stub deliberately — an applied CI-gate override must never be silent, so this drives the real runRelease and asserts the override reason reaches release.complete, and that a blocked release emits release.failed at all (that return previously emitted nothing and reached telemetry only by throwing). Resolves through ensureTelemetryStorage because that is the seat git-release.mjs calls; getTelemetryCollector returns a different, non-recording stub.',

  'tests/integration/exec-rollback-restores-rks-state.test.mjs':
    'READS the stub deliberately — a rolled-back exec previously emitted no terminal event at all, so this drives the real rollback() from packages/mcp-rks/src/server/test-runner.mjs and asserts exec.rollback fires carrying its reason verbatim. It resolves through ensureTelemetryStorage specifically, because that is the seat the code under test calls; getTelemetryCollector is a different stub and would read an empty array forever.',

  'tests/unit/guardrails-zero-change-no-false-ship.test.mjs':
    'READS the stub deliberately — a zero-change guardrailsOn previously reported a successful ship, so this drives the real guardrailsOff/guardrailsOn zero-change else-branch in packages/mcp-rks/src/server/guardrails-audit.mjs and asserts the nothing_to_ship / unpushedCommits outcome instead of a false ship. It resolves through ensureTelemetryStorage because that is the seat guardrails-audit.mjs calls, and its captureTelemetry helper reads the UNION of collector.addListener events and ensureTelemetryStorage().emit mock calls — which surface is live depends on the tier config, and reading both is what stops it passing vacuously under either.',

  'tests/unit/endsession-stash-flush.test.mjs':
    'READS the stub deliberately — two acceptance criteria of backlog.fix.endsession-stash-autopop-unawaited required the pop OUTCOME to reach telemetry, and neither had a test: governor.stash_pop returned zero matches across tests/ (positive control governor.init, same scope, 10 hits). The outcome ARRAY was covered; the emit an operator would actually read was not. It drives the real endSession and flushPendingStashPops from packages/mcp-rks/src/shared/governor-token.mjs and asserts BOTH polarities of the emitted event, so reading the stub IS the requirement rather than a substitute for one. It resolves through getTelemetryCollector because that is the seat emitStashPopOutcome calls, and it wraps collector.emit rather than reading emit.mock.calls, because resetTelemetryCollector is itself a no-op vi.fn() under this mock and would leave call history from every earlier file in the shard.',

  'tests/integration/story-ship-telemetry-events.test.mjs':
    'READS the stub deliberately — this is the one consumer whose assertions ARE about the emitted events. It drives the real packages/mcp-rks/src/server/story-ship.mjs runStoryShipTool and asserts story_ship.success is ABSENT and story_ship.failed PRESENT on a failed ship, because the parent story forbade proving that channel by source grep. Reading the stub IS the requirement here, not a substitute for one.',

  'tests/integration/git-release.staging-merge.test.mjs':
    'Stub stands in for ensureTelemetryStorage().emit so the CI-gate path emits without touching disk; substantive assertions target the real packages/mcp-rks/src/server/git/git-release.mjs (runStagingMerge gate/merge decisions).',

  'tests/unit/agents/research.test.mjs':
    'Stub stands in for the best-effort git-tool telemetry writer; substantive assertions target the real packages/mcp-rks/src/agents/research.mjs (rag_query fallback cascade, ResearchOutputSchema coercion). No assertion reads the stub.',

  'tests/unit/assert-tool-allowed.test.mjs':
    'Stub stands in for the process-wide collector so chain.violation emits are capturable via spyOn; substantive assertions target the real packages/mcp-rks/src/shared/governor-token.mjs (assertToolAllowed gate decisions). LATENT: :518 negative would survive a non-recording stub.',

  'tests/unit/init-telemetry.test.mjs':
    'Stub stands in for getTelemetryCollector().emit so init.start/complete/failed payloads are inspectable; substantive assertions target the real packages/mcp-rks/src/server/init.mjs (runInitTool lifecycle ordering). LATENT: :168 negative would survive a non-recording stub.',

  'tests/unit/llm-clients.test.mjs':
    'Stub stands in for the process-wide collector to capture the llm.token_usage payload; substantive assertions target the real packages/mcp-rks/src/llm/clients.mjs (payload shape, cache_control) and the real packages/telemetry/src/cost.mjs. LATENT: :349 negative would survive a non-recording stub.',

  'tests/unit/offrail-ship-reconcile-to-integrated.test.mjs':
    'Stub stands in for ensureTelemetryStorage().emit so phase-advance hops emit nowhere; substantive assertions target the real packages/mcp-rks/src/workflow/auto-phase.mjs (reconcileToIntegrated ladder) and workflow/phases.mjs. No assertion reads the stub.',

  'tests/unit/onrail-ship-reconcile-executing.test.mjs':
    'Stub stands in for ensureTelemetryStorage().emit so advancePhase emits nowhere; substantive assertions target the real packages/mcp-rks/src/workflow/auto-phase.mjs (reconcileExecutingBeforeShip) and workflow/phases.mjs. No assertion reads the stub.',

  'tests/unit/plan-exec-telemetry-lifecycle.test.mjs':
    'Barrel half only: stub is a passive emit sink the test wraps to record event types, with substantive assertions against the real packages/mcp-rks/src/server/planner-llm.mjs. The half that asserts REAL collector internals already escapes via vi.importActual at :102-103.',

  'tests/unit/pr-body-cost-report.test.mjs':
    'Stub stands in for ensureTelemetryStorage().emit so PR creation emits nowhere; substantive assertions target the real packages/mcp-rks/src/server/git/git-workflow.mjs (runGitPR body construction). Also mocks the un-globally-mocked /cost-report subpath at :31 — deliberate, injected-value tests only.',

  'tests/unit/refine-projectid-telemetry.test.mjs':
    'Stub stands in for getTelemetryCollector().emit so the projectId positional arg of each refine.* event is inspectable; substantive assertions target the real packages/mcp-rks/src/server/refine.mjs (runRefineTool projectId threading). Guarded by positive length checks.',

  'tests/unit/server/rks-agent-research.test.mjs':
    'Stub records agent.research.* emissions into a local array. NOTE: the code under test is a test-local reimplementation, so no real module carries its assertions — a separate coverage defect, not a shadowing one. LATENT: :87 and :96 negatives would survive a non-recording stub.',

  'tests/unit/token-cost-emitter-reader-seam.test.mjs':
    'Stub is a capture point for the third emit arg; substantive assertions target the real packages/mcp-rks/src/llm/clients.mjs payload fed verbatim through the real packages/telemetry/src/cost-report.mjs. Hard-guarded at :69-71, so a non-recording stub reddens it.',

  'tests/unit/workflow/auto-analyze.spec.mjs':
    'Stub stands in for getTelemetryCollector().emit as a silent sink; substantive assertions target the real packages/mcp-rks/src/workflow/auto-analyze.mjs (runAutoAnalyze result mapping, shouldSkipAnalysis). No assertion reads the stub.',

  'tests/unit/workflow/auto-phase.spec.mjs':
    'Effective stub is the global barrel ensureTelemetryStorage(); substantive assertions target the real packages/mcp-rks/src/workflow/auto-phase.mjs (advancePhase transitions). NOTE: its own /collector mock at :18 is dead — the SUT imports only from the barrel.',

  'tests/unit/dashboard-token-cost.test.mjs':
    'Not a globally-mocked-specifier consumer; listed because it shadows the un-globally-mocked /cost-report subpath. Deliberate: it injects generateCostReport return values to exercise the real scripts/telemetry dashboard reader.',
};

// Consumed with LITERAL specifiers, deliberately. Importing via the constants
// above would hide this file from its own scanner and make the self-triage entry
// in VERDICTS stale — dodging the collision instead of resolving it. The whole
// point of self-triage is that the collision is real and accounted for.
const collectorMod = await import('@routekit/telemetry/collector');
const barrelMod = await import('@routekit/telemetry');

describe('global @routekit/telemetry mock — stub surface lock', () => {
  it('resolves the STUB (not the real module) and its surface has not grown', () => {
    const stub = collectorMod.getTelemetryCollector();

    expect(Object.keys(stub).sort()).toEqual(STUB_SURFACE);
    expect(stub._scheduleFlush).toBeUndefined();
    expect(stub._flushTimer).toBeUndefined();
  });

  it('barrel and subpath return the SAME collector instance', () => {
    expect(barrelMod.getTelemetryCollector()).toBe(collectorMod.getTelemetryCollector());
  });
});

describe('global @routekit/telemetry mock — consumer triage', () => {
  it('enumerates consumers by walking the tests/ tree at runtime', () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(consumers.length).toBeGreaterThan(0);
  });

  it('every consumer carries exactly one verdict — UN-SHADOWED or a reasoned map entry', () => {
    const untriaged = needsVerdict
      .filter((f) => !VERDICTS[f.rel])
      .map((f) => `${f.rel} (consumes ${f.consumed.join(', ') || 'nothing globally mocked'})`);

    expect(untriaged).toEqual([]);
  });

  it('no verdict entry is an empty or placeholder reason', () => {
    for (const [file, reason] of Object.entries(VERDICTS)) {
      expect(reason.trim().length, `${file} has an empty verdict reason`).toBeGreaterThan(40);
    }
  });

  it('no verdict entry is stale — every triaged file still needs its verdict', () => {
    const stale = Object.keys(VERDICTS).filter((rel) => !needsVerdict.some((f) => f.rel === rel));

    expect(stale).toEqual([]);
  });

  it('no per-file vi.mock shadows an un-mocked subpath without a reason', () => {
    const shadowed = scanned
      .filter((f) => f.shadowedUnmocked.length > 0 && !VERDICTS[f.rel])
      .map((f) => `${f.rel} (mocks ${f.shadowedUnmocked.join(', ')})`);

    expect(shadowed).toEqual([]);
  });
});

describe('global @routekit/telemetry mock — coverage floor', () => {
  // The enumeration above is discovered at runtime; this list is NOT the source
  // of the enumeration, only a floor under it. It is the set confirmed complete
  // by governed exhaustive search at anchor @43403aa3, across all three quote
  // styles plus vi.mock targets. If the walker or the classifier ever regresses
  // into matching less, this fails.
  const COVERAGE_FLOOR = [
    'tests/integration/git-release.staging-merge.test.mjs',
    'tests/unit/agents/research.test.mjs',
    'tests/unit/assert-tool-allowed.test.mjs',
    'tests/unit/init-telemetry.test.mjs',
    'tests/unit/llm-clients.test.mjs',
    'tests/unit/offrail-ship-reconcile-to-integrated.test.mjs',
    'tests/unit/onrail-ship-reconcile-executing.test.mjs',
    'tests/unit/plan-exec-telemetry-lifecycle.test.mjs',
    'tests/unit/pr-body-cost-report.test.mjs',
    'tests/unit/refine-projectid-telemetry.test.mjs',
    'tests/unit/server/rks-agent-research.test.mjs',
    'tests/unit/telemetry-collector.test.mjs',
    'tests/unit/telemetry-import-redirect.test.mjs',
    'tests/unit/token-cost-emitter-reader-seam.test.mjs',
    'tests/unit/workflow/auto-analyze.spec.mjs',
    'tests/unit/workflow/auto-phase.spec.mjs',
  ];

  it('enumeration covers every file in the confirmed floor', () => {
    const missed = COVERAGE_FLOOR.filter((rel) => {
      const found = scanned.find((f) => f.rel === rel);
      return !found || (!found.isConsumer && found.escaped.length === 0);
    });

    expect(missed).toEqual([]);
  });
});

describe('global @routekit/telemetry mock — classifier negative control', () => {
  // Proves the guard CAN fail. Without this, the triage assertions above would
  // pass vacuously if the walker or the classifier silently matched nothing.

  it('flags an untriaged import of a globally mocked specifier', () => {
    const verdict = classifySource(`import { getTelemetryCollector } from "${COLLECTOR}";`);

    expect(verdict.isConsumer).toBe(true);
    expect(verdict.isUnshadowed).toBe(false);
    expect(verdict.consumed).toEqual([COLLECTOR]);
  });

  it('flags an untriaged vi.mock target', () => {
    const verdict = classifySource(`vi.mock('${BARREL}', () => ({}));`);

    expect(verdict.isConsumer).toBe(true);
    expect(verdict.isUnshadowed).toBe(false);
  });

  it('passes a file that escapes via vi.importActual', () => {
    const verdict = classifySource(
      `const m = await vi.importActual("${COLLECTOR}");\nimport x from "${COLLECTOR}";`,
    );

    expect(verdict.isUnshadowed).toBe(true);
  });

  it('passes a file that escapes via vi.unmock', () => {
    const verdict = classifySource(`vi.unmock('${BARREL}');\nimport y from '${BARREL}';`);

    expect(verdict.isUnshadowed).toBe(true);
  });

  it('does NOT treat a bare quoted specifier in an assertion as consumption', () => {
    const verdict = classifySource(`expect(src).toContain("${COLLECTOR}");`);

    expect(verdict.isConsumer).toBe(false);
  });

  it('does NOT treat an import-shaped FIXTURE STRING as consumption', () => {
    // The regression that this scanner originally got wrong: a neighbouring
    // guard passes import-shaped text to its own regex classifier. Built by
    // concatenation so the fixture genuinely contains backticks at runtime.
    const nested = 'expect(kinds(`import { x } from "' + COLLECTOR + '";`)).toEqual([]);';
    const verdict = classifySource(nested);

    expect(verdict.isConsumer).toBe(false);
  });

  it('does NOT treat a commented-out import or vi.mock as consumption', () => {
    expect(classifySource(`// import x from '${BARREL}';`).isConsumer).toBe(false);
    expect(classifySource(` * vi.mock('${COLLECTOR}') is installed suite-wide`).isConsumer).toBe(
      false,
    );
  });

  it('still flags a real import on a line that also carries a trailing URL comment', () => {
    // Guards the stripper against over-reach: only WHOLE-line comments are
    // removed, so a `//` inside or after code cannot swallow a real reference.
    const verdict = classifySource(`import { c } from "${COLLECTOR}"; // see https://x/y`);

    expect(verdict.isConsumer).toBe(true);
  });

  it('does NOT treat an escape of one specifier as covering the other', () => {
    const verdict = classifySource(
      `vi.unmock("${COLLECTOR}");\nimport a from "${COLLECTOR}";\nimport b from "${BARREL}";`,
    );

    expect(verdict.isConsumer).toBe(true);
    expect(verdict.isUnshadowed).toBe(false);
  });

  it('detects a per-file mock of an un-mocked subpath', () => {
    const verdict = classifySource(`vi.mock("${BARREL}/redact", () => ({}));`);

    expect(verdict.shadowedUnmocked).toEqual([`${BARREL}/redact`]);
  });
});
