#!/usr/bin/env node

import { dirname, join, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detects the current project context and returns appropriate paths for RAG system
 * @param {string} [customProjectRoot] - Optional custom project root path
 * @returns {Object} Project configuration for RAG
 */
export function getProjectContext(customProjectRoot = null) {
  // An explicitly supplied root is AUTHORITATIVE: resolve it and stop. Do not walk up to an
  // ancestor package.json, and never substitute process.cwd(). Discovery — the walk-up plus
  // the cwd fallback — applies ONLY to the zero-argument call. Mirrors the resolver contract
  // in packages/rag/src/utils.mjs; this copy's homedir ragDbPath and ${projectSlug}.* glob
  // are deliberately divergent and stay as they are.
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
        if (process.stdin.isTTY) {
          console.warn('⚠️  No package.json found, using current directory as project root');
        }
        projectRoot = process.cwd();
      }
    }

    // Derive project slug from directory name
    const projectSlug = basename(projectRoot);
    
    // Check if there's a notes directory in the project
    const notesDir = join(projectRoot, 'notes');
    const hasNotesDir = existsSync(notesDir);
    
    if (!hasNotesDir) {
      if (process.stdin.isTTY) {
        console.warn(`⚠️  No notes directory found at ${notesDir}`);
      }
    }
    
    // Generate paths
    const ragDbName = `${projectSlug}.lancedb`;
    const ragDbPath = join(homedir(), 'Documents', 'projects', '.routekit', 'rag', ragDbName);
    const vaultPath = hasNotesDir ? notesDir : join(projectRoot, 'notes');
    const noteGlob = `${projectSlug}.*`;
    
    const context = {
      projectRoot,
      projectSlug,
      ragDbPath,
      vaultPath,
      noteGlob,
      hasNotesDir
    };
    
    if (process.stdin.isTTY) {
      console.log('🎯 Detected project context:', {
        projectSlug: context.projectSlug,
        vaultPath: context.vaultPath,
        noteGlob: context.noteGlob,
        ragDbPath: context.ragDbPath
      });
    }
    
    return context;
    
  } catch (error) {
    if (process.stdin.isTTY) {
      console.error('❌ Error detecting project context:', error.message);
    }
    
    // Fallback to safe defaults — honour an explicit root here too, so the catch does not
    // silently retarget cwd when the caller named a project.
    const projectSlug = 'unknown-project';
    const fallbackRoot = explicitRoot || process.cwd();
    return {
      projectRoot: fallbackRoot,
      projectSlug,
      ragDbPath: join(homedir(), 'Documents', 'projects', '.routekit', 'rag', `${projectSlug}.lancedb`),
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
    projectSlug: context.projectSlug,  // ADD THIS LINE
    k: 5
  };
}