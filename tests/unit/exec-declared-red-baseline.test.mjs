/**
 * Declared-red baseline wiring (backlog.feat.exec-declared-red-baseline-tests).
 * spawnSync is mocked; runPreApplyBaseline gets an injected runTests stub. No real pytest or
 * vitest is ever spawned: every mocked run returns captured output (E1, verbatim from the story
 * note) or writes a vitest JSON report fixture into a tmp dir.
 *
 * exec.mjs assertions are source-level over the full source or delimiter-bounded regions
 * (brace-matched blocks), never fixed-size slice windows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});
import { spawnSync } from "child_process";
import { runProjectTests } from "../../packages/mcp-rks/src/exec/command-runner.mjs";
import { runPreApplyBaseline } from "../../packages/mcp-rks/src/server/test-runner.mjs";
import { parsePytestSummary } from "../../packages/mcp-rks/src/exec/test-results.mjs";
import { ARRAY_FIELDS, updateFieldDirect, updateField, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const F = "tests/unit/test_robinhood_client.py::TestRobinhoodClient::";
const FILE = "tests/unit/test_robinhood_client.py";
const OTHER = "tests/unit/test_market_data.py";

// ── E1 [peer], verbatim from the story note ─────────────────────────
const E1_LINES = [
  "=========================== short test summary info ============================",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_initialization",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_authenticate_success",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_authenticate_with_key_file_path",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_authenticate_failure",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_crypto_price_failure",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_crypto_historical_data_success",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_crypto_order_failure",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_order_status",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_cancel_order",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClientIntegration::test_authenticated_workflow",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClientPerformance::test_get_crypto_price_latency",
  "PASSED tests/unit/test_robinhood_client.py::TestRobinhoodClientPerformance::test_order_placement_latency",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_crypto_price_success - assert None == 50000.0",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_account_info_success - AssertionError: assert {'results': [...': '150.25'}]} == {'buying_powe...ay...",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_crypto_positions_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_crypto_buy_order_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_crypto_sell_order_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_limit_order_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_signature_generation - AssertionError: expected call not found.",
  "=================== 7 failed, 12 passed, 2 warnings in 0.43s ===================",
];
const E1 = E1_LINES.join("\n");
const E1_FAILED_IDS = [
  `${F}test_get_crypto_price_success`,
  `${F}test_get_account_info_success`,
  `${F}test_get_crypto_positions_success`,
  `${F}test_place_crypto_buy_order_success`,
  `${F}test_place_crypto_sell_order_success`,
  `${F}test_place_limit_order_success`,
  `${F}test_signature_generation`,
];
const E1_PASSED_IDS = E1_LINES.filter((l) => l.startsWith("PASSED ")).map((l) => l.slice("PASSED ".length));

// pytest --color=yes markup: SGR around the outcome word, bold after the first "::", resets,
// and a counts line whose end-separator markup is left unterminated.
const ESC = "\u001b";
function colourize(line) {
  const m = line.match(/^(PASSED|FAILED) ([^:]+)::(\S+)(.*)$/);
  if (m) {
    const colour = m[1] === "PASSED" ? `${ESC}[32m` : `${ESC}[31m`;
    return `${colour}${ESC}[1m${m[1]}${ESC}[0m ${m[2]}::${ESC}[1m${m[3]}${ESC}[0m${m[4]}`;
  }
  if (line.includes("short test summary info")) return `${ESC}[36m${line}${ESC}[0m`;
  if (line.includes("7 failed")) {
    return `${ESC}[31m=================== ${ESC}[31m${ESC}[1m7 failed${ESC}[0m, ${ESC}[32m12 passed${ESC}[0m, `
      + `${ESC}[33m2 warnings${ESC}[0m${ESC}[31m in 0.43s${ESC}[0m${ESC}[31m ===================`;
  }
  return line;
}

const TIMEOUT = 30000;
const tmpDirs = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-declared-red-")); tmpDirs.push(d); return d; };
let errSpy;

/** A tmp project root; testCommand written to .rks/project.json when given. */
function mkProject({ testCommand, files = [FILE, OTHER] } = {}) {
  const root = mkTmp();
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "def test_ok():\n    assert True\n");
  }
  if (testCommand) {
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks/project.json"), JSON.stringify({ testCommand }));
  }
  return root;
}
const spawnResult = (status, stdout = "", extra = {}) => ({ status, signal: null, stdout, stderr: "", ...extra });

beforeEach(() => {
  spawnSync.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

// ── runProjectTests: collectTestResults ─────────────────────────────

describe("runProjectTests collectTestResults (mocked spawnSync)", () => {
  it("without collectTestResults the argv is unchanged and the result has no testResults key", () => {
    const root = mkProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockReturnValue(spawnResult(1, E1));
    const r = runProjectTests(root, { testPaths: [FILE], timeout: TIMEOUT });
    expect(spawnSync.mock.calls[0][0]).toBe("pytest");
    expect(spawnSync.mock.calls[0][1]).toEqual(["-q", FILE]);
    expect(spawnSync.mock.calls[0][2].timeout).toBe(TIMEOUT);
    expect(Object.keys(r)).not.toContain("testResults");

    const plain = mkProject();
    spawnSync.mockReset();
    spawnSync.mockReturnValue(spawnResult(0, "ok"));
    const v = runProjectTests(plain, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(spawnSync.mock.calls[0][1]).toEqual([
      "scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", "295000", "tests/unit/foo.test.mjs",
    ]);
    expect(Object.keys(v)).not.toContain("testResults");
  });

  it("pytest: -rA --color=no go after the declared args and before testPaths; E1 parses", () => {
    const root = mkProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockReturnValue(spawnResult(1, E1));
    const r = runProjectTests(root, { testPaths: [FILE], timeout: TIMEOUT, collectTestResults: { reportDir: mkTmp() } });
    expect(spawnSync.mock.calls[0][1]).toEqual(["-q", "-rA", "--color=no", FILE]);
    expect(spawnSync.mock.calls[0][2].timeout).toBe(TIMEOUT);
    expect(r.testResults.available).toBe(true);
    expect(r.testResults.runner).toBe("pytest");
    expect(r.testResults.failed).toEqual(E1_FAILED_IDS);
    expect(r.testResults.passed).toEqual(E1_PASSED_IDS);

    const traders = mkProject({ testCommand: { cmd: "pytest", args: ["-q", "tests/"] } });
    spawnSync.mockReset();
    spawnSync.mockReturnValue(spawnResult(1, E1));
    runProjectTests(traders, { testPaths: [FILE, OTHER], collectTestResults: {} });
    expect(spawnSync.mock.calls[0][1]).toEqual(["-q", "tests/", "-rA", "--color=no", FILE, OTHER]);
  });

  it("trap (a), colour: SGR-marked E1 yields the plain-E1 result and output holds no ESC", () => {
    const root = mkProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    const coloured = E1_LINES.map(colourize).join("\n");
    expect(coloured).toContain(`${ESC}[1m`);
    expect(coloured.endsWith(`${ESC}[31m ===================`)).toBe(true);
    spawnSync.mockReturnValue(spawnResult(1, coloured));
    const r = runProjectTests(root, { testPaths: [FILE], collectTestResults: {} });
    expect(r.testResults).toEqual(parsePytestSummary(E1));
    expect(r.output.includes("\u001b")).toBe(false);
  });

  it("built-in vitest path: --json-output with an absolute path under reportDir; parses the written report; missing → unavailable", () => {
    const root = mkProject({ files: ["tests/unit/foo.test.mjs"] });
    const reportDir = mkTmp();
    spawnSync.mockImplementation((cmd, args) => {
      const reportPath = args[args.indexOf("--json-output") + 1];
      fs.writeFileSync(reportPath, JSON.stringify({
        testResults: [{
          name: path.join(root, "tests/unit/foo.test.mjs"),
          status: "failed",
          assertionResults: [
            { ancestorTitles: ["suite"], title: "red", status: "failed" },
            { ancestorTitles: ["suite"], title: "green", status: "passed" },
          ],
        }],
      }));
      return spawnResult(1, "1 failed");
    });
    const r = runProjectTests(root, { testPaths: ["tests/unit/foo.test.mjs"], collectTestResults: { reportDir } });
    const args = spawnSync.mock.calls[0][1];
    const reportPath = args[args.indexOf("--json-output") + 1];
    expect(path.isAbsolute(reportPath)).toBe(true);
    expect(reportPath.startsWith(reportDir)).toBe(true);
    expect(args.indexOf("--json-output")).toBeLessThan(args.indexOf("tests/unit/foo.test.mjs"));
    expect(r.testResults.available).toBe(true);
    expect(r.testResults.failed).toEqual(["tests/unit/foo.test.mjs > suite > red"]);
    expect(r.testResults.passed).toEqual(["tests/unit/foo.test.mjs > suite > green"]);

    spawnSync.mockReset();
    spawnSync.mockReturnValue(spawnResult(1, "1 failed"));
    const missing = runProjectTests(root, { testPaths: ["tests/unit/foo.test.mjs"], collectTestResults: { reportDir } });
    expect(missing.testResults.available).toBe(false);
  });

  it("npm test: argv unchanged, testResults unavailable with runner_not_recognized", () => {
    const root = mkProject({ testCommand: { cmd: "npm", args: ["test"] } });
    spawnSync.mockReturnValue(spawnResult(0, "ok"));
    const r = runProjectTests(root, { testPaths: [FILE], collectTestResults: {} });
    expect(spawnSync.mock.calls[0][1]).toEqual(["test", FILE]);
    expect(r.testResults).toMatchObject({ available: false, reason: "runner_not_recognized" });
  });

  it("a SIGTERM run returns testResults available false", () => {
    const root = mkProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockReturnValue({ status: null, signal: "SIGTERM", stdout: E1, stderr: "" });
    const r = runProjectTests(root, { testPaths: [FILE], collectTestResults: {} });
    expect(r.summary).toBe("timeout");
    expect(r.testResults.available).toBe(false);
  });
});

// ── runPreApplyBaseline: declared-red proof ─────────────────────────

const e1Run = () => ({ passed: false, skipped: false, exitCode: 1, summary: "tests failed", output: E1, testResults: parsePytestSummary(E1) });

describe("runPreApplyBaseline with baselineRedTests (injected runTests)", () => {
  it("absent or empty baselineRedTests: runTests gets exactly { testPaths } with no collectTestResults key", () => {
    for (const baselineRedTests of [undefined, []]) {
      const root = mkProject();
      const runTests = vi.fn(() => ({ passed: true, skipped: false }));
      const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE], runDir: null, runTests, baselineRedTests });
      expect(runTests).toHaveBeenCalledTimes(1);
      expect(runTests).toHaveBeenCalledWith(root, { testPaths: [FILE] });
      expect(Object.keys(runTests.mock.calls[0][1])).toEqual(["testPaths"]);
      expect(r.proceed).toBe(true);
      expect(r.baselineRed).toBeUndefined();
    }
  });

  it("per-test pytest entries ⊇ failing ids → proceed with baselineRed granularity test", () => {
    const root = mkProject();
    const runTests = vi.fn(e1Run);
    const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE], runDir: null, runTests, baselineRedTests: E1_FAILED_IDS });
    expect(runTests).toHaveBeenCalledTimes(1);
    expect(runTests.mock.calls[0][1].collectTestResults).toBeTruthy();
    expect(r.proceed).toBe(true);
    expect(r.baselineRed.granularity).toBe("test");
    expect(r.baselineRed.runner).toBe("pytest");
    expect(r.baselineRed.observedFailing).toEqual(E1_FAILED_IDS);
    expect(r.baselineRed.declared).toEqual(E1_FAILED_IDS);
  });

  it("an undeclared failing id RETURNS a baseline_failed refusal naming it", () => {
    const root = mkProject();
    const runTests = vi.fn(e1Run);
    const declared = E1_FAILED_IDS.filter((id) => !id.endsWith("test_signature_generation"));
    let r;
    expect(() => { r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE], runDir: null, runTests, baselineRedTests: declared }); }).not.toThrow();
    expect(r.proceed).toBe(false);
    expect(r.refusal.reason).toBe("baseline_failed");
    expect(r.refusal.stage).toBe("pre_apply_baseline");
    expect(r.refusal.undeclaredFailing).toEqual([`${F}test_signature_generation`]);
    expect(r.refusal.baselineRed).toBeTruthy();
    expect(r.refusal.baselineRed.observedFailing).toEqual(E1_FAILED_IDS);
  });

  it("baseline_red_declaration_invalid names entries outside testFiles, with absent files, and not observed", () => {
    const root = mkProject({ files: [FILE] });
    const runTests = vi.fn(e1Run);
    const outside = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE], runDir: null, runTests, baselineRedTests: ["tests/unit/test_nope.py::test_x"] });
    expect(outside.refusal.reason).toBe("baseline_red_declaration_invalid");
    expect(outside.refusal.invalidDeclarations).toEqual([{ entry: "tests/unit/test_nope.py::test_x", why: "not_in_testFiles" }]);

    const absent = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE, OTHER], runDir: null, runTests, baselineRedTests: [`${OTHER}::test_quote`] });
    expect(absent.refusal.reason).toBe("baseline_red_declaration_invalid");
    expect(absent.refusal.invalidDeclarations).toEqual([{ entry: `${OTHER}::test_quote`, why: "file_absent" }]);

    const typo = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE], runDir: null, runTests, baselineRedTests: [...E1_FAILED_IDS, `${F}test_typo`] });
    expect(typo.refusal.reason).toBe("baseline_red_declaration_invalid");
    expect(typo.refusal.invalidDeclarations).toEqual([{ entry: `${F}test_typo`, why: "id_not_observed", cause: "not_in_results" }]);
  });

  it("a per-test entry with unavailable results refuses baseline_red_results_unavailable and never falls back to file-level", () => {
    const root = mkProject();
    const runTests = vi.fn(() => ({ passed: false, skipped: false, exitCode: 1, summary: "tests failed", output: "",
      testResults: { available: false, reason: "runner_not_recognized", runner: null, failed: [], passed: [], skipped: [] } }));
    const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE, OTHER], runDir: null, runTests, baselineRedTests: [`${F}test_signature_generation`, OTHER] });
    expect(runTests).toHaveBeenCalledTimes(1);
    expect(r.proceed).toBe(false);
    expect(r.refusal.reason).toBe("baseline_red_results_unavailable");
    expect(r.refusal.runner).toBeNull();
    expect(r.refusal.resultsUnavailableReason).toBe("runner_not_recognized");
  });

  describe("file-level entries only, results unavailable (two-run exit-code fallback)", () => {
    const unavailable = { available: false, reason: "runner_not_recognized", runner: null, failed: [], passed: [], skipped: [] };
    const run = (passed) => ({ passed, skipped: false, exitCode: passed ? 0 : 1, summary: passed ? "all tests passed" : "tests failed", output: "", testResults: unavailable });

    it("runs remaining then declared files; proceeds with granularity file when remaining pass and declared fail", () => {
      const root = mkProject();
      const runTests = vi.fn().mockReturnValueOnce(run(true)).mockReturnValueOnce(run(false));
      const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE, OTHER], runDir: null, runTests, baselineRedTests: [FILE] });
      expect(runTests).toHaveBeenCalledTimes(2);
      expect(runTests.mock.calls[0][1].testPaths).toEqual([OTHER]);
      expect(runTests.mock.calls[1][1].testPaths).toEqual([FILE]);
      expect(r.proceed).toBe(true);
      expect(r.baselineRed.granularity).toBe("file");
      expect(r.baselineRed.stale).toEqual([]);
    });

    it("records the declared file as stale when it passes", () => {
      const root = mkProject();
      const runTests = vi.fn().mockReturnValueOnce(run(true)).mockReturnValueOnce(run(true));
      const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE, OTHER], runDir: null, runTests, baselineRedTests: [FILE] });
      expect(r.proceed).toBe(true);
      expect(r.baselineRed.stale).toEqual([FILE]);
    });

    it("refuses baseline_failed when the remaining files fail", () => {
      const root = mkProject();
      const runTests = vi.fn().mockReturnValueOnce(run(false)).mockReturnValueOnce(run(false));
      const r = runPreApplyBaseline({ projectRoot: root, storyTestFiles: [FILE, OTHER], runDir: null, runTests, baselineRedTests: [FILE] });
      expect(r.proceed).toBe(false);
      expect(r.refusal.reason).toBe("baseline_failed");
      expect(r.refusal.undeclaredFailing).toEqual([OTHER]);
      expect(r.refusal.baselineRed.granularity).toBe("file");
    });
  });
});

// ── exec.mjs wiring (source-level, delimiter-bounded) ───────────────

const count = (src, needle) => src.split(needle).length - 1;

/** The text between the `{` that follows `marker` (searched from `from`) and its matching `}`. */
function blockAfter(src, marker, from = 0) {
  const at = src.indexOf(marker, from);
  if (at === -1) return null;
  const open = src.indexOf("{", at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") { i = src.indexOf(ch, i + 1); continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { start: open + 1, end: i, text: src.slice(open + 1, i) };
  }
  return null;
}

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

describe("exec.mjs wiring", () => {
  const idxCheckout = EXEC_SRC.indexOf('"checkout", "-b"');
  const idxFixMode = EXEC_SRC.indexOf("testFixMode = isTestFixStory(");
  const idxCall = EXEC_SRC.indexOf("runPreApplyBaseline(");
  const GUARD = "if (!skipTests && appliedFiles.length > 0) {";

  it("reads baselineRedTests from the story and passes it to the single runPreApplyBaseline( call, after the branch chain", () => {
    expect(EXEC_SRC).toMatch(/earlyStory\.frontmatter\.baselineRedTests/);
    expect(count(EXEC_SRC, "runPreApplyBaseline(")).toBe(1);
    const iSkip = EXEC_SRC.indexOf("if (skipTests) {", idxFixMode);
    const iDecl = EXEC_SRC.indexOf("} else if (hasBaselineRedTests) {", idxFixMode);
    const iExempt = EXEC_SRC.indexOf('"test_fix_exemption"', idxFixMode);
    expect(idxFixMode).toBeGreaterThan(-1);
    expect(iSkip).toBeGreaterThan(idxFixMode);
    expect(iDecl).toBeGreaterThan(iSkip);
    expect(iExempt).toBeGreaterThan(iDecl);
    expect(idxCall).toBeGreaterThan(iExempt);
    expect(idxCall).toBeLessThan(idxCheckout);
    const callArgs = EXEC_SRC.slice(idxCall, EXEC_SRC.indexOf(")", idxCall));
    expect(callArgs).toContain("runTests: runProjectTests");
    expect(callArgs).toContain("baselineRedTests");
  });

  it("the declaration branch sets no skip, and the call is guarded by !baselineSkipped", () => {
    const decl = blockAfter(EXEC_SRC, "} else if (hasBaselineRedTests) {", idxFixMode);
    expect(decl.text).not.toMatch(/baselineSkipped\s*=/);
    expect(decl.text).not.toMatch(/baselineSkipReason\s*=/);
    const guarded = blockAfter(EXEC_SRC, "if (!baselineSkipped) {", idxFixMode);
    expect(guarded.start).toBeLessThan(idxCall);
    expect(guarded.end).toBeGreaterThan(idxCall);
  });

  it("skipTests is unchanged: the skip_tests branch sets baselineSkipped true and precedes any baseline run", () => {
    const skip = blockAfter(EXEC_SRC, "if (skipTests) {", idxFixMode);
    expect(skip.text).toMatch(/baselineSkipped\s*=\s*true/);
    expect(skip.text).toContain('"skip_tests"');
    expect(skip.text).not.toContain("runPreApplyBaseline");
    expect(skip.end).toBeLessThan(idxCall);
  });

  it("the pre-apply block has exactly one exec.failed emit, carrying baseline.refusal.reason", () => {
    const block = blockAfter(EXEC_SRC, "if (!baseline.proceed) {", idxCall);
    const inBlock = emitCalls(EXEC_SRC).filter((c) => c.index > block.start && c.index < block.end);
    expect(inBlock).toHaveLength(1);
    const [c] = inBlock;
    expect(c.args[0]).toBe('"exec.failed"');
    expect(c.args[2]).toMatch(/reason:\s*baseline\.refusal\.reason\b/);
    expect(c.args[2]).not.toMatch(/reason:\s*"baseline_failed"/);
    expect(c.args[2]).not.toMatch(/testsFailed:\s*true/);
    expect(block.text).toContain("return baseline.refusal;");
  });

  it("post-apply collects results only for per-test entries and fails the attempt on declaredNotPassing", () => {
    expect(EXEC_SRC).toMatch(/const baselineRedPerTest = hasBaselineRedTests && baselineRedTests\.some\(/);
    expect(EXEC_SRC).toMatch(/const verifyCollectOptions = \(attempt\) => \(baselineRedPerTest\s*\?\s*\{ collectTestResults:/);
    const guard = blockAfter(EXEC_SRC, GUARD);
    expect(guard.start).toBeGreaterThan(idxCheckout);
    expect(guard.text).toContain("runProjectTests(projectRoot, { testPaths: storyTestFiles, ...verifyCollectOptions(attemptNumber) })");
    expect(guard.text).toContain("evaluateDeclaredPostApply({ entries: baselineRedTests, results: verification.testResults");
    expect(guard.text).toContain("if (verification.passed && declaredNotPassing.length === 0) {");
    // Exactly one testsFailed: true emit exists in the whole file — no new one for declaredNotPassing.
    expect(emitCalls(EXEC_SRC).filter((c) => /\btestsFailed:\s*true\b/.test(c.args[2] || ""))).toHaveLength(1);
  });

  it("the pending_ship and tests_exhausted results carry baselineRed alongside the baseline* keys", () => {
    const KEYS = ["baselineSkipped", "baselineSkipReason", "baselineAbsentPaths", "baselineTestPaths", "baselineRed:"];
    const idxStatus = EXEC_SRC.indexOf("status: 'pending_ship'");
    const shipObj = EXEC_SRC.slice(EXEC_SRC.lastIndexOf("return {", idxStatus), EXEC_SRC.indexOf("};", idxStatus));
    const idxReason = EXEC_SRC.indexOf('reason: "tests_exhausted"');
    const exhaustedStart = EXEC_SRC.indexOf("return {", idxReason);
    const exhaustedObj = EXEC_SRC.slice(exhaustedStart, EXEC_SRC.indexOf("};", exhaustedStart));
    for (const k of KEYS) {
      expect(shipObj, k).toContain(k);
      expect(exhaustedObj, k).toContain(k);
    }
  });

  it("inside if (verification.skipped) a declaration routes to verification_skipped and the failed-attempt path", () => {
    const skipped = blockAfter(EXEC_SRC, "if (verification.skipped) {");
    expect(skipped).not.toBeNull();
    const inner = blockAfter(skipped.text, "if (!hasBaselineRedTests) {");
    expect(inner.text).toMatch(/testsSkipped\s*=\s*true;\s*break;/);
    const outside = skipped.text.slice(0, inner.start) + skipped.text.slice(inner.end);
    expect(outside).not.toMatch(/testsSkipped\s*=\s*true/);
    expect(outside).not.toMatch(/\bbreak;/);
    expect(outside).toContain("evaluateDeclaredPostApply({ entries: baselineRedTests, results: null, verificationSkipped: true })");
    expect(outside).toContain("declaredNotPassing");
  });

  it("when the post-apply guard is false, postApply is { ran: false, notRunReason } with no declared* keys", () => {
    const guard = blockAfter(EXEC_SRC, GUARD);
    const after = EXEC_SRC.slice(guard.end + 1);
    expect(after).toMatch(/^\s*else\s*\{/);
    const elseBlock = blockAfter(EXEC_SRC, "else {", guard.end);
    expect(elseBlock.text).toContain('baselineRedPostApply = { ran: false, notRunReason: skipTests ? "skip_tests" : "no_files_applied" };');
    expect(elseBlock.text).not.toContain("declaredPassed");
    expect(elseBlock.text).not.toContain("declaredNotPassing");
    expect(elseBlock.text).toMatch(/testsSkipped\s*=\s*true/);
  });

  it("verification.output is annotated before the tests-failed log write; both testOutput literals are unchanged", () => {
    const guard = blockAfter(EXEC_SRC, GUARD);
    const iAnnotate = guard.text.indexOf("verification.output = formatDeclaredNotPassing(declaredNotPassing, verification.output);");
    const iLog = guard.text.indexOf("fs.writeFileSync(testLogPath");
    expect(iAnnotate).toBeGreaterThan(-1);
    expect(iLog).toBeGreaterThan(iAnnotate);
    expect(count(EXEC_SRC, 'testOutput: verification.output || ""')).toBe(1);
    expect(count(EXEC_SRC, 'testOutput: lastVerification?.output || ""')).toBe(1);
  });
});

// ── dendron ARRAY_FIELDS ────────────────────────────────────────────

describe("ARRAY_FIELDS", () => {
  const seedNote = (fm) => {
    const dir = mkTmp();
    const lines = Object.entries({ id: "s", title: "S", created: 1, updated: 2, ...fm })
      .map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${JSON.stringify(v)}`))
      .join("\n");
    fs.writeFileSync(path.join(dir, "s.md"), `---\n${lines}\n---\n\nbody\n`);
    return dir;
  };

  it("contains baselineRedTests, so the it.each shrink refusal covers it", () => {
    expect(ARRAY_FIELDS.has("baselineRedTests")).toBe(true);
    let dir = seedNote({ baselineRedTests: ["a", "b", "c"] });
    expect(updateFieldDirect(dir, "s.md", "baselineRedTests", ["a"], { skipEmbed: true }).ok).toBe(false);
    dir = seedNote({ baselineRedTests: ["a", "b", "c"] });
    expect(updateField(dir, "s.md", "baselineRedTests", '["a"]', { skipEmbed: true }).ok).toBe(false);
  });

  it("an updateFieldDirect write of ids with ::, [ ], ' > ' and ': ' round-trips byte-identically", () => {
    const dir = seedNote({});
    const ids = [
      "tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_signature_generation",
      "tests/unit/test_q.py::test_quote[BTC - USD spot]",
      "tests/unit/foo.test.mjs > suite > case: with colon",
      "tests/reliability/test_api_health_endpoints.py",
    ];
    expect(updateFieldDirect(dir, "s.md", "baselineRedTests", ids, { skipEmbed: true }).ok).toBe(true);
    const back = parseFrontmatter(fs.readFileSync(path.join(dir, "s.md"), "utf8")).data.baselineRedTests;
    expect(back).toEqual(ids);
  });
});
