/**
 * Ship Agent
 *
 * Tier 1 Core agent — orchestrates the full code shipping workflow:
 * branch → commit → push → PR → merge → staging sync.
 *
 * Config-driven: reads PR target branch from project.json.
 * Callers pass only projectId + storyId — everything else is derived.
 *
 * Delegates to existing git-tools functions for atomic operations.
 * Returns structured results with per-step status and partial completion tracking.
 *
 * Tools (server-side, no hooks):
 * - check_state: verify git state and readiness for shipping
 * - prepare_and_push: create branch, stage, commit, push to remote
 * - create_pr: create a pull request via gh CLI
 * - check_pr: check PR status (CI checks, review state)
 * - merge_pr: merge a pull request
 * - sync_staging: sync staging branch with main after merge
 */

import { z } from 'zod';
import { normalizeCheckRollup, allChecksPassed } from "../shared/check-rollup.mjs";
// Verbatim re-export, never a wrapper — see gh-tools.mjs.
export { normalizeCheckRollup, allChecksPassed } from "../shared/check-rollup.mjs";
import { spawnSync } from 'child_process';
import { runGitPR, runStagingMerge, runPromote } from '../server/git-tools.mjs';
import { runGit } from '../utils/git.mjs';
import { loadAgentConfig } from './config.mjs';
import { resolveShipTarget, derivePrTitle, deriveBranchName, deriveCommitMessage } from './project-config.mjs';
import { pollCiStatus } from '../server/ci-polling.mjs';
import { ghPrView } from '../server/gh-tools.mjs';
import fs from 'fs';
import path from 'path';

// --- Input Contract ---
// baseBranch intentionally absent — read from project config, never caller-supplied.
export const ShipInputSchema = z.object({
  projectId: z.string(),
  storyId: z.string().optional().describe('Backlog story ID for traceability'),
  title: z.string().optional().describe('PR title override (derived from story if omitted)'),
});

// --- Output Contract ---
// Use .nullable() alongside .optional() because LLMs often return explicit null
// instead of omitting keys. Zod .optional() only allows undefined, not null.
export const ShipOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string().describe('Human-readable summary of what happened'),
  data: z.object({
    branch: z.string().nullable().optional(),
    prUrl: z.string().nullable().optional(),
    prNumber: z.number().nullable().optional(),
    merged: z.boolean().nullable().optional(),
    stagingSynced: z.boolean().nullable().optional(),
    steps: z.array(z.object({
      step: z.string(),
      ok: z.boolean().nullable().optional(),
      skipped: z.boolean().nullable().optional(),
      detail: z.string().nullable().optional(),
    })).nullable().optional(),
  }).nullable().optional(),
});

// --- System Prompt (inline fallback; dendron note overrides) ---
const SHIP_SYSTEM_PROMPT = `You are a Ship Agent. Your job is to ship code changes through the full workflow: branch → commit → push → PR → merge → staging sync.

You have these tools:
1. check_state — verify current git state (branch, dirty files, ahead/behind)
2. prepare_and_push — create feature branch, stage all changes, commit, and push to remote
3. create_pr — create a pull request targeting the base branch
4. check_pr — check PR status (CI checks, mergeable state)
5. merge_pr — merge a pull request
6. check_ci — poll GitHub Actions CI status for a commit (waits for completion or timeout)
7. sync_staging — sync staging branch with main after merge

WORKFLOW:
1. Call check_state to understand current git state
2. If changes exist: call prepare_and_push to branch, commit, push
3. Call create_pr to open a pull request
4. Call check_pr to verify the PR is mergeable
5. If mergeable: call merge_pr
6. After merge: call check_ci with the merge commit SHA to verify CI passes
7. Call sync_staging to keep staging in sync
8. Return a JSON summary with all steps

HARD LIMITS:
- Maximum 8 tool calls per request
- If any step fails, STOP and return what you have — include the failure in your response
- Do NOT retry failed steps — return the error for the coordinator to handle

OUTPUT FORMAT — CRITICAL:
- You call tools using the tool_use mechanism provided by the API, NOT by writing XML tags
- NEVER output <invoke>, <tool_use>, <parameter>, or any XML tags in your text response
- After all tool calls are complete, return ONLY a raw JSON object (no markdown fences, no prose)
- The JSON must match this schema:
{
  "ok": true/false,
  "summary": "What happened across all steps",
  "data": {
    "branch": "feature branch name",
    "prUrl": "https://github.com/...",
    "prNumber": 123,
    "merged": true/false,
    "stagingSynced": true/false,
    "steps": [{ "step": "name", "ok": true, "detail": "..." }]
  }
}`;

/**
 * Create a Ship Agent configuration.
 *
 * Target branch is read from project config — callers cannot override it.
 * PR title and branch name are derived from storyId if not provided.
 *
 * @param {{ projectId: string, storyId?: string, title?: string, projectRoot: string }} params
 * @returns {object} Agent config for runAgent()
 */
export function createShipAgent({ projectId, storyId, title, projectRoot }) {
  const cfg = loadAgentConfig('ship', projectRoot);

  // Resolve target branch from project config — hard reject main
  const target = resolveShipTarget(projectRoot);
  if (!target.ok) {
    // Return a config that will immediately fail with a clear error
    return {
      name: 'ship',
      model: cfg.model,
      prompt: 'Return the error as JSON.',
      userMessage: JSON.stringify({ ok: false, summary: target.error, data: { steps: [{ step: 'resolve_target', ok: false, detail: target.error }] } }),
      inputSchema: ShipInputSchema,
      outputSchema: ShipOutputSchema,
      rawInput: { projectId, storyId },
      maxTurns: 1,
      timeoutMs: 5_000,
      projectId,
      projectRoot,
      tools: [],
    };
  }
  const targetBranch = target.branch;

  // Detect if target branch is local-only (no remote tracking)
  const remoteCheck = spawnSync('git', ['ls-remote', '--heads', 'origin', targetBranch], { cwd: projectRoot, encoding: 'utf8' });
  const targetBranchIsLocal = remoteCheck.status !== 0 || !remoteCheck.stdout.trim();

  // Derive title and branch from storyId if not explicitly provided
  const prTitle = title || derivePrTitle(projectRoot, storyId) || `feat: ship ${projectId} changes`;
  const branchName = deriveBranchName(storyId);
  const commitMessage = deriveCommitMessage(projectRoot, storyId);

  return {
    name: 'ship',
    model: cfg.model,
    prompt: cfg.prompt || SHIP_SYSTEM_PROMPT,
    userMessage: `Ship the current changes.\n\nPR title: "${prTitle}"\nTarget branch: ${targetBranch}\n${storyId ? `Story: ${storyId}\n` : ''}Project: ${projectId}.\n\nFollow the workflow: check state → prepare & push → create PR → check PR → merge → sync staging. Return structured results.`,
    inputSchema: ShipInputSchema,
    outputSchema: ShipOutputSchema,
    rawInput: { projectId, storyId, title: prTitle },
    fallbackModel: cfg.fallbackModel,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    // Post-run verification (guard 1): branch and merged claims are checked against git and gh.
    verify: (result) => verifyShipClaims(projectRoot, result),
    tools: [
      // --- check_state ---
      {
        name: 'check_state',
        description: 'Check current git state: branch, dirty files, ahead/behind, merge state.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const gitDir = path.join(projectRoot, '.git');
            const branch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
            const statusOutput = spawnSync('git', ['status', '--porcelain'], {
              cwd: projectRoot, encoding: 'utf8',
            });
            const lines = (statusOutput.stdout || '').split('\n').filter(Boolean);
            const dirty = lines.length > 0;

            let ahead = 0, behind = 0;
            try {
              const ab = runGit(projectRoot, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
              const parts = ab.split('\t');
              behind = parseInt(parts[0], 10) || 0;
              ahead = parseInt(parts[1], 10) || 0;
            } catch { /* no upstream */ }

            // Detect merge state
            let mergeState = null;
            if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) mergeState = 'merging';
            else if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) mergeState = 'rebasing';
            else if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) mergeState = 'cherry-picking';

            return {
              branch,
              dirty,
              filesChanged: lines.length,
              files: lines.slice(0, 20).map(l => l.trim()),
              ahead,
              behind,
              mergeState,
              targetBranch,
            };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- prepare_and_push ---
      {
        name: 'prepare_and_push',
        description: 'Create a feature branch (if needed), stage all changes, commit with the given message, and push to remote.',
        inputSchema: z.object({
          branchName: z.string().optional().describe('Feature branch name (auto-generated from story if omitted)'),
          commitMessage: z.string().optional().describe('Commit message (auto-generated from story if omitted)'),
        }),
        execute: async (input) => {
          try {
          // Zero-files guard (moved from lifecycle.mjs)
          const statusOut = spawnSync('git', ['status', '--porcelain'],
            { cwd: projectRoot, encoding: 'utf8' });
          const dirtyFiles = (statusOut.stdout || '').split('\n').filter(Boolean);
          const aheadCheck = spawnSync('git',
            ['rev-list', '--count', `${targetBranch}...HEAD`],
            { cwd: projectRoot, encoding: 'utf8' });
          const ahead = parseInt(aheadCheck.stdout?.trim() || '0', 10);
          if (dirtyFiles.length === 0 && ahead === 0) {
            return { ok: false, error: `Cannot ship: zero files changed and no commits ahead of ${targetBranch}. Nothing to ship.` };
          }

            const currentBranch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);

            // Create branch if on a protected branch
            const protectedBranches = ['main', 'staging', 'dev'];
            let branch = currentBranch;
            if (protectedBranches.includes(currentBranch)) {
              const name = input.branchName || branchName || `rks/${prTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`;
              const out = spawnSync('git', ['checkout', '-b', name], { cwd: projectRoot, encoding: 'utf8' });
              if (out.status !== 0) return { error: `Failed to create branch: ${out.stderr?.trim()}` };
              branch = name;
            }

            // Stage all changes
            const addOut = spawnSync('git', ['add', '-A'], { cwd: projectRoot, encoding: 'utf8' });
            if (addOut.status !== 0) return { error: `Failed to stage: ${addOut.stderr?.trim()}` };

            // Check if there's anything to commit
            const diffOut = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
            if (diffOut.status === 0) {
              // Nothing staged — check if already ahead
              try {
                const ab = runGit(projectRoot, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
                const ahead = parseInt(ab.split('\t')[1], 10) || 0;
                if (ahead > 0) return { branch, committed: false, pushed: false, detail: 'Nothing to commit but branch is ahead of remote' };
              } catch { /* no upstream yet */ }
              return { branch, committed: false, pushed: false, detail: 'Nothing to commit' };
            }

            // Commit
            const msg = input.commitMessage || commitMessage;
            const commitOut = spawnSync('git', ['commit', '-m', msg], { cwd: projectRoot, encoding: 'utf8' });
            if (commitOut.status !== 0) return { error: `Failed to commit: ${commitOut.stderr?.trim()}` };

            // Push (skip when target branch is local-only — no remote ops needed)
            if (targetBranchIsLocal) {
              return { branch, committed: true, pushed: false, detail: 'Target branch is local-only — skipped push' };
            }
            const pushOut = spawnSync('git', ['push', '-u', 'origin', branch], { cwd: projectRoot, encoding: 'utf8' });
            if (pushOut.status !== 0) return { error: `Failed to push: ${pushOut.stderr?.trim()}` };

            return { branch, committed: true, pushed: true };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- create_pr ---
      {
        name: 'create_pr',
        description: 'Create a pull request targeting the config-defined base branch. Skips if PR already exists.',
        inputSchema: z.object({
          prTitle: z.string().optional().describe('Pull request title (auto-derived if omitted)'),
          body: z.string().optional().describe('PR body/description'),
        }),
        execute: async (input) => {
          if (targetBranchIsLocal) {
            return { skipped: true, reason: 'Target branch is local-only — use local merge instead of PR' };
          }
          try {
            // Check for existing PR
            const existing = spawnSync('gh', ['pr', 'view', '--json', 'url,number,state'], { cwd: projectRoot, encoding: 'utf8' });
            if (existing.status === 0) {
              const data = JSON.parse(existing.stdout);
              return { skipped: true, reason: `PR already exists (${data.state})`, url: data.url, number: data.number, state: data.state };
            }

            // Create PR
            const result = await runGitPR({
              projectRoot,
              targetBranch,
              title: input.prTitle || prTitle,
              problemId: storyId,
              reason: storyId ? undefined : 'infrastructure',
              summary: input.body,
              projectId,
              autoMerge: false,
            });

            if (!result.ok) return { error: result.error, hint: result.hint };
            return { url: result.url, number: result.number, created: true };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- check_pr ---
      {
        name: 'check_pr',
        description: 'Check PR status: CI checks, review state, mergeable.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const out = spawnSync('gh', ['pr', 'view', '--json', 'url,number,state,mergeable,reviewDecision,statusCheckRollup'], {
              cwd: projectRoot, encoding: 'utf8',
            });
            if (out.status !== 0) return { error: 'No PR found for current branch' };
            const data = JSON.parse(out.stdout);

            const checks = normalizeCheckRollup(data.statusCheckRollup);

            return {
              url: data.url,
              number: data.number,
              state: data.state,
              mergeable: data.mergeable,
              reviewDecision: data.reviewDecision,
              checks,
              allChecksPassed: allChecksPassed(checks),
            };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- merge_pr ---
      {
        name: 'merge_pr',
        description: 'Merge the current PR. Uses squash merge by default.',
        inputSchema: z.object({
          prNumber: z.number().optional().describe('PR number (auto-detected if omitted)'),
        }),
        execute: async (input) => {
          try {
            // Pre-merge guard (guards 2 and 3, backlog.feat.escalation-safe-side-effecting-agents).
            // Order: already-merged short-circuit → mergeable → no-CI → runStagingMerge, which keeps
            // its own running/failed CI refusals. Every gh call goes through ghPrView (child_process).
            const view = ghPrView({ projectRoot, prNumber: input.prNumber });
            if (!view.ok) {
              return { error: `Refusing to merge: could not read PR state before merging (${view.error})`, refused: true, hint: 'Run check_pr, then merge_pr again.' };
            }
            const pr = view.pr;
            const prRef = pr.number ?? input.prNumber ?? 'for current branch';
            if (pr.state === 'MERGED') {
              // Idempotent: an escalated rerun that reaches merge_pr again does not merge twice.
              return { merged: true, alreadyMerged: true, prNumber: pr.number ?? input.prNumber, detail: `PR #${prRef} is already merged — no merge performed` };
            }
            if (pr.state && pr.state !== 'OPEN') {
              return { error: `Refusing to merge PR #${prRef}: state is ${pr.state}, expected OPEN`, refused: true };
            }
            if (pr.mergeable !== 'MERGEABLE') {
              return {
                error: `Refusing to merge PR #${prRef}: mergeable is ${pr.mergeable ?? 'unknown'}, expected MERGEABLE`,
                refused: true,
                ...(pr.mergeable === 'UNKNOWN' || pr.mergeable == null
                  ? { hint: 'GitHub has not computed mergeability yet — re-run check_pr, then merge_pr.' }
                  : { hint: 'Resolve the conflicts on the PR branch before merging.' }),
              };
            }
            if (!Array.isArray(pr.checks) || pr.checks.length === 0) {
              return { error: `Refusing to merge PR #${prRef}: no CI checks reported — the ship agent does not merge without a CI gate`, refused: true };
            }

            const result = await runStagingMerge({
              projectRoot,
              prNumber: input.prNumber,
              problemId: storyId,
              reason: storyId ? undefined : 'infrastructure',
              projectId,
            });

            if (!result.ok) return { error: result.error, hint: result.hint };
            return { merged: true, commitId: result.commitId };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- local_merge ---
      {
        name: 'local_merge',
        description: 'Merge the current feature branch into the local working branch and clean up. Used in 3-branch workflow where the working branch has no remote.',
        inputSchema: z.object({}),
        execute: async () => {
          if (!targetBranchIsLocal) {
            return { skipped: true, reason: 'Target branch has a remote — use PR merge instead' };
          }
          try {
            const currentBranch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
            if (currentBranch === targetBranch) {
              return { error: `Already on target branch ${targetBranch} — nothing to merge` };
            }
            // Pre-side-effect guard (guard 2): refuse an unexpected base branch or a dirty tree
            // before anything is checked out or merged.
            if (currentBranch === 'main' || currentBranch === 'master' || currentBranch === 'HEAD') {
              return { error: `Refusing local_merge: HEAD is on ${currentBranch}, not a feature branch — unexpected base branch for a merge into ${targetBranch}`, refused: true };
            }
            const dirty = readPorcelain(projectRoot);
            if (!dirty.ok) {
              return { error: `Refusing local_merge: git status failed (${dirty.error})`, refused: true };
            }
            if (dirty.lines.length > 0) {
              return { error: `Refusing local_merge: working tree is dirty — ${dirty.lines.length} uncommitted change(s): ${dirty.lines.slice(0, 10).join(', ')}`, refused: true };
            }
            // Switch to working branch
            runGit(projectRoot, ['checkout', targetBranch]);
            // Merge feature branch
            runGit(projectRoot, ['merge', currentBranch, '--no-ff', '-m', `Merge ${currentBranch} into ${targetBranch}`]);
            // Delete feature branch
            try {
              runGit(projectRoot, ['branch', '-d', currentBranch]);
            } catch {
              // non-fatal — branch may have diverged, leave for manual cleanup
            }
            return { merged: true, from: currentBranch, into: targetBranch, branchDeleted: true };
          } catch (err) {
            // Restore original branch on failure
            try { runGit(projectRoot, ['checkout', '-']); } catch { /* best-effort */ }
            return { error: err.message };
          }
        },
      },

      // --- check_ci ---
      {
        name: 'check_ci',
        description: 'Poll GitHub Actions CI status for a commit SHA. Waits until all checks complete or timeout.',
        inputSchema: z.object({
          sha: z.string().describe('Commit SHA to check CI status for'),
          owner: z.string().optional().describe('Repo owner (auto-detected if omitted)'),
          repo: z.string().optional().describe('Repo name (auto-detected if omitted)'),
        }),
        execute: async (input) => {
          try {
            // Auto-detect owner/repo from git remote
            let owner = input.owner;
            let repo = input.repo;
            if (!owner || !repo) {
              const remoteUrl = runGit(projectRoot, ['remote', 'get-url', 'origin']);
              const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
              if (match) {
                owner = owner || match[1];
                repo = repo || match[2];
              } else {
                return { error: 'Could not detect owner/repo from git remote' };
              }
            }

            const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
            if (!ghToken) {
              return { error: 'No GITHUB_TOKEN or GH_TOKEN in environment' };
            }

            const result = await pollCiStatus(owner, repo, input.sha, ghToken, {
              pollIntervalMs: 10_000,
              timeoutMs: 300_000,
            });

            return result;
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- sync_staging ---
      {
        name: 'sync_staging',
        description: 'Sync staging branch with main after PR merge. Merges main into staging. Skipped when target branch is local-only.',
        inputSchema: z.object({}),
        execute: async () => {
          if (targetBranchIsLocal) {
            return { skipped: true, reason: 'Target branch is local-only — staging sync is not applicable' };
          }
          // Pre-side-effect guard (guard 2): refuse an unexpected base branch before runPromote
          // checks anything out. The dirty-tree refusal stays runPromote's own.
          const head = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
          const headBranch = (head.stdout || '').trim();
          if (head.status !== 0 || !headBranch) {
            return { error: `Refusing sync_staging: could not read the current branch (${(head.stderr || '').trim() || 'git rev-parse failed'})`, refused: true };
          }
          if (headBranch !== targetBranch) {
            return { error: `Refusing sync_staging: HEAD is on branch ${headBranch}, expected base branch ${targetBranch}`, refused: true };
          }
          try {
            const result = await runPromote({
              projectRoot,
              projectId,
              from: 'main',
              to: 'staging',
              push: true,
            });

            if (!result.ok) return { error: result.error };
            return { synced: true, detail: result.summary || 'staging synced with main' };
          } catch (err) {
            return { error: err.message };
          } finally {
            // Always restore checkout to target branch — runPromote may leave us on main
            try { runGit(projectRoot, ['checkout', targetBranch]); } catch { /* best-effort */ }
          }
        },
      },
    ],
  };
}

// ── Post-run verification and guard helpers ─────────

const GIT_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 30_000;

/** git status --porcelain lines, or { ok: false } when git status itself fails. */
function readPorcelain(projectRoot) {
  const out = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (out.status !== 0) return { ok: false, error: (out.stderr || '').trim() || 'git status failed' };
  return { ok: true, lines: (out.stdout || '').split('\n').filter(Boolean).map((l) => l.trim()) };
}

/**
 * Verify a ship result's claims against git and gh — never against the agent's own output.
 *
 * - data.branch (when data.merged is not true): the branch must exist as a local ref or on
 *   origin. With NO origin remote configured, the origin side is observed absent. Only a failed
 *   ls-remote against a configured origin is cannot-observe. Not a HEAD comparison: a successful
 *   merge_pr checks out staging, so a correct data.branch differs from HEAD.
 * - data.merged true: `gh pr view <prNumber> --json state` must report MERGED. A non-zero gh
 *   exit, unparseable output, or no prNumber is cannot-observe.
 *
 * @returns {{ ok: true } | { ok: false, mismatch: string } | { observed: false, reason: string }}
 */
export function verifyShipClaims(projectRoot, result) {
  const data = result?.data || {};
  const mismatches = [];
  const unobserved = [];

  if (typeof data.branch === 'string' && data.branch.trim() && data.merged !== true) {
    const b = data.branch.trim();
    const local = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: projectRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    if (local.status !== 0) {
      const originUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
      if (originUrl.status !== 0) {
        mismatches.push(`branch claimed "${b}" exists neither as a local ref nor on origin (no origin remote configured)`);
      } else {
        const remote = spawnSync('git', ['ls-remote', '--heads', 'origin', b], { cwd: projectRoot, encoding: 'utf8', timeout: GH_TIMEOUT_MS });
        if (remote.status !== 0) {
          unobserved.push(`git ls-remote origin failed while checking branch "${b}": ${(remote.stderr || '').trim() || 'non-zero exit'}`);
        } else if (!(remote.stdout || '').trim()) {
          mismatches.push(`branch claimed "${b}" exists neither as a local ref nor on origin`);
        }
      }
    }
  }

  if (data.merged === true) {
    if (typeof data.prNumber !== 'number') {
      unobserved.push('gh: merged claimed but no prNumber, so the PR state cannot be queried');
    } else {
      const view = spawnSync('gh', ['pr', 'view', String(data.prNumber), '--json', 'state'], { cwd: projectRoot, encoding: 'utf8', timeout: GH_TIMEOUT_MS });
      if (view.status !== 0) {
        unobserved.push(`gh pr view ${data.prNumber} failed: ${(view.stderr || '').trim() || 'non-zero exit'}`);
      } else {
        let state;
        try { state = JSON.parse(view.stdout || '{}').state; } catch { state = undefined; }
        if (!state) unobserved.push(`gh pr view ${data.prNumber} returned no parseable state`);
        else if (state !== 'MERGED') mismatches.push(`merged claimed true for PR #${data.prNumber}, but gh reports state ${state}`);
      }
    }
  }

  if (mismatches.length > 0) return { ok: false, mismatch: mismatches.join('; ') };
  if (unobserved.length > 0) return { observed: false, reason: unobserved.join('; ') };
  return { ok: true };
}
