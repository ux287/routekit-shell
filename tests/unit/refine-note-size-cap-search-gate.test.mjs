/**
 * Tests for @@SEARCH-gated size cap in runRefineApplyTool (refine.mjs).
 *
 * The fix: pruneRefineBlocks is only called when body.length > MAX_NOTE_BODY_BYTES
 * AND body.includes('@@SEARCH'). Without @@SEARCH blocks the note hasn't been through
 * the planner yet — code snippets must be preserved for planning to succeed.
 *
 * Regression: the original guard (body.length > MAX_NOTE_BODY_BYTES, no @@SEARCH check)
 * was stripping code snippets from fresh notes like snacks' settings.js (~15 KB) on
 * first injection, before the planner had ever seen them.
 *
 * Verifies:
 * 1. Static: @@SEARCH guard wraps pruneRefineBlocks call in source
 * 2. Body over cap + NO @@SEARCH  → ### Target: sections NOT pruned
 * 3. Body over cap + @@SEARCH present → ### Target: sections ARE pruned
 * 4. Body under cap → unchanged regardless of @@SEARCH presence
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
const TARGET = "src/svc.mjs";
const BASE_FILE_CONTENT = `export function handleRequest(req) {\n  return req;\n}\n`;

// ─── Static source check ──────────────────────────────────────────────────────

describe("refine.mjs — @@SEARCH guard on size cap (source)", () => {
  let src;

  beforeEach(() => {
    src = fs.readFileSync(REFINE_MJS, "utf8");
  });

  it("pruneRefineBlocks call is guarded by body.includes('@@SEARCH')", () => {
    // The guard must require @@SEARCH presence, not just size
    expect(src).toMatch(/body\.length\s*>\s*MAX_NOTE_BODY_BYTES\s*&&\s*body\.includes\(['"]@@SEARCH['"]\)/);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a large note with ### Target: code snippet sections but NO @@SEARCH blocks.
 * Simulates a fresh note that has had add_code_snippet applied but the planner has not run yet.
 */
function buildLargeNoteWithSnippets(storyId, targetFile, snippetLines = 200) {
  const snippet = Array.from({ length: snippetLines }, (_, i) =>
    `  // line ${i}: ${"x".repeat(40)}`
  ).join("\n");

  return `---
id: "${storyId}"
title: "Size cap gate test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

A large file needs changes.

## Acceptance Criteria

- [ ] Feature works correctly

### Target: ${targetFile}

\`\`\`javascript
${snippet}
\`\`\`
`;
}

/**
 * Build a large note with both ### Target: sections AND @@SEARCH blocks.
 * @@SEARCH blocks are placed under their own ## section so pruneRefineBlocks
 * does not catch them in the ### Target: skip zone. This mirrors the real note
 * structure after the planner has consumed the snippets and injected anchors.
 */
function buildLargeNoteWithSearchBlocks(storyId, targetFile, snippetLines = 100) {
  const snippet = Array.from({ length: snippetLines }, (_, i) =>
    `  // line ${i}: ${"x".repeat(40)}`
  ).join("\n");

  // @@SEARCH blocks under ## Code Changes — outside the ### Target: skip zone
  const searchBlocks = Array.from({ length: 5 }, (_, i) =>
    `### ${targetFile}\n\n@@SEARCH\nexport function anchor_${i}() {\n@@REPLACE\nexport function anchor_${i}() {\n@@END`
  ).join("\n\n");

  return `---
id: "${storyId}"
title: "Size cap gate test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

A large file needs changes.

## Acceptance Criteria

- [ ] Feature works correctly

### Target: ${targetFile}

\`\`\`javascript
${snippet}
\`\`\`

## Code Changes

${searchBlocks}
`;
}

// ─── Functional behavior ──────────────────────────────────────────────────────

describe("runRefineApplyTool — @@SEARCH-gated size cap", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine-search-gate");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("body over cap + NO @@SEARCH: ### Target: sections are preserved (not pruned)", async () => {
    const storyId = "backlog.feat.gate-no-search";
    const noteContent = buildLargeNoteWithSnippets(storyId, TARGET, 200);
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(noteContent).not.toContain("@@SEARCH");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    // clarify_ac appends ACs without adding @@SEARCH blocks
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "clarify_ac", data: { criteria: ["Updated criterion"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // ### Target: section must still be present — pruning must NOT have fired
    expect(written).toContain(`### Target: ${TARGET}`);
  });

  it("body over cap + @@SEARCH present: ### Target: code snippet sections ARE pruned", async () => {
    const storyId = "backlog.feat.gate-with-search";
    const noteContent = buildLargeNoteWithSearchBlocks(storyId, TARGET, 150);
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(noteContent).toContain("@@SEARCH");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    // clarify_ac appends ACs without adding @@SEARCH blocks — body still has existing @@SEARCH
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "clarify_ac", data: { criteria: ["Updated criterion"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // pruneRefineBlocks strips ### Target: sections — they must be gone
    expect(written).not.toContain(`### Target: ${TARGET}`);
    // @@SEARCH blocks under ## Code Changes (outside skip zone) should survive
    expect(written).toContain("@@SEARCH");
    expect(written).toContain("anchor_0");
  });

  it("body under cap + NO @@SEARCH: note unchanged regardless of @@SEARCH absence", async () => {
    const storyId = "backlog.feat.gate-under-cap";
    // Small note — well under 8192 bytes
    const noteContent = buildLargeNoteWithSnippets(storyId, TARGET, 5);
    expect(noteContent.length).toBeLessThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), noteContent);

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "clarify_ac", data: { criteria: ["New criterion"] } }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // No pruning should occur — ### Target: must survive
    expect(written).toContain(`### Target: ${TARGET}`);
  });
});
