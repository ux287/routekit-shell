#!/bin/bash
# onboard-child.sh - Automate child project setup after rks_init
# Usage: ../routekit-shell/scripts/onboard-child.sh

set -e

echo "RouteKit Child Project Onboarding"
echo "=================================="

# Check we're in a child project (has package.json with @routekit/mcp-rks dep)
if [ ! -f "package.json" ]; then
  echo "Error: No package.json found. Run this from your project root."
  exit 1
fi

if ! grep -q "@routekit/mcp-rks" package.json; then
  echo "Error: Not a RouteKit project (missing @routekit/mcp-rks dependency)"
  exit 1
fi

PROJECT_NAME=$(basename "$PWD")
echo "Project: $PROJECT_NAME"

# Step 1: Install dependencies
echo ""
echo "Step 1: Installing dependencies..."
npm install

# Step 2: Verify MCP server
echo ""
echo "Step 2: Verifying MCP server..."
if [ -f "node_modules/@routekit/mcp-rks/bin/mcp-rks.mjs" ]; then
  echo "MCP server binary found"
else
  echo "MCP server binary not found. Check npm install output."
  exit 1
fi

# Step 3: Project interview
echo ""
echo "Step 3: Project interview"
echo "   The first time you use Claude in this project, run the interview:"
echo "   rks_interview with projectId='$PROJECT_NAME'"
echo ""
echo "   This teaches Claude about your project type and tech stack."

# Step 4: Next steps (manual)
echo ""
echo "Step 4: Next steps (manual):"
echo "   1. Open this project in VSCode: code ."
echo "   2. Check MCP status: /mcp in Claude"
echo "   3. Run interview: rks_interview with projectId='$PROJECT_NAME'"
echo "   4. Embed notes: rks_rag_embed with projectId='$PROJECT_NAME'"
echo ""
echo "Onboarding complete! Open VSCode to continue."
