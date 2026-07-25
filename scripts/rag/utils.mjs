#!/usr/bin/env node

import { dirname, join, basename } from 'path';
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
  try {
    // Start from current script location and find project root
    let projectRoot = customProjectRoot || process.cwd();
    
    // Walk up to find package.json to determine project root
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
    const fallbackRoot = process.cwd();
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
