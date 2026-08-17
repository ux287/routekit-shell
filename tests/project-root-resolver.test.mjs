import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, makeTempDir, writeFile } from "./helpers/tmp.mjs";
import { resolveProjectRoot } from "../packages/cli/src/project/resolve-project-root.mjs";

describe("project root resolver", () => {
  it("uses ROUTEKIT_PROJECT_ROOT when set", () => {
    const projectRoot = makeTempDir("resolve_root_env");
    const res = resolveProjectRoot({ cwd: "/tmp", env: { ROUTEKIT_PROJECT_ROOT: projectRoot } });
    expect(res.projectRoot).toBe(path.resolve(projectRoot));
    expect(res.reason).toBe("env");
  });

  it("finds routekit/project.json by walking up from cwd", () => {
    const projectRoot = makeTempDir("resolve_root_marker");
    ensureDir(path.join(projectRoot, "routekit"));
    writeFile(path.join(projectRoot, "routekit", "project.json"), JSON.stringify({ id: "p" }, null, 2));
    const cwd = path.join(projectRoot, "src", "nested");
    ensureDir(cwd);
    const res = resolveProjectRoot({ cwd, env: {} });
    expect(res.projectRoot).toBe(path.resolve(projectRoot));
    expect(res.reason).toBe("marker");
  });

  it("falls back to vendored heuristic when no routekit/project.json exists", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resolve_root_vendored_"));
    const cwd = path.join(projectRoot, "tools", "routekit-shell", "packages", "cli");
    ensureDir(cwd);
    const res = resolveProjectRoot({ cwd, env: {} });
    expect(res.projectRoot).toBe(path.resolve(projectRoot));
    expect(res.reason).toBe("vendored");
  });
});
