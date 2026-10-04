/**
 * Lifecycle Agent — Tier 3 Composite
 *
 * Single entry point for full story automation:
 * validate → plan → exec → ship → complete
 *
 * Workflow modes:
 * - full:   validate → plan → (approval gate) → exec → ship → complete
 * - draft:  validate only
 * - plan:   validate → plan → stop
 * - ship:   ship → complete (for already-executed work)
 * - resume: continue from last checkpoint
 *
 * Each phase delegates to a sub-agent or MCP tool function.
 * Checkpoints written to .rks/runs/{runId}/lifecycle.json for resume.
 * Approval gates are configurable per-phase (plan gate enabled by default).
 *
 * Tools (composite — delegate to sub-agents/functions):
 * - check_phase: read checkpoint state for resume
 * - validate_story: validate story via Story Agent
 * - run_plan: call the planner for this story
 * - run_exec: apply plan and run tests
 * - ship_changes: ship via Ship Agent
 * - complete_cycle: post-ship lifecycle via Cycle Complete Agent
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { loadAgentConfig } from './config.mjs';
import { runAgent } from './runner.mjs';
import { createStoryAgent } from './story.mjs';
import { createShipAgent } from './ship.mjs';
import { createCycleCompleteAgent } from './cycle-complete.mjs';

// ── Schemas ──────────────────────────────────────────

export const LifecycleInputSchema = z.object({
  projectId: z.string().describe('Project identifier'),
  storyId: z.string().describe('Story note ID to run through lifecycle'),
  mode: z.enum(['full', 'draft', 'plan', 'ship', 'resume']).default('full')
    .describe('Workflow mode: full (all phases), draft (validate only), plan (validate+plan), ship (ship+complete), resume (from checkpoint)'),
  approvalGates: z.object({
    plan: z.boolean().optional().describe('Require approval after plan phase (default: true)'),
    exec: z.boolean().optional().describe('Require approval after exec phase (default: false)'),
    ship: z.boolean().optional().describe('Require approval after ship phase (default: false)'),
  }).optional().describe('Override which transitions require user approval'),
  skipTests: z.boolean().optional().describe('Skip tests during exec phase'),
});

export const LifecycleOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.object({
    storyId: z.string(),
    mode: z.string(),
    completedPhases: z.array(z.string()).optional(),
    currentPhase: z.string().optional(),
    validation: z.object({
      verdict: z.string(),
      quality: z.number().optional(),
    }).optional(),
    planResult: z.object({
      ok: z.boolean(),
      slug: z.string().optional(),
      stepsCount: z.number().optional(),
    }).optional(),
    execResult: z.object({
      ok: z.boolean(),
      branch: z.string().optional(),
      testsPassed: z.boolean().optional(),
      stepsApplied: z.number().optional(),
    }).optional(),
    shipResult: z.object({
      ok: z.boolean(),
      prUrl: z.string().optional(),
      prNumber: z.number().optional(),
      merged: z.boolean().optional(),
    }).optional(),
    cycleResult: z.object({
      ok: z.boolean(),
      storyUpdated: z.boolean().optional(),
    }).optional(),
    approvalNeeded: z.object({
      phase: z.string(),
      question: z.string(),
    }).optional(),
    error: z.string().optional(),
  }).optional(),
});

// ── Phases ───────────────────────────────────────────

const PHASES = ['validate', 'plan', 'exec', 'ship', 'complete'];
const DEFAULT_GATES = { plan: true, exec: false, ship: false };

// ── Default Prompt ───────────────────────────────────

const DEFAULT_PROMPT = `You are the Lifecycle Agent, a composite orchestrator for full story automation.

Your job is to take a single story through its complete lifecycle:
1. Validate — check story readiness (Story Agent)
2. Plan — create implementation plan (planner)
3. Exec — apply plan, run tests (exec engine)
4. Ship — branch, PR, merge (Ship Agent)
5. Complete — post-ship lifecycle (Cycle Complete Agent)

You have these tools:
1. check_phase — read checkpoint state (for resume mode)
2. validate_story — validate story readiness via Story Agent
3. run_plan — create an implementation plan for the story
4. run_exec — apply the plan and run verification tests
5. ship_changes — ship code via Ship Agent (branch, PR, merge)
6. complete_cycle — post-ship lifecycle via Cycle Complete Agent

## Workflow Modes

- **full**: Run all phases in sequence. Stop at approval gates.
- **draft**: Only validate. Return validation result.
- **plan**: Validate + plan. Stop after plan is created.
- **ship**: Ship + complete. For work that was already exec'd.
- **resume**: Read checkpoint, skip completed phases, continue.

## Rules

- Run phases in order. NEVER skip a phase (except in ship/resume modes).
- If any phase fails, STOP and return what you have.
- If an approval gate is configured, STOP and return needs_approval.
- Maximum 8 tool calls per lifecycle run.
- Return structured JSON with all phase results.

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true,
  "summary": "Concise summary of lifecycle outcome",
  "data": {
    "storyId": "backlog.feat.example",
    "mode": "full",
    "completedPhases": ["validate", "plan"],
    "currentPhase": "plan",
    "validation": { "verdict": "ready", "quality": 0.8 },
    "planResult": { "ok": true, "slug": "example-slug", "stepsCount": 5 },
    "execResult": { "ok": true, "branch": "rks/feat-example", "testsPassed": true, "stepsApplied": 5 },
    "shipResult": { "ok": true, "prUrl": "https://github.com/...", "prNumber": 42, "merged": true },
    "cycleResult": { "ok": true, "storyUpdated": true },
    "error": null
  }
}

When a phase fails, set ok to false and include only the phases that ran. When approval is needed, include approvalNeeded with phase and question.`;

// ── Factory ──────────────────────────────────────────

export function createLifecycleAgent({ projectId, storyId, mode, approvalGates, skipTests, projectRoot }) {
  const cfg = loadAgentConfig('lifecycle', projectRoot);
  const gates = { ...DEFAULT_GATES, ...approvalGates };
  const resolvedMode = mode || 'full';

  return {
    name: 'lifecycle',
    model: cfg.model,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    prompt: cfg.prompt || DEFAULT_PROMPT,
    userMessage: buildUserMessage({ projectId, storyId, mode: resolvedMode, gates, skipTests }),
    inputSchema: LifecycleInputSchema,
    outputSchema: LifecycleOutputSchema,
    rawInput: { projectId, storyId, mode: resolvedMode, approvalGates, skipTests },
    projectId,
    projectRoot,
    tools: buildTools({ projectId, storyId, mode: resolvedMode, gates, skipTests, projectRoot }),
  };
}

function buildUserMessage({ projectId, storyId, mode, gates, skipTests }) {
  const parts = [`Run lifecycle for story "${storyId}" in project ${projectId}.`];
  parts.push(`Mode: ${mode}`);

  if (mode === 'full') {
    const gatePhases = Object.entries(gates).filter(([, v]) => v).map(([k]) => k);
    if (gatePhases.length > 0) {
      parts.push(`Approval gates enabled at: ${gatePhases.join(', ')}`);
    } else {
      parts.push('No approval gates — full autonomous run.');
    }
  }

  if (skipTests) parts.push('Skip tests during exec phase.');

  if (mode === 'resume') {
    parts.push('Resume from last checkpoint — call check_phase first.');
  } else if (mode === 'draft') {
    parts.push('Draft mode — validate only, then stop.');
  } else if (mode === 'plan') {
    parts.push('Plan mode — validate, then create plan, then stop.');
  } else if (mode === 'ship') {
    parts.push('Ship mode — ship already-executed work, then complete cycle.');
  }

  return parts.join('\n');
}

// ── Tools ────────────────────────────────────────────

function buildTools({ projectId, storyId, mode, gates, skipTests, projectRoot }) {
  const checkpointDir = path.join(projectRoot, '.rks', 'lifecycle');

  return [
    // --- check_phase ---
    {
      name: 'check_phase',
      description: 'Read lifecycle checkpoint state for this story. Used in resume mode to skip completed phases.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const cpPath = path.join(checkpointDir, `${storyId.replace(/\./g, '-')}.json`);
          if (!fs.existsSync(cpPath)) {
            return { hasCheckpoint: false, completedPhases: [], currentPhase: PHASES[0] };
          }
          const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
          return {
            hasCheckpoint: true,
            completedPhases: cp.completedPhases || [],
            currentPhase: cp.currentPhase || PHASES[0],
            lastUpdated: cp.lastUpdated,
            artifacts: cp.artifacts || {},
          };
        } catch (err) {
          return { hasCheckpoint: false, error: err.message, completedPhases: [], currentPhase: PHASES[0] };
        }
      },
    },

    // --- validate_story ---
    {
      name: 'validate_story',
      description: 'Validate story readiness via the Story Agent. Returns validation verdict, quality score, and gaps.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const storyConfig = createStoryAgent({
            projectId,
            storyId,
            action: 'validate',
            projectRoot,
          });
          const result = await runAgent(storyConfig);

          // Save checkpoint
          saveCheckpoint(checkpointDir, storyId, 'validate', result.ok, {
            validation: {
              verdict: result.data?.validation?.verdict || (result.ok ? 'pass' : 'fail'),
              quality: result.data?.validation?.quality,
              gaps: result.data?.validation?.gaps,
            },
          });

          return {
            ok: result.ok,
            verdict: result.data?.validation?.verdict || (result.ok ? 'pass' : 'fail'),
            quality: result.data?.validation?.quality,
            completeness: result.data?.validation?.completeness,
            gaps: result.data?.validation?.gaps,
            error: result.error,
          };
        } catch (err) {
          return { ok: false, verdict: 'error', error: err.message };
        }
      },
    },

    // --- run_plan ---
    {
      name: 'run_plan',
      description: 'Create an implementation plan for the story using the planner. Returns plan summary with step count.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          // Import planner function dynamically to avoid circular deps
          const { runPlanTool } = await import('../server/planner.mjs');
          const result = await runPlanTool({
            projectId,
            problemId: storyId,
          });

          const planOk = result.ok !== false && result.status !== 'needs_refinement';

          saveCheckpoint(checkpointDir, storyId, 'plan', planOk, {
            plan: {
              slug: result.slug,
              stepsCount: result.stepsCount || result.steps?.length || 0,
              runDir: result.runFolder,
              status: result.status,
            },
          });

          // Check approval gate
          if (planOk && gates.plan) {
            return {
              ok: true,
              needsApproval: true,
              phase: 'plan',
              question: `Plan created with ${result.stepsCount || '?'} steps for "${storyId}". Review and approve to continue to exec phase.`,
              slug: result.slug,
              stepsCount: result.stepsCount,
              status: result.status,
            };
          }

          return {
            ok: planOk,
            slug: result.slug,
            stepsCount: result.stepsCount,
            status: result.status,
            error: result.error || (planOk ? null : 'Plan needs refinement'),
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- run_exec ---
    {
      name: 'run_exec',
      description: 'Apply the plan and run verification tests. Creates feature branch, applies changes, commits if tests pass.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { runExecTool } = await import('../server/exec.mjs');
          const result = await runExecTool({
            projectId,
            label: storyId,
            skipTests: skipTests || false,
            autoCommit: true,
          });

          saveCheckpoint(checkpointDir, storyId, 'exec', result.ok, {
            exec: {
              branch: result.branch,
              testsPassed: result.testsPassed,
              stepsApplied: result.stepsApplied,
              runId: result.runId,
            },
          });

          // Check approval gate
          if (result.ok && gates.exec) {
            return {
              ok: true,
              needsApproval: true,
              phase: 'exec',
              question: `Exec complete: ${result.stepsApplied} steps applied, tests ${result.testsPassed ? 'passed' : 'skipped'}. Approve to continue to ship phase.`,
              branch: result.branch,
              testsPassed: result.testsPassed,
              stepsApplied: result.stepsApplied,
            };
          }

          return {
            ok: result.ok,
            branch: result.branch,
            testsPassed: result.testsPassed,
            testsSkipped: result.testsSkipped,
            stepsApplied: result.stepsApplied,
            error: result.error,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- ship_changes ---
    {
      name: 'ship_changes',
      description: 'Ship code via Ship Agent: push to remote, create PR, merge. Config-driven target branch.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          // Circuit breaker: refuse to ship if exec phase didn't complete (unless ship mode)
          if (mode !== 'ship') {
            const cp = readCheckpoint(checkpointDir, storyId);
            if (!cp.completedPhases.includes('exec')) {
              return {
                ok: false,
                error: `Cannot ship: exec phase has not completed successfully. Completed phases: [${cp.completedPhases.join(', ')}]. Aborting to prevent shipping unexecuted code.`,
              };
            }

            // Zero-files guard: refuse to ship if nothing was produced
            const { spawnSync: spawnShipCheck } = await import('node:child_process');
            const statusOut = spawnShipCheck('git', ['status', '--porcelain'],
              { cwd: projectRoot, encoding: 'utf8' });
            const dirtyFiles = (statusOut.stdout || '')
              .split('\n').filter(Boolean);
            const aheadCheck = spawnShipCheck('git',
              ['rev-list', '--count', 'staging...HEAD'],
              { cwd: projectRoot, encoding: 'utf8' });
            const ahead = parseInt(
              aheadCheck.stdout?.trim() || '0', 10);
            if (dirtyFiles.length === 0 && ahead === 0) {
              return {
                ok: false,
                error: 'Cannot ship: zero files changed and no commits'
                  + ' ahead of base. Nothing to ship.',
              };
            }
          }
          const shipConfig = createShipAgent({
            projectId,
            storyId,
            projectRoot,
          });
          const result = await runAgent(shipConfig);

          saveCheckpoint(checkpointDir, storyId, 'ship', result.ok, {
            ship: {
              prUrl: result.data?.prUrl,
              prNumber: result.data?.prNumber,
              merged: result.data?.merged,
              branch: result.data?.branch,
            },
          });

          // Check approval gate
          if (result.ok && gates.ship) {
            return {
              ok: true,
              needsApproval: true,
              phase: 'ship',
              question: `Ship complete: PR ${result.data?.prUrl || 'created'}. Approve to continue to cycle complete.`,
              prUrl: result.data?.prUrl,
              prNumber: result.data?.prNumber,
            };
          }

          return {
            ok: result.ok,
            prUrl: result.data?.prUrl,
            prNumber: result.data?.prNumber,
            merged: result.data?.merged,
            branch: result.data?.branch,
            error: result.error,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- complete_cycle ---
    {
      name: 'complete_cycle',
      description: 'Post-ship lifecycle via Cycle Complete Agent: mark implemented, update epic, governance, RAG embed.',
      inputSchema: z.object({
        prNumber: z.number().optional().describe('PR number from ship phase'),
      }),
      execute: async (input) => {
        try {
          // Circuit breaker: refuse to complete if ship phase didn't complete
          const cp = readCheckpoint(checkpointDir, storyId);
          if (!cp.completedPhases.includes('ship')) {
            return {
              ok: false,
              error: `Cannot complete cycle: ship phase has not completed successfully. Completed phases: [${cp.completedPhases.join(', ')}]. Aborting.`,
            };
          }
          const cycleConfig = createCycleCompleteAgent({
            projectId,
            storyId,
            prNumber: input.prNumber,
            projectRoot,
          });
          const result = await runAgent(cycleConfig);

          saveCheckpoint(checkpointDir, storyId, 'complete', result.ok, {
            cycle: {
              storyUpdated: result.data?.storyUpdated,
              epicUpdated: result.data?.epicUpdated,
              governancePassed: result.data?.governancePassed,
            },
          });

          return {
            ok: result.ok,
            storyUpdated: result.data?.storyUpdated,
            epicUpdated: result.data?.epicUpdated,
            governancePassed: result.data?.governancePassed,
            error: result.error,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },
  ];
}

// ── Checkpoint helpers ───────────────────────────────

function readCheckpoint(dir, storyId) {
  try {
    const cpPath = path.join(dir, `${storyId.replace(/\./g, '-')}.json`);
    if (!fs.existsSync(cpPath)) return { completedPhases: [], artifacts: {} };
    return JSON.parse(fs.readFileSync(cpPath, 'utf8'));
  } catch {
    return { completedPhases: [], artifacts: {} };
  }
}

function saveCheckpoint(dir, storyId, phase, ok, artifacts) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cpPath = path.join(dir, `${storyId.replace(/\./g, '-')}.json`);

    let existing = { completedPhases: [], artifacts: {} };
    if (fs.existsSync(cpPath)) {
      try { existing = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch { /* start fresh */ }
    }

    if (ok && !existing.completedPhases.includes(phase)) {
      existing.completedPhases.push(phase);
    }
    existing.currentPhase = ok ? nextPhase(phase) : phase;
    existing.lastUpdated = new Date().toISOString();
    existing.artifacts = { ...existing.artifacts, ...artifacts };

    fs.writeFileSync(cpPath, JSON.stringify(existing, null, 2));
  } catch {
    // Checkpoint save is best-effort
  }
}

function nextPhase(current) {
  const idx = PHASES.indexOf(current);
  return idx >= 0 && idx < PHASES.length - 1 ? PHASES[idx + 1] : 'done';
}
