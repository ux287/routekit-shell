---
id: routekit-shell.figma-mcp.troubleshooting
title: Troubleshooting
desc: >-
  Complete troubleshooting log and next steps for Figma MCP server image export
  functionality
updated: '2025-09-02T20:20:51.029Z'
created: '2025-09-02T20:20:51.029Z'
---

# Figma MCP Server Troubleshooting & Progress

## Issue Summary

Figma MCP server `get_image` function returns `<output_image>` in conversation but saves empty placeholder files (70 bytes) instead of actual image data.

## Root Cause Identified

Missing `FIGMA_ACCESS_TOKEN` environment variable prevents MCP server from authenticating with Figma API for proper image export.

**Source**: [Figma MCP Troubleshooting Guide](https://github.com/TimHolden/figma-mcp-server/blob/main/examples/TROUBLESHOOTING.md)

## Current Status: ✅ READY FOR TESTING

### ✅ Completed Steps

1. **Frame Documentation Created**: `design.figma-frame-documentation.md` with full React/TypeScript code
2. **Asset Structure Created**: `assets.images.design.figma.popover-frame.md` with proper Dendron transclusion
3. **MCP Configuration Updated**: Added `FIGMA_ACCESS_TOKEN` to `.mcp.json`
4. **Access Token Added**: User provided Figma personal access token

### ⚠️ JSON Syntax Error Found

`.mcp.json` has malformed JSON due to line break in token string:

```json
"FIGMA_ACCESS_TOKEN": "REDACTED_FIGMA_TOKEN
"  // ← Line break here breaks JSON
```

## Next Steps After Restart

### 1. Fix JSON Configuration

```json
{
  "figma-dev-mode-mcp-server": {
    "type": "http", 
    "url": "http://127.0.0.1:3845/mcp",
    "env": {
      "FIGMA_ACCESS_TOKEN": "figd_xyz"
    }
  }
}
```

### 2. Restart VS Code Window

Required to reload MCP configuration with new token.

### 3. Test Image Export

```javascript
// Test command:
mcp__figma-dev-mode-mcp-server__get_image
nodeId: "13:1296" 
// Should now save actual image data instead of 70-byte placeholder
```

### 4. Verify Asset File

Check that `/notes/assets.images.design.figma.popover-frame.figma-popover-frame.png` contains actual image data (should be >1KB).

### 5. Update Documentation

Once image works, update `design.figma-frame-documentation.md` success checklist.

## Technical Context

### Current Figma Frame

- **Component**: Popover (shadcn/ui style)
- **Node ID**: 13:1296  
- **Dimensions**: 792 × 565px
- **Content**: Dimensions form interface with Width/Height inputs
- **Generated Code**: Complete React/TypeScript implementation available

### MCP Server Details

- **URL**: <http://127.0.0.1:3845/mcp>
- **Type**: HTTP server (not process-based)
- **Authentication**: Personal access token required
- **Image Format**: PNG export expected

## File Locations

- **Documentation**: `notes/design.figma-frame-documentation.md`
- **Asset Markdown**: `notes/assets.images.design.figma.popover-frame.md`
- **Asset File**: `notes/assets.images.design.figma.popover-frame.figma-popover-frame.png`
- **MCP Config**: `.mcp.json`

## Expected Result

After fixes, the Figma frame image should display properly in documentation via `![[assets.images.design.figma.popover-frame]]` transclusion, showing the actual Popover component UI instead of empty placeholder.

---
*Status: Ready for restart and testing*
