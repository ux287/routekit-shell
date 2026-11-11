/**
 * Tests for the exec → refine handoff at the post-retry-exhausted call site
 * in packages/mcp-rks/src/server/exec.mjs.
 *
 * Pre-fix: exec called runRefineTool with `context: "Tests failed after N attempt(s)"`
 * and OMITTED testOutput. Refine's `test_failed` branch then ran its analysis on
 * a useless string, producing no meaningful suggestions.
 *
 * Post-fix: exec must forward `testOutput: lastVerification?.output || ""` so
 * refine sees the actual stderr/stdout.
 *
 * Since exec.mjs's runExec is a 1000+ line function, this test pins the
 * contract structurally (source-level grep with assertions on the relevant
 * lines) plus verifies runRefineTool's signature still accepts testOutput.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const EXEC_PATH = path.join(REPO_ROOT, 'packages/mcp-rks/src/server/exec.mjs');
const REFINE_PATH = path.join(REPO_ROOT, 'packages/mcp-rks/src/server/refine.mjs');

const EXEC_SRC = fs.readFileSync(EXEC_PATH, 'utf8');
const REFINE_SRC = fs.readFileSync(REFINE_PATH, 'utf8');

/**
 * Extract the source block of the post-retry-exhausted `runRefineTool(...)` call
 * so assertions target that specific call site (the file may have other
 * runRefineTool references elsewhere in the future).
 */
function extractRefineCallBlock(src) {
  // Find the first occurrence of `await runRefineTool({` and capture the args
  // up to the matching closing `});`.
  const start = src.indexOf('await runRefineTool({');
  if (start === -1) return null;
  const end = src.indexOf('});', start);
  if (end === -1) return null;
  return src.slice(start, end + 3);
}

describe('exec.mjs — post-retry-exhausted runRefineTool call forwards testOutput', () => {
  const block = extractRefineCallBlock(EXEC_SRC);

  it('a runRefineTool call exists in exec.mjs', () => {
    expect(block).not.toBeNull();
  });

  it('the call passes trigger: "test_failed"', () => {
    expect(block).toMatch(/trigger:\s*["']test_failed["']/);
  });

  it('the call preserves the existing context string (regression guard — fix ADDS testOutput, does not replace context)', () => {
    expect(block).toMatch(/context:\s*`Tests failed after \$\{attemptNumber\} attempt\(s\)`/);
  });

  it('the call now passes testOutput sourced from the verification result (the fix)', () => {
    // Accept either `lastVerification?.output || ""` or `lastVerification.output || ""` patterns
    // — both forward the captured test output. The empty-string fallback is mandatory so
    // undefined/null verification doesn't leak through.
    expect(block).toMatch(/testOutput:\s*lastVerification(\?\.|\.)output\s*\|\|\s*["']{1,2}/);
  });

  it('regression guard: the buggy call shape (missing testOutput) is gone', () => {
    // Pre-fix block had exactly: projectRoot, problemId, trigger, context, projectId.
    // Post-fix block must include testOutput between context and projectId (or anywhere within).
    expect(block).toMatch(/testOutput:/);
  });
});

describe('refine.mjs — runRefineTool signature still accepts testOutput', () => {
  it('runRefineTool destructures testOutput from its args', () => {
    // The fix relies on this — if refine ever removes the testOutput field from its
    // signature, the exec call site silently does nothing useful.
    expect(REFINE_SRC).toMatch(/export\s+async\s+function\s+runRefineTool\(\s*\{[^}]*\btestOutput\b/);
  });

  it('the test_failed branch reads testOutput (or context) when constructing the log content', () => {
    // Per research findings, the branch is `if (trigger === "test_failed" && (testOutput || context))`.
    // This guards against a future regression where someone removes testOutput from the gate.
    expect(REFINE_SRC).toMatch(/trigger\s*===\s*["']test_failed["']/);
    expect(REFINE_SRC).toMatch(/testOutput\s*\|\|\s*context/);
  });
});
