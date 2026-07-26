#!/usr/bin/env node

/**
 * Query Logger for Guardrailed Retriever Stack Learning System
 * 
 * Logs Claude's tool usage patterns, routing decisions, and context quality
 * to enable learning and optimization of the contextual intelligence system.
 */

import fs from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Learning system paths
const LEARNING_BASE_PATH = join(homedir(), '.routekit', 'learning');
const QUERY_LOGS_PATH = join(LEARNING_BASE_PATH, 'query-logs');

// Project context detection
function detectProjectContext(workingDir = process.cwd()) {
  if (workingDir.includes('UX287')) return 'ux287';
  if (workingDir.includes('routekit-shell')) return 'routekit-shell';
  if (workingDir.includes('traders')) return 'traders';
  return 'unknown';
}

// Generate session ID (simple timestamp-based for now)
let currentSessionId = null;
function getSessionId() {
  if (!currentSessionId) {
    currentSessionId = `claude-${Date.now()}`;
  }
  return currentSessionId;
}

/**
 * Log a query interaction with full context
 */
export async function logQuery({
  query,
  toolSequence = [],
  routingReason = 'unknown',
  contextQuality = 'unknown',
  userFeedback = null,
  workingDirectory = process.cwd()
}) {
  try {
    const projectContext = detectProjectContext(workingDirectory);
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId: getSessionId(),
      query,
      toolSequence,
      routingReason,
      contextQuality,
      userFeedback,
      projectContext,
      workingDirectory
    };

    // Write to project-specific log file
    const logFile = join(QUERY_LOGS_PATH, `${projectContext}.jsonl`);
    const logLine = JSON.stringify(logEntry) + '\n';
    
    await fs.appendFile(logFile, logLine, 'utf8');
    
    console.error(`🔍 Logged query: ${query.slice(0, 50)}... → ${projectContext}`);
    
    return logEntry;
    
  } catch (error) {
    console.error('❌ Failed to log query:', error.message);
    return null;
  }
}

/**
 * Log a tool call with timing and parameters
 */
export async function logToolCall(toolName, params = {}, duration = 0, success = true) {
  const toolCall = {
    tool: toolName,
    params,
    duration,
    success,
    timestamp: new Date().toISOString()
  };
  
  // Store in current session for aggregation
  if (!global.currentToolSequence) {
    global.currentToolSequence = [];
  }
  global.currentToolSequence.push(toolCall);
  
  return toolCall;
}

/**
 * Start a new query session
 */
export function startQuerySession(query) {
  global.currentQuery = query;
  global.currentToolSequence = [];
  global.queryStartTime = Date.now();
  console.error(`🚀 Starting query session: ${query.slice(0, 80)}...`);
}

/**
 * End query session and log results
 */
export async function endQuerySession({
  routingReason = 'automatic',
  contextQuality = 'medium',
  userFeedback = null
}) {
  if (!global.currentQuery) {
    console.error('⚠️ No active query session to end');
    return null;
  }
  
  const totalDuration = Date.now() - global.queryStartTime;
  
  const result = await logQuery({
    query: global.currentQuery,
    toolSequence: global.currentToolSequence || [],
    routingReason,
    contextQuality,
    userFeedback,
    totalDuration
  });
  
  // Clean up session
  global.currentQuery = null;
  global.currentToolSequence = [];
  global.queryStartTime = null;
  
  console.error(`✅ Query session complete (${totalDuration}ms)`);
  return result;
}

/**
 * Get recent queries for analysis
 */
export async function getRecentQueries(projectContext = 'all', limit = 50) {
  try {
    if (projectContext === 'all') {
      // Read from all project logs
      const files = await fs.readdir(QUERY_LOGS_PATH);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      
      let allQueries = [];
      for (const file of jsonlFiles) {
        const content = await fs.readFile(join(QUERY_LOGS_PATH, file), 'utf8');
        const queries = content.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        allQueries.push(...queries);
      }
      
      // Sort by timestamp, most recent first
      return allQueries
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit);
        
    } else {
      // Read from specific project log
      const logFile = join(QUERY_LOGS_PATH, `${projectContext}.jsonl`);
      const content = await fs.readFile(logFile, 'utf8');
      
      return content.trim().split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit);
    }
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []; // No logs yet
    }
    throw error;
  }
}

/**
 * CLI interface for testing
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  
  if (command === 'test') {
    // Test logging functionality
    console.log('🧪 Testing query logger...');
    
    startQuerySession("Test query: How do I configure MCP servers?");
    
    await logToolCall('grep', { pattern: 'mcp.*server', glob: '**/*.md' }, 800, true);
    await logToolCall('read', { file_path: '.mcp.json' }, 400, true);
    await logToolCall('rag_query', { q: 'MCP integration', k: 3 }, 1200, true);
    
    await endQuerySession({
      routingReason: 'technical_config_query',
      contextQuality: 'high'
    });
    
  } else if (command === 'recent') {
    const limit = parseInt(process.argv[3]) || 10;
    const queries = await getRecentQueries('all', limit);
    
    console.log(`\n📊 Recent ${queries.length} queries:\n`);
    queries.forEach((q, i) => {
      console.log(`${i + 1}. [${q.projectContext}] ${q.query}`);
      console.log(`   Tools: ${q.toolSequence.map(t => t.tool).join(' → ')}`);
      console.log(`   Reason: ${q.routingReason}, Quality: ${q.contextQuality}\n`);
    });
    
  } else {
    console.log(`
Usage:
  node query-logger.mjs test     # Test logging functionality
  node query-logger.mjs recent [N]  # Show recent N queries (default: 10)
    `);
  }
}