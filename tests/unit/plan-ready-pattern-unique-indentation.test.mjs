// backlog.fix.plan-ready-pattern-unique-indentation-and-locations
//
// ONE shared SEARCH occurrence matcher (findPatternOccurrences, validation/search-replace.mjs)
// for plan_ready, the reviewer, the plan-step validator, rks_plan_review, rks_refine and the
// exec applier. A whole-line hit always counts. A mid-line hit is discounted ONLY when the
// pattern also has a whole-line hit AND the line holding it differs from the pattern by extra
// leading whitespace alone; with no whole-line hit every containment hit counts. A pattern
// ending in a newline meets the end-of-line condition by itself. Counting is OVERLAPPING.
// Fixtures live under os.tmpdir() only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@routekit/rag/tools', () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

import { runPlanReadyTool, extractSearchPatterns } from '../../packages/mcp-rks/src/server/plan-ready.mjs';
import { extractExplicitEdits, validateExplicitEdits, countOccurrences } from '../../packages/mcp-rks/src/llm/reviewer.mjs';
import {
  countPatternOccurrences,
  findPatternOccurrences,
  validateSearchReplacePatterns,
} from '../../packages/mcp-rks/src/validation/search-replace.mjs';
import { applySearchReplace } from '../../packages/mcp-rks/src/server/step-apply.mjs';
import { extractAuthoredBlocks, reviewPlan, checkOverlappingEditRegions } from '../../packages/mcp-rks/src/server/plan-quality.mjs';
import { runRefineTool } from '../../packages/mcp-rks/src/server/refine.mjs';

const NL = '\n';
// Built, never written literally: a literal triple backtick in this file would close the
// story's own fence for extractors that are not line-anchored.
const FENCE = '`'.repeat(3);
const STORY_ID = 'backlog.fix.pattern-unique-fixture';
const S12 = ' '.repeat(12);
const S16 = ' '.repeat(16);
const X = "mock_request.assert_called_once_with('GET', 'accounts/')";
const PY = 'tests/test_client.py';
// X at 16 spaces on line 3, at 12 spaces on line 5.
const PY_CONTENT = ['def test_a():', `${S12}with patch() as mock_request:`, `${S16}${X}`, 'def test_b():', `${S12}${X}`, ''].join(NL);
const DUP = 'tests/test_dup.py';
// The same 12-space line twice, on lines 2 and 4.
const DUP_CONTENT = ['def t():', `${S12}${X}`, '    pass', `${S12}${X}`, ''].join(NL);
// A whole-line hit on line 1 and a hit on line 2 whose line differs by MORE than whitespace.
const MIX = 'src/orders.mjs';
const MIX_SEARCH = 'computeTotal(order);';
const MIX_CONTENT = [MIX_SEARCH, 'const total = computeTotal(order);', ''].join(NL);

const IMPORT = 'from src.core import trading_guardrails as guardrails';
const ENGINE = 'src/trade_engine.py';
const CLIENT = 'src/tradier_client.py';
const ENGINE_CONTENT = ['import os', IMPORT, '', 'def run():', '    return guardrails', ''].join(NL);
const CLIENT_CONTENT = ['def a():', `    ${IMPORT}`, '', 'def b():', `    ${IMPORT}`, ''].join(NL);
// CLIENT is declared BEFORE ENGINE and holds the import twice, indented.
const CROSS_TARGETS = [CLIENT, ENGINE];

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-pattern-unique-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function writeStory(dir, body, targets) {
  const fm = [
    '---',
    `id: "${STORY_ID}"`,
    'title: "pattern_unique fixture"',
    'desc: "test"',
    'status: "not-implemented"',
    'phase: "ready"',
    'testRequirements:',
    '  - "Verify the change works and fails gracefully on invalid input"',
    'targetFiles:',
    ...targets.flatMap((t) => [`  - path: "${t}"`, '    op: "edit"', `    desc: "Edit ${t}"`]),
    '---',
  ];
  const sections = ['', '## Problem', '', 'Fixture.', '', '## Acceptance Criteria', '', '- [ ] Something works', '', body, ''];
  fs.writeFileSync(path.join(dir, 'notes', `${STORY_ID}.md`), [...fm, ...sections].join(NL));
}

function block(heading, search, replace) {
  return ['### ' + heading, '', '@@SEARCH', search, '@@REPLACE', replace, '@@END', ''].join(NL);
}

// rks_refine reads only the legacy heading-plus-fence form: a level-3 heading naming the path
// and ending in the search/replace label, then a fenced SEARCH body.
function legacyBlock(rel, search) {
  return ['### ' + rel + ' (search' + '/replace)', '', FENCE, search, FENCE, ''].join(NL);
}

function stepPlan(rel, search, replace, pathKey) {
  return { steps: [{ id: 1, action: 'search_replace', [pathKey]: rel, edits: [{ search, replace }] }] };
}

async function uniqueIssues(dir) {
  const result = await runPlanReadyTool({ projectId: 'test', problemId: STORY_ID, projectRoot: dir });
  return result.issues.filter((i) => i.check === 'pattern_unique');
}

function reviewerUniqueCheck(dir, body, targets) {
  const edits = extractExplicitEdits(body, dir, targets);
  const result = validateExplicitEdits(edits, dir, targets);
  return result.validatedEdits[0].validation.checks.find((c) => c.check === 'pattern_unique');
}

function applyOnCopy(dir, rel, search, replace) {
  const copy = path.join(dir, `${rel}.copy`);
  fs.copyFileSync(path.join(dir, rel), copy);
  return () => applySearchReplace(copy, [{ search, replace }]);
}

async function refineAmbiguity(dir, rel, search) {
  writeStory(dir, legacyBlock(rel, search), [rel]);
  const refined = await runRefineTool({ projectRoot: dir, problemId: STORY_ID, trigger: 'plan_failed', context: 'plan failed' });
  return refined.suggestions.find((s) => s.type === 'fix_search_pattern' && String(s.reason).endsWith('(ambiguous)'));
}

// One fixture through every gate. Each verdict is true when that gate ACCEPTS the SEARCH.
async function gateVerdicts(files, rel, search, replace) {
  const dir = makeProject(files);
  const body = block(rel, search, replace);
  writeStory(dir, body, [rel]);
  const planReady = (await uniqueIssues(dir)).length === 0;
  const reviewer = reviewerUniqueCheck(dir, body, [rel]).passed === true;
  const validated = validateSearchReplacePatterns(stepPlan(rel, search, replace, 'target'), dir);
  const validator = !(validated.validationErrors || []).some((e) => e.refinementType === 'ambiguous_pattern');
  const reviewed = await reviewPlan({ projectRoot: dir, plan: stepPlan(rel, search, replace, 'path') });
  const planReview = !reviewed.errors.some((e) => e.check === 'search_pattern_ambiguous');
  const refine = (await refineAmbiguity(makeProject(files), rel, search)) === undefined;
  let applier = true;
  try {
    applySearchReplace(path.join(dir, rel), [{ search, replace }]);
  } catch {
    applier = false;
  }
  return { verdicts: { planReady, reviewer, validator, planReview, refine, applier }, dir };
}

describe('the shared matcher', () => {
  it('counts whole-line hits, discounts only indentation-only hits, and keeps containment for fragments', () => {
    const cases = [
      [PY_CONTENT, `${S16}${X}`, 1, [3]],
      [PY_CONTENT, `${S12}${X}`, 1, [5]],
      [DUP_CONTENT, `${S12}${X}`, 2, [2, 4]],
      [MIX_CONTENT, MIX_SEARCH, 2, [1, 2]],
      ['const v = compute(a, b);' + NL, 'compute(a, b)', 1, [1]],
      ['aaa', 'a', 3, [1, 1, 1]],
      ['abc', 'b', 1, [1]],
    ];
    for (const [content, pattern, count, lines] of cases) {
      const found = findPatternOccurrences(content, pattern);
      expect(found.count).toBe(count);
      expect(found.offsets).toHaveLength(count);
      expect(found.lines).toEqual(lines);
      expect(countPatternOccurrences(content, pattern)).toBe(count);
      expect(countOccurrences(content, pattern)).toBe(count);
    }
  });

  it('derives the match lines from the counted offsets of the same pass', () => {
    for (const [content, pattern] of [[DUP_CONTENT, `${S12}${X}`], [MIX_CONTENT, MIX_SEARCH], [PY_CONTENT, `${S12}${X}`]]) {
      const found = findPatternOccurrences(content, pattern);
      expect(found.lines).toEqual(found.offsets.map((o) => content.slice(0, o).split(NL).length));
    }
  });
});

describe('a pattern ending in a newline meets the end-of-line condition by itself', () => {
  it('a mid-file trailing-newline anchor is whole-line, so the indentation discount applies to it', () => {
    const content = ['a', `${S12}x`, `${S16}x`, 'b', ''].join(NL);
    expect(findPatternOccurrences(content, `${S12}x${NL}`)).toMatchObject({ count: 1, lines: [2] });
    const dir = makeProject({ 'src/t.txt': content });
    expect(applyOnCopy(dir, 'src/t.txt', `${S12}x${NL}`, `${S12}y${NL}`)).not.toThrow();
    expect(fs.readFileSync(path.join(dir, 'src/t.txt.copy'), 'utf8')).toBe(['a', `${S12}y`, `${S16}x`, 'b', ''].join(NL));
  });

  it('two identical mid-file trailing-newline lines still count 2, and the three color red lines still count 3', () => {
    const twice = ['a', `${S12}x`, 'b', `${S12}x`, ''].join(NL);
    expect(findPatternOccurrences(twice, `${S12}x${NL}`)).toMatchObject({ count: 2, lines: [2, 4] });
    const red = '  color: red;' + NL;
    const css = ['.a {', red + '}', '.b {', red + '}', '.c {', red + '}', ''].join(NL);
    expect(countPatternOccurrences(css, red)).toBe(3);
  });

  it('a CRLF line ending meets the end-of-line condition', () => {
    const crlf = 'x' + '\r\n' + '    x' + '\r\n';
    expect(findPatternOccurrences(crlf, 'x')).toMatchObject({ count: 1, lines: [1] });
  });
});

describe('overlapping counting', () => {
  it('a self-overlapping pattern counts 2, and the validator, rks_plan_review and the applier all refuse it', async () => {
    const rel = 'src/over.txt';
    const content = 'aaa' + NL;
    expect(countPatternOccurrences(content, 'aa')).toBe(2);
    const dir = makeProject({ [rel]: content });
    const validated = validateSearchReplacePatterns(stepPlan(rel, 'aa', 'bb', 'target'), dir);
    expect((validated.validationErrors || []).some((e) => e.refinementType === 'ambiguous_pattern')).toBe(true);
    const reviewed = await reviewPlan({ projectRoot: dir, plan: stepPlan(rel, 'aa', 'bb', 'path') });
    expect(reviewed.errors.some((e) => e.check === 'search_pattern_ambiguous')).toBe(true);
    expect(applyOnCopy(dir, rel, 'aa', 'bb')).toThrow();
  });
});

describe('one fixture through every gate', () => {
  it('a mid-line hit whose line differs by more than leading whitespace still counts, so all six gates refuse', async () => {
    const { verdicts } = await gateVerdicts({ [MIX]: MIX_CONTENT }, MIX, MIX_SEARCH, 'computeTotal(order, tax);');
    expect(verdicts).toEqual({ planReady: false, reviewer: false, validator: false, planReview: false, refine: false, applier: false });
  });

  it('a hit whose line differs only by extra leading whitespace is discounted, so all six gates accept and the applier edits the whole-line site', async () => {
    const search = `${S12}${X}`;
    const replace = `${S12}mock_request.assert_called_once()`;
    const { verdicts, dir } = await gateVerdicts({ [PY]: PY_CONTENT }, PY, search, replace);
    expect(verdicts).toEqual({ planReady: true, reviewer: true, validator: true, planReview: true, refine: true, applier: true });
    const after = fs.readFileSync(path.join(dir, PY), 'utf8').split(NL);
    expect(after[4]).toBe(replace);
    expect(after[2]).toBe(`${S16}${X}`);
  });
});

describe('indentation is part of the anchor', () => {
  it('extractSearchPatterns keeps the leading indentation of the first SEARCH line', () => {
    const body = block(PY, `${S16}${X}`, `${S16}mock_request.assert_called_once()`);
    expect(extractSearchPatterns(body)).toEqual([`${S16}${X}`]);
  });

  it('the legacy fence and heading forms keep the leading indentation too', () => {
    const fenceForm = ['SEARCH:', FENCE + 'js', `${S12}${X}`, FENCE, ''].join(NL);
    const headingForm = ['#### SEARCH', FENCE + 'python', `${S12}${X}`, FENCE, ''].join(NL);
    expect(extractSearchPatterns(fenceForm)).toEqual([`${S12}${X}`]);
    expect(extractSearchPatterns(headingForm)).toEqual([`${S12}${X}`]);
  });

  for (const [label, indent, line] of [['16-space', S16, 3], ['12-space', S12, 5]]) {
    it(`a ${label} anchor unique as a whole line passes plan_ready, the reviewer and the applier`, async () => {
      const dir = makeProject({ [PY]: PY_CONTENT });
      const search = `${indent}${X}`;
      const replace = `${indent}mock_request.assert_called_once()`;
      const body = block(PY, search, replace);
      writeStory(dir, body, [PY]);
      expect(await uniqueIssues(dir)).toEqual([]);
      expect(reviewerUniqueCheck(dir, body, [PY]).passed).toBe(true);
      expect(countPatternOccurrences(PY_CONTENT, search)).toBe(1);
      expect(countOccurrences(PY_CONTENT, search)).toBe(1);
      expect(applyOnCopy(dir, PY, search, replace)).not.toThrow();
      const after = fs.readFileSync(path.join(dir, `${PY}.copy`), 'utf8').split(NL);
      expect(after[line - 1]).toBe(replace);
    });
  }
});

describe('a genuinely duplicated line is still refused, with its lines', () => {
  it('plan_ready names both 1-based lines in a structured field and in the message', async () => {
    const dir = makeProject({ [DUP]: DUP_CONTENT });
    writeStory(dir, block(DUP, `${S12}${X}`, `${S12}pass`), [DUP]);
    const issues = await uniqueIssues(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(DUP);
    expect(issues[0].matchLines).toEqual([2, 4]);
    expect(issues[0].message).toContain('lines 2, 4');
  });

  it('the reviewer refuses the same block with the same lines, and the applier refuses the edit', () => {
    const dir = makeProject({ [DUP]: DUP_CONTENT });
    const search = `${S12}${X}`;
    const check = reviewerUniqueCheck(dir, block(DUP, search, `${S12}pass`), [DUP]);
    expect(check.passed).toBe(false);
    expect(check.matchLines).toEqual([2, 4]);
    expect(countPatternOccurrences(DUP_CONTENT, search)).toBe(2);
    expect(applyOnCopy(dir, DUP, search, `${S12}pass`)).toThrow(/lines 2, 4/);
  });

  it('rks_plan_review and rks_refine name the same lines', async () => {
    const dir = makeProject({ [DUP]: DUP_CONTENT });
    const search = `${S12}${X}`;
    const reviewed = await reviewPlan({ projectRoot: dir, plan: stepPlan(DUP, search, `${S12}pass`, 'path') });
    const err = reviewed.errors.find((e) => e.check === 'search_pattern_ambiguous');
    expect(err.matchLines).toEqual([2, 4]);
    const suggestion = await refineAmbiguity(dir, DUP, search);
    expect(suggestion.reason).toContain('lines 2, 4');
  });
});

describe('fragment anchors keep containment semantics', () => {
  it('a mid-line SEARCH with no whole-line occurrence is counted by containment and applied', () => {
    const content = 'const v = compute(a, b);' + NL;
    expect(countPatternOccurrences(content, 'compute(a, b)')).toBe(1);
    expect(countPatternOccurrences('aaa', 'a')).toBe(3);
    const dir = makeProject({ 'src/f.mjs': content });
    expect(applyOnCopy(dir, 'src/f.mjs', 'compute(a, b)', 'compute(b, a)')).not.toThrow();
    expect(fs.readFileSync(path.join(dir, 'src/f.mjs.copy'), 'utf8')).toBe('const v = compute(b, a);' + NL);
  });
});

describe('the overlap check locates each edit where the applier applies it', () => {
  function twoStepPlan(rel, first, second) {
    return {
      steps: [
        { order: 1, title: 'Step A', action: 'search_replace', path: rel, edits: [first] },
        { order: 2, title: 'Step B', action: 'search_replace', path: rel, edits: [second] },
      ],
    };
  }

  it('two steps on the indentation-only PY fixture (lines 3 and 5) raise no overlapping_edit_regions', async () => {
    const dir = makeProject({ [PY]: PY_CONTENT });
    const plan = twoStepPlan(
      PY,
      { search: `${S16}${X}`, replace: `${S16}pass` },
      { search: `${S12}${X}`, replace: `${S12}pass` },
    );
    expect(checkOverlappingEditRegions(plan, dir).filter((i) => i.check === 'overlapping_edit_regions')).toEqual([]);
    const reviewed = await reviewPlan({ projectRoot: dir, plan });
    expect(reviewed.errors.some((e) => e.check === 'overlapping_edit_regions')).toBe(false);
  });

  it('a real overlap at the counted site is still reported when the first raw hit is a discounted indentation-only line', () => {
    // Line 2 holds X at 16 spaces (an indentation-only hit for the 12-space anchor). Step A
    // rewrites lines 3-4; step B edits the 12-space X on line 4, the same line.
    const content = ['def f():', `${S16}${X}`, 'def g():', `${S12}${X}`, ''].join(NL);
    expect(findPatternOccurrences(content, `${S12}${X}`)).toMatchObject({ count: 1, lines: [4] });
    const dir = makeProject({ [PY]: content });
    const plan = twoStepPlan(
      PY,
      { search: `def g():${NL}${S12}${X}`, replace: `def g():${NL}${S12}pass` },
      { search: `${S12}${X}`, replace: `${S12}pass` },
    );
    const issues = checkOverlappingEditRegions(plan, dir).filter((i) => i.check === 'overlapping_edit_regions');
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(PY);
  });
});

describe('uniqueness is counted in the attributed file', () => {
  it('a non-identity block under the trade_engine heading raises no pattern_unique for tradier_client', async () => {
    const dir = makeProject({ [ENGINE]: ENGINE_CONTENT, [CLIENT]: CLIENT_CONTENT });
    const body = block(ENGINE, IMPORT, `${IMPORT}${NL}import logging`);
    writeStory(dir, body, CROSS_TARGETS);
    expect(extractExplicitEdits(body, dir, CROSS_TARGETS).map((e) => e.file)).toEqual([ENGINE]);
    expect(await uniqueIssues(dir)).toEqual([]);
  });

  it('an identity anchor under a path heading or a Target-label heading raises no pattern_unique', async () => {
    for (const heading of [ENGINE, `Target: ${ENGINE}`]) {
      const dir = makeProject({ [ENGINE]: ENGINE_CONTENT, [CLIENT]: CLIENT_CONTENT });
      writeStory(dir, block(heading, IMPORT, IMPORT), CROSS_TARGETS);
      expect(await uniqueIssues(dir)).toEqual([]);
    }
  });

  it('a block whose anchor repeats in its OWN attributed file is still refused there', async () => {
    const twice = ['import os', IMPORT, 'x = 1', IMPORT, ''].join(NL);
    const dir = makeProject({ [ENGINE]: twice, [CLIENT]: CLIENT_CONTENT });
    writeStory(dir, block(ENGINE, IMPORT, `${IMPORT}${NL}import logging`), CROSS_TARGETS);
    const issues = await uniqueIssues(dir);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(ENGINE);
    expect(issues[0].matchLines).toEqual([2, 4]);
  });

  it('the planner extractor and the plan_review extractor bind an adjacent heading to the same file', () => {
    for (const heading of [ENGINE, `Target: ${ENGINE}`]) {
      const body = block(heading, IMPORT, `${IMPORT}${NL}import logging`);
      expect(extractExplicitEdits(body, null, CROSS_TARGETS)[0].file).toBe(ENGINE);
      expect(extractAuthoredBlocks(body)[0].label).toBe(ENGINE);
    }
  });
});
