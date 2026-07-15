---
id: how-to.rag-integration.setup
title: Setup
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.440Z'
created: '2025-09-02T16:22:55.440Z'
---

# RAG System Setup

## Quick Setup

### 1. Initialize RAG Database

```bash
npm run rag:init
```

**What this does:**

- Creates LanceDB vector database
- Sets up embeddings table
- Configures project-specific paths

**Expected output:**

```
🎯 Detected project context: {
  projectSlug: 'my-app',
  vaultPath: '/path/to/my-app/notes',
  noteGlob: 'my-app.*',
  ragDbPath: '/path/to/.routekit/rag/my-app.lancedb'
}
✅ RAG database initialized successfully
```

### 2. Embed Documentation

```bash
npm run rag:embed
```

**What this does:**

- Processes all markdown files matching your project pattern
- Creates text embeddings using AI models
- Stores embeddings in the vector database

**Expected output:**

```
📚 Found 25 matching notes
🤖 Loading embedding model (Xenova/all-MiniLM-L6-v2)...
✅ Embedding model loaded
📄 Processing: my-app.how-to.getting-started.md
✂️  Created 4 chunks
...
🔢 Generated 120 total embeddings
✅ Embedding process completed successfully
```

### 3. Test the System

```bash
npm run rag:query -- "getting started" 3
```

**Expected output:**

```json
{
  "score": 0.85,
  "slug": "my-app.how-to.getting-started",
  "title": "Getting Started",
  "text": "Getting Started with My App..."
}
```

## Verification Steps

### Check Database Location

The database is stored at:

```
~/.routekit/rag/[project-slug].lancedb
```

### Verify Embeddings Count

After embedding, you should see a count like:

```
📊 Total embeddings in database: 120
```

### Test Query Relevance

Try different queries to test relevance:

```bash
npm run rag:query -- "button component" 5
npm run rag:query -- "deployment guide" 3
npm run rag:query -- "api documentation" 2
```

## Troubleshooting Setup

### Database Creation Fails

```bash
# Check permissions
ls -la ~/.routekit/rag/

# Manual cleanup and retry
rm -rf ~/.routekit/rag/[project-name].lancedb
npm run rag:init
```

### No Documents Found

```bash
# Check notes directory exists
ls notes/

# Verify naming pattern
ls notes/[project-slug].*

# Check for proper frontmatter
head notes/your-file.md
```

### Embedding Model Download Issues

The system downloads the embedding model on first run:

- Model: `Xenova/all-MiniLM-L6-v2`
- Size: ~90MB
- Location: Cached locally by Transformers.js

**If download fails:**

- Check internet connection
- Try running again (downloads resume)
- Clear cache: `rm -rf ~/.cache/transformers-cache`

### Memory Issues

For large documentation sets:

- The embedding process uses ~2GB RAM
- Processing happens in chunks to manage memory
- Consider smaller document sets for testing

---

**Next:** [Claude Code Integration →](routekit-shell.how-to.rag-integration.claude-code.md)
