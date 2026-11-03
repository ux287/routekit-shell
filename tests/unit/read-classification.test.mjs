import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Set test environment before importing
const TEST_PROJECT_DIR = path.join(process.cwd(), '.tmp-test-classification');
process.env.CLAUDE_PROJECT_DIR = TEST_PROJECT_DIR;

// Create test session dir
fs.mkdirSync(path.join(TEST_PROJECT_DIR, '.rks', 'session'), { recursive: true });

const { classifyReadIntent } = await import('../../packages/mcp-rks/src/shared/read-classification.mjs');

describe('classifyReadIntent', () => {
  const baseConfig = {
    mode: 'block',
    rag_path_ttl_turns: 3,
    user_path_ttl_turns: 5,
    exploration_detection: { threshold: 0.6 },
    runtime_paths: ['.routekit/*.yaml', 'package.json', 'CLAUDE.md'],
    strict_rag_paths: ['notes/*', 'docs/*']
  };

  afterEach(() => {
    try {
      fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    } catch (e) {}
  });

  describe('runtime config paths', () => {
    it('allows .routekit/*.yaml', () => {
      const result = classifyReadIntent({
        targetPath: '.routekit/enforcement.yaml',
        toolName: 'Read',
        toolInput: { file_path: '.routekit/enforcement.yaml' },
        config: baseConfig
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('runtime_config');
    });

    it('allows package.json', () => {
      const result = classifyReadIntent({
        targetPath: 'package.json',
        toolName: 'Read',
        toolInput: { file_path: 'package.json' },
        config: baseConfig
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('runtime_config');
    });

    it('allows CLAUDE.md', () => {
      const result = classifyReadIntent({
        targetPath: 'CLAUDE.md',
        toolName: 'Read',
        toolInput: { file_path: 'CLAUDE.md' },
        config: baseConfig
      });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('runtime_config');
    });
  });

  describe('strict RAG paths', () => {
    it('blocks notes/ paths', () => {
      const result = classifyReadIntent({
        targetPath: 'notes/backlog.foo.md',
        toolName: 'Read',
        toolInput: { file_path: 'notes/backlog.foo.md' },
        config: baseConfig
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('exploration');
      expect(result.suggestion).toBeDefined();
    });

    it('blocks docs/ paths', () => {
      const result = classifyReadIntent({
        targetPath: 'docs/readme.md',
        toolName: 'Read',
        toolInput: { file_path: 'docs/readme.md' },
        config: baseConfig
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('exploration');
    });
  });

  describe('pattern search detection', () => {
    it('blocks Glob operations', () => {
      const result = classifyReadIntent({
        targetPath: 'packages/**/*.mjs',
        toolName: 'Glob',
        toolInput: { pattern: 'packages/**/*.mjs' },
        config: baseConfig
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('pattern_search');
    });

    it('blocks Grep operations', () => {
      const result = classifyReadIntent({
        targetPath: 'packages/',
        toolName: 'Grep',
        toolInput: { path: 'packages/', pattern: 'function' },
        config: baseConfig
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('pattern_search');
    });
  });

  describe('project source detection', () => {
    it('allows single code file read (project source heuristic)', () => {
      const result = classifyReadIntent({
        targetPath: 'packages/cli/src/foo.mjs',
        toolName: 'Read',
        toolInput: { file_path: 'packages/cli/src/foo.mjs' },
        config: { ...baseConfig, strict_rag_paths: [] }
      });
      // Should allow with project_source reason due to code file extension
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('project_source');
    });
  });

  describe('default behavior', () => {
    it('returns classification result with metadata', () => {
      const result = classifyReadIntent({
        targetPath: 'some/file.txt',
        toolName: 'Read',
        toolInput: { file_path: 'some/file.txt' },
        config: { ...baseConfig, mode: 'warn', strict_rag_paths: [] }
      });
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('metadata');
    });
  });
});
