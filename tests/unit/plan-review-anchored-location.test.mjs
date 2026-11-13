import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';
import { pruneRefineBlocks } from '../../packages/mcp-rks/src/server/planner-context.mjs';
import { runRefineApplyTool } from '../../packages/mcp-rks/src/server/refine.mjs';
import { runPlanReadyTool } from '../../packages/mcp-rks/src/server/plan-ready.mjs';

// backlog.fix.identity-anchor-location-unverified-by-plan-gates (Option A).
// An identity (SEARCH === REPLACE) block bound by label to an op:edit target marks a location
// the plan must edit. rks_plan_review (reviewPlan with authoredStoryBody) reports every anchored
// location that no real plan edit on the same file overlaps.

const A1 = 'export function stopBreach() {';
const A2 = 'export function stopBreachSince() {';
const A3 = 'export function clearStopBreach() {';
const R = 'const unrelated = 5;';
const FILE_BODY = [A1, '  return 1;', '}', A2, '  return 2;', '}', A3, '  return 3;', '}', R, ''].join('\n');
const TF = [{ path: 'a.mjs', op: 'edit' }];
const REFINE_MARKER = '<!-- rks:refine-anchor -->';

const anchor = (s) => `### a.mjs\n\n@@SEARCH\n${s}\n@@REPLACE\n${s}\n@@END\n`;
const realBlock = (s) => `### a.mjs\n\n@@SEARCH\n${s}\n@@REPLACE\n${s} // edited\n@@END\n`;
const edit = (search, replace = `${search} // edited`) => ({ action: 'search_replace', path: 'a.mjs', edits: [{ search, replace }] });
const unedited = (r) => (r.errors || []).filter((e) => e.check === 'anchored_location_unedited');
const previews = (r) => unedited(r).flatMap((e) => e.missingPreviews || []).join('\n');

let root;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-anchored-loc-'));
  fs.writeFileSync(path.join(root, 'a.mjs'), FILE_BODY);
});
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const review = (body, steps) =>
  reviewPlan({ projectRoot: root, plan: { steps }, targetFiles: TF, checkExecutableSteps: true, authoredStoryBody: body });

describe('anchored_location_unedited', () => {
  it('reports the two of three anchored sites the plan never edits, with file and preview', async () => {
    const r = await review([anchor(A1), anchor(A2), anchor(A3)].join('\n'), [edit(A1)]);
    expect(r.ok).toBe(false);
    expect(unedited(r).length).toBeGreaterThan(0);
    expect(unedited(r).every((e) => e.file === 'a.mjs' && e.severity === 'error')).toBe(true);
    expect(previews(r)).toContain(A2);
    expect(previews(r)).toContain(A3);
    expect(previews(r)).not.toContain(A1);
    // R9: the error volunteers both remedies, including how to clear a stale unmarked anchor.
    for (const e of unedited(r)) {
      expect(e.message).toContain(REFINE_MARKER);
      expect(e.message).toMatch(/edit/i);
    }
    expect(r.unplannedBlocks).toBe(0);
    expect(r.unattributedBlocks).toBe(0);
  });

  it('editing every anchored site yields exactly the errors of the same plan without anchors', async () => {
    const steps = [edit(A1), edit(`${A2}\n  return 2;`), edit(A3)];
    const withAnchors = await review([anchor(A1), anchor(A2), anchor(A3)].join('\n'), steps);
    const without = await review('', steps);
    expect(unedited(withAnchors)).toHaveLength(0);
    expect(withAnchors.errors).toEqual(without.errors);
  });

  it('a plan edit whose REPLACE equals its SEARCH does not edit the anchored location', async () => {
    const r = await review(anchor(A2), [edit(A2, A2)]);
    expect(previews(r)).toContain(A2);
  });

  it('mixed: a real block plus an identity anchor in the same file - the anchor is still checked', async () => {
    const r = await review(realBlock(R) + '\n' + anchor(A1), [edit(R)]);
    expect((r.errors || []).filter((e) => e.check === 'authored_block_shortfall')).toHaveLength(0);
    expect(previews(r)).toContain(A1);
  });

  it('refine-injected anchors (provenance marker above the heading) are exempt', async () => {
    const body = `${REFINE_MARKER}\n` + anchor(A2) + '\n' + realBlock(R);
    const r = await review(body, [edit(R)]);
    expect(unedited(r)).toHaveLength(0);
  });

  it('unlabelled identity blocks are neither checked nor unattributed (unchanged)', async () => {
    const r = await review(`@@SEARCH\n${A2}\n@@REPLACE\n${A2}\n@@END\n`, [edit(A1)]);
    expect(unedited(r)).toHaveLength(0);
    expect(r.unattributedBlocks).toBe(0);
  });

  it('the check does not run when authoredStoryBody is absent (exec.mjs / persistAndFinalize callers)', async () => {
    const r = await reviewPlan({ projectRoot: root, plan: { steps: [edit(A1)] }, targetFiles: TF });
    expect(unedited(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBeNull();
  });
});

describe('pruneRefineBlocks keeps the refine-anchor marker (ARCH round 1, Item 2)', () => {
  it('a marker inside a ### Target: skip zone survives while the snapshot is shed', () => {
    const pad = Array.from({ length: 50 }, (_, i) => `// snapshot pad line ${i}`).join('\n');
    const body = `## Problem\n\nx\n\n### Target: a.mjs\n\n\`\`\`js\n${pad}\n\`\`\`\n\n${REFINE_MARKER}\n` + anchor(A1);
    const out = pruneRefineBlocks(body, { threshold: 10 });
    expect(out).not.toContain('snapshot pad line 0');
    expect(out).toContain(`${REFINE_MARKER}\n### a.mjs\n`);
  });
});

describe('refine add_search_pattern writes the provenance marker', () => {
  const SVC = 'src/svc.mjs';
  const SVC_BODY = 'export function handleRequest(req) {\n  return req;\n}\n';
  const SVC_ANCHOR = 'export function handleRequest(req) {';
  let proj;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-refine-marker-'));
    fs.mkdirSync(path.join(proj, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, SVC), SVC_BODY);
  });
  afterEach(() => {
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  const noteText = (id, snapshot) =>
    `---\nid: "${id}"\ntitle: "marker"\nstatus: "not-implemented"\nphase: "arch-approved"\ntestExempt: true\ntargetFiles:\n  - path: "${SVC}"\n    op: "edit"\n---\n\n## Problem\n\nSomething.\n\n### Target: ${SVC}\n\n\`\`\`javascript\n${snapshot}\`\`\`\n`;
  const writeNote = (id, text) => {
    fs.writeFileSync(path.join(proj, 'notes', `${id}.md`), text);
    return text;
  };
  const readNote = (id) => fs.readFileSync(path.join(proj, 'notes', `${id}.md`), 'utf8');
  const bodyOf = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const apply = (id, data) => runRefineApplyTool({ projectRoot: proj, problemId: id, refinements: [{ type: 'add_search_pattern', data }] });
  // A plan that edits the file but NOT the injected anchor line.
  const reviewSvc = (body) =>
    reviewPlan({
      projectRoot: proj,
      plan: { steps: [{ action: 'search_replace', path: SVC, edits: [{ search: '  return req;', replace: '  return req ?? null;' }] }] },
      targetFiles: [{ path: SVC, op: 'edit' }],
      checkExecutableSteps: true,
      authoredStoryBody: body,
    });
  const markerAboveHeading = (text) => text.includes(`${REFINE_MARKER}\n### ${SVC}\n`);

  it('snippet-anchor path: marker above the injected heading, exempt at plan_review; stripped marker is not', async () => {
    const id = 'backlog.feat.marker-snippet';
    writeNote(id, noteText(id, SVC_BODY));
    await apply(id, { file: SVC, anchors: [SVC_ANCHOR] });
    const body = bodyOf(readNote(id));
    expect(markerAboveHeading(body)).toBe(true);
    expect(body).toContain(`@@SEARCH\n${SVC_ANCHOR}\n@@REPLACE\n${SVC_ANCHOR}\n@@END`);
    expect(unedited(await reviewSvc(body))).toHaveLength(0);
    // Negative control: the exemption, not some other rule, is what silences the check.
    expect(previews(await reviewSvc(body.replace(`${REFINE_MARKER}\n`, '')))).toContain(SVC_ANCHOR);
  });

  it('disk-fallback path: marker above the injected heading, exempt at plan_review', async () => {
    const id = 'backlog.feat.marker-fallback';
    // Snapshot with no extractable anchor forces the read-from-disk fallback.
    writeNote(id, noteText(id, 'const pad = 1;\n'));
    const res = await apply(id, { file: SVC });
    expect(JSON.stringify(res.applied || [])).toContain('fallback');
    const body = bodyOf(readNote(id));
    expect(markerAboveHeading(body)).toBe(true);
    expect(body).toContain(`@@SEARCH\n${SVC_ANCHOR}\n@@REPLACE\n${SVC_ANCHOR}\n@@END`);
    expect(unedited(await reviewSvc(body))).toHaveLength(0);
  });

  it('dedup still skips an anchor already present; the marker is not duplicated', async () => {
    const id = 'backlog.feat.marker-dedup';
    writeNote(id, noteText(id, SVC_BODY));
    await apply(id, { file: SVC, anchors: [SVC_ANCHOR] });
    const second = await apply(id, { file: SVC, anchors: [SVC_ANCHOR] });
    expect(JSON.stringify(second.applied || [])).toContain('skipped');
    expect(readNote(id).split(REFINE_MARKER).length - 1).toBe(1);
  });

  it('plan_ready on the refined story raises no new issue versus the same story without the marker', async () => {
    const id = 'backlog.feat.marker-ready';
    writeNote(id, noteText(id, SVC_BODY));
    await apply(id, { file: SVC, anchors: [SVC_ANCHOR] });
    const marked = readNote(id);
    const idPlain = 'backlog.feat.marker-ready-plain';
    writeNote(idPlain, marked.replace(`${REFINE_MARKER}\n`, '').replace(`id: "${id}"`, `id: "${idPlain}"`));
    const checks = (r) => (r.issues || []).map((i) => i.check).sort();
    const rMarked = await runPlanReadyTool({ projectRoot: proj, problemId: id, projectId: 'p' });
    const rPlain = await runPlanReadyTool({ projectRoot: proj, problemId: idPlain, projectId: 'p' });
    expect(checks(rMarked)).toEqual(checks(rPlain));
    expect(checks(rMarked)).not.toContain('no_search_pattern_for_modify');
  });

  it('over-cap note whose cap-mode prune succeeds still writes the marker, and plan_review raises nothing', async () => {
    const id = 'backlog.feat.marker-overcap';
    const pad = Array.from({ length: 300 }, (_, i) => `// snapshot pad line ${i} `.padEnd(40, 'x')).join('\n') + '\n';
    const text = writeNote(id, noteText(id, SVC_BODY + pad));
    expect(text.length).toBeGreaterThan(8192); // precondition: the cap gate arms
    const res = await apply(id, { file: SVC, anchors: [SVC_ANCHOR] });
    expect(res.noteSizeOverflow).toBeUndefined(); // precondition: the prune brought it under the cap
    const body = bodyOf(readNote(id));
    expect(body).not.toContain('snapshot pad line 0'); // the Target snapshot was shed
    expect(markerAboveHeading(body)).toBe(true);
    expect(unedited(await reviewSvc(body))).toHaveLength(0);
  });
});
