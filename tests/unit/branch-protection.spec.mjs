import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir } from "../helpers/tmp.mjs";

// We'll test the module by importing it and mocking the dependencies
const MODULE_PATH = path.resolve("./packages/mcp-rks/src/server/branch-protection.mjs");

describe("branch-protection", () => {
  let projectDir;
  let branchProtection;

  beforeEach(async () => {
    projectDir = makeTempDir("branch-protection-test");

    // Create minimal project structure
    const rksDir = path.join(projectDir, ".rks");
    fs.mkdirSync(rksDir, { recursive: true });

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

    // Dynamically import the module
    branchProtection = await import(MODULE_PATH);
  });

  describe("two-branch topology (staging as working)", () => {
    beforeEach(() => {
      // Override the project.json for two-branch setup
      const rksDir = path.join(projectDir, ".rks");
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
    });

    it("protects main branch", () => {
      const protectedBranches = branchProtection.getProtectedBranches(projectDir);
      expect(protectedBranches).toContain("main");
    });

    it("does NOT protect staging (it is the working branch)", () => {
      const protectedBranches = branchProtection.getProtectedBranches(projectDir);
      // In two-branch, working === integration, so staging is NOT protected
      expect(protectedBranches).not.toContain("staging");
    });

    it("throws when trying to checkout main", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "main", "checkout")
      ).toThrow(/BLOCKED.*main/);
    });

    it("allows checkout to staging (working branch)", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "staging", "checkout")
      ).not.toThrow();
    });

    it("allows checkout to feature branches", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "rks/my-feature", "checkout")
      ).not.toThrow();
    });
  });

  describe("three-branch topology (dev as working)", () => {
    beforeEach(() => {
      // Override the project.json for three-branch setup
      const rksDir = path.join(projectDir, ".rks");
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({
          id: "test-project",
          root: projectDir,
          branches: {
            working: "dev",
            integration: "staging",
            production: "main"
          }
        })
      );
    });

    it("protects both staging and main", () => {
      const protectedBranches = branchProtection.getProtectedBranches(projectDir);
      expect(protectedBranches).toContain("staging");
      expect(protectedBranches).toContain("main");
    });

    it("does NOT protect dev (it is the working branch)", () => {
      const protectedBranches = branchProtection.getProtectedBranches(projectDir);
      expect(protectedBranches).not.toContain("dev");
    });

    it("throws when trying to checkout staging", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "staging", "checkout")
      ).toThrow(/BLOCKED.*staging/);
    });

    it("throws when trying to checkout main", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "main", "checkout")
      ).toThrow(/BLOCKED.*main/);
    });

    it("allows checkout to dev (working branch)", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "dev", "checkout")
      ).not.toThrow();
    });

    it("allows rks_promote to touch staging with allowPromote", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "staging", "merge", { allowPromote: true })
      ).not.toThrow();
    });

    it("allows rks_release to touch main with allowRelease", () => {
      expect(() =>
        branchProtection.assertNotProtectedBranch(projectDir, "main", "merge", { allowRelease: true })
      ).not.toThrow();
    });
  });

  describe("assertNotOnProtectedBranch", () => {
    beforeEach(() => {
      // Three-branch setup for maximum protection
      const rksDir = path.join(projectDir, ".rks");
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({
          id: "test-project",
          root: projectDir,
          branches: {
            working: "dev",
            integration: "staging",
            production: "main"
          }
        })
      );
    });

    it("throws when on main", () => {
      expect(() =>
        branchProtection.assertNotOnProtectedBranch(projectDir, "main", "commit")
      ).toThrow(/BLOCKED.*main/);
    });

    it("throws when on staging (three-branch)", () => {
      expect(() =>
        branchProtection.assertNotOnProtectedBranch(projectDir, "staging", "commit")
      ).toThrow(/BLOCKED.*staging/);
    });

    it("allows commits on feature branches", () => {
      expect(() =>
        branchProtection.assertNotOnProtectedBranch(projectDir, "rks/fix-bug", "commit")
      ).not.toThrow();
    });

    it("allows commits on dev (three-branch working branch)", () => {
      expect(() =>
        branchProtection.assertNotOnProtectedBranch(projectDir, "dev", "commit")
      ).not.toThrow();
    });
  });

  describe("error messages", () => {
    beforeEach(() => {
      const rksDir = path.join(projectDir, ".rks");
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({
          id: "test-project",
          root: projectDir,
          branches: {
            working: "dev",
            integration: "staging",
            production: "main"
          }
        })
      );
    });

    it("suggests rks_release for main branch", () => {
      try {
        branchProtection.assertNotProtectedBranch(projectDir, "main", "checkout");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e.message).toContain("rks_release");
      }
    });

    it("suggests rks_promote for staging branch", () => {
      try {
        branchProtection.assertNotProtectedBranch(projectDir, "staging", "checkout");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e.message).toContain("rks_promote");
      }
    });
  });

  describe("isIntegrationBranch", () => {
    it("identifies staging as integration branch", () => {
      const rksDir = path.join(projectDir, ".rks");
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({
          id: "test-project",
          root: projectDir,
          branches: {
            working: "dev",
            integration: "staging",
            production: "main"
          }
        })
      );
      expect(branchProtection.isIntegrationBranch(projectDir, "staging")).toBe(true);
    });
  });

  describe("isProductionBranch", () => {
    it("identifies main as production branch", () => {
      const rksDir = path.join(projectDir, ".rks");
      fs.writeFileSync(
        path.join(rksDir, "project.json"),
        JSON.stringify({
          id: "test-project",
          root: projectDir,
          branches: {
            working: "dev",
            integration: "staging",
            production: "main"
          }
        })
      );
      expect(branchProtection.isProductionBranch(projectDir, "main")).toBe(true);
      expect(branchProtection.isProductionBranch(projectDir, "master")).toBe(true);
    });
  });
});
