/**
 * backlog.fix.exhaustive-search-case-sensitivity-undisclosed.
 *
 * rks_exhaustive_search matches case-sensitively. That is defensible for a literal
 * search tool. What was not defensible is that Tool Reliability caution 1 — carried
 * byte-identically in all five governor prompts — licensed treating a zero as PROVEN
 * ABSENCE whenever a positive control on the same scope returned a hit, and that rule
 * cannot detect a case mismatch: the control tests the SCOPE, the query tests the
 * PATTERN. A Governor following the discipline exactly reports content that is present
 * as absent.
 *
 * These are behavioural witnesses against a fixture this file creates. They
 * characterise the matcher and demonstrate the workarounds the amended caution names.
 * They do NOT witness that any Governor obeys it — no assertion available here can.
 *
 * FORWARD COMPATIBILITY: nothing below asserts on `exhaustive`, on any disclosure
 * field, or on any reason string. Those are the deliverable of
 * backlog.fix.exhaustive-search-dotdir-silent-zero, which ships against this same
 * matcher and is still unbuilt.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runExhaustiveSearch } from "../../packages/rag/src/tools.mjs";

// The fixture is created here and torn down after. It deliberately does NOT read any
// repo note or prompt: a witness that depended on notes/public.canon.getting-started.md
// would turn red or green because that note's content moved, which is not what it is
// about. It is also NOT sited under <repo>/tests/.tmp — packages/rag/src/tools.mjs
// prunes that path directly under the project root, which would make every assertion
// below vacuous by returning zero for the right reason.
let root;

const HEADING = "## 8. Cost Visibility";
const LOWER = "the cost visibility section is where operators look first";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-case-sensitivity-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "docs", "guide.md"),
    ["# Guide", "", HEADING, "", "Body text.", "", LOWER, ""].join("\n"),
    "utf8",
  );
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// `path` is required — exhaustive search is bounded, never repo-wide. Scoping to the
// one fixture directory also makes every zero below a SCOPED zero, which is the shape
// a Governor actually issues.
const search = (pattern) => runExhaustiveSearch(root, { pattern, path: "docs" });

describe("rks_exhaustive_search is case-sensitive", () => {
  it("finds the heading under its exact casing", () => {
    const r = search("Cost Visibility");
    expect(r.matchCount).toBe(1);
    expect(r.results[0].text).toBe(HEADING);
  });

  it("returns zero for the same phrase mis-cased", () => {
    const r = search("Cost visibility");
    expect(r.fileCount).toBe(0);
    expect(r.matchCount).toBe(0);
  });
});

describe("a positive control does not detect a case mismatch", () => {
  it("the control hits and the mis-cased query zeroes on the SAME scope", () => {
    // THE CENTRE OF GRAVITY. These two results together satisfy the precondition
    // caution 1 states for reporting a zero as proven absence — while the content is
    // demonstrably present, three lines up. That is the false absence the unamended
    // rule licensed.
    //
    // The control literal is DISTINCT from the query, which is faithful to how a
    // Governor works: the query returned zero, so it cannot itself be the thing
    // already known to be present.
    const control = search("Body text.");
    const query = search("Cost visibility");

    expect(control.matchCount).toBeGreaterThan(0);
    expect(query.matchCount).toBe(0);

    // And the content the query "proved absent" is right there.
    expect(search("Cost Visibility").matchCount).toBe(1);
  });
});

describe("the workarounds the amended caution names", () => {
  it("sweeping both casings recovers what either alone would miss", () => {
    const upper = search("Cost Visibility").matchCount;
    const lower = search("cost visibility").matchCount;
    expect(upper).toBe(1);
    expect(lower).toBe(1);
    // Neither casing alone sees both lines; the sweep sees both.
    expect(upper + lower).toBe(2);
  });

  it("a case-invariant substring matches both casings at once", () => {
    const r = search("isibility");
    expect(r.matchCount).toBe(2);
    const texts = r.results.map((x) => x.text);
    expect(texts).toContain(HEADING);
    expect(texts).toContain(LOWER);
  });

  it("enumerating a structural literal recovers the content a phrase query missed", () => {
    // Pins the TECHNIQUE as effective against a fixture. Per ARCH it must not be read
    // as evidence that any Governor will use it.
    const r = search("## ");
    expect(r.results.map((x) => x.text)).toContain(HEADING);
  });
});
