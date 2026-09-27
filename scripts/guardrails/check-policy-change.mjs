#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';

const projectRoot = process.env.ROUTEKIT_PROJECT_ROOT ? path.resolve(process.env.ROUTEKIT_PROJECT_ROOT) : process.cwd();
const baseRef = process.argv[2] || process.env.GUARDRAIL_BASE_REF || 'origin/dev';

function runGit(args) {
  try {
    return execSync(`git ${args.join(' ')}`, { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
  } catch (error) {
    console.error(`[guardrails] git ${args.join(' ')} failed: ${error.message}`);
    process.exit(1);
  }
}

function listChangedFiles() {
  const diffArgs = baseRef ? ['diff', '--name-only', `${baseRef}...HEAD`] : ['diff', '--name-only'];
  return runGit(diffArgs)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const changedFiles = listChangedFiles();
if (!changedFiles.includes('guardrails/policy.json')) {
  console.log('[guardrails] No policy changes detected.');
  process.exit(0);
}

const approvalRegex = /^notes\/decisions\..*guardrail.*\.md$/i;
const approvalPresent = changedFiles.some((file) => approvalRegex.test(file)) ||
  changedFiles.includes('notes/backlog.guardrails.policy-change-review.md');

if (!approvalPresent) {
  console.error('[guardrails] guardrails/policy.json changed but no guardrail approval note was updated.');
  console.error('Update a notes/decisions.*guardrail*.md file or notes/backlog.guardrails.policy-change-review.md to acknowledge the change.');
  process.exit(1);
}

console.log('[guardrails] Policy change detected with matching approval notes.');
