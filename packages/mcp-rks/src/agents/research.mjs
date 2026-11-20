/**
 * Research Agent
 *
 * Handles all discovery: RAG queries, file reading, architecture questions.
 * Read-only. Returns answers with sources. Replaces raw file reads and
 * grep/find operations that would otherwise fill the coordinator's context.
 *
 * Tools (server-side, no hooks):
 * - rag_query: queries RAG index for code, docs, or notes
 * - read_file: reads a specific file (a path named in the question, or one RAG identifies)
 * - read_git: delegates read-only git operations to the git agent (allowlisted)
 * - exhaustive_search: deterministic, bounded literal search (runExhaustiveSearch, in-process)
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { z } from 'zod';
import { runRagQuery } from '@routekit/rag';
import { runExhaustiveSearch } from '@routekit/rag';
import { inferQueryIntent } from '@routekit/rag';
import { loadAgentConfig } from './config.mjs';
import { resolveNotesDir, writeNoteRaw, frontmatterDefaults, editNote, updateField } from '../dendron.mjs';
import { createCrossDelegationTool } from './cross-delegate.mjs';
import { createAttemptState } from './attempt-state.mjs';
import { runGitShow, runGitBlame, runGitDescribe, runGitBranchList, runGitRemoteList } from '../server/git-tools.mjs';
import { runGit } from '../utils/git.mjs';
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { commitAndEmbedNote } from '../shared/commit-and-embed-note.mjs';
import { buildDendronCommitMessage } from '../shared/dendron-commit-message.mjs';

const DENIED_NAMESPACES = ['backlog.', 'z_archive.'];
const DENIED_GUARD_MSG = 'Research agent cannot write to backlog.* or z_archive.* namespaces. backlog.* is PO-owned; z_archive.* is archived. All other namespaces in notes/ are allowed.';

// Read-only residue check after a commit that reported neither success nor a reason.
const NOTE_STATUS_TIMEOUT_MS = 10_000;

/**
 * Returns a non-empty reason when `relPath` is still uncommitted (or git could not
 * tell), else null. Read-only: `--no-optional-locks` keeps git status from taking
 * .git/index.lock, so another writer's lock is never touched.
 */
function uncommittedNoteReason(projectRoot, relPath) {
  const r = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain', '--', relPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: NOTE_STATUS_TIMEOUT_MS,
  });
  const stderr = String(r.stderr || '').trim();
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error.message || String(r.error)) : `git status exited ${r.status}`;
    return `note ${relPath} is still uncommitted: ${why}${stderr ? ` — ${stderr}` : ''}`;
  }
  const out = String(r.stdout || '').trim();
  if (out) {
    return `note ${relPath} is still uncommitted (git status: ${out})${stderr ? ` — ${stderr}` : ''}`;
  }
  return null;
}

/**
 * Commit exactly the note an in-agent tool just wrote, using the same path and
 * commit subject as the MCP-level dendron tools (server.mjs commitDendronWriteResult).
 * `ok` stays with the caller (it describes the write); this returns only the commit
 * fields. commitResult.ok is never spread — on a protected branch it is false.
 * backlog.fix.research-agent-note-writes-uncommitted
 */
async function commitInAgentNoteWrite({ projectRoot, tool, noteId, notePath }) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    return { writeOk: true, commitOk: false, commitError: 'projectRoot is required to commit the note' };
  }
  const relPath = path.isAbsolute(notePath) ? path.relative(projectRoot, notePath) : notePath;
  let commitResult;
  try {
    commitResult = await commitAndEmbedNote({
      projectRoot,
      notePath: relPath,
      commitMessage: buildDendronCommitMessage(tool, noteId),
    });
  } catch (err) {
    return { writeOk: true, commitOk: false, commitError: err?.message || String(err) };
  }
  const out = { writeOk: true, commitOk: commitResult?.commitOk === true };
  if (commitResult?.commitId) out.commitId = commitResult.commitId;
  if (commitResult?.commitError) out.commitError = commitResult.commitError;
  if (commitResult?.idempotent) out.idempotent = true;
  if (commitResult?.committedPaths) out.committedPaths = commitResult.committedPaths;
  if (commitResult?.ragEmbedWarning) out.ragEmbedWarning = commitResult.ragEmbedWarning;
  // commit-and-embed-note.mjs reports a failed `git add` (e.g. a held index.lock, or
  // no repo) as idempotent with no reason. Only an empty status is truly idempotent.
  if (out.commitOk !== true && !out.commitError) {
    const reason = uncommittedNoteReason(projectRoot, relPath);
    if (reason) {
      out.commitError = reason;
      delete out.idempotent;
    }
  }
  return out;
}

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
  //
  // backlog.fix.research-agent-output-contract (D7): a bare array is MALFORMED model output,
  // not a low-confidence answer. `ok` stays true — the coercion exists to avoid a haiku→sonnet
  // escalation, and failureCategory is deliberately not a rollback trigger (server.mjs) — but
  // the failure is now legible to the caller instead of laundered into an empty success.
  return { ok: true, answer: '', sources: v, confidence: 0.3, failureCategory: 'malformed_output' };
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
  // thin_results / retrieval_failed / malformed_output are CODE-SET (never requested of the model):
  // see buildResearchOutputSchema and coerceBareArrayOutput. backlog.fix.research-agent-output-contract.
  failureCategory: z.enum(['no_results', 'thin_results', 'retrieval_failed', 'malformed_output', 'timeout', 'escalated', 'partial_answer']).optional().describe('Failure category when answer is incomplete or partial'),
  // Finding 3 (notes/research.2026.06.28.uat-findings.md): a factual answer must
  // carry non-empty `sources` OR be explicitly flagged advisory. Additive optional
  // field — sourceless content is never presented as authoritative cited fact.
  advisory: z.boolean().optional().describe('True when the answer is design/advisory opinion not backed by cited sources. Any output with empty sources is normalized to advisory: true.'),
  // Graceful degradation (backlog.feat.agent-turn-ceiling-graceful-degradation): the runner stamps
  // truncated:true on a best-effort partial returned at the turn ceiling. Declared here (optional) so
  // the strict z.object does not strip the flag when the result is re-validated downstream.
  truncated: z.boolean().optional().describe('True when this is a best-effort partial returned at the agent turn ceiling.'),
  // backlog.feat.research-agent-exhaustive-search-tool: PROGRAM-STAMPED by buildResearchOutputSchema from
  // this agent instance's exhaustive_search call ledger; a model-supplied value is discarded. It records
  // an observation of the agent's own searches, never that a sentence in the answer was checked.
  deterministicNegativeObserved: z.boolean().optional().describe('True when a deterministic negative was obtained: on one path, an exhaustive_search returned matchCount 0 at exhaustive true and a different-pattern search returned a hit. Set by the program, not the model; it does not bind any particular claim in the answer.'),
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

// --- Code-set failure categories (backlog.fix.research-agent-output-contract, D7) ---
//
// The rag_query tool computes whether retrieval found evidence (_cascade) and the runner used
// to discard it at the tool boundary, so retrieval failure, no results, thin results and a
// genuine low-confidence answer were indistinguishable to the caller. Each research agent
// instance now keeps a private retrieval record and a per-agent output schema applies it.

// Best-first ranking of retrieval outcomes across one run's rag_query calls: one grounded
// retrieval means the answer had evidence available.
const RETRIEVAL_RANK = { healthy: 0, thin_results: 1, no_results: 2, retrieval_failed: 3 };

// Precedence when more than one category applies. A code-set category always overrides a
// model-volunteered one; when code sets none, a volunteered enum value passes through.
const CODE_SET_PRECEDENCE = ['retrieval_failed', 'malformed_output', 'no_results', 'thin_results'];

/** Classify one rag_query tool return value. */
export function classifyRetrieval(returned) {
  if (returned && returned.ok === false) return 'retrieval_failed';
  if (returned?._cascade === 'no_results') return 'no_results';
  if (returned?._cascade === 'thin_results') return 'thin_results';
  return 'healthy';
}

/** A per-instance retrieval record — closure state, never module-level, so nothing leaks. */
export function createRetrievalRecord() {
  let best = null;
  return {
    record(outcome) {
      if (best === null || RETRIEVAL_RANK[outcome] < RETRIEVAL_RANK[best]) best = outcome;
    },
    // Read-and-clear: a second finalize on the same schema starts clean.
    consume() {
      const r = best;
      best = null;
      return r;
    },
    // In-place reset for the attempt lifecycle: keeps the record's identity (config._retrieval).
    reset() {
      best = null;
    },
  };
}

/**
 * Per-agent output schema: parse with the base schema, then consume the retrieval record and
 * apply the code-set failure category. MUST forward _consumeSanitizationMeta — runner.mjs reads
 * it duck-typed after every finalize parse, and dropping it silently stops
 * agent.research.sources_sanitized.
 */
export function buildResearchOutputSchema({ baseSchema = ResearchOutputSchema, retrieval, projectRoot, budget, namedPaths }) {
  return {
    parse(value) {
      const parsed = baseSchema.parse(value);
      // backlog.fix.research-agent-budget-observed-not-asserted: the budget is PROGRAM-STAMPED here,
      // after the base parse, from the code counters. A model-supplied `budget` is discarded, never
      // trusted. It is deliberately absent from ResearchOutputObject, so --json-schema never shows it.
      // backlog.fix.research-agent-named-path-read: `namedPaths` is stamped the same way, from the
      // detection and the observed read record; a model-supplied value is discarded.
      // backlog.feat.research-agent-exhaustive-search-tool: deterministicNegativeObserved is stamped
      // the same way, from the exhaustive_search call ledger (a pure read); a model value is discarded.
      const {
        budget: _modelBudget, namedPaths: _modelNamedPaths, deterministicNegativeObserved: _modelNegative, ...unstampedBase
      } = parsed;
      const unstamped = Array.isArray(namedPaths) && namedPaths.length > 0
        ? { ...unstampedBase, namedPaths: stampNamedPaths(namedPaths, budget) }
        : unstampedBase;
      const budgeted = budget ? { ...unstamped, budget: budget.report() } : unstamped;
      const stamped = budget?.deterministicNegativeObserved?.() === true
        ? { ...budgeted, deterministicNegativeObserved: true }
        : budgeted;
      // backlog.fix.research-agent-snippet-not-verbatim — composes onto the same seam.
      const out = projectRoot ? { ...stamped, sources: verifySnippets(stamped.sources, projectRoot) } : stamped;
      const retrievalOutcome = retrieval ? retrieval.consume() : null;
      const candidates = [];
      if (retrievalOutcome && retrievalOutcome !== 'healthy') candidates.push(retrievalOutcome);
      if (out.failureCategory && CODE_SET_PRECEDENCE.includes(out.failureCategory)) {
        candidates.push(out.failureCategory);
      }
      if (candidates.length === 0) return out;
      const winner = CODE_SET_PRECEDENCE.find((c) => candidates.includes(c));
      return { ...out, failureCategory: winner };
    },
    _consumeSanitizationMeta: () => baseSchema._consumeSanitizationMeta?.() ?? null,
  };
}

// --- Code-counted tool budgets (backlog.fix.research-agent-budget-observed-not-asserted) ---
//
// The rag_query / read_file quotas used to exist only as prompt text, so "budget exhausted" in an
// answer was a model assertion. They are now counted in code. BUDGET_TOOLS fixes the key order of
// the stamped budget and of `exhausted`.
const BUDGET_TOOLS = ['rag_query', 'read_file', 'read_git', 'exhaustive_search'];
const UNOBSERVED_BUDGET = () => ({ observed: false, exhausted: [] });

const _isCount = (n) => Number.isInteger(n) && n >= 0;

// One exhaustive_search ledger entry: exactly { path, pattern, matchCount, exhaustive }.
const _isSearchCall = (c) => c !== null && typeof c === 'object'
  && typeof c.path === 'string' && typeof c.pattern === 'string'
  && _isCount(c.matchCount) && typeof c.exhaustive === 'boolean';
const _copySearchCall = (c) => ({ path: c.path, pattern: c.pattern, matchCount: c.matchCount, exhaustive: c.exhaustive });

/**
 * True when a ledger holds, for one and the same path, a matchCount 0 call at exhaustive true AND a
 * call with a different pattern on that path returning matchCount above 0 (the zero plus its positive
 * control). A pure read: the ledger is never mutated, so a repeated z.preprocess run answers the same.
 */
function ledgerHasDeterministicNegative(calls) {
  if (!Array.isArray(calls)) return false;
  return calls.some((zero) => _isSearchCall(zero) && zero.matchCount === 0 && zero.exhaustive === true
    && calls.some((control) => _isSearchCall(control) && control.path === zero.path
      && control.pattern !== zero.pattern && control.matchCount > 0));
}

/**
 * One view over a research agent's counters. snapshot() is the transportable counter state (the
 * claude-cli tools process writes it); report() is the stamped budget; replay() loads a snapshot
 * made in another process; markUnobserved() records that no snapshot could be read, so report()
 * says the budget was not observed instead of reporting zeros.
 *
 * Snapshot shape: { rag_query: { used, max, queries: string[] }, read_file: { used, max, paths: [] },
 * read_git: { used, max }, exhaustive_search: { used, max, calls: [] } }. Each exhaustive_search calls entry
 * is exactly { path, pattern, matchCount, exhaustive }, path repo-relative POSIX. Each read_file paths entry is { path, offset, limit } plus optional
 * flags: named: true marks a named path's reserved read (listed, not counted in read_file.used);
 * error: true marks a read that was listed and used its slot (consumed or reserved) but returned
 * no content (traversal blocked, not found, or the read threw). replay() accepts only a state whose
 * counts agree with its lists (rag_query.used === queries.length, read_file.used === the number of
 * paths entries without named: true, exhaustive_search.used === calls.length) and whose used counts do
 * not exceed this budget's max.
 */
function createToolBudget({ ragCounter, readCounter, gitCounter, exhaustiveCounter, observation }) {
  const snapshot = () => ({
    rag_query: { used: ragCounter.count, max: ragCounter.max, queries: [...ragCounter.queries] },
    read_file: { used: readCounter.count, max: readCounter.max, paths: readCounter.paths.map((p) => ({ ...p })) },
    read_git: { used: gitCounter.count, max: gitCounter.max },
    exhaustive_search: { used: exhaustiveCounter.count, max: exhaustiveCounter.max, calls: exhaustiveCounter.calls.map(_copySearchCall) },
  });
  return {
    snapshot,
    report() {
      if (!observation.observed) return UNOBSERVED_BUDGET();
      const s = snapshot();
      return { observed: true, ...s, exhausted: BUDGET_TOOLS.filter((t) => s[t].used >= s[t].max) };
    },
    /** Load a snapshot written by another process. Returns false (and loads nothing) when malformed. */
    replay(state) {
      const rag = state?.rag_query;
      const read = state?.read_file;
      const git = state?.read_git;
      // Required, never defaulted: parent and child run the same code, so a state lacking the key
      // was not produced by these tools, and a defaulted zero would be unobserved reported as observed.
      const search = state?.exhaustive_search;
      const valid = rag && read && git && search
        && _isCount(rag.used) && _isCount(read.used) && _isCount(git.used) && _isCount(search.used)
        && Array.isArray(rag.queries) && rag.queries.every((q) => typeof q === 'string')
        && Array.isArray(read.paths) && read.paths.every((p) => p && typeof p.path === 'string')
        && Array.isArray(search.calls) && search.calls.every(_isSearchCall);
      if (!valid) return false;
      // Consistency: the tools increment a counter and list its entry together, so a state whose
      // counts disagree with its lists, or exceed a refusal-guarded max, was not produced by them.
      const consistent = rag.used === rag.queries.length
        && read.used === read.paths.filter((p) => p.named !== true).length
        && search.used === search.calls.length
        && rag.used <= ragCounter.max && read.used <= readCounter.max && git.used <= gitCounter.max
        && search.used <= exhaustiveCounter.max;
      if (!consistent) return false;
      ragCounter.count = rag.used;
      ragCounter.queries = [...rag.queries];
      readCounter.count = read.used;
      readCounter.paths = read.paths.map((p) => ({ ...p }));
      gitCounter.count = git.used;
      exhaustiveCounter.count = search.used;
      exhaustiveCounter.calls = search.calls.map(_copySearchCall);
      observation.observed = true;
      return true;
    },
    markUnobserved() {
      observation.observed = false;
    },
    /** Pure read of the exhaustive_search ledger; never true while the ledger was not observed. */
    deterministicNegativeObserved() {
      if (!observation.observed) return false;
      return ledgerHasDeterministicNegative(exhaustiveCounter.calls);
    },
    /** The named read_file entries, or null when the read record was not observed. */
    namedReads() {
      if (!observation.observed) return null;
      return readCounter.paths.filter((p) => p && p.named === true).map((p) => ({ ...p }));
    },
  };
}

// --- Named paths (backlog.fix.research-agent-named-path-read) ---
//
// A path or note slug named in the question is read on a reserved slot, outside the discovery
// read_file budget. Containment is decided ONLY by isWithinProjectRoot (no check of its own here).
export const NAMED_PATH_CAP = 3;
const TOKEN_EDGE_LEAD = /^[`'"([{<]+/;
const TOKEN_EDGE_TRAIL = /[`'"\])}>,;:!?.]+$/;
const HAS_EXTENSION = /\.[A-Za-z0-9_-]+$/;
const SLUG_TOKEN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

const toPosix = (p) => p.split(path.sep).join('/');

function _isFile(abs) {
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

/**
 * True when a file path is a dotenv secret file: .env or .env.*, except the committed, non-secret
 * .env.example / .env.sample / .env.template. read_file returns variable NAMES only for these, and
 * the verbatim short-circuit refuses them (backlog.security.agent-env-secret-leak-redaction,
 * backlog.fix.research-agent-verbatim-regex-double-escape). The one shared rule for both callers.
 *
 * Names are compared case-insensitively (a case-insensitive filesystem opens .env for .ENV), and the
 * file counts as a secret when EITHER the typed basename or the basename of its realpath matches, so
 * an ordinary-named symlink to a .env file is caught (backlog.fix.research-agent-dotenv-rule-case-and-symlink).
 * realpath failure never throws: it falls back to the typed basename alone.
 */
function _isDotenvSecretPath(filePath) {
  const isSecretName = (base) =>
    /^\.env(\.|$)/i.test(base) && !/^\.env\.(example|sample|template)$/i.test(base);
  if (isSecretName(path.basename(filePath))) return true;
  let real = null;
  try { real = fs.realpathSync(filePath); } catch { real = null; }
  return real !== null && isSecretName(path.basename(real));
}

/**
 * Names-only redaction for a read_file of a dotenv secret file. Returns null when filePath is not a
 * dotenv secret file (the caller reads it normally); otherwise returns the redacted stub, listing the
 * variable NAMES only and never a value. displayPath is the path as the caller typed it. The one
 * redaction shared by every in-process read_file tool (research and planner), classified by
 * _isDotenvSecretPath (backlog.security.planner-read-file-dotenv-redaction).
 */
export function redactDotenvRead(filePath, displayPath) {
  if (!_isDotenvSecretPath(filePath)) return null;
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
    path: displayPath,
    redacted: true,
    reason: 'dotenv secret file — values are never returned',
    variableNames,
    content: `[REDACTED dotenv file: ${displayPath}] Secret values are withheld. Variable names only: ${variableNames.join(', ')}. To document names/format, read .env.example instead.`,
  };
}

/**
 * One exhaustive_search hit with dotenv secret values withheld. A hit whose file _isDotenvSecretPath
 * classifies as a dotenv secret keeps file and line, keeps the variable NAME of an assignment line,
 * withholds everything after the '=' (a non-assignment line is withheld whole) and carries
 * redacted: true. Any other hit (.env.example, .env.sample, .env.template included) is returned as is:
 * same object shape, no redacted key, text byte-identical.
 */
function _redactDotenvHit(projectRoot, hit) {
  if (!hit || typeof hit.file !== 'string') return hit;
  if (!_isDotenvSecretPath(path.resolve(projectRoot, hit.file))) return hit;
  const m = typeof hit.text === 'string' ? hit.text.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)/) : null;
  const text = m ? `${m[1]}[REDACTED — dotenv secret value withheld]` : '[REDACTED — dotenv secret line withheld]';
  return { file: hit.file, line: hit.line, text, redacted: true };
}

/** The exhaustive_search ledger path: the scoped path as a repo-relative POSIX path ('.' for the root). */
function _searchLedgerPath(projectRoot, p) {
  const root = path.resolve(projectRoot);
  return toPosix(path.relative(root, path.resolve(root, p))) || '.';
}

/** Repo-relative POSIX path for an in-root file path, or null when it is not inside projectRoot. */
function _namedRel(projectRoot, p) {
  if (typeof p !== 'string' || !p) return null;
  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, p);
  if (!isWithinProjectRoot(projectRoot, abs)) return null;
  return toPosix(path.relative(root, abs));
}

/**
 * Detect the paths and note slugs a query names. A token containing '/' whose basename has an
 * extension is a repo path candidate, reported whether or not it exists. A dotted token with no '/'
 * is a note slug, resolved to notes/<slug>.md (or notes/<token> when it already ends in .md); it
 * is a candidate only when that note exists, since a dotted word is not unambiguously a path.
 * Existing entries come first; the list is capped at NAMED_PATH_CAP.
 */
export function detectNamedPaths(query, projectRoot) {
  if (typeof query !== 'string' || !query || typeof projectRoot !== 'string' || !projectRoot) return [];
  const seen = new Set();
  const found = [];
  for (const raw of query.split(/\s+/)) {
    const token = raw.replace(TOKEN_EDGE_LEAD, '').replace(TOKEN_EDGE_TRAIL, '');
    if (!token || token.includes('://')) continue;
    let rel = null;
    let mustExist = false;
    if (token.includes('/')) {
      if (!HAS_EXTENSION.test(path.posix.basename(token))) continue;
      rel = _namedRel(projectRoot, token);
    } else if (SLUG_TOKEN.test(token)) {
      rel = _namedRel(projectRoot, path.join('notes', token.endsWith('.md') ? token : `${token}.md`));
      mustExist = true;
    }
    if (!rel || seen.has(rel)) continue;
    const exists = _isFile(path.resolve(projectRoot, rel));
    if (mustExist && !exists) continue;
    seen.add(rel);
    found.push({ path: rel, exists });
  }
  return [...found.filter((e) => e.exists), ...found.filter((e) => !e.exists)].slice(0, NAMED_PATH_CAP);
}

/** Keep only supplied named paths that are inside projectRoot and exist (the tools-process input). */
function _existingNamedPaths(paths, projectRoot) {
  if (!Array.isArray(paths) || typeof projectRoot !== 'string' || !projectRoot) return [];
  const out = [];
  for (const p of paths) {
    const rel = _namedRel(projectRoot, p);
    if (rel && !out.some((e) => e.path === rel) && _isFile(path.resolve(projectRoot, rel))) out.push({ path: rel, exists: true });
  }
  return out.slice(0, NAMED_PATH_CAP);
}

/**
 * namedPaths[] from the detection and the read record. read is true only when a read_file on that
 * path returned content, false when the record was observed and it did not (readError marks an
 * admitted read that returned an error), and null when the record was not observed.
 */
function stampNamedPaths(detected, budget) {
  const reads = budget && typeof budget.namedReads === 'function' ? budget.namedReads() : [];
  return detected.map(({ path: p, exists }) => {
    if (reads === null) return { path: p, exists, read: null };
    const hits = reads.filter((e) => e.path === p);
    const read = hits.some((e) => !e.error);
    return !read && hits.length > 0 ? { path: p, exists, read, readError: true } : { path: p, exists, read };
  });
}

// --- Snippet verification (backlog.fix.research-agent-snippet-not-verbatim) ---
//
// sources[].snippet is written by the model. On multi-part queries it was observed returning
// pipe-joined paraphrases that appear nowhere in the cited file, presented as excerpts that
// downstream agents quote as evidence. A snippet is now kept only when code has found it in the
// cited file's current content (whitespace-normalised). An unverified snippet is REMOVED — not
// merely flagged — so a later re-validation that strips unknown keys cannot resurrect it as
// though verified. The source entry and its `file` are always kept: provenance minting
// (track-agent-provenance.mjs) reads `file` only.
const MAX_VERIFY_BYTES = 2 * 1024 * 1024;
const normaliseWs = (t) => String(t).replace(/\s+/g, ' ').trim();

// Separator-aware root containment for agent read paths (backlog.fix.agent-read-file-root-
// containment-separator). A bare filePath.startsWith(projectRoot) admits a SIBLING directory that
// shares the root's basename prefix ('/a/proj-evil' starts with '/a/proj'). Comparing the path
// relative to the resolved root refuses it. '..' + path.sep (not a bare '..') keeps an in-root
// file whose name begins with two dots ('..notes.md') readable. The root itself (rel === '')
// and a cross-drive absolute rel are refused.
//
// Symlink containment (backlog.fix.agent-read-root-containment-symlink): the root and the target
// are canonicalized by ONE resolver, _canonicalContainmentPath, so an in-root link whose
// destination is outside the root is refused, and a root reached through a link (os.tmpdir() on
// macOS sits behind /var -> /private/var) still admits its own files.

// Canonical form of p for containment, or null when it cannot be shown. An existing path is its
// realpath. A missing path is the realpath of its deepest existing ancestor with the remaining
// segments re-appended. The upward walk uses lstatSync (existsSync follows links and would step
// past a dangling one): ENOENT means the level is missing and the walk goes up one level; a level
// that is present but whose realpath fails (a dangling link, file or mid-path directory) is
// refused; any other fs error is refused. Never throws.
function _canonicalContainmentPath(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      fs.lstatSync(cur);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') return null;
      const up = path.dirname(cur);
      if (up === cur) return null;
      tail.unshift(path.basename(cur));
      cur = up;
      continue;
    }
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      return null; // present but unresolvable: a dangling link — fail closed
    }
  }
}

export function isWithinProjectRoot(projectRoot, filePath) {
  try {
    const root = _canonicalContainmentPath(projectRoot);
    const target = _canonicalContainmentPath(path.resolve(path.resolve(projectRoot), filePath));
    if (root === null || target === null) return false;
    const rel = path.relative(root, target);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return false;
    return true;
  } catch {
    return false;
  }
}

function readCitedFile(projectRoot, file) {
  try {
    const abs = path.resolve(path.resolve(projectRoot), file);
    if (!isWithinProjectRoot(projectRoot, abs)) return null; // outside projectRoot
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_VERIFY_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null; // missing or unreadable — fail closed
  }
}

export function verifySnippets(sources, projectRoot) {
  if (!Array.isArray(sources)) return sources;
  const cache = new Map();
  return sources.map((src) => {
    const { verbatim: _modelClaim, ...rest } = src; // a model-supplied marker is never trusted
    if (typeof rest.snippet !== 'string') return rest;
    const needle = normaliseWs(rest.snippet);
    if (!cache.has(rest.file)) {
      const content = readCitedFile(projectRoot, rest.file);
      cache.set(rest.file, content === null ? null : normaliseWs(content));
    }
    const hay = cache.get(rest.file);
    if (needle && hay && hay.includes(needle)) return { ...rest, verbatim: true };
    const { snippet: _dropped, ...kept } = rest;
    return { ...kept, verbatim: false };
  });
}

/**
 * Telemetry rule (user decision: failures only). retrieval_failed and malformed_output are
 * emitted; no_results and thin_results are returned to the caller but not emitted, so routine
 * no-hit runs do not flood telemetry. timeout / escalated / partial_answer emit as before.
 */
const EMITTED_FAILURE_CATEGORIES = new Set([
  'retrieval_failed', 'malformed_output', 'timeout', 'escalated', 'partial_answer',
]);
export function shouldEmitResearchFailureEvent(category) {
  return EMITTED_FAILURE_CATEGORIES.has(category);
}

// --- System Prompt (fallback only — canonical prompt lives in .rks/prompts/agent-research.md) ---
const RESEARCH_SYSTEM_PROMPT = `You are a Research Agent. Answer questions about the codebase by querying the knowledge base and reading relevant files. Use rag_query first, then read_file, read_git, exhaustive_search, or dendron tools as needed. Return a JSON object: { "ok": true, "answer": "...", "sources": [{ "file": "...", "snippet": "..." }], "confidence": 0.0-1.0, "failureCategory": "no_results|timeout|escalated|partial_answer" (optional — include when answer is incomplete or partial) }.

SOURCES SHAPE: every element of "sources" MUST be an object of the form { "file": "path/to/file.mjs", "snippet": "..." }. NEVER put a bare line number or any standalone string/number as a sources[] element. Location info belongs INSIDE the object — in "file" (a path) — never as its own array element. "snippet" must be text copied exactly from that file, never a summary or a join of fragments: snippets are checked against the file and removed when they do not match. Do NOT cite line numbers anywhere: the retrieval index carries no line data, so any line number you write would be invented. Cite files by path; callers needing exact positions use rks_exhaustive_search.

WHEN TO USE read_git: Use read_git when the question is about git history, recent commits, branch state, file blame, or changes between refs. Prefer read_git over read_file for questions about what changed, when, or by whom.

WHEN NOT TO USE read_git: Do not use read_git for questions about file content, architecture, or code structure — use rag_query and read_file for those. Do not use read_git for write operations (commit, push, merge, reset) — those are not available.

ON read_git FAILURE: If read_git returns an error or the budget is exhausted, fall back to rag_query or read_file to answer the question from static content. Budget exhaustion means no further git read calls are available in this session.

WHEN TO USE exhaustive_search: Use the exhaustive_search tool (pattern and path required, at most 6 calls) for "list every X" or "does Y exist" questions: it is a deterministic literal search over a scoped path and returns every line containing the pattern. ABSENCE RULE: you may say something does not exist, or that a list is complete, ONLY when an exhaustive_search returned matchCount 0 with exhaustive true AND a positive control (a different pattern known to be present) on the same path returned a hit. Read both exhaustive and skipped before believing a zero; a zero at exhaustive false establishes nothing. matchCount counts lines containing the pattern, not lines equal to it. Any absence claim names the path and both patterns it rests on. Otherwise say only that you did not find it and that absence was not established.`;

/**
 * Create the Research agent configuration.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.query
 * @param {string} [params.scope]
 * @param {string} params.projectRoot
 * @param {Function} [params.writeGuard] - accepted so delegating factories forward one uniformly; NOT
 *   applied to this agent's note writes (exempt, backlog.feat.agent-code-path-note-writes-guarded;
 *   the reason is stated at each write site).
 * @param {string[]} [params.namedPaths] - the parent's existing named-path set, supplied only to the
 *   claude-cli tools process (whose query is empty); when absent the set is detected from the query.
 */
export function createResearchAgent({ projectId, query, scope, projectRoot, writeGuard, telemetryId, namedPaths }) {
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

  // read_git cross-delegation — its own budget, independent of the rag_query and read_file counters below.
  // Fresh per restart attempt, carried on max-turns resume (backlog.fix.cross-delegation-budget-per-attempt).
  // One attemptState per createResearchAgent call; S3 registers 'retrieval' on this same instance.
  const attemptState = createAttemptState();
  const gitCounter = attemptState.scoped('read_git', () => ({ count: 0, max: 3 }), { onResume: 'carry' });
  // rag_query / read_file budgets (backlog.fix.research-agent-budget-observed-not-asserted): same
  // attemptState, same semantics as gitCounter. An admitted call consumes its slot whatever its result;
  // only a quota refusal is excluded. queries / paths record exactly the admitted calls.
  const ragCounter = attemptState.scoped('rag_query', () => ({ count: 0, max: 2, queries: [] }), { onResume: 'carry' });
  const readCounter = attemptState.scoped('read_file', () => ({ count: 0, max: 3, paths: [] }), { onResume: 'carry' });
  // exhaustive_search (backlog.feat.research-agent-exhaustive-search-tool): ONE attempt-scoped object
  // holds its counter AND its call ledger, so both reset on a restart and carry on a resume together.
  // `calls` is the ledger deterministicNegativeObserved is derived from; it is never returned as tool output.
  const exhaustiveCounter = attemptState.scoped('exhaustive_search', () => ({ count: 0, max: 6, calls: [] }), { onResume: 'carry' });
  // false only when the claude-cli executor could not read the tools process's budget state.
  const budgetObservation = attemptState.scoped('budget_observation', () => ({ observed: true }), { onResume: 'carry' });
  const budget = createToolBudget({ ragCounter, readCounter, gitCounter, exhaustiveCounter, observation: budgetObservation });
  const budgetRefusal = (tool, counter) => ({
    ok: false,
    budgetExhausted: tool,
    error: `${tool} budget exhausted (${counter.count}/${counter.max}). No further ${tool} calls are available.`,
  });
  // Retrieval record (backlog.fix.agent-evidence-state-reset-on-retry): reset on a restart attempt so an
  // abandoned attempt's outcome cannot mask the retry's; carried on a max-turns resume (ARCH 2026-10-19).
  const retrieval = attemptState.scoped('retrieval', () => createRetrievalRecord(), { onResume: 'carry' });
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

  // exhaustive_search (backlog.feat.research-agent-exhaustive-search-tool): runExhaustiveSearch in-process,
  // its fields returned verbatim. Order: quota refusal (reuses budgetRefusal), then the search; a call
  // the primitive refuses (it throws for a missing pattern or path, a path outside the root and a
  // nonexistent scope) returns ok false WITHOUT consuming a slot or entering the ledger, like the
  // read_git allowlist rejection. The one rewrite: a hit in a dotenv secret file (_isDotenvSecretPath,
  // the rule read_file uses) has its value withheld and that results entry carries redacted: true.
  const exhaustiveSearchTool = {
    name: 'exhaustive_search',
    description: 'Deterministic, bounded literal search: every line under a scoped path that contains the pattern (case-sensitive substring). Returns anchor, exhaustive, fileCount, matchCount, truncated, skipped, warnings and results[] { file, line, text } (or files[] under countOnly). path is required; a search is never repo-wide. A zero is evidence of absence only when exhaustive is true and skipped is empty, and only with a positive control on the same path.',
    inputSchema: z.object({
      pattern: z.string().describe('Literal string to find (case-sensitive substring, matched per line)'),
      path: z.string().describe('Scoped path under the project root (file or directory). Required.'),
      countOnly: z.boolean().optional().describe('Return files[] with per-file counts instead of results[]'),
      maxResults: z.number().optional().describe('Cap on returned hits (default 1000); truncated reports a cut'),
    }),
    execute: async (input = {}) => {
      if (exhaustiveCounter.count >= exhaustiveCounter.max) return budgetRefusal('exhaustive_search', exhaustiveCounter);
      if (typeof input.pattern !== 'string' || input.pattern === '') {
        return { ok: false, error: 'exhaustive_search refused: pattern is required (a non-empty string)' };
      }
      if (typeof input.path !== 'string' || input.path.trim() === '') {
        return { ok: false, error: "exhaustive_search refused: a scoped 'path' is required — exhaustive search is bounded, never repo-wide" };
      }
      let res;
      try {
        res = runExhaustiveSearch(projectRoot, {
          pattern: input.pattern,
          path: input.path,
          ...(input.countOnly !== undefined ? { countOnly: input.countOnly } : {}),
          ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
        });
      } catch (err) {
        return { ok: false, error: `exhaustive_search refused: ${err?.message || String(err)}` };
      }
      exhaustiveCounter.count++;
      exhaustiveCounter.calls.push({
        path: _searchLedgerPath(projectRoot, input.path),
        pattern: input.pattern,
        matchCount: res.matchCount,
        exhaustive: res.exhaustive,
      });
      if (!Array.isArray(res.results)) return res;
      return { ...res, results: res.results.map((hit) => _redactDotenvHit(projectRoot, hit)) };
    },
  };

  // Verbatim mode: "read <path> verbatim" bypasses LLM entirely.
  // Returns raw file content as the answer -- no synthesis, no summarization.
  // Used by Governor bootstrap to read its own prompt without lossy compression.
  const verbatimMatch = query.match(/^read\s+(.+?)\s+verbatim$/i);
  const verbatimShortCircuit = verbatimMatch ? () => {
    const relPath = verbatimMatch[1].trim();
    const filePath = path.resolve(projectRoot, relPath);
    if (!isWithinProjectRoot(projectRoot, filePath)) return null;
    if (!fs.existsSync(filePath)) return null;
    // A directory (or any non-regular file) is not read: return null so the query falls through
    // to the agent path instead of readFileSync throwing EISDIR into a silent executor catch.
    if (!_isFile(filePath)) return null;
    // SECURITY: never return a dotenv secret file raw. Return null so the query falls through to
    // the agent path, whose read_file returns variable NAMES only under the same rule.
    if (_isDotenvSecretPath(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      ok: true,
      answer: content,
      sources: [{ file: relPath }],
      confidence: 1.0,
      advisory: false, // cited path — the verbatim file read IS the source (Finding 3)
    };
  } : undefined;

  // Named paths (backlog.fix.research-agent-named-path-read). Detection is skipped for a verbatim
  // query so the short-circuit result is exactly what it was. `detected` (existing and missing,
  // in-root only) is what namedPaths reports; `reserved` (existing only) gets the reserved read and
  // is listed in the user message. A supplied set (tools process) replaces detection.
  const detected = Array.isArray(namedPaths)
    ? _existingNamedPaths(namedPaths, projectRoot)
    : (verbatimMatch ? [] : detectNamedPaths(query, projectRoot));
  const reserved = new Set(detected.filter((e) => e.exists).map((e) => e.path));
  const namedLine = reserved.size > 0
    ? `\n\nNamed paths (exist on disk): ${[...reserved].join(', ')}. Read these directly with read_file first; a read of a named path does not use the discovery read_file budget.`
    : '';
  // A named path's first read is reserved; a repeat read of it counts as a discovery read.
  const reservedReadFor = (p) => {
    if (reserved.size === 0) return null;
    const rel = _namedRel(projectRoot, p);
    if (!rel || !reserved.has(rel)) return null;
    return readCounter.paths.some((e) => e.named === true && e.path === rel) ? null : rel;
  };

  // rag_query with the thin-results fallback cascade. The cascade value it returns is what the
  // retrieval record classifies (backlog.fix.research-agent-output-contract).
  // telemetryId (backlog.feat.research-agent-run-telemetry-coverage) is the invocation's join key:
  // forwarded to both runRagQuery calls only when supplied, so rag.query omits it otherwise.
  const ragTelemetry = telemetryId ? { telemetryId } : {};
  async function ragQueryWithCascade(input) {
    const intent = inferQueryIntent(input.q);
    const result = await runRagQuery(projectRoot, { q: input.q, k: input.k || 5, intent, ...ragTelemetry });
    const matches = result?.matches || [];
    // Fallback cascade: thin results → broaden query → return best
    if (matches.length < 2) {
      const broadWords = input.q.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(' ');
      if (broadWords && broadWords !== input.q) {
        try {
          const broadResult = await runRagQuery(projectRoot, { q: broadWords, k: input.k || 5, intent, ...ragTelemetry });
          const broadMatches = broadResult?.matches || [];
          if (broadMatches.length > matches.length) {
            return { ...broadResult, _cascade: 'broadened' };
          }
        } catch { /* best-effort — return original result below */ }
      }
      return { ...result, _cascade: matches.length === 0 ? 'no_results' : 'thin_results' };
    }
    return result;
  }

  return {
    name: 'research',
    attemptState,
    model: cfg.model,
    fallbackModel: cfg.fallbackModel,
    prompt: cfg.prompt || RESEARCH_SYSTEM_PROMPT,
    userMessage: `Research question: "${query}"${scopeHint}\n\nProject: ${projectId}. Use rag_query to find relevant files, then read_file if you need exact content. Return a structured answer.${namedLine}`,
    inputSchema: ResearchInputSchema,
    outputSchema: buildResearchOutputSchema({ baseSchema: ResearchOutputSchema, retrieval, projectRoot, budget, namedPaths: detected }),
    // claude-cli backend (backlog.feat.agent-backend-selection-research): the out-of-process
    // executor needs the Zod source for --json-schema (outputSchema above is a plain parse
    // wrapper, not a Zod schema) and the retrieval record, so rag_query outcomes reported by the
    // rks-agent-tools server reach the same code-set failureCategory logic. Ignored by _executeAgent.
    _outputSchemaZod: ResearchOutputSchema,
    _retrieval: retrieval,
    // Tool budget view (backlog.fix.research-agent-budget-observed-not-asserted): the tools process
    // writes _budget.snapshot(); the claude-cli executor replays it here before the parse.
    _budget: budget,
    // Existing named paths (backlog.fix.research-agent-named-path-read): the claude-cli executor
    // passes them to the tools process, which cannot detect them from its empty query.
    _namedPaths: [...reserved],
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
          // A refusal is not a retrieval: it returns BEFORE retrieval.record, so it records no outcome.
          if (ragCounter.count >= ragCounter.max) return budgetRefusal('rag_query', ragCounter);
          ragCounter.count++;
          ragCounter.queries.push(input.q);
          const out = await ragQueryWithCascade(input);
          retrieval.record(classifyRetrieval(out));
          return out;
        },
      },
      {
        name: 'read_file',
        description: 'Read the contents of a specific file. Read a path named in the question directly; otherwise use after rag_query identifies relevant files. Returns file content as text.',
        inputSchema: z.object({
          path: z.string().describe('Relative file path from project root'),
          offset: z.number().optional().describe('Start line (0-indexed, default 0)'),
          limit: z.number().optional().describe('Max lines to read (default 200)'),
        }),
        execute: async (input) => {
          // A named path's reserved read is listed in paths with named: true and does not count
          // toward the discovery budget (backlog.fix.research-agent-named-path-read).
          const namedRel = reservedReadFor(input.path);
          let entry;
          if (namedRel) {
            entry = { path: namedRel, offset: input.offset || 0, limit: input.limit || 200, named: true };
          } else {
            if (readCounter.count >= readCounter.max) return budgetRefusal('read_file', readCounter);
            // Admitted: the slot is consumed whatever the result (ARCH ruling, cross-delegate precedent).
            readCounter.count++;
            entry = { path: input.path, offset: input.offset || 0, limit: input.limit || 200 };
          }
          readCounter.paths.push(entry);
          const filePath = path.resolve(projectRoot, input.path);
          // Safety: ensure path is within project root
          if (!isWithinProjectRoot(projectRoot, filePath)) {
            entry.error = true; // listed, but no content was returned
            return { error: 'Path traversal blocked — must be within project root' };
          }
          if (!fs.existsSync(filePath)) {
            entry.error = true;
            return { error: `File not found: ${input.path}` };
          }
          // SECURITY: never return secret VALUES from dotenv files. This agent's read_file
          // runs in-process inside the MCP server, where the built-in Read deny (.claude/
          // settings.json) and the read hooks do NOT apply — so enforce it here. .env / .env.*
          // carry live credentials; return variable NAMES only. (.env.example/.sample/.template
          // are committed, non-secret, and read normally.) A "redact values" instruction in the
          // query is not a control. See backlog.security.agent-env-secret-leak-redaction.
          const dotenvStub = redactDotenvRead(filePath, input.path);
          if (dotenvStub) return dotenvStub;
          let lines;
          let slice;
          const offset = input.offset || 0;
          const limit = input.limit || 200;
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            lines = content.split('\n');
            slice = lines.slice(offset, offset + limit);
          } catch (err) {
            // Exists but unreadable (a directory gives EISDIR, or a permission error): the slot
            // stays used and the entry is listed, but no content was returned.
            entry.error = true;
            return { error: `Could not read ${input.path}: ${err?.message || String(err)}` };
          }
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
          // EXEMPT from writeGuard (backlog.feat.agent-code-path-note-writes-guarded):
          // DENIED_NAMESPACES already blocks backlog.* and z_archive.*; the story/qa namespace allowlist
          // would refuse the research papers this agent writes inside story and QA chains; writeGuard is
          // accepted for uniform delegation but intentionally not applied here.
          // skipEmbed: write → commit → embed, as commitAndEmbedNote expects.
          writeNoteRaw(notePath, content, { skipEmbed: true });
          const commit = await commitInAgentNoteWrite({ projectRoot, tool: 'dendron_create_note', noteId: input.filename, notePath });
          return { ok: true, filename: input.filename, path: notePath, ...commit };
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
          // EXEMPT from writeGuard (backlog.feat.agent-code-path-note-writes-guarded):
          // DENIED_NAMESPACES already blocks backlog.* and z_archive.*; the story/qa namespace allowlist
          // would refuse the research papers this agent writes inside story and QA chains; writeGuard is
          // accepted for uniform delegation but intentionally not applied here.
          editNote(notesDir, input.filename, input.body, { skipEmbed: true });
          const commit = await commitInAgentNoteWrite({ projectRoot, tool: 'dendron_edit_note', noteId: input.filename, notePath });
          return { ok: true, filename: input.filename, ...commit };
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
            // EXEMPT from writeGuard (backlog.feat.agent-code-path-note-writes-guarded):
          // DENIED_NAMESPACES already blocks backlog.* and z_archive.*; the story/qa namespace allowlist
            // would refuse the research papers this agent writes inside story and QA chains; writeGuard is
            // accepted for uniform delegation but intentionally not applied here.
            const result = updateField(notesDir, input.filename, input.field, input.value, { skipEmbed: true });
            // SPREAD-FIRST. A library refusal (ok:false, e.g. an array-shrink guard) must
            // override the old hardcoded ok:true — but the library result carries neither
            // filename nor field, and an existing assertion reads field, so both are
            // re-applied after the spread rather than replaced by it.
            // A refusal returns before any commit call.
            if (!result || result.ok === false) {
              return { ...result, filename: input.filename, field: input.field };
            }
            const safeName = String(input.filename).trim();
            const notePath = path.join(notesDir, safeName.endsWith('.md') ? safeName : `${safeName}.md`);
            const commit = await commitInAgentNoteWrite({ projectRoot, tool: 'dendron_update_field', noteId: input.filename, notePath });
            return { ...result, filename: input.filename, field: input.field, ...commit };
          } catch (err) {
            return { error: err?.message ?? String(err) };
          }
        },
      },
      readGitTool,
      exhaustiveSearchTool,
    ],
  };
}
