import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "vendor-skills.sh");

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `rks-vendor-${prefix}-`));
}

function write(p, content = "stub") {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

function buildShellRoot(dir) {
  write(path.join(dir, ".claude", "skills", "build", "SKILL.md"), "# Build\nprojectId: routekit-shell");
  write(path.join(dir, ".rks", "prompts", "governor-po.md"), "# PO Governor");
}

function buildTargetProject(dir, projectId) {
  mkdirSync(dir, { recursive: true });
  write(path.join(dir, ".rks", "project.json"), JSON.stringify({ projectId, id: projectId }));
}

function writeRegistry(shellRoot, entries) {
  const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
  write(path.join(shellRoot, "projects", "index.jsonl"), lines);
}

function runScript(shellRoot, args = [], extraEnv = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot, ...extraEnv },
  });
}

describe("vendor-skills.sh registry-driven targets", () => {
  let shellRoot, target1, target2;

  beforeEach(() => {
    shellRoot = tmpDir("shell");
    target1 = tmpDir("target1");
    target2 = tmpDir("target2");
    buildShellRoot(shellRoot);
    buildTargetProject(target1, "project-one");
    buildTargetProject(target2, "project-two");
  });

  afterEach(() => {
    rmSync(shellRoot, { recursive: true, force: true });
    rmSync(target1, { recursive: true, force: true });
    rmSync(target2, { recursive: true, force: true });
  });

  it("with no args reads registry and distributes to all entries whose root exists", () => {
    writeRegistry(shellRoot, [
      { id: "project-one", root: target1 },
      { id: "project-two", root: target2 },
    ]);

    const result = runScript(shellRoot);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(path.join(target1, ".claude", "skills", "build", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(target2, ".claude", "skills", "build", "SKILL.md"))).toBe(true);
  });

  it("skips entries whose root does not exist, warns to stderr, does not exit non-zero", () => {
    const missingPath = path.join(os.tmpdir(), `rks-nonexistent-${Date.now()}`);
    writeRegistry(shellRoot, [
      { id: "project-one", root: target1 },
      { id: "missing", root: missingPath },
    ]);

    const result = runScript(shellRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("WARNING");
    expect(result.stderr).toContain(missingPath);
    // project-one still gets distributed
    expect(existsSync(path.join(target1, ".claude", "skills", "build"))).toBe(true);
  });

  it("exits 0 even when all registry entries resolve to missing paths", () => {
    const missing1 = path.join(os.tmpdir(), `rks-missing1-${Date.now()}`);
    const missing2 = path.join(os.tmpdir(), `rks-missing2-${Date.now()}`);
    writeRegistry(shellRoot, [
      { id: "a", root: missing1 },
      { id: "b", root: missing2 },
    ]);

    const result = runScript(shellRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("WARNING");
  });

  it("with explicit path args uses those paths instead of the registry", () => {
    // Registry has target2, but we pass only target1 explicitly
    writeRegistry(shellRoot, [
      { id: "project-two", root: target2 },
    ]);

    const result = runScript(shellRoot, [target1]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    // target1 got skills (explicitly passed)
    expect(existsSync(path.join(target1, ".claude", "skills", "build"))).toBe(true);
    // target2 did NOT get skills (registry not consulted)
    expect(existsSync(path.join(target2, ".claude", "skills", "build"))).toBe(false);
  });

  it("correctly parses the root field from JSONL entries", () => {
    // Also verify path field as fallback
    writeRegistry(shellRoot, [
      { id: "project-one", path: target1, root: target1 },
    ]);

    const result = runScript(shellRoot);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(path.join(target1, ".claude", "skills", "build", "SKILL.md"))).toBe(true);
  });

  it("substitutes projectId in copied skill files", () => {
    writeRegistry(shellRoot, [
      { id: "project-one", root: target1 },
    ]);

    runScript(shellRoot);

    const skillContent = readFileSync(
      path.join(target1, ".claude", "skills", "build", "SKILL.md"),
      "utf8"
    );
    expect(skillContent).toContain("project-one");
    expect(skillContent).not.toContain("routekit-shell");
  });

  it("also copies governor prompts to each target", () => {
    writeRegistry(shellRoot, [
      { id: "project-one", root: target1 },
    ]);

    const result = runScript(shellRoot);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(path.join(target1, ".rks", "prompts", "governor-po.md"))).toBe(true);
  });

  it("also copies agent prompts alongside governor prompts", () => {
    write(path.join(shellRoot, ".rks", "prompts", "agent-dendron.md"), "# Dendron Agent");
    writeRegistry(shellRoot, [
      { id: "project-one", root: target1 },
    ]);

    const result = runScript(shellRoot);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(path.join(target1, ".rks", "prompts", "governor-po.md"))).toBe(true);
    expect(existsSync(path.join(target1, ".rks", "prompts", "agent-dendron.md"))).toBe(true);
  });
});
