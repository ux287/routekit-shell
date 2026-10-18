/**
 * Unit tests for dendron MCP tools
 *
 * Tests dendron_create_note, dendron_update_field, and related functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');

// Import dendron functions
import {
  parseFrontmatter,
  formatWithFrontmatter,
  validateNoteFrontmatter,
  canonicalIdFromFilename,
  updateField,
  hasFrontmatter,
} from '../../packages/mcp-rks/src/dendron.mjs';

describe('dendron utility functions', () => {
  describe('parseFrontmatter', () => {
    it('should parse valid YAML frontmatter', () => {
      const content = `---
id: test-note
title: Test Note
status: not-implemented
---

Body content here.`;

      const result = parseFrontmatter(content);
      expect(result.data.id).toBe('test-note');
      expect(result.data.title).toBe('Test Note');
      expect(result.data.status).toBe('not-implemented');
      expect(result.content.trim()).toBe('Body content here.');
    });

    it('should handle content without frontmatter', () => {
      const content = 'Just plain content without frontmatter';
      const result = parseFrontmatter(content);
      expect(result.data).toEqual({});
      expect(result.content).toBe(content);
    });

    it('should handle empty content', () => {
      const result = parseFrontmatter('');
      expect(result.data).toEqual({});
      expect(result.content).toBe('');
    });

    it('should handle frontmatter with arrays', () => {
      const content = `---
id: test
targetFiles:
  - src/a.ts
  - src/b.ts
---

Body`;

      const result = parseFrontmatter(content);
      expect(result.data.targetFiles).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('should handle numeric timestamps', () => {
      const content = `---
id: test
created: 1234567890
updated: 1234567891
---

Body`;

      const result = parseFrontmatter(content);
      expect(result.data.created).toBe(1234567890);
      expect(result.data.updated).toBe(1234567891);
    });

    it('should handle quoted strings', () => {
      const content = `---
id: "backlog.feat.test"
title: "Test: With Colon"
desc: ""
---

Body`;

      const result = parseFrontmatter(content);
      expect(result.data.id).toBe('backlog.feat.test');
      expect(result.data.title).toBe('Test: With Colon');
      expect(result.data.desc).toBe('');
    });
  });

  describe('hasFrontmatter', () => {
    it('should detect frontmatter', () => {
      expect(hasFrontmatter('---\nid: test\n---\nBody')).toBe(true);
      expect(hasFrontmatter('No frontmatter here')).toBe(false);
      expect(hasFrontmatter('')).toBe(false);
    });
  });

  describe('formatWithFrontmatter', () => {
    it('should format frontmatter correctly', () => {
      const data = {
        id: 'test-note',
        title: 'Test Note',
        status: 'not-implemented',
      };
      const body = 'Body content';

      const result = formatWithFrontmatter(data, body);

      expect(result).toContain('---');
      // Note: formatWithFrontmatter uses JSON.stringify for strings
      expect(result).toContain('id: "test-note"');
      expect(result).toContain('title: "Test Note"');
      expect(result).toContain('Body content');
    });

    it('should handle arrays in frontmatter', () => {
      const data = {
        id: 'test',
        targetFiles: ['src/a.ts', 'src/b.ts'],
      };

      const result = formatWithFrontmatter(data, '');

      expect(result).toContain('targetFiles:');
      expect(result).toContain('src/a.ts');
      expect(result).toContain('src/b.ts');
    });

    it('should handle empty body', () => {
      const data = { id: 'test', title: 'Test' };
      const result = formatWithFrontmatter(data, '');

      expect(result).toContain('---');
      expect(result.split('---').length).toBeGreaterThanOrEqual(2);
    });

    it('should handle numeric values without quotes', () => {
      const data = {
        id: 'test',
        created: 1234567890,
        updated: 1234567891,
      };

      const result = formatWithFrontmatter(data, '');

      expect(result).toContain('created: 1234567890');
      expect(result).toContain('updated: 1234567891');
    });
  });

  describe('canonicalIdFromFilename', () => {
    it('should extract id from filename', () => {
      expect(canonicalIdFromFilename('backlog.feat.test')).toBe('backlog.feat.test');
      expect(canonicalIdFromFilename('backlog.feat.test.md')).toBe('backlog.feat.test');
    });

    it('should handle nested paths', () => {
      expect(canonicalIdFromFilename('notes/backlog.feat.test.md')).toBe('backlog.feat.test');
    });
  });

  describe('updateField', () => {
    const TMP_DIR = join(__dirname, '../.tmp/dendron-test-' + Date.now());

    beforeEach(() => {
      mkdirSync(TMP_DIR, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(TMP_DIR)) {
        rmSync(TMP_DIR, { recursive: true, force: true });
      }
    });

    it('should update existing field', () => {
      const content = `---
id: test
phase: draft
---

Body`;
      writeFileSync(join(TMP_DIR, 'test.md'), content);

      updateField(TMP_DIR, 'test', 'phase', 'ready');

      const result = readFileSync(join(TMP_DIR, 'test.md'), 'utf8');
      const parsed = parseFrontmatter(result);

      expect(parsed.data.phase).toBe('ready');
      expect(parsed.data.id).toBe('test');
    });

    it('should add new field', () => {
      const content = `---
id: test
title: Test
---

Body`;
      writeFileSync(join(TMP_DIR, 'test.md'), content);

      updateField(TMP_DIR, 'test', 'status', 'not-implemented');

      const result = readFileSync(join(TMP_DIR, 'test.md'), 'utf8');
      const parsed = parseFrontmatter(result);

      expect(parsed.data.status).toBe('not-implemented');
      expect(parsed.data.id).toBe('test');
    });

    it('should preserve other fields', () => {
      const content = `---
id: test
title: Test Title
desc: Test description
status: not-implemented
created: 1234567890
phase: draft
---

Body`;
      writeFileSync(join(TMP_DIR, 'test.md'), content);

      updateField(TMP_DIR, 'test', 'phase', 'ready');

      const result = readFileSync(join(TMP_DIR, 'test.md'), 'utf8');
      const parsed = parseFrontmatter(result);

      expect(parsed.data.phase).toBe('ready');
      expect(parsed.data.id).toBe('test');
      expect(parsed.data.title).toBe('Test Title');
      expect(parsed.data.desc).toBe('Test description');
      expect(parsed.data.status).toBe('not-implemented');
    });

    it('should preserve body content', () => {
      const content = `---
id: test
phase: draft
---

## Problem
This is the problem.

## Goal
This is the goal.`;
      writeFileSync(join(TMP_DIR, 'test.md'), content);

      updateField(TMP_DIR, 'test', 'phase', 'ready');

      const result = readFileSync(join(TMP_DIR, 'test.md'), 'utf8');
      const parsed = parseFrontmatter(result);

      expect(parsed.content).toContain('## Problem');
      expect(parsed.content).toContain('This is the problem.');
      expect(parsed.content).toContain('## Goal');
    });

    it('should throw for non-existent note', () => {
      expect(() => updateField(TMP_DIR, 'nonexistent', 'phase', 'ready'))
        .toThrow('Note not found');
    });

    it('should reject invalid phase values', () => {
      const content = `---
id: test
phase: draft
---

Body`;
      writeFileSync(join(TMP_DIR, 'test.md'), content);

      expect(() => updateField(TMP_DIR, 'test', 'phase', 'invalid-phase'))
        .toThrow('Invalid phase');
    });
  });
});

describe('dendron validation', () => {
  describe('validateNoteFrontmatter', () => {
    it('should validate correct frontmatter', () => {
      const content = `---
id: backlog.test
title: Test
desc: ''
created: 1234567890
updated: 1234567890
---

Body`;

      const result = validateNoteFrontmatter(content);
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should reject content without frontmatter', () => {
      const content = 'Just plain content';

      const result = validateNoteFrontmatter(content);
      expect(result.ok).toBe(false);
      expect(result.issues.some(i => i.code === 'missing_frontmatter')).toBe(true);
    });

    it('should reject missing id', () => {
      const content = `---
title: Test
---

Body`;

      const result = validateNoteFrontmatter(content);
      expect(result.ok).toBe(false);
      expect(result.issues.some(i => i.message.toLowerCase().includes('id'))).toBe(true);
    });

    it('should reject missing title', () => {
      const content = `---
id: test
---

Body`;

      const result = validateNoteFrontmatter(content);
      expect(result.ok).toBe(false);
      expect(result.issues.some(i => i.message.toLowerCase().includes('title'))).toBe(true);
    });
  });
});

describe('roundtrip consistency', () => {
  it('should maintain data through parse -> format cycle', () => {
    const original = `---
id: "backlog.feat.test"
title: "Test Feature"
desc: "A test description"
created: 1234567890
updated: 1234567891
status: "not-implemented"
phase: "draft"
targetFiles:
  - "src/a.ts"
  - "src/b.ts"
---

## Problem
The problem statement.

## Goal
The goal statement.`;

    const parsed = parseFrontmatter(original);
    const reformatted = formatWithFrontmatter(parsed.data, parsed.content);
    const reparsed = parseFrontmatter(reformatted);

    // Key fields should survive roundtrip
    expect(reparsed.data.id).toBe(parsed.data.id);
    expect(reparsed.data.title).toBe(parsed.data.title);
    expect(reparsed.data.status).toBe(parsed.data.status);
    expect(reparsed.data.phase).toBe(parsed.data.phase);

    // Body should survive roundtrip
    expect(reparsed.content).toContain('## Problem');
    expect(reparsed.content).toContain('The problem statement.');
  });
});
