// RAG adapter using existing LanceDB infrastructure.
// Expected to return the same shape as fsSearch but with similarity score in [0,1].

import { query } from '../../scripts/rag/query.mjs';
import { getProjectContext } from '../../scripts/rag/utils.mjs';

export async function ragSearch(queryString: string, opts: { k: number; t: number }) {
  try {
    const { ragDbPath } = getProjectContext();
    
    const result = await query({
      db: ragDbPath,
      q: queryString,
      k: opts.k
    });
    
    if (!result.ok) {
      console.error('RAG search failed:', result.error);
      return [];
    }
    
    // Transform results to match expected interface
    return result.matches.map(match => ({
      source: "rag" as const,
      path: match.path,
      text: match.text,
      score: match.score,
      ts: match.updatedAt
    }));
    
  } catch (error) {
    console.error('RAG search error:', error.message);
    return [];
  }
}