/**
 * backlog.fix.exec-tests-passed-requires-observed-execution: a verdict needs an observation.
 * A spawn failure, or an exit-0 run whose counts line shows zero tests executed, is never a pass.
 *
 * Real spawns of POSIX shell fixture scripts (skipped on win32). Every spawn is bounded:
 * runProjectTests forwards `timeout` to spawnSync's timeout option, and the gate run uses
 * fullSuiteGate.timeoutMs. Fixture roots come from makeTempDir (outside the repository).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tmp.mjs";
import { runProjectTests, testsRanFromVerification, mergePartitionResults } from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import { runPreApplyBaseline } from "../../packages/mcp-rks/src/server/test-runner.mjs";
import { runFullSuiteGate } from "../../packages/mcp-rks/src/exec/full-suite-gate.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const RUNNER_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/exec/command-runner.mjs"), "utf8");
const POSIX = process.platform !== "win32";
// runProjectTests forwards this to spawnSync's timeout option: every real spawn below is bounded.
const SPAWN_TIMEOUT = 15_000;
const EXIT_CODE_ONLY = "verdict decided by exit code alone";

const EMPTY_RUN = 'echo "============================ no tests ran in 0.01s ============================="; exit 0';
const SKIPPED_ONLY = 'echo "===== 5 skipped in 0.10s ====="; exit 0';
const XFAILED_ONLY = 'echo "===== 3 xfailed in 0.10s ====="; exit 0';
const THREE_PASSED = 'echo "===== 3 passed in 0.05s ====="; exit 0';

const FILE_A = "tests/test_a.py";
const FILE_B = "tests/test_b.py";
const NO_FILES = { passed: false, skipped: false, noTestsFound: true, output: "No test files found, exiting with code 1", exitCode: 1 };
const GREEN = { passed: true, skipped: false, output: "ok", exitCode: 0, summary: "all tests passed", testResults: { available: false, runner: null, reason: "runner_not_recognized", failed: [], passed: [], skipped: [] } };

const roots = [];
let errSpy;

/** A temp project whose testCommand is the relative cmd venv/bin/pytest; body null = no script. */
function project(body, extraConfig = {}) {
  const root = makeTempDir("observed-exec");
  roots.push(root);
  const bin = path.join(root, "venv", "bin");
  fs.mkdirSync(bin, { recursive: true });
  if (body !== null) {
    const script = path.join(bin, "pytest");
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(script, 0o755);
  }
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"),
    JSON.stringify({ testCommand: { cmd: "venv/bin/pytest", args: [] }, ...extraConfig }));
  return root;
}
/** Story test files on disk, so runPreApplyBaseline does not skip the baseline as absent. */
function withStoryFiles(root) {
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  for (const f of [FILE_A, FILE_B]) fs.writeFileSync(path.join(root, f), "def test_x():\n    pass\n");
  return root;
}
const run = (root) => runProjectTests(root, { timeout: SPAWN_TIMEOUT });
const exitCodeOnlyLogged = () => errSpy.mock.calls.some((c) => String(c[0]).includes(EXIT_CODE_ONLY));

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe.runIf(POSIX)("runProjectTests: the verdict requires observed execution", () => {
  it("spawn ENOENT: passed false, spawnError names the cause, testsRan false", () => {
    const r = run(project(null));
    expect(r.passed).toBe(false);
    expect(String(r.spawnError)).toMatch(/ENOENT/);
    expect(testsRanFromVerification(r)).toBe(false);
  });

  it.each([
    ["the pytest empty-run counts line", EMPTY_RUN],
    ["a skipped-only run", SKIPPED_ONLY],
  ])("exit 0 with %s is proven empty: not a pass, testsRan false", (_label, body) => {
    const r = run(project(body));
    expect(r.passed).toBe(false);
    expect(r.summary).toBe("no tests executed");
    expect(r.executedCount).toBe(0);
    expect(r.noTestsExecuted).toBe(true);
    expect(r.noTestsFound).toBe(true);
    expect(r.spawnError).toBeNull();
    expect(testsRanFromVerification(r)).toBe(false);
  });

  it("an xfailed-only run executed its tests: executedCount 3, passed true, testsRan true", () => {
    const r = run(project(XFAILED_ONLY));
    expect(r.executedCount).toBe(3);
    expect(r.passed).toBe(true);
    expect(testsRanFromVerification(r)).toBe(true);
  });

  it("relative cmd resolves against projectRoot, not process.cwd()", () => {
    const root = project('touch ran.marker; echo "===== 2 passed in 0.01s ====="; exit 0');
    expect(path.resolve(process.cwd())).not.toBe(path.resolve(root));
    const r = run(root);
    expect(fs.existsSync(path.join(root, "ran.marker"))).toBe(true);
    expect(r.spawnError ?? null).toBeNull();
  });

  it("genuine pass: exit 0 with an executed count >= 1 stays passed true, testsRan true, no exit-code-only log", () => {
    const r = run(project(THREE_PASSED));
    expect(r.passed).toBe(true);
    expect(r.executedCount).toBe(3);
    expect(r.spawnError).toBeNull();
    expect(testsRanFromVerification(r)).toBe(true);
    expect(exitCodeOnlyLogged()).toBe(false);
  });

  it("unparseable count: executedCount null (never 0), exit status decides, and the exit-code-only verdict is logged", () => {
    const pass = run(project('echo "ok"; exit 0'));
    expect(pass.executedCount).toBeNull();
    expect(pass.passed).toBe(true);
    expect(exitCodeOnlyLogged()).toBe(true);
    errSpy.mockClear();
    const fail = run(project('echo "ok"; exit 1'));
    expect(fail.executedCount).toBeNull();
    expect(fail.passed).toBe(false);
    expect(exitCodeOnlyLogged()).toBe(true);
  });
});

describe.runIf(POSIX)("pre-apply baseline: a proven-empty run refuses as baseline_no_tests_executed", () => {
  const expectEmptyRefusal = (out) => {
    expect(out.proceed).toBe(false);
    expect(out.refusal.reason).toBe("baseline_no_tests_executed");
    expect(out.refusal.reason).not.toBe("baseline_failed");
    expect(out.refusal.testsFailed).toBe(false);
    expect(out.refusal.noTestsExecuted).toBe(true);
  };
  const emptyProject = () => {
    const root = withStoryFiles(project(SKIPPED_ONLY));
    return { root, empty: run(root) };
  };

  it("plain baseline", () => {
    const { root, empty } = emptyProject();
    expectEmptyRefusal(runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE_A], runDir: null, runTests: () => empty }));
  });

  it("declared-red per-test run", () => {
    const { root, empty } = emptyProject();
    expectEmptyRefusal(runPreApplyBaseline({
      projectRoot: root, storyTestFiles: [FILE_A, FILE_B], runDir: null,
      runTests: () => empty, baselineRedTests: [`${FILE_A} > test_x`],
    }));
  });

  it("declared-red file-level remaining run (declared run green)", () => {
    const { root, empty } = emptyProject();
    const runTests = (_root, { testPaths }) => (testPaths.includes(FILE_B) ? empty : GREEN);
    expectEmptyRefusal(runPreApplyBaseline({
      projectRoot: root, storyTestFiles: [FILE_A, FILE_B], runDir: null, runTests, baselineRedTests: [FILE_A],
    }));
  });

  it("declared-red file-level declared run (remaining run green)", () => {
    const { root, empty } = emptyProject();
    const runTests = (_root, { testPaths }) => (testPaths.includes(FILE_A) ? empty : GREEN);
    expectEmptyRefusal(runPreApplyBaseline({
      projectRoot: root, storyTestFiles: [FILE_A, FILE_B], runDir: null, runTests, baselineRedTests: [FILE_A],
    }));
  });

  it("a vitest no-files result (no noTestsExecuted) still refuses no_tests_found", () => {
    const root = withStoryFiles(project(SKIPPED_ONLY));
    const out = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE_A], runDir: null, runTests: () => NO_FILES });
    expect(out.proceed).toBe(false);
    expect(String(out.refusal.reason)).toMatch(/^no_tests_found/);
  });
});

describe.runIf(POSIX)("ship full-suite gate: a proven-empty run blocks", () => {
  it("blocks with no_tests_found, so an empty run never counts as green", () => {
    const root = project(SKIPPED_ONLY, { fullSuiteGate: { enabled: true, timeoutMs: SPAWN_TIMEOUT } });
    const g = runFullSuiteGate(root);
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe("no_tests_found");
  });
});

describe("testsRanFromVerification", () => {
  it("is false for no run, a skipped run, a spawn failure, no tests found, or zero executed", () => {
    expect(testsRanFromVerification(null)).toBe(false);
    expect(testsRanFromVerification(undefined)).toBe(false);
    expect(testsRanFromVerification({ passed: true, skipped: true })).toBe(false);
    expect(testsRanFromVerification({ passed: false, skipped: false, spawnError: "ENOENT", exitCode: null })).toBe(false);
    expect(testsRanFromVerification({ passed: false, skipped: false, noTestsFound: true, exitCode: 1 })).toBe(false);
    expect(testsRanFromVerification({ passed: false, skipped: false, spawnError: null, exitCode: 1, executedCount: 0 })).toBe(false);
  });
  it("is true for an observed spawn, whether it passed or failed or its count is unknown", () => {
    expect(testsRanFromVerification({ passed: true, skipped: false, spawnError: null, exitCode: 0, executedCount: 3 })).toBe(true);
    expect(testsRanFromVerification({ passed: false, skipped: false, spawnError: null, exitCode: 1, executedCount: 2 })).toBe(true);
    expect(testsRanFromVerification({ passed: true, skipped: false, spawnError: null, exitCode: 0, executedCount: null })).toBe(true);
  });
});

describe("mergePartitionResults: observed-execution fields", () => {
  const part = (over) => ({ passed: true, skipped: false, output: "", exitCode: 0, spawnError: null, executedCount: 1, ...over });
  it("sums executedCount when every partition reports one", () => {
    expect(mergePartitionResults([part({ executedCount: 2 }), part({ executedCount: 3 })], null).executedCount).toBe(5);
  });
  it("is null when any partition's count is unknown", () => {
    expect(mergePartitionResults([part({ executedCount: 2 }), part({ executedCount: null })], null).executedCount).toBeNull();
  });
  it("a partition spawnError makes the merged result fail and carries the cause", () => {
    const m = mergePartitionResults([part({}), part({ passed: false, exitCode: null, spawnError: "spawn node ENOENT", executedCount: null })], null);
    expect(m.passed).toBe(false);
    expect(String(m.spawnError)).toMatch(/ENOENT/);
  });
  it("a proven-empty partition carries noTestsFound and noTestsExecuted onto the merged result", () => {
    const m = mergePartitionResults([part({}), part({ passed: false, noTestsFound: true, noTestsExecuted: true, noTestsFoundPaths: [FILE_A], executedCount: 0 })], null);
    expect(m.passed).toBe(false);
    expect(m.noTestsFound).toBe(true);
    expect(m.noTestsExecuted).toBe(true);
  });
});

describe("source contracts", () => {
  const count = (src, lit) => src.split(lit).length - 1;

  it("exec.mjs derives testsRan from the observed verification, not from flags", () => {
    expect(EXEC_SRC).not.toContain("testsRan: !skipTests && !testsSkipped,");
    expect(EXEC_SRC).toMatch(/testsRan:\s*testsRanFromVerification\(lastVerification\)/);
  });

  it("exec.mjs writes tests-passed.log through its own variable and records it only once observed", () => {
    expect(EXEC_SRC).toContain('path.join(runDir, "tests-passed.log")');
    expect(EXEC_SRC).not.toMatch(/lastTestLogPath\s*=\s*passLogPath/);
    const iWrite = EXEC_SRC.indexOf("fs.writeFileSync(passLogPath");
    const iRecord = EXEC_SRC.indexOf("testsPassedLogPath = passLogPath");
    expect(iWrite).toBeGreaterThan(-1);
    expect(iRecord).toBeGreaterThan(iWrite);
    expect(EXEC_SRC.slice(iWrite, iRecord)).toContain("fs.existsSync(passLogPath)");
  });

  it("exec.mjs routes a proven-empty run to the existing non-refinable no_tests_found exit, before any fix plan", () => {
    const iLoop = EXEC_SRC.indexOf("const verification = runProjectTests(");
    const iCheck = EXEC_SRC.indexOf("if (verification.noTestsFound) {", iLoop);
    const iFlag = EXEC_SRC.indexOf("verification.noTestsExecuted", iLoop);
    const iFix = EXEC_SRC.indexOf("await generateFixPlan(", iLoop);
    expect(iLoop).toBeGreaterThan(-1);
    expect(iCheck).toBeGreaterThan(iLoop);
    expect(iFlag).toBeGreaterThan(iCheck);
    expect(iFlag).toBeLessThan(iFix);
    // backlog.feat.exec-plan-commit-linkage (AC8): every exec rollback call now passes correlationId.
    const shape = (reason) => `const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: '${reason}', correlationId });`;
    expect(count(EXEC_SRC, shape("test_failure"))).toBe(1);
    expect(count(EXEC_SRC, shape("no_tests_found"))).toBe(1);
  });

  it("command-runner.mjs reads the spawn error, uses the shared counts helper, and holds no second pytest grammar", () => {
    expect(RUNNER_SRC).toContain("result.error");
    expect(RUNNER_SRC).toContain("parsePytestCounts(output)");
    expect(RUNNER_SRC).not.toContain("no tests ran");
  });
});
