/**
 * Tests for enforce-targetfile-scope.mjs hook
 *
 * Covers:
 * - build-only tier (allow-list): block/pass by allowedFiles
 * - framework-update tier (deny-list): block/pass by denyList
 * - Read-class tools never blocked
 * - No-op cases (no scope file, unrecognized writeMode)
 * - scope.violation telemetry in stderr
 * - Always-allowed meta paths in build-only mode
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function findHook(hookName) {
  const normal = path.join(PROJECT_ROOT, ".routekit", "hooks", hookName);
  const bak = path.join(PROJECT_ROOT, ".routekit", "hooks.bak", hookName);
  const system = path.join(PROJECT_ROOT, ".routekit", "hooks", "system", hookName);
  if (fs.existsSync(normal)) return normal;
  if (fs.existsSync(bak)) return bak;
  if (fs.existsSync(system)) return system;
  throw new Error(`Hook not found: ${hookName} (checked hooks/, hooks.bak/, hooks/system/)`);
}

async function callHookDirect(hookName, toolName, toolInput, envOverrides = {}) {
  const hookPath = findHook(hookName);
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  return new Promise((resolve) => {
    const proc = spawn("node", [hookPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* already gone */ }
      resolve({ code: 124, stdout, stderr, blocked: false, timedOut: true });
    }, 10_000);

    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    proc.stdin.write(input);
    proc.stdin.end();
    proc.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, blocked: code === 2 });
    });
  });
}

function makeTempScopeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-scope-test-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  return dir;
}

function writeScopeFile(dir, scope) {
  fs.writeFileSync(
    path.join(dir, ".rks", "active-scope.json"),
    JSON.stringify(scope, null, 2)
  );
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const ALLOWED = "packages/mcp-rks/src/server/guardrails-audit.mjs";
const UNRELATED = "src/unrelated.mjs";
const DENY_LISTED = "notes/my-note.md";
const FRAMEWORK = "packages/some-lib/index.mjs";

describe("enforce-targetfile-scope", () => {
  describe("build-only tier — allow-list enforcement", () => {
    it("blocks Edit to path not in allowedFiles", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: UNRELATED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(true);
        expect(r.code).toBe(2);
      } finally { cleanup(dir); }
    });

    it("allows Edit to path in allowedFiles", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: ALLOWED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
        expect(r.code).toBe(0);
      } finally { cleanup(dir); }
    });

    it("blocks Write to path not in allowedFiles", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Write", { file_path: UNRELATED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(true);
      } finally { cleanup(dir); }
    });

    it("allows meta path .rks/ in build-only mode", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: ".rks/something.json" }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
      } finally { cleanup(dir); }
    });

    it("allows meta path .routekit/ in build-only mode", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: ".routekit/hooks/foo.mjs" }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
      } finally { cleanup(dir); }
    });

    it("allows meta path .claude/ in build-only mode", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: ".claude/settings.json" }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
      } finally { cleanup(dir); }
    });
  });

  describe("framework-update tier — deny-list enforcement", () => {
    it("blocks Edit to path matching denyList", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "framework-update", writeMode: "deny-list", denyList: ["notes/", "CLAUDE.md", ".claude/"], sessionId: "s2" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: DENY_LISTED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(true);
      } finally { cleanup(dir); }
    });

    it("allows Edit to path NOT in denyList", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "framework-update", writeMode: "deny-list", denyList: ["notes/", "CLAUDE.md", ".claude/"], sessionId: "s2" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: FRAMEWORK }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
      } finally { cleanup(dir); }
    });
  });

  describe("read-class tools are never blocked", () => {
    it("Read is never blocked regardless of tier", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Read", { file_path: UNRELATED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
        expect(r.code).toBe(0);
      } finally { cleanup(dir); }
    });

    it("Bash is never blocked", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Bash", { command: "ls" }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
      } finally { cleanup(dir); }
    });
  });

  describe("no-op cases", () => {
    it("allows when no active-scope.json present", async () => {
      const dir = makeTempScopeDir();
      try {
        // .rks/ exists but no active-scope.json
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: UNRELATED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
        expect(r.code).toBe(0);
      } finally { cleanup(dir); }
    });

    it("allows when writeMode is unrecognized (no tier)", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { writeMode: "legacy", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: UNRELATED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(false);
      } finally { cleanup(dir); }
    });
  });

  describe("scope.violation telemetry", () => {
    it("stderr contains scope.violation with tier and path on a blocked write", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" });
        const r = await callHookDirect("enforce-targetfile-scope.mjs", "Edit", { file_path: UNRELATED }, { CLAUDE_PROJECT_DIR: dir });
        expect(r.blocked).toBe(true);
        expect(r.stderr).toContain("scope.violation");
        expect(r.stderr).toContain("build-only");
        expect(r.stderr).toContain(UNRELATED);
      } finally { cleanup(dir); }
    });
  });
});
