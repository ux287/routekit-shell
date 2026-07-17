/**
 * Cycle Complete Agent
 *
 * Tier 1 Core agent — handles the post-ship lifecycle:
 * mark story implemented, update epic, run governance, verify git, embed RAG.
 *
 * Ensures nothing gets forgotten after code is shipped.
 *
 * Tools (server-side, no hooks):
 * - mark_implemented: mark backlog story as implemented via dendron
 * - update_epic: update parent epic progress
 * - run_governance: run lint, build, test checks
 * - check_git_state: verify clean git state
 * - embed_rag: trigger RAG re-embedding for changed files
 */

import { z } from 'zod';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveNotesDir, updateField } from '../dendron.mjs';
import { loadAgentConfig } from './config.mjs';
import { ensureTelemetryStorage } from '../server/telemetry/index.mjs';
import { runGit } from '../utils/git.mjs';

// --- Input Contract ---
export const CycleCompleteInputSchema = z.object({
  projectId: z.string(),
  storyId: z.string().describe('Backlog story ID that was shipped'),
  prNumber: z.number().optional().describe('PR number for reference'),
});

// --- Output Contract ---
export const CycleCompleteOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string().describe('Human-readable summary of what happened'),
  data: z.object({
    storyUpdated: z.boolean().optional(),
    epicUpdated: z.boolean().optional(),
    governancePassed: z.boolean().optional(),
    governanceDetails: z.object({
      lint: z.boolean().optional(),
      build: z.boolean().optional(),
      test: z.boolean().optional(),
    }).optional(),
    ragEmbedded: z.boolean().optional(),
    gitClean: z.boolean().optional(),
  }).optional(),
});

// --- System Prompt ---
const CYCLE_COMPLETE_SYSTEM_PROMPT = `You are a Cycle Complete Agent. Your job is to handle the post-ship lifecycle after code has been merged. You ensure nothing gets forgotten.

You have these tools:
1. mark_implemented — mark the backlog story as implemented
2. update_epic — update the parent epic's progress tracking
3. run_governance — run lint, build, and test checks
4. check_git_state — verify the working tree is clean
5. embed_rag — trigger RAG re-embedding for changed files

WORKFLOW:
1. Call mark_implemented to update the story status
2. Call update_epic to update the epic progress
3. Call run_governance to verify lint/build/test pass
4. Call check_git_state to verify clean working tree
5. Call embed_rag to update the RAG index
6. Return a JSON summary

HARD LIMITS:
- Maximum 5 tool calls per request
- If any step fails, note it but continue with remaining steps
- ALL steps should be attempted even if earlier ones fail (non-blocking)

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true/false,
  "summary": "What happened across all steps",
  "data": {
    "storyUpdated": true/false,
    "epicUpdated": true/false,
    "governancePassed": true/false,
    "governanceDetails": { "lint": true, "build": true, "test": true },
    "ragEmbedded": true/false,
    "gitClean": true/false
  }
}`;

/**
 * Create a Cycle Complete Agent configuration.
 */
export function createCycleCompleteAgent({ projectId, storyId, prNumber, projectRoot }) {
  const cfg = loadAgentConfig('cycle-complete', projectRoot);

  return {
    name: 'cycle-complete',
    model: cfg.model,
    prompt: cfg.prompt || CYCLE_COMPLETE_SYSTEM_PROMPT,
    userMessage: `Complete the cycle for story "${storyId}" in project ${projectId}.${prNumber ? ` PR #${prNumber}.` : ''}\n\nRun all post-ship steps: mark implemented, update epic, governance checks, git state, RAG embedding.`,
    inputSchema: CycleCompleteInputSchema,
    outputSchema: CycleCompleteOutputSchema,
    rawInput: { projectId, storyId, prNumber },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    tools: [
      // --- mark_implemented ---
      {
        name: 'mark_implemented',
        description: 'Mark the backlog story as implemented. Updates status field and moves the note to the z_implemented namespace (the filename prefix is the archival marker; phase is preserved per R1.3f).',
        inputSchema: z.object({
          storyId: z.string().describe('Backlog story ID to mark implemented'),
        }),
        execute: async (input) => {
          try {
            const notesDir = resolveNotesDir(projectRoot);
            const storyPath = path.join(notesDir, `${input.storyId}.md`);
            const implementedPath = path.join(notesDir, input.storyId.replace(/^backlog\./, 'backlog.z_implemented.') + '.md');

            if (fs.existsSync(implementedPath)) {
              return { skipped: true, reason: 'already implemented' };
            }

            if (!fs.existsSync(storyPath)) {
              return { error: `Story not found: ${input.storyId}` };
            }

            updateField(notesDir, input.storyId, 'status', 'implemented');
            // R1.3f: phase is intentionally NOT written to 'implemented'. The v2 model
            // collapses implemented into integrated; the filename prefix (backlog.z_implemented.*)
            // is the archival marker, not the phase. See research.2026.06.13.integrated-implemented-released-arc.md.
            // This change closes GAP-3: stories now stay at phase=integrated so rks_release's
            // regex (git-release.mjs:173) finally matches them.

            const newId = input.storyId.replace(/^backlog\./, 'backlog.z_implemented.');
            updateField(notesDir, input.storyId, 'id', newId);
            const newPath = path.join(notesDir, `${newId}.md`);
            fs.renameSync(storyPath, newPath);

            return { updated: true, newId };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- update_epic ---
      {
        name: 'update_epic',
        description: 'Update the parent epic progress. Reads the story to find its epic, then updates the epic note.',
        inputSchema: z.object({
          storyId: z.string().describe('Story ID to find parent epic'),
        }),
        execute: async (input) => {
          try {
            const notesDir = resolveNotesDir(projectRoot);
            // Try both regular and z_implemented paths
            const regularPath = path.join(notesDir, `${input.storyId}.md`);
            const implPath = path.join(notesDir, input.storyId.replace(/^backlog\./, 'backlog.z_implemented.') + '.md');
            const storyPath = fs.existsSync(regularPath) ? regularPath : fs.existsSync(implPath) ? implPath : null;

            if (!storyPath) {
              return { skipped: true, reason: 'Story file not found, cannot determine epic' };
            }

            const content = fs.readFileSync(storyPath, 'utf8');
            const epicMatch = content.match(/^epic:\s*"?([^"\n]+)"?$/m);
            if (!epicMatch) {
              return { skipped: true, reason: 'No epic field in story frontmatter' };
            }

            const epicId = `backlog.epics.${epicMatch[1]}`;
            const epicPath = path.join(notesDir, `${epicId}.md`);
            if (!fs.existsSync(epicPath)) {
              return { skipped: true, reason: `Epic note not found: ${epicId}` };
            }

            // Update the epic's updated timestamp
            updateField(notesDir, epicId, 'updated', Date.now());

            return { updated: true, epicId };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- run_governance ---
      {
        name: 'run_governance',
        description: 'Run governance checks: lint, build, test. Returns per-check results.',
        inputSchema: z.object({}),
        execute: async () => {
          const results = { lint: null, build: null, test: null };

          // Lint
          try {
            const lint = spawnSync('npm', ['run', 'lint', '--if-present'], {
              cwd: projectRoot, encoding: 'utf8', timeout: 60_000,
            });
            results.lint = lint.status === 0;
          } catch {
            results.lint = false;
          }

          // Build
          try {
            const build = spawnSync('npm', ['run', 'build', '--if-present'], {
              cwd: projectRoot, encoding: 'utf8', timeout: 120_000,
            });
            results.build = build.status === 0;
          } catch {
            results.build = false;
          }

          // Test
          try {
            const test = spawnSync('npm', ['test', '--if-present'], {
              cwd: projectRoot, encoding: 'utf8', timeout: 120_000,
            });
            results.test = test.status === 0;
          } catch {
            results.test = false;
          }

          const allPassed = results.lint !== false && results.build !== false && results.test !== false;
          return { allPassed, ...results };
        },
      },

      // --- check_git_state ---
      {
        name: 'check_git_state',
        description: 'Verify git working tree is clean and on the expected branch.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const branch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
            const statusOutput = spawnSync('git', ['status', '--porcelain'], {
              cwd: projectRoot, encoding: 'utf8',
            });
            const lines = (statusOutput.stdout || '').split('\n').filter(Boolean);
            const clean = lines.length === 0;

            return { branch, clean, filesChanged: lines.length };
          } catch (err) {
            return { error: err.message };
          }
        },
      },

      // --- embed_rag ---
      {
        name: 'embed_rag',
        description: 'Trigger RAG re-embedding for recently changed files.',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            // Get recently changed files from last commit
            const diff = spawnSync('git', ['diff', '--name-only', 'HEAD~1'], {
              cwd: projectRoot, encoding: 'utf8',
            });
            const changedFiles = (diff.stdout || '').split('\n').filter(Boolean);

            if (changedFiles.length === 0) {
              return { skipped: true, reason: 'No changed files to embed' };
            }

            // Try to trigger RAG embedding via the rag-embed-on-commit hook mechanism
            // The hook does this automatically on commits, but we trigger it explicitly here
            try {
              const { ragEmbed } = await import('../server/rag.mjs');
              if (ragEmbed) {
                await ragEmbed({ projectRoot, projectId, files: changedFiles });
                return { embedded: true, fileCount: changedFiles.length };
              }
            } catch {
              // RAG module may not be available
            }

            // Fallback: just report the files that should be embedded
            return { embedded: false, fileCount: changedFiles.length, files: changedFiles.slice(0, 10), hint: 'RAG module not available — files listed for manual embedding' };
          } catch (err) {
            return { error: err.message };
          }
        },
      },
    ],
  };
}
