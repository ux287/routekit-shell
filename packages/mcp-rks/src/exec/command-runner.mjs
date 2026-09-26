import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { spawnManaged, ALL_EXIT_CODES } from "../../../../scripts/lib/spawn-managed.mjs";
import {
  UNAVAILABLE,
  detectResultAdapter,
  resultCollectionArgs,
  parsePytestSummary,
  parseVitestJsonReport,
} from "./test-results.mjs";

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
 * stderr, and exec.mjs's test log and parseTestCount.
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

function stripAnsi(text) {
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
 * `collectTestResults: { reportDir?, reportName? }` (backlog.feat.exec-declared-red-baseline-tests)
 * asks for per-test outcomes. Only then are adapter args injected and a `testResults` record
 * returned; without it the argv and the result shape are exactly what they were before.
 */
export function runProjectTests(projectRoot, options = {}) {
  const { timeout = 300000, storyMetadata = {}, testPaths = null, collectTestResults = null } = options;

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
  let adapter = null;
  let reportPath = null;
  const collectionArgs = (runnerCmd, runnerArgs, builtin) => {
    if (!collectTestResults) return [];
    adapter = detectResultAdapter(runnerCmd, runnerArgs);
    if (adapter === "vitest") {
      const reportDir = collectTestResults.reportDir || path.join(projectRoot, ".rks");
      reportPath = path.resolve(reportDir, collectTestResults.reportName || "test-results.json");
    }
    return resultCollectionArgs(adapter, { builtin, reportPath });
  };

  let cmd, args;
  if (configuredTestCommand) {
    cmd = configuredTestCommand.cmd;
    args = [...configuredTestCommand.args, ...collectionArgs(cmd, configuredTestCommand.args, false), ...(testPaths || [])];
  } else if (testPaths && testPaths.length > 0) {
    // Pass --timeout so vitest-runner's internal wall-clock matches spawnSync's
    // outer timeout, leaving a 5s buffer for graceful cleanup.
    const vitestTimeout = Math.max(timeout - 5000, 30000);
    cmd = "node";
    args = ["scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", String(vitestTimeout),
      ...collectionArgs(cmd, ["scripts/vitest-runner.mjs"], true), ...testPaths];
  } else {
    const runner = detectTestRunner(projectRoot);
    if (!runner) {
      return { passed: true, skipped: true, reason: "no test runner detected" };
    }
    cmd = runner.cmd;
    args = collectTestResults ? [...runner.args, ...collectionArgs(runner.cmd, runner.args, false)] : runner.args;
  }

  // A stale report from an earlier run must never be read as this run's outcome.
  if (reportPath) {
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.rmSync(reportPath, { force: true });
    } catch { /* an unremovable report is caught below: parse reads only what this run wrote */ }
  }

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

  return {
    passed: result.status === 0,
    skipped: false,
    output,
    summary: result.status === 0 ? "all tests passed" : "tests failed",
    exitCode: result.status,
    ...(collectTestResults ? { testResults: collectResults(adapter, output, reportPath, projectRoot) } : {}),
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
 * Load command policy from project root.
 * Falls back to sensible defaults if file is missing.
 */
export function loadCommandPolicy(projectRoot) {
  const policyPath = path.join(projectRoot, ".routekit", "command-policy.yaml");
  const defaults = {
    auto_execute: ["git status", "git diff", "npm test", "npm run lint", "npm run build"],
    execute_with_plan_approval: ["git add", "git rm --cached", "git commit", "npm install"],
    require_explicit_confirmation: ["rm", "git reset", "git push --force", "git branch -D"],
  };

  if (!fs.existsSync(policyPath)) return defaults;

  try {
    const content = fs.readFileSync(policyPath, "utf8");
    const parsed = yaml.load(content);
    return parsed?.command_policy || defaults;
  } catch {
    return defaults;
  }
}

/**
 * Classify a command against the policy.
 * Returns one of: auto_execute, execute_with_plan_approval, require_explicit_confirmation, unknown
 */
export function classifyCommand(command, policy) {
  const cmd = (command || "").trim();
  if (!cmd) return "unknown";

  // Check auto_execute patterns
  for (const pattern of policy.auto_execute || []) {
    if (cmd === pattern || cmd.startsWith(pattern + " ")) return "auto_execute";
  }

  // Check execute_with_plan_approval patterns
  for (const pattern of policy.execute_with_plan_approval || []) {
    if (cmd === pattern || cmd.startsWith(pattern + " ")) return "execute_with_plan_approval";
  }

  // Check require_explicit_confirmation patterns (uses includes for dangerous commands)
  for (const pattern of policy.require_explicit_confirmation || []) {
    if (cmd.includes(pattern)) return "require_explicit_confirmation";
  }

  return "unknown";
}

/**
 * Execute a shell command with timeout.
 * Returns { code, stdout, stderr, duration, error? }
 */
export async function executeCommand(command, options = {}) {
  const { timeout = 300000, cwd = process.cwd() } = options;
  const startTime = Date.now();

  // Use /bin/sh -c for shell semantics, but within a managed process group so
  // grandchildren are cleaned up on timeout rather than becoming orphans.
  const { code, stdout, stderr } = await spawnManaged(
    "/bin/sh", ["-c", command],
    { timeoutMs: timeout, cwd, allowedExitCodes: ALL_EXIT_CODES }
  );
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

  const policy = loadCommandPolicy(projectRoot);
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
  } else if (classification === "require_explicit_confirmation") {
    result.skipped = true;
    result.reason = "requires_explicit_confirmation";
  } else {
    // Unknown classification - be conservative and skip
    result.skipped = true;
    result.reason = "unknown_command";
  }

  return result;
}
