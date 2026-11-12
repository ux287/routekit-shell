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

  // backlog.feat.release-notes-account-for-released-stories AC12 — Step 2b opens with a dry run,
  // keeps story ids out of the notes text and maps each story to a phrase through notesCoverage.
  function releaseBlocks(content) {
    const lines = content.split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('mcp__rks__rks_release({')) continue;
      const block = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('})'); j++) block.push(lines[j]);
      blocks.push(block);
    }
    return blocks;
  }
  function step2b(content) {
    const stepAt = content.search(/^### Step 2b: Write the release notes$/m);
    expect(stepAt).toBeGreaterThan(-1);
    const nextHeading = content.indexOf('\n### ', stepAt + 1);
    return { stepAt, step: content.slice(stepAt, nextHeading === -1 ? undefined : nextHeading) };
  }
  const isDryRunBlock = (block) => block.some((l) => /^\s*dryRun: true,?\s*$/.test(l));

  it('AC12 Step 2b starts with a dryRun rks_release call and names the coverage refusal reasons', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    const { stepAt, step } = step2b(content);
    const firstCall = content.indexOf('mcp__rks__rks_release({');
    expect(firstCall).toBeGreaterThan(stepAt);
    expect(firstCall).toBeLessThan(stepAt + step.length);
    const first = releaseBlocks(content)[0];
    expect(isDryRunBlock(first), first.join('\n')).toBe(true);
    // The dry-run block is the first thing Step 2b asks for: no other rks_release block precedes it.
    expect(step.indexOf('mcp__rks__rks_release({')).toBe(firstCall - stepAt);
    for (const reason of ['release_notes_incomplete', 'notes_coverage_invalid', 'notes_exclusions_invalid']) {
      expect(content).toContain(reason);
    }
  });

  it('AC12 Step 2b keeps story ids out of the notes and builds notesCoverage from the written text', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    const { step } = step2b(content);
    expect(step).toMatch(/Do not put story ids in the (notes )?text/);
    expect(step).toMatch(/notesCoverage/);
    expect(step).toMatch(/copied from the written text/);
    expect(step).toMatch(/notesExclusions/);
    expect(step).toMatch(/with a reason/);
    expect(step).toMatch(/standing user constraint/);
    expect(step).toMatch(/Show the lines, the mapping and the exclusions to the user/);
    expect(step).toMatch(/from the released stories/);
    expect(step).toMatch(/never from commit subjects/);
  });

  it('AC12 every rks_release block without dryRun: true contains a changelog: line and a notesCoverage: line', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');
    const real = releaseBlocks(content).filter((block) => !isDryRunBlock(block));
    expect(real.length).toBeGreaterThanOrEqual(2);
    for (const block of real) {
      expect(block.some((l) => /^\s*changelog:/.test(l)), block.join('\n')).toBe(true);
      expect(block.some((l) => /^\s*notesCoverage:/.test(l)), block.join('\n')).toBe(true);
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
