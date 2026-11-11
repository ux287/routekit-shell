/**
 * Tests for /release skill — verifies SKILL.md structure and CLAUDE.md entry.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const SKILL_PATH = path.join(process.cwd(), '.claude/skills/release/SKILL.md');
const CLAUDE_MD_PATH = path.join(process.cwd(), 'CLAUDE.md');

function parseSkillMd(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) throw new Error('No frontmatter found');
  const frontmatter = yaml.load(fmMatch[1]);
  const body = fmMatch[2];
  return { frontmatter, body };
}

describe('/release skill SKILL.md', () => {
  it('exists at .claude/skills/release/SKILL.md with valid YAML frontmatter', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
    const { frontmatter } = parseSkillMd(SKILL_PATH);
    expect(frontmatter.name).toBe('skills-release');
    expect(typeof frontmatter.description).toBe('string');
    expect(frontmatter['user-invocable']).toBe(true);
  });

  it('body includes pre-flight check for clean working tree', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/clean.*working.*tree|git status --porcelain|uncommitted/i);
  });

  it('body includes pre-flight check that current branch is staging', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/branch.*staging|must be on staging/i);
  });

  it('body includes pre-flight check that CI is green', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/CI.*green|CI.*pass|gh run list/i);
  });

  it('body instructs to call mcp__rks__rks_release with projectId and version', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/mcp__rks__rks_release/);
    expect(body).toMatch(/projectId/);
    expect(body).toMatch(/version/);
  });

  it('body instructs to report result on success including version, tag, and commit', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/version.*tag|tag.*commit|report.*result/i);
  });

  it('body instructs to stop and report on pre-flight failure', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/stop|fail.*report|Pre-flight failed/i);
  });

  it('body parses $ARGUMENTS for version bump type defaulting to patch', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toMatch(/\$ARGUMENTS/);
    expect(body).toMatch(/patch.*default|default.*patch/i);
    expect(body).toMatch(/minor/);
    expect(body).toMatch(/major/);
  });

  // backlog.feat.release-write-release-notes AC7 — release notes are required, written from the
  // released stories, and every rks_release call block passes changelog.
  it('AC7 does not offer to omit the changelog ("ask user or omit")', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    expect(content).not.toContain('ask user or omit');
  });

  it('AC7 has a write-the-release-notes step before the first rks_release call, from stories not commit subjects', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    const stepAt = content.search(/^### Step [0-9a-z]+: Write the release notes$/m);
    const firstCall = content.indexOf('mcp__rks__rks_release({');
    expect(stepAt).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(-1);
    expect(stepAt).toBeLessThan(firstCall);
    const nextHeading = content.indexOf('\n### ', stepAt + 1);
    const step = content.slice(stepAt, nextHeading);
    expect(step).toMatch(/from the released stories/);
    expect(step).toMatch(/never from commit subjects/);
  });

  it('AC7 names release_notes_missing and notesOverride, and requires user direction plus a reason', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    expect(content).toContain('release_notes_missing');
    expect(content).toContain('notesOverride');
    expect(content).toMatch(/notesOverride[^\n]*\n?[^\n]*requires the user's explicit direction and a reason/);
  });

  it('AC7 every mcp__rks__rks_release({ block (at least two) contains a changelog: line', () => {
    const lines = fs.readFileSync(SKILL_PATH, 'utf8').split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('mcp__rks__rks_release({')) continue;
      const block = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('})'); j++) block.push(lines[j]);
      blocks.push(block);
    }
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block.some((l) => /^\s*changelog:/.test(l)), block.join('\n')).toBe(true);
    }
  });

  it('AC7 the CI-override section states enforcementOverride does not waive release notes', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    const start = content.indexOf('### Overriding a blocking CI verdict');
    expect(start).toBeGreaterThan(-1);
    const end = content.indexOf('\n### ', start + 1);
    const section = content.slice(start, end === -1 ? undefined : end);
    expect(section).toMatch(/`enforcementOverride` waives only the CI gate\. It does not waive release notes/);
  });

  it('AC7 keeps the enforcementOverride example line byte-identical', () => {
    const lines = fs.readFileSync(SKILL_PATH, 'utf8').split('\n');
    expect(lines).toContain("  enforcementOverride: { enabled: true, reason: 'why you are releasing without a CI verdict' },");
  });

  // backlog.feat.child-lifecycle.upgrade-all-from-release — every release surfaces the one-liner.
  it('body instructs the child-rollout one-liner (routekit project upgrade --all --from-release)', () => {
    const { body } = parseSkillMd(SKILL_PATH);
    expect(body).toContain('routekit project upgrade --all --from-release');
  });
});

describe('CLAUDE.md /release entry', () => {
  it('Skills section includes a /release entry', () => {
    const content = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
    expect(content).toMatch(/\/release/);
    expect(content).toMatch(/skill[\s\S]*\/release/i);
  });
});
