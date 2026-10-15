/**
 * doctor.mjs — `routekit doctor`: diagnose the full child-project ecosystem
 * and auto-invoke the four Tier 2 fixers by default.
 *
 * Nine checks:
 *   1. Shell-side template drift  → fixer: syncHooks(packages/hooks → templates/generic)
 *   2. Per-child hooks drift      → fixer: syncProject
 *   3. Per-child .mcp.json pointer → fixer: repinMcpServer (skipped when pinned:true)
 *   4. Per-child registry presence → fixer: upsertProject (NOT add-existing handler)
 *   5. Per-child schemaVersion    → fixer: migrateConfig
 *   6. Per-child hook REGISTRATION → fixer: ensureHookRegistration
 *   7. Per-child rks PERMISSION rules → fixer: mergeRksPermissionAllow
 *   8. Per-child vitest files (unit shim, base config, runner, spawn-managed) → fixer: seedVitestFiles
 *   9. Per-child runtime artifacts:
 *      9a. .gitignore runtime rules → fixer: repairChildGitignore (append-only; skipped for content-only)
 *      9b. runtime artifacts already in the git index → REPORTED only (non-recoverable), never untracked
 *
 * Check 2 compares hook SCRIPTS on disk; Check 6 compares their REGISTRATION in
 * .claude/settings.json. A child can pass 2 and fail 6 — 48 current hook scripts
 * and not one of them registered, every guardrail inert, and every existing check
 * green. That is backlog.fix.child-hook-registration-repair-and-audit, verified in
 * a real child (routekit-growth) before this check existed.
 *
 * Default mode: detect + auto-fix. `dryRun:true` returns the fix plan without
 * mutating anything.
 *
 * The pinned-out: a child can declare `pinned: true` in its `.rks/project.json`
 * to refuse auto-repin of .mcp.json (Check 3). All other checks/fixers still
 * run for that child; the pinned shell-drift is reported as a non-recoverable
 * finding.
 */
import fs from "node:fs";
import path from "node:path";
import { syncHooks, checkDrift } from "../../../../scripts/sync-hooks.mjs";
import { syncProject, sameDirectory } from "./sync.mjs";
import { repinMcpServer } from "./repin-mcp.mjs";
import { migrateConfig } from "./migrate-config.mjs";
import { loadProjects, upsertProject } from "./index.js";
import {
  buildHookRegistration,
  ensureHookRegistration,
  loadHookManifest,
  seedVitestFiles,
  VITEST_SEED_DESTINATIONS,
} from "./bootstrap.mjs";
import { mergeRksPermissionAllow, planRksPermissionMerge, readChildProjectConfig } from "./child-permissions.mjs";
import { readContentOnly } from "./content-only.mjs";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Check 9 — backlog.fix.doctor-child-runtime-gitignore-repair-and-tracked-audit
// ---------------------------------------------------------------------------

/**
 * The rks runtime paths a child's .gitignore must cover (traders-46). Exactly these six, in
 * this order. Deliberately NO catch-all (`.rks/`, `.rks/*`, `*`): a child tracks
 * .rks/project.json, .rks/prompts/ and friends, so doctor never adds a rule that would hide them.
 */
export const CHILD_RUNTIME_GITIGNORE_RULES = Object.freeze([
  ".rks/runs/",
  ".rks/session/",
  ".rks/fetch-cache/",
  ".rks/state/interventions.jsonl",
  ".rks/test-runner-debug.json",
  ".rks/test-runner-full-output.txt",
]);

const CHILD_RUNTIME_GITIGNORE_COMMENT = "# rks runtime artifacts (added by routekit doctor)";

// Local copy of upgrade.mjs's module-private normRule (trim, strip one leading `/`, strip trailing `/`).
const normRule = (line) => line.trim().replace(/^\//, "").replace(/\/+$/, "");

const GIT_AUDIT_TIMEOUT_MS = 15000;

// Local copy of content-only.mjs's module-private list. The 9b result is reported against the
// CHILD, so the default runner must read the child's index, not one an inherited variable names.
const GIT_REDIRECT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE"];

/** process.env minus the git redirect variables, computed per spawn (never captured at load). */
function gitAuditEnv() {
  const env = { ...process.env };
  for (const k of GIT_REDIRECT_ENV) delete env[k];
  return env;
}

/** Read a child's .gitignore; ENOENT is empty (null), any other read error throws. */
function readChildGitignore(childRoot) {
  try {
    return fs.readFileSync(path.join(childRoot, ".gitignore"), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Does any normalised .gitignore line cover `required`? Rules (i) equal, (ii) ancestor, (iii) `<dir>/*`. */
function ruleCovers(normLines, required) {
  const req = required.replace(/\/+$/, "");
  for (const n of normLines) {
    if (n === req) return true; // (i)
    if (req.startsWith(n + "/")) return true; // (ii)
    const glob = /^(.+)\/\*\*?$/.exec(n); // (iii)
    if (glob && req.startsWith(glob[1] + "/")) return true;
  }
  return false;
}

/**
 * Check 9a detector. Absent .gitignore = empty. Blank, `#` comment and `!` negation lines are
 * not coverage. Read errors other than ENOENT propagate (runDoctor books them).
 *
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function inspectChildGitignore(childRoot) {
  const content = readChildGitignore(childRoot) ?? "";
  const normLines = content
    .split(/\r?\n/)
    .filter((raw) => {
      const t = raw.trim();
      return t !== "" && !t.startsWith("#") && !t.startsWith("!");
    })
    .map(normRule)
    .filter((n) => n !== "");
  const missing = CHILD_RUNTIME_GITIGNORE_RULES.filter((rule) => !ruleCovers(normLines, rule));
  return { ok: missing.length === 0, missing };
}

/**
 * Check 9a fixer: append ONLY `missing`, keeping the existing bytes as an exact prefix. Never
 * removes, reorders or rewrites a line. Creates the file when absent.
 *
 * @returns {string[]} the entries appended
 */
export function repairChildGitignore(childRoot, missing) {
  const entries = Array.isArray(missing) ? missing : [];
  if (entries.length === 0) return [];
  const existing = readChildGitignore(childRoot);
  const before = existing ?? "";
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  let addition = "";
  if (before.length > 0 && !before.endsWith("\n")) addition += eol;
  addition += CHILD_RUNTIME_GITIGNORE_COMMENT + eol;
  for (const e of entries) addition += e + eol;
  fs.writeFileSync(path.join(childRoot, ".gitignore"), before + addition);
  return [...entries];
}

const errMessage = (err) => (err && err.message) || String(err);
const trimOut = (s) => (typeof s === "string" ? s.trim() : "");

/**
 * Check 9b audit: which of the six runtime paths are already in the child's git index?
 * REPORT ONLY — never mutates the index or history. Never throws. Returns exactly one of
 *   { files: [...] }            the audit ran (may be empty)
 *   { skipped: true, reason }   not a git work tree, or git unavailable
 *   { error: true, reason }     rev-parse succeeded but ls-files failed
 */
export function listTrackedRuntimeArtifacts(childRoot, { runGit } = {}) {
  const run =
    typeof runGit === "function"
      ? runGit
      : (args) =>
          spawnSync("git", args, { cwd: childRoot, env: gitAuditEnv(), encoding: "utf8", timeout: GIT_AUDIT_TIMEOUT_MS });

  let rp;
  try {
    rp = run(["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    return { skipped: true, reason: `git unavailable: ${errMessage(err)}` };
  }
  if (!rp || typeof rp !== "object") return { skipped: true, reason: "git unavailable: no result from git rev-parse" };
  if (rp.error) return { skipped: true, reason: `git unavailable: ${errMessage(rp.error)}` };
  if (rp.status !== 0) {
    const why = rp.status === null && rp.signal ? `killed by ${rp.signal}` : `exit ${rp.status}`;
    const stderr = trimOut(rp.stderr);
    return { skipped: true, reason: `not a git work tree: ${why}${stderr ? `: ${stderr}` : ""}` };
  }
  const rpOut = trimOut(rp.stdout);
  if (rpOut !== "true") return { skipped: true, reason: `not a git work tree: output ${rpOut || "(empty)"}` };

  try {
    const ls = run(["ls-files", "-z", "--", ...CHILD_RUNTIME_GITIGNORE_RULES]);
    if (!ls || typeof ls !== "object") return { error: true, reason: "git ls-files failed: no result" };
    const stderr = trimOut(ls.stderr);
    const tail = stderr ? `: ${stderr}` : "";
    if (ls.error) return { error: true, reason: `git ls-files failed: ${errMessage(ls.error)}${tail}` };
    if (ls.status !== 0) {
      const why = ls.status === null && ls.signal ? `killed by ${ls.signal}` : `exit ${ls.status}`;
      return { error: true, reason: `git ls-files failed: ${why}${tail}` };
    }
    const out = typeof ls.stdout === "string" ? ls.stdout : String(ls.stdout ?? "");
    return { files: [...new Set(out.split("\0").filter(Boolean))] };
  } catch (err) {
    return { error: true, reason: `git ls-files failed: ${errMessage(err)}` };
  }
}

/**
 * Read a child's `.rks/project.json` and return its `pinned` flag. Any error
 * or missing file returns false (fail-safe — default is unpinned).
 */
function isPinned(projectRoot) {
  try {
    const p = path.join(projectRoot, ".rks", "project.json");
    if (!fs.existsSync(p)) return false;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return data?.pinned === true;
  } catch {
    return false;
  }
}

/**
 * Check whether args[0] of the child's .mcp.json points under the given
 * shellRoot. Returns { exists, pointer, healthy }.
 */
function checkMcpPointer(projectRoot, shellRoot) {
  const mcpPath = path.join(projectRoot, ".mcp.json");
  if (!fs.existsSync(mcpPath)) {
    return { exists: false, pointer: null, healthy: false };
  }
  try {
    const data = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    const pointer = data?.mcpServers?.rks?.args?.[0];
    if (typeof pointer !== "string") return { exists: true, pointer: null, healthy: false };
    const healthy = pointer.startsWith(shellRoot + path.sep) || pointer.startsWith(shellRoot + "/");
    return { exists: true, pointer, healthy };
  } catch {
    return { exists: true, pointer: null, healthy: false };
  }
}

/** Every hook command string registered in a settings object, in order. */
function registeredCommands(settings) {
  const out = [];
  const events = settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const event of Object.keys(events)) {
    for (const group of Array.isArray(events[event]) ? events[event] : []) {
      for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (h && typeof h.command === "string") out.push(h.command);
      }
    }
  }
  return out;
}

/**
 * Check 6's detector: is this child's hook registration present, complete and
 * resolvable? backlog.fix.child-hook-registration-repair-and-audit
 *
 * `recoverable: true` means ensureHookRegistration can repair it. Unparseable
 * settings are NOT recoverable — the writer refuses a file it cannot read rather
 * than clobbering user content, so no fixer can clear it and a human must look.
 *
 * @returns {{ok: boolean, reason?: string, recoverable?: boolean, detail?: string[]}}
 */
export function inspectHookRegistration({ childRoot, manifest, canonical }) {
  const settingsPath = path.join(childRoot, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { ok: false, reason: "no .claude/settings.json", recoverable: true };
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return { ok: false, reason: "unparseable .claude/settings.json", recoverable: false };
  }
  if (!settings || typeof settings !== "object" || !settings.hooks || typeof settings.hooks !== "object") {
    return { ok: false, reason: "no hooks key in .claude/settings.json", recoverable: true };
  }

  const commands = registeredCommands(settings);
  if (commands.length === 0) {
    return { ok: false, reason: "hooks block registers zero hook commands", recoverable: true };
  }

  const expected = registeredCommands({ hooks: canonical || buildHookRegistration(manifest) });
  const present = new Set(commands);
  const missing = expected.filter((cmd) => !present.has(cmd));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `registration is incomplete (${missing.length} of ${expected.length} canonical hooks unregistered)`,
      recoverable: true,
      detail: missing.slice(0, 5),
    };
  }

  // Registered but dead: a command whose script is not on disk in the CHILD does
  // not load, and Claude Code treats a failed hook as non-blocking — the tool
  // runs unredirected. That is indistinguishable from no registration at all.
  const unresolved = [];
  for (const cmd of commands) {
    const m = /\.routekit\/hooks\/(\S+\.mjs)/.exec(cmd);
    if (!m) continue;
    if (!fs.existsSync(path.join(childRoot, ".routekit", "hooks", m[1]))) unresolved.push(m[1]);
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      reason: `${unresolved.length} registered hook command(s) point at files not on disk in the child`,
      recoverable: true,
      detail: unresolved.slice(0, 5),
    };
  }

  return { ok: true };
}

/**
 * Run all six doctor checks against the given shell.
 *
 * @param {object} args
 * @param {string}  args.shellRoot - Absolute path to the invoking routekit-shell.
 * @param {boolean} [args.dryRun]  - When true, no fixers are invoked (default false).
 * @param {object}  [args.deps]    - Dependency overrides (for tests).
 * @returns {Promise<object>} structured per-check results
 */
export async function runDoctor({ shellRoot, dryRun = false, deps = {} } = {}) {
  if (!shellRoot || typeof shellRoot !== "string") {
    throw new Error("runDoctor: shellRoot is required");
  }
  const _syncHooks = deps.syncHooks || syncHooks;
  const _checkDrift = deps.checkDrift || checkDrift;
  const _syncProject = deps.syncProject || syncProject;
  const _repinMcpServer = deps.repinMcpServer || repinMcpServer;
  const _migrateConfig = deps.migrateConfig || migrateConfig;
  const _upsertProject = deps.upsertProject || upsertProject;
  const _loadProjects = deps.loadProjects || loadProjects;
  const _isPinned = deps.isPinned || isPinned;
  const _loadHookManifest = deps.loadHookManifest || loadHookManifest;
  const _ensureHookRegistration = deps.ensureHookRegistration || ensureHookRegistration;
  const _inspectHookRegistration = deps.inspectHookRegistration || inspectHookRegistration;
  const _mergeRksPermissionAllow = deps.mergeRksPermissionAllow || mergeRksPermissionAllow;
  const _seedVitestFiles = deps.seedVitestFiles || seedVitestFiles;
  const _listTrackedRuntimeArtifacts = deps.listTrackedRuntimeArtifacts || listTrackedRuntimeArtifacts;

  const findings = {
    shellTemplateDrift: null,           // Check 1
    childHooksDrift: [],                // Check 2 — per-child
    childMcpPointer: [],                // Check 3 — per-child
    childRegistryPresence: [],          // Check 4 — per-child
    childSchemaVersion: [],             // Check 5 — per-child
    childHookRegistration: [],          // Check 6 — per-child
    childPermissionAllow: [],           // Check 7 — per-child
    childVitestShim: [],                // Check 8 — per-child
    childRuntimeGitignore: [],          // Check 9a — per-child
    childTrackedRuntimeArtifacts: [],   // Check 9b — per-child (report only)
    nonRecoverable: [],                 // pinned drift, etc.
    succeeded: 0,
    failed: 0,
    appliedFixers: [],
  };

  // Check 1: shell-side template drift.
  const canonicalHooks = path.join(shellRoot, "packages", "hooks");
  const templateHooks = path.join(shellRoot, "templates", "generic", ".routekit", "hooks");
  try {
    const drift1 = _checkDrift(canonicalHooks, templateHooks);
    findings.shellTemplateDrift = drift1;
    if (!drift1.ok) {
      if (dryRun) {
        findings.appliedFixers.push({ check: 1, fixer: "syncHooks", dryRun: true });
      } else {
        try {
          _syncHooks(canonicalHooks, templateHooks);
          findings.appliedFixers.push({ check: 1, fixer: "syncHooks" });
          findings.succeeded += 1;
        } catch (err) {
          findings.failed += 1;
          findings.nonRecoverable.push({ check: 1, reason: err?.message || String(err) });
        }
      }
    }
  } catch (err) {
    findings.shellTemplateDrift = { ok: false, error: err?.message || String(err) };
    findings.failed += 1;
  }

  // The shell's hook manifest — Check 6's authority for name → tiered path.
  // Loaded once; its ABSENCE is a per-child failure, never a per-child pass (see below).
  const hookManifest = _loadHookManifest(shellRoot);
  const canonicalRegistration = hookManifest ? buildHookRegistration(hookManifest) : null;

  // Iterate registered children for Checks 2-6.
  const registered = _loadProjects(shellRoot);
  const childRoots = new Map(registered.map((r) => [r.id, r.root || r.path]));

  for (const record of registered) {
    const childRoot = record.root || record.path;
    if (!childRoot || !fs.existsSync(childRoot)) continue;

    // backlog.fix.shell-self-sync-skill-wipe-health-gate: THE SHELL IS NOT ONE OF ITS OWN CHILDREN.
    //
    // `setup.mjs` registers the shell in its own registry, and `loadProjects` returns every record
    // unfiltered — so without this the shell arrives here as a "child" and gets the full fixer
    // treatment: syncProject wipes its skills (projectRoot === shellRoot), and migrateConfig writes
    // its .rks/project.json. That is why this is a whole-record `continue` at the TOP of the loop and
    // not a check in front of the sync alone: Checks 3 and 5 mutate the shell too.
    //
    // Skipping BEFORE the fixer also matters for the report. syncProject now refuses loudly, and the
    // Check-2 catch below books any throw as findings.failed + nonRecoverable — so merely letting it
    // throw would make `routekit doctor` report a permanent, unfixable failure against the shell on
    // every single run, on the very tool that is supposed to tell you the ecosystem is healthy.
    if (sameDirectory(childRoot, shellRoot)) {
      findings.skippedShellRecord = { id: record.id, root: childRoot };
      continue;
    }

    // Check 2: per-child hooks drift.
    const childHooks = path.join(childRoot, ".routekit", "hooks");
    if (fs.existsSync(childHooks)) {
      try {
        const drift2 = _checkDrift(templateHooks, childHooks);
        findings.childHooksDrift.push({ id: record.id, drift: drift2 });
        if (!drift2.ok) {
          if (dryRun) {
            findings.appliedFixers.push({ check: 2, id: record.id, fixer: "syncProject", dryRun: true });
          } else {
            try {
              _syncProject({ projectRoot: childRoot, projectId: record.id, shellRoot });
              findings.appliedFixers.push({ check: 2, id: record.id, fixer: "syncProject" });
              findings.succeeded += 1;
            } catch (err) {
              findings.failed += 1;
              findings.nonRecoverable.push({ check: 2, id: record.id, reason: err?.message || String(err) });
            }
          }
        }
      } catch (err) {
        findings.failed += 1;
      }
    }

    // Check 6: per-child hook REGISTRATION.
    // backlog.fix.child-hook-registration-repair-and-audit
    //
    // Same precondition as Check 2 — the child has .routekit/hooks, i.e. rks claims to
    // govern it. Check 2 then asks whether the SCRIPTS are current; this asks whether
    // any of them are actually wired up. Only when there is no .routekit/hooks at all is
    // this check skipped, because then rks makes no claim about the project.
    if (fs.existsSync(childHooks)) {
      if (!hookManifest) {
        // ANTI-ABSTENTION. A check that cannot see the failure state must FAIL, never
        // pass. core_skills in preflight.mjs does the opposite — it sets skillsPassed on
        // manifest_missing, so a child with zero skills gets a green check. Reproducing
        // that shape here would recreate the exact bug this check exists to catch.
        // Non-recoverable by construction: with no manifest there is nothing to write.
        const reason = "shell hook manifest could not be loaded — child hook registration is UNVERIFIABLE (not a pass)";
        findings.childHookRegistration.push({ id: record.id, ok: false, reason, recoverable: false });
        findings.nonRecoverable.push({ check: 6, id: record.id, reason });
        findings.failed += 1;
      } else {
        try {
          const reg = _inspectHookRegistration({
            childRoot,
            manifest: hookManifest,
            canonical: canonicalRegistration,
          });
          findings.childHookRegistration.push({ id: record.id, ...reg });
          if (!reg.ok) {
            if (reg.recoverable === false) {
              findings.nonRecoverable.push({ check: 6, id: record.id, reason: reg.reason });
              findings.failed += 1;
            } else if (dryRun) {
              findings.appliedFixers.push({ check: 6, id: record.id, fixer: "ensureHookRegistration", dryRun: true });
            } else {
              try {
                _ensureHookRegistration({
                  settingsPath: path.join(childRoot, ".claude", "settings.json"),
                  manifest: hookManifest,
                });
                // VERIFY the repair rather than assume it. A fixer that RAN is not a child
                // that is GOVERNED: if the registration is still absent, incomplete or
                // unresolvable afterwards — e.g. the hook scripts are not actually on disk
                // in the child — booking `succeeded` here would be this story's own bug,
                // a check certifying health it never observed.
                const after = _inspectHookRegistration({
                  childRoot,
                  manifest: hookManifest,
                  canonical: canonicalRegistration,
                });
                if (after.ok) {
                  findings.appliedFixers.push({ check: 6, id: record.id, fixer: "ensureHookRegistration" });
                  findings.succeeded += 1;
                } else {
                  findings.failed += 1;
                  findings.nonRecoverable.push({
                    check: 6,
                    id: record.id,
                    reason: `hook registration still invalid after repair: ${after.reason}`,
                  });
                }
              } catch (err) {
                findings.failed += 1;
                findings.nonRecoverable.push({ check: 6, id: record.id, reason: err?.message || String(err) });
              }
            }
          }
        } catch (err) {
          findings.childHookRegistration.push({ id: record.id, ok: false, reason: err?.message || String(err), recoverable: false });
          findings.failed += 1;
        }
      }
    }

    // Check 7: per-child rks PERMISSION rules (wildcard allow + checkpoint ask).
    // backlog.fix.child-rks-permission-allow-list
    //
    // Same precondition as Checks 2 and 6: only a child with .routekit/hooks is one rks
    // claims to govern, so doctor never creates or edits settings.json anywhere else.
    // Additive only — the fixer never removes, reorders or rewrites an entry.
    if (fs.existsSync(childHooks)) {
      const permArgs = {
        settingsPath: path.join(childRoot, ".claude", "settings.json"),
        localSettingsPath: path.join(childRoot, ".claude", "settings.local.json"),
        projectConfig: readChildProjectConfig(childRoot),
      };
      try {
        const plan = planRksPermissionMerge(permArgs);
        if (!plan.ok && plan.reason === "opted-out") {
          // An explicit opt-out is reported, never repaired, and is not a failure.
          findings.childPermissionAllow.push({ id: record.id, ok: true, reason: "opted-out", missing: [] });
        } else if (!plan.ok) {
          const reason = `${plan.file} is unparseable — rks permission merge REFUSED (file left untouched)`;
          findings.childPermissionAllow.push({ id: record.id, ok: false, reason, file: plan.file, missing: [] });
          findings.nonRecoverable.push({ check: 7, id: record.id, reason });
          findings.failed += 1;
        } else {
          const missing = [...plan.added, ...plan.addedAsk];
          findings.childPermissionAllow.push({ id: record.id, ok: missing.length === 0, missing });
          if (missing.length > 0) {
            if (dryRun) {
              findings.appliedFixers.push({ check: 7, id: record.id, fixer: "mergeRksPermissionAllow", dryRun: true });
            } else {
              try {
                _mergeRksPermissionAllow(permArgs);
                // VERIFY, like Check 6: a fixer that ran is not a child that is repaired.
                const after = planRksPermissionMerge(permArgs);
                const stillMissing = after.ok ? [...after.added, ...after.addedAsk] : null;
                if (stillMissing && stillMissing.length === 0) {
                  findings.appliedFixers.push({ check: 7, id: record.id, fixer: "mergeRksPermissionAllow" });
                  findings.succeeded += 1;
                } else {
                  findings.failed += 1;
                  findings.nonRecoverable.push({
                    check: 7,
                    id: record.id,
                    reason: `rks permission rules still missing after repair: ${
                      stillMissing ? stillMissing.join(", ") : after.reason
                    }`,
                  });
                }
              } catch (err) {
                findings.failed += 1;
                findings.nonRecoverable.push({ check: 7, id: record.id, reason: err?.message || String(err) });
              }
            }
          }
        }
      } catch (err) {
        findings.childPermissionAllow.push({ id: record.id, ok: false, reason: err?.message || String(err), missing: [] });
        findings.failed += 1;
      }
    }

    // Check 3: .mcp.json shell pointer.
    const mcp = checkMcpPointer(childRoot, shellRoot);
    findings.childMcpPointer.push({ id: record.id, ...mcp });
    if (mcp.exists && !mcp.healthy) {
      const pinned = _isPinned(childRoot);
      if (pinned) {
        findings.nonRecoverable.push({
          check: 3,
          id: record.id,
          reason: "pinned:true — refusing to repin .mcp.json (explicit opt-out)",
        });
        findings.failed += 1;
      } else if (dryRun) {
        findings.appliedFixers.push({ check: 3, id: record.id, fixer: "repinMcpServer", dryRun: true });
      } else {
        try {
          _repinMcpServer({ projectRoot: childRoot, shellRoot });
          findings.appliedFixers.push({ check: 3, id: record.id, fixer: "repinMcpServer" });
          findings.succeeded += 1;
        } catch (err) {
          findings.failed += 1;
          findings.nonRecoverable.push({ check: 3, id: record.id, reason: err?.message || String(err) });
        }
      }
    }

    // Check 5: schemaVersion (handled by migrateConfig — noOp means clean).
    try {
      // Probe via migrateConfig in dry-mode-equivalent: we don't have a true
      // dryRun on migrateConfig itself, so for dryRun we call it and treat
      // any non-noOp result as "would migrate" without committing the result.
      // In wet mode (the common path) we just invoke it; noOp means clean.
      if (dryRun) {
        // To stay strictly read-only, skip the call entirely in dry mode and
        // only record a structural finding: the child's schemaVersion is
        // unknown without reading metadata. Best-effort: try migrateConfig
        // and capture the result but be aware migrateConfig writes if non-noop.
        // Since we cannot avoid writes without modifying migrateConfig, dry
        // mode for Check 5 reports "not checked under --dry-run" to be safe.
        findings.childSchemaVersion.push({ id: record.id, status: "skipped-under-dry-run" });
      } else {
        const result = _migrateConfig({ projectRoot: childRoot });
        findings.childSchemaVersion.push({ id: record.id, result });
        if (!result.noOp) {
          findings.appliedFixers.push({ check: 5, id: record.id, fixer: "migrateConfig" });
          findings.succeeded += 1;
        }
      }
    } catch (err) {
      findings.childSchemaVersion.push({ id: record.id, error: err?.message || String(err) });
      findings.failed += 1;
    }

    // Check 8: per-child vitest files. backlog.fix.upgrade-never-restores-vitest-unit-shim
    //
    // Exec builds scoped test runs as `scripts/vitest-runner.mjs --config vitest.config.unit.mjs`,
    // so a child missing any of these files fails every such run. Seed-when-absent only — the
    // fixer NEVER overwrites a customised file. A fix is booked only for files the fixer
    // OBSERVED as created; a missing shell template is reported on the entry but is not a
    // failure (it is not the child's defect, and there is nothing to write).
    const vitestMissing = VITEST_SEED_DESTINATIONS.filter((rel) => !fs.existsSync(path.join(childRoot, rel)));
    if (vitestMissing.length > 0) {
      const entry = { id: record.id, missing: vitestMissing };
      findings.childVitestShim.push(entry);
      if (dryRun) {
        findings.appliedFixers.push({ check: 8, id: record.id, fixer: "seedVitestFiles", dryRun: true });
      } else {
        try {
          const seeded = _seedVitestFiles({ projectRoot: childRoot, shellRoot }) || {};
          entry.created = seeded.created || [];
          entry.templateMissing = seeded.templateMissing || [];
          if (entry.created.length > 0) {
            findings.appliedFixers.push({ check: 8, id: record.id, fixer: "seedVitestFiles" });
            findings.succeeded += 1;
          }
        } catch (err) {
          entry.error = err?.message || String(err);
          findings.failed += 1;
          findings.nonRecoverable.push({ check: 8, id: record.id, reason: entry.error });
        }
      }
    }

    // Check 9a: child .gitignore runtime rules.
    // backlog.fix.doctor-child-runtime-gitignore-repair-and-tracked-audit
    //
    // Append-only and idempotent: existing bytes stay an exact prefix, nothing is removed or
    // rewritten. A content-only child's .gitignore is client content and is never touched.
    if (readContentOnly(childRoot)) {
      findings.childRuntimeGitignore.push({ id: record.id, ok: true, reason: "content-only" });
    } else {
      let inspected = null;
      try {
        inspected = inspectChildGitignore(childRoot);
      } catch (err) {
        const reason = `cannot read .gitignore: ${err?.message || String(err)}`;
        findings.childRuntimeGitignore.push({ id: record.id, ok: false, missing: [], reason });
        findings.failed += 1;
        findings.nonRecoverable.push({ check: 9, id: record.id, reason });
      }
      if (inspected && inspected.missing.length === 0) {
        findings.childRuntimeGitignore.push({ id: record.id, ok: true, missing: [] });
      } else if (inspected && dryRun) {
        findings.childRuntimeGitignore.push({ id: record.id, ok: false, missing: inspected.missing, dryRun: true });
        findings.appliedFixers.push({ check: 9, id: record.id, fixer: "repairChildGitignore", dryRun: true });
      } else if (inspected) {
        try {
          const added = repairChildGitignore(childRoot, inspected.missing);
          // VERIFY, like Checks 6 and 7: a fixer that ran is not a child that is repaired.
          const after = inspectChildGitignore(childRoot);
          if (after.missing.length === 0) {
            findings.childRuntimeGitignore.push({ id: record.id, ok: true, missing: [], added });
            findings.appliedFixers.push({ check: 9, id: record.id, fixer: "repairChildGitignore" });
            findings.succeeded += 1;
          } else {
            const reason = "still missing after repair";
            findings.childRuntimeGitignore.push({ id: record.id, ok: false, missing: after.missing, reason });
            findings.failed += 1;
            findings.nonRecoverable.push({ check: 9, id: record.id, reason });
          }
        } catch (err) {
          const reason = `repair failed: ${err?.message || String(err)}`;
          findings.childRuntimeGitignore.push({ id: record.id, ok: false, missing: inspected.missing, reason });
          findings.failed += 1;
          findings.nonRecoverable.push({ check: 9, id: record.id, reason });
        }
      }
    }

    // Check 9b: runtime artifacts already in the child's git index. REPORT ONLY — doctor never
    // runs git rm / update-index / filter-repo or any other index or history mutation, in either
    // mode. Runs for content-only children too. A skip (non-git child, git unavailable) is not a
    // failure; an ls-files failure inside a work tree is never folded into a skip or a clean audit.
    let audit;
    try {
      audit = _listTrackedRuntimeArtifacts(childRoot);
    } catch (err) {
      audit = { error: true, reason: `git ls-files failed: ${err?.message || String(err)}` };
    }
    if (audit && audit.error) {
      const reason = typeof audit.reason === "string" && audit.reason ? audit.reason : "git ls-files failed: unknown error";
      findings.childTrackedRuntimeArtifacts.push({ id: record.id, error: true, reason });
      findings.nonRecoverable.push({ check: 9, id: record.id, reason });
    } else if (audit && audit.skipped) {
      const reason = typeof audit.reason === "string" && audit.reason ? audit.reason : "audit skipped";
      findings.childTrackedRuntimeArtifacts.push({ id: record.id, skipped: true, reason });
    } else if (audit && Array.isArray(audit.files)) {
      const files = [...audit.files];
      findings.childTrackedRuntimeArtifacts.push({ id: record.id, files });
      if (files.length > 0) {
        const reason =
          `${files.length} rks runtime artifact(s) tracked in the git index: ${files.join(", ")}. ` +
          "Reported only — untracking (git rm --cached) and any history rewrite are the user's decision; doctor never untracks.";
        findings.nonRecoverable.push({ check: 9, id: record.id, reason, files });
      }
    } else {
      // Not a recognised shape: the audit cannot be claimed clean.
      const reason = "git ls-files failed: unrecognised audit result";
      findings.childTrackedRuntimeArtifacts.push({ id: record.id, error: true, reason });
      findings.nonRecoverable.push({ check: 9, id: record.id, reason });
    }
  }

  // Check 4: registry presence — children-on-disk that aren't in the
  // registry. Without an external source-of-truth (e.g. a workspace manifest)
  // this check has nothing concrete to compare against; we expose the hook
  // for future expansion via deps.findUnregisteredChildren. Today: no-op
  // unless a candidate list is provided.
  const candidates = (deps.findUnregisteredChildren ? deps.findUnregisteredChildren(shellRoot) : []) || [];
  for (const candidate of candidates) {
    if (childRoots.has(candidate.id)) continue;
    findings.childRegistryPresence.push({ id: candidate.id, root: candidate.root, missing: true });
    if (dryRun) {
      findings.appliedFixers.push({ check: 4, id: candidate.id, fixer: "upsertProject", dryRun: true });
    } else {
      try {
        _upsertProject({ id: candidate.id, root: candidate.root, stack: candidate.stack || null }, shellRoot);
        findings.appliedFixers.push({ check: 4, id: candidate.id, fixer: "upsertProject" });
        findings.succeeded += 1;
      } catch (err) {
        findings.failed += 1;
        findings.nonRecoverable.push({ check: 4, id: candidate.id, reason: err?.message || String(err) });
      }
    }
  }

  // Compose exit-code summary.
  const exitCode = findings.failed === 0 && findings.nonRecoverable.length === 0 ? 0 : 1;

  return {
    ok: exitCode === 0,
    dryRun,
    findings,
    exitCode,
  };
}

// Re-exports for ergonomic test access.
export { isPinned, checkMcpPointer };
export { ensureHookRegistration };
