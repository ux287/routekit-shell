import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, ensureDir, writeFile } from "./helpers/tmp.mjs";

function copyDirRecursive(srcDir, destDir) {
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function assertBootstrapOutputs(projectRoot) {
  expect(fs.existsSync(path.join(projectRoot, "routekit", "project.json"))).toBe(true);
  expect(fs.existsSync(path.join(projectRoot, "routekit", "registry.json"))).toBe(true);
  expect(fs.existsSync(path.join(projectRoot, "routekit", "kg.yaml"))).toBe(true);
  expect(fs.existsSync(path.join(projectRoot, "notes"))).toBe(true);
  expect(fs.existsSync(path.join(projectRoot, "dendron.yml"))).toBe(true);
  // .vscode/mcp.json intentionally NOT created — conflicts with .mcp.json
  expect(fs.existsSync(path.join(projectRoot, ".vscode", "mcp.json"))).toBe(false);
  expect(fs.existsSync(path.join(projectRoot, ".rks", "rag", "config.json"))).toBe(true);

  // Verify needsOnboarding flag is written
  const statePath = path.join(projectRoot, ".routekit", "state.json");
  expect(fs.existsSync(statePath)).toBe(true);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  expect(state.needsOnboarding).toBe(true);

  // .mcp.json exists with correct structure
  const mcpJsonPath = path.join(projectRoot, ".mcp.json");
  expect(fs.existsSync(mcpJsonPath)).toBe(true);
  const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
  expect(mcpJson.mcpServers).toBeDefined();
  expect(mcpJson.mcpServers.rks).toBeDefined();
  expect(mcpJson.mcpServers.rks.command).toBe("node");
  expect(mcpJson.mcpServers.rks.args[0]).toContain("bin/mcp-rks.mjs");
  expect(mcpJson.mcpServers.rks.env.ROUTEKIT_PROJECT_ID).toBeDefined();

  // .claude/settings.json has permissions only — no mcpServers
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  expect(fs.existsSync(settingsPath)).toBe(true);
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  expect(settings.mcpServers).toBeUndefined();
  expect(settings.permissions).toBeDefined();
  expect(settings.permissions.allow).toBeInstanceOf(Array);
  expect(settings.permissions.allow.length).toBeGreaterThan(3);

  // .routekit/hooks/ exists and has hook files (nested in write/, read/, system/ subdirs)
  const hooksDir = path.join(projectRoot, ".routekit", "hooks");
  expect(fs.existsSync(hooksDir)).toBe(true);
  const hookFiles = [];
  for (const tier of ["write", "read", "system"]) {
    const tierDir = path.join(hooksDir, tier);
    if (fs.existsSync(tierDir)) {
      hookFiles.push(...fs.readdirSync(tierDir).filter(f => f.endsWith(".mjs")));
    }
  }
  expect(hookFiles.length).toBeGreaterThanOrEqual(20);
  expect(hookFiles).toContain("enforce-plan-scope.mjs");
  expect(hookFiles).toContain("enforce-branch-workflow.mjs");
  expect(hookFiles).toContain("enforce-git-workflow.mjs");
  expect(hookFiles).toContain("enforce-dendron-note-creation.mjs");

  // Governor prompts exist — required for Governors to bootstrap
  expect(fs.existsSync(path.join(projectRoot, ".rks", "prompts", "governor-po.md"))).toBe(true);

  // Skills exist — required for Governors to bootstrap
  expect(fs.existsSync(path.join(projectRoot, ".claude", "skills", "build"))).toBe(true);

  // vitest runner scripts exist — required for rks exec test runs
  expect(fs.existsSync(path.join(projectRoot, "scripts", "vitest-runner.mjs"))).toBe(true);
  expect(fs.existsSync(path.join(projectRoot, "scripts", "lib", "spawn-managed.mjs"))).toBe(true);

  // vitest.config.unit.mjs shim exists — hardcoded by command-runner.mjs
  expect(fs.existsSync(path.join(projectRoot, "vitest.config.unit.mjs"))).toBe(true);
  const shimContent = fs.readFileSync(path.join(projectRoot, "vitest.config.unit.mjs"), "utf8");
  // The shim re-exports the provisioned base config, and that base config is
  // distributed alongside it, so the child's config chain resolves out of the
  // box (UAT-blocker fix — see notes/research.2026.06.28.uat-findings.md Finding 1).
  expect(shimContent).toContain("vitest.config.base.mjs");
  expect(fs.existsSync(path.join(projectRoot, "vitest.config.base.mjs"))).toBe(true);
}

describe("project init/attach bootstrap convergence", () => {
  // SKIPPED 2026-06-08: subprocess takes 60-137s and returns null status under
  // CI load. Follow-up: backlog.fix.slow-subprocess-test-pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("creates the same core bootstrap outputs for init and attach", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");

    const shellRoot = makeTempDir("shellroot_bootstrap");
    const templateId = "app.web.react.spa";
    copyDirRecursive(path.join(repoRoot, "templates", templateId), path.join(shellRoot, "templates", templateId));
    // Copy generic template for hooks seeding
    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    // Copy governor prompts and skills so attachProject can distribute them
    copyDirRecursive(path.join(repoRoot, ".rks", "prompts"), path.join(shellRoot, ".rks", "prompts"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));
    // Copy vitest runner scripts so ensureVitestRunner can distribute them
    ensureDir(path.join(shellRoot, "scripts", "lib"));
    fs.copyFileSync(
      path.join(repoRoot, "scripts", "vitest-runner.mjs"),
      path.join(shellRoot, "scripts", "vitest-runner.mjs")
    );
    fs.copyFileSync(
      path.join(repoRoot, "scripts", "lib", "spawn-managed.mjs"),
      path.join(shellRoot, "scripts", "lib", "spawn-managed.mjs")
    );
    // Copy vitest.config.unit.mjs shim template so ensureVitestRunner can distribute it
    ensureDir(path.join(shellRoot, "templates", "base"));
    fs.copyFileSync(
      path.join(repoRoot, "templates", "base", "vitest.config.unit.mjs"),
      path.join(shellRoot, "templates", "base", "vitest.config.unit.mjs")
    );

    const initRoot = makeTempDir("bootstrap_init_project");
    const initResult = spawnSync(
      process.execPath,
      [cliPath, "project", "init", "--id", "demo-init", "--stack", templateId, "--path", initRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(initResult.status, initResult.stderr || initResult.stdout).toBe(0);
    assertBootstrapOutputs(initRoot);

    const attachRoot = makeTempDir("bootstrap_attach_project");
    writeFile(path.join(attachRoot, "package.json"), JSON.stringify({ name: "demo-attach", private: true }, null, 2));
    const attachResult = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "demo-attach", "--path", attachRoot, "--stack", templateId],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(attachResult.status, attachResult.stderr || attachResult.stdout).toBe(0);
    assertBootstrapOutputs(attachRoot);

    const globalRegistry = path.join(shellRoot, "projects", "index.jsonl");
    expect(fs.existsSync(globalRegistry)).toBe(true);
    const lines = fs.readFileSync(globalRegistry, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  // SKIPPED 2026-06-08: same slow-subprocess pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("uses simplified Dendron namespace (no project-slug prefix)", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");

    const shellRoot = makeTempDir("shellroot_namespace");
    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    copyDirRecursive(path.join(repoRoot, ".rks", "prompts"), path.join(shellRoot, ".rks", "prompts"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));

    const projectRoot = makeTempDir("namespace_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "my-app", private: true }, null, 2));

    const result = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "my-app", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot, ROUTEKIT_SKIP_GLOBAL_CONFIG: "true" } }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const notesDir = path.join(projectRoot, "notes");
    const noteFiles = fs.readdirSync(notesDir);

    // Welcome note should be welcome.md, NOT my-app.welcome.md
    expect(noteFiles).toContain("welcome.md");
    expect(noteFiles).not.toContain("my-app.welcome.md");
  });

  // SKIPPED 2026-06-05: subprocess takes ~86s and returns null exit code under
  // load. Pre-existing flake; not introduced today. Follow-up: slow-subprocess-tests stub.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("re-running attach overwrites existing governor prompts (not skipped)", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");
    const shellRoot = makeTempDir("shellroot_overwrite");
    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    copyDirRecursive(path.join(repoRoot, ".rks", "prompts"), path.join(shellRoot, ".rks", "prompts"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));

    const projectRoot = makeTempDir("overwrite_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "overwrite-test", private: true }, null, 2));

    const first = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "overwrite-test", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(first.status, first.stderr || first.stdout).toBe(0);

    const promptPath = path.join(projectRoot, ".rks", "prompts", "governor-po.md");
    expect(fs.existsSync(promptPath)).toBe(true);
    fs.writeFileSync(promptPath, "STALE CONTENT");

    const second = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "overwrite-test", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(second.status, second.stderr || second.stdout).toBe(0);

    const content = fs.readFileSync(promptPath, "utf8");
    expect(content).not.toBe("STALE CONTENT");
  });

  // SKIPPED 2026-06-08: same slow-subprocess pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("re-running attach does NOT overwrite existing vitest.config.unit.mjs (no-overwrite policy)", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");
    const shellRoot = makeTempDir("shellroot_shim_nooverwrite");
    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    copyDirRecursive(path.join(repoRoot, ".rks", "prompts"), path.join(shellRoot, ".rks", "prompts"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));
    ensureDir(path.join(shellRoot, "templates", "base"));
    fs.copyFileSync(
      path.join(repoRoot, "templates", "base", "vitest.config.unit.mjs"),
      path.join(shellRoot, "templates", "base", "vitest.config.unit.mjs")
    );

    const projectRoot = makeTempDir("shim_nooverwrite_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "shim-nooverwrite", private: true }, null, 2));

    // Pre-seed a customized vitest.config.unit.mjs
    const shimPath = path.join(projectRoot, "vitest.config.unit.mjs");
    fs.writeFileSync(shimPath, "// CUSTOM CONFIG\nexport default {};\n");

    const result = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "shim-nooverwrite", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const content = fs.readFileSync(shimPath, "utf8");
    expect(content).toBe("// CUSTOM CONFIG\nexport default {};\n");
  });

  // SKIPPED 2026-06-08: same slow-subprocess pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("substitutes projectId in copied skill files", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");
    const shellRoot = makeTempDir("shellroot_subst");
    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    copyDirRecursive(path.join(repoRoot, ".rks", "prompts"), path.join(shellRoot, ".rks", "prompts"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));

    const projectRoot = makeTempDir("subst_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "my-child-app", private: true }, null, 2));

    const result = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "my-child-app", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const buildSkillDir = path.join(projectRoot, ".claude", "skills", "build");
    expect(fs.existsSync(buildSkillDir)).toBe(true);
    const mdFiles = fs.readdirSync(buildSkillDir).filter(f => f.endsWith(".md"));
    expect(mdFiles.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(buildSkillDir, mdFiles[0]), "utf8");
    expect(content).not.toContain("routekit-shell");
    expect(content).toContain("my-child-app");
  });

  // SKIPPED 2026-06-08: same slow-subprocess pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("copies agent-*.md prompts alongside governor-*.md prompts", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");
    const shellRoot = makeTempDir("shellroot_agent_prompts");

    const srcPrompts = path.join(shellRoot, ".rks", "prompts");
    fs.mkdirSync(srcPrompts, { recursive: true });
    fs.writeFileSync(path.join(srcPrompts, "governor-build.md"), "# Governor Build\nYou are the Build Governor.");
    fs.writeFileSync(path.join(srcPrompts, "agent-dendron.md"), "# Dendron Agent\nYou are the Dendron Agent.");

    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));

    const projectRoot = makeTempDir("agent_prompts_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "agent-prompt-test", private: true }, null, 2));

    const result = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "agent-prompt-test", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);

    expect(fs.existsSync(path.join(projectRoot, ".rks", "prompts", "governor-build.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".rks", "prompts", "agent-dendron.md"))).toBe(true);
    const agentContent = fs.readFileSync(path.join(projectRoot, ".rks", "prompts", "agent-dendron.md"), "utf8");
    expect(agentContent).toContain("You are the Dendron Agent.");
  });

  // SKIPPED 2026-06-08: same slow-subprocess pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("graceful no-op when shellRoot has no .rks/prompts directory", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");
    const shellRoot = makeTempDir("shellroot_no_prompts");

    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));
    copyDirRecursive(path.join(repoRoot, ".claude", "skills"), path.join(shellRoot, ".claude", "skills"));

    const projectRoot = makeTempDir("no_prompts_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "no-prompts-test", private: true }, null, 2));

    const result = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "no-prompts-test", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  // SKIPPED 2026-06-08: same slow-subprocess pattern.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("graceful no-op when shellRoot has no .claude/skills directory", () => {
    const repoRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const cliPath = path.join(repoRoot, "packages", "cli", "bin", "routekit.js");
    const shellRoot = makeTempDir("shellroot_no_skills");

    const srcPrompts = path.join(shellRoot, ".rks", "prompts");
    fs.mkdirSync(srcPrompts, { recursive: true });
    fs.writeFileSync(path.join(srcPrompts, "governor-build.md"), "# Governor Build");
    copyDirRecursive(path.join(repoRoot, "templates", "generic"), path.join(shellRoot, "templates", "generic"));

    const projectRoot = makeTempDir("no_skills_project");
    writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "no-skills-test", private: true }, null, 2));

    const result = spawnSync(
      process.execPath,
      [cliPath, "project", "attach", "--id", "no-skills-test", "--path", projectRoot],
      { encoding: "utf8", timeout: 60_000, env: { ...process.env, ROUTEKIT_SHELL_ROOT: shellRoot } }
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
