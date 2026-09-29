/**
 * Witness for backlog.fix.reviewer-search-block-heading-adjacency-attribution.
 *
 * THE DEFECT: in reviewer.mjs's Pattern 5 the file heading is an OPTIONAL PREFIX GROUP that must
 * be CONTIGUOUS with the marker. `\n\s*` tolerates blank lines but NOT prose. A heading separated
 * from its blocks by a sentence of explanation therefore never fired the group, and every block
 * under it inherited the sticky `currentFile` from the PREVIOUS heading. The rule in force was
 * "immediately-adjacent heading, else last attributed file" — never "nearest preceding heading".
 *
 * FIELD EVIDENCE (routekit-growth, rks v0.50.6): a note with one adjacent block under
 * `### packages/archive/package.json` and three prose-separated blocks under
 * `### packages/cli/bin/growth.mjs` reported all three growth.mjs patterns as missing FROM
 * package.json — correct patterns, wrong file — and blocked an arch-approved story.
 *
 * FIXTURE SHAPE IS LOAD-BEARING, twice over:
 *   - A single-heading fixture passes with the defect fully present.
 *   - So does a fixture whose headings are all adjacent to their blocks.
 *   - And so does one separated by a CODE FENCE: reviewer.mjs strips fence lines BEFORE this
 *     pattern runs, collapsing the fence to whitespace that `\s*` already tolerates. The
 *     separator must be PLAIN PROSE.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractExplicitEdits } from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import { extractMustEditPaths } from "../../packages/mcp-rks/src/llm/planner.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const FILE_A = "packages/archive/package.json";
const FILE_B = "packages/cli/bin/growth.mjs";
const DECLARED = [FILE_A, FILE_B];

// Markers are assembled rather than written literally so no line of THIS file begins with a
// canonical marker at column 0 — otherwise a tool scanning the repo would parse the fixtures
// below as real edit blocks.
const S = "@" + "@SEARCH";
const R = "@" + "@REPLACE";
const E = "@" + "@END";

const block = (search, replace) => [S, search, R, replace, E].join("\n");

// The child's exact shape: heading A with ONE adjacent block, then heading B separated from its
// THREE blocks by prose.
const CHILD_SHAPED_NOTE = [
  `### ${FILE_A}`,
  block('  "." : "./src/index.mjs"', '  "." : "./src/index.mjs",'),
  "",
  `### ${FILE_B}`,
  "",
  "Three real hunks, no pure anchors: the import, the new command branch, and the help line",
  "the spawn test reads back. Both symbols the import adds are defined by the edit above, so",
  "there is no unprovided import.",
  "",
  block('} from "../src/index.mjs";', '  showLedger,\n} from "../src/index.mjs";'),
  "",
  block('    case "sources": {', '    case "ledger": {\n    case "sources": {'),
  "",
  block("  growth sources    list sources", "  growth sources    list sources\n  growth ledger     show ledger"),
  "",
].join("\n");

describe("a prose-separated heading still attributes its blocks", () => {
  it("binds each block to its NEAREST PRECEDING heading, not the first", () => {
    const edits = extractExplicitEdits(CHILD_SHAPED_NOTE, null, DECLARED);
    expect(edits).toHaveLength(4);
    // Per-block attribution by name. Asserting only a COUNT would pass for the wrong reason —
    // the defect produced four edits too, just three of them misfiled.
    const attributed = edits.map((e) => e.file);
    expect(attributed).toEqual([FILE_A, FILE_B, FILE_B, FILE_B]);
  });

  it("the fixture's separator is prose, not a fence — a fence would pass with the defect", () => {
    // Guards the fixture itself. reviewer.mjs strips ```-lines before Pattern 5, so a fenced
    // separator collapses to whitespace the existing `\s*` already tolerates.
    const between = CHILD_SHAPED_NOTE.split(`### ${FILE_B}`)[1].split(S)[0];
    expect(between).toContain("Three real hunks");
    expect(between).not.toContain("```");
  });
});

describe("the 0.50.3 acceptance gate is not regressed", () => {
  it("resolves ACROSS a rejected prose heading to the last accepted file", () => {
    // `### 2. Wire the ledger row` must NOT be accepted as a path. An UNGATED nearest-preceding
    // scan would bind to it; the lookup is nearest preceding ACCEPTED for exactly this reason.
    const note = [
      `### ${FILE_B}`,
      block("first anchor text", "first anchor replacement"),
      "",
      "### 2. Wire the ledger row",
      "",
      "Prose that separates the rejected heading from the block below it.",
      "",
      block("second anchor text", "second anchor replacement"),
      "",
    ].join("\n");
    const edits = extractExplicitEdits(note, null, DECLARED);
    expect(edits.map((e) => e.file)).toEqual([FILE_B, FILE_B]);
  });

  it("a block with no accepted heading anywhere reports NO file rather than inventing one", () => {
    const note = [
      "### 2. Wire the ledger row",
      "",
      "Prose.",
      "",
      block("orphan anchor text", "orphan anchor replacement"),
      "",
    ].join("\n");
    const [edit] = extractExplicitEdits(note, null, DECLARED);
    // Absence asserted directly. A diagnostic flag alongside an inherited path would not
    // satisfy this — naming a file the block was never associated with is the defect.
    expect(edit.file == null).toBe(true);
    expect(DECLARED).not.toContain(edit.file);
  });
});

describe("the two extractors agree on which files a note edits", () => {
  it("reviewer and planner derive the same file set from the child-shaped note", () => {
    // AGREEMENT PIN. ARCH declined convergence — the shared residue is a five-line loop while
    // llm/planner.mjs carries four source-level test pins outside this story's witness set — so
    // this pin is the sole guard against the two re-diverging. Compare the SET; never change
    // extractMustEditPaths' return type to satisfy it.
    const fromReviewer = new Set(
      extractExplicitEdits(CHILD_SHAPED_NOTE, null, DECLARED).map((e) => e.file).filter(Boolean),
    );
    const fromPlanner = new Set(extractMustEditPaths(CHILD_SHAPED_NOTE));
    expect([...fromReviewer].sort()).toEqual([...fromPlanner].sort());
    // Non-vacuous: pre-fix the reviewer yielded {FILE_A} alone while the planner already
    // yielded both, so this disagreed. Post-fix both are {FILE_A, FILE_B}.
    expect([...fromPlanner].sort()).toEqual([FILE_A, FILE_B].sort());
  });
});

describe("adjacent headings and File:/Target: lines still work", () => {
  it("an adjacent heading still wins over an earlier accepted one", () => {
    const note = [
      `### ${FILE_A}`,
      "",
      "Prose under A.",
      "",
      block("anchor under A", "replacement under A"),
      `### ${FILE_B}`,
      block("anchor under B", "replacement under B"),
      "",
    ].join("\n");
    expect(extractExplicitEdits(note, null, DECLARED).map((e) => e.file)).toEqual([FILE_A, FILE_B]);
  });

  it("a File: line still attributes its own block", () => {
    const note = [
      `### ${FILE_A}`,
      "",
      "Prose.",
      "",
      `File: ${FILE_B}`,
      block("anchor via file line", "replacement via file line"),
      "",
    ].join("\n");
    expect(extractExplicitEdits(note, null, DECLARED)[0].file).toBe(FILE_B);
  });
});

describe("the fix is real, not fixture-shaped", () => {
  it("reviewer.mjs performs a nearest-preceding-ACCEPTED lookup", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "packages/mcp-rks/src/llm/reviewer.mjs"),
      "utf8",
    );
    expect(src.length).toBeGreaterThan(0); // positive control — the file was read
    expect(src).toContain("nearestPrecedingHeading");
    // The gate must still be applied when indexing headings; an ungated index reintroduces
    // the 0.50.3 defect.
    const idx = src.indexOf("const acceptedHeadings");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 600)).toContain("resolveTargetPath");
  });
});
