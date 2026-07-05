import path from "path";
import fs from "fs";
import { initProjectFromStack } from "../project/init-stack.js";
import { verifyById, verifyProjectRoot } from "../project/verify.js";
import { resolveProjectRoot } from "../project/resolve-project-root.mjs";
import { attachProject } from "../project/bootstrap.mjs";
import { syncProject } from "../project/sync.mjs";
import { repinMcpServer } from "../project/repin-mcp.mjs";
import { migrateConfig } from "../project/migrate-config.mjs";
import { upgradeProject } from "../project/upgrade.mjs";
import { parseVendorOptions } from "./vendor-options.mjs";
import { listTemplates } from "../../../mcp-rks/src/templates.mjs";

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
      console.log(`Registered in shell registry: ${path.join(SHELL_ROOT, "projects", "index.jsonl")}`);
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
    const stackId = kv.stack;
    const projectPath = kv.path;
    if (!id || !stackId || !projectPath) {
      console.error("usage: routekit project add-existing --id <id> --stack <stackId> --path <absPath>");
      processExit(1);
    }
    const absPath = path.resolve(projectPath);
    if (!fs.existsSync(absPath)) {
      console.error(`Path not found: ${absPath}`);
      processExit(2);
    }
    const { upsertProject } = await import("../project/index.js");
    const record = {
      id,
      stack: stackId,
      root: absPath,
      path: absPath,
      addedAt: new Date().toISOString(),
    };
    upsertProject(record, SHELL_ROOT);
    console.log(`Registered project '${id}' at ${absPath} using stack '${stackId}'.`);
    processExit(0);
  }

  if (sub === "migrate-registry") {
    const { loadProjects, writeRegistry } = await import("../project/index.js");
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
    writeRegistry(normalized, SHELL_ROOT);
    console.log(`Migrated ${updated} project record(s).`);
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

    if (all) {
      const _loadProjects = DI_loadProjects || (await import("../project/index.js")).loadProjects;
      const projects = _loadProjects(SHELL_ROOT);
      if (projects.length === 0) {
        console.log("No projects to sync.");
        processExit(0);
        return;
      }
      let succeeded = 0;
      const failures = [];
      for (const record of projects) {
        const childRoot = record.root || record.path;
        if (!childRoot || !fs.existsSync(childRoot)) {
          console.error(`  ${record.id}: FAILED — project root not found: ${childRoot || '(unset)'}`);
          failures.push(record.id);
          continue;
        }
        try {
          const updated = _syncProject({ projectRoot: childRoot, projectId: record.id, shellRoot: SHELL_ROOT });
          console.log(`  ${record.id}: synced ${updated.length} file(s) into ${childRoot}`);
          succeeded += 1;
        } catch (err) {
          console.error(`  ${record.id}: FAILED — ${err?.message || err}`);
          failures.push(record.id);
        }
      }
      const total = projects.length;
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
      const updatedFiles = _syncProject({ projectRoot, projectId: id, shellRoot: SHELL_ROOT });
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
    if (!id) {
      console.error("usage: routekit project upgrade --id <id> [--dry-run] [--no-backup]");
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
    const opts = { dryRun: Boolean(kv["dry-run"]), noBackup: Boolean(kv["no-backup"]) };
    try {
      const report = _upgradeProject({ projectRoot, projectId: id, shellRoot: SHELL_ROOT, opts });
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
}
