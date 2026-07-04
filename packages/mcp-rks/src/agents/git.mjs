/**
 * Git Agent
 *
 * Tier 2 Utility agent — handles atomic git operations in isolated context.
 * Returns summaries, not raw output. Does NOT handle multi-step workflows
 * (PRs, merges to staging, releases) — those belong to Shipper/Delivery agents.
 *
 * Tools (server-side, no hooks):
 * - git_state: current branch, dirty files, sync status, merge/rebase/conflict state
 * - git_branch: create a new branch
 * - git_branch_list: list all branches (read-only)
 * - git_checkout: switch branches
 * - git_commit: stage and commit changes
 * - git_stash: stash, pop, list, apply
 * - git_reset: reset HEAD
 * - git_diff: show file changes
 * - git_log: show recent commit history
 * - git_show: show commit content or file at a ref
 * - git_blame: show line authorship for a file
 * - git_describe: describe a ref using nearest tag
 * - git_remote: list remotes
 * - git_merge: merge branches, finalize/abort pending merges
 * - git_restore: restore working tree files
 * - git_conflict_resolve: resolve merge/rebase conflicts
 * - git_cherry_pick: cherry-pick commits
 * - git_tag: create, list, delete tags
 * - gh_pr_list: list pull requests with filters
 * - gh_pr_view: view PR details, CI checks, mergeable state
 * - gh_pr_create: create PR with base branch enforcement
 * - gh_pr_merge: merge PR (squash/merge/rebase)
 * - gh_branch_delete: delete remote/local branches (with protection)
 * - gh_branches_prune: find and delete stale remote branches from merged PRs
 */

import { z } from 'zod';
import { spawnSync } from 'child_process';
import {
  runGitBranch,
  runGitCheckout,
  runGitCommit,
  runGitStash,
  runGitReset,
  runGitMerge,
  runGitRestore,
  runResolveConflict,
  runGitCherryPick,
  runGitTag,
  runGitShow,
  runGitBlame,
  runGitDescribe,
  runGitBranchList,
  runGitRemoteList,
} from '../server/git-tools.mjs';
import { runGit } from '../utils/git.mjs';
import { ghPrList, ghPrView, ghPrCreate, ghPrMerge, ghBranchDelete, ghBranchesPrune } from '../server/gh-tools.mjs';
import { loadAgentConfig } from './config.mjs';

// --- Input Contract ---
export const GitInputSchema = z.object({
  projectId: z.string(),
  request: z.string().describe('Natural language git request (e.g., "show me the current status", "create a branch for feature-x", "stash my changes")'),
});

// --- Output Contract ---
export const GitOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string().describe('Human-readable summary of what happened'),
  data: z.record(z.unknown()).optional().describe('Structured data from the operation'),
});

// --- System Prompt (inline fallback; dendron note overrides) ---
const GIT_SYSTEM_PROMPT = `You are a Git Agent. Your job is to execute atomic git and GitHub operations and return concise summaries. You do NOT handle multi-step workflows like full shipping pipelines, releases, or branch repair — those belong to other agents.

You have these tools:

LOCAL GIT:
1. git_state — get current branch, dirty files, ahead/behind, merge/rebase/conflict state
2. git_branch — create a new branch
3. git_branch_list — list all local and remote branches (read-only)
4. git_checkout — switch to an existing branch
5. git_commit — stage and commit changes
6. git_stash — stash, pop, list, or apply stashed changes
7. git_reset — reset HEAD (soft, mixed, or hard)
8. git_diff — show file changes (staged, unstaged, or between refs)
9. git_log — show recent commit history
10. git_show — show commit content or the content of a file at a specific ref
11. git_blame — show line-by-line authorship for a file
12. git_describe — describe a ref using the nearest reachable tag
13. git_remote — list configured remotes
14. git_merge — merge a branch into the current branch (or finalize a pending merge)
15. git_restore — restore working tree files from index or a specific commit
16. git_conflict_resolve — resolve merge/rebase conflicts (accept ours/theirs, or abort)
17. git_cherry_pick — cherry-pick a commit by SHA (or abort a pending cherry-pick)
18. git_tag — create, list, or delete tags

GITHUB (via gh CLI):
14. gh_pr_list — list pull requests (open, closed, merged, or all) with optional filters
15. gh_pr_view — view PR details: CI checks, review state, mergeable status
16. gh_pr_create — create a PR targeting the integration branch (enforces base branch rail)
17. gh_pr_merge — merge a PR (squash, merge, or rebase)
18. gh_branch_delete — delete remote and/or local branches (refuses protected branches)
19. gh_branches_prune — find and delete stale remote branches from merged PRs (with dry-run preview)

WORKFLOW:
1. If unsure of the current state, call git_state FIRST
2. Parse the user's request to determine which operation(s) are needed
3. Call the appropriate tool(s)
4. Return a JSON summary immediately

HARD LIMITS:
- Maximum 6 tool calls per request
- After your tool calls, you MUST return the JSON answer — do NOT call more tools
- gh_pr_create ENFORCES the base branch rail — it will reject PRs targeting production
- Use gh_pr_view to CHECK status before attempting gh_pr_merge
- If you CANNOT fulfill the request for any reason, return {"ok": false, "summary": "<reason>"} — NEVER explain in prose

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true,
  "summary": "Concise summary of what happened or what the state is",
  "data": { ... structured data from the operation ... }
}`;

/**
 * Create the Git agent configuration.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.request
 * @param {string} params.projectRoot
 */
export function createGitAgent({ projectId, request, projectRoot }) {
  const cfg = loadAgentConfig('git', projectRoot);

  return {
    name: 'git',
    model: cfg.model,
    prompt: cfg.prompt || GIT_SYSTEM_PROMPT,
    userMessage: `Git request: "${request}"\n\nProject: ${projectId}. Execute the appropriate git operation and return a structured summary.`,
    inputSchema: GitInputSchema,
    outputSchema: GitOutputSchema,
    rawInput: { projectId, request },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    tools: [
      // --- git_state ---
      {
        name: 'git_state',
        description: 'Get current git state: branch, dirty/clean, files changed, ahead/behind, merge/rebase/cherry-pick state, conflict files.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const fs = await import('fs');
            const path = await import('path');
            const gitDir = path.default.join(projectRoot, '.git');

            const branch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
            const statusOutput = spawnSync('git', ['status', '--porcelain'], {
              cwd: projectRoot, encoding: 'utf8',
            });
            const lines = (statusOutput.stdout || '').split('\n').filter(Boolean);
            const dirty = lines.length > 0;

            // Ahead/behind
            let ahead = 0, behind = 0;
            try {
              const ab = runGit(projectRoot, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
              const parts = ab.split('\t');
              behind = parseInt(parts[0], 10) || 0;
              ahead = parseInt(parts[1], 10) || 0;
            } catch { /* no upstream */ }

            // Detect merge/rebase/cherry-pick in-progress
            let mergeState = null;
            if (fs.default.existsSync(path.default.join(gitDir, 'MERGE_HEAD'))) {
              mergeState = 'merging';
            } else if (fs.default.existsSync(path.default.join(gitDir, 'rebase-merge')) || fs.default.existsSync(path.default.join(gitDir, 'rebase-apply'))) {
              mergeState = 'rebasing';
            } else if (fs.default.existsSync(path.default.join(gitDir, 'CHERRY_PICK_HEAD'))) {
              mergeState = 'cherry-picking';
            }

            // Detect conflict files
            const conflictFiles = lines
              .filter(l => l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DD') || l.startsWith('AU') || l.startsWith('UA'))
              .map(l => l.slice(3).trim());

            return {
              branch,
              dirty,
              filesChanged: lines.length,
              files: lines.slice(0, 20).map(l => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
              ahead,
              behind,
              mergeState,
              conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
            };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_branch ---
      {
        name: 'git_branch',
        description: 'Create a new git branch. Returns the new branch name.',
        inputSchema: z.object({
          name: z.string().describe('Branch name (without type prefix)'),
          type: z.enum(['feature', 'fix', 'chore', 'refactor']).optional().describe('Branch type prefix (default: feature)'),
        }),
        execute: async (input) => {
          try {
            return await runGitBranch({
              projectRoot,
              name: input.name,
              type: input.type || 'feature',
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_checkout ---
      {
        name: 'git_checkout',
        description: 'Switch to an existing branch.',
        inputSchema: z.object({
          branch: z.string().describe('Branch name to switch to'),
          force: z.boolean().optional().describe('Force checkout (discard local changes)'),
        }),
        execute: async (input) => {
          try {
            return await runGitCheckout({
              projectRoot,
              branch: input.branch,
              force: input.force || false,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_commit ---
      {
        name: 'git_commit',
        description: 'Stage and commit changes with conventional commit format.',
        inputSchema: z.object({
          message: z.string().describe('Commit message (without type prefix)'),
          type: z.enum(['feat', 'fix', 'refactor', 'docs', 'chore', 'test']).optional().describe('Commit type (default: feat)'),
          scope: z.string().optional().describe('Commit scope'),
          files: z.array(z.string()).optional().describe('Specific files to commit (all if omitted)'),
        }),
        execute: async (input) => {
          try {
            return await runGitCommit({
              projectRoot,
              message: input.message,
              type: input.type || 'feat',
              scope: input.scope,
              files: input.files,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_stash ---
      {
        name: 'git_stash',
        description: 'Stash operations: save, pop, list, apply, drop.',
        inputSchema: z.object({
          action: z.enum(['save', 'pop', 'list', 'apply', 'drop']).describe('Stash action'),
          message: z.string().optional().describe('Stash message (for save)'),
          stashIndex: z.number().optional().describe('Stash index (for pop/apply/drop, default 0)'),
        }),
        execute: async (input) => {
          try {
            return await runGitStash({
              projectRoot,
              action: input.action,
              message: input.message,
              stashIndex: input.stashIndex,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_reset ---
      {
        name: 'git_reset',
        description: 'Reset HEAD. Modes: soft (keep staged), mixed (unstage, default), hard (discard all).',
        inputSchema: z.object({
          mode: z.enum(['soft', 'mixed', 'hard']).optional().describe('Reset mode (default: mixed)'),
          target: z.string().optional().describe('Target ref (default: HEAD)'),
          confirm: z.boolean().optional().describe('Required for hard reset'),
        }),
        execute: async (input) => {
          try {
            return await runGitReset({
              projectRoot,
              mode: input.mode || 'mixed',
              target: input.target || 'HEAD',
              confirm: input.confirm || false,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_diff ---
      {
        name: 'git_diff',
        description: 'Show file changes. Can show unstaged, staged, or diff between refs.',
        inputSchema: z.object({
          staged: z.boolean().optional().describe('Show staged changes (default: false, shows unstaged)'),
          ref1: z.string().optional().describe('First ref for comparison'),
          ref2: z.string().optional().describe('Second ref for comparison'),
          file: z.string().optional().describe('Specific file to diff'),
          stat: z.boolean().optional().describe('Show diffstat summary only (default: false)'),
        }),
        execute: async (input) => {
          try {
            const args = ['diff'];
            if (input.staged) args.push('--cached');
            if (input.stat) args.push('--stat');
            if (input.ref1) args.push(input.ref1);
            if (input.ref2) args.push(input.ref2);
            if (input.file) { args.push('--'); args.push(input.file); }

            const output = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
            const diff = (output.stdout || '').trim();

            // Truncate large diffs to prevent context blowout
            const lines = diff.split('\n');
            const truncated = lines.length > 200;
            return {
              diff: truncated ? lines.slice(0, 200).join('\n') + '\n... (truncated)' : diff,
              lineCount: lines.length,
              truncated,
            };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_log ---
      {
        name: 'git_log',
        description: 'Show recent commit history.',
        inputSchema: z.object({
          count: z.number().optional().describe('Number of commits to show (default: 10, max: 50)'),
          oneline: z.boolean().optional().describe('One-line format (default: true)'),
          ref: z.string().optional().describe('Branch or ref to show log for'),
        }),
        execute: async (input) => {
          try {
            const count = Math.min(input.count || 10, 50);
            const args = ['log', `-${count}`];
            if (input.oneline !== false) args.push('--oneline');
            if (input.ref) args.push(input.ref);

            const output = runGit(projectRoot, args);
            const commits = output.split('\n').filter(Boolean);
            return {
              commits,
              count: commits.length,
            };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_merge ---
      {
        name: 'git_merge',
        description: 'Merge a branch into the current branch. Can also finalize a pending merge (--no-edit) or abort one.',
        inputSchema: z.object({
          branch: z.string().optional().describe('Branch to merge into current (omit to finalize pending merge)'),
          noFf: z.boolean().optional().describe('Create a merge commit even if fast-forward is possible'),
          abort: z.boolean().optional().describe('Abort a merge in progress'),
          finalize: z.boolean().optional().describe('Finalize a pending merge (commit with --no-edit)'),
        }),
        execute: async (input) => {
          try {
            if (input.abort) {
              const out = spawnSync('git', ['merge', '--abort'], { cwd: projectRoot, encoding: 'utf8' });
              if (out.status !== 0) return { error: out.stderr?.trim() || 'merge abort failed' };
              return { action: 'merge_aborted' };
            }
            if (input.finalize) {
              const out = spawnSync('git', ['commit', '--no-edit'], { cwd: projectRoot, encoding: 'utf8' });
              if (out.status !== 0) return { error: out.stderr?.trim() || 'merge finalize failed' };
              return { action: 'merge_finalized', output: out.stdout?.trim() };
            }
            if (!input.branch) return { error: 'Branch name required (or use abort/finalize)' };
            const args = ['merge'];
            if (input.noFf) args.push('--no-ff');
            args.push(input.branch);
            const out = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
            if (out.status !== 0) {
              const stderr = out.stderr?.trim() || '';
              if (stderr.includes('CONFLICT') || (out.stdout || '').includes('CONFLICT')) {
                return { action: 'merge_conflict', message: 'Merge conflicts detected — use git_conflict_resolve', output: (out.stdout || '').trim() };
              }
              return { error: stderr || 'merge failed' };
            }
            return { action: 'merged', branch: input.branch, output: (out.stdout || '').trim() };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_restore ---
      {
        name: 'git_restore',
        description: 'Restore working tree files from index or a specific commit. Can unstage files with --staged.',
        inputSchema: z.object({
          files: z.array(z.string()).describe('Files to restore'),
          staged: z.boolean().optional().describe('Restore staged files (unstage, default: false)'),
          source: z.string().optional().describe('Restore from a specific commit/ref'),
        }),
        execute: async (input) => {
          try {
            return await runGitRestore({
              projectRoot,
              files: input.files,
              staged: input.staged || false,
              source: input.source,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_conflict_resolve ---
      {
        name: 'git_conflict_resolve',
        description: 'Resolve merge or rebase conflicts. Accepts ours/theirs strategy for all or specific files, or abort the operation.',
        inputSchema: z.object({
          strategy: z.enum(['ours', 'theirs', 'abort']).describe('Resolution strategy: accept ours, theirs, or abort the merge/rebase'),
          files: z.array(z.string()).optional().describe('Specific files to resolve (all if omitted)'),
        }),
        execute: async (input) => {
          try {
            return await runResolveConflict({
              projectRoot,
              strategy: input.strategy,
              files: input.files || [],
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_cherry_pick ---
      {
        name: 'git_cherry_pick',
        description: 'Cherry-pick a commit by SHA onto the current branch, or abort a pending cherry-pick.',
        inputSchema: z.object({
          commit: z.string().optional().describe('Commit SHA to cherry-pick'),
          noCommit: z.boolean().optional().describe('Apply changes without committing (default: false)'),
          abort: z.boolean().optional().describe('Abort a cherry-pick in progress'),
        }),
        execute: async (input) => {
          try {
            return await runGitCherryPick({
              projectRoot,
              commit: input.commit,
              noCommit: input.noCommit || false,
              abort: input.abort || false,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_tag ---
      {
        name: 'git_tag',
        description: 'Create, list, or delete git tags.',
        inputSchema: z.object({
          action: z.enum(['list', 'create', 'delete']).describe('Tag action'),
          name: z.string().optional().describe('Tag name (required for create/delete)'),
          message: z.string().optional().describe('Annotated tag message (for create)'),
          commit: z.string().optional().describe('Commit to tag (default: HEAD)'),
          pattern: z.string().optional().describe('Filter pattern for list (e.g., "v1.*")'),
        }),
        execute: async (input) => {
          try {
            return await runGitTag({
              projectRoot,
              action: input.action,
              name: input.name,
              message: input.message,
              commit: input.commit,
              pattern: input.pattern,
            });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_show ---
      {
        name: 'git_show',
        description: 'Show commit content or the content of a specific file at a ref. Returns metadata and diff for commits, or raw content for file paths.',
        inputSchema: z.object({
          ref: z.string().optional().describe('Commit SHA, tag, or branch (default: HEAD)'),
          path: z.string().optional().describe('File path to show at the given ref (omit to show full commit)'),
        }),
        execute: async (input) => {
          try {
            return runGitShow(projectRoot, { ref: input.ref, path: input.path });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_blame ---
      {
        name: 'git_blame',
        description: 'Show line-by-line authorship for a file. Returns sha, author, and line number for each line.',
        inputSchema: z.object({
          path: z.string().describe('File path to blame'),
          ref: z.string().optional().describe('Ref to blame at (default: HEAD)'),
        }),
        execute: async (input) => {
          try {
            return runGitBlame(projectRoot, { path: input.path, ref: input.ref });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_describe ---
      {
        name: 'git_describe',
        description: 'Describe a ref using the nearest reachable tag. Returns a version string like "v1.0.0-3-gabcdef".',
        inputSchema: z.object({
          ref: z.string().optional().describe('Ref to describe (default: HEAD)'),
          tagsOnly: z.boolean().optional().describe('Use only tags (not annotated, default: false)'),
          dirty: z.boolean().optional().describe('Append -dirty suffix if working tree is modified (default: false)'),
        }),
        execute: async (input) => {
          try {
            return runGitDescribe(projectRoot, { ref: input.ref, tagsOnly: input.tagsOnly, dirty: input.dirty });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_branch_list ---
      {
        name: 'git_branch_list',
        description: 'List all local and remote branches. Returns branch name, whether it is current, and upstream remote if set.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            return runGitBranchList(projectRoot);
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- git_remote ---
      {
        name: 'git_remote',
        description: 'List configured git remotes. With verbose=true, includes fetch and push URLs.',
        inputSchema: z.object({
          verbose: z.boolean().optional().describe('Include fetch and push URLs (default: false)'),
        }),
        execute: async (input) => {
          try {
            return runGitRemoteList(projectRoot, { verbose: input.verbose });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- gh_pr_list ---
      {
        name: 'gh_pr_list',
        description: 'List pull requests with optional filters (state, base branch, author).',
        inputSchema: z.object({
          state: z.enum(['open', 'closed', 'merged', 'all']).optional().describe('PR state filter (default: open)'),
          base: z.string().optional().describe('Filter by base branch'),
          author: z.string().optional().describe('Filter by author'),
          limit: z.number().optional().describe('Max results (default: 10, max: 50)'),
        }),
        execute: async (input) => {
          try {
            return await ghPrList({ projectRoot, ...input });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- gh_pr_view ---
      {
        name: 'gh_pr_view',
        description: 'View PR details: title, state, CI checks, review decision, mergeable status.',
        inputSchema: z.object({
          prNumber: z.number().optional().describe('PR number (auto-detects from current branch if omitted)'),
        }),
        execute: async (input) => {
          try {
            return await ghPrView({ projectRoot, ...input });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- gh_pr_create ---
      {
        name: 'gh_pr_create',
        description: 'Create a pull request. Enforces base branch rail — rejects PRs targeting production.',
        inputSchema: z.object({
          targetBranch: z.string().describe('Base branch for the PR (e.g., "staging")'),
          title: z.string().describe('PR title'),
          body: z.string().optional().describe('PR body/description'),
        }),
        execute: async (input) => {
          try {
            return await ghPrCreate({ projectRoot, ...input });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- gh_pr_merge ---
      {
        name: 'gh_pr_merge',
        description: 'Merge a pull request. Defaults to squash merge with branch deletion.',
        inputSchema: z.object({
          prNumber: z.number().optional().describe('PR number (auto-detects from current branch if omitted)'),
          method: z.enum(['squash', 'merge', 'rebase']).optional().describe('Merge method (default: squash)'),
          deleteBranch: z.boolean().optional().describe('Delete branch after merge (default: true)'),
        }),
        execute: async (input) => {
          try {
            return await ghPrMerge({ projectRoot, ...input });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- gh_branch_delete ---
      {
        name: 'gh_branch_delete',
        description: 'Delete remote and/or local branches. Refuses to delete protected branches (main, staging).',
        inputSchema: z.object({
          branches: z.array(z.string()).describe('Branch names to delete'),
          remote: z.boolean().optional().describe('Delete remote branches (default: true)'),
          local: z.boolean().optional().describe('Delete local branches (default: true)'),
        }),
        execute: async (input) => {
          try {
            return await ghBranchDelete({ projectRoot, ...input });
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- gh_branches_prune ---
      {
        name: 'gh_branches_prune',
        description: 'Find and delete remote branches whose PRs are already merged. Skips protected branches. Use dryRun to preview.',
        inputSchema: z.object({
          dryRun: z.boolean().optional().describe('Preview what would be deleted without actually deleting (default: false)'),
        }),
        execute: async (input) => {
          try {
            return await ghBranchesPrune({ projectRoot, ...input });
          } catch (err) {
            return { error: err.message };
          }
        },
      },
    ],
  };
}
