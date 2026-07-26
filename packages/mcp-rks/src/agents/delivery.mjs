/**
 * Delivery Agent — Tier 3 Composite
 *
 * "Walk-away autonomy" — orchestrates a full release by composing
 * Story, Ship, and Cycle Complete agents. Given a batch of stories,
 * validates them, ships the code, and completes the post-ship lifecycle.
 *
 * Architecture: tools call runAgent() with sub-agent factories.
 * Each sub-agent runs in its own isolated context with separate telemetry.
 * The Delivery Agent manages sequencing, error handling, and rollback.
 *
 * Tools (composite — delegate to sub-agents):
 * - list_ready_stories: find stories ready to ship
 * - validate_batch: validate stories for shippability (Story Agent)
 * - ship_code: ship changes via branch/PR/merge (Ship Agent)
 * - complete_cycles: post-ship lifecycle per story (Cycle Complete Agent)
 * - release_summary: generate release notes from shipped stories
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

// baseBranch intentionally absent — Ship Agent reads from project config.
// title is optional — derived from story IDs if omitted.
export const DeliveryInputSchema = z.object({
  projectId: z.string().describe('Project identifier'),
  title: z.string().optional().describe('Release title (derived from stories if omitted)'),
  storyIds: z.array(z.string()).optional()
    .describe('Specific story IDs to deliver (auto-discovers ready stories if omitted)'),
  dryRun: z.boolean().optional().describe('If true, validate only — do not ship'),
});

export const DeliveryOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.object({
    storiesValidated: z.number().optional(),
    storiesShipped: z.number().optional(),
    cyclesCompleted: z.number().optional(),
    prUrl: z.string().nullable().optional(),
    prNumber: z.number().nullable().optional(),
    validationResults: z.array(z.object({
      storyId: z.string(),
      ok: z.boolean(),
      verdict: z.string().optional(),
      quality: z.number().optional(),
    })).optional(),
    shipResult: z.object({
      ok: z.boolean(),
      branch: z.string().optional(),
      detail: z.string().optional(),
    }).nullable().optional(),
    cycleResults: z.array(z.object({
      storyId: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    })).optional(),
    errors: z.array(z.string()).optional(),
  }).optional(),
});

// ── Default Prompt ───────────────────────────────────

const DEFAULT_PROMPT = `You are the Delivery Agent, a composite orchestrator for releasing code.

Your job is to take a batch of stories through the full release pipeline:
1. Discover or validate the stories to ship
2. Ship the code (branch, PR, merge)
3. Complete post-ship lifecycle for each story

You have these tools:
1. list_ready_stories — find stories in ready/planned status
2. validate_batch — validate stories for shippability (calls Story Agent per story)
3. plan — create an implementation plan for a story (persists to .rks/runs/)
4. implement — apply the plan: create branch, write files to disk, run tests
5. ship_code — ship current changes (calls Ship Agent: branch, PR, merge)
6. complete_cycles — run post-ship lifecycle per story (calls Cycle Complete Agent)
7. release_summary — generate release notes from the shipped stories

## Workflow

1. If no story IDs provided: call list_ready_stories to discover what to ship
2. Call validate_batch with the story IDs to check readiness
3. If dryRun=true, stop here with validation results
4. Call plan for each validated story to create implementation plans
5. Call implement for each planned story to write files to disk
6. Call ship_code to push and merge
7. After merge: call complete_cycles for each shipped story
8. Call release_summary to produce the final report
9. Return structured JSON with all results

## Rules
- If validate_batch shows any story failing, include it in errors but continue with passing stories
- If ship_code fails, STOP — do not attempt complete_cycles
- If dryRun is true, only validate — do not ship or complete
- Always return a complete summary even on partial failure
- Maximum 12 tool calls per delivery

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true/false,
  "summary": "Release summary",
  "data": {
    "storiesValidated": 3,
    "storiesShipped": 3,
    "cyclesCompleted": 3,
    "prUrl": "https://...",
    "prNumber": 123,
    "validationResults": [{ "storyId": "...", "ok": true, "verdict": "pass", "quality": 0.85 }],
    "shipResult": { "ok": true, "branch": "...", "detail": "..." },
    "cycleResults": [{ "storyId": "...", "ok": true, "detail": "..." }],
    "errors": []
  }
}`;

// ── Factory ──────────────────────────────────────────

/**
 * Create a Delivery Agent config for the agent runner.
 */
export function createDeliveryAgent({ projectId, title, storyIds, dryRun, projectRoot }) {
  const cfg = loadAgentConfig('delivery', projectRoot);
  const prompt = cfg.prompt || DEFAULT_PROMPT;
  const releaseTitle = title || (storyIds?.length ? `Deliver ${storyIds.length} stories` : 'Delivery run');

  return {
    name: 'delivery',
    model: cfg.model,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    prompt,
    userMessage: buildUserMessage({ projectId, title: releaseTitle, storyIds, dryRun }),
    inputSchema: DeliveryInputSchema,
    outputSchema: DeliveryOutputSchema,
    rawInput: { projectId, title: releaseTitle, storyIds, dryRun },
    projectId,
    projectRoot,
    tools: buildTools({ projectId, title: releaseTitle, storyIds, projectRoot }),
  };
}

function buildUserMessage({ projectId, title, storyIds, dryRun }) {
  const parts = [`Deliver release "${title}" for project ${projectId}.`];
  if (storyIds?.length) parts.push(`Stories: ${storyIds.join(', ')}`);
  else parts.push('Auto-discover ready stories.');
  if (dryRun) parts.push('DRY RUN — validate only, do not ship.');
  return parts.join('\n');
}

// ── Tools ────────────────────────────────────────────

function buildTools({ projectId, title, storyIds, projectRoot }) {
  const notesDir = path.join(projectRoot, 'notes');

  return [
    // --- list_ready_stories ---
    {
      name: 'list_ready_stories',
      description: 'Find backlog stories that are ready to ship (status: not-implemented, phase: ready or planned).',
      inputSchema: z.object({
        prefix: z.string().optional().describe('Filter by ID prefix (e.g., "backlog.agents")'),
      }),
      execute: async (input) => {
        try {
          const files = fs.readdirSync(notesDir).filter(f =>
            f.startsWith('backlog.') && f.endsWith('.md') && !f.includes('z_implemented') && !f.includes('epics.')
          );

          const stories = [];
          for (const file of files) {
            if (input.prefix && !file.startsWith(input.prefix)) continue;
            const content = fs.readFileSync(path.join(notesDir, file), 'utf8');
            const statusMatch = content.match(/^status:\s*"?([^"\n]+)"?$/m);
            const phaseMatch = content.match(/^phase:\s*"?([^"\n]+)"?$/m);
            const status = statusMatch?.[1]?.trim();
            const phase = phaseMatch?.[1]?.trim();

            if (status === 'not-implemented' && (phase === 'ready' || phase === 'planned')) {
              stories.push({
                id: file.replace('.md', ''),
                status,
                phase,
              });
            }
          }

          return { count: stories.length, stories };
        } catch (err) {
          return { error: err.message };
        }
      },
    },

    // --- validate_batch ---
    {
      name: 'validate_batch',
      description: 'Validate a batch of stories for shippability. Calls the Story Agent for each story.',
      inputSchema: z.object({
        storyIds: z.array(z.string()).describe('Story IDs to validate'),
      }),
      execute: async (input) => {
        const results = [];
        for (const id of input.storyIds) {
          try {
            const storyConfig = createStoryAgent({
              projectId,
              storyId: id,
              action: 'validate',
              projectRoot,
            });
            const result = await runAgent(storyConfig);
            results.push({
              storyId: id,
              ok: result.ok,
              verdict: result.data?.validation?.verdict || (result.ok ? 'pass' : 'fail'),
              quality: result.data?.validation?.quality,
              completeness: result.data?.validation?.completeness,
              gaps: result.data?.validation?.gaps,
              error: result.error,
            });
          } catch (err) {
            results.push({ storyId: id, ok: false, verdict: 'error', error: err.message });
          }
        }

        const allPassed = results.every(r => r.ok);
        return { allPassed, count: results.length, results };
      },
    },


    // --- plan ---
    {
      name: 'plan',
      description: 'Create an implementation plan for a story. Persists the plan to .rks/runs/ for execution. Call before implement.',
      inputSchema: z.object({
        storyId: z.string().describe('Story ID to plan (e.g., backlog.feat.example)'),
      }),
      execute: async (input) => {
        try {
          const { runPlanTool } = await import('../server/planner.mjs');
          return await runPlanTool({ projectId, problemId: input.storyId });
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- implement ---
    {
      name: 'implement',
      description: 'Apply the latest plan: create feature branch, write files to disk, run tests. Call after plan, before ship_code.',
      inputSchema: z.object({
        storyId: z.string().describe('Story ID that was planned'),
        skipTests: z.boolean().optional().describe('Skip verification tests (default false)'),
      }),
      execute: async (input) => {
        try {
          const { runExecTool } = await import('../server/exec.mjs');
          return await runExecTool({
            projectId,
            label: input.storyId,
            skipTests: input.skipTests || false,
            autoCommit: true,
          });
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- ship_code ---
    {
      name: 'ship_code',
      description: 'Ship current changes: branch, commit, push, create PR, merge. Calls the Ship Agent.',
      inputSchema: z.object({
        prTitle: z.string().optional().describe('PR title (defaults to delivery title)'),
      }),
      execute: async (input) => {
        try {
          // Ship Agent reads target branch from project config — no baseBranch param.
          const shipConfig = createShipAgent({
            projectId,
            storyId: storyIds?.[0],
            title: input.prTitle || title,
            projectRoot,
          });
          const result = await runAgent(shipConfig);
          return {
            ok: result.ok,
            branch: result.data?.branch,
            prUrl: result.data?.prUrl,
            prNumber: result.data?.prNumber,
            merged: result.data?.merged,
            stagingSynced: result.data?.stagingSynced,
            error: result.error,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
    },

    // --- complete_cycles ---
    {
      name: 'complete_cycles',
      description: 'Run post-ship lifecycle for each story: mark implemented, update epic, governance, RAG. Calls Cycle Complete Agent per story.',
      inputSchema: z.object({
        storyIds: z.array(z.string()).describe('Story IDs to complete'),
        prNumber: z.number().optional().describe('PR number for reference'),
      }),
      execute: async (input) => {
        const results = [];
        for (const id of input.storyIds) {
          try {
            const cycleConfig = createCycleCompleteAgent({
              projectId,
              storyId: id,
              prNumber: input.prNumber,
              projectRoot,
            });
            const result = await runAgent(cycleConfig);
            results.push({
              storyId: id,
              ok: result.ok,
              storyUpdated: result.data?.storyUpdated,
              epicUpdated: result.data?.epicUpdated,
              governancePassed: result.data?.governancePassed,
              error: result.error,
            });
          } catch (err) {
            results.push({ storyId: id, ok: false, error: err.message });
          }
        }

        const allOk = results.every(r => r.ok);
        return { allOk, count: results.length, results };
      },
    },

    // --- release_summary ---
    {
      name: 'release_summary',
      description: 'Generate a release summary from the delivery results. Returns formatted notes for the release.',
      inputSchema: z.object({
        storiesShipped: z.array(z.string()).describe('Story IDs that were shipped'),
        prNumber: z.number().optional(),
        prUrl: z.string().optional(),
      }),
      execute: async (input) => {
        try {
          const storyDetails = [];
          for (const id of input.storiesShipped) {
            const filePath = path.join(notesDir, `${id}.md`);
            const implPath = path.join(notesDir, `${id.replace('backlog.', 'backlog.z_implemented.')}.md`);
            const p = fs.existsSync(filePath) ? filePath : fs.existsSync(implPath) ? implPath : null;
            if (p) {
              const content = fs.readFileSync(p, 'utf8');
              const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?$/m);
              const descMatch = content.match(/^desc:\s*"?([^"\n]+)"?$/m);
              storyDetails.push({
                id,
                title: titleMatch?.[1]?.trim() || id,
                desc: descMatch?.[1]?.trim() || '',
              });
            } else {
              storyDetails.push({ id, title: id, desc: '' });
            }
          }

          const lines = [`# Release: ${title}`, ''];
          if (input.prUrl) lines.push(`PR: ${input.prUrl}`);
          lines.push(`Stories shipped: ${storyDetails.length}`, '');
          for (const s of storyDetails) {
            lines.push(`- **${s.title}** (${s.id})${s.desc ? `: ${s.desc}` : ''}`);
          }

          return { summary: lines.join('\n'), stories: storyDetails };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
  ];
}
