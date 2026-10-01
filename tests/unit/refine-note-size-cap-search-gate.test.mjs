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

// ─── AC-1 reproduction: add_code_snippet is a no-growth fixed point ───────────
//
// backlog.fix.refine-apply-no-growth-fixed-point
//
// The section above pins that a PRE-AUTHORED `### Target:` section IS pruned on an
// over-cap note. That is intended and stays. This block pins the opposite case for a
// section the CALL ITSELF injected: add_code_snippet reports a non-empty applied[]
// claiming an injection, the cap prune then deletes the section before the write, and
// the suggester's only convergence signal (body.includes("### Target: " + file)) is
// therefore never satisfied — so it re-fires forever while the note stays byte-flat.
//
// The two cases are distinguished ONLY by injected-vs-authored, which is why a blanket
// protected-headers option cannot satisfy both. Both must be green in the same run.

/**
 * Over-cap note carrying @@SEARCH blocks but NO `### Target:` section, so the
 * add_code_snippet applier takes the inject path rather than its skip-if-present branch.
 */
function buildOverCapNoteWithoutTargetSection(storyId, targetFile, anchorCount = 80) {
  const searchBlocks = Array.from({ length: anchorCount }, (_, i) =>
    `### ${targetFile}\n\n@@SEARCH\nexport function anchor_${i}(${"arg".repeat(8)}) {\n@@REPLACE\nexport function anchor_${i}(${"arg".repeat(8)}) {\n@@END`
  ).join("\n\n");

  return `---
id: "${storyId}"
title: "No-growth fixed point reproduction"
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

## Code Changes

${searchBlocks}
`;
}

describe("runRefineApplyTool — add_code_snippet durability on an over-cap note", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine-nogrowth");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, TARGET), BASE_FILE_CONTENT);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("AC-1/AC-5: applied[] never claims a ### Target: header the written note lacks", async () => {
    const storyId = "backlog.fix.nogrowth-repro";
    const notePath = path.join(projectRoot, "notes", `${storyId}.md`);
    const noteContent = buildOverCapNoteWithoutTargetSection(storyId, TARGET);

    // Vacuity guard: the gate must actually arm, and the inject path must be taken.
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(noteContent).toContain("@@SEARCH");
    expect(noteContent).not.toContain(`### Target: ${TARGET}`);
    fs.writeFileSync(notePath, noteContent);

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: TARGET } }],
    });

    const acted = (result?.applied || []).filter(
      (a) => a?.type === "add_code_snippet" && !String(a?.result || "").startsWith("skipped")
    );
    // Precondition: the applier did something. If it skipped, this repro is vacuous.
    expect(acted.length).toBeGreaterThan(0);

    const written = fs.readFileSync(notePath, "utf8");

    // AC 5: applied[] cannot claim what disk does not hold. The call must either persist the
    // header it says it wrote, or report the documented out-of-band path instead of claiming
    // an injection at all. Pre-fix it did neither: it claimed the injection and the prune ate it.
    const claimedInjection = acted.some((a) => a?.injectedHeader);
    if (claimedInjection) {
      expect(written).toContain(`### Target: ${TARGET}`);
    } else {
      expect(acted.some((a) => a?.outOfBand === true)).toBe(true);
      expect(result?.outOfBandContext?.some((c) => c.file === TARGET)).toBe(true);
      // AC 7: a durable signal that context was supplied must survive the prune.
      expect(written).toContain(`<!-- rks:context-out-of-band: ${TARGET} -->`);
    }
  });

  it("AC-6: a second identical round does not reproduce round 1 verbatim on an unchanged file", async () => {
    const storyId = "backlog.fix.nogrowth-converge";
    const notePath = path.join(projectRoot, "notes", `${storyId}.md`);
    const noteContent = buildOverCapNoteWithoutTargetSection(storyId, TARGET);
    expect(noteContent.length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(notePath, noteContent);

    const refinements = [{ type: "add_code_snippet", data: { file: TARGET } }];

    const r1 = await runRefineApplyTool({ projectRoot, problemId: storyId, refinements });
    const after1 = fs.readFileSync(notePath, "utf8");

    const r2 = await runRefineApplyTool({ projectRoot, problemId: storyId, refinements });
    const after2 = fs.readFileSync(notePath, "utf8");

    const claimedInjection = (res) =>
      (res?.applied || []).some(
        (a) => a?.type === "add_code_snippet" && !String(a?.result || "").startsWith("skipped")
      );

    // Terminal state: either round 2 stops claiming an injection, or it reports refine_noop.
    // What must NOT happen is round 2 claiming success identically while the file is unchanged.
    // Compare modulo the known-cosmetic `updated:` stamp, which is rewritten on every call —
    // without stripping it the two files always differ and this assertion passes vacuously.
    const stripStamp = (s) => s.replace(/^updated:.*$/m, "updated: <stamp>");
    const stalled =
      claimedInjection(r1) &&
      claimedInjection(r2) &&
      stripStamp(after1) === stripStamp(after2) &&
      r2?.status !== "refine_noop";
    expect(stalled).toBe(false);
  });
});
