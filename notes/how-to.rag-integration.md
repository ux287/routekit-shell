---
id: fpjdsp6jvplw443mqy3bvss
title: Rag Integration
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.441Z'
created: '2025-09-02T16:22:55.441Z'
---

# RAG Integration with Claude Code

## What is RAG in RouteKit?

**RAG (Retrieval Augmented Generation)** allows Claude Code to search and reference your project's documentation during development. This creates a powerful AI pair programming experience where Claude has deep context about your codebase, patterns, and decisions.

## How It Works

1. **Document Embedding**: Your markdown documentation is converted into searchable embeddings
2. **Semantic Search**: When you ask Claude a question, it searches for relevant documentation
3. **Contextual Responses**: Claude provides answers based on your actual project documentation

## Quick Setup

### 1. Initialize the RAG System

```bash
# Initialize the vector database
npm run rag:init

# Embed your documentation
npm run rag:embed
```

**From MCP / Claude Code**

```
rks.rag_init { "projectId": "<project-id>" }
rks.rag_embed { "projectId": "<project-id>" }
```

### 2. Start the MCP Server

```bash
# Start the MCP server for Claude Code integration
npm run mcp:rag
```

### 3. Configure Claude Code

Ensure your `.vscode/settings.json` includes the MCP server configuration.

## RAG System Commands

### Core Commands

```bash
# Initialize vector database
npm run rag:init

# Process and embed all documentation
npm run rag:embed  

# Search documentation (for testing)
npm run rag:query -- "search term" [limit]

# Start MCP server for Claude Code
npm run mcp:rag
```

### Example Searches

```bash
# Find component patterns
npm run rag:query -- "button component" 3

# Search for setup instructions  
npm run rag:query -- "getting started" 5

# Look for deployment info
npm run rag:query -- "how to deploy" 2
```

**From MCP / Claude Code**

```
rks.rag_query { "projectId": "<project-id>", "q": "button component", "k": 3 }
```

### Embedding Stats Logs

Every `npm run rag:embed` / `routekit rag embed <projectId>` run now writes a JSON log under `.rks/rag/embeds/<timestamp>_<project>/stats.json`. Each file captures the vault/glob settings, timestamps, processed/embedded/skipped note counts, chunk totals, and the resulting embedding table size. Inspect the latest run with:

```bash
ls -dt .rks/rag/embeds/* | head -n1
cat $(find .rks/rag/embeds -maxdepth 2 -type f -name stats.json | sort | tail -n1)
```

These logs make it easy to audit embedding runs during the daily APE workflow and spot unexpected drops in coverage before the next MCP session.

## What Gets Embedded

### Included by Default

- All `.md` files matching your project pattern (e.g., `my-app.*`)
- Documentation in the `docs`, `design`, and `how-to` hierarchies
- Files with `rag: true` in frontmatter

### Excluded by Default

- Notes hierarchy (personal notes)
- Daily notes
- Prototype files
- Files with `rag: false` in frontmatter
- Anything under `z_archive.*` (archived or deprecated material)
- Anything under `drafts.*` (idea parking lot / not production ready)

### Controlling What Gets Embedded

#### Using Frontmatter

```yaml
---
title: My Documentation
rag: true   # Force include this file
---
```

```yaml
---
title: Private Notes
rag: false  # Exclude this file
---
```

#### Using File Patterns

The system automatically includes/excludes based on naming patterns:

```bash
✅ Included:
my-app.docs.api.md
my-app.how-to.setup.md  
my-app.design.components.md

❌ Excluded:
my-app.notes.meeting-notes.md
my-app.daily.2024.01.15.md
my-app.prototype.experiment.md
```

## Claude Code Integration

### What Claude Can Access

With RAG integration, Claude Code can:

- **Search your documentation** for relevant patterns and examples
- **Reference your design system** when suggesting components
- **Understand your architecture** decisions and conventions
- **Find existing solutions** to similar problems in your codebase

### Example Conversations

**You**: "How do I create a new page in this project?"

**Claude** (with RAG): Based on your project documentation, to create a new page you should:

1. Create a component in `src/pages/MyPage.tsx`
2. Add the route to `src/main.tsx`
3. Update navigation in `src/components/Layout.tsx`

### Best Practices for AI-Assisted Development

#### 1. Document as You Build

```bash
# Add documentation for new features
echo "# New Feature
Implementation details...
" > notes/my-app.docs.new-feature.md

# Make it searchable immediately
npm run rag:embed
```

#### 2. Use Semantic Naming

Write documentation that's easy to search:

```markdown
# ✅ Good: Semantic and searchable
## How to add authentication to routes
## Button component variations
## Deployment to Vercel

# ❌ Less helpful: Vague or too specific
## Stuff I tried today
## Fix for bug #123
## Random notes
```

#### 3. Structure Information Hierarchically

```
my-app.how-to.authentication.setup.md
my-app.how-to.authentication.protecting-routes.md
my-app.how-to.authentication.user-management.md
```

## Troubleshooting RAG Issues

### Common Problems

#### 1. No Search Results

```bash
# Check if database exists
ls ~/.routekit/rag/

# Reinitialize and re-embed
npm run rag:init
npm run rag:embed
```

#### 2. MCP Server Not Connecting

```bash
# Check server logs
npm run mcp:rag

# Verify Claude Code is running
# Check .vscode/settings.json configuration
```

#### 3. Documents Not Being Embedded

Check the embedding logs:

```bash
npm run rag:embed

# Look for messages like:
# ⏭️  Skipping excluded note (rag: false or pattern default)
```

### Debugging Commands

#### Check Database Status

```bash
npm run rag:init
# Should show: ✅ Connected to LanceDB
```

#### Verify Embeddings

```bash
npm run rag:query -- "test" 1
# Should return at least one result
```

#### Test MCP Connection

```bash
npm run mcp:rag
# Should show: ✅ RAG MCP Server connected
```

## Advanced Configuration

### Custom Embedding Patterns

Modify `scripts/rag/utils.mjs` to change which files get embedded:

```javascript
// Customize the getShouldEmbed function
function getShouldEmbed(relativePath, frontmatter) {
  // Your custom logic here
  if (relativePath.includes('private')) return false;
  if (frontmatter.rag === true) return true;
  // ... more rules
}
```

### Performance Tuning

For large documentation sets:

```bash
# Process only recently changed files
npm run rag:embed -- --incremental

# Limit chunk size for faster processing
# Edit CHUNK_SIZE in scripts/rag/embed.mjs
```

## Integration with Other Tools

### VS Code Workspace

The MCP server automatically integrates with your VS Code workspace, giving Claude Code access to:

- Project structure
- Documentation search
- Context-aware suggestions

### Documentation Workflow

```bash
# Daily workflow
1. Write documentation as you code
2. npm run rag:embed  # Make it searchable
3. Ask Claude questions referencing your docs
4. Iterate and improve based on AI feedback
```

## Security and Privacy

### What Data is Stored

- **Local only**: All embeddings are stored locally in `~/.routekit/rag/`
- **No cloud sync**: Your documentation never leaves your machine
- **Opt-in**: Only files you explicitly mark for RAG are embedded

### Sensitive Information

Use `rag: false` frontmatter to exclude sensitive documentation:

```yaml
---
title: API Keys and Secrets
rag: false  # Keep this private
---
```

---
