/**
 * backlog.fix.bash-metachar-check-quote-aware — scanShellWords, the quote-aware,
 * fail-closed shell word scanner shared by the two Bash allowlist hooks.
 * Pure: no subprocess, no network. The only fs use is the byte-parity and scope checks.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { scanShellWords } from '../../packages/hooks/lib/shell-words.mjs';

describe('scanShellWords never throws (AC1)', () => {
  it.each([[undefined], [null], [42], [{}], [['git', 'log']]])('returns a result object for %p', (input) => {
    let r;
    expect(() => { r = scanShellWords(input); }).not.toThrow();
    expect(typeof r.ok).toBe('boolean');
  });
});

describe('scanShellWords rejects unquoted shell control (AC1)', () => {
  it.each([';', '&', '|', '`', '$', '(', ')', '{', '}', '<', '>', '\\'])('unquoted %s', (ch) => {
    expect(scanShellWords(`git log a${ch}b`).ok).toBe(false);
  });
  it.each(['git log\nrm x', 'git log\rrm x'])('an unquoted line break: %j', (cmd) => {
    expect(scanShellWords(cmd).ok).toBe(false);
  });
});

describe('scanShellWords fails closed on ambiguous quoting (AC1)', () => {
  it.each([
    "git log 'a\nb'",
    'git log "a\nb"',
    'git log "$(rm x)"',
    'git log "$HOME"',
    'git log "${X}"',
    'git log "`rm x`"',
    'git log "a\\$b"',
    'git log "a\\"b"',
    'git log "a\\\\b"',
    'git log "x',
    "git log 'x",
  ])('rejects %j', (cmd) => {
    expect(scanShellWords(cmd).ok).toBe(false);
  });
  it('names an unterminated quote as unbalanced-quote', () => {
    expect(scanShellWords('git log "x')).toMatchObject({ ok: false, reason: 'unbalanced-quote' });
    expect(scanShellWords("git log 'x")).toMatchObject({ ok: false, reason: 'unbalanced-quote' });
  });
});

describe('scanShellWords dequotes balanced quotes (AC2)', () => {
  it.each([
    ['git commit -m "fix (x)"', ['git', 'commit', '-m', 'fix (x)'], true],
    ["git log --grep='a\\|b'", ['git', 'log', '--grep=a\\|b'], true],
    ['git log --grep="a\\|b"', ['git', 'log', '--grep=a\\|b'], true],
    ['git -C "my repo" status', ['git', '-C', 'my repo', 'status'], false],
    ['git co""mmit -m x', ['git', 'commit', '-m', 'x'], false],
    ["git log ''", ['git', 'log', ''], false],
    ['  git\tstatus  ', ['git', 'status'], false],
  ])('%j', (cmd, words, quotedMeta) => {
    expect(scanShellWords(cmd)).toEqual({ ok: true, words, quotedMeta });
  });
  it('is deterministic', () => {
    const cmd = 'git commit -m "fix (x)"';
    expect(scanShellWords(cmd)).toEqual(scanShellWords(cmd));
  });
});

describe('lib/shell-words.mjs copies and scope', () => {
  const canonical = new URL('../../packages/hooks/lib/shell-words.mjs', import.meta.url);
  const template = new URL('../../templates/generic/.routekit/hooks/lib/shell-words.mjs', import.meta.url);
  const deployed = new URL('../../.routekit/hooks/lib/shell-words.mjs', import.meta.url);
  it('the template copy matches canonical', () => {
    expect(fs.readFileSync(template).equals(fs.readFileSync(canonical))).toBe(true);
  });
  it.skipIf(!fs.existsSync(deployed))('the deployed copy matches canonical (skipped until guardrails-on deploys it)', () => {
    expect(fs.readFileSync(deployed).equals(fs.readFileSync(canonical))).toBe(true);
  });
  it('AC12: project-test-command.mjs keeps its own META_RE and does not use the scanner', () => {
    const src = fs.readFileSync(new URL('../../packages/hooks/lib/project-test-command.mjs', import.meta.url), 'utf8');
    expect(src).toContain('const META_RE = ');
    expect(src).not.toContain('shell-words');
  });
});
