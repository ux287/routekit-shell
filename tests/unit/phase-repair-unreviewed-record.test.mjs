/**
 * backlog.fix.phase-repair-records-unreviewed-remainder
 *
 * When an off-rail ship is suppressed with ac_coverage_truncated_diff, what no review call saw
 * must survive to the repaired story. The suppression outcome, the advance_phase ship step and
 * response.phaseAdvanceSuppressed carry the server-measured truncation; a flat record is
 * persisted at <root>/.rks/state/truncated-review/<storyId>.json; repairPhaseToIntegrated reads
 * it back with a filesystem read; and the rks_phase_repair handler writes it onto the story
 * frontmatter, its commit message body, its result and telemetry, then deletes the record only
 * after the frontmatter write AND the note commit both succeed.
 *
 * Truncated fixtures go through the REAL runReview (reviewer model mocked) over a diff longer
 * than REVIEW_MAX_CALLS * REVIEW_DIFF_CHAR_CAP, both imported from review.mjs, and the expected
 * values are that call's result.diffTruncation. Repair fixtures are real git repositories with
 * a bare remote; every git spawn passes an explicit timeout.
 *
 * Telemetry: this file mocks the collector subpath with a local emit spy and escapes the
 * global-mock triage with vi.importActual("@routekit/telemetry/collector") in the telemetry
 * case, which asserts the handler's emit route is a real export (the
 * tests/unit/server-handler-governance.test.mjs GV-TR14 precedent).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const GIT_TIMEOUT_MS = 120_000;

const h = vi.hoisted(() => ({
  chat: vi.fn(),
  emit: vi.fn(),
  failNoteWrite: false,
  reviewRoot: null,
  reviewDiff: '',
  reviewNames: '',
  repairRoot: null,
  integrationBranch: 'staging',
}));

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', () => ({
  loadEnv: vi.fn(() => ({ anthropicKey: 'test-key-not-a-real-credential' })),
  createAnthropicClient: vi.fn(() => ({ stub: true })),
  callAnthropicChat: (...args) => h.chat(...args),
  DEFAULT_LLM_TIMEOUT_MS: 30_000,
}));

vi.mock('../../packages/mcp-rks/src/server/project.mjs', async (io) => ({
  ...(await io()),
  loadContext: vi.fn(async (projectId) => ({
    record: { id: projectId, root: projectId === 'review-fixture' ? h.reviewRoot : h.repairRoot },
    projectJson: {},
  })),
  getBranchConfig: vi.fn(() => ({ integration: h.integrationBranch })),
}));

vi.mock('@routekit/rag', () => ({ runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })) }));

// Pass-through, except git calls whose cwd is the REVIEW fixture root: those serve the fixture
// diff to runReview. Every other git call (the repair fixtures) reaches the real git.
const fakeOrReal = (actual) => (cmd, args = [], opts = {}) => {
  if (h.reviewRoot && opts && opts.cwd === h.reviewRoot && cmd === 'git') {
    if (args[0] === 'log') return { stdout: '', stderr: '', status: 0 };
    if (args.includes('--name-only')) return { stdout: h.reviewNames, stderr: '', status: 0 };
    return { stdout: h.reviewDiff, stderr: '', status: 0 };
  }
  return actual.spawnSync(cmd, args, opts);
};
vi.mock('child_process', async (io) => {
  const actual = await io();
  return { ...actual, spawnSync: fakeOrReal(actual), default: { ...actual, spawnSync: fakeOrReal(actual) } };
});
vi.mock('node:child_process', async (io) => {
  const actual = await io();
  return { ...actual, spawnSync: fakeOrReal(actual), default: { ...actual, spawnSync: fakeOrReal(actual) } };
});

vi.mock('../../packages/mcp-rks/src/dendron.mjs', async (io) => {
  const real = await io();
  return {
    ...real,
    writeNoteRaw: (...args) => {
      if (h.failNoteWrite) throw new Error('simulated frontmatter write failure');
      return real.writeNoteRaw(...args);
    },
  };
});

vi.mock('@routekit/telemetry/collector', () => ({
  getTelemetryCollector: () => ({ emit: h.emit }),
  TelemetryCollector: vi.fn(),
  resetTelemetryCollector: vi.fn(),
}));

const { execFileSync } = await import('node:child_process');
const { runReview, redactReview, computeDiffTruncation, REVIEW_DIFF_CHAR_CAP, REVIEW_MAX_CALLS } = await import(
  '../../packages/mcp-rks/src/server/review.mjs'
);
const {
  resolvePhaseAdvanceSuppression,
  buildOffRailReviewStep,
  runOffRailEnforcementGate,
  writeTruncatedReviewRecord,
  clearTruncatedReviewRecordAfterGateBeta,
} = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');
const { repairPhaseToIntegrated } = await import('../../packages/mcp-rks/src/workflow/auto-phase.mjs');
const { createHandlerRegistry } = await import('../../packages/mcp-rks/src/server/handlers/registry.mjs');
const { registerGovernanceHandlers } = await import('../../packages/mcp-rks/src/server/handlers/governance.mjs');
const { parseFrontmatter } = await import('../../packages/mcp-rks/src/dendron.mjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');
const GUARDRAILS_ON = AUDIT_SRC.slice(AUDIT_SRC.indexOf('export async function guardrailsOn('));

const REVIEW_STORY = 'backlog.fix.review-fixture-story';
const COMMIT_SUBJECT = (id) => `chore(story): advance ${id} to integrated (rks_phase_repair)`;
const TRUNCATION_KEYS = ['unseenFiles', 'partialFile', 'partialFiles', 'originalChars', 'includedChars'];

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const roots = [];
afterEach(() => {
  h.failNoteWrite = false;
  h.integrationBranch = 'staging';
  h.emit.mockReset();
  h.chat.mockReset();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function mkRoot(prefix) {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(r);
  return r;
}

/** A real REVIEW fixture root holding the story note runReview reads its criteria from. */
function setupReviewRoot() {
  const r = mkRoot('rks-unreviewed-review-');
  fs.mkdirSync(path.join(r, 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(r, 'notes', `${REVIEW_STORY}.md`),
    `---\nid: "${REVIEW_STORY}"\ntitle: "Review fixture"\ncreated: 1\nupdated: 2\nphase: "executing"\n---\n\n` +
      '# Review fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n',
  );
  h.reviewRoot = r;
  return r;
}

const LINE = 'a'.repeat(99);
function fileDiff(file, lines) {
  return (
    [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines} @@`,
      ...Array.from({ length: lines }, () => `+${LINE}`),
    ].join('\n') + '\n'
  );
}
const BIG_LINES = Math.ceil((REVIEW_DIFF_CHAR_CAP * 1.2) / (LINE.length + 2));
const SMALL_LINES = Math.floor((REVIEW_DIFF_CHAR_CAP * 0.85) / (LINE.length + 2));

/**
 * `cutCount` file sections each longer than REVIEW_DIFF_CHAR_CAP come first (so all fall inside
 * the first REVIEW_MAX_CALLS calls), then whole sections are added until the diff is longer than
 * REVIEW_MAX_CALLS * REVIEW_DIFF_CHAR_CAP and has more sections than calls.
 */
function buildOverBoundDiff(cutCount) {
  const files = [];
  const parts = [];
  for (let i = 0; i < cutCount; i++) {
    files.push(`src/cut-${i + 1}.mjs`);
    parts.push(fileDiff(files[files.length - 1], BIG_LINES));
  }
  let i = 0;
  while (parts.join('').length <= REVIEW_MAX_CALLS * REVIEW_DIFF_CHAR_CAP || parts.length <= REVIEW_MAX_CALLS) {
    files.push(`src/whole-${++i}.mjs`);
    parts.push(fileDiff(files[files.length - 1], SMALL_LINES));
  }
  return { diff: parts.join(''), files };
}

const COVERED_RESPONSE = (extra = {}) =>
  JSON.stringify({
    verdict: 'pass',
    summary: 'looks fine',
    findings: [],
    acCoverage: { assessed: true, covered: ['AC1 does a thing', 'AC2 does another'], notCovered: [], uncertain: [] },
    ...extra,
  });

/** The real runReview over a fixture diff, then the step the gate builds from it. */
async function reviewOver(diff, files, response = COVERED_RESPONSE()) {
  setupReviewRoot();
  h.reviewDiff = diff;
  h.reviewNames = files.join('\n') + '\n';
  h.chat.mockResolvedValue(response);
  const result = await runReview({ projectId: 'review-fixture', problemId: REVIEW_STORY, branch: 'staging', targetBranch: 'abc1234' });
  const step = buildOffRailReviewStep(redactReview(result));
  return { result, step, outcome: resolvePhaseAdvanceSuppression(step) };
}

let twoCutCache = null;
async function twoCutReview() {
  if (twoCutCache) return twoCutCache;
  const { diff, files } = buildOverBoundDiff(2);
  const r = await reviewOver(diff, files);
  twoCutCache = { diff, files, ...r };
  return twoCutCache;
}

const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });

/** A real repair root: story note committed, a `Story:` trailer commit, pushed to a bare origin. */
function setupRepairRoot(id, { phase = 'arch-approved', trailer = true, note = true } = {}) {
  const r = mkRoot('rks-unreviewed-repair-');
  const remote = mkRoot('rks-unreviewed-remote-');
  g(remote, ['init', '--bare', '-b', 'staging']);
  g(r, ['init', '-b', 'staging']);
  g(r, ['config', 'user.email', 't@t']);
  g(r, ['config', 'user.name', 't']);
  g(r, ['config', 'commit.gpgsign', 'false']);
  g(r, ['remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(r, 'notes'), { recursive: true });
  if (note) {
    fs.writeFileSync(
      path.join(r, 'notes', `${id}.md`),
      `---\nid: "${id}"\ntitle: "T"\ncreated: 1\nupdated: 2\nphase: "${phase}"\n---\n\n## Problem\n\nbody\n`,
    );
  }
  fs.writeFileSync(path.join(r, 'README.md'), 'fixture\n');
  g(r, ['add', '-A']);
  g(r, ['commit', '-m', 'chore: fixture base']);
  let sha = null;
  if (trailer) {
    fs.writeFileSync(path.join(r, 'src.mjs'), '// work\n');
    g(r, ['add', '-A']);
    g(r, ['commit', '-m', `feat(off-rail): work\n\nSession: abc\nStory: ${id}`]);
    sha = g(r, ['rev-parse', 'HEAD']).trim();
  }
  g(r, ['push', '-u', 'origin', 'staging']);
  h.repairRoot = r;
  return { root: r, remote, sha };
}

const recordPath = (root, id) => path.join(root, '.rks', 'state', 'truncated-review', `${id}.json`);
const notePath = (root, id) => path.join(root, 'notes', `${id}.md`);
const archivedPath = (root, id) => notePath(root, id.replace(/^backlog\./, 'backlog.z_implemented.'));
const fmOf = (p) => parseFrontmatter(fs.readFileSync(p, 'utf8')).data;

function govRegistry() {
  const r = createHandlerRegistry();
  const pass = () => z.object({}).passthrough();
  registerGovernanceHandlers(
    r,
    {
      guardrailsOffSchema: pass(), guardrailsOnSchema: pass(), guardrailsAbortSchema: pass(), guardrailsStatusSchema: pass(),
      phaseRepairSchema: pass(), archVerdictSchema: pass(), governorInitSchema: pass(), governorEndSchema: pass(),
    },
    {
      getDendronContext: vi.fn(), assertNotesDir: vi.fn(), notePathFromFilename: vi.fn(),
      commitDendronWriteResult: vi.fn(), reconcileActiveScopeOnInit: vi.fn(),
    },
  );
  return async (args) => {
    const res = await r.lookupHandler('rks_phase_repair')(args, Object.freeze({ tool: 'rks_phase_repair', args }));
    return JSON.parse(res.content[0].text);
  };
}

/** A two-cut-file record persisted for `id` at the repair root, as the suppression path writes it. */
async function persistTwoCutRecord(root, id) {
  const { outcome } = await twoCutReview();
  const w = writeTruncatedReviewRecord(root, id, outcome, { reviewedFrom: 'fromsha', reviewedTo: 'tosha' });
  expect(w.ok).toBe(true);
  return JSON.parse(fs.readFileSync(recordPath(root, id), 'utf8'));
}

/** Evaluate the real advance_phase literal from source (tests/unit/ac-coverage-phase-advance-gate.test.mjs). */
const evalShipStep = (suppression) => {
  const branchIdx = AUDIT_SRC.indexOf('if (advanceSuppression) {');
  const pushIdx = AUDIT_SRC.indexOf('shipSteps.push({', branchIdx);
  const closeIdx = AUDIT_SRC.indexOf('});', pushIdx);
  const literal = AUDIT_SRC.slice(pushIdx + 'shipSteps.push('.length, closeIdx + 1);
  expect(literal.trimStart().startsWith('{')).toBe(true);
  expect(literal.trimEnd().endsWith('}')).toBe(true);
  return new Function('advanceSuppression', `return (${literal});`)(suppression);
};
/** Evaluate the real response.phaseAdvanceSuppressed literal from source. */
const evalResponseEnvelope = (suppression) => {
  const assignIdx = GUARDRAILS_ON.indexOf('response.phaseAdvanceSuppressed = {');
  const openIdx = GUARDRAILS_ON.indexOf('{', assignIdx);
  const closeIdx = GUARDRAILS_ON.indexOf('};', openIdx);
  const literal = GUARDRAILS_ON.slice(openIdx, closeIdx + 1);
  expect(literal.trimEnd().endsWith('}')).toBe(true);
  return new Function('advanceSuppression', `return (${literal});`)(suppression);
};

const truncatedStep = (diffTruncation) => ({
  step: 'review',
  ok: true,
  verdict: 'pass',
  findingCount: 0,
  diffTruncation: { truncated: true, ...diffTruncation },
  acCoverage: { covered: [], notCovered: [], uncertain: [], assessed: false, assessable: false },
});

// ---------------------------------------------------------------------------------------------

describe('phase-repair unreviewed record', () => {
  it('rule 3a outcome carries the runReview result diffTruncation measurements', async () => {
    const { diff, result, outcome } = await twoCutReview();
    expect(diff.length).toBeGreaterThan(REVIEW_MAX_CALLS * REVIEW_DIFF_CHAR_CAP);
    const t = result.diffTruncation;
    expect(t.truncated).toBe(true);
    expect(t.partialFiles.length).toBeGreaterThanOrEqual(2);

    expect(outcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(outcome.unseenFiles).toEqual(t.unseenFiles);
    expect(outcome.unseenFiles.length).toBeGreaterThan(0);
    expect(outcome.partialFile.file).toBe(t.partialFile.file);
    expect(outcome.partialFile.lastIncludedLine).toBe(t.partialFile.lastIncludedLine);
    expect(outcome.partialFiles.length).toBeGreaterThanOrEqual(2);
    expect(outcome.partialFiles).toEqual(t.partialFiles);
    outcome.partialFiles.forEach((p, i) => {
      expect(p.file).toBe(t.partialFiles[i].file);
      expect(p.lastIncludedLine).toBe(t.partialFiles[i].lastIncludedLine);
    });
    expect(outcome.originalChars).toBe(t.originalChars);
    expect(outcome.includedChars).toBe(t.includedChars);

    // Not a fresh single-cap computation over the full diff.
    const fresh = computeDiffTruncation(diff);
    expect(outcome.includedChars).not.toBe(fresh.includedChars);
    expect(outcome.unseenFiles).not.toEqual(fresh.unseenFiles);
  });

  it('advance_phase step and response envelope expose the truncation measurements', () => {
    const outcome = resolvePhaseAdvanceSuppression(
      truncatedStep({
        originalChars: 260000,
        includedChars: 190000,
        unseenFiles: ['src/never-a.mjs', 'src/never-b.mjs'],
        partialFile: { file: 'src/cut-1.mjs', lastIncludedLine: 490 },
        partialFiles: [
          { file: 'src/cut-1.mjs', lastIncludedLine: 490 },
          { file: 'src/cut-2.mjs', lastIncludedLine: 488 },
        ],
      }),
    );
    expect(outcome.partialFiles).toHaveLength(2);
    for (const evaluated of [evalShipStep(outcome), evalResponseEnvelope(outcome)]) {
      for (const k of TRUNCATION_KEYS) expect(evaluated[k], k).toEqual(outcome[k]);
      expect(evaluated.reason).toBe(outcome.reason);
      expect(evaluated.remedy).toBe(outcome.remedy);
    }
    expect(evalShipStep(outcome).step).toBe('advance_phase');
    expect(evalShipStep(outcome).skipped).toBe(true);
  });

  it('other suppression reasons carry no truncation keys', () => {
    const cov = (c) => ({ step: 'review', ok: true, verdict: 'pass', findingCount: 0, acCoverage: { assessed: true, covered: [], notCovered: [], uncertain: [], ...c } });
    const cases = [
      ['ac_not_covered', resolvePhaseAdvanceSuppression(cov({ notCovered: ['AC1'] })), ['reason', 'remedy']],
      ['ac_coverage_uncertain', resolvePhaseAdvanceSuppression(cov({ uncertain: ['AC1'] })), ['reason', 'remedy']],
      ['ac_coverage_not_assessed', resolvePhaseAdvanceSuppression(undefined), ['reason', 'remedy']],
      [
        'block_severity_finding',
        resolvePhaseAdvanceSuppression({ step: 'review', findings: [{ severity: 'block', category: 'ac_coverage' }] }),
        ['categories', 'findingCount', 'reason'],
      ],
    ];
    for (const [name, outcome, outcomeKeys] of cases) {
      expect(outcome.reason, name).toMatch(new RegExp(`\\b${name}\\b`));
      expect(Object.keys(outcome).sort(), name).toEqual(outcomeKeys);
      const step = evalShipStep(outcome);
      const envelope = evalResponseEnvelope(outcome);
      for (const k of TRUNCATION_KEYS) {
        expect(k in outcome, `${name} outcome ${k}`).toBe(false);
        expect(k in step, `${name} step ${k}`).toBe(false);
        expect(k in envelope, `${name} envelope ${k}`).toBe(false);
      }
      expect(step).toEqual({
        step: 'advance_phase',
        skipped: true,
        reason: outcome.reason,
        ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
      });
      expect(envelope).toEqual({
        reason: outcome.reason,
        ...(outcome.categories ? { categories: outcome.categories } : {}),
        ...(outcome.findingCount !== undefined ? { findingCount: outcome.findingCount } : {}),
        ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
      });
    }
    // The legacy cause keeps its exact three keys.
    expect(Object.keys(evalShipStep(cases[3][1])).sort()).toEqual(['reason', 'skipped', 'step']);
  });

  it('persisted record is read by repairPhaseToIntegrated in a fresh module instance', async () => {
    // The suppression branch persists through writeTruncatedReviewRecord with the session range.
    expect(GUARDRAILS_ON).toContain('writeTruncatedReviewRecord(projectRoot, activeSession.problemId, advanceSuppression, {');
    const id = 'backlog.fix.fresh-instance';
    const { root } = setupRepairRoot(id);
    const record = await persistTwoCutRecord(root, id);
    expect(record.storyId).toBe(id);

    vi.resetModules();
    const fresh = await import('../../packages/mcp-rks/src/workflow/auto-phase.mjs');
    const res = await fresh.repairPhaseToIntegrated(root, id, 'p', { integrationBranch: 'staging' });
    expect(res.repaired).toBe(true);
    expect(res.reviewRecord).toEqual({
      ...record,
      status: 'truncated_review',
      recordFile: path.join('.rks', 'state', 'truncated-review', `${id}.json`),
    });
  });

  it('handler writes the record onto the story and it survives the archive rename', async () => {
    const id = 'backlog.fix.handler-writes';
    const { root, sha } = setupRepairRoot(id);
    const record = await persistTwoCutRecord(root, id);
    expect(record.partialFiles.length).toBeGreaterThanOrEqual(2);

    const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
    expect(res.repaired).toBe(true);
    expect(res.reviewRecordWrite.ok).toBe(true);
    expect(res.archive.archived).toBe(true);
    expect(fs.existsSync(notePath(root, id))).toBe(false);

    const fm = fmOf(archivedPath(root, id));
    expect(fm.id).toBe(id.replace(/^backlog\./, 'backlog.z_implemented.'));
    expect(fm.phase).toBe('integrated');
    expect(fm.review_never_reviewed_files).toEqual(record.unseenFiles);
    expect(fm.review_partial_file).toBe(record.partialFile);
    expect(fm.review_partial_file_last_line).toBe(record.partialFileLastIncludedLine);
    expect(fm.review_partial_files).toEqual(record.partialFiles);
    expect(fm.review_partial_files).toEqual(
      (await twoCutReview()).result.diffTruncation.partialFiles.map((p) => `${p.file}:${p.lastIncludedLine}`),
    );
    expect(fm.review_suppression_reason).toBe(record.reason);
    expect(fm.review_advance).toBe('operator_acceptance_via_rks_phase_repair');
    expect(fm.review_evidence_commit).toBe(sha);
    // Flat: every review_* value is a scalar or an array of strings.
    for (const [k, v] of Object.entries(fm).filter(([k]) => k.startsWith('review_'))) {
      if (Array.isArray(v)) for (const x of v) expect(typeof x, k).toBe('string');
      else expect(['string', 'number', 'boolean'], k).toContain(typeof v);
    }
    // The committed archive holds the same values.
    const committed = g(root, ['show', `HEAD:notes/${path.basename(archivedPath(root, id))}`]);
    expect(parseFrontmatter(committed).data.review_partial_files).toEqual(record.partialFiles);
  });

  it('result payload and commit message name the same never-reviewed files', async () => {
    const id = 'backlog.fix.payload-and-message';
    const { root } = setupRepairRoot(id);
    const record = await persistTwoCutRecord(root, id);

    const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
    expect(res.note.ok).toBe(true);
    const message = g(root, ['log', '-1', '--format=%B', 'staging']);
    const [firstLine] = message.split('\n');
    expect(firstLine).toBe(COMMIT_SUBJECT(id));
    expect(message).not.toMatch(new RegExp(`^\\s*Story: ${id.replace(/\./g, '\\.')}\\s*$`, 'm'));
    expect(res.reviewRecord.unseenFiles).toEqual(record.unseenFiles);
    expect(res.reviewRecord.partialFiles).toEqual(record.partialFiles);
    for (const f of record.unseenFiles) expect(message).toContain(f);
    for (const p of record.partialFiles) expect(message).toContain(p);
    for (const f of res.reviewRecord.unseenFiles) expect(message).toContain(f);
    for (const p of res.reviewRecord.partialFiles) expect(message).toContain(p);
    // The pushed remote holds the same commit.
    expect(g(root, ['rev-parse', 'origin/staging']).trim()).toBe(g(root, ['rev-parse', 'staging']).trim());
  });

  it('handler emits telemetry naming the never-reviewed files', async () => {
    // The handler's emit route is a real export of the collector module this file mocks.
    const realCollector = await vi.importActual('@routekit/telemetry/collector');
    expect(typeof realCollector.getTelemetryCollector).toBe('function');

    const id = 'backlog.fix.handler-telemetry';
    const { root } = setupRepairRoot(id);
    await persistTwoCutRecord(root, id);
    const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });

    const events = h.emit.mock.calls.filter((c) => c[0] === 'phase.repair.review_record');
    expect(events).toHaveLength(1);
    const [, projectId, payload] = events[0];
    expect(projectId).toBe('repair-fixture');
    expect(payload.storyId).toBe(id);
    expect(payload.reviewRecord).toBe('truncated_review');
    expect(payload.neverReviewedFiles).toEqual(res.reviewRecord.unseenFiles);
    expect(payload.partialFiles).toEqual(res.reviewRecord.partialFiles);
    expect(payload.partialFiles.length).toBeGreaterThanOrEqual(2);
    expect(payload.suppressionReason).toBe(res.reviewRecord.reason);
  });

  it('no record yields an explicit no-review-record marker and no reviewed field', async () => {
    const id = 'backlog.fix.no-record';
    const { root } = setupRepairRoot(id);
    expect(fs.existsSync(recordPath(root, id))).toBe(false);

    const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
    expect(res.repaired).toBe(true);
    expect(res.reviewRecord.status).toBe('no_review_record');
    expect('reviewRecordWrite' in res).toBe(false);
    const fm = fmOf(archivedPath(root, id));
    expect(Object.keys(fm).filter((k) => /review/i.test(k))).toEqual([]);
    // The no-record commit message is the subject alone (plus the provenance trailer).
    const message = g(root, ['log', '-1', '--format=%B', 'staging']);
    expect(message.split('\n')[0]).toBe(COMMIT_SUBJECT(id));
    expect(message).not.toMatch(/never reviewed/i);

    // And repairPhaseToIntegrated alone returns the marker.
    const id2 = 'backlog.fix.no-record-direct';
    const { root: root2 } = setupRepairRoot(id2);
    const direct = await repairPhaseToIntegrated(root2, id2, 'p', { integrationBranch: 'staging' });
    expect(direct.reviewRecord.status).toBe('no_review_record');
    expect(Object.keys(fmOf(notePath(root2, id2))).filter((k) => /review/i.test(k))).toEqual([]);
  });

  /** One repair fixture per existing refusal, each holding a record. */
  async function refusalFixtures() {
    const out = [];
    {
      const id = 'backlog.fix.refuse-not-found';
      const { root } = setupRepairRoot(id, { note: false });
      out.push({ id, root, reason: 'story_not_found' });
    }
    {
      const id = 'backlog.fix.refuse-ladder';
      const { root } = setupRepairRoot(id, { phase: 'draft' });
      out.push({ id, root, reason: 'phase_not_on_off_rail_ladder' });
    }
    {
      const id = 'backlog.fix.refuse-unreadable';
      const { root } = setupRepairRoot(id);
      out.push({ id, root, reason: 'evidence_unreadable', integrationBranch: 'no-such-branch' });
    }
    {
      const id = 'backlog.fix.refuse-no-commit';
      const { root } = setupRepairRoot(id, { trailer: false });
      out.push({ id, root, reason: 'no_merged_commit_for_story' });
    }
    {
      const id = 'backlog.fix.refuse-advanced';
      const { root } = setupRepairRoot(id, { phase: 'integrated' });
      out.push({ id, root, reason: 'already_advanced' });
    }
    for (const f of out) await persistTwoCutRecord(f.root, f.id);
    return out;
  }

  it('existing refusals are unchanged and write no review-record field', async () => {
    for (const f of await refusalFixtures()) {
      const noteBefore = fs.existsSync(notePath(f.root, f.id)) ? fs.readFileSync(notePath(f.root, f.id)) : null;
      const direct = await repairPhaseToIntegrated(f.root, f.id, 'p', { integrationBranch: f.integrationBranch ?? 'staging' });
      expect(direct.reason, f.reason).toBe(f.reason);
      expect(direct.repaired).toBe(false);
      expect('reviewRecord' in direct, f.reason).toBe(false);

      h.repairRoot = f.root;
      h.integrationBranch = f.integrationBranch ?? 'staging';
      const res = await govRegistry()({ projectId: 'repair-fixture', storyId: f.id });
      expect(res).toEqual(direct);
      if (noteBefore) {
        expect(fs.readFileSync(notePath(f.root, f.id)).equals(noteBefore), f.reason).toBe(true);
        expect(Object.keys(fmOf(notePath(f.root, f.id))).filter((k) => k.startsWith('review_'))).toEqual([]);
      }
    }
  });

  it('recorded values come from the runReview result diffTruncation, not the reviewer model', async () => {
    const { diff, files } = buildOverBoundDiff(2);
    expect(diff.length).toBeGreaterThan(REVIEW_MAX_CALLS * REVIEW_DIFF_CHAR_CAP);
    const MODEL = {
      unseenFiles: ['model/invented-unseen.mjs'],
      partialFile: { file: 'model/invented-cut.mjs', lastIncludedLine: 99999 },
      partialFiles: [{ file: 'model/invented-cut.mjs', lastIncludedLine: 99999 }],
      originalChars: 7,
      includedChars: 3,
    };
    const { result, outcome } = await reviewOver(
      diff,
      files,
      COVERED_RESPONSE({ diffTruncation: { truncated: true, ...MODEL }, ...MODEL }),
    );
    const t = result.diffTruncation;
    expect(outcome.unseenFiles).toEqual(t.unseenFiles);
    expect(outcome.partialFile).toEqual(t.partialFile);
    expect(outcome.partialFiles).toEqual(t.partialFiles);
    expect(outcome.originalChars).toBe(t.originalChars);
    expect(outcome.includedChars).toBe(t.includedChars);
    expect(t.originalChars).not.toBe(MODEL.originalChars);

    const root = mkRoot('rks-unreviewed-model-');
    writeTruncatedReviewRecord(root, 'backlog.fix.model-values', outcome, {});
    const raw = fs.readFileSync(recordPath(root, 'backlog.fix.model-values'), 'utf8');
    const rec = JSON.parse(raw);
    expect(rec.unseenFiles).toEqual(t.unseenFiles);
    expect(rec.partialFile).toBe(t.partialFile.file);
    expect(rec.partialFileLastIncludedLine).toBe(t.partialFile.lastIncludedLine);
    expect(rec.partialFiles).toEqual(t.partialFiles.map((p) => `${p.file}:${p.lastIncludedLine}`));
    expect(rec.originalChars).toBe(t.originalChars);
    expect(rec.includedChars).toBe(t.includedChars);
    expect(raw).not.toContain('model/invented');
    expect(JSON.stringify(outcome)).not.toContain('model/invented');
  });

  it('successful repair deletes the persisted record file', async () => {
    const id = 'backlog.fix.repair-deletes';
    const { root } = setupRepairRoot(id);
    await persistTwoCutRecord(root, id);
    expect(fs.existsSync(recordPath(root, id))).toBe(true);

    const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
    expect(res.reviewRecordWrite.ok).toBe(true);
    expect(res.note.ok).toBe(true);
    expect(res.reviewRecordCleared.deleted).toBe(true);
    expect(fs.existsSync(recordPath(root, id))).toBe(false);
  });

  it('refusals and failed writes leave the record file byte-identical', async () => {
    for (const f of await refusalFixtures()) {
      const before = fs.readFileSync(recordPath(f.root, f.id));
      h.repairRoot = f.root;
      h.integrationBranch = f.integrationBranch ?? 'staging';
      const res = await govRegistry()({ projectId: 'repair-fixture', storyId: f.id });
      expect(res.reason).toBe(f.reason);
      expect(fs.readFileSync(recordPath(f.root, f.id)).equals(before), f.reason).toBe(true);
    }
    h.integrationBranch = 'staging';

    // Frontmatter write fails.
    {
      const id = 'backlog.fix.write-fails';
      const { root } = setupRepairRoot(id);
      await persistTwoCutRecord(root, id);
      const before = fs.readFileSync(recordPath(root, id));
      h.failNoteWrite = true;
      const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
      h.failNoteWrite = false;
      expect(res.repaired).toBe(true);
      expect(res.reviewRecordWrite.ok).toBe(false);
      expect('reviewRecordCleared' in res).toBe(false);
      expect(fs.readFileSync(recordPath(root, id)).equals(before)).toBe(true);
    }

    // Note commit fails (a pre-commit hook refuses it).
    {
      const id = 'backlog.fix.commit-fails';
      const { root } = setupRepairRoot(id);
      await persistTwoCutRecord(root, id);
      const hook = path.join(root, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(hook, 0o755);
      const before = fs.readFileSync(recordPath(root, id));
      const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
      expect(res.reviewRecordWrite.ok).toBe(true);
      expect(res.note.ok).toBe(false);
      expect('reviewRecordCleared' in res).toBe(false);
      expect(fs.readFileSync(recordPath(root, id)).equals(before)).toBe(true);
    }
  });

  it('non-truncated gate-beta review deletes a prior record and repair takes the no-record path', async () => {
    // guardrailsOn hands the gate-beta result to the lifecycle helper right after the gate returns.
    const gateIdx = GUARDRAILS_ON.indexOf('const gateBeta = await runOffRailEnforcementGate({');
    const pushIdx = GUARDRAILS_ON.indexOf('shipSteps.push(...gateBeta.steps);', gateIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(GUARDRAILS_ON.slice(gateIdx, pushIdx)).toContain(
      'clearTruncatedReviewRecordAfterGateBeta(projectRoot, activeSession.problemId, gateBeta);',
    );

    const small = fileDiff('src/small.mjs', 3);
    const runGate = async (response) => {
      const reviewRoot = setupReviewRoot();
      h.reviewDiff = small;
      h.reviewNames = 'src/small.mjs\n';
      h.chat.mockResolvedValue(response);
      return runOffRailEnforcementGate({
        projectRoot: reviewRoot,
        projectId: 'review-fixture',
        activeSession: { problemId: REVIEW_STORY, branch: 'staging', headCommit: 'abc1234' },
        changedFiles: ['src/small.mjs'],
        allowedFiles: [],
        gate: 'gate_beta',
        override: null,
      });
    };
    const uncertain = await runGate(
      COVERED_RESPONSE({ acCoverage: { assessed: true, covered: ['AC1 does a thing'], notCovered: [], uncertain: ['AC2 does another'] } }),
    );
    expect(uncertain.phaseAdvanceSuppression.reason).toMatch(/\bac_coverage_uncertain\b/);
    const passed = await runGate(COVERED_RESPONSE());
    expect(passed.phaseAdvanceSuppression).toBeNull();

    for (const [label, gateBeta] of [['uncertain', uncertain], ['not suppressed', passed]]) {
      expect(gateBeta.steps.find((s) => s.step === 'review').diffTruncation, label).toBeUndefined();
      const id = `backlog.fix.gate-clears-${label.replace(/\s/g, '-')}`;
      const { root } = setupRepairRoot(id);
      await persistTwoCutRecord(root, id);
      clearTruncatedReviewRecordAfterGateBeta(root, id, gateBeta);
      expect(fs.existsSync(recordPath(root, id)), label).toBe(false);

      const res = await govRegistry()({ projectId: 'repair-fixture', storyId: id });
      expect(res.repaired).toBe(true);
      expect(res.reviewRecord.status).toBe('no_review_record');
      expect('review_never_reviewed_files' in fmOf(archivedPath(root, id))).toBe(false);
    }

    // Positive control: a truncated gate-beta review keeps the record.
    const { step } = await twoCutReview();
    const id = 'backlog.fix.gate-keeps-truncated';
    const { root } = setupRepairRoot(id);
    await persistTwoCutRecord(root, id);
    clearTruncatedReviewRecordAfterGateBeta(root, id, { steps: [step] });
    expect(fs.existsSync(recordPath(root, id))).toBe(true);
  });

  it('single cut file yields a one-element partialFiles', async () => {
    const { diff, files } = buildOverBoundDiff(1);
    expect(diff.length).toBeGreaterThan(REVIEW_MAX_CALLS * REVIEW_DIFF_CHAR_CAP);
    const { result, outcome } = await reviewOver(diff, files);
    const t = result.diffTruncation;
    expect(t.truncated).toBe(true);
    expect(t.partialFile).not.toBeNull();
    expect('partialFiles' in t).toBe(false);
    expect(outcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(outcome.partialFiles).toEqual([t.partialFile]);
  });
});
