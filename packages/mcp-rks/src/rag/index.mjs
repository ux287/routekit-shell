// Public import surface for the RAG module — a documented TWO-TIER contract.
//
// TIER 1 (PUBLIC, stable): the governed operations + the shared embedding pipeline. New code should
// depend only on these — import them from `../rag`.
//
// TIER 2 (TRANSITIONAL — internal/unstable): a small set of lower-level symbols still referenced by
// specific consumers. Do NOT add new dependents; these are slated to migrate onto the governed
// operations, after which they leave the barrel entirely.
//
// Everything else in rag/ (hybrid-search, fidelity-filter, source-classifier, notes-chunker, and the
// rag-columns internals such as RAG_REQUIRED_COLUMNS / normalizeRagRows) is IMPLEMENTATION DETAIL:
// import it directly from its source module for intra-rag/ use. It is intentionally NOT public API.

// ── Tier 1: public API ──
export * from './tools.mjs';
export * from './embedding-pipeline.mjs';

// ── Tier 2: transitional (referenced-but-internal — migrate onto governed ops, then remove) ──
// rag-context.mjs still composes the column contract directly.
export { missingRequiredColumns, selectableProjection, tableFieldNames } from './rag-columns.mjs';
// agents/research.mjs still infers query intent directly.
export { inferQueryIntent } from './query-intent.mjs';
