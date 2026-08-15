/**
 * Pins the offRail.roots scope boundary after adding CHANGELOG.md.
 *
 * offRail.roots is the allowlist deciding which files rks_guardrails_off may
 * write, so this is a security/scope boundary, not a config list. Presence of
 * the string in the array is NOT sufficient evidence that the change works —
 * these tests exercise authorization through guardrailsOff itself, in both
 * directions: CHANGELOG.md authorized, docs/CHANGELOG.md denied.
 *
 * matchesOffRailRoot and targetFilesMatchRoots are module-private (no `export`),
 * so the matcher cannot be imported directly; it is reachable only through
 * guardrailsOff. Line numbers in these comments were re-derived at the build
 * commit — per this story's CITATION ACCURACY requirement, a transcribed line
 * number is not evidence.
 *
 * (backlog.feat.offrail-roots-changelog-md)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The repository's REAL config — the artifact this story changes. */
const realProjectJson = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.rks', 'project.json'), 'utf8'),
);
const realRoots = realProjectJson.offRail.roots;

let tmpDir;
let guardrailsOff;
let resolveOffRailConfig;

/** Mirrors the helper in tests/unit/guardrails-off-guidance.spec.mjs. */
function seedProject({ offRail, problemId, targetFiles }) {
  fs.mkdirSync(path.join(tmpDir, '.rks'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.routekit', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.rks', 'project.json'),
    JSON.stringify(offRail === undefined ? {} : { offRail }, null, 2),
  );
  if (problemId) {
    const fm = [
      '---',
      `id: "${problemId}"`,
      'title: "Test"',
      'desc: "test"',
      'phase: "arch-approved"',
      'targetFiles:',
      ...targetFiles.flatMap((p) => [`  - path: "${p}"`, '    op: "edit"', '    desc: "test"']),
      '---',
      '',
      '## Problem',
      'test',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'notes', `${problemId}.md`), fm);
  }
}

beforeEach(async () => {
  ({ guardrailsOff, resolveOffRailConfig } = await import(
    '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
  ));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offrail-roots-changelog-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('offRail.roots — CHANGELOG.md entry', () => {
  it('contains the exact bare string, with no wildcard variant', () => {
    expect(realRoots).toContain('CHANGELOG.md');
    // The bare literal is the narrowest form this matcher can express. A
    // wildcard would be strictly broader and is the wrong fix here.
    expect(realRoots).not.toContain('CHANGELOG*');
    expect(realRoots).not.toContain('CHANGELOG.md*');
    expect(realRoots).not.toContain('CHANGELOG.md/*');
  });

  it('has exactly 28 string entries and every entry is a non-empty string', () => {
    expect(realRoots).toHaveLength(28);
    for (const entry of realRoots) {
      expect(typeof entry).toBe('string');
      expect(entry.trim()).toBe(entry);
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  it('leaves offRail.enabled true and the surrounding config intact', () => {
    expect(realProjectJson.offRail.enabled).toBe(true);
    expect(realProjectJson.id).toBe('routekit-shell-core');
    // Every root-level maintained file is now an offRail root — the coherence
    // property this story delivers.
    for (const rootFile of ['LICENSE', 'README.md', 'SECURITY.md', 'CLAUDE.md', 'CHANGELOG.md']) {
      expect(realRoots).toContain(rootFile);
    }
  });

  it('is still a valid configured offRail block', () => {
    const resolved = resolveOffRailConfig(realProjectJson);
    expect(resolved.mode).toBe('configured');
    expect(resolved.roots).toContain('CHANGELOG.md');
  });
});

describe('offRail.roots — CHANGELOG.md authorization is exercised, not assumed', () => {
  it('AUTHORIZES a story whose targetFiles are [CHANGELOG.md]', async () => {
    // Seeded with the REAL roots array: this assertion fails before the change
    // and passes only after it, so it cannot pass vacuously.
    seedProject({
      offRail: { enabled: true, roots: realRoots },
      problemId: 'backlog.feat.test',
      targetFiles: ['CHANGELOG.md'],
    });

    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');

    expect(res.reason).not.toBe('non_core_work');
    expect(res.ok).toBe(true);
  });

  it('SCOPE BOUND: denies a nested docs/CHANGELOG.md', async () => {
    // Matching is filePath.startsWith(prefix) over REPO-RELATIVE paths, so a
    // bare root-file entry cannot authorize a nested path.
    seedProject({
      offRail: { enabled: true, roots: realRoots },
      problemId: 'backlog.feat.test',
      targetFiles: ['docs/CHANGELOG.md'],
    });

    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('non_core_work');
  });

  it('negative control: the roots array is what grants it, not the filename', async () => {
    // Same targetFile, roots WITHOUT the entry -> denied. Proves the previous
    // authorization came from the config change and nothing else.
    seedProject({
      offRail: { enabled: true, roots: realRoots.filter((r) => r !== 'CHANGELOG.md') },
      problemId: 'backlog.feat.test',
      targetFiles: ['CHANGELOG.md'],
    });

    const res = await guardrailsOff(tmpDir, 'test', 'all', 'backlog.feat.test', 'test-project');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('non_core_work');
  });
});
