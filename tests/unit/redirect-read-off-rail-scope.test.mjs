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
import { canonicalHookPath } from "../helpers/hook-path.mjs";

// SPAWNS THE CANONICAL COPY, deliberately (backlog.fix.unit-tier-offrail-hermeticity).
//
// This used to resolve via resolveHookPath, whose second candidate is
// .routekit/hooks.bak. During an off-rail session that is where this hook lives —
// beside a partial tree — so its `../lib/session-state.mjs` import failed with
// ERR_MODULE_NOT_FOUND and the process died before any hook logic ran. runHook
// swallowed the non-zero exit and returned stdout: "", so all six assertions below
// failed with `expected '' to match ...`. That read as a real hook regression and
// was misdiagnosed as environmental more than once.
//
// Canonical is also the RIGHT copy on the merits: sync-hooks refuses to regenerate
// the deployed tree mid-session, so during a hooks-editing session the deployed
// copy is legitimately stale and would exercise pre-change code. Drift between the
// two is caught by the sync-parity check at the bottom of this file.
const HOOK_PATH = canonicalHookPath("read/redirect-read-to-agent.mjs");
const HOOK_SRC = fs.readFileSync(HOOK_PATH, "utf8");
const DEPLOYED_HOOK = path.resolve(
  process.cwd(),
  ".routekit/hooks/read/redirect-read-to-agent.mjs",
);

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
  // SURFACES THE EXIT STATUS. The old shape caught the spawn error and returned
  // `{ stdout: "" }`, which made a hook that never LOADED indistinguishable from a
  // hook that ran and printed nothing. That is what let ERR_MODULE_NOT_FOUND
  // present as six ordinary assertion failures.
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
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

/** Every spawn must have LOADED. A module-resolution death is never a test result. */
function expectLoaded(result) {
  expect(result.stderr || "").not.toContain("ERR_MODULE_NOT_FOUND");
  expect(result.stderr || "").not.toContain("Cannot find module");
  expect(result.status, `hook exited ${result.status}: ${result.stderr}`).toBe(0);
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
      // POSITIVE LIVENESS, paired with the negative. `not.toMatch(/BLOCKED/)` was
      // the only assertion here and it is satisfied by an empty string — so it
      // passed even when the hook never loaded. The pairing is what makes the
      // absence of BLOCKED mean "allowed" rather than "nothing happened".
      expectLoaded(result);
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

  describe("canonical/deployed sync parity", () => {
    // Repointing HOOK_PATH at canonical moved this suite's source-text pins from
    // the deployed copy to the canonical one — correct, but it left the deployed
    // copy with no content witness here. This restores it.
    //
    // AN OBSERVABLE SKIP, not a silent return. `if (!exists) return;` would be a
    // green test with zero assertions — a fresh instance of the vacuous-pass class
    // this story exists to remove, and permanently green during off-rail builds,
    // which is exactly when it matters. ctx.skip() puts it in the run output.
    it("deployed copy is byte-identical to canonical when it is present", (ctx) => {
      if (!fs.existsSync(DEPLOYED_HOOK)) {
        ctx.skip(
          "deployed hook is relocated (guardrails-off session) — parity is "
          + "unverifiable, and saying so beats passing silently",
        );
        return;
      }
      // Byte comparison, not substring: a substring check would tolerate exactly
      // the drift this is here to catch.
      expect(fs.readFileSync(DEPLOYED_HOOK)).toEqual(fs.readFileSync(HOOK_PATH));
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
