/**
 * backlog.fix.exec-scoped-tests-integration-config-routing — a run that selected zero test
 * files ("No test files found") is a distinct, non-refinable outcome: the pre-apply baselines
 * refuse it with a no_tests_found reason, and exec.mjs's verification loop exits on it before
 * any fix plan, with the same rollback as the tests-failed exit.
 *
 * runPreApplyBaseline receives an injected runTests stub — no subprocess is spawned.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPreApplyBaseline } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const NO_TESTS = { passed: false, skipped: false, noTestsFound: true, output: "No test files found, exiting with code 1", exitCode: 1 };
const GREEN = { passed: true, skipped: false, output: "ok", exitCode: 0, summary: "all tests passed", testResults: { available: false, runner: null, reason: "runner_not_recognized", failed: [], passed: [], skipped: [] } };

const FILE_A = "tests/unit/command-runner.test.mjs";
const FILE_B = "tests/unit/command-runner-scoped-tests.test.mjs";

const reasonOf = (out) => (out.refusal ? out.refusal.reason : out.baselineSkipReason);

const expectNoTestsRefusal = (out, paths) => {
  expect(out.proceed).not.toBe(true);
  const reason = reasonOf(out);
  expect(String(reason)).toMatch(/no_tests_found/);
  for (const p of paths) expect(String(reason)).toContain(p);
  expect(reason).not.toBe("baseline_failed");
  expect(reason).not.toBe("baseline_red_results_unavailable");
};

/** Count source occurrences of a literal. */
const count = (src, lit) => src.split(lit).length - 1;

/** Each `collector.emit(` call's full argument text (balanced parens, strings skipped). */
function emitArgs(src) {
  const out = [];
  const opener = "collector.emit(";
  let idx = src.indexOf(opener);
  while (idx !== -1) {
    let depth = 0;
    let i = idx + opener.length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") { i = src.indexOf(ch, i + 1); continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
    }
    out.push(src.slice(idx + opener.length, i));
    idx = src.indexOf(opener, i);
  }
  return out;
}

/** The `{ ... }` block opened at the first `{` at or after `from`. */
function braceBlock(src, from) {
  const start = src.indexOf("{", from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

describe("runPreApplyBaseline refuses a no-tests-found baseline", () => {
  it("reports a no_tests_found reason naming the unmatched paths, never baseline_failed nor a non-skipped proceed", () => {
    const out = runPreApplyBaseline({ projectRoot: REPO_ROOT, storyTestFiles: [FILE_A], runDir: null, runTests: () => NO_TESTS });
    expectNoTestsRefusal(out, [FILE_A]);
    expect(out.proceed === true && out.baselineSkipped === false).toBe(false);
  });

  it("prefers the runner's own noTestsFoundPaths when it names them", () => {
    const out = runPreApplyBaseline({
      projectRoot: REPO_ROOT, storyTestFiles: [FILE_A, FILE_B], runDir: null,
      runTests: () => ({ ...NO_TESTS, noTestsFoundPaths: [FILE_B] }),
    });
    expectNoTestsRefusal(out, [FILE_B]);
    expect(out.refusal.noTestsFoundPaths).toEqual([FILE_B]);
  });
});

describe("runDeclaredRedBaseline refuses no-tests-found on every run", () => {
  it("per-test run", () => {
    const out = runPreApplyBaseline({
      projectRoot: REPO_ROOT, storyTestFiles: [FILE_A, FILE_B], runDir: null,
      runTests: () => NO_TESTS, baselineRedTests: [`${FILE_A} > some test`],
    });
    expectNoTestsRefusal(out, [FILE_A, FILE_B]);
  });

  it("file-level remaining run (declared run green)", () => {
    const runTests = (_root, { testPaths }) => (testPaths.includes(FILE_B) ? NO_TESTS : GREEN);
    const out = runPreApplyBaseline({
      projectRoot: REPO_ROOT, storyTestFiles: [FILE_A, FILE_B], runDir: null, runTests, baselineRedTests: [FILE_A],
    });
    expectNoTestsRefusal(out, [FILE_B]);
  });

  it("file-level declared run (remaining run green)", () => {
    const runTests = (_root, { testPaths }) => (testPaths.includes(FILE_A) ? NO_TESTS : GREEN);
    const out = runPreApplyBaseline({
      projectRoot: REPO_ROOT, storyTestFiles: [FILE_A, FILE_B], runDir: null, runTests, baselineRedTests: [FILE_A],
    });
    expectNoTestsRefusal(out, [FILE_A]);
  });
});

describe("exec.mjs verification loop: no-tests-found is non-refinable", () => {
  const iLoop = EXEC_SRC.indexOf("const verification = runProjectTests(");
  const iCheck = EXEC_SRC.indexOf("verification.noTestsFound", iLoop);
  const iFix = EXEC_SRC.indexOf("await generateFixPlan(", iLoop);
  const iRbNoTests = EXEC_SRC.indexOf("reason: 'no_tests_found' });");
  const iExitStart = EXEC_SRC.lastIndexOf("const rb = await rollback(", iRbNoTests);
  const exitBlock = EXEC_SRC.slice(iExitStart, EXEC_SRC.indexOf("};", EXEC_SRC.indexOf("return {", iExitStart)));

  it("checks verification.noTestsFound before generating a fix plan", () => {
    expect(iLoop).toBeGreaterThan(-1);
    expect(iCheck).toBeGreaterThan(iLoop);
    expect(iFix).toBeGreaterThan(-1);
    expect(iCheck).toBeLessThan(iFix);
    const check = braceBlock(EXEC_SRC, iCheck);
    expect(check).not.toContain("generateFixPlan");
    expect(check).toMatch(/\bbreak;/);
  });

  it("performs the same rollback call as the tests-failed exit and derives rolledBack from it", () => {
    const shape = (reason) => `const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: '${reason}' });`;
    expect(count(EXEC_SRC, shape("test_failure"))).toBe(1);
    expect(count(EXEC_SRC, shape("no_tests_found"))).toBe(1);
    expect(iRbNoTests).toBeGreaterThan(iFix);
    expect(exitBlock).toMatch(/const rolledBack = rb\?\.\w+/);
    expect(exitBlock).toMatch(/\n\s*rolledBack,\n/);
    expect(exitBlock).not.toMatch(/rolledBack:\s*(true|false)/);
    expect(exitBlock).toContain("noTestsFoundPaths");
    expect(exitBlock).not.toContain("generateFixPlan");
    expect(exitBlock).not.toContain("runRefineTool");
  });

  it("reports a distinct reason (not tests_exhausted, not a pass) with no second testsFailed emit or testOutput literal", () => {
    expect(exitBlock).toContain('reason: "no_tests_found"');
    expect(exitBlock).not.toContain("tests_exhausted");
    expect(exitBlock).toMatch(/ok:\s*false/);
    expect(exitBlock).not.toMatch(/testsFailed:\s*true/);
    expect(emitArgs(EXEC_SRC).filter((a) => /\btestsFailed:\s*true\b/.test(a))).toHaveLength(1);
    expect(count(EXEC_SRC, 'testOutput: verification.output || ""')).toBe(1);
    expect(count(EXEC_SRC, 'testOutput: lastVerification?.output || ""')).toBe(1);
  });
});
