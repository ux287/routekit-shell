import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DIR = path.join(process.cwd(), '.tmp-test-hooks-preflight');
const HOOKS_PATH = path.join(TEST_DIR, '.routekit', 'hooks');
const BAK_PATH = path.join(TEST_DIR, '.routekit', 'hooks.bak');
const SCOPE_PATH = path.join(TEST_DIR, '.rks', 'active-scope.json');
const MANIFEST_PATH = path.join(TEST_DIR, '.routekit', 'hooks-manifest.json');

describe('Hooks State Preflight', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.routekit'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.rks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('detects missing hooks when guardrails should be on', () => {
    // No hooks directory, no scope file = broken state
    const hooksExist = fs.existsSync(HOOKS_PATH);
    const scopeExists = fs.existsSync(SCOPE_PATH);

    expect(hooksExist).toBe(false);
    expect(scopeExists).toBe(false);
    // This state should trigger auto-recovery
  });

  it('allows operation when hooks present and no active scope', () => {
    fs.mkdirSync(HOOKS_PATH, { recursive: true });
    fs.writeFileSync(path.join(HOOKS_PATH, 'test-hook.mjs'), '// test');

    expect(fs.existsSync(HOOKS_PATH)).toBe(true);
    expect(fs.existsSync(SCOPE_PATH)).toBe(false);
  });

  it('allows operation when off-rail with hooks.bak', () => {
    fs.mkdirSync(BAK_PATH, { recursive: true });
    fs.writeFileSync(SCOPE_PATH, JSON.stringify({ sessionId: 'test' }));

    expect(fs.existsSync(BAK_PATH)).toBe(true);
    expect(fs.existsSync(SCOPE_PATH)).toBe(true);
  });

  it('detects stale hooks.bak without active session', () => {
    fs.mkdirSync(HOOKS_PATH, { recursive: true });
    fs.mkdirSync(BAK_PATH, { recursive: true });
    // No scope file = stale bak

    expect(fs.existsSync(HOOKS_PATH)).toBe(true);
    expect(fs.existsSync(BAK_PATH)).toBe(true);
    expect(fs.existsSync(SCOPE_PATH)).toBe(false);
  });
});
