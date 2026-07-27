import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CANON_FILE = path.join(PROJECT_ROOT, 'notes', 'canon.prompt-architecture.md');
const GETTING_STARTED = path.join(PROJECT_ROOT, 'notes', 'canon.getting-started.md');

function readNote(p) {
  return fs.readFileSync(p, 'utf8');
}

function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : content;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

describe('canon.prompt-architecture.md', () => {
  it('file exists', () => {
    expect(fs.existsSync(CANON_FILE)).toBe(true);
  });

  it('has valid Dendron frontmatter with required fields', () => {
    const content = readNote(CANON_FILE);
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\nid:/);
    expect(content).toMatch(/\ntitle:/);
    expect(content).toMatch(/\ndesc:/);
    expect(content).toMatch(/\ncreated:/);
    expect(content).toMatch(/\nupdated:/);
  });

  it('documents .rks/prompts/ as canonical prompt location', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body).toContain('.rks/prompts/');
  });

  it('documents governor-{role}.md naming convention', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body).toContain('governor-{role}.md');
  });

  it('documents agent-{name}.md naming convention', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body).toContain('agent-{name}.md');
  });

  it('mentions loadAgentPrompt()', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body).toContain('loadAgentPrompt()');
  });

  it('describes hot-reload behavior', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    // Should mention caching or hot-reload semantics
    expect(body.toLowerCase()).toMatch(/hot.reload|no caching|re.read/i);
  });

  it('describes null-fallback behavior', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body.toLowerCase()).toMatch(/null|fallback/i);
  });

  it('documents vendor-skills.sh as distribution mechanism for existing child projects', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body).toContain('vendor-skills.sh');
  });

  it('documents attachProject as distribution mechanism for new child projects', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    expect(body.toLowerCase()).toMatch(/attachproject|attach_project|ensuregovernorartifacts/i);
  });

  it('body word count is between 400 and 1200', () => {
    const body = stripFrontmatter(readNote(CANON_FILE));
    const words = countWords(body);
    expect(words).toBeGreaterThanOrEqual(400);
    expect(words).toBeLessThanOrEqual(1200);
  });

  it('contains no stale notes/public.agents.* references', () => {
    const content = readNote(CANON_FILE);
    expect(content).not.toContain('notes/public.agents.');
  });
});

describe('canon.getting-started.md', () => {
  it('file exists', () => {
    expect(fs.existsSync(GETTING_STARTED)).toBe(true);
  });

  it('contains a reference to canon.prompt-architecture', () => {
    const content = readNote(GETTING_STARTED);
    expect(content).toContain('canon.prompt-architecture');
  });

  it('contains no stale notes/public.agents.* references', () => {
    const content = readNote(GETTING_STARTED);
    expect(content).not.toContain('notes/public.agents.');
  });
});

describe('stale path audit', () => {
  function scanForPattern(filePath, pattern) {
    if (!fs.existsSync(filePath)) return false;
    return fs.readFileSync(filePath, 'utf8').includes(pattern);
  }

  it('CLAUDE.md does not reference notes/public.agents.', () => {
    expect(scanForPattern(path.join(PROJECT_ROOT, 'CLAUDE.md'), 'notes/public.agents.')).toBe(false);
  });

  it('no .rks/prompts/ file references notes/public.agents.', () => {
    const promptsDir = path.join(PROJECT_ROOT, '.rks', 'prompts');
    if (!fs.existsSync(promptsDir)) return;
    const hits = fs.readdirSync(promptsDir)
      .filter(f => f.endsWith('.md'))
      .filter(f => scanForPattern(path.join(promptsDir, f), 'notes/public.agents.'));
    expect(hits).toHaveLength(0);
  });
});
