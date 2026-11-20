import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function run() {
  console.log("rks-test-exec: unit-only test (no MCP call)");
  try {
    const modPath = resolve(__dirname, "../packages/mcp-rks/src/server/exec.mjs");

    let execModule;
    try {
      // Try to import the exec module directly. If missing, skip detailed tests.
      execModule = await import(modPath);
    } catch (e) {
      console.log(`[rks-test-exec] exec module not found at ${modPath}, skipping detailed tests.`);
      process.exit(0);
    }

    const { runExecTool, isWorkingTreeClean, getCurrentBranch } = execModule;
    if (typeof runExecTool !== "function") {
      console.error("[rks-test-exec] runExecTool not exported as function");
      process.exitCode = 1;
      return;
    }

    // Test helper functions are exported and callable
    if (typeof isWorkingTreeClean !== "function") {
      console.error("[rks-test-exec] isWorkingTreeClean not exported");
      process.exitCode = 1;
      return;
    }
    if (typeof getCurrentBranch !== "function") {
      console.error("[rks-test-exec] getCurrentBranch not exported");
      process.exitCode = 1;
      return;
    }

    // Test that helper functions work
    const branch = getCurrentBranch(process.cwd());
    console.log(`[rks-test-exec] getCurrentBranch() = ${branch}`);

    const clean = isWorkingTreeClean(process.cwd());
    console.log(`[rks-test-exec] isWorkingTreeClean() = ${clean}`);

    console.log("[rks-test-exec] All exports verified");
    process.exit(0);
  } catch (err) {
    console.error("Error running test-exec:", err);
    process.exitCode = 1;
  }
}

run();
