/**
 * Witness for backlog.fix.search-pattern-presence-not-reconciled-across-validators.
 *
 * THE DEFECT (Divergence 3, settled at ARCH round 2). `rks_plan_ready` never bound a SEARCH
 * pattern to a file. Its nested loops with `foundInAnyTarget` + `break` asked "is this pattern
 * present in ANY declared target?", while the planner reviewer's validateExplicitEdits reads
 * path.join(projectRoot, targetFile) and asks "is it present in THE file this edit names?".
 * A pattern declared against file A but present only in file B therefore PASSED the readiness
 * gate and was then rejected as pattern_not_found — `ready: true` / "N patterns validated"
 * followed by "M of N explicit edits failed validation", with byte-identical extraction and
 * identical exact-bytes matching on both sides. A child project hit this on four rks versions
 * and could not diagnose it: every anchor verified byte-identical to source, and plan_ready
 * said ready both before and after.
 *
 * REFUTED, recorded so it is not re-derived: there was never a tolerance asymmetry.
 * patternExistsInFile returns `found: true` ONLY on the exact tier; its normalised branch
 * returns `found: false` and is a diagnostic.
 *
 * ANTI-MIRROR RULE: every assertion imports and executes real production symbols. Nothing here
 * re-implements the matcher, the extractor or the message template.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  extractExplicitEdits,
  validateExplicitEdits,
  countOccurrences,
  AMBIGUITY_POLICY,
} from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import {
  countPatternOccurrences,
  patternPresenceInContent,
  patternExistsInFile,
  normalizeWhitespace,
} from "../../packages/mcp-rks/src/validation/search-replace.mjs";
import { extractSearchPatterns, runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

// R1: a countOccurrences declaration in ANY form is a second presence matcher unless its whole
// body is a delegation to the shared counter. The previous guard matched only a bare
// `function countOccurrences(` at line start, so an `export function` with its own body passed.
const COUNTER_DECL = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+countOccurrences\s*\([^)]*\)\s*\{([\s\S]*?)^\}/m;
const COUNTER_BINDING = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+countOccurrences\s*=/m;
const DELEGATING_BODY = /^\s*return\s+countPatternOccurrences\([^)]*\);\s*$/;
function declaresIndependentCounter(src) {
  if (COUNTER_BINDING.test(src)) return true;
  const decl = COUNTER_DECL.exec(src);
  return decl !== null && !DELEGATING_BODY.test(decl[1]);
}
import { makeTempDir } from "../helpers/tmp.mjs";

const REPO_ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".."));

// The discriminating shape: one pattern, declared against FILE_A, present only in FILE_B.
const FILE_A = "src/alpha.mjs";
const FILE_B = "src/beta.mjs";
const SHARED_PATTERN = "export function ledgerRow(entry) {";

let root;

function seed(rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

beforeAll(() => {
  root = makeTempDir("search_presence_reconciliation");
  // FILE_A does NOT contain the pattern. FILE_B does. Both exist and are declared.
  seed(FILE_A, "export function alphaOnly() {\n  return 1;\n}\n");
  seed(FILE_B, `${SHARED_PATTERN}\n  return entry;\n}\n`);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const storyDeclaringAgainstA = `
## Edit ${FILE_A}

SEARCH:
\`\`\`javascript
${SHARED_PATTERN}
\`\`\`
REPLACE:
\`\`\`javascript
export function ledgerRow(entry, meta) {
\`\`\`
`;

describe("presence is ONE derivation, reached from both call sites", () => {
  it("the reviewer's counter and the shared counter agree on every case", () => {
    const cases = [
      ["abc", "b", 1],
      ["aaa", "a", 3],
      ["abc", "z", 0],
      ["", "a", 0],
      ["a", "", 0],
      ["line\n  indented", "  indented", 1],
      ["            x\n                x\n", "            x", 1],
      ["                x\n            x\n                x\n", "                x", 2],
      ["const v = compute(a, b);\n", "compute(a, b)", 1],
      ["computeTotal(order);\nconst total = computeTotal(order);\n", "computeTotal(order);", 2],
      ["a\n            x\n                x\nb\n", "            x\n", 1],
      ["a\n            x\nb\n            x\n", "            x\n", 2],
      [".a {\n  color: red;\n}\n.b {\n  color: red;\n}\n.c {\n  color: red;\n}\n", "  color: red;\n", 3],
      ["aaa\n", "aa", 2],
    ];
    const mismatches = cases.filter(
      ([content, pattern]) => countOccurrences(content, pattern) !== countPatternOccurrences(content, pattern),
    );
    expect(mismatches).toEqual([]);
    const wrong = cases.filter(([content, pattern, want]) => countPatternOccurrences(content, pattern) !== want);
    expect(wrong).toEqual([]);
  });

  it("neither validator declares its own private presence counter any more", () => {
    // SCOPE FENCE (ARCH ruling Q1): scoped to these TWO files only. plan-quality.mjs keeps its
    // own countOccurrences and is deliberately out of scope — a repo-wide assertion would red
    // on untouched code and is tracked as a separate follow-up.
    const fenced = [
      "packages/mcp-rks/src/llm/reviewer.mjs",
      "packages/mcp-rks/src/server/plan-ready.mjs",
    ];
    const offenders = fenced.filter((rel) =>
      declaresIndependentCounter(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")),
    );
    expect(offenders).toEqual([]);
    // Positive control: the fence is non-vacuous — the files were actually read and are non-empty.
    const empties = fenced.filter((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").length === 0);
    expect(empties).toEqual([]);
  });

  it("AMBIGUITY_POLICY is still the single shared ambiguity rule", async () => {
    const planReady = await import("../../packages/mcp-rks/src/server/plan-ready.mjs");
    expect(planReady.AMBIGUITY_POLICY).toBe(AMBIGUITY_POLICY);
  });
});

describe("DISCRIMINATOR 1b — file binding, the primary witness", () => {
  it("a pattern declared against A but present only in B is REJECTED by the reviewer", () => {
    const edits = extractExplicitEdits(storyDeclaringAgainstA, root, [FILE_A, FILE_B]);
    expect(edits.length).toBeGreaterThan(0);
    const attributed = edits.filter((e) => e.file === FILE_A && e.search);
    expect(attributed.length).toBe(1);

    const result = validateExplicitEdits(edits, root);
    const notFound = result.issues.filter((i) => i.type === "pattern_not_found" && i.file === FILE_A);
    expect(notFound.length).toBe(1);
  });

  it("the SAME input now fails the readiness presence check too — the gates agree", () => {
    // This is the reconciliation. Pre-fix, plan_ready asked "present in ANY target?" and the
    // pattern IS present in FILE_B, so this returned found and the story passed. The check now
    // runs against the file the edit NAMES, using the one shared matcher.
    const edits = extractExplicitEdits(storyDeclaringAgainstA, root, [FILE_A, FILE_B]);
    const edit = edits.find((e) => e.file === FILE_A && e.search);
    const namedFile = fs.readFileSync(path.join(root, edit.file), "utf8");
    expect(patternPresenceInContent(namedFile, edit.search).found).toBe(false);

    // And the story-scoped question still answers "yes" — which is exactly why the two gates
    // disagreed. Asserting this pins the DEFECT's shape, not just the fix.
    expect(patternExistsInFile(root, FILE_B, edit.search).found).toBe(true);
  });

  it("a pattern genuinely absent everywhere is rejected by BOTH paths", () => {
    const absent = "export function neverWrittenAnywhere() {";
    const perFile = [FILE_A, FILE_B].filter((f) => patternExistsInFile(root, f, absent).found);
    expect(perFile).toEqual([]);
    expect(patternPresenceInContent(fs.readFileSync(path.join(root, FILE_A), "utf8"), absent).found).toBe(false);
  });
});

describe("TIER ATTRIBUTION — a failure names what each tier observed", () => {
  it("reports the exact tier's observation and the normalized tier's", () => {
    const content = fs.readFileSync(path.join(root, FILE_B), "utf8");
    const hit = patternPresenceInContent(content, SHARED_PATTERN);
    expect(hit.found).toBe(true);
    expect(hit.tiers.map((t) => t.tier)).toEqual(["exact"]);
    expect(hit.tiers[0].observed).toBe(1);
  });

  it("a whitespace-only difference is reported as a whitespace mismatch, not a bare absence", () => {
    const content = fs.readFileSync(path.join(root, FILE_B), "utf8");
    const spaced = SHARED_PATTERN.replace("function ledgerRow", "function    ledgerRow");
    const miss = patternPresenceInContent(content, spaced);
    // Exact-only on the VERDICT — step-apply.mjs applies with a bare indexOf, so a normalised
    // match is a promise the applier cannot keep.
    expect(miss.found).toBe(false);
    expect(miss.whitespaceMismatch).toBe(true);
    expect(miss.tiers.map((t) => t.tier)).toEqual(["exact", "normalized"]);
    // Same verdict from the other path — reconciled, not merely similar.
    expect(patternExistsInFile(root, FILE_B, spaced).found).toBe(false);
    expect(normalizeWhitespace(spaced)).toBe(normalizeWhitespace(SHARED_PATTERN));
  });
});

describe("REPORTED COUNT EQUALS COUNT ACTUALLY SUBMITTED", () => {
  it("the readiness summary no longer renders the extraction-array length", () => {
    // `searchPatterns.length` counts what was EXTRACTED. Patterns skipped before the matcher —
    // empty CREATE-FILE blocks, or a pattern whose every target is absent — were never
    // submitted, yet were reported as "patterns validated": a number naming something it did
    // not observe. Behavioural pin below; this is the structural half.
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/plan-ready.mjs"), "utf8");
    expect(src).toContain("${submittedPatterns} patterns validated");
    expect(src).not.toContain("${searchPatterns.length} patterns validated");
  });

  it("extraction counts empty CREATE-FILE blocks out, so the two numbers can differ", () => {
    const mixed = [
      "// CREATE FILE: src/new.mjs",
      "",
      "@@SEARCH",
      SHARED_PATTERN,
      "@@REPLACE",
      "export function ledgerRow(entry, meta) {",
      "@@END",
      "",
    ].join("\n");
    const patterns = extractSearchPatterns(mixed);
    // The CREATE-FILE directive contributes no pattern; only the real block does.
    expect(patterns).toEqual([SHARED_PATTERN]);
  });
});

describe("R1 — the counter guard is non-vacuous and catches every declaration form", () => {
  it("finds the reviewer's delegating declaration and accepts it", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/llm/reviewer.mjs"), "utf8");
    expect(COUNTER_DECL.test(src)).toBe(true);
    expect(declaresIndependentCounter(src)).toBe(false);
  });

  it("flags an exported independent body, a plain one and an arrow binding", () => {
    const fixtures = {
      exported: "export function countOccurrences(c, s) {\n  let n = 0;\n  let i = c.indexOf(s);\n  while (i !== -1) { n++; i = c.indexOf(s, i + 1); }\n  return n;\n}\n",
      plain: "function countOccurrences(c, s) {\n  return c.split(s).length - 1;\n}\n",
      async: "async function countOccurrences(c, s) {\n  return c.split(s).length - 1;\n}\n",
      arrow: "export const countOccurrences = (c, s) => c.split(s).length - 1;\n",
    };
    const missed = Object.entries(fixtures)
      .filter(([, src]) => !declaresIndependentCounter(src))
      .map(([name]) => name);
    expect(missed).toEqual([]);
  });
});

describe("R2 — runPlanReadyTool end to end: the readiness gate refuses what the reviewer refuses", () => {
  // Each case seeds its OWN temp project, with the note shape the existing runPlanReadyTool suites
  // use (tests/unit/identity-hunk-not-change-spec.test.mjs makeStory/build: notes/<id>.md, phase
  // arch-approved, testExempt true). No git init and no mocks: that suite calls runPlanReadyTool
  // on a bare temp dir the same way. Each case collects its observations into one record and
  // asserts once.
  const STORY = "backlog.fix.r2-presence-probe";
  const FILE_C = "src/gamma.mjs"; // op: create, never written to disk

  function r2Project(targets, body) {
    const dir = makeTempDir("search_presence_r2");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, FILE_A), "export function alphaOnly() {\n  return 1;\n}\n", "utf8");
    fs.writeFileSync(path.join(dir, FILE_B), `${SHARED_PATTERN}\n  return entry;\n}\n`, "utf8");
    const fm = targets.map(([p, op]) => `  - path: "${p}"\n    op: "${op}"`).join("\n");
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "notes", `${STORY}.md`),
      `---\nid: "${STORY}"\nphase: "arch-approved"\ntestExempt: true\ntargetFiles:\n${fm}\n---\n\n## Problem\n\nProbe.\n${body}`,
      "utf8",
    );
    return dir;
  }
  const namedFileIssueFiles = (res) =>
    (res.issues || []).filter((i) => i.check === "pattern_exists_in_named_file").map((i) => i.file);
  const reviewerNotFoundFiles = (body, dir, declared) =>
    validateExplicitEdits(extractExplicitEdits(body, dir, declared), dir)
      .issues.filter((i) => i.type === "pattern_not_found")
      .map((i) => i.file);
  const boundFiles = (body, dir, declared) =>
    extractExplicitEdits(body, dir, declared).filter((e) => e.search).map((e) => e.file);

  it("Divergence 3 shape is refused by runPlanReadyTool and by the reviewer, naming src/alpha.mjs", async () => {
    const dir = r2Project([[FILE_A, "edit"], [FILE_B, "edit"]], storyDeclaringAgainstA);
    try {
      const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
      expect({
        ready: res.ready,
        named: namedFileIssueFiles(res),
        reviewer: reviewerNotFoundFiles(storyDeclaringAgainstA, dir, [FILE_A, FILE_B]),
      }).toEqual({ ready: false, named: [FILE_A], reviewer: [FILE_A] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("control: the same block attributed to src/beta.mjs passes both gates", async () => {
    // ready is deliberately NOT asserted here: FILE_A stays a declared edit target with no block,
    // which other readiness checks may report. The control is about the two presence gates only.
    const controlBody = storyDeclaringAgainstA.replace(`## Edit ${FILE_A}`, `## Edit ${FILE_B}`);
    const dir = r2Project([[FILE_A, "edit"], [FILE_B, "edit"]], controlBody);
    try {
      const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
      expect({
        bound: boundFiles(controlBody, dir, [FILE_A, FILE_B]),
        named: namedFileIssueFiles(res),
        reviewer: reviewerNotFoundFiles(controlBody, dir, [FILE_A, FILE_B]),
      }).toEqual({ bound: [FILE_B], named: [], reviewer: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("create case: an op create target absent from disk is named by no pattern_exists_in_named_file issue", async () => {
    // The FILE_A block is kept so the same response proves the attributed check RAN (it names
    // FILE_A); the FILE_C block is bound by the extractor, so its absence from `named` is the
    // existsSync skip and not an unbound block.
    const createBody = `${storyDeclaringAgainstA}\n## Edit ${FILE_C}\n\nSEARCH:\n\`\`\`javascript\n${SHARED_PATTERN}\n\`\`\`\nREPLACE:\n\`\`\`javascript\nexport function ledgerRow(entry, meta) {\n\`\`\`\n`;
    const dir = r2Project([[FILE_A, "edit"], [FILE_B, "edit"], [FILE_C, "create"]], createBody);
    try {
      const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
      expect({
        absentOnDisk: !fs.existsSync(path.join(dir, FILE_C)),
        bound: boundFiles(createBody, dir, [FILE_A, FILE_B, FILE_C]),
        named: namedFileIssueFiles(res),
      }).toEqual({ absentOnDisk: true, bound: [FILE_A, FILE_C], named: [FILE_A] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R3 — whitespace variants get the same verdict from both gates", () => {
  it("reviewer and readiness agree on found and on whitespaceMismatch for every case", () => {
    const content = fs.readFileSync(path.join(root, FILE_B), "utf8");
    const [template] = extractExplicitEdits(storyDeclaringAgainstA, root, [FILE_A, FILE_B]);
    const cases = {
      exact: SHARED_PATTERN,
      leadingWhitespace: `    ${SHARED_PATTERN}`,
      trailingWhitespace: `${SHARED_PATTERN}   `,
      crlf: `${SHARED_PATTERN}\r\n  return entry;`,
      absent: "export function neverWrittenAnywhere() {",
    };
    const disagreements = [];
    for (const [name, search] of Object.entries(cases)) {
      const reviewed = validateExplicitEdits([{ ...template, file: FILE_B, search }], root);
      const issue = reviewed.issues.find((i) => i.type === "pattern_not_found" && i.file === FILE_B);
      const presence = patternPresenceInContent(content, search);
      const reviewerFound = issue === undefined;
      const reviewerMismatch = issue?.whitespaceMismatch === true;
      const readyMismatch = presence.whitespaceMismatch === true;
      if (reviewerFound !== presence.found || reviewerMismatch !== readyMismatch) {
        disagreements.push({ name, reviewerFound, readyFound: presence.found, reviewerMismatch, readyMismatch });
      }
    }
    expect(disagreements).toEqual([]);
    // Non-vacuity: the table exercises both outcomes and the whitespace diagnostic.
    const verdicts = Object.values(cases).map((search) => patternPresenceInContent(content, search));
    expect(verdicts.map((v) => v.found)).toEqual([true, false, false, false, false]);
    expect(verdicts.map((v) => v.whitespaceMismatch === true)).toEqual([false, true, true, true, false]);
  });
});

describe("R4 — the stale cross-module comment is restated", () => {
  it("no longer claims an unenforced MUST-match with plan-quality.mjs", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/validation/search-replace.mjs"), "utf8");
    expect(src).not.toContain("MUST match the logic in plan-quality.mjs");
    expect(src).toContain("plan-quality.mjs carries its OWN copy of this normalizer");
  });
});

describe("PROHIBITED FIX — create targets still reach ready", () => {
  it("the attributed check skips a declared target that does not exist on disk", () => {
    // op: create targets are deliberately WARNED (file_will_be_created), never failed.
    // Raising an issue for them here would red the readiness gate for every story that
    // creates a file. The guard is the existsSync skip in the attributed loop.
    const missing = path.join(root, "src/not-created-yet.mjs");
    expect(fs.existsSync(missing)).toBe(false);
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/plan-ready.mjs"), "utf8");
    expect(src).toContain("if (!fs.existsSync(attributedPath)) continue;");
  });

  it("the reviewer likewise passes a create target rather than failing it", () => {
    const createStory = `
## Edit src/not-created-yet.mjs

SEARCH:
\`\`\`javascript
${SHARED_PATTERN}
\`\`\`
REPLACE:
\`\`\`javascript
export function ledgerRow(entry, meta) {
\`\`\`
`;
    const edits = extractExplicitEdits(createStory, root, ["src/not-created-yet.mjs"]);
    const withAction = edits.map((e) => ({ ...e, action: "create" }));
    const result = validateExplicitEdits(withAction, root);
    const notFound = result.issues.filter((i) => i.type === "pattern_not_found");
    expect(notFound).toEqual([]);
  });
});
