/**
 * Witness for backlog.fix.commit-and-embed-derives-changed-files-from-a-parent-ref.
 *
 * `commitAndEmbed` read back its changed-file list with `git diff --name-only HEAD~1..HEAD`.
 * `HEAD~1` DOES NOT RESOLVE on a repository's first commit — git exits non-zero with "unknown
 * revision", `execSync` throws, and the caller's catch turns that into
 * `{ ok: false, writeOk: true, commitOk: false }`.
 *
 * The commit HAS ALREADY LANDED at that point. So the failure mode is not a crash, it is a status
 * contradicting the repository: the tool reports the commit failed, and it is sitting in the log.
 *
 * REACHABLE ON AN ORDINARY FIRST RUN, which is why this is not a curiosity. `bootstrap.mjs` makes
 * its baseline commit best-effort and swallows a git failure — an unconfigured `user.email` /
 * `user.name`, the common case on a fresh machine or a CI container, is enough. Scaffolding then
 * completes and leaves a REGISTERED project whose repo has zero commits, with no second chance,
 * because the skip guard only fires when `rev-parse --verify HEAD` succeeds. The next
 * `dendron_create_note` makes the root commit and lands here.
 *
 * The remedy needed no invention: `server/guardrails-audit.mjs` already reads committed paths with
 * `diff-tree … -r --root <sha>` and carries a comment stating the flag is load-bearing. What that
 * exemplar ALSO carries is an explicit `status !== 0` check, because it uses spawnSync. Copying its
 * argv without its check would trade a loud throw for a silent empty list — the same defect class,
 * pointed the other way. Hence execFileSync here, which throws on non-zero by construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@routekit/rag/tools', () => ({
  runRagEmbed: vi.fn(async () => ({ ok: true })),
}));

const { commitAndEmbed } = await import('../../packages/mcp-rks/src/shared/commit-and-embed.mjs');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });

/** A repo with NO commits — the state a child is left in when the baseline commit is swallowed. */
function initEmptyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-root-'));
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function stage(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(['add', '-A'], dir);
}

const dirs = [];
beforeEach(() => { dirs.length = 0; });
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function repo({ withBase }) {
  const dir = initEmptyRepo();
  dirs.push(dir);
  if (withBase) git(['commit', '--allow-empty', '-m', 'base'], dir);
  return dir;
}

describe('commitAndEmbed on a ROOT commit', () => {
  it('FIXTURE PRECONDITION — the repo really has no commits', () => {
    // Without this the RED below could pass for an unrelated reason.
    const dir = repo({ withBase: false });
    expect(() => git(['rev-parse', '--verify', 'HEAD'], dir)).toThrow();
  });

  it('RED at HEAD — does not throw on a parentless commit', async () => {
    const dir = repo({ withBase: false });
    stage(dir, 'notes/first.md', '---\ntitle: First\n---\n\nbody\n');

    // Before the fix this rejected with git's "unknown revision or path not in the working tree"
    // for HEAD~1, AFTER the commit had already been created.
    await expect(commitAndEmbed(dir, 'docs(notes): create first')).resolves.toBeTruthy();
  });

  it('reports every file the root commit contained', async () => {
    const dir = repo({ withBase: false });
    stage(dir, 'notes/first.md', 'one\n');
    stage(dir, 'notes/second.md', 'two\n');

    const res = await commitAndEmbed(dir, 'docs(notes): create two');

    expect(res.committedPaths.sort()).toEqual(['notes/first.md', 'notes/second.md']);
    expect(res.commitId).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the reported commit really is the one in the log — status matches the repository', async () => {
    // The heart of it. The old code reported commitOk:false for a commit that existed.
    const dir = repo({ withBase: false });
    stage(dir, 'notes/only.md', 'content\n');

    const res = await commitAndEmbed(dir, 'docs(notes): create only');
    const head = git(['rev-parse', 'HEAD'], dir).trim();

    expect(res.commitId).toBe(head);
    expect(git(['log', '--oneline'], dir).trim().split('\n')).toHaveLength(1);
  });

  it('a NON-root commit is unaffected — same list as before the change', async () => {
    // No behaviour change on the path that always worked. `--root` must not widen an ordinary
    // commit's list to the whole tree.
    const dir = repo({ withBase: true });
    stage(dir, 'notes/existing.md', 'first\n');
    await commitAndEmbed(dir, 'docs(notes): first');

    stage(dir, 'notes/added.md', 'second\n');
    const res = await commitAndEmbed(dir, 'docs(notes): second');

    expect(res.committedPaths).toEqual(['notes/added.md']);
    expect(res.committedPaths).not.toContain('notes/existing.md');
  });

  it('a path-scoped commit still reports only what it committed', async () => {
    // The pathspec contract from the sibling story must survive the read-back change.
    const dir = repo({ withBase: true });
    stage(dir, 'notes/mine.md', 'mine\n');
    stage(dir, 'notes/theirs.md', 'theirs\n');

    const res = await commitAndEmbed(dir, 'docs(notes): mine only', { pathspec: ['notes/mine.md'] });

    expect(res.committedPaths).toEqual(['notes/mine.md']);
    // The other file is still staged and uncommitted.
    expect(git(['diff', '--cached', '--name-only'], dir).trim()).toBe('notes/theirs.md');
  });

  it('a genuine git failure still THROWS — the fix did not buy silence', async () => {
    // The trade this change had to avoid. A spawnSync port without a status check would return
    // an empty list here instead of failing.
    const dir = repo({ withBase: false });
    // Nothing staged: `git commit` exits non-zero and must propagate.
    await expect(commitAndEmbed(dir, 'docs(notes): nothing')).rejects.toThrow();
  });
});
