/**
 * MCP Tool Preflight Validation
 *
 * Runs configurable checks before MCP tool execution.
 * Mirrors hook-level enforcement for tools that bypass Claude Code hooks.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";
import { getCurrentBranch, isWorkingTreeClean, hasGitRepo } from "../utils/git.mjs";
import { loadContext } from "./project.mjs";
import { getTelemetryCollector } from "./telemetry/collector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read the rks release version from the root package.json.
 * Returns null if the file cannot be read (non-fatal).
 */
export function readRksVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "../../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Per-tool preflight check configuration.
 * Each tool maps to an array of check names to run.
 */
const TOOL_CHECKS = {
  rks_plan:          ["branch", "story_exists"],
  rks_exec:          ["branch"],
  rks_apply:         ["branch"],
  rks_staging_merge: ["branch"],
  rks_staging_pr:    ["branch", "base_branch"],
  rks_story_ship:    ["branch"],
  rks_release:       ["release_ready"],
};

/**
 * Run preflight checks for a given tool invocation.
 *
 * @param {string} toolName - MCP tool name (e.g., "rks_plan")
 * @param {Object} args - Tool arguments
 * @returns {{ ok: boolean, errors: Array<{check: string, message: string}>, warnings: Array<{check: string, message: string}> }}
 */
export async function runPreflight(toolName, args) {
  // Allow smoke tests and CI to skip preflight checks
  if (process.env.RKS_SKIP_PREFLIGHT) {
    return { ok: true, rksVersion: readRksVersion(), errors: [], warnings: [] };
  }

  const checks = TOOL_CHECKS[toolName];
  if (!checks || checks.length === 0) {
    return { ok: true, rksVersion: readRksVersion(), errors: [], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  const projectId = args?.projectId;

  let context = null;
  let projectRoot = null;

  if (projectId) {
    try {
      context = await loadContext(projectId);
      projectRoot = context?.record?.root;
    } catch (e) {
      // Can't load context — skip checks that need it
    }
  }

  for (const check of checks) {
    switch (check) {
      case "branch": {
        if (!projectRoot || !hasGitRepo(projectRoot)) break;
        try {
          const baseBranch = context?.projectJson?.baseBranch || "staging";
          const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false });
          // rks_plan and rks_exec should run from base branch
          if (["rks_plan", "rks_exec", "rks_apply"].includes(toolName)) {
            if (currentBranch && currentBranch !== baseBranch && !currentBranch.startsWith("rks/")) {
              errors.push({
                check: "branch",
                message: `${toolName} should run from "${baseBranch}" branch, currently on "${currentBranch}"`
              });
            }
          }
          // rks_staging_merge should run from staging or the rks/* branch being merged
          if (toolName === "rks_staging_merge" && currentBranch !== baseBranch) {
            warnings.push({
              check: "branch",
              message: `${toolName} typically runs from "${baseBranch}", currently on "${currentBranch}"`
            });
          }
        } catch (e) { /* non-fatal */ }
        break;
      }

      case "base_branch": {
        if (!projectRoot) break;
        const targetBranch = args?.targetBranch;
        if (!targetBranch) break; // Will be resolved from config by handler
        try {
          const { isProductionBranch } = await import("./branch-protection.mjs");
          if (isProductionBranch(projectRoot, targetBranch)) {
            const { getBranchConfig } = await import("./project.mjs");
            const branchConfig = getBranchConfig(context?.record || {}, context?.projectJson);
            errors.push({
              check: "base_branch",
              message: `PRs must not target "${targetBranch}" (production). Use rks_release to promote "${branchConfig.integration}" → "${branchConfig.production}".`
            });
          }
        } catch (e) { /* non-fatal */ }
        break;
      }

      case "release_ready": {
        if (!projectRoot) break;
        try {
          const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false });
          if (currentBranch && currentBranch !== "staging") {
            errors.push({
              check: "release_ready",
              message: `rks_release must run from "staging", currently on "${currentBranch}"`
            });
          }
        } catch (e) { /* non-fatal */ }
        break;
      }

      case "story_exists": {
        if (!projectRoot) break;
        const problemId = args?.problemId;
        if (problemId) {
          try {
            const { resolveNotesDir } = await import("../dendron.mjs");
            const notesDir = resolveNotesDir(projectRoot);
            const fs = await import("fs");
            const path = await import("path");
            const storyPath = path.join(notesDir, `${problemId}.md`);
            if (!fs.existsSync(storyPath)) {
              errors.push({
                check: "story_exists",
                message: `Backlog story "${problemId}" not found at ${storyPath}`
              });
            }
          } catch (e) { /* non-fatal */ }
        }
        break;
      }
    }
  }

  // Emit telemetry
  try {
    const collector = getTelemetryCollector();
    collector.emit("preflight.mcp_tool", projectId || "unknown", {
      tool: toolName,
      checksRun: checks,
      errorCount: errors.length,
      warningCount: warnings.length,
      passed: errors.length === 0,
      failures: errors,
    });
  } catch (e) { /* telemetry is best-effort */ }

  return {
    ok: errors.length === 0,
    rksVersion: readRksVersion(),
    errors,
    warnings,
  };
}

/**
 * Check if a tool has preflight checks configured.
 */
export function hasPreflightChecks(toolName) {
  return !!(TOOL_CHECKS[toolName] && TOOL_CHECKS[toolName].length > 0);
}

/**
 * Placeholder-remote tokens. A remote URL containing any of these is a template
 * stand-in, not a real repo (e.g. the hint string rks_preflight itself emits:
 * "git remote add origin https://github.com/YOUR-ORG/YOUR-REPO.git").
 */
const PLACEHOLDER_REMOTE_TOKENS = ["YOUR-ORG", "YOUR-REPO", "YOUR_ORG", "YOUR_REPO"];

export function isPlaceholderRemote(url) {
  if (!url || typeof url !== "string") return false;
  const upper = url.toUpperCase();
  return PLACEHOLDER_REMOTE_TOKENS.some((tok) => upper.includes(tok));
}

/**
 * The build-ready / ship-ready git precondition set. Each entry validates VALIDITY,
 * not mere presence, so a green result means actually-ready:
 *  - baseline_commit: the repo has at least one commit (HEAD resolves)
 *  - working_branch:  the configured working branch is the one checked out
 *  - github_remote:   origin is real (not a YOUR-ORG/YOUR-REPO placeholder) AND reachable
 *
 * Returns an array of { name, passed, detail?, hint } check objects, shaped to be
 * pushed directly into the rks_preflight handler's `checks` list. Each failing
 * check carries an actionable hint naming the missing precondition and its fix.
 *
 * Reachability uses `git ls-remote` against the configured origin; placeholder
 * remotes are rejected BEFORE any probe (so a placeholder never causes a network
 * hang). Tests exercise reachability offline via local bare-repo paths.
 *
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {object} [args.projectJson] - parsed .rks/project.json (for branches.working)
 * @param {number} [args.timeoutMs]
 */
export function checkGitReadiness({ projectRoot, projectJson, timeoutMs = 15_000 } = {}) {
  const checks = [];

  if (!projectRoot || !hasGitRepo(projectRoot)) {
    checks.push({
      name: "git_repo",
      passed: false,
      hint: "Not a git repository — run `routekit project init` (which now bootstraps git) or `git init`",
    });
    return checks;
  }

  // baseline_commit — at least one commit (HEAD resolves)
  let hasCommit = false;
  try {
    const r = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs });
    hasCommit = r.status === 0;
  } catch { /* non-fatal */ }
  checks.push({
    name: "baseline_commit",
    passed: hasCommit,
    hint: hasCommit ? null : "No commits yet — create a baseline commit: `git add -A && git commit -m \"baseline\"`",
  });

  // working_branch — configured working branch is checked out
  const workingBranch = projectJson?.branches?.working || projectJson?.baseBranch || null;
  let currentBranch = null;
  try { currentBranch = getCurrentBranch(projectRoot, { throwOnError: false }); } catch { /* non-fatal */ }
  const onWorking = workingBranch ? currentBranch === workingBranch : !!currentBranch;
  checks.push({
    name: "working_branch",
    passed: !!onWorking,
    detail: currentBranch || null,
    hint: onWorking
      ? null
      : workingBranch
        ? `Checkout the working branch: \`git checkout ${workingBranch}\` (currently on "${currentBranch || "<none>"}")`
        : "No branch is checked out — create a baseline commit and check out a working branch",
  });

  // github_remote — origin real (not placeholder) AND reachable
  let remoteUrl = null;
  try {
    const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs });
    if (r.status === 0 && r.stdout.trim()) remoteUrl = r.stdout.trim();
  } catch { /* non-fatal */ }

  let remotePassed = false;
  let remoteHint;
  if (!remoteUrl) {
    remoteHint = "No `origin` remote — add one: `git remote add origin <your repo URL>`";
  } else if (isPlaceholderRemote(remoteUrl)) {
    remoteHint = `origin is a placeholder (${remoteUrl}) — set a real remote: \`git remote set-url origin <your repo URL>\``;
  } else {
    let reachable = false;
    try {
      const r = spawnSync("git", ["ls-remote", "--exit-code", remoteUrl], { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs });
      reachable = r.status === 0;
    } catch { /* non-fatal */ }
    remotePassed = reachable;
    if (!reachable) remoteHint = `origin (${remoteUrl}) is not reachable — verify the URL and your access`;
  }
  checks.push({
    name: "github_remote",
    passed: remotePassed,
    detail: remoteUrl,
    hint: remotePassed ? null : remoteHint,
  });

  return checks;
}
