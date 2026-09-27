# __title__
Scaffolded from routekit-shell. Replace this with real app instructions.

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Browser MCP Setup (Optional)
To enable AI browser automation, install the Browser MCP Chrome extension:

1. Visit [Browser MCP Chrome Extension](https://chromewebstore.google.com/detail/browser-mcp-automate-your/bjfgambnhccakkhmkepdoekmckoijdlc)
2. Click "Add to Chrome" to install
3. Pin the extension and ensure it's enabled
4. Browser MCP is already configured in `.mcp.json` and will work automatically with Claude Code

### 3. Notes Seeding
On project creation, RouteKit seeds **docs/** and **design/** notes from the shell's canonical vault into `./notes`, rewriting `routekit-shell` → your project slug.  
Re-run manually if needed:
```bash
node scripts/setup/post-init.mjs "$PROJECT_SLUG"
```

