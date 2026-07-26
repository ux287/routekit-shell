/**
 * Witness for backlog.fix.planner-dropped-step-diagnostics.
 *
 * Five defects introduced by / left behind from v0.27.0 (the note-step false-rejection P0 fix):
 *
 *   1. TASK-MODE COVERAGE HOLE — v0.27.0 replaced `hasNoteSteps` with `hasTargetCoverageGap` in both
 *      guards. That gate derives from `enhancedEditableTargets`, which is EMPTY in task mode, so it
 *      is ALWAYS false there: a task-mode plan shipped silently minus every step that was dropped.
 *   2. `r.path` vs `r.label` — a pathless rejection rendered as the literal string "null: <reason>".
 *   3. SILENCED DIAGNOSTIC — `_invalid` steps vanish from `combinedSteps`, so the retry prompt no
 *      longer NAMED the step it was asking the LLM to fix.
 *   4/5. The exhausted payload's `noteSteps` was written the long way round ONLY to satisfy a
 *      readFileSync grep of planner.mjs's own source text.
 *
 * EVERY witness here drives the REAL exported functions. No source-text greps, no local
 * re-implementation of the rule — this repo has repeatedly shipped tests that mirrored the code they
 * claimed to witness and stayed green while the rule broke. That is how the original P0 survived two
 * releases, and it is the debt item 5 exists to pay down.
 *
 * VACUITY TRAPS these fixtures are built to avoid (each greens against UNFIXED code if you hit it):
 *   - RKS_SKIP_LLM=1 short-circuits BOTH guards (`&& !skipLlm`). Asserted unset.
 *   - The allowed-targets gate is OPT-IN: `validateStep` short-circuits `allowedMatch` to true when
 *     `allowedTargets` is null. A story-mode witness MUST populate it — and must populate BOTH
 *     `allowFiles` AND `allowPatterns`, because create_file matches only against allowPatterns.
 *   - `search_replace` never consults allowedTargets at all, so an out-of-target search_replace is
 *     dropped for the WRONG reason. The out-of-target step here is a create_file, and its reason is
 *     asserted exactly.
 *   - The placeholder downgrade (:296) runs BEFORE validateStep (:301) and never reads `action`, so a
 *     step with placeholder content never reaches the allowlist check. Out-of-target fixtures carry
 *     REAL bodies.
 *   - `runPlanTool` RECURSES on live LLM calls and is never driven end-to-end.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// Importing planner.mjs transitively pulls the RAG tools chain (@xenova/transformers + onnxruntime).
// Mocked exactly as planner-decomposed-gate.test.mjs does.
vi.mock("../../packages/mcp-rks/src/rag/tools.mjs", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

let classifySteps, validateStep, computeDroppedSteps, evaluatePlanGuard;
let buildRetryGuidance, buildNoExecutableDescription, buildExhaustedPayload;

beforeAll(async () => {
  const planner = await import(path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"));
  ({
    classifySteps,
    validateStep,
    computeDroppedSteps,
    evaluatePlanGuard,
    buildRetryGuidance,
    buildNoExecutableDescription,
    buildExhaustedPayload,
  } = planner);
});

// A body isSynthesizedBody() accepts as REAL. Placeholder/prose content would be downgraded at :296
// before validateStep ever sees the step — which is a different drop reason and a vacuous fixture.
const realBody = (name) => `export function ${name}() {\n  return <div>${name}</div>;\n}\n`;
const PLACEHOLDER = "// TODO: implement";

// ── shared guard-is-live assertions ────────────────────────────────────────────────
// `RKS_SKIP_LLM=1` bypasses BOTH note guards via `&& !skipLlm`. If it ever leaks into this suite's
// env, every "guard did not fire" assertion below greens for free.
function assertGuardIsLive() {
  expect(process.env.RKS_SKIP_LLM).not.toBe("1");
  expect(typeof evaluatePlanGuard).toBe("function");
  expect(typeof computeDroppedSteps).toBe("function");
  expect(typeof classifySteps).toBe("function");
  expect(typeof validateStep).toBe("function");
}

// ══════════════════════════════════════════════════════════════════════════════════
// AC1 — TASK MODE: dropped work MUST fire the guard
// ══════════════════════════════════════════════════════════════════════════════════

describe("AC1 — TASK MODE: a plan that silently discards generated work fires the guard", () => {
  // TASK MODE: no problemId, no targetFiles → allowedTargets is null and enhancedEditableTargets is
  // empty. The ONLY drop sources available here are the placeholder downgrade and validateStep's HARD
  // rejections — the allowlist rejection is UNAVAILABLE (allowedTargets null short-circuits
  // allowedMatch to true), so the fixture is built from those two alone.
  const taskModeFixture = () => {
    const good = { action: "create_file", path: "src/Good.tsx", title: "Good", content: realBody("Good") };
    const dropped = [
      // (i) placeholder-content downgrade — raw action is executable, so it IS lost work
      { action: "edit_file", path: "src/A.tsx", title: "A", content: PLACEHOLDER },
      { action: "create_file", path: "src/B.tsx", title: "B", content: "Create a B component." }, // prose
      // (ii) hard _invalid rejections
      { action: "create_file", path: "src/C.tsx", title: "C" }, // missing content
      { action: "frobnicate", title: "D" }, // unrecognized action type
    ];
    return { rawSteps: [good, ...dropped], good, dropped };
  };

  it("the guard FIRES on 1 executable + 4 dropped steps, and every drop is named", () => {
    assertGuardIsLive();
    const { rawSteps, dropped } = taskModeFixture();

    // TASK MODE: allowedTargets null, no editable targets.
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });

    // The fixture actually dropped what it claims to have dropped (not an assumption).
    expect(classified.executable).toHaveLength(1);
    expect(droppedSteps).toHaveLength(4);
    for (const raw of dropped) {
      const d = droppedSteps.find((x) => x.label === (raw.path || raw.title));
      expect(d, `step ${raw.title} should be in the dropped set`).toBeTruthy();
      // The descriptor carries the RAW executable action the LLM authored — never "note".
      expect(d.action).toBe(raw.action);
      expect(d.action).not.toBe("note");
      expect(d.reason).toBeTruthy();
    }

    const verdict = evaluatePlanGuard({
      combinedSteps: classified.steps,
      enhancedEditableTargets: [], // task mode
      droppedSteps,
    });

    // Task mode is REAL: coverage is not merely satisfied, it is not computable.
    expect(verdict.taskMode).toBe(true);
    expect(verdict.hasTargetCoverageGap).toBe(false);
    expect(verdict.hasExecutableSteps).toBe(true);

    // THE REGRESSION: under v0.27.0 this returned false and the 4 steps vanished silently.
    expect(verdict.fire).toBe(true);
    expect(verdict.reason).toBe("dropped_work");
    expect(verdict.droppedLabels).toHaveLength(4);
  });

  it("on exhaustion the refinement_required payload NAMES all 4 discarded items", () => {
    const { rawSteps } = taskModeFixture();
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const verdict = evaluatePlanGuard({ combinedSteps: classified.steps, enhancedEditableTargets: [], droppedSteps });

    const { payload } = buildExhaustedPayload({
      combinedSteps: classified.steps,
      verdict,
      droppedSteps,
      rejectionReasons: classified.rejectionReasons,
      frontmatterCreateFiles: [],
    });

    expect(payload.status).toBe("refinement_required");
    expect(payload.reason).toBe("dropped_work");
    expect(payload.droppedSteps).toHaveLength(4);
    for (const d of payload.droppedSteps) {
      expect(d.label).toBeTruthy();
      expect(d.reason).toBeTruthy();
      expect(d.action).toBeTruthy();
      expect(d).toHaveProperty("path");
      expect(d).toHaveProperty("title");
    }
  });

  it("the retry prompt NAMES every dropped step — never an empty list, never a bare '.'", () => {
    const { rawSteps } = taskModeFixture();
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const noteLabels = classified.noteSteps.map((s) => s.path || s.title || `<${s.action} step>`);

    const { text, droppedGuidance } = buildRetryGuidance({ noteLabels, droppedSteps, uncoveredTargets: [] });

    expect(droppedGuidance).not.toBe("");
    for (const d of droppedSteps) {
      expect(text).toContain(d.label);
      expect(text).toContain(d.reason);
    }
    // The v0.27.0 symptom: "converted to non-executable notes: ." — naming nothing.
    expect(text).not.toMatch(/notes:\s*\.\s*$/m);
    expect(text).not.toMatch(/:\s*\.\s/);
  });

  it("does NOT fire on an ordinary task-mode plan whose only rejections are advisory", () => {
    // planner.mjs pushes an advisory "missing paired test/doc" descriptor for every code edit that
    // has no paired test AND doc — WITHOUT dropping the step. A guard keyed on rejectionReasons
    // would fire on nearly every ordinary plan. This is the regression that guard would have caused.
    const rawSteps = [
      { action: "create_file", path: "src/One.tsx", title: "One", content: realBody("One") },
      { action: "create_file", path: "src/Two.tsx", title: "Two", content: realBody("Two") },
    ];
    const classified = classifySteps({ rawSteps, allowedTargets: null });

    // Simulate the in-place mutation runPlanTool performs on classified.rejectionReasons.
    classified.rejectionReasons.push(
      { label: "src/One.tsx", path: "src/One.tsx", title: "One", action: "create_file", reason: "missing paired test/doc" },
      { label: "src/Two.tsx", path: "src/Two.tsx", title: "Two", action: "create_file", reason: "missing paired test/doc" },
    );

    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    expect(droppedSteps).toEqual([]); // advisory rejections are NOT drops

    const verdict = evaluatePlanGuard({ combinedSteps: classified.steps, enhancedEditableTargets: [], droppedSteps });
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// AC2b — TASK MODE: LLM commentary is NOT lost work (+ POSITIVE CONTROL)
// ══════════════════════════════════════════════════════════════════════════════════

describe("AC2b — TASK MODE: a commentary note must NOT fire the guard (with positive control)", () => {
  // ONE shared fixture factory, ONE parameterized difference: the extra step is authored as a `note`
  // (AC2b arm) or as an executable step that then gets dropped (CONTROL arm). Everything else —
  // task mode, empty allowedTargets, the two good steps, the env — is identical. The control proves
  // the guard COULD have fired on this very fixture, so AC2b's silence is a RESULT, not a broken
  // harness.
  const fixture = (extraArm) => {
    const good = [
      { action: "create_file", path: "src/One.tsx", title: "One", content: realBody("One") },
      { action: "create_file", path: "src/Two.tsx", title: "Two", content: realBody("Two") },
    ];
    const extra =
      extraArm === "note"
        ? {
          // MUST carry `content` AND a code-extension `path`. The :296 placeholder check runs BEFORE
          // validateStep and never reads `action`, so a note whose content fails isSynthesizedBody
          // DOES push a rejection descriptor — and a rejectionReasons-keyed guard would fire on it.
          // That is the most dangerous input this arm can be given, and the one it must survive.
          //
          // The path is load-bearing: isSynthesizedBody's prose-narration branch is gated on the
          // file EXTENSION (`if (ext && !PROSE_EXEMPT_EXTS.has(ext))`). A PATHLESS note carrying the
          // same prose has no ext, skips that branch entirely, and returns the fail-safe `true` — it
          // is never downgraded, never pushes a descriptor, and would leave this arm asserting
          // nothing. (A realistic shape too: the LLM annotating a file it chose not to change.)
          action: "note",
          path: "src/Three.tsx",
          title: "Consider memoizing later",
          content: "We should consider memoizing this component once the profile data lands.",
        }
        : { action: "edit_file", path: "src/Three.tsx", title: "Three", content: PLACEHOLDER };
    const rawSteps = [...good, extra];
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const verdict = evaluatePlanGuard({ combinedSteps: classified.steps, enhancedEditableTargets: [], droppedSteps });
    return { rawSteps, extra, classified, droppedSteps, verdict };
  };

  it("CONTROL: the same fixture with the extra step authored EXECUTABLE-and-dropped DOES fire", () => {
    assertGuardIsLive();
    const { classified, droppedSteps, verdict, extra } = fixture("dropped");

    expect(droppedSteps).toHaveLength(1);
    expect(droppedSteps[0].label).toBe(extra.path);
    expect(droppedSteps[0].action).toBe("edit_file");
    expect(classified.hasExecutableSteps).toBe(true);

    expect(verdict.taskMode).toBe(true);
    expect(verdict.fire).toBe(true);
    expect(verdict.reason).toBe("dropped_work");
  });

  it("AC2b: the same fixture with an LLM-authored commentary note does NOT fire", () => {
    assertGuardIsLive();
    const { classified, droppedSteps, verdict, extra } = fixture("note");

    // (a) The dangerous path was actually exercised: the content-carrying note DID push a rejection
    //     descriptor at :296. A guard keyed on rejectionReasons would fire here — this one must not.
    expect(classified.rejectionReasons.some((r) => r.reason === "placeholder content")).toBe(true);

    // (b) The good steps survived — an empty/all-rejected fixture also "does not fire", and would
    //     pass for entirely the wrong reason.
    expect(classified.hasExecutableSteps).toBe(true);
    expect(classified.executable).toHaveLength(2);

    // (c) The note was actually classified as a note, and is nameable.
    expect(classified.noteSteps).toHaveLength(1);
    expect(classified.noteSteps.map((s) => s.path || s.title)).toContain(extra.path);

    // (d) Task mode is REAL: coverage is false because there are NO targets, not because coverage
    //     happened to be satisfied.
    expect(verdict.taskMode).toBe(true);
    expect(verdict.hasTargetCoverageGap).toBe(false);
    expect(verdict.uncoveredTargets).toEqual([]);

    // THE CLAIM: commentary is not lost work.
    expect(droppedSteps).toEqual([]);
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// AC2c — STORY MODE: the MODE GATE. A harmless drop must NOT fire. (+ POSITIVE CONTROL)
// ══════════════════════════════════════════════════════════════════════════════════

describe("AC2c — STORY MODE mode gate: an out-of-target step must NOT discard a covered plan", () => {
  // This is the v0.27.0 P0's EXACT shape: an out-of-target step (the injected About.tsx) riding along
  // on an otherwise-perfect, fully-covered plan. If the dropped-step arm is ever OR'd in
  // unconditionally instead of being gated on task mode, that P0 comes straight back — and this pair
  // is the only thing that catches it.
  const ALPHA = "src/alpha/Widget.tsx";
  const BETA = "src/beta/Gadget.tsx";
  // Lexically DISJOINT from both targets in BOTH directions — the coverage compare is fuzzy
  // (`p.endsWith(t.path) || t.path.endsWith(p)`), so a shared suffix would make the coverage claim
  // ambiguous.
  const OUT_OF_TARGET = "vendor/legacy/Unrelated.tsx";

  // STORY MODE: allowedTargets carries BOTH allowFiles AND allowPatterns. create_file matches ONLY
  // against allowPatterns — an allowFiles-only fixture would hard-reject the COVERING creates too,
  // producing a coverage gap and inverting this test.
  const allowedTargets = { allowFiles: [ALPHA, BETA], allowPatterns: [ALPHA, BETA] };
  const targets = [{ path: ALPHA }, { path: BETA }];

  const fixture = ({ uncover = false } = {}) => {
    const covering = [
      { action: "create_file", path: ALPHA, title: "Widget", content: realBody("Widget") },
      { action: "create_file", path: BETA, title: "Gadget", content: realBody("Gadget") },
    ];
    // The out-of-target step carries a REAL body, so it is NOT downgraded at :296 — it reaches the
    // allowlist check and is hard-rejected there. It is a create_file (not search_replace, which
    // never consults allowedTargets at all and would be dropped for the wrong reason).
    const outOfTarget = {
      action: "create_file",
      path: OUT_OF_TARGET,
      title: "Unrelated",
      content: realBody("Unrelated"),
    };
    // The CONTROL differs by exactly ONE thing: one covering step is removed, uncovering BETA.
    const rawSteps = uncover
      ? [covering[0], outOfTarget]
      : [...covering, outOfTarget];

    const classified = classifySteps({ rawSteps, allowedTargets });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const verdict = evaluatePlanGuard({
      combinedSteps: classified.steps,
      enhancedEditableTargets: targets,
      droppedSteps,
    });
    return { rawSteps, classified, droppedSteps, verdict };
  };

  it("AC2c: fully covered + ONE out-of-target step → the guard does NOT fire", () => {
    assertGuardIsLive();
    const { classified, droppedSteps, verdict } = fixture();

    // (T1) Story mode is REAL: the allowlist actually rejected the out-of-target step. If
    //      allowedTargets were unpopulated, validateStep would short-circuit allowedMatch to true,
    //      the step would never be rejected, the dropped set would be empty — and this test would
    //      pass for a reason that has NOTHING to do with the mode gate.
    expect(verdict.taskMode).toBe(false);
    expect(droppedSteps).toHaveLength(1);
    expect(droppedSteps[0].label).toBe(OUT_OF_TARGET);
    // (T3/T4) Dropped for the RIGHT reason — not "file not found", not "placeholder content".
    expect(droppedSteps[0].reason).toBe("path not in editable targets");
    expect(droppedSteps[0].action).toBe("create_file");
    expect(classified.noteSteps).toHaveLength(0);

    // (T2) "Fully covered" actually holds — computed by the predicate, not asserted back at it.
    expect(verdict.hasTargetCoverageGap).toBe(false);
    expect(verdict.uncoveredTargets).toEqual([]);
    expect(classified.executable).toHaveLength(2);

    // THE MODE GATE: dropped work does NOT count in story mode. Coverage governs, and it is clean.
    expect(verdict.fire).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it("AC2c CONTROL: the same fixture with ONE target uncovered DOES fire — via coverage", () => {
    assertGuardIsLive();
    const { classified, droppedSteps, verdict } = fixture({ uncover: true });

    // INVARIANT across both arms — this is what makes the parameterization single-difference: the
    // out-of-target step is present and dropped in BOTH arms. A control whose dropped count differs
    // from AC2c's is a different fixture, not a control.
    expect(droppedSteps).toHaveLength(1);
    expect(droppedSteps[0].label).toBe(OUT_OF_TARGET);

    // Fires via COVERAGE, not by accidentally emptying the plan (which would fire "note_only" and
    // prove nothing about coverage or the mode gate).
    expect(classified.hasExecutableSteps).toBe(true);
    expect(verdict.fire).toBe(true);
    expect(verdict.reason).toBe("coverage_gap");
    expect(verdict.hasTargetCoverageGap).toBe(true);
    expect(verdict.uncoveredTargets.map((t) => t.path)).toEqual([BETA]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// AC3 — a rejection is rendered by its LABEL, never "null: <reason>"
// ══════════════════════════════════════════════════════════════════════════════════

describe("AC3 — a pathless rejection renders by label, never as 'null:'", () => {
  it("a step with NEITHER path NOR title still names itself in the failure description", () => {
    // The original P0 in miniature: a step carrying neither path nor title. `describeStep` gives it
    // the label "<create_file step>"; rendering it by `r.path` gives the literal string "null".
    const rawSteps = [{ action: "create_file", content: realBody("Ghost") }];
    const classified = classifySteps({ rawSteps, allowedTargets: null });

    expect(classified.hasExecutableSteps).toBe(false);
    expect(classified.rejectionReasons).toHaveLength(1);
    expect(classified.rejectionReasons[0].path).toBeNull(); // the field that used to be rendered
    expect(classified.rejectionReasons[0].label).toBe("<create_file step>");

    const description = buildNoExecutableDescription({
      llmActions: [], // NOT null — null routes to the LLM-failure branch
      llmDebug: null,
      rejectionReasons: classified.rejectionReasons,
    });

    expect(description).toContain("<create_file step>");
    expect(description).toContain("missing or invalid path");
    expect(description).not.toMatch(/(^|[^A-Za-z])null:\s/);
  });

  it("a pathless-but-titled step renders by its title", () => {
    const rawSteps = [{ action: "create_file", title: "Add the widget", content: realBody("W") }];
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const description = buildNoExecutableDescription({
      llmActions: [],
      llmDebug: null,
      rejectionReasons: classified.rejectionReasons,
    });
    expect(description).toContain("Add the widget");
    expect(description).not.toMatch(/(^|[^A-Za-z])null:\s/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// AC4 — drops are named in BOTH the retry prompt and the failure payload
// ══════════════════════════════════════════════════════════════════════════════════

describe("AC4 — an out-of-target drop is NAMED (retry prompt + failure payload)", () => {
  const TARGET = "src/alpha/Widget.tsx";
  const OUT = "vendor/legacy/Other.tsx";
  const allowedTargets = { allowFiles: [TARGET], allowPatterns: [TARGET] };

  // STORY MODE by necessity: an out-of-target rejection requires a populated allowlist. In task mode
  // allowedTargets is null, allowedMatch short-circuits to true, and the step is never dropped at all.
  const fixture = () => {
    const rawSteps = [
      // A KEPT step (covers the target) — it carries only an ADVISORY rejection, and must NEVER be
      // named as dropped.
      { action: "create_file", path: TARGET, title: "Widget", content: realBody("Widget") },
      { action: "create_file", path: OUT, title: "Other", content: realBody("Other") },
    ];
    const classified = classifySteps({ rawSteps, allowedTargets });
    // The advisory loop runPlanTool runs, reproduced faithfully: it pushes into the SAME array object
    // classifySteps returned, for a step that was KEPT and is still executable.
    classified.rejectionReasons.push({
      label: TARGET, path: TARGET, title: "Widget", action: "create_file", reason: "missing paired test/doc",
    });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    return { rawSteps, classified, droppedSteps };
  };

  it("names the dropped step with action + path + title + reason, and never names a KEPT step", () => {
    const { classified, droppedSteps } = fixture();

    expect(droppedSteps).toHaveLength(1);
    const [d] = droppedSteps;
    expect(d.action).toBe("create_file");
    expect(d.path).toBe(OUT);
    expect(d.title).toBe("Other");
    expect(d.reason).toBe("path not in editable targets");

    // THE CONVERSE, and it is the one that bites: the kept step carries an advisory rejection, so a
    // naive rejectionReasons-sourced diagnostic would tell the LLM to rewrite work that is CORRECT.
    expect(droppedSteps.map((x) => x.label)).not.toContain(TARGET);
    expect(classified.executable.map((s) => s.path)).toContain(TARGET);
  });

  it("the retry prompt names it; the refinement_required payload names it", () => {
    const { classified, droppedSteps } = fixture();
    const uncoveredTargets = [];

    const { text } = buildRetryGuidance({ noteLabels: [], droppedSteps, uncoveredTargets });
    expect(text).toContain(OUT);
    expect(text).toContain("create_file");
    expect(text).toContain("path not in editable targets");
    expect(text).not.toContain("missing paired test/doc"); // the KEPT step is not scolded

    const verdict = evaluatePlanGuard({
      combinedSteps: classified.steps,
      enhancedEditableTargets: [{ path: TARGET }],
      droppedSteps,
    });
    const { payload } = buildExhaustedPayload({
      combinedSteps: classified.steps,
      verdict,
      droppedSteps,
      rejectionReasons: classified.rejectionReasons,
      frontmatterCreateFiles: [],
    });

    expect(payload.droppedSteps).toHaveLength(1);
    expect(payload.droppedSteps[0].path).toBe(OUT);
    expect(payload.droppedSteps[0].reason).toBe("path not in editable targets");
  });

  it("SAME-PATH COLLISION: a kept step and a dropped step sharing a path do not cancel out", () => {
    // A label-keyed set difference computes {P} \ {P} = ∅ here and loses the drop ENTIRELY — worse
    // than naming it wrong. The difference must be keyed on object identity.
    const P = "src/alpha/Widget.tsx";
    const kept = { action: "create_file", path: P, title: "Widget", content: realBody("Widget") };
    const droppedSamePath = { action: "edit_file", path: P, title: "Widget tweak", content: PLACEHOLDER };
    const rawSteps = [kept, droppedSamePath];

    const classified = classifySteps({ rawSteps, allowedTargets: { allowFiles: [P], allowPatterns: [P] } });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });

    expect(droppedSteps).toHaveLength(1);
    expect(droppedSteps[0].label).toBe(P);
    expect(droppedSteps[0].reason).toBe("placeholder content"); // the DROP reason, not the advisory one
    expect(droppedSteps[0].action).toBe("edit_file");

    // The kept step is untouched and still rides into the plan.
    expect(classified.executable).toHaveLength(1);
    expect(classified.executable[0]).toBe(kept); // same object reference
  });

  it("CONTAMINATION IMMUNITY: pre-polluting rejectionReasons does not change the dropped set", () => {
    // runPlanTool mutates classified.rejectionReasons IN PLACE (it is the same array object). A
    // dropped-set derived from that array would be contaminated by advisory entries — and the
    // contamination is unobservable from outside runPlanTool. The set difference never reads it.
    const rawSteps = [
      { action: "create_file", path: "src/One.tsx", title: "One", content: realBody("One") },
      { action: "create_file", path: "src/Two.tsx", title: "Two", content: realBody("Two") },
    ];
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const before = computeDroppedSteps({ rawSteps, classified });
    expect(before).toEqual([]);

    for (const s of rawSteps) {
      classified.rejectionReasons.push({
        label: s.path, path: s.path, title: s.title, action: s.action, reason: "missing paired test/doc",
      });
    }

    const after = computeDroppedSteps({ rawSteps, classified });
    expect(after).toEqual([]); // UNCHANGED — and names none of the kept steps
    expect(after.map((d) => d.label)).not.toContain("src/One.tsx");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// AC5 — the exhausted payload's noteSteps IS noteLabels (behavioral, not a source grep)
// ══════════════════════════════════════════════════════════════════════════════════

describe("AC5 — the exhausted payload's noteSteps field is correctly populated", () => {
  it("noteSteps equals the computed noteLabels for the same input, and every entry is nameable", () => {
    const rawSteps = [
      { action: "create_file", path: "src/Good.tsx", title: "Good", content: realBody("Good") },
      { action: "note", title: "A titled note" },
      { action: "note", path: "notes/thing.md" },
      { action: "note" }, // NEITHER path nor title — the step that made the original bug undebuggable
    ];
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const verdict = evaluatePlanGuard({ combinedSteps: classified.steps, enhancedEditableTargets: [], droppedSteps });

    const { payload, noteLabels } = buildExhaustedPayload({
      combinedSteps: classified.steps,
      verdict,
      droppedSteps,
      rejectionReasons: classified.rejectionReasons,
      frontmatterCreateFiles: [],
    });

    expect(payload.noteSteps).toEqual(noteLabels);
    expect(payload.noteSteps).toEqual(["A titled note", "notes/thing.md", "<note step>"]);
    // No entry may be the empty string — that render is what made the P0 impossible to debug.
    for (const label of payload.noteSteps) expect(label).not.toBe("");
  });

  it("structural discriminator is still attached additively for an uncovered op:create target", () => {
    const rawSteps = [{ action: "note", title: "AC restated" }];
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const verdict = evaluatePlanGuard({ combinedSteps: classified.steps, enhancedEditableTargets: [], droppedSteps });

    const { payload } = buildExhaustedPayload({
      combinedSteps: classified.steps,
      verdict,
      droppedSteps,
      rejectionReasons: classified.rejectionReasons,
      frontmatterCreateFiles: ["public/decks/aar.html"],
    });

    expect(payload.status).toBe("refinement_required");
    expect(payload.reason).toBe("note_only");
    expect(payload.failureClass).toBe("structural");
    expect(payload.refinable).toBe(false);
    expect(payload.uncoveredCreateTargets).toEqual(["public/decks/aar.html"]);
    expect(payload.rejectionReasons).toBeDefined();
  });
});
