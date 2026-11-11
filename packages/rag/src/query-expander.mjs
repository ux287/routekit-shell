/* Query Expander
 * Responsibilities:
 * - Detect query type (factual, conceptual, procedural, discovery)
 * - Extract key entities and concepts
 * - Identify ambiguous terms
 * - Produce expansions: synonyms, aspects, HyDE (hypothetical document)
 * - Configurable expansion level: conservative | aggressive
 */

const DEFAULT_DOMAIN_VOCAB = {
  test: ["testing", "unit testing", "component testing", "vitest"],
  component: ["component", "ui component", "web component", "component spec"],
  deploy: ["deployment", "ci/cd", "github actions", "deploy pipeline"],
  auth: ["authentication", "oauth", "jwt", "sessions"]
};

const AMBIGUOUS_TERMS = new Set(["test", "spec", "component", "auth", "deployment"]);
const STOPWORDS = new Set(["the","a","an","to","for","of","in","on","how","what","why","is","are","do","we","should"]);

function detectQueryType(query) {
  const q = query.trim().toLowerCase();
  if (/^how\b/.test(q) || /\bhow do i\b/.test(q) || /\bhow to\b/.test(q)) return 'procedural';
  if (/^what\b/.test(q) || /what is|define|meaning/.test(q)) return 'factual';
  if (/^why\b/.test(q) || /difference|trade-off|pros and cons/.test(q)) return 'conceptual';
  // longer, multi-aspect queries lean discovery
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 8) return 'discovery';
  return 'factual';
}

function extractEntities(query) {
  // simple token-based entity extraction: return lowercased significant tokens
  const tokens = query
    .replace(/["'.,?()]/g, ' ')
    .split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t && !STOPWORDS.has(t));
  // return unique tokens preserving order
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function identifyAmbiguousTerms(tokens) {
  return tokens.filter(t => AMBIGUOUS_TERMS.has(t));
}

function synonymExpansion(tokens, domainVocab) {
  const vocab = Object.assign({}, DEFAULT_DOMAIN_VOCAB, domainVocab || {});
  const expansions = [];
  for (const t of tokens) {
    if (vocab[t]) {
      for (const s of vocab[t]) expansions.push(s);
    }
  }
  return [...new Set(expansions)];
}

function aspectExpansion(query, tokens) {
  // Generate short phrase-based variations that focus on likely aspects
  const aspects = new Set();
  // If query contains verbs like test/build/deploy, produce focused aspect queries
  const verbHints = ['test','deploy','build','migrate','compare','install','configure'];
  const qLower = query.toLowerCase();
  for (const v of verbHints) {
    if (qLower.includes(v)) {
      for (const t of tokens) aspects.add(`${v} ${t}`);
    }
  }
  // General component aspect: "<token> best practices", "<token> examples"
  for (const t of tokens) {
    aspects.add(`${t} best practices`);
    aspects.add(`${t} examples`);
    aspects.add(`${t} guide`);
  }
  return Array.from(aspects).slice(0, 12);
}

function generateHyDE(query, entities, aspects) {
  // Produce a short hypothetical document (HyDE) - an ideal answer summary that can be used for retrieval
  const leadEntities = entities.slice(0, 4).join(', ');
  const leadAspects = aspects.slice(0, 3).join('; ');
  return `Ideal answer for query: "${query}"\n\nSummary:\nProvide a concise explanation covering ${leadEntities || 'key concepts'}, including practical steps and examples. Discuss relevant aspects such as ${leadAspects || 'implementation details, tools, and examples'}. Include commands, configuration snippets, and links to authoritative docs where applicable.\n`;
}

export function expandQuery(originalQuery, opts = {}) {
  const { level = 'conservative', domainVocab = null, includeHyDE = true } = opts;
  const type = detectQueryType(originalQuery);
  const tokens = extractEntities(originalQuery);
  const ambiguous = identifyAmbiguousTerms(tokens);
  const synonyms = synonymExpansion(tokens, domainVocab);
  const aspects = aspectExpansion(originalQuery, tokens);
  const hydeText = includeHyDE ? generateHyDE(originalQuery, tokens, aspects) : null;

  // Build candidate list with weights
  const candidates = [];
  // Original query - highest priority
  candidates.push({
    id: 'original',
    text: originalQuery,
    source: 'original',
    weight: 1.00,
    meta: { type, entities: tokens, ambiguous }
  });

  // Conservative expansions: synonyms + primary aspects
  if (level === 'conservative' || level === 'aggressive') {
    const unique = new Set();
    for (const s of synonyms) unique.add(s);
    for (const a of aspects.slice(0, 6)) unique.add(a);
    for (const q of unique) {
      candidates.push({ id: `cons:${q}`, text: q, source: 'synonym/aspect', weight: 0.85, meta: { type, entities: tokens } });
    }
    if (hydeText) {
      candidates.push({ id: 'hyde', text: hydeText, source: 'hyde', weight: 0.70, meta: { type, entities: tokens } });
    }
  }

  // Aggressive: include more synonyms/aspects and longer paraphrases
  if (level === 'aggressive') {
    for (const a of aspects.slice(6, 12)) {
      candidates.push({ id: `ag:${a}`, text: a, source: 'aspect', weight: 0.70, meta: { type, entities: tokens } });
    }
    // add token-based expansions
    for (const t of tokens) {
      candidates.push({ id: `ag:term:${t}`, text: `${t} overview`, source: 'term', weight: 0.65, meta: { type } });
    }
  }

  return {
    originalQuery: originalQuery,
    type,
    candidates
  };
}

export default { expandQuery };