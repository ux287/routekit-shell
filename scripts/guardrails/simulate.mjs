#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const projectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? path.resolve(process.env.ROUTEKIT_PROJECT_ROOT) : process.cwd();
const policyPath = path.join(projectRoot, 'guardrails', 'policy.json');

function loadPolicy() {
  if (!fs.existsSync(policyPath)) {
    console.error(`Guardrail policy not found at ${policyPath}`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(policyPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('Failed to parse guardrail policy:', error.message);
    process.exit(1);
  }
}

function matchScenario(policy, label = '') {
  const scenarios = Array.isArray(policy?.scenarios) ? policy.scenarios : [];
  for (const scenario of scenarios) {
    const labels = scenario?.match?.labels || [];
    if (labels.some((pattern) => label.includes(pattern))) {
      return scenario;
    }
  }
  return policy?.default || null;
}

const label = process.argv[2] || '';
const policy = loadPolicy();
const scenario = matchScenario(policy, label);

if (label) {
  console.log(`Label: ${label}`);
  console.log('Matched Scenario:', scenario ? scenario.id : '(none)');
  if (scenario) {
    console.log(JSON.stringify(scenario, null, 2));
  }
} else {
  console.log('Guardrail Scenarios:');
  console.log(JSON.stringify(policy, null, 2));
}
