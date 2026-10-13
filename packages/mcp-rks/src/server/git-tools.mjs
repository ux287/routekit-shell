// Barrel re-export — all git tool functions from domain modules.
// Consumers import from this file; implementation lives in git/*.mjs.

export { runGitStash, runGitReset, runGitRevert, runGitTag, runGitCherryPick, runGitRestore, runGitCheckout } from "./git/git-core.mjs";
export { runGitBranch, runGitCommit, runGitMerge, runGitPR } from "./git/git-workflow.mjs";
export { runStagingMerge, runRelease, runSyncStaging, runResolveConflict, runPromote, runBranchRepair } from "./git/git-release.mjs";
export { runCycleComplete, runShip } from "./git/git-ship.mjs";

// Read-only git tools — pure inspection, no side effects.
import { spawnSync } from 'child_process';

export function runGitShow(projectRoot, { ref = 'HEAD', path: filePath } = {}) {
  const args = ['show', '--no-color'];
  if (filePath) args.push(`${ref}:${filePath}`);
  else args.push(ref);
  const out = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  if (out.status !== 0) return { error: (out.stderr || '').trim() || 'git show failed' };
  const content = (out.stdout || '').trim();
  const lines = content.split('\n');
  const truncated = lines.length > 300;
  return { content: truncated ? lines.slice(0, 300).join('\n') + '\n... (truncated)' : content, truncated };
}

export function runGitBlame(projectRoot, { path: filePath, ref } = {}) {
  if (!filePath) return { error: 'path is required for git blame' };
  const args = ['blame', '--porcelain'];
  if (ref) args.push(ref);
  args.push('--', filePath);
  const out = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  if (out.status !== 0) return { error: (out.stderr || '').trim() || 'git blame failed' };
  const lines = [];
  const raw = (out.stdout || '').split('\n');
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (/^[0-9a-f]{40}/.test(line)) {
      const sha = line.slice(0, 40);
      const lineMatch = line.match(/\d+ (\d+)$/);
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : null;
      const authorLine = raw[i + 1] || '';
      const author = authorLine.startsWith('author ') ? authorLine.slice(7) : '';
      lines.push({ sha: sha.slice(0, 8), line: lineNum, author });
    }
  }
  return { blame: lines.slice(0, 200) };
}

export function runGitDescribe(projectRoot, { ref, tagsOnly = false, dirty = false } = {}) {
  const args = ['describe'];
  if (tagsOnly) args.push('--tags');
  if (dirty) args.push('--dirty');
  if (ref) args.push(ref);
  const out = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  if (out.status !== 0) return { error: (out.stderr || '').trim() || 'git describe failed' };
  return { description: (out.stdout || '').trim() };
}

export function runGitBranchList(projectRoot) {
  const out = spawnSync('git', ['branch', '-a', '--format=%(refname:short)|%(HEAD)|%(upstream:short)'], { cwd: projectRoot, encoding: 'utf8' });
  if (out.status !== 0) return { error: (out.stderr || '').trim() || 'git branch failed' };
  const branches = (out.stdout || '').split('\n').filter(Boolean).map(line => {
    const [name, head, remote] = line.split('|');
    return { name, current: head === '*', ...(remote ? { remote } : {}) };
  });
  return { branches };
}

export function runGitRemoteList(projectRoot, { verbose = false } = {}) {
  const args = verbose ? ['remote', '-v'] : ['remote'];
  const out = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  if (out.status !== 0) return { error: (out.stderr || '').trim() || 'git remote failed' };
  if (!verbose) {
    return { remotes: (out.stdout || '').split('\n').filter(Boolean).map(name => ({ name })) };
  }
  const seen = new Map();
  for (const line of (out.stdout || '').split('\n').filter(Boolean)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)/);
    if (!m) continue;
    const [, name, url, type] = m;
    if (!seen.has(name)) seen.set(name, { name });
    seen.get(name)[type] = url;
  }
  return { remotes: [...seen.values()] };
}
