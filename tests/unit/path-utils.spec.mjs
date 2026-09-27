import { describe, it, expect } from 'vitest';
import { normalizePath, pathsMatch, getProjectRoot } from '../../packages/mcp-rks/src/shared/path-utils.mjs';

describe('normalizePath', () => {
  it('should strip leading slashes', () => {
    expect(normalizePath('/notes/foo.md')).toBe('notes/foo.md');
    expect(normalizePath('///notes/foo.md')).toBe('notes/foo.md');
  });

  it('should strip trailing slashes', () => {
    expect(normalizePath('notes/foo/')).toBe('notes/foo');
  });

  it('should handle empty/null input', () => {
    expect(normalizePath('')).toBe('');
    expect(normalizePath(null)).toBe('');
    expect(normalizePath(undefined)).toBe('');
  });

  it('should strip project root prefix', () => {
    const root = '/Users/test/project';
    expect(normalizePath('/Users/test/project/notes/foo.md', root)).toBe('notes/foo.md');
  });

  it('should handle relative paths', () => {
    expect(normalizePath('notes/foo.md')).toBe('notes/foo.md');
  });

  it('should handle absolute paths without project root', () => {
    expect(normalizePath('/absolute/path/file.md')).toBe('absolute/path/file.md');
  });
});

describe('pathsMatch', () => {
  it('should match equivalent paths with different formatting', () => {
    expect(pathsMatch('/notes/foo.md', 'notes/foo.md')).toBe(true);
    expect(pathsMatch('notes/foo.md/', '/notes/foo.md')).toBe(true);
  });

  it('should not match different paths', () => {
    expect(pathsMatch('notes/foo.md', 'notes/bar.md')).toBe(false);
  });

  it('should match paths with leading/trailing slashes', () => {
    expect(pathsMatch('//notes/foo.md/', 'notes/foo.md')).toBe(true);
    expect(pathsMatch('/notes/foo.md', 'notes/foo.md/')).toBe(true);
  });
});

describe('getProjectRoot', () => {
  it('should return a string', () => {
    const root = getProjectRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });
});

describe('integration: session-state and read-classification use same normalization', () => {
  it('should normalize paths consistently for provenance matching', () => {
    // This is the core bug we're fixing:
    // session-state was storing "/notes/foo.md"
    // read-classification was checking "notes/foo.md"
    // They should now both normalize to "notes/foo.md"

    const storedPath = '/notes/backlog.fix.example.md';
    const requestedPath = 'notes/backlog.fix.example.md';

    expect(pathsMatch(storedPath, requestedPath)).toBe(true);
  });

  it('should handle absolute paths from Claude tools', () => {
    const absolutePath = '/tmp/rks-fixture/routekit-shell/notes/foo.md';
    const relativePath = 'notes/foo.md';
    const projectRoot = '/tmp/rks-fixture/routekit-shell';

    expect(pathsMatch(absolutePath, relativePath, projectRoot)).toBe(true);
  });
});
