/**
 * Regression coverage for backlog.feat.mcp-boot-keyfree-credential-gate
 *
 * The MCP server used to hard-fail at boot (process.exit(1)) when no LLM credential was present,
 * blocking the whole server even though the RAG substrate is key-free. This story relocates the
 * gate: boot is now KEY-FREE (non-fatal warning), and a single SHARED invoke-time guard
 * (assertAnthropicCredential in credential-preflight.mjs) is reused at every `new Anthropic()`
 * construction site so a missing key surfaces as a clear, value-free per-tool error instead of an
 * opaque SDK crash.
 *
 * Witnesses:
 *   - DRY: all three SDK sites import + call the ONE shared guard before constructing the SDK.
 *   - Behavioral: qa-agent + visual return a graceful, key-name-only error keyless (no network).
 *   - HTTP: clients.mjs callers get a clear key-name error instead of a null-deref.
 *   - Boot: bin/mcp-rks.mjs boots key-free (non-fatal WARNING), value-free, no process.exit(1).
 *   - Value-free everywhere: messages name the key, never a secret value.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mcpRoot = path.join(repoRoot, "packages", "mcp-rks");
const read = (rel) => fs.readFileSync(path.join(mcpRoot, rel), "utf8");
const importMcp = (rel) => import(pathToFileURL(path.join(mcpRoot, rel)).href);

// A value that must never appear in any error/warning message.
const SECRET_PATTERN = /sk-[a-zA-Z0-9]/;

// Save/clear credentials so the guard fires deterministically regardless of the CI environment.
let savedEnv;
function clearCreds() {
  savedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ROUTEKIT_LLM_PROVIDER: process.env.ROUTEKIT_LLM_PROVIDER,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ROUTEKIT_LLM_PROVIDER;
}
function restoreCreds() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const GATE_SITES = ["src/agents/runner.mjs", "src/agents/visual.mjs", "src/server/qa-agent.mjs"];

describe("shared invoke-time guard (DRY, single source of truth)", () => {
  it.each(GATE_SITES)("%s imports the shared guard from credential-preflight", (rel) => {
    const src = read(rel);
    expect(src).toMatch(
      /import\s*\{[^}]*assertAnthropicCredential[^}]*\}\s*from\s*['"][^'"]*credential-preflight\.mjs['"]/
    );
    expect(src).toMatch(/assertAnthropicCredential\(\)/);
  });

  it("all three sites call the guard BEFORE constructing new Anthropic()", () => {
    for (const rel of GATE_SITES) {
      const src = read(rel);
      const guardIdx = src.indexOf("assertAnthropicCredential()");
      const ctorIdx = src.indexOf("new Anthropic(");
      expect(guardIdx).toBeGreaterThan(-1);
      expect(ctorIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(ctorIdx);
    }
  });
});

describe("assertAnthropicCredential", () => {
  it("throws a value-free error naming the key when absent (injected env)", async () => {
    const { assertAnthropicCredential } = await importMcp("src/llm/credential-preflight.mjs");
    expect(() => assertAnthropicCredential({})).toThrow(/ANTHROPIC_API_KEY/);
    try {
      assertAnthropicCredential({});
    } catch (e) {
      expect(e.message).not.toMatch(SECRET_PATTERN);
    }
  });

  it("does not throw when the key is present (injected env)", async () => {
    const { assertAnthropicCredential } = await importMcp("src/llm/credential-preflight.mjs");
    expect(() => assertAnthropicCredential({ ANTHROPIC_API_KEY: "present" })).not.toThrow();
  });
});

describe("qa-agent invoke-time gate", () => {
  beforeEach(clearCreds);
  afterEach(restoreCreds);

  it("runQaAgentReview returns a clear key-name-only error without a credential (no network)", async () => {
    const { runQaAgentReview } = await importMcp("src/server/qa-agent.mjs");
    const res = await runQaAgentReview({
      plan: "p",
      tddApplicable: "weak",
      testCode: "t",
      implementationCode: "i",
      projectId: null,
    });
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(false);
    expect(res.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(res.error).not.toMatch(SECRET_PATTERN);
  });
});

describe("visual invoke-time gate", () => {
  beforeEach(clearCreds);
  afterEach(restoreCreds);

  it("assessScreenshot returns a clear key-name-only observation without a credential (no network)", async () => {
    const { assessScreenshot } = await importMcp("src/agents/visual.mjs");
    const tmp = path.join(os.tmpdir(), `keyfree-shot-${process.pid}.png`);
    fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // bytes so readFile() succeeds
    try {
      const res = await assessScreenshot(tmp, { url: "http://example.test", viewport: "1920x1080", criteria: "c" });
      expect(res.passed).toBe(false);
      expect(res.observation).toMatch(/ANTHROPIC_API_KEY/);
      expect(res.observation).not.toMatch(SECRET_PATTERN);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe("clients.mjs HTTP-path null-client guards", () => {
  it("callAnthropicChat + callOpenAiChat throw clear key-name errors instead of a null-deref", async () => {
    const mod = await importMcp("src/llm/clients.mjs");
    await expect(mod.callAnthropicChat({ client: null, model: "m", prompt: "p" })).rejects.toThrow(
      /ANTHROPIC_API_KEY/
    );
    await expect(mod.callOpenAiChat({ client: null, model: "m", prompt: "p" })).rejects.toThrow(
      /OPENAI_API_KEY/
    );
  });
});

describe("key-free boot", () => {
  it("boots non-fatally with a value-free WARNING when no credential is present", () => {
    const bin = path.join(mcpRoot, "bin", "mcp-rks.mjs");
    // Set the creds to EMPTY (not delete): bin/mcp-rks.mjs runs dotenv.config(), which is
    // first-wins and will NOT override an already-present key — even an empty one. An empty value
    // is falsy, so the preflight sees no usable credential. Deleting them instead lets dotenv
    // backfill the real value from the repo's own .env, defeating the keyless simulation.
    const env = { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ROUTEKIT_LLM_PROVIDER: "" };

    // spawnSync with the explicit `timeout:` OPTION form (unit-tier-purity Rule A). A key-free
    // boot proceeds past the preflight into startServer() and may stay alive on stdio; the timeout
    // bounds the run. The preflight warning prints BEFORE the (heavy) server import, so it is
    // captured regardless of how the process ultimately exits.
    const res = spawnSync(process.execPath, [bin], {
      env,
      encoding: "utf8",
      input: "", // EOF on stdin so the stdio server can exit cleanly
      timeout: 8000,
    });

    const err = res.stderr || "";
    // The "Continuing key-free boot" line prints ONLY on the demoted (non-fatal) path — never on
    // the old fatal `process.exit(1)` path — so its presence proves boot was not blocked.
    expect(err).toMatch(/WARNING/);
    expect(err).toMatch(/Continuing key-free boot/);
    // Value-free: no secret value echoed to the boot log.
    expect(err).not.toMatch(SECRET_PATTERN);
  });
});
