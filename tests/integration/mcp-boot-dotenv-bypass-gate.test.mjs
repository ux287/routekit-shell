/**
 * backlog.fix.mcp-boot-dotenv-bypass-vars — mock-tier witness: the governor-token gate survives a
 * project .env carrying the token-gate bypass variables (RKS_SKIP_PREFLIGHT, RKS_TEST_MODE,
 * NODE_ENV=test).
 *
 *   npx vitest run --config vitest.config.mock.mjs tests/integration/mcp-boot-dotenv-bypass-gate.test.mjs
 *
 * Three witnesses:
 *   1. Boot path — bin/mcp-rks.mjs over StdioClientTransport: the bin's dotenv loads must not
 *      switch the gate off, so an untokened protected call is refused.
 *   2. Project-context reentry — src/server.mjs spawned DIRECTLY (no bin dotenv boot, so the boot
 *      strip cannot be what makes it pass): a context-loading call (rks_project_get, unprotected)
 *      runs loadProjectContext's override:true .env load first, then an untokened protected call is
 *      still refused.
 *   3. loadProjectContext in-process — absent-before stays absent, a process value is not
 *      overwritten, and a non-bypass variable still loads.
 *
 * The protected tool is rks_exhaustive_search: protected, no preflight entry and no auto-route
 * mapping, so an untokened call reaches unauthorizedResponse. rks_agent_research is NOT used — it
 * self-bootstraps a session when untokened and the gate is on.
 *
 * Isolation follows tests/integration/mcp-boot-smoke.test.mjs: credentials and routing overrides
 * scrubbed, stub embeddings, temp HOME, fixture root outside the repo. Unlike that precedent the
 * child env carries NONE of the three bypass variables, so the fixture root (child cwd and
 * CLAUDE_PROJECT_DIR) gets an empty .routekit/hooks/ — otherwise the boot hooks check would exit 1
 * or restore hooks. Every child is bounded by a kill guard.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getRepoCopy, disposeTemplates } from "../helpers/git-repo-template.mjs";

const ORIGINAL_ENV = { ...process.env };
const BYPASS = ["RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE", "NODE_ENV"];
const SCRUBBED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ROUTEKIT_LLM_PROVIDER", "BRAVE_SEARCH_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"];
const ROUTING_UNSET_KEYS = ["RKS_PROJECT_ROOT", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
const BYPASS_ENV_FILE = "RKS_SKIP_PREFLIGHT=1\nRKS_TEST_MODE=1\nNODE_ENV=test\nRKS_QA_SENTINEL=1\n";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN_PATH = path.join(REPO_ROOT, "packages/mcp-rks/bin/mcp-rks.mjs");
const SERVER_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const GOVERNOR_TOKEN_MODULE = "../../packages/mcp-rks/src/shared/governor-token.mjs";
const PROJECT_CONTEXT_MODULE = pathToFileURL(path.join(REPO_ROOT, "packages/mcp-rks/src/project-context.mjs")).href;

const PROTECTED_TOOL = "rks_exhaustive_search";
const CONTEXT_TOOL = "rks_project_get";
/** Kill guard bounding connect and the calls. */
const GUARD_MS = 120_000;
/** Explicit per-test vitest timeout: the guard plus room to reap the child. */
const TEST_TIMEOUT_MS = 180_000;

const tempDirs = [];

afterAll(() => {
  disposeTemplates();
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A fixture project root outside the repo whose .env carries the bypass variables. */
function makeFixture(projectId) {
  const fixtureRoot = getRepoCopy("working-no-origin").workDir;
  fs.mkdirSync(path.join(fixtureRoot, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, ".routekit", "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, ".rks", "project.json"),
    JSON.stringify({ id: projectId, root: fixtureRoot, kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(fixtureRoot, "routekit", "kg.yaml"), `project: ${projectId}\n`);
  fs.writeFileSync(path.join(fixtureRoot, ".env"), BYPASS_ENV_FILE);
  const rel = path.relative(REPO_ROOT, fixtureRoot);
  expect(rel.startsWith("..") || path.isAbsolute(rel)).toBe(true);
  return fixtureRoot;
}

/** Child env from ORIGINAL_ENV with credentials, routing overrides and ALL bypass variables removed. */
function buildChildEnv({ fixtureRoot, projectId }) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rks-dotenv-bypass-home-"));
  tempDirs.push(tempHome);
  const env = { ...ORIGINAL_ENV };
  for (const key of [...SCRUBBED_KEYS, ...ROUTING_UNSET_KEYS, ...BYPASS]) delete env[key];
  Object.assign(env, {
    ROUTEKIT_RAG_EMBEDDINGS_MODE: "stub",
    HOME: tempHome,
    GH_CONFIG_DIR: path.join(tempHome, ".config", "gh"),
    XDG_CONFIG_HOME: path.join(tempHome, ".config"),
    ROUTEKIT_PROJECT_ROOT: fixtureRoot,
    ROUTEKIT_PROJECT_ID: projectId,
    CLAUDE_PROJECT_DIR: fixtureRoot,
  });
  for (const key of BYPASS) expect(key in env, `${key} must not reach the child`).toBe(false);
  return env;
}

/** Connect a client to `entry` and run `body(client)` under a kill guard. */
async function withClient({ entry, env, cwd }, body) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd, stderr: "pipe" });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  const client = new Client({ name: "mcp-boot-dotenv-bypass-gate", version: "1.0.0" }, { capabilities: {} });
  let guardFired = false;
  const guard = setTimeout(() => {
    guardFired = true;
    const pid = transport.pid;
    transport.close().catch(() => {});
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch { /* already gone */ }
    }
  }, GUARD_MS);
  try {
    await client.connect(transport);
    await body(client, () => stderrChunks.join(""));
  } finally {
    clearTimeout(guard);
    await client.close().catch(() => {});
  }
  expect(guardFired, `kill guard fired; child stderr:\n${stderrChunks.join("")}`).toBe(false);
  return stderrChunks.join("");
}

function parsePayload(result) {
  return JSON.parse(result.content[0].text);
}

function expectRefused(result, stderr) {
  const payload = parsePayload(result);
  expect(payload.error, `protected call was not refused; payload: ${JSON.stringify(payload)}\nstderr:\n${stderr}`).toBe("unauthorized");
  expect(payload.ok).toBe(false);
  expect(payload.tool).toBe(PROTECTED_TOOL);
  expect(payload.tokenStatus).toBe("missing");
}

describe("token gate survives a project .env carrying bypass variables (backlog.fix.mcp-boot-dotenv-bypass-vars)", () => {
  it("tool classification premises hold against the live module", async () => {
    const { UNPROTECTED_TOOLS, isProtectedTool } = await import(GOVERNOR_TOKEN_MODULE);
    expect(isProtectedTool(PROTECTED_TOOL)).toBe(true);
    expect(UNPROTECTED_TOOLS.has(CONTEXT_TOOL)).toBe(true);
  });

  it("boot path: bin/mcp-rks.mjs refuses an untokened protected call", async () => {
    const projectId = "dotenv-bypass-boot-fixture";
    const fixtureRoot = makeFixture(projectId);
    const env = buildChildEnv({ fixtureRoot, projectId });
    const stderr = await withClient({ entry: BIN_PATH, env, cwd: fixtureRoot }, async (client, getStderr) => {
      // No projectId: no loadContext runs, so only the bin's boot strip stands between the .env
      // and the gate (the project-context path is witnessed separately below).
      const result = await client.callTool({ name: PROTECTED_TOOL, arguments: { pattern: "anything" } });
      expectRefused(result, getStderr());
    });
    for (const k of BYPASS) expect(stderr).toContain(`[preflight] removed ${k} `);
  }, TEST_TIMEOUT_MS);

  it("project-context reentry: server.mjs direct, context-loading call first, protected call still refused", async () => {
    const projectId = "dotenv-bypass-reentry-fixture";
    const fixtureRoot = makeFixture(projectId);
    const env = buildChildEnv({ fixtureRoot, projectId });
    const stderr = await withClient({ entry: SERVER_PATH, env, cwd: fixtureRoot }, async (client, getStderr) => {
      const ctxResult = await client.callTool({ name: CONTEXT_TOOL, arguments: { id: projectId } });
      expect(ctxResult.isError, `context call failed; stderr:\n${getStderr()}`).toBeFalsy();
      const ctx = parsePayload(ctxResult);
      expect(ctx.registry.root).toBe(fixtureRoot);
      expect(ctx.projectJson.id).toBe(projectId);

      const result = await client.callTool({ name: PROTECTED_TOOL, arguments: { projectId, pattern: "anything" } });
      expectRefused(result, getStderr());
    });
    // The project .env really was loaded by loadProjectContext (not skipped).
    expect(stderr).toContain(`[mcp] loaded .env from ${path.join(fixtureRoot, ".env")}`);
  }, TEST_TIMEOUT_MS);
});

describe("loadProjectContext leaves bypass variables as they were (backlog.fix.mcp-boot-dotenv-bypass-vars)", () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
    Object.assign(process.env, ORIGINAL_ENV);
  });

  it("absent stays absent, a process value is not overwritten, a non-bypass variable loads", async () => {
    const projectId = `dotenv-bypass-inproc-${process.pid}-${Date.now()}`;
    const fixtureRoot = makeFixture(projectId);
    delete process.env.RKS_SKIP_PREFLIGHT;
    delete process.env.NODE_ENV;
    delete process.env.RKS_QA_SENTINEL;
    delete process.env.RKS_PROJECT_ROOT;
    process.env.RKS_TEST_MODE = "0";
    process.env.ROUTEKIT_PROJECT_ROOT = fixtureRoot;
    process.env.ROUTEKIT_PROJECT_ID = projectId;

    const { loadProjectContext } = await import(PROJECT_CONTEXT_MODULE);
    const ctx = await loadProjectContext(projectId, REPO_ROOT);
    expect(ctx.record.root).toBe(fixtureRoot);

    expect("RKS_SKIP_PREFLIGHT" in process.env).toBe(false);
    expect("NODE_ENV" in process.env).toBe(false);
    expect(process.env.RKS_TEST_MODE).toBe("0");
    expect(process.env.RKS_QA_SENTINEL).toBe("1");
  });
});
