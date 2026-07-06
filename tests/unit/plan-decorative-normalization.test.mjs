import { describe, it, expect } from 'vitest';
import { reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';
import { autoCorrectSearchPatterns } from '../../packages/mcp-rks/src/validation/search-replace.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Decorative character run normalization', () => {
  let tmpDir;

  function setupTmpFile(filename, content) {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-test-'));
    }
    const filePath = path.join(tmpDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filename;
  }

  it('quality review accepts search patterns with different dash counts in box-drawing chars', async () => {
    const actualContent = '    // ── QA Governor ────────────────────────────────────\n\n    const QA_FLOW_TOOLS = new Set([]);';
    const searchPattern = '    // ── QA Governor ──────────────────────────────\n\n    const QA_FLOW_TOOLS = new Set([]);';
    const filePath = setupTmpFile('src/governor-state.mjs', actualContent);

    const plan = {
      steps: [{
        action: 'search_replace',
        path: filePath,
        edits: [{ search: searchPattern, replace: 'replacement' }],
      }],
    };

    const result = await reviewPlan({ projectRoot: tmpDir, plan });
    const searchErrors = (result.errors || []).filter(e => e.check === 'search_pattern_not_found');
    expect(searchErrors.length).toBe(0);
  });

  it('quality review accepts search patterns with different counts of regular dashes', async () => {
    const actualContent = '// ---------- section ----------\nconst x = 1;';
    const searchPattern = '// ----- section -----\nconst x = 1;';
    const filePath = setupTmpFile('src/dashes.mjs', actualContent);

    const plan = {
      steps: [{
        action: 'search_replace',
        path: filePath,
        edits: [{ search: searchPattern, replace: 'replacement' }],
      }],
    };

    const result = await reviewPlan({ projectRoot: tmpDir, plan });
    const searchErrors = (result.errors || []).filter(e => e.check === 'search_pattern_not_found');
    expect(searchErrors.length).toBe(0);
  });

  it('quality review still rejects genuinely wrong search patterns', async () => {
    const actualContent = 'const QA_FLOW_TOOLS = new Set([]);';
    const searchPattern = 'const SHIP_FLOW_TOOLS = new Set([]);';
    const filePath = setupTmpFile('src/wrong.mjs', actualContent);

    const plan = {
      steps: [{
        action: 'search_replace',
        path: filePath,
        edits: [{ search: searchPattern, replace: 'replacement' }],
      }],
    };

    const result = await reviewPlan({ projectRoot: tmpDir, plan });
    const searchErrors = (result.errors || []).filter(e => e.check === 'search_pattern_not_found');
    expect(searchErrors.length).toBeGreaterThan(0);
  });

  it('autoCorrectSearchPatterns fixes decorative character count mismatches', () => {
    const actualContent = '    // ── Header ────────────────────────────────────\n    const x = 1;';
    const searchPattern = '    // ── Header ──────────────────────────────\n    const x = 1;';
    const filePath = setupTmpFile('src/autocorrect.mjs', actualContent);

    const plan = {
      steps: [{
        action: 'search_replace',
        path: filePath,
        edits: [{ search: searchPattern, replace: 'replacement' }],
      }],
    };

    autoCorrectSearchPatterns(plan, tmpDir);
    // After auto-correction, the search pattern should match the actual file
    expect(actualContent.includes(plan.steps[0].edits[0].search)).toBe(true);
  });

  it('autoCorrectSearchPatterns does not modify already-correct patterns', () => {
    const actualContent = 'const x = 1;\nconst y = 2;';
    const searchPattern = 'const x = 1;\nconst y = 2;';
    const filePath = setupTmpFile('src/correct.mjs', actualContent);

    const plan = {
      steps: [{
        action: 'search_replace',
        path: filePath,
        edits: [{ search: searchPattern, replace: 'replacement' }],
      }],
    };

    autoCorrectSearchPatterns(plan, tmpDir);
    expect(plan.steps[0].edits[0].search).toBe(searchPattern);
    expect(plan._whitespaceCorrections).toBeUndefined();
  });
});
