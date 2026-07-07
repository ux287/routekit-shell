---
id: how-to.getting-started
title: Getting Started
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.450Z'
created: '2025-09-02T16:22:55.450Z'
---

# Getting Started with RouteKit Shell

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** - [Download from nodejs.org](https://nodejs.org/)
- **Git** - For version control
- **VS Code** - Recommended editor with Claude Code extension
- **Claude Code** - AI pair programming assistant

## Installation

### 1. Install RouteKit CLI

```bash
npm install -g @routekit/cli
```

### 2. Verify Installation

```bash
routekit --version
```

## Creating Your First Project

### 1. Initialize a New Project

```bash
routekit create my-app --template=web
cd my-app
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Development Server

```bash
npm run dev
```

Your app will be available at `http://localhost:5173`

## Project Structure Overview

```
my-app/
├── src/
│   ├── components/     # Reusable UI components
│   ├── pages/         # Route components
│   ├── utils/         # Utility functions
│   └── styles/        # CSS and styling
├── scripts/
│   ├── rag/          # RAG system for AI integration
│   └── mcp/          # MCP servers for Claude Code
├── notes/            # Dendron documentation vault
└── package.json      # Dependencies and scripts
```

## Key Features Out of the Box

### ✅ **Modern React Stack**

- React 18 with TypeScript
- Vite for fast development
- React Router for navigation

### ✅ **Design System**

- Tailwind CSS with custom design tokens
- Pre-built components from @routekit/design
- Consistent styling patterns

### ✅ **AI Integration**

- RAG system for documentation search
- MCP integration with Claude Code
- Automated content embedding

### ✅ **Development Tools**

- Hot module replacement
- TypeScript checking
- ESLint and Prettier

## Next Steps

1. **[Explore the Project Structure](routekit-shell.how-to.project-structure.md)** - Understand the generated files
2. **[Development Workflow](routekit-shell.how-to.development-workflow.md)** - Learn the daily development process
3. **[Design System](routekit-shell.how-to.design-system.md)** - Start building with components

## Common Commands

```bash
# Development
npm run dev              # Start dev server
npm run build           # Build for production
npm run preview         # Preview production build

# RAG System
npm run rag:init        # Initialize RAG database
npm run rag:embed       # Embed documentation
npm run rag:query       # Search documentation

# Utilities
npm run test            # Run tests
npm run lint            # Check code quality
```

## Troubleshooting

### Port Already in Use

If port 5173 is busy, Vite will automatically use the next available port.

### Module Not Found Errors

Ensure all dependencies are installed:

```bash
npm install
```

### RAG System Issues

Initialize the RAG system:

```bash
npm run rag:init
npm run rag:embed
```

---

**Next:** [Project Structure →](routekit-shell.how-to.project-structure.md)
