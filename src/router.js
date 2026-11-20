import { fsSearch } from "./retrievers/fs.js";
import { ragSearch } from "./retrievers/rag.js";
export async function retrieveWithRouting(query, cfg, guard, context = {}) {
    const start = classify(query, cfg);
    const trace = [];
    const errors = [];
    let fsHits = [];
    let ragHits = [];
    if (start === "fs") {
        fsHits = await safeFsSearch(query, cfg.budget.fs_first, trace, errors, context.searchDirs);
        trace.push({ step: "fs-first", hits: fsHits.length });
        if (shouldEscalate(fsHits, cfg)) {
            ragHits = await ragSearch(query, {
                k: cfg.budget.rag_first.k,
                t: cfg.budget.rag_first.time_ms,
                db: context.ragDbPath,
                source: context.ragSource || "rag",
                context: { projectSlug: context.projectSlug }
            });
            trace.push({ step: "rag-escalate", hits: ragHits.length });
        }
    }
    else {
        ragHits = await ragSearch(query, {
            k: cfg.budget.rag_first.k,
            t: cfg.budget.rag_first.time_ms,
            db: context.ragDbPath,
            source: context.ragSource || "rag",
            context: { projectSlug: context.projectSlug }
        });
        trace.push({ step: "rag-first", hits: ragHits.length });
        if (shouldEscalate(ragHits, cfg)) {
            fsHits = await safeFsSearch(query, cfg.budget.fs_first, trace, errors, context.searchDirs);
            trace.push({ step: "fs-escalate", hits: fsHits.length });
        }
    }
    let merged = dedupeAndRank([...fsHits, ...ragHits], cfg, guard);
    merged = enforceCanon(merged, cfg);
    const top = merged.slice(0, cfg.thresholds.max_total_passages);
    const fsCount = fsHits.length;
    const ragCount = ragHits.length;
    return {
        passages: top,
        trace,
        errors,
        TRACE: `ROUTER start=${start} fs=${fsCount} rag=${ragCount} escalated=${(fsCount && ragCount) ? "yes" : "no"}`
    };
}
function classify(q, cfg) {
    const pathRe = new RegExp(cfg.routing.fs_triggers[0].regex);
    const errRe = new RegExp(cfg.routing.fs_triggers[1].regex);
    const fsWord = containsAny(q, cfg.routing.fs_triggers[2].contains_any);
    const ragWord = containsAny(q, cfg.routing.rag_triggers[0].contains_any);
    const longish = (q.trim().split(/\s+/).length) >= (cfg.routing.rag_triggers[1].min_words || 8);
    if ((pathRe.test(q) || errRe.test(q) || fsWord) && !(ragWord || longish))
        return "fs";
    return "rag";
}
function shouldEscalate(hits, cfg) {
    const min = Math.min(cfg.thresholds.lexical_score_min, cfg.thresholds.semantic_score_min);
    const good = hits.filter(h => h.score >= min);
    return hits.length < cfg.thresholds.escalate_if_fewer_than_hits || good.length === 0;
}
function dedupeAndRank(all, _cfg, _guard) {
    const byKey = new Map();
    for (const p of all) {
        const key = `${p.path}:${p.line_start ?? 0}-${p.line_end ?? 0}:${hash(p.text.slice(0, 120))}`;
        if (!byKey.has(key))
            byKey.set(key, p);
    }
    return [...byKey.values()].sort((a, b) => b.score - a.score);
}
function enforceCanon(passages, cfg) {
    const prefer = cfg.priority.canonical || [];
    const depr = cfg.priority.deprioritize || [];
    const bump = (p) => (prefer.some((glob) => match(p.path, glob)) ? 0.15 : 0) -
        (depr.some((glob) => match(p.path, glob)) ? 0.10 : 0);
    return passages
        .map(p => ({ ...p, score: Math.min(1, p.score + bump(p)) }))
        .sort((a, b) => b.score - a.score);
}
// helpers
function containsAny(q, words) { return words?.some(w => q.toLowerCase().includes(w.toLowerCase())); }
function match(path, glob) { const g = glob.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"); return new RegExp("^" + g + "$").test(path); }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++)
    h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }
async function safeFsSearch(query, budget, trace, errors, searchDirs) {
    const result = await fsSearch(query, { k: budget.k, t: budget.time_ms, searchDirs });
    if (Array.isArray(result))
        return result;
    if (result?.error) {
        const payload = {
            source: result.error.source || "fs",
            code: result.error.code || "FS_ERROR",
            message: result.error.message || "File system search failed",
        };
        errors.push(payload);
        trace.push({ step: "fs-error", error: payload });
    }
    return [];
}
