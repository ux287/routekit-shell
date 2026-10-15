#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { getDefaultRagConfig } from './utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get dynamic database path from project context
const DEFAULT_CONFIG = getDefaultRagConfig();
const DB_PATH = DEFAULT_CONFIG.db;

async function initializeDatabase(dbPath = DB_PATH) {
  try {
    if (process.stdin.isTTY) {
      console.log('🚀 Initializing RAG database...');
      console.log(`📍 Database path: ${dbPath}`);
    }
    
    // Ensure directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      if (process.stdin.isTTY) {
        console.log(`📁 Created directory: ${dbDir}`);
      }
    }
    
    // Connect to database
    const db = await connect(dbPath);
    if (process.stdin.isTTY) {
      console.log('✅ Connected to LanceDB');
    }
    
    // Check if table exists
    const tableNames = await db.tableNames();
    const hasEmbeddingsTable = tableNames.includes('embeddings');
    
    if (hasEmbeddingsTable) {
      if (process.stdin.isTTY) {
        console.log('📊 Found existing embeddings table');
      }
      const table = await db.openTable('embeddings');
      const count = await table.countRows();
      if (process.stdin.isTTY) {
        console.log(`📈 Current embeddings count: ${count}`);
      }
    } else {
      if (process.stdin.isTTY) {
        console.log('🔧 Creating embeddings table...');
        // Create table with schema - will be created when first embeddings are added
        console.log('📝 Table will be created during first embedding operation');
      }
    }
    
    if (process.stdin.isTTY) {
      console.log('✅ RAG database initialized successfully');
    }
    return { ok: true, db: dbPath };
    
  } catch (error) {
    if (process.stdin.isTTY) {
      console.error('❌ Error initializing database:', error.message);
    }
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