import fs from "fs";
import path from "path";

function loadTestCases(testPath) {
  const resolved = path.resolve(process.cwd(), testPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

function simpleRagAnswer(query, retrievedChunks) {
  // Baseline deterministic answer: pick retrieved chunks that contain tokens from the query
  const qTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const selected = [];
  for (const chunk of retrievedChunks) {
    const cTokens = new Set(chunk.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let overlap = 0;
    for (const t of qTokens) if (cTokens.has(t)) overlap++;
    if (overlap > 0) selected.push(chunk);
  }
  if (selected.length === 0) {
    // Fallback: return the first chunk as a guess
    return retrievedChunks[0] || "";
  }
  // Concatenate up to 3 chunks to form an answer
  return selected.slice(0, 3).join(" \n\n");
}

function sentenceSplit(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function scoreRelevance(generated, query) {
  // Heuristic: token overlap between generated and query -> map to 1-5
  const g = new Set(generated.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const q = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (q.size === 0) return 1;
  let overlap = 0;
  for (const t of q) if (g.has(t)) overlap++;
  const ratio = overlap / q.size; // 0..1
  return Math.max(1, Math.min(5, Math.round(ratio * 5)));
}

function scoreCompleteness(generated, groundTruth) {
  // If generated contains the ground truth exactly => 5
  if (!groundTruth) return 1;
  const gen = generated.toLowerCase();
  const gt = groundTruth.toLowerCase();
  if (gen.includes(gt)) return 5;
  // Partial overlap heuristic
  const gtTokens = new Set(gt.split(/[^a-z0-9]+/).filter(Boolean));
  if (gtTokens.size === 0) return 1;
  const genTokens = new Set(gen.split(/[^a-z0-9]+/).filter(Boolean));
  let overlap = 0;
  for (const t of gtTokens) if (genTokens.has(t)) overlap++;
  const ratio = overlap / gtTokens.size;
  if (ratio > 0.75) return 4;
  if (ratio > 0.4) return 3;
  if (ratio > 0.1) return 2;
  return 1;
}

function scoreGroundedness(generated, retrievedChunks) {
  // For each sentence in generated, check if at least one retrieved chunk contains tokens from the sentence
  const sentences = sentenceSplit(generated);
  if (sentences.length === 0) return 1;
  let supported = 0;
  for (const s of sentences) {
    const sTokens = new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let sentenceSupported = false;
    for (const chunk of retrievedChunks) {
      const cTokens = new Set(chunk.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      let overlap = 0;
      for (const t of sTokens) if (cTokens.has(t)) overlap++;
      if (overlap > 0) {
        sentenceSupported = true;
        break;
      }
    }
    if (sentenceSupported) supported++;
  }
  const ratio = supported / sentences.length;
  return Math.max(1, Math.min(5, Math.round(ratio * 5)));
}

function detectHallucinations(generated, retrievedChunks) {
  const sentences = sentenceSplit(generated);
  const hallucinated = [];
  for (const s of sentences) {
    const sTokens = new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let supported = false;
    for (const chunk of retrievedChunks) {
      const cTokens = new Set(chunk.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      let overlap = 0;
      for (const t of sTokens) if (cTokens.has(t)) overlap++;
      if (overlap > 0) {
        supported = true;
        break;
      }
    }
    if (!supported) hallucinated.push(s);
  }
  return hallucinated;
}

function computeUsedContextPct(generated, retrievedChunks) {
  if (!retrievedChunks || retrievedChunks.length === 0) return 0.0;
  let used = 0;
  const gen = generated.toLowerCase();
  for (const chunk of retrievedChunks) {
    if (!chunk) continue;
    // Consider chunk used if a majority of its words appear in the generated answer
    const cTokens = chunk.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (cTokens.length === 0) continue;
    let present = 0;
    for (const t of cTokens) {
      if (gen.includes(t)) present++;
    }
    if (present / cTokens.length >= 0.2) used++; // loose threshold
  }
  return used / retrievedChunks.length;
}

function evaluateCase(tc) {
  const { id, query, ground_truth: groundTruth, retrieved_chunks: retrievedChunks } = tc;
  const generated = simpleRagAnswer(query, retrievedChunks);
  const relevance = scoreRelevance(generated, query);
  const completeness = scoreCompleteness(generated, groundTruth);
  const groundedness = scoreGroundedness(generated, retrievedChunks);
  const hallucinations = detectHallucinations(generated, retrievedChunks);
  const used_context_pct = computeUsedContextPct(generated, retrievedChunks);
  const correct_exact = (groundTruth || "").trim().length > 0 && generated.toLowerCase().includes((groundTruth || "").toLowerCase());
  return {
    id,
    query,
    ground_truth: groundTruth,
    generated,
    scores: { relevance, completeness, groundedness },
    hallucinations,
    used_context_pct,
    correct_exact
  };
}

function aggregateResults(results) {
  const n = results.length || 1;
  const sum = results.reduce((acc, r) => {
    acc.relevance += r.scores.relevance;
    acc.completeness += r.scores.completeness;
    acc.groundedness += r.scores.groundedness;
    acc.used_context_pct += r.used_context_pct;
    acc.exact_matches += r.correct_exact ? 1 : 0;
    return acc;
  }, { relevance: 0, completeness: 0, groundedness: 0, used_context_pct: 0, exact_matches: 0 });
  return {
    avg_relevance: +(sum.relevance / n).toFixed(2),
    avg_completeness: +(sum.completeness / n).toFixed(2),
    avg_groundedness: +(sum.groundedness / n).toFixed(2),
    avg_used_context_pct: +((sum.used_context_pct / n).toFixed(2)),
    exact_match_rate: +((sum.exact_matches / n).toFixed(2))
  };
}

async function run(testPath) {
  const cases = loadTestCases(testPath);
  const results = [];
  for (const tc of cases) {
    try {
      results.push(evaluateCase(tc));
    } catch (err) {
      console.error("Error evaluating case", tc.id, err);
    }
  }
  const aggregates = aggregateResults(results);
  const out = { cases: results, aggregates };
  console.error(JSON.stringify(out, null, 2));
  // Exit code non-zero if many hallucinations or low averages (simple guard)
  if (aggregates.avg_groundedness < 2 || aggregates.avg_relevance < 2) {
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const testPath = process.argv[2] || "tests/rag/answer-quality-cases.json";
  run(testPath).catch(err => { console.error(err); process.exit(1); });
}

export { run, evaluateCase, simpleRagAnswer };
