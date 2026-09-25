/**
 * Tests for exec pre-flight dirty check excluding ALL notes/ files
 * (backlog.feat.exec-preflight-exclude-all-notes)
 *
 * The fix extends the dirtyFiles filter from:
 *   allDirtyFiles.filter(f => !storyNoteExclusions.has(f))
 * to:
 *   allDirtyFiles.filter(f => !storyNoteExclusions.has(f) && !f.startsWith('notes/'))
 *
 * Notes are governor-managed project metadata, never part of exec commits.
 * In multi-story epic work, many story notes sit dirty on staging while
 * individual stories execute one at a time — this should not block exec.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tmp.mjs';
import { getUncommittedFiles } from '../../packages/mcp-rks/src/utils/git.mjs';

function initGitRepo(dir) {
  spawnSync('git', ['init', '-b', 'staging'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', '.keep'), '');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.mjs'), '// app');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

/** Mirror the NEW filter logic from exec.mjs after the fix */
function applyNewFilter(projectRoot, problemId) {
  const storyNoteExclusions = new Set();
  if (problemId) {
    storyNoteExclusions.add(`notes/${problemId}.md`);
    const allDirty = getUncommittedFiles(projectRoot);
    for (const f of allDirty) {
      if (f.startsWith(`notes/${problemId}.`) && f.endsWith('.md')) {
        storyNoteExclusions.add(f);
      }
    }
  }
  const allDirtyFiles = getUncommittedFiles(projectRoot);
  // NEW: also exclude all notes/ files
  return allDirtyFiles.filter(f => !storyNoteExclusions.has(f) && !f.startsWith('notes/'));
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('exec pre-flight: dirty notes/ files do not block execution', () => {
  it('unrelated story note is excluded from dirtyFiles', () => {
    const projectRoot = makeTempDir('exec-notes-all-exclude');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const currentStory = 'backlog.feat.current-story';
    const otherNote = 'notes/backlog.discrepancies.create-modal.tailwind-and-fragment.md';
    fs.writeFileSync(path.join(projectRoot, otherNote), '# other story note');

    const dirtyFiles = applyNewFilter(projectRoot, currentStory);
    expect(dirtyFiles).not.toContain(otherNote);
  });

  it('five unrelated dirty story notes do not appear in dirtyFiles', () => {
    const projectRoot = makeTempDir('exec-notes-multi-exclude');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const currentStory = 'backlog.feat.current-story';
    const otherNotes = [
      'notes/backlog.feat.story-one.md',
      'notes/backlog.feat.story-two.md',
      'notes/backlog.feat.story-three.md',
      'notes/backlog.feat.story-four.md',
      'notes/backlog.feat.story-five.md',
    ];
    for (const n of otherNotes) {
      fs.writeFileSync(path.join(projectRoot, n), '# note');
    }

    const dirtyFiles = applyNewFilter(projectRoot, currentStory);
    for (const n of otherNotes) {
      expect(dirtyFiles).not.toContain(n);
    }
  });

  it('current story note is also excluded (existing behavior preserved)', () => {
    const projectRoot = makeTempDir('exec-notes-current-exclude');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const currentStory = 'backlog.feat.current-story';
    fs.writeFileSync(path.join(projectRoot, `notes/${currentStory}.md`), '# current story');

    const dirtyFiles = applyNewFilter(projectRoot, currentStory);
    expect(dirtyFiles).not.toContain(`notes/${currentStory}.md`);
  });
});

describe('exec pre-flight: implementation files still block execution', () => {
  it('dirty implementation file remains in dirtyFiles', () => {
    const projectRoot = makeTempDir('exec-notes-impl-still-blocked');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const currentStory = 'backlog.feat.current-story';
    fs.writeFileSync(path.join(projectRoot, 'src', 'app.mjs'), '// modified implementation');

    const dirtyFiles = applyNewFilter(projectRoot, currentStory);
    expect(dirtyFiles).toContain('src/app.mjs');
  });

  it('mix of dirty notes and dirty impl: only impl appears in dirtyFiles', () => {
    const projectRoot = makeTempDir('exec-notes-mixed');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const currentStory = 'backlog.feat.current-story';
    fs.writeFileSync(path.join(projectRoot, 'notes/backlog.feat.other.md'), '# other note');
    fs.writeFileSync(path.join(projectRoot, 'src/app.mjs'), '// modified');

    const dirtyFiles = applyNewFilter(projectRoot, currentStory);
    expect(dirtyFiles).not.toContain('notes/backlog.feat.other.md');
    expect(dirtyFiles).toContain('src/app.mjs');
  });
});
