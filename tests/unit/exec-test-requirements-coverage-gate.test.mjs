// exec.mjs wiring for the coverage gate, asserted on full source with indexOf ordering
// (no fixed-size slices), plus a frontmatter round-trip and the incident fixture. No subprocess.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { writeRequirementCoverageRecord } from "../../packages/mcp-rks/src/server/exec.mjs";
import { computeEarlyExitCoverage, decideEarlyExit } from "../../packages/mcp-rks/src/server/planner.mjs";
import { evaluateRequirementCoverage, buildRequirementCoverageRecord } from "../../packages/mcp-rks/src/exec/test-results.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

/** Index of the brace closing the one opening at `open` (skips comments and string contents). */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { i = src.indexOf(ch, i + 1); continue; }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The block opened by the first `{` at or after `marker` (searching from `from`). */
function blockAt(marker, from = 0) {
  const at = EXEC_SRC.indexOf(marker, from);
  expect(at, marker).toBeGreaterThan(-1);
  const open = EXEC_SRC.indexOf("{", at + marker.length - 1);
  const close = matchBrace(EXEC_SRC, open);
  return { at, start: open, end: close, text: EXEC_SRC.slice(open, close + 1) };
}

/** Every `ctx.terminalDetail = { ... }` with the statement that follows it. */
function terminalDetails() {
  return [...EXEC_SRC.matchAll(/ctx\.terminalDetail = \{/g)].map((m) => {
    const open = m.index + "ctx.terminalDetail = ".length;
    const close = matchBrace(EXEC_SRC, open);
    return { index: m.index, text: EXEC_SRC.slice(open, close + 1), after: close + 1 };
  });
}

/** The object literal of the `return {` that directly follows a terminal detail. */
function returnAfter(detail) {
  const rest = EXEC_SRC.slice(detail.after);
  expect(rest).toMatch(/^;\s*return \{/);
  const open = EXEC_SRC.indexOf("{", detail.after);
  const close = matchBrace(EXEC_SRC, open);
  return { index: EXEC_SRC.indexOf("return", detail.after), text: EXEC_SRC.slice(open, close + 1) };
}

const idx = (literal, from = 0) => {
  const i = EXEC_SRC.indexOf(literal, from);
  expect(i, literal).toBeGreaterThan(-1);
  return i;
};

describe("exec coverage gate wiring", () => {
  it("reads testRequirements beside baselineRedTests; verifyCollectOptions widened; AC9 argv unchanged (AC3/AC9)", () => {
    const load = blockAt("if (earlyProblemId) {");
    expect(load.text).toContain("earlyStory.frontmatter.baselineRedTests");
    expect(load.text).toContain("earlyStory.frontmatter.testRequirements");

    // Behavioral: evaluate the real normalization and collect-option expressions from source.
    const norm = EXEC_SRC.slice(idx("const treq = earlyStory.frontmatter.testRequirements;"), idx("storyTargetFiles = earlyStory.targetFiles"));
    const hasExpr = /const hasTestRequirements = ([^;]+);/.exec(EXEC_SRC)[1];
    const readReqs = new Function("earlyStory", `let storyTestRequirements = null; ${norm} return ${hasExpr};`);
    const collectExpr = /const verifyCollectOptions = (\(attempt\) => \([\s\S]*?\));\n/.exec(EXEC_SRC)[1];
    expect(collectExpr).toContain("baselineRedPerTest || hasTestRequirements");
    const makeCollect = new Function("baselineRedPerTest", "hasTestRequirements", "runDir", `return ${collectExpr};`);

    for (const testRequirements of [undefined, [], null]) {
      const has = readReqs({ frontmatter: { testRequirements } });
      expect(has, String(testRequirements)).toBe(false);
      // No per-test baseline entries and no requirements: no collect option, so argv is unchanged.
      expect(makeCollect(false, has, "/run")(1)).toEqual({});
    }
    for (const testRequirements of [["does x"], "does x"]) {
      const has = readReqs({ frontmatter: { testRequirements } });
      expect(has).toBe(true);
      expect(makeCollect(false, has, "/run")(2)).toEqual({ collectTestResults: { reportDir: "/run", reportName: "verify-test-results-2.json" } });
    }
    expect(makeCollect(true, false, "/run")(1)).toHaveProperty("collectTestResults");
  });

  it("skipTests refusal precedes apply, status test_requirements_unverifiable, reason skip_tests (AC3)", () => {
    const skip = blockAt("if (skipTests) {", idx("const hasBaselineRedTests ="));
    expect(skip.text).toContain('console.error("[rks.exec] Skipping baseline tests (--skip-tests)");');
    expect(skip.text).toContain("if (nonProcessRequirementCount > 0) {");
    expect(skip.text).toMatch(/return \{\s*ok: false,\s*status: "test_requirements_unverifiable",\s*reason: "skip_tests",/);
    // The refusal precedes the first plan-step apply call.
    expect(skip.end).toBeLessThan(idx("await runApplyTool({"));
    expect(skip.end).toBeLessThan(idx("runPreApplyBaseline("));
    // Its guard counts only non-process requirements.
    expect(EXEC_SRC).toMatch(/const nonProcessRequirementCount = hasTestRequirements\s*\?\s*storyTestRequirements\.filter\(\(r\) => !isProcessRequirement\(r\)\)\.length/);
    expect(EXEC_SRC).toMatch(/import \{[^}]*\bisProcessRequirement\b[^}]*\} from "\.\.\/exec\/test-results\.mjs";/);
  });

  it("gate refusals sit after verification and before const commitFiles; rollback + resetStalePhaseToArchApproved; no commit (AC1/AC4)", () => {
    const loop = idx("while (attemptNumber <= MAX_RETRY_ATTEMPTS + 1)");
    const commitFiles = idx("const commitFiles = computeCommitFiles(");
    const gate = idx("let requirementCoverageEvaluation = null;");
    expect(gate).toBeGreaterThan(loop);
    expect(gate).toBeLessThan(commitFiles);
    for (const status of ['status: "test_requirements_uncovered"', 'status: "test_requirements_unverifiable"']) {
      const at = idx(status, gate);
      expect(at, status).toBeLessThan(commitFiles);
      const retAt = EXEC_SRC.lastIndexOf("return {", at);
      expect(retAt).toBeGreaterThan(gate);
      const ret = EXEC_SRC.slice(retAt, matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", retAt)) + 1);
      expect(ret, status).toMatch(/\bok: false\b/);
      const path_ = EXEC_SRC.slice(gate, retAt);
      expect(path_, status).toContain("await rollback(projectRoot, {");
      expect(path_, status).toContain("resetStalePhaseToArchApproved(projectRoot, coverageProblemId);");
      expect(path_.indexOf("await rollback(")).toBeLessThan(path_.indexOf("resetStalePhaseToArchApproved("));
      expect(path_, status).not.toContain("runGitCommit(");
      expect(path_, status).not.toContain("advanceExecEndPhase(");
    }
    // The gate evaluates the ORIGINAL plan's map and the passing attempt's per-test results.
    const gateText = EXEC_SRC.slice(gate, commitFiles);
    expect(gateText).toContain("requirementCoverage: plan.requirementCoverage,");
    expect(gateText).toContain("const coverageResults = lastVerification?.testResults || null;");
    expect(gateText).toContain("if (hasTestRequirements) {");
  });

  it("resolveUnverifiedCoveragePolicy consulted only in the unavailable branch; waiver logged (AC12)", () => {
    expect(EXEC_SRC).toContain('import { resolveUnverifiedCoveragePolicy } from "../exec/requirement-coverage-policy.mjs";');
    const calls = [...EXEC_SRC.matchAll(/resolveUnverifiedCoveragePolicy\(/g)];
    expect(calls).toHaveLength(1);
    const branch = blockAt("if (!coverageSkipReason && !coverageResults?.available) {", idx("let requirementCoverageEvaluation = null;"));
    expect(calls[0].index).toBeGreaterThan(branch.start);
    expect(calls[0].index).toBeLessThan(branch.end);
    const waiver = blockAt('if (requirementCoverageEvaluation.outcome === "unverified") {');
    expect(waiver.text).toMatch(/console\.error\([^;]*testRequirementCoverage\.acceptUnverified[^;]*requirementCoverageEvaluation\.unverified\.reason/);
  });

  it("record written after runGitCommit and before commitExecEndNote; run.json; pending_ship requirementCoverage (AC5)", () => {
    const commit = idx("commitResult = await runGitCommit({");
    const write = idx("writeRequirementCoverageRecord({ notePath: recordNotePath, record: requirementCoverageRecord })");
    const noteCommit = idx("await commitExecEndNote({");
    expect(write).toBeGreaterThan(commit);
    expect(write).toBeLessThan(noteCommit);
    const build = idx("requirementCoverageRecord = buildRequirementCoverageRecord({", commit);
    expect(build).toBeLessThan(write);
    expect(EXEC_SRC.slice(build, write)).toContain("commit: commitIdForRecord,");
    const runJson = idx("recordRunMeta.requirementCoverageRecord = requirementCoverageRecord;", write);
    expect(runJson).toBeLessThan(noteCommit);
    expect(EXEC_SRC.slice(write, runJson)).toContain('path.join(runDir, "run.json")');
    const ship = idx("status: 'pending_ship',");
    const shipRet = EXEC_SRC.lastIndexOf("return {", ship);
    const shipObj = EXEC_SRC.slice(shipRet, matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", shipRet)) + 1);
    expect(shipObj).toContain("requirementCoverage: requirementCoverageRecord,");
    // AC9: only stories with testRequirements get the key.
    expect(shipObj).toMatch(/\.\.\.\(hasTestRequirements \? \{\s*requirementCoverage: requirementCoverageRecord,/);
  });

  it("story-load catch replaced: story_missing / story_unreadable refusals with stage story_load precede the skip-tests log and runPreApplyBaseline( (AC14)", () => {
    expect(EXEC_SRC).not.toContain("// testFiles unavailable — fall back to full suite");
    const load = blockAt("if (earlyProblemId) {");
    const skipLog = idx('"[rks.exec] Skipping baseline tests (--skip-tests)"');
    const baseline = idx("runPreApplyBaseline(");
    for (const reason of ["story_missing", "story_unreadable"]) {
      const details = terminalDetails().filter((d) => d.text.includes(`reason: "${reason}"`));
      expect(details, reason).toHaveLength(1);
      const [d] = details;
      expect(d.text).toContain('stage: "story_load"');
      expect(d.index).toBeGreaterThan(load.start);
      expect(d.index).toBeLessThan(load.end);
      const ret = returnAfter(d);
      expect(ret.text).toMatch(/\bok: false\b/);
      expect(ret.text).toContain('status: "test_requirements_unverifiable"');
      expect(ret.text).toContain(`reason: "${reason}"`);
      expect(ret.text).toContain("problemId: earlyProblemId");
      expect(ret.index).toBeLessThan(skipLog);
      expect(ret.index).toBeLessThan(baseline);
    }
    // story_unreadable carries the load error message as detail.
    const unreadable = terminalDetails().find((d) => d.text.includes('reason: "story_unreadable"'));
    expect(returnAfter(unreadable).text).toContain("detail: loadDetail,");
  });

  it("story_missing classified by fs.existsSync on the resolved note path, not error text (AC14)", () => {
    const load = blockAt("if (earlyProblemId) {");
    expect(load.text).toContain("const earlyNotePath = resolveNotePath(projectRoot, earlyProblemId);");
    expect(load.text).toContain("fs.existsSync(earlyNotePath)");
    expect(load.text.indexOf("fs.existsSync(earlyNotePath)")).toBeLessThan(load.text.indexOf('reason: "story_missing"'));
    expect(load.text).not.toContain("Problem note not found");
    expect(EXEC_SRC).toContain('import { resolveNotePath } from "../dendron-notes.mjs";');
  });

  it("record write guarded by commitResult?.ok === true and a non-empty commitId; withheld path carries requirementCoverageWithheld 'no_commit' and logs it (AC15)", () => {
    expect(EXEC_SRC).toContain("const commitIdForRecord = commitResult?.fullCommitId || commitResult?.commitId;");
    // The record commit and the withholding guard key on the same value.
    expect(EXEC_SRC).not.toContain("commit: commitResult.commitId,");
    const guard = blockAt('if (shouldCommit && commitResult?.ok === true && typeof commitIdForRecord === "string" && commitIdForRecord.length > 0) {');
    expect(guard.text).toContain("writeRequirementCoverageRecord(");
    expect(guard.text).toContain("recordRunMeta.requirementCoverageRecord = requirementCoverageRecord;");
    // Nothing outside the guard writes the record.
    expect([...EXEC_SRC.matchAll(/= writeRequirementCoverageRecord\(\{ notePath:/g)]).toHaveLength(1);
    const elseAt = guard.end + 1;
    const withheld = blockAt("else {", elseAt);
    expect(withheld.at - elseAt).toBeLessThan(5);
    expect(withheld.text).toContain('requirementCoverageWithheld = "no_commit";');
    expect(withheld.text).toMatch(/console\.error\("[^"]*withheld[^"]*no commit/);
    expect(EXEC_SRC).toContain("let requirementCoverageRecord = null;");
    const ship = idx("status: 'pending_ship',");
    const shipRet = EXEC_SRC.lastIndexOf("return {", ship);
    const shipObj = EXEC_SRC.slice(shipRet, matchBrace(EXEC_SRC, EXEC_SRC.indexOf("{", shipRet)) + 1);
    expect(shipObj).toContain("requirementCoverage: requirementCoverageRecord,");
    expect(shipObj).toContain("...(requirementCoverageWithheld ? { requirementCoverageWithheld } : {}),");
  });
});

describe("coverage record persistence", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
  const tempNote = (content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-cov-record-"));
    dirs.push(dir);
    const p = path.join(dir, "backlog.fix.x.md");
    fs.writeFileSync(p, content);
    return p;
  };
  const NOTE = `---\nid: "backlog.fix.x"\nphase: "executed"\ntestRequirements:\n  - "does x"\n---\n\n## Problem\n\nbody stays\n`;

  it("nested record round-trips through the frontmatter writer and parseFrontmatter (AC5)", () => {
    const record = {
      runId: "2026-11-01T00-00-00-000Z_backlog-fix-x",
      commit: "abc1234",
      recordedAt: "2026-11-01T00:00:00.000Z",
      requirementsDigest: "f".repeat(64),
      verification: "unverified",
      unverified: { reason: "runner_not_recognized", adapter: null, policySource: ".rks/project.json#testRequirementCoverage.acceptUnverified" },
      requirements: [
        { index: 0, kind: "test", coverage: "unverified", testFile: "tests/unit/a.test.mjs", path: "suite > does \"x\": #1", observedId: null, observedStatus: null },
        { index: 1, kind: "process", coverage: "process" },
      ],
    };
    const notePath = tempNote(NOTE);
    const res = writeRequirementCoverageRecord({ notePath, record });
    expect(res).toEqual({ ok: true, path: notePath });
    const after = fs.readFileSync(notePath, "utf8");
    const parsed = parseFrontmatter(after);
    expect(parsed.data.requirementCoverageRecord).toEqual(record);
    expect(parsed.data.requirementCoverageRecord.requirements[0].observedStatus).toBeNull();
    expect(parsed.data.requirementCoverageRecord.unverified.adapter).toBeNull();
    // The rest of the note is untouched.
    expect(parsed.data.phase).toBe("executed");
    expect(parsed.data.testRequirements).toEqual(["does x"]);
    expect(after.endsWith("## Problem\n\nbody stays\n")).toBe(true);
  });

  it("an observed read-back mismatch or unwritable note is reported, never silent (requirementCoverageWriteError, ARCH note)", () => {
    // A key whose value cannot survive serialization (undefined is dropped) makes the read-back differ.
    const notePath = tempNote(NOTE);
    const mismatch = writeRequirementCoverageRecord({ notePath, record: { runId: "r", commit: "abc1234", lost: undefined, requirements: [] } });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toBe("read_back_mismatch");
    expect(mismatch.detail.length).toBeGreaterThan(0);
    // No frontmatter block, and a missing file: reported with an error and detail, no throw.
    const bare = writeRequirementCoverageRecord({ notePath: tempNote("no frontmatter here\n"), record: { runId: "r" } });
    expect(bare).toMatchObject({ ok: false, error: "note_has_no_frontmatter" });
    const missing = writeRequirementCoverageRecord({ notePath: path.join(os.tmpdir(), `rks-missing-${Date.now()}.md`), record: { runId: "r" } });
    expect(missing).toMatchObject({ ok: false, error: "write_failed" });
    expect(missing.detail.length).toBeGreaterThan(0);
    // exec carries the failure on its result and logs it.
    expect(EXEC_SRC).toContain("requirementCoverageWriteError = { error: recordWrite.error, detail: recordWrite.detail, path: recordNotePath };");
    expect(EXEC_SRC).toMatch(/console\.error\(`\[rks\.exec\] requirementCoverageRecord write to \$\{recordNotePath\} failed/);
    expect(EXEC_SRC).toContain("...(requirementCoverageWriteError ? { requirementCoverageWriteError } : {}),");
  });
});

describe("incident regression", () => {
  it("dispatch-fresh-run-never-release-shaped fixture: no early-exit, uncovered names the untested indices (AC10)", () => {
    const block = (file, search, replace) => `\n### ${file}\n\n@@SEARCH\n${search}\n@@REPLACE\n${replace}\n@@END\n`;
    const testRequirements = [
      "a fresh dispatch run acquires the lease",
      "the lease is released when the run completes",
      "the lease is released when the run throws",
      "a released lease can be re-acquired by the next run",
    ];
    const story = `---\nid: "backlog.fix.dispatch-fresh-run-never-release"\nphase: "arch-approved"\n---\n\n## Solution\n`
      + block("packages/mcp-rks/src/dispatch/run.mjs", "const lease = acquire();", "const lease = acquire();\ntry {")
      + block("packages/mcp-rks/src/dispatch/lease.mjs", "export function release() {}", "export function release(id) { leases.delete(id); }");
    const targets = ["packages/mcp-rks/src/dispatch/run.mjs", "packages/mcp-rks/src/dispatch/lease.mjs"];
    const { allCovered, steps } = computeEarlyExitCoverage(story, targets);
    // Non-identity blocks cover every edit target: the old decision would have early-exited.
    expect(allCovered).toBe(true);
    expect(steps).toHaveLength(2);
    const decision = decideEarlyExit({ allCovered, earlyExitStepCount: steps.length, uncoveredCreateCount: 0, testRequirements, requirementCoverage: null });
    expect(decision.earlyExit).toBe(false);
    expect(decision.refusedReason).toBe("requirement_coverage_incomplete");

    // The (LLM) plan maps all four; only two tests exist and pass in the run.
    const T = "tests/unit/dispatch-lease.test.mjs";
    const requirementCoverage = testRequirements.map((_, index) => ({ index, testFile: T, path: `dispatch lease > case ${index}` }));
    const results = {
      available: true, runner: "vitest", source: "vitest_json",
      passed: [`${T} > dispatch lease > case 0`, `${T} > dispatch lease > case 3`],
      failed: [], error: [], failing: [], xfailed: [], xpassed: [], skipped: [],
      assertions: [{ id: `${T} > dispatch lease > case 0`, status: "passed" }, { id: `${T} > dispatch lease > case 3`, status: "passed" }],
    };
    const evaluation = evaluateRequirementCoverage({ testRequirements, requirementCoverage, results, verificationSkipped: false });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.status).toBe("test_requirements_uncovered");
    expect(evaluation.uncoveredRequirements.map((u) => u.index)).toEqual([1, 2]);
    expect(evaluation.uncoveredRequirements.map((u) => u.text)).toEqual([testRequirements[1], testRequirements[2]]);
    // And no record can be built from a refused evaluation.
    expect(buildRequirementCoverageRecord({ evaluation, testRequirements, runId: "r", commit: "abc1234" })).toBeNull();
  });
});
