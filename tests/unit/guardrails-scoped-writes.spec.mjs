import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir } from "../helpers/tmp.mjs";

const MODULE_PATH = path.resolve("./packages/mcp-rks/src/server/guardrails-audit.mjs");
const SCOPE_FILE = ".rks/active-scope.json";

describe("guardrails-scoped-writes", () => {
  let projectDir;
  let guardrailsModule;

  beforeEach(async () => {
    projectDir = makeTempDir("guardrails-scoped-writes-test");

    // Create minimal project structure
    const rksDir = path.join(projectDir, ".rks");
    fs.mkdirSync(rksDir, { recursive: true });

    // Create hooks directory (required for guardrailsOff)
    const hooksDir = path.join(projectDir, ".routekit", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, "test-hook.mjs"), "// test hook");

    // Create a minimal project.json
    fs.writeFileSync(
      path.join(rksDir, "project.json"),
      JSON.stringify({
        id: "test-project",
        root: projectDir,
        branches: {
          working: "staging",
          integration: "staging",
          production: "main"
        }
      })
    );

    // Create notes directory
    const notesDir = path.join(projectDir, "notes");
    fs.mkdirSync(notesDir, { recursive: true });

    // Create a sample backlog story with targetFiles
    fs.writeFileSync(
      path.join(notesDir, "backlog.feat.test-feature.md"),
      `---
id: backlog.feat.test-feature
title: Test Feature
phase: arch-approved
targetFiles:
  - src/components/Button.tsx
  - src/utils/helpers.mjs
  - "packages/**/*.ts"
created: 1700000000000
updated: 1700000000000
---

## Description
Test feature for scoped writes.
`
    );

    // Create another story WITHOUT targetFiles (but arch-approved so gate passes)
    fs.writeFileSync(
      path.join(notesDir, "backlog.feat.no-targets.md"),
      `---
id: backlog.feat.no-targets
title: No Targets Feature
phase: arch-approved
created: 1700000000000
updated: 1700000000000
---

## Description
Story without targetFiles defined.
`
    );

    // Dynamically import the module (fresh for each test)
    // Clear cache to ensure fresh import
    const cacheKey = Object.keys(require.cache || {}).find(k => k.includes("guardrails-audit"));
    if (cacheKey) delete require.cache[cacheKey];

    guardrailsModule = await import(MODULE_PATH + `?t=${Date.now()}`);
  });

  afterEach(() => {
    // Cleanup scope file if exists
    const scopePath = path.join(projectDir, SCOPE_FILE);
    if (fs.existsSync(scopePath)) {
      fs.unlinkSync(scopePath);
    }
  });

  describe("guardrailsOff with problemId", () => {
    it("writes scope file with allowedFiles from story", async () => {
      const result = await guardrailsModule.guardrailsOff(
        projectDir,
        "testing scoped writes",
        "all",
        "backlog.feat.test-feature"
      );

      expect(result.ok).toBe(true);
      expect(result.writeMode).toBe("scoped");
      expect(result.problemId).toBe("backlog.feat.test-feature");
      expect(result.allowedFiles).toContain("src/components/Button.tsx");
      expect(result.allowedFiles).toContain("src/utils/helpers.mjs");
      expect(result.allowedFiles).toContain("packages/**/*.ts");

      // Verify scope file was written
      const scopePath = path.join(projectDir, SCOPE_FILE);
      expect(fs.existsSync(scopePath)).toBe(true);

      const scopeData = JSON.parse(fs.readFileSync(scopePath, "utf8"));
      expect(scopeData.writeMode).toBe("scoped");
      expect(scopeData.allowedFiles).toEqual(result.allowedFiles);
      expect(scopeData.problemId).toBe("backlog.feat.test-feature");
    });

    it("sets read-only mode when story has no targetFiles", async () => {
      const result = await guardrailsModule.guardrailsOff(
        projectDir,
        "testing without targets",
        "all",
        "backlog.feat.no-targets"
      );

      expect(result.ok).toBe(true);
      expect(result.writeMode).toBe("read-only");
      expect(result.allowedFiles).toBeNull();
      expect(result.warning).toContain("no targetFiles defined");
    });

    it("rejects when story does not exist (not arch-approved)", async () => {
      const result = await guardrailsModule.guardrailsOff(
        projectDir,
        "testing nonexistent story",
        "all",
        "backlog.feat.nonexistent"
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("story_not_ready");
      expect(result.storyId).toBe("backlog.feat.nonexistent");
    });
  });

  describe("guardrailsOff without problemId", () => {
    it("rejects with problemId_required when no problemId supplied", async () => {
      const result = await guardrailsModule.guardrailsOff(
        projectDir,
        "exploration only",
        "all"
        // No problemId
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("problemId_required");
    });

    it("does not write scope file when problemId is absent", async () => {
      await guardrailsModule.guardrailsOff(
        projectDir,
        "exploration",
        "all"
      );

      const scopePath = path.join(projectDir, SCOPE_FILE);
      expect(fs.existsSync(scopePath)).toBe(false);
    });
  });

  describe("removeScopeFile", () => {
    it("removes existing scope file", async () => {
      // First create a scope file
      await guardrailsModule.guardrailsOff(
        projectDir,
        "test",
        "all",
        "backlog.feat.test-feature"
      );

      const scopePath = path.join(projectDir, SCOPE_FILE);
      expect(fs.existsSync(scopePath)).toBe(true);

      // Remove it
      const removed = guardrailsModule.removeScopeFile(projectDir);
      expect(removed).toBe(true);
      expect(fs.existsSync(scopePath)).toBe(false);
    });

    it("returns false when no scope file exists", () => {
      const scopePath = path.join(projectDir, SCOPE_FILE);
      if (fs.existsSync(scopePath)) {
        fs.unlinkSync(scopePath);
      }

      const removed = guardrailsModule.removeScopeFile(projectDir);
      expect(removed).toBe(false);
    });
  });

  describe("guardrailsOn cleans up scope file", () => {
    it("scope file removal is verified via removeScopeFile", async () => {
      // The guardrailsOn function calls removeScopeFile internally.
      // We've already tested removeScopeFile directly above.
      // This test verifies the integration by checking the exported function works.

      // Start session to create the scope file
      await guardrailsModule.guardrailsOff(
        projectDir,
        "test",
        "all",
        "backlog.feat.test-feature"
      );

      const scopePath = path.join(projectDir, SCOPE_FILE);
      expect(fs.existsSync(scopePath)).toBe(true);

      // Directly test the removeScopeFile function (which guardrailsOn calls)
      const removed = guardrailsModule.removeScopeFile(projectDir);
      expect(removed).toBe(true);
      expect(fs.existsSync(scopePath)).toBe(false);

      // Note: Full guardrailsOn test would require mocking git operations
      // which is beyond the scope of this unit test.
    });
  });
});
