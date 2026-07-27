import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createSession, endSession, setGuardrailsDisabled, restoreGuardrails, detectOrphanedGuardrails, setProjectRoot, resetToken } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

describe("guardrails-restore-gap", () => {
  let projectRoot;

  beforeEach(() => {
    resetToken(); // Clear all sessions for test isolation
    projectRoot = makeTempDir("guardrails-restore-test");
    fs.mkdirSync(path.join(projectRoot, ".routekit"), { recursive: true });
    setProjectRoot(projectRoot);
  });

  describe("createSession guardrailsDisabled flag", () => {
    it("initializes session with guardrailsDisabled: false", () => {
      const { session } = createSession({ projectId: "test" });
      expect(session.guardrailsDisabled).toBe(false);
    });
  });

  describe("setGuardrailsDisabled", () => {
    it("sets guardrailsDisabled to true on the session", () => {
      const { token, session } = createSession({ projectId: "test" });
      setGuardrailsDisabled(token);
      expect(session.guardrailsDisabled).toBe(true);
    });
  });

  describe("endSession auto-restore", () => {
    it("calls restoreGuardrails when guardrailsDisabled is true", () => {
      // Create hooks.bak to simulate disabled guardrails
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "test-hook.mjs"), "// hook");

      const { token } = createSession({ projectId: "test" });
      setGuardrailsDisabled(token);
      endSession(token);

      // hooks.bak should be gone, hooks should exist
      expect(fs.existsSync(bakDir)).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "test-hook.mjs"))).toBe(true);
    });

    it("does NOT call restoreGuardrails when guardrailsDisabled is false", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "test-hook.mjs"), "// hook");

      const { token } = createSession({ projectId: "test" });
      // Don't set guardrailsDisabled
      endSession(token);

      // hooks.bak should still exist
      expect(fs.existsSync(bakDir)).toBe(true);
    });
  });

  describe("restoreGuardrails", () => {
    it("moves hooks.bak back to hooks", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "my-hook.mjs"), "// hook content");

      const result = restoreGuardrails();
      expect(result).toBe(true);
      expect(fs.existsSync(bakDir)).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "my-hook.mjs"))).toBe(true);
    });

    it("returns false when hooks.bak does not exist", () => {
      const result = restoreGuardrails();
      expect(result).toBe(false);
    });
  });

  describe("detectOrphanedGuardrails", () => {
    it("restores hooks.bak when no active session exists", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "orphaned-hook.mjs"), "// orphaned");

      const result = detectOrphanedGuardrails();
      expect(result).toBe(true);
      expect(fs.existsSync(bakDir)).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, ".routekit", "hooks", "orphaned-hook.mjs"))).toBe(true);
    });

    it("does NOT restore when an active session exists", () => {
      const bakDir = path.join(projectRoot, ".routekit", "hooks.bak");
      fs.mkdirSync(bakDir, { recursive: true });
      fs.writeFileSync(path.join(bakDir, "hook.mjs"), "// hook");

      const { token } = createSession({ projectId: "test" });
      const result = detectOrphanedGuardrails();
      expect(result).toBe(false);
      expect(fs.existsSync(bakDir)).toBe(true);

      // Cleanup
      endSession(token);
    });

    it("is a no-op when hooks.bak does not exist", () => {
      const result = detectOrphanedGuardrails();
      expect(result).toBe(false);
    });
  });
});
