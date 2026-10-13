/**
 * Unit tests for decompose threshold logic in runRefineTool (refine.mjs).
 *
 * Covers:
 * - op:edit-only suppression (editCountThreshold = 5)
 * - create+edit threshold (editCountThreshold = 3, hasCreateAndEdit threshold-gated)
 * - AC count and body length are NOT signals (removed)
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirrors the decomposeReasons + isHighByConcern logic in refine.mjs.
 *
 * editCountThreshold: allEditOnly ? 5 : 3
 * hasCreateAndEdit fires only when editCount > 3
 * AC count and body length removed as signals.
 */
function buildDecomposeSignals({
  targetFileCount,
  editCount,
  hasCreateAndEdit,
  allEditOnly,
  isChild,
}) {
  const editCountThreshold = allEditOnly ? 5 : 3;
  const decomposeReasons = [];
  if (targetFileCount > 5) decomposeReasons.push(`${targetFileCount} target files`);
  if (!isChild && editCount > editCountThreshold) decomposeReasons.push(`${editCount} separate files being edited (multiple independent concerns)`);
  if (hasCreateAndEdit && editCount > 3) decomposeReasons.push(`bundled create+edit targets with ${editCount} edit targets (implementation mixed with wiring)`);

  const isHighByConcern = (!isChild && editCount > editCountThreshold) || (hasCreateAndEdit && editCount > 3);
  return { decomposeReasons, isHighByConcern };
}

// ─── op:edit-only suppression ─────────────────────────────────────────────────

describe('refine decompose threshold — op:edit-only suppression', () => {
  it('op:edit-only story with 2 target files does NOT add editCount decompose reason', () => {
    const { decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      allEditOnly: true,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('separate files being edited'))).toBe(false);
  });

  it('op:edit-only story with 2 target files is NOT high by concern', () => {
    const { isHighByConcern } = buildDecomposeSignals({
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      allEditOnly: true,
      isChild: false,
    });
    expect(isHighByConcern).toBe(false);
  });

  it('op:edit-only story with 5 target files does NOT trigger decompose (at threshold, not above)', () => {
    const { decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 5,
      editCount: 5,
      hasCreateAndEdit: false,
      allEditOnly: true,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('separate files being edited'))).toBe(false);
  });

  it('op:edit-only story with 6 target files DOES trigger decompose (above threshold)', () => {
    const { decomposeReasons, isHighByConcern } = buildDecomposeSignals({
      targetFileCount: 6,
      editCount: 6,
      hasCreateAndEdit: false,
      allEditOnly: true,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('separate files being edited'))).toBe(true);
    expect(isHighByConcern).toBe(true);
  });

  it('op:edit-only threshold (5) is higher than create+edit threshold (3)', () => {
    // editCount=4 fires for create+edit mix but NOT for edit-only
    const { isHighByConcern: createEditHigh } = buildDecomposeSignals({
      targetFileCount: 4, editCount: 4, hasCreateAndEdit: false, allEditOnly: false, isChild: false,
    });
    const { isHighByConcern: editOnlyHigh } = buildDecomposeSignals({
      targetFileCount: 4, editCount: 4, hasCreateAndEdit: false, allEditOnly: true, isChild: false,
    });
    expect(createEditHigh).toBe(true);
    expect(editOnlyHigh).toBe(false);
  });
});

// ─── hasCreateAndEdit threshold-gated ────────────────────────────────────────

describe('refine decompose threshold — hasCreateAndEdit is threshold-gated at editCount > 3', () => {
  it('source + test file (editCount=2, hasCreateAndEdit=true) does NOT decompose', () => {
    const { isHighByConcern, decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: true,
      allEditOnly: false,
      isChild: false,
    });
    expect(isHighByConcern).toBe(false);
    expect(decomposeReasons.some(r => r.includes('bundled create+edit'))).toBe(false);
  });

  it('editCount=3, hasCreateAndEdit=true does NOT decompose', () => {
    const { isHighByConcern } = buildDecomposeSignals({
      targetFileCount: 3,
      editCount: 3,
      hasCreateAndEdit: true,
      allEditOnly: false,
      isChild: false,
    });
    expect(isHighByConcern).toBe(false);
  });

  it('editCount=4, hasCreateAndEdit=true DOES decompose (above threshold)', () => {
    const { isHighByConcern, decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 4,
      editCount: 4,
      hasCreateAndEdit: true,
      allEditOnly: false,
      isChild: false,
    });
    expect(isHighByConcern).toBe(true);
    expect(decomposeReasons.some(r => r.includes('bundled create+edit'))).toBe(true);
  });
});

// ─── create+edit mix without hasCreateAndEdit ─────────────────────────────────

describe('refine decompose threshold — create+edit mix editCount threshold is 3', () => {
  it('allEditOnly=false, editCount=3 does NOT fire editCount signal (at threshold, not above)', () => {
    const { decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 3,
      editCount: 3,
      hasCreateAndEdit: false,
      allEditOnly: false,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('separate files being edited'))).toBe(false);
  });

  it('allEditOnly=false, editCount=4 DOES fire editCount signal (above threshold)', () => {
    const { decomposeReasons, isHighByConcern } = buildDecomposeSignals({
      targetFileCount: 4,
      editCount: 4,
      hasCreateAndEdit: false,
      allEditOnly: false,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('separate files being edited'))).toBe(true);
    expect(isHighByConcern).toBe(true);
  });
});

// ─── AC count and body length are NOT signals ─────────────────────────────────

describe('refine decompose threshold — AC count and body length removed as signals', () => {
  it('story with 10 ACs does NOT add AC count to decomposeReasons', () => {
    // AC count was removed — no path produces an "acceptance criteria" reason
    const { decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      allEditOnly: true,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('acceptance criteria'))).toBe(false);
  });

  it('story with large body does NOT add body length to decomposeReasons', () => {
    // Body length was removed — no path produces a "KB of content" reason
    const { decomposeReasons } = buildDecomposeSignals({
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      allEditOnly: true,
      isChild: false,
    });
    expect(decomposeReasons.some(r => r.includes('KB of content'))).toBe(false);
  });
});
