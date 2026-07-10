import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeTempDir, writeFile, ensureDir } from "./helpers/tmp.mjs";
import { resolveTargetPaths } from "../packages/mcp-rks/src/llm/targets.mjs";
import { validateStep } from "../packages/mcp-rks/src/server/planner.mjs";

describe("planner Targets (globs/dirs)", () => {
  it("expands directory targets to existing files and allows create under the directory", () => {
    const projectRoot = makeTempDir("targets_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "targets-project", private: true }, null, 2));

    writeFile(path.join(projectRoot, "src", "_includes", "layouts", "hero.njk"), "<h1>Hero</h1>\n");
    writeFile(path.join(projectRoot, "src", "_includes", "components", "header.njk"), "<header></header>\n");
    ensureDir(path.join(projectRoot, ".rks"));
    writeFile(
      path.join(projectRoot, ".rks", "protected-files.yml"),
      "protected:\n  - \"package.json\"\n"
    );

    const targets = ["src/_includes/layouts/"];
    const resolved = resolveTargetPaths(projectRoot, targets, { maxFiles: 80 });
    expect(resolved.allowFiles).toContain("src/_includes/layouts/hero.njk");
    expect(resolved.allowFiles).not.toContain("src/_includes/components/header.njk");
    expect(resolved.allowPatterns).toContain("src/_includes/layouts/**");

    const createAllowed = validateStep(
      { action: "create_file", path: "src/_includes/layouts/new-layout.njk", content: "ok" },
      resolved,
      projectRoot
    );
    expect(createAllowed.action).toBe("create_file");

    const createRejected = validateStep(
      { action: "create_file", path: "src/_includes/components/new-comp.njk", content: "ok" },
      resolved,
      projectRoot
    );
    expect(createRejected.action).toBe("note");
  });

  it("supports explicit file targets", () => {
    const projectRoot = makeTempDir("targets_project_file");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "targets-project-file", private: true }, null, 2));
    writeFile(path.join(projectRoot, "src", "a.js"), "export const a = 1;\n");

    const resolved = resolveTargetPaths(projectRoot, ["src/a.js"], { maxFiles: 80 });
    const editAllowed = validateStep(
      { action: "edit_file", path: "src/a.js", content: "export const a = 2;\n" },
      resolved,
      projectRoot
    );
    expect(editAllowed.action).toBe("edit_file");

    const editRejected = validateStep(
      { action: "edit_file", path: "src/b.js", content: "export const b = 1;\n" },
      resolved,
      projectRoot
    );
    expect(editRejected.action).toBe("note");
  });
});

