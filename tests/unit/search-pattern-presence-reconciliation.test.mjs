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
import { extractSearchPatterns } from "../../packages/mcp-rks/src/server/plan-ready.mjs";
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
      /^\s*function\s+countOccurrences\s*\(/m.test(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")),
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
