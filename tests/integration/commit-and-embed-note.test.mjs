/**
 * Tests for commitAndEmbedNote() — atomic write → commit → embed for a Dendron
 * memory note. Restores the "nothing embedded that's not committed" invariant.
 *
 * Behavioral tests use real temp git repos and mock runRagEmbed so we don't need
 * LanceDB. The mock captures HEAD at embed-time, proving commit lands strictly
 * before embed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync as _spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SPAWN_TIMEOUT_MS = 30000;
function spawnSync(cmd, args, opts = {}) {
  return _spawnSync(cmd, args, { timeout: SPAWN_TIMEOUT_MS, ...opts });
}

// Capture runRagEmbed invocations and the HEAD SHA at the moment each runs.
// commitAndEmbed (the underlying helper) calls runRagEmbed AFTER its git commit;
// capturing HEAD at embed-time proves the commit landed first.
const ragEmbedCalls = [];
let ragEmbedBehavior = 'success';
vi.mock('../../packages/mcp-rks/src/rag/tools.mjs', () => ({
  runRagEmbed: vi.fn(async (projectRoot, opts) => {
    const headSha = _spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS,
    }).stdout.trim();
    ragEmbedCalls.push({ projectRoot, files: opts?.files || [], headSha });
    if (ragEmbedBehavior === 'success') return { ok: true };
    if (ragEmbedBehavior === 'fail') return { ok: false, error: 'simulated embed failure' };
    if (ragEmbedBehavior === 'throw') throw new Error('simulated embed throw');
    return { ok: true };
  }),
}));

const { commitAndEmbedNote } = await import('../../packages/mcp-rks/src/shared/commit-and-embed-note.mjs');

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-embed-note-'));
  spawnSync('git', ['init', '--initial-branch', 'main', base]);
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: base });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: base });
  // Notes dir so resolveNotesDir() has a target.
  fs.mkdirSync(path.join(base, 'notes'), { recursive: true });
  // Initial commit so HEAD exists.
  fs.writeFileSync(path.join(base, 'README.md'), '# test\n');
  spawnSync('git', ['add', 'README.md'], { cwd: base });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: base });
  return base;
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

describe('commitAndEmbedNote — atomic write → commit → embed', () => {
  let projectRoot;

  beforeEach(() => {
    ragEmbedCalls.length = 0;
    ragEmbedBehavior = 'success';
    projectRoot = makeTempRepo();
  });

  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
  });

  it('happy path: writes the note, commits, then embeds — note is tracked at HEAD', async () => {
    const result = await commitAndEmbedNote({
      projectRoot, slug: 'test-memory', content: 'A test memory body.',
    });
    expect(result.ok).toBe(true);
    expect(result.notePath).toBe(path.join('notes', 'memories.test-memory.md'));
    expect(result.commitId).toMatch(/^[0-9a-f]{40}$/);

    // Note exists on disk.
    expect(fs.existsSync(path.join(projectRoot, 'notes', 'memories.test-memory.md'))).toBe(true);
    // Note is tracked at HEAD.
    const ls = spawnSync('git', ['ls-files', '--error-unmatch', 'notes/memories.test-memory.md'], {
      cwd: projectRoot, encoding: 'utf8',
    });
    expect(ls.status).toBe(0);
    // Working tree clean for the note.
    const status = spawnSync('git', ['status', '--porcelain', 'notes/memories.test-memory.md'], {
      cwd: projectRoot, encoding: 'utf8',
    });
    expect(status.stdout.trim()).toBe('');

    // runRagEmbed invoked exactly once with the committed note path in `files`.
    expect(ragEmbedCalls.length).toBe(1);
    expect(ragEmbedCalls[0].files).toContain('notes/memories.test-memory.md');
  });

  it('call-order invariant: commit strictly before embed — note is at HEAD when runRagEmbed is invoked', async () => {
    const result = await commitAndEmbedNote({
      projectRoot, slug: 'order-test', content: 'order check.',
    });
    expect(result.ok).toBe(true);
    expect(ragEmbedCalls.length).toBe(1);

    // HEAD captured at embed-time is the commit returned by commitAndEmbedNote.
    expect(ragEmbedCalls[0].headSha).toBe(result.commitId);

    // The note is reachable at that HEAD — i.e. the commit landed before the embed.
    const show = spawnSync('git', ['show', `${result.commitId}:notes/memories.order-test.md`], {
      cwd: projectRoot, encoding: 'utf8',
    });
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('order check.');
  });

  it('commit failure: runRagEmbed is NOT invoked, returns ok:false surfacing the commit error', async () => {
    // Force commit failure by requiring signed commits against a nonexistent gpg.
    spawnSync('git', ['config', 'commit.gpgSign', 'true'], { cwd: projectRoot });
    spawnSync('git', ['config', 'gpg.program', '/nonexistent/gpg'], { cwd: projectRoot });

    const result = await commitAndEmbedNote({
      projectRoot, slug: 'commit-fail', content: 'commit fail content.',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/commit/i);
    // No embed ran.
    expect(ragEmbedCalls.length).toBe(0);
  });

  it('embed failure AFTER successful commit: commit remains at HEAD, ragEmbedWarning surfaced', async () => {
    ragEmbedBehavior = 'fail';
    const result = await commitAndEmbedNote({
      projectRoot, slug: 'embed-fail', content: 'embed-fail content.',
    });
    expect(result.ok).toBe(true);
    expect(result.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(result.ragEmbedWarning).toBeDefined();
    // Commit IS at HEAD with the note.
    const ls = spawnSync('git', ['ls-files', '--error-unmatch', 'notes/memories.embed-fail.md'], {
      cwd: projectRoot, encoding: 'utf8',
    });
    expect(ls.status).toBe(0);
  });

  it('embed throw AFTER successful commit: commit remains at HEAD, warning surfaced', async () => {
    ragEmbedBehavior = 'throw';
    const result = await commitAndEmbedNote({
      projectRoot, slug: 'embed-throw', content: 'throw content.',
    });
    expect(result.ok).toBe(true);
    expect(result.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(result.ragEmbedWarning).toBeDefined();
    const ls = spawnSync('git', ['ls-files', '--error-unmatch', 'notes/memories.embed-throw.md'], {
      cwd: projectRoot, encoding: 'utf8',
    });
    expect(ls.status).toBe(0);
  });

  it('input validation: missing projectRoot / slug / content returns ok:false', async () => {
    const r1 = await commitAndEmbedNote({ slug: 's', content: 'c' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/projectRoot/);
    const r2 = await commitAndEmbedNote({ projectRoot: '/tmp', content: 'c' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/slug/);
    const r3 = await commitAndEmbedNote({ projectRoot: '/tmp', slug: 's' });
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/content/);
  });
});

describe('commitAndEmbedNote — source structure', () => {
  const wrapperSrc = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/shared/commit-and-embed-note.mjs'), 'utf8',
  );
  const dendronSrc = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/dendron.mjs'), 'utf8',
  );

  it('writeNoteRaw is called with { skipEmbed: true } — no pre-commit embed spawn', () => {
    expect(wrapperSrc).toMatch(/writeNoteRaw\([^)]*skipEmbed:\s*true/);
  });

  it('commit (via commitAndEmbed) is sequenced after the write — commit before embed', () => {
    const iWrite = wrapperSrc.indexOf('writeNoteRaw(');
    const iCommit = wrapperSrc.indexOf('commitAndEmbed(projectRoot');
    expect(iWrite).toBeGreaterThan(-1);
    expect(iCommit).toBeGreaterThan(iWrite);
  });

  it('writeNoteRaw accepts an options argument with a skipEmbed gate', () => {
    expect(dendronSrc).toMatch(/export function writeNoteRaw\(notePath,\s*content,\s*options\s*=\s*\{\}/);
    expect(dendronSrc).toMatch(/if\s*\(options\.skipEmbed\)\s*return/);
  });

  it('writeNoteRaw default behavior unchanged — embed spawn remains, gated only by the new flag', () => {
    // The spawn block exists, and the skipEmbed return-early sits IMMEDIATELY before it.
    const iGate = dendronSrc.indexOf('if (options.skipEmbed) return;');
    const iSpawn = dendronSrc.indexOf('spawn(process.execPath');
    expect(iGate).toBeGreaterThan(-1);
    expect(iSpawn).toBeGreaterThan(iGate);
  });
});
