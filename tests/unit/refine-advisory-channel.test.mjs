import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRefineTool } from "../../packages/mcp-rks/src/server/refine.mjs";

/**
 * backlog.fix.refine-plan-staging-advisory-channel
 *
 * `rks_refine` emitted `plan_staging` into `suggestions[]`, but `rks_refine_apply`
 * has no handler for it — so applying it produced a guaranteed decline, reported as
 * `refine_noop`, and any Governor obeying the Build prompt's STOP rule terminated a
 * healthy run on a suggestion that was never actionable. A child project reported it
 * killing a story outright.
 *
 * The cure is mechanical rather than advisory: with `plan_staging` out of
 * `suggestions[]`, a staging-only refine leaves that array empty, so `requiredNext`
 * flips from `rks_refine_apply` to `rks_plan` and the doomed call is never requested.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REFINE_SRC = path.join(__dirname, "../..", "packages/mcp-rks/src/server/refine.mjs");

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-advisory-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".rks", "project.json"),
    JSON.stringify({
      projectId: "test-project",
      branches: { working: "staging", integration: "staging", production: "main" },
    }),
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const n of ["a", "b", "c", "d", "e", "f"]) {
    fs.writeFileSync(path.join(root, "src", `${n}.mjs`), `// ${n}\n`);
  }
});
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function writeStory(id, targetFilesYaml, extraBody = "") {
  fs.writeFileSync(
    path.join(root, "notes", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      "status: not-implemented",
      "phase: ready",
      "testRequirements:",
      '  - "Test passes"',
      "targetFiles:",
      targetFilesYaml,
      "---",
      "",
      "## Problem",
      "",
      "Test story.",
      "",
      "## Acceptance Criteria",
      "- [ ] One criterion",
      "- [ ] Two criterion",
      "",
      extraBody,
    ].join("\n"),
  );
  return id;
}

/** Six op:edit targets exceeds the editCount threshold of 5, tripping staging. */
function writeBigStory(id = "big-story") {
  return writeStory(id, ["a", "b", "c", "d", "e", "f"].map((n) => `  - path: src/${n}.mjs\n    op: edit`).join("\n"));
}

/** One target — no concern-scoring signal fires, so nothing advisory is emitted. */
function writeSmallStory(id = "small-story") {
  return writeStory(id, "  - path: src/a.mjs\n    op: edit");
}

const SIX = ["a", "b", "c", "d", "e", "f"];

/**
 * A fixture that is PROVABLY staging-only: `advisory[]` carries plan_staging and
 * `suggestions[]` is empty. Derived, not observed — the derivation is the point,
 * because a fixture that merely happens to emit nothing today puts the routing
 * assertion straight back where it was.
 *
 * TRIPS (needed, so estimatedComplexity becomes "high" and the advisory fires):
 *   - refine.mjs:481-482  targetFileCount > 5 — six targets
 *   - refine.mjs:492      editCountThreshold = 5 for all-op:edit — six exceeds it
 *   Two signals satisfy the >= 2 gate at :536-:537.
 *
 * AVOIDS (each by a stated mechanism, all six paths on src/a..f.mjs):
 *   - refine.mjs:656 fix_target_files — the loop's fs.stat at :663 SUCCEEDS,
 *     because beforeEach pre-creates all six files. Its :658 exemption is
 *     op:create-only, so no body section can suppress it; a missing path is the
 *     one thing that would arm it. The push at :669 is guarded by :668
 *     `if (missingFiles.length > 0)` and would emit ONE aggregate entry, not six
 *     — the count is irrelevant, non-emptiness is what breaks the routing test.
 *   - refine.mjs:708 add_code_snippet — suppressed by a `### Target: <path>`
 *     section per target. The :713 disjunct runs through :715 and terminates at
 *     :716 `) continue;`, skipping the :726 and :735 pushes alike.
 *   - refine.mjs:838-852 — inert here regardless of the Target sections. Its
 *     guard is a THREE-way AND whose first conjunct (:844) is
 *     `context && context.includes("no_search_pattern_for_modify")`, and this
 *     suite never passes `context`.
 *   - refine.mjs:602 fix_vague_tests — the five patterns at :387-:391 are
 *     start-anchored and "Test passes" matches none.
 *   - the trigger-gated emitters (:823, :863, :872) — this suite passes no trigger.
 */
function writeStagingOnlyStory(id = "staging-only-story") {
  return writeStory(
    id,
    SIX.map((n) => `  - path: src/${n}.mjs\n    op: edit`).join("\n"),
    SIX.map((n) => `### Target: src/${n}.mjs\n`).join("\n"),
  );
}

const refine = (problemId) => runRefineTool({ projectRoot: root, problemId });

describe("plan_staging leaves suggestions[] for advisory[]", () => {
  it("does not appear in suggestions[]", async () => {
    const res = await refine(writeBigStory());
    expect(res.suggestions.map((s) => s.type)).not.toContain("plan_staging");
  });

  it("appears in advisory[] carrying applicable:false and a reason naming why", async () => {
    const res = await refine(writeBigStory());
    const entry = res.advisory.find((a) => a.type === "plan_staging");
    expect(entry, "expected a plan_staging advisory entry").toBeTruthy();
    expect(entry.applicable).toBe(false);
    expect(entry.applicableReason).toMatch(/handler|decline/i);
  });

  it("preserves the advice itself — reason, hint and priority are unchanged", async () => {
    const entry = (await refine(writeBigStory())).advisory.find((a) => a.type === "plan_staging");
    expect(entry.priority).toBe("medium");
    expect(entry.reason).toBeTruthy();
    expect(entry.hint).toMatch(/multi-step plan|staged commits|refine-in-place/);
    expect(entry.hint).toMatch(/independent-concern break/);
  });
});

describe("the response shape consumers rely on", () => {
  it("returns advisory[] as an empty array when nothing advisory was emitted", async () => {
    const res = await refine(writeSmallStory());
    expect(Array.isArray(res.advisory)).toBe(true);
    expect(res.advisory).toEqual([]);
  });

  it("returns advisoryNotice on every response, including when advisory[] is empty", async () => {
    for (const write of [writeSmallStory, writeBigStory]) {
      const res = await refine(write());
      expect(typeof res.advisoryNotice, "advisoryNotice").toBe("string");
      expect(res.advisoryNotice).toMatch(/rks_refine_apply/);
      // Anchored on a dash-free phrase from the notice text. The previous
      // pattern /not|NOT/ matched "notice" and "nothing" — it passed on the real
      // text for the wrong reason, and would have kept passing if the meaning
      // inverted. Two decoys below prove this one discriminates.
      expect(res.advisoryNotice).toMatch(/Do NOT pass them to rks_refine_apply/);
    }
  });
});

describe("the advisoryNotice pattern discriminates", () => {
  // The pattern must fail on text that contains the noise words it used to match,
  // and on text whose MEANING is inverted. Without both decoys, "it passes on the
  // real string" is not evidence that it is testing the right thing.
  const PATTERN = /Do NOT pass them to rks_refine_apply/;

  it("rejects text that merely contains the old noise words", () => {
    expect(PATTERN.test("This notice says nothing about rks_refine_apply.")).toBe(false);
  });

  it("rejects text whose meaning is inverted", () => {
    expect(PATTERN.test("Do pass them to rks_refine_apply.")).toBe(false);
  });

  it("accepts the live notice", async () => {
    const res = await refine(writeSmallStory());
    expect(PATTERN.test(res.advisoryNotice)).toBe(true);
  });
});

describe("the cure: requiredNext no longer requests a doomed apply", () => {
  // This is the mechanism, not a side effect. requiredNext derives from
  // suggestions.length, so a staging-only refine now routes to rks_plan.
  it("routes a staging-only refine to rks_plan, not rks_refine_apply", async () => {
    // EXECUTION WITNESS. The previous version guarded the two routing assertions
    // behind `if (!stagingOnly) { ...; return; }` — and the fixture always tripped
    // other signals, so the early return always fired and the assertions this
    // describe block is named for never ran. Counting assertions catches that:
    // any path that completes without executing all four fails here, whereas a
    // source-level check for the absent `return` would only prove the text is gone.
    expect.assertions(4);

    const res = await refine(writeStagingOnlyStory());

    // PRECONDITIONS ARE ASSERTIONS, not a branch. If the fixture ever stops being
    // staging-only, these redden — they do not silently reroute the test.
    expect(res.suggestions, "fixture must emit no suggestions").toHaveLength(0);
    expect(res.advisory.map((a) => a.type)).toContain("plan_staging");

    expect(res.requiredNext).toMatch(/rks_plan/);
    expect(res.requiredNext).not.toMatch(/rks_refine_apply/);
  });
});

describe("applicable:false is drift-guarded against a future handler", () => {
  // AC5. `applicable: false` is a literal asserted by intent, so it can silently
  // become a lie the day someone adds an apply handler for an advisory type. This
  // derives the advisory type set from source and checks no dispatch exists for it.
  it("no advisory type has an apply-loop handler", () => {
    const src = fs.readFileSync(REFINE_SRC, "utf8");

    const advisoryTypes = new Set();
    const pushRe = /advisory\.push\(\{/g;
    let m;
    while ((m = pushRe.exec(src)) !== null) {
      const window = src.slice(m.index, m.index + 200);
      const typeMatch = window.match(/type:\s*"([a-z0-9_]+)"/);
      if (typeMatch) advisoryTypes.add(typeMatch[1]);
    }

    // Lower bound — without this the loop below passes vacuously if the scan
    // pattern ever stops matching, which is how the sibling suite at
    // refine-apply-schema-contract.test.mjs lost coverage silently.
    expect(advisoryTypes.size, "advisory emit sites found").toBeGreaterThan(0);
    expect(advisoryTypes).toContain("plan_staging");

    const withHandlers = [...advisoryTypes].filter((t) => src.includes(`type === "${t}"`));
    expect(
      withHandlers,
      "an advisory type gained an apply handler — applicable:false is now false-while-reported",
    ).toEqual([]);
  });

  // Positive control for the handler probe: the same predicate must FIND a handler
  // for a type that genuinely has one, or the assertion above proves nothing.
  it("the handler probe detects a type that does have a handler", () => {
    const src = fs.readFileSync(REFINE_SRC, "utf8");
    expect(src.includes('type === "add_search_pattern"')).toBe(true);
  });
});
