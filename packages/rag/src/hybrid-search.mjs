/*
Hybrid search module.
Functions:
- detectQueryType(query) -> 'code' | 'concept' | 'mixed'
- rrfCombine(semanticList, keywordList, weights) -> merged ranked list
- hybridSearch({ query, semanticResults, bm25Index, k, config })

Notes: semanticResults should be an array of { id, score } where higher is better.
This module does not compute semantic embeddings itself; it expects semantic results from the caller.
*/

import { createIndex } from './bm25-index.mjs';

export function detectQueryType(query) {
  // Heuristic classifier: looks for paths, dot/slash, short identifier-like tokens
  if (!query || typeof query !== 'string') return 'concept';
  const hasPath = /[\/.\\]|\w+\.\w{1,4}\b/.test(query);
  const tokens = (query.match(/[A-Za-z_][\w$]*/g) || []);
  const identCount = tokens.filter(t => /[A-Za-z_]/.test(t)).length;
  const totalWords = (query.match(/\w+/g) || []).length;
  if (hasPath || identCount >= Math.max(1, Math.floor(totalWords * 0.6))) return 'code';
  if (totalWords >= 6) return 'concept';
  return 'mixed';
}

function toRankMap(list) {
  // list: [{id, score}] assumed sorted descending by score
  const map = new Map();
  for (let i = 0; i < list.length; i++) {
    map.set(list[i].id, i + 1); // rank starts at 1
  }
  return map;
}

export function rrfCombine(semanticList = [], keywordList = [], weights = { semantic: 0.7, keyword: 0.3, rrfK: 60 }) {
  // Implements Reciprocal Rank Fusion (RRF) and combines with configured weights.
  // semanticList and keywordList are arrays of { id, score } (score not used for RRF except ordering)
  const semRank = toRankMap(semanticList);
  const keyRank = toRankMap(keywordList);
  const allIds = new Set([...semanticList.map(r => r.id), ...keywordList.map(r => r.id)]);
  const out = [];
  for (const id of allIds) {
    const r_sem = semRank.get(id) || (semanticList.length + 1);
    const r_key = keyRank.get(id) || (keywordList.length + 1);
    const rrf_sem = 1 / (weights.rrfK + r_sem);
    const rrf_key = 1 / (weights.rrfK + r_key);
    const score = (weights.semantic * rrf_sem) + (weights.keyword * rrf_key);
    out.push({ id, score, r_sem, r_key });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export async function hybridSearch({ query, semanticResults = [], bm25Index, k = 12, config = {} }) {
  // bm25Index: instance created by createIndex() (caller may reuse a shared instance)
  // semanticResults: [{ id, score }] (may be empty)
  // config: { semanticWeight, keywordWeight, codeWeights: { semantic, keyword }, conceptWeights, mixedWeights }

  if (!bm25Index) {
    // create a temporary index if none provided (not ideal, but makes module usable in isolation)
    bm25Index = createIndex();
  }

  const qtype = detectQueryType(query);
  const defaults = {
    semanticWeight: 0.7,
    keywordWeight: 0.3,
    codeWeights: { semantic: 0.4, keyword: 0.6 },
    conceptWeights: { semantic: 0.8, keyword: 0.2 },
    mixedWeights: { semantic: 0.6, keyword: 0.4 },
    rrfK: 60
  };
  const c = Object.assign({}, defaults, config);

  let weights;
  if (qtype === 'code') weights = { semantic: c.codeWeights.semantic, keyword: c.codeWeights.keyword, rrfK: c.rrfK };
  else if (qtype === 'concept') weights = { semantic: c.conceptWeights.semantic, keyword: c.conceptWeights.keyword, rrfK: c.rrfK };
  else weights = { semantic: c.mixedWeights.semantic, keyword: c.mixedWeights.keyword, rrfK: c.rrfK };

  // Normalize incoming semanticResults by rank ordering if scores are not comparable
  const sortedSemantic = [...semanticResults].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, k);

  // Keyword (bm25) results
  const keywordResults = bm25Index.search(query, k, { boostIdentifiers: true });

  // Combine via RRF
  const merged = rrfCombine(sortedSemantic, keywordResults, weights);

  // Attach original scores (if available) for transparency
  const semMap = new Map(sortedSemantic.map((r, i) => [r.id, { score: r.score, rank: i + 1 }]));
  const keyMap = new Map(keywordResults.map((r, i) => [r.id, { score: r.score, rank: i + 1 }]));

  const result = merged.slice(0, k).map(item => {
    return {
      id: item.id,
      score: item.score,
      semantic: semMap.get(item.id) || null,
      keyword: keyMap.get(item.id) || null
    };
  });

  return { query, qtype, weights, results: result };
}

export default { detectQueryType, rrfCombine, hybridSearch };
