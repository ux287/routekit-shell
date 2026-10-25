import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PROMPT_PATH = path.join(process.cwd(), '.rks/prompts/governor-build.md');
const content = fs.readFileSync(PROMPT_PATH, 'utf8');

describe('governor-build.md — dendron_edit_note requirement', () => {
  it('Rules section forbids Edit, Write, and Bash for story note mutations', () => {
    expect(content).toMatch(/must never use Edit.*Write.*Bash|never use Edit.*Write.*or Bash/i);
  });

  // backlog.fix.build-prompt-story-edits-route-through-refine: Build never writes story content
  // directly. These pins previously REQUIRED dendron_edit_note; they now require the prohibition.
  it('Rules section forbids direct story writes and routes story changes through rks_refine_apply', () => {
    const rulesBlock = content.slice(content.indexOf('## Rules'));
    expect(rulesBlock).toMatch(/Build never writes story content directly/);
    expect(rulesBlock).toMatch(/Story content changes only through rks_refine_apply/);
  });

  it('whole prompt: no dendron_edit_note call, and every mention is a prohibition', () => {
    expect(content).not.toContain('mcp__rks__dendron_edit_note(');
    expect(content).not.toMatch(/use dendron_edit_note only/i);
    expect(content).not.toMatch(/dendron_edit_note procedure/i);
    const mentions = content.split('\n').filter((line) => line.includes('dendron_edit_note'));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      expect(line, 'non-prohibitive dendron_edit_note mention: ' + line).toMatch(/never|Do NOT/);
    }
  });

  it('names the story_amendment_required STOP for changes refine cannot make', () => {
    expect(content).toContain("error: 'story_amendment_required'");
    expect(content).toContain("summary: '<what must change and why>'");
    const rulesBlock = content.slice(content.indexOf('## Rules'));
    const rule = rulesBlock.split('\n').find((line) => line.includes("error: 'story_amendment_required'"));
    expect(rule).toBeDefined();
    for (const kind of ['acceptance criteria', 'targetFiles', 'testRequirements', 'prose']) {
      expect(rule).toContain(kind);
    }
  });

  it('prohibition uses "must never" language — not advisory', () => {
    expect(content).toMatch(/must never|never use/i);
  });

  it('step 4 (rks_plan) forbids direct story writes', () => {
    const step4Block = content.slice(content.indexOf('4. mcp__rks__rks_plan'));
    const beforeStep5 = step4Block.slice(0, step4Block.indexOf('5. POLL'));
    expect(beforeStep5).toMatch(/Edit\/Write\/Bash/);
    expect(beforeStep5).toMatch(/never writes story content directly/);
    expect(beforeStep5).toContain('story_amendment_required');
  });

  it('step 6 (rks_exec) forbids direct story writes', () => {
    const step6Block = content.slice(content.indexOf('6. mcp__rks__rks_exec'));
    const beforeStep6a = step6Block.slice(0, step6Block.indexOf('6a.'));
    expect(beforeStep6a).toMatch(/Edit\/Write\/Bash/);
    expect(beforeStep6a).toMatch(/never writes story content directly/);
    expect(beforeStep6a).toContain('story_amendment_required');
  });

  it('step 7 (rks_story_ship) forbids direct story writes', () => {
    const step7Block = content.slice(content.indexOf('7. mcp__rks__rks_story_ship'));
    const beforeRules = step7Block.slice(0, step7Block.indexOf('## Rules'));
    expect(beforeRules).toMatch(/Edit\/Write\/Bash/);
    expect(beforeRules).toMatch(/never writes story content directly/);
    expect(beforeRules).toContain('story_amendment_required');
  });

  it('step 3 manual:true recovery sub-step c routes through rks_refine_apply add_search_pattern', () => {
    const step3 = content.slice(content.indexOf('3. mcp__rks__rks_refine'), content.indexOf('3.5. mcp__rks__rks_plan_ready'));
    const subC = step3.split('\n').find((line) => /^\s+c\. /.test(line));
    expect(subC).toBeDefined();
    expect(subC).toContain('mcp__rks__rks_refine_apply(');
    expect(subC).toContain("type: 'add_search_pattern'");
    expect(subC).toContain("anchors: ['<anchor>']");
    expect(subC).toContain('results[0].text');
    // b-multi: consecutive results[].text lines joined with a newline, passed as ONE entry.
    expect(subC).toContain('b-multi');
    expect(subC).toContain('joined with a single newline');
    expect(subC).toContain('ONE `anchors` entry');
    // The 3a/b/b-multi verification text stays.
    expect(step3).toContain('Read the VERDICT OFF `results`, NOT off `matchCount`');
    expect(step3).toContain('CONSECUTIVE ascending integers with no gap');
  });

  it('step 3.5 maps story_changed_since_arch to story_amendment_required before the generic STOP', () => {
    const start = content.indexOf('3.5. mcp__rks__rks_plan_ready');
    const end = content.indexOf('\n4. mcp__rks__rks_plan(', start);
    const region = content.slice(start, end);
    const mapIdx = region.search(/story_changed_since_arch[^\n]*error: 'story_amendment_required'/);
    const genericIdx = region.indexOf("blocking issues other than `multi_file_blocked`: STOP and return { status: 'failed', error: 'plan_ready_blocked'");
    expect(mapIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(mapIdx);
    // The no_search_pattern_for_modify branch points at the refine route, not a direct edit.
    const nsp = region.split('\n').find((line) => line.includes('no_search_pattern_for_modify') && line.includes('manual: true'));
    expect(nsp).toBeDefined();
    expect(nsp).toMatch(/rks_refine_apply add_search_pattern/);
  });

  it('caution-3 note is preserved', () => {
    expect(content).toContain('Do NOT call dendron_read_note');
    expect(content).toContain('caution 3 is INERT for Build');
    expect(content).toContain('does NOT license calling `dendron_read_note`');
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
