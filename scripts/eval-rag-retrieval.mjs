#!/usr/bin/env node
// Deterministic in-process runner for eval rag-retrieval-v1.
// backlog.feat.eval-rag-retrieval-runner. Rules: evals/README.md, "Runner scope".
//
// NOT a Governor tool. Invoked only by `npm run eval:rag` (a person, or a CI job). It wires ONLY an
// in-memory telemetry collector into the RAG host hooks and never the provenance hook, so a run grants
// no read provenance to any session. Rows carry ids, ranks, booleans and applied k/intent only: no
// question text, and no retrieved paths or content. The question set lives under evals/, which the embed walk ignores.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRagQuery, setRagHostHooks } from "../packages/rag/src/tools.mjs";

export const EVAL_ID = "rag-retrieval-v1";
export const K = 10;
/** Exit code when a question's rag.query payload was not captured (distinct from 1 crash, 2 refused, 3 exists). */
export const EXIT_UNCAPTURED = 4;
const QUESTIONS_REL = `evals/${EVAL_ID}/questions.json`;
const RESULTS_REL = `evals/${EVAL_ID}/results`;
const MANIFEST_REL = ".rks/rag/embed-manifest.json";

/** A note slug from a ranked entry or candidate: its slug, else its path basename without .md. */
export function slugOf(entry) {
  if (entry?.slug) return entry.slug;
  if (!entry?.path) return null;
  return path.basename(entry.path).replace(/\.md$/, "");
}

/** Gold rule from questions.json goldMatch: exact slug, or prefix when the gold entry ends in *. */
export function goldMatches(slug, gold) {
  if (!slug) return false;
  return gold.some((g) => (g.endsWith("*") ? slug.startsWith(g.slice(0, -1)) : slug === g));
}

/** Score one question from a captured rag.query payload. Strict: only a gold note in ranked counts.
 *  A missing payload is not a miss: it throws, so no caller can record an unobserved row as 0 hits. */
export function scoreQuestion(payload, gold) {
  if (payload == null) throw new TypeError("scoreQuestion: no captured rag.query payload");
  const ranked = payload.ranked ?? [];
  const hit = ranked.find((r) => goldMatches(slugOf(r), gold));
  const rank = hit ? hit.rank : null;
  const inTop = (n) => rank != null && rank <= n;
  const cand = (payload?.candidates ?? []).find((c) => goldMatches(slugOf(c), gold));
  return {
    rank,
    hit5: inTop(5),
    hit10: inTop(10),
    rr10: inTop(10) ? 1 / rank : 0,
    goldSemanticRank: cand ? cand.semanticRank : null,
    appliedK: payload?.k ?? null,
    appliedIntent: payload?.intent ?? null,
  };
}

export function aggregate(rows) {
  const n = rows.length;
  const mrr = n ? rows.reduce((s, r) => s + r.rr10, 0) / n : 0;
  return {
    n,
    hit5: rows.filter((r) => r.hit5).length,
    hit10: rows.filter((r) => r.hit10).length,
    mrr10: Math.round(mrr * 1000) / 1000,
  };
}

/** sha256 over the manifest's hashes with keys sorted, so the digest is independent of key order. */
export function indexDigestOf(manifest) {
  const hashes = manifest?.hashes ?? {};
  const canonical = JSON.stringify(Object.keys(hashes).sort().map((k) => [k, hashes[k]]));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function questionSetDigestOf(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Append-only: the wx flag refuses to open a path that already exists. Returns false on refusal. */
export function writeResultsAppendOnly(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    throw e;
  }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export async function main(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  if (git(root, ["status", "--porcelain"]) !== "") {
    console.error("[eval:rag] refused: working tree is dirty; a results file must name a reproducible commit");
    return 2;
  }
  const sha = git(root, ["rev-parse", "--short=9", "HEAD"]);
  const manifestPath = path.join(root, MANIFEST_REL);
  if (!existsSync(manifestPath)) {
    console.error(`[eval:rag] refused: ${MANIFEST_REL} not found; embed the corpus first`);
    return 2;
  }
  const indexDigest = indexDigestOf(JSON.parse(readFileSync(manifestPath, "utf8")));
  const questionBytes = readFileSync(path.join(root, QUESTIONS_REL));
  const questionSet = JSON.parse(questionBytes.toString("utf8"));
  const date = new Date().toISOString().slice(0, 10);
  const resultsFile = path.join(root, RESULTS_REL, `${date}-${sha}.json`);
  if (existsSync(resultsFile)) {
    console.error(`[eval:rag] refused: ${path.relative(root, resultsFile)} exists; results are append-only`);
    return 3;
  }

  let captured = null;
  setRagHostHooks({
    getTelemetryCollector: () => ({
      emit(type, _project, payload) {
        if (type === "rag.query") captured = payload;
      },
    }),
  });

  const rows = [];
  for (const question of questionSet.questions) {
    captured = null;
    await runRagQuery(root, { q: question.q, k: K });
    if (captured === null) {
      // tools.mjs emits rag.query inside a best-effort try/catch: a lost payload fails the run, it does not score 0.
      console.error(`[eval:rag] failed: no rag.query telemetry captured for ${question.id}; no results written`);
      return EXIT_UNCAPTURED;
    }
    rows.push({ id: question.id, ...scoreQuestion(captured, question.gold) });
  }

  const results = {
    eval: EVAL_ID,
    date,
    anchor: `@${sha}`,
    indexDigest,
    questionSet: questionSet.id,
    questionSetDigest: questionSetDigestOf(questionBytes),
    runner: "script",
    k: K,
    aggregate: aggregate(rows),
    rows,
  };
  if (!writeResultsAppendOnly(resultsFile, results)) {
    console.error(`[eval:rag] refused: ${path.relative(root, resultsFile)} exists; results are append-only`);
    return 3;
  }
  const a = results.aggregate;
  console.log(`[eval:rag] ${EVAL_ID} @${sha}: hit@5 ${a.hit5}/${a.n}, hit@10 ${a.hit10}/${a.n}, MRR@10 ${a.mrr10} -> ${path.relative(root, resultsFile)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[eval:rag] failed: ${err?.message}`);
      process.exit(1);
    },
  );
}
