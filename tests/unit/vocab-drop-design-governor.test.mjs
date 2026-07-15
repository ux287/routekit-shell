import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const root = process.cwd();
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const NON_CANONICAL = /Design Governor|Designer Governor|Design\/Research Governor|governor-design-research/;

const TARGET_FILES = [
  'notes/research.2026.05.08.rks-prompt-process.md',
  'notes/blog.2026.05.09.rks-deep-dive-release-ready.md',
  'notes/blog.2026.02.21.rks-agentified-workflow-deep-dive.md',
  '.claude/skills/research/SKILL.md',
  'notes/how-to.agent-operations.2-research.md',
];

describe('vocab-drop-design-governor', () => {
  it('governor-design-research.md no longer exists', () => {
    expect(existsSync(resolve(root, '.rks/prompts/governor-design-research.md'))).toBe(false);
  });

  it('governor-research.md exists as the canonical prompt', () => {
    expect(existsSync(resolve(root, '.rks/prompts/governor-research.md'))).toBe(true);
  });

  it('governor-research.md does not contain non-canonical Governor names', () => {
    const content = read('.rks/prompts/governor-research.md');
    expect(content).not.toMatch(NON_CANONICAL);
  });

  for (const file of TARGET_FILES) {
    it(`${file} contains no non-canonical Governor name variants`, () => {
      const content = read(file);
      const matches = content.match(new RegExp(NON_CANONICAL.source, 'g'));
      expect(matches).toBeNull();
    });
  }

  it('SKILL.md references governor-research.md (not governor-design-research.md)', () => {
    const content = read('.claude/skills/research/SKILL.md');
    expect(content).toContain('governor-research.md');
    expect(content).not.toContain('governor-design-research.md');
  });

  it('SKILL.md uses "Research Governor" in document mode instructions', () => {
    const content = read('.claude/skills/research/SKILL.md');
    expect(content).toContain('Research Governor');
  });
});
