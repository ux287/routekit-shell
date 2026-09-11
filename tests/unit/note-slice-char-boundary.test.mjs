/**
 * Characterization and out-of-bounds witness for lastCharBoundaryAtOrBefore.
 *
 * backlog.fix.ship-review-evidence-followups, item A1.
 *
 * THE OBSERVATION. When the cap is at or beyond the buffer length the walk-back
 * loop reads `buf[buf.length]` — one past the end. That yields `undefined`,
 * `undefined & 0xc0` coerces to `0`, `0 === 0x80` is false, and the loop exits
 * with the right answer. The RESULT was never wrong; the bound was simply never
 * stated, and the correctness rested on a coercion nobody had written down.
 *
 * WHY A PROXY AND NOT A VALUE ASSERTION. The fix must not change a single
 * returned index — that is an acceptance criterion of this story. So by
 * construction NO assertion on return values can tell fixed from unfixed. The
 * out-of-bounds READ is the only differing observable, which is why the witness
 * records index access instead of comparing outputs.
 *
 * The helper had ZERO direct test imports before this file: it was exercised
 * only through sliceNote and the fetch-raw body cap. Refactoring an untested
 * export against an unpinned contract is the real risk here, so the second
 * describe pins every branch of the return contract with values captured from
 * the PRE-change implementation.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect } from 'vitest';
import { lastCharBoundaryAtOrBefore } from '../../packages/mcp-rks/src/shared/note-slice.mjs';

// 'héllo' — 6 bytes, 5 characters. The two-byte é occupies indices 1-2, so a cap
// of 2 lands on a continuation byte and must walk back to 1.
const TEXT = 'héllo';
const BYTES = Buffer.from(TEXT, 'utf8');

/** A buffer that records every numeric index read through it. */
function recordingBuffer(buf) {
  const reads = [];
  const proxy = new Proxy(buf, {
    get(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.push(Number(prop));
      // NO receiver argument. Forwarding the proxy as the receiver routes the
      // TypedArray `length` getter through an incompatible object and throws
      // `Method get TypedArray.prototype.length called on incompatible
      // receiver`. That failure looks like a red witness and is not one — it is
      // the harness breaking, which this story explicitly forbids as evidence.
      return Reflect.get(target, prop);
    },
  });
  return { proxy, reads };
}

describe('lastCharBoundaryAtOrBefore reads nothing past the end of the buffer', () => {
  it('FIXTURE PRECONDITION — the recording buffer really does observe index reads', () => {
    // Anti-vacuity. If the Proxy never saw an index access, the assertions below
    // would pass against ANY implementation, including the unfixed one.
    const { proxy, reads } = recordingBuffer(BYTES);
    expect(BYTES).toHaveLength(6);
    lastCharBoundaryAtOrBefore(proxy, 2);
    expect(reads.length, 'the Proxy recorded no index reads at all').toBeGreaterThan(0);
  });

  it('A1 WITNESS — cap EQUAL to buf.length reads no index at or past the end', () => {
    const { proxy, reads } = recordingBuffer(BYTES);
    const result = lastCharBoundaryAtOrBefore(proxy, BYTES.length);
    expect(result).toBe(6);
    expect(
      reads.filter((i) => i >= BYTES.length),
      `read past the end of the buffer at ${JSON.stringify(reads.filter((i) => i >= BYTES.length))}`,
    ).toEqual([]);
  });

  it('A1 WITNESS — cap BEYOND buf.length reads no index at or past the end', () => {
    const { proxy, reads } = recordingBuffer(BYTES);
    const result = lastCharBoundaryAtOrBefore(proxy, 99);
    expect(result).toBe(6);
    expect(
      reads.filter((i) => i >= BYTES.length),
      `read past the end of the buffer at ${JSON.stringify(reads.filter((i) => i >= BYTES.length))}`,
    ).toEqual([]);
  });

  it('an in-range cap still reads only in-range indices', () => {
    const { proxy, reads } = recordingBuffer(BYTES);
    lastCharBoundaryAtOrBefore(proxy, 2);
    expect(reads.every((i) => i < BYTES.length)).toBe(true);
  });
});

describe('lastCharBoundaryAtOrBefore return contract — captured from the pre-change implementation', () => {
  // Every expected value below was taken from the implementation BEFORE this
  // story touched it, so the change is proven behaviour-identical rather than
  // assumed so. None of these may move.
  const cases = [
    ['cap 0 — nothing fits', BYTES, 0, 0],
    ['cap 1 — lands on the lead byte of the two-byte char', BYTES, 1, 1],
    ['cap 2 — lands on a CONTINUATION byte, walks back', BYTES, 2, 1],
    ['cap 3 — lands on an ASCII byte, no walk-back', BYTES, 3, 3],
    ['cap 6 — exactly buf.length', BYTES, 6, 6],
    ['cap 99 — far beyond buf.length, clamps', BYTES, 99, 6],
    ['empty buffer, cap 0', Buffer.alloc(0), 0, 0],
    ['empty buffer, cap 5', Buffer.alloc(0), 5, 0],
  ];

  it.each(cases)('%s', (_label, buf, cap, expected) => {
    expect(lastCharBoundaryAtOrBefore(buf, cap)).toBe(expected);
  });

  it('ANTI-VACUITY — the table is not all one answer', () => {
    // A table whose every row expects the same number would pass against a
    // function that ignored its arguments.
    expect(new Set(cases.map(([, , , expected]) => expected)).size).toBeGreaterThan(2);
  });

  it('never returns an index that splits a character', () => {
    // The property the whole helper exists for, swept across every cap.
    for (let cap = 0; cap <= BYTES.length + 2; cap++) {
      const end = lastCharBoundaryAtOrBefore(BYTES, cap);
      expect(end, `cap ${cap} exceeded the cap`).toBeLessThanOrEqual(Math.min(cap, BYTES.length));
      if (end < BYTES.length) {
        expect(BYTES[end] & 0xc0, `cap ${cap} landed mid-character`).not.toBe(0x80);
      }
    }
  });
});
