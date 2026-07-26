// Shared helpers for git operations — NOT re-exported from barrel.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureTelemetryStorage } from "../telemetry/index.mjs";
import yaml from "js-yaml";

/**
 * Run a git command and return stdout, throwing McpError on failure.
 */
export function runGit(projectRoot, args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
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
