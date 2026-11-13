import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { buildDendronCommitMessage } from '../../packages/mcp-rks/src/shared/dendron-commit-message.mjs';
import { CI_IGNORED_PATH_PREFIXES } from '../../packages/mcp-rks/src/server/git/git-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CI_CONFIG = parseYaml(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
const PUSH = CI_CONFIG.on.push['paths-ignore'];
const PR = CI_CONFIG.on.pull_request['paths-ignore'];

// GitHub paths-ignore semantics for the patterns this file uses: a trailing '**' is a prefix match.
const matches = (file, pattern) => (pattern.endsWith('**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern);
const allIgnored = (files, patterns) => files.every((f) => patterns.some((p) => matches(f, p)));

describe('decision commit scope', () => {
  it('maps a decision.* note id to scope decision', () => {
    expect(buildDendronCommitMessage('dendron_create_note', 'decision.foo')).toBe('docs(decision): create decision.foo');
  });

  it('keeps the existing prefix scopes', () => {
    expect(buildDendronCommitMessage('dendron_create_note', 'research.x')).toBe('docs(research): create research.x');
    expect(buildDendronCommitMessage('dendron_create_note', 'backlog.feat.y')).toBe('docs(backlog): create backlog.feat.y');
    expect(buildDendronCommitMessage('dendron_create_note', 'canon.z')).toBe('docs(canon): create canon.z');
    expect(buildDendronCommitMessage('dendron_create_note', 'memories.m')).toBe('docs(memory): create memories.m');
    expect(buildDendronCommitMessage('dendron_create_note', 'design.d')).toBe('docs(notes): create design.d');
  });
});

describe('decision CI ignore', () => {
  it('both paths-ignore lists contain notes/decision.**', () => {
    expect(PUSH).toContain('notes/decision.**');
    expect(PR).toContain('notes/decision.**');
  });

  it('paths-ignore lists are identical and cover every notes/ prefix in CI_IGNORED_PATH_PREFIXES', () => {
    expect(PUSH).toEqual(PR);
    const notePrefixes = CI_IGNORED_PATH_PREFIXES.filter((p) => p.startsWith('notes/'));
    expect(notePrefixes).toContain('notes/decision.');
    for (const prefix of notePrefixes) {
      expect(PUSH).toContain(`${prefix}**`);
    }
  });

  it('a commit touching only a decision note is ignored by both lists', () => {
    expect(allIgnored(['notes/decision.some-topic.md'], PUSH)).toBe(true);
    expect(allIgnored(['notes/decision.some-topic.md'], PR)).toBe(true);
    expect(allIgnored(['notes/decision.some-topic.md', 'packages/mcp-rks/src/server/exec.mjs'], PUSH)).toBe(false);
  });
});
