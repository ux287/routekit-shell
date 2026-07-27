/**
 * Regression witness for backlog.fix.offrail-ship-commit-phase-note (bug #7).
 *
 * The off-rail auto-ship advances the story note to `phase: integrated` via a git-free disk
 * write that lands AFTER the scoped commit+push, stranding the note dirty and desyncing the
 * branch — which blocks the next rks_release. `commitAndPushNote` (called right after
 * advance_phase in guardrailsOn) persists that note so the tree ends clean + synced.
 *
 * These exercise the exported helper directly against a temp git repo + a bare `origin`
 * remote — the production push is an inline `spawnSync git push origin <branch>`, so a real
 * (or deliberately broken) remote is the only clean way to drive both push outcomes. Lives in
 * tests/unit/ so the CI unit tier actually runs it (packages/mcp-rks/__tests__ is not swept).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { commitAndPushNote } from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 });
}

function initRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ship-note-repo-'));
  git(root, ['init', '-b', 'staging']);
  git(root, ['config', 'user.email', 'test@test.dev']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function addBareOrigin(root) {
  const bare = mkdtempSync(path.join(os.tmpdir(), 'ship-note-bare-'));
  git(bare, ['init', '--bare', '-b', 'staging']);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-u', 'origin', 'staging']);
  return bare;
}

function writeNote(root, rel, content) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

const porcelain = (root, p) =>
  git(root, ['status', '--porcelain', ...(p ? ['--', p] : [])]).trim();

describe('commitAndPushNote — off-rail story-note persistence (bug #7)', () => {
  it('HAPPY PATH: commits the dirty note and pushes; tree ends clean and origin has it', () => {
    const root = initRepo();
    const bare = addBareOrigin(root);
    try {
      const notePath = writeNote(root, 'notes/backlog.fix.demo.md', '---\nphase: arch-approved\n---\nbody\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'add note at arch-approved']);
      git(root, ['push', 'origin', 'staging']);
      // Simulate advance_phase's post-ship disk write (phase → integrated).
      writeFileSync(notePath, '---\nphase: integrated\n---\nbody\n');

      const res = commitAndPushNote(root, notePath, 'staging', 'chore(story): advance demo to integrated');

      expect(res.ok).toBe(true);
      expect(res.commitId).toBeTruthy();
      expect(porcelain(root, notePath)).toBe(''); // note committed, tree clean
      expect(git(bare, ['log', '--oneline', '-1', 'staging'])).toContain('advance demo to integrated');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('NO-OP: when the note is not dirty, makes no commit and does not move HEAD', () => {
    const root = initRepo();
    const bare = addBareOrigin(root);
    try {
      const notePath = writeNote(root, 'notes/clean.md', 'clean\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'clean note']);
      const head = git(root, ['rev-parse', 'HEAD']).trim();

      const res = commitAndPushNote(root, notePath, 'staging', 'should not commit');

      expect(res.ok).toBe(true);
      expect(res.skipped).toBe(true);
      expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(head); // HEAD unchanged
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('PUSH FAILURE: note committed locally (tree clean), ok:false with a manual-push hint, no throw', () => {
    const root = initRepo();
    // origin points at a nonexistent path → push fails, but the local commit still lands.
    git(root, ['remote', 'add', 'origin', path.join(os.tmpdir(), `no-such-remote-${process.pid}`)]);
    try {
      const notePath = writeNote(root, 'notes/demo.md', 'v1\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'note v1']);
      writeFileSync(notePath, 'v2\n'); // dirty

      const res = commitAndPushNote(root, notePath, 'staging', 'chore(story): advance demo');

      expect(res.ok).toBe(false);
      expect(res.commitId).toBeTruthy();        // committed locally
      expect(res.error).toMatch(/manual push/i);
      expect(porcelain(root, notePath)).toBe(''); // tree clean despite push failure
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SCOPED STAGE: commits only the note, leaving unrelated dirty files untouched', () => {
    const root = initRepo();
    const bare = addBareOrigin(root);
    try {
      const notePath = writeNote(root, 'notes/demo.md', 'v1\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'note']);
      git(root, ['push', 'origin', 'staging']);
      writeFileSync(notePath, 'v2\n');                             // dirty note
      writeFileSync(path.join(root, 'unrelated.txt'), 'dirty\n');  // unrelated dirty file

      const res = commitAndPushNote(root, notePath, 'staging', 'chore: note only');

      expect(res.ok).toBe(true);
      expect(porcelain(root, notePath)).toBe('');           // note committed
      expect(porcelain(root)).toContain('unrelated.txt');   // unrelated file NOT swept in
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('NO-REORDER INVARIANT: the ship-note step is wired AFTER advance_phase in guardrailsOn', () => {
    // The phase must only be written `integrated` post merge+push, and the note commit follows
    // it — never before. Guard the ordering at the source (a full guardrailsOn run is too heavy
    // to fixture reliably); this breaks exactly when someone reorders the steps.
    const src = readFileSync(path.resolve('packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');
    const advanceIdx = src.indexOf('step: "advance_phase"');
    const shipNoteIdx = src.indexOf('step: "ship-note"');
    expect(advanceIdx).toBeGreaterThan(-1);
    expect(shipNoteIdx).toBeGreaterThan(advanceIdx);
  });
});
