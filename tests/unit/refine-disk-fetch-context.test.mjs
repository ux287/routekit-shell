/**
 * Unit tests for disk-fetch context injection in refine.mjs.
 *
 * Tests the truncation detection signal and the note body size warning
 * in isolation (pure function checks), verifying the key invariants:
 * - disk_fetch_context suggested when truncation markers in context
 * - add_code_snippet suggested when no truncation (non-truncation path intact)
 * - story note body unchanged after disk_fetch_context path
 * - 5KB note body warning emitted when threshold exceeded
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDir, ensureDir } from '../helpers/tmp.mjs';
import {
  runRefineApplyTool,
  targetSectionFor,
  FENCE,
  fenceLangFor,
} from '../../packages/mcp-rks/src/server/refine.mjs';

// ─── Truncation detection helpers (mirrors refine.mjs logic) ─────────────────

const TRUNCATION_MARKER_RE = /\/\/ \.\.\. \(\d+ lines omitted\) \.\.\./;

function hasTruncationMarker(context) {
  return !!(context && TRUNCATION_MARKER_RE.test(context));
}

const NOTE_BODY_SIZE_WARN_BYTES = 5120;

function buildNoteSizeWarning(bodyLength) {
  if (bodyLength > NOTE_BODY_SIZE_WARN_BYTES) {
    return `Story note body is ${Math.round(bodyLength / 1024)}KB — exceeds 5KB threshold; note inflation may crowd out file context in planner`;
  }
  return null;
}

// ─── Truncation detection ────────────────────────────────────────────────────

describe('truncation detection', () => {
  it('detects truncation marker in context string', () => {
    const ctx = 'Plan failed: src/server/exec.mjs\n// ... (42 lines omitted) ...\nmore context';
    expect(hasTruncationMarker(ctx)).toBe(true);
  });

  it('returns false when no truncation marker in context', () => {
    const ctx = 'Plan failed: search pattern not found in exec.mjs';
    expect(hasTruncationMarker(ctx)).toBe(false);
  });

  it('returns false for empty/null context', () => {
    expect(hasTruncationMarker('')).toBe(false);
    expect(hasTruncationMarker(null)).toBe(false);
    expect(hasTruncationMarker(undefined)).toBe(false);
  });

  it('detects marker with any line count', () => {
    expect(hasTruncationMarker('// ... (1 lines omitted) ...')).toBe(true);
    expect(hasTruncationMarker('// ... (999 lines omitted) ...')).toBe(true);
  });
});

// ─── Note body size warning ───────────────────────────────────────────────────

describe('note body size warning', () => {
  it('emits warning when body exceeds 5KB', () => {
    const warning = buildNoteSizeWarning(5121);
    expect(warning).not.toBeNull();
    expect(warning).toContain('5KB');
    expect(warning).toContain('threshold');
  });

  it('does NOT warn when body is exactly at threshold', () => {
    expect(buildNoteSizeWarning(5120)).toBeNull();
  });

  it('does NOT warn when body is below threshold', () => {
    expect(buildNoteSizeWarning(1024)).toBeNull();
    expect(buildNoteSizeWarning(0)).toBeNull();
  });

  it('warning includes KB representation of actual size', () => {
    const warning = buildNoteSizeWarning(10 * 1024); // 10KB
    expect(warning).toContain('10KB');
  });
});

// ─── Real-handler assertions ──────────────────────────────────────────────────
//
// backlog.fix.refine-apply-no-growth-fixed-point:
// These blocks previously asserted against LOCAL MIRRORS of refine.mjs — a
// `selectSuggestionType()` helper defined in this file, and a hand-simulated
// disk_fetch_context handler using local variables. Neither imported refine.mjs, so
// widening the real gate would have left them green while behaviour changed. That is a
// false negative, not coverage. They now drive the real exported handler.

// Mirrors the section the writer interpolates in refine.mjs, built the same way —
// heading, prose line, fences and newlines — so the projection here tracks the
// writer's own text rather than a hardcoded constant.
// backlog.fix.disk-fetch-test-helpers-drift-from-source: these DERIVE from the
// writer's own factory rather than re-typing its text. The previous version
// hardcoded the fence while the writer built it from a FENCE constant, so a change
// to that constant would have left this suite measuring a framing the writer no
// longer emits — with every assertion still green.
const sectionWith = (payload, targetFile = 'src/svc.mjs') => targetSectionFor(targetFile, payload);

// ─── The fenced-payload predicate ────────────────────────────────────────────
// backlog.fix.ac9-snippet-bound-vacuous-and-unwitnessed.
//
// ONE definition, called by the AC-9 assertion and by BOTH witnesses. A witness
// that re-implemented or copied it would measure its own copy rather than the
// thing AC-9 measures, which is the mirror-drift defect this file has already
// been bitten by twice (see the two backlog references above).
//
// The framing is spelled out here rather than derived from `targetSectionFor`
// ON PURPOSE. Deriving it would make every framing assertion an algebraic
// identity about one function — green for any value of FENCE and any framing
// the writer might drift to. This is the independent side of that comparison;
// requirement 11's assertion is what couples it back to the real emission.
//
// The five framing lines are NOT contiguous prose: refine.mjs:1292 separates the
// heading from the preamble with a blank line and terminates with another, and
// :1293 appends the opening fence after that. A predicate requiring the three
// non-blank lines to be CONSECUTIVE never locates a real section.
const FRAMING_PREAMBLE = 'Current source (use for search_replace patterns):';

/** The framing lines the predicate matches, in emitted order, as an array. */
function framingPrefixFor(targetFile, fence = FENCE) {
  return [
    `### Target: ${targetFile}`,
    '',
    FRAMING_PREAMBLE,
    '',
    fence + fenceLangFor(targetFile),
  ];
}

// Module-scoped call counter — the committed witness for the single-predicate
// rule above. An INLINED copy of the predicate never increments it, so a case
// that copies rather than calls falls short of its asserted advance and reddens.
// It witnesses INVOCATION, not provenance: a copy accompanied by a compensating
// dead call still passes, which is why the rule remains a diff-review obligation
// as well. Read the counter with `predicateCalls`, never cache it across cases.
let predicateCalls = 0;

/**
 * Extract the payload from the `### Target:` section for `targetFile`.
 *
 * Returns the text strictly between the fence lines, joined back with newlines
 * and NOT trimmed — an unbounded section must round-trip its payload
 * byte-for-byte, including a trailing empty line when the payload ends in a
 * newline. Trimming would return `payload.length - 1` and redden witness 1 for
 * what looks like a spec bug and is not.
 *
 * Returns null when no conforming section is found. Both fence lines are matched
 * by EXACT LINE EQUALITY: a payload line that merely BEGINS with the fence would
 * be taken for the closing fence by a prefix matcher and close extraction early.
 */
function extractFencedPayload(noteText, targetFile, fence = FENCE) {
  predicateCalls += 1;
  const lines = String(noteText).split('\n');
  const prefix = framingPrefixFor(targetFile, fence);
  for (let i = 0; i + prefix.length <= lines.length; i += 1) {
    if (!prefix.every((want, k) => lines[i + k] === want)) continue;
    const start = i + prefix.length;
    for (let j = start; j < lines.length; j += 1) {
      if (lines[j] === fence) return lines.slice(start, j).join('\n');
    }
    return null;
  }
  return null;
}

/** The non-payload cost of the section: the same string with an empty payload. */
const sectionFraming = (targetFile = 'src/svc.mjs') => targetSectionFor(targetFile, '');

/**
 * The BODY the handler operates on — everything after the frontmatter block.
 * Mirrors refine.mjs: `storyContent.slice(frontmatterMatch[0].length)` against
 * /^---\n([\s\S]*?)\n---/. Projecting on the whole note file instead would
 * over-count by the frontmatter and mis-place the boundary — the same
 * measure-the-wrong-quantity error this story exists to fix.
 */
function bodyOf(note) {
  const m = note.match(/^---\n([\s\S]*?)\n---/);
  return m ? note.slice(m[0].length) : note;
}

/** body + framing + payload, all String.prototype.length — the guard's operand. */
function projectedLength(note, payload, targetFile = 'src/svc.mjs') {
  return bodyOf(note).length + sectionFraming(targetFile).length + payload.length;
}

const TARGET = 'src/svc.mjs';
const BASE_FILE_CONTENT = 'export function handleRequest(req) {\n  return req;\n}\n';

function buildNote(storyId, targetFile, { anchors = 0 } = {}) {
  const searchBlocks = Array.from({ length: anchors }, (_, i) =>
    `### ${targetFile}\n\n@@SEARCH\nexport function anchor_${i}(${'arg'.repeat(8)}) {\n@@REPLACE\nexport function anchor_${i}(${'arg'.repeat(8)}) {\n@@END`
  ).join('\n\n');

  return `---
id: "${storyId}"
title: "disk fetch context test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

A file needs changes.
${anchors ? '\n## Code Changes\n\n' + searchBlocks + '\n' : ''}`;
}

describe('disk_fetch_context — real handler', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine-disk-fetch');
    ensureDir(path.join(projectRoot, 'notes'));
    ensureDir(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('leaves the story note body unchanged and returns content out of band', async () => {
    const storyId = 'backlog.feat.disk-fetch-body';
    const notePath = path.join(projectRoot, 'notes', `${storyId}.md`);
    fs.writeFileSync(notePath, buildNote(storyId, TARGET));
    const before = fs.readFileSync(notePath, 'utf8');

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: 'disk_fetch_context', data: { file: TARGET } }],
    });

    const after = fs.readFileSync(notePath, 'utf8');
    // ONE extraction algorithm — the file-level bodyOf, which mirrors the slice
    // refine.mjs projects on. These two call sites previously SHADOWED it with a
    // different algorithm, so parts of this suite measured a different "body" than
    // the rest.
    //
    // The .trim() that used to sit on these comparisons is GONE, and so is the comment
    // justifying it. That comment stated "re-serialising the note shifts a leading newline" as
    // though it were a property of the format. It was a DEFECT — refine emitted its own newline
    // after the closing fence when the sliced body already carried one, growing the note a byte
    // per apply while reporting "story note unchanged". The trim tolerated exactly the byte that
    // grew, so this test passed while asserting the opposite of what its name claims.
    // Byte-identity is now the assertion. Do not reinstate the trim to make a red go away.
    expect(bodyOf(after)).toBe(bodyOf(before));
    expect(result?.outOfBandContext?.some((c) => c.file === TARGET)).toBe(true);
  });

  it('the note body does NOT grow across repeated disk-fetch cycles', async () => {
    const storyId = 'backlog.feat.disk-fetch-cycles';
    const notePath = path.join(projectRoot, 'notes', `${storyId}.md`);
    fs.writeFileSync(notePath, buildNote(storyId, TARGET));
    // ONE extraction algorithm — the file-level bodyOf, which mirrors the slice
    // refine.mjs projects on. These two call sites previously SHADOWED it with a
    // different algorithm, so parts of this suite measured a different "body" than
    // the rest.
    //
    // The .trim() that used to sit on these comparisons is GONE, and so is the comment
    // justifying it. That comment stated "re-serialising the note shifts a leading newline" as
    // though it were a property of the format. It was a DEFECT — refine emitted its own newline
    // after the closing fence when the sliced body already carried one, growing the note a byte
    // per apply while reporting "story note unchanged". The trim tolerated exactly the byte that
    // grew, so this test passed while asserting the opposite of what its name claims.
    // Byte-identity is now the assertion. Do not reinstate the trim to make a red go away.
    const initial = bodyOf(fs.readFileSync(notePath, 'utf8'));

    for (let i = 0; i < 3; i++) {
      await runRefineApplyTool({
        projectRoot, problemId: storyId,
        refinements: [{ type: 'disk_fetch_context', data: { file: TARGET } }],
      });
      expect(bodyOf(fs.readFileSync(notePath, 'utf8'))).toBe(initial);
    }
  });
});

describe('add_code_snippet routing — real handler, real cap gate', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine-snippet-routing');
    ensureDir(path.join(projectRoot, 'notes'));
    ensureDir(path.join(projectRoot, 'src'));
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('UNDER cap: injects a ### Target: section into the body (non-cap path intact)', async () => {
    const storyId = 'backlog.feat.snippet-under-cap';
    const notePath = path.join(projectRoot, 'notes', `${storyId}.md`);
    const note = buildNote(storyId, TARGET);
    // PROJECTIVE precondition. This assertion used to check nothing about size at
    // all, so "non-cap path intact" was unverified: the guard now selects on the
    // POST-injection total, and a precondition on the pre-injection body would not
    // name the predicate that picks the branch this test is about.
    expect(
      projectedLength(note, BASE_FILE_CONTENT),
      'precondition: projected total must be under the cap',
    ).toBeLessThan(8192);
    fs.writeFileSync(notePath, note);

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET } }],
    });

    expect(fs.readFileSync(notePath, 'utf8')).toContain(`### Target: ${TARGET}`);
    expect(result?.applied?.some((a) => a?.injectedHeader)).toBe(true);
  });

  it('OVER cap: routes out of band instead of injecting a section the prune would strip', async () => {
    const storyId = 'backlog.feat.snippet-over-cap';
    const notePath = path.join(projectRoot, 'notes', `${storyId}.md`);
    const note = buildNote(storyId, TARGET, { anchors: 80 });
    expect(note.length).toBeGreaterThan(8192);
    fs.writeFileSync(notePath, note);

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET } }],
    });

    const written = fs.readFileSync(notePath, 'utf8');
    expect(result?.applied?.some((a) => a?.outOfBand === true)).toBe(true);
    expect(result?.applied?.some((a) => a?.injectedHeader)).toBe(false);
    expect(result?.outOfBandContext?.some((c) => c.file === TARGET)).toBe(true);
    // The durable signal must survive the very prune that strips ### Target: sections.
    expect(written).toContain(`<!-- rks:context-out-of-band: ${TARGET} -->`);
  });
});

// ─── backlog.fix.refine-projective-headroom-guard ─────────────────────────────
//
// The guard at the injection site compared the PRE-injection body against the cap.
// A note that fit today but not after the injection passed it: the section was
// written, the prune stripped it before the write, and the ledger entry was
// labelled NOT DURABLE. Observed on a 7,448-byte body with 744 bytes of headroom.
// The headroom test omitted the size of what it was about to add.

describe('add_code_snippet — the headroom guard is projective', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine-projective');
    ensureDir(path.join(projectRoot, 'notes'));
    ensureDir(path.join(projectRoot, 'src'));
  });
  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Pad so the note's BODY — the guard's operand — is exactly `bodyLength` chars. */
  function noteOfLength(storyId, targetFile, bodyLength) {
    const base = buildNote(storyId, targetFile);
    const pad = bodyLength - bodyOf(base).length;
    if (pad < 0) throw new Error(`base body already ${bodyOf(base).length} > ${bodyLength}`);
    return base + 'x'.repeat(pad);
  }

  function write(storyId, note, fileContent) {
    fs.writeFileSync(path.join(projectRoot, TARGET), fileContent);
    fs.writeFileSync(path.join(projectRoot, 'notes', `${storyId}.md`), note);
    return path.join(projectRoot, 'notes', `${storyId}.md`);
  }

  const apply = (storyId) => runRefineApplyTool({
    projectRoot, problemId: storyId,
    refinements: [{ type: 'add_code_snippet', data: { file: TARGET } }],
  });

  // THE REPRODUCTION. Under cap by body, over cap by projection.
  it('routes out of band when the body fits but the projected total does not', async () => {
    const storyId = 'backlog.feat.crossing';
    const payload = 'export function big() {\n' + '  // filler line\n'.repeat(40) + '}\n';
    const note = noteOfLength(storyId, TARGET, 8000);
    const notePath = write(storyId, note, payload);

    expect(bodyOf(note).length, 'precondition: body alone is UNDER the cap').toBeLessThan(8192);
    expect(projectedLength(note, payload), 'precondition: projection is OVER the cap').toBeGreaterThan(8192);

    const res = await apply(storyId);
    const written = fs.readFileSync(notePath, 'utf8');

    expect(res?.applied?.some((a) => a?.outOfBand === true)).toBe(true);
    expect(res?.applied?.some((a) => a?.injectedHeader)).toBe(false);
    expect(written).toContain(`<!-- rks:context-out-of-band: ${TARGET} -->`);
    // The body must be free of the section the prune would have removed, and no
    // NOT DURABLE entry may be produced for this call.
    expect(written).not.toContain(`### Target: ${TARGET}`);
    expect(JSON.stringify(res?.applied ?? [])).not.toMatch(/NOT DURABLE/);
  });

  it('still injects when body plus projected injection fits', async () => {
    const storyId = 'backlog.feat.fits';
    const payload = BASE_FILE_CONTENT;
    const note = noteOfLength(storyId, TARGET, 2000);
    const notePath = write(storyId, note, payload);

    expect(projectedLength(note, payload)).toBeLessThan(8192);

    const res = await apply(storyId);
    expect(res?.applied?.some((a) => a?.injectedHeader === `### Target: ${TARGET}`)).toBe(true);
    expect(fs.readFileSync(notePath, 'utf8')).toContain(`### Target: ${TARGET}`);
  });

  // AC-9. A >120-line target whose FILE size projects over the cap but whose
  // EXTRACTED payload does not. A projection sourced from fs.stat().size or any
  // whole-file measurement reddens here; one sourced from the snippet does not.
  it('sources the payload term from the extracted snippet, not the file on disk', async () => {
    const storyId = 'backlog.feat.payload-provenance';
    const bigFile = 'export function handleRequest(req) {\n  return req;\n}\n'
      + Array.from({ length: 400 }, (_, i) => `// filler line ${i} ${'y'.repeat(20)}`).join('\n') + '\n';
    const note = noteOfLength(storyId, TARGET, 1500);
    const notePath = write(storyId, note, bigFile);

    expect(bodyOf(note).length + bigFile.length, 'precondition: WHOLE FILE would project over the cap').toBeGreaterThan(8192);

    const res = await apply(storyId);
    expect(
      res?.applied?.some((a) => a?.injectedHeader),
      'a whole-file payload term would have routed this out of band',
    ).toBe(true);

    const written = fs.readFileSync(notePath, 'utf8');
    expect(written).toContain(`### Target: ${TARGET}`);

    // The bound this test RELIES on, now ASSERTED. It passes because the extractor
    // truncates a >120-line target, and previously nothing checked that — so a
    // change to the extractor would have left the test passing for a reason that
    // no longer held. Fixture is deliberately over MAX_LINES so the strict `<`
    // can neither pass nor fail for the wrong reason.
    expect(bigFile.split('\n').length).toBeGreaterThan(120);

    // Arm the fixture: fence-delimited extraction over it is only well defined if
    // the payload cannot itself close the fence. Same discipline as the cap tests.
    expect(bigFile).not.toContain(FENCE);

    // The previous form of this assertion sliced `written` to the length of the
    // WHOLE-FILE section and compared that slice's length against the same
    // length — trivially true whenever the note is shorter than the offset, and
    // therefore true no matter what the extractor did. It measured nothing.
    // This measures the payload the extractor actually wrote.
    const callsBefore = predicateCalls;
    const extracted = extractFencedPayload(written, TARGET);
    expect(
      predicateCalls - callsBefore,
      'AC-9 must drive the shared predicate, not an inlined copy',
    ).toBeGreaterThanOrEqual(1);

    expect(extracted, 'a conforming section must be locatable').not.toBeNull();
    expect(extracted.length, 'an empty extraction would satisfy the bound vacuously').toBeGreaterThan(0);
    expect(written, 'the extraction must come from the written note').toContain(extracted);
    expect(extracted, 'a clamped extraction would have swallowed a fence').not.toContain(FENCE);
    expect(
      extracted.length,
      'extracted snippet must be shorter than the file it came from',
    ).toBeLessThan(bigFile.length);
  });

  // WITNESS 1 — the extractor-unbounded negative case, committed rather than
  // narrated. Commit 26a45692 claimed a build-session mutation as evidence; a
  // mutation nobody can re-run is not evidence. Both branches live in ONE case so
  // the pair fails if either side flips.
  it('the AC-9 bound is FALSE for an unbounded section and TRUE for the real one', async () => {
    const storyId = 'backlog.feat.payload-provenance-unbounded';
    const bigFile = 'export function handleRequest(req) {\n  return req;\n}\n'
      + Array.from({ length: 400 }, (_, i) => `// filler line ${i} ${'y'.repeat(20)}`).join('\n') + '\n';
    expect(bigFile).not.toContain(FENCE);

    const note = noteOfLength(storyId, TARGET, 1500);
    const notePath = write(storyId, note, bigFile);
    await apply(storyId);
    const written = fs.readFileSync(notePath, 'utf8');

    // The fixture the extractor WOULD produce if it stopped bounding: the whole
    // file as the payload. It takes its payload from `bigFile` directly — a
    // fixture whose payload and whose asserted-against length both flowed out of
    // `targetSectionFor` would move together when the writer changed, and would
    // assert nothing about bounding.
    const unbounded = sectionWith(bigFile, TARGET);

    const callsBefore = predicateCalls;
    const fromReal = extractFencedPayload(written, TARGET);
    const fromUnbounded = extractFencedPayload(unbounded, TARGET);
    expect(
      predicateCalls - callsBefore,
      'both branches must drive the shared predicate',
    ).toBeGreaterThanOrEqual(2);

    // The unbounded payload round-trips byte-for-byte — so the AC-9 comparison,
    // `< bigFile.length`, is FALSE for it. This is the branch that proves the
    // AC-9 assertion can fail at all.
    expect(fromUnbounded).not.toBeNull();
    expect(fromUnbounded.length).toBe(bigFile.length);
    expect(fromUnbounded.length).not.toBeLessThan(bigFile.length);

    // ...and TRUE for the section the real extractor produced.
    expect(fromReal).not.toBeNull();
    expect(fromReal.length).toBeLessThan(bigFile.length);
  });

  // WITNESS 2 — framing drift and fence drift. The teeth are in the (b)+(c)
  // CONJUNCTION, not in (c) alone: (b) and (c) differ in NOTHING but the fence
  // handed to the predicate and are required to produce opposite outcomes, so a
  // predicate that ignores that argument makes them the same call and one must
  // fail. Weakening (b) from a rejection to an acceptance destroys the coupling
  // check entirely while leaving (c) green and apparently meaningful. Do not.
  it('the predicate is coupled to the fence and framing the writer actually emits', () => {
    const payload = 'export const alpha = 1;\nexport const beta = 2;\n';

    // Derived by perturbation, never a hardcoded literal. The perturbation must
    // yield a value DISJOINT from FENCE — neither a prefix of it nor prefixed by
    // it. A drift that merely EXTENDS FENCE (one further backtick) leaves the
    // undrifted fence sitting inside the drifted opening line as a substring, so
    // a prefix-matching predicate still locates the payload and (b) goes red.
    const driftedFence = FENCE.replace(/`/g, '~');

    // MEASURED, not merely stated. These two halves are NOT the same kind of
    // assertion. (i) The inequality is ATTRIBUTION: the equality case would
    // already redden through (b)+(c) — if the drift equalled FENCE, (b) would
    // emit a section identical to the real one, the payload WOULD be located,
    // and (b) and (c) would be the same call with opposite required outcomes.
    // Never silent. What this buys is that the failure NAMES the drift value
    // instead of surfacing as an unexplained rejection inside (b), where a
    // builder chasing green is tempted to relax (b).
    expect(driftedFence).not.toBe(FENCE);
    // (ii) The disjointness assertions are DETECTION and carry the teeth. They
    // are the ONLY committed check of the disjointness rule: an unequal but
    // NON-disjoint drift leaves (a), (b) and (c) all green under this exact-
    // equality predicate, so the (b)+(c) pair cannot see it at all. Dropping
    // these removes coverage, not colour.
    expect(driftedFence.startsWith(FENCE)).toBe(false);
    expect(FENCE.startsWith(driftedFence)).toBe(false);

    // Arm every fixture the predicate is driven over: the payload must contain
    // neither fence, or a payload line could close extraction early and let a
    // case pass for the wrong reason.
    expect(payload).not.toContain(FENCE);
    expect(payload).not.toContain(driftedFence);

    const real = sectionWith(payload, TARGET);
    // The drifted section is PERTURBED from the real one, not re-typed. A
    // hand-typed section with subtly wrong framing would also reject in (b) —
    // passing it for the wrong reason. Case (c) is what catches that, which is
    // why the conjunction guards fixture construction as well as fence-reading.
    const driftedSection = real.split(FENCE).join(driftedFence);
    expect(driftedSection).not.toBe(real);
    // The predicate's framing is independent of the writer's; this is what
    // couples the two, and it reddens on any framing mis-transcription.
    expect(real).toContain(framingPrefixFor(TARGET).join('\n'));

    const callsBefore = predicateCalls;

    // (a) real section, fence argument OMITTED — this is what puts the imported
    // FENCE default on an executed path. If every call site passed a fence
    // explicitly the default would be dead code.
    const a = extractFencedPayload(real, TARGET);
    // (b) drifted section, predicate still handed the imported FENCE — MUST NOT
    // locate. THIS IS THE LOAD-BEARING ASSERTION IN THIS FILE.
    const b = extractFencedPayload(driftedSection, TARGET, FENCE);
    // (c) the SAME drifted section, predicate handed the DRIFTED fence — locates.
    const c = extractFencedPayload(driftedSection, TARGET, driftedFence);

    expect(
      predicateCalls - callsBefore,
      'all three cases must drive the shared predicate',
    ).toBeGreaterThanOrEqual(3);

    expect(a, '(a) the real section must be located via the default fence').toBe(payload);
    expect(b, '(b) a drifted fence must NOT be located by the imported FENCE').toBeNull();
    expect(c, '(c) the same section IS located when the drifted fence is handed in').toBe(payload);

    // FRAMING drift, not only fence drift — a section whose heading or whose
    // preamble differs from what the writer emits is rejected, and the
    // conforming one is accepted.
    const driftedHeading = real.replace(`### Target: ${TARGET}`, `### Target: ${TARGET}x`);
    const driftedPreamble = real.replace(FRAMING_PREAMBLE, 'Current source, but reworded:');
    expect(driftedHeading).not.toBe(real);
    expect(driftedPreamble).not.toBe(real);
    expect(extractFencedPayload(driftedHeading, TARGET)).toBeNull();
    expect(extractFencedPayload(driftedPreamble, TARGET)).toBeNull();
    expect(extractFencedPayload(real, TARGET)).toBe(payload);
  });

  // The emission contract this story couples to, asserted present and unchanged —
  // behaviourally, then structurally on two durable export phrases. Full-source
  // toContain only: a fixed-size window is the exact shape of the defect above,
  // and a whole-file hash reddens on any unrelated edit.
  it('the emission contract it couples to is present and unchanged', () => {
    const marker = 'MARKER_PAYLOAD_a1b2c3';
    const section = targetSectionFor(TARGET, marker);
    expect(section).toContain(`### Target: ${TARGET}`);
    expect(section).toContain(FENCE);
    expect(section).toContain(marker);

    const src = fs.readFileSync(
      path.join(process.cwd(), 'packages/mcp-rks/src/server/refine.mjs'),
      'utf8',
    );
    expect(src).toContain('export const FENCE');
    expect(src).toContain('export function targetSectionFor(');
  });

  it('keeps the boundary at strictly-greater-than: exactly at the cap still injects', async () => {
    const storyId = 'backlog.feat.boundary';
    const payload = BASE_FILE_CONTENT;
    const framing = sectionFraming(TARGET).length;
    const note = noteOfLength(storyId, TARGET, 8192 - framing - payload.length);
    write(storyId, note, payload);

    expect(projectedLength(note, payload), 'precondition: projection is exactly at the cap').toBe(8192);
    const res = await apply(storyId);
    expect(res?.applied?.some((a) => a?.injectedHeader)).toBe(true);
  });

  it('one character over the cap routes out of band', async () => {
    const storyId = 'backlog.feat.boundary-over';
    const payload = BASE_FILE_CONTENT;
    const framing = sectionFraming(TARGET).length;
    const note = noteOfLength(storyId, TARGET, 8193 - framing - payload.length);
    write(storyId, note, payload);

    expect(projectedLength(note, payload)).toBe(8193);
    const res = await apply(storyId);
    expect(res?.applied?.some((a) => a?.outOfBand === true)).toBe(true);
  });

  // TR3: the projection must track the writer's own framing string, not a constant.
  it('the framing term matches the section the writer actually builds', async () => {
    const storyId = 'backlog.feat.framing';
    const payload = BASE_FILE_CONTENT;
    const note = noteOfLength(storyId, TARGET, 2000);
    const notePath = write(storyId, note, payload);

    await apply(storyId);
    const written = fs.readFileSync(notePath, 'utf8');
    // Direct containment of the exact section the writer builds. Slicing to
    // end-of-file would also capture the history block appended afterwards, which
    // is how a length-difference form of this assertion goes wrong.
    expect(written).toContain(sectionWith(payload, TARGET));
    // ...and the framing this suite projects with is that same string minus the
    // payload, so the projection cannot drift from the writer's own text.
    expect(sectionWith(payload, TARGET).length - payload.length).toBe(sectionFraming(TARGET).length);
  });
});
