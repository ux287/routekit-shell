/**
 * Pure unit tests for packages/mcp-rks/src/exec/test-results.mjs
 * (backlog.feat.exec-declared-red-baseline-tests). No subprocess is spawned:
 * parsers are driven from captured pytest output text and vitest JSON fixtures.
 *
 * Fixture provenance: E1, E2 and the E3(d) log lines are copied byte-for-byte from the story
 * note's "Measured pytest evidence". Shapes known only from pytest source (ERROR, XFAIL, XPASS,
 * parametrized ids, term spellings absent from E1/E2) are synthetic, built to the E4 format
 * strings, and every test using one carries [src-synthetic] in its name.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectResultAdapter,
  parseDeclaredEntry,
  resultCollectionArgs,
  parsePytestSummary,
  parseVitestJsonReport,
  evaluateDeclaredRed,
  evaluateDeclaredPostApply,
  formatDeclaredNotPassing,
} from "../../packages/mcp-rks/src/exec/test-results.mjs";

const F = "tests/unit/test_robinhood_client.py::TestRobinhoodClient::";
const FILE = "tests/unit/test_robinhood_client.py";

// ── E1 [peer], verbatim ─────────────────────────────────────────────
const E1_HEADER = "=========================== short test summary info ============================";
const E1_PASSED = [
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
];
const E1_FAILED = [
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_crypto_price_success - assert None == 50000.0",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_account_info_success - AssertionError: assert {'results': [...': '150.25'}]} == {'buying_powe...ay...",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_get_crypto_positions_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_crypto_buy_order_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_crypto_sell_order_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_place_limit_order_success - AssertionError: expected call not found.",
  "FAILED tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_signature_generation - AssertionError: expected call not found.",
];
const E1_COUNTS = "=================== 7 failed, 12 passed, 2 warnings in 0.43s ===================";
const E1_REGION = [E1_HEADER, ...E1_PASSED, ...E1_FAILED];
const E1 = [...E1_REGION, E1_COUNTS].join("\n");

const E1_PASSED_IDS = E1_PASSED.map((l) => l.slice("PASSED ".length));
const E1_FAILED_IDS = [
  `${F}test_get_crypto_price_success`,
  `${F}test_get_account_info_success`,
  `${F}test_get_crypto_positions_success`,
  `${F}test_place_crypto_buy_order_success`,
  `${F}test_place_crypto_sell_order_success`,
  `${F}test_place_limit_order_success`,
  `${F}test_signature_generation`,
];

// ── E2 [peer], verbatim ─────────────────────────────────────────────
const E2_SKIPPED = [
  "SKIPPED [1] tests/reliability/test_frontend_integration.py:295: Requires Playwright MCP server - implement when available",
  "SKIPPED [1] tests/reliability/test_frontend_integration.py:312: Requires Playwright MCP server - implement when available",
  "SKIPPED [1] tests/reliability/test_frontend_integration.py:327: Requires Playwright MCP server - implement when available",
  "SKIPPED [1] tests/reliability/test_frontend_integration.py:347: Requires Playwright MCP server - implement when available",
  "SKIPPED [1] tests/reliability/test_frontend_integration.py:368: Requires Playwright MCP server - implement when available",
];

// ── E3(d) [peer], verbatim ──────────────────────────────────────────
const E3D_LOG_LINES = [
  "ERROR    api_server:api_server.py:302 System health check failed: object SystemHealthSummary can't be used in 'await' expression",
  "CRITICAL src.core.system_health:system_health.py:775    • robinhood_client: Health check failed: Initial failure",
  "WARNING  src.execution.order_executor:order_executor.py:424 ❌ Order placement failed on attempt 1",
];

/** A synthetic region under the E1 header with the given counts line. */
const region = (lines, counts) => [E1_HEADER, ...lines, counts].join("\n");
const sameAsE1 = (r) => {
  expect(r.available).toBe(true);
  expect(r.failed).toEqual(E1_FAILED_IDS);
  expect(r.passed).toEqual(E1_PASSED_IDS);
};

describe("detectResultAdapter", () => {
  it("recognizes pytest invocations", () => {
    expect(detectResultAdapter("pytest", [])).toBe("pytest");
    expect(detectResultAdapter("py.test", ["-q"])).toBe("pytest");
    expect(detectResultAdapter("python", ["-m", "pytest"])).toBe("pytest");
    expect(detectResultAdapter("uv", ["run", "pytest"])).toBe("pytest");
    expect(detectResultAdapter(".venv/bin/pytest", ["-q"])).toBe("pytest");
  });

  it("recognizes vitest invocations and returns null for anything else", () => {
    expect(detectResultAdapter("node", ["scripts/vitest-runner.mjs"])).toBe("vitest");
    expect(detectResultAdapter("npx", ["vitest", "run"])).toBe("vitest");
    expect(detectResultAdapter("npm", ["test"])).toBeNull();
    expect(detectResultAdapter("make", ["test"])).toBeNull();
    expect(detectResultAdapter("npx", ["jest"])).toBeNull();
  });
});

describe("resultCollectionArgs", () => {
  it("returns the per-adapter collection flags", () => {
    expect(resultCollectionArgs("pytest", {})).toEqual(["-rA", "--color=no"]);
    expect(resultCollectionArgs("vitest", { builtin: true, reportPath: "/abs/r.json" })).toEqual(["--json-output", "/abs/r.json"]);
    expect(resultCollectionArgs("vitest", { builtin: false, reportPath: "/abs/r.json" }))
      .toEqual(["--reporter=default", "--reporter=json", "--outputFile.json=/abs/r.json"]);
    expect(resultCollectionArgs(null, {})).toEqual([]);
  });
});

describe("parseDeclaredEntry", () => {
  it("splits a pytest node id", () => {
    const e = parseDeclaredEntry(`${F}test_signature_generation`);
    expect(e).toEqual({ file: FILE, style: "pytest", testId: `${F}test_signature_generation` });
  });

  it("keeps a parametrized pytest id intact", () => {
    const e = parseDeclaredEntry("tests/unit/test_market_data.py::test_quote[BTC-USD]");
    expect(e.file).toBe("tests/unit/test_market_data.py");
    expect(e.testId).toBe("tests/unit/test_market_data.py::test_quote[BTC-USD]");
  });

  it("treats a ' > ' id as vitest and a bare path as file-level", () => {
    expect(parseDeclaredEntry("tests/unit/foo.test.mjs > suite > case"))
      .toEqual({ file: "tests/unit/foo.test.mjs", style: "vitest", testId: "tests/unit/foo.test.mjs > suite > case" });
    expect(parseDeclaredEntry("tests/reliability/test_api_health_endpoints.py"))
      .toEqual({ file: "tests/reliability/test_api_health_endpoints.py", style: "file", testId: null });
  });
});

describe("parsePytestSummary — E1", () => {
  it("E1 verbatim yields exactly the 7 failed and 12 passed ids; 2 warnings is ignored", () => {
    const r = parsePytestSummary(E1);
    sameAsE1(r);
    expect(r.failed).toHaveLength(7);
    expect(r.passed).toHaveLength(12);
    expect(r.passed).toContain("tests/unit/test_robinhood_client.py::TestRobinhoodClientIntegration::test_authenticated_workflow");
    expect(r.passed).toContain("tests/unit/test_robinhood_client.py::TestRobinhoodClientPerformance::test_order_placement_latency");
    expect(r.runner).toBe("pytest");
  });

  it("E1 with the counts line altered to 8 failed → count_mismatch", () => {
    const r = parsePytestSummary(E1.replace("7 failed", "8 failed"));
    expect(r).toMatchObject({ available: false, reason: "count_mismatch" });
  });

  it("a progress line alone, and empty output → summary_absent", () => {
    expect(parsePytestSummary("tests/unit/test_robinhood_client.py ....F..FFFF.FF.....")).toMatchObject({ available: false, reason: "summary_absent" });
    expect(parsePytestSummary("")).toMatchObject({ available: false, reason: "summary_absent" });
  });

  it("header absent: no tests ran → available with empty sets; 3 passed → summary_absent", () => {
    const empty = parsePytestSummary("collected 0 items\n\n============================ no tests ran in 0.01s =============================");
    expect(empty.available).toBe(true);
    for (const k of ["passed", "failed", "error", "xfailed", "xpassed", "skipped"]) expect(empty[k], k).toEqual([]);
    const r = parsePytestSummary("collected 3 items\n\n============================== 3 passed in 0.01s ===============================");
    expect(r).toMatchObject({ available: false, reason: "summary_absent" });
  });
});

describe("parsePytestSummary — outcome model", () => {
  it("[src-synthetic] ERROR collection and test-id lines are failing, reconciled against 1 error and 2 errors", () => {
    const one = parsePytestSummary(region(["ERROR tests/unit/test_broken.py"], "=============== 1 error in 0.10s ==============="));
    expect(one.available).toBe(true);
    expect(one.error).toEqual(["tests/unit/test_broken.py"]);
    expect(one.failing).toEqual(["tests/unit/test_broken.py"]);
    const two = parsePytestSummary(region([
      "ERROR tests/unit/test_broken.py",
      "ERROR tests/unit/test_a.py::test_b - RuntimeError: teardown - failed",
    ], "=============== 2 errors in 0.10s ==============="));
    expect(two.available).toBe(true);
    expect(two.error).toEqual(["tests/unit/test_broken.py", "tests/unit/test_a.py::test_b"]);
    expect(two.failing).toContain("tests/unit/test_a.py::test_b");
  });

  it("E2's 5 SKIPPED lines verbatim → skippedCount 5 and no skipped ids; 4 skipped → count_mismatch", () => {
    const r = parsePytestSummary(region(E2_SKIPPED, "====== 5 skipped, 30 warnings in 160.55s (0:02:40) ======"));
    expect(r.available).toBe(true);
    expect(r.skippedCount).toBe(5);
    expect(r.skipped).toEqual([]);
    const bad = parsePytestSummary(region(E2_SKIPPED, "====== 4 skipped, 30 warnings in 160.55s (0:02:40) ======"));
    expect(bad).toMatchObject({ available: false, reason: "count_mismatch" });
  });

  it("[src-synthetic] XFAIL (space-hyphen-space) and XPASS (plain space) land in xfailed/xpassed, not failing", () => {
    const r = parsePytestSummary(region([
      "XFAIL tests/unit/test_x.py::test_known - bug #12 - upstream",
      "XPASS tests/unit/test_x.py::test_lucky unexpectedly fixed",
    ], "========= 1 xfailed, 1 xpassed in 0.20s ========="));
    expect(r.available).toBe(true);
    expect(r.xfailed).toEqual(["tests/unit/test_x.py::test_known"]);
    expect(r.xpassed).toEqual(["tests/unit/test_x.py::test_lucky"]);
    expect(r.failing).toEqual([]);
    const noTerm = parsePytestSummary(region(["XFAIL tests/unit/test_x.py::test_known - bug"], "========= 1 passed in 0.20s ========="));
    expect(noTerm).toMatchObject({ available: false, reason: "count_mismatch" });
  });

  it("[src-synthetic] records deselected as deselectedCount and ignores warning/warnings", () => {
    const r = parsePytestSummary(region([E1_PASSED[0]], "===== 1 passed, 4 deselected, 1 warning in 0.20s ====="));
    expect(r.available).toBe(true);
    expect(r.deselectedCount).toBe(4);
    expect(parsePytestSummary(region([E1_PASSED[0]], "===== 1 passed, 3 warnings in 0.20s =====")).available).toBe(true);
  });

  it("[src-synthetic] rerun/reruns → rerun_not_supported; an unknown term → unrecognized_summary_term", () => {
    expect(parsePytestSummary(region([E1_PASSED[0]], "===== 1 passed, 1 rerun in 0.20s ====="))).toMatchObject({ available: false, reason: "rerun_not_supported" });
    expect(parsePytestSummary(region([E1_PASSED[0]], "===== 1 passed, 2 reruns in 0.20s ====="))).toMatchObject({ available: false, reason: "rerun_not_supported" });
    expect(parsePytestSummary(region([E1_PASSED[0]], "===== 1 passed, 2 flaked in 0.20s ====="))).toMatchObject({ available: false, reason: "unrecognized_summary_term" });
  });

  it("[src-synthetic] teardown dual outcome — PASSED+ERROR and PASSED+FAILED ids are failing, not passed", () => {
    const id = "tests/unit/test_t.py::test_teardown";
    const withError = parsePytestSummary(region([`PASSED ${id}`, `ERROR ${id} - teardown failed`], "===== 1 passed, 1 error in 0.20s ====="));
    expect(withError.available).toBe(true);
    expect(withError.failing).toContain(id);
    expect(withError.passed).not.toContain(id);
    const withFailed = parsePytestSummary(region([`PASSED ${id}`, `FAILED ${id} - boom`], "===== 1 failed, 1 passed in 0.20s ====="));
    expect(withFailed.available).toBe(true);
    expect(withFailed.failed).toContain(id);
    expect(withFailed.passed).not.toContain(id);
  });
});

describe("parsePytestSummary — measured traps", () => {
  it("trap (b): the bare (-q) counts line gives the E1 result; no counts line → summary_counts_absent", () => {
    sameAsE1(parsePytestSummary([...E1_REGION, "7 failed, 12 passed, 2 warnings in 0.43s"].join("\n")));
    expect(parsePytestSummary(E1_REGION.join("\n"))).toMatchObject({ available: false, reason: "summary_counts_absent" });
  });

  it("trap (c): a coverage block after the counts line, and a warnings section before it, give the E1 result", () => {
    const coverage = [
      "",
      "---------- coverage: platform darwin, python 3.11.16-final-0 -----------",
      "Name                          Stmts   Miss  Cover   Missing",
      "-----------------------------------------------------------",
      "src/robinhood_client.py         210     42    80%   12-18, 77",
      "TOTAL                          4210    812    81%",
    ];
    sameAsE1(parsePytestSummary([E1, ...coverage].join("\n")));
    const warnings = [
      "=============================== warnings summary (final) ===============================",
      "tests/unit/test_robinhood_client.py::TestRobinhoodClient::test_initialization",
      "  /venv/lib/python3.11/site-packages/x.py:10: DeprecationWarning: old api",
      "",
      "-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html",
    ];
    sameAsE1(parsePytestSummary([...E1_REGION, ...warnings, E1_COUNTS].join("\n")));
  });

  it("trap (d): E3(d) log lines before the header are ignored; as the first region lines → unrecognized_summary_line", () => {
    const before = parsePytestSummary([...E3D_LOG_LINES, E1].join("\n"));
    sameAsE1(before);
    expect(before.error).toEqual([]);
    const inside = parsePytestSummary([E1_HEADER, ...E3D_LOG_LINES, ...E1_PASSED, ...E1_FAILED, E1_COUNTS].join("\n"));
    expect(inside).toMatchObject({ available: false, reason: "unrecognized_summary_line" });
    expect(inside.error ?? []).toEqual([]);
  });

  it("[src-synthetic] id rule: a parametrized id holding ' - ' is kept whole; E1's == message leaks nothing; strict XPASS lands in failed", () => {
    const r = parsePytestSummary(region([
      "FAILED tests/unit/test_q.py::test_quote[BTC - USD spot] - AssertionError: a - b",
      "FAILED tests/unit/test_q.py::test_strict",
      E1_FAILED[1],
    ], "===== 3 failed in 0.20s ====="));
    expect(r.available).toBe(true);
    expect(r.failed).toEqual([
      "tests/unit/test_q.py::test_quote[BTC - USD spot]",
      "tests/unit/test_q.py::test_strict",
      `${F}test_get_account_info_success`,
    ]);
  });
});

describe("parseVitestJsonReport (fixture written to a tmp dir)", () => {
  const tmpDirs = [];
  afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });
  const writeReport = (root, body) => {
    const p = path.join(root, "report.json");
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return fs.readFileSync(p, "utf8");
  };
  const mkRoot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-vitest-report-")); tmpDirs.push(d); return d; };

  it("maps absolute testResults[].name to project-relative ids with statuses", () => {
    const root = mkRoot();
    const text = writeReport(root, {
      testResults: [{
        name: path.join(root, "tests/unit/foo.test.mjs"),
        status: "failed",
        assertionResults: [
          { ancestorTitles: ["outer", ""], title: "inner title", status: "passed" },
          { ancestorTitles: ["outer"], title: "breaks", status: "failed" },
          { ancestorTitles: [], title: "later", status: "skipped" },
          { ancestorTitles: ["outer"], title: "p", status: "pending" },
          { ancestorTitles: ["outer"], title: "t", status: "todo" },
        ],
      }],
    });
    const r = parseVitestJsonReport(text, root);
    expect(r.available).toBe(true);
    expect(r.runner).toBe("vitest");
    expect(r.passed).toEqual(["tests/unit/foo.test.mjs > outer > inner title"]);
    expect(r.failed).toEqual(["tests/unit/foo.test.mjs > outer > breaks"]);
    expect(r.skipped).toEqual([
      "tests/unit/foo.test.mjs > later",
      "tests/unit/foo.test.mjs > outer > p",
      "tests/unit/foo.test.mjs > outer > t",
    ]);
  });

  it("a failed file with no assertion results is a file-level failing id; missing or invalid JSON is unavailable", () => {
    const root = mkRoot();
    const text = writeReport(root, { testResults: [{ name: path.join(root, "tests/unit/broken.test.mjs"), status: "failed", assertionResults: [] }] });
    const r = parseVitestJsonReport(text, root);
    expect(r.available).toBe(true);
    expect(r.failed).toEqual(["tests/unit/broken.test.mjs"]);
    expect(parseVitestJsonReport(null, root).available).toBe(false);
    expect(parseVitestJsonReport(writeReport(root, "{ not json"), root).available).toBe(false);
  });
});

describe("evaluateDeclaredRed", () => {
  const testFiles = [FILE, "tests/unit/test_market_data.py"];
  const existingTestFiles = [...testFiles];
  const e1 = parsePytestSummary(E1);

  it("proceeds when failing ids ⊆ declared, reporting the exact observed failing ids", () => {
    const r = evaluateDeclaredRed({ entries: E1_FAILED_IDS, testFiles, existingTestFiles, results: e1 });
    expect(r.ok).toBe(true);
    expect(r.observedFailing).toEqual(E1_FAILED_IDS);
    expect(r.stale).toEqual([]);
  });

  it("rejects baseline_failed naming an undeclared failing id", () => {
    const results = parsePytestSummary(E1
      .replace(`PASSED ${F}test_cancel_order\n`, "")
      .replace(E1_COUNTS, `FAILED ${F}test_cancel_order - AssertionError: wrong path\n=================== 8 failed, 11 passed, 2 warnings in 0.43s ===================`));
    expect(results.available).toBe(true);
    const r = evaluateDeclaredRed({ entries: E1_FAILED_IDS, testFiles, existingTestFiles, results });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("baseline_failed");
    expect(r.undeclaredFailing).toEqual([`${F}test_cancel_order`]);
  });

  it("stale: a declared pytest id observed passed is stale and proceeds; vitest passed or skipped is stale; pytest never skips per id", () => {
    const r = evaluateDeclaredRed({ entries: [...E1_FAILED_IDS, `${F}test_cancel_order`], testFiles, existingTestFiles, results: e1 });
    expect(r.ok).toBe(true);
    expect(r.stale).toEqual([`${F}test_cancel_order`]);
    expect(e1.skipped).toEqual([]);

    const vFile = "tests/unit/foo.test.mjs";
    const vitest = { available: true, runner: "vitest", passed: [`${vFile} > a`], failed: [], error: [], failing: [], xfailed: [], xpassed: [], skipped: [`${vFile} > b`] };
    const v = evaluateDeclaredRed({ entries: [`${vFile} > a`, `${vFile} > b`], testFiles: [vFile], existingTestFiles: [vFile], results: vitest });
    expect(v.ok).toBe(true);
    expect(v.stale).toEqual([`${vFile} > a`, `${vFile} > b`]);
  });

  it("rejects baseline_red_declaration_invalid for not_in_testFiles, file_absent and id_not_observed", () => {
    const notIn = evaluateDeclaredRed({ entries: ["tests/unit/test_other.py::test_x"], testFiles, existingTestFiles, results: e1 });
    expect(notIn).toMatchObject({ ok: false, reason: "baseline_red_declaration_invalid" });
    expect(notIn.invalidDeclarations).toEqual([{ entry: "tests/unit/test_other.py::test_x", why: "not_in_testFiles" }]);
    const absent = evaluateDeclaredRed({ entries: ["tests/unit/test_market_data.py::test_q"], testFiles, existingTestFiles: [FILE], results: e1 });
    expect(absent.invalidDeclarations).toEqual([{ entry: "tests/unit/test_market_data.py::test_q", why: "file_absent" }]);
    const typo = evaluateDeclaredRed({ entries: [...E1_FAILED_IDS, `${F}test_typo`], testFiles, existingTestFiles, results: e1 });
    expect(typo.reason).toBe("baseline_red_declaration_invalid");
    expect(typo.invalidDeclarations).toEqual([{ entry: `${F}test_typo`, why: "id_not_observed", cause: "not_in_results" }]);
  });

  it("pytest id_not_observed cause: pytest_skip_unattributable, deselected_or_absent, not_in_results", () => {
    const base = { available: true, runner: "pytest", passed: [], failed: [], error: [], failing: [], xfailed: [], xpassed: [], skipped: [] };
    const cause = (extra) => evaluateDeclaredRed({ entries: [`${F}test_gone`], testFiles, existingTestFiles, results: { ...base, ...extra } }).invalidDeclarations[0];
    expect(cause({ skippedCount: 5, deselectedCount: 2 })).toEqual({ entry: `${F}test_gone`, why: "id_not_observed", cause: "pytest_skip_unattributable" });
    expect(cause({ skippedCount: 0, deselectedCount: 2 }).cause).toBe("deselected_or_absent");
    expect(cause({ skippedCount: 0, deselectedCount: 0 }).cause).toBe("not_in_results");
  });

  it("[src-synthetic] pytest xfailed/xpassed declared → outcome_not_declarable; undeclared ones do not cause baseline_failed", () => {
    const xOnly = parsePytestSummary(region([
      `XFAIL ${F}test_xf - known`,
      `XPASS ${F}test_xp lucky`,
    ], "===== 1 xfailed, 1 xpassed in 0.20s ====="));
    const declared = evaluateDeclaredRed({ entries: [`${F}test_xf`, `${F}test_xp`], testFiles, existingTestFiles, results: xOnly });
    expect(declared.reason).toBe("baseline_red_declaration_invalid");
    expect(declared.invalidDeclarations).toEqual([
      { entry: `${F}test_xf`, why: "outcome_not_declarable", outcome: "xfailed" },
      { entry: `${F}test_xp`, why: "outcome_not_declarable", outcome: "xpassed" },
    ]);
    const results = parsePytestSummary(region([
      `XFAIL ${F}test_xf - known`,
      `XPASS ${F}test_xp lucky`,
      `FAILED ${F}test_signature_generation - boom`,
    ], "===== 1 failed, 1 xfailed, 1 xpassed in 0.20s ====="));
    const undeclared = evaluateDeclaredRed({ entries: [`${F}test_signature_generation`], testFiles, existingTestFiles, results });
    expect(undeclared.ok).toBe(true);
    expect(undeclared.observedFailing).toEqual([`${F}test_signature_generation`]);
  });

  it("a file-level entry allows every failing id in the file, lists exact ids, and is stale with none failing", () => {
    const r = evaluateDeclaredRed({ entries: [FILE], testFiles, existingTestFiles, results: e1 });
    expect(r.ok).toBe(true);
    expect(r.observedFailing).toEqual(E1_FAILED_IDS);
    expect(r.stale).toEqual([]);
    const green = parsePytestSummary(region(E1_PASSED, "===== 12 passed in 0.20s ====="));
    expect(evaluateDeclaredRed({ entries: [FILE], testFiles, existingTestFiles, results: green }).stale).toEqual([FILE]);
  });
});

describe("evaluateDeclaredPostApply", () => {
  const base = { available: true, runner: "pytest", passed: [], failed: [], error: [], failing: [], xfailed: [], xpassed: [], skipped: [], skippedCount: 0, deselectedCount: 0 };

  it("names every non-passing outcome, and a passed+failing id is not passing", () => {
    const pytest = {
      ...base,
      passed: ["t.py::ok", "t.py::both"],
      failed: ["t.py::f", "t.py::both"],
      error: ["t.py::e"],
      failing: ["t.py::f", "t.py::both", "t.py::e"],
      xfailed: ["t.py::xf"],
      xpassed: ["t.py::xp"],
      skippedCount: 1,
    };
    const r = evaluateDeclaredPostApply({ entries: ["t.py::ok", "t.py::both", "t.py::f", "t.py::e", "t.py::xf", "t.py::xp", "t.py::gone"], results: pytest, verificationSkipped: false });
    expect(r.declaredPassed).toEqual(["t.py::ok"]);
    expect(r.declaredNotPassing).toEqual([
      { id: "t.py::both", outcome: "failed" },
      { id: "t.py::f", outcome: "failed" },
      { id: "t.py::e", outcome: "error" },
      { id: "t.py::xf", outcome: "xfailed" },
      { id: "t.py::xp", outcome: "xpassed" },
      { id: "t.py::gone", outcome: "not_observed", cause: "pytest_skip_unattributable" },
    ]);

    const vitest = { ...base, runner: "vitest", skipped: ["a.test.mjs > s"] };
    expect(evaluateDeclaredPostApply({ entries: ["a.test.mjs > s"], results: vitest, verificationSkipped: false }).declaredNotPassing)
      .toEqual([{ id: "a.test.mjs > s", outcome: "skipped" }]);
    expect(evaluateDeclaredPostApply({ entries: ["t.py::ok"], results: { available: false, reason: "count_mismatch" }, verificationSkipped: false }).declaredNotPassing)
      .toEqual([{ id: "t.py::ok", outcome: "results_unavailable" }]);
  });

  it("every declared id observed passed → empty declaredNotPassing", () => {
    const r = evaluateDeclaredPostApply({ entries: E1_PASSED_IDS.slice(0, 3), results: parsePytestSummary(E1), verificationSkipped: false });
    expect(r.declaredNotPassing).toEqual([]);
    expect(r.declaredPassed).toEqual(E1_PASSED_IDS.slice(0, 3));
  });

  it("verificationSkipped with a non-empty declaration → every entry verification_skipped", () => {
    const r = evaluateDeclaredPostApply({ entries: [`${F}test_signature_generation`, FILE], results: null, verificationSkipped: true });
    expect(r.declaredNotPassing).toEqual([
      { id: `${F}test_signature_generation`, outcome: "verification_skipped" },
      { id: FILE, outcome: "verification_skipped" },
    ]);
  });
});

describe("formatDeclaredNotPassing", () => {
  it("names each id and outcome ahead of the original output; identity for an empty list", () => {
    const out = "=== 1 failed in 0.1s ===";
    const text = formatDeclaredNotPassing([{ id: "t.py::a", outcome: "failed" }, { id: "t.py::b", outcome: "not_observed", cause: "not_in_results" }], out);
    expect(text.indexOf("t.py::a")).toBeGreaterThan(-1);
    expect(text).toContain("failed");
    expect(text).toContain("t.py::b");
    expect(text).toContain("not_observed");
    expect(text.indexOf("t.py::b")).toBeLessThan(text.indexOf(out));
    expect(text.endsWith(out)).toBe(true);
    expect(formatDeclaredNotPassing([], out)).toBe(out);
  });
});
