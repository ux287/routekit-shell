#!/usr/bin/env node

import { dirname, join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detects the current project context and returns appropriate paths for RAG system
 * @param {string} [customProjectRoot] - Optional custom project root path
 * @returns {Object} Project configuration for RAG
 */
export function getProjectContext(customProjectRoot = null) {
  // An explicitly supplied root is AUTHORITATIVE: resolve it and stop. Do not walk up
  // to an ancestor package.json, and never substitute process.cwd(). Discovery — the
  // walk-up plus the cwd fallback — applies ONLY to the zero-argument call.
  //
  // Before this guard, `projectRoot = process.cwd()` below ran unconditionally when no
  // package.json was found, so an embed scoped to project B read project A's content
  // and overwrote A's embed-manifest.json. See
  // notes/backlog.fix.rag-embed-honours-explicit-project-root.md
  const explicitRoot = typeof customProjectRoot === 'string' && customProjectRoot
    ? resolve(customProjectRoot)
    : null;

  try {
    let projectRoot = explicitRoot || process.cwd();

    if (!explicitRoot) {
      // Zero-argument discovery: walk up to find package.json to determine project root
      let currentDir = projectRoot;
      let packageJsonPath = null;

      while (currentDir !== dirname(currentDir)) {
        const potentialPackageJson = join(currentDir, 'package.json');
        if (existsSync(potentialPackageJson)) {
          packageJsonPath = potentialPackageJson;
          projectRoot = currentDir;
          break;
        }
        currentDir = dirname(currentDir);
      }

      // If no package.json found, fall back to current directory
      if (!packageJsonPath) {
        console.warn('⚠️  No package.json found, using current directory as project root');
        projectRoot = process.cwd();
      }
    }

    // Derive project slug from directory name
    const projectSlug = basename(projectRoot);
    
    // Check if there's a notes directory in the project
    const notesDir = join(projectRoot, 'notes');
    const hasNotesDir = existsSync(notesDir);
    
    if (!hasNotesDir) {
      console.warn(`⚠️  No notes directory found at ${notesDir}`);
    }
    
    // Generate paths - use project-local RAG database for isolation
    const ragDbName = `${projectSlug}.lancedb`;
    const ragDbPath = join(projectRoot, '.rks', 'rag', ragDbName);
    const vaultPath = hasNotesDir ? notesDir : join(projectRoot, 'notes');
    
    // Use simplified namespace for all projects — no project-slug prefix needed.
    // Standard RKS note prefixes (backlog, how-to, etc.) are universal.
    const noteGlob = '{backlog,design,docs,how-to,stack,root,notes,prototype}*';
    
    const context = {
      projectRoot,
      projectSlug,
      ragDbPath,
      vaultPath,
      noteGlob,
      hasNotesDir
    };
    
    // Intentionally silent during library usage to avoid polluting stdout.
    
    return context;
    
  } catch (error) {
    console.error('❌ Error detecting project context:', error.message);
    
    // Fallback to safe defaults - still use project-local path
    const projectSlug = 'unknown-project';
    // Honour an explicit root here too — the catch must not silently retarget cwd.
    const fallbackRoot = explicitRoot || process.cwd();
    return {
      projectRoot: fallbackRoot,
      projectSlug,
      ragDbPath: join(fallbackRoot, '.rks', 'rag', `${projectSlug}.lancedb`),
      vaultPath: join(fallbackRoot, 'notes'),
      noteGlob: `${projectSlug}.*`,
      hasNotesDir: false
    };
  }
}

/**
 * Gets default RAG configuration for the current project
 * @returns {Object} Default configuration
 */
export function getDefaultRagConfig() {
  const context = getProjectContext();
  
  return {
    db: context.ragDbPath,
    vault: context.vaultPath,
    glob: context.noteGlob,
    projectSlug: context.projectSlug,
    k: 5
  };
}
