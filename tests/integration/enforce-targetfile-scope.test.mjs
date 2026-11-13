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
import { resolveHookByName, canonicalHookPath } from "../helpers/hook-path.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// Resolve by bare name across live/.bak/canonical trees and every tier — so a system-tier hook
// moved to .routekit/hooks.bak/system/ during an off-rail session is still found (the old inline
// resolver checked hooks.bak/ but not hooks.bak/system/, ENOENT'ing in off-rail mode).
function findHook(hookName) {
  return resolveHookByName(hookName, PROJECT_ROOT);
}

async function callHookDirect(hookName, toolName, toolInput, envOverrides = {}, hookPathOverride = null) {
  const hookPath = hookPathOverride || findHook(hookName);
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

    // backlog.feat.offrail-governance-refusal-telemetry: each refusal also appends one redacted
    // offrail.scope_violation line to .rks/telemetry/events-<date>.jsonl. Spawned from the
    // CANONICAL copy (the code under change); the byte-identity test below covers the other two.
    const CANON = canonicalHookPath("system/enforce-targetfile-scope.mjs", PROJECT_ROOT);
    const callCanon = (dir, toolName, toolInput) =>
      callHookDirect("enforce-targetfile-scope.mjs", toolName, toolInput, { CLAUDE_PROJECT_DIR: dir }, CANON);
    const eventsPath = (dir) =>
      path.join(dir, ".rks", "telemetry", `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const eventsBytes = (dir) => (fs.existsSync(eventsPath(dir)) ? fs.readFileSync(eventsPath(dir), "utf8") : "");
    const violations = (dir) =>
      eventsBytes(dir).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === "offrail.scope_violation");

    it("deny-list refusal appends one offrail.scope_violation event with violation deny_list", async () => {
      const dir = makeTempScopeDir();
      try {
        const denyList = ["notes/", "CLAUDE.md", ".claude/"];
        writeScopeFile(dir, { tier: "framework-update", writeMode: "deny-list", denyList, sessionId: "s2", problemId: "backlog.feat.dl" });
        const r = await callCanon(dir, "Edit", { file_path: DENY_LISTED });
        expect(r.code).toBe(2);
        expect(r.stderr).toBe(
          "\nscope.violation: framework-update — write blocked by deny-list\n" +
          `   File: ${DENY_LISTED}\n` +
          `   Deny-listed prefixes: ${denyList.join(", ")}\n\n`
        );
        const evs = violations(dir);
        expect(evs).toHaveLength(1);
        expect(evs[0].payload.violation).toBe("deny_list");
        expect(evs[0].payload.file).toBe(DENY_LISTED);
        expect(evs[0].payload.tool).toBe("Edit");
        expect(evs[0].payload.writeMode).toBe("deny-list");
        expect(evs[0].payload.denyListCount).toBe(3);
        expect(typeof evs[0].timestamp).toBe("string");
        expect(eventsBytes(dir)).not.toContain('"denyList"');
      } finally { cleanup(dir); }
    });

    it("read-only refusal appends one offrail.scope_violation event with violation read_only", async () => {
      const dir = makeTempScopeDir();
      try {
        writeScopeFile(dir, { tier: "read-only", writeMode: "read-only", sessionId: "s3", problemId: "backlog.feat.ro" });
        const r = await callCanon(dir, "Write", { file_path: UNRELATED });
        expect(r.code).toBe(2);
        expect(r.stderr).toBe(
          "\nscope.violation: read-only — write blocked: off-rail session is read-only\n" +
          `   File: ${UNRELATED}\n` +
          "   Reason: No targetFiles defined for story backlog.feat.ro\n" +
          "\n   💡 To write code, add targetFiles to your story note and restart off-rail:\n" +
          '      rks_guardrails_off { problemId: "backlog.feat.ro" }\n\n'
        );
        const evs = violations(dir);
        expect(evs).toHaveLength(1);
        expect(evs[0].payload.violation).toBe("read_only");
        expect(evs[0].payload.tool).toBe("Write");
        expect(evs[0].payload.problemId).toBe("backlog.feat.ro");
        expect(evs[0].payload.writeMode).toBe("read-only");
      } finally { cleanup(dir); }
    });

    it("not-in-targetFiles refusal appends one offrail.scope_violation event with counts only", async () => {
      const dir = makeTempScopeDir();
      try {
        const allowedFiles = [ALLOWED, "packages/other/only-here.mjs"];
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles, sessionId: "s1", problemId: "backlog.feat.nt" });
        const r = await callCanon(dir, "Edit", { file_path: UNRELATED });
        expect(r.code).toBe(2);
        expect(r.stderr).toBe(
          "\nscope.violation: build-only — write blocked: file not in story's targetFiles\n" +
          `   File: ${UNRELATED}\n` +
          "   Story: backlog.feat.nt\n" +
          "   Allowed:\n" +
          allowedFiles.map((f) => `      - ${f}`).join("\n") +
          "\n\n   💡 Add this file to targetFiles in your story, or work within scope\n\n"
        );
        const evs = violations(dir);
        expect(evs).toHaveLength(1);
        const p = evs[0].payload;
        expect(p.violation).toBe("not_in_target_files");
        expect(p.tool).toBe("Edit");
        expect(p.problemId).toBe("backlog.feat.nt");
        expect(p).toHaveProperty("sessionId");
        expect(p.tier).toBe("build-only");
        expect(p.writeMode).toBe("scoped");
        expect(p.allowedCount).toBe(2);
        expect(p.file).toBe(UNRELATED);
        const bytes = eventsBytes(dir);
        expect(bytes).not.toContain('"allowedFiles"');
        expect(bytes).not.toContain('"denyList"');
        expect(bytes).not.toContain("only-here.mjs");
      } finally { cleanup(dir); }
    });

    it("allowed writes append no offrail.scope_violation event", async () => {
      const cases = [
        [{ tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" }, ALLOWED],
        [{ tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1" }, ".rks/something.json"],
        [{ tier: "framework-update", writeMode: "deny-list", denyList: ["notes/"], sessionId: "s2" }, FRAMEWORK],
      ];
      for (const [scope, file] of cases) {
        const dir = makeTempScopeDir();
        try {
          writeScopeFile(dir, scope);
          const r = await callCanon(dir, "Edit", { file_path: file });
          expect(r.code, file).toBe(0);
          expect(violations(dir), file).toEqual([]);
        } finally { cleanup(dir); }
      }
    });

    it("an unwritable .rks/telemetry does not change exit code or stderr", async () => {
      const ok = makeTempScopeDir();
      const broken = makeTempScopeDir();
      try {
        const scope = { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1", problemId: "backlog.feat.uw" };
        writeScopeFile(ok, scope);
        writeScopeFile(broken, scope);
        fs.writeFileSync(path.join(broken, ".rks", "telemetry"), "not a directory\n");
        const a = await callCanon(ok, "Edit", { file_path: UNRELATED });
        const b = await callCanon(broken, "Edit", { file_path: UNRELATED });
        expect(a.code).toBe(2);
        expect(b.code).toBe(2);
        expect(b.stderr).toBe(a.stderr);
        expect(b.stderr).not.toContain("Hook error");
        expect(violations(ok)).toHaveLength(1); // positive control: the writable case did write
        expect(fs.readFileSync(path.join(broken, ".rks", "telemetry"), "utf8")).toBe("not a directory\n");
      } finally { cleanup(ok); cleanup(broken); }
    });

    it("a target outside the project dir records file null and outsideProject true", async () => {
      const dir = makeTempScopeDir();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rks-scope-outside-"));
      try {
        writeScopeFile(dir, { tier: "build-only", writeMode: "scoped", allowedFiles: [ALLOWED], sessionId: "s1", problemId: "backlog.feat.op" });
        const abs = path.join(outside, "elsewhere", "target-file.mjs");
        const r = await callCanon(dir, "Write", { file_path: abs });
        expect(r.code).toBe(2);
        expect(r.stderr).toContain(abs); // stderr is unchanged and still names the path
        const evs = violations(dir);
        expect(evs).toHaveLength(1);
        expect(evs[0].payload.file).toBeNull();
        expect(evs[0].payload.outsideProject).toBe(true);
        const bytes = eventsBytes(dir);
        expect(bytes).not.toContain(abs);
        expect(bytes).not.toContain(outside);
        expect(bytes).not.toContain("target-file.mjs");
      } finally { cleanup(dir); cleanup(outside); }
    });

    it("the three enforce-targetfile-scope.mjs copies are byte-identical", () => {
      const rel = path.join("hooks", "system", "enforce-targetfile-scope.mjs");
      const canonical = fs.readFileSync(path.join(PROJECT_ROOT, "packages", rel));
      const deployed = fs.readFileSync(path.join(PROJECT_ROOT, ".routekit", rel));
      const template = fs.readFileSync(path.join(PROJECT_ROOT, "templates", "generic", ".routekit", rel));
      expect(canonical.length).toBeGreaterThan(0);
      expect(canonical.includes("offrail.scope_violation")).toBe(true);
      expect(deployed.equals(canonical)).toBe(true);
      expect(template.equals(canonical)).toBe(true);
    });
  });
});
