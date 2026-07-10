/**
 * Recovery Agent — Tier 3 Composite
 *
 * "Doctor" agent — diagnoses and repairs broken state. Handles:
 * - Git state issues (merge conflicts, stuck rebases, dirty trees)
 * - Stale lock files
 * - Hook configuration problems
 * - RAG index corruption
 *
 * Architecture: diagnose-then-fix pattern. First tool call always
 * diagnoses, subsequent calls fix specific issues. Uses Git Agent
 * for git repairs, direct utility calls for simpler fixes.
 *
 * Tools (composite + direct):
 * - diagnose: full system health check
 * - fix_git: repair git state (cross-delegates to Git Agent)
 * - fix_dendron: repair notes/frontmatter (cross-delegates to Dendron Agent)
 * - fix_locks: remove stale session/config locks
 * - fix_rag: re-embed or compact the RAG index
 * - fix_hooks: verify and repair hook configuration
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadAgentConfig } from './config.mjs';
import { createGitAgent } from './git.mjs';
import { createDendronAgent } from './dendron.mjs';
import { createCrossDelegationTool, createDelegationCounter } from './cross-delegate.mjs';
import {
  getCascadeState,
  findIncompleteCascades,
  getResumeInfo,
  buildDispatcherResponse,
} from '../workflow/cascade-state.mjs';

// ── Schemas ──────────────────────────────────────────

export const RecoveryInputSchema = z.object({
  projectId: z.string().describe('Project identifier'),
  symptoms: z.string().optional()
    .describe('Description of what went wrong (helps focus diagnosis)'),
  autoFix: z.boolean().optional()
    .describe('If true, automatically apply safe fixes after diagnosis'),
});

export const RecoveryOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.object({
    diagnosis: z.object({
      gitHealthy: z.boolean().optional(),
      locksHealthy: z.boolean().optional(),
      hooksHealthy: z.boolean().optional(),
      ragHealthy: z.boolean().optional(),
      issues: z.array(z.string()).optional(),
    }).optional(),
    fixes: z.array(z.object({
      area: z.string(),
      action: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    })).optional(),
    remainingIssues: z.array(z.string()).optional(),
  }).optional(),
});

// ── Default Prompt ───────────────────────────────────

const DEFAULT_PROMPT = `You are the Recovery Agent, a diagnostic and repair specialist.

Your job is to diagnose broken state and apply targeted fixes. You handle:
- Git problems (merge conflicts, stuck rebases, dirty trees, detached HEAD)
- Stale lock files blocking operations
- Hook configuration issues
- RAG index problems

You have these tools:
1. diagnose — run a full health check (git, locks, hooks, RAG)
2. fix_git — repair git state (delegates to Git Agent for complex repairs)
3. fix_locks — remove stale lock files
4. fix_rag — re-embed or compact the RAG index
5. fix_hooks — verify and repair hook wiring
6. cascade_diagnose — check cascade checkpoint files in .rks/runs/, cross-reference with git state
7. cascade_resume — load a cascade checkpoint and resume from the failed/paused phase
8. fix_dendron — repair note/frontmatter issues (delegates to Dendron Agent)

## Workflow
1. ALWAYS call diagnose first to understand the full picture
2. Review the diagnosis — identify which areas need fixing
3. Apply fixes for each broken area (safest fixes first)
4. Return a structured summary of what was found and fixed

## Rules
- Always diagnose before fixing — never guess
- Apply fixes from safest to riskiest: locks → hooks → RAG → git
- If autoFix is false, diagnose only — report issues without fixing
- If a fix fails, note it but continue with other fixes
- Never force-push, reset --hard, or delete branches without explicit symptoms requesting it
- Maximum 6 tool calls per recovery session

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true/false,
  "summary": "What was found and fixed",
  "data": {
    "diagnosis": {
      "gitHealthy": true/false,
      "locksHealthy": true/false,
      "hooksHealthy": true/false,
      "ragHealthy": true/false,
      "issues": ["list of issues found"]
    },
    "fixes": [{ "area": "git", "action": "abort merge", "ok": true, "detail": "..." }],
    "remainingIssues": ["issues that could not be fixed"]
  }
}`;

// ── Factory ──────────────────────────────────────────

/**
 * Create a Recovery Agent config for the agent runner.
 */
export function createRecoveryAgent({ projectId, symptoms, autoFix, projectRoot }) {
  const cfg = loadAgentConfig('recovery', projectRoot);
  const prompt = cfg.prompt || DEFAULT_PROMPT;

  return {
    name: 'recovery',
    model: cfg.model,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    prompt,
    userMessage: buildUserMessage({ projectId, symptoms, autoFix }),
    inputSchema: RecoveryInputSchema,
    outputSchema: RecoveryOutputSchema,
    rawInput: { projectId, symptoms, autoFix },
    projectId,
    projectRoot,
    tools: buildTools({ projectId, projectRoot }),
  };
}

function buildUserMessage({ projectId, symptoms, autoFix }) {
  const parts = [`Diagnose and repair project ${projectId}.`];
  if (symptoms) parts.push(`Symptoms: ${symptoms}`);
  if (autoFix) parts.push('Auto-fix enabled — apply safe fixes automatically.');
  else parts.push('Diagnosis only — report issues without fixing.');
  return parts.join('\n');
}

// ── Tools ────────────────────────────────────────────

function buildTools({ projectId, projectRoot }) {
  const rksDir = path.join(projectRoot, '.rks');
  const sessionDir = path.join(rksDir, 'session');
  const routekitDir = path.join(projectRoot, '.routekit');
  const hooksDir = path.join(routekitDir, 'hooks');

  const delegationCounter = createDelegationCounter(3);

  const { tool: fixGitTool } = createCrossDelegationTool({
    sourceAgent: 'recovery',
    targetAgent: 'git',
    toolName: 'fix_git',
    description: 'Repair git state by delegating to the Git Agent. Handles: abort merges/rebases, clean dirty state, checkout branches.',
    inputSchema: z.object({
      request: z.string().describe('Natural language description of the git fix needed'),
    }),
    createTarget: (input) => createGitAgent({
      projectId,
      request: input.request,
      projectRoot,
    }),
    projectId,
    projectRoot,
    counter: delegationCounter,
  });

  const { tool: fixDendronTool } = createCrossDelegationTool({
    sourceAgent: 'recovery',
    targetAgent: 'dendron',
    toolName: 'fix_dendron',
    description: 'Repair note and frontmatter issues by delegating to the Dendron Agent. Handles: fix broken frontmatter, validate schemas, update fields.',
    inputSchema: z.object({
      request: z.string().describe('Natural language description of the note/frontmatter fix needed'),
    }),
    createTarget: (input) => createDendronAgent({
      projectId,
      request: input.request,
      projectRoot,
    }),
    projectId,
    projectRoot,
    counter: delegationCounter,
  });

  return [
    // --- diagnose ---
    {
      name: 'diagnose',
      description: 'Run full system health check: git state, lock files, hook configuration, RAG status.',
      inputSchema: z.object({}),
      execute: async () => {
        const issues = [];
        const diagnosis = {
          gitHealthy: true,
          locksHealthy: true,
          hooksHealthy: true,
          ragHealthy: true,
          issues,
        };

        // Git health
        try {
          const gitDir = path.join(projectRoot, '.git');

          const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: projectRoot, encoding: 'utf8',
          });
          const currentBranch = branch.stdout?.trim();

          if (currentBranch === 'HEAD') {
            diagnosis.gitHealthy = false;
            issues.push('git: detached HEAD state');
          }

          const status = spawnSync('git', ['status', '--porcelain'], {
            cwd: projectRoot, encoding: 'utf8',
          });
          const dirtyFiles = (status.stdout || '').split('\n').filter(Boolean);
          if (dirtyFiles.length > 0) {
            issues.push(`git: ${dirtyFiles.length} dirty files`);
          }

          // Check for in-progress operations
          if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
            diagnosis.gitHealthy = false;
            issues.push('git: merge in progress');
          }
          if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
            diagnosis.gitHealthy = false;
            issues.push('git: rebase in progress');
          }
          if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
            diagnosis.gitHealthy = false;
            issues.push('git: cherry-pick in progress');
          }

          // Check conflict files
          const conflicts = dirtyFiles.filter(l =>
            l.startsWith('UU') || l.startsWith('AA') || l.startsWith('DD')
          );
          if (conflicts.length > 0) {
            diagnosis.gitHealthy = false;
            issues.push(`git: ${conflicts.length} conflict files`);
          }

          diagnosis.currentBranch = currentBranch;
          diagnosis.dirtyFiles = dirtyFiles.length;
        } catch (err) {
          diagnosis.gitHealthy = false;
          issues.push(`git: ${err.message}`);
        }

        // Lock files
        try {
          const lockFiles = [];
          const sessionLock = path.join(sessionDir, '.lock');
          if (fs.existsSync(sessionLock)) {
            const stat = fs.statSync(sessionLock);
            const ageMs = Date.now() - stat.mtimeMs;
            lockFiles.push({ path: sessionLock, ageMs, stale: ageMs > 10_000 });
            if (ageMs > 10_000) {
              diagnosis.locksHealthy = false;
              issues.push(`locks: stale session lock (${Math.round(ageMs / 1000)}s old)`);
            }
          }
          const gitLock = path.join(projectRoot, '.git', 'index.lock');
          if (fs.existsSync(gitLock)) {
            const stat = fs.statSync(gitLock);
            const ageMs = Date.now() - stat.mtimeMs;
            lockFiles.push({ path: gitLock, ageMs, stale: ageMs > 30_000 });
            if (ageMs > 30_000) {
              diagnosis.locksHealthy = false;
              issues.push(`locks: stale git index.lock (${Math.round(ageMs / 1000)}s old)`);
            }
          }
          diagnosis.lockFiles = lockFiles;
        } catch (err) {
          issues.push(`locks: ${err.message}`);
        }

        // Hook health
        try {
          if (fs.existsSync(hooksDir)) {
            const hookFiles = fs.readdirSync(hooksDir).filter(f => f.endsWith('.mjs'));
            diagnosis.hookCount = hookFiles.length;

            // Verify each hook is syntactically valid (check it parses)
            for (const hookFile of hookFiles) {
              try {
                const content = fs.readFileSync(path.join(hooksDir, hookFile), 'utf8');
                if (!content.includes('process.exit')) {
                  diagnosis.hooksHealthy = false;
                  issues.push(`hooks: ${hookFile} missing process.exit — may hang`);
                }
              } catch (err) {
                diagnosis.hooksHealthy = false;
                issues.push(`hooks: ${hookFile} unreadable — ${err.message}`);
              }
            }
          } else {
            issues.push('hooks: hooks directory missing');
          }
        } catch (err) {
          issues.push(`hooks: ${err.message}`);
        }

        // RAG health
        try {
          const ragDir = path.join(rksDir, 'rag');
          if (fs.existsSync(ragDir)) {
            const ragFiles = fs.readdirSync(ragDir);
            diagnosis.ragFiles = ragFiles.length;
            if (ragFiles.length === 0) {
              diagnosis.ragHealthy = false;
              issues.push('rag: index directory empty');
            }
          } else {
            diagnosis.ragHealthy = false;
            issues.push('rag: index directory missing');
          }
        } catch (err) {
          issues.push(`rag: ${err.message}`);
        }

        return diagnosis;
      },
    },

    // --- fix_git (cross-delegation to Git Agent) ---
    fixGitTool,

    // --- fix_dendron (cross-delegation to Dendron Agent) ---
    fixDendronTool,

    // --- fix_locks ---
    {
      name: 'fix_locks',
      description: 'Remove stale lock files (session locks, git index locks).',
      inputSchema: z.object({
        force: z.boolean().optional().describe('Remove locks even if not detected as stale'),
      }),
      execute: async (input) => {
        const removed = [];
        const errors = [];

        const lockPaths = [
          { path: path.join(sessionDir, '.lock'), name: 'session', staleMs: 10_000 },
          { path: path.join(projectRoot, '.git', 'index.lock'), name: 'git-index', staleMs: 30_000 },
        ];

        for (const lock of lockPaths) {
          if (!fs.existsSync(lock.path)) continue;

          const stat = fs.statSync(lock.path);
          const ageMs = Date.now() - stat.mtimeMs;
          const isStale = ageMs > lock.staleMs;

          if (isStale || input.force) {
            try {
              fs.unlinkSync(lock.path);
              removed.push({ name: lock.name, ageMs, wasStale: isStale });
            } catch (err) {
              errors.push({ name: lock.name, error: err.message });
            }
          }
        }

        return { removed, errors, count: removed.length };
      },
    },

    // --- fix_rag ---
    {
      name: 'fix_rag',
      description: 'Re-embed or compact the RAG index to fix corruption or missing entries.',
      inputSchema: z.object({
        action: z.enum(['embed', 'compact']).describe('embed: re-index all, compact: optimize existing'),
      }),
      execute: async (input) => {
        try {
          if (input.action === 'embed') {
            const result = spawnSync('node', [
              path.join(projectRoot, 'packages/mcp-rks/src/server/rag.mjs'),
              '--embed', '--project', projectId,
            ], { cwd: projectRoot, encoding: 'utf8', timeout: 60_000 });

            if (result.status !== 0) {
              // Fallback: try via the MCP tool mechanism
              return { ok: false, error: result.stderr?.trim() || 'RAG embed failed', hint: 'Try calling rks_rag_embed manually' };
            }
            return { ok: true, action: 'embed', output: result.stdout?.trim() };
          }

          if (input.action === 'compact') {
            const result = spawnSync('node', [
              path.join(projectRoot, 'packages/mcp-rks/src/server/rag.mjs'),
              '--compact', '--project', projectId,
            ], { cwd: projectRoot, encoding: 'utf8', timeout: 60_000 });

            if (result.status !== 0) {
              return { ok: false, error: result.stderr?.trim() || 'RAG compact failed', hint: 'Try calling rks_rag_compact manually' };
            }
            return { ok: true, action: 'compact', output: result.stdout?.trim() };
          }

          return { ok: false, error: `Unknown action: ${input.action}` };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- fix_hooks ---
    {
      name: 'fix_hooks',
      description: 'Verify hook configuration and repair missing or broken hooks.',
      inputSchema: z.object({}),
      execute: async () => {
        const results = [];

        try {
          // Check hooks directory exists
          if (!fs.existsSync(hooksDir)) {
            return { ok: false, error: 'Hooks directory missing — cannot auto-create', hint: 'Check .routekit/hooks/' };
          }

          // Check settings.json references
          const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
          if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const hooks = settings.hooks || {};

            for (const [event, entries] of Object.entries(hooks)) {
              for (const entry of (Array.isArray(entries) ? entries : [])) {
                const hooksList = entry.hooks || [];
                for (const hook of hooksList) {
                  if (hook.command) {
                    // Extract hook file path from command
                    const fileMatch = hook.command.match(/hooks\/([^\s"]+)/);
                    if (fileMatch) {
                      const hookFile = path.join(hooksDir, fileMatch[1]);
                      if (fs.existsSync(hookFile)) {
                        results.push({ hook: fileMatch[1], event, ok: true });
                      } else {
                        results.push({ hook: fileMatch[1], event, ok: false, error: 'File missing' });
                      }
                    }
                  }
                }
              }
            }
          }

          const allOk = results.every(r => r.ok);
          return { ok: allOk, hooks: results, count: results.length };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- cascade_diagnose ---
    {
      name: 'cascade_diagnose',
      description: 'Check cascade checkpoint files in .rks/runs/. Cross-references with git branches to verify artifact state. Returns incomplete cascades with resume info.',
      inputSchema: z.object({
        runDir: z.string().optional().describe('Specific run directory to diagnose. If omitted, scans all runs.'),
      }),
      execute: async (input) => {
        try {
          // Single run diagnosis
          if (input.runDir) {
            const state = getCascadeState(input.runDir);
            if (!state) {
              return { ok: false, error: `No cascade state in ${input.runDir}` };
            }

            const resumeInfo = getResumeInfo(state);
            const response = buildDispatcherResponse(state);

            // Cross-reference artifacts with git state
            const artifactCheck = {};
            if (state.artifacts?.branch) {
              const branchCheck = spawnSync('git', ['branch', '--list', state.artifacts.branch], {
                cwd: projectRoot, encoding: 'utf8',
              });
              artifactCheck.branchExists = branchCheck.stdout?.trim().length > 0;
            }
            if (state.artifacts?.prNumber) {
              const prCheck = spawnSync('gh', ['pr', 'view', String(state.artifacts.prNumber), '--json', 'state'], {
                cwd: projectRoot, encoding: 'utf8',
              });
              try {
                const prData = JSON.parse(prCheck.stdout || '{}');
                artifactCheck.prState = prData.state || 'unknown';
              } catch {
                artifactCheck.prState = 'unknown';
              }
            }

            return {
              ok: true,
              state,
              resumeInfo,
              dispatcherResponse: response,
              artifactCheck,
            };
          }

          // Scan all incomplete cascades
          const incomplete = findIncompleteCascades(projectRoot);
          const results = incomplete.map((run) => {
            const resumeInfo = getResumeInfo(run.state);
            return {
              runDir: run.runDir,
              runId: run.runId,
              storyId: run.state.storyId,
              status: run.state.status,
              retryFrom: run.state.retryFrom,
              canResume: resumeInfo.canResume,
              completedPhases: resumeInfo.completedPhases || [],
              artifacts: run.state.artifacts,
            };
          });

          return {
            ok: true,
            totalIncomplete: results.length,
            cascades: results,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- cascade_resume ---
    {
      name: 'cascade_resume',
      description: 'Load a cascade checkpoint and resume from the indicated phase. Skips completed phases and calls the appropriate agent for the retry phase.',
      inputSchema: z.object({
        runDir: z.string().describe('Run directory containing cascade.json'),
        approval: z.string().optional().describe('User decision for needs_approval cascades: "approve", "modify", or "abort"'),
      }),
      execute: async (input) => {
        try {
          const state = getCascadeState(input.runDir);
          if (!state) {
            return { ok: false, error: `No cascade state in ${input.runDir}` };
          }

          const resumeInfo = getResumeInfo(state);
          if (!resumeInfo.canResume) {
            return { ok: false, error: resumeInfo.reason };
          }

          // Handle abort
          if (input.approval === 'abort') {
            return {
              ok: true,
              action: 'aborted',
              summary: `Cascade for ${state.storyId} aborted by user.`,
            };
          }

          // Build resume context for the Dispatcher
          const completedPhases = resumeInfo.completedPhases || [];
          const retryPhase = state.retryFrom;

          return {
            ok: true,
            action: 'resume',
            storyId: state.storyId,
            retryFrom: retryPhase,
            completedPhases,
            artifacts: state.artifacts,
            approval: input.approval || null,
            resumeContext: [
              `Previous cascade run ${state.runId} ${state.status === 'needs_approval' ? 'paused for approval' : 'failed'} at phase "${retryPhase}".`,
              `Completed phases: ${completedPhases.join(', ') || 'none'}.`,
              state.artifacts?.branch ? `Artifacts: branch ${state.artifacts.branch}${state.artifacts.commitId ? `, commit ${state.artifacts.commitId}` : ''}.` : null,
              `Resume from "${retryPhase}" phase — do not re-run completed phases.`,
            ].filter(Boolean).join('\n'),
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },
  ];
}
