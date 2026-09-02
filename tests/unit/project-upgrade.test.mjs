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
      ensureHookRegistration: vi.fn(() => ({ changed: true, reason: "registered" })),
      migrateConfig: vi.fn(() => ({ ok: true, applied: ["1→2"], noOp: false })),
      now: () => "TS",
    };
  }

  // backlog.fix.child-hook-registration-repair-and-audit — the new reconciled entry must be
  // matched on its own literal. upgrade.mjs already pushes TWO other strings mentioning
  // .claude/settings.json ("repair .claude/settings.json hook paths" on the isMinorPlus
  // dry-run preview, and ".claude/settings.json (hook paths)" from the path migration), so a
  // bare toContain('.claude/settings.json') proves nothing about this writer.
  const HOOK_REGISTRATION_ENTRY = ".claude/settings.json (hook registration)";

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
    // Crash-safety composition witness: upgrade tells sync NOT to early-stamp
    // (refreshStamp:false) so the ONLY stamp mutation is the stamp-LAST advance below.
    expect(d.syncProject).toHaveBeenCalledWith(expect.objectContaining({ refreshStamp: false }));
    expect(d.repinMcpServer).toHaveBeenCalledOnce();
    expect(d.migrateChildSettingsHookPaths).not.toHaveBeenCalled();
    expect(d.migrateConfig).not.toHaveBeenCalled();
    expect(r.stampAdvanced).toBe(true);
    expect(r.restartRequired).toBe(true);
    // The stamp IS advanced to `to` — and because the mocked syncProject never writes
    // project.json, this proves the real stamp-LAST advanceStamp ran (not an early sync stamp).
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

  // ────────────────────────────────────────────────────────────────────────────────
  // backlog.fix.child-hook-registration-repair-and-audit — hook REGISTRATION repair
  // ────────────────────────────────────────────────────────────────────────────────
  //
  // A missing hooks block is a correctness defect, not a version-gated migration: a child
  // on a patch jump is exactly as ungoverned as one on a minor jump. So unlike the
  // path-migration above, this runs on EVERY reconciling boundary — patch included.

  it("PATCH invokes ensureHookRegistration (the new behavior — a patch child is just as ungoverned)", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(d.ensureHookRegistration).toHaveBeenCalledOnce();
    expect(d.ensureHookRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ settingsPath: join(projectRoot, ".claude", "settings.json") }),
    );
  });

  it("MINOR and UNSTAMPED invoke ensureHookRegistration too", () => {
    for (const from of ["0.20.18", "0.1.0"]) {
      setupChild(from);
      const d = spies(from === "0.1.0" ? "0.20.19" : "0.21.0");
      upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
      expect(d.ensureHookRegistration, `boundary from ${from}`).toHaveBeenCalledOnce();
    }
  });

  it("NEGATIVE: not invoked on none, downgrade, gated major, or --dry-run", () => {
    const cases = [
      ["none", "0.20.19", "0.20.19", {}],
      ["downgrade", "0.21.0", "0.20.19", {}],
      ["major (gated)", "0.20.19", "1.0.0", {}],
      ["dry-run", "0.20.18", "0.21.0", { dryRun: true }],
    ];
    const wrong = [];
    for (const [label, from, to, opts] of cases) {
      setupChild(from);
      const d = spies(to);
      upgradeProject({ projectRoot, projectId: "calc", shellRoot, opts }, d);
      if (d.ensureHookRegistration.mock.calls.length !== 0) wrong.push(label);
    }
    expect(wrong).toEqual([]);
  });

  it("ORDERING: runs AFTER backupFootprint and BEFORE advanceStamp", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    let backupWrittenAtCallTime = null;
    let stampAtCallTime = null;
    d.ensureHookRegistration = vi.fn(() => {
      // The backup of the MIXED footprint must already be on disk — the settings file
      // holds user content, so a repair that precedes its backup is unrecoverable.
      backupWrittenAtCallTime = existsSync(
        join(projectRoot, ".rks", ".upgrade-backup", "0.20.18-to-0.20.19-TS", ".claude", "settings.json"),
      );
      // And the stamp must NOT have advanced yet — stamp-last is what makes a crash here
      // leave the child at `from`, re-runnable.
      stampAtCallTime = childVersion();
      return { changed: true, reason: "registered" };
    });

    upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(d.ensureHookRegistration).toHaveBeenCalledOnce();
    expect(backupWrittenAtCallTime).toBe(true);
    expect(stampAtCallTime).toBe("0.20.18");
    expect(childVersion()).toBe("0.20.19");
  });

  it("REPORT: reconciled gains the hook-registration entry only when changed:true", () => {
    setupChild("0.20.18");
    const changed = spies("0.20.19");
    const rChanged = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, changed);
    expect(rChanged.reconciled).toContain(HOOK_REGISTRATION_ENTRY);

    setupChild("0.20.18");
    const unchanged = spies("0.20.19");
    unchanged.ensureHookRegistration = vi.fn(() => ({ changed: false, reason: "unchanged" }));
    const rUnchanged = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, unchanged);
    expect(rUnchanged.reconciled).not.toContain(HOOK_REGISTRATION_ENTRY);
  });

  it("REPORT: on a MINOR dry-run the pre-existing hook-PATHS literal is present and the registration literal is NOT", () => {
    // The disambiguation this entry exists for: :174 pushes "repair .claude/settings.json
    // hook paths" on the isMinorPlus dry-run preview regardless of any writer's result.
    setupChild("0.20.18");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot, opts: { dryRun: true } }, spies("0.21.0"));
    expect(r.reconciled).toContain("repair .claude/settings.json hook paths");
    expect(r.reconciled).not.toContain(HOOK_REGISTRATION_ENTRY);
  });

  it("an unparseable settings.json is REFUSED and warned about, not reported as reconciled", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    d.ensureHookRegistration = vi.fn(() => ({ changed: false, reason: "unparseable" }));
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.reconciled).not.toContain(HOOK_REGISTRATION_ENTRY);
    expect(r.warnings.join("\n")).toMatch(/unparseable/);
    expect(r.stampAdvanced).toBe(true); // a refusal is reported, not fatal
  });

  it("a throwing registration writer is warned about and does NOT block the stamp", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    d.ensureHookRegistration = vi.fn(() => { throw new Error("disk on fire"); });
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.warnings.join("\n")).toMatch(/disk on fire/);
    expect(childVersion()).toBe("0.20.19");
  });

// ── backlog.feat.project-adopt-verb ──────────────────────────────────────────────────────────
// `Already at 0.20.34 — nothing to do.` was CORRECT and unactionable: it named the version but never
// the shell it had compared against, and the shell it resolved was a stale clone on the operator's
// PATH that they did not know was there. shellRoot is carried at report construction so every
// terminating path surfaces it without each one having to remember.

describe("upgradeProject — the report names the shell it resolved", () => {
  const boundaries = [
    ["none", "0.20.19", "0.20.19"],
    ["downgrade", "0.20.19", "0.20.18"],
    ["invalid", "not-a-version", "0.20.19"],
    ["major", "0.20.19", "1.0.0"],
    ["patch", "0.20.18", "0.20.19"],
    ["minor", "0.20.18", "0.21.0"],
  ];

  it.each(boundaries)("carries shellRoot on boundary %s", (_label, from, to) => {
    setupChild(from);
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies(to));
    expect(r.shellRoot).toBe(shellRoot);
  });

  it("carries shellRoot on the unstamped boundary", () => {
    setupChild(null);
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies("0.20.19"));
    expect(r.shellRoot).toBe(shellRoot);
  });

  it("the no-op warning names the shell ROOT PATH, not only the version", () => {
    setupChild("0.20.19");
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies("0.20.19"));
    const joined = r.warnings.join("\n");
    // A message matching only /Already at .* nothing to do/ is exactly the failure being fixed.
    expect(joined).toContain(shellRoot);
    expect(joined).toMatch(/Already at 0\.20\.19/);
  });

  it("downgrade, invalid and major-gated warnings all name the shell root path", () => {
    const cases = [
      ["0.20.19", "0.20.18"], // downgrade
      ["not-a-version", "0.20.19"], // invalid
      ["0.20.19", "1.0.0"], // major (gated)
    ];
    const missing = cases.filter(([from, to]) => {
      setupChild(from);
      const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies(to));
      return !r.warnings.join("\n").includes(shellRoot);
    });
    expect(missing).toEqual([]);
  });

  // NEGATIVE CONTROL: this story adds shellRoot. It must not move restartRequired.
  it("restartRequired semantics are unchanged", () => {
    const mutating = [["0.20.18", "0.20.19"], ["0.20.18", "0.21.0"]];
    const nonMutating = [["0.20.19", "0.20.19"], ["0.20.19", "0.20.18"], ["not-a-version", "0.20.19"], ["0.20.19", "1.0.0"]];

    const wrong = [];
    for (const [from, to] of mutating) {
      setupChild(from);
      if (upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies(to)).restartRequired !== true) {
        wrong.push(`${from}->${to} should require restart`);
      }
    }
    for (const [from, to] of nonMutating) {
      setupChild(from);
      if (upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies(to)).restartRequired) {
        wrong.push(`${from}->${to} should NOT require restart`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
});
