#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeAllMetrics } from './metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baselinesDir = path.join(__dirname, 'baselines');

// Resolve project root: walk up from __tests__/eval/ to packages/mcp-rks, then up to repo root
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

const baselineName = process.argv[2] || 'baseline-current';
const filepath = path.join(baselinesDir, `${baselineName}.json`);

if (!fs.existsSync(baselinesDir)) {
  fs.mkdirSync(baselinesDir, { recursive: true });
}

try {
  const metrics = await computeAllMetrics(projectRoot);
  fs.writeFileSync(filepath, JSON.stringify(metrics, null, 2), 'utf-8');

  console.log(`Baseline captured to ${filepath}`);
  console.log(`  Tool failure rate: ${(metrics.toolFailureRate.overall * 100).toFixed(1)}%`);
  console.log(`  Plan pass rate:    ${(metrics.planPassRate.rate * 100).toFixed(1)}%`);
  console.log(`  Exec success rate: ${(metrics.execSuccessRate.rate * 100).toFixed(1)}%`);
  console.log(`  Exec latency avg:  ${metrics.execLatency.avgMs}ms`);
  console.log(`  Guardrail viol.:   ${(metrics.guardrailViolations.rate * 100).toFixed(1)}%`);
} catch (error) {
  console.error('Failed to capture baseline:', error.message);
  process.exit(1);
}
