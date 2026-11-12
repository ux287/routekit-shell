/**
 * backlog.feat.full-suite-regression-gate — the opt-in full-suite gate module and the
 * runProjectTests command override / command fields it depends on.
 *
 * No real subprocess is spawned: child_process.spawnSync is mocked for every test that
 * reaches runProjectTests, and runFullSuiteGate receives an injected runTests stub wherever
 * the spawn itself is not under test.
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
import {
  resolveFullSuiteGateConfig,
  diffFailingNodeIds,
  runFullSuiteGate,
  fullSuiteGateApplies,
} from "../../packages/mcp-rks/src/exec/full-suite-gate.mjs";
import { runProjectTests } from "../../packages/mcp-rks/src/exec/command-runner.mjs";

const GATE_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/mcp-rks/src/exec/full-suite-gate.mjs"),
  "utf8",
);

let root;
let errSpy;
const writeProject = (obj) => {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify(obj));
};
const writeRaw = (text) => {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), text);
};
const tr = (over = {}) => ({ available: true, source: "pytest_short_summary", failing: [], passed: [], skipped: [], ...over });
const ran = (over = {}) => ({
  passed: false, skipped: false, output: "out", exitCode: 1,
  command: { cmd: "pytest", args: ["-q"] },
  testResults: tr(), ...over,
});
const spawnCalls = () => spawnSync.mock.calls;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "full-suite-gate-"));
  spawnSync.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveFullSuiteGateConfig", () => {
  it("absent project.json and absent key are not_configured; enabled:false is disabled", () => {
    expect(resolveFullSuiteGateConfig(root)).toMatchObject({ enabled: false, reason: "not_configured" });
    writeProject({ id: "x" });
    expect(resolveFullSuiteGateConfig(root)).toMatchObject({ enabled: false, reason: "not_configured" });
    writeProject({ fullSuiteGate: { enabled: false } });
    expect(resolveFullSuiteGateConfig(root)).toMatchObject({ enabled: false, reason: "disabled" });
  });

  it("enabled:true resolves defaults; declared knownFailing, command and timeoutMs are returned as declared", () => {
    writeProject({ fullSuiteGate: { enabled: true } });
    expect(resolveFullSuiteGateConfig(root)).toEqual({ enabled: true, knownFailing: [], command: null, timeoutMs: 300000 });
    writeProject({
      fullSuiteGate: {
        enabled: true,
        knownFailing: ["tests/a.py::t1", "tests/b.test.mjs > s > t"],
        command: { cmd: "npx", args: ["vitest", "run"] },
        timeoutMs: 1234,
      },
    });
    expect(resolveFullSuiteGateConfig(root)).toEqual({
      enabled: true,
      knownFailing: ["tests/a.py::t1", "tests/b.test.mjs > s > t"],
      command: { cmd: "npx", args: ["vitest", "run"] },
      timeoutMs: 1234,
    });
  });

  const MALFORMED = [
    ["a string", "on", "fullSuiteGate"],
    ["an array", [true], "fullSuiteGate"],
    ["non-boolean enabled", { enabled: "yes" }, "fullSuiteGate.enabled"],
    ["knownFailing not an array", { enabled: true, knownFailing: "a" }, "fullSuiteGate.knownFailing"],
    ["knownFailing with a non-string", { enabled: true, knownFailing: ["a", 1] }, "fullSuiteGate.knownFailing"],
    ["command without cmd", { enabled: true, command: { args: [] } }, "fullSuiteGate.command"],
    ["command with empty cmd", { enabled: true, command: { cmd: "  " } }, "fullSuiteGate.command"],
    ["command with non-string args", { enabled: true, command: { cmd: "npx", args: ["vitest", 2] } }, "fullSuiteGate.command"],
    ["zero timeoutMs", { enabled: true, timeoutMs: 0 }, "fullSuiteGate.timeoutMs"],
    ["negative timeoutMs", { enabled: true, timeoutMs: -1 }, "fullSuiteGate.timeoutMs"],
    ["string timeoutMs", { enabled: true, timeoutMs: "100" }, "fullSuiteGate.timeoutMs"],
  ];
  for (const [label, value, field] of MALFORMED) {
    it(`malformed (${label}) is misconfigured, names ${field}, and blocks without running`, () => {
      writeProject({ fullSuiteGate: value });
      const cfg = resolveFullSuiteGateConfig(root);
      expect(cfg).toMatchObject({ enabled: false, reason: "misconfigured", field });
      expect(cfg.detail).toContain(field);
      const runTests = vi.fn();
      const r = runFullSuiteGate(root, { runTests });
      expect(runTests).toHaveBeenCalledTimes(0);
      expect(r).toMatchObject({ blocked: true, ran: false, reason: "misconfigured", field });
    });
  }

  it("enabled:false runs nothing and does not block", () => {
    writeProject({ fullSuiteGate: { enabled: false } });
    const runTests = vi.fn();
    const r = runFullSuiteGate(root, { runTests });
    expect(runTests).toHaveBeenCalledTimes(0);
    expect(r).toMatchObject({ ran: false, blocked: false, reason: "disabled" });
  });

  it("unparseable project.json is project_json_unreadable, runs nothing, does not block, and is logged", () => {
    writeRaw("{ not json");
    expect(resolveFullSuiteGateConfig(root)).toMatchObject({ enabled: false, reason: "project_json_unreadable" });
    const runTests = vi.fn();
    const r = runFullSuiteGate(root, { runTests });
    expect(runTests).toHaveBeenCalledTimes(0);
    expect(r).toMatchObject({ ran: false, blocked: false, reason: "project_json_unreadable" });
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("project_json_unreadable"))).toBe(true);
  });

  it("is project-level only: a config under HOME / XDG_CONFIG_HOME is never consulted", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "full-suite-gate-home-"));
    const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
    try {
      const gate = JSON.stringify({ fullSuiteGate: { enabled: true } });
      for (const dir of [path.join(fakeHome, ".rks"), path.join(fakeHome, ".config", "rks"), path.join(fakeHome, "rks")]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "project.json"), gate);
      }
      process.env.HOME = fakeHome;
      process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
      writeProject({ id: "x" });
      expect(resolveFullSuiteGateConfig(root)).toMatchObject({ enabled: false, reason: "not_configured" });
      const runTests = vi.fn();
      expect(runFullSuiteGate(root, { runTests })).toMatchObject({ ran: false, blocked: false, reason: "not_configured" });
      expect(runTests).not.toHaveBeenCalled();
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
      if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.XDG;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
    expect(GATE_SRC).not.toContain("homedir");
    expect(GATE_SRC).not.toContain("process.env.HOME");
  });
});

describe("diffFailingNodeIds", () => {
  it("decides on node IDs, not counts", () => {
    expect(diffFailingNodeIds({ baselineFailing: ["a", "b"], nowFailing: ["a", "b"] })).toEqual({ newFailures: [], fixed: [] });
    expect(diffFailingNodeIds({ baselineFailing: ["a", "b"], nowFailing: ["a", "c"] })).toEqual({ newFailures: ["c"], fixed: ["b"] });
    expect(diffFailingNodeIds({ baselineFailing: ["a", "b"], nowFailing: ["c", "d"] })).toMatchObject({ newFailures: ["c", "d"] });
  });
});

describe("runFullSuiteGate — opt-in and the run call", () => {
  it("absent key is not_configured and runs nothing", () => {
    writeProject({ id: "x" });
    const runTests = vi.fn();
    const r = runFullSuiteGate(root, { runTests });
    expect(runTests).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ran: false, blocked: false, reason: "not_configured" });
    expect(fullSuiteGateApplies(r)).toBe(false);
  });

  it("enabled: calls runTests once with no testPaths, collectTestResults set and the resolved timeout", () => {
    writeProject({ fullSuiteGate: { enabled: true, timeoutMs: 4321 } });
    const runTests = vi.fn(() => ran({ exitCode: 0 }));
    runFullSuiteGate(root, { runTests });
    expect(runTests).toHaveBeenCalledTimes(1);
    const [calledRoot, opts] = runTests.mock.calls[0];
    expect(calledRoot).toBe(root);
    expect(opts.testPaths == null).toBe(true);
    expect(opts.collectTestResults).toBeTruthy();
    expect(opts.timeout).toBe(4321);
  });
});

describe("runFullSuiteGate — decision", () => {
  it("known-red baseline passes", () => {
    writeProject({ fullSuiteGate: { enabled: true, knownFailing: ["a", "b"] } });
    const r = runFullSuiteGate(root, { runTests: () => ran({ exitCode: 1, testResults: tr({ failing: ["a", "b"] }) }) });
    expect(r).toMatchObject({ blocked: false, newFailures: [], baselineFailing: ["a", "b"], nowFailing: ["a", "b"] });
  });

  it("a new failure blocks; a fixed known failure is reported and never blocks", () => {
    writeProject({ fullSuiteGate: { enabled: true, knownFailing: ["a", "b"] } });
    const blocked = runFullSuiteGate(root, { runTests: () => ran({ testResults: tr({ failing: ["a", "c"] }) }) });
    expect(blocked).toMatchObject({ blocked: true, reason: "new_failures", newFailures: ["c"], fixed: ["b"] });
    const fixedOnly = runFullSuiteGate(root, { runTests: () => ran({ testResults: tr({ failing: ["a"] }) }) });
    expect(fixedOnly).toMatchObject({ blocked: false, fixed: ["b"], newFailures: [] });
  });

  for (const reason of ["runner_not_recognized", "summary_absent", "report_missing", "timeout"]) {
    it(`unavailable results (${reason}) block`, () => {
      writeProject({ fullSuiteGate: { enabled: true } });
      const r = runFullSuiteGate(root, {
        runTests: () => ran({ exitCode: 0, testResults: { available: false, reason, failed: [], passed: [], skipped: [] } }),
      });
      expect(r.blocked).toBe(true);
      expect(r.available).toBe(false);
      expect(r.reason).toContain(reason);
    });
  }

  it("a skipped run blocks with no_test_runner; noTestsFound blocks with no_tests_found", () => {
    writeProject({ fullSuiteGate: { enabled: true } });
    const skipped = runFullSuiteGate(root, { runTests: () => ({ passed: true, skipped: true, reason: "no test runner detected" }) });
    expect(skipped).toMatchObject({ blocked: true, reason: "no_test_runner" });
    const none = runFullSuiteGate(root, { runTests: () => ran({ exitCode: 1, noTestsFound: true }) });
    expect(none).toMatchObject({ blocked: true, reason: "no_tests_found" });
  });

  it("exit code is never sufficient", () => {
    writeProject({ fullSuiteGate: { enabled: true } });
    const nonZero = runFullSuiteGate(root, { runTests: () => ran({ exitCode: 2, testResults: tr({ failing: [] }) }) });
    expect(nonZero).toMatchObject({ blocked: true, reason: "exit_nonzero_without_failing_ids" });
    const zeroUnavailable = runFullSuiteGate(root, {
      runTests: () => ran({ exitCode: 0, testResults: { available: false, reason: "summary_absent", failed: [], passed: [], skipped: [] } }),
    });
    expect(zeroUnavailable.blocked).toBe(true);
  });

  it("a throwing runner blocks rather than passing", () => {
    writeProject({ fullSuiteGate: { enabled: true } });
    const r = runFullSuiteGate(root, { runTests: () => { throw new Error("boom"); } });
    expect(r).toMatchObject({ blocked: true, ran: false });
  });
});

describe("runFullSuiteGate — evidence-bound result", () => {
  it("command comes from the run result, never from config; tail, counts and source are observed", () => {
    writeProject({ fullSuiteGate: { enabled: true, command: { cmd: "npx", args: ["vitest", "run"] } } });
    const lines = Array.from({ length: 100 }, (_, i) => `\u001b[31mline ${i + 1}\u001b[0m`).join("\n");
    const r = runFullSuiteGate(root, {
      runTests: () => ran({
        exitCode: 0,
        output: lines,
        command: { cmd: "observed", args: ["--x"] },
        testResults: tr({ source: "vitest_json", passed: ["p1", "p2"], skipped: ["s1"], failing: [] }),
      }),
    });
    expect(r.ran).toBe(true);
    expect(r.command).toEqual({ cmd: "observed", args: ["--x"] });
    expect(r.resultsSource).toBe("vitest_json");
    expect(r.exitCode).toBe(0);
    const tail = r.outputTail.split("\n");
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail[tail.length - 1]).toBe("line 100");
    expect(r.outputTail).not.toContain("\u001b");
    expect(r.counts).toEqual({ passed: 2, failing: 0, skipped: 1 });
    expect(r.blocked).toBe(false);
  });

  it("a result carrying commands is recorded as commands; unavailable results have null source and counts", () => {
    writeProject({ fullSuiteGate: { enabled: true } });
    const commands = [{ cmd: "a", args: [] }, { cmd: "b", args: [] }];
    const r = runFullSuiteGate(root, {
      runTests: () => ({ passed: false, skipped: false, output: "x", exitCode: 1, commands,
        testResults: { available: false, reason: "report_missing", failed: [], passed: [], skipped: [] } }),
    });
    expect(r.commands).toEqual(commands);
    expect(r).not.toHaveProperty("command");
    expect(r.resultsSource).toBeNull();
    expect(r.counts).toBeNull();
  });
});

describe("runFullSuiteGate end to end (spawnSync mocked)", () => {
  it("pytest testCommand: one spawn, args exactly [-q, -rA, --color=no], node-ID diff from the -rA summary", () => {
    writeProject({
      testCommand: { cmd: "pytest", args: ["-q"] },
      fullSuiteGate: { enabled: true, knownFailing: ["tests/test_a.py::test_x"] },
    });
    const fixture = [
      "============================= test session starts ==============================",
      "collected 3 items",
      "",
      "tests/test_a.py F                                                        [ 33%]",
      "tests/test_b.py F                                                        [ 66%]",
      "tests/test_c.py .                                                        [100%]",
      "",
      "=========================== short test summary info ============================",
      "PASSED tests/test_c.py::test_z",
      "FAILED tests/test_a.py::test_x - assert 1 == 2",
      "FAILED tests/test_b.py::test_y - AssertionError: boom",
      "========================= 2 failed, 1 passed in 0.12s ==========================",
      "",
    ].join("\n");
    spawnSync.mockReturnValue({ status: 1, signal: null, stdout: fixture, stderr: "" });
    const r = runFullSuiteGate(root);
    expect(spawnCalls().length).toBe(1);
    const [cmd, args] = spawnCalls()[0];
    expect(cmd).toBe("pytest");
    expect(args).toEqual(["-q", "-rA", "--color=no"]);
    expect(r).toMatchObject({
      ran: true,
      blocked: true,
      reason: "new_failures",
      newFailures: ["tests/test_b.py::test_y"],
      resultsSource: "pytest_short_summary",
      command: { cmd: "pytest", args: ["-q", "-rA", "--color=no"] },
      exitCode: 1,
    });
    expect(r.counts).toEqual({ passed: 1, failing: 2, skipped: 0 });
  });

  it("fullSuiteGate.command wins over testCommand: npx vitest run + json reporter args, vitest node IDs", () => {
    writeProject({
      testCommand: { cmd: "pytest", args: ["-q"] },
      fullSuiteGate: { enabled: true, command: { cmd: "npx", args: ["vitest", "run"] } },
    });
    spawnSync.mockImplementation((cmd, args) => {
      const out = args.find((a) => a.startsWith("--outputFile.json="));
      const reportPath = out.slice("--outputFile.json=".length);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({
        testResults: [{
          name: "tests/x.test.mjs",
          status: "failed",
          assertionResults: [
            { ancestorTitles: ["suite"], title: "fails", status: "failed" },
            { ancestorTitles: ["suite"], title: "works", status: "passed" },
          ],
        }],
      }));
      return { status: 1, signal: null, stdout: "vitest output", stderr: "" };
    });
    const r = runFullSuiteGate(root);
    expect(spawnCalls().length).toBe(1);
    const [cmd, args] = spawnCalls()[0];
    expect(cmd).toBe("npx");
    expect(args.slice(0, 2)).toEqual(["vitest", "run"]);
    expect(args.slice(2, 4)).toEqual(["--reporter=default", "--reporter=json"]);
    expect(args[4]).toMatch(/^--outputFile\.json=/);
    expect(args.length).toBe(5);
    expect(r.nowFailing).toContain("tests/x.test.mjs > suite > fails");
    expect(r.resultsSource).toBe("vitest_json");
    expect(r).toMatchObject({ blocked: true, reason: "new_failures" });
  });

  it("a wrapped testCommand (sh -c npm test) exiting 0 blocks as runner_not_recognized", () => {
    writeProject({ testCommand: { cmd: "sh", args: ["-c", "npm test"] }, fullSuiteGate: { enabled: true } });
    spawnSync.mockReturnValue({ status: 0, signal: null, stdout: "all good\n12 passing\n", stderr: "" });
    const r = runFullSuiteGate(root);
    expect(r).toMatchObject({ blocked: true, reason: "runner_not_recognized", exitCode: 0 });
    expect(r.outputTail.length).toBeGreaterThan(0);
  });
});

describe("runProjectTests command override and command fields", () => {
  const ok = () => ({ status: 0, signal: null, stdout: "ok", stderr: "" });

  it("the override wins over a declared testCommand", () => {
    writeProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockImplementation(ok);
    const r = runProjectTests(root, { command: { cmd: "npx", args: ["vitest", "run"] } });
    expect(spawnCalls().length).toBe(1);
    expect(spawnCalls()[0][0]).toBe("npx");
    expect(spawnCalls()[0][1]).toEqual(["vitest", "run"]);
    expect(r.command).toEqual({ cmd: "npx", args: ["vitest", "run"] });
  });

  it("the override wins over the scoped partitionByConfig branch and the detectTestRunner fallback", () => {
    spawnSync.mockImplementation(ok);
    runProjectTests(root, { command: { cmd: "npx", args: ["vitest", "run"] }, testPaths: ["tests/unit/a.test.mjs"] });
    expect(spawnCalls()[0][0]).toBe("npx");
    expect(spawnCalls()[0][1]).toEqual(["vitest", "run", "tests/unit/a.test.mjs"]);

    spawnSync.mockClear();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    runProjectTests(root, { command: { cmd: "npx", args: ["vitest", "run"] } });
    expect(spawnCalls()[0][0]).toBe("npx");
  });

  it("absent override: argv is unchanged (testCommand, detectTestRunner)", () => {
    writeProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockImplementation(ok);
    runProjectTests(root, {});
    expect(spawnCalls()[0][0]).toBe("pytest");
    expect(spawnCalls()[0][1]).toEqual(["-q"]);

    spawnSync.mockClear();
    writeProject({ id: "x" });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    runProjectTests(root, {});
    expect(spawnCalls()[0][0]).toBe("npm");
    expect(spawnCalls()[0][1]).toEqual(["test"]);
  });

  it("normal, timeout and noTestsFound returns all carry the spawned command", () => {
    writeProject({ testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockImplementation(ok);
    expect(runProjectTests(root, {}).command).toEqual({ cmd: "pytest", args: ["-q"] });

    spawnSync.mockImplementation(() => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }));
    const timedOut = runProjectTests(root, {});
    expect(timedOut.summary).toBe("timeout");
    expect(timedOut.command).toEqual({ cmd: "pytest", args: ["-q"] });

    spawnSync.mockImplementation(() => ({ status: 1, signal: null, stdout: "No test files found, exiting with code 1", stderr: "" }));
    const none = runProjectTests(root, {});
    expect(none.noTestsFound).toBe(true);
    expect(none.command).toEqual({ cmd: "pytest", args: ["-q"] });
  });

  it("a merged mixed-tier result carries commands in spawn order and no command; one partition carries command", () => {
    fs.writeFileSync(path.join(root, "vitest.config.mock.mjs"), "export default {};\n");
    spawnSync.mockImplementation(ok);
    const merged = runProjectTests(root, { testPaths: ["tests/unit/a.test.mjs", "tests/integration/b.test.mjs"] });
    expect(spawnCalls().length).toBe(2);
    expect(merged).not.toHaveProperty("command");
    expect(merged.commands).toEqual(spawnCalls().map(([cmd, args]) => ({ cmd, args })));

    spawnSync.mockClear();
    const single = runProjectTests(root, { testPaths: ["tests/unit/a.test.mjs"] });
    expect(spawnCalls().length).toBe(1);
    expect(single.command).toEqual({ cmd: spawnCalls()[0][0], args: spawnCalls()[0][1] });
    expect(single).not.toHaveProperty("commands");
  });

  it("skipped results gain neither field", () => {
    const paired = runProjectTests(root, { storyMetadata: { testStory: "x" } });
    expect(paired).not.toHaveProperty("command");
    expect(paired).not.toHaveProperty("commands");
    const noRunner = runProjectTests(root, {});
    expect(noRunner).toEqual({ passed: true, skipped: true, reason: "no test runner detected" });
    expect(spawnCalls().length).toBe(0);
  });
});
