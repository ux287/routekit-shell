#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { getProjectContext } from './utils.mjs';
import { getRagConfigFor, getRagPathsFor } from './rag-config-loader.mjs';

async function initializeDatabase(dbPath, { projectSlug, configPath } = {}) {
  try {
    console.log('🚀 Initializing RAG database...');
    console.log(`📍 Database path: ${dbPath}`);
    if (projectSlug) console.log(`🎯 Project: ${projectSlug}`);
    if (configPath) console.log(`🗂 Config: ${configPath}`);

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
  // CLI entrypoint: resolve project paths/config via the dynamic loader (no static @routekit/cli
  // import at module scope — cycle-freedom). The programmatic init({db}) export is fed the db directly.
  // Pass explicitProjectRoot (undefined when the env var is absent) to the resolver so it
  // runs zero-argument discovery. projectRoot stays absolute for getRagConfigFor/getRagPathsFor.
  const explicitProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? resolve(process.env.ROUTEKIT_PROJECT_ROOT) : undefined;
  const projectRoot = explicitProjectRoot ?? process.cwd();
  const context = getProjectContext(explicitProjectRoot);
  const { configPath } = await getRagConfigFor(projectRoot);
  const ragPaths = await getRagPathsFor(projectRoot);
  await initializeDatabase(ragPaths.notes, { projectSlug: context.projectSlug, configPath });
}
