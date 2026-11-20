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

Your `notes/` directory is embedded into a LanceDB vector index at `.rks/rag/{projectSlug}.lancedb`. The embedding pipeline runs on every `rks_rag_embed` call, after MCP write and commit paths, and after a `git commit` run through Claude Code's Bash tool (the `rag-embed-on-commit` hook). See [Embedding Lifecycle](#embedding-lifecycle) for the exact trigger paths and when each one is skipped.

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

Files are embedded by exactly three trigger paths:

1. **MCP write and commit paths.** When an rks MCP tool commits (for example a note write followed by its commit), it calls `runRagEmbed(projectRoot, { files: changedFiles })` for the files that commit changed. The embed is scoped to those files. It is skipped when `VITEST` or `RKS_SKIP_BACKGROUND_EMBED` is set (the result then carries `ragEmbedSkipped: true`). A note write through the rks MCP tools that is not made with `skipEmbed` starts its own background embed of that note (same `VITEST` / `RKS_SKIP_BACKGROUND_EMBED` skips); a write made with `skipEmbed` leaves the embed to the commit step.
2. **The `rag-embed-on-commit` Claude Code hook.** A Claude Code `PostToolUse` hook on the `Bash` tool. When a Bash call runs `git commit`, it starts a full embed in a detached background process. It is skipped when the commit message contains `[skip-rag]`, when the commit output contains error text (`error:`, `fatal:` or `Exit code`), when the commit changed no files, or when another process holds the embed lock. These skips are logged only to `.rks/rag/post-commit.log`.
3. **Explicit `rks_rag_embed`.** Calling the tool directly (or via `/ops rag embed`), optionally scoped with `files` or `glob`.

A commit made from a terminal, outside Claude Code and outside the rks MCP tools, triggers no embed: no hook sees it, so nothing is embedded until one of the three paths above runs.

### Reading per-file outcomes

`rks_rag_embed` returns a `fileOutcomes` entry per file it handled, with `embedded` and `reason`. `embedded: false` means "not embedded by this call", not "missing from the index". A file whose outcome is `reason: "unchanged"` also carries `alreadyCurrent: true`. `alreadyCurrent` means **manifest hash matches**: the file's current content hash equals the hash the embed manifest recorded at the file's last successful index, so there was nothing to re-embed. LanceDB rows are not re-queried for this decision, and the manifest and the table can diverge, so `alreadyCurrent` is not a guarantee that the file has rows in the index. Outcomes with any other reason (`not-selected`, `no-rows`, `excluded`, or an embedded file) have no `alreadyCurrent` field.

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
