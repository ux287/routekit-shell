/**
 * backlog.fix.identity-hunk-passes-as-change-spec.
 *
 * An identity hunk — SEARCH side byte-equal to REPLACE side — is a LEGAL construct.
 * governor-po.md sanctions it as a pure location anchor and refine's
 * add_search_pattern emits one mechanically. It is not an error; it simply specifies
 * no change, so it must not be COUNTED as one.
 *
 * Two consumers counted it. The severe one is the planner: an identity hunk satisfied
 * coverage of an op:edit target, so the early-exit fired, the LLM was bypassed, and the
 * resulting no-op plan was classified executable — the exact opposite of the anchor's
 * stated purpose. The other is plan-readiness, which reported nothing at all.
 *
 * The asymmetry below is load-bearing and must not be collapsed into one rule:
 * the PLANNER BLOCKS an anchors-only target (routing it to the LLM), while PLAN-READY
 * only WARNS. Blocking in plan-readiness would wedge the refine recovery loop that
 * injects identity anchors deliberately.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isIdentityHunk } from "../../packages/mcp-rks/src/validation/search-replace.mjs";
import { extractExplicitEdits } from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import { computeEarlyExitCoverage } from "../../packages/mcp-rks/src/server/planner.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const SEARCH_REPLACE_SRC = path.join(ROOT, "packages/mcp-rks/src/validation/search-replace.mjs");
const PLANNER_SRC = path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs");

// ─── The predicate ───────────────────────────────────────────────────────────

describe("isIdentityHunk", () => {
  it("is true for byte-identical sides", () => {
    expect(isIdentityHunk("const a = 1;", "const a = 1;")).toBe(true);
  });

  it("is true when sides differ only by trailing spaces or tabs, including an interior line", () => {
    expect(isIdentityHunk("a  \nb", "a\nb")).toBe(true);
    expect(isIdentityHunk("a\t\nb\t", "a\nb")).toBe(true);
  });

  it("is true when sides differ only by trailing newlines", () => {
    expect(isIdentityHunk("a\nb\n\n", "a\nb")).toBe(true);
  });

  it("is FALSE for a comment-only difference — it lands real bytes", () => {
    // Classifying this as identity would need a tokenizer. Out of scope, and the
    // fail-safe direction is to treat it as a real change.
    expect(isIdentityHunk("const a = 1;", "const a = 1; // why")).toBe(false);
  });

  it("is FALSE when sides differ by leading indentation", () => {
    expect(isIdentityHunk("  a", "a")).toBe(false);
  });

  it("is FALSE when a line is added or removed", () => {
    expect(isIdentityHunk("a\nb", "a\nb\nc")).toBe(false);
    expect(isIdentityHunk("a\nb\nc", "a\nb")).toBe(false);
  });

  it("is FALSE when either argument is not a string", () => {
    expect(isIdentityHunk(null, "a")).toBe(false);
    expect(isIdentityHunk("a", undefined)).toBe(false);
    expect(isIdentityHunk(42, "42")).toBe(false);
  });
});

// ─── The divergence from the reviewer guard, pinned in both directions ───────

/** Build a canonical block the reviewer's regex at reviewer.mjs:238 will parse. */
const block = (search, replace) =>
  `### src/x.mjs\n\n@@SEARCH\n${search}\n@@REPLACE\n${replace}\n@@END\n`;

describe("isIdentityHunk vs the reviewer guard — INCOMPARABLE, not a widening", () => {
  it("WIDER here: interior trailing whitespace is identity here, a real edit to the reviewer", () => {
    // reviewer.mjs:247 uses trimEnd(), which strips only the end of the WHOLE string;
    // the normalizer carries /gm, so $ matches EVERY line end.
    expect(isIdentityHunk("a  \nb", "a\nb")).toBe(true);

    const edits = extractExplicitEdits(block("a  \nb", "a\nb"));
    expect(edits, "the reviewer still emits this pair as a real edit").toHaveLength(1);

    // Deliberate and NOT resolved by this story. Repointing reviewer.mjs at
    // isIdentityHunk is a BEHAVIOUR CHANGE, not a refactor — see follow-up 1.
  });

  it("NARROWER here, and only at the TRAILING position: (a) the predicate", () => {
    expect(isIdentityHunk("x\r\n", "x\n")).toBe(false);
  });

  it("NARROWER here: (b) the reviewer skips that same pair as identity", () => {
    // Both sides trimEnd() to "x", so the guard at reviewer.mjs:252 skips them.
    expect(extractExplicitEdits(block("x\r\n", "x\n"))).toHaveLength(0);
  });

  it("NARROWER here: (c) PARSE CONTROL — the same fixture with a changed REPLACE IS emitted", () => {
    // Without this, (b)'s absence witnesses nothing: a fixture that never parsed
    // produces zero edits for a reason that has nothing to do with the guard.
    const edits = extractExplicitEdits(block("x\r\n", "y\n"));
    expect(edits, "the fixture reaches the guard; the absence in (b) is the guard's doing").toHaveLength(1);
  });

  it("NOT a divergence: (d) interior CRLF is AGREEMENT — both report a real edit", () => {
    // Neither side carries trailing whitespace, so trimEnd() changes nothing.
    expect(isIdentityHunk("a\r\nb", "a\nb")).toBe(false);

    const edits = extractExplicitEdits(block("a\r\nb", "a\nb"));
    expect(edits).toHaveLength(1);
    // Also witnesses that a CR survives the canonical-block regex at reviewer.mjs:238
    // into the guard at :247 — without which (b) above would be unbuildable.
    expect(edits[0].search).toContain("\r");
  });
});

// ─── What the shipped comment is allowed to claim ────────────────────────────

describe("no false comparison shipped into source", () => {
  /** The JSDoc block immediately above the isIdentityHunk export — never the whole file. */
  function isIdentityHunkJsDoc() {
    const src = fs.readFileSync(SEARCH_REPLACE_SRC, "utf8");
    const exportIdx = src.indexOf("export function isIdentityHunk");
    if (exportIdx === -1) return "";
    const open = src.lastIndexOf("/**", exportIdx);
    const close = src.indexOf("*/", open);
    if (open === -1 || close === -1 || close > exportIdx) return "";
    return src.slice(open, close + 2);
  }

  const doc = isIdentityHunkJsDoc();

  it("EXTRACTION CONTROL — the block was found and carries its fixture", () => {
    // Asserted in its own right. Every part below is an absence assertion or a
    // universal, so all four are green on an EMPTY or MIS-LOCATED block. The
    // mis-location is reachable, not hypothetical: patternExistsInFile carries its
    // own JSDoc in this same file, and that block satisfies every part while
    // witnessing nothing about the comment this describe exists to police.
    expect(doc.length).toBeGreaterThan(0);
    expect(doc).toContain('"x\\r\\n"');
    expect(doc).toContain('"x\\n"');
  });

  it("(a) claims no UNQUALIFIED agreement with the reviewer guard", () => {
    // Not implemented as a bare ban on "agree" — the block legitimately states a
    // SCOPED agreement (interior CRLF), which must remain sayable.
    // NOT a bare keyword ban. The block legitimately says "DELIBERATELY NOT THE SAME
    // PREDICATE" — banning that phrase outright reddens on a correct disagreement
    // claim. That is the use/mention trap this story has hit three times; only
    // unqualified POSITIVE forms are forbidden.
    expect(doc).not.toMatch(/\bis the same predicate\b/i);
    expect(doc).not.toMatch(/\b(matches|agrees with|mirrors) the (reviewer|guard)\b/i);
    // Positive evidence that the correct relationship IS stated.
    expect(doc).toMatch(/INCOMPARABLE/);
  });

  it("(b) states the narrower direction BY ITS CAUSE, not as a CR-only rule", () => {
    // A trailing form feed, vertical tab or NBSP diverges identically. Shipped text
    // asserting CR is the WHOLE of the narrower direction would be false.
    expect(doc).toMatch(/trimEnd\(\) strips every Unicode WhiteSpace/);
    expect(doc).toMatch(/canonical member/);
  });

  it("(c) every fixture pair in the block is the subject of an executed assertion", () => {
    // Ranges over fixture literals actually present, which the EXTRACTION CONTROL
    // has already proven non-empty.
    const pairs = [...doc.matchAll(/"([^"]*)" vs "([^"]*)"/g)].map((m) => [m[1], m[2]]);
    expect(pairs.length).toBeGreaterThan(0);
    const asserted = new Set(['a  \\nb|a\\nb', 'x\\r\\n|x\\n', 'a\\r\\nb|a\\nb']);
    for (const [s, r] of pairs) {
      expect(asserted.has(`${s}|${r}`), `fixture "${s}" vs "${r}" is claimed but never asserted`).toBe(true);
    }
  });

  it("(d) makes no comparison claim that names no fixture", () => {
    // This is what escaped (a), (b) and (c) simultaneously in an earlier draft.
    for (const shape of ["outside them", "in general", "otherwise", "always"]) {
      expect(doc.toLowerCase(), `unfixtured comparison shape: ${shape}`).not.toContain(shape);
    }
  });
});

// ─── The planner: identity hunks are not coverage ────────────────────────────

const editBlock = (file, search, replace) =>
  `\n### ${file}\n\n@@SEARCH\n${search}\n@@REPLACE\n${replace}\n@@END\n`;

describe("planner early-exit BLOCKS an anchors-only target", () => {
  it("an identity-only target is not covered — falls through to the LLM", () => {
    const text = editBlock("src/a.mjs", "anchor line", "anchor line");
    const { allCovered, steps } = computeEarlyExitCoverage(text, ["src/a.mjs"]);
    expect(allCovered, "an anchor specifies no change and must not count as coverage").toBe(false);
    expect(steps).toHaveLength(0);
  });

  it("NEGATIVE CONTROL — a target with an identity anchor AND a real block still covers", () => {
    // The guard must not be a blanket rejection of identity hunks. Without this, a
    // builder could satisfy the block-case by refusing them everywhere.
    const text =
      editBlock("src/a.mjs", "anchor line", "anchor line") +
      editBlock("src/a.mjs", "old code", "new code");
    const { allCovered, steps } = computeEarlyExitCoverage(text, ["src/a.mjs"]);
    expect(allCovered).toBe(true);
    expect(steps).toHaveLength(1);
    expect(steps[0].edits.map((e) => e.search)).toContain("old code");
    expect(steps[0].edits.map((e) => e.search), "the anchor is dropped, not emitted").not.toContain("anchor line");
  });

  it("SEMANTICS PRESERVED — partial coverage RETURNS accumulated steps, it does not discard them", () => {
    // Asserted on the PARTIAL-coverage fixture. On a fixture with no blocks at all
    // both the old and new semantics return [], so it would witness nothing.
    const text = editBlock("src/a.mjs", "old code", "new code"); // b has none
    const { allCovered, steps } = computeEarlyExitCoverage(text, ["src/a.mjs", "src/b.mjs"]);
    expect(allCovered).toBe(false);
    expect(steps, "production accumulates then breaks; the deleted mirror returned []").toHaveLength(1);
  });

  it("the identity filter is applied inside the exported function, not at its call site", () => {
    const { allCovered } = computeEarlyExitCoverage(
      editBlock("src/a.mjs", "same", "same"),
      ["src/a.mjs"],
    );
    expect(allCovered).toBe(false);
  });

  it("REGRESSION — the all-or-nothing rationale comment stays at the call site", () => {
    const src = fs.readFileSync(PLANNER_SRC, "utf8");
    expect(src).toContain("All-or-nothing gate");
    expect(src).toContain("design.arch-planner-refactor.md");
  });
});

// ─── plan-readiness: WARN, never block ───────────────────────────────────────

function makeStory(dir, id, body) {
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes", `${id}.md`), body, "utf8");
}

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-identity-hunk-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

describe("plan-readiness WARNS on an anchors-only target and never blocks", () => {
  const STORY = "backlog.feat.probe";

  function build(dir, targets, blocks) {
    const fm = targets.map((t) => `  - path: "${t}"\n    op: "edit"`).join("\n");
    makeStory(
      dir,
      STORY,
      `---\nid: "${STORY}"\nphase: "arch-approved"\ntestExempt: true\ntargetFiles:\n${fm}\n---\n\n## Problem\n\nProbe.\n${blocks}`,
    );
  }

  it("warns, and stays ready", async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, "src/a.mjs"), "anchor line\n", "utf8");
    build(dir, ["src/a.mjs"], editBlock("src/a.mjs", "anchor line", "anchor line"));

    const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
    const warn = (res.warnings || []).find((w) => w.check === "anchor_only_target");
    expect(warn, "an anchors-only target must be reported").toBeTruthy();
    expect(warn.file).toBe("src/a.mjs");
    expect(res.ready, "WARN, never block — blocking would wedge the refine recovery loop").toBe(true);
    expect((res.issues || []).some((i) => i.check === "anchor_only_target")).toBe(false);
  });

  it("PER-TARGET ATTRIBUTION, proven on a MULTI-TARGET fixture", async () => {
    // A single-target fixture cannot distinguish a per-target predicate from a
    // story-wide one — they agree whenever the story has exactly one op:edit target.
    // Story-wide `.every()` never fires here, because the real edit is not identity.
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, "src/a.mjs"), "anchor line\n", "utf8");
    fs.writeFileSync(path.join(dir, "src/b.mjs"), "old code\n", "utf8");
    build(
      dir,
      ["src/a.mjs", "src/b.mjs"],
      editBlock("src/a.mjs", "anchor line", "anchor line") + editBlock("src/b.mjs", "old code", "new code"),
    );

    const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
    const warns = (res.warnings || []).filter((w) => w.check === "anchor_only_target");
    expect(warns.map((w) => w.file)).toEqual(["src/a.mjs"]);
    expect(res.ready).toBe(true);
  });

  it("FALSE-POSITIVE CONTROL — a target with a real edit does not warn", async () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, "src/a.mjs"), "old code\n", "utf8");
    build(dir, ["src/a.mjs"], editBlock("src/a.mjs", "old code", "new code"));

    const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
    expect((res.warnings || []).some((w) => w.check === "anchor_only_target")).toBe(false);
  });

  it("THE REFINE RECOVERY LOOP IS NOT WEDGED — the form refine emits still yields ready", async () => {
    // refine.mjs:1801 emits `@@SEARCH\n${anchor}\n@@REPLACE\n${anchor}\n@@END` —
    // the same variable on both sides. If plan-readiness ever blocks on that, the
    // recovery loop the injection exists to drive can never complete.
    const dir = tmpProject();
    const anchor = "export function handleRequest(req) {";
    fs.writeFileSync(path.join(dir, "src/a.mjs"), `${anchor}\n  return req;\n}\n`, "utf8");
    build(dir, ["src/a.mjs"], `\n### src/a.mjs\n\n@@SEARCH\n${anchor}\n@@REPLACE\n${anchor}\n@@END\n`);

    const res = await runPlanReadyTool({ projectRoot: dir, problemId: STORY, projectId: "p" });
    expect(res.ready).toBe(true);
  });
});
