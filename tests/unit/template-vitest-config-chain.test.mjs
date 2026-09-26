import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fitness function for the template vitest config chain.
//
// Guards the uat-calc-0626 UAT blocker (notes/research.2026.06.28.uat-findings.md
// Finding 1): templates/base/vitest.config.unit.mjs re-exported a config
// (./vitest.config.ts) that templates/base/ never provisioned, so a freshly
// scaffolded child hit an unresolvable import the moment it ran its tests.
//
// These assertions fail the instant the shim's re-export target goes missing or
// is renamed. They check resolvability + exported shape only — NOT byte-for-byte
// identity with the shell's own root config (children customize their config).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const templateBase = path.join(repoRoot, "templates", "base");
const shimPath = path.join(templateBase, "vitest.config.unit.mjs");

describe("template vitest config chain (fitness function)", () => {
  it("shim re-exports a config file that templates/base/ actually provisions", () => {
    const shimSrc = fs.readFileSync(shimPath, "utf8");
    const m = shimSrc.match(/from\s+["']\.\/([^"']+)["']/);
    expect(m, "shim must be a single-line relative re-export").not.toBeNull();
    const targetPath = path.join(templateBase, m[1]);
    expect(
      fs.existsSync(targetPath),
      `shim re-exports ./${m[1]} but templates/base/${m[1]} does not exist`,
    ).toBe(true);
  });

  it("resolves the shim re-export chain without an unresolvable import", async () => {
    const mod = await import(pathToFileURL(shimPath).href);
    expect(mod.default).toBeDefined();
  });

  it("exports the expected vitest config shape (a test object)", async () => {
    const mod = await import(pathToFileURL(shimPath).href);
    const config =
      typeof mod.default === "function"
        ? await mod.default({ mode: "test", command: "serve" })
        : mod.default;
    expect(config).toBeTypeOf("object");
    expect(config.test).toBeTypeOf("object");
  });

  it("template base is child-safe (no shell-only setupFiles, distinct from the shell root base)", async () => {
    // The shell's root vitest.config.base.mjs references shell-only files
    // (tests/setup.mjs); the template base must NOT, so it is deliberately a
    // separate minimal config rather than a verbatim copy of the shell's.
    // Assert on the RESOLVED config (behavioral) rather than source text, so a
    // doc comment that names the file doesn't trip a substring check.
    const templateBasePath = path.join(templateBase, "vitest.config.base.mjs");
    const mod = await import(pathToFileURL(templateBasePath).href);
    const config =
      typeof mod.default === "function"
        ? await mod.default({ mode: "test", command: "serve" })
        : mod.default;
    const setupFiles = config.test?.setupFiles ?? [];
    const setupArr = Array.isArray(setupFiles) ? setupFiles : [setupFiles];
    expect(setupArr).not.toContain("tests/setup.mjs");
    // Distinct from the shell's own (shell-specific) root base config.
    const templateBaseSrc = fs.readFileSync(templateBasePath, "utf8");
    const shellBaseSrc = fs.readFileSync(path.join(repoRoot, "vitest.config.base.mjs"), "utf8");
    expect(templateBaseSrc).not.toBe(shellBaseSrc);
  });
});
