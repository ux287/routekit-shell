/**
 * Witness for backlog.fix.refine-noop-escalation-false-positive — MECHANISM B.
 *
 * THE BUG: every `data?.file` / `data?.files` handler in the apply loop guarded on a resolvable
 * path with NO `else`. A refinement whose payload did not survive the schema boundary — or that
 * named no file at all — fell out of the loop having pushed nothing to `applied`. The escalation
 * then derived `skipped` by filtering `applied` for results starting with "skipped", and filtering
 * an empty array yields an empty array.
 *
 * The observed payload was `applied: []` AND `escalation.skipped: []`: three refinements in, zero
 * records out, and a caller told that nothing worked with no reason given for anything. That empty
 * ledger is what made a FALSE no-op indistinguishable from a real one — and therefore what made
 * escalating on the first one unsafe.
 *
 * The invariant pinned here: a non-empty `refinements` input can never produce an empty ledger.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const PROBLEM = "backlog.feat.thing";
let projectRoot;

function storyPath() {
  return path.join(projectRoot, "notes", `${PROBLEM}.md`);
}

function writeStory() {
  writeFile(
    storyPath(),
    `---
id: "${PROBLEM}"
phase: "arch-approved"
targetFiles:
  - path: "src/beta.mjs"
    op: "edit"
---

## Problem

Build beta.
`,
  );
}

beforeEach(() => {
  projectRoot = makeTempDir("refine_ledger");
  ensureDir(path.join(projectRoot, "notes"));
  ensureDir(path.join(projectRoot, "src"));
  writeFile(path.join(projectRoot, "src/beta.mjs"), "export const beta = 1;\n");
  writeStory();
});

describe("every refinement handed in leaves a record", () => {
  it("a payload-less add_code_snippet is RECORDED, not silently dropped", async () => {
    // This is the live-reproduction shape: the type survived the schema, the payload did not.
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "add_code_snippet" }],
    });

    expect(res.applied.length).toBe(1);
    expect(res.applied[0].type).toBe("add_code_snippet");
    expect(String(res.applied[0].result)).toMatch(/^skipped/);
  });

  it("escalation.skipped is NEVER empty when refinements was non-empty and nothing applied", async () => {
    // The headline invariant. The old code returned skipped: [] here.
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [
        { type: "add_code_snippet" },
        { type: "add_target_files" },
        { type: "add_search_pattern" },
      ],
    });

    // backlog.fix.refine-inapplicable-status: all three are payload-less, so every
    // ledger entry carries the marker and this is now the DISTINCT status. Everything
    // below this line is the envelope assertion — it must keep holding, which is the
    // point: the new return reproduces the whole refine_noop envelope, not just its
    // first few fields.
    expect(res.status).toBe("refine_inapplicable");
    expect(res.escalation.kind).toBe("refine_inapplicable");
    expect(res.escalation.skipped.length).toBeGreaterThan(0);
    // One record per refinement handed in — not merely "at least one".
    expect(res.applied.length).toBe(3);
    for (const entry of res.escalation.skipped) {
      expect(entry.result, `every skip must state a cause: ${JSON.stringify(entry)}`).toBeTruthy();
    }
  });

  it("the recorded reason names a CAUSE, not just the fact of skipping", async () => {
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "add_code_snippet" }],
    });
    // "skipped" alone is what the caller already knew. The reason has to add information.
    expect(String(res.applied[0].result).length).toBeGreaterThan("skipped".length + 10);
    expect(res.applied[0].result).toMatch(/payload|file/i);
  });

  it("LEDGER ORDERING: records are appended in INPUT order, with no pre-seeding", async () => {
    // tests/unit/refine-snippet-function-aware.test.mjs:71 indexes `result.applied?.[0]`
    // POSITIONALLY. Pre-seeding the ledger, or recording declines before applications, would
    // redden it silently. Input order is therefore a hard constraint, not a nicety.
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [
        { type: "add_code_snippet" },
        { type: "add_search_pattern" },
        { type: "add_target_files" },
      ],
    });

    expect(res.applied.map((a) => a.type)).toEqual([
      "add_code_snippet", "add_search_pattern", "add_target_files",
    ]);
  });

  it("an unrecognized type is recorded as such rather than vanishing", async () => {
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "totally_unknown_type" }],
    });
    expect(res.applied.length).toBe(1);
    expect(res.applied[0].result).toMatch(/unrecognized/i);
  });

  it("a refinement that DOES apply is recorded once, not twice", async () => {
    // Guard against the fallback double-recording a successful application.
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "add_target_files", files: ["src/gamma.mjs"] }],
    });
    const targetFileRecords = res.applied.filter((a) => a.type === "add_target_files");
    expect(targetFileRecords.length).toBe(1);
    expect(String(targetFileRecords[0].result)).not.toMatch(/^skipped/);
  });
});
