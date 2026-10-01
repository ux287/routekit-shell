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
