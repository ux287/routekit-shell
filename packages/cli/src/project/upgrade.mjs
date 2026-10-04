import fs from "node:fs";
import path from "node:path";
import { readRksVersion, advanceStamp } from "./read-rks-version.mjs";
import { syncProject } from "./sync.mjs";
import { repinMcpServer } from "./repin-mcp.mjs";
import { migrateChildSettingsHookPaths, ensureHookRegistration, seedVitestFiles } from "./bootstrap.mjs";
import { migrateConfig } from "./migrate-config.mjs";
import { mergeRksPermissionAllow, readChildProjectConfig } from "./child-permissions.mjs";

/**
 * `routekit project upgrade` — reconcile a local child project's rks-OWNED scaffolding
 * to the shell's current rks version, for PATCH and MINOR jumps. MAJOR is refused
 * (release-migration registry is deferred). Orchestrates the existing reconcilers; it
 * does NOT reimplement them. Every side-effecting primitive is injectable (deps) so the
 * orchestration can be unit-tested without executing real hook-sync / repin / migrations.
 *
 * rksVersion is the release semver. "0.1.0" or absent is the UNSTAMPED sentinel (a child
 * scaffolded before the stamp fix) — treated as a full reconcile, NOT a genuine major jump.
 */

const SENTINEL = "0.1.0";

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function cmpSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Classify a from→to jump.
 * @returns 'unstamped' | 'none' | 'downgrade' | 'patch' | 'minor' | 'major' | 'invalid'
 */
export function classifyBoundary(from, to) {
  const t = parseSemver(to);
  if (!t) return "invalid";
  if (!from || from === SENTINEL) return "unstamped";
  const f = parseSemver(from);
  if (!f) return "invalid";
  const c = cmpSemver(f, t);
  if (c === 0) return "none";
  if (c > 0) return "downgrade";
  if (t.major !== f.major) return "major";
  if (t.minor !== f.minor) return "minor";
  return "patch";
}

function readChildRksVersion(rksJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(rksJsonPath, "utf8")).rksVersion || null;
  } catch {
    return null;
  }
}

function loadShellHooksManifest(shellRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(shellRoot, ".routekit", "hooks-manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

// Back up the mutation-prone MIXED footprint (user content lives here) before touching it.
// rks-owned dirs (hooks/prompts/skills) are regenerable, so they are not copied.
const BACKUP_FOOTPRINT = [".mcp.json", path.join(".claude", "settings.json"), path.join(".rks", "project.json")];

function backupFootprint(projectRoot, from, to, stamp) {
  const dir = path.join(projectRoot, ".rks", ".upgrade-backup", `${from || "unstamped"}-to-${to}-${stamp}`);
  let copied = 0;
  for (const rel of BACKUP_FOOTPRINT) {
    const src = path.join(projectRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied++;
  }
  return copied > 0 ? dir : null;
}

const PRESERVED = ["CLAUDE.md", "routekit/kg.yaml", "notes/**", "vitest.config.*"];

/**
 * @param {object} args projectRoot, projectId, shellRoot, opts {dryRun, noBackup}
 * @param {object} deps injectable primitives + readRksVersion + now (for tests)
 */
export function upgradeProject({ projectRoot, projectId, shellRoot, opts = {} } = {}, deps = {}) {
  const _readRksVersion = deps.readRksVersion || readRksVersion;
  const _syncProject = deps.syncProject || syncProject;
  const _repinMcpServer = deps.repinMcpServer || repinMcpServer;
  const _migrateSettings = deps.migrateChildSettingsHookPaths || migrateChildSettingsHookPaths;
  const _ensureHookRegistration = deps.ensureHookRegistration || ensureHookRegistration;
  const _migrateConfig = deps.migrateConfig || migrateConfig;
  const _mergeRksPermissionAllow = deps.mergeRksPermissionAllow || mergeRksPermissionAllow;
  const _seedVitestFiles = deps.seedVitestFiles || seedVitestFiles;
  const _now = deps.now || (() => new Date().toISOString().replace(/[:.]/g, "-"));

  const dryRun = Boolean(opts.dryRun);
  const noBackup = Boolean(opts.noBackup);
  const rksJsonPath = path.join(projectRoot, ".rks", "project.json");

  const from = readChildRksVersion(rksJsonPath);
  const to = _readRksVersion(shellRoot);

  // backlog.feat.project-adopt-verb — carried at CONSTRUCTION so every one of the seven terminating
  // returns below surfaces it without each having to remember. The no-op path is the one that
  // motivated this: `Already at 0.20.34 — nothing to do.` was correct and unactionable, because it
  // never said WHICH shell it had compared against — and the shell it resolved was a stale clone the
  // operator did not know was on their PATH.
  const resolvedShellRoot = shellRoot ? path.resolve(shellRoot) : null;

  const report = {
    ok: true,
    projectId,
    from,
    to,
    shellRoot: resolvedShellRoot,
    boundary: null,
    gated: false,
    dryRun,
    backupPath: null,
    reconciled: [],
    migrationsApplied: [],
    preserved: [...PRESERVED],
    stampAdvanced: false,
    restartRequired: false,
    warnings: [],
  };

  const shellLabel = resolvedShellRoot || "an unresolved shell root";

  if (!to) {
    report.ok = false;
    report.boundary = "invalid";
    report.warnings.push(
      `Could not read the shell version (package.json) at ${shellLabel} — cannot upgrade.`,
    );
    return report;
  }

  const boundary = classifyBoundary(from, to);
  report.boundary = boundary;

  if (boundary === "none") {
    report.warnings.push(`Already at ${to} — nothing to do. (compared against shell ${shellLabel})`);
    return report;
  }
  if (boundary === "downgrade") {
    report.warnings.push(
      `Child is ${from}, shell at ${shellLabel} is older (${to}) — refusing to downgrade.`,
    );
    return report;
  }
  if (boundary === "invalid") {
    report.ok = false;
    report.warnings.push(`Cannot parse versions (${from} → ${to}) against shell ${shellLabel}.`);
    return report;
  }
  if (boundary === "major") {
    report.gated = true;
    report.warnings.push(
      `Major upgrade ${from} → ${to} (shell ${shellLabel}) is not yet supported — the release-migration registry is deferred. No changes made.`,
    );
    return report; // GATED: zero mutation
  }

  // boundary ∈ { patch, minor, unstamped }. A full scaffolding reconcile.
  report.restartRequired = true;
  const isMinorPlus = boundary === "minor" || boundary === "unstamped";

  if (dryRun) {
    report.reconciled.push("sync hooks/prompts/skills", "repin .mcp.json");
    if (isMinorPlus) report.reconciled.push("repair .claude/settings.json hook paths", "apply schema migrations");
    return report; // mutate nothing
  }

  // Backup the mutation-prone footprint first (recoverable partial upgrade).
  if (!noBackup) report.backupPath = backupFootprint(projectRoot, from, to, _now());

  // Reconcile rks-owned scaffolding (patch+): sync + repin.
  // refreshStamp:false — the upgrade path stamps LAST (below) for crash-safety, so sync
  // must NOT advance the stamp early. A crash between sync and the stamp-LAST call must
  // leave the child at `from`, re-runnable.
  const updated = _syncProject({ projectRoot, projectId, shellRoot, refreshStamp: false }) || [];
  report.reconciled.push(...updated);
  try {
    const repin = _repinMcpServer({ projectRoot, shellRoot });
    if (repin && repin.argsChanged) report.reconciled.push(".mcp.json (repinned)");
    for (const c of (repin && repin.envRootChanges) || []) {
      report.reconciled.push(`.mcp.json env ${c.key} (stale root rewritten): ${c.from} → ${c.to}`);
    }
  } catch (e) {
    report.warnings.push(`repin-mcp skipped: ${e.message}`);
  }

  // Minor+: surgical settings hook-path repair + schema migrations.
  if (isMinorPlus) {
    const manifest = loadShellHooksManifest(shellRoot);
    const settingsPath = path.join(projectRoot, ".claude", "settings.json");
    if (manifest && _migrateSettings({ settingsPath, manifest })) {
      report.reconciled.push(".claude/settings.json (hook paths)");
    }
    try {
      const mc = _migrateConfig({ projectRoot });
      if (mc && !mc.noOp) report.migrationsApplied.push(...mc.applied);
    } catch (e) {
      report.warnings.push(`migrate-config skipped: ${e.message}`);
    }
  }

  // EVERY reconciling boundary (patch, minor, unstamped): ensure the child's hooks
  // are actually REGISTERED in .claude/settings.json.
  // backlog.fix.child-hook-registration-repair-and-audit — a missing hooks block is a
  // correctness defect, not a version-gated migration: a child on a patch jump is
  // exactly as ungoverned as one on a minor jump. This runs AFTER backupFootprint
  // (the file is MIXED — user content lives in it) and BEFORE the stamp-last advance.
  // It also runs after the minor-only path migration above, so a flat→tiered rewrite
  // still reports itself before the block is canonicalised.
  try {
    const registration = _ensureHookRegistration({
      settingsPath: path.join(projectRoot, ".claude", "settings.json"),
      manifest: loadShellHooksManifest(shellRoot),
    });
    if (registration && registration.changed) {
      report.reconciled.push(".claude/settings.json (hook registration)");
    } else if (registration && registration.reason === "unparseable") {
      // Refused, not clobbered — the operator has to look at it.
      report.warnings.push(
        ".claude/settings.json is unparseable — hook registration REFUSED (file left untouched).",
      );
    }
  } catch (e) {
    report.warnings.push(`hook registration skipped: ${e.message}`);
  }

  // EVERY reconciling boundary: add any missing rks permission rules (wildcard allow +
  // checkpoint ask). backlog.fix.child-rks-permission-allow-list — the hook writer only
  // owns `hooks`, so without this an existing child never receives a new rule.
  // Additive only; after backupFootprint, before the stamp-last advance.
  try {
    const perms = _mergeRksPermissionAllow({
      settingsPath: path.join(projectRoot, ".claude", "settings.json"),
      localSettingsPath: path.join(projectRoot, ".claude", "settings.local.json"),
      projectConfig: readChildProjectConfig(projectRoot),
    });
    if (perms && perms.changed) {
      const n = (perms.added || []).length + (perms.addedAsk || []).length;
      report.reconciled.push(`.claude/settings.json (rks permissions: +${n})`);
    } else if (perms && perms.reason === "unparseable") {
      report.warnings.push(
        `${perms.file} is unparseable — rks permission merge REFUSED (files left untouched).`,
      );
    } else if (perms && perms.reason === "opted-out") {
      report.warnings.push(
        "rks permission merge skipped: opted out (.rks/project.json claudePermissions.manageAllowList: false).",
      );
    }
  } catch (e) {
    report.warnings.push(`rks permission merge skipped: ${e.message}`);
  }

  // EVERY reconciling boundary: seed any ABSENT vitest file exec's scoped test runs depend
  // on (the vitest.config.unit.mjs shim, its base config, the runner and spawn-managed).
  // backlog.fix.upgrade-never-restores-vitest-unit-shim — NEVER overwrites: vitest.config.*
  // stays PRESERVED, and a customised runner is not in BACKUP_FOOTPRINT, so an overwrite
  // would be unrecoverable. reconciled entries come only from the OBSERVED `created` list;
  // a missing shell template is warned about and never blocks the stamp. Dry runs returned
  // above, so they never reach this. A same-version child (boundary none) is doctor's job.
  try {
    const seeded = _seedVitestFiles({ projectRoot, shellRoot });
    for (const rel of (seeded && seeded.created) || []) {
      report.reconciled.push(`${rel} (seeded: was absent)`);
    }
    for (const rel of (seeded && seeded.templateMissing) || []) {
      report.warnings.push(`${rel} is absent and was not seeded: shell template missing.`);
    }
  } catch (e) {
    report.warnings.push(`vitest file seeding skipped: ${e.message}`);
  }

  // Advance the stamp LAST — a crash before here leaves the child re-runnable.
  advanceStamp(rksJsonPath, to);
  report.stampAdvanced = true;

  return report;
}
