/**
 * backlog.fix.mcp-boot-dotenv-bypass-vars — unit witness for the boot-time strip in bin/mcp-rks.mjs.
 *
 * The token-gate bypass variables (RKS_SKIP_PREFLIGHT, RKS_TEST_MODE, NODE_ENV) must never be
 * taken from a .env file. The bin snapshots their presence before its dotenv loads and deletes any
 * the loads introduced, naming each on stderr (never a value). A value already in the real process
 * env is kept.
 *
 * Each case spawns the bin with a temp ROUTEKIT_PROJECT_ROOT whose .env is written by the test. The
 * temp dir is also the child's cwd and CLAUDE_PROJECT_DIR, and carries an empty .routekit/hooks/ so
 * the (bypass-free) boot neither exits on the hooks check nor restores hooks into the repo. HOME is
 * a temp dir too. spawnSync carries an explicit timeout; the strip lines print before the server
 * module is imported, so a timeout kill still leaves them in stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bin = path.join(repoRoot, "packages", "mcp-rks", "bin", "mcp-rks.mjs");
const BYPASS = ["RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE", "NODE_ENV"];
const SCRUBBED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ROUTEKIT_LLM_PROVIDER", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID"];
const SPAWN_TIMEOUT_MS = 15_000;
const BYPASS_ENV_FILE = "RKS_SKIP_PREFLIGHT=1\nRKS_TEST_MODE=1\nNODE_ENV=test\n";

let tmp;
let home;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-bypass-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-bypass-home-"));
  fs.mkdirSync(path.join(tmp, ".routekit", "hooks"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function boot(envFile, extraEnv = {}) {
  fs.writeFileSync(path.join(tmp, ".env"), envFile);
  const env = { ...process.env };
  for (const k of [...BYPASS, ...SCRUBBED]) delete env[k];
  Object.assign(env, {
    ROUTEKIT_PROJECT_ROOT: tmp,
    CLAUDE_PROJECT_DIR: tmp,
    HOME: home,
    ROUTEKIT_RAG_EMBEDDINGS_MODE: "stub",
    ...extraEnv,
  });
  const res = spawnSync(process.execPath, [bin], { env, cwd: tmp, encoding: "utf8", input: "", timeout: SPAWN_TIMEOUT_MS });
  return { ...res, stderr: res.stderr || "" };
}

/** stderr lines that report a removed bypass variable. */
function removalLines(stderr) {
  return stderr.split("\n").filter((l) => l.startsWith("[preflight] removed "));
}

describe("boot strips .env-sourced token-gate bypass variables (backlog.fix.mcp-boot-dotenv-bypass-vars)", () => {
  it("names each removed variable on stderr", () => {
    const res = boot(BYPASS_ENV_FILE);
    const lines = removalLines(res.stderr);
    for (const k of BYPASS) {
      expect(lines.some((l) => l.includes(` ${k} `)), `no removal line for ${k}; stderr:\n${res.stderr}`).toBe(true);
    }
  });

  it("never logs a removed variable's value (name-only)", () => {
    const res = boot(BYPASS_ENV_FILE);
    const lines = removalLines(res.stderr);
    expect(lines.length).toBe(3);
    for (const k of BYPASS) {
      expect(res.stderr).not.toMatch(new RegExp(`${k}\\s*[=:]\\s*(1|test)\\b`));
      expect(res.stderr).not.toMatch(new RegExp(`\\b(1|test)\\s*[=:]?\\s*${k}`));
    }
    for (const l of lines) {
      expect(l).not.toMatch(/=\s*(1|test)\b/);
      expect(l).not.toMatch(/\btest\b/);
      expect(l).not.toMatch(/\b1\b/);
    }
  });

  it("keeps a bypass value already set in the process env (no removal line for it)", () => {
    const res = boot("RKS_TEST_MODE=2\n", { RKS_TEST_MODE: "1" });
    const lines = removalLines(res.stderr);
    expect(lines.some((l) => l.includes("RKS_TEST_MODE"))).toBe(false);
  });

  it("does not name a non-bypass variable, and credential provenance lines still print", () => {
    const res = boot(`${BYPASS_ENV_FILE}RKS_QA_SENTINEL=1\nANTHROPIC_API_KEY=placeholder-not-a-real-key\n`);
    const lines = removalLines(res.stderr);
    expect(lines.length).toBe(3);
    expect(lines.some((l) => l.includes("RKS_QA_SENTINEL"))).toBe(false);
    expect(res.stderr).toContain(`[preflight] credential ANTHROPIC_API_KEY ← ${path.join(tmp, ".env")}`);
    expect(res.stderr).not.toContain("placeholder-not-a-real-key");
  });
});
