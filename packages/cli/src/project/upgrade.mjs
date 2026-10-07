import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { readRksVersion, advanceStamp } from "./read-rks-version.mjs";
import { syncProject } from "./sync.mjs";
import { repinMcpServer } from "./repin-mcp.mjs";
import { migrateChildSettingsHookPaths, ensureHookRegistration, seedVitestFiles } from "./bootstrap.mjs";
import { migrateConfig } from "./migrate-config.mjs";
import { mergeRksPermissionAllow, readChildProjectConfig } from "./child-permissions.mjs";
import { getProtectedBranches } from "../../../mcp-rks/src/server/branch-protection.mjs";

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

// ---------------------------------------------------------------------------------------------
// backlog.fix.upgrade-leaves-child-tree-dirty — the upgrade closes its own git transaction.
// ---------------------------------------------------------------------------------------------

// Machine-only artifacts the upgrade (and the writers it calls) drop into the child. The child's
// .gitignore is self-healed to cover them BEFORE backupFootprint writes the first one.
const IGNORE_RULES = [".rks/.upgrade-backup/", ".rks/.backup/"];

// The rks-OWNED footprint the upgrade may commit. An explicit constant — NEVER derived from
// report.reconciled, which mixes real paths with human-readable labels. Directory entries end in
// "/" and match by prefix; the rest match exactly.
const COMMIT_FOOTPRINT = [
  ".routekit/hooks/",
  ".rks/prompts/",
  ".rks/project.json",
  ".claude/skills/",
  ".claude/agents/",
  ".claude/settings.json",
  ".mcp.json",
];

// enforce-branch-workflow.mjs's own default when .routekit/branch-policy.yaml is absent.
const DEFAULT_POLICY_BLOCKED = ["main", "dev"];

const GIT_TIMEOUT_MS = 30_000;

function defaultGit(projectRoot) {
  return (args, { cwd } = {}) => {
    try {
      return execFileSync("git", args, {
        cwd: cwd || projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (e) {
      const stderr = e && e.stderr ? String(e.stderr).trim() : "";
      throw new Error(stderr || (e && e.message) || String(e));
    }
  };
}

const normRule = (line) => line.trim().replace(/^\//, "").replace(/\/+$/, "");

/**
 * Ensure the child's .gitignore covers IGNORE_RULES. Appends only missing rules (a rule present
 * with or without its trailing slash counts), keeps existing bytes as a prefix, creates the file
 * when absent. @returns the rules appended ([] when nothing changed).
 */
function healGitignore(projectRoot) {
  const p = path.join(projectRoot, ".gitignore");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  const present = new Set((existing || "").split(/\r?\n/).map(normRule).filter(Boolean));
  const missing = IGNORE_RULES.filter((r) => !present.has(normRule(r)));
  if (missing.length === 0) return [];
  let out = existing || "";
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  out += missing.map((r) => `${r}\n`).join("");
  fs.writeFileSync(p, out);
  return missing;
}

function readUpgradeCommitOptOut(projectRoot) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    return Boolean(pj && pj.upgrade && pj.upgrade.commit === false);
  } catch {
    return false;
  }
}

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Read one policy file. @returns { exists, doc } or throws (fail closed) with a message naming the
 * file and the reason. Present keys must be arrays of strings.
 */
function readPolicyFile(projectRoot, rel, keys) {
  const abs = path.join(projectRoot, rel);
  if (!fs.existsSync(abs)) return { exists: false, doc: {} };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`${rel} could not be parsed: ${e.message}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${rel} is not a mapping`);
  }
  for (const k of keys) {
    if (doc[k] !== undefined && !isStringArray(doc[k])) {
      throw new Error(`${rel} key ${k} is not an array of strings`);
    }
  }
  return { exists: true, doc };
}

/**
 * The child's policy set: [{ branch, file, key }] entries that forbid a direct commit.
 * exempt_branches is deliberately NEVER consulted — it cannot grant the upgrade a commit.
 */
function readPolicyBlocked(projectRoot) {
  const blocked = [];
  const bpRel = ".routekit/branch-policy.yaml";
  const bp = readPolicyFile(projectRoot, bpRel, ["block_direct_commits_to", "protected_branches"]);
  if (!bp.exists) {
    for (const b of DEFAULT_POLICY_BLOCKED) {
      blocked.push({ branch: b, file: `${bpRel} (absent: hook default)`, key: "block_direct_commits_to" });
    }
  } else {
    for (const key of ["block_direct_commits_to", "protected_branches"]) {
      for (const b of bp.doc[key] || []) blocked.push({ branch: b, file: bpRel, key });
    }
  }
  const gpRel = ".routekit/git-policy.yaml";
  const gp = readPolicyFile(projectRoot, gpRel, ["protected_branches"]);
  for (const b of gp.doc.protected_branches || []) blocked.push({ branch: b, file: gpRel, key: "protected_branches" });
  return blocked;
}

/** Paths from `git status --porcelain -z --untracked-files=all` (both sides of a rename). */
function dirtyPaths(git, projectRoot) {
  const out = git(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: projectRoot }) || "";
  const parts = out.split("\0");
  const paths = new Set();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (xy[0] === "R" || xy[0] === "C") {
      i += 1;
      if (parts[i]) paths.add(parts[i]);
    }
  }
  return paths;
}

const inFootprint = (rel) => COMMIT_FOOTPRINT.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f));

const realpathOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Decide, BEFORE anything is written, whether this upgrade may commit, and snapshot the paths that
 * are already dirty. @returns { ok: true, preDirty, preHead } or { ok: false, reason, warning }.
 */
function prepareCommit({ git, projectRoot, opts }) {
  if (opts.noCommit) {
    return { ok: false, reason: "no_commit", warning: "upgrade commit skipped (--no-commit): the upgrade's footprint is left uncommitted." };
  }
  if (readUpgradeCommitOptOut(projectRoot)) {
    return {
      ok: false,
      reason: "opted_out",
      warning: "upgrade commit skipped: opted out (.rks/project.json upgrade.commit: false); the upgrade's footprint is left uncommitted.",
    };
  }
  let top;
  try {
    top = String(git(["rev-parse", "--show-toplevel"], { cwd: projectRoot }) || "").trim();
  } catch (e) {
    return {
      ok: false,
      reason: "not_git_repo",
      warning: `upgrade commit skipped: ${projectRoot} is not a git repository (${e.message}); the upgrade's footprint is left uncommitted.`,
    };
  }
  if (!top || realpathOr(top) !== realpathOr(projectRoot)) {
    return {
      ok: false,
      reason: "not_repo_root",
      warning: `upgrade commit skipped: ${projectRoot} is not the root of its git repository (toplevel ${top || "unknown"}); refusing to commit into an enclosing repository.`,
    };
  }
  let branch;
  try {
    branch = String(git(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: projectRoot }) || "").trim();
  } catch {
    branch = "";
  }
  if (!branch) {
    return {
      ok: false,
      reason: "detached_head",
      warning: "upgrade commit skipped: HEAD is detached; the upgrade's footprint is left uncommitted.",
    };
  }
  let protectedBranches = [];
  try {
    protectedBranches = getProtectedBranches(projectRoot) || [];
  } catch {
    protectedBranches = ["main", "master", "production"];
  }
  if (protectedBranches.includes(branch)) {
    return {
      ok: false,
      reason: "protected_branch",
      warning: `upgrade commit skipped: branch '${branch}' is protected (getProtectedBranches); the upgrade's footprint is left uncommitted.`,
    };
  }
  let blocked;
  try {
    blocked = readPolicyBlocked(projectRoot);
  } catch (e) {
    return {
      ok: false,
      reason: "branch_policy_unreadable",
      warning: `upgrade commit skipped: branch policy unreadable — ${e.message}; failing closed, the upgrade's footprint is left uncommitted.`,
    };
  }
  const hit = blocked.find((b) => b.branch === branch);
  if (hit) {
    return {
      ok: false,
      reason: "policy_blocked_branch",
      warning: `upgrade commit skipped: branch '${branch}' is blocked for direct commits by ${hit.file} key ${hit.key}; the upgrade's footprint is left uncommitted.`,
    };
  }
  let preHead = null;
  try {
    preHead = String(git(["rev-parse", "-q", "--verify", "HEAD"], { cwd: projectRoot }) || "").trim() || null;
  } catch {
    preHead = null;
  }
  let preDirty;
  try {
    preDirty = dirtyPaths(git, projectRoot);
  } catch (e) {
    return {
      ok: false,
      reason: "commit_failed",
      warning: `upgrade commit failed: could not read git status before the upgrade (${e.message}); the upgrade's footprint is left uncommitted.`,
    };
  }
  return { ok: true, preDirty, preHead };
}

/**
 * Path-scoped commit of the upgrade's own footprint. Every report field is read back from git.
 */
function commitFootprint({ git, projectRoot, prep, extraPaths, message, report }) {
  let post;
  try {
    post = dirtyPaths(git, projectRoot);
  } catch (e) {
    report.commitSkipped = "commit_failed";
    report.warnings.push(`upgrade commit failed: could not read git status (${e.message}); the upgrade's footprint is left uncommitted.`);
    return;
  }
  const isCandidate = (rel) => inFootprint(rel) || extraPaths.has(rel);
  const excluded = [...prep.preDirty].filter(isCandidate).sort();
  if (excluded.length > 0) {
    report.warnings.push(
      `upgrade commit excluded rks-owned path(s) already modified before the upgrade (operator edits left uncommitted): ${excluded.join(", ")}`,
    );
  }
  const paths = [...post].filter((rel) => isCandidate(rel) && !prep.preDirty.has(rel)).sort();
  if (paths.length === 0) {
    report.commitSkipped = "nothing_to_commit";
    return;
  }
  try {
    git(["add", "-A", "--", ...paths], { cwd: projectRoot });
    git(["commit", "-q", "-m", message, "--only", "--", ...paths], { cwd: projectRoot });
  } catch (e) {
    let restored = true;
    try {
      git(["reset", "-q", "--", ...paths], { cwd: projectRoot });
    } catch {
      restored = false;
    }
    report.commitSkipped = "commit_failed";
    report.warnings.push(
      `upgrade commit failed: ${e.message}; the upgrade's footprint is left uncommitted${restored ? " (index restored)" : " (index restore FAILED — check git status)"}.`,
    );
    return;
  }
  let sha = null;
  try {
    sha = String(git(["rev-parse", "HEAD"], { cwd: projectRoot }) || "").trim() || null;
  } catch {
    sha = null;
  }
  if (!sha || sha === prep.preHead) {
    report.commitSkipped = "commit_failed";
    report.warnings.push("upgrade commit failed: git reported success but HEAD did not move; the upgrade's footprint is left uncommitted.");
    return;
  }
  let files = [];
  try {
    const out = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", sha], { cwd: projectRoot }) || "";
    files = out.split("\0").filter(Boolean);
  } catch (e) {
    report.warnings.push(`upgrade commit ${sha} created, but its file list could not be read: ${e.message}`);
  }
  report.committed = true;
  report.commitSha = sha;
  report.committedFiles = files;
  report.commitSkipped = null;
}

/**
 * @param {object} args projectRoot, projectId, shellRoot, opts {dryRun, noBackup, noCommit}
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
  // deps.git(args, { cwd }) — returns stdout, throws on non-zero exit.
  const _git = deps.git || defaultGit(projectRoot);

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
    // backlog.fix.upgrade-leaves-child-tree-dirty — evidence-bound: only set from observed git output.
    committed: false,
    commitSha: null,
    committedFiles: [],
    commitSkipped: null,
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
  const commitMessage = `chore(rks): upgrade scaffolding ${boundary === "unstamped" || !from ? "unstamped" : from} -> ${to}`;

  if (dryRun) {
    report.reconciled.push("sync hooks/prompts/skills", "repin .mcp.json");
    if (isMinorPlus) report.reconciled.push("repair .claude/settings.json hook paths", "apply schema migrations");
    report.commitSkipped = "dry_run";
    report.warnings.push(
      `dry-run: would commit the rks-owned upgrade footprint as '${commitMessage}' (unless --no-commit, an opt-out or a branch/policy gate applies).`,
    );
    return report; // mutate nothing
  }

  // Gate + snapshot BEFORE anything is written, so pre-existing dirt is known and never staged.
  const prep = prepareCommit({ git: _git, projectRoot, opts });
  if (!prep.ok) {
    report.commitSkipped = prep.reason;
    report.warnings.push(prep.warning);
  }

  // Self-heal the child's .gitignore BEFORE backupFootprint, so the upgrade's own backups never
  // appear as untracked dirt.
  let gitignoreHealed = false;
  try {
    const added = healGitignore(projectRoot);
    if (added.length > 0) {
      gitignoreHealed = true;
      report.reconciled.push(`.gitignore (ignore ${added.join(", ")})`);
    }
  } catch (e) {
    report.warnings.push(`.gitignore self-heal skipped: ${e.message}`);
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
  const seededPaths = [];
  try {
    const seeded = _seedVitestFiles({ projectRoot, shellRoot });
    for (const rel of (seeded && seeded.created) || []) {
      seededPaths.push(String(rel).split(path.sep).join("/"));
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

  // Commit LAST, after the stamp-last advance. Never fails the upgrade: every outcome is reported.
  if (prep.ok) {
    try {
      const extraPaths = new Set(seededPaths);
      if (gitignoreHealed) extraPaths.add(".gitignore");
      commitFootprint({ git: _git, projectRoot, prep, extraPaths, message: commitMessage, report });
    } catch (e) {
      report.committed = false;
      report.commitSha = null;
      report.committedFiles = [];
      report.commitSkipped = "commit_failed";
      report.warnings.push(`upgrade commit failed: ${e.message}`);
    }
  }

  return report;
}
