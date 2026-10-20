---
id: t38s5159rpjc08jar4l6ke3
title: RAG Setup Guide
desc: >-
  How to initialize and configure the RAG vector index for an rks project — MCP
  registration, first embed, ONNX troubleshooting.
updated: 1746843600000
created: 1746843600000
---

# RAG Setup Guide

This guide covers initializing the RAG vector index for a new rks project, registering the MCP server, running the first embed, and troubleshooting ONNX model load issues.

## Prerequisites

- rks installed and MCP server connected (see [[public.canon.getting-started]])
- `notes/` directory exists with at least one `.md` file
- `ANTHROPIC_API_KEY` set in `.env` (used by the embed pipeline's embedding model)

## Step 1 — Initialize the RAG Database

Call `rks_rag_init` from Claude Code:

```
rks_rag_init { "projectId": "my-project" }
```

This creates the LanceDB database at `.rks/rag/{projectSlug}.lancedb` and sets up the embeddings table. You only need to run this once per project.

**Expected output:**

```json
{
  "ok": true,
  "message": "RAG database initialized",
  "dbPath": ".rks/rag/my-project.lancedb"
}
```

## Step 2 — MCP Registration

The RAG tools are served by the `rks` MCP server — no separate RAG server is needed. The entry point is already declared in `.mcp.json`:

```json
{
  "mcpServers": {
    "rks": {
      "command": "node",
      "args": ["packages/mcp-rks/bin/mcp-rks.mjs"],
      "env": {}
    }
  }
}
```

All RAG operations (`rks_rag_init`, `rks_rag_embed`, `rks_rag_query`, `rks_rag_compact`) run through the `rks` MCP server — no separate RAG server process is needed.

After editing `.mcp.json`, reload the VS Code window (`Cmd+Shift+P → Developer: Reload Window`) to pick up the new server config.

## Step 3 — Embed Your Documentation

```
rks_rag_embed { "projectId": "my-project" }
```

This processes all notes matching your project's embed scope, creates text chunks, generates embeddings using the ONNX model (`Xenova/all-MiniLM-L6-v2`), and stores them in `.rks/rag/{projectSlug}.lancedb`.

**Expected output:**

```json
{
  "processedNotes": 25,
  "addedEmbeddings": 120,
  "skippedNotes": 3
}
```

After embedding completes, `.rks/rag/last-embed.json` is written with a `lastEmbedMs` timestamp.

## Step 4 — Verify the Index

```
rks_rag_query { "projectId": "my-project", "q": "getting started", "k": 3 }
```

A successful query returns ranked matches:

```json
{
  "matches": [
    {
      "score": 0.85,
      "path": "notes/public.canon.getting-started.md",
      "title": "Getting Started",
      "preview": "rks (RouteKit Shell) is an AI-native development workflow..."
    }
  ]
}
```

## Database Location

The LanceDB vector index lives at:

```
.rks/rag/{projectSlug}.lancedb
```

This is a project-local path — isolated per project, not stored in a global home-directory location. The `.rks/rag/` directory is gitignored by default.

## Keeping Embeddings Fresh

The `rag-embed-on-commit` system hook automatically re-embeds changed notes after each git commit. For manual refreshes:

```
rks_rag_embed { "projectId": "my-project", "glob": "public.*" }
```

Use `glob` to limit the embed scope to a subset of notes. Useful after bulk edits to one namespace.

## Compact the Index

After many embed runs, the LanceDB index accumulates version fragments. Compact periodically:

```
rks_rag_compact { "projectId": "my-project" }
```

Returns `beforeBytes`, `afterBytes`, and `reclaimedBytes`.

## Troubleshooting

### Database creation fails

Check that `.rks/` directory exists and is writable:

```bash
ls -la .rks/
```

If missing, `rks_init` creates it during onboarding. Running `rks_rag_init` again is safe.

### No documents found after embed

Verify notes exist and are not excluded:

```bash
ls notes/
```

Check frontmatter — notes with `rag: false` are skipped. Notes under `z_archive.*` or `drafts.*` are excluded by default.

### ONNX model load failure

The embed pipeline downloads `Xenova/all-MiniLM-L6-v2` (~90 MB) on first run. If this fails:

1. Check internet connection and retry
2. Clear the ONNX cache: `rm -rf ~/.cache/transformers-cache`
3. **Stub mode fallback:** set `RKS_RAG_EMBEDDINGS_MODE=stub` in your shell to use a deterministic zero-vector embedder. This bypasses ONNX entirely — results won't be semantically meaningful but the pipeline will run cleanly. Use only for testing or CI environments without ONNX support.

```bash
RKS_RAG_EMBEDDINGS_MODE=stub npx vitest run tests/unit/rag-*.spec.mjs
```

### Index size grows unexpectedly

Run `rks_rag_compact` to prune old version fragments. The auto-compact step runs after every `rks_rag_embed`, but manual compaction is useful after bulk operations.

---

*Versioning sentinel: public.guide.rag-setup v1 — 2026-05-10. DB path: `.rks/rag/{projectSlug}.lancedb`. MCP entry: `.mcp.json` → `packages/mcp-rks/bin/mcp-rks.mjs`. Update this note when the setup flow or DB path changes.*
