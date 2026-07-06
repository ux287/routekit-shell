/**
 * Dendron Agent
 *
 * Tier 2 Utility agent — handles note CRUD operations in isolated context.
 * Returns confirmations and summaries, not raw file contents.
 * Manages frontmatter, schema validation, field updates, and note lifecycle.
 *
 * Tools (server-side, no hooks):
 * - dendron_create: create a new note with frontmatter + optional schema/template
 * - dendron_read: read a note's content
 * - dendron_edit: replace a note's body (preserves frontmatter)
 * - dendron_update_field: update a single frontmatter field
 * - dendron_fix_frontmatter: ensure required frontmatter fields exist
 * - dendron_validate: validate frontmatter for notes matching a pattern
 * - dendron_mark_implemented: move a backlog story to z_implemented
 */

import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveNotesDir,
  readNoteRaw,
  writeNoteRaw,
  frontmatterDefaults,
  formatWithFrontmatter,
  parseFrontmatter,
  hasFrontmatter,
  validateNoteFrontmatter,
  canonicalIdFromFilename,
  findMatchingSchema,
  loadSchemaTemplate,
  mergeTemplateWithGenerated,
  updateField,
  updateFieldDirect,
  editNote,
  markImplemented,
} from '../dendron.mjs';
import { loadAgentConfig } from './config.mjs';
import { runRagEmbed } from '../rag/tools.mjs';

// --- Input Contract ---
// `content` (and the create-note convenience fields below) are forwarded by the
// auto-route path (server.mjs TOOL_TO_AGENT_MAP buildInput for dendron_create_note)
// so the verbatim helper can write content byte-equal without going through the LLM.
// backlog.fix.dendron-agent-rewrites-content
export const DendronInputSchema = z.object({
  projectId: z.string(),
  request: z.string().describe('Natural language dendron request (e.g., "create a backlog note for X", "read the note backlog.foo", "update status to implemented")'),
  filename: z.string().optional().describe('Optional: filename for dendron_create_note auto-route (bypasses LLM)'),
  title: z.string().optional().describe('Optional: title for dendron_create_note auto-route'),
  desc: z.string().optional().describe('Optional: desc for dendron_create_note auto-route'),
  content: z.string().optional().describe('Optional: body content for dendron_create_note auto-route — written byte-equal'),
  testFile: z.string().optional().describe('Optional: testFile field for dendron_create_note auto-route'),
});

// --- Output Contract ---
export const DendronOutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string().describe('Human-readable summary of what happened'),
  data: z.record(z.unknown()).optional().describe('Structured data from the operation'),
});

// --- System Prompt (inline fallback; dendron note overrides) ---
const DENDRON_SYSTEM_PROMPT = `You are a Dendron Agent. Your job is to manage project notes — create, read, edit, validate, and manage lifecycle. You return concise summaries, not raw file contents.

You have these tools:
1. dendron_create — create a new note with frontmatter (optional title, desc, content)
2. dendron_read — read a note by filename (returns content)
3. dendron_edit — replace a note's body content (preserves frontmatter)
4. dendron_update_field — update a single frontmatter field (e.g., status, phase, targetFiles)
5. dendron_fix_frontmatter — ensure a note has required frontmatter fields
6. dendron_validate — validate frontmatter for notes matching a glob pattern
7. dendron_mark_implemented — move a backlog story to z_implemented namespace

NAMING CONVENTIONS:
- Backlog stories: backlog.{category}.{slug} (e.g., backlog.agents.git-agent)
- Docs: docs.{topic} (e.g., docs.hooks-inventory)
- Design: design.{topic}
- Agent prompts: agents.{name}.prompt

WORKFLOW:
1. Parse the request to determine which operation is needed
2. Call the appropriate tool — usually just ONE
3. Return a JSON summary immediately

HARD LIMITS:
- Maximum 3 tool calls per request
- After your tool calls, you MUST return the JSON answer — do NOT call more tools
- When reading notes, summarize the content in your response — do NOT return raw markdown

RESPOND WITH ONLY a JSON object matching this schema:
{
  "ok": true,
  "summary": "Concise summary of what happened",
  "data": { ... structured data from the operation ... }
}`;

/**
 * Create the Dendron agent configuration.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.request
 * @param {string} params.projectRoot
 */
export function createDendronAgent({ projectId, request, projectRoot }) {
  const cfg = loadAgentConfig('dendron', projectRoot);
  const notesDir = resolveNotesDir(projectRoot);

  function notePathFromFilename(filename) {
    const safe = String(filename || '').trim();
    return path.join(notesDir, safe.endsWith('.md') ? safe : `${safe}.md`);
  }

  return {
    name: 'dendron',
    model: cfg.model,
    prompt: cfg.prompt || DENDRON_SYSTEM_PROMPT,
    userMessage: `Dendron request: "${request}"\n\nProject: ${projectId}. Execute the appropriate note operation and return a structured summary.`,
    inputSchema: DendronInputSchema,
    outputSchema: DendronOutputSchema,
    rawInput: { projectId, request },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    tools: [
      // --- dendron_create ---
      {
        name: 'dendron_create',
        description: 'Create a new Dendron note with frontmatter. Optionally applies schema templates.',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension (e.g., backlog.agents.foo)'),
          title: z.string().optional().describe('Note title'),
          desc: z.string().optional().describe('Note description'),
          content: z.string().optional().describe('Markdown body content'),
          testFile: z.string().optional().describe('Path to the test file that validates this story'),
        }),
        async execute({ filename, title, desc, content, testFile }) {
          const notePath = notePathFromFilename(filename);
          if (fs.existsSync(notePath)) {
            return { error: `Note already exists: ${filename}` };
          }
          const id = canonicalIdFromFilename(filename);
          const generated = frontmatterDefaults({ id, title: title || null, desc: desc || null });
          if (filename.startsWith('backlog.') && !filename.includes('z_implemented') && !filename.includes('z_archive')) {
            generated.phase = 'draft';
          }
          if (testFile) generated.testFile = testFile;
          const body = content || '';
          const schema = findMatchingSchema(notesDir, filename);
          const resultMeta = { ok: true, path: `${filename}.md`, id };
          if (schema && schema.template) {
            const tpl = loadSchemaTemplate(notesDir, schema.template);
            if (tpl) {
              const { merged, body: mergedBody } = mergeTemplateWithGenerated({ generated, templateParsed: tpl.parsed, content: body, id });
              writeNoteRaw(notePath, formatWithFrontmatter(merged, mergedBody));
              resultMeta.schema = schema.id;
            } else {
              writeNoteRaw(notePath, formatWithFrontmatter(generated, body));
            }
          } else {
            writeNoteRaw(notePath, formatWithFrontmatter(generated, body));
          }
          try {
            const embedResult = await runRagEmbed(projectRoot, { files: [path.relative(projectRoot, notePath)] });
            if (embedResult && embedResult.ok === false) {
              resultMeta.ragEmbedWarning = embedResult.error ?? 'runRagEmbed returned ok: false';
            }
          } catch (err) {
            resultMeta.ragEmbedWarning = err?.message ?? String(err);
          }
          return resultMeta;
        },
      },
      // --- dendron_read ---
      {
        name: 'dendron_read',
        description: 'Read a Dendron note by filename. Returns the full content (frontmatter + body).',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension'),
        }),
        async execute({ filename }) {
          const notePath = notePathFromFilename(filename);
          if (!fs.existsSync(notePath)) {
            return { ok: false, error: `Note not found: ${filename}` };
          }
          const raw = readNoteRaw(notePath);
          return { ok: true, filename, content: raw };
        },
      },
      // --- dendron_edit ---
      {
        name: 'dendron_edit',
        description: 'Replace a note body. Preserves frontmatter, updates the "updated" timestamp.',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension'),
          content: z.string().describe('New markdown body content (replaces existing body, frontmatter preserved)'),
        }),
        async execute({ filename, content }) {
          let result;
          try {
            result = editNote(notesDir, filename, content);
          } catch (err) {
            return { ok: false, error: err.message };
          }
          const notePath = notePathFromFilename(filename);
          try {
            const embedResult = await runRagEmbed(projectRoot, { files: [path.relative(projectRoot, notePath)] });
            if (embedResult && embedResult.ok === false) {
              result.ragEmbedWarning = embedResult.error ?? 'runRagEmbed returned ok: false';
            }
          } catch (err) {
            result.ragEmbedWarning = err?.message ?? String(err);
          }
          return result;
        },
      },
      // --- dendron_update_field ---
      {
        name: 'dendron_update_field',
        description: 'Update a single frontmatter field in a note (e.g., status, phase, targetFiles).',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension'),
          field: z.string().describe('Frontmatter field name'),
          value: z.union([
            z.string(),
            z.array(z.unknown()),
          ]).describe('New value — string for scalars, array for list fields like targetFiles'),
        }),
        async execute({ filename, field, value }) {
          const notePath = notePathFromFilename(filename);
          const result = Array.isArray(value)
            ? updateFieldDirect(notesDir, filename, field, value)
            : updateField(notesDir, filename, field, value);
          try {
            const embedResult = await runRagEmbed(projectRoot, { files: [path.relative(projectRoot, notePath)] });
            if (embedResult && embedResult.ok === false) {
              result.ragEmbedWarning = embedResult.error ?? 'runRagEmbed returned ok: false';
            }
          } catch (err) {
            result.ragEmbedWarning = err?.message ?? String(err);
          }
          return result;
        },
      },
      // --- dendron_fix_frontmatter ---
      {
        name: 'dendron_fix_frontmatter',
        description: 'Ensure a note has all required frontmatter fields (id, title, created, updated).',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension'),
        }),
        async execute({ filename }) {
          const notePath = notePathFromFilename(filename);
          if (!fs.existsSync(notePath)) {
            return { ok: false, error: `Note not found: ${filename}` };
          }
          const raw = readNoteRaw(notePath);
          const parsed = parseFrontmatter(raw);
          const id = canonicalIdFromFilename(filename);
          const next = { ...frontmatterDefaults({ id }), ...(parsed.data || {}), id, updated: Date.now() };
          writeNoteRaw(notePath, formatWithFrontmatter(next, parsed.content || ''));
          const result = { ok: true, path: `${filename}.md`, id };
          try {
            const embedResult = await runRagEmbed(projectRoot, { files: [path.relative(projectRoot, notePath)] });
            if (embedResult && embedResult.ok === false) {
              result.ragEmbedWarning = embedResult.error ?? 'runRagEmbed returned ok: false';
            }
          } catch (err) {
            result.ragEmbedWarning = err?.message ?? String(err);
          }
          return result;
        },
      },
      // --- dendron_validate ---
      {
        name: 'dendron_validate',
        description: 'Validate frontmatter for notes matching a glob pattern. Returns pass/fail per note.',
        inputSchema: z.object({
          pattern: z.string().optional().describe('Glob pattern (default: **/*.md)'),
        }),
        async execute({ pattern }) {
          const glob = pattern || '**/*.md';
          const { globSync } = await import('glob');
          const matches = globSync(glob, { cwd: notesDir, nodir: true }).sort();
          const results = matches.map(rel => {
            const raw = readNoteRaw(path.join(notesDir, rel));
            return { path: rel, ...validateNoteFrontmatter(raw) };
          });
          const passCount = results.filter(r => r.ok).length;
          const failCount = results.filter(r => !r.ok).length;
          return {
            ok: failCount === 0,
            total: results.length,
            passed: passCount,
            failed: failCount,
            failures: results.filter(r => !r.ok).map(r => ({ path: r.path, issues: r.issues })),
          };
        },
      },
      // --- dendron_mark_implemented ---
      {
        name: 'dendron_mark_implemented',
        description: 'Mark a backlog story as implemented and move to z_implemented namespace.',
        inputSchema: z.object({
          filename: z.string().describe('Backlog note filename (must start with backlog.)'),
          commitId: z.string().optional().describe('Commit SHA that implements this story'),
        }),
        async execute({ filename, commitId }) {
          let result;
          try {
            result = markImplemented(notesDir, filename, commitId);
          } catch (err) {
            return { ok: false, error: err.message };
          }
          const newAbsPath = path.join(notesDir, result.path);
          try {
            const embedResult = await runRagEmbed(projectRoot, { files: [path.relative(projectRoot, newAbsPath)] });
            if (embedResult && embedResult.ok === false) {
              result.ragEmbedWarning = embedResult.error ?? 'runRagEmbed returned ok: false';
            }
          } catch (err) {
            result.ragEmbedWarning = err?.message ?? String(err);
          }
          return result;
        },
      },
    ],
  };
}
