// Shared helpers for git operations — NOT re-exported from barrel.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import yaml from "js-yaml";

// ── backlog.fix.rungit-repo-root-binding ──────────────────────────────────────────────────────
//
// Second of the two unbound runGit implementations in this codebase (the other is
// packages/mcp-rks/src/utils/git.mjs). Both bound only `cwd`, so git's walk-up meant a
// `projectRoot` that merely sat inside a repository silently operated on the ancestor. THIS one
// is the implementation the destructive `reset --hard origin/<working>` in git-ship.mjs runs
// through — the call that destroyed ~30 unpushed commits on 2026-08-21.
//
// The logic below is deliberately a near-duplicate of the sibling module's rather than a shared
// import: ten test files mock these two modules with partial object literals that do not use
// `importOriginal`, so introducing a new cross-module export would break all ten at once.
// Duplication is the lesser cost, and both copies carry this comment so neither drifts silently.

/** projectRoot -> { dev, ino, realRoot }. */
const _repoRootCache = new Map();

/**
 * ADDITIVE defence in depth — never a substitute for the assertion below.
 * PARENT of projectRoot, because git(1): "It will not exclude the current working directory."
 * `...process.env` because spawnSync's `env` REPLACES rather than merges.
 */
function ceilingEnv(projectRoot) {
  const parent = path.dirname(path.resolve(projectRoot));
  // An empty entry disables the ceiling silently.
  if (!parent || parent === path.resolve(projectRoot)) return { ...process.env };
  return { ...process.env, GIT_CEILING_DIRECTORIES: parent };
}

/** Throw unless projectRoot IS the top level of the repo git resolves from it. */
function assertRepoRoot(projectRoot) {
  let stat;
  try {
    stat = fs.statSync(projectRoot);
  } catch (err) {
    _repoRootCache.delete(projectRoot);
    throw new McpError(
      ErrorCode.InternalError,
      `git binding failed: projectRoot does not exist or is unreadable: ${projectRoot} (${err.code || err.message})`,
    );
  }

  // dev+ino, not the path string: a directory deleted and recreated within a run reuses the path
  // but not the inode, and a stale entry would re-authorise a different directory.
  const cached = _repoRootCache.get(projectRoot);
  // dev+ino alone is NOT sufficient: deleting a directory and recreating it at the same path
  // commonly REUSES the inode (observed on Linux/CI), so a replaced directory compares equal to
  // the cached one and would be served a stale "this is a repository root" verdict. Re-checking
  // the repo marker is one stat and closes that hole — a path that is no longer a repository
  // falls through to a fresh probe, which refuses it.
  if (cached && cached.dev === stat.dev && cached.ino === stat.ino
    && fs.existsSync(path.join(cached.realRoot, ".git"))) {
    return cached.realRoot;
  }


  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: ceilingEnv(projectRoot),
    timeout: 30_000,
  });

  const raw = (probe.stdout || "").trim();
  if (probe.status !== 0 || !raw) {
    // `!raw` matters: several suites stub spawnSync to return { stdout: '', status: 0 } — a
    // SUCCESSFUL EMPTY result. realpathSync('') throws a bare ENOENT nobody can act on.
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
    // Realpath BOTH sides. On macOS os.tmpdir() is /var/folders/… while show-toplevel returns
    // /private/var/folders/… — a raw string compare would reject every legitimate root and break
    // the exec/commit/ship machinery at the same moment this assertion started firing.
    realRoot = fs.realpathSync(raw);
    realDeclared = fs.realpathSync(projectRoot);
  } catch (err) {
    throw new McpError(
      ErrorCode.InternalError,
      `git binding failed: could not resolve real paths for ${projectRoot} / ${raw} (${err.code || err.message})`,
    );
  }

  if (realRoot !== realDeclared) {
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
 * Run a git command and return stdout, throwing McpError on failure.
 */
export function runGit(projectRoot, args) {
  assertRepoRoot(projectRoot);
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: ceilingEnv(projectRoot),
  });
  if (result.status !== 0) {
    const errorText = result.stderr?.trim() || result.stdout?.trim() || "git command failed";
    throw new McpError(ErrorCode.InternalError, errorText);
  }
  return result.stdout.trim();
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(projectRoot) {
  return runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Helper to slugify a string for branch names.
 */
export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Check if this is a guardrails-off session (hooks moved to hooks.bak/).
 */
export function isGuardrailsOffSession(projectRoot) {
  return fs.existsSync(path.join(projectRoot, '.routekit', 'hooks.bak'));
}

/**
 * Check hook integrity before commit.
 */
export function checkHookIntegrity(projectRoot, projectId = "unknown") {
  const collector = ensureTelemetryStorage(projectRoot);

  try {
    if (isGuardrailsOffSession(projectRoot)) {
      collector.emit('hooks.integrity.check', projectId, { status: 'skipped_guardrails_off' });
      return { ok: true };
    }

    const hooksPath = path.join(projectRoot, '.routekit/hooks');

    // Check if hooks directory exists
    if (!fs.existsSync(hooksPath)) {
      collector.emit('hooks.integrity.check', projectId, {
        discoveredHooks: 0,
        hooksPath: '.routekit/hooks'
      });
      return { ok: true, discoveredHooks: [] };
    }

    // Scan directory for .mjs files
    let files;
    try {
      files = fs.readdirSync(hooksPath);
    } catch (error) {
      collector.emit('hooks.integrity.check', projectId, { status: 'error', error: error.message });
      return { ok: true, warning: `Failed to read hooks directory: ${error.message}` };
    }

    const discoveredHooks = files
      .filter(file => file.endsWith('.mjs'))
      .sort();

    collector.emit('hooks.integrity.check', projectId, {
      discoveredHooks: discoveredHooks.length,
      hooksPath: '.routekit/hooks'
    });

    return { ok: true, discoveredHooks };
  } catch (error) {
    collector.emit('hooks.integrity.check', projectId, { status: 'error', error: error.message });
    return { ok: true, warning: `Hook integrity check failed: ${error.message}` };
  }
}

/**
 * Check if git status shows changes to protected paths.
 */
export function hasProtectedPathChanges(projectRoot) {
  const protectedPaths = [
    '.routekit/hooks/',
    '.routekit/enforcement.yaml',
    '.routekit/git-policy.yaml',
    '.routekit/read-policy.yaml',
    '.claude/settings.json'
  ];

  try {
    const status = runGit(projectRoot, ['status', '--porcelain']);
    const changedFiles = status.split('\n').filter(Boolean);

    for (const line of changedFiles) {
      const filePath = line.slice(3);
      for (const protectedPath of protectedPaths) {
        if (filePath.startsWith(protectedPath)) {
          return { hasChanges: true, file: filePath, type: line.slice(0, 2).trim() };
        }
      }
    }

    return { hasChanges: false };
  } catch (error) {
    return { hasChanges: false };
  }
}

/**
 * Update backlog note status to "implemented" and move to z_implemented namespace.
 */
export function updateBacklogStatus(projectRoot, problemId, commitId = null) {
  if (!problemId || typeof problemId !== "string") {
    return { updated: false, error: "no problemId provided" };
  }
  if (!problemId.startsWith("backlog.") || problemId.startsWith("backlog.z_implemented.")) {
    return { updated: false, error: "problemId is not an active backlog item" };
  }
  const notePath = path.join(projectRoot, "notes", `${problemId}.md`);
  if (!fs.existsSync(notePath)) {
    return { updated: false, error: `note file not found: ${notePath}` };
  }
  try {
    const content = fs.readFileSync(notePath, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return { updated: false, error: "no frontmatter found" };
    let frontmatter = fmMatch[1];
    const body = content.slice(fmMatch[0].length);
    if (/^status:\s*implemented/m.test(frontmatter)) return { updated: false, error: "already implemented" };
    frontmatter = frontmatter.replace(/^status:\s*.+$/m, "status: implemented");
    frontmatter = frontmatter.replace(/^updated:\s*.+$/m, `updated: ${Date.now()}`);
    if (commitId) {
      if (/^commitId:/m.test(frontmatter)) {
        frontmatter = frontmatter.replace(/^commitId:\s*.+$/m, `commitId: "${commitId}"`);
      } else {
        frontmatter = frontmatter.trim() + `\ncommitId: "${commitId}"`;
      }
    }
    fs.writeFileSync(notePath, `---\n${frontmatter}\n---${body}`, "utf8");
    const newProblemId = problemId.replace(/^backlog\./, "backlog.z_implemented.");
    const newPath = path.join(projectRoot, "notes", `${newProblemId}.md`);
    fs.renameSync(notePath, newPath);
    return { updated: true, path: newPath, renamed: true };
  } catch (err) {
    return { updated: false, error: err.message };
  }
}

// Valid reasons for shipping without a problemId
export const VALID_UNLINKED_REASONS = ["hotfix", "docs-only", "infrastructure", "off-rail"];
