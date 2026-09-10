/*
Lightweight BM25 index with incremental updates and simple code-symbol extraction.
Exports: createIndex()
*/

const DEFAULTS = { k1: 1.5, b: 0.75, idBoost: 3.0 };

function tokenize(text) {
  if (!text) return [];
  // simple word tokenization, preserves identifiers like foo_bar and camelCase
  return ("" + text).toLowerCase().match(/[a-z0-9_]+|\/.+?\/?|\w+\.|\w+\:\:\w+/g) || [];
}

function extractSymbols(text) {
  // try to capture common code symbols: function/class names, identifiers, file paths
  const syms = new Set();
  if (!text) return syms;
  // function foo, async function foo, const foo = () =>
  const fn = /(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = fn.exec(text))) syms.add(m[1].toLowerCase());
  // common identifier patterns (camelCase, snake_case, kebab-ish)
  const id = /\b([A-Za-z_$][\w$]{2,})\b/g;
  while ((m = id.exec(text))) syms.add(m[1].toLowerCase());
  // file paths like src/foo/bar.js or /path/to/file
  const pathRe = /([\/\w\.-]+\.(?:js|ts|mjs|jsx|tsx|json))/g;
  while ((m = pathRe.exec(text))) syms.add(m[1].toLowerCase());
  return syms;
}

class BM25Index {
  constructor(opts = {}) {
    this.k1 = opts.k1 ?? DEFAULTS.k1;
    this.b = opts.b ?? DEFAULTS.b;
    this.idBoost = opts.idBoost ?? DEFAULTS.idBoost;

    this.docs = new Map(); // id -> { text, metadata }
    this.termFreqs = new Map(); // term -> Map(docId -> freq)
    this.docFreqs = new Map(); // term -> df
    this.docLengths = new Map(); // docId -> length
    this.totalDocs = 0;
    this.avgDocLen = 0;
    this.symbolIndex = new Map(); // symbol -> Set(docId)
  }

  _incTerm(term, docId) {
    let tf = this.termFreqs.get(term);
    if (!tf) {
      tf = new Map();
      this.termFreqs.set(term, tf);
    }
    tf.set(docId, (tf.get(docId) || 0) + 1);
    this.docFreqs.set(term, tf.size);
  }

  _decTerm(term, docId) {
    const tf = this.termFreqs.get(term);
    if (!tf) return;
    tf.delete(docId);
    if (tf.size === 0) {
      this.termFreqs.delete(term);
      this.docFreqs.delete(term);
    } else {
      this.docFreqs.set(term, tf.size);
    }
  }

  addDocument(docId, text, metadata = {}) {
    if (this.docs.has(docId)) {
      return this.updateDocument(docId, text, metadata);
    }
    const tokens = tokenize(text);
    const len = tokens.length;
    this.docs.set(docId, { text, metadata });
    this.docLengths.set(docId, len);
    this.totalDocs += 1;
    this.avgDocLen = [...this.docLengths.values()].reduce((a, b) => a + b, 0) / this.totalDocs;

    const counted = new Map();
    for (const t of tokens) {
      counted.set(t, (counted.get(t) || 0) + 1);
    }
    for (const [t, freq] of counted.entries()) {
      for (let i = 0; i < freq; i++) this._incTerm(t, docId);
    }

    const syms = extractSymbols(text);
    for (const s of syms) {
      const set = this.symbolIndex.get(s) || new Set();
      set.add(docId);
      this.symbolIndex.set(s, set);
    }
  }

  removeDocument(docId) {
    const existing = this.docs.get(docId);
    if (!existing) return;
    const tokens = tokenize(existing.text);
    const counted = new Map();
    for (const t of tokens) counted.set(t, (counted.get(t) || 0) + 1);
    for (const [t, freq] of counted.entries()) {
      for (let i = 0; i < freq; i++) this._decTerm(t, docId);
    }
    // remove symbols
    for (const [s, set] of this.symbolIndex.entries()) {
      if (set.has(docId)) {
        set.delete(docId);
        if (set.size === 0) this.symbolIndex.delete(s);
      }
    }
    this.docs.delete(docId);
    this.docLengths.delete(docId);
    this.totalDocs = Math.max(0, this.totalDocs - 1);
    this.avgDocLen = this.totalDocs === 0 ? 0 : [...this.docLengths.values()].reduce((a, b) => a + b, 0) / this.totalDocs;
  }

  updateDocument(docId, text, metadata = {}) {
    // incremental: remove old then add new
    this.removeDocument(docId);
    this.addDocument(docId, text, metadata);
  }

  _idf(term) {
    const df = this.docFreqs.get(term) || 0;
    if (df === 0) return 0;
    return Math.log(1 + (this.totalDocs - df + 0.5) / (df + 0.5));
  }

  search(query, k = 10, opts = {}) {
    // returns array of { id, score, metadata }
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const scores = new Map();
    for (const t of tokens) {
      const tfmap = this.termFreqs.get(t);
      if (!tfmap) continue;
      const idf = this._idf(t);
      for (const [docId, freq] of tfmap.entries()) {
        const dl = this.docLengths.get(docId) || 0;
        const norm = (freq * (this.k1 + 1)) / (freq + this.k1 * (1 - this.b + (this.b * dl) / Math.max(1, this.avgDocLen)));
        const v = idf * norm;
        scores.set(docId, (scores.get(docId) || 0) + v);
      }
    }

    // identifier boosting: if query contains a symbol present in doc, boost
    if (opts.boostIdentifiers !== false) {
      for (const t of tokens) {
        const symSet = this.symbolIndex.get(t);
        if (!symSet) continue;
        for (const docId of symSet) {
          const prev = scores.get(docId) || 0;
          scores.set(docId, prev + this.idBoost);
        }
      }
    }

    const out = [...scores.entries()].map(([id, score]) => {
      return { id, score, metadata: this.docs.get(id)?.metadata || null };
    });
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}

export function createIndex(opts = {}) {
  return new BM25Index(opts);
}

export default { createIndex };
