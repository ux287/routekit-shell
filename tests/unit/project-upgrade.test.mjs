import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { classifyBoundary, upgradeProject } from "../../packages/cli/src/project/upgrade.mjs";
import { CHILD_RKS_ASK_RULES } from "../../packages/cli/src/project/child-permissions.mjs";

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
      repinMcpServer: vi.fn(() => ({ ok: true, changed: true, argsChanged: true, envRootChanges: [] })),
      migrateChildSettingsHookPaths: vi.fn(() => true),
      ensureHookRegistration: vi.fn(() => ({ changed: true, reason: "registered" })),
      mergeRksPermissionAllow: vi.fn(() => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] })),
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
    expect(r.reconciled).toContain(".mcp.json (repinned)");
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

  // ────────────────────────────────────────────────────────────────────────────────
  // backlog.fix.child-rks-permission-allow-list — rks permission rules merge
  // ────────────────────────────────────────────────────────────────────────────────
  const PERMS_ENTRY = (n) => `.claude/settings.json (rks permissions: +${n})`;

  it("PERMISSIONS: merge called once on PATCH, MINOR and UNSTAMPED with both settings paths", () => {
    for (const [from, to] of [["0.20.18", "0.20.19"], ["0.20.18", "0.21.0"], ["0.1.0", "0.20.19"]]) {
      setupChild(from);
      const d = spies(to);
      upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
      expect(d.mergeRksPermissionAllow, `from ${from}`).toHaveBeenCalledOnce();
      expect(d.mergeRksPermissionAllow).toHaveBeenCalledWith(
        expect.objectContaining({
          settingsPath: join(projectRoot, ".claude", "settings.json"),
          localSettingsPath: join(projectRoot, ".claude", "settings.local.json"),
        }),
      );
    }
  });

  it("PERMISSIONS: NOT called on none, downgrade, gated major or --dry-run", () => {
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
      if (d.mergeRksPermissionAllow.mock.calls.length !== 0) wrong.push(label);
    }
    expect(wrong).toEqual([]);
  });

  it("PERMISSIONS: reconciled gets the +N literal only when changed", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    d.mergeRksPermissionAllow = vi.fn(() => ({
      changed: true,
      reason: "added",
      added: ["mcp__rks__*"],
      addedAsk: ["mcp__rks__rks_release", "mcp__rks__rks_publish"],
    }));
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(r.reconciled).toContain(PERMS_ENTRY(3));

    setupChild("0.20.18");
    const r2 = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, spies("0.20.19"));
    expect(r2.reconciled.filter((e) => e.includes("rks permissions"))).toEqual([]);
  });

  it("PERMISSIONS: unparseable (per file), opted-out and throw are warned about and never block the stamp", () => {
    for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
      setupChild("0.20.18");
      const d = spies("0.20.19");
      d.mergeRksPermissionAllow = vi.fn(() => ({ changed: false, reason: "unparseable", added: [], addedAsk: [], file }));
      const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
      const hit = r.warnings.filter((w) => /rks permission/.test(w) && w.includes(file));
      expect(hit.length, file).toBe(1);
      expect(r.stampAdvanced).toBe(true);
    }

    setupChild("0.20.18");
    const opted = spies("0.20.19");
    opted.mergeRksPermissionAllow = vi.fn(() => ({ changed: false, reason: "opted-out", added: [], addedAsk: [] }));
    expect(upgradeProject({ projectRoot, projectId: "calc", shellRoot }, opted).warnings.join("\n")).toMatch(/opted.out/);

    setupChild("0.20.18");
    const boom = spies("0.20.19");
    boom.mergeRksPermissionAllow = vi.fn(() => { throw new Error("perm writer on fire"); });
    const rb = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, boom);
    expect(rb.warnings.join("\n")).toMatch(/perm writer on fire/);
    expect(rb.stampAdvanced).toBe(true);
  });

  it("PERMISSIONS ORDERING: after backupFootprint, before advanceStamp", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    let backupAtCall = null;
    let stampAtCall = null;
    d.mergeRksPermissionAllow = vi.fn(() => {
      backupAtCall = existsSync(
        join(projectRoot, ".rks", ".upgrade-backup", "0.20.18-to-0.20.19-TS", ".claude", "settings.json"),
      );
      stampAtCall = childVersion();
      return { changed: false, reason: "unchanged", added: [], addedAsk: [] };
    });
    upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    expect(backupAtCall).toBe(true);
    expect(stampAtCall).toBe("0.20.18");
  });

  it("PERMISSIONS real-merge wiring: no spy → the real module writes the rks rules", () => {
    setupChild("0.20.18");
    const d = spies("0.20.19");
    delete d.mergeRksPermissionAllow;
    const r = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d);
    const s = JSON.parse(readFileSync(join(projectRoot, ".claude", "settings.json"), "utf8"));
    expect(s.permissions.allow).toContain("mcp__rks__*");
    for (const t of CHILD_RKS_ASK_RULES) expect(s.permissions.ask).toContain(t);
    expect(r.reconciled).toContain(PERMS_ENTRY(5));

    setupChild("0.20.18");
    const pjPath = join(projectRoot, ".rks", "project.json");
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    writeFileSync(pjPath, JSON.stringify({ ...pj, claudePermissions: { manageAllowList: false } }, null, 2));
    const settingsPath = join(projectRoot, ".claude", "settings.json");
    const before = readFileSync(settingsPath, "utf8");
    const d2 = spies("0.20.19");
    delete d2.mergeRksPermissionAllow;
    const r2 = upgradeProject({ projectRoot, projectId: "calc", shellRoot }, d2);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(r2.warnings.join("\n")).toMatch(/opted.out/);
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

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.upgrade-never-restores-vitest-unit-shim
// ══════════════════════════════════════════════════════════════════════════════════
//
// Exec builds scoped test runs as `scripts/vitest-runner.mjs --config vitest.config.unit.mjs`.
// Only attach used to seed those files; upgrade never restored an absent one. seedVitestFiles is
// the never-overwrite helper upgrade (and doctor) now call. Every fixture here is a real temp dir
// — the helper and the upgrade seeding step run for real; only the other reconcilers are spied.
describe("seedVitestFiles / ensureVitestRunner / upgrade vitest seeding", () => {
  const SHIM = "vitest.config.unit.mjs";
  const BASE = "vitest.config.base.mjs";
  const RUNNER = join("scripts", "vitest-runner.mjs");
  const SPAWN = join("scripts", "lib", "spawn-managed.mjs");
  const ALL = [SHIM, BASE, RUNNER, SPAWN];

  const TPL_SHIM = "// template shim\nexport default {};\n";
  const TPL_BASE = "// template base\nexport default {};\n";
  const SHELL_RUNNER = "// shell runner v2\n";
  const SHELL_SPAWN = "// shell spawn-managed v2\n";

  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  const tmp = (prefix) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
  const put = (root, rel, body) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const read = (root, rel) => readFileSync(join(root, rel), "utf8");

  /** A temp shell. `with` picks which of the four sources exist. */
  function makeShell({ shim = true, base = true, runner = true, spawn = true } = {}) {
    const root = tmp("rks-vshell-");
    mkdirSync(join(root, ".routekit"), { recursive: true });
    writeFileSync(join(root, ".routekit", "hooks-manifest.json"), JSON.stringify({}));
    if (shim) put(root, join("templates", "base", SHIM), TPL_SHIM);
    if (base) put(root, join("templates", "base", BASE), TPL_BASE);
    if (runner) put(root, RUNNER, SHELL_RUNNER);
    if (spawn) put(root, SPAWN, SHELL_SPAWN);
    return root;
  }

  function makeChild(fromVersion = "0.20.18") {
    const root = tmp("rks-vchild-");
    mkdirSync(join(root, ".rks"), { recursive: true });
    writeFileSync(join(root, ".rks", "project.json"), JSON.stringify({ id: "calc", rksVersion: fromVersion }, null, 2));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    return root;
  }

  function spies(to) {
    return {
      readRksVersion: vi.fn(() => to),
      syncProject: vi.fn(() => []),
      repinMcpServer: vi.fn(() => ({ ok: true, changed: false, argsChanged: false, envRootChanges: [] })),
      migrateChildSettingsHookPaths: vi.fn(() => false),
      ensureHookRegistration: vi.fn(() => ({ changed: false })),
      mergeRksPermissionAllow: vi.fn(() => ({ changed: false, reason: "unchanged", added: [], addedAsk: [] })),
      migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true })),
      now: () => "TS",
    };
  }

  const upgrade = (projectRoot, shellRoot, opts = {}) =>
    upgradeProject({ projectRoot, projectId: "calc", shellRoot, opts }, spies("0.20.19"));

  const loadBootstrap = () => import("../../packages/cli/src/project/bootstrap.mjs");

  // ── seedVitestFiles ─────────────────────────────────────────────────────────────

  it("bootstrap.mjs exports seedVitestFiles as a function", async () => {
    const { seedVitestFiles } = await loadBootstrap();
    expect(typeof seedVitestFiles).toBe("function");
  });

  it("seedVitestFiles creates an absent shim byte-identical to templates/base and lists it in created", async () => {
    const { seedVitestFiles } = await loadBootstrap();
    const shell = makeShell();
    const child = makeChild();
    const r = seedVitestFiles({ projectRoot: child, shellRoot: shell });
    expect(read(child, SHIM)).toBe(read(shell, join("templates", "base", SHIM)));
    expect(r.created).toContain(SHIM);
    expect(r.templateMissing).toEqual([]);
  });

  it("seedVitestFiles never overwrites: all four customised child files stay byte-identical, created is empty", async () => {
    const { seedVitestFiles } = await loadBootstrap();
    const shell = makeShell();
    const child = makeChild();
    for (const rel of ALL) put(child, rel, `// CUSTOM ${rel}\n`);
    const r = seedVitestFiles({ projectRoot: child, shellRoot: shell });
    for (const rel of ALL) expect(read(child, rel)).toBe(`// CUSTOM ${rel}\n`);
    expect(r.created).toEqual([]);
    expect(r.templateMissing).toEqual([]);
  });

  it("seedVitestFiles with no templates/base shim writes nothing, omits it from created, lists it in templateMissing", async () => {
    const { seedVitestFiles } = await loadBootstrap();
    const shell = makeShell({ shim: false });
    const child = makeChild();
    const r = seedVitestFiles({ projectRoot: child, shellRoot: shell });
    expect(existsSync(join(child, SHIM))).toBe(false);
    expect(r.created).not.toContain(SHIM);
    expect(r.templateMissing).toEqual([SHIM]);
  });

  it("seedVitestFiles seeds an absent runner and spawn-managed (creating scripts/lib) byte-identical to the shell", async () => {
    const { seedVitestFiles } = await loadBootstrap();
    const shell = makeShell();
    const child = makeChild();
    expect(existsSync(join(child, "scripts"))).toBe(false);
    const r = seedVitestFiles({ projectRoot: child, shellRoot: shell });
    expect(read(child, RUNNER)).toBe(read(shell, RUNNER));
    expect(read(child, SPAWN)).toBe(read(shell, SPAWN));
    expect(r.created).toEqual(expect.arrayContaining([RUNNER, SPAWN]));
  });

  // ── ensureVitestRunner (attach) ─────────────────────────────────────────────────

  it("ensureVitestRunner is exported and still OVERWRITES a stale runner + spawn-managed, but never the shim", async () => {
    const { ensureVitestRunner } = await loadBootstrap();
    expect(typeof ensureVitestRunner).toBe("function");
    const shell = makeShell();
    const child = makeChild();
    put(child, RUNNER, "// stale runner\n");
    put(child, SPAWN, "// stale spawn\n");
    put(child, SHIM, "// CUSTOM shim\n");
    ensureVitestRunner({ projectRoot: child, shellRoot: shell });
    expect(read(child, RUNNER)).toBe(SHELL_RUNNER);
    expect(read(child, SPAWN)).toBe(SHELL_SPAWN);
    expect(read(child, SHIM)).toBe("// CUSTOM shim\n");
  });

  // ── upgradeProject ──────────────────────────────────────────────────────────────

  it("wet PATCH upgrade creates an absent vitest.config.unit.mjs with the template content", () => {
    const shell = makeShell();
    const child = makeChild();
    const r = upgrade(child, shell);
    expect(r.boundary).toBe("patch");
    expect(read(child, SHIM)).toBe(TPL_SHIM);
  });

  it("upgrade leaves a customised vitest.config.unit.mjs byte-identical", () => {
    const shell = makeShell();
    const child = makeChild();
    put(child, SHIM, "// MY SHIM\n");
    upgrade(child, shell);
    expect(read(child, SHIM)).toBe("// MY SHIM\n");
  });

  it("upgrade seeds an absent vitest.config.base.mjs without overwriting an existing shim", () => {
    const shell = makeShell();
    const child = makeChild();
    put(child, SHIM, "// MY SHIM\n");
    upgrade(child, shell);
    expect(read(child, BASE)).toBe(TPL_BASE);
    expect(read(child, SHIM)).toBe("// MY SHIM\n");
  });

  it("wet upgrade leaves a customised runner and spawn-managed byte-identical even when the shell's differ", () => {
    const shell = makeShell();
    const child = makeChild();
    put(child, RUNNER, "// MY runner\n");
    put(child, SPAWN, "// MY spawn\n");
    upgrade(child, shell);
    expect(read(child, RUNNER)).toBe("// MY runner\n");
    expect(read(child, SPAWN)).toBe("// MY spawn\n");
  });

  it("reconciled has one entry per CREATED file, and none when all four were already present", () => {
    const shell = makeShell();
    const child = makeChild();
    put(child, BASE, "// MY base\n");
    const r = upgrade(child, shell);
    const vitestEntries = (rec) => rec.filter((e) => ALL.some((rel) => e.includes(rel)));
    const v1 = vitestEntries(r.reconciled);
    expect(v1).toHaveLength(3);
    for (const rel of [SHIM, RUNNER, SPAWN]) expect(v1.filter((e) => e.startsWith(`${rel} `))).toHaveLength(1);
    expect(v1.some((e) => e.includes(BASE))).toBe(false);

    const full = makeChild();
    for (const rel of ALL) put(full, rel, `// CUSTOM ${rel}\n`);
    const r2 = upgrade(full, shell);
    expect(vitestEntries(r2.reconciled)).toEqual([]);
  });

  it("a missing shim template is a warning naming the file, with no reconciled entry and no shim written", () => {
    const shell = makeShell({ shim: false });
    const child = makeChild();
    const r = upgrade(child, shell);
    expect(r.warnings.some((w) => w.includes(SHIM) && /template missing/.test(w))).toBe(true);
    expect(r.reconciled.some((e) => e.includes(SHIM))).toBe(false);
    expect(existsSync(join(child, SHIM))).toBe(false);
  });

  it("a shell with no templates/base and no scripts still returns ok true and stampAdvanced true", () => {
    const shell = makeShell({ shim: false, base: false, runner: false, spawn: false });
    const child = makeChild();
    const r = upgrade(child, shell);
    expect(r.boundary).toBe("patch");
    expect(r.warnings.filter((w) => /template missing/.test(w))).toHaveLength(4);
    expect(r.ok).toBe(true);
    expect(r.stampAdvanced).toBe(true);
    expect(JSON.parse(read(child, join(".rks", "project.json"))).rksVersion).toBe("0.20.19");
  });

  it("a throwing seeder is warned about and does not block the stamp", () => {
    const shell = makeShell();
    const child = makeChild();
    const d = spies("0.20.19");
    d.seedVitestFiles = vi.fn(() => {
      throw new Error("disk full");
    });
    const r = upgradeProject({ projectRoot: child, projectId: "calc", shellRoot: shell }, d);
    expect(r.warnings).toContain("vitest file seeding skipped: disk full");
    expect(r.stampAdvanced).toBe(true);
  });

  it("dryRun writes no vitest file and does not create or modify the runner files", () => {
    const shell = makeShell();
    const child = makeChild();
    const r = upgrade(child, shell, { dryRun: true });
    expect(r.dryRun).toBe(true);
    for (const rel of ALL) expect(existsSync(join(child, rel))).toBe(false);
    expect(r.reconciled.some((e) => ALL.some((rel) => e.includes(rel)))).toBe(false);

    const custom = makeChild();
    put(custom, RUNNER, "// MY runner\n");
    put(custom, SPAWN, "// MY spawn\n");
    upgrade(custom, shell, { dryRun: true });
    expect(read(custom, RUNNER)).toBe("// MY runner\n");
    expect(read(custom, SPAWN)).toBe("// MY spawn\n");
    expect(existsSync(join(custom, SHIM))).toBe(false);
    expect(existsSync(join(custom, BASE))).toBe(false);
  });

  it("does not seed on a none boundary (doctor owns same-version repair)", () => {
    const shell = makeShell();
    const child = makeChild("0.20.19");
    const r = upgrade(child, shell);
    expect(r.boundary).toBe("none");
    for (const rel of ALL) expect(existsSync(join(child, rel))).toBe(false);
  });

  it("preserved still contains vitest.config.* (seeding an ABSENT file keeps the never-overwrite contract)", () => {
    const shell = makeShell();
    const child = makeChild();
    const r = upgrade(child, shell);
    expect(r.preserved).toContain("vitest.config.*");
    expect(r.preserved).toContain("CLAUDE.md");
  });
});
