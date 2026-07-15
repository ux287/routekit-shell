/**
 * Story Agent — Tier 1 Core
 *
 * Orchestrates story lifecycle: read → validate → phase transitions → dependency checks.
 * Acts as the lifecycle coordinator, sequencing validation, context research,
 * and phase management into a cohesive workflow.
 *
 * Tools are local function calls — no MCP round-trip, no hooks.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { loadAgentConfig, loadAgentPrompt } from './config.mjs';

// ── Schemas ──────────────────────────────────────────

export const StoryInputSchema = z.object({
  projectId: z.string().describe('Project identifier from registry'),
  storyId: z.string().describe('Story note ID (e.g., backlog.agents.ship-agent)'),
  action: z.enum(['lifecycle', 'validate', 'advance', 'status']).default('lifecycle')
    .describe('Action to perform: lifecycle (full), validate, advance phase, or status check'),
});

export const StoryOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.object({
    storyId: z.string(),
    phase: z.string().optional(),
    status: z.string().optional(),
    validation: z.object({
      verdict: z.string(),
      quality: z.number().nullable().optional(),
      completeness: z.number().nullable().optional(),
      gaps: z.array(z.string()).nullable().default([]),
    }).optional(),
    dependencies: z.object({
      total: z.number().nullable().default(0),
      resolved: z.number().nullable().default(0),
      blocking: z.array(z.string()).nullable().default([]),
    }).optional(),
    phaseAdvanced: z.object({
      from: z.string(),
      to: z.string(),
    }).optional(),
    stages: z.array(z.object({
      stage: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    })).optional(),
  }).optional(),
});

// ── Default prompt ──────────────────────────────────

const DEFAULT_PROMPT = `You are the Story Agent, a lifecycle coordinator for backlog stories.

Your job is to manage story lifecycle: reading stories, validating readiness,
checking dependencies, and advancing phases.

## Workflow

For "lifecycle" actions:
1. Read the story to understand its current state
2. Check dependencies (if any) to see if they're blocking
3. Validate the story for quality and completeness
4. Report the full status with actionable recommendations

For "validate" actions:
1. Run validation and report results

For "advance" actions:
1. Read current phase
2. Attempt to advance to the next phase
3. Report success or failure with reason

For "status" actions:
1. Read the story and report its current state

## Rules
- Always read the story first before any other action
- If validation fails, include specific gaps and recommendations
- If dependencies are blocking, list them clearly

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true,
  "summary": "Concise summary of what happened",
  "data": {
    "storyId": "backlog.feat.example",
    "phase": "ready",
    "status": "active",
    "validation": { "verdict": "ready", "quality": 0.8, "completeness": 0.9, "gaps": [] },
    "dependencies": { "total": 0, "resolved": 0, "blocking": [] }
  }
}`;

// ── Factory ─────────────────────────────────────────

/**
 * Create a Story Agent config for the agent runner.
 *
 * @param {{ projectId: string, storyId: string, action?: string, projectRoot: string }} input
 * @returns {object} Agent config for runAgent()
 */
export function createStoryAgent({ projectId, storyId, action = 'lifecycle', projectRoot }) {
  const cfg = loadAgentConfig('story', projectRoot);
  const prompt = cfg.prompt || DEFAULT_PROMPT;

  return {
    name: 'story',
    model: cfg.model,
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    prompt,
    userMessage: `${action} story "${storyId}" in project "${projectId}".`,
    inputSchema: StoryInputSchema,
    outputSchema: StoryOutputSchema,
    rawInput: { projectId, storyId, action },
    projectId,
    tools: buildTools({ projectId, storyId, projectRoot }),
  };
}

// ── Tool Builders ───────────────────────────────────

function buildTools({ projectId, storyId, projectRoot }) {
  const notesDir = path.join(projectRoot, 'notes');

  return [
    {
      name: 'read_story',
      description: 'Read a backlog story note. Returns frontmatter fields and body content.',
      inputSchema: z.object({
        storyId: z.string().optional().describe('Story ID to read (defaults to current story)'),
      }),
      execute: async (input) => {
        const id = input.storyId || storyId;
        return readStoryNote(notesDir, id);
      },
    },
    {
      name: 'validate_story',
      description: 'Run comprehensive story validation (quality + completeness scoring). Returns verdict, scores, and gaps.',
      inputSchema: z.object({
        storyId: z.string().optional().describe('Story ID to validate (defaults to current story)'),
      }),
      execute: async (input) => {
        const id = input.storyId || storyId;
        return runValidation(projectId, id, projectRoot);
      },
    },
    {
      name: 'advance_phase',
      description: 'Advance story to the next phase in the lifecycle (draft→ready→planned→executed→implemented). Validates the transition.',
      inputSchema: z.object({
        operation: z.enum(['plan', 'exec', 'ship']).describe('Operation triggering the phase advance'),
      }),
      execute: async (input) => {
        return advanceStoryPhase(projectRoot, storyId, input.operation, projectId);
      },
    },
    {
      name: 'check_dependencies',
      description: 'Check if story dependencies are resolved. Returns blocking/resolved counts and blocking story IDs.',
      inputSchema: z.object({
        storyId: z.string().optional().describe('Story ID to check (defaults to current story)'),
      }),
      execute: async (input) => {
        const id = input.storyId || storyId;
        return checkDependencies(notesDir, id);
      },
    },
    {
      name: 'list_stories',
      description: 'List backlog stories with optional filtering by status, phase, or prefix.',
      inputSchema: z.object({
        prefix: z.string().optional().describe('Filter by note ID prefix (e.g., "backlog.agents")'),
        status: z.string().optional().describe('Filter by status (e.g., "not-implemented", "in-progress")'),
        phase: z.string().optional().describe('Filter by phase (e.g., "draft", "ready")'),
        limit: z.number().optional().describe('Max results (default 20)'),
      }),
      execute: async (input) => {
        return listStories(notesDir, input);
      },
    },
    {
      name: 'research_context',
      description: 'Query RAG index for codebase context related to the story. Returns relevant code snippets and documentation.',
      inputSchema: z.object({
        query: z.string().describe('Search query for RAG'),
        k: z.number().optional().describe('Number of results (default 5)'),
      }),
      execute: async (input) => {
        return queryRag(projectId, projectRoot, input.query, input.k);
      },
    },
  ];
}

// ── Tool Implementations ────────────────────────────

/**
 * Read a story note and return structured data.
 */
function readStoryNote(notesDir, id) {
  const notePath = path.join(notesDir, `${id}.md`);

  if (!fs.existsSync(notePath)) {
    // Check z_implemented namespace
    const implPath = path.join(notesDir, `${id.replace('backlog.', 'backlog.z_implemented.')}.md`);
    if (fs.existsSync(implPath)) {
      return readAndParse(implPath, id, true);
    }
    return { ok: false, error: `Story not found: ${id}` };
  }

  return readAndParse(notePath, id, false);
}

function readAndParse(notePath, id, isImplemented) {
  try {
    const raw = fs.readFileSync(notePath, 'utf8');
    const { parseFrontmatter } = requireDendron();
    const { data: fm, content: body } = parseFrontmatter(raw);

    return {
      ok: true,
      storyId: id,
      isImplemented,
      phase: fm.phase || 'draft',
      status: fm.status || 'not-implemented',
      title: fm.title || '',
      desc: fm.desc || '',
      targetFiles: fm.targetFiles || [],
      dependencies: fm.dependencies || [],
      epic: fm.epic || null,
      bodySummary: body.slice(0, 500) + (body.length > 500 ? '...' : ''),
      bodyLength: body.length,
    };
  } catch (err) {
    return { ok: false, error: `Failed to read story: ${err.message}` };
  }
}

/**
 * Run story validation using the existing story-validator-v2.
 */
async function runValidation(projectId, problemId, projectRoot) {
  try {
    const { validateStory } = await import('../server/story-validator-v2.mjs');
    const result = await validateStory({ projectId, problemId, projectRoot });
    return {
      ok: true,
      verdict: result.verdict || (result.ok ? 'ready' : 'not-ready'),
      quality: result.quality || 0,
      completeness: result.completeness || 0,
      gaps: result.gaps || [],
      recommendations: result.recommendations || [],
    };
  } catch (err) {
    return { ok: false, error: `Validation failed: ${err.message}` };
  }
}

/**
 * Advance story phase using auto-phase module.
 */
async function advanceStoryPhase(projectRoot, problemId, operation, projectId) {
  try {
    const { advancePhase } = await import('../workflow/auto-phase.mjs');
    const result = await advancePhase(projectRoot, problemId, operation, projectId);
    return result;
  } catch (err) {
    return { ok: false, error: `Phase advance failed: ${err.message}` };
  }
}

/**
 * Check if story dependencies are resolved.
 */
function checkDependencies(notesDir, id) {
  const note = readStoryNote(notesDir, id);
  if (!note.ok) return note;

  const deps = note.dependencies || [];
  if (deps.length === 0) {
    return { ok: true, total: 0, resolved: 0, blocking: [], allResolved: true };
  }

  const blocking = [];
  let resolved = 0;

  for (const depId of deps) {
    const depNote = readStoryNote(notesDir, depId);
    if (!depNote.ok) {
      blocking.push(depId);
      continue;
    }
    if (depNote.isImplemented || depNote.status === 'complete' || depNote.phase === 'implemented') {
      resolved++;
    } else {
      blocking.push(depId);
    }
  }

  return {
    ok: true,
    total: deps.length,
    resolved,
    blocking,
    allResolved: blocking.length === 0,
  };
}

/**
 * List stories from the notes directory with optional filtering.
 */
function listStories(notesDir, { prefix, status, phase, limit = 20 } = {}) {
  try {
    if (!fs.existsSync(notesDir)) {
      return { ok: true, stories: [], total: 0 };
    }

    const files = fs.readdirSync(notesDir)
      .filter(f => f.startsWith('backlog.') && f.endsWith('.md') && !f.includes('z_implemented') && !f.includes('z_archive'));

    const { parseFrontmatter } = requireDendron();
    const stories = [];

    for (const file of files) {
      const id = file.replace('.md', '');
      if (prefix && !id.startsWith(prefix)) continue;

      try {
        const raw = fs.readFileSync(path.join(notesDir, file), 'utf8');
        const { data: fm } = parseFrontmatter(raw);

        if (status && fm.status !== status) continue;
        if (phase && fm.phase !== phase) continue;

        stories.push({
          id,
          title: fm.title || '',
          status: fm.status || 'not-implemented',
          phase: fm.phase || 'draft',
          priority: fm.priority || null,
          epic: fm.epic || null,
        });

        if (stories.length >= limit) break;
      } catch {
        // skip malformed notes
      }
    }

    return { ok: true, stories, total: stories.length };
  } catch (err) {
    return { ok: false, error: `Failed to list stories: ${err.message}` };
  }
}

/**
 * Query RAG index for codebase context.
 */
async function queryRag(projectId, projectRoot, query, k = 5) {
  try {
    const ragMod = await import('../server/rag.mjs');
    const ragQuery = ragMod.ragQuery || ragMod.default?.ragQuery;

    if (!ragQuery) {
      return { ok: false, error: 'RAG module not available' };
    }

    const result = await ragQuery({ projectId, q: query, k });
    return { ok: true, ...result };
  } catch (err) {
    // RAG may not be initialized — non-fatal
    return { ok: false, error: `RAG query failed: ${err.message}`, results: [] };
  }
}

// ── Helpers ─────────────────────────────────────────

let _dendronMod = null;
function requireDendron() {
  if (!_dendronMod) {
    // Dynamic require to avoid circular imports at module load
    const dendronPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '..', 'dendron.mjs'
    );
    // We use a sync approach for the cached import
    // The module is already loaded by the server
    _dendronMod = null;
  }
  // Inline frontmatter parser (avoids import issues in agent context)
  return {
    parseFrontmatter(content) {
      const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) return { data: {}, content };

      const data = {};
      let currentKey = null;
      let arrayValues = null;

      for (const line of match[1].split('\n')) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (kv) {
          if (currentKey && arrayValues) {
            data[currentKey] = arrayValues;
            arrayValues = null;
          }
          const [, key, rawVal] = kv;
          const val = rawVal.trim();
          if (val === '' || val === '[]') {
            currentKey = key;
            arrayValues = [];
          } else if (val.startsWith('"') && val.endsWith('"')) {
            data[key] = val.slice(1, -1);
            currentKey = key;
            arrayValues = null;
          } else if (val === 'true') {
            data[key] = true;
            currentKey = null;
          } else if (val === 'false') {
            data[key] = false;
            currentKey = null;
          } else if (!isNaN(Number(val))) {
            data[key] = Number(val);
            currentKey = null;
          } else {
            data[key] = val;
            currentKey = key;
            arrayValues = null;
          }
        } else if (currentKey && arrayValues !== null) {
          const arrItem = line.trim().match(/^-\s+(.+)$/);
          if (arrItem) {
            let v = arrItem[1].trim();
            if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
            arrayValues.push(v);
          }
        }
      }
      if (currentKey && arrayValues) {
        data[currentKey] = arrayValues;
      }

      return { data, content: match[2] };
    },
  };
}
