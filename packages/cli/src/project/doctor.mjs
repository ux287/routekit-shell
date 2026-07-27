/**
 * doctor.mjs — `routekit doctor`: diagnose the full child-project ecosystem
 * and auto-invoke the four Tier 2 fixers by default.
 *
 * Five checks:
 *   1. Shell-side template drift  → fixer: syncHooks(packages/hooks → templates/generic)
 *   2. Per-child hooks drift      → fixer: syncProject
 *   3. Per-child .mcp.json pointer → fixer: repinMcpServer (skipped when pinned:true)
 *   4. Per-child registry presence → fixer: upsertProject (NOT add-existing handler)
 *   5. Per-child schemaVersion    → fixer: migrateConfig
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

/**
 * Run all five doctor checks against the given shell.
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

  const findings = {
    shellTemplateDrift: null,           // Check 1
    childHooksDrift: [],                // Check 2 — per-child
    childMcpPointer: [],                // Check 3 — per-child
    childRegistryPresence: [],          // Check 4 — per-child
    childSchemaVersion: [],             // Check 5 — per-child
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

  // Iterate registered children for Checks 2-5.
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
