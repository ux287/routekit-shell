---
id: how-to.development-workflow
title: Development Workflow
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.452Z'
created: '2025-09-02T16:22:55.452Z'
---

# RouteKit Development Workflow

## The RouteKit Philosophy

RouteKit is designed for **AI-assisted rapid development**. Every tool and convention is optimized for:

- **Fast iteration cycles** - Get from idea to working code quickly
- **AI collaboration** - Seamless integration with Claude Code and other AI tools
- **Maintainable outcomes** - Code that scales beyond the prototype phase

## Daily Development Cycle

### 1. **Start Your Development Session**

```bash
# Terminal 1: Start the development server
npm run dev

# Terminal 2: Start the RAG system (if using Claude Code)
npm run mcp:rag
```

### 2. **Plan with Documentation**

Use the integrated RAG system to search existing patterns and documentation:

```bash
# Search for existing patterns
npm run rag:query -- "button component" 5
npm run rag:query -- "authentication flow" 3
```

### 3. **Build with AI Assistance**

With Claude Code connected via MCP, you can:

- **Ask questions about your codebase**: "How do I add a new route?"
- **Get contextual suggestions**: Claude has access to your documentation via RAG
- **Generate components**: "Create a modal component following our design system"

### 4. **Document as You Build**

Add documentation that becomes immediately searchable:

```bash
# Add notes about your new feature
echo "---
title: New Feature Documentation  
rag: true
---
# Feature Details..." > notes/my-app.docs.new-feature.md

# Make it searchable
npm run rag:embed
```

## AI-Assisted Development Patterns

### Pattern 1: **Documentation-Driven Development**

1. **Document first** - Write the API or component interface in markdown
2. **Embed documentation** - `npm run rag:embed` makes it searchable
3. **Implement with AI** - Claude Code can reference your documentation
4. **Iterate** - Update docs and re-embed as you refine

### Pattern 2: **Component Discovery and Reuse**

```bash
# Find existing components
npm run rag:query -- "button variations" 5

# Discover design patterns
npm run rag:query -- "form validation" 3

# Understand architecture decisions
npm run rag:query -- "why typescript" 2
```

### Pattern 3: **Context-Aware Code Generation**

With MCP integration, Claude Code understands:

- Your project structure
- Existing components and patterns  
- Design system conventions
- Documentation and decision history

## Development Commands Reference

### Core Development

```bash
npm run dev          # Start development server (Vite)
npm run build        # Production build
npm run preview      # Preview production build locally
npm test             # Run test suite
npm run lint         # Check code quality
```

### RAG System Management

```bash
npm run rag:init     # Initialize vector database
npm run rag:embed    # Process and embed documentation
npm run rag:query -- "search term" [limit]  # Search embeddings
```

### AI Integration

```bash
npm run mcp:rag      # Start MCP server for Claude Code
```

## File Watching and Hot Reload

RouteKit uses Vite's advanced hot module replacement (HMR):

- **React components** - Update instantly without losing state
- **CSS changes** - Applied immediately without page refresh
- **TypeScript errors** - Shown in both terminal and browser
- **Documentation changes** - Re-embed with `npm run rag:embed`

## Code Quality Workflow

### Automatic Formatting

RouteKit includes Prettier configuration that formats code on save.

### Type Safety

TypeScript is configured with strict checking:

```bash
# Check types without building
npx tsc --noEmit
```

### Linting

ESLint catches common issues:

```bash
npm run lint         # Check all files
npm run lint:fix     # Auto-fix issues where possible
```

## Testing Strategy

### Component Testing

```bash
# Run tests in watch mode during development
npm test -- --watch

# Run specific test file
npm test Button.test.tsx
```

### RAG System Testing

```bash
# Test document embedding
npm run rag:embed

# Verify search functionality
npm run rag:query -- "test query" 1
```

## Deployment Workflow

### 1. **Pre-deployment Checks**

```bash
npm run build        # Ensure clean build
npm run test         # Run full test suite
npm run rag:embed    # Update search index
```

### 2. **Build Optimization**

Vite automatically optimizes your build:

- Code splitting
- Asset optimization
- Tree shaking
- TypeScript compilation

### 3. **Preview Before Deploy**

```bash
npm run preview      # Test production build locally
```

## Debugging and Troubleshooting

### RAG System Issues

```bash
# Check database status
npm run rag:init

# Rebuild embeddings
rm -rf ~/.routekit/rag/[project-name].lancedb
npm run rag:init
npm run rag:embed
```

### Development Server Issues

```bash
# Clear Vite cache
rm -rf node_modules/.vite

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### MCP Connection Issues

1. Ensure Claude Code is running
2. Check MCP server logs: `npm run mcp:rag`
3. Verify `.vscode/settings.json` MCP configuration

## Advanced Workflows

### Multi-Agent Development

When working with multiple AI agents:

1. **Maintain context** - Keep documentation updated
2. **Use RAG search** - Help agents discover existing patterns
3. **Document decisions** - Capture architectural choices in searchable format

### Rapid Prototyping

For quick prototypes:

1. **Start with demo page** - Use `/demo` route for experiments
2. **Copy existing patterns** - Search with RAG for similar implementations
3. **Document discoveries** - Capture learnings for future projects

---

**Next:** [Design System →](routekit-shell.how-to.design-system.md)
