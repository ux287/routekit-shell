#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { globby } from 'globby';
import { readFileSync, readdirSync, rmSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, relative, resolve, join } from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import stripMarkdown from 'strip-markdown';
import { createHash } from 'crypto';
import { getProjectContext } from './utils.mjs';
import { chunkNoteText } from '@routekit/rag/notes-chunker';
import { classifySource, classifyContentType } from '@routekit/rag/source-classifier';
import {
  RAG_REQUIRED_COLUMNS,
  normalizeRagRows,
  missingRequiredColumns,
  tableFieldNames,
} from '@routekit/rag/rag-columns';
import { getRagPathsFor } from './rag-config-loader.mjs';

// Manifest for content-hash based change detection
function getManifestPath(projectRoot) {
  return join(projectRoot, '.rks', 'rag', 'embed-manifest.json');
}

function loadManifest(projectRoot) {
  const manifestPath = getManifestPath(projectRoot);
  if (existsSync(manifestPath)) {
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      return { hashes: {} };
    }
  }
  return { hashes: {} };
}

function saveManifest(projectRoot, manifest) {
  const manifestPath = getManifestPath(projectRoot);
  ensureDir(dirname(manifestPath));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Remove the incremental-embed manifest so the NEXT embed reprocesses the full corpus. Used when we
 * discard an index whose schema violates the read contract: the rebuild must see every file, not
 * just the changed subset. Best-effort.
 */
export function clearManifest(projectRoot) {
  try {
    const manifestPath = getManifestPath(projectRoot);
    if (existsSync(manifestPath)) rmSync(manifestPath, { force: true });
  } catch { /* best-effort */ }
}

/**
 * Exercise the READERS' projection against the freshly-written table. countRows() only proves rows
 * exist — it never proves the columns every reader selects are actually present, which is how an
 * unqueryable index used to pass as ok:true. Returns { ok, missing, error }.
 */
export async function verifyReadContract(table) {
  const fields = await tableFieldNames(table);
  const missing = missingRequiredColumns(fields);
  if (missing.length > 0) return { ok: false, missing, error: `missing required column(s): ${missing.join(', ')}` };
  try {
    await table.query().select([...RAG_REQUIRED_COLUMNS]).limit(1).toArray();
    return { ok: true, missing: [] };
  } catch (e) {
    return { ok: false, missing: [], error: e?.message || String(e) };
  }
}

function computeContentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Configuration
const CHUNK_SIZE = 900;
const OVERLAP_SIZE = 100;
const EMBEDDINGS_MODE = process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE || process.env.RKS_RAG_EMBEDDINGS_MODE || "model";
// ROUTEKIT_PROJECT_ROOT resolved when set, otherwise undefined — so getProjectContext
// runs its zero-argument discovery rather than being handed cwd as if it were an
// explicit root. `projectRoot` MUST stay an absolute string: :319 and :856 consume it.
const explicitProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? resolve(process.env.ROUTEKIT_PROJECT_ROOT) : undefined;
const projectRoot = explicitProjectRoot ?? process.cwd();
const projectContext = getProjectContext(explicitProjectRoot);
const {
  vaultPath: DEFAULT_VAULT_PATH,
  noteGlob: DEFAULT_NOTE_PATTERN,
  projectSlug: DEFAULT_PROJECT_SLUG
} = projectContext;
// Blacklist pattern: embed everything, exclude known noise/binary.
// This ensures all source code (Python, Go, Rust, etc.) is indexed
// regardless of language. Add exclusions to CODE_IGNORE as needed.
const DEFAULT_CODE_GLOBS = [
  "**/*",
];
const CODE_IGNORE = [
  // Dependency and tooling directories
  "**/node_modules/**",
  "**/.git/**",
  "**/.rks/**",
  "**/.routekit/**",
  "**/.claude/settings*.json",
  "**/.claude/plans/**",
  "**/.codex/**",
  "**/.vscode/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/venv/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  // Vendored toolchains
  "**/tools/**",
  // Static asset output
  "**/public/**",
  // Images
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.webp",
  "**/*.bmp",
  "**/*.tiff",
  // Fonts
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
  // Media
  "**/*.mp3",
  "**/*.mp4",
  "**/*.wav",
  "**/*.avi",
  "**/*.mov",
  // Archives
  "**/*.zip",
  "**/*.tar.gz",
  "**/*.tgz",
  "**/*.gz",
  "**/*.bz2",
  "**/*.rar",
  // Compiled/binary
  "**/*.pyc",
  "**/*.class",
  "**/*.o",
  "**/*.so",
  "**/*.dylib",
  "**/*.exe",
  "**/*.dll",
  "**/*.wasm",
  // Databases
  "**/*.sqlite",
  "**/*.db",
  "**/*.lancedb/**",
  // Lock files and infrastructure
  "**/package.json",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/dendron.yml",
  "**/kg.yaml",
  // Archived notes — excluded from RAG to prevent stale content poisoning results
  "**/z_archive*",
  "**/tsconfig.json",
  "**/vite.config.*",
  "**/vitest.config.*",
];
export const RAG_CODE_IGNORE_DEFAULTS = CODE_IGNORE;

// Import shared embedding pipeline (singleton across all modules)
import { getSharedEmbeddingPipeline } from '@routekit/rag/embedding-pipeline';

function parseCodeGlobs(value, fallback) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.includes(",") && !trimmed.includes("{")) {
    return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [trimmed];
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function getEmbeddingPipeline() {
  return getSharedEmbeddingPipeline();
}

function getShouldEmbed(relativePath, frontmatter, projectSlug = DEFAULT_PROJECT_SLUG) {
  // Explicit frontmatter control takes precedence
  if (frontmatter.rag === true) return true;
  if (frontmatter.rag === false || frontmatter.private === true) return false;

  // Universal simplified namespace — no project-slug prefix needed.
  // All projects use the same note prefixes (backlog, how-to, etc.)
  if (relativePath.startsWith('design.')) return true;
  if (relativePath.startsWith('docs.')) return true;
  if (relativePath.startsWith('how-to.')) return true;
  if (relativePath.startsWith('notes.')) return false; // Usually private/scratch
  if (relativePath.startsWith('daily.')) return false;
  if (relativePath.startsWith('scratch.')) return false; // Temporary working docs
  if (relativePath.startsWith('prototype.')) return false; // Usually experimental

  // Default to embedding (covers backlog.*, stack.*, root.*, etc.)
  return true;
}

async function extractTextFromMarkdown(content) {
  const processor = remark().use(stripMarkdown);
  const result = await processor.process(content);
  return result.toString().trim();
}

function extractTextFromCode(content) {
  return content || "";
}

function chunkText(text, maxSize = CHUNK_SIZE, overlapSize = OVERLAP_SIZE) {
  const chunks = [];
  const paragraphs = text.split('\n\n').filter(p => p.trim());
  
  let currentChunk = '';
  let chunkIndex = 0;
  
  for (const paragraph of paragraphs) {
    const potentialChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
    
    if (potentialChunk.length <= maxSize) {
      currentChunk = potentialChunk;
    } else {
      // Save current chunk if it exists
      if (currentChunk) {
        chunks.push({
          text: currentChunk.trimEnd(),  // Preserve leading whitespace for code indentation
          chunkId: chunkIndex++
        });
      }
      
      // Handle oversized paragraphs by splitting on sentences
      if (paragraph.length > maxSize) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        currentChunk = '';
        
        for (const sentence of sentences) {
          const potentialSentenceChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
          
          if (potentialSentenceChunk.length <= maxSize) {
            currentChunk = potentialSentenceChunk;
          } else {
            if (currentChunk) {
              chunks.push({
                text: currentChunk.trimEnd(),  // Preserve leading whitespace for code indentation
                chunkId: chunkIndex++
              });
            }
            currentChunk = sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    }
  }
  
  // Add the final chunk
  if (currentChunk) {
    chunks.push({
      text: currentChunk.trimEnd(),  // Preserve leading whitespace for code indentation
      chunkId: chunkIndex++
    });
  }
  
  return chunks;
}

function generateStableId(filePath, chunkId) {
  const content = `${filePath}:${chunkId}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

async function deleteByPaths(table, paths) {
  if (!paths?.length) return { deleted: 0 };
  if (typeof table.delete !== "function") {
    throw new Error("LanceDB table.delete is not available");
  }
  // Delete all chunks where path matches any of the specified files
  const predicates = paths.map(p => `path = '${p.replace(/'/g, "''")}'`);
  const predicate = predicates.join(" OR ");
  await table.delete(predicate);
  return { deleted: paths.length };
}

async function upsertEmbeddings(table, embeddings) {
  const ids = Array.from(new Set(embeddings.map((e) => e.id).filter(Boolean)));
  if (!ids.length) return { deleted: 0 };
  if (typeof table.delete !== "function") {
    throw new Error("LanceDB table.delete is not available; cannot upsert safely.");
  }
  const chunkSize = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const predicate = `id IN (${chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`;
    await table.delete(predicate);
    deleted += chunk.length;
  }
  return { deleted };
}

function createStatsLogPath(rootDir, projectSlug, startedAt) {
  const safeStamp = (startedAt || new Date())
    .toISOString()
    .replace(/[:.]/g, '-');
  const dir = resolve(rootDir || projectRoot, '.rks', 'rag', 'embeds', `${safeStamp}_${projectSlug}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'stats.json');
}

/**
 * Prune old embed run directories, keeping only the most recent `keep` entries.
 * Directories are named with ISO timestamps so lexicographic sort = chronological.
 */
function pruneEmbedRunDirs(embedsRoot, keep = 10) {
  try {
    if (!existsSync(embedsRoot)) return;
    const dirs = readdirSync(embedsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort(); // Lexicographic = chronological for ISO timestamps
    if (dirs.length <= keep) return;
    const toRemove = dirs.slice(0, dirs.length - keep);
    for (const dir of toRemove) {
      rmSync(join(embedsRoot, dir), { recursive: true });
    }
    console.log(`🧹 Pruned ${toRemove.length} old embed run dirs (kept ${keep})`);
  } catch (e) {
    console.warn(`⚠️  Failed to prune embed run dirs: ${e.message}`);
  }
}

/**
 * Build embedding rows for one note file — testable extraction.
 *
 * Returns the row objects that processNote would push into allEmbeddings,
 * without actually calling the embedding model. Tests inject an `embedderFn`
 * stub that returns a deterministic vector (or `null` / a fixed array) so
 * row-shape assertions don't depend on @xenova/transformers.
 *
 * Same code path runs in production via processNote(), which supplies the
 * real Xenova pipeline as embedderFn. THE CONTENT_TYPE COMPUTATION HAPPENS
 * HERE — exactly one assignment per row, sourced from classifyContentType.
 *
 * backlog.fix.rag-embed-classifier-output-not-reaching-lancedb (AC1, AC2, AC6, testReq #1)
 */
export async function buildEmbeddingRows(filePath, { vaultPath, projectSlug, content: contentOverride, embedderFn } = {}) {
  const content = typeof contentOverride === 'string' ? contentOverride : readFileSync(filePath, 'utf-8');
  const { data: frontmatter } = matter(content);
  const stats = statSync(filePath);
  const relativePath = relative(vaultPath, filePath);
  const shouldEmbed = getShouldEmbed(relativePath, frontmatter, projectSlug);
  if (!shouldEmbed) {
    return { rows: [], skipped: true, reason: 'excluded' };
  }
  const slug = relativePath.replace(/\.md$/, '').replace(/\//g, '.');
  const title = frontmatter.title || slug.split('.').pop();
  const tags = frontmatter.tags || [];
  const chunks = chunkNoteText(content, relativePath);
  if (!chunks.length) {
    return { rows: [], skipped: true, reason: 'empty' };
  }
  const rows = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const status = frontmatter.status || 'unknown';
    const source_class = classifySource({
      path: relativePath,
      frontmatter,
      content: chunk.content,
      domain: 'notes',
    });
    // backlog.fix.rag-embed-classifier-output-not-reaching-lancedb AC6: every
    // content_type assignment is sourced from classifyContentType(...) and is
    // the FINAL value in this row push (no subsequent spread/mutation).
    const content_type = classifyContentType(relativePath, chunk.note_type);
    let vector;
    if (typeof embedderFn === 'function') {
      vector = await embedderFn(chunk.content);
    } else {
      vector = null; // tests that don't supply an embedder skip the vector field
    }
    rows.push({
      id: chunk.id,
      slug: chunk.dendron_id || slug,
      title: chunk.heading_path?.length ? chunk.heading_path[chunk.heading_path.length - 1] : title,
      path: relativePath,
      vault: projectSlug,
      tags: chunk.tags?.length ? chunk.tags : (Array.isArray(tags) ? tags : []),
      status,
      updatedAt: new Date(stats.mtime).toISOString(),
      chunkId: i,
      text: chunk.content,
      vector,
      dendron_id: chunk.dendron_id,
      heading_path: chunk.heading_path || [],
      note_type: chunk.note_type,
      token_count: chunk.token_count,
      source_class,
      content_type,
    });
  }
  return { rows, skipped: false };
}

async function processNote(filePath, { vaultPath, projectSlug }) {
  try {
    console.log(`📄 Processing: ${relative(vaultPath, filePath)}`);
    const pipeline = await getEmbeddingPipeline();
    const embedderFn = async (text) => {
      const embedding = await pipeline(text, { pooling: 'mean', normalize: true });
      return Array.from(embedding.data);
    };
    const result = await buildEmbeddingRows(filePath, { vaultPath, projectSlug, embedderFn });
    if (result.skipped) {
      if (result.reason === 'excluded') console.log(`⏭️  Skipping excluded note (rag: false or pattern default)`);
      else if (result.reason === 'empty') console.log(`⚠️  Empty content, skipping`);
      return [];
    }
    console.log(`✂️  Created ${result.rows.length} structure-aware chunks`);
    return result.rows;
  } catch (error) {
    console.error(`❌ Error processing ${filePath}:`, error.message);
    return [];
  }
}

async function processCodeFile(filePath, { projectRoot, projectSlug }) {
  try {
    const relPath = relative(projectRoot, filePath);
    console.log(`💻 Processing code: ${relPath}`);
    const stats = statSync(filePath);
    const plainText = extractTextFromCode(readFileSync(filePath, "utf-8"));
    if (!plainText.trim()) {
      console.log("⚠️  Empty code file, skipping");
      return [];
    }
    const chunks = chunkText(plainText);
    const pipeline = await getEmbeddingPipeline();
    const embeddings = [];
    for (const chunk of chunks) {
      const embedding = await pipeline(chunk.text, {
        pooling: 'mean',
        normalize: true,
      });

      // Classify source for provenance control
      const source_class = classifySource({
        path: relPath,
        frontmatter: {},
        content: chunk.text,
        domain: 'code'
      });

      const content_type = classifyContentType(relPath, null);

      embeddings.push({
        id: generateStableId(relPath, chunk.chunkId),
        slug: relPath.replace(/\.[^/.]+$/, "").replace(/\//g, "."),
        title: relPath.split("/").pop(),
        path: relPath,
        vault: projectSlug,
        tags: ["code"],
        updatedAt: new Date(stats.mtime).toISOString(),
        chunkId: chunk.chunkId,
        text: chunk.text,
        vector: Array.from(embedding.data),
        source_class,
        content_type
      });
    }
    return embeddings;
  } catch (error) {
    console.error(`❌ Error processing code ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Resolve the code-file set for a run, bounded by the changed set when one is supplied.
 *
 * Exported as a test seam: embedNotes is deliberately not exported, and driving this
 * through embed() would require a real LanceDB connect plus the ONNX pipeline for every
 * assertion. Consumed by tests only — not dead code.
 *
 * @param {object}        args
 * @param {string}        args.projectRoot
 * @param {string[]}      args.codeGlobs
 * @param {string[]}      args.ignore
 * @param {string[]|null} args.incrementalFiles absolute paths, or null for a full walk
 * @returns {Promise<string[]>} absolute paths
 */
export async function resolveCodeFileSet({ projectRoot, codeGlobs, ignore, incrementalFiles = null }) {
  const bounded = Array.isArray(incrementalFiles) && incrementalFiles.length > 0;
  if (!bounded) {
    return await globby(codeGlobs, { cwd: projectRoot, absolute: true, ignore });
  }

  // Passing the changed paths AS the patterns bounds the enumeration to them. globby only
  // returns paths that exist, so a file deleted since the commit simply drops out — no throw.
  const candidates = incrementalFiles
    .map((abs) => relative(projectRoot, abs))
    .filter((rel) => rel && !rel.startsWith(".."));
  if (candidates.length === 0) return [];

  const scoped = await globby(candidates, { cwd: projectRoot, absolute: true, ignore });

  // A catch-all codeGlobs admits every non-ignored path, so `scoped` is already a strict
  // subset of the full walk. A CUSTOM glob is narrower, so the subset guarantee has to be
  // verified against it — which costs a full walk, but only when someone has configured
  // RKS_CODE_GLOB / ROUTEKIT_CODE_GLOB. The default path never pays it.
  const isCatchAll = Array.isArray(codeGlobs) && codeGlobs.length === 1 && codeGlobs[0] === "**/*";
  if (isCatchAll) return scoped;

  const allowed = new Set(await globby(codeGlobs, { cwd: projectRoot, absolute: true, ignore }));
  return scoped.filter((p) => allowed.has(p));
}

/**
 * Decide what the manifest should contain after a run, and which paths are genuinely stale.
 *
 * The hazard this closes: `newHashes` only ever holds files the run VISITED. When the run
 * is bounded, every unvisited file falls out of it — and the old
 * `Object.keys(manifest.hashes).filter(p => !newHashes[p])` classified all of them as stale
 * and sent them to deleteByPaths. Bounding the walk without this is index destruction, not
 * an optimisation.
 *
 * Exported as a test seam alongside resolveCodeFileSet.
 *
 * @param {object}          args
 * @param {object}          args.priorHashes  manifest.hashes as loaded
 * @param {object}          args.newHashes    hashes for files this run visited
 * @param {Set<string>|null} args.visitedScope project-root-relative paths the run was asked
 *                                             about; null for a full walk
 * @returns {{ hashes: object, stale: string[] }}
 */
export function computeManifestUpdate({ priorHashes = {}, newHashes = {}, visitedScope = null }) {
  if (!visitedScope) {
    // Full walk: newHashes is authoritative. Anything in the prior manifest the walk did not
    // re-hash is genuinely gone from disk.
    return {
      hashes: { ...newHashes },
      stale: Object.keys(priorHashes).filter((p) => !newHashes[p]),
    };
  }

  // Bounded run: only paths inside the requested scope were examined. A prior entry outside
  // it was never looked at, so it must be carried forward — never deleted. A path that WAS
  // requested but produced no hash is one that vanished from disk, and is correctly stale.
  const scope = visitedScope instanceof Set ? visitedScope : new Set(visitedScope);
  const stale = Object.keys(priorHashes).filter((p) => scope.has(p) && !newHashes[p]);
  const hashes = { ...priorHashes, ...newHashes };
  for (const p of stale) delete hashes[p];
  return { hashes, stale };
}

async function embedNotes(
  vaultPath,
  notePattern = DEFAULT_NOTE_PATTERN,
  dbPath,
  targetRoot,
  options = {}
) {
  try {
    // Resolve the target context FIRST — vaultPath and dbPath both derive from it, so
    // neither may fall back to a value captured at module import time.
    //
    // The third arm MUST be explicitProjectRoot, never bare `undefined`: two in-repo
    // callers invoke this with no arguments at all — the CLI main guard at the bottom of
    // this file (reached in production via packages/mcp-rks/src/dendron.mjs) and
    // packages/hooks/system/rag-embed-on-commit.mjs. Bare `undefined` would silently drop
    // ROUTEKIT_PROJECT_ROOT and revert both to cwd-discovery, reopening the cross-project
    // leak this change closes.
    const currentContext = getProjectContext(
      targetRoot || (vaultPath ? dirname(vaultPath) : explicitProjectRoot)
    );
    if (!vaultPath) {
      vaultPath = currentContext.vaultPath;
    }
    // Resolve the default DB path lazily via the dynamic config loader when the caller didn't pass
    // one — keeps this module free of any static @routekit/cli import (cycle-freedom).
    if (!dbPath) {
      dbPath = (await getRagPathsFor(currentContext.projectRoot)).notes;
    }
    const runStartedAt = new Date();
    console.log('🚀 Starting RAG embedding process...');
    console.log(`🎯 Project: ${currentContext.projectSlug}`);
    console.log(`📁 Vault path: ${vaultPath}`);
    console.log(`🎯 Pattern: ${notePattern}`);
    const scopeMode = (options.mode || "append").toLowerCase();
    const reset = Boolean(options.reset);
    console.log(`🧭 Mode: ${scopeMode}${reset ? " (reset)" : ""}`);
    
    // Ensure database directory exists
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      console.log(`📁 Created directory: ${dbDir}`);
    }
    
    const basePattern = notePattern && notePattern.trim() ? notePattern.trim() : "**/*";
    const globWithExt = basePattern.endsWith(".md") ? basePattern : `${basePattern}.md`;
    const archiveIgnorePatterns = [
      "z_archive*",
      "z_archive.*",
      "z_archive/**",
      "drafts*",
      "drafts.*",
      "drafts/**",
    ];
    // INCREMENTAL MODE: bound the enumeration to the changed set BEFORE globbing, instead of
    // walking the whole corpus and discarding.
    //
    // Candidates arrive PROJECT-ROOT-relative — commit-and-embed.mjs passes `git diff
    // --name-only` output — so they resolve against currentContext.projectRoot, not against
    // vaultPath. The old post-glob filter resolved them against vaultPath, which is why it
    // matched nothing: CI run 31462012004 logged "Incremental mode: filtered 1840 → 0 notes".
    // Every note was then absent from newHashes and classified stale, so a commit-triggered
    // embed was deleting the entire note index. See computeManifestUpdate.
    const incrementalPaths = Array.isArray(options.incrementalFiles) && options.incrementalFiles.length > 0
      ? options.incrementalFiles.map((f) => resolve(currentContext.projectRoot, f))
      : null;

    let noteFiles;
    if (incrementalPaths) {
      const noteCandidates = incrementalPaths
        .map((abs) => relative(vaultPath, abs))
        .filter((rel) => rel && !rel.startsWith(".."));
      noteFiles = noteCandidates.length > 0
        ? await globby(noteCandidates, { cwd: vaultPath, absolute: true, ignore: archiveIgnorePatterns })
        : [];
      console.log(`📎 Incremental mode: ${noteFiles.length} of ${incrementalPaths.length} changed path(s) are notes`);
    } else {
      noteFiles = await globby([globWithExt], {
        cwd: vaultPath,
        absolute: true,
        ignore: archiveIgnorePatterns,
      });
      if (noteFiles.length === 0 && basePattern !== "**/*") {
        console.log(`📚 No notes matched pattern '${globWithExt}', falling back to all notes`);
        noteFiles = await globby(["**/*.md"], {
          cwd: vaultPath,
          absolute: true,
          ignore: archiveIgnorePatterns,
        });
      }
      console.log(`📚 Found ${noteFiles.length} matching notes`);
    }

    // Collect code files
    const rawCodeGlobs = options.codeGlob || process.env.RKS_CODE_GLOB || process.env.ROUTEKIT_CODE_GLOB || null;
    const codeGlobs = parseCodeGlobs(rawCodeGlobs, DEFAULT_CODE_GLOBS);
    const codeFiles = await resolveCodeFileSet({
      projectRoot: currentContext.projectRoot,
      codeGlobs,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: incrementalPaths,
    });
    console.log(`💻 Found ${codeFiles.length} code files for embedding`);
    
    // Process all notes and code
    let allEmbeddings = [];
    let processedCount = 0;
    let embeddedNotes = 0;
    let skippedNotes = 0;
    let chunkTotal = 0;
    let embeddedCodeFiles = 0;
    let skippedCodeFiles = 0;
    const manifest = loadManifest(currentContext.projectRoot);
    const newHashes = {};
    let skippedUnchanged = 0;

    for (const noteFile of noteFiles) {
      processedCount++;
      const content = readFileSync(noteFile, 'utf-8');
      const contentHash = computeContentHash(content);
      const relPath = relative(currentContext.projectRoot, noteFile);
      
      if (manifest.hashes[relPath] === contentHash) {
        console.log(`⏭️  Skipping unchanged: ${relPath}`);
        skippedUnchanged++;
        newHashes[relPath] = contentHash;
        continue;
      }
      newHashes[relPath] = contentHash;
      
      const embeddings = await processNote(noteFile, { vaultPath, projectSlug: currentContext.projectSlug });
      if (embeddings.length) {
        embeddedNotes++;
        chunkTotal += embeddings.length;
      } else {
        skippedNotes++;
      }
      allEmbeddings = allEmbeddings.concat(embeddings);
    }
    for (const codeFile of codeFiles) {
      const content = readFileSync(codeFile, 'utf-8');
      const contentHash = computeContentHash(content);
      const relPath = relative(currentContext.projectRoot, codeFile);

      if (manifest.hashes[relPath] === contentHash) {
        console.log(`⏭️  Skipping unchanged code: ${relPath}`);
        skippedUnchanged++;
        newHashes[relPath] = contentHash;
        continue;
      }
      newHashes[relPath] = contentHash;

      const embeddings = await processCodeFile(codeFile, { projectRoot: currentContext.projectRoot, projectSlug: currentContext.projectSlug });
      if (embeddings.length) {
        embeddedCodeFiles++;
        chunkTotal += embeddings.length;
      } else {
        skippedCodeFiles++;
      }
      allEmbeddings = allEmbeddings.concat(embeddings);
    }
    
    // Decide the manifest contents and the genuinely-stale set ONCE, before any of the three
    // save paths. A bounded run only examined the paths it was given, so "absent from
    // newHashes" does NOT mean "deleted from disk" — it usually means "out of scope this
    // run". Scoping this is what keeps a one-file commit from wiping the rest of the index.
    const visitedScope = incrementalPaths
      ? new Set(incrementalPaths.map((abs) => relative(currentContext.projectRoot, abs)))
      : null;
    const manifestUpdate = computeManifestUpdate({
      priorHashes: manifest.hashes,
      newHashes,
      visitedScope,
    });

    const shouldRebuild = reset || scopeMode === "prune";
    if (allEmbeddings.length === 0 && !shouldRebuild) {
      console.log('✅ All files unchanged — nothing to embed');
      saveManifest(currentContext.projectRoot, { hashes: manifestUpdate.hashes });
      let existingCount = 0;
      try {
        const existingDb = await connect(dbPath);
        const existingTable = await existingDb.openTable('embeddings');
        existingCount = await existingTable.countRows();
      } catch { /* DB may not exist yet */ }
      return {
        ok: true,
        skipped: true,
        reason: "no-changes",
        indexed: existingCount,
        processedNotes: processedCount,
        processedCodeFiles: codeFiles.length,
        skippedUnchanged,
        vault: vaultPath,
        glob: notePattern,
        db: dbPath,
      };
    }
    
    console.log(`🔢 Generated ${allEmbeddings.length} total embeddings`);

    // Schema contract: code rows (processCodeFile) omit `status` while note rows carry it. LanceDB
    // infers the Arrow schema from these records, so a code row landing first produced a table with
    // no `status` column and every reader's .select([...'status'...]) threw. Backfill the full
    // required set on EVERY row so inference can't drop a required column.
    allEmbeddings = normalizeRagRows(allEmbeddings);

    // Connect to database
    const db = await connect(dbPath);
    console.log('🔗 Connected to LanceDB');
    
    // Check if table exists
    const tableNames = await db.tableNames();
    let table;
    
    let chunksAdded = 0;
    if (tableNames.includes("embeddings") && shouldRebuild) {
      console.log("🧹 Dropping embeddings table (reset/prune)...");
      await db.dropTable("embeddings");
    }

    const refreshedTableNames = await db.tableNames();
    if (!refreshedTableNames.includes("embeddings")) {
      if (allEmbeddings.length === 0) {
        console.log("✅ Table pruned — no embeddings to write");
        saveManifest(currentContext.projectRoot, { hashes: manifestUpdate.hashes });
        return {
          ok: true,
          indexed: 0,
          mode: scopeMode,
          reset,
          processedNotes: processedCount,
          processedCodeFiles: codeFiles.length,
          skippedUnchanged,
          vault: vaultPath,
          glob: notePattern,
          db: dbPath,
        };
      }
      console.log("🔧 Creating new embeddings table...");
      // Row/array normalization (required columns + non-empty seed arrays for Arrow inference) is
      // already applied by normalizeRagRows() above.
      table = await db.createTable("embeddings", allEmbeddings);
      console.log("✅ Created new table with embeddings");
      chunksAdded = allEmbeddings.length;
    } else {
      table = await db.openTable("embeddings");
      console.log("📊 Opened existing embeddings table");

      // Schema mismatch detection. Two independent triggers:
      //  - ADD direction: the record carries a field name the table lacks (original behavior).
      //  - CONTRACT direction: the table is MISSING a column every reader selects. This is the
      //    case the ADD-only detector could never see — a code row introduces no new field NAMES,
      //    so a table created without `status` was never rebuilt and the break survived re-embeds.
      const existingFields = await tableFieldNames(table);
      const existingFieldSet = new Set(existingFields);
      const newFields = Object.keys(allEmbeddings[0] || {}).filter(k => !existingFieldSet.has(k));
      const missingRequired = missingRequiredColumns(existingFields);

      if (missingRequired.length > 0 && skippedUnchanged > 0) {
        // The index is unqueryable AND we only hold the changed subset. Recreating from it would
        // silently drop every unchanged row — trading one silent failure for another. Discard the
        // broken index + manifest and fail loud; the next embed reprocesses the full corpus.
        console.error(`❌ Broken index schema (missing: ${missingRequired.join(', ')}) and only a partial corpus in hand.`);
        try { await db.dropTable("embeddings"); } catch { /* best-effort */ }
        clearManifest(currentContext.projectRoot);
        return {
          ok: false,
          error: `RAG index schema is unusable (missing required column(s): ${missingRequired.join(', ')}). The broken index and its manifest have been discarded — re-run embed to rebuild the full index.`,
          reason: "rag_index_schema_broken",
          missingColumns: missingRequired,
          rebuildRequired: true,
          vault: vaultPath,
          glob: notePattern,
          db: dbPath,
        };
      }

      if (newFields.length > 0 || missingRequired.length > 0) {
        if (newFields.length > 0) console.log(`⚠️  Schema mismatch detected. New fields: ${newFields.join(', ')}`);
        if (missingRequired.length > 0) console.log(`⚠️  Read-contract violation. Missing required column(s): ${missingRequired.join(', ')}`);
        console.log("🧹 Dropping and recreating table to accommodate schema changes...");
        await db.dropTable("embeddings");
        table = await db.createTable("embeddings", allEmbeddings);
        chunksAdded = allEmbeddings.length;
        console.log("✅ Recreated table with new schema");
      } else {
        const { deleted } = await upsertEmbeddings(table, allEmbeddings);
        console.log(`♻️  Upsert: deleted ${deleted} existing rows (by id)`);
        await table.add(allEmbeddings);
        chunksAdded = allEmbeddings.length;
        console.log("✅ Upserted embeddings into existing table");
      }
    }
    
    // Remove embeddings for files that no longer exist. `manifestUpdate` was computed above,
    // before the early-return save paths, so all three agree on what is stale.
    const staleFiles = manifestUpdate.stale;
    let removedEmbeddings = 0;
    if (staleFiles.length > 0) {
      await deleteByPaths(table, staleFiles);
      removedEmbeddings = staleFiles.length;
      console.log(`🧹 Removed embeddings for ${staleFiles.length} deleted files`);
    }

    // Read-contract gate: countRows() proves rows exist but never proves the columns the readers
    // select are present — that is exactly how an unqueryable index used to return ok:true. Run the
    // readers' own projection before claiming success. On failure, discard the index + manifest so
    // the next embed rebuilds a full, queryable one, and report ok:false. Never a silent success.
    const contract = await verifyReadContract(table);
    if (!contract.ok) {
      console.error(`❌ Read-contract verification failed after write: ${contract.error}`);
      try { await db.dropTable("embeddings"); } catch { /* best-effort */ }
      clearManifest(currentContext.projectRoot);
      return {
        ok: false,
        error: `RAG index failed read-contract verification (${contract.error}). The index and its manifest have been discarded — re-run embed to rebuild.`,
        reason: "rag_index_read_contract_failed",
        missingColumns: contract.missing,
        rebuildRequired: true,
        vault: vaultPath,
        glob: notePattern,
        db: dbPath,
      };
    }
    console.log(`🔎 Read-contract verified (${RAG_REQUIRED_COLUMNS.length} required columns selectable)`);

    // Persist manifest after successful, VERIFIED DB write
    // Merge, never replace: a bounded run must carry forward the hashes of files it did not
    // visit, or the next full walk re-embeds the whole corpus.
    saveManifest(currentContext.projectRoot, { hashes: manifestUpdate.hashes });
    console.log(`📋 Saved embed manifest (${Object.keys(manifestUpdate.hashes).length} files, ${skippedUnchanged} unchanged)`);

    // Verify final count
    const finalCount = await table.countRows();
    console.log(`🧮 Notes processed: ${processedCount} (embedded ${embeddedNotes}, skipped ${skippedNotes})`);
    console.log(`🧮 Code files processed: ${codeFiles.length} (embedded ${embeddedCodeFiles}, skipped ${skippedCodeFiles})`);
    console.log(`📦 Embedding chunks produced: ${chunkTotal}`);
    console.log(`➕ Chunks written to LanceDB: ${chunksAdded}`);
    console.log(`📊 Total embeddings in database: ${finalCount}`);

    console.log('✅ Embedding process completed successfully');
    const runStats = {
      project: currentContext.projectSlug,
      vaultPath,
      glob: notePattern,
      dbPath,
      startedAt: runStartedAt.toISOString(),
      completedAt: new Date().toISOString(),
      processedNotes: processedCount,
      embeddedNotes,
      skippedNotes,
      chunkTotal,
      addedEmbeddings: chunksAdded,
      totalEmbeddings: finalCount,
      excludedPatterns: archiveIgnorePatterns,
    };
    let statsFile = null;
    try {
      statsFile = createStatsLogPath(targetRoot || currentContext.projectRoot, currentContext.projectSlug, runStartedAt);
      writeFileSync(statsFile, JSON.stringify(runStats, null, 2));
      console.log(`📝 Wrote embed stats -> ${statsFile}`);
    } catch (error) {
      console.warn('⚠️  Failed to write embed stats log:', error.message);
    }

    // Prune old embed run directories (keep only latest)
    const embedsRoot = join(targetRoot || currentContext.projectRoot, ".rks", "rag", "embeds");
    pruneEmbedRunDirs(embedsRoot, 1);
    return {
      ok: true,
      indexed: finalCount,
      addedEmbeddings: chunksAdded,
      removedEmbeddings,
      mode: scopeMode,
      reset,
      processedNotes: processedCount,
      embeddedNotes,
      skippedNotes,
      processedCodeFiles: codeFiles.length,
      embeddedCodeFiles,
      skippedCodeFiles,
      vault: vaultPath,
      glob: notePattern,
      db: dbPath,
      statsFile,
    };

  } catch (error) {
    console.error('❌ Error during embedding:', error.message);
    console.error(error.stack);
    return { ok: false, error: error.message, vault: vaultPath, glob: notePattern, db: dbPath };
  }
}

// Export for MCP server
export async function embed({ vault, glob, db, projectRoot, files } = {}) {
  const noteGlob = typeof glob === "string" ? glob : undefined;
  const incrementalFiles = Array.isArray(files) ? files : null;
  const resolvedVault = typeof vault === "string" ? vault : undefined;
  const resolvedDb = typeof db === "string" ? db : undefined;
  const resolvedProjectRoot = typeof projectRoot === "string" ? projectRoot : undefined;
  const mode = process.env.RKS_RAG_SCOPE_MODE || process.env.ROUTEKIT_RAG_SCOPE_MODE || null;
  const reset = process.env.RKS_RAG_RESET === "1" || process.env.ROUTEKIT_RAG_RESET === "1";
  const codeGlob = process.env.RKS_RAG_CODE_GLOB || process.env.RKS_CODE_GLOB || process.env.ROUTEKIT_CODE_GLOB || null;
  return await embedNotes(resolvedVault, noteGlob, resolvedDb, resolvedProjectRoot, { mode, reset, codeGlob, incrementalFiles });
}

export async function listRagCodeEmbedCandidates({ projectRoot: root, codeGlob } = {}) {
  const base = typeof root === "string" ? resolve(root) : projectRoot;
  const rawCodeGlobs = codeGlob || process.env.RKS_CODE_GLOB || process.env.ROUTEKIT_CODE_GLOB || null;
  const codeGlobs = parseCodeGlobs(rawCodeGlobs, DEFAULT_CODE_GLOBS);
  const codeFiles = await globby(codeGlobs, {
    cwd: base,
    absolute: true,
    ignore: RAG_CODE_IGNORE_DEFAULTS,
  });
  return codeFiles.map((abs) => relative(base, abs)).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cliFiles = process.argv
    .filter(a => a.startsWith('--files='))
    .map(a => a.slice('--files='.length))
    .filter(Boolean);
  // backlog.fix.rag-embed-classifier-output-not-reaching-lancedb: CLI must
  // forward env-var-driven options so RKS_RAG_SCOPE_MODE=prune RKS_RAG_RESET=1
  // actually triggers the rebuild path. Previously these env vars were only
  // read by the embed() wrapper used from the MCP server, leaving CLI
  // invocations stuck in append/no-reset mode.
  const cliMode = process.env.RKS_RAG_SCOPE_MODE || process.env.ROUTEKIT_RAG_SCOPE_MODE || null;
  const cliReset = process.env.RKS_RAG_RESET === '1' || process.env.ROUTEKIT_RAG_RESET === '1';
  const cliCodeGlob = process.env.RKS_RAG_CODE_GLOB || process.env.RKS_CODE_GLOB || process.env.ROUTEKIT_CODE_GLOB || null;
  embedNotes(undefined, undefined, undefined, undefined, {
    incrementalFiles: cliFiles.length > 0 ? cliFiles : null,
    mode: cliMode,
    reset: cliReset,
    codeGlob: cliCodeGlob,
  });
}
