import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { spawnManaged, ALL_EXIT_CODES } from "../../../../scripts/lib/spawn-managed.mjs";
import { scanShellWords } from "../../../hooks/lib/shell-words.mjs";
import {
  UNAVAILABLE,
  detectResultAdapter,
  resultCollectionArgs,
  parsePytestSummary,
  parsePytestCounts,
  parseVitestJsonReport,
} from "./test-results.mjs";
import { isProtectedPath } from "../server/project.mjs";

/**
 * Detect test runner based on package.json scripts and dependencies.
 * Returns { cmd, args } or null if no test runner detected.
 */
export function detectTestRunner(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    // Prefer explicit test:unit script
    if (pkg.scripts?.["test:unit"]) return { cmd: "npm", args: ["run", "test:unit"] };
    // Fall back to test script
    if (pkg.scripts?.test) return { cmd: "npm", args: ["test"] };
    // Detect vitest
    if (pkg.devDependencies?.vitest) return { cmd: "npx", args: ["vitest", "run"] };
    // Detect jest
    if (pkg.devDependencies?.jest) return { cmd: "npx", args: ["jest"] };

    return null;
  } catch {
    return null;
  }
}

/**
 * Run project tests and return results.
 * Returns { passed, skipped, reason?, output?, summary?, testsSkipped? }
 */
/**
 * Strip ANSI escape sequences from captured test output.
 *
 * backlog.feat.per-project-test-command: once a project declares its own testCommand,
 * that runner's own config becomes live — pytest.ini `addopts` with `--color=yes`, for
 * instance — and the escapes land in everything downstream of the single `output` string
 * below: the returned result, .rks/test-runner-full-output.txt, the debug JSON preview,
 * stderr, and exec.mjs's test log and parseTestCounts.
 *
 * Two alternations, deliberately. The OSC arm (window-title sequences, terminated by BEL
 * or ESC-backslash) is separate because the CSI arm cannot be widened to admit `]` without
 * over-matching. git-release.mjs carries a CSI-only ANSI_REGEX; it is module-local and not
 * exported, and sharing it would drag the release path into this story's blast radius, so
 * the pattern is duplicated rather than extracted.
 */
const ANSI_PATTERN = new RegExp(
  [
    // OSC: ESC ] ... ( BEL | ESC \ )
    "[\\u001b\\u009b]\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)",
    // CSI: ESC [ ... final byte
    "[\\u001b\\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]",
  ].join("|"),
  "g",
);

export function stripAnsi(text) {
  return typeof text === "string" ? text.replace(ANSI_PATTERN, "") : "";
}

/**
 * Resolve a project-declared test command from .rks/project.json.
 *
 * Returns { cmd, args } or null. NEVER throws, and warns at most once.
 *
 * Absence is not a new code path — a missing file, an unreadable container, a missing key
 * and an explicit null all return null silently, and the caller then behaves exactly as it
 * did before this function existed. Only a PRESENT but malformed value warns.
 *
 * argv array only, never a string. spawnSync below is called without `shell`, so a string
 * form would be looked up as a literal filename; supporting one would need either a
 * splitter (quoting bugs) or shell: true (injection, from a child project's config file).
 *
 * The read, the parse and the field access share ONE try/catch: guarding only the parse
 * would leave the field access exposed when JSON.parse returns null for the literal "null".
 */
export function resolveTestCommand(projectRoot) {
  let raw;
  try {
    const configPath = path.join(projectRoot, ".rks", "project.json");
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    raw = parsed.testCommand;
  } catch (err) {
    console.error(
      `[rks.exec] runProjectTests - could not read testCommand from .rks/project.json ` +
        `(${err && err.message ? err.message : String(err)}); using the default runner`,
    );
    return null;
  }

  if (raw === undefined || raw === null) return null;

  const refuse = (why) => {
    console.error(
      `[rks.exec] runProjectTests - ignoring malformed testCommand in .rks/project.json ` +
        `(${why}); using the default runner`,
    );
    return null;
  };

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("expected an object with a cmd string");
  }
  if (typeof raw.cmd !== "string" || raw.cmd.trim() === "") {
    return refuse("cmd must be a non-empty string");
  }
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")) {
      return refuse("args must be an array of strings");
    }
  }

  return { cmd: raw.cmd, args: Array.isArray(raw.args) ? [...raw.args] : [] };
}

/**
 * The vitest config tiers a scoped built-in run can route a test path to
 * (backlog.fix.exec-scoped-tests-integration-config-routing).
 *
 * Kept consistent with the configs' own include globs, not a second divergent list:
 * - vitest.config.unit.mjs includes `tests/unit/**`, `tests/*.test.*` and `tests/*.spec.*`;
 *   it is the default for every path that is not integration-tier (unchanged argv).
 * - vitest.config.mock.mjs includes `tests/integration/**\/*.test.*` and `.spec.*`. A path under
 *   INTEGRATION_PREFIX runs under it ONLY when `<projectRoot>/vitest.config.mock.mjs` exists —
 *   child projects get no mock config from templates/, and their unit shim already includes
 *   `tests/**\/*.test.*`, so for them every path keeps the unit argv.
 */
const UNIT_CONFIG = "vitest.config.unit.mjs";
const MOCK_CONFIG = "vitest.config.mock.mjs";
const INTEGRATION_PREFIX = "tests/integration/";

/** vitest's own zero-selection message — the filter matched nothing under the config's include. */
const NO_TESTS_FOUND = /No test files found/;

/** Split scoped testPaths into per-config partitions, in first-seen tier order. */
function partitionByConfig(projectRoot, testPaths) {
  let mockExists = false;
  try { mockExists = fs.existsSync(path.join(projectRoot, MOCK_CONFIG)); } catch { mockExists = false; }
  if (!mockExists) return [{ tier: "unit", config: UNIT_CONFIG, paths: [...testPaths] }];

  const isIntegration = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "").startsWith(INTEGRATION_PREFIX);
  const partitions = [];
  for (const p of testPaths) {
    const tier = isIntegration(p) ? "integration" : "unit";
    let part = partitions.find((x) => x.tier === tier);
    if (!part) {
      part = { tier, config: tier === "integration" ? MOCK_CONFIG : UNIT_CONFIG, paths: [] };
      partitions.push(part);
    }
    part.paths.push(p);
  }
  return partitions;
}

/** A distinct report path per partition when there is more than one: `<name>.<tier><ext>`. */
function partitionReportName(reportName, tier, partitionCount) {
  const base = reportName || "test-results.json";
  if (partitionCount <= 1) return base;
  const ext = path.extname(base);
  return `${ext ? base.slice(0, -ext.length) : base}.${tier}${ext}`;
}

/**
 * `collectTestResults: { reportDir?, reportName? }` (backlog.feat.exec-declared-red-baseline-tests)
 * asks for per-test outcomes. Only then are adapter args injected and a `testResults` record
 * returned; without it the argv and the result shape are exactly what they were before.
 *
 * A vitest "No test files found" outcome is reported as `noTestsFound: true` (with
 * `noTestsFoundPaths`), never `passed: true` — an unexecuted test proves nothing. Result fields
 * are additive: callers must not depend on the exact key set.
 *
 * `command: { cmd, args }` (backlog.feat.full-suite-regression-gate) is an optional argv
 * override. It wins over a declared testCommand and over both built-in branches; absent,
 * the spawned argv is unchanged. Every spawned result carries `command` — the argv actually
 * handed to spawnSync — and a merged multi-partition result carries `commands` instead.
 */
export function runProjectTests(projectRoot, options = {}) {
  const { timeout = 300000, storyMetadata = {}, testPaths = null, collectTestResults = null, command: commandOverride = null } = options;

  // Skip tests if story has a paired test story (testStory field is set and non-empty)
  if (storyMetadata.testStory) {
    return { passed: true, skipped: true, reason: "paired test story", testsSkipped: true };
  }

  // A project-declared command wins over BOTH built-in branches. It is checked first so a
  // Python project stops spawning vitest, and so detectTestRunner is not consulted for a
  // project that has already said what its tests are.
  const configuredTestCommand = resolveTestCommand(projectRoot);

  // Adapter args go AFTER the runner's own args (pytest's -r and --color are last-occurrence-wins)
  // and BEFORE testPaths. Empty unless collectTestResults was requested.
  const collectionFor = (runnerCmd, runnerArgs, builtin, reportName) => {
    if (!collectTestResults) return { adapter: null, reportPath: null, args: [] };
    const adapter = detectResultAdapter(runnerCmd, runnerArgs);
    let reportPath = null;
    if (adapter === "vitest") {
      const reportDir = collectTestResults.reportDir || path.join(projectRoot, ".rks");
      reportPath = path.resolve(reportDir, reportName || collectTestResults.reportName || "test-results.json");
    }
    return { adapter, reportPath, args: resultCollectionArgs(adapter, { builtin, reportPath }) };
  };

  // A caller-supplied argv (the full-suite gate's fullSuiteGate.command) wins over the
  // declared testCommand and both built-in branches.
  if (commandOverride && typeof commandOverride.cmd === "string" && commandOverride.cmd.trim() !== "") {
    const cmd = commandOverride.cmd;
    const overrideArgs = Array.isArray(commandOverride.args) ? [...commandOverride.args] : [];
    const c = collectionFor(cmd, overrideArgs, false);
    const args = [...overrideArgs, ...c.args, ...(testPaths || [])];
    return spawnTestRun(projectRoot, { cmd, args, timeout, collectTestResults, adapter: c.adapter, reportPath: c.reportPath, testPaths: testPaths || [] });
  }

  if (configuredTestCommand) {
    const cmd = configuredTestCommand.cmd;
    const c = collectionFor(cmd, configuredTestCommand.args, false);
    const args = [...configuredTestCommand.args, ...c.args, ...(testPaths || [])];
    return spawnTestRun(projectRoot, { cmd, args, timeout, collectTestResults, adapter: c.adapter, reportPath: c.reportPath, testPaths: testPaths || [] });
  }

  if (testPaths && testPaths.length > 0) {
    // Pass --timeout so vitest-runner's internal wall-clock matches spawnSync's
    // outer timeout, leaving a 5s buffer for graceful cleanup.
    const vitestTimeout = Math.max(timeout - 5000, 30000);
    const cmd = "node";
    const partitions = partitionByConfig(projectRoot, testPaths);
    const results = partitions.map((part) => {
      const c = collectionFor(cmd, ["scripts/vitest-runner.mjs"], true,
        partitionReportName(collectTestResults?.reportName, part.tier, partitions.length));
      const args = ["scripts/vitest-runner.mjs", "--config", part.config, "--timeout", String(vitestTimeout),
        ...c.args, ...part.paths];
      return spawnTestRun(projectRoot, { cmd, args, timeout, collectTestResults, adapter: c.adapter, reportPath: c.reportPath, testPaths: part.paths });
    });
    return results.length === 1 ? results[0] : mergePartitionResults(results, collectTestResults);
  }

  const runner = detectTestRunner(projectRoot);
  if (!runner) {
    return { passed: true, skipped: true, reason: "no test runner detected" };
  }
  const c = collectionFor(runner.cmd, runner.args, false);
  const args = collectTestResults ? [...runner.args, ...c.args] : runner.args;
  return spawnTestRun(projectRoot, { cmd: runner.cmd, args, timeout, collectTestResults, adapter: c.adapter, reportPath: c.reportPath, testPaths: [] });
}

/**
 * Whether a verification result is an observed test execution
 * (backlog.fix.exec-tests-passed-requires-observed-execution). False for no run (null or
 * undefined), a skipped run, a spawn failure, a run that found no tests (noTestsFound, which
 * every proven-empty run also carries) and a run whose counts line shows zero executed. True
 * for an observed spawn that executed tests or whose count is unknown, passed or failed.
 */
export function testsRanFromVerification(verification) {
  if (!verification || typeof verification !== "object") return false;
  if (verification.skipped === true) return false;
  if (verification.spawnError) return false;
  if (verification.noTestsFound === true) return false;
  if (verification.executedCount === 0) return false;
  return true;
}

/** One spawn of the test runner and its result. */
function spawnTestRun(projectRoot, { cmd, args, timeout, collectTestResults, adapter, reportPath, testPaths }) {
  // A stale report from an earlier run must never be read as this run's outcome.
  if (reportPath) {
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.rmSync(reportPath, { force: true });
    } catch { /* an unremovable report is caught below: parse reads only what this run wrote */ }
  }

  // The argv observed at the spawn site, stamped on every result this function returns.
  const command = { cmd, args: [...(args || [])] };

  const result = spawnSync(cmd, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Handle timeout
  if (result.signal === "SIGTERM") {
    return {
      passed: false,
      skipped: false,
      output: "Test run timed out",
      summary: "timeout",
      command,
      ...(collectTestResults ? { testResults: { ...UNAVAILABLE("timeout"), runner: adapter } } : {}),
    };
  }

  const output = stripAnsi((result.stdout || "") + (result.stderr || ""));

  // File-based debug logging to help diagnose environment differences between CLI and MCP
  try {
    const debugPath = path.join(projectRoot, '.rks', 'test-runner-debug.json');
    // Ensure directory exists
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      projectRoot,
      runner: { cmd, args },
      result: {
        status: result.status,
        signal: result.signal,
        outputLength: output.length,
        outputPreview: output.slice(0, 2000)
      }
    }, null, 2));
    fs.writeFileSync(path.join(projectRoot, '.rks', 'test-runner-full-output.txt'), output);
  } catch (err) {
    // Debug logging should never break test execution
  }

  // Debug: log exit code, signal, and a truncated output to help diagnose false positive test failures
  try {
    console.error(`[rks.exec] runProjectTests - cmd: ${cmd} ${args ? args.join(' ') : ''}, exitCode: ${result.status}, signal: ${result.signal}`);
    console.error(`[rks.exec] runProjectTests - output (truncated 2000 chars): ${output.slice(0, 2000)}`);
  } catch (err) {
    console.warn(`[rks.exec] runProjectTests - failed to log debug info: ${err && err.message ? err.message : String(err)}`);
  }

  // Zero files selected is not a pass and not an ordinary failure: never passed, even on exit 0.
  if (NO_TESTS_FOUND.test(output)) {
    return {
      passed: false,
      skipped: false,
      output,
      summary: "no test files found",
      exitCode: result.status,
      noTestsFound: true,
      noTestsFoundPaths: [...(testPaths || [])],
      command,
      ...(collectTestResults ? { testResults: collectResults(adapter, output, reportPath, projectRoot) } : {}),
    };
  }

  // The observation behind the verdict (backlog.fix.exec-tests-passed-requires-observed-execution).
  // spawnError: the spawn itself failed (e.g. ENOENT), so nothing executed.
  // executedCount = passed + failed + error + xfailed + xpassed when
  // parsePytestCounts(output).available is true, and null otherwise (vitest, jest, unrecognised).
  const spawnError = result.error ? String(result.error.message || result.error) : null;
  const counts = parsePytestCounts(output);
  const executedCount = counts.available
    ? counts.passed + counts.failed + counts.error + counts.xfailed + counts.xpassed
    : null;
  const testResultsField = collectTestResults ? { testResults: collectResults(adapter, output, reportPath, projectRoot) } : {};

  // Proven empty: exit 0, yet the counts line shows zero tests executed (pytest's empty-run
  // line, or a skipped-only run). Never a pass. It also carries noTestsFound, so exec's
  // non-refinable no_tests_found exit and the ship gate's no_tests_found block both apply;
  // noTestsExecuted lets the pre-apply baseline refuse it as baseline_no_tests_executed.
  if (!spawnError && result.status === 0 && executedCount === 0) {
    return {
      passed: false,
      skipped: false,
      output,
      summary: "no tests executed",
      exitCode: result.status,
      noTestsFound: true,
      noTestsExecuted: true,
      noTestsFoundPaths: [...(testPaths || [])],
      spawnError,
      executedCount,
      command,
      ...testResultsField,
    };
  }

  if (executedCount === null && !spawnError) {
    console.error(`[rks.exec] runProjectTests - executed-test count unknown (no pytest counts line): verdict decided by exit code alone (exitCode: ${result.status})`);
  }

  const passed = result.status === 0 && !spawnError;
  return {
    passed,
    skipped: false,
    output,
    summary: spawnError ? `spawn failed: ${spawnError}` : (passed ? "all tests passed" : "tests failed"),
    exitCode: result.status,
    spawnError,
    executedCount,
    command,
    ...testResultsField,
  };
}

/**
 * Combine per-tier partition results into one: passed only if every partition passed;
 * exitCode is the first non-zero partition's (0 only when all are 0); output concatenated;
 * noTestsFound when any partition reports it, naming that partition's paths. Merged
 * testResults are unavailable (with the first unavailable partition's reason) if any are.
 */
export function mergePartitionResults(results, collectTestResults) {
  const passed = results.every((r) => r.passed === true);
  const firstBad = results.find((r) => r.exitCode !== 0);
  const noTests = results.filter((r) => r.noTestsFound);
  const firstFailed = results.find((r) => !r.passed);
  const merged = {
    passed,
    skipped: false,
    output: results.map((r) => r.output || "").join("\n"),
    summary: passed ? "all tests passed" : (noTests.length > 0 ? "no test files found" : firstFailed.summary || "tests failed"),
    exitCode: firstBad ? (firstBad.exitCode ?? null) : 0,
    // Each partition's spawned argv, in spawn order. No single `command`: none ran alone.
    commands: results.map((r) => r.command),
    // The first partition's spawn failure, if any; a sum only when every partition observed a count.
    spawnError: results.find((r) => r.spawnError)?.spawnError ?? null,
    executedCount: results.every((r) => typeof r.executedCount === "number")
      ? results.reduce((n, r) => n + r.executedCount, 0)
      : null,
  };
  if (noTests.length > 0) {
    merged.noTestsFound = true;
    merged.noTestsFoundPaths = noTests.flatMap((r) => r.noTestsFoundPaths || []);
    if (noTests.some((r) => r.noTestsExecuted)) merged.noTestsExecuted = true;
  }
  if (collectTestResults) merged.testResults = mergeTestResults(results.map((r) => r.testResults));
  return merged;
}

/** Union per-test outcomes across partitions; keeps available, runner and source. */
function mergeTestResults(list) {
  const unavailable = list.find((r) => !r || !r.available);
  if (unavailable) {
    return {
      ...UNAVAILABLE(unavailable?.reason || "report_missing"),
      runner: unavailable?.runner ?? list.find((r) => r?.runner)?.runner ?? null,
    };
  }
  const cat = (k) => [...new Set(list.flatMap((r) => r[k] || []))];
  return {
    available: true,
    runner: list[0].runner || null,
    source: list[0].source || null,
    passed: cat("passed"),
    failed: cat("failed"),
    error: cat("error"),
    failing: [...new Set([...cat("failing"), ...cat("failed"), ...cat("error")])],
    xfailed: cat("xfailed"),
    xpassed: cat("xpassed"),
    skipped: cat("skipped"),
    skippedCount: list.reduce((n, r) => n + (r.skippedCount || 0), 0),
    deselectedCount: list.reduce((n, r) => n + (r.deselectedCount || 0), 0),
  };
}

/** Per-test outcomes for a finished run; unavailable unless the adapter's output proves them. */
function collectResults(adapter, output, reportPath, projectRoot) {
  if (adapter === "pytest") return parsePytestSummary(output);
  if (adapter === "vitest") {
    let report = null;
    try {
      if (reportPath && fs.existsSync(reportPath)) report = fs.readFileSync(reportPath, "utf8");
    } catch { /* unreadable → report_missing */ }
    return parseVitestJsonReport(report, projectRoot);
  }
  return { ...UNAVAILABLE("runner_not_recognized"), runner: null };
}

/**
 * The run_command policy file, relative to the project root. loadCommandPolicy reads it and
 * isCommandPolicyTarget guards it, so the reader and the guard cannot name different files.
 */
export const COMMAND_POLICY_RELATIVE_PATH = ".routekit/command-policy.yaml";

/**
 * True when a plan step target resolves to the command policy file. Path-based, not string-based:
 * resolved against projectRoot, separators normalized to "/", compared case-insensitively
 * (APFS default volumes are case-insensitive). A target outside projectRoot never matches.
 */
export function isCommandPolicyTarget(projectRoot, target) {
  if (typeof target !== "string" || !target.trim()) return false;
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved).split(path.sep).join("/");
  if (rel.toLowerCase() === COMMAND_POLICY_RELATIVE_PATH.toLowerCase()) return true;

  // backlog.fix.command-policy-integrity-across-runs (F12): a target that reaches the policy file
  // through a symlink (a symlinked directory, or a symlink file) resolves to it on disk. The realpath
  // of the target's nearest EXISTING ancestor, joined with the remaining not-yet-existing segments,
  // is compared with the realpath of the policy file. With no policy file the lexical rule alone applies.
  let policyReal;
  try {
    policyReal = fs.realpathSync(path.join(root, ...COMMAND_POLICY_RELATIVE_PATH.split("/")));
  } catch {
    return false;
  }
  const rest = [];
  let cur = resolved;
  for (;;) {
    let real = null;
    try {
      real = fs.realpathSync(cur);
    } catch {
      real = null;
    }
    if (real !== null) {
      const candidate = rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
      return candidate.toLowerCase() === policyReal.toLowerCase();
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * backlog.fix.exec-commit-set-protected-paths: the built-in governance floor. A path under one of
 * these prefixes (or equal to one without its trailing slash) is a governance path no on-rail exec
 * mechanism may write or commit. No operator config can shrink this set; .rks/protected-files.yml
 * patterns are only ever ADDED on top of it.
 */
export const GOVERNANCE_PATH_PREFIXES = Object.freeze([".routekit/", ".rks/", ".claude/", ".git/"]);

/**
 * The root-free, lexical half of isGovernancePath. `relPath` must already be a normalized,
 * root-relative, "/"-separated path (planDeclaredOutputs produces exactly that form). Compared
 * case-insensitively: equal to a prefix without its trailing slash, starting with a prefix, or equal
 * to COMMAND_POLICY_RELATIVE_PATH. A non-string or empty input fails closed (true).
 */
export function isGovernanceRelPath(relPath) {
  if (typeof relPath !== "string") return true;
  const rel = relPath.replace(/\\/g, "/").replace(/^(\.\/)+/, "").toLowerCase();
  if (!rel) return true;
  if (rel === COMMAND_POLICY_RELATIVE_PATH.toLowerCase()) return true;
  return GOVERNANCE_PATH_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
}

/**
 * True when `relPath` is a governance path in `projectRoot`: backslashes converted to "/", resolved
 * against projectRoot (so "." and ".." collapse) and made relative, then matched by
 * isGovernanceRelPath; OR isCommandPolicyTarget (which also follows symlinks to the policy file);
 * OR an operator .rks/protected-files.yml pattern in `projectPatterns`. isProtectedPath is consulted
 * only when patterns are supplied, so callers that pass none never read that binding (several tests
 * factory-mock server/project.mjs without it). An unparsable or non-string input fails closed (true).
 */
export function isGovernancePath(projectRoot, relPath, projectPatterns = []) {
  if (typeof relPath !== "string" || !relPath.trim()) return true;
  let rel;
  try {
    const root = path.resolve(projectRoot);
    const resolved = path.resolve(root, relPath.trim().replace(/\\/g, "/"));
    rel = path.relative(root, resolved).split(path.sep).join("/");
  } catch {
    return true;
  }
  // A path outside projectRoot is not one of this project's governance paths (isCommandPolicyTarget
  // applies the same rule). The project root itself is not a governance path either.
  if (rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel) && isGovernanceRelPath(rel)) return true;
  try {
    if (isCommandPolicyTarget(projectRoot, relPath)) return true;
  } catch {
    return true;
  }
  if (Array.isArray(projectPatterns) && projectPatterns.length > 0) {
    if (isProtectedPath(rel, projectPatterns) || isProtectedPath(relPath, projectPatterns)) return true;
  }
  return false;
}

/** The policy loadCommandPolicy falls back to when the file is missing or unreadable. */
function defaultCommandPolicy() {
  return {
    auto_execute: ["git status", "git diff", "npm test", "npm run lint", "npm run build"],
    execute_with_plan_approval: ["git add", "git rm --cached", "git commit", "npm install"],
    require_explicit_confirmation: ["rm", "git reset", "git push --force", "git branch -D"],
  };
}

/** Parse policy file text exactly as loadCommandPolicy does (defaults on a parse failure). */
function parseCommandPolicyText(content) {
  try {
    const parsed = yaml.load(content);
    return parsed?.command_policy || defaultCommandPolicy();
  } catch {
    return defaultCommandPolicy();
  }
}

/**
 * Load command policy from project root.
 * Falls back to sensible defaults if file is missing.
 */
export function loadCommandPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, ...COMMAND_POLICY_RELATIVE_PATH.split("/"));
  if (!fs.existsSync(policyPath)) return defaultCommandPolicy();

  try {
    const content = fs.readFileSync(policyPath, "utf8");
    return parseCommandPolicyText(content);
  } catch {
    return defaultCommandPolicy();
  }
}

// ---------------------------------------------------------------------------
// backlog.fix.command-policy-integrity-across-runs: the policy STATE (worktree bytes, index entry,
// HEAD blob) captured once per exec, compared after plan-influenced code runs, and restored.
// git is spawned argv-only (no shell) with an explicit timeout.
// ---------------------------------------------------------------------------

const POLICY_GIT_TIMEOUT_MS = 15_000;
const POLICY_PARTS = ["worktree", "index", "head"];

function policyGit(projectRoot, args) {
  let r;
  try {
    r = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: POLICY_GIT_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, stdout: "", error: err?.message || String(err) };
  }
  r = r || {};
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.message || String(r.error)) : `exit ${r.status ?? "null"}${r.signal ? ` (${r.signal})` : ""}`;
    return { ok: false, stdout, error: `git ${args.join(" ")} failed: ${why}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}` };
  }
  return { ok: true, stdout, error: null };
}

/** A git work tree in the sense exec uses (a .git entry at projectRoot), confirmed by git itself. */
function isPolicyGitWorkTree(projectRoot) {
  try {
    if (!fs.existsSync(path.join(projectRoot, ".git"))) return false;
  } catch {
    return false;
  }
  const r = policyGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

function policyAbsPath(projectRoot) {
  return path.join(projectRoot, ...COMMAND_POLICY_RELATIVE_PATH.split("/"));
}

function captureWorktree(projectRoot) {
  const abs = policyAbsPath(projectRoot);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { exists: false, kind: null, symlink: false, linkTarget: null, bytes: null, sha256: null };
  }
  const symlink = st.isSymbolicLink();
  let linkTarget = null;
  if (symlink) {
    try { linkTarget = fs.readlinkSync(abs); } catch { linkTarget = null; }
  }
  let bytes = null;
  try {
    if (symlink || st.isFile()) bytes = fs.readFileSync(abs);
  } catch {
    bytes = null;
  }
  return {
    exists: true,
    kind: symlink ? "symlink" : (st.isFile() ? "file" : "other"),
    symlink,
    linkTarget,
    bytes,
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
  };
}

function captureIndex(projectRoot) {
  const r = policyGit(projectRoot, ["ls-files", "-s", "--", COMMAND_POLICY_RELATIVE_PATH]);
  if (!r.ok) return { mode: null, blob: null, error: r.error };
  const line = r.stdout.split("\n").find((l) => l.trim());
  if (!line) return null;
  const m = /^(\d+)\s+([0-9a-f]+)\s+(\d+)\t/.exec(line);
  if (!m) return { mode: null, blob: null, error: `unparsed ls-files line: ${line.slice(0, 200)}` };
  return { mode: m[1], blob: m[2] };
}

function captureHeadBlob(projectRoot) {
  const r = policyGit(projectRoot, ["rev-parse", "--verify", "--quiet", `HEAD:./${COMMAND_POLICY_RELATIVE_PATH}`]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

function captureHeadCommit(projectRoot) {
  const r = policyGit(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Capture the command policy state: worktree { exists, kind, symlink, bytes, sha256 }, and in a git
 * work tree the index entry { mode, blob } (null when untracked), the HEAD blob (null when absent)
 * and headCommit (recorded only as a reset target). index, head and headCommit are null in a
 * non-git root, and comparisons then cover the worktree only.
 */
export function captureCommandPolicyState(projectRoot) {
  const worktree = Object.freeze(captureWorktree(projectRoot));
  const git = isPolicyGitWorkTree(projectRoot);
  if (!git) {
    return Object.freeze({ git: false, worktree, index: null, head: null, headCommit: null });
  }
  const index = captureIndex(projectRoot);
  return Object.freeze({
    git: true,
    worktree,
    index: index ? Object.freeze(index) : null,
    head: captureHeadBlob(projectRoot),
    headCommit: captureHeadCommit(projectRoot),
  });
}

function worktreeEqual(a, b) {
  const x = a || { exists: false };
  const y = b || { exists: false };
  if (Boolean(x.exists) !== Boolean(y.exists)) return false;
  if (!x.exists) return true;
  return (x.kind ?? null) === (y.kind ?? null)
    && Boolean(x.symlink) === Boolean(y.symlink)
    && (x.linkTarget ?? null) === (y.linkTarget ?? null)
    && (x.sha256 ?? null) === (y.sha256 ?? null);
}

function indexEqual(a, b) {
  if (!a || !b) return !a && !b;
  return (a.mode ?? null) === (b.mode ?? null) && (a.blob ?? null) === (b.blob ?? null) && (a.error ?? null) === (b.error ?? null);
}

/**
 * Compare two captures. parts ⊆ ["worktree", "index", "head"], derived only from the recorded fields.
 * head compares the policy BLOB at HEAD, never headCommit: a commit that moves HEAD without touching
 * the policy (exec's own commit) is not a change. index and head are compared only when both
 * captures come from a git work tree.
 */
export function compareCommandPolicyState(baseline, current) {
  const parts = [];
  if (!worktreeEqual(baseline?.worktree, current?.worktree)) parts.push("worktree");
  if (baseline?.git === true && current?.git === true) {
    if (!indexEqual(baseline.index, current.index)) parts.push("index");
    if ((baseline.head ?? null) !== (current.head ?? null)) parts.push("head");
  }
  return { changed: parts.length > 0, parts };
}

function restoreWorktree(projectRoot, baseline) {
  const abs = policyAbsPath(projectRoot);
  const want = baseline.worktree || { exists: false };
  let st = null;
  try { st = fs.lstatSync(abs); } catch { st = null; }
  if (st && (st.isSymbolicLink() || !st.isFile() || !want.exists || want.symlink || want.kind !== "file")) {
    // A symlink (or a directory, or a file the baseline did not have) is removed first, so the
    // write below can never follow a link to somewhere else.
    fs.rmSync(abs, { recursive: true, force: true });
  }
  if (!want.exists) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (want.symlink) {
    if (typeof want.linkTarget !== "string") throw new Error("baseline symlink target unknown");
    fs.symlinkSync(want.linkTarget, abs);
    return;
  }
  if (want.kind !== "file" || !want.bytes) throw new Error(`baseline worktree entry is not a readable regular file (${want.kind})`);
  fs.writeFileSync(abs, want.bytes);
}

function restoreIndex(projectRoot, baseline) {
  const want = baseline.index;
  if (want && want.error) throw new Error(`baseline index entry was not observed: ${want.error}`);
  const r = want
    ? policyGit(projectRoot, ["update-index", "--add", "--cacheinfo", `${want.mode},${want.blob},${COMMAND_POLICY_RELATIVE_PATH}`])
    : policyGit(projectRoot, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", COMMAND_POLICY_RELATIVE_PATH]);
  if (!r.ok) throw new Error(r.error);
}

/**
 * Restore each named part to the baseline and report { restored, failed: [{ part, error }] }, each
 * part observed by re-capturing after its operation (never assumed).
 *   worktree: write the baseline bytes (any symlink removed first), or unlink when the baseline had none;
 *   index: git update-index --add --cacheinfo, or git rm --cached when the baseline had no entry;
 *   head: git reset --soft <baseline.headCommit> ONLY with { allowHeadReset: true } AND when the current
 *         HEAD descends from baseline.headCommit; otherwise head is reported failed and HEAD is not moved.
 *         After a successful reset the index and worktree are re-restored.
 */
export function restoreCommandPolicyState(projectRoot, baseline, parts, options = {}) {
  const restored = [];
  const failed = [];
  const requested = new Set((Array.isArray(parts) ? parts : []).filter((p) => POLICY_PARTS.includes(p)));
  const fail = (part, error) => failed.push({ part, error: String(error?.message || error) });
  if (!baseline || typeof baseline !== "object") {
    for (const part of requested) fail(part, "no baseline");
    return { restored, failed };
  }
  const gitRoot = baseline.git === true;

  if (requested.has("head")) {
    if (!gitRoot) {
      fail("head", "not a git work tree");
    } else if (options?.allowHeadReset !== true) {
      fail("head", "HEAD reset not allowed: the caller did not pass allowHeadReset: true");
    } else if (!baseline.headCommit) {
      fail("head", "baseline has no HEAD commit to reset to");
    } else {
      const anc = policyGit(projectRoot, ["merge-base", "--is-ancestor", baseline.headCommit, "HEAD"]);
      if (!anc.ok) {
        fail("head", `current HEAD does not descend from baseline HEAD ${baseline.headCommit}`);
      } else {
        const reset = policyGit(projectRoot, ["reset", "--soft", baseline.headCommit]);
        if (!reset.ok) {
          fail("head", reset.error);
        } else if ((captureHeadBlob(projectRoot) ?? null) !== (baseline.head ?? null)) {
          fail("head", "HEAD policy blob still differs from the baseline after git reset --soft");
        } else {
          restored.push("head");
          // The reset leaves the reverted commit's entries in the index and the worktree.
          const now = captureCommandPolicyState(projectRoot);
          if (!indexEqual(baseline.index, now.index)) requested.add("index");
          if (!worktreeEqual(baseline.worktree, now.worktree)) requested.add("worktree");
        }
      }
    }
  }

  if (requested.has("index")) {
    if (!gitRoot) {
      fail("index", "not a git work tree");
    } else {
      try {
        restoreIndex(projectRoot, baseline);
        if (indexEqual(baseline.index, captureIndex(projectRoot))) restored.push("index");
        else fail("index", "index entry still differs from the baseline after restore");
      } catch (err) {
        fail("index", err);
      }
    }
  }

  if (requested.has("worktree")) {
    try {
      restoreWorktree(projectRoot, baseline);
      if (worktreeEqual(baseline.worktree, captureWorktree(projectRoot))) restored.push("worktree");
      else fail("worktree", "worktree file still differs from the baseline after restore");
    } catch (err) {
      fail("worktree", err);
    }
  }

  return { restored, failed };
}

/** The policy object a capture's worktree bytes parse to, exactly as loadCommandPolicy would. */
export function commandPolicyFromState(state) {
  const bytes = state?.worktree?.bytes;
  if (!state?.worktree?.exists || !bytes) return defaultCommandPolicy();
  return parseCommandPolicyText(Buffer.from(bytes).toString("utf8"));
}

/**
 * Split a command or a policy pattern into argv words with the Bash-allowlist scanner.
 * Returns null when the scanner cannot prove a plain word list (fail closed, any reason).
 */
function argvWords(text) {
  const scan = scanShellWords(String(text ?? "").trim());
  return scan.ok && scan.words.length > 0 ? scan.words : null;
}

/** True when the pattern's words equal the command's leading argv words. */
function leadingWordsMatch(words, pattern) {
  const patternWords = argvWords(pattern);
  if (!patternWords || patternWords.length > words.length) return false;
  return patternWords.every((w, i) => words[i] === w);
}

/** The two policy tiers that execute a command. */
const EXECUTING_TIERS = ["auto_execute", "execute_with_plan_approval"];

/**
 * Policy entries that are a general-purpose code runner when written bare: matching is by leading
 * argv words, so a bare runner entry admits every argv that starts with it (node -e, npm run <any>,
 * git -c alias.x=!cmd, git config diff.external ...).
 */
const BARE_RUNNER_ENTRIES = new Set([
  "node", "nodejs", "npx", "npm", "npm run", "npm run-script", "npm exec", "npm x",
  "pnpm", "pnpm run", "pnpm exec", "pnpm dlx", "yarn", "yarn run", "yarn exec", "yarn dlx",
  "bun", "bun run", "bunx", "deno", "deno run", "deno eval", "python", "python3", "ruby", "perl",
  "php", "sh", "bash", "zsh", "dash", "fish", "ksh", "env", "xargs", "sudo", "git", "git config",
]);

/** Interpreters and shells whose inline-code flag turns an entry into a code runner. */
const INLINE_CODE_INTERPRETERS = new Set([
  "node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl", "php",
  "sh", "bash", "zsh", "dash", "fish", "ksh",
]);

const INLINE_CODE_LONG_FLAGS = ["--eval", "--print", "--require", "--import", "--loader", "--experimental-loader"];
const INLINE_CODE_SHORT_LETTERS = new Set(["e", "p", "c", "r"]);

/** True when an argv token is an inline-code flag (exact, --flag=value, or a short cluster holding one). */
function isInlineCodeFlag(token) {
  if (token.startsWith("--")) {
    return INLINE_CODE_LONG_FLAGS.some((f) => token === f || token.startsWith(`${f}=`));
  }
  if (/^-[A-Za-z]+$/.test(token)) {
    return [...token.slice(1)].some((ch) => INLINE_CODE_SHORT_LETTERS.has(ch));
  }
  return false;
}

/**
 * True when a policy entry is a runner entry: a bare interpreter / script runner (exact word match
 * against BARE_RUNNER_ENTRIES), or an interpreter / shell entry carrying an inline-code flag
 * (node -e, bash -c, python -c ...). A runner entry never admits a command in any executing tier.
 * An entry naming a specific target (node scripts/foo.mjs, npm run test:unit) is not a runner entry.
 */
export function isRunnerEntry(pattern) {
  const words = argvWords(pattern);
  if (!words) return false;
  // An absolute or relative interpreter path (/usr/bin/node) is the same interpreter.
  const lead = path.posix.basename(words[0]);
  const normalized = [lead, ...words.slice(1)];
  if (BARE_RUNNER_ENTRIES.has(normalized.join(" "))) return true;
  if (INLINE_CODE_INTERPRETERS.has(lead) && normalized.slice(1).some(isInlineCodeFlag)) return true;
  return false;
}

/**
 * Every executing-tier entry of a policy that isRunnerEntry refuses, as
 * [{ tier, entry, reason: "runner_entry" }], in tier then file order.
 */
export function refusedPolicyEntries(policy) {
  const refused = [];
  for (const tier of EXECUTING_TIERS) {
    const entries = Array.isArray(policy?.[tier]) ? policy[tier] : [];
    for (const entry of entries) {
      if (isRunnerEntry(entry)) refused.push({ tier, entry, reason: "runner_entry" });
    }
  }
  return refused;
}

/**
 * The first refusedPolicyEntries element whose entry lead-matches the command's argv words, or
 * null when none does or the command does not scan.
 */
export function refusedEntryFor(command, policy) {
  const words = argvWords(command);
  if (!words) return null;
  return refusedPolicyEntries(policy).find((r) => leadingWordsMatch(words, r.entry)) ?? null;
}

/**
 * Built-in, policy-independent destructive-flag rules. Each rule names a verb (leading argv words)
 * and what in the argv after the verb vetoes it: a short-flag letter (clusters expanded letter by
 * letter), a long option (exact or --opt= prefix), a positional refspec prefix, or any invocation.
 * Scanning stops at the first "--" token (everything after it is a pathspec).
 */
export const DESTRUCTIVE_FLAG_RULES = Object.freeze([
  Object.freeze({ verb: "git branch", short: ["D", "M", "C", "f"], long: ["--force"] }),
  Object.freeze({
    verb: "git push",
    short: ["f", "d"],
    long: ["--force", "--force-with-lease", "--force-if-includes", "--delete", "--mirror", "--prune"],
    refspecPrefixes: ["+", ":"],
  }),
  Object.freeze({ verb: "git reset", long: ["--hard", "--merge", "--keep"] }),
  Object.freeze({ verb: "git checkout", short: ["f", "B"], long: ["--force"] }),
  Object.freeze({ verb: "git clean", any: true }),
  Object.freeze({ verb: "rm", any: true }),
]);

/**
 * The built-in destructive-flag veto. Accepts a command string or its argv words and returns
 * { verb, match } for the first DESTRUCTIVE_FLAG_RULES hit, or null. classifyCommand calls this
 * one function, so a caller can tell a built-in veto from a policy-entry veto without a second
 * copy of the rule table. Ambiguity fails closed: a short cluster holding a vetoed letter is
 * vetoed even if a value-taking option would have consumed it.
 */
export function builtinVetoFor(commandOrWords) {
  const words = Array.isArray(commandOrWords) ? commandOrWords : argvWords(commandOrWords);
  if (!words) return null;
  for (const rule of DESTRUCTIVE_FLAG_RULES) {
    if (!leadingWordsMatch(words, rule.verb)) continue;
    if (rule.any) return { verb: rule.verb, match: "*" };
    const rest = words.slice(argvWords(rule.verb).length);
    for (const token of rest) {
      if (token === "--") break;
      if (token.startsWith("--")) {
        const hit = (rule.long || []).find((opt) => token === opt || token.startsWith(`${opt}=`));
        if (hit) return { verb: rule.verb, match: hit };
      } else if (token.startsWith("-") && token.length > 1) {
        const hit = [...token.slice(1)].find((ch) => (rule.short || []).includes(ch));
        if (hit) return { verb: rule.verb, match: `-${hit}` };
      } else if ((rule.refspecPrefixes || []).some((p) => token.startsWith(p))) {
        return { verb: rule.verb, match: token };
      }
    }
  }
  return null;
}

/**
 * Classify a command against the policy.
 * Returns one of: shell_syntax_rejected, require_explicit_confirmation, auto_execute,
 * execute_with_plan_approval, unknown. Precedence is pinned, first match wins:
 * shell_syntax_rejected -> built-in destructive veto -> policy require_explicit_confirmation ->
 * auto_execute -> execute_with_plan_approval -> unknown. Runner entries never admit.
 */
export function classifyCommand(command, policy) {
  const cmd = (command || "").trim();
  if (!cmd) return "unknown";

  // Fail closed: shell syntax never reaches a tier and is never passed to an executor.
  const words = argvWords(cmd);
  if (!words) return "shell_syntax_rejected";

  // Built-in destructive-flag veto: policy-independent, checked before the policy's own entries.
  if (builtinVetoFor(words)) return "require_explicit_confirmation";

  // Confirmation is a veto, so it is checked before either executing tier.
  for (const pattern of policy.require_explicit_confirmation || []) {
    if (leadingWordsMatch(words, pattern)) return "require_explicit_confirmation";
  }

  for (const pattern of policy.auto_execute || []) {
    if (isRunnerEntry(pattern)) continue;
    if (leadingWordsMatch(words, pattern)) return "auto_execute";
  }

  for (const pattern of policy.execute_with_plan_approval || []) {
    if (isRunnerEntry(pattern)) continue;
    if (leadingWordsMatch(words, pattern)) return "execute_with_plan_approval";
  }

  return "unknown";
}

/**
 * Execute a command WITHOUT a shell: argv words from the fail-closed scanner, spawned directly.
 * Returns { code, stdout, stderr, duration, error?, spawnError? }
 */
export async function executeCommand(command, options = {}) {
  const { timeout = 300000, cwd = process.cwd() } = options;
  const startTime = Date.now();

  const words = argvWords(command);
  if (!words) throw new Error(`executeCommand refused a command it cannot split into argv words: ${command}`);
  const [bin, ...args] = words;

  // No shell, but still a managed process group so grandchildren are cleaned up on timeout.
  let outcome;
  try {
    outcome = await spawnManaged(bin, args, { timeoutMs: timeout, cwd, allowedExitCodes: ALL_EXIT_CODES });
  } catch (err) {
    // A spawn failure arrives from the child 'error' event carrying a string errno. Report it as
    // the failed exit /bin/sh used to produce (127 not found, 126 cannot execute), decided by that errno.
    if (!err || typeof err.code !== "string") throw err;
    return {
      code: err.code === "ENOENT" ? 127 : 126,
      stdout: "",
      stderr: String(err.message || err.code),
      duration: Date.now() - startTime,
      error: true,
      spawnError: err.code,
    };
  }
  const { code, stdout, stderr } = outcome;
  return {
    code,
    stdout: stdout || "",
    stderr: stderr || "",
    duration: Date.now() - startTime,
    ...(code !== 0 ? { error: true } : {}),
  };
}

/**
 * Main handler for run_command plan steps.
 * Classifies command, decides whether to execute based on policy and planApproved flag.
 * Returns { command, classification, executed?, exec?, skipped?, reason? }
 */
export async function handleRunCommandStep(command, options = {}) {
  const { projectRoot = process.cwd(), planApproved = false, timeout = 300000 } = options;

  // An injected policy (a per-apply snapshot) is used as-is, with no read from disk.
  const policy = options.policy && typeof options.policy === "object"
    ? options.policy
    : loadCommandPolicy(projectRoot);
  const classification = classifyCommand(command, policy);

  const result = { command, classification };

  if (classification === "auto_execute") {
    result.exec = await executeCommand(command, { timeout, cwd: projectRoot });
    result.executed = true;
  } else if (classification === "execute_with_plan_approval") {
    if (planApproved) {
      result.exec = await executeCommand(command, { timeout, cwd: projectRoot });
      result.executed = true;
    } else {
      result.skipped = true;
      result.reason = "requires_plan_approval";
    }
  } else if (classification === "shell_syntax_rejected") {
    // The scanner could not prove a plain word list: nothing is spawned.
    result.skipped = true;
    result.reason = "shell_syntax_rejected";
  } else if (classification === "require_explicit_confirmation") {
    result.skipped = true;
    result.reason = "requires_explicit_confirmation";
  } else {
    // Unknown classification - be conservative and skip
    result.skipped = true;
    result.reason = "unknown_command";
    // A policy entry the operator wrote may have been refused as a runner entry: volunteer it.
    const refusedEntry = refusedEntryFor(command, policy);
    if (refusedEntry) {
      result.refusedEntry = refusedEntry;
      console.error(
        `[rks.exec] run_command policy entry refused: ${refusedEntry.tier} entry "${refusedEntry.entry}" is a runner entry (${refusedEntry.reason}); skipped as unknown_command: ${command}`,
      );
    }
  }

  if (result.skipped) result.hint = skipHintFor(result, policy);

  return result;
}

/**
 * The reason-specific operator hint for a skipped run_command outcome. Each reason names the
 * remedy that can actually admit the command, and never one that cannot: shell syntax and the
 * built-in destructive veto are decided before any policy tier, so their hints do not send the
 * operator to the policy file. The confirmation source is decided by builtinVetoFor, the same
 * predicate classifyCommand uses.
 */
function skipHintFor(result, policy) {
  const cmd = String(result.command ?? "").trim();
  switch (result.reason) {
    case "shell_syntax_rejected":
      return (
        "run_command executes argv WITHOUT a shell, so shell syntax is never interpreted. Remove the unquoted " +
        "shell syntax (; & | $ ( ) { } < >, backtick, backslash, newline) or move the compound logic into a script " +
        "invoked as plain argv (e.g. node scripts/build.mjs)."
      );
    case "requires_explicit_confirmation": {
      const veto = builtinVetoFor(cmd);
      if (veto) {
        return (
          `The command hits the built-in destructive-command veto (verb "${veto.verb}", match "${veto.match}"). ` +
          "The veto is built in and policy-independent: no policy edit lifts it, and plan steps never run it."
        );
      }
      const words = argvWords(cmd);
      const entry = words
        ? (policy?.require_explicit_confirmation || []).find((p) => leadingWordsMatch(words, p))
        : undefined;
      return (
        `The command matches the require_explicit_confirmation entry "${entry ?? "(unknown)"}" under the top-level ` +
        `key command_policy in ${COMMAND_POLICY_RELATIVE_PATH}. That tier is a veto checked before both executing ` +
        "tiers, so adding the command to auto_execute does not admit it; it runs only if that entry is removed."
      );
    }
    case "requires_plan_approval":
      return (
        "The command is in the execute_with_plan_approval tier and the step ran without plan approval; " +
        "approve the plan before it is applied."
      );
    case "unknown_command":
    default: {
      const refused = result.refusedEntry
        ? ` The ${result.refusedEntry.tier} entry "${result.refusedEntry.entry}" matched this command but was ` +
          "refused as a bare interpreter or script-runner entry, so it admits nothing."
        : "";
      return (
        "The command matches no executing tier of the run_command policy. To admit it, add an entry naming the " +
        "SPECIFIC script or subcommand (e.g. node tools/build.mjs, not bare node) to auto_execute (or " +
        `execute_with_plan_approval) under the top-level key command_policy in ${COMMAND_POLICY_RELATIVE_PATH}. ` +
        "Bare interpreter or script-runner entries (node, npm run, npx, bash and the like) are refused by the policy loader " +
        `and never admit a command.${refused}`
      );
    }
  }
}
