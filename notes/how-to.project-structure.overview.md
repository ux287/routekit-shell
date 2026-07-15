---
id: how-to.project-structure.overview
title: Overview
desc: Project structure documentation for RouteKit Shell
updated: '2025-09-02T16:22:55.443Z'
created: '2025-09-02T16:22:55.443Z'
---

# RouteKit Project Structure Overview

## Top-Level Structure

```
my-project/
├── src/                    # Application source code
├── scripts/               # Automation and tooling
├── notes/                 # Dendron documentation vault
├── public/                # Static assets
├── .vscode/              # VS Code workspace settings
├── package.json          # Dependencies and scripts
├── vite.config.ts        # Vite build configuration
├── tailwind.config.js    # Tailwind CSS configuration
├── tsconfig.json         # TypeScript configuration
└── README.md             # Project documentation
```

## Core Directories

### `src/` - Application Code

Contains all React components, pages, utilities, and styles.

### `scripts/` - Automation

RAG system, MCP servers, and other development scripts.

### `notes/` - Documentation

Hierarchical documentation using Dendron conventions.

## Key Files

### `package.json`

- Dependencies and devDependencies
- npm scripts for development and build
- Project metadata

### `vite.config.ts`

- Build tool configuration
- Plugin setup
- Development server settings

### `tailwind.config.js`

- CSS framework configuration
- Custom design tokens
- Component styling

### `tsconfig.json`

- TypeScript compiler settings
- Path mappings
- Strict type checking

## Design Principles

### Convention Over Configuration

- Predictable file locations
- Standard naming patterns
- Minimal configuration required

### AI-First Architecture

- RAG system for searchable documentation
- MCP integration for Claude Code
- Structured data formats

### Rapid Prototyping

- Hot module replacement
- Zero-config TypeScript
- Pre-configured tooling

---

**Next:** [Source Code Structure →](routekit-shell.how-to.project-structure.src.md)
