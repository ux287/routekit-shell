---
id: 9bvvg9jag8oigadk39q1rl2
title: RAG Usage Guide
desc: >-
  How to query the RAG index in rks projects — rks_rag_query vs /research,
  fidelity levels, hybrid search, and embedding lifecycle.
updated: 1746843600000
created: 1746843600000
---

# RAG Usage Guide

RAG (Retrieval-Augmented Generation) lets the Dispatcher and Research Agent search your project's notes by semantic similarity. This guide covers how to invoke RAG queries, when to use `rks_rag_query` versus `/research`, and how to control result fidelity.

## How RAG Works in rks

Your `notes/` directory is embedded into a LanceDB vector index at `.rks/rag/{projectSlug}.lancedb`. The embedding pipeline runs on every `rks_rag_embed` call and auto-runs after each commit via the `rag-embed-on-commit` system hook.

Queries return ranked chunks from your notes. Each result includes the source path, a similarity score, and note content at the requested fidelity level.

## `rks_rag_query` vs `/research`

Both surface note content, but they serve different purposes:

| | `rks_rag_query` | `/research` |
|---|---|---|
| **What it does** | Direct semantic search against the vector index | Launches a Research Governor agent that reads, cites, and synthesizes |
| **When to use** | You know what you're looking for and want raw results | You have an open question and need cited analysis |
| **Output** | Ranked chunks with scores | Inline answer or a research paper in `notes/` |
| **Cost** | Low (vector lookup only) | Higher (Governor agent turn) |
| **Best for** | Checking if a note exists, finding a specific pattern, confirming a fact | Investigating unknown behavior, comparing options, design research |

Use `rks_rag_query` when you need a fast lookup. Use `/research` when you need an answer synthesized from multiple sources.

## Fidelity Levels

RAG results are filtered by fidelity to prevent over-sharing sensitive content:

| Level | Name | Content returned |
|---|---|---|
| L0 | Metadata only | Note ID, title, path, score — no body text |
| L1 | Summary | First paragraph or `desc` frontmatter field |
| L2 | Redacted preview | Up to ~300 chars of body content (default for unauthenticated queries) |
| L3 | Full content | Complete note text (requires capability token) |

The default fidelity is L2. Pass `fidelity: 3` with a valid `capabilityToken` from `rks_governor_init` to receive full content.

## Invoking `rks_rag_query`

```json
{
  "projectId": "my-project",
  "q": "what is the branch strategy for staging",
  "k": 5,
  "fidelity": 2
}
```

**Parameters:**
- `q` — query text (required)
- `k` — number of results to return (default: 5)
- `fidelity` — 0–3 (default: 2)
- `intent` — optional hint: `"lookup"`, `"compare"`, `"explain"`
- `capabilityToken` — Governor token for L3 fidelity

## Hybrid Search

rks uses hybrid search by default: semantic vector similarity is combined with BM25 keyword matching. This means queries that include exact terms (like a function name or config key) will rank those exact matches higher even if semantic similarity is low.

To rely on keyword matching exclusively, include the exact term in quotes in your query:

```
q: '"ROUTEKIT_PROJECT_ROOT" env var purpose'
```

Hybrid search is automatic — no flags to set.

## Embedding Lifecycle

Notes are re-embedded when:
1. `rks_rag_embed` is called directly (or via `/ops rag embed`)
2. The `rag-embed-on-commit` hook fires after a git commit (system-tier, always active)

Check when embeddings were last updated:

```json
{ "tool": "rks_rag_query", "q": "last embed timestamp" }
```

Or inspect `.rks/rag/last-embed.json` for the `lastEmbedMs` timestamp.

## What Gets Embedded

Notes are included by default unless:
- The note has `rag: false` in frontmatter
- The note matches a default exclusion pattern (`z_archive.*`, `drafts.*`, `daily.*`)

Force-include a note with `rag: true` in frontmatter. The embed scope can be narrowed with `glob` or `files` options in `rks_rag_embed`.

## Troubleshooting

**No results returned:**
- Check `.rks/rag/` exists and has content: `ls .rks/rag/`
- Re-embed: call `rks_rag_embed` or run `/ops rag embed`
- Verify the note exists at `notes/` with correct frontmatter

**Results are stale:**
- Check `lastEmbedMs` in `.rks/rag/last-embed.json`
- Call `rks_rag_embed` to refresh

**ONNX model load failure at embed time:**
- Set `RKS_RAG_EMBEDDINGS_MODE=stub` to use a deterministic stub embedder (zero vectors, no ONNX dependency). Results will not be semantically meaningful but the pipeline will run. Use only for testing.

---

*Versioning sentinel: public.guide.rag-usage v1 — 2026-05-10. DB path: `.rks/rag/{projectSlug}.lancedb`. MCP entry: `.mcp.json` → `packages/mcp-rks/bin/mcp-rks.mjs`. Update this note when the embed path or query API changes.*
