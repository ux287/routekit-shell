/**
 * Tests for parseTargetsFromMarkdown in targets.mjs
 *
 * Covers:
 * 1. Em-dash (—) separator stripped: "`path` — EDIT — desc" → "path"
 * 2. En-dash (–) separator stripped: "`path` – EDIT – desc" → "path"
 * 3. Spaced hyphen (-) separator stripped: "`path` - EDIT - desc" → "path"
 * 4. Paren format still works: "path (description)" → "path"
 * 5. Plain path with no suffix: "path/to/file.ts" → "path/to/file.ts"
 * 6. Backtick-wrapped path with no suffix: "`path/to/file.ts`" → "path/to/file.ts"
 * 7. Embedded hyphen in filename unaffected: "my-file.ts — EDIT — desc" → "my-file.ts"
 * 8. Full PO Governor standard format: backtick + em-dash + op + em-dash + desc
 */
import { describe, it, expect } from 'vitest';
import { parseTargetsFromMarkdown } from '../../packages/mcp-rks/src/llm/targets.mjs';

function makeBody(bullets) {
  return `## Target Files\n${bullets.map(b => `- ${b}`).join('\n')}\n`;
}

describe('parseTargetsFromMarkdown — em-dash stripping', () => {
  it('strips em-dash (—) separator: path — EDIT — desc', () => {
    const body = makeBody(['`services/sqliteService.ts` — EDIT — Add releaseDiscrepancyToNRC method']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['services/sqliteService.ts']);
  });

  it('strips en-dash (–) separator: path – EDIT – desc', () => {
    const body = makeBody(['`src/foo.mjs` – EDIT – Update foo logic']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/foo.mjs']);
  });

  it('strips spaced hyphen (-) separator: path - EDIT - desc', () => {
    const body = makeBody(['`src/bar.mjs` - CREATE FILE - New bar module']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/bar.mjs']);
  });

  it('handles full PO Governor standard format with CREATE FILE op', () => {
    const body = makeBody([
      '`src/components/Calculator.tsx` — CREATE FILE — Main calculator component',
      '`package.json` — EDIT — Add React dependencies',
    ]);
    expect(parseTargetsFromMarkdown(body)).toEqual([
      'src/components/Calculator.tsx',
      'package.json',
    ]);
  });
});

describe('parseTargetsFromMarkdown — no regressions', () => {
  it('still strips paren trailing description: path (description)', () => {
    const body = makeBody(['packages/cli/src/project/index.js (project subsystem: init and helpers)']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['packages/cli/src/project/index.js']);
  });

  it('plain path with no suffix is returned as-is', () => {
    const body = makeBody(['src/utils/helper.mjs']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/utils/helper.mjs']);
  });

  it('backtick-wrapped path with no suffix strips backticks', () => {
    const body = makeBody(['`src/utils/helper.mjs`']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/utils/helper.mjs']);
  });

  it('embedded hyphen in filename is NOT stripped', () => {
    const body = makeBody(['`my-file.ts` — EDIT — Update hyphenated file']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['my-file.ts']);
  });

  it('path with multiple directory hyphens is NOT stripped', () => {
    const body = makeBody(['`packages/mcp-rks/src/llm/plan-ready.mjs` — EDIT — Fix check']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['packages/mcp-rks/src/llm/plan-ready.mjs']);
  });

  it('returns empty array when no ## Target Files section', () => {
    const body = '## Problem\nSome description\n';
    expect(parseTargetsFromMarkdown(body)).toEqual([]);
  });

  it('deduplicates repeated paths', () => {
    const body = makeBody([
      '`src/foo.mjs` — EDIT — First mention',
      '`src/foo.mjs` — EDIT — Second mention',
    ]);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/foo.mjs']);
  });
});

// ─── Fenced blocks are content, not structure ────────────────────────────────
// backlog.fix.target-parse-fence-blind-false-targets.
//
// extractSection had no fence state, so every line of a fenced code block reached
// the bullet regex. A JSDoc continuation line is asterisk-led and matched, turning
// prose into a "target path". A child project reported targetCount 53 against 10
// real targets and 43 blocking missing_create_directive issues naming prose.
//
// The witness lines below are the two the field report named. They are written as
// string concatenation rather than as literals inside this file's own comments,
// so this suite cannot poison a parser run over its own source.
describe('parseTargetsFromMarkdown — fenced blocks are not targets', () => {
  const STAR = ' ' + '*' + ' ';
  const fence = (lang, ...body) => ['```' + lang, ...body, '```'].join('\n');

  const sectionWith = (...lines) => '## Target Files\n\n' + lines.join('\n') + '\n\n## Next\n';

  it('a JSDoc prose line inside a fence yields no target', () => {
    const body = sectionWith(
      '- `src/real.mjs` — EDIT — genuine',
      fence('javascript', '/**', STAR + 'Owned-account analytics storage and queries.', ' */'),
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/real.mjs']);
  });

  it('a JSDoc @param line inside a fence yields no target', () => {
    const body = sectionWith(
      '- `src/real.mjs` — EDIT — genuine',
      fence('javascript', '/**', STAR + '@param {string} handle', ' */'),
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/real.mjs']);
  });

  it('bullets BEFORE and AFTER a fence are both still returned', () => {
    const body = sectionWith(
      '- `src/before.mjs` — EDIT — one',
      fence('javascript', STAR + 'noise', '- not a bullet'),
      '- `src/after.mjs` — EDIT — two',
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/before.mjs', 'src/after.mjs']);
  });

  it('dash-led lines inside a fence (YAML sequence items) yield no targets', () => {
    const body = sectionWith(
      '- `src/real.mjs` — EDIT — genuine',
      fence('yaml', 'targetFiles:', '  - path: "src/decoy.mjs"', '    op: "edit"'),
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/real.mjs']);
  });

  it('two fences in one section are each tracked; the bullet between them survives', () => {
    const body = sectionWith(
      fence('javascript', STAR + 'first noise'),
      '- `src/middle.mjs` — EDIT — between the fences',
      fence('javascript', STAR + 'second noise'),
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/middle.mjs']);
  });

  it('a bare fence opener with no info string is tracked too', () => {
    const body = sectionWith(
      '- `src/real.mjs` — EDIT — genuine',
      fence('', STAR + 'noise'),
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/real.mjs']);
  });

  it('a tilde fence is tracked', () => {
    const body = sectionWith(
      '- `src/real.mjs` — EDIT — genuine',
      ['~~~javascript', STAR + 'noise', '~~~'].join('\n'),
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/real.mjs']);
  });

  it('an UNTERMINATED fence does not throw and keeps bullets that preceded it', () => {
    const body = '## Target Files\n\n'
      + '- `src/before.mjs` — EDIT — genuine\n'
      + '```javascript\n'
      + STAR + 'noise that never closes\n';
    expect(() => parseTargetsFromMarkdown(body)).not.toThrow();
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/before.mjs']);
  });

  it('a heading INSIDE a fence does not truncate the section', () => {
    // Otherwise fenced markdown would end collection early — an under-collection
    // defect swapped in for the over-collection one.
    const body = sectionWith(
      '- `src/before.mjs` — EDIT — one',
      fence('markdown', '## Not A Real Heading'),
      '- `src/after.mjs` — EDIT — two',
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/before.mjs', 'src/after.mjs']);
  });

  it('N genuine bullets plus any number of fences returns exactly those N', () => {
    const body = sectionWith(
      '- `src/a.mjs` — EDIT — one',
      fence('javascript', STAR + 'x', '- y', '* z'),
      '- `src/b.mjs` — EDIT — two',
      fence('yaml', '  - path: "decoy"'),
      '- `src/c.mjs` — EDIT — three',
    );
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  });
});
