/**
 * Witness for backlog.fix.planner-note-step-degeneracy (fail-loud revision).
 *
 * Virgin-file op:create stories used to park in plan_review forever: the planner produced an
 * all-note-steps plan (AC checkboxes + boilerplate meta-steps), never a create_file step,
 * tripped has_note_steps every attempt, and the outer refine→plan loop re-burned the
 * structurally-impossible plan silently.
 *
 * DESIGN (per user directive): the planner has NO model-escalation ladder, so an un-authorable
 * create MUST FAIL LOUD — never a silent stub-and-succeed (that would ship a placeholder file).
 *   PART A — planner.mjs: a REAL create_file step (non-empty content) from the LLM passes
 *            through and covers its op:create target; when the LLM returns NO usable content for
 *            an uncovered op:create target, route IMMEDIATELY to the loud structural failure
 *            (buildStructuralFailure) — no stub, no loop. planner-llm.mjs keeps the ADDITIVE
 *            CREATE TARGETS directive (maximizes the chance the LLM authors REAL content first).
 *   PART B — plan.retry.exhausted keeps a structural discriminator additively (safety net).
 *   PART C — governor-build.md step 4 short-circuits the outer loop on failureClass:"structural".
 *
 * Isolation: the LLM planner (src/llm/planner.mjs runLlmPlanner) is vi.mock'd — NO live LLM.
 * The RAG tools chain is mocked so importing planner.mjs does not pull in transformers/onnx.
 * The only subprocess-capable path exercised (planProblem decomposed gate) reads frontmatter
 * and returns before any spawn; no unguarded subprocess is launched by this suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { isSynthesizedBody } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// Isolation (testRequirement TEST ISOLATION): mock the LLM planner — no live LLM call.
vi.mock("../../packages/mcp-rks/src/llm/planner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runLlmPlanner: vi.fn() };
});

// Mock the RAG tools chain so importing planner.mjs does not transitively load
// @xenova/transformers + onnxruntime-node. See planner-decomposed-gate.test.mjs.
vi.mock("../../packages/mcp-rks/src/rag/tools.mjs", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

const plannerSrc = fs.readFileSync(
  path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"),
  "utf8"
);
const plannerLlmSrc = fs.readFileSync(
  path.join(ROOT, "packages/mcp-rks/src/server/planner-llm.mjs"),
  "utf8"
);
const governorBuildSrc = fs.readFileSync(
  path.join(ROOT, ".rks/prompts/governor-build.md"),
  "utf8"
);

let buildStructuralFailure, planProblem;
let classifySteps, computeDroppedSteps, evaluatePlanGuard, buildExhaustedPayload;
let classifyPlanStatus;
let validatePromptReadiness;
let runLlmPlanner;

beforeAll(async () => {
  const planner = await import(path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs"));
  buildStructuralFailure = planner.buildStructuralFailure;
  planProblem = planner.planProblem;
  classifySteps = planner.classifySteps;
  computeDroppedSteps = planner.computeDroppedSteps;
  evaluatePlanGuard = planner.evaluatePlanGuard;
  buildExhaustedPayload = planner.buildExhaustedPayload;
  const prompts = await import(path.join(ROOT, "packages/mcp-rks/src/server/planner-prompts.mjs"));
  classifyPlanStatus = prompts.classifyPlanStatus;
  const llm = await import(path.join(ROOT, "packages/mcp-rks/src/server/planner-llm.mjs"));
  validatePromptReadiness = llm.validatePromptReadiness;
  const llmPlanner = await import(path.join(ROOT, "packages/mcp-rks/src/llm/planner.mjs"));
  runLlmPlanner = llmPlanner.runLlmPlanner;
});

// The source coverage rule (planner.mjs): a create_file step with a REAL BODY covers its
// op:create target; empty / placeholder-only / prose-narration content leaves it uncovered →
// loud structural fail.
//
// backlog.fix.planner-greenfield-body-synthesis: this calls the REAL isSynthesizedBody the
// source calls — it is not a hand-copied mirror of the rule. A local mirror can silently drift
// from the source it claims to witness (and did: the mirror's "non-empty string" rule counted
// prose narration as covered), which is the exact class of divergence this story exists to kill.
function coveredCreatePaths(llmActions) {
  return new Set(
    (llmActions || [])
      .filter(a => a?.action === "create_file" && isSynthesizedBody(a?.content, a?.path))
      .map(a => a.path).filter(Boolean)
  );
}
function uncoveredCreates(frontmatterCreateFiles, llmActions) {
  const covered = coveredCreatePaths(llmActions);
  return Array.from(frontmatterCreateFiles).filter(p => !covered.has(p));
}

// ── PART A: authorable creates pass through; un-authorable creates FAIL LOUD ───────

describe("PART A — authorable create passes through, un-authorable create fails loud", () => {
  it("PASS-THROUGH: a REAL create_file step (non-empty content) covers its op:create target", () => {
    const target = "public/decks/aar-software-governed-ai.html";
    const llmActions = [{ action: "create_file", path: target, content: "<!doctype html><html><body>Deck</body></html>" }];
    // Covered → no uncovered create → no structural failure route.
    expect(uncoveredCreates(new Set([target]), llmActions)).toEqual([]);
  });

  it("FAIL-LOUD: LLM empty (no usable content) for an op:create target → structural, NOT a stub", () => {
    const target = "public/decks/aar-software-governed-ai.html";
    // LLM produced nothing usable (empty actions, or a create_file with empty content, or note-only).
    for (const llmActions of [[], [{ action: "create_file", path: target, content: "   " }], [{ action: "note", title: "AC restated" }]]) {
      const uncovered = uncoveredCreates(new Set([target]), llmActions);
      expect(uncovered).toEqual([target]); // stays uncovered → routes to loud fail

      const sig = buildStructuralFailure(uncovered);
      expect(sig.failureClass).toBe("structural");
      expect(sig.refinable).toBe(false);
      expect(sig.uncoveredCreateTargets).toEqual([target]);
      expect(sig.message).toContain(target); // names the un-authorable target
      expect(sig.message).toMatch(/no usable content/i);
      // NOT a stub, NOT the generic refinable hint.
      expect(sig.message).not.toMatch(/run rks_refine/i);
    }
  });

  it("planner.mjs routes uncovered op:create to buildStructuralFailure and returns IMMEDIATELY (no stub, no loop)", () => {
    // Immediate structural return exists, built from the loud signal, before the retry loop.
    expect(plannerSrc).toContain("uncoveredCreatesAfterLlm");
    expect(plannerSrc).toMatch(/if\s*\(uncoveredCreatesAfterLlm\.length\s*>\s*0\)/);
    expect(plannerSrc).toContain("buildStructuralFailure(uncoveredCreatesAfterLlm)");
    // Returns the discriminator additively; no synthesized-stub machinery survives.
    expect(plannerSrc).toContain("failureClass: structural.failureClass");
    expect(plannerSrc).not.toContain("synthesizeCreateSteps");
    expect(plannerSrc).not.toContain("buildCreateStubContent");
    expect(plannerSrc).not.toContain("synthesized_create");
  });

  it("coverage rule requires a REAL BODY (empty, placeholder-only, and prose-narration creates do NOT cover)", () => {
    // Behavioral guard, replacing a source-grep pin on the old `String(a.content).trim()` rule.
    // Grepping the implementation for its own source text asserts nothing about behavior and
    // breaks on every refactor; assert against the predicate the source actually calls.
    const target = "src/components/Calculator.tsx";
    const cover = (content) => coveredCreatePaths([{ action: "create_file", path: target, content }]).has(target);

    expect(cover("")).toBe(false);                              // empty
    expect(cover("   \n  ")).toBe(false);                       // whitespace-only
    expect(cover("// TODO: implement the calculator")).toBe(false);   // placeholder-only
    // THE GREENFIELD BUG: prose narration is a non-empty string, so the old rule counted it as
    // covered — the plan looked authored, executed nothing, and looped forever.
    expect(cover("Create a Calculator component that handles the four basic operations.")).toBe(false);

    // A real body covers — including one that merely CONTAINS a TODO (must not be over-rejected).
    expect(cover("export function Calculator() {\n  return <div>0</div>;\n}")).toBe(true);
    expect(cover("export function Calculator() {\n  // TODO: divide-by-zero\n  return <div>0</div>;\n}")).toBe(true);
  });

  it("the coverage gate in planner.mjs is wired to the shared isSynthesizedBody predicate", () => {
    // Structural pin (narrow, not a copy of the rule): the gate must delegate to the shared
    // predicate rather than re-deriving "has content" locally — local re-derivation is what
    // let the LLM-side and server-side rules diverge.
    expect(plannerSrc).toContain("isSynthesizedBody");
    expect(plannerSrc).toMatch(/create_file"\s*&&\s*isSynthesizedBody\(/);
  });

  it("does NOT call the live LLM planner (isolation)", () => {
    expect(vi.isMockFunction(runLlmPlanner)).toBe(true);
    expect(runLlmPlanner).not.toHaveBeenCalled();
  });
});

// ── rag_miss does NOT block create-step generation (additive directive) ─────────

describe("PART A — rag_miss on an op:create target does not block create-step generation", () => {
  it("validatePromptReadiness adds an ADDITIVE create_file directive for uncovered op:create paths", () => {
    const target = "public/decks/aar.html";
    const result = validatePromptReadiness({
      totalSnippetChars: 0,
      hasSnippets: false, // rag_miss condition
      hasTargetFiles: true,
      frontmatterTargets: [target],
      planningText: "Build the deck",
      planningSource: "context",
      requirementSummary: "Summary",
      slug: "test",
      projectId: "my-project",
      uncoveredCreatePaths: [target],
    });
    // Additive create directive naming the path — maximizes the chance the LLM authors REAL content.
    expect(result.enhancedRequirements).toContain("CREATE TARGETS");
    expect(result.enhancedRequirements).toContain(`- ${target}`);
    expect(result.enhancedRequirements).toContain("create_file");
    // The base rag_miss directive is still present (op:edit path preserved).
    expect(result.enhancedRequirements).toContain("search_replace actions");
    expect(result.warnings).toContain("targetFiles specified but no snippets fetched");
  });
});

// ── DEGENERACY DETECTION + LOUD message ────────────────────────────────────────

describe("structural failure signal shape and phrasing", () => {
  it("DEGENERACY DETECTION: machine-readable failureClass:'structural' discriminator, distinct from generic hint", () => {
    const sig = buildStructuralFailure(["public/decks/aar.html"]);
    expect(sig.failureClass).toBe("structural");
    expect(sig.refinable).toBe(false);
    expect(sig.uncoveredCreateTargets).toEqual(["public/decks/aar.html"]);
    expect(sig.failureClass).not.toBe("has_note_steps");
    expect(sig.message).not.toMatch(/run rks_refine/i);
  });

  it("LOUD signal names the uncovered target(s) and uses non-refinable phrasing", () => {
    const sig = buildStructuralFailure([
      "public/decks/aar.html",
      "public/decks/aar.client.html",
    ]);
    expect(sig.message).toContain("public/decks/aar.html");
    expect(sig.message).toContain("public/decks/aar.client.html");
    // decompose/analyze will not help; hand-author or escalate to a stronger model.
    expect(sig.message).toMatch(/will not help/i);
    expect(sig.message).toMatch(/hand-author/i);
    expect(sig.message).toMatch(/escalate to a stronger model/i);
  });

  // backlog.fix.planner-dropped-step-diagnostics: this used to be a readFileSync grep of planner.mjs's
  // own source, asserting the literal text `noteSteps: combinedSteps.filter`. It asserted NOTHING
  // about behavior, broke on any refactor, and — worse — pinned a contorted expression in place:
  // production code was written the long way round purely to keep this grep green. It is now driven
  // through the REAL exported payload builder, which is what it always claimed to be testing.
  it("plan.retry.exhausted return is ADDITIVE — every pinned field is returned, plus the discriminator", () => {
    const target = "public/decks/aar.html";
    // An exhausted plan: note steps only, and an op:create target left uncovered → structural.
    const rawSteps = [
      { action: "note", title: "AC restated" },
      { action: "note" }, // neither path nor title — must still be nameable
    ];
    const classified = classifySteps({ rawSteps, allowedTargets: null });
    const droppedSteps = computeDroppedSteps({ rawSteps, classified });
    const verdict = evaluatePlanGuard({
      combinedSteps: classified.steps,
      enhancedEditableTargets: [],
      droppedSteps,
    });
    const { payload } = buildExhaustedPayload({
      combinedSteps: classified.steps,
      verdict,
      droppedSteps,
      rejectionReasons: classified.rejectionReasons,
      frontmatterCreateFiles: [target],
    });

    // Pinned fields preserved (protects planner-validate-step.test.mjs)
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("refinement_required");
    expect(payload.reason).toBe("note_only");
    expect(payload.rejectionReasons).toBeDefined();
    // noteSteps is RETURNED and correctly populated — every entry nameable, none the empty string.
    expect(payload.noteSteps).toEqual(["AC restated", "<note step>"]);
    for (const label of payload.noteSteps) expect(label).not.toBe("");

    // New structural discriminator + named targets added additively
    expect(payload.failureClass).toBe("structural");
    expect(payload.refinable).toBe(false);
    expect(payload.uncoveredCreateTargets).toEqual([target]);
    expect(payload.message).toContain(target);
  });

  it("the exhausted guard is still gated on the retry budget, and telemetry carries the discriminator", () => {
    // Narrow structural pins that have no behavioral surface (the guard condition and the telemetry
    // emit both live inside runPlanTool, which cannot be driven — it recurses on live LLM calls).
    expect(plannerSrc).toContain("retryCount >= MAX_NOTE_ONLY_RETRIES");
    expect(plannerSrc).toMatch(/plan\.retry\.exhausted[\s\S]*?failureClass: structural\.failureClass/);
  });
});

// ── snippets_missing ADDITIVE reconciliation (planner-llm.mjs) ──────────────────

describe("PART A — planner-llm.mjs snippets_missing reconciliation is additive", () => {
  it("preserves the rag_miss/query_empty ternary VERBATIM", () => {
    expect(plannerLlmSrc).toMatch(
      /frontmatterTargets\?\.length\s*>\s*0\s*\?\s*'rag_miss'\s*:\s*'query_empty'/
    );
  });

  it("preserves the snippets_missing emit fields (reason, targetFiles, promptLength, slug)", () => {
    const emit = plannerLlmSrc.match(/emitTelemetry\("plan\.prompt\.snippets_missing"[\s\S]*?\}\)/)?.[0] ?? "";
    expect(emit).toContain("reason:");
    expect(emit).toContain("targetFiles");
    expect(emit).toContain("promptLength");
    expect(emit).toContain("slug");
  });

  it("adds the op:create carve-out additively (after the pinned ternary, not replacing it)", () => {
    expect(plannerLlmSrc).toContain("op:create carve-out");
    expect(plannerLlmSrc).toContain("CREATE TARGETS");
    const ternaryIdx = plannerLlmSrc.indexOf("? 'rag_miss' : 'query_empty'");
    const carveIdx = plannerLlmSrc.indexOf("op:create carve-out");
    expect(ternaryIdx).toBeGreaterThan(-1);
    expect(carveIdx).toBeGreaterThan(ternaryIdx); // additive, downstream of the pinned ternary
  });
});

// ── boilerplate scaffold-note suppression for create stories ────────────────────

describe("PART A — boilerplate scaffold notes suppressed for create stories (static-source)", () => {
  it("refinement-note injection is gated by suppressScaffoldNotes when uncovered creates exist", () => {
    expect(plannerSrc).toContain("suppressScaffoldNotes");
    expect(plannerSrc).toContain("(!llmActions || llmActions.length === 0) && !suppressScaffoldNotes");
    expect(plannerSrc).toContain("uncoveredCreatesAfterLlm");
  });
});

// ── FAIL-FAST outer-loop short-circuit (governor-build.md, PART C) ──────────────

describe("PART C — governor-build.md step 4 outer-loop short-circuit (static-content)", () => {
  it("preserves the pinned single-digit-cap literals VERBATIM", () => {
    expect(governorBuildSrc).toContain("max 2 iterations");
    expect(governorBuildSrc).toContain("After 2 refinement_required iterations");
    expect(governorBuildSrc).toContain("refinement_loop_exhausted");
    expect(governorBuildSrc).toContain("Do NOT loop further");
    expect(governorBuildSrc).toContain("Re-run rks_plan (this step)");
  });

  it("adds a NEW branch that short-circuits (0 further iterations) on the structural discriminator", () => {
    expect(governorBuildSrc).toContain("short-circuit");
    expect(governorBuildSrc).toContain('failureClass: "structural"');
    expect(governorBuildSrc).toContain("0 further iterations");
    expect(governorBuildSrc).toContain("plan_note_step_degeneracy");
  });
});

// ── INNER BUDGET UNCHANGED ─────────────────────────────────────────────────────

describe("inner retry budget unchanged", () => {
  it("MAX_NOTE_ONLY_RETRIES stays 2 (static-source)", () => {
    expect(plannerSrc).toContain("const MAX_NOTE_ONLY_RETRIES = 2;");
    expect(plannerSrc).not.toContain("MAX_NOTE_ONLY_RETRIES = 3");
    expect(plannerSrc).not.toContain("MAX_NOTE_ONLY_RETRIES = 4");
  });
});

// ── Regression guards ──────────────────────────────────────────────────────────

describe("regression — non-degenerate paths unchanged", () => {
  it("NON-DEGENERATE EDIT STORY: no structural signal when no op:create targets are uncovered", () => {
    // An edit story has no op:create frontmatter targets → nothing to route to structural fail.
    expect(uncoveredCreates(new Set(), [{ action: "search_replace", path: "src/a.mjs" }])).toEqual([]);
    // A healthy edit plan still classifies executable.
    const editPlan = [{ action: "search_replace", path: "src/a.mjs", edits: [{ search: "a", replace: "b" }] }];
    expect(classifyPlanStatus({ steps: editPlan })).toBe("executable");
  });

  it("rag_miss REGRESSION for edit targets: the edit-target directive/warning is unchanged", () => {
    const result = validatePromptReadiness({
      totalSnippetChars: 0,
      hasSnippets: false,
      hasTargetFiles: true,
      frontmatterTargets: ["src/index.js"], // op:edit target, NO uncoveredCreatePaths
      planningText: "Add feature",
      planningSource: "context",
      requirementSummary: "Summary",
      slug: "test",
      projectId: "my-project",
    });
    expect(result.enhancedRequirements).toContain("IMPORTANT:");
    expect(result.enhancedRequirements).toContain("search_replace actions");
    expect(result.enhancedRequirements).not.toContain("CREATE TARGETS"); // carve-out not triggered
    expect(result.warnings).toContain("targetFiles specified but no snippets fetched");
  });

  it("classifyPlanStatus UNCHANGED: note → needs_refinement, empty → note_only", () => {
    expect(classifyPlanStatus({ steps: [{ action: "note", text: "do later" }] })).toBe("needs_refinement");
    expect(classifyPlanStatus({ steps: [] })).toBe("note_only");
  });
});

describe("regression — decomposed-gate early-exit unchanged", () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-degeneracy-test-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("planProblem still returns { ok:false, error:'story_decomposed' } before the note-step path", async () => {
    const noteDir = path.join(tmpDir, "notes");
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, "backlog.feat.degeneracy-decomposed.md"),
      `---\nid: "backlog.feat.degeneracy-decomposed"\nphase: "decomposed"\nchildren:\n  - "backlog.feat.degeneracy-decomposed.child-a"\n---\n\n## Problem\n\nTest.\n`
    );
    const result = await planProblem(tmpDir, "backlog.feat.degeneracy-decomposed");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("story_decomposed");
    expect(result.childStories).toEqual(["backlog.feat.degeneracy-decomposed.child-a"]);
  });
});
