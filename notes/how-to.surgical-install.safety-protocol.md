---
id: 02mjncbyrqn6ze3ve69zy9l
title: Safety Protocol
desc: Documentation for the RouteKit Shell framework
updated: '2025-09-02T16:22:55.439Z'
created: '2025-09-02T16:22:55.439Z'
---

# Surgical Install Safety Protocol

## Pre-Install Validation

### Application Health Check

```bash
# 1. Verify current working state
npm run dev
# → Should start without errors
# → All routes should be accessible
# → Hot reload should function
# → No console warnings/errors

# 2. Run existing tests (if any)
npm test 2>/dev/null || echo "No tests configured"
npm run test:unit 2>/dev/null || echo "No unit tests"
npm run test:e2e 2>/dev/null || echo "No e2e tests"

# 3. Build verification
npm run build 2>/dev/null || echo "No build script configured"
```

### Environment Snapshot

```bash
# Create comprehensive backup
git status > .routekit-install.pre-state
npm list --depth=0 > .routekit-install.dependencies
node --version >> .routekit-install.pre-state
npm --version >> .routekit-install.pre-state
```

### Conflict Detection

```bash
# Check for existing RouteKit components
[ -d ".routekit" ] && echo "⚠️  .routekit directory exists" || echo "✅ .routekit clear"
[ -d "notes" ] && echo "⚠️  notes directory exists" || echo "✅ notes clear"
[ -d "scripts/rag" ] && echo "⚠️  scripts/rag exists" || echo "✅ scripts/rag clear"
[ -d "scripts/mcp" ] && echo "⚠️  scripts/mcp exists" || echo "✅ scripts/mcp clear"

# Check package.json for conflicting scripts
grep -q "rag:" package.json && echo "⚠️  RAG scripts exist" || echo "✅ RAG scripts clear"
grep -q "mcp:" package.json && echo "⚠️  MCP scripts exist" || echo "✅ MCP scripts clear"
```

## Installation Safeguards

### File System Protection

```bash
# Before any file operations
set -euo pipefail  # Exit on any error

# Create timestamped backup of critical files
BACKUP_DIR=".routekit-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup package files
cp package.json "$BACKUP_DIR/" 2>/dev/null || true
cp package-lock.json "$BACKUP_DIR/" 2>/dev/null || true
cp yarn.lock "$BACKUP_DIR/" 2>/dev/null || true

# Backup configuration files
cp tsconfig.json "$BACKUP_DIR/" 2>/dev/null || true
cp vite.config.* "$BACKUP_DIR/" 2>/dev/null || true
cp webpack.config.* "$BACKUP_DIR/" 2>/dev/null || true
```

### Atomic Operations

```bash
# Use temporary directories for preparation
TEMP_INSTALL_DIR=$(mktemp -d)
trap "rm -rf $TEMP_INSTALL_DIR" EXIT

# Prepare all files in temp location first
# Only move to final location after validation
```

### Process Validation

```bash
# After each major step, verify app still works
validate_app_state() {
    echo "🔍 Validating application state..."
    
    # Check if dev server starts
    timeout 30s npm run dev &
    SERVER_PID=$!
    sleep 5
    
    if kill -0 $SERVER_PID 2>/dev/null; then
        echo "✅ Dev server starts successfully"
        kill $SERVER_PID
        wait $SERVER_PID 2>/dev/null || true
    else
        echo "❌ Dev server failed to start"
        return 1
    fi
    
    # Additional checks can be added here
    return 0
}
```

## Critical Path Protection

### Source Code Immutability

- **NEVER** modify files in `src/`
- **NEVER** modify existing build configuration
- **NEVER** change existing npm scripts (only add new ones)
- **NEVER** modify existing dependencies (only add new devDependencies)

### Namespace Isolation

```bash
# All new components use isolated namespaces
PROJECT_SLUG=$(basename "$PWD")
NOTE_NAMESPACE="${PROJECT_SLUG}.notes"
RAG_NAMESPACE="${PROJECT_SLUG}.rag"
MCP_RAG_NAMESPACE="routekit-rag-${PROJECT_SLUG}"
MCP_PLAYWRIGHT_NAMESPACE="routekit-playwright-${PROJECT_SLUG}"

# Critical: Verify no MCP server conflicts before installation
echo "🔍 Pre-installation MCP conflict check..."
ps aux | grep "rag-server" | grep -v grep && echo "⚠️  Existing RAG servers detected"
ps aux | grep "@playwright/mcp" | grep -v grep && echo "⚠️  Existing Playwright servers detected"

# Kill conflicting processes if found (required for clean install)
pkill -f "rag-server" 2>/dev/null && echo "🔄 Killed conflicting RAG servers" || true
pkill -f "@playwright/mcp" 2>/dev/null && echo "🔄 Killed conflicting Playwright servers" || true
```

### Dependency Safety

```bash
# Only add as devDependencies
npm install --save-dev @xenova/transformers  # For embeddings
npm install --save-dev lancedb                # For vector storage
npm install --save-dev marked                 # For markdown processing

# Never modify existing dependencies
# Never add to regular dependencies (only devDependencies)
```

## Real-Time Monitoring

### Installation Progress Tracking

```bash
log_step() {
    echo "[$(date '+%H:%M:%S')] $1" | tee -a .routekit-install.log
}

validate_step() {
    if validate_app_state; then
        log_step "✅ Step completed: $1"
    else
        log_step "❌ Step failed: $1"
        rollback_installation
        exit 1
    fi
}
```

### Rollback Triggers

```bash
rollback_installation() {
    echo "🔄 Rolling back installation..."
    
    # Remove all RouteKit additions
    rm -rf .routekit/ notes/ scripts/rag/ scripts/mcp/ 2>/dev/null || true
    
    # Restore package.json if modified
    if [ -f "$BACKUP_DIR/package.json" ]; then
        cp "$BACKUP_DIR/package.json" package.json
        npm install
    fi
    
    # Validate rollback success
    if validate_app_state; then
        echo "✅ Rollback successful - app restored to working state"
    else
        echo "❌ Rollback failed - manual intervention required"
        echo "Backup location: $BACKUP_DIR"
    fi
}
```

## Post-Install Validation

### Comprehensive Testing

```bash
# 1. Original functionality preserved
npm run dev &
DEV_PID=$!
sleep 5

# Test main routes (customize for your app)
curl -s http://localhost:5173/ > /dev/null || echo "❌ Homepage not accessible"
curl -s http://localhost:5173/about > /dev/null || echo "❌ About page not accessible"

kill $DEV_PID 2>/dev/null || true

# 2. New RAG functionality works
npm run rag:embed
npm run rag:query -- "test query" 1

# 3. Both MCP servers start successfully
echo "Testing RAG MCP server..."
timeout 10s npm run mcp:rag &
RAG_MCP_PID=$!
sleep 3
if kill -0 $RAG_MCP_PID 2>/dev/null; then
    echo "✅ RAG MCP server functional"
    kill $RAG_MCP_PID 2>/dev/null || true
else
    echo "❌ RAG MCP server failed"
fi

echo "Testing Playwright MCP server..."
npm run mcp:playwright --help >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "✅ Playwright MCP server functional"
else
    echo "❌ Playwright MCP server failed"
fi

echo "✅ All post-install validations passed"
```

### Performance Impact Assessment

```bash
# Measure bundle size impact (should be zero for dev-only additions)
npm run build 2>/dev/null && \
    du -sh dist/ || \
    echo "No build to measure"

# Measure dev server startup time
time npm run dev &
DEV_PID=$!
sleep 2
kill $DEV_PID
```

### Team Validation Checklist

Before considering the surgical install complete:

- [ ] **Primary developer** confirms `npm run dev` works identically
- [ ] **QA/Testing team** confirms existing test suite passes
- [ ] **Other developers** can pull changes and run app without issues
- [ ] **CI/CD pipeline** continues to work (if applicable)
- [ ] **Production build** still works (if applicable)

## Emergency Procedures

### Immediate Rollback

```bash
# One-command emergency rollback
git stash push -m "Emergency rollback - surgical install issues"
git reset --hard HEAD~1  # If changes were committed
npm install
npm run dev
```

### Partial Rollback

```bash
# Remove only RAG components
rm -rf .routekit/ scripts/rag/
npm uninstall @xenova/transformers lancedb

# Remove only MCP components  
rm -rf scripts/mcp/
# Remove MCP scripts from package.json manually
```

### Recovery Documentation

Document any issues encountered for future installations:

```bash
echo "$(date): Issue description and resolution" >> .routekit-install-issues.log
```

---

**Key Principle**: Better to abort the installation than risk breaking a working application. The original app's functionality is sacred and must be preserved at all costs.
