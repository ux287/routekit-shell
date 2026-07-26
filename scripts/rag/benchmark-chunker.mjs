import { globSync } from 'glob';
import { readFileSync } from 'fs';
import { chunkNoteText } from '../../packages/mcp-rks/src/rag/notes-chunker.mjs';

const SOFT_LIMIT = 1500;
const HARD_LIMIT = 2500;

// Glob all notes/*.md files (exclude z_archive, z_implemented)
const noteFiles = globSync('notes/*.md', { ignore: ['notes/z_archive.*', 'notes/backlog.z_implemented.*'] });

let totalChunks = 0;
let totalTokens = 0;
let softViolations = 0;
let hardViolations = 0;
const tokenCounts = [];

for (const file of noteFiles) {
  const content = readFileSync(file, 'utf8');
  const chunks = chunkNoteText(content, file);

  for (const chunk of chunks) {
    totalChunks++;
    totalTokens += chunk.token_count;
    tokenCounts.push(chunk.token_count);

    if (chunk.token_count > HARD_LIMIT) {
      hardViolations++;
      console.log(`❌ HARD LIMIT: ${file} chunk ${chunk.id} = ${chunk.token_count} tokens`);
    } else if (chunk.token_count > SOFT_LIMIT) {
      softViolations++;
      console.log(`⚠️  SOFT LIMIT: ${file} chunk ${chunk.id} = ${chunk.token_count} tokens`);
    }
  }
}

// Summary
console.log('\n📊 Benchmark Results');
console.log('====================');
console.log(`Files processed: ${noteFiles.length}`);
console.log(`Total chunks: ${totalChunks}`);
console.log(`Avg tokens/chunk: ${Math.round(totalTokens / totalChunks)}`);
console.log(`Min tokens: ${Math.min(...tokenCounts)}`);
console.log(`Max tokens: ${Math.max(...tokenCounts)}`);
console.log(`Soft limit violations (>${SOFT_LIMIT}): ${softViolations}`);
console.log(`Hard limit violations (>${HARD_LIMIT}): ${hardViolations}`);
console.log(`\n✅ AC2 ${hardViolations === 0 ? 'PASS' : 'FAIL'}: Hard limit (${HARD_LIMIT}) respected`);
