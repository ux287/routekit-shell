import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CI_IGNORED_PATH_PREFIXES } from '../../packages/mcp-rks/src/server/git/git-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CI_CONFIG = parseYaml(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const PUSH = CI_CONFIG.on.push['paths-ignore'];
const PR = CI_CONFIG.on.pull_request['paths-ignore'];

// GitHub paths-ignore semantics for these patterns: a trailing '**' is a prefix match.
const matches = (file, pattern) => (pattern.endsWith('**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern);
const allIgnored = (files, patterns) => files.every((f) => patterns.some((p) => matches(f, p)));
// Same predicate isCiIgnored applies in git-release.mjs (not exported).
const gateIgnored = (file) => CI_IGNORED_PATH_PREFIXES.some((p) => file === p || file.startsWith(p));

const ARCHIVE_FILE = 'notes/z_archive.backlog.feat.x.md';
const CODE_FILE = 'packages/mcp-rks/src/server/exec.mjs';

const PRIOR_CI_ENTRIES = [
  'package.json', 'CHANGELOG.md', 'notes/research.public.**', 'notes/backlog.**', 'notes/research.**',
  'notes/canon.**', 'notes/how-to.**', 'notes/scratch.**', '.rks/project.json', '.rks/active-scope.json',
  'notes/ideas.**', 'notes/design.**', 'notes/notes.**', 'notes/decision.**',
];
const PRIOR_GATE_PREFIXES = [
  'package.json', 'CHANGELOG.md', 'notes/research.', 'notes/backlog.', 'notes/canon.', 'notes/decision.',
  'notes/how-to.', 'notes/scratch.', 'notes/ideas.', 'notes/design.', 'notes/notes.',
  '.rks/project.json', '.rks/active-scope.json',
];

describe('z_archive ci.yml paths-ignore', () => {
  it('push list contains notes/z_archive.**', () => {
    expect(PUSH).toContain('notes/z_archive.**');
  });

  it('pull_request list contains notes/z_archive.**', () => {
    expect(PR).toContain('notes/z_archive.**');
  });

  it('a z_archive-only change is ignored by both lists', () => {
    expect(allIgnored([ARCHIVE_FILE], PUSH)).toBe(true);
    expect(allIgnored([ARCHIVE_FILE], PR)).toBe(true);
  });

  it('a z_archive change mixed with a code file runs CI under both lists', () => {
    expect(allIgnored([ARCHIVE_FILE, CODE_FILE], PUSH)).toBe(false);
    expect(allIgnored([ARCHIVE_FILE, CODE_FILE], PR)).toBe(false);
  });

  it('both lists equal the prior entries plus notes/z_archive.** and nothing else', () => {
    const expected = [...PRIOR_CI_ENTRIES, 'notes/z_archive.**'].sort();
    expect([...PUSH].sort()).toEqual(expected);
    expect([...PR].sort()).toEqual(expected);
  });
});

describe('z_archive release gate prefixes', () => {
  it('CI_IGNORED_PATH_PREFIXES contains notes/z_archive.', () => {
    expect(CI_IGNORED_PATH_PREFIXES).toContain('notes/z_archive.');
  });

  it('the gate predicate classifies a z_archive note as CI-ignored', () => {
    expect(gateIgnored(ARCHIVE_FILE)).toBe(true);
  });

  it('a z_archive change mixed with a code file is CI-relevant to the gate', () => {
    expect(gateIgnored(CODE_FILE)).toBe(false);
    expect([ARCHIVE_FILE, CODE_FILE].every(gateIgnored)).toBe(false);
  });

  it('CI_IGNORED_PATH_PREFIXES equals the prior entries plus notes/z_archive. and nothing else', () => {
    expect([...CI_IGNORED_PATH_PREFIXES].sort()).toEqual([...PRIOR_GATE_PREFIXES, 'notes/z_archive.'].sort());
  });
});
