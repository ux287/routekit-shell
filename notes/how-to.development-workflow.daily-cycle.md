---
id: how-to.development-workflow.daily-cycle
title: Daily Cycle
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.454Z'
created: '2025-09-02T16:22:55.454Z'
---

# Daily Development Cycle

## Morning Setup

### 1. Start Development Session

```bash
# Terminal 1: Start the development server
npm run dev

# Terminal 2: Start the RAG system (if using Claude Code)
npm run mcp:rag
```

### 2. Verify Environment

- Check that `http://localhost:5173` loads
- Ensure hot reload is working
- Verify Claude Code MCP connection

## Planning Phase

### 3. Review Documentation

Search existing patterns before starting new work:

```bash
# Find existing patterns
npm run rag:query -- "button component" 5
npm run rag:query -- "authentication flow" 3
npm run rag:query -- "api integration" 5
```

### 4. Document Your Plan

Create or update documentation for your feature:

```bash
# Create feature documentation
echo "---
title: New Feature Plan
rag: true
---
# Feature Implementation Plan
..." > notes/my-app.docs.new-feature.md
```

## Development Phase

### 5. Implement with AI Assistance

With Claude Code connected via MCP, you can:

- **Ask contextual questions**: "How do I add a new route based on our existing patterns?"
- **Get component suggestions**: "Create a modal component following our design system"
- **Reference documentation**: Claude has access to your docs via RAG

### 6. Test as You Build

- Use hot reload for immediate feedback
- Test in browser continuously
- Run type checking: `npx tsc --noEmit`

## Documentation Phase

### 7. Document Your Changes

Add documentation that becomes immediately searchable:

```bash
# Update feature documentation
# Add implementation notes
# Document any decisions made

# Make it searchable
npm run rag:embed
```

## End of Day

### 8. Quality Check

```bash
# Check types
npx tsc --noEmit

# Run linting
npm run lint

# Test build
npm run build
```

### 9. Commit Changes

```bash
git add .
git commit -m "feat: add new feature

- Implemented X functionality
- Added documentation
- Updated tests"
```

## Troubleshooting Common Issues

### Development Server Won't Start

```bash
# Clear cache and restart
rm -rf node_modules/.vite
npm run dev
```

### Hot Reload Not Working

- Check for syntax errors in console
- Restart development server
- Clear browser cache

### MCP Connection Issues

```bash
# Restart MCP server
npm run mcp:rag

# Check Claude Code connection status
# Verify .vscode/settings.json configuration
```

---

**Next:** [AI-Assisted Development →](routekit-shell.how-to.development-workflow.ai-patterns.md)
