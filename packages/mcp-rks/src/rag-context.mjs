import fs from "fs";
import path from "path";
import { connect } from "@lancedb/lancedb";
import { getSharedEmbeddingPipeline } from "./rag/embedding-pipeline.mjs";
import { getRagPaths } from "../../cli/src/rag/config.mjs";
import { missingRequiredColumns, selectableProjection, tableFieldNames } from "./rag/rag-columns.mjs";

/**
 * Projection for the planner's in-server reader, sourced from the shared RAG column contract
 * (backlog.fix.rag-index-unusable-after-embed). Against a legacy/broken index that is missing a
 * required column, degrade to the selectable subset and warn instead of letting the driver throw a
 * raw "No field named status" — which used to starve the planner of all code context.
 */
async function ragProjection(table) {
  const fields = await tableFieldNames(table);
  const missing = missingRequiredColumns(fields);
  if (missing.length > 0) {
    console.error(
      `[rag-context] RAG index is missing required column(s): ${missing.join(", ")}. ` +
      `Returning partial rows — re-run rks_rag_embed to rebuild a fully queryable index.`
    );
  }
  return selectableProjection(fields);
}

const DEFAULT_LIMIT = 3;
const PER_TYPE_LIMIT = 5;

// Status-based relevance boost multipliers
// Implemented items represent proven patterns and should rank higher
const STATUS_BOOST = {
  implemented: 1.5,
  in_progress: 1.2,
  ready: 1.0,
  pending: 0.9,
  unknown: 0.8,
};

async function getEmbeddingPipeline() {
  return getSharedEmbeddingPipeline();
}

function loadRagConfig(projectRoot) {
  try {
    // Use centralized path resolution for version 2 unified DB support
    const paths = getRagPaths(projectRoot);
    return { paths };
  } catch (error) {
    console.warn(`[rag-context] Failed to get RAG paths: ${error.message}`);
    return null;
  }
}

async function queryDb(dbPath, queryVector, limit = DEFAULT_LIMIT) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    const db = await connect(dbPath);
    const tableNames = await db.tableNames();
    if (!tableNames.includes("embeddings")) return [];
    const table = await db.openTable("embeddings");
    const rows = await table
      .search(queryVector)
      .select(await ragProjection(table))
      .limit(limit)
      .toArray();
    return rows.map((row) => {
      // Calculate base score from distance
      const baseScore = row._distance !== undefined ? 1 - row._distance : row.score || 0;
      // Apply status-based boost (implemented items rank higher)
      const status = row.status || "unknown";
      const boost = STATUS_BOOST[status] || STATUS_BOOST.unknown;
      const boostedScore = baseScore * boost;

      return {
        score: boostedScore,
        baseScore,
        status,
        path: row.path,
        title: row.title,
        text: row.text,
        slug: row.slug,
        chunkId: row.chunkId,
        tags: row.tags || [],
        updatedAt: row.updatedAt,
      };
    });
  } catch (error) {
    console.warn(`[rag-context] Failed querying ${dbPath}: ${error.message}`);
    return [];
  }
}

/**
 * Query database with a tag filter (code vs notes).
 * Uses post-filter to ensure we get results of the desired type.
 */
async function queryDbByType(dbPath, queryVector, type, limit = DEFAULT_LIMIT) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    const db = await connect(dbPath);
    const tableNames = await db.tableNames();
    if (!tableNames.includes("embeddings")) return [];
    const table = await db.openTable("embeddings");

    // Query many more results to find code hits (code often ranks lower than notes)
    // Testing showed first code result can appear at rank 100+ for some queries
    const overFetch = Math.max(limit * 50, 250);
    const rows = await table
      .search(queryVector)
      .select(await ragProjection(table))
      .limit(overFetch)
      .toArray();

    // Filter by type: "code" requires code tag, "notes" excludes code tag
    const filtered = rows.filter((row) => {
      const hasCodeTag = row.tags && row.tags.includes("code");
      return type === "code" ? hasCodeTag : !hasCodeTag;
    });

    return filtered.slice(0, limit).map((row) => {
      const baseScore = row._distance !== undefined ? 1 - row._distance : row.score || 0;
      const status = row.status || "unknown";
      const boost = STATUS_BOOST[status] || STATUS_BOOST.unknown;
      const boostedScore = baseScore * boost;

      return {
        score: boostedScore,
        baseScore,
        status,
        path: row.path,
        title: row.title,
        text: row.text,
        slug: row.slug,
        chunkId: row.chunkId,
        tags: row.tags || [],
        updatedAt: row.updatedAt,
      };
    });
  } catch (error) {
    console.warn(`[rag-context] Failed querying ${dbPath} for ${type}: ${error.message}`);
    return [];
  }
}

/**
 * Direct path-based query - bypasses semantic search entirely.
 * Retrieves ALL chunks for a specific file path using SQL-like filtering.
 * This is more reliable than semantic search for known target files.
 */
async function getChunksByPath(dbPath, targetPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  if (!targetPath) return [];

  try {
    const db = await connect(dbPath);
    const tableNames = await db.tableNames();
    if (!tableNames.includes("embeddings")) return [];

    const table = await db.openTable("embeddings");
    const normalizedPath = targetPath.replace(/^\.\//, "");

    // Use LanceDB's filter API with SQL WHERE clause
    // Escape single quotes in the path for SQL safety
    const escapedPath = normalizedPath.replace(/'/g, "''");

    // Try exact match first using WHERE filter
    let allRows;
    try {
      // LanceDB filter syntax uses SQL-like WHERE clauses
      allRows = await table
        .query()
        .select(await ragProjection(table))
        .where(`path = '${escapedPath}'`)
        .limit(1000)
        .toArray();
    } catch {
      // If exact match fails, fall back to scanning with JS filter
      allRows = [];
    }

    // If exact match returned nothing, try broader JS-based filtering
    if (allRows.length === 0) {
      // Get all rows and filter in JS (works for partial path matches)
      const scanRows = await table
        .query()
        .select(await ragProjection(table))
        .limit(5000)
        .toArray();

      allRows = scanRows.filter(row => {
        if (!row.path) return false;
        const rowPath = row.path.replace(/^\.\//, "");
        return (
          rowPath === normalizedPath ||
          rowPath.endsWith(normalizedPath) ||
          normalizedPath.endsWith(rowPath)
        );
      });
    }

    return allRows.map((row) => ({
      path: row.path,
      title: row.title,
      text: row.text,
      slug: row.slug,
      chunkId: row.chunkId,
      tags: row.tags || [],
      status: row.status || "unknown",
      updatedAt: row.updatedAt,
    }));
  } catch (error) {
    console.warn(`[rag-context] getChunksByPath failed for ${targetPath}: ${error.message}`);
    return [];
  }
}

export async function getRagContext(projectRoot, queryText) {
  const config = loadRagConfig(projectRoot);
  if (!config || !queryText || !queryText.trim()) {
    return { notes: [], code: [], kg: [] };
  }
  try {
    const pipe = await getEmbeddingPipeline();
    const embedding = await pipe(queryText, { pooling: "mean", normalize: true });
    const queryVector = Array.from(embedding.data);
    // Use unified DB path (version 2+) with fallback to legacy paths
    const dbPath = config.paths.unified || config.paths.notes;

    // Query notes and code separately to guarantee results from each type
    // Previously, a single query would return all notes if they scored higher
    const [noteRows, codeRows] = await Promise.all([
      queryDbByType(dbPath, queryVector, "notes", PER_TYPE_LIMIT),
      queryDbByType(dbPath, queryVector, "code", PER_TYPE_LIMIT),
    ]);

    // Deduplicate by path within each type
    const dedupByPath = (rows) => {
      const seen = new Map();
      for (const row of rows) {
        if (row.path && !seen.has(row.path)) {
          seen.set(row.path, row);
        }
      }
      return Array.from(seen.values());
    };

    const notes = dedupByPath(noteRows)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, PER_TYPE_LIMIT);
    const code = dedupByPath(codeRows)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, PER_TYPE_LIMIT);

    return { notes, code, kg: [] };
  } catch (error) {
    console.warn(`[rag-context] Error building context: ${error.message}`);
    return { notes: [], code: [], kg: [] };
  }
}

/**
 * Rank file chunks by keyword relevance to queryText.
 * Returns {text, score}[] sorted by score descending, deduplicated, capped at k.
 * @param {Array} chunks - Raw chunk objects from DB with .text and .chunkId
 * @param {string} queryText - Query text for identifier extraction
 * @param {number} k - Max results
 * @returns {{text: string, score: number}[]}
 */
function _rankSnippets(chunks, queryText, k) {
  const identifierPattern = /\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+)\b/g;
  const queryIdentifiers = new Set();
  if (queryText) {
    for (const match of queryText.matchAll(identifierPattern)) {
      const id = match[1];
      if (id.length > 3 && !/^(this|that|with|from|into|have|been|will|would|could|should)$/i.test(id)) {
        queryIdentifiers.add(id);
      }
    }
  }

  const scored = chunks.map(chunk => {
    let score = 0;
    const text = chunk.text || "";
    for (const id of queryIdentifiers) {
      if (text.includes(id)) {
        if (new RegExp(`(?:function|class|const|let|var)\\s+${id}\\b`).test(text)) {
          score += 10;
        } else {
          score += 1;
        }
      }
    }
    return { ...chunk, _score: score };
  });

  scored.sort((a, b) => b._score !== a._score ? b._score - a._score : (a.chunkId || 0) - (b.chunkId || 0));

  const result = [];
  const seen = new Set();
  for (const row of scored) {
    if (result.length >= k) break;
    const text = row.text?.trimEnd();
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push({ text, score: row._score });
    }
  }
  return result;
}

/**
 * Retrieve verbatim code snippets for a specific target file using RAG.
 * @param {string} projectRoot - Project root path
 * @param {string} targetPath - Relative path to target file
 * @param {string} queryText - Query to find relevant code
 * @param {number} k - Number of snippets to return (default 3)
 * @returns {Promise<string[]>} Array of verbatim code snippet strings
 */
export async function getCodeSnippets(projectRoot, targetPath, queryText, k = 3) {
  const config = loadRagConfig(projectRoot);
  if (!config) return [];

  const normalizedTarget = targetPath?.trim();
  if (!normalizedTarget) return [];

  try {
    const dbPath = config.paths.unified || config.paths.notes;

    // Strategy 1: Direct path query (bypasses semantic search entirely)
    // This is more reliable for known target files
    let fileChunks = await getChunksByPath(dbPath, normalizedTarget);

    // Filter to code-tagged chunks only
    fileChunks = fileChunks.filter(r => r.tags && r.tags.includes("code"));

    // Strategy 2: Fall back to semantic search if direct query returns nothing
    if (fileChunks.length === 0) {
      console.warn(`[rag-context] Direct path query returned 0 chunks for ${targetPath}, falling back to semantic search`);

      const pipe = await getEmbeddingPipeline();
      const results = new Map();

      // Query 1: File path query
      const pathQuery = normalizedTarget;
      const pathEmbedding = await pipe(pathQuery, { pooling: "mean", normalize: true });
      const pathVector = Array.from(pathEmbedding.data);
      const pathRows = await queryDb(dbPath, pathVector, 1000);
      for (const r of pathRows) {
        if (r.tags && r.tags.includes("code") &&
            r.path && (r.path === normalizedTarget || r.path.endsWith(normalizedTarget) || normalizedTarget.endsWith(r.path))) {
          const key = `${r.path}:${r.chunkId}`;
          if (!results.has(key)) results.set(key, r);
        }
      }

      // Query 2: File-specific functions query
      const funcQuery = `function async ${path.basename(normalizedTarget)}`;
      const funcEmbedding = await pipe(funcQuery, { pooling: "mean", normalize: true });
      const funcVector = Array.from(funcEmbedding.data);
      const funcRows = await queryDb(dbPath, funcVector, 1000);
      for (const r of funcRows) {
        if (r.tags && r.tags.includes("code") &&
            r.path && (r.path === normalizedTarget || r.path.endsWith(normalizedTarget) || normalizedTarget.endsWith(r.path))) {
          const key = `${r.path}:${r.chunkId}`;
          if (!results.has(key)) results.set(key, r);
        }
      }

      fileChunks = Array.from(results.values()).filter(r =>
        r.tags && r.tags.includes("code")
      );
    }

    if (fileChunks.length === 0) {
      console.warn(`[rag-context] getCodeSnippets: no code chunks found for ${targetPath}`);
      return [];
    }

    return _rankSnippets(fileChunks, queryText, k).map(s => s.text);
  } catch (error) {
    console.warn(`[rag-context] getCodeSnippets failed: ${error.message}`);
    return [];
  }
}

/**
 * Like getCodeSnippets but returns {text, score}[] so callers can surface relevance scores.
 * score = keyword-match score (0 = no query identifier matches, higher = more relevant).
 * Order matches getCodeSnippets — highest score first.
 * @param {string} projectRoot - Project root path
 * @param {string} targetPath - Relative path to target file
 * @param {string} queryText - Query to find relevant code
 * @param {number} k - Number of snippets to return (default 3)
 * @returns {Promise<{text: string, score: number}[]>}
 */
export async function getCodeSnippetsWithScores(projectRoot, targetPath, queryText, k = 3) {
  const config = loadRagConfig(projectRoot);
  if (!config) return [];
  const normalizedTarget = targetPath?.trim();
  if (!normalizedTarget) return [];

  try {
    const dbPath = config.paths.unified || config.paths.notes;
    let fileChunks = await getChunksByPath(dbPath, normalizedTarget);
    fileChunks = fileChunks.filter(r => r.tags && r.tags.includes("code"));

    if (fileChunks.length === 0) {
      const pipe = await getEmbeddingPipeline();
      const results = new Map();
      const pathEmbedding = await pipe(normalizedTarget, { pooling: "mean", normalize: true });
      const pathRows = await queryDb(dbPath, Array.from(pathEmbedding.data), 1000);
      for (const r of pathRows) {
        if (r.tags?.includes("code") && r.path &&
            (r.path === normalizedTarget || r.path.endsWith(normalizedTarget) || normalizedTarget.endsWith(r.path))) {
          const key = `${r.path}:${r.chunkId}`;
          if (!results.has(key)) results.set(key, r);
        }
      }
      fileChunks = Array.from(results.values());
    }

    if (fileChunks.length === 0) return [];
    return _rankSnippets(fileChunks, queryText, k);
  } catch (error) {
    console.warn(`[rag-context] getCodeSnippetsWithScores failed: ${error.message}`);
    return [];
  }
}
