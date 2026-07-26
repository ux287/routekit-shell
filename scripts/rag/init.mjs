#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getProjectContext } from './utils.mjs';
import { getRagConfig, getRagPaths } from '../../packages/cli/src/rag/config.mjs';

const projectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? resolve(process.env.ROUTEKIT_PROJECT_ROOT) : process.cwd();
const context = getProjectContext(projectRoot);
const { configPath } = getRagConfig(projectRoot);
const ragPaths = getRagPaths(projectRoot);
const DB_PATH = ragPaths.notes;

async function initializeDatabase(dbPath = DB_PATH) {
  try {
    console.log('🚀 Initializing RAG database...');
    console.log(`📍 Database path: ${dbPath}`);
    console.log(`🎯 Project: ${context.projectSlug}`);
    console.log(`🗂 Config: ${configPath}`);

    // Clear embed manifest so next embed does a full re-index, not incremental.
    // The manifest is a cache tied to the DB contents — if we're re-initing, it must be cleared.
    const manifestPath = join(dirname(dbPath), 'embed-manifest.json');
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
      console.log('🧹 Cleared embed manifest (full re-index will occur on next embed)');
    }
    
    // Ensure directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      console.log(`📁 Created directory: ${dbDir}`);
    }
    
    // Connect to database
    const db = await connect(dbPath);
    console.log('✅ Connected to LanceDB');
    
    // Check if table exists
    const tableNames = await db.tableNames();
    const hasEmbeddingsTable = tableNames.includes('embeddings');
    
    if (hasEmbeddingsTable) {
      console.log('📊 Found existing embeddings table');
      const table = await db.openTable('embeddings');
      const count = await table.countRows();
      console.log(`📈 Current embeddings count: ${count}`);
    } else {
      console.log('🔧 Creating embeddings table...');
      // Create table with schema - will be created when first embeddings are added
      console.log('📝 Table will be created during first embedding operation');
    }
    
    console.log('✅ RAG database initialized successfully');
    return { ok: true, db: dbPath };
    
  } catch (error) {
    console.error('❌ Error initializing database:', error.message);
    return { ok: false, error: error.message, db: dbPath };
  }
}

// Export for MCP server
export async function init({ db }) {
  return await initializeDatabase(db);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initializeDatabase();
}
