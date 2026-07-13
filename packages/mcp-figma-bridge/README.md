# RouteKit Figma MCP stdio bridge

Figma Desktop exposes an MCP server over HTTP + Server-Sent Events (SSE) at `http://127.0.0.1:3845/mcp`. Many MCP clients can run stdio servers reliably but don’t consistently handle the HTTP+SSE session lifecycle.

This package provides a RouteKit-managed stdio MCP server that bridges to the local Figma MCP endpoint:

- Enforces the required `Accept: application/json, text/event-stream` header
- Performs `initialize` and captures `mcp-session-id`
- Replays `mcp-session-id` on subsequent calls
- Re-initializes once on `Invalid sessionId`

## Environment

- `FIGMA_MCP_URL` (default: `http://127.0.0.1:3845/mcp`)
- `FIGMA_MCP_PROTOCOL_VERSION` (default: `2024-11-05`)

## Running

From a vendored toolchain:

```bash
node tools/routekit-shell/packages/mcp-figma-bridge/src/server.mjs
```

