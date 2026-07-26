import { expandQuery } from '../rag/query-expander.mjs';
import { rerankResults } from '../rag/reranker.mjs';

/**
 * orchestrate(query, retrieveFn, options)
 * - retrieveFn: async function retrieveFn(queryString, opts) => [{ id, score, text, source? }]
 * - options: { level: 'conservative'|'aggressive', k, dedupe }
 *
 * Returns: { mergedResults: [{id,score,text,provenance}], details }
 */
export async function orchestrate(query, retrieveFn, options = {}) {
  const { level = 'conservative', k = 6, dedupe = true, timeoutMs = 5000 } = options;
  const plan = expandQuery(query, { level, includeHyDE: true });
  const candidates = plan.candidates;

  // Helper to call retrieveFn with simple timeout guard
  const callRetriever = async (qText) => {
    const p = retrieveFn(qText, { k }).then(r => ({ ok: true, r })).catch(err => ({ ok: false, err }));
    if (!timeoutMs) return p;
    const timeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, err: new Error('retrieve timeout') }), timeoutMs));
    return Promise.race([p, timeout]);
  };

  // Run retrieval for each candidate in parallel but cap concurrency implicitly by Promise.all
  const retrievalPromises = candidates.map(async (cand) => {
    const res = await callRetriever(cand.text);
    return { cand, res };
  });

  const retrievals = await Promise.all(retrievalPromises);

  // Merge results with weighting and deduplication
  const merged = new Map(); // id => { id, text, score, provenance: [{sourceCandidateId, candidateWeight, rawScore}] }

  for (const entry of retrievals) {
    const { cand, res } = entry;
    if (!res || !res.ok) continue; // skip failed
    const hits = res.r || [];
    for (const h of hits) {
      const id = h.id || h.uri || h.key || JSON.stringify(h).slice(0, 60);
      const rawScore = Number(h.score || 0);
      // weight: candidate.weight already encodes original vs expansion preference
      const weighted = rawScore * (cand.weight ?? 0.7);

      if (!merged.has(id)) {
        merged.set(id, {
          id,
          text: h.text || h.snippet || h.content || null,
          score: weighted,
          provenance: [{ candidateId: cand.id, candidateText: cand.text, candidateWeight: cand.weight, rawScore }]
        });
      } else {
        const prev = merged.get(id);
        // update score to max of scores (conservative) and append provenance
        prev.score = Math.max(prev.score, weighted);
        prev.provenance.push({ candidateId: cand.id, candidateText: cand.text, candidateWeight: cand.weight, rawScore });
        // prefer longer text if missing
        if (!prev.text && (h.text || h.snippet)) prev.text = h.text || h.snippet;
      }
    }
  }

  // Convert to sorted array
  const mergedResults = Array.from(merged.values()).sort((a, b) => b.score - a.score);

  // Rerank results using lightweight reranker
  let rerankedResults = mergedResults;
  try {
    rerankedResults = await rerankResults(query, mergedResults, {
      maxCandidates: Math.min(20, mergedResults.length),
      enableCrossEncoder: options.enableCrossEncoder || false
    });
  } catch (e) {
    console.warn('rerank failed, using merged order', e);
  }

  // If dedupe is enabled, perform a lightweight dedupe by normalizing text (very conservative)
  if (dedupe) {
    const seenSignatures = new Set();
    const deduped = [];
    for (const r of rerankedResults) {
      const sig = (r.text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
      if (!sig) {
        deduped.push(r);
        continue;
      }
      if (!seenSignatures.has(sig)) {
        seenSignatures.add(sig);
        deduped.push(r);
      }
    }
    return {
      mergedResults: deduped,
      details: {
        originalQuery: plan.originalQuery,
        type: plan.type,
        candidates: candidates.map(c => ({ id: c.id, text: c.text, weight: c.weight, source: c.source })),
        retrievedCount: rerankedResults.length
      }
    };
  }

  return {
    mergedResults: rerankedResults,
    details: {
      originalQuery: plan.originalQuery,
      type: plan.type,
      candidates: candidates.map(c => ({ id: c.id, text: c.text, weight: c.weight, source: c.source })),
      retrievedCount: rerankedResults.length
    }
  };
}

export default { orchestrate };