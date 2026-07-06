import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { readPackageScripts, formatScriptsForPrompt } from "../../packages/mcp-rks/src/server/planner.mjs";

describe("planner-scripts-injection", () => {
  describe("readPackageScripts", () => {
    const tmpDir = path.join(process.cwd(), ".tmp-test-pkg-scripts");

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns scripts object when package.json has scripts", () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", scripts: { test: "vitest", build: "vite build" } })
      );
      const result = readPackageScripts(tmpDir);
      expect(result).toEqual({ test: "vitest", build: "vite build" });
    });

    it("returns null when package.json does not exist", () => {
      const result = readPackageScripts(tmpDir);
      expect(result).toBeNull();
    });

    it("returns null when package.json has no scripts field", () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", version: "1.0.0" })
      );
      const result = readPackageScripts(tmpDir);
      expect(result).toBeNull();
    });

    it("returns null when scripts is an empty object", () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", scripts: {} })
      );
      const result = readPackageScripts(tmpDir);
      expect(result).toBeNull();
    });

    it("returns null when package.json is malformed JSON", () => {
      fs.writeFileSync(path.join(tmpDir, "package.json"), "{ not valid json }}}");
      const result = readPackageScripts(tmpDir);
      expect(result).toBeNull();
    });
  });

  describe("formatScriptsForPrompt", () => {
    it("formats scripts with delimiters and directive when scripts exist", () => {
      const scripts = { test: "vitest", lint: "eslint .", build: "vite build" };
      const sections = formatScriptsForPrompt(scripts);

      expect(sections).toHaveLength(2);
      expect(sections[0]).toContain("--- Available npm scripts (from package.json) ---");
      expect(sections[0]).toContain("--- End npm scripts ---");
      expect(sections[0]).toContain("npm run test");
      expect(sections[0]).toContain("npm run lint");
      expect(sections[0]).toContain("npm run build");
      expect(sections[0]).toContain("vitest");
      expect(sections[0]).toContain("eslint .");
      expect(sections[1]).toContain("IMPORTANT");
      expect(sections[1]).toContain("Only generate run_command steps for npm scripts listed above");
    });

    it("returns no-scripts warning when scripts is null", () => {
      const sections = formatScriptsForPrompt(null);

      expect(sections).toHaveLength(1);
      expect(sections[0]).toContain("No npm scripts found");
      expect(sections[0]).toContain("Do NOT generate run_command steps");
    });

    it("returns no-scripts warning when scripts is undefined", () => {
      const sections = formatScriptsForPrompt(undefined);

      expect(sections).toHaveLength(1);
      expect(sections[0]).toContain("No npm scripts found");
    });

    it("includes each script name with npm run prefix", () => {
      const scripts = { "test:unit": "vitest run", "test:e2e": "playwright test" };
      const sections = formatScriptsForPrompt(scripts);

      expect(sections[0]).toContain("npm run test:unit");
      expect(sections[0]).toContain("npm run test:e2e");
    });
  });
});
