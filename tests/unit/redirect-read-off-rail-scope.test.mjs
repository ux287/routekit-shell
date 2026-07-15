/**
 * Tests for off-rail read scope enforcement in redirect-read-to-agent.mjs.
 *
 * When an active off-rail session exists (.rks/active-scope.json), reads must
 * be restricted to the session's allowedFiles. Files outside that list get a
 * hard deny with a Research Governor handoff — not a generic provenance block.
 *
 * (backlog.feat.hook-off-rail-read-scope-enforcement)
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK_PATH = path.resolve(".routekit/hooks/read/redirect-read-to-agent.mjs");
const HOOK_SRC = fs.readFileSync(HOOK_PATH, "utf8");

function makeProjectDir(allowedRelPaths = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-scope-test-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });

  const allowedFiles = allowedRelPaths.map(r => path.join(dir, r));
  fs.writeFileSync(
    path.join(dir, ".rks", "active-scope.json"),
    JSON.stringify({ allowedFiles, writeMode: "scoped" })
  );
  return { dir, allowedFiles };
}

function runHook(projectDir, filePath) {
  const input = JSON.stringify({
    tool_name: "Read",
    tool_input: { file_path: filePath },
  });
  try {
    const stdout = execFileSync("node", [HOOK_PATH], {
      input,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        RKS_GUARDRAILS: "on",
        RKS_PROJECT_ID: "test-project",
      },
      encoding: "utf8",
      timeout: 5000,
    });
    return { blocked: false, stdout };
  } catch (err) {
    return { blocked: false, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("redirect-read-to-agent — off-rail scope enforcement", () => {
  describe("when active-scope.json exists", () => {
    it("allows reads for files in allowedFiles", () => {
      const { dir, allowedFiles } = makeProjectDir(["src/allowed-file.mjs"]);
      dirs.push(dir);

      const result = runHook(dir, allowedFiles[0]);
      expect(result.stdout).not.toMatch(/BLOCKED/);
    });

    it("hard-denies reads for files outside allowedFiles", () => {
      const { dir } = makeProjectDir(["src/allowed-file.mjs"]);
      dirs.push(dir);

      const outsideFile = path.join(dir, "src", "some-other-config.json");
      const result = runHook(dir, outsideFile);
      expect(result.stdout).toMatch(/BLOCKED/);
    });

    it("deny message includes the blocked file path", () => {
      const { dir } = makeProjectDir(["src/allowed-file.mjs"]);
      dirs.push(dir);

      const result = runHook(dir, path.join(dir, "src", "some-other-file.mjs"));
      expect(result.stdout).toMatch(/some-other-file\.mjs/);
    });

    it("deny message references rks_governor_init with flowType open", () => {
      const { dir } = makeProjectDir(["src/allowed-file.mjs"]);
      dirs.push(dir);

      const result = runHook(dir, path.join(dir, "src", "unrelated.mjs"));
      expect(result.stdout).toMatch(/rks_governor_init/);
      expect(result.stdout).toMatch(/flowType.*open|open.*flowType/);
    });

    it("deny message references rks_agent_research", () => {
      const { dir } = makeProjectDir(["src/allowed-file.mjs"]);
      dirs.push(dir);

      const result = runHook(dir, path.join(dir, "src", "unrelated.mjs"));
      expect(result.stdout).toMatch(/rks_agent_research/);
    });

    it("deny message includes 'path forward' reinforcement", () => {
      const { dir } = makeProjectDir(["src/allowed-file.mjs"]);
      dirs.push(dir);

      const result = runHook(dir, path.join(dir, "src", "unrelated.mjs"));
      expect(result.stdout).toMatch(/path forward/i);
    });

    it("deny message includes the allowedFiles list", () => {
      const { dir, allowedFiles } = makeProjectDir(["src/my-specific-allowed-file.mjs"]);
      dirs.push(dir);

      const result = runHook(dir, path.join(dir, "src", "unrelated.mjs"));
      expect(result.stdout).toMatch(/allowedFiles|my-specific-allowed-file/);
    });
  });

  describe("source code assertions — off-rail scope check precedes guardrails-off check", () => {
    it("scope file check (fs.existsSync(SCOPE_FILE)) appears before isGuardrailsOff()", () => {
      const scopeCheckIdx = HOOK_SRC.indexOf("fs.existsSync(SCOPE_FILE)");
      const guardrailsOffIdx = HOOK_SRC.indexOf("isGuardrailsOff()");
      expect(scopeCheckIdx).toBeGreaterThan(-1);
      expect(guardrailsOffIdx).toBeGreaterThan(-1);
      expect(scopeCheckIdx).toBeLessThan(guardrailsOffIdx);
    });

    it("deny path emits BLOCKED keyword in the reason string", () => {
      expect(HOOK_SRC).toMatch(/BLOCKED.*outside.*off-rail.*scope|BLOCKED.*allowedFiles/i);
    });

    it("deny path includes Research Governor handoff instructions with rks_governor_init", () => {
      expect(HOOK_SRC).toMatch(/rks_governor_init.*flowType.*open/);
    });

    it("deny path includes 'path forward' reinforcement phrase", () => {
      expect(HOOK_SRC).toMatch(/path forward/i);
    });

    it("on-rail provenance check (hasValidProvenance) is still present for non-off-rail sessions", () => {
      expect(HOOK_SRC).toMatch(/hasValidProvenance/);
    });
  });
});
