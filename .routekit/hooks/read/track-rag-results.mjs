#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { addRagSourcedPath } from "../lib/session-state.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function extractPathsFromResults(resultObj) {
  const paths = new Set();
  // Common shape: resultObj.passages | resultObj.results | resultObj.hits
  const buckets = resultObj.passages || resultObj.results || resultObj.hits || [];
  for (const item of buckets) {
    if (!item) continue;
    if (item.path) paths.add(String(item.path));
    if (item.source) paths.add(String(item.source));
    if (item.file) paths.add(String(item.file));
    if (item.metadata && item.metadata.path) paths.add(String(item.metadata.path));
    if (item.text) {
      // crude inline path extraction for patterns like "docs/foo.md" or "/src/foo.js"
      const re = /([\w\-\.\/]+\/[\w\-\.\/]+\.[a-zA-Z0-9_\-]+)/g;
      let m;
      while ((m = re.exec(item.text)) !== null) {
        paths.add(m[1]);
      }
    }
  }
  return Array.from(paths).filter(Boolean);
}

(async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch (e) {
    process.exit(0);
  }

  const toolName = hookData.tool_name || hookData.tool || '';
  const toolInput = hookData.tool_input || {};
  const resultObj = toolInput.result || toolInput.results || toolInput.output || {};

  if (!['rks_rag_query', 'orchestrator_query', 'rag_query', 'orchestrator'].includes(toolName)) {
    // Not a RAG result we care about
    process.exit(0);
  }

  const query = toolInput.q || toolInput.query || toolInput.prompt || '';
  const paths = extractPathsFromResults(resultObj);
  for (const p of paths) {
    try {
      addRagSourcedPath(p, query);
    } catch (e) {
      // best-effort
    }
  }

  // Log basic telemetry to stderr for debugging
  if (paths.length > 0) {
    process.stderr.write(`Tracked RAG paths: ${paths.slice(0, 10).join(', ')}\n`);
  }
  process.exit(0);
})();
