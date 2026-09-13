export function precisionAtK(retrieved, relevant, k) {
  const topK = retrieved.slice(0, k);
  const hits = topK.filter(r => relevant.includes(r.id)).length;
  return hits / k;
}

export function recallAtK(retrieved, relevant, k) {
  if (!relevant || relevant.length === 0) return 0;
  const topK = retrieved.slice(0, k);
  const hits = topK.filter(r => relevant.includes(r.id)).length;
  return hits / relevant.length;
}

export function mrr(retrieved, relevant) {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.includes(retrieved[i].id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

export function hitRate(results, kFieldSuffix = 10) {
  // results: array of per-query metric objects. We expect precision_at_<kFieldSuffix> to exist.
  const key = `precision_at_${kFieldSuffix}`;
  const hits = results.filter(r => r[key] && r[key] > 0).length;
  return hits / results.length;
}

export function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  const sum = arr.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  return sum / arr.length;
}

export function aggregateByCategory(results) {
  const byCat = {};
  for (const r of results) {
    const cat = r.category || 'uncategorized';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(r);
  }

  const out = {};
  for (const [cat, arr] of Object.entries(byCat)) {
    out[cat] = {
      avg_precision_at_5: avg(arr.map(a => a.precision_at_5)),
      avg_precision_at_10: avg(arr.map(a => a.precision_at_10)),
      avg_recall_at_10: avg(arr.map(a => a.recall_at_10)),
      avg_mrr: avg(arr.map(a => a.mrr)),
      hit_rate_at_10: hitRate(arr, 10)
    };
  }
  return out;
}
