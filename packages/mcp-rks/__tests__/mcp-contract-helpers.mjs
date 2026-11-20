/**
 * MCP Contract Test Harness
 *
 * Provides helpers for testing MCP tools through the real protocol path:
 *   MCP Client → stdio → MCP Server (server.mjs) → tool handler → response
 *
 * Uses ROUTEKIT_PROJECT_ROOT env var to point loadContext() at test fixtures.
 *
 * Tier-2 refactor (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit):
 *   createTempFixture() now auto-registers cleanup with the active test
 *   lifecycle so callers cannot forget to call cleanupTempFixture(). The
 *   explicit cleanupTempFixture(dir) function still works (legacy callers
 *   are unchanged), but a new withTempFixture(fn) callback API is the
 *   preferred shape — it wraps create + cleanup in try/finally so leaks
 *   are impossible.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { after } from "node:test";
import { makeTempDirWithCleanup } from "../../../tests/_helpers/with-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "../src/server.mjs");
const FIXTURE_DIR = path.join(__dirname, "fixtures/test-project");

// Module-level registry of live fixtures. Each entry is { dir, cleanup }. A
// node:test `after` hook (registered eagerly at module load) performs a final
// safety-net sweep when the whole test file completes, cleaning any fixture
// whose owner forgot to call cleanupTempFixture explicitly.
//
// This is `after` (end-of-file), NOT `afterEach`: the contract spec creates
// suite-scoped fixtures in `before()` and releases them in the matching
// `after()`, so an afterEach sweep would delete an in-use fixture between tests
// in the same describe block (observed: "ROUTEKIT_PROJECT_ROOT non-existent
// path" → "Project not found"). Eager registration at module load (rather than
// lazily from inside a running test) keeps hook registration valid under the
// node:test runner, where hooks must attach during suite definition, not
// mid-test. The sweep early-returns when nothing is live.
const LIVE_FIXTURES = new Map();

after(() => {
  if (LIVE_FIXTURES.size === 0) return;
  for (const [dir, handle] of LIVE_FIXTURES) {
    try { handle.cleanup(); } catch { /* best-effort */ }
    LIVE_FIXTURES.delete(dir);
  }
});

/**
 * Build a temp copy of the test fixture (git-initialized). Returns the temp
 * dir path string for back-compat with existing callers; cleanup is
 * auto-registered with the active test's afterEach hook so leaks are
 * impossible even if the caller forgets to invoke cleanupTempFixture(dir).
 *
 * Preferred shape for new callers is withTempFixture(fn) below.
 */
export function createTempFixture() {
  const handle = makeTempDirWithCleanup("mcp-contract-");
  const tmpDir = handle.dir;
  cpRecursive(FIXTURE_DIR, tmpDir);
  // Initialize git repo so git-dependent tools don't crash
  execSync("git init && git add -A && git commit -m 'initial'", {
    cwd: tmpDir,
    stdio: "pipe",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  LIVE_FIXTURES.set(tmpDir, handle);
  return tmpDir;
}

/**
 * Remove a temp fixture directory. Idempotent — safe to call even if the
 * auto-cleanup hook already ran. Legacy callers continue to invoke this
 * explicitly; new callers should prefer withTempFixture(fn).
 */
export function cleanupTempFixture(tmpDir) {
  if (!tmpDir) return;
  if (!tmpDir.startsWith(os.tmpdir())) return;
  const handle = LIVE_FIXTURES.get(tmpDir);
  if (handle) {
    try { handle.cleanup(); } catch { /* best-effort */ }
    LIVE_FIXTURES.delete(tmpDir);
    return;
  }
  // Not tracked — fall back to direct rm (legacy callers that bypassed
  // createTempFixture for some reason).
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Callback-shape variant: create a fixture, run fn(dir), clean up in finally.
 * New code should prefer this over the createTempFixture / cleanupTempFixture
 * pair — the cleanup is unconditional even if fn throws.
 */
export async function withTempFixture(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("withTempFixture: fn must be a function");
  }
  const dir = createTempFixture();
  try {
    return await Promise.resolve(fn(dir));
  } finally {
    cleanupTempFixture(dir);
  }
}

/**
 * Create an MCP client connected to the server via stdio.
 * Server runs with all test bypasses enabled.
 */
export async function createTestClient(opts = {}) {
  const projectRoot = opts.projectRoot || FIXTURE_DIR;

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH],
    env: {
      ...process.env,
      NODE_ENV: "test",
      RKS_TEST_MODE: "1",
      RKS_SKIP_PREFLIGHT: "1",
      RKS_SKIP_LLM: "1",
      RKS_SKIP_READINESS: "1",
      RKS_SKIP_PHASE_CHECK: "1",
      RKS_SKIP_QA_REVIEW: "1",
      RKS_SKIP_STATIC_ANALYSIS: "1",
      RKS_SKIP_REVIEWER_MODE: "1",
      // Point loadContext() at test fixture (no registry needed)
      ROUTEKIT_PROJECT_ROOT: projectRoot,
      ROUTEKIT_PROJECT_ID: "test-project",
      // Suppress CLAUDE_PROJECT_DIR to avoid hooks check using wrong path
      CLAUDE_PROJECT_DIR: projectRoot,
      ...(opts.env || {}),
    },
  });

  const client = new Client(
    { name: "mcp-contract-test", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  return { client, transport };
}

/**
 * Disconnect the MCP client and close transport.
 */
export async function closeTestClient({ client, transport }) {
  try {
    await client.close();
  } catch {
    // Best-effort cleanup
  }
  try {
    await transport.close();
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Call a tool and return parsed JSON result.
 */
export async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Response text is not JSON — that's fine, return raw
  }
  return { raw: result, parsed, text };
}

/**
 * Call a tool, catching any errors.
 * Returns { threw: false, result } on success or { threw: true, error } on failure.
 */
export async function callToolSafe(client, name, args = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { threw: false, result };
  } catch (err) {
    return { threw: true, error: err };
  }
}

// ── Internal helpers ──

function cpRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      cpRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
