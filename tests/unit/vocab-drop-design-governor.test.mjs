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

  // backlog.fix.mirror-ci-green-unship-doc-integrity-tests — AC5.
  //
  // Four of the five TARGET_FILES are notes (research.*, blog.*, how-to.*) that are on no
  // include pattern in publish-profiles.yaml, so on the mirror `read()` threw ENOENT for each.
  // The fifth, .claude/skills/research/SKILL.md, DOES ship and is unaffected.
  //
  // CONDITION-SCOPED, not disabled: wherever a target IS present the vocabulary sweep still
  // runs against it unchanged, and the floor below fails the suite if the set ever collapses —
  // so this cannot quietly become a test that sweeps nothing.
  it('the vocabulary sweep resolves a real target set (non-vacuity floor)', () => {
    const present = TARGET_FILES.filter((f) => existsSync(resolve(root, f)));
    // The shipped skill file alone must always resolve; upstream all five do.
    expect(present.length).toBeGreaterThanOrEqual(1);
    expect(present).toContain('.claude/skills/research/SKILL.md');
  });

  for (const file of TARGET_FILES) {
    it.skipIf(!existsSync(resolve(root, file)))(
      `${file} contains no non-canonical Governor name variants`, () => {
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
