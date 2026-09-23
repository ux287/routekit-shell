import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { scanProject, hasSourceFiles } from "../packages/mcp-rks/src/server/archaeology.mjs";

describe("archaeology scanner", () => {
  let tempDir;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "archaeology-test-"));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("scanProject", () => {
    it("detects package.json and JavaScript", async () => {
      const testDir = path.join(tempDir, "js-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          dependencies: { lodash: "^4.0.0" },
        })
      );

      const result = await scanProject(testDir);
      expect(result.techStack.language).toBe("javascript");
      expect(result.techStack.packageManager).toBe("npm");
      expect(result.dependencies.production).toContain("lodash");
    });

    it("detects TypeScript from tsconfig.json", async () => {
      const testDir = path.join(tempDir, "ts-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "package.json"), "{}");
      fs.writeFileSync(path.join(testDir, "tsconfig.json"), "{}");

      const result = await scanProject(testDir);
      expect(result.techStack.language).toBe("typescript");
    });

    it("detects React from dependencies", async () => {
      const testDir = path.join(tempDir, "react-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          dependencies: { react: "^18.0.0" },
        })
      );

      const result = await scanProject(testDir);
      expect(result.techStack.framework).toBe("react");
    });

    it("detects Vue from dependencies", async () => {
      const testDir = path.join(tempDir, "vue-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          dependencies: { vue: "^3.0.0" },
        })
      );

      const result = await scanProject(testDir);
      expect(result.techStack.framework).toBe("vue");
    });

    it("detects Next.js from dependencies", async () => {
      const testDir = path.join(tempDir, "next-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          dependencies: { next: "^14.0.0", react: "^18.0.0" },
        })
      );

      const result = await scanProject(testDir);
      expect(result.techStack.framework).toBe("next");
    });

    it("detects Vitest as testing framework", async () => {
      const testDir = path.join(tempDir, "vitest-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          devDependencies: { vitest: "^1.0.0" },
        })
      );

      const result = await scanProject(testDir);
      expect(result.testing).toBe("vitest");
    });

    it("detects Jest as testing framework", async () => {
      const testDir = path.join(tempDir, "jest-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          devDependencies: { jest: "^29.0.0" },
        })
      );

      const result = await scanProject(testDir);
      expect(result.testing).toBe("jest");
    });

    it("detects GitHub Actions CI", async () => {
      const testDir = path.join(tempDir, "ci-project");
      fs.mkdirSync(path.join(testDir, ".github/workflows"), { recursive: true });
      fs.writeFileSync(path.join(testDir, ".github/workflows/test.yml"), "name: Test");

      const result = await scanProject(testDir);
      expect(result.ci).toBe("github-actions");
    });

    it("detects monorepo structure", async () => {
      const testDir = path.join(tempDir, "monorepo-project");
      fs.mkdirSync(path.join(testDir, "packages"), { recursive: true });

      const result = await scanProject(testDir);
      expect(result.structure.type).toBe("monorepo");
    });

    it("detects single-package structure", async () => {
      const testDir = path.join(tempDir, "single-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "index.js"), "");

      const result = await scanProject(testDir);
      expect(result.structure.type).toBe("single-package");
    });

    it("reads existing CLAUDE.md", async () => {
      const testDir = path.join(tempDir, "claude-md-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "CLAUDE.md"), "# Test Claude MD");

      const result = await scanProject(testDir);
      expect(result.claudeMd).toBe("# Test Claude MD");
    });

    it("generates summary correctly", async () => {
      const testDir = path.join(tempDir, "summary-project");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "package.json"),
        JSON.stringify({
          dependencies: { react: "^18.0.0" },
          devDependencies: { vitest: "^1.0.0", vite: "^5.0.0" },
        })
      );
      fs.writeFileSync(path.join(testDir, "tsconfig.json"), "{}");

      const result = await scanProject(testDir);
      expect(result.summary).toContain("typescript");
      expect(result.summary).toContain("react");
      expect(result.summary).toContain("vite");
      expect(result.summary).toContain("vitest");
    });
  });

  describe("hasSourceFiles", () => {
    it("returns true for project with package.json", () => {
      const testDir = path.join(tempDir, "has-pkg");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "package.json"), "{}");

      expect(hasSourceFiles(testDir)).toBe(true);
    });

    it("returns true for project with src directory", () => {
      const testDir = path.join(tempDir, "has-src");
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });

      expect(hasSourceFiles(testDir)).toBe(true);
    });

    it("returns true for project with index.js", () => {
      const testDir = path.join(tempDir, "has-index");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "index.js"), "");

      expect(hasSourceFiles(testDir)).toBe(true);
    });

    it("returns false for empty directory", () => {
      const testDir = path.join(tempDir, "empty-dir");
      fs.mkdirSync(testDir, { recursive: true });

      expect(hasSourceFiles(testDir)).toBe(false);
    });
  });
});
