/**
 * Witness for backlog.fix.hardcap-prune-destroys-authored-anchors.
 *
 * THE FIELD REPORT (routekit-growth, rks 0.41.0, commit fe00f4e — 5 insertions, 52 deletions):
 * a story note declared FIVE author-written @@SEARCH…@@END blocks under five `### <path>`
 * headings. A routine rks_refine_apply returned:
 *
 *   { ok: true, applied: [{ type: "add_code_snippet", result: "injected keyword-match context…" }],
 *     historyAppended: true, requiredNext: "rks_plan { … }" }
 *
 * and deleted the contents of blocks 1–4, leaving heading-plus-empty-fence husks. Block 5 — last
 * in document order — survived. Nothing in the result said so.
 *
 * THE MECHANISM. `shedOldestAnchorBlocks` spliced @@SEARCH…@@END inclusive, oldest-first, stopping
 * at one remaining block. Written for refine-loop SEDIMENT, where "youngest is the live fix" is a
 * sound heuristic. v0.41.0's po-prompt-edit-target-anchor-obligation made PO author an anchor for
 * EVERY op:edit target, so a note's anchors became the author's DELIVERABLE — co-equal,
 * simultaneous, ordered only by file position. There is no timestamp anywhere on that path;
 * "oldest" only ever meant "first". Damage scaled N-1 of N, and the obligation's whole purpose is
 * to raise N: the better PO did its new job, the more there was to lose.
 *
 * THE FIX. Refuse and report. An oversized note is recoverable; a destroyed one is not.
 *
 * FIXTURE DISCIPLINE. Every fixture here asserts its own body length against the cap BEFORE the
 * call, so each case proves whether it armed the path rather than assuming it. That matters in
 * both directions — an over-cap case that quietly fell under the cap would pass vacuously.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool, targetSectionFor } from "../../packages/mcp-rks/src/server/refine.mjs";

const MAX_NOTE_BODY_BYTES = 8192;
const TARGET = "src/scorer.mjs";

let projectRoot;
const created = [];

beforeEach(() => {
  projectRoot = makeTempDir("hardcap-anchors");
  created.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, TARGET),
    Array.from({ length: 60 }, (_, i) => `export function fn_${i}() { return ${i}; }`).join("\n") + "\n",
  );
});
afterEach(() => {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const count = (s, re) => (s.match(re) || []).length;

/**
 * The field-report shape: N author-declared anchors under `### <path>` headings, plus enough
 * prose to push the body over the cap. `bigFrontmatter` reproduces the more dangerous variant —
 * see the large-frontmatter case below.
 */
function writeAuthoredNote(storyId, { anchors = 5, padParas = 40, bigFrontmatter = false } = {}) {
  const fmPad = bigFrontmatter
    ? Array.from({ length: 30 }, (_, i) =>
        `  - path: "src/extra_${i}.mjs"\n    op: "edit"\n    desc: "${"context ".repeat(30)}"`).join("\n")
    : "";
  const frontmatter = [
    "---",
    `id: "${storyId}"`,
    'phase: "arch-approved"',
    "targetFiles:",
    `  - path: "${TARGET}"`,
    '    op: "edit"',
    `    desc: "${bigFrontmatter ? "detail ".repeat(60) : "edit the scorer"}"`,
    ...(fmPad ? [fmPad] : []),
    "---",
  ].join("\n");

  const blocks = Array.from({ length: anchors }, (_, i) =>
    `### ${TARGET}\n\n\`\`\`\n@@SEARCH\nexport function fn_${i}() { return ${i}; }\n@@REPLACE\nexport function fn_${i}() { return ${i} + 1; }\n@@END\n\`\`\`\n`
  ).join("\n");

  const prose = Array.from({ length: padParas }, (_, i) =>
    `Paragraph ${i}. ${"deliberate body padding to exceed the size cap. ".repeat(4)}`
  ).join("\n\n");

  const body = `\n## Problem\n\n${prose}\n\n## SEARCH Anchors\n\n${blocks}`;
  fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), frontmatter + body);
  return { body, frontmatter };
}

// backlog.fix.refine-projective-headroom-guard: the guard now selects on the
// POST-injection total. A precondition stated on body.length alone no longer names
// the predicate that picks the branch, so it can pass while the fixture sits on the
// other side of the real boundary.
const TARGET_SOURCE = Array.from({ length: 60 }, (_, i) => `export function fn_${i}() { return ${i}; }`).join("\n") + "\n";

// backlog.fix.disk-fetch-test-helpers-drift-from-source: DERIVED from the writer's
// own factory, not re-typed. This is a cap-arithmetic ORACLE — projectedLength
// below feeds a precondition that decides which branch a test is asserting about —
// so a framing that drifted from the writer would silently move that boundary while
// the assertion stayed green.
const sectionFraming = (targetFile) => targetSectionFor(targetFile, "");

/** The guard's operand: body + framing + the extracted payload. */
function projectedLength(body, payload = TARGET_SOURCE, targetFile = TARGET) {
  return body.length + sectionFraming(targetFile).length + payload.length;
}

const applySnippet = (storyId) => runRefineApplyTool({
  projectRoot,
  problemId: storyId,
  refinements: [{ type: "add_code_snippet", file: TARGET, hint: "fn_0" }],
});

describe("the field-report shape: five authored anchors, body over cap", () => {
  it("ALL FIVE anchors survive — the exact case that lost four", async () => {
    const storyId = "backlog.chore.authored-five";
    const { body } = writeAuthoredNote(storyId);
    expect(body.length, "precondition: the cap path must be ARMED").toBeGreaterThan(MAX_NOTE_BODY_BYTES);

    await applySnippet(storyId);
    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");

    for (let i = 0; i < 5; i++) {
      expect(written, `fn_${i} anchor must survive`).toContain(`export function fn_${i}() { return ${i}; }`);
    }
  });

  it("no husks: marker counts balance at five apiece", async () => {
    // The husk signature is heading + empty fence with markers gone, because the shed spliced
    // marker-bounded and inclusive. Counting all three markers detects exactly that residue, and
    // is strictly stronger than asserting the presence of any one of them.
    const storyId = "backlog.chore.authored-husk";
    writeAuthoredNote(storyId);

    await applySnippet(storyId);
    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");

    expect(count(written, /^@@SEARCH\b/gm)).toBe(5);
    expect(count(written, /^@@REPLACE\b/gm)).toBe(5);
    expect(count(written, /^@@END\b/gm)).toBe(5);
  });

  it("the caller is TOLD the note is over cap", async () => {
    const storyId = "backlog.chore.authored-report";
    writeAuthoredNote(storyId);

    const res = await applySnippet(storyId);

    expect(res.noteSizeOverflow, "overflow must reach the RESULT, not only stderr").toBeTruthy();
    // backlog.fix.refine-prune-destroys-authored-create-blocks — AC10, site 2 of 3.
    // This fixture's body holds no `### Target:` span, so the base prune sheds nothing and all
    // four counters are honestly zero. The companions make the zero evidence of computation.
    expect(res.noteSizeOverflow.anchorsShed).toBe(0);
    expect(res.noteSizeOverflow.createDirectivesShed).toBe(0);
    expect(res.noteSizeOverflow.fencesShed).toBe(0);
    expect(res.noteSizeOverflow.linesShed).toBe(0);
    expect(res.noteSizeOverflow.anchorBlocks).toBe(5);
    expect(res.noteSizeOverflow.bodyBytes).toBeGreaterThan(res.noteSizeOverflow.threshold);
    // The remedy has to be actionable: the gate measures body length only, so relocating prose
    // into frontmatter genuinely disarms it.
    //
    // AC6 MAKES THIS CONDITIONAL. The `note` key is now suppressed whenever the base prune
    // removed anything, and this assertion stays green ONLY because this fixture sheds nothing
    // — the same property the four zeros above assert. If this fixture is ever changed to hold
    // a `### Target:` span, this line must change with it or it fails for a reason no comment
    // would otherwise explain.
    expect(res.noteSizeOverflow.note).toMatch(/frontmatter/i);
  });

  it("a stderr-only implementation would fail this", async () => {
    // Guard against the fix regressing to a warning nobody consumes — which is what let the
    // original loss go unnoticed against an ok:true result.
    const storyId = "backlog.chore.authored-notstderr";
    writeAuthoredNote(storyId);
    const res = await applySnippet(storyId);
    expect(Object.keys(res)).toContain("noteSizeOverflow");
  });
});

describe("the large-frontmatter variant — the most dangerous shape", () => {
  it("survives when a big frontmatter drives the threshold to its floor", async () => {
    // The path is inconsistent about which quantity the cap governs: the GATE measures body
    // length, but the threshold subtracts the frontmatter block and floors at 1024. So a large
    // frontmatter makes the cap maximally aggressive on exactly the notes carrying the most
    // authored anchors — which is the field-report shape. A fixture with a small frontmatter
    // exercises a threshold near 8000 and would not reach this.
    const storyId = "backlog.chore.authored-bigfm";
    const { body, frontmatter } = writeAuthoredNote(storyId, { bigFrontmatter: true });
    expect(body.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(frontmatter.length, "precondition: frontmatter must be large").toBeGreaterThan(2000);

    await applySnippet(storyId);
    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");

    expect(count(written, /^@@SEARCH\b/gm)).toBe(5);
    expect(count(written, /^@@END\b/gm)).toBe(5);
  });
});

describe("the negative control", () => {
  it("a note UNDER the cap reports no overflow", async () => {
    // Proves the over-cap cases above are actually exercising the hard-cap path rather than
    // passing because nothing ever fires.
    const storyId = "backlog.chore.authored-small";
    const { body } = writeAuthoredNote(storyId, { anchors: 2, padParas: 1 });
    // Repointed from body.length to the PROJECTED total — the quantity the guard
    // now tests. Stated on body.length this precondition would keep passing while
    // silently stopping to select the branch it names.
    expect(
      projectedLength(body),
      "precondition: the cap path must NOT be armed (projected total under cap)",
    ).toBeLessThan(MAX_NOTE_BODY_BYTES);

    const res = await applySnippet(storyId);

    expect(res.noteSizeOverflow).toBeUndefined();
    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(count(written, /^@@SEARCH\b/gm)).toBe(2);
  });
});
