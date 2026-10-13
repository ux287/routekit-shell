/**
 * backlog.fix.exec-scoped-tests-integration-config-routing — runProjectTests scoped branch.
 *
 * Integration-tier testPaths run under vitest.config.mock.mjs only when that config exists at
 * projectRoot; mixed tiers are partitioned per config with distinct report paths and merged
 * results; vitest "No test files found" is flagged as noTestsFound and never a pass.
 *
 * spawnSync is mocked: no real subprocess is spawned. Result assertions are per-field or
 * toMatchObject (never a whole-object toEqual) — result fields are additive.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});
import { spawnSync } from "child_process";
import { runProjectTests } from "../../packages/mcp-rks/src/exec/command-runner.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../../..");
const spawnResult = (status, stdout = "") => ({ status, signal: null, stdout, stderr: "" });
const NO_FILES = "No test files found, exiting with code 1";
const UNIT_ARGV = ["scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", "295000"];
const MOCK_ARGV = ["scripts/vitest-runner.mjs", "--config", "vitest.config.mock.mjs", "--timeout", "295000"];

const temps = [];
const mkTemp = (prefix, { mockConfig = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  if (mockConfig) writeFileSync(join(dir, "vitest.config.mock.mjs"), "export default {};\n");
  return dir;
};

/** A vitest JSON report with one assertion per [file, title, status]. */
const vitestReport = (entries) => JSON.stringify({
  testResults: entries.map(([name, title, status]) => ({
    name,
    status: status === "failed" ? "failed" : "passed",
    assertionResults: [{ ancestorTitles: [], title, status }],
  })),
});

/** Make the mocked runner write `reportFor(config)` to the --json-output path it was handed. */
const writeReports = (reportFor, statusFor = () => 0) => {
  spawnSync.mockImplementation((_cmd, args) => {
    const config = args[args.indexOf("--config") + 1];
    const i = args.indexOf("--json-output");
    const report = reportFor(config);
    if (i > -1 && report !== null) writeFileSync(args[i + 1], report);
    return spawnResult(statusFor(config), `ran ${config}`);
  });
};

const configOf = (call) => call[1][call[1].indexOf("--config") + 1];
const pathsOf = (call) => call[1].filter((a) => /^tests\//.test(String(a)));

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue(spawnResult(0, "ok"));
});

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop(), { recursive: true, force: true });
});

describe("runProjectTests scoped config routing", () => {
  it("integration-only paths run under vitest.config.mock.mjs when it exists at projectRoot", () => {
    const paths = ["tests/integration/a.test.mjs"];
    runProjectTests(ROOT, { testPaths: paths });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][0]).toBe("node");
    expect(spawnSync.mock.calls[0][1]).toEqual([...MOCK_ARGV, ...paths]);
  });

  it("integration paths keep the unit argv when projectRoot has no vitest.config.mock.mjs (child projects)", () => {
    const tmp = mkTemp("rks-no-mock-");
    runProjectTests(tmp, { testPaths: ["tests/integration/a.test.mjs"] });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][1]).toEqual([...UNIT_ARGV, "tests/integration/a.test.mjs"]);
  });

  it("unit-tier paths (tests/unit and root-level tests/) keep the unchanged unit argv", () => {
    const paths = ["tests/unit/foo.test.mjs", "tests/foo.test.mjs"];
    runProjectTests(ROOT, { testPaths: paths });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][1]).toEqual([...UNIT_ARGV, ...paths]);
  });

  it("mixed tiers spawn once per tier, each with only its own paths under its matching config", () => {
    runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs", "tests/integration/a.test.mjs", "tests/foo.test.mjs"] });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    const byConfig = Object.fromEntries(spawnSync.mock.calls.map((c) => [configOf(c), pathsOf(c)]));
    expect(byConfig["vitest.config.unit.mjs"]).toEqual(["tests/unit/foo.test.mjs", "tests/foo.test.mjs"]);
    expect(byConfig["vitest.config.mock.mjs"]).toEqual(["tests/integration/a.test.mjs"]);
  });

  it("mixed-tier passed is true when both partitions exit 0", () => {
    const r = runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs", "tests/integration/a.test.mjs"] });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it.each([["vitest.config.unit.mjs"], ["vitest.config.mock.mjs"]])("mixed-tier passed is false when the %s partition exits non-zero", (failing) => {
    spawnSync.mockImplementation((_cmd, args) => spawnResult(args.includes(failing) ? 1 : 0, "x"));
    const r = runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs", "tests/integration/a.test.mjs"] });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("no-tests-found output is flagged, never passed, and its summary differs from tests failed", () => {
    spawnSync.mockReturnValue(spawnResult(1, NO_FILES));
    const r = runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(r.noTestsFound).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.summary).not.toBe("tests failed");
    expect(r.noTestsFoundPaths).toEqual(["tests/unit/foo.test.mjs"]);
  });

  it("no-tests-found is never passed even when the process exits 0", () => {
    spawnSync.mockReturnValue(spawnResult(0, NO_FILES));
    const r = runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(r.noTestsFound).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("ordinary failure keeps its fields (field checks, never whole-object toEqual)", () => {
    spawnSync.mockReturnValue(spawnResult(1, "1 failed"));
    const r = runProjectTests(ROOT, { testPaths: ["tests/unit/foo.test.mjs"] });
    expect(r).toMatchObject({ passed: false, summary: "tests failed", exitCode: 1 });
    expect(r.noTestsFound ?? false).toBe(false);
  });

  it("a configured testCommand gets integration paths appended unchanged and no vitest --config", () => {
    const tmp = mkTemp("rks-testcmd-", { mockConfig: true });
    mkdirSync(join(tmp, ".rks"), { recursive: true });
    writeFileSync(join(tmp, ".rks", "project.json"), JSON.stringify({ testCommand: { cmd: "pytest", args: ["-q"] } }));
    runProjectTests(tmp, { testPaths: ["tests/integration/a.test.mjs"] });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][0]).toBe("pytest");
    expect(spawnSync.mock.calls[0][1]).toEqual(["-q", "tests/integration/a.test.mjs"]);
    expect(spawnSync.mock.calls[0][1]).not.toContain("--config");
  });
});

describe("runProjectTests mixed-tier merged results", () => {
  const MIXED = ["tests/unit/foo.test.mjs", "tests/integration/a.test.mjs"];

  it("collectTestResults uses a distinct report path per partition", () => {
    const reportDir = mkTemp("rks-reports-");
    runProjectTests(ROOT, { testPaths: MIXED, collectTestResults: { reportDir, reportName: "r.json" } });
    expect(spawnSync).toHaveBeenCalledTimes(2);
    const outFile = (args) => args.find((a) => String(a).includes(reportDir));
    const [a, b] = spawnSync.mock.calls.map((c) => outFile(c[1]));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("merges failing, passed and skipped across partitions and keeps available, runner, source", () => {
    const root = mkTemp("rks-mixed-", { mockConfig: true });
    writeReports((config) => (config === "vitest.config.unit.mjs"
      ? vitestReport([["tests/unit/foo.test.mjs", "u-pass", "passed"], ["tests/unit/foo.test.mjs", "u-skip", "skipped"]])
      : vitestReport([["tests/integration/a.test.mjs", "i-fail", "failed"], ["tests/integration/a.test.mjs", "i-pass", "passed"]])),
    (config) => (config === "vitest.config.mock.mjs" ? 1 : 0));
    const r = runProjectTests(root, { testPaths: MIXED, collectTestResults: { reportDir: join(root, "out"), reportName: "r.json" } });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.testResults).toMatchObject({ available: true, runner: "vitest", source: "vitest_json" });
    expect(r.testResults.passed).toEqual(expect.arrayContaining(["tests/unit/foo.test.mjs > u-pass", "tests/integration/a.test.mjs > i-pass"]));
    expect(r.testResults.failing).toEqual(["tests/integration/a.test.mjs > i-fail"]);
    expect(r.testResults.failed).toEqual(["tests/integration/a.test.mjs > i-fail"]);
    expect(r.testResults.skipped).toEqual(["tests/unit/foo.test.mjs > u-skip"]);
  });

  it("is unavailable with the failing partition's reason when any partition's results are unavailable", () => {
    const root = mkTemp("rks-mixed-", { mockConfig: true });
    writeReports((config) => (config === "vitest.config.unit.mjs" ? vitestReport([["tests/unit/foo.test.mjs", "u", "passed"]]) : null));
    const r = runProjectTests(root, { testPaths: MIXED, collectTestResults: { reportDir: join(root, "out"), reportName: "r.json" } });
    expect(r.testResults.available).toBe(false);
    expect(r.testResults.reason).toBe("report_missing");
  });

  it("concatenates output and takes exitCode from the first non-zero partition (0 only when all are 0)", () => {
    spawnSync.mockImplementation((_cmd, args) => (args.includes("vitest.config.unit.mjs")
      ? spawnResult(2, "UNIT-OUT")
      : spawnResult(1, "MOCK-OUT")));
    const r = runProjectTests(ROOT, { testPaths: MIXED });
    expect(r.output).toContain("UNIT-OUT");
    expect(r.output).toContain("MOCK-OUT");
    expect(r.exitCode).toBe(2);
    spawnSync.mockImplementation((_cmd, args) => (args.includes("vitest.config.unit.mjs") ? spawnResult(0, "u") : spawnResult(3, "m")));
    expect(runProjectTests(ROOT, { testPaths: MIXED }).exitCode).toBe(3);
  });

  it("noTestsFound is true when any partition reports it, naming that partition's paths", () => {
    spawnSync.mockImplementation((_cmd, args) => (args.includes("vitest.config.mock.mjs")
      ? spawnResult(1, NO_FILES)
      : spawnResult(0, "ok")));
    const r = runProjectTests(ROOT, { testPaths: MIXED });
    expect(r.noTestsFound).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.noTestsFoundPaths).toEqual(["tests/integration/a.test.mjs"]);
  });
});
