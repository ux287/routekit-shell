#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const servers = [
  { name: 'RAG', script: 'rag-server-http.mjs', port: 3001 },
  { name: 'Dendron', script: 'dendron-server-http.mjs', port: 3002 },
  { name: 'Governance', script: 'governance-server-http.mjs', port: 3003 }
];

console.log('🚀 Starting MCP HTTP servers...\n');

const processes = [];

for (const server of servers) {
  const scriptPath = join(__dirname, server.script);
  console.log(`Starting ${server.name} server on port ${server.port}...`);
  
  const process = spawn('node', [scriptPath], {
    stdio: 'pipe',
    env: { ...process.env, PORT: server.port }
  });
  
  process.stdout.on('data', (data) => {
    console.log(`[${server.name}] ${data.toString().trim()}`);
  });
  
  process.stderr.on('data', (data) => {
    console.log(`[${server.name}] ${data.toString().trim()}`);
  });
  
  process.on('close', (code) => {
    console.log(`[${server.name}] Process exited with code ${code}`);
  });
  
  processes.push({ name: server.name, process, port: server.port });
}

console.log('\n✅ All servers started. Press Ctrl+C to stop all servers.\n');

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping all servers...');
  processes.forEach(({ name, process }) => {
    console.log(`Stopping ${name} server...`);
    process.kill('SIGTERM');
  });
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();