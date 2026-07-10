/**
 * Research Agent
 *
 * Handles all discovery: RAG queries, file reading, architecture questions.
 * Read-only. Returns answers with sources. Replaces raw file reads and
 * grep/find operations that would otherwise fill the coordinator's context.
 *
 * Tools (server-side, no hooks):
 * - rag_query: queries RAG index for code, docs, or notes
 * - read_file: reads a specific file (after RAG identifies it)
 * - read_git: delegates read-only git operations to the git agent (allowlisted)
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import { runRagQuery } from '../rag/tools.mjs';
import { inferQueryIntent } from '../rag/query-intent.mjs';
import { loadAgentConfig } from './config.mjs';
import { resolveNotesDir, writeNoteRaw, frontmatterDefaults, editNote, updateField } from '../dendron.mjs';
import { createCrossDelegationTool } from './cross-delegate.mjs';
import { runGitShow, runGitBlame, runGitDescribe, runGitBranchList, runGitRemoteList } from '../server/git-tools.mjs';
import { runGit } from '../utils/git.mjs';
import { ensureTelemetryStorage } from '../server/telemetry/index.mjs';

const DENIED_NAMESPACES = ['backlog.', 'z_archive.'];
const DENIED_GUARD_MSG = 'Research agent cannot write to backlog.* or z_archive.* namespaces. backlog.* is PO-owned; z_archive.* is archived. All other namespaces in notes/ are allowed.';

// Read-only git tool allowlist — write operations are never reachable through read_git.
const READ_GIT_ALLOWLIST = ['git_log', 'git_diff', 'git_show', 'git_blame', 'git_describe', 'git_state', 'git_branch', 'git_remote'];

function _executeGitRead(projectRoot, { tool, args = {} }) {
  switch (tool) {
    case 'git_show': return runGitShow(projectRoot, args);
    case 'git_blame': return runGitBlame(projectRoot, args);
    case 'git_describe': return runGitDescribe(projectRoot, args);
    case 'git_branch': return runGitBranchList(projectRoot);
    case 'git_remote': return runGitRemoteList(projectRoot, args);
    case 'git_log': {
      try {
        const count = Math.min(args.count || 10, 50);
        const logArgs = ['log', `-${count}`, '--oneline'];
        if (args.ref) logArgs.push(args.ref);
        const output = runGit(projectRoot, logArgs);
        return { commits: output.split('\n').filter(Boolean) };
      } catch (err) { return { error: err.message }; }
    }
    case 'git_diff': {
      const diffArgs = ['diff', '--no-color'];
      if (args.staged) diffArgs.push('--cached');
      if (args.ref1) diffArgs.push(args.ref1);
      if (args.ref2) diffArgs.push(args.ref2);
      if (args.file) { diffArgs.push('--'); diffArgs.push(args.file); }
      const out = spawnSync('git', diffArgs, { cwd: projectRoot, encoding: 'utf8' });
      const diff = (out.stdout || '').trim();
      const lines = diff.split('\n');
      return { diff: lines.length > 200 ? lines.slice(0, 200).join('\n') + '\n...(truncated)' : diff };
    }
    case 'git_state': {
      try {
        const branch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const out = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' });
        const files = (out.stdout || '').split('\n').filter(Boolean);
        return { branch, dirty: files.length > 0, filesChanged: files.length };
      } catch (err) { return { error: err.message }; }
    }
    default: return { error: `Unknown tool: ${tool}` };
  }
}

// --- Input Contract ---
export const ResearchInputSchema = z.object({
  projectId: z.string(),
  query: z.string().describe('The research question or discovery query'),
  scope: z.enum(['code', 'notes', 'all']).optional().describe('Scope to search within (default: all)'),
});

// --- Output Contract ---
// Coerce a bare-array LLM response into the expected object shape BEFORE schema validation.
// The research agent occasionally returns a top-level JSON array — either the whole result
// wrapped in a 1-element array, or just the sources list — instead of the object. Without this,
// z.object rejects it ("Expected object, received array") and the runner wastefully escalates
// haiku→sonnet. The coercion is NARROW: only arrays are touched, and a wrong-shape array still
// fails downstream (sources must be {file,...} objects), so genuinely-invalid output still errors.
function coerceBareArrayOutput(v) {
  if (!Array.isArray(v)) return v;
  // The model wrapped the full result object in a 1-element array — unwrap it.
  if (v.length === 1 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])
      && ('answer' in v[0] || 'ok' in v[0])) {
    return v[0];
  }
  // Otherwise treat the bare array as the sources list. Missing answer/confidence get
  // conservative defaults; an empty array flows through the transform to advisory: true.
  return { ok: true, answer: '', sources: v, confidence: 0.3 };
}

// A well-formed source is a plain object (the schema then validates {file, snippet?}).
// Bare primitives (number/string/null) and arrays are NOT sources — the "line numbers"
// phrasing in a query occasionally nudges the model to drop a standalone line NUMBER into
// sources[], which failed the whole run on `sources[0] expected object received number`.
function _isSourceObject(el) {
  return el !== null && typeof el === 'object' && !Array.isArray(el);
}

// Preprocess for the research output. Composes two NARROW coercions:
//  1. Object-with-answer branch (this fix, backlog.fix.research-agent-sources-primitive-sanitization):
//     when the input is an OBJECT that carries an `answer` and a `sources` array, DROP bare
//     non-object primitive elements from sources[] while PRESERVING well-formed source objects
//     and their order. All-primitive sources normalize to [] (→ advisory:true via the transform).
//     A missing `answer` / other schema violation still fails — we narrow to sources[] shape only.
//  2. Otherwise defer to coerceBareArrayOutput (the sibling bare-array path, unchanged) — a bare
//     TOP-LEVEL primitive array ([1,2,3] / ['just','strings']) is NOT rescued here and still throws.
// Same-frame, consume-once bridge for sources[] sanitization observability
// (backlog.fix.research-agent-sources-sanitized-emit). preprocessResearchOutput is a PURE
// z.preprocess input with no collector / telemetryId in scope, and z.preprocess may run it more
// than once per .parse(). So we record the drop count to a module-level slot here and emit
// exactly once at the finalizeResult call site (runner.mjs), which runs once per run and owns
// emitTelemetry. Reset at the top of every invocation so a bare-array branch or a prior thrown
// parse can never leak a stale record; the finalize call consumes-once (clears on read).
let _lastSanitization = null;

function preprocessResearchOutput(v) {
  _lastSanitization = null;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)
      && 'answer' in v && Array.isArray(v.sources)) {
    const filtered = v.sources.filter(_isSourceObject);
    _lastSanitization = { dropped: v.sources.length - filtered.length, kept: filtered.length };
    return { ...v, sources: filtered };
  }
  return coerceBareArrayOutput(v);
}

const ResearchOutputObject = z.object({
  ok: z.boolean(),
  answer: z.string().describe('Synthesized answer to the research question'),
  sources: z.array(z.object({
    file: z.string(),
    snippet: z.string().optional(),
  })).describe('Files referenced in the answer'),
  confidence: z.number().min(0).max(1).describe('Confidence in the answer'),
  failureCategory: z.enum(['no_results', 'timeout', 'escalated', 'partial_answer']).optional().describe('Failure category when answer is incomplete or partial'),
  // Finding 3 (notes/research.2026.06.28.uat-findings.md): a factual answer must
  // carry non-empty `sources` OR be explicitly flagged advisory. Additive optional
  // field — sourceless content is never presented as authoritative cited fact.
  advisory: z.boolean().optional().describe('True when the answer is design/advisory opinion not backed by cited sources. Any output with empty sources is normalized to advisory: true.'),
  // Graceful degradation (backlog.feat.agent-turn-ceiling-graceful-degradation): the runner stamps
  // truncated:true on a best-effort partial returned at the turn ceiling. Declared here (optional) so
  // the strict z.object does not strip the flag when the result is re-validated downstream.
  truncated: z.boolean().optional().describe('True when this is a best-effort partial returned at the agent turn ceiling.'),
}).transform((o) =>
  // Enforce the core invariant on the OUTPUT: a parsed answer with empty sources
  // always carries advisory: true. We COERCE rather than reject so a legitimately
  // sourceless answer (a design/advisory question) is flagged, not failed — the
  // agent keeps working while the contract holds on every output.
  o.sources.length === 0 && o.advisory === undefined ? { ...o, advisory: true } : o,
);

// Public schema is bare-array-tolerant: coerce array → object shape, then validate + transform.
// Object inputs pass through coerceBareArrayOutput unchanged, so existing behavior is preserved.
export const ResearchOutputSchema = z.preprocess(preprocessResearchOutput, ResearchOutputObject);

// Consume-once hook read by the generic runner's finalizeResult immediately after a successful
// outputSchema.parse (synchronously, no await between the parse and the consume). Returns the
// last sanitization record { dropped, kept } then clears it, so a sources[] drop surfaces as
// exactly one agent.research.sources_sanitized event per run. Duck-typed on the schema object so
// runner.mjs stays generic and does NOT import research.mjs.
ResearchOutputSchema._consumeSanitizationMeta = () => {
  const r = _lastSanitization;
  _lastSanitization = null;
  return r;
};

// --- System Prompt (fallback only — canonical prompt lives in .rks/prompts/agent-research.md) ---
const RESEARCH_SYSTEM_PROMPT = `You are a Research Agent. Answer questions about the codebase by querying the knowledge base and reading relevant files. Use rag_query first, then read_file, read_git, or dendron tools as needed. Return a JSON object: { "ok": true, "answer": "...", "sources": [{ "file": "...", "snippet": "..." }], "confidence": 0.0-1.0, "failureCategory": "no_results|timeout|escalated|partial_answer" (optional — include when answer is incomplete or partial) }.

SOURCES SHAPE: every element of "sources" MUST be an object of the form { "file": "path/to/file.mjs", "snippet": "..." }. NEVER put a bare line number or any standalone string/number as a sources[] element. Line and location info belongs INSIDE the object — as "file": "path/to/file.mjs:187" or inside "snippet" — never as its own array element. The inline [filename:lineNumber] citation form is only for the prose "answer" text, not for the structured sources list.

WHEN TO USE read_git: Use read_git when the question is about git history, recent commits, branch state, file blame, or changes between refs. Prefer read_git over read_file for questions about what changed, when, or by whom.

WHEN NOT TO USE read_git: Do not use read_git for questions about file content, architecture, or code structure — use rag_query and read_file for those. Do not use read_git for write operations (commit, push, merge, reset) — those are not available.

ON read_git FAILURE: If read_git returns an error or the budget is exhausted, fall back to rag_query or read_file to answer the question from static content. Budget exhaustion means no further git read calls are available in this session.`;

/**
 * Create the Research agent configuration.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.query
 * @param {string} [params.scope]
 * @param {string} params.projectRoot
 */
export function createResearchAgent({ projectId, query, scope, projectRoot }) {
  const scopeHint = scope && scope !== 'all' ? ` Focus on ${scope} files.` : '';
  const cfg = loadAgentConfig('research', projectRoot);

  // Telemetry collector — best-effort, never throws
  let _collector;
  function getCollector() {
    if (!_collector) {
      try { _collector = projectRoot ? ensureTelemetryStorage(projectRoot) : { emit: () => {} }; }
      catch { _collector = { emit: () => {} }; }
    }
    return _collector;
  }
  function emitGitTelemetry(event, data) {
    try { getCollector().emit(`agent.research.read_git.${event}`, projectId, data); } catch {}
  }

  // read_git cross-delegation — separate budget from RAG/file-read counters
  const gitCounter = { count: 0, max: 3 };
  const { tool: _readGitBase } = createCrossDelegationTool({
    sourceAgent: 'research',
    targetAgent: 'git',
    toolName: 'read_git',
    description: `Delegate a read-only git operation to the git agent. Allowed tools: ${READ_GIT_ALLOWLIST.join(', ')}. Write operations (commit, push, merge, reset, etc.) are not available.`,
    inputSchema: z.object({
      tool: z.string().describe('Git read tool name from READ_GIT_ALLOWLIST'),
      args: z.record(z.unknown()).optional().describe('Arguments for the tool'),
    }),
    createTarget: (input) => ({
      name: 'git-reader',
      prompt: 'Git read-only dispatcher.',
      userMessage: `Execute: ${input.tool}`,
      inputSchema: z.object({}),
      outputSchema: z.object({}).passthrough(),
      rawInput: {},
      projectId,
      projectRoot,
      // Allowlist is enforced in the wrapper BEFORE this shortCircuit runs.
      shortCircuit: async () => _executeGitRead(projectRoot, { tool: input.tool, args: input.args || {} }),
    }),
    projectId,
    projectRoot,
    counter: gitCounter,
    maxCalls: 3,
  });

  // Wrapper: allowlist and budget checks happen here, before the cross-delegation
  // counter is incremented. Rejected calls do NOT consume the git read budget.
  const readGitTool = {
    name: _readGitBase.name,
    description: _readGitBase.description,
    inputSchema: _readGitBase.inputSchema,
    execute: async (input) => {
      // 1. Allowlist — blocked tools never consume budget
      if (!READ_GIT_ALLOWLIST.includes(input.tool)) {
        emitGitTelemetry('allowlist_rejection', { rejectedTool: input.tool, allowed: READ_GIT_ALLOWLIST });
        return {
          ok: false,
          error: `Tool '${input.tool}' is not in READ_GIT_ALLOWLIST. Allowed: ${READ_GIT_ALLOWLIST.join(', ')}`,
        };
      }
      // 2. Budget — emit specific telemetry before returning the error
      if (gitCounter.count >= gitCounter.max) {
        emitGitTelemetry('budget_exhausted', { tool: input.tool, calls: gitCounter.count, max: gitCounter.max });
        return {
          ok: false,
          error: `git read budget exhausted (${gitCounter.count}/${gitCounter.max}). No further git read calls are available.`,
        };
      }
      // 3. Delegate — counter increments inside _readGitBase.execute
      emitGitTelemetry('attempt', { tool: input.tool });
      return _readGitBase.execute(input);
    },
  };

  // Verbatim mode: "read <path> verbatim" bypasses LLM entirely.
  // Returns raw file content as the answer -- no synthesis, no summarization.
  // Used by Governor bootstrap to read its own prompt without lossy compression.
  const verbatimMatch = query.match(/^read\\s+(.+?)\\s+verbatim$/i);
  const verbatimShortCircuit = verbatimMatch ? () => {
    const relPath = verbatimMatch[1].trim();
    const filePath = path.resolve(projectRoot, relPath);
    if (!filePath.startsWith(projectRoot)) return null;
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      ok: true,
      answer: content,
      sources: [{ file: relPath }],
      confidence: 1.0,
      advisory: false, // cited path — the verbatim file read IS the source (Finding 3)
    };
  } : undefined;

  return {
    name: 'research',
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    prompt: cfg.prompt || RESEARCH_SYSTEM_PROMPT,
    userMessage: `Research question: "${query}"${scopeHint}\n\nProject: ${projectId}. Use rag_query to find relevant files, then read_file if you need exact content. Return a structured answer.`,
    inputSchema: ResearchInputSchema,
    outputSchema: ResearchOutputSchema,
    rawInput: { projectId, query, scope },
    maxTurns: cfg.maxTurns,
    timeoutMs: cfg.timeoutMs,
    projectId,
    projectRoot,
    shortCircuit: verbatimShortCircuit,
    tools: [
      {
        name: 'rag_query',
        description: 'Search the RAG index for code, documentation, or notes matching a query. Returns ranked results with file paths and snippets.',
        inputSchema: z.object({
          q: z.string().describe('Search query'),
          k: z.number().optional().describe('Number of results (default 5)'),
        }),
        execute: async (input) => {
          const intent = inferQueryIntent(input.q);
          const result = await runRagQuery(projectRoot, { q: input.q, k: input.k || 5, intent });
          const matches = result?.matches || [];

          // Fallback cascade: thin results → broaden query → return best
          if (matches.length < 2) {
            const broadWords = input.q.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(' ');
            if (broadWords && broadWords !== input.q) {
              try {
                const broadResult = await runRagQuery(projectRoot, { q: broadWords, k: input.k || 5, intent });
                const broadMatches = broadResult?.matches || [];
                if (broadMatches.length > matches.length) {
                  return { ...broadResult, _cascade: 'broadened' };
                }
              } catch { /* best-effort — return original result below */ }
            }
            return { ...result, _cascade: matches.length === 0 ? 'no_results' : 'thin_results' };
          }
          return result;
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a specific file. Use after rag_query identifies relevant files. Returns file content as text.',
        inputSchema: z.object({
          path: z.string().describe('Relative file path from project root'),
          offset: z.number().optional().describe('Start line (0-indexed, default 0)'),
          limit: z.number().optional().describe('Max lines to read (default 200)'),
        }),
        execute: async (input) => {
          const filePath = path.resolve(projectRoot, input.path);
          // Safety: ensure path is within project root
          if (!filePath.startsWith(projectRoot)) {
            return { error: 'Path traversal blocked — must be within project root' };
          }
          if (!fs.existsSync(filePath)) {
            return { error: `File not found: ${input.path}` };
          }
          // SECURITY: never return secret VALUES from dotenv files. This agent's read_file
          // runs in-process inside the MCP server, where the built-in Read deny (.claude/
          // settings.json) and the read hooks do NOT apply — so enforce it here. .env / .env.*
          // carry live credentials; return variable NAMES only. (.env.example/.sample/.template
          // are committed, non-secret, and read normally.) A "redact values" instruction in the
          // query is not a control. See backlog.security.agent-env-secret-leak-redaction.
          const base = path.basename(filePath);
          if (/^\.env(\.|$)/.test(base) && !/^\.env\.(example|sample|template)$/.test(base)) {
            let variableNames = [];
            try {
              variableNames = fs.readFileSync(filePath, 'utf8')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith('#'))
                .map((l) => (l.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1])
                .filter(Boolean);
            } catch { /* fall through to the stub with empty names */ }
            return {
              path: input.path,
              redacted: true,
              reason: 'dotenv secret file — values are never returned',
              variableNames,
              content: `[REDACTED dotenv file: ${input.path}] Secret values are withheld. Variable names only: ${variableNames.join(', ')}. To document names/format, read .env.example instead.`,
            };
          }
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split('\n');
          const offset = input.offset || 0;
          const limit = input.limit || 200;
          const slice = lines.slice(offset, offset + limit);
          return {
            path: input.path,
            totalLines: lines.length,
            offset,
            limit,
            content: slice.join('\n'),
          };
        },
      },
      {
        name: 'dendron_create_note',
        description: 'Create a new Dendron note in the project notes directory. All namespaces allowed except backlog.* (PO-owned) and z_archive.* (archived).',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension (e.g. notes.my-topic, design.arch.overview)'),
          title: z.string().optional().describe('Note title'),
          desc: z.string().optional().describe('Short description'),
          body: z.string().optional().describe('Note body markdown content'),
        }),
        execute: async (input) => {
          if (DENIED_NAMESPACES.some(p => input.filename.startsWith(p))) {
            return { error: DENIED_GUARD_MSG };
          }
          const notesDir = resolveNotesDir(projectRoot);
          const notePath = path.join(notesDir, `${input.filename}.md`);
          if (fs.existsSync(notePath)) {
            return { error: `Note already exists: ${input.filename}.md` };
          }
          const defaults = frontmatterDefaults({ id: input.filename, title: input.title, desc: input.desc });
          const fm = Object.entries(defaults).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
          const content = `---\n${fm}\n---\n\n${input.body || ''}`;
          writeNoteRaw(notePath, content);
          return { ok: true, filename: input.filename, path: notePath };
        },
      },
      {
        name: 'dendron_edit_note',
        description: 'Edit the body of an existing Dendron note. All namespaces allowed except backlog.* (PO-owned) and z_archive.* (archived).',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension'),
          body: z.string().describe('New body content (replaces existing body)'),
        }),
        execute: async (input) => {
          if (DENIED_NAMESPACES.some(p => input.filename.startsWith(p))) {
            return { error: DENIED_GUARD_MSG };
          }
          const notesDir = resolveNotesDir(projectRoot);
          const notePath = path.join(notesDir, `${input.filename}.md`);
          if (!fs.existsSync(notePath)) {
            return { error: `Note not found: ${input.filename}.md` };
          }
          editNote(notesDir, input.filename, input.body);
          return { ok: true, filename: input.filename };
        },
      },
      {
        name: 'dendron_update_field',
        description: 'Update a specific frontmatter field on an existing Dendron note. All namespaces allowed except backlog.* (PO-owned) and z_archive.* (archived). Value is not logged in telemetry.',
        inputSchema: z.object({
          filename: z.string().describe('Note filename without .md extension'),
          field: z.string().describe('Frontmatter field name to update'),
          value: z.unknown().describe('New value for the field'),
        }),
        execute: async (input) => {
          // Namespace guard — must be the first check
          if (DENIED_NAMESPACES.some(p => input.filename.startsWith(p))) {
            try { getCollector().emit('agent.research.dendron_update_field.namespace_violation', projectId, { prefix: DENIED_NAMESPACES.find(p => input.filename.startsWith(p)), field: input.field }); } catch {}
            return { error: DENIED_GUARD_MSG };
          }
          try { getCollector().emit('agent.research.dendron_update_field.attempt', projectId, { field: input.field }); } catch {}
          try {
            const notesDir = resolveNotesDir(projectRoot);
            updateField(notesDir, input.filename, input.field, input.value);
            return { ok: true, filename: input.filename, field: input.field };
          } catch (err) {
            return { error: err?.message ?? String(err) };
          }
        },
      },
      readGitTool,
    ],
  };
}
