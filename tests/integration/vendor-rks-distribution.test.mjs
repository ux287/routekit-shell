import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, ensureDir } from "../helpers/tmp.mjs";

const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const vendorScript = path.join(repoRoot, "scripts", "vendor-rks.sh");
const SCRIPT_TIMEOUT = 90_000;

function makeTargetProject(name) {
  const targetDir = makeTempDir(name);
  ensureDir(path.join(targetDir, ".rks"));
  fs.writeFileSync(
    path.join(targetDir, ".rks", "project.json"),
    JSON.stringify({ projectId: name }, null, 2)
  );
  return targetDir;
}

describe("vendor-rks.sh vitest runner distribution", () => {
  it("copies scripts/vitest-runner.mjs to target project", () => {
    const target = makeTargetProject("test-vendor-vitest");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(path.join(target, "scripts", "vitest-runner.mjs"))).toBe(true);
  });

  it("copies scripts/lib/spawn-managed.mjs to target project", () => {
    const target = makeTargetProject("test-vendor-spawn");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(path.join(target, "scripts", "lib", "spawn-managed.mjs"))).toBe(true);
  });

  it("creates scripts/lib/ directory in target project if absent", () => {
    const target = makeTargetProject("test-vendor-mkdir");
    expect(fs.existsSync(path.join(target, "scripts"))).toBe(false);
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.existsSync(path.join(target, "scripts", "lib"))).toBe(true);
  });

  it("overwrites existing vitest-runner.mjs with latest from source", () => {
    const target = makeTargetProject("test-vendor-overwrite");
    ensureDir(path.join(target, "scripts"));
    fs.writeFileSync(path.join(target, "scripts", "vitest-runner.mjs"), "STALE CONTENT");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const content = fs.readFileSync(path.join(target, "scripts", "vitest-runner.mjs"), "utf8");
    expect(content).not.toBe("STALE CONTENT");
    expect(content).toContain("spawn-managed.mjs");
  });

  it("source scripts/vitest-runner.mjs is unchanged after vendor run", () => {
    const target = makeTargetProject("test-vendor-src-vitest-unchanged");
    const srcBefore = fs.readFileSync(path.join(repoRoot, "scripts", "vitest-runner.mjs"), "utf8");
    spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    const srcAfter = fs.readFileSync(path.join(repoRoot, "scripts", "vitest-runner.mjs"), "utf8");
    expect(srcAfter).toBe(srcBefore);
  });

  it("source scripts/lib/spawn-managed.mjs is unchanged after vendor run", () => {
    const target = makeTargetProject("test-vendor-src-spawn-unchanged");
    const srcBefore = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "spawn-managed.mjs"), "utf8");
    spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    const srcAfter = fs.readFileSync(path.join(repoRoot, "scripts", "lib", "spawn-managed.mjs"), "utf8");
    expect(srcAfter).toBe(srcBefore);
  });

  it("import integrity: copied vitest-runner.mjs references spawn-managed.mjs and content matches source", () => {
    const target = makeTargetProject("test-vendor-import-integrity");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const runnerPath = path.join(target, "scripts", "vitest-runner.mjs");
    const spawnPath = path.join(target, "scripts", "lib", "spawn-managed.mjs");
    expect(fs.existsSync(runnerPath)).toBe(true);
    expect(fs.existsSync(spawnPath)).toBe(true);
    const runnerContent = fs.readFileSync(runnerPath, "utf8");
    expect(runnerContent).toContain("spawn-managed.mjs");
    const srcRunner = fs.readFileSync(path.join(repoRoot, "scripts", "vitest-runner.mjs"), "utf8");
    expect(runnerContent).toBe(srcRunner);
  });

  it("vendor script exits with code 0 and leaves no .bak files in target (cross-platform sed)", () => {
    const target = makeTargetProject("test-vendor-cross-platform");
    const result = spawnSync("bash", [vendorScript, target], {
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    // Verify no .bak residue left by sed -i.bak
    const bakFiles = [];
    function findBak(dir) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findBak(full);
        else if (entry.name.endsWith(".bak")) bakFiles.push(full);
      }
    }
    findBak(target);
    expect(bakFiles, `unexpected .bak files: ${bakFiles.join(", ")}`).toHaveLength(0);
  });
});
