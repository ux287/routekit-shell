/*
 * Lightweight reranker for RAG results
 * - Exported function: rerankResults(query, candidates, options)
 * - candidates: [{ id, text, score, provenance? }]
 * - options: { maxCandidates, enableCrossEncoder, crossEncoder (optional fn), nowMs }
 *
 * Behavior:
 *  - Compute a BM25-lite / keyword-overlap score between query and candidate text
 *  - Apply source-type weighting when provenance indicates source
 *  - Apply a simple recency boost if timestamps are present
 *  - If enableCrossEncoder && options.crossEncoder provided, call it for top-N (hook only)
 */

const DEFAULT_STOPWORDS = new Set(['the','is','at','which','on','and','a','an','of','for','to','in','that','it','with']);

function tokenize(text) {
  if (!text) return [];
  return ('' + text).toLowerCase().split(/[^\w]+/).filter(t => t && !DEFAULT_STOPWORDS.has(t));
}

function uniqueTokens(tokens) {
  const s = new Set();
  for (const t of tokens) s.add(t);
  return Array.from(s);
}

function sourceWeightFrom(source) {
  if (!source) return 1.0;
  const s = ('' + source).toLowerCase();
  if (s.includes('notes') || s.includes('decision') || s.includes('spec')) return 1.15;
  if (s.includes('code') || s.includes('.js') || s.includes('.py')) return 0.95;
  if (s.includes('docs') || s.includes('doc') || s.includes('manual')) return 1.05;
  return 1.0;
}

function extractTimestamp(candidate) {
  // try common places for timestamp: candidate.timestamp, candidate.meta?.timestamp, provenance entries
  if (!candidate) return null;
  if (typeof candidate.timestamp === 'number') return candidate.timestamp;
  if (candidate.meta && typeof candidate.meta.timestamp === 'number') return candidate.meta.timestamp;
  if (candidate.provenance && Array.isArray(candidate.provenance)) {
    for (const p of candidate.provenance) {
      if (p && typeof p.timestamp === 'number') return p.timestamp;
      // sometimes source may include ISO date
      if (p && typeof p.source === 'string') {
        const m = Date.parse(p.source);
        if (!isNaN(m)) return m;
      }
    }
  }
  return null;
}

export async function rerankResults(query, candidates, options = {}) {
  const { maxCandidates = Math.min(20, candidates.length), enableCrossEncoder = false, crossEncoder = null, nowMs = Date.now() } = options;

  const qTokens = uniqueTokens(tokenize(query));
  const qSet = new Set(qTokens);

  // Score each candidate quickly
  const scored = candidates.map((c, idx) => {
    const text = c.text || '';
    const tokens = uniqueTokens(tokenize(text));

    // term overlap: number of query tokens present in doc
    let overlap = 0;
    for (const t of qSet) if (tokens.indexOf(t) !== -1) overlap++;

    // length normalization (BM25-lite style)
    const len = Math.max(1, (text.split(/\s+/).length || 1));
    const lengthNorm = 1 / Math.log(2 + len);

    const overlapScore = overlap * lengthNorm;

    // source weighting (inspect provenance first entry if available)
    let src = null;
    if (c.provenance && Array.isArray(c.provenance) && c.provenance.length) {
      src = c.provenance[0].source || c.provenance[0].candidateText || null;
    } else if (c.source) {
      src = c.source;
    }
    const sWeight = sourceWeightFrom(src);

    // recency boost if timestamp available
    const ts = extractTimestamp(c);
    let recencyBoost = 1.0;
    if (ts && typeof ts === 'number') {
      // simple exponential decay: half-life 90 days
      const ageDays = Math.max(0, (nowMs - ts) / (1000 * 60 * 60 * 24));
      const halfLife = 90;
      recencyBoost = 1 + Math.exp(-ageDays / halfLife) * 0.25; // up to +0.25 boost for very recent
    }

    // combine: base embedding score preserved but allow overlapScore to influence ordering
    const base = typeof c.score === 'number' ? c.score : 0;
    const combined = (base * 0.7) + (overlapScore * 1.0) ;
    const weighted = combined * sWeight * recencyBoost;

    return Object.assign({}, c, { _rerankScore: weighted, _overlapScore: overlapScore, _sourceWeight: sWeight, _recencyBoost: recencyBoost, _origIndex: idx });
  });

  // Sort by _rerankScore desc
  scored.sort((a, b) => b._rerankScore - a._rerankScore);

  // Optional cross-encoder hook for top-N
  if (enableCrossEncoder && typeof crossEncoder === 'function') {
    try {
      const top = scored.slice(0, maxCandidates);
      // crossEncoder expected to be async fn(query, [{id,text,...}], opts) => [{id,score}] or similar
      const crossRes = await crossEncoder(query, top.map(t => ({ id: t.id, text: t.text })), { maxCandidates });
      if (Array.isArray(crossRes) && crossRes.length) {
        // merge cross scores
        const crossMap = new Map();
        for (const r of crossRes) {
          if (r && (r.id || r.key)) crossMap.set(r.id || r.key, r.score ?? r.score === 0 ? Number(r.score) : null);
        }
        for (const t of top) {
          const cs = crossMap.get(t.id);
          if (typeof cs === 'number') {
            // give cross-encoder strong weight but keep overlap
            t._rerankScore = (t._rerankScore * 0.4) + (cs * 0.6);
          }
        }
        // re-sort top portion and splice back
        top.sort((a, b) => b._rerankScore - a._rerankScore);
        scored.splice(0, top.length, ...top);
      }
    } catch (e) {
      // if cross-encoder fails, ignore and continue with lightweight scores
      // keep operation fast and resilient
      // eslint-disable-next-line no-console
      console.warn('cross-encoder rerank failed', e);
    }
  }

  // return same shape but sorted; keep only up to maxCandidates if requested
  const result = (maxCandidates && scored.length > maxCandidates) ? scored.slice(0, maxCandidates) : scored;
  return result.map(r => {
    // remove internal keys
    const copy = Object.assign({}, r);
    delete copy._overlapScore; delete copy._sourceWeight; delete copy._recencyBoost; delete copy._origIndex; delete copy._rerankScore;
    return copy;
  });
}

export default { rerankResults };