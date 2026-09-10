/**
 * Witness for backlog.fix.reviewer-search-target-attribution.
 *
 * THE DEFECT: `reviewer.mjs` resolved each @@SEARCH block's target from a `File:`/`Target:`
 * line OR the preceding markdown heading, guarded only by `/[/.]/` — "contains a slash or a
 * period". An ordinary numbered heading like `### 2. Wire the ledger row` contains a period,
 * was accepted as a file path, resolved to `file_not_found`, and was counted as a MISSING
 * SEARCH PATTERN. Worse, the unverified value was assigned to `currentFile`, so ONE bad
 * heading poisoned every later unattributed block — which is how a story with four valid
 * patterns failed as "3 of 4 SEARCH patterns not found in current code".
 *
 * A child project hit this on 0.47.0 and 0.48.0 with no way to diagnose it: `rks_plan_ready`
 * said the story was ready, `rks_exhaustive_search` confirmed all four patterns byte-identical
 * to source, and the error named the wrong cause.
 *
 * ANTI-MIRROR RULE (testRequirement 14): every assertion below imports and executes the real
 * production symbols. Nothing here re-implements the guard, the occurrence count or the message
 * template locally — a witness that mirrors production cannot fail when production drifts, which
 * is a defect this project has already been bitten by.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  extractExplicitEdits,
  validateExplicitEdits,
  looksLikePath,
  resolveTargetPath,
  describeEditFailures,
  summariseEditFailures,
  AMBIGUITY_POLICY,
} from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

const PROSE_HEADING = "2. Wire the ledger row";
const ABSENT_PATH = "services/sqliteService.ts";

let root;

function seed(rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const block = (search, replace) =>
  `@@SEARCH\n${search}\n@@REPLACE\n${replace}\n@@END`;

beforeAll(() => {
  root = makeTempDir("reviewer-attribution");
  seed("lib/real.mjs", "export const alpha = 1;\nexport const beta = 2;\n");
  // A file whose pattern occurs exactly TWICE — the ambiguity fixture.
  seed("lib/twice.mjs", "const dup = 1;\nconst other = 0;\nconst dup = 1;\n");
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("the guard narrows, it does not delete heading inference", () => {
  it("REQ 1 — a numbered heading is not adopted as a file path", () => {
    const story = `### ${PROSE_HEADING}\n${block("export const alpha = 1;", "export const alpha = 9;")}`;
    const edits = extractExplicitEdits(story, root, []);
    expect(edits.length).toBe(1);
    expect(edits[0].file).not.toBe(PROSE_HEADING);
  });

  it("REQ 4 — PRESERVATION GUARD: an on-disk heading still resolves", () => {
    // Passes at HEAD by design. Its only job is to red-flag a fix that deletes heading
    // inference wholesale instead of narrowing the guard.
    const story = `### lib/real.mjs\n${block("export const alpha = 1;", "export const alpha = 9;")}`;
    const edits = extractExplicitEdits(story, root, []);
    expect(edits[0].file).toBe("lib/real.mjs");
  });

  it("REQ 5 — CONTRAST: the same absent path resolves when declared, and not when it is not", () => {
    const story = `### ${ABSENT_PATH}\n${block("alpha", "beta")}`;
    const declared = extractExplicitEdits(story, root, [ABSENT_PATH]);
    const undeclared = extractExplicitEdits(story, root, []);
    // Accepting half — would pass at HEAD, so it is only meaningful paired with the next line.
    expect(declared[0]).toBeDefined();
    expect(undeclared[0]).toBeDefined();
    expect(declared[0].file).toBe(ABSENT_PATH);
    // Rejecting half — FAILS AT HEAD.
    expect(undeclared[0].file).not.toBe(ABSENT_PATH);
  });

  it("REQ 6 — the gate stays active when projectRoot is null", () => {
    // Every pre-existing reviewer suite calls with one argument. If the gate were written as
    // "verify only when projectRoot is truthy" it would be inert for all of them, the fix would
    // look green, and the production defect would remain reachable through any such caller.
    const story = `### ${PROSE_HEADING}\n${block("alpha", "beta")}`;
    const edits = extractExplicitEdits(story, null, []);
    expect(edits[0].file).not.toBe(PROSE_HEADING);
  });
});

describe("a rejected candidate does not propagate", () => {
  it("REQ 2 — NON-STICKY: the second, unattributed block is not mis-attributed", () => {
    const story = [
      `### ${PROSE_HEADING}`,
      block("export const alpha = 1;", "export const alpha = 9;"),
      "",
      block("export const beta = 2;", "export const beta = 8;"),
    ].join("\n");
    const edits = extractExplicitEdits(story, root, []);
    expect(edits.length).toBe(2);
    // Asserted on the SECOND edit specifically — this is the propagation that turned one bad
    // heading into "3 of 4 patterns not found".
    expect(edits[1].file).not.toBe(PROSE_HEADING);
    expect(edits.every((e) => e.file !== PROSE_HEADING)).toBe(true);
  });

  it("REQ 3 — a rejection does not clobber an earlier VERIFIED attribution", () => {
    const story = [
      "### lib/real.mjs",
      block("export const alpha = 1;", "export const alpha = 9;"),
      "",
      `### ${PROSE_HEADING}`,
      block("export const beta = 2;", "export const beta = 8;"),
    ].join("\n");
    const edits = extractExplicitEdits(story, root, []);
    expect(edits.length).toBe(2);
    expect(edits[0].file).toBe("lib/real.mjs");
    // The rejected heading must leave the previously verified currentFile intact.
    expect(edits[1].file).toBe("lib/real.mjs");
  });
});

describe("REQ 15 — the File:/Target: arm is gated identically to the heading arm", () => {
  it("(a) ACCEPT on disk", () => {
    const story = `File: lib/real.mjs\n${block("export const alpha = 1;", "export const alpha = 9;")}`;
    expect(extractExplicitEdits(story, root, [])[0].file).toBe("lib/real.mjs");
  });

  it("(b) ACCEPT via the declared target set", () => {
    const story = `File: ${ABSENT_PATH}\n${block("alpha", "beta")}`;
    expect(extractExplicitEdits(story, root, [ABSENT_PATH])[0].file).toBe(ABSENT_PATH);
  });

  it("(c) REJECT a non-path File: value, and it must not become currentFile", () => {
    const story = [
      `File: ${PROSE_HEADING}`,
      block("export const alpha = 1;", "export const alpha = 9;"),
      "",
      block("export const beta = 2;", "export const beta = 8;"),
    ].join("\n");
    const edits = extractExplicitEdits(story, root, []);
    expect(edits.length).toBe(2);
    expect(edits[0].file).not.toBe(PROSE_HEADING);
    expect(edits[1].file).not.toBe(PROSE_HEADING);
  });
});

describe("REQ 13 — a rejected candidate is diagnosable", () => {
  it("records the rejected text rather than reporting it as the file", () => {
    const story = `### ${PROSE_HEADING}\n${block("alpha", "beta")}`;
    const edits = extractExplicitEdits(story, root, []);
    expect(edits[0].rejectedCandidate).toBe(PROSE_HEADING);
    expect(edits[0].file).not.toBe(PROSE_HEADING);
  });
});

describe("REQ 11 / 12 — the reported cause is the observed cause", () => {
  it("an attribution failure is not labelled 'SEARCH patterns not found'", () => {
    const issues = [{ type: "target_unresolved", message: "x" }];
    const msg = describeEditFailures(issues, 1, 1);
    expect(msg).not.toContain("SEARCH patterns not found in current code");
    expect(msg).toContain("attributed");
  });

  it("a mixed run reports each cause separately instead of summing them", () => {
    const issues = [
      { type: "file_not_found" },
      { type: "pattern_not_found" },
      { type: "pattern_ambiguous" },
    ];
    expect(summariseEditFailures(issues)).toEqual({
      file_not_found: 1,
      pattern_not_found: 1,
      pattern_ambiguous: 1,
    });
    const msg = describeEditFailures(issues, 3, 4);
    expect(msg).toContain("target file not found on disk");
    expect(msg).toContain("SEARCH pattern not found in current code");
    expect(msg).toContain("matches more than once");
  });
});

describe("REQ 9 / 10 — the two validators agree on the ambiguity rule", () => {
  it("the reviewer surfaces the reconciled policy on an ambiguous pattern", () => {
    const edits = [{ file: "lib/twice.mjs", search: "const dup = 1;", replace: "const dup = 2;" }];
    const result = validateExplicitEdits(edits, root, ["lib/twice.mjs"]);
    expect(result.valid).toBe(false);
    const check = result.validatedEdits[0].validation.checks.find((c) => c.check === "pattern_unique");
    expect(check.passed).toBe(false);
    expect(check.ambiguityPolicy).toBe(AMBIGUITY_POLICY);
  });

  it("plan-ready consumes the SAME constant rather than its own copy", async () => {
    // Direction-agnostic: this asserts the two validators share one policy value, not which
    // value was chosen. plan-ready.mjs imports AMBIGUITY_POLICY from reviewer.mjs, so a future
    // divergence would have to reintroduce a second literal to break this.
    const planReady = await import("../../packages/mcp-rks/src/server/plan-ready.mjs");
    // Reads a value OUT of plan-ready and compares it to the reviewer's. The previous form
    // asserted only that the module loaded, which would have passed even if plan-ready had
    // kept its own separate policy — a guard that cannot fail is not a guard.
    expect(planReady.AMBIGUITY_POLICY).toBe(AMBIGUITY_POLICY);
  });

  // NOT COVERED HERE, stated rather than faked: verdict equality across a full
  // runPlanReadyTool() vs runReviewerMode() run needs an on-disk story note and a project
  // fixture. Asserting it against a stub would assert the stub. Tracked as an integration gap.
});

describe("the resolution primitives are exported and behave", () => {
  it("looksLikePath separates prose from paths on whitespace", () => {
    expect(looksLikePath("services/sqliteService.ts")).toBe(true);
    expect(looksLikePath("index.ts")).toBe(true);
    expect(looksLikePath(PROSE_HEADING)).toBe(false);
    expect(looksLikePath("Wire the ledger row")).toBe(false);
  });

  it("resolveTargetPath requires shape AND either disk or declaration", () => {
    expect(resolveTargetPath("lib/real.mjs", root, [])).toBe("lib/real.mjs");
    expect(resolveTargetPath(ABSENT_PATH, root, [ABSENT_PATH])).toBe(ABSENT_PATH);
    expect(resolveTargetPath(ABSENT_PATH, root, [])).toBe(null);
    expect(resolveTargetPath(PROSE_HEADING, root, [PROSE_HEADING])).toBe(null);
  });
});
