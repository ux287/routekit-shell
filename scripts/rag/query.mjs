#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { resolve } from 'path';
import { getProjectContext } from './utils.mjs';
import { getRagPaths } from '../../packages/cli/src/rag/config.mjs';
import { hybridSearch } from '../../packages/mcp-rks/src/rag/hybrid-search.mjs';
import { filterByFidelity, FIDELITY_LEVELS } from '../../packages/mcp-rks/src/rag/fidelity-filter.mjs';
import { CONTENT_TYPE_BOOST, inferQueryIntent, isImplementationQuery, getNamespaceBoost } from '../../packages/mcp-rks/src/rag/query-intent.mjs';
import { missingRequiredColumns, selectableProjection, tableFieldNames } from '../../packages/mcp-rks/src/rag/rag-columns.mjs';
// Shared embedding pipeline (singleton across all modules — one ONNX load per process; stub-mode aware).
import { getSharedEmbeddingPipeline } from '../../packages/mcp-rks/src/rag/embedding-pipeline.mjs';

const projectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? resolve(process.env.ROUTEKIT_PROJECT_ROOT) : process.cwd();
const context = getProjectContext(projectRoot);
const ragPaths = getRagPaths(projectRoot);
const DB_PATH = ragPaths.notes;
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

async function queryEmbeddings(query, limit = DEFAULT_LIMIT, dbPath = DB_PATH, projectSlug = DEFAULT_PROJECT_SLUG, intent = 'neutral') {
  try {
    console.error('🔍 Processing query:', query);
    console.error(`🎯 Project: ${projectSlug}`);
    console.error(`📊 Returning top ${limit} results`);
    
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
    const matches = results.map(result => {
      const baseScore = result._distance ? (1 - result._distance) : result.score || 0;
      const status = result.status || 'unknown';
      const statusBoost = STATUS_BOOST[status] || STATUS_BOOST.unknown;
      const contentType = result.content_type || 'note';
      const intentBoosts = CONTENT_TYPE_BOOST[intent] || CONTENT_TYPE_BOOST.neutral;
      const contentTypeBoost = intentBoosts[contentType] ?? 1.0;
      const boostedScore = baseScore * statusBoost * contentTypeBoost;

      return {
        score: boostedScore,
        baseScore,
        status,
        content_type: contentType,
        slug: result.slug,
        title: result.title,
        path: result.path,
        chunkId: result.chunkId,
        tags: result.tags || [],
        updatedAt: result.updatedAt,
        text: result.text
      };
    });
    
    // Output results as JSON lines (for CLI usage only)
    // IMPORTANT: Do not output to stdout when imported as a module - it pollutes MCP JSON-RPC
    if (!isSilent() && isMainModule()) {
      for (const match of matches) {
        console.log(JSON.stringify(match));
      }
    }
    
    return { ok: true, matches };
    
  } catch (error) {
    console.error('❌ Error during query:', error.message);
    if (error.message.includes('does not exist') || error.message.includes('No such file')) {
      console.error('💡 Hint: Run `npm run rag:init` and `npm run rag:embed` first');
    }
    return { ok: false, error: error.message, matches: [] };
  }
}

// Export for MCP server
export async function query({ db, q, k = DEFAULT_LIMIT, projectSlug = DEFAULT_PROJECT_SLUG, fidelity = FIDELITY_LEVELS.L2_REDACTED, intent = 'neutral' }) {
  const inferredSlug = projectSlug || (db ? db.toString().split("/").pop()?.replace(/\.lancedb$/, "") : DEFAULT_PROJECT_SLUG);
  // Run semantic embedding search first
  const semRes = await queryEmbeddings(q, k, db, inferredSlug, intent);
  if (!semRes || !semRes.ok) {
    // propagate error or empty result shape
    return semRes;
  }
  // Convert embedding matches into the semanticResults shape expected by hybridSearch
  const semanticList = (semRes.matches || []).map(m => {
    return { id: m.slug || m.path || `${m.slug}:${m.chunkId ?? 0}`, score: m.score || 0 };
  });

  // Call hybridSearch to fuse semantic and keyword (bm25) results. Leave bm25Index undefined so hybridSearch may create a temp index if necessary.
  const hybridRes = await hybridSearch({ query: q, semanticResults: semanticList, k });

  // Transform hybridSearch results back to matches format expected by consumers
  // hybridSearch returns { results: [...] } but rag.js expects { matches: [...] }
  const isImplQuery = isImplementationQuery(q);
  const matches = (hybridRes.results || []).map((r, idx) => {
    // Find original semantic match to preserve full metadata
    const original = semRes.matches.find(m =>
      (m.slug || m.path || `${m.slug}:${m.chunkId ?? 0}`) === r.id
    ) || {};
    const nsBoost = getNamespaceBoost(original.slug, isImplQuery);
    return {
      ...original,
      score: r.score * nsBoost,
      hybridRank: idx + 1,
      semanticScore: r.semantic?.score,
      keywordScore: r.keyword?.score
    };
  });

  // Apply fidelity filtering based on source_class
  const filteredMatches = filterByFidelity(matches, fidelity);

  return { ok: true, matches: filteredMatches, ...hybridRes };
}

function parseArgs() {
  const args = process.argv.slice(2);
  
  // Remove '--' if present (from npm script)
  const cleanArgs = args.filter(arg => arg !== '--');
  
  if (cleanArgs.length === 0) {
    console.error('Usage: npm run rag:query -- "your query here" [limit]');
    console.error('   or: node scripts/rag/query.mjs "your query here" [limit]');
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
