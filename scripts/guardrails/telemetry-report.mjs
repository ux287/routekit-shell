#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const projectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? path.resolve(process.env.ROUTEKIT_PROJECT_ROOT) : process.cwd();
const telemetryFile = path.join(projectRoot, '.rks', 'telemetry', 'summary.csv');

if (!fs.existsSync(telemetryFile)) {
  console.error(`[telemetry] ${telemetryFile} not found. Run a few rks.exec cycles first.`);
  process.exit(1);
}

const rows = fs
  .readFileSync(telemetryFile, 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

const header = rows.shift().split(',');
const idx = (name) => header.indexOf(name);
const scenarioIdx = idx('guardrailScenario');
const statusIdx = idx('guardrailStatus');

const scenarioCounts = new Map();
const violations = [];

for (const line of rows) {
  const cols = line.split(',');
  const scenario = cols[scenarioIdx] || '(none)';
  const status = (cols[statusIdx] || '').toLowerCase();
  scenarioCounts.set(scenario, (scenarioCounts.get(scenario) || 0) + 1);
  if (status && status !== 'pass') {
    violations.push({ scenario, status, raw: line });
  }
}

console.log(`Guardrail telemetry report | total runs: ${rows.length}`);
for (const [scenario, count] of scenarioCounts.entries()) {
  console.log(`- ${scenario}: ${count}`);
}

if (violations.length) {
  console.log('\nViolations:');
  violations.slice(-5).forEach((entry) => {
    console.log(`- ${entry.scenario}: status=${entry.status}`);
  });
} else {
  console.log('\nNo guardrail violations recorded.');
}
