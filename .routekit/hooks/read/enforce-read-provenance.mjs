#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce file operation provenance
 *
 * Blocks exploration-style file operations and requires RAG-based discovery.
 * Allows legitimate operations: pre-edit reads, RAG-sourced, user-specified, plan targets.
 *
 * Covers:
 *   - Read, Glob, Grep (discovery)
 *   - Edit, Write, NotebookEdit (modification)
 *   - Bash commands that bypass above (cat, sed, echo >, etc.)
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (message to stderr)
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { classifyReadIntent } from '../../node_modules/@routekit/mcp-rks/src/shared/read-classification.mjs';
import { recordRead, getRecentReads } from '../../node_modules/@routekit/mcp-rks/src/shared/session-state.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, '.routekit', 'read-policy.yaml');
const TELEMETRY_DIR = path.join(PROJECT_DIR, '.routekit', 'telemetry');

// File operation tools that need provenance
const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit'];

// Bash patterns that bypass file tools
const BASH_READ_PATTERNS = [
  /\bcat\s+["']?([^\s|>"']+)/,
  /\bhead\s+(?:-[n0-9]+\s+)?["']?([^\s|>"']+)/,
  /\btail\s+(?:-[n0-9f]+\s+)?["']?([^\s|>"']+)/,
  /\bless\s+["']?([^\s|>"']+)/,
  /\bmore\s+["']?([^\s|>"']+)/,
];

const BASH_EDIT_PATTERNS = [
  /\bsed\s+(?:-[ie]+\s+)?['"]?[^'"]+['"]?\s+["']?([^\s|>"']+)/,
  /\bawk\s+.*\s+["']?([^\s|>"']+)/,
];

const BASH_WRITE_PATTERNS = [
  /\becho\s+.*>\s*["']?([^\s"']+)/,
  /\btee\s+(?:-a\s+)?["']?([^\s|>"']+)/,
  />\s*["']?([^\s"']+)/,
];

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      provenance_enforcement: {
        enabled: true,
        mode: 'warn',
        runtime_paths: ['.routekit/*.yaml', 'package.json', 'tsconfig.json'],
        strict_rag_paths: ['/notes/', '/docs/']
      }
    };
  }
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function emitTelemetry(event) {
  try {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    const logPath = path.join(TELEMETRY_DIR, 'provenance-blocks.log');
    fs.appendFileSync(logPath, JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n');
  } catch (e) {
    // Best effort
  }
}

/**
 * Detect file operations in Bash commands
 * Returns: { detected: bool, operation: 'read'|'edit'|'write', path: string, command: string }
 */
function detectBashFileOp(command) {
  if (!command) return null;

  // Skip git commands - they're version control, not file bypass
  if (/^\s*git\s+/.test(command)) return null;

  // Skip npm/node/pnpm commands
  if (/^\s*(npm|node|pnpm|npx)\s+/.test(command)) return null;

  // Skip ls commands (directory listing is allowed)
  if (/^\s*ls\s+/.test(command)) return null;

  // Helper: check if extracted path looks like a real file (not a flag)
  function isFilePath(p) {
    if (!p) return false;
    // Not a flag (starts with -)
    if (p.startsWith('-')) return false;
    // Not a bare number
    if (/^\d+$/.test(p)) return false;
    // Has some file-like structure
    return /[a-zA-Z]/.test(p);
  }

  for (const pattern of BASH_READ_PATTERNS) {
    const match = command.match(pattern);
    if (match && match[1] && isFilePath(match[1])) {
      return { detected: true, operation: 'read', path: match[1], command: command.slice(0, 60) };
    }
  }

  for (const pattern of BASH_EDIT_PATTERNS) {
    const match = command.match(pattern);
    if (match && match[1] && isFilePath(match[1])) {
      return { detected: true, operation: 'edit', path: match[1], command: command.slice(0, 60) };
    }
  }

  for (const pattern of BASH_WRITE_PATTERNS) {
    const match = command.match(pattern);
    if (match && match[1] && isFilePath(match[1])) {
      return { detected: true, operation: 'write', path: match[1], command: command.slice(0, 60) };
    }
  }

  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Check guardrails escape hatch
  if (process.env.RKS_GUARDRAILS === 'off') {
    process.exit(0);
  }

  const config = loadConfig();
  if (!config.provenance_enforcement?.enabled) {
    process.exit(0);
  }

  let targetPath = null;
  let bashFileOp = null;
  let effectiveTool = toolName;

  // Handle Bash commands that bypass file tools
  if (toolName === 'Bash') {
    bashFileOp = detectBashFileOp(toolInput.command);
    if (!bashFileOp) {
      process.exit(0); // Not a file operation bash command
    }
    targetPath = bashFileOp.path;
    effectiveTool = `Bash(${bashFileOp.operation})`;
  } else if (FILE_TOOLS.includes(toolName)) {
    targetPath = toolInput.file_path || toolInput.path || toolInput.pattern || toolInput.notebook_path;
  } else {
    process.exit(0); // Not a file operation tool
  }

  if (!targetPath) {
    process.exit(0);
  }

  // Classify the read intent
  const result = classifyReadIntent({
    targetPath,
    toolName: effectiveTool,
    toolInput,
    config: config.provenance_enforcement
  });

  // Record for history
  recordRead(targetPath, result.reason);

  // Get recent context for block message
  const recentReads = getRecentReads ? getRecentReads(5) : [];

  // Emit telemetry with full context
  emitTelemetry({
    tool: effectiveTool,
    originalTool: toolName,
    path: targetPath,
    allowed: result.allowed,
    reason: result.reason,
    confidence: result.confidence,
    explorationScore: result.metadata?.explorationScore || 0,
    bashCommand: bashFileOp?.command || null,
    recentContext: recentReads.map(r => ({ path: r.path, reason: r.reason }))
  });

  if (result.allowed) {
    process.exit(0);
  }

  // Block or warn based on mode
  const mode = config.provenance_enforcement.mode;
  const message = formatBlockMessage(result, targetPath, effectiveTool, bashFileOp, recentReads);

  if (mode === 'block') {
    process.stderr.write(message);
    process.exit(2);
  } else {
    // Warn mode - log but allow
    process.stderr.write(`\n⚠️  [WARN] ${message.replace(/⛔/g, '⚠️')}`);
    process.exit(0);
  }
}

function formatBlockMessage(result, targetPath, tool, bashFileOp, recentReads) {
  const lines = [
    '',
    `⛔ File operation blocked: ${result.reason}`,
    `   Tool: ${tool}`,
    `   Path: ${targetPath}`,
    `   Confidence: ${(result.confidence * 100).toFixed(0)}%`,
    ''
  ];

  if (bashFileOp) {
    lines.push(`   🔍 Detected bash bypass: ${bashFileOp.command}...`);
    lines.push(`   → Use the proper ${bashFileOp.operation === 'read' ? 'Read' : bashFileOp.operation === 'edit' ? 'Edit' : 'Write'} tool with RAG provenance`);
    lines.push('');
  }

  if (result.suggestion) {
    lines.push(`   💡 ${result.suggestion}`);
    lines.push('');
  }

  // Show recent context that led to this block
  if (recentReads && recentReads.length > 0) {
    lines.push('   📋 Recent file operations (context):');
    for (const r of recentReads.slice(-3)) {
      lines.push(`      • ${r.reason}: ${r.path}`);
    }
    lines.push('');
  }

  lines.push('   ✅ Legitimate patterns:');
  lines.push('   • RAG query returns path → then read/edit that file');
  lines.push('   • User explicitly mentions path → read/edit that file');
  lines.push('   • Plan step targets file → read before editing');
  lines.push('');
  lines.push('   📊 This block is logged for workflow optimization.');
  lines.push('      If this operation should be supported, the pattern will be analyzed.');
  lines.push('');

  return lines.join('\n');
}

main().catch(err => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
