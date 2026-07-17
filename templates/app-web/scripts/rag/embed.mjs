#!/usr/bin/env node

import { connect } from '@lancedb/lancedb';
import { pipeline } from '@xenova/transformers';
import { globby } from 'globby';
import { readFileSync, statSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import matter from 'gray-matter';
import { remark } from 'remark';
import stripMarkdown from 'strip-markdown';
import { createHash } from 'crypto';
import { getDefaultRagConfig } from './utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper function for TTY-aware logging
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
const CHUNK_SIZE = 900;
const OVERLAP_SIZE = 100;
const VAULT_PATH = DEFAULT_CONFIG.vault;
const NOTE_PATTERN = DEFAULT_CONFIG.glob;

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

function getShouldEmbed(relativePath, frontmatter) {
  // Explicit frontmatter control takes precedence
  if (frontmatter.rag === true) return true;
  if (frontmatter.rag === false || frontmatter.private === true) return false;
  
  // Smart defaults based on file patterns
  if (relativePath.startsWith('ux287-com.design.')) return true;
  if (relativePath.startsWith('ux287-com.docs.')) return true;
  if (relativePath.startsWith('ux287-com.notes.')) return false;
  if (relativePath.startsWith('ux287-com.daily.')) return false;
  if (relativePath.startsWith('ux287-com.prototype.')) return false;
  
  // Default to false for unknown patterns (safer)
  return false;
}

async function extractTextFromMarkdown(content) {
  const processor = remark().use(stripMarkdown);
  const result = await processor.process(content);
  return result.toString().trim();
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
          text: currentChunk.trim(),
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
                text: currentChunk.trim(),
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
      text: currentChunk.trim(),
      chunkId: chunkIndex++
    });
  }
  
  return chunks;
}

function generateStableId(filePath, chunkId) {
  const content = `${filePath}:${chunkId}`;
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

async function processNote(filePath) {
  try {
    log(`📄 Processing: ${relative(VAULT_PATH, filePath)}`);
    
    const content = readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content: markdownContent } = matter(content);
    
    // Extract metadata first
    const stats = statSync(filePath);
    const relativePath = relative(VAULT_PATH, filePath);
    
    // Smart defaults based on file patterns
    const shouldEmbed = getShouldEmbed(relativePath, frontmatter);
    
    if (!shouldEmbed) {
      log(`⏭️  Skipping excluded note (rag: false or pattern default)`);
      return [];
    }
    const slug = relativePath.replace(/\.md$/, '').replace(/\//g, '.');
    const title = frontmatter.title || slug.split('.').pop();
    const tags = frontmatter.tags || [];
    
    // Convert markdown to plain text
    const plainText = await extractTextFromMarkdown(markdownContent);
    
    if (!plainText.trim()) {
      log(`⚠️  Empty content, skipping`);
      return [];
    }
    
    // Chunk the text
    const chunks = chunkText(plainText);
    log(`✂️  Created ${chunks.length} chunks`);
    
    // Create embeddings for each chunk
    const pipeline = await getEmbeddingPipeline();
    const embeddings = [];
    
    for (const chunk of chunks) {
      const embedding = await pipeline(chunk.text, {
        pooling: 'mean',
        normalize: true,
      });
      
      const embeddingVector = Array.from(embedding.data);
      
      embeddings.push({
        id: generateStableId(relativePath, chunk.chunkId),
        slug,
        title,
        path: relativePath,
        vault: 'ux287.com',
        tags: Array.isArray(tags) ? tags : [],
        updatedAt: new Date(stats.mtime).toISOString(),
        chunkId: chunk.chunkId,
        text: chunk.text,
        vector: embeddingVector
      });
    }
    
    return embeddings;
    
  } catch (error) {
    logError(`❌ Error processing ${filePath}:`, error.message);
    return [];
  }
}

async function embedNotes(vaultPath = VAULT_PATH, notePattern = NOTE_PATTERN, dbPath = DB_PATH) {
  try {
    log('🚀 Starting RAG embedding process...');
    log(`📁 Vault path: ${vaultPath}`);
    log(`🎯 Pattern: ${notePattern}`);
    
    // Ensure database directory exists
    const dbDir = dirname(DB_PATH);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      log(`📁 Created directory: ${dbDir}`);
    }
    
    // Find matching notes
    const noteFiles = await globby([`${NOTE_PATTERN}.md`], {
      cwd: VAULT_PATH,
      absolute: true
    });
    
    log(`📚 Found ${noteFiles.length} matching notes`);
    
    if (noteFiles.length === 0) {
      log('⚠️  No notes found matching pattern');
      return;
    }
    
    // Process all notes
    let allEmbeddings = [];
    for (const noteFile of noteFiles) {
      const embeddings = await processNote(noteFile);
      allEmbeddings = allEmbeddings.concat(embeddings);
    }
    
    if (allEmbeddings.length === 0) {
      log('⚠️  No embeddings generated');
      return;
    }
    
    log(`🔢 Generated ${allEmbeddings.length} total embeddings`);
    
    // Connect to database
    const db = await connect(DB_PATH);
    log('🔗 Connected to LanceDB');
    
    // Check if table exists
    const tableNames = await db.tableNames();
    let table;
    
    if (tableNames.includes('embeddings')) {
      table = await db.openTable('embeddings');
      log('📊 Opened existing embeddings table');
      
      // Get existing IDs for deduplication
      log('🔍 Checking for existing embeddings...');
      const existingIds = new Set();
      
      try {
        const results = await table.search([]).select(['id']).limit(10000).toArray();
        results.forEach(row => existingIds.add(row.id));
        log(`📈 Found ${existingIds.size} existing embeddings`);
      } catch (error) {
        log('📊 Table appears to be empty or in different format');
      }
      
      // Filter out existing embeddings
      const newEmbeddings = allEmbeddings.filter(emb => !existingIds.has(emb.id));
      log(`➕ ${newEmbeddings.length} new embeddings to add`);
      
      if (newEmbeddings.length > 0) {
        await table.add(newEmbeddings);
        log('✅ Added new embeddings to existing table');
      }
    } else {
      log('🔧 Creating new embeddings table...');
      // Ensure at least one record has proper tag structure for schema inference
      if (allEmbeddings.length > 0 && (!allEmbeddings[0].tags || allEmbeddings[0].tags.length === 0)) {
        allEmbeddings[0].tags = ['design-system']; // Add default tag for schema inference
      }
      table = await db.createTable('embeddings', allEmbeddings);
      log('✅ Created new table with embeddings');
    }
    
    // Verify final count
    const finalCount = await table.countRows();
    log(`📊 Total embeddings in database: ${finalCount}`);
    log('✅ Embedding process completed successfully');
    return { ok: true, indexed: finalCount, vault: vaultPath, glob: notePattern, db: dbPath };
    
  } catch (error) {
    logError('❌ Error during embedding:', error.message);
    logError(error.stack);
    return { ok: false, error: error.message, vault: vaultPath, glob: notePattern, db: dbPath };
  }
}

// Export for MCP server
export async function embed({ vault, glob, db }) {
  return await embedNotes(vault, glob, db);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  embedNotes();
}