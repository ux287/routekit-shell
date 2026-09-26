/**
 * Witness for backlog.fix.exec-baseline-blocks-non-js-tdd-stories.
 *
 * Two defects made rks_exec unusable for a TDD story in a pytest project:
 *   A. the PRE-apply baseline was handed the story's testFiles, which include files the story
 *      will create — pytest exits 4 on a missing path, and `status === 0` reads that as red;
 *   B. isTestFile only knew JS naming, so `tests/unit/test_foo.py` never triggered the
 *      test-fix exemption that masked (A) in JS projects.
 * And the refusal was THROWN, so the Build Governor never saw a testsFailed result.
 *
 * Spawns no subprocess: runPreApplyBaseline takes an injected runTests.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isTestFile,
  isTestFixStory,
  filterExistingTestPaths,
  runPreApplyBaseline,
} from "../../packages/mcp-rks/src/server/test-runner.mjs";
import { transitionOnResult } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const BUILD_PROMPT = fs.readFileSync(path.join(REPO_ROOT, ".rks/prompts/governor-build.md"), "utf8");
const PROMPT_LINES = BUILD_PROMPT.split("\n");

const tmpDirs = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-baseline-")); tmpDirs.push(d); return d; };
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

/** A temp projectRoot holding tests/test_existing.py only. */
const mkProject = () => {
  const root = mkTmp();
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests/test_existing.py"), "def test_ok():\n    assert True\n");
  return root;
};

const count = (src, needle) => src.split(needle).length - 1;

/** Same depth-aware splitter as tests/unit/exec-lifecycle-emission-cardinality.test.mjs. */
function emitCalls(src) {
  const calls = [];
  const opener = "collector.emit(";
  let idx = src.indexOf(opener);
  while (idx !== -1) {
    const args = [];
    let depth = 0;
    let start = idx + opener.length;
    let i = start;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") { i = src.indexOf(ch, i + 1); continue; }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === ")") { if (depth === 0) break; depth--; }
      else if (ch === "," && depth === 0) { args.push(src.slice(start, i).trim()); start = i + 1; }
    }
    const last = src.slice(start, i).trim();
    if (last.length > 0) args.push(last);
    calls.push({ index: idx, args });
    idx = src.indexOf(opener, i);
  }
  return calls;
}

describe("isTestFile — pytest naming", () => {
  it("recognizes pytest test files, including a root-level tests/ directory", () => {
    for (const p of ["tests/unit/test_foo.py", "tests/test_foo.py", "src/pkg/foo_test.py", "test_foo.py", "tests/conftest.py"]) {
      expect(isTestFile(p), p).toBeTruthy();
    }
  });

  it("still recognizes every JS form", () => {
    for (const p of ["tests/unit/foo.test.mjs", "src/a.spec.ts", "src/__tests__/a.js", "pkg/tests/helper.js"]) {
      expect(isTestFile(p), p).toBeTruthy();
    }
  });

  it("does not match ordinary source files that merely contain 'test'", () => {
    for (const p of ["src/pkg/foo.py", "src/contest.py", "src/testing_utils.py", "src/latest.py", "README.md"]) {
      expect(isTestFile(p), p).toBeFalsy();
    }
  });
});

describe("isTestFixStory — pytest targets and config", () => {
  it("fires for a plan whose step creates tests/unit/test_foo.py", () => {
    const plan = { problemId: "backlog.feat.x", steps: [{ type: "create_file", target: "tests/unit/test_foo.py" }] };
    expect(isTestFixStory(plan, [])).toBe(true);
  });

  it("fires for declared pytest.ini, and separately for conftest.py", () => {
    const plan = { problemId: "backlog.feat.x", steps: [] };
    expect(isTestFixStory(plan, [{ path: "pytest.ini", op: "create" }])).toBe(true);
    expect(isTestFixStory(plan, [{ path: "conftest.py", op: "create" }])).toBe(true);
  });

  it("keeps the existing vitest/jest cases and negatives", () => {
    const plan = { problemId: "backlog.feat.x", steps: [] };
    expect(isTestFixStory(plan, ["vitest.config.ts"])).toBe(true);
    expect(isTestFixStory(plan, ["config/jest.config.js"])).toBe(true);
    const widget = { problemId: "backlog.feat.add-widget", steps: [{ target: "src/widget.js" }, { target: "README.md" }] };
    expect(isTestFixStory(widget, ["src/widget.js", "README.md"])).toBe(false);
    expect(isTestFixStory(plan, ["src/app.config.ts"])).toBe(false);
  });
});

describe("filterExistingTestPaths", () => {
  it("keeps only on-disk entries, in input order", () => {
    const root = mkProject();
    expect(filterExistingTestPaths(root, ["tests/unit/test_new.py", "tests/test_existing.py"])).toEqual(["tests/test_existing.py"]);
  });

  it("returns [] when none exist, and for null or empty input", () => {
    const root = mkProject();
    expect(filterExistingTestPaths(root, ["tests/unit/test_new.py"])).toEqual([]);
    expect(filterExistingTestPaths(root, null)).toEqual([]);
    expect(filterExistingTestPaths(root, [])).toEqual([]);
  });
});

describe("runPreApplyBaseline (injected runTests = vi.fn())", () => {
  it("skips — never runs, never reports passed — when no story test file exists yet", () => {
    const root = mkProject();
    const runTests = vi.fn();
    const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: ["tests/unit/test_new.py"], runDir: null, runTests });
    expect(runTests).not.toHaveBeenCalled();
    expect(r.proceed).toBe(true);
    expect(r.baselineSkipped).toBe(true);
    expect(r.baselineSkipReason).toContain("story_test_files_absent");
    expect(r.baselineSkipReason).toContain("tests/unit/test_new.py");
    expect(r.baselineAbsentPaths).toEqual(["tests/unit/test_new.py"]);
    expect(r.passed).not.toBe(true);
  });

  it("runs once, scoped to exactly the existing subset", () => {
    const root = mkProject();
    const runTests = vi.fn(() => ({ passed: true, skipped: false }));
    const r = runPreApplyBaseline({
      projectRoot: root, storyTestFiles: ["tests/test_existing.py", "tests/unit/test_new.py"], runDir: null, runTests,
    });
    expect(runTests).toHaveBeenCalledTimes(1);
    expect(runTests).toHaveBeenCalledWith(root, { testPaths: ["tests/test_existing.py"] });
    expect(r.proceed).toBe(true);
    expect(r.baselineSkipped).toBe(false);
    expect(r.baselineTestPaths).toEqual(["tests/test_existing.py"]);
  });

  it("storyTestFiles null keeps the unscoped run", () => {
    const root = mkProject();
    const runTests = vi.fn(() => ({ passed: true, skipped: false }));
    runPreApplyBaseline({ projectRoot: root, storyTestFiles: null, runDir: null, runTests });
    expect(runTests).toHaveBeenCalledTimes(1);
    expect(runTests).toHaveBeenCalledWith(root, { testPaths: null });
  });

  it("reports a runner skip as runner_skipped with the runner's reason", () => {
    const root = mkProject();
    const runTests = vi.fn(() => ({ passed: true, skipped: true, reason: "no test runner detected" }));
    const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: null, runDir: null, runTests });
    expect(r.proceed).toBe(true);
    expect(r.baselineSkipped).toBe(true);
    expect(r.baselineSkipReason.startsWith("runner_skipped")).toBe(true);
    expect(r.baselineSkipReason).toContain("no test runner detected");
  });

  it("RETURNS a structured refusal (no throw) when the baseline is red", () => {
    const root = mkProject();
    const runTests = vi.fn(() => ({ passed: false, skipped: false, exitCode: 4, summary: "tests failed", output: "ERROR: file or directory not found" }));
    let r;
    expect(() => { r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: ["tests/test_existing.py"], runDir: null, runTests }); }).not.toThrow();
    expect(r.proceed).toBe(false);
    const f = r.refusal;
    expect(f.ok).toBe(false);
    expect(f.testsFailed).toBe(true);
    expect(f.stage).toBe("pre_apply_baseline");
    expect(f.applied).toBe(false);
    expect(f.rolledBack).toBe(false);
    expect(f.partialDiffPath).toBeNull();
    expect(Array.isArray(f.refinementSuggestions)).toBe(true);
    expect(f.attempts).toBe(0);
    expect(f.testPaths).toEqual(["tests/test_existing.py"]);
    expect(f.summary).toBe("tests failed");
    expect(f.exitCode).toBe(4);
    expect(f.hint).toMatch(/before any change was applied/i);
  });

  it("R8 — writes the log to runDir and reports it only once it exists", () => {
    const root = mkProject();
    const runDir = mkTmp();
    const runTests = vi.fn(() => ({ passed: false, skipped: false, exitCode: 1, summary: "tests failed", output: "1 failed" }));
    const { refusal } = runPreApplyBaseline({ projectRoot: root, storyTestFiles: null, runDir, runTests });
    expect(refusal.testsFailedLog).toBe(path.join(runDir, "baseline-tests-failed.log"));
    expect(fs.existsSync(refusal.testsFailedLog)).toBe(true);
    expect(fs.readFileSync(refusal.testsFailedLog, "utf8")).toContain("tests failed");
  });

  it("R8 — testsFailedLog is null when runDir is null or missing, and nothing throws", () => {
    const root = mkProject();
    const runTests = vi.fn(() => ({ passed: false, skipped: false, exitCode: 1, summary: "tests failed" }));
    expect(runPreApplyBaseline({ projectRoot: root, storyTestFiles: null, runDir: null, runTests }).refusal.testsFailedLog).toBeNull();
    const missing = path.join(root, "no-such-run-dir");
    expect(runPreApplyBaseline({ projectRoot: root, storyTestFiles: null, runDir: missing, runTests }).refusal.testsFailedLog).toBeNull();
  });
});

describe("exec.mjs wiring (full-source checks, no fixed-size slices)", () => {
  const idxCheckout = EXEC_SRC.indexOf('"checkout", "-b"');
  const POST_APPLY = "runProjectTests(projectRoot, { testPaths: storyTestFiles, ...verifyCollectOptions(attemptNumber) })";

  it("the throw is gone", () => {
    expect(EXEC_SRC).not.toContain("tests already failing");
  });

  it("calls runPreApplyBaseline with runTests: runProjectTests before the branch is created", () => {
    const idxCall = EXEC_SRC.indexOf("runPreApplyBaseline(");
    expect(idxCheckout).toBeGreaterThan(-1);
    expect(idxCall).toBeGreaterThan(-1);
    expect(idxCall).toBeLessThan(idxCheckout);
    const callEnd = EXEC_SRC.indexOf(")", idxCall);
    expect(EXEC_SRC.slice(idxCall, callEnd)).toContain("runTests: runProjectTests");
  });

  it("the post-apply runProjectTests literal occurs exactly once, after checkout -b", () => {
    expect(count(EXEC_SRC, POST_APPLY)).toBe(1);
    expect(EXEC_SRC.indexOf(POST_APPLY)).toBeGreaterThan(idxCheckout);
  });

  it("emits exactly one exec.failed baseline_failed, shaped like every exec emit, without testsFailed: true", () => {
    const matches = emitCalls(EXEC_SRC).filter((c) => c.args[0] === '"exec.failed"' && /reason:\s*baseline\.refusal\.reason\b/.test(c.args[2] || ""));
    expect(matches).toHaveLength(1);
    const [c] = matches;
    expect(c.args.length).toBeGreaterThanOrEqual(3);
    expect(c.args[1]).toBe("projectId");
    expect(c.args[2].startsWith("{")).toBe(true);
    expect(c.args[2]).not.toMatch(/testsFailed:\s*true/);
  });

  const KEYS = ["baselineSkipped", "baselineSkipReason", "baselineAbsentPaths", "baselineTestPaths"];

  it("R9 — the pending_ship return carries every baseline* key after its status key", () => {
    const idxStatus = EXEC_SRC.indexOf("status: 'pending_ship'");
    const objStart = EXEC_SRC.lastIndexOf("return {", idxStatus);
    const objEnd = EXEC_SRC.indexOf("};", idxStatus);
    expect(objStart).toBeGreaterThan(-1);
    for (const k of KEYS) {
      const at = EXEC_SRC.indexOf(k, idxStatus);
      expect(at, k).toBeGreaterThan(idxStatus);
      expect(at, k).toBeLessThan(objEnd);
    }
  });

  it("R9 — the tests_exhausted return carries every baseline* key", () => {
    const idxReason = EXEC_SRC.indexOf('reason: "tests_exhausted"');
    const objStart = EXEC_SRC.indexOf("return {", idxReason);
    const objEnd = EXEC_SRC.indexOf("};", objStart);
    const obj = EXEC_SRC.slice(objStart, objEnd);
    for (const k of KEYS) expect(obj, k).toContain(k);
  });

  const preApplyRegion = () => {
    const start = EXEC_SRC.indexOf("testFixMode = isTestFixStory(");
    const ends = [EXEC_SRC.indexOf("runPreApplyBaseline(", start), EXEC_SRC.indexOf('"checkout", "-b"', start)].filter((i) => i > -1);
    return EXEC_SRC.slice(start, Math.min(...ends));
  };

  it("the test-fix exemption is reported as a baseline skip", () => {
    expect(EXEC_SRC).toContain("test_fix_exemption");
    const region = preApplyRegion();
    expect(region).toContain("test_fix_exemption");
    expect(region).toMatch(/baselineSkipped(\s*=\s*|:\s*)true/);
  });

  it("skipTests is reported as a baseline skip", () => {
    expect(EXEC_SRC).toContain("skip_tests");
    const start = EXEC_SRC.indexOf("testFixMode = isTestFixStory(");
    const region = EXEC_SRC.slice(start, EXEC_SRC.indexOf('"checkout", "-b"', start));
    expect(region).toContain("skip_tests");
    expect(region).toMatch(/baselineSkipped(\s*=\s*|:\s*)true/);
  });
});

describe("governor-build.md pre_apply_baseline guard", () => {
  const step6 = () => {
    const start = BUILD_PROMPT.indexOf("6. mcp__rks__rks_exec");
    return BUILD_PROMPT.slice(start, BUILD_PROMPT.indexOf("6a.", start));
  };
  const rules = () => BUILD_PROMPT.slice(BUILD_PROMPT.indexOf("## Rules"));

  it("step 6 STOPs on pre_apply_baseline without calling rks_refine", () => {
    const s = step6();
    expect(s).toContain("pre_apply_baseline");
    expect(s).toContain("STOP");
    expect(s).toMatch(/Do NOT call rks_refine/);
  });

  it("## Rules has a matching STOP line", () => {
    expect(rules().split("\n").some((l) => l.includes("pre_apply_baseline") && l.includes("STOP"))).toBe(true);
  });

  it("no pre_apply_baseline line mentions 6a, and the 6a markers are where they were", () => {
    for (const l of PROMPT_LINES.filter((x) => x.includes("pre_apply_baseline"))) {
      expect(l).not.toContain("6a.");
      expect(l).not.toContain("step 6a");
    }
    const heading = BUILD_PROMPT.indexOf("6a.");
    expect(BUILD_PROMPT.slice(heading)).toMatch(/^6a\. \*\*Refine-retry loop\*\*/);
    expect(BUILD_PROMPT.indexOf("step 6a")).toBeLessThan(heading);
  });

  it("the 6a entry sentence excludes the pre-apply refusal", () => {
    const lines = PROMPT_LINES.filter((l) => l.includes("do NOT stop immediately"));
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l).toContain("pre_apply_baseline");
    expect(l).not.toContain("6a.");
    expect(l).not.toContain("step 6a");
    expect(BUILD_PROMPT.indexOf(l)).toBeGreaterThan(BUILD_PROMPT.indexOf("6a. **Refine-retry loop**"));
  });

  it("the Rules retry line is qualified after its pinned phrase, without the stage literal", () => {
    const phrase = "Test failure with retries remaining";
    const lines = rules().split("\n").filter((l) => l.includes(phrase));
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l.indexOf("pre-apply baseline")).toBeGreaterThan(l.indexOf(phrase));
    expect(l).not.toContain("pre_apply_baseline");
  });

  it("no line both STOPs on pre_apply_baseline and says do NOT stop immediately", () => {
    for (const l of PROMPT_LINES) {
      expect(l.includes("pre_apply_baseline") && /\bSTOP\b/.test(l) && l.includes("do NOT stop immediately")).toBe(false);
    }
  });
});

describe("governed transition", () => {
  it("exec.failed lands in test-failed", () => {
    expect(transitionOnResult("story", "executing", "exec.failed")).toBe("test-failed");
  });
});
