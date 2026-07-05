import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { classifyBoundary, upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";

describe("classifyBoundary", () => {
  it("classifies patch / minor / major / none / downgrade", () => {
    expect(classifyBoundary("0.20.18", "0.20.19")).toBe("patch");
    expect(classifyBoundary("0.20.18", "0.21.0")).toBe("minor");
    expect(classifyBoundary("0.20.18", "1.0.0")).toBe("major");
    expect(classifyBoundary("0.20.18", "0.20.18")).toBe("none");
    expect(classifyBoundary("0.20.19", "0.20.18")).toBe("downgrade");
  });
  it("treats 0.1.0 and absent as UNSTAMPED (not a genuine major)", () => {
    expect(classifyBoundary("0.1.0", "0.20.18")).toBe("unstamped");
    expect(classifyBoundary(null, "0.20.18")).toBe("unstamped");
    expect(classifyBoundary(undefined, "0.20.18")).toBe("unstamped");
  });
  it("returns invalid for an unparseable to-version", () => {
    expect(classifyBoundary("0.20.18", null)).toBe("invalid");
    expect(classifyBoundary("0.20.18", "garbage")).toBe("invalid");
  });
});

describe("upgradeProject — orchestration (injected primitives, no real execution)", () => {
  let projectRoot;
  let shellRoot;
  const created = [];

  function setupChild(fromVersion) {
    projectRoot = mkdtempSync(join(tmpdir(), "rks-child-"));
    shellRoot = mkdtempSync(join(tmpdir(), "rks-shell-"));
    created.push(projectRoot, shellRoot);
    mkdirSync(join(projectRoot, ".rks"), { recursive: true });
    const pj = { id: "calc", kgFile: "routekit/kg.yaml" };
    if (fromVersion !== undefined) pj.rksVersion = fromVersion;
    writeFileSync(join(projectRoot, ".rks", "project.json"), JSON.stringify(pj, null, 2));
    writeFileSync(join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    mkdirSync(join(shellRoot, ".routekit"), { recursive: true });
    writeFileSync(join(shellRoot, ".routekit", "hooks-manifest.json"), JSON.stringify({}));
  }

  function spies(to) {
    return {
      readRksVersion: vi.fn(() => to),
      syncProject: vi.fn(() => ["a", "b"]),
      repinMcpServer: vi.fn(() => ({ ok: true, changed: true })),
      migrateChildSettingsHookPaths: vi.fn(() => true),
      migrateConfig: vi.fn(() => ({ ok: true, applied: ["1→2"], noOp: false })),
      now: () => "TS",
    };
  }

  const childVersion = () => JSON.parse(readFileSync(join(projectRoot, ".rks", "project.json"), "utf8")).rksVersion;

  afterEach(() => {
    for (const d of created.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("PATCH: syncs + repins, does NOT run settings/migrateConfig, advances stamp last", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.boundary).toBe("patch");
    expect(d.syncProject).toHaveBeenCalledOnce();
    expect(d.repinMcpServer).toHaveBeenCalledOnce();
    expect(d.migrateChildSettingsHookPaths).not.toHaveBeenCalled();
    expect(d.migrateConfig).not.toHaveBeenCalled();
    expect(r.stampAdvanced).toBe(true);
    expect(r.restartRequired).toBe(true);
    expect(childVersion()).toBe("0.20.19");
  });

  it("MINOR: also runs settings repair + migrateConfig", () => {
    setupChild("0.20.18");
    const d = spies("0.21.0");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.boundary).toBe("minor");
    expect(d.syncProject).toHaveBeenCalledOnce();
    expect(d.migrateChildSettingsHookPaths).toHaveBeenCalledOnce();
    expect(d.migrateConfig).toHaveBeenCalledOnce();
    expect(r.migrationsApplied).toContain("1→2");
    expect(childVersion()).toBe("0.21.0");
  });

  it("UNSTAMPED (0.1.0): full reconcile (minor-like), stamps current", () => {
    setupChild("0.1.0");
    const d = spies("0.20.19");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.boundary).toBe("unstamped");
    expect(d.migrateChildSettingsHookPaths).toHaveBeenCalledOnce();
    expect(childVersion()).toBe("0.20.19");
  });

  it("MAJOR: gated — no primitives run, no stamp, no mutation", () => {
    setupChild("0.20.18");
    const d = spies("1.0.0");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.boundary).toBe("major");
    expect(r.gated).toBe(true);
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(r.stampAdvanced).toBe(false);
    expect(childVersion()).toBe("0.20.18");
  });

  it("NONE: from === to → no mutation", () => {
    setupChild("0.20.19");
    const d = spies("0.20.19");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.boundary).toBe("none");
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(r.stampAdvanced).toBe(false);
  });

  it("DOWNGRADE: refuses, no mutation", () => {
    setupChild("0.21.0");
    const d = spies("0.20.19");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.boundary).toBe("downgrade");
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(childVersion()).toBe("0.21.0");
  });

  it("--dry-run: mutates nothing, runs no primitives, reports the plan", () => {
    setupChild("0.20.18");
    const d = spies("0.21.0");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot, opts: { dryRun: true } }, d);
    expect(r.dryRun).toBe(true);
    expect(d.syncProject).not.toHaveBeenCalled();
    expect(r.stampAdvanced).toBe(false);
    expect(childVersion()).toBe("0.20.18");
    expect(r.reconciled.length).toBeGreaterThan(0);
  });

  it("stamp advanced LAST — a primitive throw leaves the stamp unadvanced (re-runnable)", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    d.syncProject = vi.fn(() => {
      throw new Error("boom");
    });
    expect(() => upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d)).toThrow(/boom/);
    expect(childVersion()).toBe("0.20.18");
  });

  it("backs up the mixed footprint by default", () => {
    setupChild("0.20.18");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies("0.20.19"));
    expect(r.backupPath).toBeTruthy();
    expect(existsSync(join(r.backupPath, ".mcp.json"))).toBe(true);
    expect(existsSync(join(r.backupPath, ".rks", "project.json"))).toBe(true);
  });

  it("--no-backup skips the backup", () => {
    setupChild("0.20.18");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot, opts: { noBackup: true } }, spies("0.20.19"));
    expect(r.backupPath).toBeNull();
  });

  it("returns the full structured report shape", () => {
    setupChild("0.20.18");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies("0.20.19"));
    for (const k of [
      "ok", "projectId", "from", "to", "boundary", "gated", "dryRun", "backupPath",
      "reconciled", "migrationsApplied", "preserved", "stampAdvanced", "restartRequired", "warnings",
    ]) {
      expect(r).toHaveProperty(k);
    }
    expect(r.preserved).toContain("CLAUDE.md");
  });

  it("never overwrites user-owned files (CLAUDE.md untouched)", () => {
    setupChild("0.20.18");
    writeFileSync(join(projectRoot, "CLAUDE.md"), "MY CUSTOM CLAUDE\n");
    upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies("0.20.19"));
    expect(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8")).toBe("MY CUSTOM CLAUDE\n");
  });
});
