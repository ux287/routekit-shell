#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { pipeline } from '@xenova/transformers';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { getDefaultRagConfig } from './utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper functions for TTY-aware logging
function log(message) {
  if (process.stdin.isTTY) {
    console.log(message);
  }
}

function logError(message, ...args) {
  if (process.stdin.isTTY) {
    console.error(message, ...args);
  }
}

// Get dynamic database path from project context
const DEFAULT_CONFIG = getDefaultRagConfig();
const DB_PATH = DEFAULT_CONFIG.db;

// Configuration
const DEFAULT_LIMIT = 5;

// Initialize embedding pipeline (lazy loaded)
let embeddingPipeline = null;

async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    log('🤖 Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    log('✅ Embedding model loaded');
  }
  return embeddingPipeline;
}

async function queryEmbeddings(query, limit = DEFAULT_LIMIT, dbPath = DB_PATH) {
  try {
    logError('🔍 Processing query:', query);
    logError(`📊 Returning top ${limit} results`);
    
    // Generate query embedding
    const pipeline = await getEmbeddingPipeline();
    const queryEmbedding = await pipeline(query, {
      pooling: 'mean',
      normalize: true,
    });
    
    const queryVector = Array.from(queryEmbedding.data);
    logError('🎯 Generated query embedding');
    
    // Connect to database
    const db = await connect(dbPath);
    logError('🔗 Connected to LanceDB');
    
    // Open embeddings table
    const table = await db.openTable('embeddings');
    const totalCount = await table.countRows();
    logError(`📈 Searching ${totalCount} embeddings`);
    
    // Perform similarity search
    const results = await table
      .search(queryVector)
      .select(['id', 'slug', 'title', 'path', 'text', 'chunkId', 'tags', 'updatedAt'])
      .limit(limit)
      .toArray();
    
    logError(`✅ Found ${results.length} results`);
    
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
      log(JSON.stringify(match));
    }
    
    return { ok: true, matches };
    
  } catch (error) {
    logError('❌ Error during query:', error.message);
    if (error.message.includes('does not exist') || error.message.includes('No such file')) {
      logError('💡 Hint: Run `npm run rag:init` and `npm run rag:embed` first');
    }
    return { ok: false, error: error.message, matches: [] };
  }
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
    logError('Usage: npm run rag:query -- "your query here" [limit]');
    logError('   or: node scripts/rag/query.mjs "your query here" [limit]');
    process.exit(1);
  }
  
  const query = cleanArgs[0];
  const limit = cleanArgs[1] ? parseInt(cleanArgs[1], 10) : DEFAULT_LIMIT;
  
  if (isNaN(limit) || limit <= 0) {
    logError('❌ Limit must be a positive number');
    process.exit(1);
  }
  
  return { query, limit };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { query, limit } = parseArgs();
  queryEmbeddings(query, limit);
}