#!/usr/bin/env node
/**
 * Tests for enforce-plan-scope.mjs hook
 *
 * @see backlog.test.hook-testing-harness
 */

import { callHook } from './hook-harness.mjs';

let failures = 0;
function ok(msg) { console.log('[PASS] ' + msg); }
function fail(msg) { console.error('[FAIL] ' + msg); failures++; }

async function run() {
  console.log('[test-enforce-plan-scope] running tests');

  // Test 1: Edit to packages/ without a plan -> expected to be blocked (code path)
  const r1 = await callHook('enforce-plan-scope.mjs', 'Edit', {
    file_path: 'packages/foo/index.js'
  });
  if (r1.blocked) ok('packages edit without plan blocked'); else fail('packages edit without plan should be blocked');

  // Test 2: Edit to notes/ -> allowed (EDIT_WHITELIST)
  const r2 = await callHook('enforce-plan-scope.mjs', 'Edit', {
    file_path: 'notes/meeting.md'
  });
  if (!r2.blocked && r2.code === 0) ok('notes edit allowed'); else fail('notes edit should be allowed');

  // Test 3: Edit to a .md file at root -> allowed (file extension whitelist)
  const r3 = await callHook('enforce-plan-scope.mjs', 'Edit', {
    file_path: 'README.md'
  });
  if (!r3.blocked) ok('.md file allowed'); else fail('.md file should be allowed');

  // Test 4: Edit to .routekit/ -> allowed (ALWAYS_ALLOWED)
  const r4 = await callHook('enforce-plan-scope.mjs', 'Edit', {
    file_path: '.routekit/config.yaml'
  });
  if (!r4.blocked) ok('.routekit path allowed'); else fail('.routekit path should be allowed');

  // Test 5: Guardrails disabled via env -> all allowed
  const r5 = await callHook('enforce-plan-scope.mjs', 'Edit', {
    file_path: 'packages/foo/index.js'
  }, { RKS_GUARDRAILS: 'off' });
  if (!r5.blocked) ok('guardrails off allows code path'); else fail('guardrails off should allow code path');

  if (failures > 0) {
    console.error('[test-enforce-plan-scope] FAILED', failures, 'tests failed');
    process.exitCode = 1;
  } else {
    console.log('[test-enforce-plan-scope] OK');
    process.exitCode = 0;
  }
}

run();
