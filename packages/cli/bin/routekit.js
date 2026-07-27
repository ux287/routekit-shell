#!/usr/bin/env node
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "child_process";
import { runApplyTool } from "../../mcp-rks/src/server.mjs";
import { handlePlanCommand } from "../src/cli/plan.js";
import { handleExecCommand } from "../src/cli/exec.js";
import { handleProjectCommand } from "../src/cli/project.js";
import { handleNotesCommand } from "../src/cli/notes.js";
import { handleWorkspaceCommand, createWorkspaceHelpers } from "../src/cli/workspace.js";
import { handleRagCommand } from "../src/cli/rag.js";
import { handleSnapshotCommand } from "../src/cli/snapshot.js";
import { handleAnalyzeCommand } from "../src/cli/analyze.js";
import { handleBacklogCommand } from "../src/cli/backlog.js";
import { handlePublishCommand } from "../src/cli/publish.js";
import { runDoctor } from "../src/project/doctor.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_ROOT = path.resolve(process.env.ROUTEKIT_SHELL_ROOT || path.join(__dirname, "../../.."));
const _TEMPLATES_DIR = path.join(SHELL_ROOT, "templates");

const HOME = os.homedir();
const PROJECTS_ROOT = path.resolve(path.join(HOME, "Documents", "projects"));
const WORKSPACE_DIR = path.join(PROJECTS_ROOT, ".vscode");
const WORKSPACE_PATH = path.join(WORKSPACE_DIR, "projects.code-workspace");
const ROOT_VAULT = path.join(PROJECTS_ROOT, "notes");

// ---------- utils ----------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(p, fallback = {}) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeFileWithBackup(p, content) {
  ensureDir(path.dirname(p));
  if (fs.existsSync(p)) {
    const bak = p + `.bak.${Date.now()}`;
    fs.copyFileSync(p, bak);
    console.log("backup:", bak);
  }
  fs.writeFileSync(p, content);
  console.log("wrote:", p);
}
function writeJSON(p, obj) { writeFileWithBackup(p, JSON.stringify(obj, null, 2)); }
function copyDirNoOverwrite(srcDir, destDir) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
  ensureDir(destDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirNoOverwrite(src, dest);
      continue;
    }
    if (!entry.isFile()) continue;
    if (fs.existsSync(dest)) continue;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}
// copyDir kept for backwards compatibility; not used in current scope.
function parseArgs(argv) {
  const parts = argv.slice(2);
  const cmd = parts[0];
  let idx = 1;
  let sub = null;
  if (parts[idx] && !parts[idx].startsWith("--")) {
    sub = parts[idx];
    idx += 1;
  }
  const kv = {};
  while (idx < parts.length) {
    const token = parts[idx];
    if (!token.startsWith("--")) {
      idx += 1;
      continue;
    }
    let [key, value] = token.replace(/^--/, "").split("=");
    if (value === undefined || value === "") {
      const next = parts[idx + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        idx += 2;
      } else {
        value = true;
        idx += 1;
      }
    } else {
      idx += 1;
    }
    kv[key] = value;
  }
  return { cmd, sub, kv };
}
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
    if (process.stdin.isTTY) resolve("");
  });
}
function usage() {
  console.log(`routekit commands:

      project init          --id=<id> --stack=<stackId> --path=<abs path> [--branch-model=2-branch|3-branch] [--dev]
      project attach        --id=<id> --path=<abs path> [--stack=<stackId>] [--branch-model=2-branch|3-branch] [--vendor[=subtree|copy] --vendor-ref=<ref> --vendor-remote=<url> --git-init] [--yes] [--dev]
      project add-existing  --id=<id> --stack=<stackId> --path=<abs path>
      project list
      project info          --id=<id>
      project migrate-registry

      plan <projectId> ["task" | --problem note.id]
      analyze <projectId>

      notes seed      --toSlug=<slug> --toVault=<abs path> [--domains=design,docs]
      notes export    --vault=<abs> [--out=<dir>] [--types=blog,docs]

      workspace add      --path=<abs> [--name=<label>]
      workspace remove   --path=<abs>
      workspace rename   --path=<abs> --name=<label>
      workspace list     [--pretty]
      workspace prune
      workspace fix      # dedupe & sort by name/path, keeps projects root

      workspace health

      rag ingest|embed --project=<abs path>    # placeholders
      snapshot         --project=<abs path>    # placeholder
      apply <projectId> <label>

      backlog list     [--status=<status>] [--pretty]
      backlog import   [--file=<path>] [--slug=<slug>]
      backlog status   <slug> <new-status>

      publish          [--remote=<name>] [--profile=<name>] [--branch=<name>] [--dry-run] [-m <msg>] [--root=<path>] [--yes]
                       # fresh-process re-publish to a configured remote (default rks-public), no formal release
    `); process.exit(1);
}

function printPlanHelp() {
  console.log(`Usage:
        routekit plan <projectId> "Describe the change you want"
        routekit plan <projectId> --problem backlog.problems.note-id
        routekit plan <projectId> backlog.problems.note-id

    Examples:
        routekit plan ux287 "Add an About page with a hero and CTA."
        routekit plan ux287 --problem backlog.problems.navigation-missing-about-page
        routekit plan ux287 backlog.problems.navigation-missing-about-page
    `);
}

function printRagHelp() {
  console.log(`Usage:
        routekit rag init <projectId>
        routekit rag embed <projectId>
        routekit rag query <projectId> "question text"

    Examples:
        routekit rag init testsite
        routekit rag embed testsite
        routekit rag query testsite "navigation about page missing"
    `);
}

async function callMcpTool(toolName, args) {
  // Use bin/mcp-rks.mjs which loads dotenv before starting the server
  const serverPath = path.join(SHELL_ROOT, "packages/mcp-rks/bin/mcp-rks.mjs");
  const parsedTimeout =
    Number.isFinite(Number(process.env.RKS_MCP_TIMEOUT_MS))
      ? Number(process.env.RKS_MCP_TIMEOUT_MS)
      : Number.isFinite(Number(process.env.ROUTEKIT_MCP_TIMEOUT_MS))
        ? Number(process.env.ROUTEKIT_MCP_TIMEOUT_MS)
        : null;
  const timeoutMs = parsedTimeout && parsedTimeout > 0 ? parsedTimeout : 300000; // align with LLM timeout default
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { ...process.env },
  });
  const client = new Client({ name: "routekit-cli", version: "0.1.0" });
  await client.connect(transport);
  try {
    const response = await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs });
    await client.close();
    return response;
  } catch (error) {
    await client.close();
    throw error;
  }
}

// ---------- command router ----------
const { cmd, sub, kv } = parseArgs(process.argv);
if (!cmd) usage();

if (cmd === "plan") {
  await handlePlanCommand({ args: process.argv.slice(2), kv, SHELL_ROOT, readStdin, callMcpTool, printPlanHelp });
}

if (cmd === "analyze") {
  await handleAnalyzeCommand({ args: process.argv.slice(2), callMcpTool });
}

if (cmd === "apply") {
  const args = process.argv.slice(2);
  const positionalProject = args[1] && !args[1].startsWith("--") ? args[1] : null;
  const positionalLabel = args[2] && !args[2].startsWith("--") ? args[2] : null;
  const projectId = typeof kv.project === "string" ? kv.project : positionalProject;
  const label = typeof kv.label === "string" ? kv.label : positionalLabel;
  if (!projectId) {
    console.error("usage: routekit apply <projectId> [<label>]");
    process.exit(2);
  }
  try {
    const res = await runApplyTool({ projectId, label: label || null });
    const runDir = path.join(SHELL_ROOT, ".rks", "runs", res.runId);
    console.log(`Applied run for project "${projectId}" label "${label || "(latest)"}".`);
    console.log(`Run: ${res.runId} (${path.relative(SHELL_ROOT, runDir)})`);
    console.log(`Steps applied: ${res.stepsApplied}`);
    console.log(`Files: ${res.appliedFiles.length ? res.appliedFiles.join(", ") : "(none)"}`);
    process.exit(0);
  } catch (error) {
    console.error(`apply failed: ${error?.message || error}`);
    process.exit(1);
  }
}

if (cmd === "exec") {
  await handleExecCommand({ kv, SHELL_ROOT, readStdin, ensureDir });
}

if (cmd === "project") {
  await handleProjectCommand({ sub, kv, SHELL_ROOT, args: process.argv.slice(2) });
}

if (cmd === "notes") {
  await handleNotesCommand({ sub, kv, SHELL_ROOT, ensureDir });
}

if (cmd === "workspace") {
  const helpers = createWorkspaceHelpers({
    PROJECTS_ROOT,
    WORKSPACE_DIR,
    WORKSPACE_PATH,
    ROOT_VAULT,
    ensureDir,
    readJSON,
    writeJSON,
  });
  await handleWorkspaceCommand({ sub, kv, helpers });
}

if (cmd === "rag") {
  await handleRagCommand({ args: process.argv.slice(2), kv, SHELL_ROOT, printRagHelp });
}

if (cmd === "backlog") {
  await handleBacklogCommand({ sub, kv, SHELL_ROOT });
}

if (cmd === "publish") {
  await handlePublishCommand({ kv, SHELL_ROOT, args: process.argv.slice(2) });
}

if (cmd === "doctor") {
  const dryRun = kv["dry-run"] === true || kv["dry-run"] === "true";
  try {
    const result = await runDoctor({ shellRoot: SHELL_ROOT, dryRun });
    const f = result.findings;
    console.log(`routekit doctor — ${dryRun ? "DRY RUN " : ""}exit=${result.exitCode}`);
    if (f.shellTemplateDrift && !f.shellTemplateDrift.ok) {
      console.log(`  shell template drift: ${(f.shellTemplateDrift.issues || []).join("; ") || "drift detected"}`);
    }
    for (const c of f.childHooksDrift) {
      if (!c.drift.ok) console.log(`  child ${c.id}: hooks drift: ${(c.drift.issues || []).join("; ")}`);
    }
    for (const c of f.childMcpPointer) {
      if (c.exists && !c.healthy) console.log(`  child ${c.id}: .mcp.json points outside shellRoot → ${c.pointer}`);
    }
    for (const c of f.childRegistryPresence) {
      if (c.missing) console.log(`  child ${c.id}: missing from registry`);
    }
    for (const c of f.childSchemaVersion) {
      if (c.result && !c.result.noOp) console.log(`  child ${c.id}: schema migrated ${c.result.fromVersion}→${c.result.currentVersion}`);
      if (c.error) console.log(`  child ${c.id}: schema check failed — ${c.error}`);
    }
    for (const nr of f.nonRecoverable) {
      console.log(`  NON-RECOVERABLE check=${nr.check}${nr.id ? " id=" + nr.id : ""}: ${nr.reason}`);
    }
    console.log(`  fixers applied: ${f.appliedFixers.length}; succeeded: ${f.succeeded}; failed: ${f.failed}`);
    process.exit(result.exitCode);
  } catch (err) {
    console.error(`doctor failed: ${err?.message || err}`);
    process.exit(1);
  }
}

if (cmd === "run" && sub === "status") {
  const rawArgs = process.argv.slice(2);
  const projectId = rawArgs[2];
  if (!projectId || projectId.startsWith("--")) {
    console.error("usage: routekit run status <projectId> [--limit=<n>]");
    process.exit(2);
  }
  const limit = kv.limit ? Math.max(1, parseInt(kv.limit, 10) || 5) : 5;
  const { getProjectById } = await import("../src/project/index.js");
  const project = getProjectById(projectId, SHELL_ROOT);
  if (!project || !(project.root || project.path)) {
    console.error(`Project not found: ${projectId}`);
    process.exit(1);
  }
  const projectRoot = project.root || project.path;
  const runsDir = path.join(projectRoot, ".rks", "runs");
  if (!fs.existsSync(runsDir)) {
    console.log(`No runs recorded for project ${projectId}.`);
    process.exit(0);
  }
  const entries = fs
    .readdirSync(runsDir)
    .filter((name) => {
      const full = path.join(runsDir, name);
      return fs.statSync(full).isDirectory();
    })
    .sort()
    .reverse()
    .slice(0, limit);
  if (!entries.length) {
    console.log(`No runs recorded for project ${projectId}.`);
    process.exit(0);
  }
  const rows = entries.map((runId) => {
    const folder = path.join(runsDir, runId);
    const planPath = path.join(folder, "plan.json");
    const metaPath = path.join(folder, "run.json");
    let plan = {};
    let meta = {};
    if (fs.existsSync(planPath)) {
      try {
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      } catch {
        plan = {};
      }
    }
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        meta = {};
      }
    }
    const slugFromRun = runId.includes("_") ? runId.split("_").slice(1).join("_") : runId;
    return {
      runId,
      createdAt: meta.createdAt || plan.generatedAt || null,
      baseBranch: meta.baseBranch || project.baseBranch || "dev",
      rksBranch: meta.rksBranch || `rks/${plan.slug || slugFromRun}`,
      label: plan.slug || plan.task || plan.problemId || slugFromRun,
      problemId: plan.problemId || null,
      task: plan.task || null,
      runFolder: path.relative(SHELL_ROOT, folder),
    };
  });
  console.log(JSON.stringify({ projectId, runs: rows }, null, 2));
  process.exit(0);
}

if (cmd === "hub") {
  if (sub === "rebuild") {
    const mode = kv.mode || "links";
    const root = process.env.HOME + "/Documents/projects";
    const rootVault = root + "/notes";
    const { rebuildHub } = await import("../src/hub-rebuild.js");
    const res = await rebuildHub({ root, rootVault, mode });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
}

if (cmd === "snapshot") {
  const handled = await handleSnapshotCommand({ cmd, sub, kv });
  if (handled) process.exit(0);
}

// Re-export for CLI helpers that need direct MCP access
export { callMcpTool };

usage();
