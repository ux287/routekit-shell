import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
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

// The shell release version stamped into a synced child's .rks/project.json.
const SHELL_VERSION = "0.99.0";

// Build a minimal shellRoot with hooks, prompts, and skills
function buildShellRoot(dir, { projectId = "routekit-shell" } = {}) {
  // package.json — the source of the rks release version (readRksVersion(shellRoot))
  write(path.join(dir, "package.json"), JSON.stringify({ name: "routekit-shell", version: SHELL_VERSION }));
  // hooks in generic template
  write(path.join(dir, "templates", "generic", ".routekit", "hooks", "write", "enforce-plan-scope.mjs"), "// enforce-plan-scope");
  write(path.join(dir, "templates", "generic", ".routekit", "hooks", "read", "monitor-context.mjs"), "// monitor-context");
  // governor prompts
  write(path.join(dir, ".rks", "prompts", "governor-po.md"), "# PO Governor\nprojectId: routekit-shell");
  write(path.join(dir, ".rks", "prompts", "governor-qa.md"), "# QA Governor\nprojectId: routekit-shell");
  write(path.join(dir, ".rks", "prompts", "not-a-governor.md"), "other prompt");
  // skills — build (included) and promote (excluded)
  // A COMPLETE TWO-TOKEN LAUNCH DIRECTIVE: __RKS_SOURCE_PROJECT__ is the SUBSTITUTED sentinel,
  // __PROJECT_ID__ the SURVIVING placeholder the child's Governor prompt resolves later.
  write(
    path.join(dir, ".claude", "skills", "build", "SKILL.md"),
    "# Build\nYou are a Build Governor for projectId __RKS_SOURCE_PROJECT__. Read your prompt at\n" +
      ".rks/prompts/governor-build.md. Replace __PROJECT_ID__ with __RKS_SOURCE_PROJECT__\n",
  );
  write(
    path.join(dir, ".claude", "skills", "promote", "SKILL.md"),
    "# Promote\nprojectId: __RKS_SOURCE_PROJECT__",
  );
  // agent definitions — flat .md; the governor subagent def (no projectId substitution)
  write(path.join(dir, ".claude", "agents", "governor.md"), "---\nname: governor\n---\nGovernor for projectId __RKS_SOURCE_PROJECT__");
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
    expect(content).toContain("my-app"); // target id present, verbatim
    expect(content).not.toContain("__RKS_SOURCE_PROJECT__"); // no surviving sentinel
    expect(content).toContain("__PROJECT_ID__"); // placeholder SURVIVES — two distinct tokens
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
    expect(content).toContain("__RKS_SOURCE_PROJECT__"); // sentinel survives — agents are not substituted
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

  it("does not touch notes/ or routekit/kg.yaml, and refreshes .rks/project.json rksVersion PRESERVING siblings", () => {
    const notesFile = path.join(projectRoot, "notes", "welcome.md");
    const projectJson = path.join(projectRoot, ".rks", "project.json");
    const kgYaml = path.join(projectRoot, "routekit", "kg.yaml");
    write(notesFile, "MY NOTES");
    write(projectJson, JSON.stringify({ id: "my-app", offRail: { enabled: true }, fetchRaw: { allowedHosts: ["x.com"] }, rksVersion: "0.20.21" }));
    write(kgYaml, "kg: content");

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    // notes/ and kg.yaml are still never touched by sync.
    expect(readFileSync(notesFile, "utf8")).toBe("MY NOTES");
    expect(readFileSync(kgYaml, "utf8")).toBe("kg: content");
    // project.json: rksVersion refreshed to the shell version, ALL siblings preserved.
    const pj = JSON.parse(readFileSync(projectJson, "utf8"));
    expect(pj.rksVersion).toBe(SHELL_VERSION);
    expect(pj.id).toBe("my-app");
    expect(pj.offRail).toEqual({ enabled: true });
    expect(pj.fetchRaw).toEqual({ allowedHosts: ["x.com"] });
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

  // backlog.fix.child-hook-registration-repair-and-audit — NEGATIVE CONTROL.
  // The hook-registration repair deliberately went into bootstrap/upgrade/doctor and NOT
  // here. syncProject's contract is distributing rks-OWNED regenerable files;
  // .claude/settings.json is MIXED (user content lives in it), sync has no backup step,
  // and it is called from three places — so a settings write here would mutate user
  // content unbacked and double-write on the upgrade path. That non-change is worth
  // pinning: if this test ever goes red, someone moved the repair into the wrong layer.
  it("still neither reads nor writes .claude/settings.json (the repair does NOT live here)", () => {
    const settingsPath = path.join(projectRoot, ".claude", "settings.json");
    write(settingsPath, JSON.stringify({ mcpServers: { rks: { command: "node", args: [] } } }, null, 2));
    const before = readFileSync(settingsPath, "utf8");

    syncProject({ projectRoot, projectId: "my-app", shellRoot });

    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    // Not even a backup sibling — sync did not touch the file at all.
    const siblings = readdirSync(path.dirname(settingsPath)).filter((f) => f.includes("settings.json.bak."));
    expect(siblings).toEqual([]);
  });

  // THE INVERSE of the removed exemption. sync.mjs once skipped substitution when
  // projectId === "routekit-shell". That exemption is DELETED: "routekit-shell" is the PUBLIC
  // MIRROR — a real, registered project — and exempting it shipped it an unsubstituted sentinel.
  // The sentinel is not a projectId, so no target can ever equal it and no exemption can exist.
  it("DOES substitute for a target whose id is literally routekit-shell (the public mirror)", () => {
    syncProject({ projectRoot, projectId: "routekit-shell", shellRoot });
    const content = readFileSync(
      path.join(projectRoot, ".claude", "skills", "build", "SKILL.md"),
      "utf8"
    );
    expect(content).toContain("for projectId routekit-shell."); // target id present, verbatim
    expect(content).not.toContain("__RKS_SOURCE_PROJECT__"); // no surviving sentinel
    expect(content).toContain("__PROJECT_ID__"); // placeholder SURVIVES
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

describe("syncProject() — rksVersion stamp refresh", () => {
  let shellRoot, projectRoot;
  beforeEach(() => {
    shellRoot = tmpDir("shell");
    projectRoot = tmpDir("proj");
    buildShellRoot(shellRoot); // writes package.json version = SHELL_VERSION
  });
  afterEach(() => {
    rmSync(shellRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const childJson = () => path.join(projectRoot, ".rks", "project.json");
  const readChild = () => JSON.parse(readFileSync(childJson(), "utf8"));

  it("default (refreshStamp:true) advances a STALE child stamp to the shell version", () => {
    write(childJson(), JSON.stringify({ id: "my-app", rksVersion: "0.20.21" }));
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    expect(readChild().rksVersion).toBe(SHELL_VERSION);
  });

  it("uses the AUTHORITATIVE shell version (readRksVersion), not a hardcoded literal", () => {
    write(path.join(shellRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
    write(childJson(), JSON.stringify({ id: "my-app", rksVersion: "0.0.1" }));
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    expect(readChild().rksVersion).toBe("1.2.3");
  });

  it("refreshStamp:false leaves the stale stamp UNCHANGED (the upgrade crash-safety path)", () => {
    write(childJson(), JSON.stringify({ id: "my-app", rksVersion: "0.20.21" }));
    syncProject({ projectRoot, projectId: "my-app", shellRoot, refreshStamp: false });
    expect(readChild().rksVersion).toBe("0.20.21");
  });

  it("is idempotent: an already-current child is left byte-identical (no spurious rewrite)", () => {
    write(childJson(), JSON.stringify({ id: "my-app", rksVersion: SHELL_VERSION }));
    const before = readFileSync(childJson(), "utf8");
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    expect(readFileSync(childJson(), "utf8")).toBe(before);
  });

  it("preserves ALL sibling config on refresh (id/offRail/fetchRaw/skillDefaults)", () => {
    write(childJson(), JSON.stringify({ id: "my-app", offRail: { enabled: true, roots: ["src/*"] }, fetchRaw: { mode: "open" }, skillDefaults: { build: "heartbeat" }, rksVersion: "0.20.21" }));
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    const pj = readChild();
    expect(pj.rksVersion).toBe(SHELL_VERSION);
    expect(pj.id).toBe("my-app");
    expect(pj.offRail).toEqual({ enabled: true, roots: ["src/*"] });
    expect(pj.fetchRaw).toEqual({ mode: "open" });
    expect(pj.skillDefaults).toEqual({ build: "heartbeat" });
  });

  it("adds rksVersion when the child project.json has none (no-field edge)", () => {
    write(childJson(), JSON.stringify({ id: "my-app" }));
    syncProject({ projectRoot, projectId: "my-app", shellRoot });
    const pj = readChild();
    expect(pj.rksVersion).toBe(SHELL_VERSION);
    expect(pj.id).toBe("my-app");
  });

  it("null shell version (shell package.json missing) skips refresh — no crash, child untouched", () => {
    rmSync(path.join(shellRoot, "package.json"), { force: true });
    write(childJson(), JSON.stringify({ id: "my-app", rksVersion: "0.20.21" }));
    const before = readFileSync(childJson(), "utf8");
    expect(() => syncProject({ projectRoot, projectId: "my-app", shellRoot })).not.toThrow();
    expect(readFileSync(childJson(), "utf8")).toBe(before);
  });

  it("malformed child project.json is repaired (no crash) on refresh", () => {
    write(childJson(), "{ not valid json");
    expect(() => syncProject({ projectRoot, projectId: "my-app", shellRoot })).not.toThrow();
    expect(readChild().rksVersion).toBe(SHELL_VERSION);
  });
});
