---
id: c1hm1iq6ket8doozgtix34m
title: Scripts
desc: Project structure documentation for RouteKit Shell
updated: '2025-09-02T16:22:55.442Z'
created: '2025-09-02T16:22:55.442Z'
---

# Scripts Directory Structure

## Directory Layout

```
scripts/
├── rag/              # RAG (Retrieval Augmented Generation)
│   ├── init.mjs      # Initialize vector database
│   ├── embed.mjs     # Embed documentation
│   ├── query.mjs     # Search embedded content
│   └── utils.mjs     # Project-agnostic utilities
└── mcp/              # Model Context Protocol servers
    └── rag-server.mjs # MCP server for Claude Code
```

## RAG System (`scripts/rag/`)

### Purpose

AI-powered documentation search and embedding system.

### Core Scripts

#### `init.mjs` - Database Initialization

- Creates LanceDB vector database
- Sets up tables and indexes
- Project-specific database naming

**Usage:**

```bash
npm run rag:init
```

#### `embed.mjs` - Document Processing

- Processes markdown files
- Creates text embeddings using Xenova transformers
- Stores in vector database

**Usage:**

```bash
npm run rag:embed
```

#### `query.mjs` - Semantic Search

- Searches embedded content
- Returns relevant documentation chunks
- Supports similarity scoring

**Usage:**

```bash
npm run rag:query -- "search term" 5
```

#### `utils.mjs` - Project Detection

- Auto-detects current project context
- Generates appropriate paths and patterns
- Handles project-specific configurations

### How RAG Works

1. **Document Processing**: Markdown files → text chunks
2. **Embedding**: Text chunks → vector embeddings
3. **Storage**: Embeddings stored in LanceDB
4. **Query**: Search query → relevant chunks

## MCP Integration (`scripts/mcp/`)

### Purpose

Model Context Protocol servers for Claude Code integration.

### `rag-server.mjs` - RAG MCP Server

Exposes RAG functionality to Claude Code through MCP protocol.

**Available Tools:**

- `rag_init` - Initialize database
- `rag_embed` - Embed documentation
- `rag_query` - Search embeddings

**Usage:**

```bash
npm run mcp:rag
```

### MCP Connection

Once running, Claude Code can access your documentation through:

1. Semantic search of your notes
2. Context-aware code suggestions
3. Documentation-informed responses

## Script Configuration

### Project-Agnostic Design

All scripts automatically detect:

- Current project slug
- Documentation patterns
- Database paths
- Vault locations

### Environment Variables

Scripts use project detection rather than environment variables:

```javascript
// Auto-detected paths
const context = getProjectContext();
// context.projectSlug: 'my-app'
// context.vaultPath: '/path/to/my-app/notes'
// context.ragDbPath: '/path/to/.routekit/rag/my-app.lancedb'
```

## Integration with Package.json

### Available Scripts

```json
{
  "scripts": {
    "rag:init": "node scripts/rag/init.mjs",
    "rag:embed": "node scripts/rag/embed.mjs", 
    "rag:query": "node scripts/rag/query.mjs",
    "mcp:rag": "node scripts/mcp/rag-server.mjs"
  }
}
```

### Common Workflow

```bash
# Setup RAG system
npm run rag:init
npm run rag:embed

# Start MCP server for Claude Code
npm run mcp:rag

# Search documentation
npm run rag:query -- "how to deploy" 3
```

---

**Next:** [Documentation Structure →](routekit-shell.how-to.project-structure.notes.md)
