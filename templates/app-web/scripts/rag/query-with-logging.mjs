#!/usr/bin/env node

/**
 * RAG Query with Learning System Integration
 * 
 * Enhanced version of query.mjs that automatically logs interactions
 * for the guardrailed retriever stack learning system.
 */

import { connect } from '@lancedb/lancedb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { startQuerySession, logToolCall, endQuerySession } from './query-logger.mjs';
import { getSharedEmbeddingPipeline } from './embedding-pipeline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database path
const DB_PATH = join(homedir(), 'Documents', 'projects', '.routekit', 'rag', 'ux287.lancedb');

// Configuration
const DEFAULT_LIMIT = 5;

// Delegates to the template-local shared singleton (stub-mode aware; one load per process).
// The first delegated load is still recorded as a tool call for the learning-system telemetry.
let modelLoadLogged = false;

async function getEmbeddingPipeline() {
  if (modelLoadLogged) {
    return getSharedEmbeddingPipeline();
  }
  const startTime = Date.now();
  const extractor = await getSharedEmbeddingPipeline();
  const duration = Date.now() - startTime;
  modelLoadLogged = true;
  await logToolCall('embedding_model_load', { model: 'Xenova/all-MiniLM-L6-v2' }, duration, true);
  return extractor;
}

async function queryEmbeddings(query, limit = DEFAULT_LIMIT, dbPath = DB_PATH) {
  const overallStartTime = Date.now();
  
  // Start logging session
  startQuerySession(query);
  
  try {
    console.error(`🔍 Processing query: ${query}`);
    console.error(`📊 Returning top ${limit} results`);
    
    // Generate embedding for query
    console.error('🎯 Generated query embedding');
    const embeddingStartTime = Date.now();
    const extractor = await getEmbeddingPipeline();
    const queryEmbedding = await extractor(query, { pooling: 'mean', normalize: true });
    const embeddingDuration = Date.now() - embeddingStartTime;
    
    await logToolCall('generate_embedding', { 
      query: query.slice(0, 100), 
      model: 'Xenova/all-MiniLM-L6-v2' 
    }, embeddingDuration, true);
    
    // Connect to database
    console.error('🔗 Connected to LanceDB');
    const dbStartTime = Date.now();
    const db = await connect(dbPath);
    const table = await db.openTable('embeddings');
    const dbDuration = Date.now() - dbStartTime;
    
    await logToolCall('lancedb_connect', { 
      dbPath: dbPath.split('/').pop(),
      table: 'embeddings'
    }, dbDuration, true);
    
    // Search for similar embeddings
    console.error(`📈 Searching ${await table.countRows()} embeddings`);
    const searchStartTime = Date.now();
    const results = await table
      .search(Array.from(queryEmbedding.data))
      .limit(limit)
      .toArray();
    const searchDuration = Date.now() - searchStartTime;
    
    await logToolCall('vector_search', { 
      query: query.slice(0, 100),
      limit,
      resultCount: results.length 
    }, searchDuration, true);
    
    console.error(`✅ Found ${results.length} results`);
    
    // Prepare results for return
    const matches = results.map(result => ({
      score: result._distance ? (1 - result._distance) : result.score || 0,
      slug: result.slug,
      title: result.title,
      path: result.path,
      chunkId: result.chunkId,
      tags: result.tags || [],
      updatedAt: result.updatedAt,
      text: result.text
    }));
    
    // Output results as JSON lines (for CLI usage)
    for (const match of matches) {
      console.log(JSON.stringify(match));
    }
    
    // End logging session with quality assessment
    const contextQuality = assessContextQuality(matches, query);
    const routingReason = classifyQuery(query);
    
    await endQuerySession({
      routingReason,
      contextQuality
    });
    
    return { ok: true, matches };
    
  } catch (error) {
    console.error('❌ Error during query:', error.message);
    if (error.message.includes('does not exist') || error.message.includes('No such file')) {
      console.error('💡 Hint: Run `npm run rag:init` and `npm run rag:embed` first');
    }
    
    // Log failed query
    await logToolCall('rag_query_error', { 
      error: error.message,
      query: query.slice(0, 100)
    }, Date.now() - overallStartTime, false);
    
    await endQuerySession({
      routingReason: 'error_recovery',
      contextQuality: 'low'
    });
    
    return { ok: false, error: error.message, matches: [] };
  }
}

/**
 * Assess the quality of retrieved context
 */
function assessContextQuality(matches, query) {
  if (matches.length === 0) return 'low';
  
  const avgScore = matches.reduce((sum, match) => sum + match.score, 0) / matches.length;
  const hasRelevantTags = matches.some(match => {
    const tags = match.tags || [];
    return Array.isArray(tags) && tags.some(tag => 
      query.toLowerCase().includes(tag.toLowerCase())
    );
  });
  
  if (avgScore > 0.7 && hasRelevantTags) return 'high';
  if (avgScore > 0.4 || hasRelevantTags) return 'medium';
  return 'low';
}

/**
 * Classify query type for routing analysis
 */
function classifyQuery(query) {
  const lower = query.toLowerCase();
  
  if (lower.includes('how do') || lower.includes('how to')) return 'how_to_query';
  if (lower.includes('what is') || lower.includes('what are')) return 'definition_query';
  if (lower.includes('configure') || lower.includes('setup') || lower.includes('mcp')) return 'technical_config_query';
  if (lower.includes('error') || lower.includes('failed') || lower.includes('broken')) return 'troubleshooting_query';
  if (lower.includes('blog') || lower.includes('publish') || lower.includes('frontmatter')) return 'content_management_query';
  if (lower.includes('service') || lower.includes('pricing') || lower.includes('package')) return 'business_info_query';
  if (lower.includes('implement') || lower.includes('create') || lower.includes('build')) return 'implementation_query';
  
  return 'general_query';
}

// Export for MCP server
export async function query({ db, q, k = DEFAULT_LIMIT }) {
  return await queryEmbeddings(q, k, db);
}

function parseArgs() {
  const args = process.argv.slice(2);
  
  // Remove '--' if present (from npm script)
  const cleanArgs = args.filter(arg => arg !== '--');
  
  if (cleanArgs.length === 0) {
    console.error('Usage: npm run rag:query -- "your query here" [limit]');
    console.error('   or: node scripts/rag/query-with-logging.mjs "your query here" [limit]');
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