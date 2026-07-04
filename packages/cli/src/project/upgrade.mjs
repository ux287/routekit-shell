import fs from "node:fs";
import path from "node:path";
import { readRksVersion } from "./read-rks-version.mjs";
import { syncProject } from "./sync.mjs";
import { repinMcpServer } from "./repin-mcp.mjs";
import { migrateChildSettingsHookPaths } from "./bootstrap.mjs";
import { migrateConfig } from "./migrate-config.mjs";

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

function advanceStamp(rksJsonPath, to) {
  let json = {};
  try {
    json = JSON.parse(fs.readFileSync(rksJsonPath, "utf8"));
  } catch {
    /* create fresh */
  }
  json.rksVersion = to;
  fs.mkdirSync(path.dirname(rksJsonPath), { recursive: true });
  fs.writeFileSync(rksJsonPath, JSON.stringify(json, null, 2) + "\n");
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
  const _migrateConfig = deps.migrateConfig || migrateConfig;
  const _now = deps.now || (() => new Date().toISOString().replace(/[:.]/g, "-"));

  const dryRun = Boolean(opts.dryRun);
  const noBackup = Boolean(opts.noBackup);
  const rksJsonPath = path.join(projectRoot, ".rks", "project.json");

  const from = readChildRksVersion(rksJsonPath);
  const to = _readRksVersion(shellRoot);

  const report = {
    ok: true,
    projectId,
    from,
    to,
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

  if (!to) {
    report.ok = false;
    report.boundary = "invalid";
    report.warnings.push("Could not read the shell version (package.json) — cannot upgrade.");
    return report;
  }

  const boundary = classifyBoundary(from, to);
  report.boundary = boundary;

  if (boundary === "none") {
    report.warnings.push(`Already at ${to} — nothing to do.`);
    return report;
  }
  if (boundary === "downgrade") {
    report.warnings.push(`Child is ${from}, shell is older (${to}) — refusing to downgrade.`);
    return report;
  }
  if (boundary === "invalid") {
    report.ok = false;
    report.warnings.push(`Cannot parse versions (${from} → ${to}).`);
    return report;
  }
  if (boundary === "major") {
    report.gated = true;
    report.warnings.push(
      `Major upgrade ${from} → ${to} is not yet supported — the release-migration registry is deferred. No changes made.`,
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
  const updated = _syncProject({ projectRoot, projectId, shellRoot }) || [];
  report.reconciled.push(...updated);
  try {
    const repin = _repinMcpServer({ projectRoot, shellRoot });
    if (repin && repin.changed) report.reconciled.push(".mcp.json (repinned)");
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

  // Advance the stamp LAST — a crash before here leaves the child re-runnable.
  advanceStamp(rksJsonPath, to);
  report.stampAdvanced = true;

  return report;
}
