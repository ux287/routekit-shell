#!/usr/bin/env node

// ── CRITICAL: Redirect console.log to stderr for MCP stdio safety ──────
// MCP uses stdio transport — STDOUT is the JSON-RPC communication channel.
// ANY console.log (from our code OR dependencies like @xenova/transformers)
// corrupts the protocol, causing Claude Code to kill/restart the server.
// This must be the FIRST thing that runs, before any imports that might log.
const _origLog = console.log;
console.log = (...args) => console.error(...args);

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (3 levels up: bin -> mcp-rks -> packages -> root)
const projectRoot = path.resolve(__dirname, '..', '..', '..');
// Load project-specific .env first (ROUTEKIT_PROJECT_ROOT set via .mcp.json env section)
// dotenv.config does NOT override already-set env vars, so first call wins per variable.
const runtimeProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT;
if (runtimeProjectRoot) {
  dotenv.config({ path: path.join(runtimeProjectRoot, '.env') });
}
dotenv.config({ path: path.join(projectRoot, '.env') });

function readLocalPackage() {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

const pkg = readLocalPackage() || { name: 'mcp-rks', version: '0.0.0' };
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  // Use original console.log for CLI output (not MCP transport mode)
  _origLog(`${pkg.name} ${pkg.version}`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  _origLog(`${pkg.name} - lightweight MCP server shim\n\nUsage:\n  mcp-rks [--version] [--help]\n  npx mcp-rks\n\nThis package will attempt to start src/server.mjs if present.`);
  process.exit(0);
}

// Import the server module and start it explicitly.
// The module is now side-effect-free on import (composition-root refactor):
// startServer() performs hooks verification, lifecycle telemetry, project-agent
// init, and transport connection.
const serverPath = path.join(__dirname, '..', 'src', 'server.mjs');
import(serverPath)
  .then(({ startServer }) => startServer())
  .catch(err => {
    console.error('Failed to load/start src/server.mjs:', err.message);
    process.exit(1);
  });
