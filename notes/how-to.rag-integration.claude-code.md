---
id: azkwwpgfslrp42re59r6ntx
title: Claude Code
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.441Z'
created: '2025-09-02T16:22:55.441Z'
---

# Claude Code Integration

## MCP Server Setup

### 1. Start the MCP Server

```bash
npm run mcp:rag
```

**Expected output:**

```
🚀 Starting RAG MCP Server...
📡 Created stdio transport
✅ RAG MCP Server connected
📍 Server name: routekit-rag
🔧 Available tools: rag_init, rag_embed, rag_query
```

### 2. Keep Server Running

The MCP server needs to stay running while you use Claude Code:

- Run in a dedicated terminal
- Or use `screen`/`tmux` for background execution

## Claude Code Configuration

### VS Code Settings

Your `.vscode/settings.json` should include MCP server configuration:

```json
{
  "mcp.servers": {
    "routekit-rag": {
      "command": "npm",
      "args": ["run", "mcp:rag"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

### Verify Connection

1. Open VS Code in your project
2. Start Claude Code
3. Check for MCP tools availability
4. Look for "routekit-rag" in available tools

## Available RAG Tools

### `rag_init`

Initialize the vector database:

```
Parameters: 
- db (optional): Database path
```

### `rag_embed`

Embed project documentation:

```
Parameters:
- vault (optional): Notes directory path
- glob (optional): File pattern filter
- db (optional): Database path
```

### `rag_query`

Search embedded documentation:

```
Parameters:
- q (required): Search query
- k (optional): Number of results (default: 5)
- db (optional): Database path
```

## Using with Claude Code

### Context-Aware Questions

With RAG integration, Claude Code can answer questions about your project:

**You:** "How do I add a new page to this project?"

**Claude (with RAG):** Based on your project documentation, to add a new page:

1. Create component in `src/pages/NewPage.tsx`
2. Add route to `src/main.tsx`
3. Update navigation in `src/components/Layout.tsx`

[Reference: my-app.how-to.project-structure.src.md]

### Documentation Search

**You:** "What button variants are available?"

**Claude (with RAG):** Your design system includes these button variants:

- `primary` - Main call-to-action
- `secondary` - Supporting actions  
- `outline` - Subtle emphasis
- `ghost` - Minimal styling
- `destructive` - Dangerous actions

[Reference: my-app.how-to.design-system.buttons.md]

### Architecture Understanding

**You:** "How does the RAG system work in this project?"

**Claude (with RAG):** The RAG system processes documentation in three steps:

1. Document Processing: Markdown files → text chunks
2. Embedding: Text chunks → vector embeddings using Xenova transformers
3. Storage: Embeddings stored in LanceDB for semantic search

[Reference: my-app.how-to.project-structure.scripts.md]

## Best Practices

### Keep Documentation Current

```bash
# After adding/updating documentation
npm run rag:embed

# Verify new content is searchable
npm run rag:query -- "your new topic" 3
```

### Use Semantic Queries

```bash
# ✅ Good: Semantic and specific
npm run rag:query -- "button component styling" 5
npm run rag:query -- "deployment configuration" 3
npm run rag:query -- "authentication setup" 2

# ❌ Less effective: Vague or too broad
npm run rag:query -- "stuff" 5
npm run rag:query -- "help" 3
```

### Document as You Code

1. Write feature documentation
2. Embed immediately: `npm run rag:embed`
3. Ask Claude Code contextual questions
4. Iterate based on AI feedback

## Troubleshooting

### MCP Server Won't Start

```bash
# Check dependencies
npm install

# Verify script exists
npm run mcp:rag --dry-run

# Check port conflicts
lsof -i :3000  # or whatever port MCP uses
```

### Claude Code Not Finding Context

1. Verify MCP server is running
2. Check VS Code MCP configuration
3. Restart Claude Code extension
4. Re-embed documentation: `npm run rag:embed`

### Poor Search Results

```bash
# Re-initialize and re-embed
npm run rag:init
npm run rag:embed

# Test query manually
npm run rag:query -- "your search" 5
```

---

**Next:** [Advanced RAG Configuration →](routekit-shell.how-to.rag-integration.advanced.md)
