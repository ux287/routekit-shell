---
id: how-to.surgical-install
title: Surgical Install
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.440Z'
created: '2025-09-02T16:22:55.440Z'
---

# Surgical Install: Project Retrofitting

## Overview

A **surgical install** is the process of retrofitting an existing project with RouteKit Shell's RAG (Retrieval-Augmented Generation) and MCP (Model Context Protocol) capabilities without disrupting the existing application.

## Core Principles

### 1. **Zero Disruption**

- Existing application must remain fully functional
- `npm run dev` continues to work exactly as before
- No changes to existing source code or build processes
- No interference with current development workflow

### 2. **Isolated Integration**

- RAG and MCP components are added as separate, isolated systems
- New components live in dedicated directories (`.routekit/`, `notes/`, `scripts/`)
- No modifications to existing `package.json` dependencies unless explicitly required

### 3. **Additive Architecture**

- Only add new files and directories
- Existing files remain untouched
- New functionality is opt-in via separate commands

## Pre-Flight Safety Checklist

Before beginning any surgical install:

### ✅ Application State Verification

```bash
# Verify the app currently works
npm run dev
# → App should start successfully on expected port
# → All existing routes should work
# → No console errors

# Create snapshot of current working state
git status
git add -A
git commit -m "Pre-retrofit snapshot - working state"
```

### ✅ Backup Critical Files

```bash
# Backup package.json and lock files
cp package.json package.json.pre-retrofit
cp package-lock.json package-lock.json.pre-retrofit 2>/dev/null || true
cp yarn.lock yarn.lock.pre-retrofit 2>/dev/null || true
```

### ✅ Identify Potential Conflicts

- Check for existing `.routekit/` directory
- Check for existing `notes/` directory  
- Check for existing `scripts/rag/` or `scripts/mcp/`
- Review existing npm scripts that might conflict

## Installation Architecture

### Directory Structure Post-Install

```
existing-project/
├── [EXISTING FILES - UNTOUCHED]
├── src/           # ← Existing app code (untouched)
├── package.json   # ← May add new scripts only
├── 
├── .routekit/     # ← NEW: RouteKit configuration
│   ├── config.json
│   └── rag/
│       └── [project-slug].lancedb/
├── notes/         # ← NEW: Documentation vault
│   └── [project-slug].*.md
└── scripts/       # ← NEW: RAG and MCP utilities
    ├── rag/
    │   ├── embed.mjs
    │   └── query.mjs
    └── mcp/
        └── rag-server.mjs
```

### Installation Components

#### 1. **RAG System** (Read-Only Integration)

- **Purpose**: Enable AI-powered documentation search
- **Location**: `scripts/rag/`, `.routekit/rag/`
- **Interface**: New npm scripts (`rag:embed`, `rag:query`)
- **Impact**: Zero impact on existing app

#### 2. **MCP Servers** (External Services)

- **RAG Server**: Provide Claude Code with project context via documentation search
  - **Location**: `scripts/mcp/rag-server.mjs`
  - **Interface**: New npm script (`mcp:rag`)
  - **Namespace**: Uses unique name `routekit-rag-${projectSlug}` to avoid conflicts
- **Playwright Server**: Browser automation and testing capabilities  
  - **Package**: `@playwright/mcp` as dev dependency
  - **Interface**: New npm script (`mcp:playwright`)
  - **Namespace**: Uses unique name `routekit-playwright-${projectSlug}` to avoid conflicts
- **Impact**: Both run as separate processes, no app interference

#### 3. **Documentation Vault** (Isolated Notes)

- **Purpose**: Structured project documentation
- **Location**: `notes/[project-slug].*.md`
- **Interface**: Dendron-compatible hierarchy
- **Impact**: Completely separate from app source

## Safety Guarantees

### What Will NOT Be Modified

- ✅ Existing source code in `src/`
- ✅ Existing build configuration (`vite.config.js`, `webpack.config.js`, etc.)
- ✅ Existing dependencies in `package.json`
- ✅ Existing npm scripts (except additions)
- ✅ Existing routing and component structure
- ✅ Current development server behavior

### What WILL Be Added

- ➕ New directories: `.routekit/`, `notes/`, `scripts/`
- ➕ New npm scripts: `rag:embed`, `rag:query`, `mcp:rag`, `mcp:playwright`
- ➕ New dev dependencies: minimal AI/embedding packages, `@playwright/mcp`
- ➕ New documentation files in isolated namespace
- ➕ Project-specific `.mcp.json` configuration for dual MCP servers

### Rollback Strategy

Complete rollback is always available:

```bash
# Remove all RouteKit additions
rm -rf .routekit/ notes/ scripts/
git checkout package.json package-lock.json
npm install
npm run dev  # ← Back to original working state
```

## Risk Assessment

### **🟢 Low Risk Areas**

- Adding documentation files
- Adding utility scripts
- Adding npm scripts for optional features
- Adding configuration files

### **🟡 Medium Risk Areas**

- Installing new dev dependencies
- Adding VS Code workspace configuration
- Modifying `.gitignore`

### **🔴 High Risk Areas** (Avoided in Surgical Install)

- Modifying existing source code
- Changing build configuration
- Altering existing dependencies
- Modifying existing npm scripts
- **MCP server namespace conflicts** with existing RouteKit projects

### **🚨 Critical: MCP Namespace Management**

Each project **MUST** use unique MCP server names to prevent conflicts:

```javascript
// ✅ CORRECT: Project-specific naming
{
  "routekit-rag-${projectSlug}": {        // e.g., 'routekit-rag-aar-mro' 
    "command": "node",
    "args": ["scripts/mcp/rag-server.mjs"]
  },
  "routekit-playwright-${projectSlug}": { // e.g., 'routekit-playwright-aar-mro'
    "command": "npx", 
    "args": ["@playwright/mcp"]
  }
}

// ❌ WRONG: Generic naming causes conflicts
{
  "routekit-rag": { ... },      // Multiple projects collision
  "routekit-playwright": { ... } // Multiple projects collision  
}
```

**Global Config Cleanup**: Remove MCP servers from global Claude config:

```bash
# Backup and clean global config (if not done already)
cp ~/.claude.json ~/.claude.json.backup
cat ~/.claude.json | jq 'del(.mcpServers)' > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json
```

**Before Installation**: Check for running MCP servers:

```bash
ps aux | grep "rag-server" | grep -v grep
# Kill any conflicting servers before starting new ones
```

## Installation Phases

### Phase 1: Foundation Setup

1. Create `.routekit/config.json` with project metadata
2. Initialize `notes/` directory with project namespace
3. Add basic documentation structure

### Phase 2: RAG Integration  

1. Add RAG utility scripts (`scripts/rag/`)
2. Install minimal embedding dependencies
3. Add RAG-related npm scripts
4. Initialize vector database

### Phase 3: MCP Integration

1. Add MCP server script (`scripts/mcp/`)
2. Add MCP npm scripts
3. Test Claude Code integration

### Phase 4: Documentation Seeding

1. Generate initial documentation from existing README/docs
2. Create how-to guides for project-specific patterns
3. Embed documentation into RAG system

## Success Criteria

A surgical install is successful when:

✅ **Original app unchanged**: `npm run dev` works exactly as before  
✅ **RAG system functional**: `npm run rag:query "test"` returns results  
✅ **MCP servers operational**: Both `npm run mcp:rag` and `npm run mcp:playwright` start successfully  
✅ **Documentation accessible**: AI can query project context via RAG  
✅ **Browser automation ready**: Playwright MCP available for testing workflows  
✅ **Zero conflicts**: No interference with existing workflows  
✅ **Easy rollback**: Complete removal possible in under 30 seconds  

## Next Steps

After successful surgical install:

1. **Validate Installation** - Run through success criteria
2. **Team Onboarding** - Introduce new RAG/MCP capabilities  
3. **Documentation Evolution** - Gradually enhance project docs
4. **AI-Assisted Development** - Leverage enhanced context for coding

---

**Remember**: The goal is to enhance the project with AI capabilities while maintaining 100% compatibility with existing workflows. When in doubt, err on the side of caution and isolation.
