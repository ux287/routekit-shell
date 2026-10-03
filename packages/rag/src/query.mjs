#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getProjectContext } from './utils.mjs';
import { getRagPathsFor } from './rag-config-loader.mjs';
import { hybridSearch } from '@routekit/rag/hybrid-search';
import { createIndex } from '@routekit/rag/bm25-index';
import { filterByFidelity, FIDELITY_LEVELS } from '@routekit/rag/fidelity-filter';
import { CONTENT_TYPE_BOOST, inferQueryIntent, isImplementationQuery, getNamespaceBoost, getCanonicalPathBoost } from '@routekit/rag/query-intent';
import { missingRequiredColumns, selectableProjection, tableFieldNames, toPlainList } from '@routekit/rag/rag-columns';
// Shared embedding pipeline (singleton across all modules — one ONNX load per process; stub-mode aware).
import { getSharedEmbeddingPipeline } from '@routekit/rag/embedding-pipeline';

// Pass explicitProjectRoot (undefined when the env var is absent) to the resolver so it runs
// zero-argument discovery. projectRoot stays an absolute string — :43 consumes it.
const explicitProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? resolve(process.env.ROUTEKIT_PROJECT_ROOT) : undefined;
const projectRoot = explicitProjectRoot ?? process.cwd();
const context = getProjectContext(explicitProjectRoot);
const DEFAULT_PROJECT_SLUG = context.projectSlug;

// Configuration
const DEFAULT_LIMIT = 5;

// Status-based relevance boost multipliers
// Implemented items represent proven patterns and should rank higher
const STATUS_BOOST = {
  implemented: 1.5,
  in_progress: 1.2,
  ready: 1.0,
  pending: 0.9,
  unknown: 0.8,
};


// Delegates to the shared process-wide singleton (stub-mode aware; one ONNX load per process).
async function getEmbeddingPipeline() {
  return getSharedEmbeddingPipeline();
}

// Exact-phrase recall (backlog.fix.rag-keyword-leg-cannot-recall-outside-semantic-window). A query of at
// least PHRASE_PIN_MIN_TOKENS whitespace tokens is also matched literally against the whole table, so a
// verbatim sentence outside the semantic window is still found. Shorter queries run no scan.
const PHRASE_PIN_MIN_TOKENS = 4;
const PHRASE_SCAN_ROW_LIMIT = 200;

function qualifiesForPhraseScan(q) {
  return String(q || '').trim().split(/\s+/).filter(Boolean).length >= PHRASE_PIN_MIN_TOKENS;
}

// LIKE predicate that matches the phrase LITERALLY: backslash (Lance's only supported LIKE escape
// character) escapes itself and the % / _ wildcards, then single quotes are doubled for the SQL literal.
function phraseLikePredicate(phrase) {
  const escaped = phrase
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/'/g, "''");
  return `text LIKE '%${escaped}%' ESCAPE '\\'`;
}

// One row -> match mapper for vector rows AND phrase-scan rows. A phrase row has no _distance, so its
// baseScore (and the derived score) is null rather than an invented 0.
function toMatch(result, intent, { phraseRow = false } = {}) {
  // != null, not truthiness: a _distance of exactly 0 (an exact match) must score 1, not 0.
  const baseScore = phraseRow ? null : (result._distance != null ? (1 - result._distance) : result.score || 0);
  const status = result.status || 'unknown';
  const statusBoost = STATUS_BOOST[status] || STATUS_BOOST.unknown;
  const contentType = result.content_type || 'note';
  const intentBoosts = CONTENT_TYPE_BOOST[intent] || CONTENT_TYPE_BOOST.neutral;
  const contentTypeBoost = intentBoosts[contentType] ?? 1.0;
  const boostedScore = baseScore === null ? null : baseScore * statusBoost * contentTypeBoost;

  return {
    score: boostedScore,
    baseScore,
    status,
    content_type: contentType,
    source_class: result.source_class,
    slug: result.slug,
    title: result.title,
    path: result.path,
    chunkId: result.chunkId,
    tags: toPlainList(result.tags),
    updatedAt: result.updatedAt,
    text: result.text
  };
}

async function queryEmbeddings(query, limit = DEFAULT_LIMIT, dbPath, projectSlug = DEFAULT_PROJECT_SLUG, intent = 'neutral', options = {}) {
  try {
    // Resolve the default DB path lazily via the dynamic config loader when the caller didn't pass
    // one — keeps this module free of any static @routekit/cli import (cycle-freedom).
    if (!dbPath) {
      dbPath = (await getRagPathsFor(projectRoot)).notes;
    }
    console.error('🔍 Processing query:', query);
    console.error(`🎯 Project: ${projectSlug}`);
    console.error(`📊 Returning top ${limit} results`);

    // Guard the QUERY path against connect()'s auto-create footgun: @lancedb/lancedb connect()
    // fabricates an empty .lancedb dir/table for a missing/wrong path, which would then return an
    // empty result set from a freshly-created index (and leave a stray dir behind) instead of
    // surfacing the real "no index here" error. Fail loudly up front — before the (expensive)
    // embedding step, and before any connect(). QUERY path only: the init/embed create paths
    // (packages/rag/src/init.mjs, packages/rag/src/embed.mjs) are untouched and must still create on first run.
    if (!existsSync(dbPath)) {
      throw new Error(`RAG store not found at ${dbPath}. Run \`rks_rag_init\` and \`rks_rag_embed\` first.`);
    }

    // Generate query embedding
    const pipeline = await getEmbeddingPipeline();
    const queryEmbedding = await pipeline(query, {
      pooling: 'mean',
      normalize: true,
    });
    
    const queryVector = Array.from(queryEmbedding.data);
    console.error('🎯 Generated query embedding');
    
    // Connect to database
    const db = await connect(dbPath);
    console.error('🔗 Connected to LanceDB');
    
    // Open embeddings table
    const table = await db.openTable('embeddings');
    const totalCount = await table.countRows();
    console.error(`📈 Searching ${totalCount} embeddings`);
    
    // Project through the shared column contract. Against a legacy/broken table (e.g. one written
    // before the status-column guarantee) degrade to the selectable subset and warn, rather than
    // letting the driver throw a raw "No field named status".
    const fields = await tableFieldNames(table);
    const missing = missingRequiredColumns(fields);
    if (missing.length > 0) {
      console.error(
        `⚠️  RAG index is missing required column(s): ${missing.join(', ')}. ` +
        `Returning partial rows — re-run \`rks_rag_embed\` to rebuild a fully queryable index.`
      );
    }
    const projection = selectableProjection(fields);

    // Perform similarity search
    const results = await table
      .search(queryVector)
      .select(projection)
      .limit(limit)
      .toArray();

    console.error(`✅ Found ${results.length} results`);

    // Prepare results with status-based relevance boost
    const matches = results.map(result => toMatch(result, intent));

    // Exact-phrase scan over the WHOLE table (same table, same projection), after the vector search.
    // Every outcome is observed and reported: truncation, and either skip, reach the caller.
    let phraseMatches = [];
    let phraseScanTruncated = null;
    let phraseScanSkipped = null;
    const phrase = typeof options.phrase === 'string' && options.phrase ? options.phrase : null;
    if (phrase) {
      if (fields.length === 0) {
        // tableFieldNames returns [] when schema() throws — an unreadable schema, NOT an observed
        // missing column.
        phraseScanSkipped = 'schema_unreadable';
        console.error('⚠️  Phrase scan skipped: the table schema could not be read, so exact-phrase recall did not run for this query.');
      } else if (!fields.includes('text')) {
        phraseScanSkipped = 'no_text_column';
        console.error('⚠️  Phrase scan skipped: the table has no text column, so exact-phrase recall did not run for this query.');
      } else {
        // One probe row beyond the limit makes truncation an observation, not an inference.
        const phraseRows = await table
          .query()
          .where(phraseLikePredicate(phrase))
          .select(projection)
          .limit(PHRASE_SCAN_ROW_LIMIT + 1)
          .toArray();
        phraseScanTruncated = phraseRows.length > PHRASE_SCAN_ROW_LIMIT;
        if (phraseScanTruncated) {
          console.error(`⚠️  Phrase scan truncated at ${PHRASE_SCAN_ROW_LIMIT} rows: more rows match, so the exact-phrase pin set was drawn from a truncated scan.`);
        }
        phraseMatches = phraseRows.slice(0, PHRASE_SCAN_ROW_LIMIT).map(row => toMatch(row, intent, { phraseRow: true }));
      }
    }
    
    // Output results as JSON lines (for CLI usage only)
    // IMPORTANT: Do not output to stdout when imported as a module - it pollutes MCP JSON-RPC
    if (!isSilent() && isMainModule()) {
      for (const match of matches) {
        console.log(JSON.stringify(match));
      }
    }
    
    return { ok: true, matches, phraseMatches, phraseScanTruncated, phraseScanSkipped };
    
  } catch (error) {
    console.error('❌ Error during query:', error.message);
    if (error.message.includes('does not exist') || error.message.includes('No such file')) {
      console.error('💡 Hint: Run `npm run rag:init` and `npm run rag:embed` first');
    }
    return { ok: false, error: error.message, matches: [] };
  }
}

// Export for MCP server
export async function query({ db, q, k = DEFAULT_LIMIT, projectSlug = DEFAULT_PROJECT_SLUG, fidelity = FIDELITY_LEVELS.L2_REDACTED, overrides = {}, intent = 'neutral' }) {
  const inferredSlug = projectSlug || (db ? db.toString().split("/").pop()?.replace(/\.lancedb$/, "") : DEFAULT_PROJECT_SLUG);
  // Run semantic embedding search first. Over-fetch 3·k raw CHUNK rows: several chunks of one note
  // can fill the top k rows, and fusion below is per NOTE (backlog.fix.rag-fusion-ranks-note-by-worst-chunk).
  // queryEmbeddings itself and the CLI keep their own limit.
  const phrase = qualifiesForPhraseScan(q) ? String(q).trim() : null;
  const semRes = await queryEmbeddings(q, 3 * k, db, inferredSlug, intent, { phrase });
  if (!semRes || !semRes.ok) {
    // propagate error or empty result shape
    return semRes;
  }
  // Collapse chunk rows to ONE entry per note identity, keeping the note's best chunk — the row with
  // the highest semantic score (ties keep the earlier row). Fusion ranks the note on that chunk, and
  // its metadata/text is what gets re-attached below.
  const bestById = new Map();
  for (const m of semRes.matches || []) {
    const id = m.slug || m.path || `${m.slug}:${m.chunkId ?? 0}`;
    const prev = bestById.get(id);
    if (prev === undefined || (m.score || 0) > (prev.score || 0)) bestById.set(id, m);
  }
  // Convert the per-note best matches into the semanticResults shape expected by hybridSearch
  const semanticList = [...bestById.values()].map(m => {
    return { id: m.slug || m.path || `${m.slug}:${m.chunkId ?? 0}`, score: m.score || 0 };
  });

  // Keyword leg: a BM25 index built PER QUERY over the semantic candidate rows only, keyed with the
  // same id expression as semanticList above so both legs fuse on one identity. Scoped to the
  // candidates on purpose: metadata is re-attached below only from semRes.matches, so a
  // keyword-only id from outside the window would carry no slug, path or text.
  // Chunks of one note share an id, and addDocument on an existing id REPLACES its text
  // (bm25-index.mjs updateDocument), so group by id and add each id once with the joined text.
  const textById = new Map();
  const windowChunksById = new Map();
  for (const m of semRes.matches || []) {
    const id = m.slug || m.path || `${m.slug}:${m.chunkId ?? 0}`;
    const prev = textById.get(id);
    textById.set(id, prev === undefined ? String(m.text || '') : `${prev}\n${m.text || ''}`);
    if (!windowChunksById.has(id)) windowChunksById.set(id, new Set());
    windowChunksById.get(id).add(m.chunkId ?? 0);
  }
  // Exact-phrase hits (any note, in or out of the semantic window). Each hit's phrase chunks that are
  // not already in-window are appended to its BM25 document ONCE per chunk, so a pinned note always
  // has the phrase in its indexed text. phraseById keeps the lowest-chunkId phrase row per note for
  // metadata re-attach of out-of-window hits.
  const phraseById = new Map();
  const appendedChunksById = new Map();
  for (const p of semRes.phraseMatches || []) {
    const id = p.slug || p.path || `${p.slug}:${p.chunkId ?? 0}`;
    const chunkKey = p.chunkId ?? 0;
    const prevPhrase = phraseById.get(id);
    if (prevPhrase === undefined || (chunkKey < (prevPhrase.chunkId ?? 0))) phraseById.set(id, p);
    if (windowChunksById.get(id)?.has(chunkKey)) continue;
    if (!appendedChunksById.has(id)) appendedChunksById.set(id, new Set());
    const appended = appendedChunksById.get(id);
    if (appended.has(chunkKey)) continue;
    appended.add(chunkKey);
    const prev = textById.get(id);
    textById.set(id, prev === undefined ? String(p.text || '') : `${prev}\n${p.text || ''}`);
  }
  const bm25Index = createIndex();
  for (const [id, text] of textById) bm25Index.addDocument(id, text);
  const pinnedIds = [...phraseById.keys()];
  const hybridRes = await hybridSearch({ query: q, semanticResults: semanticList, bm25Index, k, pinnedIds });

  // Transform hybridSearch results back to matches format expected by consumers
  // hybridSearch returns { results: [...] } but rag.js expects { matches: [...] }
  const isImplQuery = isImplementationQuery(q);
  const matches = (hybridRes.results || []).map((r, idx) => {
    // The note's BEST chunk (not the first chunk row found) supplies the metadata and text.
    const original = bestById.get(r.id) || phraseById.get(r.id) || {};
    const nsBoost = getNamespaceBoost(original.slug, isImplQuery);
    // Canonical-source boost: rank source under the canonical package roots (mcp-rks, rag, cli)
    // higher for implementation-shaped retrieval. Unconditional multiplier (1.0 for non-canonical).
    const canonicalBoost = getCanonicalPathBoost(original.path);
    return {
      ...original,
      score: r.score * nsBoost * canonicalBoost,
      hybridRank: idx + 1,
      semanticScore: r.semantic?.score ?? null,
      keywordScore: r.keyword?.score
    };
  });

  // Apply fidelity filtering based on source_class. `overrides` lifts the per-class ceiling for an
  // owned corpus (project/public → L3); getEffectiveFidelity still Math.min's against the requested
  // fidelity, so a lower role-token/explicit request is never elevated.
  const filteredMatches = filterByFidelity(matches, fidelity, { overrides });

  return {
    ok: true,
    matches: filteredMatches,
    ...hybridRes,
    phraseScanTruncated: semRes.phraseScanTruncated ?? null,
    phraseScanSkipped: semRes.phraseScanSkipped ?? null,
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  
  // Remove '--' if present (from npm script)
  const cleanArgs = args.filter(arg => arg !== '--');
  
  if (cleanArgs.length === 0) {
    console.error('Usage: npm run rag:query -- "your query here" [limit]');
    console.error('   or: node packages/rag/src/query.mjs "your query here" [limit]');
    process.exit(1);
  }
  
  const query = cleanArgs[0];
  const limit = cleanArgs[1] ? parseInt(cleanArgs[1], 10) : DEFAULT_LIMIT;
  
  if (isNaN(limit) || limit <= 0) {
    console.error('❌ Limit must be a positive number');
    process.exit(1);
  }
  
  return { query, limit };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { query, limit } = parseArgs();
  queryEmbeddings(query, limit);
}

function isSilent() {
  return process.env.ROUTEKIT_SILENCE_RAG_LOGS === "1";
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}
