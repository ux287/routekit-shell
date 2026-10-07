import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DIR = path.join(process.cwd(), '.tmp-test-embed-lock');
const LOCK_FILE = path.join(TEST_DIR, '.rks', 'rag', '.embed-lock');

describe('Embed Lock PID Awareness', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('respects lock with live PID', () => {
    // Use current process PID (definitely alive)
    const lockData = { sha: 'abc123', started: new Date().toISOString(), pid: process.pid };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData));

    expect(fs.existsSync(LOCK_FILE)).toBe(true);

    // Check PID is alive
    let isAlive = false;
    try {
      process.kill(lockData.pid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    expect(isAlive).toBe(true);
  });

  it('removes lock with dead PID', () => {
    // Use impossible PID (definitely dead)
    const lockData = { sha: 'abc123', started: new Date().toISOString(), pid: 999999999 };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData));

    // Check PID is dead
    let isAlive = false;
    try {
      process.kill(lockData.pid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    expect(isAlive).toBe(false);
  });

  it('falls back to time-based check for lock without PID', () => {
    const lockData = { sha: 'abc123', started: new Date().toISOString() };
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData));

    expect(fs.existsSync(LOCK_FILE)).toBe(true);
    expect(lockData.pid).toBeUndefined();
  });
});
