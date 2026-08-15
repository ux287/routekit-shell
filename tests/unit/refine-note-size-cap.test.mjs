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

  it("prunes @@SEARCH blocks when body exceeds MAX_NOTE_BODY_BYTES", async () => {
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
    // @@SEARCH blocks from padding should have been pruned
    expect(written).not.toContain("handler_0");
    expect(written).not.toContain("handler_59");
  });

  it("file on disk does not exceed MAX_NOTE_BODY_BYTES when pruning reduces below cap", async () => {
    const storyId = "backlog.feat.cap-size";
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);

    // Build a note large enough to trigger the cap but with pruneable content
    const noteContent = buildBloatedNote(storyId, TARGET, BASE_FILE_CONTENT, 40, 200);
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function handleRequest(req) {"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(written.length).toBeLessThanOrEqual(MAX_NOTE_BODY_BYTES);
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
