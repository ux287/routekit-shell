import { describe, it, expect } from 'vitest';
import { classifyContentType, CONTENT_TYPES } from '../../../packages/mcp-rks/src/rag/source-classifier.mjs';

describe('classifyContentType', () => {
  describe('skill', () => {
    it('classifies .claude/skills/ files as skill', () => {
      expect(classifyContentType('.claude/skills/build/SKILL.md', null)).toBe(CONTENT_TYPES.SKILL);
    });
    it('classifies nested .claude/skills/ paths as skill', () => {
      expect(classifyContentType('.claude/skills/research/SKILL.md', null)).toBe(CONTENT_TYPES.SKILL);
    });
  });

  describe('llm-context', () => {
    it('classifies .rks/prompts/ files as llm-context', () => {
      expect(classifyContentType('.rks/prompts/governor-build.md', null)).toBe(CONTENT_TYPES.LLM_CONTEXT);
    });
    it('classifies CLAUDE.md as llm-context', () => {
      expect(classifyContentType('CLAUDE.md', null)).toBe(CONTENT_TYPES.LLM_CONTEXT);
    });
    it('classifies .claude/MEMORY.md as llm-context', () => {
      expect(classifyContentType('.claude/MEMORY.md', null)).toBe(CONTENT_TYPES.LLM_CONTEXT);
    });
    it('classifies .claude/agents.md as llm-context', () => {
      expect(classifyContentType('.claude/agents.md', null)).toBe(CONTENT_TYPES.LLM_CONTEXT);
    });
  });

  describe('implemented', () => {
    it('classifies notes/backlog.z_implemented.* as implemented', () => {
      expect(classifyContentType('notes/backlog.z_implemented.feat.ship-governor.md', null)).toBe(CONTENT_TYPES.IMPLEMENTED);
    });
    it('classifies deeply nested notes/backlog.z_implemented.fix.deep.namespace.path.md as implemented', () => {
      expect(classifyContentType('notes/backlog.z_implemented.fix.deep.namespace.path.md', null)).toBe(CONTENT_TYPES.IMPLEMENTED);
    });
    it('does NOT classify the broken top-level notes/z_implemented.foo.md as implemented', () => {
      // Guard against regression to the pre-fix regex that matched the wrong
      // (non-existent) top-level z_implemented namespace.
      expect(classifyContentType('notes/z_implemented.foo.md', null)).not.toBe(CONTENT_TYPES.IMPLEMENTED);
    });
    it.each([
      ['feat', 'notes/backlog.z_implemented.feat.foo.md'],
      ['fix', 'notes/backlog.z_implemented.fix.bar.md'],
      ['perf', 'notes/backlog.z_implemented.perf.baz.md'],
      ['refactor', 'notes/backlog.z_implemented.refactor.qux.md'],
      ['docs', 'notes/backlog.z_implemented.docs.readme.md'],
    ])('classifies backlog.z_implemented.%s.* as implemented', (_leaf, path) => {
      expect(classifyContentType(path, null)).toBe(CONTENT_TYPES.IMPLEMENTED);
    });
    it('classifies basename-only backlog.z_implemented.feat.foo.md as implemented', () => {
      expect(classifyContentType('backlog.z_implemented.feat.foo.md', null)).toBe(CONTENT_TYPES.IMPLEMENTED);
    });
    it('classifies sibling notes/backlog.feat.foo.md as backlog (not implemented)', () => {
      // Confirms the IMPLEMENTED fix did not over-broaden and start
      // swallowing regular (unshipped) backlog stories.
      expect(classifyContentType('notes/backlog.feat.foo.md', null)).toBe(CONTENT_TYPES.BACKLOG);
    });
  });

  describe('backlog', () => {
    it('classifies notes/backlog.* as backlog', () => {
      expect(classifyContentType('notes/backlog.feat.rag-content-type-tagging.md', null)).toBe(CONTENT_TYPES.BACKLOG);
    });
    it('classifies files with noteType backlog as backlog', () => {
      expect(classifyContentType('notes/something-ambiguous.md', 'backlog')).toBe(CONTENT_TYPES.BACKLOG);
    });
  });

  describe('code', () => {
    it('classifies .mjs source files as code', () => {
      expect(classifyContentType('packages/mcp-rks/src/server/project.mjs', null)).toBe(CONTENT_TYPES.CODE);
    });
    it('classifies .ts files as code', () => {
      expect(classifyContentType('src/index.ts', null)).toBe(CONTENT_TYPES.CODE);
    });
    it('classifies .js files as code', () => {
      expect(classifyContentType('scripts/rag/query.js', null)).toBe(CONTENT_TYPES.CODE);
    });
    it('classifies any non-markdown file not otherwise classified as code', () => {
      expect(classifyContentType('config/settings.yaml', null)).toBe(CONTENT_TYPES.CODE);
    });
  });

  describe('note', () => {
    it('classifies unrecognized markdown notes as note', () => {
      expect(classifyContentType('notes/scratch.venture-beat-article.md', null)).toBe(CONTENT_TYPES.NOTE);
    });
    it('classifies how-to notes as note', () => {
      expect(classifyContentType('notes/how-to.agent-operations.md', null)).toBe(CONTENT_TYPES.NOTE);
    });
  });

  describe('exports', () => {
    it('exports CONTENT_TYPES enum with all 6 values', () => {
      expect(Object.values(CONTENT_TYPES)).toEqual(
        expect.arrayContaining(['skill', 'llm-context', 'implemented', 'backlog', 'code', 'note'])
      );
    });
  });
});
