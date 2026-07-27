import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Known RKS/Dendron runtime artifact patterns.
 * These files are generated at runtime and should never block planning or execution.
 * Used by planner and planner-preflight to filter dirty-tree checks.
 */
export const RKS_RUNTIME_ARTIFACT_PATTERNS = [
  '.rks/session/',
  '.rks/state/',
  '.rks/telemetry/',
  '.rks/rag/',
  '.rks/runs/',
  '.rks/',          // catch-all for .rks/*.lock and other transient files
  '.dendron.port',
  '.dendron.ws',
  'notes/.dendron.cache.json',
  '.routekit/state.json',
  '.routekit/context-state.json',
  '.routekit/telemetry/',
  'package-lock.json',
];

/**
 * Check if a file path matches a known RKS/Dendron runtime artifact.
 * @param {string} filePath - File path relative to project root
 * @returns {boolean} True if the file is a known runtime artifact
 */
export function isRuntimeArtifact(filePath) {
  return RKS_RUNTIME_ARTIFACT_PATTERNS.some(pattern =>
    filePath === pattern || filePath.startsWith(pattern)
  );
}

/**
 * Run a git command and throw a McpError on non-zero exit.
 */
export function runCheckedGit(projectRoot, args, fallbackMessage) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    const errorText = result.stderr?.trim() || result.stdout?.trim() || fallbackMessage || "git command failed";
    throw new McpError(ErrorCode.InternalError, errorText);
  }
  return result.stdout.trim();
}

/**
 * Run a git command and throw a generic Error on failure.
 */
export function runGit(projectRoot, args) {
  const res = spawnSync("git", args, { cwd: projectRoot, stdio: "pipe" });
  if (res.status !== 0) {
    const err = res.stderr.toString().trim() || res.stdout.toString().trim();
    throw new Error(`git ${args.join(" ")} failed: ${err}`.trim());
  }
  return res.stdout.toString().trim();
}

/**
 * Get the current git branch.
 * @param {string} projectRoot
 * @param {object} options
 * @param {boolean} options.throwOnError - If true (default), throws on error. If false, returns null.
 */
export function getCurrentBranch(projectRoot, { throwOnError = true } = {}) {
  try {
    return runCheckedGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], "Unable to determine current branch");
  } catch (err) {
    if (throwOnError) throw err;
    return null;
  }
}

/**
 * Check whether the working tree is clean.
 * @param {string} projectRoot
 * @param {object} options
 * @param {boolean} options.filterRks - If true (default), ignore .rks/ paths.
 * @param {boolean} options.throwOnError - If true (default), throws on error. If false, returns false.
 */
export function isWorkingTreeClean(projectRoot, { filterRks = true, throwOnError = true } = {}) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    if (throwOnError) {
      throw new McpError(ErrorCode.InternalError, result.stderr?.trim() || "git status failed");
    }
    return false;
  }
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  // Filter out .rks/ paths and projects/index.jsonl (modified by tests)
  let relevant = lines;
  if (filterRks) {
    relevant = relevant.filter((line) => !line.includes(".rks/") && !line.includes("projects/index.jsonl"));
  }
  return relevant.length === 0;
}

/**
 * Check if projectRoot has a .git directory.
 */
export function hasGitRepo(projectRoot) {
  return fs.existsSync(path.join(projectRoot, ".git"));
}

/**
 * Get list of uncommitted files (staged + unstaged).
 * @param {string} projectRoot
 * @param {object} options
 * @param {boolean} options.filterRks - If true (default), ignore .rks/ paths.
 * @returns {string[]} List of file paths relative to projectRoot
 */
export function getUncommittedFiles(projectRoot, { filterRks = true } = {}) {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return [];
  }
  const lines = result.stdout.split("\n").filter(Boolean);
  let files = lines.map((line) => line.slice(3));
  if (filterRks) {
    // Exclude .rks/ paths and projects/index.jsonl (modified by tests)
    files = files.filter((f) => !f.startsWith(".rks/") && f !== "projects/index.jsonl");
  }
  return files;
}

/**
 * Assert the working tree is clean, with configurable exclusions.
 * Throws McpError(InvalidRequest) if blocked dirty files remain after exclusions.
 *
 * @param {string} projectRoot
 * @param {object} options
 * @param {string} [options.toolName] - Used in error message (e.g. "rks_rag_init")
 * @param {string} [options.excludeNotesFor] - problemId whose notes/<id>.md and notes/<id>.child-*.md are excluded
 * @param {boolean} [options.notesOk] - If true, all notes/ files are allowed dirty (rag_embed mode)
 */
export function assertCleanWorkingTree(projectRoot, { toolName = 'rks', excludeNotesFor, notesOk = false } = {}) {
  let dirty = getUncommittedFiles(projectRoot);

  if (excludeNotesFor) {
    const prefix = `notes/${excludeNotesFor}.`;
    const exact = `notes/${excludeNotesFor}.md`;
    dirty = dirty.filter(f => f !== exact && !f.startsWith(prefix));
  }

  if (notesOk) {
    dirty = dirty.filter(f => !f.startsWith('notes/'));
  }

  if (dirty.length > 0) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${toolName}: working tree is not clean. Commit or stash changes first.\n\nDirty files:\n${dirty.map(f => `  ${f}`).join('\n')}`
    );
  }
}

/**
 * Stage and commit specific files with a message.
 * @param {string} projectRoot
 * @param {string[]} files - List of file paths relative to projectRoot
 * @param {string} message - Commit message
 */
export function commitFiles(projectRoot, files, message) {
  if (!files || files.length === 0) {
    throw new Error("No files to commit");
  }
  // Stage files
  runGit(projectRoot, ["add", ...files]);
  // Commit with message
  runGit(projectRoot, ["commit", "-m", message]);
}

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the most recently modified run directory, optionally filtering by slug.
 * @param {string} projectRoot
 * @param {string|null} slug - Optional slug to filter runs
 */
/**
 * Check if current branch is synced with origin.
 * @param {string} projectRoot
 * @returns {{ synced: boolean, aheadBy: number, behindBy: number, diverged: boolean }}
 */
export function getStagingSyncStatus(projectRoot) {
  try {
    // Fetch to get latest remote state
    spawnSync("git", ["fetch", "origin"], { cwd: projectRoot, encoding: "utf8" });
    
    const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
    if (branch.status !== 0) {
      return { synced: true, aheadBy: 0, behindBy: 0, diverged: false }; // Assume synced if can't determine
    }
    const currentBranch = branch.stdout.trim();
    
    const countResult = spawnSync("git", ["rev-list", "--left-right", "--count", `${currentBranch}...origin/${currentBranch}`], {
      cwd: projectRoot,
      encoding: "utf8"
    });
    
    if (countResult.status !== 0) {
      return { synced: true, aheadBy: 0, behindBy: 0, diverged: false }; // No remote tracking
    }
    
    const [ahead, behind] = countResult.stdout.trim().split(/\s+/).map(Number);
    return {
      synced: behind === 0,
      aheadBy: ahead || 0,
      behindBy: behind || 0,
      diverged: ahead > 0 && behind > 0
    };
  } catch (err) {
    return { synced: true, aheadBy: 0, behindBy: 0, diverged: false };
  }
}

export function findLatestRunDir(projectRoot, slug = null) {
  const runsDir = path.join(projectRoot, ".rks", "runs");
  if (!fs.existsSync(runsDir)) return null;
  const folders = fs
    .readdirSync(runsDir)
    .filter((name) => {
      if (!slug) return true;
      // Support both exact match (_slug) and suffixed match (_slug-v2)
      const re = new RegExp(`_${escapeForRegex(slug)}(-|$)`);
      return re.test(name);
    })
    .sort()
    .reverse();
  for (const name of folders) {
    const full = path.join(runsDir, name);
    if (fs.statSync(full).isDirectory()) {
      return full;
    }
  }
  return null;
}
