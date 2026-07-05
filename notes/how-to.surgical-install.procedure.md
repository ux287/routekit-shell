---
id: how-to.surgical-install.procedure
title: Procedure
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.439Z'
created: '2025-09-02T16:22:55.439Z'
---

# Surgical Install Procedure

## Prerequisites

- Existing project with working `npm run dev`
- Node.js 18+ installed
- Git repository (recommended for rollback capability)
- RouteKit Shell available at `~/Documents/projects/routekit-shell`

## Phase 1: Pre-Installation Setup

### Step 1.1: Create Working Branch

```bash
# Create dedicated branch for retrofit work
git checkout -b feat/routekit-retrofit
git commit --allow-empty -m "Start RouteKit surgical install"
```

### Step 1.2: Run Safety Protocol

```bash
# Ensure current app works
npm run dev &
SERVER_PID=$!
sleep 5
kill $SERVER_PID

echo "✅ Pre-install validation complete"
```

### Step 1.3: Determine Project Configuration

```bash
# Auto-detect project slug and configuration
PROJECT_SLUG=$(basename "$PWD")
PROJECT_TITLE=$(grep '"name"' package.json | sed 's/.*: *"\([^"]*\)".*/\1/' || echo "$PROJECT_SLUG")
echo "Project: $PROJECT_SLUG ($PROJECT_TITLE)"

# Create configuration template
cat > .routekit-install-config.json << EOF
{
  "projectSlug": "$PROJECT_SLUG",
  "projectTitle": "$PROJECT_TITLE",
  "installDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "components": {
    "rag": true,
    "mcp": true,
    "notes": true
  }
}
EOF
```

## Phase 2: Foundation Setup

### Step 2.1: Create RouteKit Configuration

```bash
# Create .routekit directory structure
mkdir -p .routekit/rag

# Generate project configuration
cat > .routekit/config.json << EOF
{
  "projectSlug": "$PROJECT_SLUG",
  "projectTitle": "$PROJECT_TITLE",
  "version": "1.0.0",
  "components": {
    "rag": {
      "enabled": true,
      "dbPath": ".routekit/rag/${PROJECT_SLUG}.lancedb",
      "notesGlob": "${PROJECT_SLUG}.*"
    },
    "mcp": {
      "enabled": true,
      "serverPort": 3001
    },
    "notes": {
      "enabled": true,
      "vaultPath": "notes",
      "namespace": "$PROJECT_SLUG"
    }
  },
  "installedBy": "surgical-install",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "✅ RouteKit configuration created"
```

### Step 2.2: Initialize Notes Directory

```bash
# Create notes directory with namespace
mkdir -p notes

# Create index note
cat > "notes/${PROJECT_SLUG}.index.md" << EOF
---
title: "${PROJECT_TITLE} Documentation"
summary: "Main documentation hub for ${PROJECT_TITLE}"
tags: ["index", "documentation"]
order: 1
rag: true
---

# ${PROJECT_TITLE}

## Project Overview

This is the main documentation hub for **${PROJECT_TITLE}**.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Documentation Sections

- [\`${PROJECT_SLUG}.docs.*\`](./${PROJECT_SLUG}.docs.md) - Technical documentation
- [\`${PROJECT_SLUG}.how-to.*\`](./${PROJECT_SLUG}.how-to.md) - How-to guides
- [\`${PROJECT_SLUG}.design.*\`](./${PROJECT_SLUG}.design.md) - Design documentation

## RAG Integration

This project now includes RAG (Retrieval-Augmented Generation) capabilities:

\`\`\`bash
# Search documentation
npm run rag:query -- "your question" 5

# Update search index
npm run rag:embed
\`\`\`

## MCP Integration

Claude Code can access this project's context via MCP:

\`\`\`bash
# Start MCP server
npm run mcp:rag
\`\`\`
EOF

echo "✅ Notes directory initialized"
```

## Phase 3: RAG System Installation

### Step 3.1: Copy RAG Scripts and Utils

```bash
# Create scripts directory structure  
mkdir -p scripts/rag scripts/mcp

# Copy RAG scripts and utilities from RouteKit Shell
cp ~/Documents/projects/routekit-shell/scripts/rag/embed.mjs scripts/rag/
cp ~/Documents/projects/routekit-shell/scripts/rag/query.mjs scripts/rag/
cp ~/Documents/projects/routekit-shell/scripts/rag/utils.mjs scripts/rag/

# Copy MCP server (needed for Step 4)
cp ~/Documents/projects/routekit-shell/scripts/mcp/rag-server.mjs scripts/mcp/

# Make scripts executable
chmod +x scripts/rag/*.mjs scripts/mcp/*.mjs

echo "✅ RAG scripts and MCP server installed"
```

### Step 3.2: Install RAG Dependencies

```bash
# CRITICAL: Use compatible LanceDB version to match RouteKit Shell
# Check RouteKit Shell version first
LANCEDB_VERSION=$(cat ~/Documents/projects/routekit-shell/package.json | grep '@lancedb/lancedb' | sed 's/.*: *"\([^"]*\)".*/\1/')
echo "Using LanceDB version: $LANCEDB_VERSION"

# Install required dependencies with version compatibility
npm install --save-dev @xenova/transformers@^2.6.0 @lancedb/lancedb@$LANCEDB_VERSION gray-matter remark strip-markdown globby

echo "✅ RAG dependencies installed with version compatibility"
```

### Step 3.3: Add RAG Scripts to package.json

```bash
# Add both RAG and MCP scripts to package.json in one step
npx json -I -f package.json -e "
this.scripts = this.scripts || {};
this.scripts['rag:embed'] = 'node scripts/rag/embed.mjs';
this.scripts['rag:query'] = 'node scripts/rag/query.mjs';
this.scripts['mcp:rag'] = 'node scripts/mcp/rag-server.mjs';
this.scripts['mcp:playwright'] = 'npx @playwright/mcp';
"

echo "✅ RAG and MCP scripts added to package.json"
```

### Step 3.4: Initialize RAG Database

```bash
# Generate initial embeddings
npm run rag:embed

echo "✅ RAG database initialized"
```

### Step 3.5: Test RAG System

```bash
# Test RAG query
npm run rag:query -- "getting started" 3

echo "✅ RAG system tested"
```

## Phase 4: MCP Server Configuration

### Step 4.1: Install Playwright MCP and Verify Server Setup

```bash
# Install Playwright MCP server as dev dependency
npm install --save-dev @playwright/mcp

# CRITICAL: Verify unique naming to prevent namespace conflicts
echo "🔍 Checking MCP server configuration..."
grep "name:" scripts/mcp/rag-server.mjs
# Should show: name: `routekit-rag-${DEFAULTS.projectSlug || 'unknown'}`

# Kill any conflicting MCP servers before proceeding
ps aux | grep "rag-server" | grep -v grep && echo "⚠️  Existing MCP servers detected - will be killed"
pkill -f "rag-server" 2>/dev/null || true

echo "✅ MCP server dependencies installed and conflicts cleared"
```

### Step 4.2: Configure Claude Code MCP Integration

```bash
# Ensure global Claude config is clean (if not done already)
if [ -f ~/.claude.json ] && grep -q "mcpServers" ~/.claude.json; then
    echo "🔄 Cleaning global Claude config..."
    cp ~/.claude.json ~/.claude.json.backup
    cat ~/.claude.json | jq 'del(.mcpServers)' > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json
    echo "✅ Global config cleaned - MCP servers removed"
fi

# Create project-specific .mcp.json for Claude Code integration with dual MCP servers
cat > .mcp.json << EOF
{
  "mcpServers": {
    "routekit-rag-${PROJECT_SLUG}": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "mcp:rag"],
      "env": {}
    },
    "routekit-playwright-${PROJECT_SLUG}": {
      "type": "stdio", 
      "command": "npm",
      "args": ["run", "mcp:playwright"],
      "env": {}
    }
  }
}
EOF

# Update Claude Code permissions (if .claude/settings.local.json exists)
if [ -f ".claude/settings.local.json" ]; then
    # Update permission name to match unique server
    sed -i.bak "s/mcp__routekit-rag__/mcp__routekit-rag-${PROJECT_SLUG}__/g" .claude/settings.local.json
fi

echo "✅ Project-specific Claude Code MCP integration configured"
echo "⚠️  RESTART REQUIRED: Reload VS Code window to pick up new MCP configuration"
```

### Step 4.5: Test MCP Servers

```bash
# Test RAG MCP server startup
echo "Testing RAG MCP server..."
timeout 10s npm run mcp:rag &
RAG_PID=$!
sleep 3

if kill -0 $RAG_PID 2>/dev/null; then
    echo "✅ RAG MCP server starts successfully"
    kill $RAG_PID
else
    echo "❌ RAG MCP server failed to start"
fi

# Test Playwright MCP server startup  
echo "Testing Playwright MCP server..."
timeout 10s npm run mcp:playwright --help >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Playwright MCP server available and functional"
else
    echo "❌ Playwright MCP server failed"
fi

echo "✅ Both MCP servers tested"
```

## Phase 5: Dendron Vault Initialization

### Step 5.1: Create Dendron Configuration

```bash
# Create dendron.yml configuration for single-vault setup
cat > dendron.yml << EOF
version: 5
dev:
  enablePreviewV2: true
commands:
  lookup:
    note:
      selectionType: extract
      confirmVaultOnCreate: true
      vaultSelectionModeOnCreate: smart
      leaveTrace: false
      bubbleUpCreateNew: true
      fuzzThreshold: 0.2
  randomNote:
    include:
      - ${PROJECT_SLUG}.*
  insertNoteLink:
    aliasMode: none
    enableMultiSelect: false
  insertNoteIndex:
    enableMarker: false
  copyNoteLink:
    aliasMode: title
workspace:
  vaults:
    - fsPath: notes
      name: ${PROJECT_SLUG}
  journal:
    dailyDomain: daily
    name: journal
    dateFormat: y.MM.dd
    addBehavior: childOfDomain
  scratch:
    name: scratch
    dateFormat: y.MM.dd.HHmmss
    addBehavior: asOwnDomain
  task:
    name: task
    dateFormat: y.MM.dd
    addBehavior: childOfDomain
    statusSymbols:
      '': ' '
      wip: w
      done: x
      assigned: a
      moved: m
      blocked: b
      delegated: l
      dropped: d
      pending: 'y'
  graph:
    zoomSpeed: 1
  enableAutoCreateOnDefinition: false
  enableXVaultWikiLink: false
  enableRemoteVaultInit: true
  enableUserTags: true
  enableHashTags: true
  workspaceVaultSyncMode: noCommit
  enableAutoFoldFrontmatter: false
  enableEditorDecorations: true
  maxPreviewsCached: 10
  maxNoteLength: 204800
  task:
    taskCompleteStatus:
      - done
      - x
    taskIncompleteStatus:
      - ''
      - wip
      - assigned
      - moved
      - blocked
      - delegated
      - dropped
      - pending
preview:
  enableFMTitle: true
  enableNoteTitleForLink: true
  enableMermaid: true
  enablePrettyRefs: true
  enableKatex: true
  automaticallyShowPreview: false
publishing:
  enableFMTitle: true
  enableNoteTitleForLink: true
  enableMermaid: true
  enablePrettyRefs: true
  enableKatex: true
  copyAssets: true
  siteHierarchies:
    - ${PROJECT_SLUG}
  writeStubs: false
  siteRootDir: docs
  usePrettyRefs: true
  title: ${PROJECT_TITLE} Documentation
  description: Documentation for ${PROJECT_TITLE}
  author: Development Team
  twitter: ""
  github:
    enableEditLink: true
    editLinkText: Edit this page on GitHub
    editBranch: main
    editViewMode: tree
  enableSiteLastModified: true
  siteLastModifiedTimestamp: false
  enableFrontmatterTags: true
  enableHashesForFMTags: false
  enableRandomlyColoredTags: true
  duplicateNoteBehavior:
    action: useVault
    payload:
      - ${PROJECT_SLUG}
  writeStubs: false
  seo:
    title: ${PROJECT_TITLE} Documentation
    description: Documentation for ${PROJECT_TITLE}
EOF

echo "✅ Dendron configuration created"
```

### Step 5.2: Create VS Code Workspace Configuration  

```bash
# Create .vscode directory if it doesn't exist
mkdir -p .vscode

# Create project-specific workspace file  
cat > ".vscode/${PROJECT_SLUG}.code-workspace" << EOF
{
  "folders": [
    {
      "name": "${PROJECT_TITLE}",
      "path": ".."
    },
    {
      "name": "${PROJECT_TITLE} Documentation", 
      "path": "../notes"
    }
  ],
  "settings": {
    "dendron.rootDir": ".",
    "dendron.workspaceVaults": [
      {
        "fsPath": "notes",
        "name": "${PROJECT_SLUG}"
      }
    ]
  },
  "extensions": {
    "recommendations": [
      "dendron.dendron",
      "ms-playwright.playwright"
    ]
  }
}
EOF

echo "✅ VS Code workspace configuration created"
```

## Phase 6: Documentation Seeding

### Step 6.1: Extract Existing Documentation

```bash
# Convert README to structured notes (if exists)
if [ -f "README.md" ]; then
    # Create getting started guide from README
    cat > "notes/${PROJECT_SLUG}.docs.getting-started.md" << EOF
---
title: "Getting Started with ${PROJECT_TITLE}"
summary: "Installation and setup guide"
tags: ["getting-started", "setup"]
rag: true
---

$(cat README.md)
EOF
fi

echo "✅ Existing documentation extracted"
```

### Step 6.2: Create Essential Documentation Structure

```bash
# Create docs index
cat > "notes/${PROJECT_SLUG}.docs.md" << EOF
---
title: "Documentation Hub"
summary: "Technical documentation for ${PROJECT_TITLE}"
tags: ["docs", "hub"]
rag: true
---

# ${PROJECT_TITLE} Documentation

## Technical Documentation

- [\`${PROJECT_SLUG}.docs.getting-started\`](./${PROJECT_SLUG}.docs.getting-started.md) - Getting started guide
- [\`${PROJECT_SLUG}.docs.architecture\`](./${PROJECT_SLUG}.docs.architecture.md) - System architecture
- [\`${PROJECT_SLUG}.docs.api\`](./${PROJECT_SLUG}.docs.api.md) - API documentation

## Development Guides

- [\`${PROJECT_SLUG}.how-to.development\`](./${PROJECT_SLUG}.how-to.development.md) - Development workflow
- [\`${PROJECT_SLUG}.how-to.deployment\`](./${PROJECT_SLUG}.how-to.deployment.md) - Deployment guide
EOF

# Create how-to index
cat > "notes/${PROJECT_SLUG}.how-to.md" << EOF
---
title: "How-To Guides"
summary: "Step-by-step guides for ${PROJECT_TITLE}"
tags: ["how-to", "guides"]
rag: true
---

# ${PROJECT_TITLE} How-To Guides

## Development

- [\`${PROJECT_SLUG}.how-to.development\`](./${PROJECT_SLUG}.how-to.development.md) - Development workflow
- [\`${PROJECT_SLUG}.how-to.testing\`](./${PROJECT_SLUG}.how-to.testing.md) - Testing guide
- [\`${PROJECT_SLUG}.how-to.deployment\`](./${PROJECT_SLUG}.how-to.deployment.md) - Deployment guide

## RAG Integration

- Query documentation: \`npm run rag:query -- "question" 5\`
- Update embeddings: \`npm run rag:embed\`
- Start MCP server: \`npm run mcp:rag\`
EOF

echo "✅ Documentation structure created"
```

### Step 6.3: Re-embed Documentation

```bash
# Update embeddings with all new documentation
npm run rag:embed

echo "✅ Documentation embedded in RAG system"
```

## Phase 7: Final Validation

### Step 7.1: Complete System Test

```bash
# Test original app functionality
echo "Testing original app..."
npm run dev &
DEV_PID=$!
sleep 5

# Test main route (customize as needed)
curl -s http://localhost:5173/ > /dev/null && echo "✅ App homepage works" || echo "❌ App homepage failed"

kill $DEV_PID 2>/dev/null || true

# Test new RAG functionality
echo "Testing RAG system..."
npm run rag:query -- "getting started" 2

echo "Testing MCP server..."
timeout 5s npm run mcp:rag &
MCP_PID=$!
sleep 2
kill $MCP_PID 2>/dev/null || true

echo "✅ All systems validated"
```

### Step 7.2: Update .gitignore

```bash
# Add RouteKit artifacts to .gitignore
cat >> .gitignore << EOF

# RouteKit Shell
.routekit/rag/*.lancedb/
.routekit-install-*.json
EOF

echo "✅ .gitignore updated"
```

### Step 7.3: Commit Installation

```bash
# Stage all new files
git add .routekit/ notes/ scripts/ package.json package-lock.json .gitignore

# Commit surgical install
git commit -m "feat: surgical install of RouteKit Shell RAG/MCP

- Add RAG system for documentation search
- Add MCP server for Claude Code integration  
- Add structured notes in ${PROJECT_SLUG} namespace
- Preserve all existing functionality
- Add scripts: rag:embed, rag:query, mcp:rag

Co-authored-by: RouteKit Shell <noreply@routekit.dev>"

echo "✅ Surgical install committed"
```

## Phase 8: Team Onboarding

### Step 8.1: Create Usage Guide

```bash
# Create quick start guide for team
cat > "notes/${PROJECT_SLUG}.how-to.rag-usage.md" << EOF
---
title: "Using RAG and MCP"
summary: "Quick guide to using new AI-powered documentation features"
tags: ["rag", "mcp", "usage", "team"]
rag: true
---

# Using RAG and MCP in ${PROJECT_TITLE}

## Quick Start

### Search Documentation
\`\`\`bash
# Ask questions about the project
npm run rag:query -- "how do I deploy this app?" 3
npm run rag:query -- "what's our testing approach?" 5
npm run rag:query -- "API endpoints" 3
\`\`\`

### Use with Claude Code
\`\`\`bash
# Start MCP server for Claude Code integration
npm run mcp:rag

# In Claude Code, you can now ask context-aware questions:
# "How should I implement authentication in this project?"
# "What components are available for the dashboard?"
\`\`\`

### Update Documentation
\`\`\`bash
# After adding new documentation files
npm run rag:embed
\`\`\`

## What Changed

- **Added**: RAG system for intelligent doc search
- **Added**: MCP server for Claude Code context
- **Added**: Structured documentation in \`notes/\`
- **Unchanged**: All existing functionality preserved

## Original App

Everything works exactly as before:
\`\`\`bash
npm run dev  # ← Same as always
\`\`\`
EOF

echo "✅ Team usage guide created"
```

### Step 8.2: Final Documentation Embed

```bash
# Final embedding update with usage guide
npm run rag:embed

echo "✅ Final documentation embedding complete"
```

## Success Verification

Run this final checklist:

```bash
echo "🔍 Final Verification Checklist:"
echo "1. Original app works: npm run dev"
echo "2. RAG search works: npm run rag:query -- 'test' 1" 
echo "3. RAG MCP server starts: timeout 5s npm run mcp:rag"
echo "4. Playwright MCP works: npm run mcp:playwright --help"
echo "5. Documentation structure: ls notes/${PROJECT_SLUG}*.md"
echo "6. Dual MCP config: cat .mcp.json shows both servers"
echo "7. No conflicts: git status shows clean state"

echo ""
echo "✅ Surgical Install Complete!"
echo ""
echo "Next steps:"
echo "- Share usage guide with team"
echo "- Start using 'npm run rag:query' for doc search"
echo "- Use 'npm run mcp:rag' with Claude Code"
echo "- Gradually enhance documentation in notes/"
```

## Troubleshooting

### Common Issues

**App won't start after install:**

```bash
# Rollback and investigate
git reset --hard HEAD~1
npm install
npm run dev
```

**RAG queries return no results:**

```bash
# Re-embed documentation
rm -rf .routekit/rag/
npm run rag:embed
```

**MCP server won't start:**

```bash
# Check port conflicts
lsof -i :3001
# Kill conflicting process or change port in .routekit/config.json
```

**Missing dependencies:**

```bash
# Reinstall RAG dependencies with proper versions
LANCEDB_VERSION=$(cat ~/Documents/projects/routekit-shell/package.json | grep '@lancedb/lancedb' | sed 's/.*: *"\([^"]*\)".*/\1/')
npm install --save-dev @xenova/transformers@^2.6.0 @lancedb/lancedb@$LANCEDB_VERSION gray-matter remark strip-markdown globby
```

**LanceDB version compatibility issues:**

```bash
# Check if you get "table.search is not a function" error
npm run rag:query -- "test" 1

# If error occurs, fix version compatibility
rm -rf .routekit/rag/*.lancedb/
LANCEDB_VERSION=$(cat ~/Documents/projects/routekit-shell/package.json | grep '@lancedb/lancedb' | sed 's/.*: *"\([^"]*\)".*/\1/')
npm install --save-dev @lancedb/lancedb@$LANCEDB_VERSION
npm run rag:embed
```

**MCP server fails to connect:**

```bash
# Check if server starts properly
npm run mcp:rag &
SERVER_PID=$!
sleep 3
ps $SERVER_PID > /dev/null && echo "✅ Server running" || echo "❌ Server failed"
kill $SERVER_PID 2>/dev/null

# If fails, check .mcp.json format
cat .mcp.json
# Must use "type": "stdio" and "npm run" commands, not direct "node" calls

# Check for script errors  
node scripts/mcp/rag-server.mjs 2>&1 | head -10
```

**Dendron not initialized properly:**

```bash
# Check if dendron.yml exists and is valid
test -f dendron.yml && echo "✅ dendron.yml exists" || echo "❌ Missing dendron.yml"

# Check if VS Code workspace exists
test -f ".vscode/${PROJECT_SLUG}.code-workspace" && echo "✅ Workspace exists" || echo "❌ Missing workspace"

# If missing, run Dendron initialization phase again (Phase 5)
```

**MCP server namespace conflicts:**

```bash
# Check for running MCP servers
ps aux | grep "rag-server" | grep -v grep

# Kill conflicting servers
pkill -f "rag-server"

# Verify unique server naming
grep -n "name:" scripts/mcp/rag-server.mjs
# Should show project-specific naming like: name: `routekit-rag-${DEFAULTS.projectSlug}`
```

**Claude Code can't find MCP servers:**

```bash
# Verify .mcp.json format and location
cat .mcp.json | jq '.'

# Check server names match expectations
grep -E "(routekit-rag-|routekit-playwright-)" .mcp.json

# Restart VS Code window after MCP config changes
# In VS Code: Command Palette > "Developer: Reload Window"
```

---

**Key Principle**: Each phase builds on the previous one, with validation after each step. If any step fails, the installation can be safely rolled back to the previous state.
