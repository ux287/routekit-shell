import path from "node:path";
import { describe, it, expect } from "vitest";
import { makeTempDir, writeFile } from "./helpers/tmp.mjs";
import { buildCodemap } from "../packages/mcp-rks/src/server/planner.mjs";

describe("analyze framework profiles (codemap)", () => {
  it("infers Eleventy/Nunjucks and produces template-oriented codemap", () => {
    const projectRoot = makeTempDir("eleventy_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "eleventy-project", private: true }, null, 2));
    writeFile(path.join(projectRoot, ".eleventy.js"), "module.exports = function () { return {}; };\n");
    writeFile(path.join(projectRoot, "notes", "eleventy.note.md"), "---\ntitle: Note\n---\n\nHello\n");
    writeFile(path.join(projectRoot, "src", "_includes", "layouts", "hero.njk"), "<h1>Hero</h1>\n");
    writeFile(path.join(projectRoot, "src", "_includes", "components", "header.njk"), "<header></header>\n");
    writeFile(path.join(projectRoot, "src", "index.njk"), "{% extends 'layouts/hero.njk' %}\n");

    const { codemap } = buildCodemap({ projectRoot, projectId: "eleventy", kg: null });
    expect(codemap.framework).toBe("eleventy-nunjucks");
    expect(codemap.pages).toContain("src/index.njk");
    expect(codemap.components).toContain("src/_includes/layouts/hero.njk");
    expect(codemap.components).toContain("src/_includes/components/header.njk");
    expect(Object.keys(codemap.codeRoots)).toContain("src");
    expect(Object.keys(codemap.codeRoots)).toContain("notes");
  });

  it("infers Astro and produces page/component codemap", () => {
    const projectRoot = makeTempDir("astro_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "astro-project", private: true }, null, 2));
    writeFile(path.join(projectRoot, "astro.config.mjs"), "export default {};\n");
    writeFile(path.join(projectRoot, "src", "pages", "index.astro"), "---\n---\n<html></html>\n");
    writeFile(path.join(projectRoot, "src", "components", "Button.tsx"), "export function Button() { return null; }\n");

    const { codemap } = buildCodemap({ projectRoot, projectId: "astro", kg: null });
    expect(codemap.framework).toBe("astro");
    expect(codemap.pages).toContain("src/pages/index.astro");
    expect(codemap.components).toContain("src/components/Button.tsx");
  });
});

