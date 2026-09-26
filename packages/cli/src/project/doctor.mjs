/**
 * doctor.mjs — `routekit doctor`: diagnose the full child-project ecosystem
 * and auto-invoke the four Tier 2 fixers by default.
 *
 * Six checks:
 *   1. Shell-side template drift  → fixer: syncHooks(packages/hooks → templates/generic)
 *   2. Per-child hooks drift      → fixer: syncProject
 *   3. Per-child .mcp.json pointer → fixer: repinMcpServer (skipped when pinned:true)
 *   4. Per-child registry presence → fixer: upsertProject (NOT add-existing handler)
 *   5. Per-child schemaVersion    → fixer: migrateConfig
 *   6. Per-child hook REGISTRATION → fixer: ensureHookRegistration
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
import { buildHookRegistration, ensureHookRegistration, loadHookManifest } from "./bootstrap.mjs";

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

  const findings = {
    shellTemplateDrift: null,           // Check 1
    childHooksDrift: [],                // Check 2 — per-child
    childMcpPointer: [],                // Check 3 — per-child
    childRegistryPresence: [],          // Check 4 — per-child
    childSchemaVersion: [],             // Check 5 — per-child
    childHookRegistration: [],          // Check 6 — per-child
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
