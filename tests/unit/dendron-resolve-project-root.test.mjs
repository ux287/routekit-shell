import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectRoot } from "../../packages/mcp-rks/src/dendron.mjs";

// resolveProjectRoot must GUARD env-derived roots with an existence check. A literal
// "${workspaceFolder}" the editor never expanded reached this resolver and produced
// <cwd>/${workspaceFolder}/notes — breaking story creation. The guard falls back to cwd
// when the env path doesn't exist (mirrors envProjectRoot in project-context.mjs).

const ENV_KEYS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT"];

describe("dendron resolveProjectRoot — existence-guarded env roots", () => {
  let saved, realDir;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    realDir = mkdtempSync(path.join(tmpdir(), "rks-resolve-"));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(realDir, { recursive: true, force: true });
  });

  it("falls back to cwd when ROUTEKIT_PROJECT_ROOT is a literal ${workspaceFolder} (nonexistent)", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = "${workspaceFolder}";
    const r = resolveProjectRoot();
    expect(r).toBe(process.cwd());
    expect(r).not.toContain("${workspaceFolder}");
  });

  it("falls back to cwd when ROUTEKIT_PROJECT_ROOT points at a nonexistent path", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = path.join(realDir, "no", "such", "dir");
    expect(resolveProjectRoot()).toBe(process.cwd());
  });

  it("uses ROUTEKIT_PROJECT_ROOT when it points at a real existing directory", () => {
    process.env.ROUTEKIT_PROJECT_ROOT = realDir;
    expect(resolveProjectRoot()).toBe(path.resolve(realDir));
  });

  it("guards RKS_PROJECT_ROOT identically (nonexistent → cwd; real → used)", () => {
    process.env.RKS_PROJECT_ROOT = "${workspaceFolder}";
    expect(resolveProjectRoot()).toBe(process.cwd());
    process.env.RKS_PROJECT_ROOT = realDir;
    expect(resolveProjectRoot()).toBe(path.resolve(realDir));
  });

  it("respects an explicit root argument unchanged (NOT existence-guarded)", () => {
    // explicitRoot is a caller-supplied intent; behavior is preserved (resolve as given).
    expect(resolveProjectRoot("/some/explicit/root")).toBe(path.resolve("/some/explicit/root"));
  });
});
