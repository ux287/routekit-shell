import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { spawnManaged, ALL_EXIT_CODES } from "../../../../scripts/lib/spawn-managed.mjs";

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
export function runProjectTests(projectRoot, options = {}) {
  const { timeout = 300000, storyMetadata = {}, testPaths = null } = options;

  // Skip tests if story has a paired test story (testStory field is set and non-empty)
  if (storyMetadata.testStory) {
    return { passed: true, skipped: true, reason: "paired test story", testsSkipped: true };
  }

  let cmd, args;
  if (testPaths && testPaths.length > 0) {
    // Pass --timeout so vitest-runner's internal wall-clock matches spawnSync's
    // outer timeout, leaving a 5s buffer for graceful cleanup.
    const vitestTimeout = Math.max(timeout - 5000, 30000);
    cmd = "node";
    args = ["scripts/vitest-runner.mjs", "--config", "vitest.config.unit.mjs", "--timeout", String(vitestTimeout), ...testPaths];
  } else {
    const runner = detectTestRunner(projectRoot);
    if (!runner) {
      return { passed: true, skipped: true, reason: "no test runner detected" };
    }
    cmd = runner.cmd;
    args = runner.args;
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
    };
  }

  const output = (result.stdout || "") + (result.stderr || "");

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
  };
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
