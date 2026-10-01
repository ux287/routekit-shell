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

// ── backlog.fix.rungit-repo-root-binding: BIND GIT TO THE REPOSITORY IT WAS NAMED ─────────────
//
// Git resolves a repository by walking UP the directory tree from `cwd`. Every helper in this
// file bound only `cwd` — no -C, no --git-dir, no ceiling, and no check that `projectRoot` is
// actually a repository root. So when `projectRoot` was a directory that merely SAT INSIDE a
// repository, every git call silently operated on the ancestor. It succeeded. Nothing warned.
//
// On 2026-08-21 that turned a test fixture into a handle on the developer's own repository and a
// `git reset --hard origin/staging` destroyed ~30 unpushed commits.
//
// The fix is deliberately narrow but total within this file: nothing spawns git here without
// first proving the directory is the top level of the repo it claims to be. Note this is NOT
// specific to the reset — a misregistered project root, a record pointing at a subdirectory, or a
// deleted-and-recreated project directory all produce the same silent ancestor binding, and an
// ancestor-bound `isWorkingTreeClean` answering "clean" is the same wrong answer in a quieter voice.
//
// Everything below is module-internal ON PURPOSE. Ten test files mock this module and
// `git-utils.mjs` with partial object literals that do not use `importOriginal`; a new
// consumer-imported export would break all ten at once.

/** projectRoot -> { dev, ino, realRoot }. Cleared per-entry when the directory identity changes. */
const _repoRootCache = new Map();

/**
 * Environment for a bound git spawn.
 *
 * GIT_CEILING_DIRECTORIES is defence in depth, ADDITIVE to the assertion below and never a
 * substitute for it: a fixture whose parent chain is a repo is caught by the assertion, not by
 * the ceiling.
 *
 * Set to the PARENT of projectRoot, because git(1) says of the ceiling: "It will not exclude the
 * current working directory." Naming projectRoot itself would still find a repo there.
 *
 * `...process.env` is mandatory. spawnSync's `env` REPLACES the environment rather than merging,
 * so a bare `{ GIT_CEILING_DIRECTORIES }` would strip PATH, HOME and GIT_AUTHOR_* and break
 * commitFiles. This is the first `env:` in this file — there was no prior shape to copy.
 */
function ceilingEnv(projectRoot) {
  const parent = path.dirname(path.resolve(projectRoot));
  // An EMPTY entry disables the ceiling entirely, and silently. Only set it when non-empty.
  if (!parent || parent === path.resolve(projectRoot)) return { ...process.env };
  return { ...process.env, GIT_CEILING_DIRECTORIES: parent };
}

/**
 * Throw unless `projectRoot` is the top level of the git repository git would resolve from it.
 *
 * Realpaths BOTH sides. On macOS os.tmpdir() is /var/folders/… while `rev-parse --show-toplevel`
 * returns /private/var/folders/… — comparing raw strings would reject every legitimate fixture
 * and, on a symlinked checkout, the developer's own repository. Rejecting good roots would break
 * the exec/commit/ship machinery at the same moment this assertion starts firing, which is the
 * one failure mode this story must not introduce.
 */
function assertRepoRoot(projectRoot) {
  let stat;
  try {
    stat = fs.statSync(projectRoot);
  } catch (err) {
    // Includes the deleted-root case. Treat as a cache miss AND a binding failure — never an
    // unhandled ENOENT out of a git helper.
    _repoRootCache.delete(projectRoot);
    throw new McpError(
      ErrorCode.InternalError,
      `git binding failed: projectRoot does not exist or is unreadable: ${projectRoot} (${err.code || err.message})`,
    );
  }

  const cached = _repoRootCache.get(projectRoot);
  // dev+ino rather than the path string: a directory deleted and recreated within one run reuses
  // the path but not the inode, and a stale cache entry would re-authorise a different directory.
  // dev+ino alone is NOT sufficient: deleting a directory and recreating it at the same path
  // commonly REUSES the inode (observed on Linux/CI), so a replaced directory compares equal to
  // the cached one and would be served a stale "this is a repository root" verdict. Re-checking
  // the repo marker is one stat and closes that hole — a path that is no longer a repository
  // falls through to a fresh probe, which refuses it.
  if (cached && cached.dev === stat.dev && cached.ino === stat.ino
    && fs.existsSync(path.join(cached.realRoot, ".git"))) {
    return cached.realRoot;
  }

  // The probe itself is the ONE raw spawn in this file, by necessity — routing it through the
  // bound path would recurse. It is read-only and carries the ceiling like every other call.
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: ceilingEnv(projectRoot),
    timeout: 30_000,
  });

  const raw = (probe.stdout || "").trim();
  if (probe.status !== 0 || !raw) {
    // `!raw` is load-bearing and not paranoia: several test suites stub spawnSync to return
    // { stdout: '', status: 0 } — a SUCCESSFUL EMPTY result. Passing that to realpathSync throws
    // a bare ENOENT instead of anything a caller can act on.
    const detail = probe.status !== 0
      ? (probe.stderr || "").trim() || `git exited ${probe.status}`
      : "git reported success but returned no top level";
    throw new McpError(
      ErrorCode.InternalError,
      `git binding failed: ${projectRoot} is not a git repository root — ${detail}`,
    );
  }

  let realRoot;
  let realDeclared;
  try {
    realRoot = fs.realpathSync(raw);
    realDeclared = fs.realpathSync(projectRoot);
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `git binding failed: could not resolve real paths for ${projectRoot} / ${raw} (${err.code || err.message})`,
    );
  }

  if (realRoot !== realDeclared) {
    // The headline error. Name BOTH sides — "you asked me to operate on X, git resolved Y" is the
    // sentence whose absence let this run silently for as long as it did.
    throw new McpError(
      ErrorCode.InternalError,
      `git binding failed: declared projectRoot ${projectRoot} is not the repository root — ` +
      `git resolved ${raw}. Refusing to operate on a repository that was not named. ` +
      `(resolved: ${realDeclared} vs ${realRoot})`,
    );
  }

  _repoRootCache.set(projectRoot, { dev: stat.dev, ino: stat.ino, realRoot });
  return realRoot;
}

/**
 * spawnSync("git", …) with the repository binding enforced first.
 *
 * The throw is UNCONDITIONAL. It must not be routed through any caller's `throwOnError: false`
 * opt-out — `isWorkingTreeClean` has one and three callers pass false. Swallowing a binding
 * failure into "clean" would reproduce, one function over, exactly the defect this story removes
 * from getStagingSyncStatus.
 */
function boundSpawnGit(projectRoot, args, opts = {}) {
  assertRepoRoot(projectRoot);
  return spawnSync("git", args, { cwd: projectRoot, ...opts, env: ceilingEnv(projectRoot) });
}

/**
 * Run a git command and throw a McpError on non-zero exit.
 */
export function runCheckedGit(projectRoot, args, fallbackMessage) {
  const result = boundSpawnGit(projectRoot, args, { encoding: "utf8" });
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
  const res = boundSpawnGit(projectRoot, args, { stdio: "pipe" });
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
  // backlog.fix.rungit-repo-root-binding: the binding assertion inside boundSpawnGit throws
  // UNCONDITIONALLY and is deliberately NOT routed through `throwOnError` below. Three callers
  // pass throwOnError:false; letting a binding failure return `false` here would report
  // "not clean" for a repository we never meant to inspect — and letting it return `true` would
  // be worse. A misbound root is not a dirty tree, it is a refusal to answer.
  const result = boundSpawnGit(projectRoot, ["status", "--porcelain"], { encoding: "utf8" });
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
  // backlog.fix.rungit-repo-root-binding: this backs the assertCleanWorkingTree gate below, so an
  // ancestor-bound answer here becomes a green light to proceed against the wrong repository. Note
  // it swallows a non-zero status into `[]` — "no uncommitted files", i.e. clean. A binding failure
  // must NOT reach that path, which is why boundSpawnGit throws rather than returning a bad result.
  const result = boundSpawnGit(projectRoot, ["status", "--porcelain"], { encoding: "utf8" });
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
  // backlog.fix.rungit-repo-root-binding: the binding check runs OUTSIDE the try below, and that
  // placement is the whole point.
  //
  // Everything inside this function is swallowed into `{ synced: true, … }` — by the catch, and
  // by two early returns that treat "could not determine" as "assume synced". A binding failure
  // raised inside would therefore be laundered into a confident "you are in sync with origin",
  // which is precisely the silent wrong answer this story exists to delete. Raising it here lets
  // it propagate.
  //
  // Its two consumers (planner-preflight.mjs and planner.mjs) are non-mutating plan-time gates,
  // so a throw stops planning rather than corrupting anything — the correct phase to fail in.
  //
  // The `git fetch origin` below is the sharpest reason this matters: unbound, it is a NETWORK
  // call made against whatever repository the walk-up happened to find.
  assertRepoRoot(projectRoot);
  try {
    // Fetch to get latest remote state
    boundSpawnGit(projectRoot, ["fetch", "origin"], { encoding: "utf8" });

    const branch = boundSpawnGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
    if (branch.status !== 0) {
      return { synced: true, aheadBy: 0, behindBy: 0, diverged: false }; // Assume synced if can't determine
    }
    const currentBranch = branch.stdout.trim();

    const countResult = boundSpawnGit(projectRoot, ["rev-list", "--left-right", "--count", `${currentBranch}...origin/${currentBranch}`], {
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
