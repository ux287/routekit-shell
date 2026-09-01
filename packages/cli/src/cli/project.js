import path from "path";
import fs from "fs";
import { initProjectFromStack } from "../project/init-stack.js";
import { verifyById, verifyProjectRoot } from "../project/verify.js";
import { resolveProjectRoot } from "../project/resolve-project-root.mjs";
import { attachProject } from "../project/bootstrap.mjs";
import { syncProject, sameDirectory } from "../project/sync.mjs";
import { repinMcpServer } from "../project/repin-mcp.mjs";
import { migrateConfig } from "../project/migrate-config.mjs";
import { upgradeProject } from "../project/upgrade.mjs";
import { parseVendorOptions } from "./vendor-options.mjs";
import { listTemplates } from "../../../mcp-rks/src/templates.mjs";

/**
 * Resolve the CONTENT source shell root for sync/upgrade. `--from-release <path>` (alias
 * `--shell-root`) overrides WHERE hooks/skills/prompts/version are copied FROM (e.g. a checked-out
 * release), WITHOUT changing which children the registry resolves — child resolution stays on the
 * default SHELL_ROOT (whose registry has the children). When the flag is absent, the content source
 * IS SHELL_ROOT (today's behavior, backward compatible). This is the decoupling of SHELL_ROOT's two
 * previously-conflated roles: registry source vs content/version source.
 * @returns {{ ok: true, shellRoot: string } | { ok: false, error: string }}
 */
/**
 * backlog.feat.project-adopt-verb — infer a registry `stack` for an already-bootstrapped child.
 *
 * `--stack` is scaffold-time metadata: it selects a template skeleton. Re-registering a child that
 * already exists has no template to select, so demanding the flag made the documented recovery path
 * fail on a usage error with nothing useful to supply.
 *
 * Returns null when the target is NOT bootstrapped — the caller then insists on an explicit --stack,
 * because for a genuinely new registration the value is a real choice, not a formality.
 */
function inferStackFromProject(absPath) {
  try {
    const rksJson = path.join(absPath, ".rks", "project.json");
    if (!fs.existsSync(rksJson)) return null;
    const cfg = JSON.parse(fs.readFileSync(rksJson, "utf8"));
    if (!cfg?.id || !cfg?.kgFile) return null; // not bootstrapped
    if (cfg.stack) return String(cfg.stack);
    // The kg the project already points at names its own stack for templated projects.
    const kgPath = path.resolve(absPath, cfg.kgFile);
    if (fs.existsSync(kgPath)) {
      const match = fs.readFileSync(kgPath, "utf8").match(/^\s*stack:\s*(\S+)\s*$/m);
      if (match) return match[1].replace(/^["']|["']$/g, "");
    }
    // Bootstrapped but unstacked (hand-rolled layouts like a notes/agent project). `base` is the
    // unopinionated template and the registry's `stack` is metadata, not behavior.
    return "base";
  } catch {
    return null;
  }
}

/** The shell's own release version, for pre-mutation disclosure. Null when unreadable. */
function readShellVersionAt(shellRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(shellRoot, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** Whether a child has opted out of automatic re-pointing via `pinned: true`. */
function isPinnedChild(absPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(absPath, ".rks", "project.json"), "utf8"));
    return cfg?.pinned === true;
  } catch {
    return false;
  }
}

function resolveContentShellRoot(kv, SHELL_ROOT) {
  const raw = kv["from-release"] ?? kv["shell-root"];
  if (!raw || raw === true) {
    if (raw === true) return { ok: false, error: "--from-release requires a path to the release shell root" };
    return { ok: true, shellRoot: SHELL_ROOT };
  }
  const abs = path.resolve(String(raw));
  if (!fs.existsSync(abs) || !fs.existsSync(path.join(abs, "package.json"))) {
    return { ok: false, error: `--from-release: not a valid rks shell root (no package.json at ${abs})` };
  }
  return { ok: true, shellRoot: abs };
}

export async function handleProjectCommand({ sub, kv, SHELL_ROOT, args = [] } = {}, deps = {}) {
  const processExit = deps.processExit ?? process.exit;
  const {
    initProjectFromStack: DI_initProjectFromStack,
    listTemplates: DI_listTemplates,
    attachProject: DI_attachProject,
    verifyProjectRoot: DI_verifyProjectRoot,
    verifyById: DI_verifyById,
    syncProject: DI_syncProject,
    repinMcpServer: DI_repinMcpServer,
    getProjectById: DI_getProjectById,
    loadProjects: DI_loadProjects,
    migrateConfig: DI_migrateConfig,
    upgradeProject: DI_upgradeProject,
  } = deps;
  const _initProjectFromStack = DI_initProjectFromStack || initProjectFromStack;
  const _listTemplates = DI_listTemplates || listTemplates;
  // attachProject is the core primitive - both init and attach use it
  const _attachProject = DI_attachProject || attachProject;
  const _verifyProjectRoot = DI_verifyProjectRoot || verifyProjectRoot;
  const _verifyById = DI_verifyById || verifyById;
  const _syncProject = DI_syncProject || syncProject;
  const _repinMcpServer = DI_repinMcpServer || repinMcpServer;
  const _migrateConfig = DI_migrateConfig || migrateConfig;
  const _upgradeProject = DI_upgradeProject || upgradeProject;
  if (sub === "init") {
    const id = kv.id;
    const stackId = kv.stack;
    const targetPath = kv.path;
    const vendorOpts = parseVendorOptions(kv);
    if (!id || !stackId || !targetPath) {
      console.error(
        "usage: routekit project init --id <id> --stack <stackId> --path <targetPath> [--vendor[=subtree|copy] --vendor-ref <ref> --vendor-remote <url> --git-init] [--yes]"
      );
      processExit(1);
    }
    try {
      const scaffold = await _initProjectFromStack({
        shellRoot: SHELL_ROOT,
        id,
        stackId,
        targetPath,
      });
      const template = _listTemplates(SHELL_ROOT).find((t) => t.stackId === stackId) || { stackId };
      const dev = Boolean(kv.dev);
      const branchModel = kv["branch-model"] || "3-branch";
      const boot = await _attachProject({
        shellRoot: SHELL_ROOT,
        projectRoot: scaffold.targetPath,
        projectId: id,
        stackId,
        stackTemplate: template,
        dev,
        branchModel,
        vendor: vendorOpts.mode,
        vendorRef: vendorOpts.vendorRef,
        vendorRemote: vendorOpts.vendorRemote,
        gitInit: vendorOpts.gitInit,
        yes: vendorOpts.yes,
      });
      console.log(`Created project '${id}' from stack '${stackId}'.`);
      console.log(`Path: ${scaffold.targetPath}`);
      // Make the shell registry target explicit so a mis-resolved SHELL_ROOT
      // (e.g. a global `routekit` link pointing at a different shell) is visible
      // rather than a silent no-show in `routekit project list`/`doctor`/`repin-mcp`.
      const { resolveRegistryPath: _resolveRegistryPath } = await import("../project/index.js");
      console.log(`Registered in shell registry: ${_resolveRegistryPath(SHELL_ROOT)}`);
      if (boot?.gitBootstrap?.bootstrapped) {
        console.log(`Git: initialized on '${boot.gitBootstrap.working}' with baseline commit (branches: ${boot.gitBootstrap.branches.join(", ")}).`);
      }
      const verify = _verifyProjectRoot(scaffold.targetPath, { projectId: id });
      console.log(JSON.stringify({ verify, vendor: boot.vendor }, null, 2));
      console.log("Next steps: run npm install inside the project when you're ready.");
      processExit(0);
    } catch (error) {
      console.error(error.message || error);
      processExit(1);
    }
  }

  if (sub === "attach") {
    const positionalId = args[2] && !String(args[2]).startsWith("--") ? String(args[2]) : null;
    const positionalPath = args[3] && !String(args[3]).startsWith("--") ? String(args[3]) : null;
    const projectId = typeof kv.id === "string" ? kv.id : positionalId;
    const projectPath = typeof kv.path === "string" ? kv.path : positionalPath;
    const stackId = typeof kv.stack === "string" ? kv.stack : null;
    const vendorOpts = parseVendorOptions(kv);

    const dev = Boolean(kv.dev);

    if (!projectId || !projectPath) {
      console.error(
        "usage: routekit project attach --id <id> --path <abs> [--stack <stackId>] [--vendor[=subtree|copy] --vendor-ref <ref> --vendor-remote <url> --git-init] [--yes] [--dev]"
      );
      processExit(2);
    }
    const projectRoot = path.resolve(projectPath);
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      console.error(`project path not found or not a directory: ${projectRoot}`);
      processExit(1);
    }

    let stackTemplate = null;
    if (stackId) {
      const templates = listTemplates(SHELL_ROOT);
      const template = templates.find((t) => t.stackId === stackId);
      if (!template) {
        console.error(`Unknown stack: ${stackId}`);
        console.error(`Available: ${templates.map((t) => t.stackId).sort().join(", ")}`);
        process.exit(2);
      }
      stackTemplate = template;
    }

    const branchModel = kv["branch-model"] || "3-branch";
    try {
      const boot = await _attachProject({
        shellRoot: SHELL_ROOT,
        projectRoot,
        projectId,
        stackId,
        stackTemplate: stackTemplate ? { ...stackTemplate, stackId } : stackId ? { stackId } : null,
        vendor: vendorOpts.mode,
        vendorRef: vendorOpts.vendorRef,
        vendorRemote: vendorOpts.vendorRemote,
        gitInit: vendorOpts.gitInit,
        yes: vendorOpts.yes,
        dev,
        branchModel,
      });
      console.log(`Attached project '${projectId}' at ${projectRoot}`);
      const verify = _verifyProjectRoot(projectRoot, { projectId });
      console.log(JSON.stringify({ verify, vendor: boot.vendor }, null, 2));
      processExit(0);
    } catch (err) {
      console.error(`project attach failed: ${err?.message || err}`);
      processExit(1);
    }
  }

  if (sub === "verify") {
    const strict = Boolean(kv.strict);
    const json = Boolean(kv.json);
    const verbose = Boolean(kv.verbose);
    const id = typeof kv.id === "string" ? kv.id : null;
    let resolved = null;
    let result = null;

    if (id) {
      result = _verifyById({ projectId: id, shellRoot: SHELL_ROOT, strict });
    } else {
      resolved = resolveProjectRoot({ cwd: process.cwd(), env: process.env });
      result = _verifyProjectRoot(resolved.projectRoot, { strict });
      // attach resolution info so --json and humans can see where the root came from
      result._resolution = resolved;
    }

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      processExit(result.status === "fail" ? 1 : 0);
    }

    // show resolved project root and reason when available
    if (result._resolution) {
      console.log(`Resolved projectRoot: ${result._resolution.projectRoot} (reason: ${result._resolution.reason})`);
    }

    const summary = `${result.status.toUpperCase()}: ${result.projectId || "(unknown project)"} (${result.projectRoot || ""})`;
    console.log(summary);

    for (const check of result.checks) {
      // only show passing checks when --verbose is passed
      if (!verbose && check.status === "ok") continue;
      console.log(`- ${check.status}: ${check.id} ${check.message ? `— ${check.message}` : ""}`.trim());
      if (check.details) {
        if (check.details.suggestion) console.log(`  suggestion: ${check.details.suggestion}`);
        if (check.details.path) console.log(`  path: ${check.details.path}`);
      }
    }

    processExit(result.status === "fail" ? 1 : 0);
  }

  if (sub === "list") {
    const { loadProjects } = await import("../project/index.js");
    const projects = loadProjects(SHELL_ROOT);
    if (!projects.length) {
      console.log("No projects found.");
      processExit(0);
    }
    const sorted = [...projects].sort((a, b) => (a.id || "").localeCompare(b.id || ""));
    const header = "ID               STACK               PATH";
    const rows = sorted.map((p) => {
      const id = (p.id || "").padEnd(17);
      const stack = (p.stack || p.template || "(unknown)").padEnd(20);
      const root = p.root || p.path || "";
      return `${id} ${stack} ${root}`;
    });
    console.log([header, ...rows].join("\n"));
    processExit(0);
  }

  if (sub === "info") {
    const id = kv.id;
    if (!id) {
      console.error("usage: routekit project info --id <id>");
      processExit(1);
    }
    const { getProjectById } = await import("../project/index.js");
    const project = getProjectById(id, SHELL_ROOT);
    if (!project) {
      console.error(`Project not found: ${id}`);
      processExit(1);
    }
    console.log(JSON.stringify(project, null, 2));
    processExit(0);
  }

  if (sub === "add-existing") {
    const id = kv.id;
    const projectPath = kv.path;
    if (!id || !projectPath) {
      console.error("usage: routekit project add-existing --id <id> --path <absPath> [--stack <stackId>]");
      processExit(1);
    }
    const absPath = path.resolve(projectPath);
    if (!fs.existsSync(absPath)) {
      console.error(`Path not found: ${absPath}`);
      processExit(2);
    }
    // A supplied --stack is written VERBATIM and never validated against listTemplates(). attach
    // hard-rejects an unknown stack with exit 2; replicating that here would break live callers —
    // scripts/setup.mjs passes `--stack routekit-shell`, and existing registry rows carry `web` and
    // `legacy-stack`, none of which are templates.
    const stackId = kv.stack || inferStackFromProject(absPath);
    if (!stackId) {
      console.error(
        `--stack is required: ${absPath} is not bootstrapped, so there is no .rks/project.json to infer a stack from.\n` +
          `Either supply one explicitly:  routekit project add-existing --id ${id} --stack <stackId> --path ${absPath}\n` +
          `or bootstrap the project first: routekit project attach --id ${id} --path ${absPath}`,
      );
      // Explicit return: processExit is injectable, so a bare call does NOT halt under test — and
      // falling through here would append the very registry row this guard just refused.
      processExit(1);
      return;
    }
    const { upsertProject, resolveRegistryPath } = await import("../project/index.js");
    const record = {
      id,
      stack: stackId,
      root: absPath,
      path: absPath,
      addedAt: new Date().toISOString(),
    };
    upsertProject(record, SHELL_ROOT);
    console.log(`Registered project '${id}' at ${absPath} using stack '${stackId}'.`);
    // Which registry received the row. The CLI resolves SHELL_ROOT from its own install location,
    // NOT the cwd, so running this from inside one shell can legitimately write into another's
    // registry — silently, until now.
    console.log(`Registered in shell registry: ${resolveRegistryPath(SHELL_ROOT)}`);
    processExit(0);
  }

  if (sub === "migrate-registry") {
    const { loadProjects, writeRegistry, resolveRegistryPath } = await import("../project/index.js");
    const projects = loadProjects(SHELL_ROOT);
    if (!projects.length) {
      console.log("No registry records found.");
      processExit(0);
    }
    let updated = 0;
    const normalized = projects.map((proj) => {
      const next = { ...proj };
      const prev = JSON.stringify(proj);
      next.stack = next.stack || next.template || null;
      let root = next.root || next.path || null;
      if (root && !path.isAbsolute(root)) {
        root = path.resolve(SHELL_ROOT, root);
      }
      if (root) {
        next.root = root;
        next.path = root;
      }
      const curr = JSON.stringify(next);
      if (curr !== prev) updated += 1;
      return next;
    });
    const migratedRegistryPath = writeRegistry(normalized, SHELL_ROOT);
    console.log(`Migrated ${updated} project record(s).`);
    console.log(`Registered in shell registry: ${migratedRegistryPath || resolveRegistryPath(SHELL_ROOT)}`);
    processExit(0);
  }

  if (sub === "sync") {
    const id = kv.id;
    const all = kv.all === true || kv.all === "true";

    if (all && (id || kv.path)) {
      console.error("usage: routekit project sync --all  (mutually exclusive with --id and --path)");
      processExit(1);
      return;
    }

    const _content = resolveContentShellRoot(kv, SHELL_ROOT);
    if (!_content.ok) {
      console.error(_content.error);
      processExit(1);
      return;
    }
    const contentRoot = _content.shellRoot;

    if (all) {
      const _loadProjects = DI_loadProjects || (await import("../project/index.js")).loadProjects;
      const projects = _loadProjects(SHELL_ROOT);
      if (projects.length === 0) {
        console.log("No projects to sync.");
        processExit(0);
        return;
      }
      let succeeded = 0;
      let skipped = 0;
      const failures = [];
      for (const record of projects) {
        const childRoot = record.root || record.path;
        if (!childRoot || !fs.existsSync(childRoot)) {
          console.error(`  ${record.id}: FAILED — project root not found: ${childRoot || '(unset)'}`);
          failures.push(record.id);
          continue;
        }
        // backlog.fix.shell-self-sync-skill-wipe-health-gate: the shell registers itself in its own
        // registry (setup.mjs) and loadProjects returns every record, so without this the shell is
        // synced FROM ITSELF and its skills are deleted. A shell is not one of its own children.
        // (syncProject refuses this outright now; the skip keeps `--all` a clean success rather than
        // one loud failure per run that users learn to scroll past.)
        if (sameDirectory(childRoot, SHELL_ROOT)) {
          console.log(`  ${record.id}: skipped — this is the shell itself, not a child (update it with git)`);
          skipped += 1;
          continue;
        }
        try {
          const updated = _syncProject({ projectRoot: childRoot, projectId: record.id, shellRoot: contentRoot });
          console.log(`  ${record.id}: synced ${updated.length} file(s) into ${childRoot}`);
          succeeded += 1;
        } catch (err) {
          console.error(`  ${record.id}: FAILED — ${err?.message || err}`);
          failures.push(record.id);
        }
      }
      // The shell's own record is not a child, so it is not part of the denominator.
      const total = projects.length - skipped;
      const failedCount = failures.length;
      if (failedCount === 0) {
        console.log(`Synced ${succeeded}/${total} children.`);
        processExit(0);
      } else {
        console.log(`Synced ${succeeded}/${total} children; ${failedCount} failed.`);
        processExit(1);
      }
      return;
    }

    if (!id) {
      console.error("usage: routekit project sync --id <id> [--path <projectRoot>]  |  --all");
      processExit(1);
      return;
    }

    let projectRoot = kv.path ? path.resolve(kv.path) : null;
    if (!projectRoot) {
      const { getProjectById } = await import("../project/index.js");
      const record = getProjectById(id, SHELL_ROOT);
      if (!record) {
        console.error(`Project not found in registry: ${id}`);
        processExit(1);
        return;
      }
      projectRoot = record.root || record.path;
    }

    if (!fs.existsSync(projectRoot)) {
      console.error(`Project root not found: ${projectRoot}`);
      processExit(1);
      return;
    }

    try {
      const updatedFiles = _syncProject({ projectRoot, projectId: id, shellRoot: contentRoot });
      console.log(`Synced ${updatedFiles.length} file(s) into '${id}' at ${projectRoot}`);
      for (const f of updatedFiles) console.log(`  ${f}`);
      processExit(0);
    } catch (err) {
      console.error(`project sync failed: ${err?.message || err}`);
      processExit(1);
    }
  }

  if (sub === "migrate-config") {
    const id = kv.id;
    if (!id) {
      console.error("usage: routekit project migrate-config --id <id>");
      processExit(1);
      return;
    }
    const _getProjectById = DI_getProjectById || (await import("../project/index.js")).getProjectById;
    const record = _getProjectById(id, SHELL_ROOT);
    if (!record) {
      console.error(`Project not found in registry: ${id}`);
      processExit(1);
      return;
    }
    const projectRoot = record.root || record.path;
    try {
      const result = _migrateConfig({ projectRoot });
      if (result.noOp) {
        console.log(`'${id}' already at latest schemaVersion ${result.currentVersion} — no migrations applied.`);
      } else {
        console.log(`'${id}' migrated ${result.fromVersion} → ${result.currentVersion} (applied: ${result.applied.join(', ')})`);
      }
      processExit(0);
    } catch (err) {
      console.error(`project migrate-config failed: ${err?.message || err}`);
      processExit(1);
    }
    return;
  }

  if (sub === "repin-mcp") {
    const id = kv.id;
    if (!id) {
      console.error("usage: routekit project repin-mcp --id <id> [--shell <path>]");
      processExit(1);
      return;
    }
    const _getProjectById = DI_getProjectById || (await import("../project/index.js")).getProjectById;
    const record = _getProjectById(id, SHELL_ROOT);
    if (!record) {
      console.error(`Project not found in registry: ${id}`);
      processExit(1);
      return;
    }
    const projectRoot = record.root || record.path;
    const shellRoot = kv.shell ? path.resolve(kv.shell) : SHELL_ROOT;
    try {
      const result = _repinMcpServer({ projectRoot, shellRoot });
      if (result.changed) {
        console.log(`Repinned MCP server for '${id}' → ${shellRoot}`);
      } else {
        console.log(`'${id}' MCP server already pinned to ${shellRoot} — no change.`);
      }
      processExit(0);
    } catch (err) {
      console.error(`project repin-mcp failed: ${err?.message || err}`);
      processExit(1);
    }
  }

  if (sub === "upgrade") {
    const id = kv.id;
    const all = kv.all === true || kv.all === "true";

    if (all && (id || kv.path)) {
      console.error("usage: routekit project upgrade --all [--from-release <path>]  (mutually exclusive with --id and --path)");
      processExit(1);
      return;
    }

    // Content/version source: --from-release/--shell-root points at a checked-out release; child
    // resolution stays on the default SHELL_ROOT registry (which is where the children are).
    const _content = resolveContentShellRoot(kv, SHELL_ROOT);
    if (!_content.ok) {
      console.error(_content.error);
      processExit(1);
      return;
    }
    const contentRoot = _content.shellRoot;
    const opts = { dryRun: Boolean(kv["dry-run"]), noBackup: Boolean(kv["no-backup"]) };
    const _fromRelease = Boolean(kv["from-release"] || kv["shell-root"]);

    if (all) {
      const _loadProjects = DI_loadProjects || (await import("../project/index.js")).loadProjects;
      const projects = _loadProjects(SHELL_ROOT);
      if (projects.length === 0) {
        console.log("No projects to upgrade.");
        processExit(0);
        return;
      }
      let succeeded = 0;
      let skipped = 0;
      const failures = [];
      for (const record of projects) {
        const childRoot = record.root || record.path;
        if (!childRoot || !fs.existsSync(childRoot)) {
          console.error(`  ${record.id}: FAILED — project root not found: ${childRoot || '(unset)'}`);
          failures.push(record.id);
          continue;
        }
        // backlog.fix.shell-self-sync-skill-wipe-health-gate: same as `sync --all` above — the shell's
        // own registry record must never be upgraded as if it were a child. This is the command that
        // wiped the skills on the clean-machine UAT box.
        if (sameDirectory(childRoot, SHELL_ROOT)) {
          console.log(`  ${record.id}: skipped — this is the shell itself, not a child (update it with git)`);
          skipped += 1;
          continue;
        }
        try {
          const report = _upgradeProject({ projectRoot: childRoot, projectId: record.id, shellRoot: contentRoot, opts });
          if (report.shellRoot) console.log(`  ${record.id}: shell ${report.shellRoot}`);
          if (report.ok) {
            if (["none", "downgrade"].includes(report.boundary)) {
              console.log(`  ${record.id}: ${report.warnings.join("; ") || `already at ${report.to}`}`);
            } else {
              console.log(`  ${record.id}: ${report.from || "unstamped"} → ${report.to} [${report.boundary}]${report.dryRun ? " (dry-run)" : ""}`);
            }
            succeeded += 1;
          } else {
            console.error(`  ${record.id}: FAILED — ${report.warnings.join("; ")}`);
            failures.push(record.id);
          }
        } catch (err) {
          console.error(`  ${record.id}: FAILED — ${err?.message || err}`);
          failures.push(record.id);
        }
      }
      // The shell's own record is not a child, so it is not part of the denominator.
      const total = projects.length - skipped;
      if (failures.length === 0) {
        console.log(`Upgraded ${succeeded}/${total} children${_fromRelease ? ` from ${contentRoot}` : ""}.`);
        processExit(0);
      } else {
        console.log(`Upgraded ${succeeded}/${total} children; ${failures.length} failed.`);
        processExit(1);
      }
      return;
    }

    if (!id) {
      console.error("usage: routekit project upgrade --id <id> [--from-release <path>] [--dry-run] [--no-backup]  |  --all [--from-release <path>]");
      processExit(1);
      return;
    }
    const _getProjectById = DI_getProjectById || (await import("../project/index.js")).getProjectById;
    const record = _getProjectById(id, SHELL_ROOT);
    if (!record) {
      console.error(`Project not found in registry: ${id}`);
      processExit(1);
      return;
    }
    const projectRoot = record.root || record.path;
    try {
      const report = _upgradeProject({ projectRoot, projectId: id, shellRoot: contentRoot, opts });
      // Name the shell BEFORE the verdict. `Already at X — nothing to do.` was correct and useless
      // precisely because it never said which shell it compared against.
      if (report.shellRoot) console.log(`Shell: ${report.shellRoot} (${report.to || "version unreadable"})`);
      if (report.gated) {
        console.error(report.warnings.join("\n"));
      } else if (!report.ok) {
        console.error(`project upgrade could not proceed: ${report.warnings.join("; ")}`);
      } else if (["none", "downgrade"].includes(report.boundary)) {
        console.log(report.warnings.join("\n"));
      } else {
        console.log(
          `Upgraded '${id}' ${report.from || "unstamped"} → ${report.to} [${report.boundary}]${report.dryRun ? " (dry-run)" : ""}`
        );
        for (const f of report.reconciled) console.log(`  reconciled: ${f}`);
        for (const m of report.migrationsApplied) console.log(`  migration: ${m}`);
        if (report.backupPath) console.log(`  backup: ${report.backupPath}`);
        if (report.restartRequired) console.log(`  → restart the rks MCP server in '${id}' for changes to take effect.`);
        for (const w of report.warnings) console.log(`  warning: ${w}`);
      }
      processExit(report.ok ? 0 : 1);
    } catch (err) {
      console.error(`project upgrade failed: ${err?.message || err}`);
      processExit(1);
    }
  }

  // backlog.feat.project-adopt-verb
  //
  // One verb for the single most common child operation: binding an existing project to a shell.
  // Previously this required discovering and correctly ORDERING four steps — add-existing, upgrade,
  // restart the child's MCP server, re-run rks_preflight — with no front door and two silent traps
  // (the registry written is the CLI's, not the cwd's; the upgrade compares against whichever shell
  // backs the CLI). adopt composes the existing verbs rather than replacing them, so anything already
  // scripted against add-existing/upgrade keeps working.
  //
  // Refusal order is load-bearing: BOTH refusals are computable from inputs alone and therefore run
  // before the registry write, which is adopt's first mutation. A refused adopt leaves zero state.
  if (sub === "adopt") {
    const id = kv.id;
    const projectPath = kv.path;
    if (!id || !projectPath) {
      console.error("usage: routekit project adopt --id <id> --path <path> [--stack <stackId>] [--force-repin] [--from-release <path>]");
      processExit(1);
      return;
    }
    const absPath = path.resolve(String(projectPath));
    if (!fs.existsSync(absPath)) {
      console.error(`Path not found: ${absPath}`);
      processExit(2);
      return;
    }

    const _content = resolveContentShellRoot(kv, SHELL_ROOT);
    if (!_content.ok) {
      console.error(_content.error);
      processExit(1);
      return;
    }
    const contentRoot = _content.shellRoot;
    const { upsertProject, resolveRegistryPath } = await import("../project/index.js");
    const registryPath = resolveRegistryPath(SHELL_ROOT);
    const shellVersion = readShellVersionAt(contentRoot);

    // --- pre-mutation disclosure: which shell, which registry, before anything is touched ---
    console.log(`Adopting '${id}' onto shell: ${contentRoot}${shellVersion ? ` (${shellVersion})` : ""}`);
    console.log(`Registered in shell registry: ${registryPath}`);

    // --- refusal 1: a shell is not one of its own children (dev+ino, not string equality) ---
    if (sameDirectory(absPath, SHELL_ROOT) || sameDirectory(absPath, contentRoot)) {
      console.error(
        `Refusing to adopt ${absPath}: a shell is not one of its own children.\n` +
          `Syncing a shell from itself deletes its own skills — update the shell with git instead.`,
      );
      processExit(1);
      return;
    }

    // --- refusal 2: honor an explicit pin ---
    const forceRepin = kv["force-repin"] === true || kv["force-repin"] === "true";
    if (isPinnedChild(absPath)) {
      if (!forceRepin) {
        console.error(
          `Refusing to adopt '${id}': its .rks/project.json sets pinned: true, so it is deliberately\n` +
            `bound to a specific shell. Nothing was changed — no registry row, no .mcp.json repoint.\n` +
            `Re-run with --force-repin to override, or clear the pin in ${path.join(absPath, ".rks", "project.json")}.`,
        );
        processExit(1);
        return;
      }
      console.log(`Overriding pinned: true because --force-repin was supplied.`);
    }

    const stackId = kv.stack || inferStackFromProject(absPath);
    if (!stackId) {
      console.error(
        `--stack is required: ${absPath} is not bootstrapped, so there is no .rks/project.json to infer a stack from.\n` +
          `Either supply one explicitly, or bootstrap first: routekit project attach --id ${id} --path ${absPath}`,
      );
      processExit(1);
      return;
    }

    try {
      // --- step 1: register in THIS shell's registry (upsert → idempotent, one row per id) ---
      upsertProject(
        { id, stack: stackId, root: absPath, path: absPath, addedAt: new Date().toISOString() },
        SHELL_ROOT,
      );
      console.log(`Registered '${id}' at ${absPath} using stack '${stackId}'.`);

      // --- step 2: upgrade (sync + repin + migrate + stamp) ---
      const report = _upgradeProject({ projectRoot: absPath, projectId: id, shellRoot: contentRoot, opts: {} });
      if (report.gated || !report.ok) {
        console.error(`adopt: upgrade step did not complete — ${report.warnings.join("; ")}`);
        processExit(1);
        return;
      }
      if (["none", "downgrade"].includes(report.boundary)) {
        console.log(report.warnings.join("\n"));
      } else {
        console.log(`Upgraded '${id}' ${report.from || "unstamped"} → ${report.to} [${report.boundary}]`);
        for (const f of report.reconciled) console.log(`  reconciled: ${f}`);
        for (const m of report.migrationsApplied) console.log(`  migration: ${m}`);
      }

      // --- step 3: the two manual steps, ALWAYS printed ---
      // Unconditional by design: on a boundary-'none' composition upgradeProject reports
      // restartRequired falsy, but adopt may still have just repointed the registry — a user who
      // skips the restart then sees stale behavior with nothing telling them why.
      console.log(`  → restart the rks MCP server in '${id}' for changes to take effect.`);
      console.log(`  → then run rks_preflight in '${id}' to verify — expect rksVersion ${report.to || shellVersion || "the shell's"}.`);
      processExit(0);
    } catch (err) {
      console.error(`project adopt failed: ${err?.message || err}`);
      processExit(1);
    }
  }
}
