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
import { loadSkillsManifest, findMissingSkills } from "../shared/skills-manifest.mjs";
import { loadContext } from "./project.mjs";
import { getTelemetryCollector } from "./telemetry/collector.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read the rks release version from the SHELL's root package.json, off disk, right now.
 *
 * Always `__dirname`-relative — NEVER `projectRoot`. A child project has its own package.json with
 * its own app version, and comparing the shell's version to a child app's version would fire the
 * stale-server check on every child, forever.
 */
export function readDiskRksVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "../../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * backlog.fix.clean-machine-honesty: THE VERSION THE RUNNING CODE ACTUALLY CAME FROM.
 *
 * Captured ONCE, at module load. This module is imported exactly once, statically (server.mjs), and
 * nothing dynamically re-imports it — so this constant is pinned to the code the MCP server is
 * actually executing, and it cannot drift out from under the checks that sit beside it.
 *
 * That distinction is the whole point. `readDiskRksVersion()` re-reads package.json on every call,
 * but the CHECK CODE is loaded once at server start. After `git checkout <newtag>` without a server
 * restart, the two disagree — and preflight was reporting the DISK version next to a MEMORY-derived
 * checks list. On a real clean machine it announced `rksVersion: 0.27.2` while `core_skills` — a
 * check that only exists in 0.27.2 — was absent from the checks array. The version field was telling
 * the truth about the wrong thing.
 *
 * A health oracle that certifies a version it is not running is the same bug as one that certifies
 * skills it never looked at: it ENDS the investigation with a false answer. A UAT round was spent
 * chasing that ghost.
 */
export const LOADED_RKS_VERSION = readDiskRksVersion();

/**
 * Back-compat: the version rks is RUNNING. Callers want the honest answer, which is the loaded one.
 */
export function readRksVersion() {
  return LOADED_RKS_VERSION;
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
    // The version we are RUNNING (module-load), and the version on DISK. Reporting only one of these
    // is what let preflight certify a version whose code was not loaded.
    rksVersion: LOADED_RKS_VERSION,
    diskRksVersion: readDiskRksVersion(),
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
 * Push-disabled sentinel. Public-mirror clones (e.g. routekit-shell-core cloned from the
 * read-only upstream) have their push URL deliberately set to the literal `no_push` by
 * scripts/setup.mjs so an accidental push can't reach the upstream. Such a clone is NOT a valid
 * push target — github_remote must report it as not-ready (not a green public-upstream URL).
 */
const NO_PUSH_SENTINEL = "no_push";

export function isNoPushRemote(url) {
  return typeof url === "string" && url.trim().toLowerCase() === NO_PUSH_SENTINEL;
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
export function checkGitReadiness({ projectRoot, projectJson, timeoutMs = 15_000, diskVersionOverride } = {}) {
  const checks = [];

  // server_freshness — is the code we are running the code that is on disk?
  //
  // Emitted BEFORE the non-git early return below: a stale server is stale regardless of whether the
  // project happens to be a git repo, and hiding the one check that explains why nothing else makes
  // sense would be its own small betrayal.
  //
  // `diskVersionOverride` exists ONLY so a witness can construct divergence. Divergence must NEVER be
  // constructed by pointing this at `projectRoot` — see readDiskRksVersion.
  const diskVersion = diskVersionOverride !== undefined ? diskVersionOverride : readDiskRksVersion();
  const stale = Boolean(LOADED_RKS_VERSION && diskVersion && LOADED_RKS_VERSION !== diskVersion);
  checks.push({
    name: "server_freshness",
    passed: !stale,
    detail: stale ? `running ${LOADED_RKS_VERSION}, on disk ${diskVersion}` : LOADED_RKS_VERSION || "unknown",
    hint: stale
      ? `The MCP server is RUNNING version ${LOADED_RKS_VERSION} but the checkout on disk is ${diskVersion}. ` +
        `Node loaded the old code at startup and a git checkout does not change that — every other check ` +
        `below is reporting on the OLD code. Restart the MCP server (reload your editor window), then re-run preflight.`
      : null,
  });

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
  //
  // backlog.fix.shell-self-sync-skill-wipe-health-gate: `git rev-parse --abbrev-ref HEAD` SUCCEEDS on
  // a detached HEAD and returns the literal string "HEAD". So the old `!!currentBranch` fallback —
  // used when no working branch is configured — was TRUE for a detached HEAD, and preflight reported
  // a tag-pinned clone as healthy. That is exactly the state the README's "pin to a tag for
  // stability" advice puts you in, and it is the state the clean-machine UAT box was in. Detached is
  // never healthy: rks ships work on branches, and a commit made here belongs to no branch.
  const workingBranch = projectJson?.branches?.working || projectJson?.baseBranch || null;
  let currentBranch = null;
  try { currentBranch = getCurrentBranch(projectRoot, { throwOnError: false }); } catch { /* non-fatal */ }
  const detachedHead = currentBranch === "HEAD";
  const onWorking = detachedHead
    ? false
    : workingBranch
      ? currentBranch === workingBranch
      : !!currentBranch;
  checks.push({
    name: "working_branch",
    passed: !!onWorking,
    detail: detachedHead ? "detached HEAD" : currentBranch || null,
    hint: onWorking
      ? null
      : detachedHead
        ? `HEAD is detached — you are on a commit, not a branch, so nothing you commit here will be on any branch. ` +
          `Land on one: \`git checkout ${workingBranch || "staging"}\`. ` +
          `(Pinning to a tag detaches HEAD — that is expected, but you cannot develop from it.)`
        : workingBranch
          ? `Checkout the working branch: \`git checkout ${workingBranch}\` (currently on "${currentBranch || "<none>"}")`
          : "No branch is checked out — create a baseline commit and check out a working branch",
  });

  // core_skills — the skills the manifest declares are actually on disk.
  //
  // backlog.fix.shell-self-sync-skill-wipe-health-gate: THE CHECK THAT WASN'T THERE. A clean-machine
  // UAT lost all 17 distributable skills to a self-sync, and preflight — running constantly, and the
  // one thing the user asks when something feels wrong — reported 7/7 green the entire time. Every
  // check passed because not one of them looked at the skills. rks with no skills has no /build, no
  // /ship, no /research: the Dispatcher cannot route anything. A health oracle that certifies a
  // corpse is worse than no oracle, because it ends the investigation.
  //
  // Manifest-driven on purpose: a hardcoded list here would be a second copy of the list in sync.mjs,
  // free to drift from it and from disk. .routekit/skills-manifest.json is the one source of truth,
  // and skills-manifest-coverage.test.mjs holds it to the filesystem in both directions.
  const skillsManifest = loadSkillsManifest(projectRoot);
  let skillsPassed = false;
  let skillsHint = null;
  let skillsDetail = null;
  if (!skillsManifest.ok) {
    // A child scaffolded before the manifest shipped legitimately has none. Don't fail it — but say
    // so, rather than reporting green on something that was never checked.
    skillsPassed = true;
    skillsDetail = `no manifest (${skillsManifest.reason})`;
  } else {
    const expected = skillsManifest.distributable;
    const missing = findMissingSkills(projectRoot, expected);
    skillsPassed = missing.length === 0;
    skillsDetail = skillsPassed
      ? `${expected.length}/${expected.length} present`
      : `${expected.length - missing.length}/${expected.length} present — MISSING: ${missing.join(", ")}`;
    skillsHint = skillsPassed
      ? null
      : `${missing.length} core skill(s) are missing from .claude/skills: ${missing.join(", ")}. ` +
        `rks cannot route work without them. Restore from git: \`git checkout HEAD -- .claude/skills\`. ` +
        `(Do NOT "repair" this with \`routekit project sync\` — a self-targeted sync is what deletes them.)`;
  }
  checks.push({
    name: "core_skills",
    passed: skillsPassed,
    detail: skillsDetail,
    hint: skillsHint,
  });

  // github_remote — origin PUSH target real (not placeholder, not push-disabled) AND reachable.
  // Read the PUSH url specifically: a public-mirror clone fetches from a real upstream but has its
  // push url set to the `no_push` sentinel, so the fetch url would falsely read as green. When no
  // explicit push url is configured, `--push` falls back to the fetch url (unchanged behavior).
  let pushUrl = null;
  try {
    const r = spawnSync("git", ["remote", "get-url", "--push", "origin"], { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs });
    if (r.status === 0 && r.stdout.trim()) pushUrl = r.stdout.trim();
  } catch { /* non-fatal */ }

  let remotePassed = false;
  let remoteHint;
  let remoteDetail = pushUrl;
  if (!pushUrl) {
    remoteHint = "No `origin` remote — add one: `git remote add origin <your repo URL>`";
  } else if (isNoPushRemote(pushUrl)) {
    // Push-disabled public-mirror clone: report as not a valid push target (detail null), not green.
    remoteDetail = null;
    remoteHint = "origin push is disabled on this clone (public mirror) — set your own push remote: `git remote set-url --push origin <your repo URL>`";
  } else if (isPlaceholderRemote(pushUrl)) {
    remoteHint = `origin push url is a placeholder (${pushUrl}) — set a real remote: \`git remote set-url origin <your repo URL>\``;
  } else {
    let reachable = false;
    try {
      const r = spawnSync("git", ["ls-remote", "--exit-code", pushUrl], { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs });
      reachable = r.status === 0;
    } catch { /* non-fatal */ }
    remotePassed = reachable;
    if (!reachable) remoteHint = `origin push url (${pushUrl}) is not reachable — verify the URL and your access`;
  }
  checks.push({
    name: "github_remote",
    passed: remotePassed,
    detail: remoteDetail,
    hint: remotePassed ? null : remoteHint,
  });

  return checks;
}
