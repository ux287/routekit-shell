/**
 * Archaeology Scanner Module
 *
 * Scans existing codebases to extract tech stack, structure, and context
 * for use when attaching RKS to an existing project.
 */

import fs from "fs";
import path from "path";

/**
 * Scan a project directory and return structured archaeology data.
 * @param {string} projectRoot - Absolute path to project root
 * @returns {Object} Archaeology results
 */
export async function scanProject(projectRoot) {
  const results = {
    techStack: {},
    structure: {},
    ci: null,
    testing: null,
    dependencies: {},
    claudeMd: null,
    summary: "",
  };

  // Detect package.json
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      results.techStack.language = "javascript";
      results.techStack.packageManager = fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(projectRoot, "yarn.lock"))
          ? "yarn"
          : "npm";
      results.dependencies = {
        production: Object.keys(pkg.dependencies || {}),
        dev: Object.keys(pkg.devDependencies || {}),
      };

      // Detect frameworks from dependencies
      const allDeps = [...results.dependencies.production, ...results.dependencies.dev];
      if (allDeps.includes("react")) results.techStack.framework = "react";
      if (allDeps.includes("vue")) results.techStack.framework = "vue";
      if (allDeps.includes("next")) results.techStack.framework = "next";
      if (allDeps.includes("vite")) results.techStack.buildTool = "vite";
      if (allDeps.includes("webpack")) results.techStack.buildTool = "webpack";

      // Detect testing
      if (allDeps.includes("vitest")) results.testing = "vitest";
      else if (allDeps.includes("jest")) results.testing = "jest";
      else if (allDeps.includes("mocha")) results.testing = "mocha";
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Detect TypeScript
  if (fs.existsSync(path.join(projectRoot, "tsconfig.json"))) {
    results.techStack.language = "typescript";
  }

  // Detect CI
  if (fs.existsSync(path.join(projectRoot, ".github/workflows"))) {
    results.ci = "github-actions";
  } else if (fs.existsSync(path.join(projectRoot, ".gitlab-ci.yml"))) {
    results.ci = "gitlab-ci";
  }

  // Detect monorepo
  if (fs.existsSync(path.join(projectRoot, "packages")) ||
      fs.existsSync(path.join(projectRoot, "pnpm-workspace.yaml"))) {
    results.structure.type = "monorepo";
  } else {
    results.structure.type = "single-package";
  }

  // Read existing CLAUDE.md
  const claudePath = path.join(projectRoot, "CLAUDE.md");
  if (fs.existsSync(claudePath)) {
    results.claudeMd = fs.readFileSync(claudePath, "utf8");
  }

  // Generate summary
  const parts = [];
  if (results.techStack.language) parts.push(results.techStack.language);
  if (results.techStack.framework) parts.push(results.techStack.framework);
  if (results.techStack.buildTool) parts.push(`built with ${results.techStack.buildTool}`);
  if (results.testing) parts.push(`tested with ${results.testing}`);
  results.summary = parts.join(", ") || "Unknown stack";

  return results;
}

/**
 * Check if a project has source files (vs empty/greenfield).
 * @param {string} projectRoot - Absolute path to project root
 * @returns {boolean} True if project has source files
 */
export function hasSourceFiles(projectRoot) {
  const indicators = [
    "package.json",
    "src",
    "lib",
    "app",
    "index.js",
    "index.ts",
    "main.js",
    "main.ts",
  ];
  return indicators.some(f => fs.existsSync(path.join(projectRoot, f)));
}
