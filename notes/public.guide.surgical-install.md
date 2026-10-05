---
id: 5oorwb590zvpvclzsd5hymr
title: Surgical Install Guide
desc: >-
  How to add rks to an existing project without disrupting it — foundation
  setup, MCP registration, notes directory, RAG init, and final validation.
updated: 1746843600000
created: 1746843600000
---

# Surgical Install Guide

A surgical install adds rks to an existing project without touching its working code. This guide covers the minimum steps: creating the rks configuration, registering the MCP server via `.mcp.json`, initializing the notes vault, seeding the RAG index, and validating the result.

## Prerequisites

- Existing project with working `npm run dev` or equivalent
- Node.js 20+ installed
- Git repository (recommended for rollback capability)
- routekit-shell-core cloned separately (rks source — see [[public.canon.getting-started]])

## What Gets Created

A surgical install adds the following to your project:

```
.rks/
  project.json          # rks project identity and config
  rag/
    {slug}.lancedb      # LanceDB vector index (gitignored)
    last-embed.json     # Timestamp of last embed run
.routekit/
  hooks/                # Claude Code hook scripts (enforcement layer)
  hooks-manifest.json   # Hook tier classification
.mcp.json               # MCP server declaration for Claude Code
notes/                  # Dendron notes vault
  {slug}.index.md       # Project index note
.env                    # API keys (copied from .env.example, never committed)
```

Nothing in your existing `src/`, `components/`, or application directories is touched.

## Phase 1 — Foundation

### 1.1 Create a working branch

```bash
git checkout -b feat/rks-install
```

### 1.2 Initialize rks project config

Run `rks_init` from Claude Code after connecting the MCP server (see Phase 2 first if MCP isn't connected yet):

```
rks_init { "projectId": "my-project", "projectTitle": "My Project" }
```

This creates `.rks/project.json` with project identity, default branch strategy, and RAG paths. It does **not** touch your application code.

## Phase 2 — MCP Registration

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "rks": {
      "command": "node",
      "args": ["/path/to/routekit-shell-core/packages/mcp-rks/bin/mcp-rks.mjs"],
      "env": {
        "ROUTEKIT_PROJECT_ROOT": "/absolute/path/to/your-project"
      }
    }
  }
}
```

**Key points:**
- `args` points to `packages/mcp-rks/bin/mcp-rks.mjs` inside the routekit-shell-core clone — not a local script
- `ROUTEKIT_PROJECT_ROOT` must be the absolute path to **your project** (the one being installed into), not the rks source
- All RAG tools are served by the `rks` MCP server via `mcp-rks.mjs` — no separate server process required

Reload the VS Code window after saving `.mcp.json`.

## Phase 3 — Notes Vault

Create the `notes/` directory and a minimal index note:

```bash
mkdir -p notes
```

Create `notes/{slug}.index.md`:

```yaml
---
id: {slug}.index
title: "{Project Title} Documentation"
desc: Main documentation hub for {Project Title}.
created: 1746843600000
updated: 1746843600000
---

# {Project Title}

Project documentation hub. Use rks_rag_query to search, or browse namespaces:

- `how-to.*` — Step-by-step guides
- `docs.*` — Technical reference
```

Replace `{slug}` and `{Project Title}` with your actual project slug and name.

## Phase 4 — RAG Init and First Embed

Initialize the vector database:

```
rks_rag_init { "projectId": "my-project" }
```

Then embed your notes:

```
rks_rag_embed { "projectId": "my-project" }
```

The database is created at `.rks/rag/{slug}.lancedb` — local to your project, isolated per-project in `.rks/rag/`.

## Phase 5 — Validation

Test the query pipeline:

```
rks_rag_query { "projectId": "my-project", "q": "getting started", "k": 3 }
```

If results come back, RAG is working. If you get 0 results, check that `notes/` has `.md` files and re-run `rks_rag_embed`.

Run the onboarder to complete setup:

```
/onboard
```

## Phase 6 — Commit

```bash
git add .rks/ .routekit/ .mcp.json notes/ .env.example
git commit -m "feat: surgical install of rks workflow system

- Add .rks/project.json with project identity and branch config
- Add .routekit/hooks/ enforcement layer
- Register rks MCP server in .mcp.json
- Initialize notes/ vault with project index
- Seed RAG index at .rks/rag/{slug}.lancedb"
```

Do not commit `.env` (contains secrets) or `.rks/rag/` (gitignored, regenerated on embed).

## Troubleshooting

**MCP server shows "Disabled" in Claude Code:**
- Check `~/.claude.json` for a conflicting empty `mcpServers: {}` entry for your project path
- Remove that entry or copy the server definition into it
- See [[public.canon.rks-config]] for the full diagnosis

**`rks_init` fails with "notes directory not found":**
- Verify `ROUTEKIT_PROJECT_ROOT` in `.mcp.json` points to your project (not the rks source)
- Create `notes/` manually and retry

**RAG embed fails with ONNX error:**
- Set `RKS_RAG_EMBEDDINGS_MODE=stub` to bypass ONNX and use zero-vector embeddings
- Results won't be semantically ranked but the pipeline will run

**No tools available in Claude Code:**
- Confirm MCP is connected: run `/mcp` in Claude Code
- Reload the VS Code window after `.mcp.json` changes

---

*Versioning sentinel: public.guide.surgical-install v1 — 2026-05-10. DB path: `.rks/rag/{projectSlug}.lancedb`. MCP entry: `.mcp.json` → `packages/mcp-rks/bin/mcp-rks.mjs`. Update this note when the install procedure or MCP registration changes.*
