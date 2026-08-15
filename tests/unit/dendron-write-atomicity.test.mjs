/**
 * Tests for the atomic-write fix in writeNoteRaw().
 * (backlog.fix.dendron-write-atomicity)
 *
 * Validates that writeNoteRaw uses temp-file + rename to ensure the target
 * file is never observed in a partial state if the write is interrupted.
 *
 * Background: An rks_agent_dendron max_turns timeout on 2026-04-29 left a
 * research paper with intact frontmatter but a wiped body — the symptom of
 * a non-atomic fs.writeFileSync(target) being interrupted mid-flush. The fix
 * routes the write through a .tmp file then atomic rename.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeNoteRaw } from '../../packages/mcp-rks/src/dendron.mjs';

describe('writeNoteRaw atomicity', () => {
  let tmpDir;
  let notePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-write-atom-'));
    notePath = path.join(tmpDir, 'subdir', 'note.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('happy path on fresh path: target has correct content, no .tmp residue', () => {
    writeNoteRaw(notePath, 'hello world');
    expect(fs.readFileSync(notePath, 'utf8')).toBe('hello world');
    expect(fs.existsSync(notePath + '.tmp')).toBe(false);
  });

  it('happy path on existing target: wholesale replacement, no .tmp residue', () => {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, 'old content');
    writeNoteRaw(notePath, 'new content');
    expect(fs.readFileSync(notePath, 'utf8')).toBe('new content');
    expect(fs.existsSync(notePath + '.tmp')).toBe(false);
  });

  it('crash sim with existing target: error propagates AND original content is unchanged', () => {
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, 'original-intact');

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('simulated mid-write interrupt');
    });

    expect(() => writeNoteRaw(notePath, 'new content that should not land')).toThrow(/interrupt/);
    writeSpy.mockRestore();

    // Critical assertion: the original target file is byte-for-byte unchanged.
    expect(fs.readFileSync(notePath, 'utf8')).toBe('original-intact');
  });

  it('crash sim with no prior target: error propagates AND no partial target file exists', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('simulated mid-write interrupt');
    });

    expect(() => writeNoteRaw(notePath, 'should not land')).toThrow(/interrupt/);
    writeSpy.mockRestore();

    expect(fs.existsSync(notePath)).toBe(false);
  });

  it('write goes to <notePath>.tmp first (not directly to target)', () => {
    const writeCalls = [];
    const realWrite = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, c, opts) => {
      writeCalls.push(String(p));
      return realWrite(p, c, opts);
    });

    writeNoteRaw(notePath, 'content');
    writeSpy.mockRestore();

    // The write call to the target path must be to <notePath>.tmp, not <notePath>.
    const targetWrites = writeCalls.filter(p => p === notePath || p === notePath + '.tmp');
    expect(targetWrites).toContain(notePath + '.tmp');
    expect(targetWrites).not.toContain(notePath);
  });

  it('renameSync(tmpPath, notePath) is called after successful write', () => {
    const renameCalls = [];
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      renameCalls.push({ from: String(from), to: String(to) });
      return realRename(from, to);
    });

    writeNoteRaw(notePath, 'content');
    renameSpy.mockRestore();

    expect(renameCalls.length).toBeGreaterThan(0);
    const swap = renameCalls.find(c => c.from === notePath + '.tmp' && c.to === notePath);
    expect(swap).toBeDefined();
  });
});
