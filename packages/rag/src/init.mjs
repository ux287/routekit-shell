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

    // Plain init never touches the embed manifest (backlog.fix.rag-init-does-not-reset-index-rows,
    // user decision "Never touch it"). The manifest is cleared only by the reset export, after a
    // verified table drop, so a plain init can never leave rows without a manifest.

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

/**
 * Destructive reset (rks_rag_init reset: true). Drops the embeddings table, then clears the embed
 * manifest whenever the table is OBSERVED absent afterwards — including when no table existed, since
 * a stale manifest over an empty table makes the next full embed skip every file. The drop happens
 * before the manifest is cleared; an unverifiable drop returns ok false and keeps the manifest.
 * The manifest path is the one embed.mjs reads when projectRoot is known, else dirname(db).
 */
export async function reset({ db: dbPath, projectRoot } = {}) {
  const manifestPath = projectRoot
    ? join(projectRoot, '.rks', 'rag', 'embed-manifest.json')
    : join(dirname(dbPath), 'embed-manifest.json');
  try {
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const db = await connect(dbPath);

    const hadTable = (await db.tableNames()).includes('embeddings');
    let rowsBeforeReset = 0;
    if (hadTable) {
      rowsBeforeReset = await (await db.openTable('embeddings')).countRows();
      await db.dropTable('embeddings');
    }

    const tableAbsent = !(await db.tableNames()).includes('embeddings');
    const tableDropped = hadTable && tableAbsent;
    if (!tableAbsent) {
      return {
        ok: false,
        error: 'embeddings table still present after dropTable; embed manifest left in place',
        db: dbPath,
        rowsBeforeReset,
        tableDropped,
        manifestPath,
      };
    }

    if (existsSync(manifestPath)) rmSync(manifestPath);
    console.log(`🧹 RAG reset: ${tableDropped ? `dropped embeddings (${rowsBeforeReset} rows)` : 'no embeddings table'}; cleared ${manifestPath}`);
    return { ok: true, db: dbPath, rowsBeforeReset, tableDropped, manifestPath };
  } catch (error) {
    console.error('❌ Error resetting database:', error.message);
    return { ok: false, error: error.message, db: dbPath, manifestPath };
  }
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
