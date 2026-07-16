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
import {
  RECOGNIZED_CREDENTIAL_KEYS,
  resolveSources,
  formatProvenanceLines,
  checkRequiredCredential,
} from '../src/llm/credential-preflight.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (3 levels up: bin -> mcp-rks -> packages -> root)
const projectRoot = path.resolve(__dirname, '..', '..', '..');

// Bug 8: snapshot which recognized credential keys are ALREADY in process.env before dotenv runs.
// These are the ambient/shell keys (e.g. a ~/.zshenv export) — first-wins means they shadow any
// project .env value, so capturing them here is what lets the preflight attribute a key's source.
// Presence only — never store the value.
const shellCredentialSnapshot = {};
for (const key of RECOGNIZED_CREDENTIAL_KEYS) {
  if (process.env[key] !== undefined) shellCredentialSnapshot[key] = true;
}

// Load project-specific .env first (ROUTEKIT_PROJECT_ROOT set via .mcp.json env section)
// dotenv.config does NOT override already-set env vars, so first call wins per variable.
const runtimeProjectRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const orderedEnvSources = [];
if (runtimeProjectRoot) {
  const runtimeEnvPath = path.join(runtimeProjectRoot, '.env');
  const runtimeResult = dotenv.config({ path: runtimeEnvPath });
  orderedEnvSources.push({ path: runtimeEnvPath, parsed: runtimeResult.parsed || {} });
}
const rootEnvPath = path.join(projectRoot, '.env');
const rootResult = dotenv.config({ path: rootEnvPath });
orderedEnvSources.push({ path: rootEnvPath, parsed: rootResult.parsed || {} });

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

// Bug 8: credential preflight — runs only when actually starting the server (AFTER the
// --version/--help early exits, which must work without any credential). (1) Log the resolved
// SOURCE of each present credential key (shell env vs which .env path) so a shadowing shell export
// is a visible startup signal, not an opaque downstream auth error. (2) Fail fast if the required
// provider credential is missing. Values are never logged.
for (const line of formatProvenanceLines(resolveSources(shellCredentialSnapshot, orderedEnvSources))) {
  console.error(line);
}
try {
  checkRequiredCredential(process.env);
} catch (err) {
  console.error(`[preflight] ${err.message}`);
  process.exit(1);
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
