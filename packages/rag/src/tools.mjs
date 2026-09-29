import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { validateToken, getTokenFidelity } from "./capability-token.mjs";
import { FIDELITY_LEVELS } from "./fidelity-filter.mjs";
import { getRagPathsFor } from "./rag-config-loader.mjs";

// ── Host hooks (dependency inversion) ────────────────────────────────────────────────────────────
// This module must keep ZERO static imports resolving outside src/rag/ so the RAG substrate can be
// lifted into a standalone @routekit/rag package without a cross-package cycle back into the mcp-rks
// host. The two host couplings — session-state provenance and the telemetry collector — are injected.
// The mcp-rks server wires the real implementations at startup (through the rag barrel) via
// setRagHostHooks(); until wired they are safe no-ops, so a standalone/unwired RAG op never throws.
const NOOP_TELEMETRY = { emit() {} };
let _addRagSourcedPath = () => {};
let _getTelemetryCollector = () => NOOP_TELEMETRY;

/**
 * Install the mcp-rks host implementations for the RAG module's two side-effect couplings
 * (provenance tracking + telemetry). Called once by the host at server startup. Entries that are
 * missing or not functions keep the safe default — behavior is byte-identical to the old static
 * imports once wired.
 */
export function setRagHostHooks({ addRagSourcedPath, getTelemetryCollector } = {}) {
  if (typeof addRagSourcedPath === "function") _addRagSourcedPath = addRagSourcedPath;
  if (typeof getTelemetryCollector === "function") _getTelemetryCollector = getTelemetryCollector;
}

/**
 * Ownership-scoped fidelity ceiling for a project.
 *
 * A self-hosted project that OWNS its corpus (`.rks/project.json` → `rag.fidelityCeiling: "full"`)
 * authorizes L3 full-fidelity retrieval over its own local index — the querier already has the
 * source files, so redacting retrieval protects nothing and only degrades the (keyless) experience.
 * Anything else — absent, malformed, or the explicit "redacted" value — FAILS CLOSED to the redacted
 * (L2) ceiling, which is the future RKS-Pro / multi-tenant / shipped-private-index posture. Never
 * throws. Note this keys off corpus OWNERSHIP, not key-presence: a keyless-local caller inherits
 * "full" because it owns its corpus, and a keyed single-tenant self-host does too.
 */
export function resolveFidelityCeiling(projectRoot) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    return pj?.rag?.fidelityCeiling === "full" ? "full" : "redacted";
  } catch {
    return "redacted";
  }
}

// The RAG config seam (getRagPathsFor → @routekit/cli) and the absorbed embed/query/init pipeline
// are now sibling modules under packages/rag/src/. getRagPathsFor is imported from the shared
// rag-config-loader (dynamic import() to @routekit/cli, cycle-safe); the pipeline is loaded via
// sibling dynamic import (./init.mjs etc.) — no more repoRoot-relative loadScript indirection.

export async function runRagInit(projectRoot) {
  const { init } = await import("./init.mjs");
  const ragPaths = await getRagPathsFor(projectRoot);
  const initStartMs = Date.now();
  const projectId = path.basename(projectRoot);
  try {
    const result = await init({ db: ragPaths.notes });
    try {
      _getTelemetryCollector().emit("rag.init", projectId, {
        projectId,
        durationMs: Date.now() - initStartMs,
        ok: true,
      });
    } catch (e) { /* telemetry is best-effort */ }
    return result;
  } catch (err) {
    try {
      _getTelemetryCollector().emit("rag.init", projectId, {
        projectId,
        durationMs: Date.now() - initStartMs,
        ok: false,
      });
    } catch (e) { /* telemetry is best-effort */ }
    throw err;
  }
}

function checkEmbedLock(projectRoot) {
  const lockPath = path.join(projectRoot, '.rks', 'rag', '.embed-lock');
  if (!fs.existsSync(lockPath)) return { locked: false };

  try {
    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lockData.pid) {
      try {
        process.kill(lockData.pid, 0);
        return { locked: true, pid: lockData.pid, started: lockData.started };
      } catch {
        // PID dead, remove orphaned lock
        fs.unlinkSync(lockPath);
        return { locked: false, cleaned: true };
      }
    }
    // No PID, check age
    const stats = fs.statSync(lockPath);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
    if (ageSeconds > 300) {
      fs.unlinkSync(lockPath);
      return { locked: false, cleaned: true };
    }
    return { locked: true, started: lockData.started };
  } catch {
    return { locked: false };
  }
}

export async function runRagEmbed(projectRoot, options = {}) {
  // Check for active embed lock before proceeding
  const lockStatus = checkEmbedLock(projectRoot);
  if (lockStatus.locked) {
    return {
      ok: false,
      error: `Embed already in progress (PID: ${lockStatus.pid || 'unknown'}, started: ${lockStatus.started})`,
      locked: true,
    };
  }

  const startTime = Date.now();
  const projectId = path.basename(projectRoot);
  const triggeredBy = options.triggeredBy || 'mcp';

  // Get current commit SHA for telemetry (best-effort)
  let commitSha = null;
  try {
    const gitResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
    commitSha = gitResult.stdout?.trim() || null;
  } catch { /* best-effort */ }

  try {
    _getTelemetryCollector().emit('rag.embed.start', projectId, {
      projectId, triggeredBy, commitSha, startedAt: new Date(startTime).toISOString(),
    });
  } catch { /* best-effort */ }

  const diagnostics = {
    phase: "init",
    projectRoot,
    options,
    startTime: new Date(startTime).toISOString(),
  };

  try {
    diagnostics.phase = "load_script";
    const { embed } = await import("./embed.mjs");

    diagnostics.phase = "get_rag_paths";
    const ragPaths = await getRagPathsFor(projectRoot);
    diagnostics.ragPaths = ragPaths;

    diagnostics.phase = "embed";
    const res = await embed({
      projectRoot,
      db: ragPaths.notes,
      glob: options.glob,
      vault: options.vault,
      files: options.files,
    });

    // Record a lightweight last-embed timestamp so planner can warn about stale embeddings.
    try {
      const metaPath = path.join(projectRoot, ".rks/rag/last-embed.json");
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ lastEmbedMs: Date.now() }));
    } catch (e) {
      console.error(`[rag.tools] failed to write embed timestamp: ${e?.message}`);
    }

    // Auto-compact: compact fragments then prune all old versions.
    // Embeddings are current state — fully recreatable from source. No history needed.
    //
    // Guarded on the embed RESULT CONTRACT, not on a caught error. The embeddings table is
    // created lazily (embed.mjs only creates it when there is something to write), so a run
    // that indexed nothing leaves no table and openTable() rejects with
    // "Table 'embeddings' was not found" — swallowed below and surfaced as an operator-facing
    // error line that looks like a real failure. That trains readers to ignore [rag.tools]
    // errors, which is how a genuine compaction failure gets missed.
    //
    // `indexed === 0` is the ONLY correct predicate across embed()'s return shapes:
    //   A1 no-changes, populated store   indexed > 0, table present -> compact (version pruning)
    //   A2 no-changes, no table          indexed === 0, table absent -> skip
    //   B  pruned empty corpus           indexed === 0, table just dropped -> skip
    //   C  wrote data                    indexed > 0, table present -> compact
    // `skipped === true` is wrong in BOTH directions: shape B carries no `skipped` field at
    // all (so the noise persists), and shape A1 has skipped:true with a live table (so it
    // would silently disable the version-pruning added by backlog.fix.rag-embed-bloat-cleanup).
    //
    // Deliberately NOT a db.tableNames() existence check: that is an existence test rather
    // than a contract test, so it would silently suppress the genuine "claimed to embed data
    // but there is no table" defect. Here that case still reaches openTable() and still
    // reports. If `indexed` is absent entirely, compaction is ATTEMPTED so contract drift
    // fails toward reporting rather than toward silence.
    if (res?.indexed === 0) {
      diagnostics.autoCompactSkipped = "nothing-indexed";
    } else {
      try {
        const { connect } = await import("@lancedb/lancedb");
        const db = await connect(diagnostics.ragPaths.notes);
        const table = await db.openTable("embeddings");
        await table.optimize({ compaction: true });
        await table.optimize({ cleanupOlderThan: new Date() });
      } catch (e) {
        console.error(`[rag.tools] auto-compact failed: ${e?.message}`);
      }
    }

    // Clean up legacy lance/ directory if present (one-time migration)
    try {
      const legacyDir = path.join(projectRoot, ".rks", "rag", "lance");
      if (fs.existsSync(legacyDir)) {
        fs.rmSync(legacyDir, { recursive: true });
        console.error("[rag.tools] removed legacy .rks/rag/lance/ directory");
      }
    } catch (e) {
      console.error(`[rag.tools] legacy cleanup failed: ${e?.message}`);
    }

    try {
      _getTelemetryCollector().emit("rag.embed", path.basename(projectRoot), {
        projectId,
        filesProcessed: (res.processedNotes ?? 0) + (res.processedCodeFiles ?? 0),
        chunksCreated: res.addedEmbeddings ?? null,
        removedCount: res.removedEmbeddings ?? 0,
        durationMs: Date.now() - startTime,
        indexSize: res.totalEmbeddings ?? null,
        commitSha,
        triggeredBy,
      });
    } catch (e) { /* telemetry is best-effort */ }
    return { ...res, removedCount: res.removedEmbeddings ?? 0 };
  } catch (error) {
    const elapsed = Date.now() - startTime;

    try {
      _getTelemetryCollector().emit('rag.embed.failed', projectId, {
        projectId,
        error: error?.message || String(error),
        exitCode: error?.code || null,
        filesProcessed: 0,
        triggeredBy,
        phase: diagnostics.phase,
        durationMs: elapsed,
        commitSha,
      });
    } catch { /* best-effort */ }

    const errorDetails = {
      ok: false,
      error: error?.message || String(error),
      errorType: error?.name || "UnknownError",
      errorCode: error?.code || null,
      phase: diagnostics.phase,
      elapsedMs: elapsed,
      projectRoot,
      ragPaths: diagnostics.ragPaths || null,
      stack: error?.stack?.split("\n").slice(0, 5).join("\n") || null,
    };

    console.error(`[rag.tools] runRagEmbed failed:`, JSON.stringify(errorDetails, null, 2));

    // Return error details instead of throwing, so MCP gets useful info
    return errorDetails;
  }
}

export function getLastEmbedTime(projectRoot) {
  try {
    const metaPath = path.join(projectRoot, ".rks/rag/last-embed.json");
    if (!fs.existsSync(metaPath)) return null;
    const data = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return data?.lastEmbedMs || null;
  } catch (e) {
    console.error(`[rag.tools] failed to read embed timestamp: ${e?.message}`);
    return null;
  }
}

export async function ensureRagIndex(projectRoot, options = {}) {
  try {
    const ragDir = path.join(projectRoot, ".rks", "rag");
    const notesDir = path.join(projectRoot, "notes");

    // If there are no notes, nothing to do.
    if (!fs.existsSync(notesDir)) {
      return { ok: false, reason: "no-notes" };
    }

    // If rag directory exists and has files, no need to auto-embed.
    const ragExists = fs.existsSync(ragDir) && fs.readdirSync(ragDir).length > 0;
    if (ragExists) {
      return { ok: true, seeded: false };
    }

    // Auto-embed using existing runRagEmbed helper.
    await runRagEmbed(projectRoot, { glob: options.glob || "*" });
    return { ok: true, seeded: true };
  } catch (e) {
    console.error(`[rag.tools] ensureRagIndex failed: ${e?.message}`);
    return { ok: false, error: e?.message };
  }
}

/**
 * The notes/ prefix rule, written exactly ONCE.
 *
 * The two embed loops disagree about what `path` is relative to: the note loop stores a
 * VAULT-relative path (`backlog.feat.X.md`, embed.mjs) while the code walk stores a
 * PROJECT-ROOT-relative one (`notes/backlog.feat.X.md`). A bare `.md` slug is therefore a
 * note-loop row and only resolves once the vault prefix is restored.
 *
 * Absolute paths and non-.md paths are returned untouched.
 */
export function ragCanonicalPath(p) {
  if (!p) return p;
  if (!p.startsWith('notes/') && !p.startsWith('/') && p.endsWith('.md')) {
    return 'notes/' + p;
  }
  return p;
}

/**
 * The whole keep/drop decision for the stale-file guard, as a pure function.
 *
 * Kept deliberately as one predicate rather than a candidate list: both callers want
 * "does this row's source still exist", and a list would force each of them to re-implement
 * the composition — which is the duplication that caused this defect in the first place.
 *
 * A row with no path is kept (unchanged behaviour). A row whose path resolves in EITHER the
 * literal or the canonical form is kept. Everything else is dropped, so a genuinely deleted
 * file still fires the guard — that is the guard's original and still-valid purpose.
 */
export function ragPathExists(projectRoot, p) {
  if (!p) return true;
  if (fs.existsSync(path.resolve(projectRoot, p))) return true;
  const canonical = ragCanonicalPath(p);
  return canonical !== p && fs.existsSync(path.resolve(projectRoot, canonical));
}

export async function runRagQuery(projectRoot, options) {
  if (!options?.q) {
    throw new Error("Query text is required");
  }

  const queryStartMs = Date.now();

  // Ownership-scoped ceiling. When the project owns its corpus, the DEFAULT retrieval fidelity
  // (used when the caller makes no explicit request — e.g. the keyless path) rises to L3, and the
  // per-source-class ceiling is lifted via `overrides` passed into filterByFidelity. When it does
  // NOT own the corpus (Pro/redacted, or fail-closed default) the historical L2 default holds.
  const ownsCorpus = resolveFidelityCeiling(projectRoot) === "full";
  const fidelityOverrides = ownsCorpus
    ? { project: FIDELITY_LEVELS.L3_FULL, public: FIDELITY_LEVELS.L3_FULL }
    : {};

  // Use capability token if provided, otherwise use explicit fidelity
  let fidelity = options.fidelity ?? (ownsCorpus ? FIDELITY_LEVELS.L3_FULL : 2); // Default L2 unless owned corpus → L3
  let capabilityToken = options.capabilityToken;

  if (capabilityToken) {
    const { valid, errors } = validateToken(capabilityToken);
    if (!valid) {
      console.warn(`[rag.tools] Invalid capability token: ${errors.join(', ')}`);
      capabilityToken = null;
    } else {
      // Use token's max fidelity, capped by any explicit fidelity request. This Math.min runs AFTER
      // the ownership default, so a low Governor role (e.g. Scout maxFidelity 0) is never elevated by
      // corpus ownership — the role cap always wins.
      fidelity = Math.min(fidelity, capabilityToken.maxFidelity);
    }
  }

  const { query } = await import("./query.mjs");
  const ragPaths = await getRagPathsFor(projectRoot);
  const projectSlug = path.basename(projectRoot);
  let result = await query({
    db: ragPaths.notes,
    q: options.q,
    k: capabilityToken?.maxResultsPerQuery ?? options.k,
    projectSlug,
    fidelity,
    overrides: fidelityOverrides,
    intent: options.intent,
  });

  // Filter out results whose source file no longer exists on disk
  if (result?.matches?.length) {
    const before = result.matches;
    const filtered = before.filter(m => ragPathExists(projectRoot, m?.path || m?.source || m?.file));
    const staleDropped = before.filter(m => {
      const p = m?.path || m?.source || m?.file;
      if (!p) return false;
      return !ragPathExists(projectRoot, p);
    });
    if (staleDropped.length > 0) {
      result = { ...result, matches: filtered };
      try {
        _getTelemetryCollector().emit("rag.query.stale_filtered", projectSlug, {
          filteredCount: staleDropped.length,
          filteredPaths: staleDropped.map(m => m?.path || m?.source || m?.file).filter(Boolean),
          query: (options.q || "").slice(0, 200),
        });
      } catch (e) { /* best-effort */ }
    }
  }

  try {
    _getTelemetryCollector().emit("rag.query", projectSlug, {
      query: (options.q || "").slice(0, 200),
      resultsReturned: result?.matches?.length ?? 0,
      durationMs: Date.now() - queryStartMs,
      indexSize: null,
    });
  } catch (e) { /* telemetry is best-effort */ }

  // Track RAG-sourced paths in session state for provenance
  // This enables the read-provenance hook to allow reads of these files
  try {
    const matches = result?.matches || [];
    for (const match of matches) {
      let p = match?.path || match?.source || match?.file;
      if (p) {
        // Same rule as the stale-file guard above — one helper, not a second inline copy.
        p = ragCanonicalPath(p);
        _addRagSourcedPath(p, options.q);
      }
    }
  } catch (e) {
    // Best-effort tracking - don't fail the query if session state update fails
    console.error(`[rag.tools] session state tracking failed: ${e?.message}`);
  }

  return result;
}

export async function runRagCompact(projectRoot) {
  const ragPaths = await getRagPathsFor(projectRoot);
  const ragDir = path.dirname(ragPaths.notes);

  // Calculate directory size (works on macOS and Linux)
  function getDirSize(dir) {
    let total = 0;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          total += getDirSize(fullPath);
        } else {
          total += fs.statSync(fullPath).size;
        }
      }
    } catch (e) {
      console.error(`[rag.tools] getDirSize error: ${e?.message}`);
    }
    return total;
  }

  // Calculate size before compaction
  const beforeBytes = getDirSize(ragDir);

  // Open LanceDB and optimize: compact first, then prune
  try {
    const { connect } = await import("@lancedb/lancedb");
    const db = await connect(ragPaths.notes);
    const table = await db.openTable("embeddings");
    await table.optimize({ compaction: true });
    await table.optimize({ cleanupOlderThan: new Date() });
  } catch (err) {
    throw new Error(`LanceDB optimize failed: ${err?.message || String(err)}`);
  }

  // Clean up legacy lance/ directory if present
  try {
    const legacyDir = path.join(ragDir, "lance");
    if (fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true });
    }
  } catch (e) { /* best-effort */ }

  // Prune old embed run directories
  try {
    const embedsDir = path.join(ragDir, "embeds");
    if (fs.existsSync(embedsDir)) {
      const dirs = fs.readdirSync(embedsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
      if (dirs.length > 1) {
        const toRemove = dirs.slice(0, dirs.length - 1);
        for (const dir of toRemove) {
          fs.rmSync(path.join(embedsDir, dir), { recursive: true });
        }
      }
    }
  } catch (e) { /* best-effort */ }

  // Calculate size after compaction
  const afterBytes = getDirSize(ragDir);

  const reclaimedBytes = beforeBytes - afterBytes;
  return { beforeBytes, afterBytes, reclaimedBytes };
}

// ── Governed exhaustive search ─────────────────────────────────────────────
//
// The precision beat of the recall→precision→commit loop. Unlike runRagQuery
// (semantic, top-k), this returns EVERY literal occurrence of `pattern` within a
// scoped path, with cited file:line + verbatim matched text + a git-state anchor.
// The raw search runs server-side here; only the structured cited result set is
// returned — raw stdout never surfaces to the main thread. This keeps exhaustive
// search inside the governed evidence layer (the read-redirect architecture is
// deliberately RAG-centric; raw grep results never hit the main thread).
//
// See notes/research.2026.06.28.uat-findings.md Findings 6, 7, 9, 10.

const EXHAUSTIVE_IGNORE_DIRS = new Set([
  "node_modules", ".git", ".rks", "dist", "build", "coverage", ".routekit",
]);

// Every reason a path can be left un-searched. Callers should compare against these
// constants rather than hard-coding the strings — the set is expected to grow, and a
// hard-coded comparison silently misses any reason added later. Each of these used to be a bare
// `return`, which is precisely what made `fileCount: 0` indistinguishable from
// "we looked and there is nothing there". Silence was the defect; these names are
// the fix. Any new skip site MUST add a reason here and record it.
export const EXHAUSTIVE_SKIP_REASONS = Object.freeze({
  IGNORED_DIR: "ignored_dir",
  TESTS_TMP: "tests_tmp",
  STAT_FAILED: "stat_failed",
  READDIR_FAILED: "readdir_failed",
  OVERSIZE: "oversize",
  READ_FAILED: "read_failed",
});

/**
 * Compute a git-state anchor for the search result set (Finding 9).
 * Returns `@<short-sha>` for a committed tree, `@<short-sha>+dirty` when the
 * working tree has uncommitted changes, or null when not a git repo.
 */
export function computeGitAnchor(projectRoot) {
  try {
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot, encoding: "utf8", timeout: 5000,
    });
    if (sha.status !== 0) return null;
    const shaStr = (sha.stdout || "").trim();
    if (!shaStr) return null;
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: projectRoot, encoding: "utf8", timeout: 5000,
    });
    const dirty = status.status === 0 && (status.stdout || "").trim().length > 0;
    return dirty ? `@${shaStr}+dirty` : `@${shaStr}`;
  } catch {
    return null;
  }
}

/**
 * Deterministic, exhaustive, bounded literal search.
 *
 * @param {string} projectRoot
 * @param {object} options
 * @param {string} options.pattern      - literal string to find (required)
 * @param {string} options.path         - scoped path under projectRoot (REQUIRED — bounded)
 * @param {boolean} [options.countOnly] - return filenames + match counts only (bounded mode)
 * @param {number} [options.maxResults] - cap on returned hits (default 1000)
 * @returns {object} cited-result contract: { ok, pattern, path, anchor, exhaustive,
 *                   countOnly, fileCount, matchCount, truncated, skipped, warnings,
 *                   files?, results? }
 *
 * `exhaustive` is COMPUTED, never asserted: it is true only when nothing was skipped
 * and the pattern could actually match. `skipped` names every path not traversed, with
 * a reason from EXHAUSTIVE_SKIP_REASONS; `warnings` carries caller-facing limitations.
 * Both are present in countOnly mode too, so a count is never less qualified than a
 * full result set. Throws when the scoped path does not exist — a typo must not be
 * reportable as proven absence.
 */
export function runExhaustiveSearch(projectRoot, options = {}) {
  const pattern = options.pattern;
  const scopedPath = options.path;
  if (!pattern) throw new Error("pattern is required");
  if (!scopedPath || String(scopedPath).trim() === "") {
    throw new Error(
      "a scoped 'path' is required — exhaustive search is bounded, never repo-wide",
    );
  }
  const absRoot = path.resolve(projectRoot);
  const absSearch = path.resolve(absRoot, scopedPath);
  if (absSearch !== absRoot && !absSearch.startsWith(absRoot + path.sep)) {
    throw new Error("path must resolve within the project root");
  }

  // Mode 3 — a scoped path that does not exist is a caller error, not an absence of
  // matches. Checked BEFORE the walk so that a mid-walk stat failure (a file that
  // vanishes during traversal) remains a disclosed skip rather than a thrown error.
  if (!fs.existsSync(absSearch)) {
    throw new Error(
      `scoped path does not exist: ${scopedPath} — a nonexistent path is a typo or a ` +
      `stale reference, never evidence that the pattern is absent`,
    );
  }

  const anchor = computeGitAnchor(absRoot);
  const maxResults = options.maxResults ?? 1000;
  const countOnly = !!options.countOnly;

  // Disclosure state. `skipped` is the answer to "what did you NOT look at".
  const skipped = [];
  const warnings = [];
  const relOf = (t) => path.relative(absRoot, t) || ".";
  const noteSkip = (t, reason) => { skipped.push({ path: relOf(t), reason }); };

  // Mode 6 — matching is line-scoped, so a pattern containing a newline can never
  // match anything. Returning a bare zero for it is indistinguishable from proven
  // absence, which is this tool's worst failure.
  // Both \n and \r: content is split on \n, so a CR-only or CRLF pattern is equally
  // unmatchable, and reporting exhaustive:true for one would be the same false zero.
  const multilinePattern = pattern.includes("\n") || pattern.includes("\r");
  if (multilinePattern) {
    warnings.push(
      "pattern contains a newline, and matching is line-scoped — it cannot match. " +
      "This zero reflects a matcher limitation, NOT absence. Search for one " +
      "distinctive line instead, then widen by reading the file.",
    );
  }

  const results = [];
  const fileCounts = new Map();

  function walk(target, isScopeRoot) {
    let stat;
    try { stat = fs.statSync(target); }
    catch { noteSkip(target, EXHAUSTIVE_SKIP_REASONS.STAT_FAILED); return; }
    if (stat.isDirectory()) {
      // Mode 2 — an explicitly named scope root is ALWAYS traversed, even when its
      // basename is denylisted. The caller asked for this directory by name; pruning
      // it answers a question they did not ask, and answers it with a zero.
      if (!isScopeRoot && EXHAUSTIVE_IGNORE_DIRS.has(path.basename(target))) {
        noteSkip(target, EXHAUSTIVE_SKIP_REASONS.IGNORED_DIR);
        return;
      }
      // Skip the project's own tests/.tmp scratch — but only directly under the
      // project root (so a project that itself lives under some .tmp path, e.g. a
      // temp-dir test fixture, is still searchable).
      const relFromRoot = path.relative(absRoot, target);
      const tmpRel = path.join("tests", ".tmp");
      if (!isScopeRoot && (relFromRoot === tmpRel || relFromRoot.startsWith(tmpRel + path.sep))) {
        noteSkip(target, EXHAUSTIVE_SKIP_REASONS.TESTS_TMP);
        return;
      }
      let entries;
      try { entries = fs.readdirSync(target).sort(); }
      catch { noteSkip(target, EXHAUSTIVE_SKIP_REASONS.READDIR_FAILED); return; }
      for (const e of entries) walk(path.join(target, e), false);
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > 2 * 1024 * 1024) {
      noteSkip(target, EXHAUSTIVE_SKIP_REASONS.OVERSIZE);
      return;
    }
    let content;
    try { content = fs.readFileSync(target, "utf8"); }
    catch { noteSkip(target, EXHAUSTIVE_SKIP_REASONS.READ_FAILED); return; }
    if (content.indexOf(pattern) === -1) return;
    const rel = path.relative(absRoot, target);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pattern)) {
        fileCounts.set(rel, (fileCounts.get(rel) || 0) + 1);
        if (!countOnly && results.length < maxResults) {
          results.push({ file: rel, line: i + 1, text: lines[i] });
        }
      }
    }
  }
  walk(absSearch, true);

  // Deterministic ordering: by file, then by line.
  results.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  const matchCount = [...fileCounts.values()].reduce((s, n) => s + n, 0);
  return {
    ok: true,
    pattern,
    path: scopedPath,
    anchor,
    // Computed, never asserted. False the moment anything was left unsearched or the
    // pattern could not have matched — so `exhaustive: true` alongside `fileCount: 0`
    // is now a real claim of absence rather than a decoration.
    exhaustive: skipped.length === 0 && !multilinePattern,
    countOnly,
    fileCount: fileCounts.size,
    matchCount,
    truncated: !countOnly && matchCount > results.length,
    // Present in BOTH modes: a count must not be less qualified than a result set.
    skipped,
    warnings,
    files: countOnly
      ? [...fileCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([file, count]) => ({ file, count }))
      : undefined,
    results: countOnly ? undefined : results,
  };
}
