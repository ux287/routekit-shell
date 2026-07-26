import { describe, it, expect } from 'vitest';
import { classifySource, SOURCE_CLASSES } from '../../packages/mcp-rks/src/rag/source-classifier.mjs';

describe('classifySource', () => {
  describe('frontmatter override', () => {
    it('uses explicit source_class from frontmatter', () => {
      const result = classifySource({
        path: 'notes/public-doc.md',
        frontmatter: { source_class: 'sensitive' },
        content: 'Normal content',
        domain: 'notes'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('ignores invalid frontmatter values', () => {
      const result = classifySource({
        path: 'notes/doc.md',
        frontmatter: { source_class: 'invalid-class' },
        content: 'Normal content',
        domain: 'notes'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('handles missing frontmatter gracefully', () => {
      const result = classifySource({
        path: 'notes/doc.md',
        content: 'Normal content'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('handles undefined options gracefully', () => {
      const result = classifySource();
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });
  });

  describe('path pattern matching', () => {
    it('classifies clients/ paths as client', () => {
      expect(classifySource({ path: 'clients/acme/notes.md' })).toBe(SOURCE_CLASSES.CLIENT);
    });

    it('classifies client. prefix as client', () => {
      expect(classifySource({ path: 'client.acme.notes.md' })).toBe(SOURCE_CLASSES.CLIENT);
    });

    it('classifies secrets/ paths as sensitive', () => {
      expect(classifySource({ path: 'secrets/api-keys.md' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies .env files as sensitive', () => {
      expect(classifySource({ path: '.env' })).toBe(SOURCE_CLASSES.SENSITIVE);
      expect(classifySource({ path: '.env.local' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies credentials paths as sensitive', () => {
      expect(classifySource({ path: 'credentials/aws.json' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies legal/ paths as legal', () => {
      expect(classifySource({ path: 'legal/contract-template.md' })).toBe(SOURCE_CLASSES.LEGAL);
    });

    it('classifies compliance/ paths as legal', () => {
      expect(classifySource({ path: 'compliance/gdpr.md' })).toBe(SOURCE_CLASSES.LEGAL);
    });

    it('classifies contracts/ paths as legal', () => {
      expect(classifySource({ path: 'contracts/nda.md' })).toBe(SOURCE_CLASSES.LEGAL);
    });

    it('classifies vendor/ paths as public', () => {
      expect(classifySource({ path: 'vendor/lodash/readme.md' })).toBe(SOURCE_CLASSES.PUBLIC);
    });

    it('classifies third-party paths as public', () => {
      expect(classifySource({ path: 'third-party/react/index.js' })).toBe(SOURCE_CLASSES.PUBLIC);
    });

    it('classifies incident/ paths as sensitive', () => {
      expect(classifySource({ path: 'incident/2024-01-breach.md' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('classifies postmortem/ paths as sensitive', () => {
      expect(classifySource({ path: 'postmortem/outage-report.md' })).toBe(SOURCE_CLASSES.SENSITIVE);
    });
  });

  describe('content marker detection', () => {
    it('detects SECRET marker as sensitive', () => {
      const result = classifySource({
        path: 'notes/config.md',
        content: 'The API_KEY is SECRET and should not be shared'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('detects PRIVATE marker as sensitive', () => {
      const result = classifySource({
        path: 'notes/internal.md',
        content: 'This document is PRIVATE'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('detects CONFIDENTIAL marker as sensitive', () => {
      const result = classifySource({
        path: 'notes/report.md',
        content: 'CONFIDENTIAL - For internal use only'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('detects API_KEY marker as sensitive', () => {
      const result = classifySource({
        path: 'notes/setup.md',
        content: 'Set your API_KEY in the environment'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('detects password patterns as sensitive', () => {
      const result = classifySource({
        path: 'notes/setup.md',
        content: 'Database password: hunter2'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('detects password= pattern as sensitive', () => {
      const result = classifySource({
        path: 'notes/config.md',
        content: 'password=mysecretpass'
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });

    it('only checks first 2000 chars for performance', () => {
      // Use word characters for padding so SECRET appears after 2000 chars and word boundary won't help
      const longContent = 'some text '.repeat(300) + ' SECRET at end';
      const result = classifySource({
        path: 'notes/long-doc.md',
        content: longContent
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT); // SECRET is after 2000 chars
    });

    it('detects markers within first 2000 chars', () => {
      // Use spaces around SECRET so word boundary regex can match
      const content = 'some text '.repeat(100) + 'SECRET' + ' more text'.repeat(200);
      const result = classifySource({
        path: 'notes/doc.md',
        content
      });
      expect(result).toBe(SOURCE_CLASSES.SENSITIVE);
    });
  });

  describe('default classification', () => {
    it('defaults to project for notes domain', () => {
      const result = classifySource({
        path: 'notes/backlog.feature.something.md',
        domain: 'notes'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('defaults to project for code domain', () => {
      const result = classifySource({
        path: 'packages/cli/src/index.mjs',
        domain: 'code'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });

    it('defaults to project for unknown paths', () => {
      const result = classifySource({
        path: 'random/unknown/file.txt'
      });
      expect(result).toBe(SOURCE_CLASSES.PROJECT);
    });
  });

  describe('priority order', () => {
    it('frontmatter overrides path patterns', () => {
      // Even though path matches 'clients/', frontmatter says public
      const result = classifySource({
        path: 'clients/acme/public-readme.md',
        frontmatter: { source_class: 'public' }
      });
      expect(result).toBe(SOURCE_CLASSES.PUBLIC);
    });

    it('path patterns override content markers', () => {
      // vendor/ path should classify as public even with SECRET in content
      const result = classifySource({
        path: 'vendor/lib/config.md',
        content: 'API_KEY configuration'
      });
      expect(result).toBe(SOURCE_CLASSES.PUBLIC);
    });
  });
});

describe('SOURCE_CLASSES', () => {
  it('exports all expected source classes', () => {
    expect(SOURCE_CLASSES.PUBLIC).toBe('public');
    expect(SOURCE_CLASSES.PROJECT).toBe('project');
    expect(SOURCE_CLASSES.CLIENT).toBe('client');
    expect(SOURCE_CLASSES.SENSITIVE).toBe('sensitive');
    expect(SOURCE_CLASSES.LEGAL).toBe('legal');
  });
});
