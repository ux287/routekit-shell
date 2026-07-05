/**
 * Unit tests for dendron-server.mjs template merging functionality
 * Tests the fix for backlog.dogfooding.01-mcp-schema-template-consistency
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

// Extract functions from dendron-server.mjs for testing
// We'll inline the functions here since the server file isn't designed as a module

function parseFrontmatter(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed.startsWith('---')) return { data: {}, content: trimmed };
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return { data: {}, content: trimmed };
  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();
  const data = {};
  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (value === '[]') value = [];
      else if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      data[match[1]] = value;
    }
  }
  return { data, content: body };
}

function mergeTemplateWithGenerated(generated, templateParsed, content, id) {
  const tmplFm = (templateParsed && templateParsed.data) || {};
  const tmplBody = (templateParsed && templateParsed.content) || "";
  const merged = { ...tmplFm, ...generated };
  merged.id = id;
  // Body: if content provided, it REPLACES template body; otherwise use template body (placeholders)
  const body = (content && String(content).trim())
    ? String(content).trim()
    : (tmplBody && String(tmplBody).trim()) || "";
  return { merged, body };
}

describe('dendron template merging', () => {
  describe('parseFrontmatter', () => {
    it('parses basic frontmatter', () => {
      const content = `---
id: test
title: Test Title
status: not-implemented
targetFiles: []
---

Body content here.`;

      const result = parseFrontmatter(content);
      expect(result.data.id).toBe('test');
      expect(result.data.title).toBe('Test Title');
      expect(result.data.status).toBe('not-implemented');
      expect(result.data.targetFiles).toEqual([]);
      expect(result.content).toBe('Body content here.');
    });

    it('handles content without frontmatter', () => {
      const result = parseFrontmatter('Just plain content');
      expect(result.data).toEqual({});
      expect(result.content).toBe('Just plain content');
    });
  });

  describe('mergeTemplateWithGenerated', () => {
    const templateParsed = {
      data: { status: 'not-implemented', targetFiles: [] },
      content: '## Problem\nTemplate placeholder.\n\n## Goal\nTemplate goal placeholder.'
    };

    const generated = {
      title: 'Test Note',
      desc: 'Test description',
      updated: '2026-01-17T00:00:00Z',
      created: '2026-01-17T00:00:00Z'
    };

    it('REPLACES template body when content is provided', () => {
      const content = '## Problem\nActual problem.\n\n## Goal\nActual goal.';
      const result = mergeTemplateWithGenerated(generated, templateParsed, content, 'backlog.test');

      // Content should REPLACE, not append
      expect(result.body).toBe(content);
      expect(result.body).not.toContain('Template placeholder');
      expect(result.body).toContain('Actual problem');
    });

    it('uses template body when no content provided', () => {
      const result = mergeTemplateWithGenerated(generated, templateParsed, '', 'backlog.test');

      expect(result.body).toContain('Template placeholder');
      expect(result.body).toContain('Template goal placeholder');
    });

    it('uses template body when content is only whitespace', () => {
      const result = mergeTemplateWithGenerated(generated, templateParsed, '   \n  ', 'backlog.test');

      expect(result.body).toContain('Template placeholder');
    });

    it('merges template frontmatter fields with generated fields', () => {
      const content = '## Problem\nActual problem.';
      const result = mergeTemplateWithGenerated(generated, templateParsed, content, 'backlog.test');

      // Template fields should be present
      expect(result.merged.status).toBe('not-implemented');
      expect(result.merged.targetFiles).toEqual([]);

      // Generated fields should be present
      expect(result.merged.title).toBe('Test Note');
      expect(result.merged.desc).toBe('Test description');

      // ID should be set from parameter
      expect(result.merged.id).toBe('backlog.test');
    });

    it('generated fields override template fields (except custom fields)', () => {
      const templateWithTitle = {
        data: { status: 'not-implemented', title: 'Template Title' },
        content: 'Body'
      };

      const result = mergeTemplateWithGenerated(generated, templateWithTitle, '', 'backlog.test');

      // Generated title should win
      expect(result.merged.title).toBe('Test Note');
      // Custom template field should remain
      expect(result.merged.status).toBe('not-implemented');
    });
  });

  describe('integration: backlog template application', () => {
    it('reads actual templates.backlog.md and verifies structure', () => {
      const templatePath = join(PROJECT_ROOT, 'notes', 'templates.backlog.md');
      const templateContent = readFileSync(templatePath, 'utf8');
      const parsed = parseFrontmatter(templateContent);

      // Verify template has required frontmatter fields
      expect(parsed.data.status).toBe('not-implemented');
      expect(parsed.data.targetFiles).toEqual([]);

      // Verify template body has expected sections
      expect(parsed.content).toContain('## Problem');
      expect(parsed.content).toContain('## Goal');
      expect(parsed.content).toContain('## Acceptance Criteria');
    });

    it('simulates full backlog note creation with content', () => {
      // Read actual template
      const templatePath = join(PROJECT_ROOT, 'notes', 'templates.backlog.md');
      const templateContent = readFileSync(templatePath, 'utf8');
      const templateParsed = parseFrontmatter(templateContent);

      // Simulate generated frontmatter
      const generated = {
        title: 'Test Feature',
        desc: 'Test feature description',
        updated: new Date().toISOString(),
        created: new Date().toISOString()
      };

      // User-provided content
      const userContent = `## Problem
The actual problem we need to solve.

## Goal
The actual goal we want to achieve.

## Target Files
- src/actual-file.ts

## Acceptance Criteria
- [ ] Actual criterion 1
- [ ] Actual criterion 2`;

      const result = mergeTemplateWithGenerated(generated, templateParsed, userContent, 'backlog.test-feature');

      // Verify content REPLACED template (no placeholder text)
      expect(result.body).not.toContain('Describe the problem clearly');
      expect(result.body).not.toContain('Describe the desired outcome');
      expect(result.body).toContain('The actual problem we need to solve');
      expect(result.body).toContain('src/actual-file.ts');

      // Verify frontmatter merged correctly
      expect(result.merged.status).toBe('not-implemented');
      expect(result.merged.targetFiles).toEqual([]);
      expect(result.merged.title).toBe('Test Feature');
      expect(result.merged.id).toBe('backlog.test-feature');
    });
  });
});
