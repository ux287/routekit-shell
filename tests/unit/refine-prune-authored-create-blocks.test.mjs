/**
 * backlog.fix.refine-prune-destroys-authored-create-blocks
 *
 * P0, v0.43.0. rks_refine_apply silently deletes authored `op: create` blocks from story
 * notes. Two field instances, each returning ok:true: 329 lines destroyed via
 * disk_fetch_context, 384 via acknowledge_multi_file.
 *
 * MECHANISM (full account: notes/research.2026.08.23.refine-cap-prune-destroys-authored-create-blocks.md)
 * The base prune in pruneRefineBlocks opens a skip zone on `### Target:` and closes it ONLY
 * on a level-2 header — `/^##\s+/` cannot match `### ` — so every authored `### <path>`
 * section trailing a Target span is deleted along with its `// CREATE FILE:` directive and
 * fenced content. @@SEARCH groups are exempted just above the skip check, which is why
 * anchors survived and create blocks did not.
 *
 * TEST POSTURE. These assert what a CALLER RECEIVES — the bytes on disk after the call, and
 * the report the tool returns — never what an internal function computed. Every prior fix in
 * this area shipped with green tests that asserted at the point of computation and missed the
 * defect entirely; that is the finding in
 * notes/research.2026.08.23.dispatcher-introduced-defect-audit.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import { pruneRefineBlocks } from "../../packages/mcp-rks/src/server/planner-context.mjs";

const TARGET = "src/svc.mjs";
const CREATE_TARGET = "tests/unit/svc-behaviour.test.mjs";

/**
 * A story note in the shape governor-po.md mandates: a tool-injected `### Target:` snapshot,
 * followed by an AUTHORED `### <path>` section carrying a `// CREATE FILE:` directive and a
 * fenced block, with NO intervening level-2 header. That is the exact layout the field report
 * describes and the one the prune deletes.
 */
function buildNoteWithAuthoredCreateBlock(storyId, { anchors = 48 } = {}) {
  const snapshot = Array.from({ length: 40 }, (_, i) => `  // snapshot line ${i}: ${"x".repeat(40)}`).join("\n");
  const createBody = Array.from({ length: 18 }, (_, i) =>
    `  it("case ${i} — ${"y".repeat(30)}", () => { expect(true).toBe(true); });`
  ).join("\n");
  const searchBlocks = Array.from({ length: anchors }, (_, i) =>
    `@@SEARCH\nexport function anchor_${i}(${"arg".repeat(6)}) {\n@@REPLACE\nexport function anchor_${i}(${"arg".repeat(6)}) {\n@@END`
  ).join("\n\n");

  return `---
id: "${storyId}"
title: "authored create block survives the prune"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${TARGET}"
    op: "edit"
  - path: "${CREATE_TARGET}"
    op: "create"
---

## Problem

A file needs changes and a new test file.

## Target Files

### Target: ${TARGET}

Current source (use for search_replace patterns):

\`\`\`javascript
${snapshot}
\`\`\`

### ${CREATE_TARGET}

// CREATE FILE: ${CREATE_TARGET}

\`\`\`javascript
import { describe, it, expect } from "vitest";

describe("svc behaviour", () => {
${createBody}
});
\`\`\`

${searchBlocks}
`;
}

const notePathFor = (root, storyId) => path.join(root, "notes", `${storyId}.md`);

/**
 * The BODY, excluding the frontmatter block.
 *
 * Load-bearing: the cap gate is `body.length > MAX_NOTE_BODY_BYTES`, and `body` there is the
 * post-frontmatter text. A vacuity guard asserting on the whole note measures a different,
 * larger quantity and can pass while the gate never arms — which is exactly how the first
 * draft of this suite went green against an unfixed defect.
 */
function bodyOf(note) {
  const end = note.indexOf("\n---\n", 4);
  return end === -1 ? note : note.slice(end + 5);
}

const MAX_NOTE_BODY_BYTES = 8192;

describe("AC1/AC2 — an authored create block survives refine_apply on an over-cap note", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("prune-create-blocks");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, TARGET), "export function handleRequest(req) {\n  return req;\n}\n");
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("disk_fetch_context — the 329-line field instance", async () => {
    const storyId = "backlog.fix.repro-disk-fetch";
    const notePath = notePathFor(projectRoot, storyId);
    const before = buildNoteWithAuthoredCreateBlock(storyId);

    // Vacuity guards: the gate must arm, and the layout must be the one under test.
    // Measured on the BODY, because that is what the gate measures.
    expect(bodyOf(before).length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    expect(bodyOf(before)).toContain("@@SEARCH");
    expect(before).toContain(`// CREATE FILE: ${CREATE_TARGET}`);
    fs.writeFileSync(notePath, before);
    const linesBefore = before.split("\n").length;

    const res = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "disk_fetch_context", data: { file: TARGET } }],
    });

    const after = fs.readFileSync(notePath, "utf8");

    // What the caller receives, on disk. The directive, the fence and the body must all survive.
    expect(after, "the CREATE FILE directive was destroyed").toContain(`// CREATE FILE: ${CREATE_TARGET}`);
    expect(after, "the authored section header was destroyed").toContain(`### ${CREATE_TARGET}`);
    expect(after, "the create-block body was destroyed").toContain('describe("svc behaviour"');
    expect(after).toContain('it("case 17');

    // The field signature: a large silent line loss reported as success.
    const linesAfter = after.split("\n").length;
    expect(linesBefore - linesAfter, "lines were silently removed").toBeLessThan(5);
    expect(res?.ok).not.toBe(undefined);
  });

  it("acknowledge_multi_file — the 384-line field instance, frontmatter-only handler", async () => {
    // The decisive case. This handler touches frontmatter only and never reads body, so the
    // destruction cannot be blamed on any handler — it is the shared prune. A fix that only
    // addresses disk_fetch_context leaves this one live, which is what the first two revisions
    // of this story would have shipped.
    const storyId = "backlog.fix.repro-ack-multifile";
    const notePath = notePathFor(projectRoot, storyId);
    const before = buildNoteWithAuthoredCreateBlock(storyId);
    expect(bodyOf(before).length).toBeGreaterThan(MAX_NOTE_BODY_BYTES);
    fs.writeFileSync(notePath, before);

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "acknowledge_multi_file", data: {} }],
    });

    const after = fs.readFileSync(notePath, "utf8");
    expect(after, "a frontmatter-only refinement destroyed authored body content")
      .toContain(`// CREATE FILE: ${CREATE_TARGET}`);
    expect(after).toContain('describe("svc behaviour"');
  });
});

describe("AC1 — the skip zone closes at any heading level", () => {
  // Asserted against the exported function directly because this is the prune's own contract,
  // consumed by two callers. The caller-side consequence is covered above.
  it("a level-3 header closes a ### Target: skip zone", () => {
    const body = [
      "## Target Files",
      "",
      "### Target: src/a.mjs",
      "",
      "```javascript",
      ...Array.from({ length: 200 }, (_, i) => `// snapshot ${i} ${"z".repeat(40)}`),
      "```",
      "",
      "### tests/unit/new.test.mjs",
      "",
      "// CREATE FILE: tests/unit/new.test.mjs",
      "",
      "```javascript",
      'describe("x", () => {});',
      "```",
    ].join("\n");

    const pruned = pruneRefineBlocks(body, { threshold: 1024 });

    // The snapshot is still shed — that is the prune's purpose and AC9 keeps it.
    expect(pruned).not.toContain("// snapshot 100");
    // The authored section that follows is not.
    expect(pruned).toContain("### tests/unit/new.test.mjs");
    expect(pruned).toContain("// CREATE FILE: tests/unit/new.test.mjs");
    expect(pruned).toContain('describe("x", () => {});');
  });

  it("a level-2 header still closes the zone (unchanged behaviour)", () => {
    const body = [
      "### Target: src/a.mjs",
      ...Array.from({ length: 200 }, (_, i) => `// snapshot ${i} ${"z".repeat(40)}`),
      "## Acceptance Criteria",
      "- [ ] preserved",
    ].join("\n");

    const pruned = pruneRefineBlocks(body, { threshold: 1024 });
    expect(pruned).not.toContain("// snapshot 100");
    expect(pruned).toContain("## Acceptance Criteria");
    expect(pruned).toContain("- [ ] preserved");
  });

  it("a ### Target: line does not close its own zone", () => {
    // The self-closing hazard ARCH named: the open branch continues at :86, so the opening
    // line never reaches the close test. If it did, the prune would become a total no-op.
    const body = [
      "### Target: src/a.mjs",
      ...Array.from({ length: 200 }, (_, i) => `// snapshot ${i} ${"z".repeat(40)}`),
    ].join("\n");

    const pruned = pruneRefineBlocks(body, { threshold: 1024 });
    expect(pruned).not.toContain("// snapshot 100");
  });
});

describe("AC3 — the out-of-band marker survives an unclosed Target span", () => {
  it("a marker appended at body end is not swallowed by an open skip zone", () => {
    // This is the regression that would reopen backlog.fix.refine-apply-no-growth-fixed-point.
    // That story routes add_code_snippet out of band on a near-cap note and appends a one-line
    // marker; plan-ready.mjs reads the marker to decide context was supplied for a target. The
    // marker lands at body END, so when the final section is an unclosed `### Target:` span it
    // sat inside the skip zone and was deleted — and the source comment asserting it "survives
    // the prune" was simply false.
    const body = [
      "## Target Files",
      "",
      "### Target: src/a.mjs",
      "",
      "```javascript",
      ...Array.from({ length: 200 }, (_, i) => `// snapshot ${i} ${"z".repeat(40)}`),
      "```",
      "",
      "<!-- rks:context-out-of-band: src/a.mjs -->",
    ].join("\n");

    const pruned = pruneRefineBlocks(body, { threshold: 1024 });

    expect(pruned).not.toContain("// snapshot 100");
    expect(pruned, "the marker was swallowed by the skip zone").toContain(
      "<!-- rks:context-out-of-band: src/a.mjs -->"
    );
  });
});

describe("AC7 — a prune that preserves everything does NOT escalate", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("prune-ac7");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, TARGET), "export function handleRequest(req) {\n  return req;\n}\n");
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("the create-block call succeeds and writes, rather than refusing", async () => {
    // The escalation's POSITIVE path is defensive: with AC1 and AC2 in force, a create
    // directive or anchor group can no longer be shed, so it should be unreachable in normal
    // operation. What is testable — and what matters — is that it does not fire spuriously and
    // turn every legitimate snapshot strip into a refusal. That failure mode is not
    // hypothetical: an earlier draft of this fix keyed the escalation on `fencesShed`, which
    // counts snapshot fences the prune is SUPPOSED to remove, and it refused to write at all.
    const storyId = "backlog.fix.ac7-negative";
    const notePath = notePathFor(projectRoot, storyId);
    const before = buildNoteWithAuthoredCreateBlock(storyId);
    fs.writeFileSync(notePath, before);

    const res = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "disk_fetch_context", data: { file: TARGET } }],
    });

    expect(res?.status).not.toBe("prune_destroyed_authored_content");
    expect(res?.ok).not.toBe(false);
    // And the note was actually written — a refusal leaves it untouched.
    expect(fs.readFileSync(notePath, "utf8")).toContain(`// CREATE FILE: ${CREATE_TARGET}`);
  });
});
