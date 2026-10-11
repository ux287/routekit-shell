import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROMPT_PATH = path.join(process.cwd(), '.rks/prompts/governor-build.md');
const content = fs.readFileSync(PROMPT_PATH, 'utf8');

describe('governor-build.md — dendron_edit_note requirement', () => {
  it('Rules section forbids Edit, Write, and Bash for story note mutations', () => {
    expect(content).toMatch(/must never use Edit.*Write.*Bash|never use Edit.*Write.*or Bash/i);
  });

  it('Rules section explicitly names dendron_edit_note as the required tool', () => {
    expect(content).toContain('dendron_edit_note');
  });

  it('prohibition uses "must never" language — not advisory', () => {
    expect(content).toMatch(/must never|never use/i);
  });

  it('step 4 (rks_plan) references dendron_edit_note requirement', () => {
    const step4Block = content.slice(content.indexOf('4. mcp__rks__rks_plan'));
    const beforeStep5 = step4Block.slice(0, step4Block.indexOf('5. POLL'));
    expect(beforeStep5).toMatch(/dendron_edit_note|Edit\/Write\/Bash/);
  });

  it('step 6 (rks_exec) references dendron_edit_note requirement', () => {
    const step6Block = content.slice(content.indexOf('6. mcp__rks__rks_exec'));
    const beforeStep6a = step6Block.slice(0, step6Block.indexOf('6a.'));
    expect(beforeStep6a).toMatch(/dendron_edit_note|Edit\/Write\/Bash/);
  });

  it('step 7 (rks_story_ship) references dendron_edit_note requirement', () => {
    const step7Block = content.slice(content.indexOf('7. mcp__rks__rks_story_ship'));
    const beforeRules = step7Block.slice(0, step7Block.indexOf('## Rules'));
    expect(beforeRules).toMatch(/dendron_edit_note|Edit\/Write\/Bash/);
  });

  it('existing 8 rules are preserved in original order', () => {
    const rulesBlock = content.slice(content.indexOf('## Rules'));
    expect(rulesBlock).toContain('Call ONLY the tools listed in the chain above');
    expect(rulesBlock).toContain('your ONLY next call is rks_plan_review');
    expect(rulesBlock).toContain('After rks_exec succeeds, your ONLY next call is rks_story_ship');
    expect(rulesBlock).toContain("Test failure with retries remaining");
    expect(rulesBlock).toContain('Test failure after exhausting retry budget');
    expect(rulesBlock).toContain('Error → STOP');
    expect(rulesBlock).toContain('decomposed: true, STOP');
    expect(rulesBlock).toContain("status: 'complete'");
  });

  it('chain step ordering (0–7 including 6a) is unchanged', () => {
    const steps = ['0. mcp__rks__rks_governor_init', '1. mcp__rks__rks_refine', '2. mcp__rks__rks_agent_research',
      '3. mcp__rks__rks_refine', '4. mcp__rks__rks_plan', '5. POLL rks_plan_review',
      '6. mcp__rks__rks_exec', '6a.', '7. mcp__rks__rks_story_ship'];
    let lastIdx = -1;
    for (const step of steps) {
      const idx = content.indexOf(step);
      expect(idx, `step "${step}" not found or out of order`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });
});
