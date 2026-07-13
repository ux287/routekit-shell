/**
 * Unit tests for pruneRefineBlocks in planner-context.mjs.
 *
 * Verifies that ### Target: sections (large code snapshots) are stripped when
 * the note body exceeds PLAN_NOTE_PRUNE_THRESHOLD_BYTES, while @@SEARCH/@@REPLACE/@@END
 * blocks (small anchor patterns needed by the planner) and core sections are preserved.
 */
import { describe, it, expect } from 'vitest';
import { pruneRefineBlocks, PLAN_NOTE_PRUNE_THRESHOLD_BYTES } from '../../packages/mcp-rks/src/server/planner-context.mjs';

// Build a string of exactly N bytes
function pad(n) {
  return 'x'.repeat(n);
}

const OVER = PLAN_NOTE_PRUNE_THRESHOLD_BYTES + 1;

// A note body with core sections and appended refine blocks
function makeNoteWithTargetSection(coreLen = OVER) {
  return `---
id: "backlog.feat.example"
status: "not-implemented"
---

## Problem

${pad(coreLen)}

## Acceptance Criteria

- [ ] Something

### Target: packages/mcp-rks/src/server/exec.mjs

\`\`\`js
function foo() { return 1; }
\`\`\`

### Target: packages/mcp-rks/src/server/refine.mjs

\`\`\`js
const BAR = 2;
\`\`\`
`;
}

function makeNoteWithSearchBlocks(coreLen = OVER) {
  return `---
id: "backlog.feat.example"
---

## Problem

${pad(coreLen)}

## Acceptance Criteria

- [ ] Something

@@SEARCH
function oldImpl() {
@@REPLACE
function newImpl() {
@@END

@@SEARCH
const OLD = 1;
@@REPLACE
const NEW = 2;
@@END
`;
}

// ─── threshold check ─────────────────────────────────────────────────────────

describe('pruneRefineBlocks — threshold', () => {
  it('returns body unchanged when under threshold', () => {
    const small = `## Problem\n\nshort body\n\n## Acceptance Criteria\n\n- [ ] foo`;
    expect(pruneRefineBlocks(small)).toBe(small);
  });

  it('returns body unchanged when exactly at threshold', () => {
    const exact = pad(PLAN_NOTE_PRUNE_THRESHOLD_BYTES);
    expect(pruneRefineBlocks(exact)).toBe(exact);
  });

  it('applies pruning when one byte over threshold', () => {
    const body = pad(PLAN_NOTE_PRUNE_THRESHOLD_BYTES) + '\n### Target: foo.mjs\n\nsome content\n';
    const result = pruneRefineBlocks(body);
    expect(result).not.toContain('### Target: foo.mjs');
  });

  it('respects custom threshold option', () => {
    const body = '### Target: foo.mjs\n\ncontent\n';
    // Under default threshold but over custom threshold of 1
    const result = pruneRefineBlocks(body, { threshold: 1 });
    expect(result).not.toContain('### Target: foo.mjs');
  });
});

// ─── ### Target: section stripping ───────────────────────────────────────────

describe('pruneRefineBlocks — ### Target: sections', () => {
  it('strips ### Target: sections and their content', () => {
    const body = makeNoteWithTargetSection();
    const result = pruneRefineBlocks(body);
    expect(result).not.toContain('### Target:');
    expect(result).not.toContain('function foo()');
    expect(result).not.toContain('const BAR = 2');
  });

  it('preserves ## Problem section', () => {
    const body = makeNoteWithTargetSection();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('## Problem');
  });

  it('preserves ## Acceptance Criteria section', () => {
    const body = makeNoteWithTargetSection();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('## Acceptance Criteria');
    expect(result).toContain('- [ ] Something');
  });

  it('preserves frontmatter', () => {
    const body = makeNoteWithTargetSection();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('id: "backlog.feat.example"');
    expect(result).toContain('status: "not-implemented"');
  });

  it('a 15KB note with 10KB of Target sections is reduced below threshold', () => {
    const coreBody = pad(5000);
    const targetSection = `### Target: packages/foo.mjs\n\n${pad(10000)}\n`;
    const body = `## Problem\n\n${coreBody}\n\n## Acceptance Criteria\n\n- [ ] x\n\n${targetSection}`;
    const result = pruneRefineBlocks(body, { threshold: 5000 });
    expect(result.length).toBeLessThan(body.length);
    expect(result).not.toContain('### Target:');
    expect(result).toContain('## Problem');
  });
});

// ─── @@SEARCH/@@REPLACE/@@END block preservation ─────────────────────────────

describe('pruneRefineBlocks — @@SEARCH/@@REPLACE/@@END blocks preserved', () => {
  it('preserves @@SEARCH lines verbatim when note exceeds threshold', () => {
    const body = makeNoteWithSearchBlocks();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('@@SEARCH');
  });

  it('preserves @@REPLACE lines verbatim when note exceeds threshold', () => {
    const body = makeNoteWithSearchBlocks();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('@@REPLACE');
  });

  it('preserves @@END lines verbatim when note exceeds threshold', () => {
    const body = makeNoteWithSearchBlocks();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('@@END');
  });

  it('preserves anchor pattern content between @@SEARCH and @@END', () => {
    const body = makeNoteWithSearchBlocks();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('function oldImpl()');
    expect(result).toContain('const OLD = 1');
  });

  it('preserves ## sections when note has @@SEARCH blocks', () => {
    const body = makeNoteWithSearchBlocks();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('## Problem');
    expect(result).toContain('## Acceptance Criteria');
    expect(result).toContain('- [ ] Something');
  });

  it('returns @@SEARCH blocks unchanged when under threshold', () => {
    const small = `## Problem\n\nshort\n\n@@SEARCH\nfoo\n@@REPLACE\nbar\n@@END\n`;
    expect(pruneRefineBlocks(small)).toBe(small);
  });
});

// ─── mixed: ### Target: stripped, @@SEARCH preserved ─────────────────────────

describe('pruneRefineBlocks — mixed blocks (### Target: stripped, @@SEARCH preserved)', () => {
  function makeMixedNote(coreLen = OVER) {
    return `---
id: "backlog.feat.example"
---

## Problem

${pad(coreLen)}

## Acceptance Criteria

- [ ] Something

### Target: packages/mcp-rks/src/server/exec.mjs

\`\`\`js
function foo() { return 1; }
\`\`\`

### Target: src/other.mjs

\`\`\`js
const BAR = 2;
\`\`\`

## Refinement History (2026-04-16)

@@SEARCH
function handleSelectChange(field) {
@@REPLACE
function handleSelectChange(field) {
@@END

@@SEARCH
function handleSave() {
@@REPLACE
function handleSave() {
@@END
`;
  }

  it('strips ### Target: sections when note contains both block types', () => {
    const body = makeMixedNote();
    const result = pruneRefineBlocks(body);
    expect(result).not.toContain('### Target:');
    expect(result).not.toContain('function foo()');
    expect(result).not.toContain('const BAR = 2');
  });

  it('preserves @@SEARCH blocks when note contains both block types', () => {
    const body = makeMixedNote();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('@@SEARCH');
    expect(result).toContain('@@REPLACE');
    expect(result).toContain('@@END');
    expect(result).toContain('function handleSelectChange(field)');
    expect(result).toContain('function handleSave()');
  });

  it('preserves core sections in mixed-block note', () => {
    const body = makeMixedNote();
    const result = pruneRefineBlocks(body);
    expect(result).toContain('## Problem');
    expect(result).toContain('## Acceptance Criteria');
    expect(result).toContain('- [ ] Something');
  });
});

// ─── REAL refine layout: @@SEARCH nested INSIDE a ### Target: section ─────────
// This is the layout add_search_pattern actually produces (refine.mjs:1506-1510):
// a `### Target:` snapshot fence, then a `### <path>` header, then a nested
// @@SEARCH/@@REPLACE/@@END corrective block — with NO `## ` boundary before the anchor.
// The pre-fix prune dropped the corrective anchor along with the snapshot, so the planner
// regenerated the buggy code. The anchor must survive; the snapshot must still be stripped.

describe('pruneRefineBlocks — anchor nested INSIDE a ### Target: section (real refine layout)', () => {
  function makeNestedAnchorNote(coreLen = OVER) {
    return `---
id: "backlog.feat.example"
---

## Problem

${pad(coreLen)}

## Acceptance Criteria

- [ ] Something

### Target: components/AuditRules.tsx

\`\`\`tsx
// SNAPSHOT_BLOAT — full-file code that crowds out RAG retrieval
const entity = ENTITY_CATALOG[key];
export function AuditRules() { return null; }
\`\`\`

### components/AuditRules.tsx

@@SEARCH
const entity = ENTITY_CATALOG[key];
@@REPLACE
const entity = ENTITY_CATALOG.find((e) => e.key === key);
@@END
`;
  }

  it('STRIPS the fenced snapshot inside the ### Target: section', () => {
    const result = pruneRefineBlocks(makeNestedAnchorNote());
    expect(result).not.toContain('SNAPSHOT_BLOAT');
    expect(result).not.toContain('export function AuditRules()');
    expect(result).not.toContain('### Target:');
  });

  it('PRESERVES the nested @@SEARCH/@@REPLACE/@@END corrective block verbatim', () => {
    const result = pruneRefineBlocks(makeNestedAnchorNote());
    expect(result).toContain('@@SEARCH');
    expect(result).toContain('@@REPLACE');
    expect(result).toContain('@@END');
    // the corrective REPLACE (the .find fix) must survive for extractSearchReplaceBlocks
    expect(result).toContain('ENTITY_CATALOG.find((e) => e.key === key)');
  });

  it('keeps the @@SEARCH…@@END trio ordered + closed (extractSearchReplaceBlocks contract)', () => {
    const result = pruneRefineBlocks(makeNestedAnchorNote());
    const s = result.indexOf('@@SEARCH');
    const r = result.indexOf('@@REPLACE');
    const e = result.indexOf('@@END');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(r).toBeGreaterThan(s);
    expect(e).toBeGreaterThan(r);
  });

  it('preserves core ## sections alongside the nested anchor', () => {
    const result = pruneRefineBlocks(makeNestedAnchorNote());
    expect(result).toContain('## Problem');
    expect(result).toContain('## Acceptance Criteria');
  });
});

// ─── edge cases ──────────────────────────────────────────────────────────────

describe('pruneRefineBlocks — edge cases', () => {
  it('returns body unchanged for null input', () => {
    expect(pruneRefineBlocks(null)).toBeNull();
  });

  it('returns body unchanged for undefined input', () => {
    expect(pruneRefineBlocks(undefined)).toBeUndefined();
  });

  it('returns body unchanged for empty string', () => {
    expect(pruneRefineBlocks('')).toBe('');
  });

  it('handles body over threshold with no refine blocks (no-op on content)', () => {
    const body = `## Problem\n\n${pad(OVER)}\n\n## Acceptance Criteria\n\n- [ ] x`;
    const result = pruneRefineBlocks(body);
    // Content preserved, no stripping needed
    expect(result).toContain('## Problem');
    expect(result).toContain('## Acceptance Criteria');
  });
});

// ─── capMode hard-cap fallback: shed oldest @@SEARCH anchors, keep the youngest ─────────────
// The soft path (default opts) preserves ALL anchors. The write-path hard cap
// (refine.mjs, MAX_NOTE_BODY_BYTES) passes { capMode: true, threshold } — a last-resort
// ceiling that sheds anchor blocks oldest-first while always keeping the youngest/active
// corrective anchor, so the planner still receives the live fix.

describe('pruneRefineBlocks — capMode hard-cap fallback (sheds oldest anchors, keeps youngest)', () => {
  function makeManyAnchors(count, padPerBlock = 40) {
    const blocks = Array.from({ length: count }, (_, i) =>
      `@@SEARCH\nexport function anchor_${i}() {\n${'// pad '.repeat(padPerBlock)}\n@@REPLACE\nexport function anchor_${i}() {\n@@END`
    ).join('\n');
    return `## Problem\n\ncore\n\n${blocks}\n`;
  }

  it('sheds OLDEST anchors and KEEPS the youngest when the body exceeds the hard threshold', () => {
    const body = makeManyAnchors(20);
    const threshold = 2048;
    expect(body.length).toBeGreaterThan(threshold);
    const result = pruneRefineBlocks(body, { capMode: true, threshold });
    expect(result.length).toBeLessThanOrEqual(threshold);
    expect(result).toContain('anchor_19'); // youngest kept
    expect(result).not.toContain('anchor_0'); // oldest shed
    expect(result).toContain('## Problem'); // core section preserved
  });

  it('never drops the last/youngest anchor even if the note stays over cap', () => {
    // A single anchor that alone exceeds the threshold cannot be shed below it — it must be
    // kept (the caller then emits a WARNING and writes the pruned version).
    const huge = `## Problem\n\ncore\n\n@@SEARCH\nexport function only() {\n${'// pad '.repeat(1000)}\n@@REPLACE\nexport function only() {\n@@END\n`;
    const result = pruneRefineBlocks(huge, { capMode: true, threshold: 512 });
    expect(result).toContain('@@SEARCH');
    expect(result).toContain('only()');
  });

  it('keeps the surviving anchor trio ordered + closed (extractSearchReplaceBlocks contract)', () => {
    const result = pruneRefineBlocks(makeManyAnchors(20), { capMode: true, threshold: 2048 });
    const s = result.indexOf('@@SEARCH');
    const r = result.indexOf('@@REPLACE');
    const e = result.indexOf('@@END');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(r).toBeGreaterThan(s);
    expect(e).toBeGreaterThan(r);
  });

  it('default opts (capMode off) preserve ALL anchors — pre-existing soft-path behavior', () => {
    const body = makeManyAnchors(20);
    const result = pruneRefineBlocks(body); // default: threshold 5120, capMode off
    expect(result).toContain('anchor_0');
    expect(result).toContain('anchor_19');
  });

  it('capMode is a no-op when the body is already under the hard threshold', () => {
    const small = `## Problem\n\ncore\n\n@@SEARCH\nfoo\n@@REPLACE\nbar\n@@END\n`;
    expect(pruneRefineBlocks(small, { capMode: true, threshold: PLAN_NOTE_PRUNE_THRESHOLD_BYTES })).toBe(small);
  });
});
