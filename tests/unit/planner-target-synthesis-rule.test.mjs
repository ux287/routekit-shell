import { describe, it, expect } from 'vitest';

// Import the module to inspect buildPrompt output via the exported planner
// We test the prompt text directly by reading the source since buildPrompt is not exported.
// Instead, we verify the rule text is present in the file itself.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const plannerSrc = fs.readFileSync(
  path.join(__dirname, '../../packages/mcp-rks/src/llm/planner.mjs'),
  'utf8'
);

describe('planner buildPrompt — TARGET + SOURCE SYNTHESIS rule', () => {
  it('contains the TARGET + SOURCE SYNTHESIS rule', () => {
    expect(plannerSrc).toContain('TARGET + SOURCE SYNTHESIS');
  });

  it('TARGET + SOURCE SYNTHESIS appears after SOURCE BLOCKS ARE INPUT-ONLY', () => {
    const sourceOnlyIdx = plannerSrc.indexOf('SOURCE BLOCKS ARE INPUT-ONLY');
    const synthesisIdx = plannerSrc.indexOf('TARGET + SOURCE SYNTHESIS');
    expect(sourceOnlyIdx).toBeGreaterThan(-1);
    expect(synthesisIdx).toBeGreaterThan(-1);
    expect(synthesisIdx).toBeGreaterThan(sourceOnlyIdx);
  });

  it('describes the pattern: Target signature only + labeled source blocks', () => {
    const synthesisIdx = plannerSrc.indexOf('TARGET + SOURCE SYNTHESIS');
    const ruleText = plannerSrc.slice(synthesisIdx, synthesisIdx + 600);
    expect(ruleText).toMatch(/function signature/i);
    expect(ruleText).toMatch(/source block/i);
  });

  it('instructs stripping of // Context: prefix lines', () => {
    const synthesisIdx = plannerSrc.indexOf('TARGET + SOURCE SYNTHESIS');
    const ruleText = plannerSrc.slice(synthesisIdx, synthesisIdx + 600);
    expect(ruleText).toContain('// Context:');
  });

  it('instructs adding necessary imports at the top', () => {
    const synthesisIdx = plannerSrc.indexOf('TARGET + SOURCE SYNTHESIS');
    const ruleText = plannerSrc.slice(synthesisIdx, synthesisIdx + 600);
    expect(ruleText).toMatch(/import/i);
  });

  it('states the output must be a complete, valid, importable file', () => {
    const synthesisIdx = plannerSrc.indexOf('TARGET + SOURCE SYNTHESIS');
    const ruleText = plannerSrc.slice(synthesisIdx, synthesisIdx + 600);
    expect(ruleText).toMatch(/complete.*valid|valid.*complete/i);
    expect(ruleText).toMatch(/TypeScript|JavaScript/i);
  });

  it('AUTHORITATIVE CONTENT RULE references live disk content', () => {
    expect(plannerSrc).toContain('AUTHORITATIVE CONTENT RULE');
    expect(plannerSrc).toContain('LIVE DISK CONTENT');
  });

  it('SOURCE BLOCKS ARE INPUT-ONLY rule is unchanged', () => {
    expect(plannerSrc).toContain('SOURCE BLOCKS ARE INPUT-ONLY');
    expect(plannerSrc).toContain('NEVER use them verbatim as create_file content');
  });
});
