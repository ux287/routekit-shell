import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markImplemented } from '../../packages/mcp-rks/src/dendron.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testNotesDir = path.join(__dirname, 'tmp-test-notes');

function createTestNote(filename, frontmatter, body = '') {
  const notePath = path.join(testNotesDir, filename);
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    if (Array.isArray(v)) {
      return `${k}:\n${v.map(item => `  - ${item}`).join('\n')}`;
    }
    return `${k}: ${JSON.stringify(v)}`;
  });
  const content = `---\n${fmLines.join('\n')}\n---\n\n${body}`;
  fs.writeFileSync(notePath, content, 'utf8');
}

function readTestNote(filename) {
  const notePath = path.join(testNotesDir, filename);
  const content = fs.readFileSync(notePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('Invalid frontmatter format');

  const frontmatter = {};
  const fmLines = match[1].split('\n');
  let currentKey = null;

  for (const line of fmLines) {
    if (line.includes(':') && !line.startsWith('  ')) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':').trim();
      if (value) {
        try {
          frontmatter[key] = JSON.parse(value);
        } catch {
          frontmatter[key] = value;
        }
      } else {
        currentKey = key;
        frontmatter[key] = [];
      }
    } else if (line.startsWith('  - ') && currentKey) {
      frontmatter[currentKey].push(line.slice(4));
    }
  }

  return { frontmatter, body: match[2] };
}

describe('markImplemented', () => {
  beforeEach(() => {
    fs.mkdirSync(testNotesDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testNotesDir)) {
      fs.rmSync(testNotesDir, { recursive: true, force: true });
    }
  });

  it('should update id field to include z_implemented', () => {
    const originalFm = {
      id: 'backlog.feature.auth',
      title: 'Add authentication',
      desc: 'Implement user authentication system',
      created: 1640000000000,
      updated: 1640000000000,
      targetFiles: ['src/auth.js', 'tests/auth.test.js']
    };

    createTestNote('backlog.feature.auth.md', originalFm, '## Implementation\n\nAdd auth system.');

    const result = markImplemented(testNotesDir, 'backlog.feature.auth.md', 'abc123');

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(testNotesDir, 'backlog.z_implemented.feature.auth.md'))).toBe(true);
    expect(fs.existsSync(path.join(testNotesDir, 'backlog.feature.auth.md'))).toBe(false);

    const { frontmatter, body } = readTestNote('backlog.z_implemented.feature.auth.md');

    expect(frontmatter.id).toBe('backlog.z_implemented.feature.auth');
    expect(frontmatter.title).toBe('Add authentication');
    expect(frontmatter.desc).toBe('Implement user authentication system');
    expect(frontmatter.created).toBe(1640000000000);
    expect(frontmatter.updated).toBeGreaterThan(1640000000000);
    expect(frontmatter.targetFiles).toEqual(['src/auth.js', 'tests/auth.test.js']);
    expect(frontmatter.implementedCommit).toBe('abc123');
    expect(body).toContain('## Implementation\n\nAdd auth system.');
  });

  it('should preserve all frontmatter fields', () => {
    const originalFm = {
      id: 'backlog.bug.fix-validation',
      title: 'Fix form validation',
      desc: 'Repair broken validation logic',
      created: 1640000000000,
      updated: 1640001000000,
      priority: 'high',
      assignee: 'john.doe',
      labels: ['bug', 'validation'],
      dependsOn: ['backlog.feature.forms'],
      customField: 'custom value'
    };

    createTestNote('backlog.bug.fix-validation.md', originalFm);

    markImplemented(testNotesDir, 'backlog.bug.fix-validation.md');

    const { frontmatter } = readTestNote('backlog.z_implemented.bug.fix-validation.md');

    expect(frontmatter.id).toBe('backlog.z_implemented.bug.fix-validation');
    expect(frontmatter.title).toBe('Fix form validation');
    expect(frontmatter.desc).toBe('Repair broken validation logic');
    expect(frontmatter.created).toBe(1640000000000);
    expect(frontmatter.priority).toBe('high');
    expect(frontmatter.assignee).toBe('john.doe');
    expect(frontmatter.labels).toEqual(['bug', 'validation']);
    expect(frontmatter.dependsOn).toEqual(['backlog.feature.forms']);
    expect(frontmatter.customField).toBe('custom value');
  });

  it('should handle notes that already have z_implemented in id', () => {
    const originalFm = {
      id: 'backlog.z_implemented.already.done',
      title: 'Already implemented task',
      desc: 'This was already moved',
      created: 1640000000000,
      updated: 1640000000000
    };

    createTestNote('backlog.z_implemented.already.done.md', originalFm);

    const result = markImplemented(testNotesDir, 'backlog.z_implemented.already.done.md', 'def456');

    expect(result.ok).toBe(true);

    const { frontmatter } = readTestNote('backlog.z_implemented.already.done.md');

    // Should not double-prefix
    expect(frontmatter.id).toBe('backlog.z_implemented.already.done');
    expect(frontmatter.implementedCommit).toBe('def456');
  });

  it('should update timestamp when marking as implemented', () => {
    const oldTimestamp = 1640000000000;
    const originalFm = {
      id: 'backlog.task.update-docs',
      title: 'Update documentation',
      desc: 'Refresh API docs',
      created: oldTimestamp,
      updated: oldTimestamp
    };

    createTestNote('backlog.task.update-docs.md', originalFm);

    markImplemented(testNotesDir, 'backlog.task.update-docs.md');

    const { frontmatter } = readTestNote('backlog.z_implemented.task.update-docs.md');

    expect(frontmatter.updated).toBeGreaterThan(oldTimestamp);
    expect(frontmatter.created).toBe(oldTimestamp); // should not change
  });

  it('should throw error if note does not exist', () => {
    expect(() => {
      markImplemented(testNotesDir, 'nonexistent.md');
    }).toThrow(/Note not found/);
  });
});
