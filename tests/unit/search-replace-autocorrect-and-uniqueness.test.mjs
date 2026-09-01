import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSearchReplacePatterns, autoCorrectSearchPatterns } from '../../packages/mcp-rks/src/validation/search-replace.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('search/replace autocorrect and uniqueness', () => {
  let tmpDir;

  function setupTmpFile(filename, content) {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-sr-test-'));
    }
    const filePath = path.join(tmpDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filename;
  }

  beforeEach(() => {
    tmpDir = null;
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('whitespace autocorrect wiring', () => {
    it('all-whitespace-mismatch plan: autoCorrectSearchPatterns fixes patterns and plan becomes executable', () => {
      const actualContent = '  .nav-item {\n    display: flex;\n  }\n';
      const wrongWhitespacePattern = '.nav-item {\n  display: flex;\n}';
      const filePath = setupTmpFile('src/app.scss', actualContent);

      const plan = {
        steps: [{
          action: 'search_replace',
          path: filePath,
          edits: [{ search: wrongWhitespacePattern, replace: '  .nav-item { display: none; }' }],
        }],
      };

      // Validate — should flag whitespace mismatch
      validateSearchReplacePatterns(plan, tmpDir);
      const errors = plan.validationErrors || [];
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every(e => e.refinementType === 'whitespace_mismatch')).toBe(true);

      // Autocorrect
      autoCorrectSearchPatterns(plan, tmpDir);
      const corrections = plan._whitespaceCorrections || [];
      expect(corrections.length).toBeGreaterThan(0);

      // After correction, pattern should exactly match file
      expect(actualContent.includes(plan.steps[0].edits[0].search)).toBe(true);

      // Re-validate — should be clean
      plan.validationErrors = [];
      delete plan._whitespaceCorrections;
      validateSearchReplacePatterns(plan, tmpDir);
      expect((plan.validationErrors || []).length).toBe(0);
    });

    it('mixed plan: whitespace mismatches corrected, complete-miss errors remain', () => {
      const actualContent = '  .header {\n    color: red;\n  }\n  .footer {\n    color: blue;\n  }\n';
      const wrongWhitespacePattern = '.header {\n  color: red;\n}';
      const completeMissPattern = '.sidebar { display: grid; }';
      const filePath = setupTmpFile('src/mixed.scss', actualContent);

      const plan = {
        steps: [{
          action: 'search_replace',
          path: filePath,
          edits: [
            { search: wrongWhitespacePattern, replace: '  .header { color: green; }' },
            { search: completeMissPattern, replace: '  .sidebar { display: none; }' },
          ],
        }],
      };

      validateSearchReplacePatterns(plan, tmpDir);
      const errors = plan.validationErrors || [];
      const whitespaceMismatches = errors.filter(e => e.refinementType === 'whitespace_mismatch');
      const completeMisses = errors.filter(e => !e.refinementType);
      expect(whitespaceMismatches.length).toBe(1);
      expect(completeMisses.length).toBe(1);

      // Autocorrect fixes whitespace-only subset
      autoCorrectSearchPatterns(plan, tmpDir);
      expect(actualContent.includes(plan.steps[0].edits[0].search)).toBe(true);

      // Re-validate — complete miss should still be present
      plan.validationErrors = [];
      delete plan._whitespaceCorrections;
      validateSearchReplacePatterns(plan, tmpDir);
      const remaining = plan.validationErrors || [];
      expect(remaining.length).toBe(1);
      expect(remaining[0].refinementType).toBeUndefined();
    });

    it('emits [rks.plan] autocorrected console log per correction', () => {
      const actualContent = '  .btn {\n    padding: 8px;\n  }\n';
      const wrongPattern = '.btn {\n  padding: 8px;\n}';
      const filePath = setupTmpFile('src/btn.scss', actualContent);

      const plan = {
        steps: [{
          action: 'search_replace',
          path: filePath,
          edits: [{ search: wrongPattern, replace: '  .btn { padding: 12px; }' }],
        }],
      };

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        validateSearchReplacePatterns(plan, tmpDir);
        const errors = plan.validationErrors || [];
        const allWhitespace = errors.length > 0 && errors.every(e => e.refinementType === 'whitespace_mismatch');
        if (allWhitespace) {
          autoCorrectSearchPatterns(plan, tmpDir);
          const corrections = plan._whitespaceCorrections || [];
          for (const c of corrections) {
            console.error(`[rks.plan] autocorrected whitespace mismatch in ${c.target}`);
          }
          expect(corrections.length).toBeGreaterThan(0);
          const logCalls = consoleSpy.mock.calls.map(args => args.join(' '));
          const autocorrectLogs = logCalls.filter(msg => msg.includes('[rks.plan] autocorrected'));
          expect(autocorrectLogs.length).toBe(corrections.length);
        }
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('ambiguous pattern detection', () => {
    it('pattern with 3 occurrences produces ambiguous_pattern error with needs_refinement', () => {
      const block = '  color: red;\n';
      const content = `.a {\n${block}}\n.b {\n${block}}\n.c {\n${block}}\n`;
      const filePath = setupTmpFile('src/ambiguous.scss', content);

      const plan = {
        steps: [{
          action: 'search_replace',
          path: filePath,
          edits: [{ search: block, replace: '  color: blue;\n' }],
        }],
      };

      validateSearchReplacePatterns(plan, tmpDir);
      const errors = plan.validationErrors || [];
      const ambiguous = errors.filter(e => e.refinementType === 'ambiguous_pattern');
      expect(ambiguous.length).toBe(1);
      expect(ambiguous[0].error).toMatch(/ambiguous search pattern.*3 occurrences/);
      expect(ambiguous[0].hint).toBeTruthy();
      expect(plan.status).toBe('needs_refinement');
    });

    it('pattern with exactly 1 occurrence does not trigger ambiguous_pattern error', () => {
      const content = '  .unique-class {\n    font-size: 14px;\n  }\n  .other {\n    font-size: 16px;\n  }\n';
      const uniquePattern = '  .unique-class {\n    font-size: 14px;\n  }\n';
      const filePath = setupTmpFile('src/unique.scss', content);

      const plan = {
        steps: [{
          action: 'search_replace',
          path: filePath,
          edits: [{ search: uniquePattern, replace: '  .unique-class { font-size: 18px; }\n' }],
        }],
      };

      validateSearchReplacePatterns(plan, tmpDir);
      const errors = plan.validationErrors || [];
      const ambiguous = errors.filter(e => e.refinementType === 'ambiguous_pattern');
      expect(ambiguous.length).toBe(0);
    });
  });
});
