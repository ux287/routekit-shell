// Atomic git operations — stash, reset, revert, tag, cherry-pick, restore, checkout.
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runGit, getCurrentBranch, hasProtectedPathChanges } from "./git-utils.mjs";

/**
 * Handle git stash operations
 */
export async function runGitStash({ projectRoot, action = 'save', message, stashIndex, includeUntracked = false }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_stash] ${timestamp} action=${action}`);

  try {
    switch (action) {
      case 'save': {
        const protectedCheck = hasProtectedPathChanges(projectRoot);
        if (protectedCheck.hasChanges) {
          return {
            ok: false,
            error: 'Cannot stash changes to protected paths',
            details: `File: ${protectedCheck.file} (${protectedCheck.type})`,
            hint: 'Protected paths include .routekit/hooks/ and enforcement configs. Use rks_guardrails_off for governed hook changes, or commit these changes through a proper workflow.'
          };
        }

        const args = ['stash', 'push'];
        if (includeUntracked) args.push('-u');
        if (message) args.push('-m', message);
        const result = runGit(projectRoot, args);
        return { ok: true, action: 'save', message: result, metadata: { timestamp } };
      }
      case 'list': {
        const stashes = runGit(projectRoot, ['stash', 'list']);
        return { ok: true, action: 'list', stashes: stashes.split('\n').filter(Boolean), metadata: { timestamp } };
      }
      case 'apply': {
        const args = ['stash', 'apply'];
        if (stashIndex !== undefined) args.push(`stash@{${stashIndex}}`);
        runGit(projectRoot, args);
        return { ok: true, action: 'apply', stashIndex: stashIndex ?? 0, metadata: { timestamp } };
      }
      case 'pop': {
        const args = ['stash', 'pop'];
        if (stashIndex !== undefined) args.push(`stash@{${stashIndex}}`);
        runGit(projectRoot, args);
        return { ok: true, action: 'pop', stashIndex: stashIndex ?? 0, metadata: { timestamp } };
      }
      case 'drop': {
        const args = ['stash', 'drop'];
        if (stashIndex !== undefined) args.push(`stash@{${stashIndex}}`);
        runGit(projectRoot, args);
        return { ok: true, action: 'drop', stashIndex: stashIndex ?? 0, metadata: { timestamp } };
      }
      default:
        throw new McpError(ErrorCode.InvalidInput, `Unsupported stash action: ${action}`);
    }
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitReset({ projectRoot, mode = 'mixed', target = 'HEAD', confirm = false }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_reset] ${timestamp} mode=${mode} target=${target}`);

  if (mode === 'hard' && !confirm) {
    return { ok: false, error: 'Hard reset requires confirm=true', hint: 'This will discard uncommitted changes' };
  }

  try {
    const args = ['reset'];
    if (mode === 'soft') args.push('--soft');
    else if (mode === 'hard') args.push('--hard');
    args.push(target);

    runGit(projectRoot, args);
    const newHead = runGit(projectRoot, ['rev-parse', 'HEAD']).slice(0, 7);
    return { ok: true, action: 'reset', mode, target, newHead, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitRevert({ projectRoot, commit, noCommit = false }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_revert] ${timestamp} commit=${commit} noCommit=${noCommit}`);

  try {
    const args = ['revert', '--no-edit'];
    if (noCommit) args.push('--no-commit');
    args.push(commit);

    runGit(projectRoot, args);

    if (noCommit) {
      return { ok: true, action: 'revert_staged', originalCommit: commit, metadata: { timestamp } };
    }
    const newCommit = runGit(projectRoot, ['rev-parse', 'HEAD']).slice(0, 7);
    return { ok: true, action: 'reverted', originalCommit: commit, newCommit, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitTag({ projectRoot, action = 'list', name, message, commit, pattern, productionBranch = 'main' }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_tag] ${timestamp} action=${action} name=${name || '(none)'}`);

  try {
    switch (action) {
      case 'list': {
        const args = ['tag', '-l'];
        if (pattern) args.push(pattern);
        const tags = runGit(projectRoot, args);
        return { ok: true, action: 'list', tags: tags.split('\n').filter(Boolean), metadata: { timestamp } };
      }
      case 'create': {
        if (!name) return { ok: false, error: 'Tag name required' };

        // Branch guard: version tags (v followed by digit) must be on the production branch
        if (/^v\d/.test(name)) {
          const currentBranch = getCurrentBranch(projectRoot);
          if (currentBranch !== productionBranch) {
            return { ok: false, error: `Version tags must be created on ${productionBranch}, currently on ${currentBranch}` };
          }
        }

        const args = ['tag'];
        if (message) args.push('-a', name, '-m', message);
        else args.push(name);
        if (commit) args.push(commit);
        runGit(projectRoot, args);
        return { ok: true, action: 'create', tag: name, annotated: !!message, metadata: { timestamp } };
      }
      case 'delete': {
        if (!name) return { ok: false, error: 'Tag name required' };
        runGit(projectRoot, ['tag', '-d', name]);
        return { ok: true, action: 'delete', tag: name, metadata: { timestamp } };
      }
      default:
        return { ok: false, error: `Unsupported tag action: ${action}` };
    }
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitCherryPick({ projectRoot, commit, noCommit = false, abort = false }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_cherry_pick] ${timestamp} commit=${commit || '(abort)'} noCommit=${noCommit}`);

  try {
    if (abort) {
      runGit(projectRoot, ['cherry-pick', '--abort']);
      return { ok: true, action: 'abort', metadata: { timestamp } };
    }

    if (!commit) return { ok: false, error: 'Commit SHA required' };

    const args = ['cherry-pick'];
    if (noCommit) args.push('-n');
    args.push(commit);

    runGit(projectRoot, args);

    if (noCommit) {
      return { ok: true, action: 'cherry_pick_staged', sourceCommit: commit, metadata: { timestamp } };
    }
    const newCommit = runGit(projectRoot, ['rev-parse', 'HEAD']).slice(0, 7);
    return { ok: true, action: 'cherry_picked', sourceCommit: commit, newCommit, metadata: { timestamp } };
  } catch (error) {
    if (error.message?.includes('conflict') || error.message?.includes('CONFLICT')) {
      return { ok: false, error: 'Cherry-pick conflict', hasConflict: true, hint: 'Use rks_cherry_pick with abort=true to cancel' };
    }
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitRestore({ projectRoot, files, staged = false, source }) {
  const timestamp = new Date().toISOString();
  const fileList = Array.isArray(files) ? files : [files];
  console.error(`[rks_restore] ${timestamp} files=${fileList.join(',')} staged=${staged}`);

  try {
    const args = ['restore'];
    if (staged) args.push('--staged');
    if (source) args.push('--source', source);
    args.push('--', ...fileList);

    runGit(projectRoot, args);
    return { ok: true, action: staged ? 'unstage' : 'restore', files: fileList, source: source || 'HEAD', metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitCheckout({ projectRoot, branch, force = false }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_checkout] ${timestamp} switching to branch ${branch} force=${force}`);

  try {
    const previousBranch = getCurrentBranch(projectRoot);

    if (previousBranch === branch) {
      return { ok: true, previousBranch, currentBranch: branch, action: "already_on_branch", metadata: { timestamp } };
    }

    if (!force) {
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
      if (status.stdout.trim()) {
        return { ok: false, error: "Uncommitted changes - commit or stash first", hint: "Use rks_git_commit to commit, rks_stash to stash, or force=true to discard changes" };
      }
    }

    const localBranches = runGit(projectRoot, ["branch", "--list", branch]);
    const remoteBranches = runGit(projectRoot, ["branch", "-r", "--list", `origin/${branch}`]);

    if (!localBranches.trim() && !remoteBranches.trim()) {
      return { ok: false, error: `Branch '${branch}' does not exist`, hint: "Use rks_git_branch to create a new branch" };
    }

    const args = ["checkout"];
    if (force) args.push("-f");
    args.push(branch);

    runGit(projectRoot, args);

    const currentBranch = getCurrentBranch(projectRoot);

    return { ok: true, previousBranch, currentBranch, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
