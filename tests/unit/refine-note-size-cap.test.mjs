/**
 * Tests for MAX_NOTE_BODY_BYTES size cap in runRefineApplyTool (refine.mjs).
 *
 * Verifies:
 * 1. MAX_NOTE_BODY_BYTES constant equals 8192 and is defined in refine.mjs
 * 2. pruneRefineBlocks is imported from ./planner-context.mjs in refine.mjs
 * 3. Body is pruned when it exceeds MAX_NOTE_BODY_BYTES before writing
 * 4. Body is written unchanged when under MAX_NOTE_BODY_BYTES
 * 5. A stderr warning is logged when body still exceeds cap after pruning
 * 6. The pruned (not original) body is written when still over cap after pruning
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTempDir, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const REFINE_MJS = path.join(ROOT, "packages/mcp-rks/src/server/refine.mjs");

const MAX_NOTE_BODY_BYTES = 8192;

// ─── Static source checks ─────────────────────────────────────────────────────

describe("refine.mjs — static source checks", () => {
  let src;

  beforeEach(() => {
    src = fs.readFileSync(REFINE_MJS, "utf8");
  });

  it("MAX_NOTE_BODY_BYTES constant equals 8192", () => {
    expect(src).toContain("const MAX_NOTE_BODY_BYTES = 8192");
  });

  it("pruneRefineBlocks is imported from ./planner-context.mjs", () => {
    expect(src).toMatch(/import\s*\{[^}]*pruneRefineBlocks[^}]*\}\s*from\s*['"]\.\/planner-context\.mjs['"]/);
  });

  it("pruneRefineBlocks is called before the disk write", () => {
    // Use the final updatedContent write (not the earlier decompose write).
    // The hard-cap guard now passes opts — match the reconciled call form
    // `pruneRefineBlocks(body, { capMode: true, threshold: MAX_NOTE_BODY_BYTES })`.
    const writeIdx = src.indexOf('await fs.writeFile(storyPath, updatedContent');
    const pruneIdx = src.indexOf('pruneRefineBlocks(body,');
    expect(pruneIdx).toBeGreaterThan(0);
    expect(writeIdx).toBeGreaterThan(0);
    expect(pruneIdx).toBeLessThan(writeIdx);
  });

  it("MAX_NOTE_BODY_BYTES guard wraps the pruneRefineBlocks call", () => {
    expect(src).toContain("body.length > MAX_NOTE_BODY_BYTES");
  });

  // ── backlog.fix.refine-projective-headroom-guard ──────────────────────────
  //
  // This story made ONLY the injection-site guard projective. The suggester guard
  // was descoped by ARCH, and the prune machinery is out of scope. These are the
  // declared home for those source-level pins — they had no implementation file
  // before, which meant the guarantees were prose.

  it("the SUGGESTER guard is left byte-identical — descoped, not made projective", () => {
    // Its hasTruncationContext disjunct must still short-circuit independently of
    // body size, so the whole conjunction is pinned verbatim rather than in parts.
    expect(src).toContain("if (hasTruncationContext || body.length > MAX_NOTE_BODY_BYTES) {");
  });

  it("the prune gate, the overflow report and the NOT DURABLE label are unchanged", () => {
    expect(src).toContain("NOT DURABLE");
    expect(src).toContain("bodyDirty");
    expect(src).toContain("fmBlockLen");
  });

  // AC-10's SOLE enforcement. Every fixture in this suite and its siblings is
  // ASCII, so a Buffer.byteLength implementation would leave every behavioural
  // test green — a green run would not be evidence. Only a source-level check can
  // catch a units change, so this assertion is the guarantee.
  it("every projection term uses String.prototype.length — no Buffer.byteLength", () => {
    expect(src).not.toContain("Buffer.byteLength");
  });
});

// ─── Functional behavior ──────────────────────────────────────────────────────

describe("runRefineApplyTool — note size cap", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine-size-cap");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const TARGET = "src/svc.mjs";
  const BASE_FILE_CONTENT = `export function handleRequest(req) {\n  return req;\n}\n`;

  function buildBloatedNote(storyId, targetFile, fileContent, padLines = 0, blockSize = 80) {
    // Build a note body that starts small but has many @@SEARCH blocks appended
    const searchBlocks = Array.from({ length: padLines }, (_, i) =>
      `### ${targetFile}\n\n@@SEARCH\nexport function handler_${i}() {\n${"// padding ".repeat(Math.ceil(blockSize / 10))}\n@@REPLACE\nexport function handler_${i}() {\n@@END`
    ).join("\n\n");

    return `---
id: "${storyId}"
title: "Size cap test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

Something needs fixing.

### Target: ${targetFile}

\`\`\`javascript
${fileContent}\`\`\`

${searchBlocks}`;
  }

  it("writes body unchanged when it is under MAX_NOTE_BODY_BYTES", async () => {
    const storyId = "backlog.feat.cap-under";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);

    // Small note — no padding, well under 8192 bytes
    const noteContent = buildBloatedNote(storyId, TARGET, BASE_FILE_CONTENT, 0);
    expect(noteContent.length).toBeLessThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // Should still contain the @@SEARCH block — no pruning occurred
    expect(written).toContain("@@SEARCH");
  });

  // backlog.fix.hardcap-prune-destroys-authored-anchors — EXPECTATIONS DELIBERATELY INVERTED.
  //
  // These two cases asserted that anchor blocks were SHED when the body exceeded the cap:
  // `not.toContain("handler_0")` and `written.length <= MAX_NOTE_BODY_BYTES`. Both encoded the
  // defect. Since v0.41.0 required PO to author an @@SEARCH anchor per op:edit target, shedding
  // deletes the author's deliverable — a child project lost 4 of 5 authored anchors to this path
  // while the tool returned ok: true. Anchors are now never shed; the note is written un-shed and
  // over cap, and the overflow is reported.
  it("PRESERVES @@SEARCH blocks when body exceeds MAX_NOTE_BODY_BYTES", async () => {
    const storyId = "backlog.feat.cap-prune";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);

    // Bloated note — enough @@SEARCH padding to exceed 8192 bytes
    const noteContent = buildBloatedNote(storyId, TARGET, BASE_FILE_CONTENT, 40, 200);
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // The first block the old shed deleted, and the last one it kept.
    expect(written).toContain("handler_0");
    expect(written).toContain("handler_39");
    // NOTE: the previous assertion here was `not.toContain("handler_59")`. The generator builds
    // handler_0..handler_39 (padLines = 40), so handler_59 never existed in the fixture and that
    // assertion could not fail — it had never tested anything. The "handler_0..handler_59" phrasing
    // propagated from the research paper into the story's acceptance criteria before anyone counted.
  });

  it("writes the note OVER cap rather than shedding anchors to fit", async () => {
    const storyId = "backlog.feat.cap-size";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);

    const noteContent = buildBloatedNote(storyId, TARGET, BASE_FILE_CONTENT, 40, 200);
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    const res = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // Inverted: staying under the cap was the symptom of the destruction, not the goal.
    expect(written.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);

    // And the caller is TOLD. Before this, the only signal was a stderr line no MCP client sees —
    // which is exactly how the loss went unnoticed against an ok:true result.
    expect(res.noteSizeOverflow).toBeTruthy();
    expect(res.noteSizeOverflow.anchorsShed).toBe(0);
    expect(res.noteSizeOverflow.anchorBlocks).toBeGreaterThan(1);
    expect(res.noteSizeOverflow.maxNoteBodyBytes).toBe(MAX_NOTE_BODY_BYTES);

    // backlog.fix.refine-prune-destroys-authored-create-blocks — AC10, site 3 of 3, and the
    // ONLY pre-existing site where the base prune demonstrably removes content while overflow
    // is true. That makes it the only place a counter can be proven by a NON-ZERO value; a
    // computed zero proves much less. `buildBloatedNote` emits a `### Target:` span, so the
    // prune sheds at minimum that header line.
    // MEASURED, then pinned — 8, which matches the value PO derived independently from the
    // fixture. The span is the `### Target:` header, its blank line, the prose line, a blank,
    // the two fence lines and the two snapshot lines the fence wraps. If this fixture changes,
    // re-measure rather than relaxing the assertion.
    expect(res.noteSizeOverflow.linesShed).toBe(8);
    // Anchors stay at zero even here: groups inside the skip zone are re-emitted by the
    // exemption in pruneRefineBlocks, so a widened span sheds no anchor.
    expect(res.noteSizeOverflow.createDirectivesShed).toBe(0);

    // AC6 — the reassurance is SUPPRESSED here, because this call did shed content. This is the
    // assertion that would have caught the original defect: the destructive write carried a
    // message saying nothing had been shed.
    expect(res.noteSizeOverflow.note).toBeUndefined();
  });

  it("the reported byte count matches the note actually on disk", async () => {
    // Cross-check against a re-read, because nothing on this path reads back after writing. The
    // reported figure is BODY bytes; the stderr line reports whole-file bytes. They differ by the
    // frontmatter block and are deliberately named differently.
    const storyId = "backlog.feat.cap-report";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);
    const noteContent = buildBloatedNote(storyId, TARGET, BASE_FILE_CONTENT, 40, 200);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    const res = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(res.noteSizeOverflow).toBeTruthy();
    // Body-only: strictly less than the whole file, and within it.
    expect(res.noteSizeOverflow.bodyBytes).toBeLessThan(written.length);
    expect(res.noteSizeOverflow.bodyBytes).toBeGreaterThan(0);
  });

  it("a note UNDER the cap does not arm the path and reports no overflow", async () => {
    // Negative control. Without this, the over-cap cases above could pass for the wrong reason.
    const storyId = "backlog.feat.cap-under";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);
    const small = `---\nid: "${storyId}"\nphase: "arch-approved"\ntargetFiles:\n  - path: "${TARGET}"\n    op: "edit"\n---\n\n## Problem\n\nsmall\n\n@@SEARCH\nexport function handleRequest(req) {\n@@REPLACE\nexport function handleRequest(req) {\n@@END\n`;
    expect(small.length).toBeLessThan(MAX_NOTE_BODY_BYTES); // precondition: gate must NOT arm
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), small);

    const res = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
    });

    expect(res.noteSizeOverflow).toBeUndefined();
  });

  it("logs stderr warning when body still exceeds cap after pruning", async () => {
    const storyId = "backlog.feat.cap-warn";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);

    // Build a note that's over 8192 bytes WITHOUT any pruneable @@SEARCH blocks
    // (just pad with plain text lines so pruning can't reduce it below cap)
    const plainPad = Array.from({ length: 200 }, (_, i) => `// padding line ${i} `.padEnd(50, "x")).join("\n");
    const noteContent = `---
id: "${storyId}"
title: "Warn test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${TARGET}"
    op: "edit"
---

## Problem

${plainPad}

### Target: ${TARGET}

\`\`\`javascript
${BASE_FILE_CONTENT}\`\`\`
`;
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(String(chunk));
      return origWrite(chunk, ...args);
    };

    try {
      await runRefineApplyTool({
        projectRoot, problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
      });
    } finally {
      process.stderr.write = origWrite;
    }

    const stderrOutput = stderrChunks.join("");
    expect(stderrOutput).toContain("[refine] WARNING");
    expect(stderrOutput).toContain("bytes after pruning");
    expect(stderrOutput).toContain(String(MAX_NOTE_BODY_BYTES));
  });
});
