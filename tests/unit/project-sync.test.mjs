import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { syncProject } from "../../packages/cli/src/project/sync.mjs";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

function tmpDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), `rks-sync-${prefix}-`));
}

function write(p, content = "stub") {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

// Build a minimal shellRoot with hooks, prompts, and skills
function buildShellRoot(dir, { projectId = "routekit-shell" } = {}) {
  // hooks in generic template
  write(path.join(dir, "templates", "generic", ".routekit", "hooks", "write", "enforce-plan-scope.mjs"), "// enforce-plan-scope");
  write(path.join(dir, "templates", "generic", ".routekit", "hooks", "read", "monitor-context.mjs"), "// monitor-context");
  // governor prompts
  write(path.join(dir, ".rks", "prompts", "governor-po.md"), "# PO Governor\nprojectId: routekit-shell");
  write(path.join(dir, ".rks", "prompts", "governor-qa.md"), "# QA Governor\nprojectId: routekit-shell");
  write(path.join(dir, ".rks", "prompts", "not-a-governor.md"), "other prompt");
  // skills — build (included) and promote (excluded)
  write(path.join(dir, ".claude", "skills", "build", "SKILL.md"), "# Build\nprojectId: routekit-shell");
  write(path.join(dir, ".claude", "skills", "promote", "SKILL.md"), "# Promote\nprojectId: routekit-shell");
  // agent definitions — flat .md; the governor subagent def (no projectId substitution)
  write(path.join(dir, ".claude", "agents", "governor.md"), "---\nname: governor\n---\nGovernor for projectId routekit-shell");
}

describe("syncProject()", () => {
  let shellRoot, projectRoot;

  beforeEach(() => {
    shellRoot = tmpDir("shell");
    projectRoot = tmpDir("proj");
    buildShellRoot(shellRoot);
  });

  afterEach(() => {
    rmSync(shellRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("copies hooks from generic template with overwrite semantics", () => {
    // Pre-seed stale hook content in project
    const hookPath = path.join(projectRoot, ".routekit", "hooks", "write", "enforce-plan-scope.mjs");
    write(hookPath, "STALE");

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    expect(readFileSync(hookPath, "utf8")).toBe("// enforce-plan-scope");
    expect(existsSync(path.join(projectRoot, ".routekit", "hooks", "read", "monitor-context.mjs"))).toBe(true);
  });

  it("copies governor-*.md prompts with overwrite semantics", () => {
    const poPath = path.join(projectRoot, ".rks", "prompts", "governor-po.md");
    write(poPath, "STALE");

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    const content = readFileSync(poPath, "utf8");
    expect(content).not.toBe("STALE");
    expect(existsSync(path.join(projectRoot, ".rks", "prompts", "governor-qa.md"))).toBe(true);
  });

  it("does NOT copy non-governor prompts", () => {
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    expect(existsSync(path.join(projectRoot, ".rks", "prompts", "not-a-governor.md"))).toBe(false);
  });

  it("copies skills with overwrite semantics and substitutes projectId", () => {
    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    const skillPath = path.join(projectRoot, ".claude", "skills", "build", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, "utf8");
    expect(content).toContain("my-app");
    expect(content).not.toContain("routekit-shell");
  });

  it("excludes the promote skill", () => {
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    expect(existsSync(path.join(projectRoot, ".claude", "skills", "promote"))).toBe(false);
  });

  it("copies agent definitions (.claude/agents/*.md) with overwrite semantics", () => {
    const agentPath = path.join(projectRoot, ".claude", "agents", "governor.md");
    write(agentPath, "STALE AGENT");

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    expect(existsSync(agentPath)).toBe(true);
    const content = readFileSync(agentPath, "utf8");
    expect(content).not.toBe("STALE AGENT");
    expect(content).toContain("name: governor");
  });

  it("does NOT substitute projectId in agent defs (unlike skills — id comes from the task prompt)", () => {
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    const content = readFileSync(path.join(projectRoot, ".claude", "agents", "governor.md"), "utf8");
    expect(content).toContain("routekit-shell");
    expect(content).not.toContain("my-app");
  });

  it("overwrites stale skill content on re-run", () => {
    // First run
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    const skillPath = path.join(projectRoot, ".claude", "skills", "build", "SKILL.md");
    writeFileSync(skillPath, "STALE SKILL");

    // Second run should overwrite
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    const content = readFileSync(skillPath, "utf8");
    expect(content).not.toBe("STALE SKILL");
    expect(content).toContain("my-app");
  });

  it("does not touch notes/, .rks/project.json, or routekit/kg.yaml", () => {
    const notesFile = path.join(projectRoot, "notes", "welcome.md");
    const projectJson = path.join(projectRoot, ".rks", "project.json");
    const kgYaml = path.join(projectRoot, "routekit", "kg.yaml");
    write(notesFile, "MY NOTES");
    write(projectJson, '{"id":"my-app"}');
    write(kgYaml, "kg: content");

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    expect(readFileSync(notesFile, "utf8")).toBe("MY NOTES");
    expect(readFileSync(projectJson, "utf8")).toBe('{"id":"my-app"}');
    expect(readFileSync(kgYaml, "utf8")).toBe("kg: content");
  });

  it("is idempotent: running twice produces identical file contents", () => {
    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    const hookContent1 = readFileSync(
      path.join(projectRoot, ".routekit", "hooks", "write", "enforce-plan-scope.mjs"),
      "utf8"
    );
    const skillContent1 = readFileSync(
      path.join(projectRoot, ".claude", "skills", "build", "SKILL.md"),
      "utf8"
    );

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    expect(readFileSync(
      path.join(projectRoot, ".routekit", "hooks", "write", "enforce-plan-scope.mjs"),
      "utf8"
    )).toBe(hookContent1);
    expect(readFileSync(
      path.join(projectRoot, ".claude", "skills", "build", "SKILL.md"),
      "utf8"
    )).toBe(skillContent1);
  });

  it("returns an array of all files that were copied", () => {
    const updated = syncProject({ projectRoot, projectId: "my-app", shellRoot });

    expect(Array.isArray(updated)).toBe(true);
    expect(updated.length).toBeGreaterThan(0);
    expect(updated).toContain(path.join(".routekit", "hooks", "write", "enforce-plan-scope.mjs"));
    expect(updated).toContain(path.join(".rks", "prompts", "governor-po.md"));
    expect(updated).toContain(path.join(".claude", "skills", "build", "SKILL.md"));
    expect(updated).toContain(path.join(".claude", "agents", "governor.md"));
  });

  it("does not substitute projectId when projectId is routekit-shell", () => {
    syncProject({ projectRoot, projectId: "routekit-shell", shellRoot });
    const content = readFileSync(
      path.join(projectRoot, ".claude", "skills", "build", "SKILL.md"),
      "utf8"
    );
    expect(content).toContain("routekit-shell");
  });
});

describe("handleProjectCommand — sync subcommand", () => {
  let shellRoot, projectRoot;

  beforeEach(() => {
    shellRoot = tmpDir("shell-cli");
    projectRoot = tmpDir("proj-cli");
    buildShellRoot(shellRoot);
  });

  afterEach(() => {
    rmSync(shellRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("dispatches to syncProject and exits 0 on success", async () => {
    const calls = [];
    let exitCode = null;

    await handleProjectCommand(
      { sub: "sync", kv: { id: "my-app", path: projectRoot }, SHELL_ROOT: shellRoot },
      {
        processExit: (code) => { exitCode = code; },
        syncProject: (opts) => { calls.push(opts); return []; },
      }
    );

    expect(calls.length).toBe(1);
    expect(calls[0].projectId).toBe("my-app");
    expect(calls[0].projectRoot).toBe(projectRoot);
    expect(calls[0].shellRoot).toBe(shellRoot);
    expect(exitCode).toBe(0);
  });

  it("exits non-zero when id is missing", async () => {
    let exitCode = null;
    const calls = [];

    await handleProjectCommand(
      { sub: "sync", kv: {}, SHELL_ROOT: shellRoot },
      {
        processExit: (code) => { exitCode = code; },
        syncProject: (opts) => { calls.push(opts); return []; },
      }
    );

    expect(exitCode).not.toBe(0);
    expect(calls.length).toBe(0);
  });

  it("exits non-zero when path does not exist", async () => {
    let exitCode = null;

    await handleProjectCommand(
      { sub: "sync", kv: { id: "my-app", path: "/nonexistent/path/does-not-exist" }, SHELL_ROOT: shellRoot },
      {
        processExit: (code) => { exitCode = code; },
        syncProject: () => [],
      }
    );

    expect(exitCode).not.toBe(0);
  });
});
