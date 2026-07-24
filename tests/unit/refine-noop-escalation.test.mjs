/**
 * Witness for backlog.fix.build-governor-self-heal — a no-op must never report success.
 *
 * THE BUG: `rks_refine_apply` returned `ok: true` AND `requiredNext: rks_plan` after changing
 * NOTHING. It told the Build Governor "success — now go re-plan", the Governor re-planned a
 * BYTE-IDENTICAL story, got the identical failure, refined again, was told "success" again… forever.
 * The retry could never converge, because the feedback never changed the input. A clean-machine
 * greenfield UAT only completed because a human hand-edited the story.
 *
 * The dedup was merely HOW it got there: `add_test_exemplar` checked for the bare header
 * `### Test Exemplar:`, so ANY prior exemplar — for any file, however stale — permanently suppressed
 * every future injection. Its two siblings in the same file already got this right.
 *
 * THE DEFECT IS ON BOTH SIDES OF THE LOOP, and that is why these tests drive the REAL
 * runRefineTool → runRefineApplyTool loop end to end. refine.mjs:625 (the SUGGESTER) carried the
 * identical unqualified check — so fixing only the apply half would mean the correction is never
 * EMITTED, the effect-aware apply is never handed anything, and the loop stays broken. An apply-only
 * witness (hand-building a refinement and calling runRefineApplyTool directly) would be GREEN while
 * the real loop was still non-convergent. That is exactly the vacuity this repo keeps shipping, and
 * it is the reason this file exists.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool, runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const PROBLEM = "backlog.feat.thing";

let projectRoot;

function storyPath() {
  return path.join(projectRoot, "notes", `${PROBLEM}.md`);
}
function readStory() {
  return fs.readFileSync(storyPath(), "utf8");
}

/**
 * A story whose plan needs a test exemplar for `tests/unit/beta.test.mjs` — but which ALREADY holds
 * an exemplar for a DIFFERENT file. That is the whole trap: the old bare-header check saw "there is
 * an exemplar" and suppressed the one that was actually needed, forever.
 */
function writeStory({ withForeignExemplar }) {
  const foreign = withForeignExemplar
    ? `
### Test Exemplar: tests/unit/alpha.test.mjs

\`\`\`js
it("alpha", () => expect(1).toBe(1));
\`\`\`
`
    : "";
  writeFile(
    storyPath(),
    `---
id: "${PROBLEM}"
phase: "arch-approved"
targetFiles:
  - path: "src/beta.mjs"
    op: "create"
  - path: "tests/unit/beta.test.mjs"
    op: "create"
---

## Problem

Build beta.

// CREATE FILE: tests/unit/beta.test.mjs
${foreign}
`,
  );
}

beforeEach(() => {
  projectRoot = makeTempDir("refine_noop");
  ensureDir(path.join(projectRoot, "notes"));
  ensureDir(path.join(projectRoot, "tests/unit"));
  ensureDir(path.join(projectRoot, "src"));
  // An exemplar candidate on disk for the suggester to find.
  writeFile(
    path.join(projectRoot, "tests/unit/alpha.test.mjs"),
    `import { describe, it, expect } from "vitest";

describe("alpha", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});
`,
  );
});

// ══════════════════════════════════════════════════════════════════════════════════
// THE LOOP — suggester + apply, end to end
// ══════════════════════════════════════════════════════════════════════════════════

describe("the refine → refine_apply loop converges", () => {
  it("STILL SUGGESTS when the story already holds an exemplar (the bare-header check suppressed this forever)", async () => {
    writeStory({ withForeignExemplar: true });

    // POSITIVE CONTROL: an exemplar is genuinely present before the call — so the old bare-header
    // check WOULD have fired. Without this, "it suggested something" proves nothing.
    expect(readStory()).toContain("### Test Exemplar: tests/unit/alpha.test.mjs");

    const res = await runRefineTool({
      projectRoot,
      problemId: PROBLEM,
      trigger: "plan_failed",
      projectId: "p",
    });

    // THE SUGGESTER MUST STILL EMIT. Under the old check it emitted NOTHING once any exemplar
    // existed — so the effect-aware apply below is never handed a correction, and the loop cannot
    // converge no matter how many times it runs. The suggester proposes; the apply decides.
    const exemplars = (res.suggestions || []).filter((s) => s.type === "add_test_exemplar");
    expect(exemplars.length).toBeGreaterThan(0);
    expect(exemplars.some((s) => s.file === "tests/unit/beta.test.mjs")).toBe(true);
  });

  it("APPLIES it, and the story actually changes", async () => {
    // NOTE the section header names the exemplar the handler COPIES FROM, not the target file. So a
    // story with no exemplar at all gets one, and the input to the next plan is genuinely different.
    writeStory({ withForeignExemplar: false });
    const before = readStory();
    expect(before).not.toContain("### Test Exemplar:"); // positive control — nothing to dedup against

    const suggested = await runRefineTool({
      projectRoot, problemId: PROBLEM, trigger: "plan_failed", projectId: "p",
    });
    const refinements = (suggested.suggestions || []).filter((s) => s.type === "add_test_exemplar");
    expect(refinements.length).toBeGreaterThan(0); // there IS something to apply

    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, refinements, projectId: "p",
    });

    expect(res.ok).toBe(true);
    expect(res.status).not.toBe("refine_noop");
    // The input to the next plan is genuinely DIFFERENT — the only thing that can make a retry
    // converge.
    const after = readStory();
    expect(after).not.toBe(before);
    expect(after).toContain("### Test Exemplar:");
    // A real change still tells the caller to re-plan. That is correct HERE.
    expect(res.requiredNext).toContain("rks_plan");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// THE ESCALATION — a genuine no-op must NOT report success
// ══════════════════════════════════════════════════════════════════════════════════

describe("a refinement that changes nothing ESCALATES", () => {
  it("returns refine_noop, does NOT say ok, and does NOT tell you to re-plan", async () => {
    writeStory({ withForeignExemplar: true });

    // Apply the SAME foreign exemplar that is already in the story. This genuinely cannot change
    // anything — and it is precisely the shape that used to return "success, go re-plan".
    const refinements = [{ type: "add_test_exemplar", file: "tests/unit/alpha.test.mjs" }];

    // POSITIVE CONTROL: it really is already there, so the skip path is genuinely exercised.
    expect(readStory()).toContain("### Test Exemplar: tests/unit/alpha.test.mjs");
    const before = readStory();

    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, refinements, projectId: "p",
    });

    // THE FIX, in three assertions.
    expect(res.ok).toBe(false);
    expect(res.status).toBe("refine_noop");
    // The one that actually breaks the loop: no instruction to re-plan an unchanged story.
    expect(res.requiredNext).toBeUndefined();

    expect(res.historyAppended).toBe(false);
    expect(res.reason).toMatch(/changed NOTHING/i);
    expect(res.escalation?.nextTool).toBe("rks_exec_abort");
    expect(res.escalation?.skipped?.length).toBeGreaterThan(0);

    // And the story is untouched — we did not stamp `phase`/`updated` onto a story we did not change.
    expect(readStory()).toBe(before);
  });

  it("historyAppended is false on the no-op path (it had ZERO coverage before this story)", async () => {
    writeStory({ withForeignExemplar: true });
    const res = await runRefineApplyTool({
      projectRoot,
      problemId: PROBLEM,
      refinements: [{ type: "add_test_exemplar", file: "tests/unit/alpha.test.mjs" }],
      projectId: "p",
    });
    expect(res.historyAppended).toBe(false);
  });

  // NEGATIVE CONTROL — the over-detection direction. A false escalation breaks SUCCESSFUL applies
  // just as badly as a missed one leaves the loop spinning, and it is the easier mistake to make.
  it("does NOT escalate when a refinement really did something", async () => {
    writeStory({ withForeignExemplar: false });
    const suggested = await runRefineTool({
      projectRoot, problemId: PROBLEM, trigger: "plan_failed", projectId: "p",
    });
    const refinements = (suggested.suggestions || []).filter((s) => s.type === "add_test_exemplar");

    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, refinements, projectId: "p",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBeUndefined();
    expect(res.requiredNext).toContain("rks_plan"); // a real change SHOULD re-plan
  });
});
