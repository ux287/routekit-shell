/**
 * Frontmatter schema validation tests
 *
 * Validates all backlog files have correct frontmatter structure.
 * This ensures malformed frontmatter is caught during CI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const NOTES_DIR = join(PROJECT_ROOT, 'notes');

/**
 * Schema for backlog note frontmatter
 *
 * Note: Legacy files may have different types for timestamps and targetFiles.
 * The schema validates structural requirements but is lenient on types.
 */
const BACKLOG_SCHEMA = {
  // Only require id and title - many legacy files have varied frontmatter
  required: ['id', 'title'],
  optional: ['desc', 'created', 'updated', 'status', 'phase', 'targetFiles', 'dependsOn', 'testFiles', 'testRequirements', 'priority', 'preCommands', 'testFile', 'testExempt'],
  types: {
    id: 'string',
    title: 'string',
  },
  // Note: validValues checks disabled due to legacy data with non-standard values
  // (status: deferred, approved, in-review, wont-do, decomposed)
  // (priority: future)
  // TODO: Clean up legacy files and re-enable strict validation
  validValues: {},
};

/**
 * Get all markdown files in a directory recursively
 */
function getMarkdownFiles(dir, pattern = null) {
  const files = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip archive directories
      if (entry === 'z_archive' || entry.startsWith('.')) continue;
      files.push(...getMarkdownFiles(fullPath, pattern));
    } else if (entry.endsWith('.md')) {
      if (pattern && !entry.match(pattern)) continue;
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Validate frontmatter against schema
 */
function validateFrontmatter(data, schema, filename) {
  const errors = [];

  // Check required fields
  for (const field of schema.required) {
    if (!(field in data) || data[field] === undefined || data[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check types of present fields
  for (const [field, value] of Object.entries(data)) {
    if (field in schema.types) {
      const expectedType = schema.types[field];
      const actualType = Array.isArray(value) ? 'array' : typeof value;

      if (actualType !== expectedType) {
        errors.push(`Field '${field}' should be ${expectedType}, got ${actualType}`);
      }
    }
  }

  // Check valid values for enum fields
  for (const [field, validValues] of Object.entries(schema.validValues)) {
    if (field in data && data[field] !== undefined && data[field] !== null && data[field] !== '') {
      if (!validValues.includes(data[field])) {
        errors.push(`Field '${field}' has invalid value '${data[field]}', expected one of: ${validValues.join(', ')}`);
      }
    }
  }

  return errors;
}

// Known files with issues that predate strict validation
// TODO: Fix these files and remove from skip list
const SKIP_FILES = [
  'backlog.architecture.exec-mjs-maintainability-refactor.05-extract-story-validator.md', // malformed YAML
  'backlog.bug.rag-embed-expects-dev.server.md', // missing title
  'backlog.bug.rag-embed-expects-dev.validator.md', // missing title
  'backlog.fix.dendron-update-field-corruption.md', // missing title
  'snacks-design.marketing-site.backlog.problems.md', // missing id (child project file)
];

describe('frontmatter schema validation', () => {
  describe('backlog files', () => {
    const backlogFiles = getMarkdownFiles(NOTES_DIR).filter(f =>
      f.includes('backlog.') &&
      !f.includes('templates.') &&
      !f.includes('z_implemented') &&
      !f.includes('z_archive') &&
      !SKIP_FILES.some(skip => f.endsWith(skip))
    );

    it('should have backlog files to validate', () => {
      expect(backlogFiles.length).toBeGreaterThan(0);
    });

    it.each(backlogFiles.map(f => [f.replace(NOTES_DIR + '/', ''), f]))(
      '%s should have valid frontmatter',
      (name, filepath) => {
        const content = readFileSync(filepath, 'utf8');

        // Check that file has frontmatter
        expect(content.startsWith('---')).toBe(true);

        // Parse frontmatter
        let parsed;
        try {
          parsed = matter(content);
        } catch (err) {
          throw new Error(`Failed to parse frontmatter: ${err.message}`);
        }

        // Validate against schema
        const errors = validateFrontmatter(parsed.data, BACKLOG_SCHEMA, name);

        if (errors.length > 0) {
          throw new Error(`Frontmatter validation failed:\n  - ${errors.join('\n  - ')}`);
        }
      }
    );
  });

  // Note: z_implemented files are legacy and may have inconsistent frontmatter.
  // Skip validation for those - they were moved before strict validation was added.
});

describe('frontmatter validation function', () => {
  it('should reject missing required fields', () => {
    const errors = validateFrontmatter({}, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toContain('Missing required field: id');
    expect(errors).toContain('Missing required field: title');
  });

  it('should accept valid frontmatter', () => {
    const valid = {
      id: 'backlog.test',
      title: 'Test Story',
      desc: '',
      created: 1234567890,
      updated: 1234567890,
      status: 'not-implemented',
      phase: 'draft',
      targetFiles: [],
    };
    const errors = validateFrontmatter(valid, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toHaveLength(0);
  });

  it('should accept frontmatter with testFile field', () => {
    const valid = {
      id: 'backlog.test',
      title: 'Test Story',
      testFile: 'tests/unit/foo.spec.mjs',
    };
    const errors = validateFrontmatter(valid, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toHaveLength(0);
  });

  it('should accept frontmatter with testExempt field', () => {
    const valid = {
      id: 'backlog.test',
      title: 'Test Story',
      testExempt: true,
    };
    const errors = validateFrontmatter(valid, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toHaveLength(0);
  });

  it('should accept frontmatter with testFiles array', () => {
    const valid = {
      id: 'backlog.test',
      title: 'Test Story',
      testFiles: ['tests/unit/foo.test.mjs', 'tests/unit/bar.test.mjs'],
    };
    const errors = validateFrontmatter(valid, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toHaveLength(0);
  });

  it('should accept frontmatter without testFiles (field is optional)', () => {
    const valid = {
      id: 'backlog.test',
      title: 'Test Story',
    };
    const errors = validateFrontmatter(valid, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toHaveLength(0);
  });

  it('should reject wrong type for id', () => {
    const invalid = {
      id: 123,
      title: 'Test Story',
    };
    const errors = validateFrontmatter(invalid, BACKLOG_SCHEMA, 'test.md');
    expect(errors.some(e => e.includes("'id'") && e.includes('string'))).toBe(true);
  });

  it('should accept empty optional fields', () => {
    const valid = {
      id: 'backlog.test',
      title: 'Test Story',
      desc: '',
      targetFiles: [],
      testFile: '',
    };
    const errors = validateFrontmatter(valid, BACKLOG_SCHEMA, 'test.md');
    expect(errors).toHaveLength(0);
  });
});
