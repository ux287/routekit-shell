/**
 * Edge cases for the sliceNote helper (backlog.fix.dendron-read-note-bounded-slice).
 *
 * The caller-facing behaviour is witnessed in
 * tests/integration/dendron-read-note-bounded-slice.test.mjs, which drives the real
 * MCP handler — that is where the defect lives. These cover the pure function's
 * boundaries, which are cheap to exercise directly and awkward to reach over the wire.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect } from "vitest";
import { sliceNote, headings, DEFAULT_MAX_BYTES } from "../../packages/mcp-rks/src/shared/note-slice.mjs";

const NOTE = [
  "---",
  'id: "x"',
  "targetFiles:",
  '  - path: "a.mjs"',
  "other: 1",
  "---",
  "",
  "## One",
  "body one",
  "",
  "### Nested",
  "nested body",
  "",
  "## Two",
  "body two",
  "",
].join("\n");

describe("sliceNote boundaries", () => {
  it("treats a note with no frontmatter as all body", () => {
    const r = sliceNote("## Only\ntext\n", { sections: ["Only"] });
    expect(r.content).toContain("## Only");
  });

  it("treats an unterminated frontmatter fence as body, rather than throwing", () => {
    expect(() => sliceNote("---\nid: x\nnever closed\n", {})).not.toThrow();
  });

  it("a section runs to the NEXT heading of any level, nested ones included", () => {
    const r = sliceNote(NOTE, { sections: ["One"] });
    expect(r.content).toContain("body one");
    // "### Nested" is the next heading, so it bounds the section.
    expect(r.content).not.toContain("nested body");
    expect(r.content).not.toContain("body two");
  });

  it("a field carries its indented block but stops at the next top-level key", () => {
    const r = sliceNote(NOTE, { fields: ["targetFiles"] });
    expect(r.content).toContain('path: "a.mjs"');
    expect(r.content).not.toContain("other: 1");
  });

  it("an unknown section or field yields empty content, never a throw", () => {
    expect(sliceNote(NOTE, { sections: ["Nope"] }).content).toBe("");
    expect(sliceNote(NOTE, { fields: ["nope"] }).content).toBe("");
  });

  it("rejects unusable numeric input rather than coercing it to zero", () => {
    // "abc" -> NaN -> null -> treated as absent, so this is an unbounded read.
    const r = sliceNote(NOTE, { offset: "abc" });
    expect(r.bounded).toBe(false);
    expect(r.content).toBe(NOTE);
  });

  it("limit 0 returns no lines and is still a bounded, truncated read", () => {
    const r = sliceNote(NOTE, { offset: 0, limit: 0 });
    expect(r.content).toBe("");
    expect(r.bounded).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("an explicit maxBytes marks the read bounded even when nothing is cut", () => {
    const r = sliceNote(NOTE, { maxBytes: 1_000_000 });
    expect(r.bounded).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.returnedBytes).toBe(r.totalBytes);
  });

  it("the default cap is a constant the caller can override, not a hardcode", () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(0);
    const big = "x".repeat(DEFAULT_MAX_BYTES + 10);
    expect(sliceNote(big, {}).truncated).toBe(true);
    expect(sliceNote(big, { maxBytes: DEFAULT_MAX_BYTES + 100 }).truncated).toBe(false);
  });

  // NOTE ON `offset: 0` IN THESE CASES: it is a SELECTOR, and the byte-cap path
  // is only reached when one is present — an unselected over-cap read returns the
  // navigable manifest instead and never cuts anything. Without it these cases
  // would assert against the manifest branch and prove nothing about the cut.
  //
  // backlog.fix.post-ship-review-findings-batch, Finding 1 — the unit mirror of
  // the caller-facing witness in the integration suite. Both tiers, because the
  // corrupted value crossed the wire AND was computed here: a witness on only one
  // side would leave the other free to drift.

  it("MID-SEQUENCE CUT — the cap backs off to a character boundary, no U+FFFD", () => {
    const text = "abcdefghij\u2014klmnop";
    const buf = Buffer.from(text, "utf8");
    const dashAt = buf.indexOf(Buffer.from("\u2014", "utf8"));
    const cap = dashAt + 1;

    // FIXTURE PRECONDITION: the cap really lands inside the character. Without
    // it, an all-ASCII edit would make the assertions below pass vacuously.
    expect(dashAt).toBeGreaterThan(-1);
    expect(buf[cap] & 0xc0).toBe(0x80);

    const r = sliceNote(text, { maxBytes: cap, offset: 0 });

    // EXACT, and strictly below the cap. Kills the clamp
    //   returnedBytes = truncated ? maxBytes : Buffer.byteLength(content, "utf8")
    // which would answer cap here. toBeLessThanOrEqual cannot.
    expect(r.returnedBytes).toBe(dashAt);
    expect(r.returnedBytes).toBeLessThan(cap);
    expect(r.content).toBe(text.slice(0, dashAt));
    expect(r.content).not.toContain("\uFFFD");
    expect(r.truncated).toBe(true);
  });

  it("a cap that clears the character keeps it whole and counts all of it", () => {
    const text = "abcdefghij\u2014klmnop";
    const buf = Buffer.from(text, "utf8");
    const cap = buf.indexOf(Buffer.from("\u2014", "utf8")) + 3;
    const r = sliceNote(text, { maxBytes: cap, offset: 0 });
    expect(r.returnedBytes).toBe(cap);
    expect(r.content.endsWith("\u2014")).toBe(true);
    expect(r.content).not.toContain("\uFFFD");
  });

  it("a cap smaller than the FIRST character returns empty rather than a corrupt byte", () => {
    // The degenerate end of the back-off: nothing fits, so nothing is returned.
    const r = sliceNote("\u2014abc", { maxBytes: 2, offset: 0 });
    expect(r.returnedBytes).toBe(0);
    expect(r.content).toBe("");
    expect(r.content).not.toContain("\uFFFD");
  });

  it("returnedBytes never exceeds maxBytes, swept across every cut position", () => {
    // The property, not one example. Every cap from 0 to the full length must
    // hold it — the old code broke it at exactly the mid-sequence positions.
    const text = "a\u2014b\u00e9c\u65e5d";
    const total = Buffer.byteLength(text, "utf8");
    for (let cap = 0; cap <= total; cap++) {
      const r = sliceNote(text, { maxBytes: cap, offset: 0 });
      expect(r.returnedBytes, `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(r.returnedBytes, `cap ${cap}`).toBe(Buffer.byteLength(r.content, "utf8"));
      expect(r.content, `cap ${cap}`).not.toContain("\uFFFD");
    }
  });

  it("headings reports level and 1-based line for each", () => {
    const h = headings(NOTE);
    expect(h.map((x) => x.heading)).toEqual(["One", "Nested", "Two"]);
    expect(h[1].level).toBe(3);
    expect(NOTE.split("\n")[h[0].line - 1]).toBe("## One");
  });
});
