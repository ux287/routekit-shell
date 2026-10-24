import { describe, it, expect } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as testRunner from "../../packages/mcp-rks/src/server/test-runner.mjs";
import { parseTestCounts } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const SRC_ROOT = fileURLToPath(new URL("../../packages/mcp-rks/src/", import.meta.url));
const src = (rel) => fs.readFileSync(path.join(SRC_ROOT, rel), "utf8");

describe("parseTestCounts", () => {
  it("extracts passed count from vitest all-pass output", () => {
    const output = `
 ✓ tests/unit/foo.test.mjs (3 tests) 5ms
 ✓ tests/unit/bar.test.mjs (2 tests) 3ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  10:00:00
   Duration  1.2s
`;
    expect(parseTestCounts(output)).toEqual({ passCount: 5, failCount: 0, countsSource: "vitest", countsUnavailableReason: null });
  });

  it("extracts both failed and passed from mixed output", () => {
    const output = `
 ✗ tests/unit/foo.test.mjs (1 test) 5ms
 ✓ tests/unit/bar.test.mjs (2 tests) 3ms

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 2 passed (3)
   Start at  10:00:00
   Duration  1.5s
`;
    expect(parseTestCounts(output)).toEqual({ passCount: 2, failCount: 1, countsSource: "vitest", countsUnavailableReason: null });
  });

  it("returns null counts with a reason for empty or null output", () => {
    for (const empty of [null, "", undefined]) {
      const r = parseTestCounts(empty);
      expect(r).toMatchObject({ passCount: null, failCount: null, countsSource: null });
      expect(typeof r.countsUnavailableReason).toBe("string");
      expect(r.countsUnavailableReason.length).toBeGreaterThan(0);
    }
  });

  it("returns null counts with a distinct reason when no summary line exists", () => {
    const output = "some random output\nno test summary here\n";
    const r = parseTestCounts(output);
    expect(r).toMatchObject({ passCount: null, failCount: null, countsSource: null });
    expect(typeof r.countsUnavailableReason).toBe("string");
    expect(r.countsUnavailableReason.length).toBeGreaterThan(0);
    expect(r.countsUnavailableReason).not.toBe(parseTestCounts("").countsUnavailableReason);
  });

  it("decision 7a: jest's 'Tests:' summary line is not parsed", () => {
    const r = parseTestCounts("Tests:       5 passed, 5 total\n");
    expect(r).toMatchObject({ passCount: null, failCount: null, countsSource: null });
    expect(r.countsUnavailableReason.length).toBeGreaterThan(0);
  });
});

// Captured-format pytest output literals; no test here spawns pytest.
const PYTEST_60 = [
  "============================= test session starts ==============================",
  "platform darwin -- Python 3.12.1, pytest-8.0.0, pluggy-1.4.0",
  "collected 60 items",
  "",
  "tests/test_risk.py::test_a PASSED                                        [  1%]",
  "tests/test_risk.py::test_b PASSED                                        [  3%]",
  "",
  "===== 60 passed, 2 warnings in 0.18s =====",
].join("\n");

describe("parseTestCounts — pytest", () => {
  it("reads a passing pytest run (collected 60 items ... 60 passed, 2 warnings)", () => {
    expect(parseTestCounts(PYTEST_60)).toEqual({ passCount: 60, failCount: 0, countsSource: "pytest", countsUnavailableReason: null });
  });

  it("test-path lines are not captured by the vitest Tests branch", () => {
    expect(parseTestCounts(PYTEST_60).countsSource).toBe("pytest");
  });

  it("reads failed and passed terms, bordered and bare -q form", () => {
    expect(parseTestCounts("collected 60 items\n===== 3 failed, 57 passed in 1.02s =====\n")).toMatchObject({ passCount: 57, failCount: 3, countsSource: "pytest" });
    expect(parseTestCounts("3 failed, 57 passed in 1.02s\n")).toMatchObject({ passCount: 57, failCount: 3, countsSource: "pytest" });
  });

  it("CRLF line endings do not defeat the anchored counts grammar", () => {
    expect(parseTestCounts("collected 60 items\r\n===== 60 passed in 0.18s =====\r\n").passCount).toBe(60);
  });

  it("'no tests ran' is an observed zero, distinct from unknown", () => {
    expect(parseTestCounts("collected 0 items\n\nno tests ran in 0.01s\n")).toEqual({ passCount: 0, failCount: 0, countsSource: "pytest", countsUnavailableReason: null });
  });

  it("takes the counts from the LAST counts line", () => {
    expect(parseTestCounts("===== 1 failed in 0.10s =====\nretrying\n===== 5 passed in 0.20s =====\n")).toMatchObject({ passCount: 5, failCount: 0, countsSource: "pytest" });
  });

  it("decision 1a: errors count as failures", () => {
    expect(parseTestCounts("===== 1 failed, 2 errors, 57 passed in 1.02s =====")).toMatchObject({ passCount: 57, failCount: 3, countsSource: "pytest" });
    expect(parseTestCounts("===== 2 errors in 0.50s =====")).toMatchObject({ passCount: 0, failCount: 2, countsSource: "pytest" });
  });

  it("decision 2a: other terms are ignored, and a rerun term does not make counts unavailable", () => {
    expect(parseTestCounts("===== 57 passed, 3 skipped, 1 xfailed, 1 rerun in 1.02s =====")).toEqual({ passCount: 57, failCount: 0, countsSource: "pytest", countsUnavailableReason: null });
  });
});

// REAL captured node:test output literals (backlog.feat.exec-test-result-persistence).
// Captured with node v22.23.2 (darwin) by running, outside this suite:
//   node --test --test-reporter=tap  pass18.test.mjs   (18 passing tests, exit 0)
//   node --test --test-reporter=spec pass18.test.mjs
//   node --test --test-reporter=tap  mixed.test.mjs    (3 pass, 2 fail, 1 cancelled by timeout, 1 skip, 1 todo; exit 1)
//   node --test --test-reporter=spec mixed.test.mjs
// stdout was captured verbatim, one array entry per line. Local filesystem paths in stack traces
// and location: lines were neutralized to /tmp/node-test-fixture/<file>.test.mjs; nothing else changed. No test here spawns node --test or any
// other subprocess to produce them.
const NODE_TEST_TAP_18 = [
  "TAP version 13",
  "# Subtest: case 1",
  "ok 1 - case 1",
  "  ---",
  "  duration_ms: 0.627375",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 2",
  "ok 2 - case 2",
  "  ---",
  "  duration_ms: 0.080667",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 3",
  "ok 3 - case 3",
  "  ---",
  "  duration_ms: 0.0305",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 4",
  "ok 4 - case 4",
  "  ---",
  "  duration_ms: 0.026834",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 5",
  "ok 5 - case 5",
  "  ---",
  "  duration_ms: 0.028042",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 6",
  "ok 6 - case 6",
  "  ---",
  "  duration_ms: 0.02725",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 7",
  "ok 7 - case 7",
  "  ---",
  "  duration_ms: 0.026333",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 8",
  "ok 8 - case 8",
  "  ---",
  "  duration_ms: 0.02325",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 9",
  "ok 9 - case 9",
  "  ---",
  "  duration_ms: 0.182167",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 10",
  "ok 10 - case 10",
  "  ---",
  "  duration_ms: 0.195334",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 11",
  "ok 11 - case 11",
  "  ---",
  "  duration_ms: 0.0715",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 12",
  "ok 12 - case 12",
  "  ---",
  "  duration_ms: 0.022542",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 13",
  "ok 13 - case 13",
  "  ---",
  "  duration_ms: 0.018916",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 14",
  "ok 14 - case 14",
  "  ---",
  "  duration_ms: 0.016041",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 15",
  "ok 15 - case 15",
  "  ---",
  "  duration_ms: 0.014334",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 16",
  "ok 16 - case 16",
  "  ---",
  "  duration_ms: 0.015375",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 17",
  "ok 17 - case 17",
  "  ---",
  "  duration_ms: 0.018209",
  "  type: 'test'",
  "  ...",
  "# Subtest: case 18",
  "ok 18 - case 18",
  "  ---",
  "  duration_ms: 0.014417",
  "  type: 'test'",
  "  ...",
  "1..18",
  "# tests 18",
  "# suites 0",
  "# pass 18",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 39.3195",
].join("\n");

const NODE_TEST_SPEC_18 = [
  "✔ case 1 (0.633959ms)",
  "✔ case 2 (0.238166ms)",
  "✔ case 3 (0.030417ms)",
  "✔ case 4 (0.0275ms)",
  "✔ case 5 (0.029625ms)",
  "✔ case 6 (0.025667ms)",
  "✔ case 7 (0.022959ms)",
  "✔ case 8 (0.022833ms)",
  "✔ case 9 (0.191959ms)",
  "✔ case 10 (0.195542ms)",
  "✔ case 11 (0.073958ms)",
  "✔ case 12 (0.022041ms)",
  "✔ case 13 (0.016958ms)",
  "✔ case 14 (0.015416ms)",
  "✔ case 15 (0.013833ms)",
  "✔ case 16 (0.016583ms)",
  "✔ case 17 (0.017917ms)",
  "✔ case 18 (0.014333ms)",
  "ℹ tests 18",
  "ℹ suites 0",
  "ℹ pass 18",
  "ℹ fail 0",
  "ℹ cancelled 0",
  "ℹ skipped 0",
  "ℹ todo 0",
  "ℹ duration_ms 34.543917",
].join("\n");

const NODE_TEST_TAP_MIXED = [
  "TAP version 13",
  "# Subtest: passes a",
  "ok 1 - passes a",
  "  ---",
  "  duration_ms: 0.290375",
  "  type: 'test'",
  "  ...",
  "# Subtest: passes b",
  "ok 2 - passes b",
  "  ---",
  "  duration_ms: 0.066583",
  "  type: 'test'",
  "  ...",
  "# Subtest: passes c",
  "ok 3 - passes c",
  "  ---",
  "  duration_ms: 0.032834",
  "  type: 'test'",
  "  ...",
  "# Subtest: fails a",
  "not ok 4 - fails a",
  "  ---",
  "  duration_ms: 0.857541",
  "  type: 'test'",
  "  location: '/tmp/node-test-fixture/mixed.test.mjs:6:1'",
  "  failureType: 'testCodeFailure'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "    ",
  "    1 !== 2",
  "    ",
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  expected: 2",
  "  actual: 1",
  "  operator: 'strictEqual'",
  "  stack: |-",
  "    TestContext.<anonymous> (file:///tmp/node-test-fixture/mixed.test.mjs:6:30)",
  "    Test.runInAsyncScope (node:async_hooks:214:14)",
  "    Test.run (node:internal/test_runner/test:1047:25)",
  "    Test.processPendingSubtests (node:internal/test_runner/test:744:18)",
  "    Test.postRun (node:internal/test_runner/test:1173:19)",
  "    Test.run (node:internal/test_runner/test:1101:12)",
  "    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)",
  "  ...",
  "# Subtest: fails b",
  "not ok 5 - fails b",
  "  ---",
  "  duration_ms: 0.11325",
  "  type: 'test'",
  "  location: '/tmp/node-test-fixture/mixed.test.mjs:7:1'",
  "  failureType: 'testCodeFailure'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "    ",
  "    1 !== 3",
  "    ",
  "  code: 'ERR_ASSERTION'",
  "  name: 'AssertionError'",
  "  expected: 3",
  "  actual: 1",
  "  operator: 'strictEqual'",
  "  stack: |-",
  "    TestContext.<anonymous> (file:///tmp/node-test-fixture/mixed.test.mjs:7:30)",
  "    Test.runInAsyncScope (node:async_hooks:214:14)",
  "    Test.run (node:internal/test_runner/test:1047:25)",
  "    Test.processPendingSubtests (node:internal/test_runner/test:744:18)",
  "    Test.postRun (node:internal/test_runner/test:1173:19)",
  "    Test.run (node:internal/test_runner/test:1101:12)",
  "    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)",
  "  ...",
  "# Subtest: skipped",
  "ok 6 - skipped # SKIP",
  "  ---",
  "  duration_ms: 0.037791",
  "  type: 'test'",
  "  ...",
  "# Subtest: todo one",
  "ok 7 - todo one # TODO",
  "  ---",
  "  duration_ms: 0.032",
  "  type: 'test'",
  "  ...",
  "# Subtest: timeouts",
  "    # Subtest: slow",
  "    not ok 1 - slow",
  "      ---",
  "      duration_ms: 22.847125",
  "      type: 'test'",
  "      location: '/tmp/node-test-fixture/mixed.test.mjs:11:3'",
  "      failureType: 'testTimeoutFailure'",
  "      error: 'test timed out after 20ms'",
  "      code: 'ERR_TEST_FAILURE'",
  "      stack: |-",
  "        async Promise.all (index 0)",
  "      ...",
  "    1..1",
  "not ok 8 - timeouts",
  "  ---",
  "  duration_ms: 23.073166",
  "  type: 'suite'",
  "  location: '/tmp/node-test-fixture/mixed.test.mjs:10:1'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "1..8",
  "# tests 8",
  "# suites 1",
  "# pass 3",
  "# fail 2",
  "# cancelled 1",
  "# skipped 1",
  "# todo 1",
  "# duration_ms 541.990333",
].join("\n");

const NODE_TEST_SPEC_MIXED = [
  "✔ passes a (0.337833ms)",
  "✔ passes b (0.074541ms)",
  "✔ passes c (0.037292ms)",
  "✖ fails a (0.663875ms)",
  "✖ fails b (0.151583ms)",
  "﹣ skipped (0.041375ms) # SKIP",
  "✔ todo one (0.035833ms) # TODO",
  "▶ timeouts",
  "  ✖ slow (21.313625ms)",
  "✖ timeouts (21.635334ms)",
  "ℹ tests 8",
  "ℹ suites 1",
  "ℹ pass 3",
  "ℹ fail 2",
  "ℹ cancelled 1",
  "ℹ skipped 1",
  "ℹ todo 1",
  "ℹ duration_ms 547.027875",
  "",
  "✖ failing tests:",
  "",
  "test at mixed.test.mjs:6:1",
  "✖ fails a (0.663875ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  1 !== 2",
  "  ",
  "      at TestContext.<anonymous> (file:///tmp/node-test-fixture/mixed.test.mjs:6:30)",
  "      at Test.runInAsyncScope (node:async_hooks:214:14)",
  "      at Test.run (node:internal/test_runner/test:1047:25)",
  "      at Test.processPendingSubtests (node:internal/test_runner/test:744:18)",
  "      at Test.postRun (node:internal/test_runner/test:1173:19)",
  "      at Test.run (node:internal/test_runner/test:1101:12)",
  "      at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "    actual: 1,",
  "    expected: 2,",
  "    operator: 'strictEqual',",
  "    diff: 'simple'",
  "  }",
  "",
  "test at mixed.test.mjs:7:1",
  "✖ fails b (0.151583ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ",
  "  1 !== 3",
  "  ",
  "      at TestContext.<anonymous> (file:///tmp/node-test-fixture/mixed.test.mjs:7:30)",
  "      at Test.runInAsyncScope (node:async_hooks:214:14)",
  "      at Test.run (node:internal/test_runner/test:1047:25)",
  "      at Test.processPendingSubtests (node:internal/test_runner/test:744:18)",
  "      at Test.postRun (node:internal/test_runner/test:1173:19)",
  "      at Test.run (node:internal/test_runner/test:1101:12)",
  "      at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {",
  "    generatedMessage: true,",
  "    code: 'ERR_ASSERTION',",
  "    actual: 1,",
  "    expected: 3,",
  "    operator: 'strictEqual',",
  "    diff: 'simple'",
  "  }",
  "",
  "test at mixed.test.mjs:11:3",
  "✖ slow (21.313625ms)",
  "  'test timed out after 20ms'",
].join("\n");

describe("parseTestCounts — node:test", () => {
  it("AC1: reads the TAP reporter summary of an 18-test passing run", () => {
    expect(parseTestCounts(NODE_TEST_TAP_18)).toEqual({ passCount: 18, failCount: 0, countsSource: "node:test", countsUnavailableReason: null });
  });

  it("AC2: reads the spec reporter (info-glyph) summary of the same 18-test run", () => {
    expect(parseTestCounts(NODE_TEST_SPEC_18)).toEqual({ passCount: 18, failCount: 0, countsSource: "node:test", countsUnavailableReason: null });
  });

  it("AC3: failCount is fail + cancelled, passCount is pass; skipped and todo change neither", () => {
    // Summary in both captures: tests 8, pass 3, fail 2, cancelled 1, skipped 1, todo 1.
    for (const output of [NODE_TEST_TAP_MIXED, NODE_TEST_SPEC_MIXED]) {
      expect(parseTestCounts(output)).toEqual({ passCount: 3, failCount: 3, countsSource: "node:test", countsUnavailableReason: null });
    }
    // Removing the skipped and todo lines changes neither count.
    const withoutSkipTodo = NODE_TEST_TAP_MIXED.split("\n").filter((l) => !/^# (skipped|todo) /.test(l)).join("\n");
    expect(parseTestCounts(withoutSkipTodo)).toMatchObject({ passCount: 3, failCount: 3 });
  });

  it("AC3: neither the TAP nor the spec literal is captured by the vitest Tests branch", () => {
    for (const output of [NODE_TEST_TAP_18, NODE_TEST_SPEC_18, NODE_TEST_TAP_MIXED, NODE_TEST_SPEC_MIXED]) {
      const r = parseTestCounts(output);
      expect(r.countsSource).toBe("node:test");
      expect(r.countsSource).not.toBe("vitest");
    }
  });

  it("takes the counts from the LAST complete summary block of concatenated partition output", () => {
    expect(parseTestCounts(`${NODE_TEST_TAP_MIXED}\n${NODE_TEST_TAP_18}`)).toMatchObject({ passCount: 18, failCount: 0, countsSource: "node:test" });
    expect(parseTestCounts(`${NODE_TEST_SPEC_18}\n${NODE_TEST_SPEC_MIXED}`)).toMatchObject({ passCount: 3, failCount: 3, countsSource: "node:test" });
  });
});

describe("parseTestCounts — wiring (full-source assertions)", () => {
  it("test-runner.mjs exports parseTestCounts, not parseTestCount, and imports parsePytestCounts", () => {
    expect(typeof testRunner.parseTestCounts).toBe("function");
    expect("parseTestCount" in testRunner).toBe(false);
    const runner = src("server/test-runner.mjs");
    expect(runner).toMatch(/import\s*\{[^}]*\bparsePytestCounts\b[^}]*\}\s*from\s*"\.\.\/exec\/test-results\.mjs"/);
    expect(runner).not.toContain("no tests ran");
  });

  it("'const COUNTS_LINE' occurs exactly once under packages/mcp-rks/src", () => {
    let hits = 0;
    for (const rel of fs.readdirSync(SRC_ROOT, { recursive: true })) {
      if (!/\.(mjs|cjs|js)$/.test(rel) || rel.includes("node_modules")) continue;
      hits += src(rel).split("const COUNTS_LINE").length - 1;
    }
    expect(hits).toBe(1);
  });

  it("exec.mjs builds testVerification from one parseTestCounts call", () => {
    const exec = src("server/exec.mjs");
    expect(exec).toContain("...parseTestCounts(lastVerification.output),");
    expect(exec).not.toContain("parseTestCount(");
  });
});

/**
 * Every `collector.emit(` call in the source, split into its top-level arguments. The same
 * depth-aware splitter as tests/unit/exec-lifecycle-emission-cardinality.test.mjs: balanced over
 * (), {} and [], skipping string and template-literal contents.
 */
function emitCalls(source) {
  const calls = [];
  const opener = "collector.emit(";
  let idx = source.indexOf(opener);
  while (idx !== -1) {
    const args = [];
    let depth = 0;
    let start = idx + opener.length;
    let i = start;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const close = source.indexOf(ch, i + 1);
        i = close;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) {
        args.push(source.slice(start, i).trim());
        start = i + 1;
      }
    }
    const last = source.slice(start, i).trim();
    if (last.length > 0) args.push(last);
    calls.push({ index: idx, args });
    idx = source.indexOf(opener, i);
  }
  return calls;
}

/** Every `<opener> ... }` object literal in the source, balanced over (), {} and []. */
function objectLiterals(source, opener) {
  const out = [];
  let idx = source.indexOf(opener);
  while (idx !== -1) {
    let depth = 0;
    let i = idx + opener.length - 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(idx, i + 1));
    idx = source.indexOf(opener, i);
  }
  return out;
}

/** Top-level keys of an object-literal argument, in source order (shorthand and `key:` forms). */
function topLevelKeys(objectSrc) {
  const body = objectSrc.trim().replace(/^\{/, "").replace(/\}$/, "");
  const keys = [];
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = body.indexOf(ch, i + 1); continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe("exec test-result persistence — exec.mjs wiring (full-source assertions)", () => {
  const exec = src("server/exec.mjs");
  const provenance = src("server/exec-provenance.mjs");
  const completes = emitCalls(exec).filter((c) => c.args[0] === '"exec.complete"');

  it("AC5: the single exec.complete emit's payload carries the four test keys, after filesChanged and the linkage keys", () => {
    expect(completes).toHaveLength(1);
    const [call] = completes;
    expect(call.args).toHaveLength(4);
    const keys = topLevelKeys(call.args[2]);
    for (const k of ["testVerification", "testsSkipped", "baselineSkipped", "baselineSkipReason"]) {
      expect(keys).toContain(k);
    }
    const after = Math.max(...["filesChanged", "commitSha", "planHash", "commitBranch", "planArchive"].map((k) => {
      expect(keys).toContain(k);
      return keys.indexOf(k);
    }));
    for (const k of ["testVerification", "testsSkipped", "baselineSkipped", "baselineSkipReason"]) {
      expect(keys.indexOf(k)).toBeGreaterThan(after);
    }
  });

  it("AC5: the exec.complete payload has no correlationId and no testsFailed true; correlationId stays the options argument", () => {
    const [call] = completes;
    expect(call.args[2]).not.toMatch(/correlationId/);
    expect(call.args[2]).not.toMatch(/testsFailed\s*:\s*true/);
    expect(call.args[3]).toMatch(/^\{\s*correlationId\s*\}$/);
  });

  it("AC5: testVerification is computed once — null when skipped — with observed exitCode and command, never defaulted to 0", () => {
    const assignments = objectLiterals(exec, "testVerification = testsSkipped ? null : lastVerification ? {");
    expect(assignments).toHaveLength(1);
    const [tv] = assignments;
    expect(tv).toContain("...parseTestCounts(lastVerification.output),");
    expect(tv).toMatch(/exitCode:\s*lastVerification\.exitCode\s*\?\?\s*null/);
    expect(tv).toMatch(/command:\s*lastVerification\.command\s*\?\?\s*lastVerification\.commands\s*\?\?\s*null/);
    expect(tv).not.toMatch(/(passCount|failCount|exitCode|command)\s*:\s*0\b/);
    expect(tv).not.toMatch(/\|\|\s*0\b|\?\?\s*0\b/);
    expect(exec).toMatch(/testVerification = testsSkipped \? null : lastVerification \? \{[\s\S]*?\} : null;/);
  });

  it("AC5: no ctx.terminalDetail assignment and no emitTerminalOutcome payload gains testVerification", () => {
    const details = objectLiterals(exec, "ctx.terminalDetail = {");
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(d).not.toContain("testVerification");
    expect(provenance).not.toContain("testVerification");
    for (const c of emitCalls(provenance)) expect(c.args.join(",")).not.toContain("testVerification");
  });

  it("AC5: the committed plan archive gains no testVerification and no baseline status fields", async () => {
    const archiveCalls = objectLiterals(exec, "buildPlanArchive({");
    expect(archiveCalls.length).toBeGreaterThan(0);
    for (const c of archiveCalls) expect(c).not.toMatch(/testVerification|baselineSkip|testsSkipped/);
    const { buildPlanArchive } = await import("../../packages/mcp-rks/src/server/exec-provenance.mjs");
    const archive = buildPlanArchive({ runId: "r1", plan: { problemId: "p", steps: [] }, fixPlans: [] });
    for (const k of Object.keys(archive)) expect(k).not.toMatch(/testVerification|baseline|testsSkipped/);
  });

  it("AC6: run.json gets testVerification and baseline status from the same variables the pending_ship return uses", () => {
    expect(exec).toContain("runMeta.testVerification = testVerification;");
    expect(exec).toContain("runMeta.baselineSkipped = baselineSkipped;");
    expect(exec).toContain("runMeta.baselineSkipReason = baselineSkipReason;");
    const pendingShip = exec.slice(exec.lastIndexOf("return {", exec.indexOf("status: 'pending_ship'")));
    const ret = pendingShip.slice(0, pendingShip.indexOf("\n  };") + 4);
    expect(ret).toContain("status: 'pending_ship'");
    const keys = topLevelKeys(ret.replace(/^return\s*/, "").replace(/;$/, ""));
    for (const k of ["testVerification", "baselineSkipped", "baselineSkipReason"]) expect(keys).toContain(k);
    expect(ret).toMatch(/^\s*testVerification,\s*$/m);
    // The run.json write follows the single computation.
    const computedAt = exec.indexOf("testVerification = testsSkipped ? null");
    const persistedAt = exec.indexOf("runMeta.testVerification = testVerification;");
    const writtenAt = exec.indexOf("fs.writeFileSync(runJsonPath", persistedAt);
    expect(computedAt).toBeGreaterThan(-1);
    expect(persistedAt).toBeGreaterThan(computedAt);
    expect(writtenAt).toBeGreaterThan(persistedAt);
  });

  it("AC6: exec.mjs contains exactly one parseTestCounts( call", () => {
    expect(exec.split("parseTestCounts(").length - 1).toBe(1);
    expect(exec).toContain("...parseTestCounts(lastVerification.output),");
  });
});

describe("testVerification object shape", () => {
  it("has correct fields when tests pass", () => {
    const testVerification = {
      passed: true,
      passCount: 567,
      failCount: 0,
      duration: 42000,
      attempts: 1,
    };

    expect(testVerification).toHaveProperty("passed", true);
    expect(testVerification).toHaveProperty("passCount");
    expect(testVerification).toHaveProperty("failCount");
    expect(testVerification).toHaveProperty("duration");
    expect(testVerification).toHaveProperty("attempts");
    expect(typeof testVerification.passed).toBe("boolean");
    expect(typeof testVerification.passCount).toBe("number");
    expect(typeof testVerification.failCount).toBe("number");
    expect(typeof testVerification.duration).toBe("number");
    expect(typeof testVerification.attempts).toBe("number");
  });

  it("is null when tests are skipped", () => {
    const testsSkipped = true;
    const testVerification = testsSkipped ? null : { passed: true };
    expect(testVerification).toBeNull();
  });

  it("preserves backward-compatible flat fields alongside testVerification", () => {
    // Simulates the exec return shape
    const result = {
      ok: true,
      testsRan: true,
      testsPassed: true,
      testsSkipped: false,
      attempts: 1,
      testVerification: {
        passed: true,
        passCount: 567,
        failCount: 0,
        duration: 42000,
        attempts: 1,
      },
      status: "pending_ship",
    };

    // Flat fields unchanged
    expect(result.testsPassed).toBe(true);
    expect(result.testsRan).toBe(true);
    expect(result.testsSkipped).toBe(false);
    expect(result.attempts).toBe(1);

    // New structured field present
    expect(result.testVerification).toBeDefined();
    expect(result.testVerification.passed).toBe(true);
    expect(result.testVerification.passCount).toBe(567);
  });
});
