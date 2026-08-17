/**
 * backlog.feat.whitepaper-skill — /whitepaper Dispatcher skill.
 *
 * Source-introspection only (readFileSync + toContain/toMatch, no CLI execution,
 * no Chromium). Modeled on tests/unit/ci-skill.test.mjs. Validates the SKILL.md
 * frontmatter contract, the CLI-delegation body, and the CLAUDE.md skill-table row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL = readFileSync(resolve(ROOT, '.claude/skills/whitepaper/SKILL.md'), 'utf8');
const CLAUDE_MD = readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf8');

function frontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No frontmatter found');
  const fm = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0 && !line.startsWith(' ')) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

describe('/whitepaper SKILL.md — frontmatter contract', () => {
  const fm = frontmatter(SKILL);

  it('parses frontmatter with the standard skill regex', () => {
    expect(SKILL).toMatch(/^---\n([\s\S]*?)\n---/);
  });

  it('has name: whitepaper and a non-empty description', () => {
    expect(fm.name).toBe('whitepaper');
    expect(fm.description).toBeTruthy();
    expect(fm.description.length).toBeGreaterThan(0);
  });

  it('has verbosity: heartbeat and the required invocation flags', () => {
    expect(fm.verbosity).toBe('heartbeat');
    expect(fm['user-invocable']).toBe('true');
    expect(fm['disable-model-invocation']).toBe('false');
  });
});

describe('/whitepaper SKILL.md — delegates to the package', () => {
  it('references @routekit/whitepaper and inlines no parsing/render logic', () => {
    expect(SKILL).toContain('@routekit/whitepaper');
    expect(SKILL).not.toContain('markdown-it');
    expect(SKILL).not.toContain('page.pdf');
  });

  it('documents the CLI invocation and the input/output paths', () => {
    expect(SKILL).toContain('whitepaper <note-id>');
    expect(SKILL).toContain('notes/<note-id>.md');
    expect(SKILL).toContain('dist/whitepapers/<note-id>.pdf');
  });

  it('notes Chromium is downloaded on first run', () => {
    expect(SKILL).toContain('Chromium');
    expect(SKILL).toContain('first run');
  });
});

describe('CLAUDE.md skill table', () => {
  it('has a /whitepaper row', () => {
    expect(CLAUDE_MD).toMatch(/\| `\/whitepaper`\s*\|/);
  });
});
