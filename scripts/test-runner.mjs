#!/usr/bin/env node
/**
 * Test Runner
 *
 * Discovers and runs smoke tests with telemetry capture.
 * Usage: node scripts/test-runner.mjs [--verbose]
 *
 * @see backlog.test.runner-infrastructure
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SCRIPTS_DIR = path.join(PROJECT_ROOT, "scripts");
const TELEMETRY_DIR = path.join(PROJECT_ROOT, ".rks", "telemetry");

const VERBOSE = process.argv.includes("--verbose");
const UNIT_ONLY = process.argv.includes("--unit");
const INTEGRATION_ONLY = process.argv.includes("--integration");
if (UNIT_ONLY && INTEGRATION_ONLY) {
  console.error("Cannot use --unit and --integration together");
  process.exitCode = 1;
  process.exit(1);
}


/**
 * Discover test files matching patterns
 */
function discoverTests() {
  const tests = [];
  const patterns = [/smoke.*\.mjs$/i, /test.*\.mjs$/i];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        for (const pattern of patterns) {
          if (pattern.test(entry.name) && entry.name !== "test-runner.mjs") {
            tests.push(fullPath);
            break;
          }
        }
      }
    }
  }

  walk(SCRIPTS_DIR);
  return tests;
}

/**
 * Run a single test file
 */
async function runTest(testPath) {
  const relativePath = path.relative(PROJECT_ROOT, testPath);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn("node", [testPath], {
      cwd: PROJECT_ROOT,
      stdio: VERBOSE ? "inherit" : "pipe",
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";

    if (!VERBOSE) {
      child.stdout?.on("data", (data) => { stdout += data; });
      child.stderr?.on("data", (data) => { stderr += data; });
    }

    child.on("close", (code) => {
      resolve({
        path: relativePath,
        passed: code === 0,
        exitCode: code,
        duration: Date.now() - startTime,
        stdout,
        stderr,
      });
    });

    child.on("error", (err) => {
      resolve({
        path: relativePath,
        passed: false,
        exitCode: -1,
        duration: Date.now() - startTime,
        stdout: "",
        stderr: err.message,
      });
    });
  });
}

/**
 * Emit telemetry for test run
 */
function emitTelemetry(results, totalDuration) {
  const telemetry = {
    event: "test-run",
    timestamp: new Date().toISOString(),
    totalDuration,
    summary: {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
    },
    tests: results.map(r => ({
      path: r.path,
      passed: r.passed,
      duration: r.duration,
    })),
  };

  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });

  const filename = `test-run-${Date.now()}.json`;
  const telemetryPath = path.join(TELEMETRY_DIR, filename);
  fs.writeFileSync(telemetryPath, JSON.stringify(telemetry, null, 2));

  return telemetryPath;
}

/**
 * Main entry point
 */
async function main() {
  console.log("=".repeat(60));
  console.log("TEST RUNNER");
  console.log("=".repeat(60));

  let tests = discoverTests();

  // Apply --unit / --integration filtering
  if (UNIT_ONLY) {
    // Unit tests: exclude scripts under scripts/mcp/
    tests = tests.filter(p => !p.includes(`${path.sep}mcp${path.sep}`));
  } else if (INTEGRATION_ONLY) {
    // Integration tests: only include scripts under scripts/mcp/
    tests = tests.filter(p => p.includes(`${path.sep}mcp${path.sep}`));
  } else {
    // Default: run unit tests only
    tests = tests.filter(p => !p.includes(`${path.sep}mcp${path.sep}`));
  }

  if (tests.length === 0) {
    console.log("\nNo tests found.");
    console.log("Looking for: *smoke*.mjs, *test*.mjs in scripts/");
    return;
  }

  console.log(`\nDiscovered ${tests.length} test(s):\n`);
  for (const test of tests) {
    console.log(`  - ${path.relative(PROJECT_ROOT, test)}`);
  }
  console.log("");

  const results = [];
  const startTime = Date.now();

  for (const test of tests) {
    const relativePath = path.relative(PROJECT_ROOT, test);
    process.stdout.write(`Running ${relativePath}... `);

    const result = await runTest(test);
    results.push(result);

    if (result.passed) {
      console.log(`\x1b[32m✓ PASS\x1b[0m (${result.duration}ms)`);
    } else {
      console.log(`\x1b[31m✗ FAIL\x1b[0m (${result.duration}ms)`);
      if (!VERBOSE && result.stderr) {
        console.log(`  Error: ${result.stderr.split("\n")[0]}`);
      }
    }
  }

  const totalDuration = Date.now() - startTime;

  console.log("\n" + "=".repeat(60));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  if (failed === 0) {
    console.log(`\x1b[32mALL TESTS PASSED\x1b[0m (${passed}/${results.length})`);
  } else {
    console.log(`\x1b[31mTESTS FAILED\x1b[0m (${passed}/${results.length} passed, ${failed} failed)`);
    console.log("\nFailed tests:");
    for (const result of results.filter(r => !r.passed)) {
      console.log(`  - ${result.path}`);
    }
  }

  const telemetryPath = emitTelemetry(results, totalDuration);
  console.log(`\nTelemetry: ${path.relative(PROJECT_ROOT, telemetryPath)}`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Test runner error: ${err.message}`);
  process.exitCode = 1;
});
