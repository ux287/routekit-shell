import { domainRegistry, getDomain } from './domain-registry.mjs';

/*
  Lightweight heuristic-based query classifier and router.
  - classifyQuery(query) => { type, hits }
  - routeQuery(query, opts) => { type, routes: [{domain,index,k,weight,primary}], originalQuery }
  - rrfMerge(resultsByDomain, options) => merged results using Reciprocal Rank Fusion with domain weights
*/

const patterns = {
  code_lookup: [ /\bwhere is\b/i, /\bfunction\b/i, /\bclass\b/i, /\bimport\b/i, /\berror\b/i, /\btrace\b/i, /\bexception\b/i ],
  decision_context: [ /\bwhy did we\b/i, /\bdecision\b/i, /\btradeoff\b/i, /\bcontext\b/i, /\bwhy\b/i ],
  procedural: [ /\bhow do i\b/i, /\bhow to\b/i, /\bsteps to\b/i, /\bguide\b/i, /\binstall\b/i ],
  discovery: [ /\blist all\b/i, /\bwhat options\b/i, /\bshow me\b/i, /\bwhat is\b/i, /\bexamples\b/i ]
};

export function classifyQuery(query) {
  const q = (query || '').toString();
  const hits = {};
  for (const [type, pats] of Object.entries(patterns)) {
    for (const p of pats) {
      if (p.test(q)) {
        hits[type] = (hits[type] || 0) + 1;
      }
    }
  }
  const typesFound = Object.keys(hits);
  let type = 'mixed';
  if (typesFound.length === 0) type = 'discovery';
  else if (typesFound.length === 1) type = typesFound[0];
  else type = 'mixed';
  // lightweight debug logging for classification decisions
  try { console.debug && console.debug('[query-router] classifyQuery', { query: q, type, hits }); } catch (e) {}
  return { type, hits };
}

export function routeQuery(query, opts = {}) {
  const { type } = classifyQuery(query);
  const routes = [];
  const cfg = opts.domainConfig || {};
  const apply = (domainName, overrides = {}) => {
    const d = getDomain(domainName);
    if (!d) return;
    const baseK = (cfg[domainName] && cfg[domainName].k) || d.defaults.k;
    const weight = (cfg[domainName] && cfg[domainName].weight) || d.defaults.weight;
    routes.push({ domain: domainName, index: d.index, k: overrides.k || baseK, weight: overrides.weight || weight, primary: !!overrides.primary });
  };

  if (type === 'code_lookup') {
    apply('code', { primary: true });
    // secondary: notes with lower k
    apply('notes', { k: Math.max(1, Math.floor(getDomain('notes').defaults.k / 2)), weight: 0.8 });
  } else if (type === 'decision_context') {
    apply('notes', { primary: true });
    // skip code
  } else if (type === 'procedural') {
    apply('notes', { primary: true });
    apply('docs', { primary: false });
  } else if (type === 'discovery') {
    // wider k across all domains
    apply('notes', { k: Math.max(6, getDomain('notes').defaults.k + 4) });
    apply('code', { k: Math.max(8, getDomain('code').defaults.k + 4) });
    apply('docs', { k: Math.max(6, getDomain('docs').defaults.k + 4) });
  } else if (type === 'mixed') {
    apply('code');
    apply('notes');
    apply('docs');
  }

  try { console.debug && console.debug('[query-router] routeQuery', { query, type, routes }); } catch (e) {}
  return { type, routes, originalQuery: query };
}

// Reciprocal Rank Fusion (RRF) implementation
export function rrfMerge(resultsByDomain = {}, options = {}) {
  const { weightOverrides = {}, kParam = 60 } = options;
  const agg = new Map(); // id -> { id, text, score, provenance: [{domain,rank,rawScore,weight}] }

  for (const [domain, arr] of Object.entries(resultsByDomain)) {
    const weight = weightOverrides[domain] ?? (getDomain(domain)?.defaults?.weight ?? 1.0);
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      const id = r.id || r.uri || r.key || JSON.stringify(r).slice(0, 60);
      const text = r.text || r.snippet || r.content || '';
      const rank = i + 1;
      const rrScore = 1 / (kParam + rank);
      const add = (rrScore * weight);
      if (!agg.has(id)) {
        agg.set(id, { id, text, score: add, provenance: [{ domain, rank, rawScore: r.score ?? null, weight }] });
      } else {
        const prev = agg.get(id);
        prev.score += add;
        prev.provenance.push({ domain, rank, rawScore: r.score ?? null, weight });
        if (!prev.text && text) prev.text = text;
      }
    }
  }

  // Convert to array and lightweight dedupe by normalized text signature
  const arr = Array.from(agg.values()).map(v => ({ ...v }));
  const seenSig = new Set();
  const deduped = [];
  for (const item of arr.sort((a, b) => b.score - a.score)) {
    const sig = (item.text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    if (!sig) {
      deduped.push(item);
      continue;
    }
    if (!seenSig.has(sig)) {
      seenSig.add(sig);
      deduped.push(item);
    }
  }
  return deduped;
}

export default { classifyQuery, routeQuery, rrfMerge };