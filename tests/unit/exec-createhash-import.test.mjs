import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const EXEC_PATH = resolve('packages/mcp-rks/src/server/exec.mjs');
const content = readFileSync(EXEC_PATH, 'utf8');

describe('exec.mjs createHash import', () => {
  it('imports createHash from crypto', () => {
    expect(content).toMatch(/import\s*\{[^}]*createHash[^}]*\}\s*from\s*['"](?:node:)?crypto['"]/);
  });

  it('does not have stale migration comment', () => {
    expect(content).not.toContain('// createHash moved to test-runner.mjs');
  });

  it('retains createHash call site at testFileHashes.set', () => {
    expect(content).toContain("createHash('sha256').update(content).digest('hex')");
  });

  it('retains createHash call site for planHash', () => {
    expect(content).toContain('createHash("sha256").update(planContent).digest("hex")');
  });

  it('retains createHash call site for currentHash integrity check', () => {
    expect(content).toContain("createHash('sha256').update(currentContent).digest('hex')");
  });
});
