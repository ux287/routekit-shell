/**
 * Witness for backlog.fix.planner-note-step-false-rejection.
 *
 * THE BUG (clean-machine UAT, 2026-07-12, rks 0.26.0 — and 0.25.0 before it):
 *
 * `rks_plan` returned failureClass:"output_invalid", reason:"has_note_steps" for plans that were
 * PERFECTLY VALID. Three consecutive attempts on the same story each produced an excellent 7-step
 * plan — five create_file steps with complete file bodies, a correct search_replace, and a trailing
 * `npm run test` run_command — and all three were thrown away.
 *
 * The LLM was blameless. The planner did it to itself:
 *
 *   1. planner.mjs carried a legacy "About page automation" that fired on /about page/i against the
 *      story PROSE and pushed a hardcoded web-agency About.tsx ("About Our Studio", HeroSection,
 *      CTASection) into `automatedSteps` — with NO `title` key.
 *   2. automatedSteps are merged AHEAD of llmActions, so it rode along on a plan the LLM had
 *      authored perfectly.
 *   3. src/pages/About.tsx was not among the story's targets, so the allowed-targets gate in
 *      validateStep downgraded it to `{action:"note", title: undefined}` — and that return omitted
 *      the `path` key entirely.
 *   4. `hasNoteSteps` then discarded the ENTIRE plan. One junk step killed six good ones.
 *   5. Every diagnostic renders `path || title`. With neither, the retry prompt read literally:
 *          "The following steps were converted to non-executable notes: ."
 *      The planner scolded the model for steps it never wrote, and named none of them — so no
 *      retry could ever converge. Three attempts, ~197s, dead.
 *
 * It also explains what looked like model non-determinism: two structurally identical stories, one
 * planned clean and one died. The only difference was whether the story's prose happened to contain
 * the words "about page". One did. One didn't.
 *
 * THE FIX, pinned here:
 *   A. The About injection is DELETED (root cause).
 *   B. An out-of-target step is REJECTED and NAMED — never disguised as an anonymous note.
 *   C. Notes are STRIPPED from the persisted plan rather than being fatal. (exec.mjs throws a hard,
 *      unrefinable McpError on any note in plan.json, so merely "tolerating" a note would have been
 *      WORSE than the bug — the plan would pass the planner and die at exec.)
 *   D. hasTargetCoverageGap is the real safety net and is retained in BOTH guards: a note that
 *      leaves a target unwritten still fails, so stripping cannot silently skip a required file.
 *
 * ANTI-MIRROR: every assertion below drives the REAL exported code path (classifySteps /
 * validateStep from server/planner.mjs). Nothing here re-implements the rule locally. This repo has
 * repeatedly shipped tests that hand-copied the logic they claimed to witness and stayed green
 * while the real rule broke — that is how this bug survived two releases.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateStep, classifySteps } from "../../packages/mcp-rks/src/server/planner.mjs";

// The allowed-targets gate is OPT-IN: planner.mjs passes `null` unless editableTargetPaths is
// non-empty, and validateStep then short-circuits `allowedMatch` to true. A witness that does not
// populate resolvedTargets GREENS VACUOUSLY against unfixed code — it would never reach the branch
// that manufactured the note. So every test here supplies real targets.
const TARGETS = {
  allowFiles: ["src/App.tsx"],
  allowPatterns: [
    "src/lib/calc.ts",
    "src/pages/Calculator.tsx",
    "src/lib/calc.test.ts",
    "src/pages/Calculator.test.tsx",
    "src/App.test.tsx",
  ],
};

// validateStep rejects a search_replace whose target does not exist on disk, so the fixture needs a
// real project root with a real src/App.tsx — otherwise that step vanishes for the wrong reason and
// the test proves nothing.
let projectRoot;

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-note-witness-"));
  fs.mkdirSync(path.join(projectRoot, "src", "pages"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src", "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "src", "App.tsx"),
    'export function App() {\n  return <main />;\n}\n',
    "utf8",
  );
});

afterAll(() => {
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

const code = (body) => body;

/** The EXACT plan the model produced in production, three times, that the planner threw away. */
function productionPlan() {
  return [
    { title: "Create src/lib/calc.ts", action: "create_file", path: "src/lib/calc.ts",
      content: code("export type CalcResult = { ok: true; value: number } | { ok: false; error: string };\nexport function divide(a: number, b: number): CalcResult {\n  if (b === 0) return { ok: false, error: 'Cannot divide by zero' };\n  return { ok: true, value: a / b };\n}\n") },
    { title: "Create src/pages/Calculator.tsx", action: "create_file", path: "src/pages/Calculator.tsx",
      content: code("import { useState } from 'react';\nexport function Calculator() {\n  const [display, setDisplay] = useState('0');\n  return <div>{display}</div>;\n}\n") },
    { title: "Register /calculator route", action: "search_replace", path: "src/App.tsx", content: null,
      edits: [{ search: "export function App() {", replace: "export function App() {\n  // calculator route" }] },
    { title: "Create src/lib/calc.test.ts", action: "create_file", path: "src/lib/calc.test.ts",
      content: code("import { it, expect } from 'vitest';\nimport { divide } from './calc';\nit('guards divide by zero', () => { expect(divide(1, 0).ok).toBe(false); });\n") },
    { title: "Create src/pages/Calculator.test.tsx", action: "create_file", path: "src/pages/Calculator.test.tsx",
      content: code("import { it, expect } from 'vitest';\nit('renders', () => { expect(true).toBe(true); });\n") },
    { title: "Create src/App.test.tsx", action: "create_file", path: "src/App.test.tsx",
      content: code("import { it, expect } from 'vitest';\nit('routes', () => { expect(true).toBe(true); });\n") },
    // The trailing step. path:null and content:null are CORRECT for a shell command — a command has
    // no file body. Every step above has a title; this one does too. It is a legitimate step.
    { title: "Run tests to verify all new functionality", action: "run_command", path: null,
      content: null, edits: null, command: "npm run test" },
  ];
}

/** The foreign step the planner used to inject into any story whose prose said "about page". */
const INJECTED_ABOUT_STEP = {
  action: "create_file",
  path: "src/pages/About.tsx",
  content: "export default function About() {\n  return <main>About Our Studio</main>;\n}\n",
  // NOTE: no `title` — this is verbatim the shape planner.mjs used to push.
};

// ── A. The headline: the production plan survives ────────────────────────────────

describe("the exact plan that died in production now survives", () => {
  it("all 7 steps stay executable — nothing is downgraded to a note", () => {
    const r = classifySteps({ rawSteps: productionPlan(), allowedTargets: TARGETS, projectRoot });

    expect(r.noteSteps).toHaveLength(0);
    expect(r.executable).toHaveLength(7);
    expect(r.hasExecutableSteps).toBe(true);
    expect(r.executable.map((s) => s.action)).toEqual([
      "create_file", "create_file", "search_replace", "create_file", "create_file", "create_file", "run_command",
    ]);
  });

  it("a run_command with path:null survives — it is NOT out-of-target", () => {
    // THE REGRESSION THAT MATTERS. A shell command has no path by nature. Any gate that treats a
    // null path as "not in the editable targets" will destroy it, and with it the whole plan.
    const step = { title: "Run tests", action: "run_command", path: null, content: null, command: "npm run test" };
    const out = validateStep(step, TARGETS, projectRoot);
    expect(out.action).toBe("run_command");
    expect(out._invalid).toBeFalsy();
  });

  it("a search_replace with content:null and populated edits[] survives", () => {
    const step = {
      title: "Route", action: "search_replace", path: "src/App.tsx", content: null,
      edits: [{ search: "export function App() {", replace: "export function App() { //" }],
    };
    const out = validateStep(step, TARGETS, projectRoot);
    expect(out.action).toBe("search_replace");
    expect(out._invalid).toBeFalsy();
  });
});

// ── B. Root cause: the injected step can no longer poison a plan ─────────────────

describe("an out-of-target step is rejected and NAMED, never an anonymous note", () => {
  it("the injected About step is rejected with a reason — and does not take the plan down with it", () => {
    const r = classifySteps({
      rawSteps: [INJECTED_ABOUT_STEP, ...productionPlan()],
      allowedTargets: TARGETS,
      projectRoot,
    });

    // The 7 real steps are untouched...
    expect(r.executable).toHaveLength(7);
    expect(r.hasExecutableSteps).toBe(true);
    // ...the intruder became a note that kills everything? No. It is rejected.
    expect(r.noteSteps).toHaveLength(0);

    const rejected = r.rejectionReasons.find((x) => x.path === "src/pages/About.tsx");
    expect(rejected).toBeTruthy();
    expect(rejected.reason).toMatch(/not in editable targets/i);
  });

  it("a rejected step is ALWAYS nameable — this is the empty-string bug", () => {
    // The step arrives with NO title (the injection had none) and gets rejected for a path that is
    // not in targets. Before the fix, validateStep returned {action:"note", title: undefined} and
    // OMITTED `path` — so `path || title` rendered "" and the retry prompt named nothing.
    const out = validateStep(INJECTED_ABOUT_STEP, TARGETS, projectRoot);

    expect(out._invalid).toBe(true);
    expect(out._invalidReason).toMatch(/not in editable targets/i);
    // The identity survives rejection. Both of these are the actual regression pins:
    expect(out.path).toBe("src/pages/About.tsx");
    expect(out.title).toBeTruthy();
    expect(String(out.path || out.title)).not.toBe("");
  });

  it("NO step reaching the guards may have BOTH a falsy path and a falsy title", () => {
    // The invariant that makes the failure debuggable. A step nobody can name is a step nobody can
    // fix — and the planner will happily tell the LLM to fix it anyway.
    const r = classifySteps({
      rawSteps: [INJECTED_ABOUT_STEP, ...productionPlan()],
      allowedTargets: TARGETS,
      projectRoot,
    });
    for (const s of [...r.steps, ...r.noteSteps]) {
      expect(Boolean(s.path || s.title)).toBe(true);
    }
    for (const rr of r.rejectionReasons) {
      expect(rr.label).toBeTruthy();
      expect(rr.label).not.toBe("");
      expect(rr.reason).toBeTruthy();
    }
  });
});

// ── C. Semantics: notes are stripped, not fatal — but coverage still bites ───────

describe("a note alongside executable steps is stripped, not fatal", () => {
  it("keeps the executables and strips the note", () => {
    const r = classifySteps({
      rawSteps: [
        ...productionPlan(),
        { action: "note", title: "Consider adding keyboard support", description: "Follow-up." },
      ],
      allowedTargets: TARGETS,
      projectRoot,
    });

    expect(r.hasExecutableSteps).toBe(true);
    expect(r.executable).toHaveLength(7);
    // The note is visible for diagnostics...
    expect(r.noteSteps).toHaveLength(1);
    expect(r.steps).toHaveLength(8);
    // ...but `executable` is what may be persisted, and exec.mjs throws a hard McpError on ANY note
    // it finds in plan.json. So the note must not be in there.
    expect(r.executable.every((s) => s.action !== "note")).toBe(true);
  });

  it("NEGATIVE CONTROL: a note-ONLY plan still has no executable steps", () => {
    // The guard's real purpose. If the fix made a note-only plan look fine, we would ship a plan
    // that writes nothing and call it success.
    const r = classifySteps({
      rawSteps: [
        { action: "note", title: "I could not do this", description: "why" },
        { action: "note", title: "Consider refining", description: "how" },
      ],
      allowedTargets: TARGETS,
      projectRoot,
    });
    expect(r.hasExecutableSteps).toBe(false);
    expect(r.executable).toHaveLength(0);
  });

  it("a placeholder-bodied create_file is still downgraded — and leaves its target UNCOVERED", () => {
    // This is why stripping is safe. A stub body becomes a note and is stripped; if we stopped
    // there, the required file would silently never be written. It survives only because the
    // stripped step leaves its target with no executable step, which hasTargetCoverageGap catches.
    const r = classifySteps({
      rawSteps: [{ title: "calc", action: "create_file", path: "src/lib/calc.ts", content: "// TODO: implement" }],
      allowedTargets: TARGETS,
      projectRoot,
    });
    expect(r.noteSteps).toHaveLength(1);
    expect(r.hasExecutableSteps).toBe(false);
    // src/lib/calc.ts now has NO executable step -> uncovered -> the coverage guard fails the plan.
    expect(r.executable.some((s) => s.path === "src/lib/calc.ts")).toBe(false);
  });
});

// ── D. The gate is opt-in — prove the witness is not vacuous ─────────────────────

describe("the witness is not vacuous", () => {
  it("with NO allowedTargets, the gate short-circuits and even a foreign step passes", () => {
    // Documents the trap: a test that forgets to populate targets exercises nothing. If this ever
    // starts failing, the opt-in behavior changed and the tests above may have silently stopped
    // testing the gate.
    const out = validateStep(INJECTED_ABOUT_STEP, null, projectRoot);
    expect(out._invalid).toBeFalsy();
    expect(out.action).toBe("create_file");
  });

  it("with allowedTargets populated, the SAME step is rejected — so the gate is live", () => {
    const out = validateStep(INJECTED_ABOUT_STEP, TARGETS, projectRoot);
    expect(out._invalid).toBe(true);
  });
});
