import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { runProjectTests } from "../../packages/mcp-rks/src/exec/command-runner.mjs";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn() };
});

const REPO_ROOT = path.join(fileURLToPath(import.meta.url), "../../..");

const ESC = "\u001b";
const SGR_RED = ESC + "[31m";
const SGR_RESET = ESC + "[0m";
const CSI_ERASE_LINE = ESC + "[2K";
const CSI_UP = ESC + "[1A";
const OSC_BEL = ESC + "]0;pytest" + "\u0007";
const OSC_ST = ESC + "]0;pytest" + ESC + "\\";

// Byte-identical to command-runner.mjs today (scoped branch, default timeout 300000).
const PATHS = ["tests/unit/foo.test.mjs", "tests/unit/bar.test.mjs"];
const BASELINE_ARGV = [
  "scripts/vitest-runner.mjs",
  "--config",
  "vitest.config.unit.mjs",
  "--timeout",
  "295000",
  "tests/unit/foo.test.mjs",
  "tests/unit/bar.test.mjs",
];

let tmpRoot;
let errSpy;

function spawnResult(status, stdout = "", stderr = "") {
  return { status, signal: null, stdout, stderr };
}

function writeProjectJson(value) {
  fs.mkdirSync(path.join(tmpRoot, ".rks"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, ".rks", "project.json"),
    typeof value === "string" ? value : JSON.stringify(value, null, 2)
  );
}

function writePackageJson() {
  fs.writeFileSync(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { "test:unit": "vitest run" } }, null, 2)
  );
}

function testCommandWarnings() {
  return errSpy.mock.calls.filter((c) => String(c[0]).includes("testCommand"));
}

function spawnOpts() {
  return spawnSync.mock.calls[0][2];
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-test-command-"));
  spawnSync.mockReset();
  spawnSync.mockReturnValue(spawnResult(0, "ok\n", ""));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("RULE 1 — no-config parity (PIN: must stay green before and after)", () => {
  it("req 1: no .rks directory at all — scoped argv is byte-identical, element by element", () => {
    runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(spawnSync.mock.calls[0][0]).toBe("node");
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
  });

  it("req 2: real .rks/project.json on disk with NO testCommand — same argv, element by element", () => {
    writeProjectJson({ id: "fixture", root: ".", schemaVersion: 1 });
    runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(spawnSync.mock.calls[0][0]).toBe("node");
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
  });

  it("req 3: --timeout stays String(Math.max(timeout - 5000, 30000)) at a custom timeout", () => {
    runProjectTests(tmpRoot, { testPaths: PATHS, timeout: 40000 });
    expect(spawnSync.mock.calls[0][1]).toEqual([
      "scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", "35000", ...PATHS,
    ]);
  });

  it("req 3: --timeout floors at 30000 when timeout - 5000 would go below it", () => {
    runProjectTests(tmpRoot, { testPaths: PATHS, timeout: 10000 });
    expect(spawnSync.mock.calls[0][1]).toEqual([
      "scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", "30000", ...PATHS,
    ]);
  });

  it("req 4: empty testPaths with no runner detectable returns the exact skip object and never spawns", () => {
    const result = runProjectTests(tmpRoot, { testPaths: [] });
    expect(result).toEqual({ passed: true, skipped: true, reason: "no test runner detected" });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("req 5: empty testPaths still consults detectTestRunner and uses its cmd/args", () => {
    writePackageJson();
    runProjectTests(tmpRoot, { testPaths: [] });
    expect(spawnSync.mock.calls[0][0]).toBe("npm");
    expect(spawnSync.mock.calls[0][1]).toEqual(["run", "test:unit"]);
  });

  it("req 6: spawnSync options carry no shell property on the no-config branch", () => {
    runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(Object.prototype.hasOwnProperty.call(spawnOpts(), "shell")).toBe(false);
    expect(spawnOpts().shell).toBeFalsy();
  });

  it("req 24: this repository's own .rks/project.json declares no testCommand", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".rks", "project.json"), "utf8"));
    expect(Object.prototype.hasOwnProperty.call(cfg, "testCommand")).toBe(false);
  });
});

describe("RULE 2 — Python path via a real on-disk .rks/project.json fixture", () => {
  it("req 7: the fixture is a real file on disk and no command is injected via options", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest", args: ["-q"] } });
    const cfgPath = path.join(tmpRoot, ".rks", "project.json");
    expect(fs.existsSync(cfgPath)).toBe(true);
    runProjectTests(tmpRoot, { testPaths: ["tests/test_foo.py"] });
    expect(spawnSync.mock.calls[0][0]).toBe("pytest");
  });

  it("req 8: testCommand + testPaths resolves to pytest with args then paths, and no vitest anywhere", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest", args: ["-q"] } });
    runProjectTests(tmpRoot, { testPaths: ["tests/test_foo.py"] });
    const [cmd, argv] = spawnSync.mock.calls[0];
    expect(cmd).toBe("pytest");
    expect(argv).toEqual(["-q", "tests/test_foo.py"]);
    expect(JSON.stringify([cmd, ...argv])).not.toContain("vitest");
  });

  it("req 9: testCommand without testPaths wins over detectTestRunner", () => {
    writePackageJson();
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest", args: ["-q"] } });
    runProjectTests(tmpRoot, {});
    expect(spawnSync.mock.calls[0][0]).toBe("pytest");
    expect(spawnSync.mock.calls[0][1]).toEqual(["-q"]);
    expect(spawnSync.mock.calls[0][0]).not.toBe("npm");
  });

  it("req 10: testCommand with args omitted resolves to an empty args list", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest" } });
    runProjectTests(tmpRoot, {});
    expect(spawnSync.mock.calls[0][1]).toEqual([]);
  });

  it("req 10: testCommand with args omitted still appends testPaths", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest" } });
    runProjectTests(tmpRoot, { testPaths: ["tests/test_foo.py"] });
    expect(spawnSync.mock.calls[0][1]).toEqual(["tests/test_foo.py"]);
  });

  it("req 6: spawnSync options carry no shell property on the configured branch", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest", args: ["-q"] } });
    runProjectTests(tmpRoot, { testPaths: ["tests/test_foo.py"] });
    expect(Object.prototype.hasOwnProperty.call(spawnOpts(), "shell")).toBe(false);
    expect(spawnOpts().shell).toBeFalsy();
  });

  it("req 14: a cmd that does not exist degrades to passed:false with empty output and no throw", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "rks-definitely-not-a-real-binary" } });
    spawnSync.mockReturnValue({
      status: null, signal: null, stdout: null, stderr: null,
      error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }),
    });
    let result;
    expect(() => { result = runProjectTests(tmpRoot, {}); }).not.toThrow();
    expect(result.passed).toBe(false);
    expect(result.output).toBe("");
  });
});

describe("Malformed and hostile config is contained — treated exactly as absent", () => {
  const MALFORMED = [
    ["a shell string instead of an object", "pytest -q"],
    ["a number", 42],
    ["an array", []],
    ["an object with no cmd", {}],
    ["an empty cmd", { cmd: "" }],
    ["args that are not an array", { cmd: "pytest", args: "-q" }],
    ["args containing a non-string", { cmd: "pytest", args: ["-q", 7] }],
  ];

  it.each(MALFORMED)("req 11: %s produces the no-config argv, no throw, and one testCommand warning", (_label, value) => {
    writeProjectJson({ id: "fixture", testCommand: value });
    let result;
    expect(() => { result = runProjectTests(tmpRoot, { testPaths: PATHS }); }).not.toThrow();
    expect(spawnSync.mock.calls[0][0]).toBe("node");
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
    expect(result.passed).toBe(true);
    expect(testCommandWarnings()).toHaveLength(1);
  });

  it("req 12: testCommand null is absence, not malformation — no warning is emitted", () => {
    writeProjectJson('{ "id": "fixture", "testCommand": null }');
    runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
    expect(testCommandWarnings()).toHaveLength(0);
  });

  it("req 12: a project.json with no testCommand key emits no warning", () => {
    writeProjectJson({ id: "fixture" });
    runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
    expect(testCommandWarnings()).toHaveLength(0);
  });

  it("req 13: unparseable project.json degrades to the no-config argv with one warning and no throw", () => {
    writeProjectJson("{ this is not json");
    let result;
    expect(() => { result = runProjectTests(tmpRoot, { testPaths: PATHS }); }).not.toThrow();
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
    expect(result.passed).toBe(true);
    expect(testCommandWarnings()).toHaveLength(1);
  });

  it("req 13: an absent project.json degrades to the no-config argv with no throw", () => {
    expect(fs.existsSync(path.join(tmpRoot, ".rks", "project.json"))).toBe(false);
    expect(() => runProjectTests(tmpRoot, { testPaths: PATHS })).not.toThrow();
    expect(spawnSync.mock.calls[0][1]).toEqual(BASELINE_ARGV);
  });
});

describe("ANSI escapes are stripped from captured output at every sink", () => {
  const COLOURED = SGR_RED + "FAILED" + SGR_RESET + " tests/test_a.py ✓\n";
  const VISIBLE = "FAILED tests/test_a.py ✓\n";

  it("req 15: SGR colour and reset are removed while the visible text survives exactly", () => {
    spawnSync.mockReturnValue(spawnResult(0, COLOURED, ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(result.output).toBe(VISIBLE);
    expect(result.output).not.toContain(ESC);
  });

  it("req 16: non-SGR CSI sequences used by progress output are removed", () => {
    spawnSync.mockReturnValue(spawnResult(0, CSI_ERASE_LINE + "12 passed" + CSI_UP + "\n", ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(result.output).toBe("12 passed\n");
    expect(result.output).not.toContain(ESC);
  });

  it("req 17: OSC sequences terminated by BEL and by ST are both removed", () => {
    spawnSync.mockReturnValue(spawnResult(0, OSC_BEL + "a", OSC_ST + "b"));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(result.output).toBe("ab");
    expect(result.output).not.toContain(ESC);
  });

  it("req 18: .rks/test-runner-full-output.txt is written stripped", () => {
    spawnSync.mockReturnValue(spawnResult(0, COLOURED, ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    const written = fs.readFileSync(path.join(tmpRoot, ".rks", "test-runner-full-output.txt"), "utf8");
    expect(written).not.toContain(ESC);
    expect(written).toBe(result.output);
  });

  it("req 19: the debug JSON outputPreview is written stripped", () => {
    spawnSync.mockReturnValue(spawnResult(0, COLOURED, ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    const debug = JSON.parse(fs.readFileSync(path.join(tmpRoot, ".rks", "test-runner-debug.json"), "utf8"));
    expect(debug.result.outputPreview).not.toContain(ESC);
    expect(debug.result.outputPreview).toBe(result.output.slice(0, 2000));
  });

  it("req 20: escape-free output passes through byte-identical", () => {
    const clean = "✓ ok\tcol\r\nliteral \\x1b[31m stays\n";
    spawnSync.mockReturnValue(spawnResult(0, clean, ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(result.output).toBe(clean);
  });
});

describe("Pass/fail derivation is untouched by stripping or command resolution", () => {
  const NOISY = SGR_RED + "boom" + SGR_RESET + "\n";

  it("req 21: status 0 on the no-config branch still yields passed true / all tests passed", () => {
    spawnSync.mockReturnValue(spawnResult(0, NOISY, ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe("all tests passed");
  });

  it("req 21: status 1 on the no-config branch still yields passed false / tests failed", () => {
    spawnSync.mockReturnValue(spawnResult(1, NOISY, ""));
    const result = runProjectTests(tmpRoot, { testPaths: PATHS });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe("tests failed");
  });

  it("req 21: status 1 on the configured branch still yields passed false / tests failed", () => {
    writeProjectJson({ id: "fixture", testCommand: { cmd: "pytest", args: ["-q"] } });
    spawnSync.mockReturnValue(spawnResult(1, NOISY, ""));
    const result = runProjectTests(tmpRoot, { testPaths: ["tests/test_foo.py"] });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe("tests failed");
    expect(result.exitCode).toBe(1);
  });
});

describe("Implementation constraints", () => {
  it("req 22: no ANSI-stripping package was added to package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    expect(Object.keys(all)).not.toContain("strip-ansi");
    expect(Object.keys(all)).not.toContain("ansi-regex");
  });

  it("req 23: spawnSync is mocked for every test in this file — no real subprocess is spawned", () => {
    expect(vi.isMockFunction(spawnSync)).toBe(true);
  });
});
