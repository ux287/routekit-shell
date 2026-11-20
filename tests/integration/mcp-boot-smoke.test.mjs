/**
 * backlog.feat.server-mjs-dispatch-characterization-harness — AC (e): subprocess boot smoke.
 *
 * Spawns `node packages/mcp-rks/src/server.mjs` (the stable entrypoint child MCP configs hardcode)
 * through StdioClientTransport, completes MCP initialize, lists tools, calls ONE cheap unprotected
 * read-only tool, closes, and proves the child was reaped. Runnable by hand before every
 * rks_guardrails_on in the decomposition sequence:
 *
 *   npx vitest run --config vitest.config.mock.mjs tests/integration/mcp-boot-smoke.test.mjs
 *
 * ISOLATION (## Solution, "(e) boot smoke under the same isolation"). The child loads its own
 * modules, so the env passed AT SPAWN decides its embeddings mode and credentials. This file builds
 * that env itself from the step-3 SCRUBBED env (never an unfiltered spread of process.env) and
 * asserts it on the object handed to StdioClientTransport. It cannot share the other file's
 * beforeAll state, so it repeats the scrub at module top level. Static imports follow step 3a:
 * vitest, node:* builtins, @modelcontextprotocol/sdk/* and tests/helpers/* only.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getRepoCopy, disposeTemplates } from "../helpers/git-repo-template.mjs";

// ── Step 3 scrub, at module top level, before any packages/** import ──────────────────────────
const ORIGINAL_ENV = { ...process.env };
const SCRUBBED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ROUTEKIT_LLM_PROVIDER", "BRAVE_SEARCH_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"];
const ROUTING_UNSET_KEYS = ["RKS_PROJECT_ROOT", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
const SCRUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rks-boot-smoke-home-"));
for (const key of [...SCRUBBED_KEYS, ...ROUTING_UNSET_KEYS, "CLAUDE_PROJECT_DIR", "ROUTEKIT_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID"]) {
  delete process.env[key];
}
process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = "stub";
process.env.HOME = SCRUB_HOME;
process.env.GH_CONFIG_DIR = path.join(SCRUB_HOME, ".config", "gh");
process.env.XDG_CONFIG_HOME = path.join(SCRUB_HOME, ".config");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_PATH = path.join(REPO_ROOT, "packages/mcp-rks/src/server.mjs");
const GOLDEN_PATH = path.join(REPO_ROOT, "tests/integration/fixtures/mcp-surface.golden.json");
const GOVERNOR_TOKEN_MODULE = "../../packages/mcp-rks/src/shared/governor-token.mjs";
const GIT_TIMEOUT_MS = 120_000;

/** Kill guard bounding connect + listTools + the tool call. */
export const BOOT_SMOKE_GUARD_MS = 120_000;
/** Explicit per-test vitest timeout: the guard plus room to reap the child. */
export const BOOT_SMOKE_TIMEOUT_MS = 180_000;
export const FIXTURE_PROJECT_ID = "mcp-boot-smoke-fixture";

// The one tool called. It must be in UNPROTECTED_TOOLS (asserted below against the live module)
// and in the characterization file's READ_ONLY_ALLOWLIST, and not in its RAG_REACHING_TOOLS
// (cross-checked by tests/integration/mcp-surface-characterization.test.mjs, which reads this
// constant). Duplicated here as a name set because a test file cannot import another test file.
export const BOOT_SMOKE_TOOL = "rks_guardrails_status";
const BOOT_SMOKE_READ_ONLY_ALLOWLIST = new Set([
  "rks_templates_list",
  "rks_publish_profiles",
  "rks_guardrails_status",
  "dendron_read_note",
  "rks_stash",
  "rks_guardrails_simulate",
  "rks_telemetry_query",
  "rks_onboarder",
  "rks_governor_init",
]);
const BOOT_SMOKE_RAG_REACHING_MINIMUM = new Set(["rks_rag_init", "rks_rag_embed", "rks_rag_query", "rks_rag_compact", "rks_exhaustive_search"]);

const CHILD_ENV_DROP = [...SCRUBBED_KEYS, ...ROUTING_UNSET_KEYS];

/**
 * Build the child env from the scrubbed process.env: drop the six credential keys and the three
 * routing overrides, then pin test mode, stub embeddings, temp HOME/config dirs and the fixture.
 */
export function buildChildEnv({ fixtureRoot, fixtureProjectId, tempHome }) {
  const env = { ...process.env }; // already scrubbed at module top level
  for (const key of CHILD_ENV_DROP) delete env[key];
  return {
    ...env,
    NODE_ENV: "test",
    RKS_TEST_MODE: "1",
    ROUTEKIT_RAG_EMBEDDINGS_MODE: "stub",
    HOME: tempHome,
    GH_CONFIG_DIR: path.join(tempHome, ".config", "gh"),
    XDG_CONFIG_HOME: path.join(tempHome, ".config"),
    ROUTEKIT_PROJECT_ROOT: fixtureRoot,
    ROUTEKIT_PROJECT_ID: fixtureProjectId,
    CLAUDE_PROJECT_DIR: fixtureRoot,
  };
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function gitOut(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  return r.stdout;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw err;
  }
}

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  disposeTemplates();
  fs.rmSync(SCRUB_HOME, { recursive: true, force: true });
});

describe("server.mjs boot smoke (subprocess)", () => {
  it("boots under the isolated env, initializes, lists the golden tool set, calls one read-only tool, and is reaped", async () => {
    expect(process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE).toBe("stub");
    const { UNPROTECTED_TOOLS } = await import(GOVERNOR_TOKEN_MODULE);
    expect(UNPROTECTED_TOOLS.has(BOOT_SMOKE_TOOL)).toBe(true);
    expect(BOOT_SMOKE_READ_ONLY_ALLOWLIST.has(BOOT_SMOKE_TOOL)).toBe(true);
    expect(BOOT_SMOKE_RAG_REACHING_MINIMUM.has(BOOT_SMOKE_TOOL)).toBe(false);

    // Fixture: no remote, no .env, outside the repo.
    const fixture = getRepoCopy("working-no-origin");
    const fixtureRoot = fixture.workDir;
    fs.mkdirSync(path.join(fixtureRoot, ".rks"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "routekit"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureRoot, ".rks", "project.json"),
      JSON.stringify({ id: FIXTURE_PROJECT_ID, root: fixtureRoot, kgFile: "routekit/kg.yaml" }, null, 2),
    );
    fs.writeFileSync(path.join(fixtureRoot, "routekit", "kg.yaml"), "project: mcp-boot-smoke-fixture\n");
    expect(isUnder(fixtureRoot, os.tmpdir())).toBe(true);
    expect(isUnder(fixtureRoot, REPO_ROOT)).toBe(false);
    expect(gitOut(["remote"], fixtureRoot).trim()).toBe("");
    expect(fs.existsSync(path.join(fixtureRoot, ".env"))).toBe(false);

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "rks-boot-smoke-child-home-"));
    const env = buildChildEnv({ fixtureRoot, fixtureProjectId: FIXTURE_PROJECT_ID, tempHome });

    // Assert the env object actually passed to the transport.
    for (const key of SCRUBBED_KEYS) expect(key in env, `${key} must not reach the child`).toBe(false);
    for (const key of ROUTING_UNSET_KEYS) expect(key in env, `${key} must not reach the child`).toBe(false);
    expect(env.NODE_ENV).toBe("test");
    expect(env.RKS_TEST_MODE).toBe("1");
    expect(env.ROUTEKIT_RAG_EMBEDDINGS_MODE).toBe("stub");
    expect(env.ROUTEKIT_PROJECT_ROOT).toBe(fixtureRoot);
    expect(env.CLAUDE_PROJECT_DIR).toBe(fixtureRoot);
    expect(env.ROUTEKIT_PROJECT_ID).toBe(FIXTURE_PROJECT_ID);
    for (const key of ["HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
      expect(isUnder(env[key], tempHome), `${key} must be inside the temp home`).toBe(true);
      expect(isUnder(env[key], os.tmpdir()), `${key} must be under os.tmpdir()`).toBe(true);
    }

    const repoBefore = {
      head: gitOut(["rev-parse", "HEAD"], REPO_ROOT),
      porcelain: gitOut(["status", "--porcelain"], REPO_ROOT),
    };

    const transportParams = { command: process.execPath, args: [SERVER_PATH], env, cwd: fixtureRoot, stderr: "pipe" };
    expect(transportParams.cwd).toBe(fixtureRoot);
    expect(transportParams.env).toBe(env);
    const transport = new StdioClientTransport(transportParams);
    const stderrChunks = [];
    transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
    const client = new Client({ name: "mcp-boot-smoke", version: "1.0.0" }, { capabilities: {} });

    let pid = null;
    let guardFired = false;
    // Kill guard: bounds connect, listTools and the call. Cleared on completion.
    const guard = setTimeout(() => {
      guardFired = true;
      transport.close().catch(() => {});
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch { /* already gone */ }
      }
    }, BOOT_SMOKE_GUARD_MS);

    try {
      await client.connect(transport);
      pid = transport.pid;
      expect(typeof pid).toBe("number");

      const { tools } = await client.listTools();
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
      const goldenNames = golden.tools.map((t) => t.name).sort();
      expect(goldenNames.length).toBeGreaterThan(0);
      expect(tools.map((t) => t.name).sort()).toEqual(goldenNames);

      const result = await client.callTool({ name: BOOT_SMOKE_TOOL, arguments: { projectId: FIXTURE_PROJECT_ID } });
      const payload = JSON.parse(result.content[0].text);
      expect(Object.keys(payload).sort()).toEqual(["ok", "sessions", "total"]);
      expect(payload.ok).toBe(true);
      expect(payload.sessions).toEqual([]);
      expect(payload.total).toBe(0);
    } finally {
      clearTimeout(guard);
      await client.close().catch(() => {});
    }
    expect(guardFired, `kill guard fired; child stderr:\n${stderrChunks.join("")}`).toBe(false);

    // Reaped: process.kill(pid, 0) throws ESRCH within the test timeout.
    const deadline = Date.now() + 30_000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(pid), `child ${pid} still alive after close`).toBe(false);

    expect({
      head: gitOut(["rev-parse", "HEAD"], REPO_ROOT),
      porcelain: gitOut(["status", "--porcelain"], REPO_ROOT),
    }).toEqual(repoBefore);
    fs.rmSync(tempHome, { recursive: true, force: true });
  }, BOOT_SMOKE_TIMEOUT_MS);
});
