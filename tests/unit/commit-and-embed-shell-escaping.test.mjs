/**
 * Regression: commitAndEmbed must pass the commit message to git WITHOUT a shell,
 * so messages containing backticks, $(...), $VARS, or quotes commit verbatim and
 * never trigger shell evaluation.
 *
 * Bug (backlog.fix.guardrails-off-autoship-shell-escaping): the prior
 * `execSync(`git commit -m ${JSON.stringify(message)}`)` shelled out, so /bin/sh
 * still interpreted backticks/command-substitution inside the JSON-quoted string.
 * A guardrails_off reason containing a backtick (e.g. an import snippet) broke the
 * off-rail auto-ship with "unexpected EOF while looking for matching backtick".
 *
 * The fix passes the message via stdin (`git commit -F -`) using execFileSync (no
 * shell). These tests pin that contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the commit path — stub RAG embedding so the test never loads a model
// or touches a real index. commit-and-embed.mjs imports '../rag/tools.mjs', which
// resolves to the same absolute module this mock targets.
vi.mock('../../packages/mcp-rks/src/rag/tools.mjs', () => ({
  runRagEmbed: vi.fn(async () => ({ ok: true })),
}));

const { commitAndEmbed } = await import('../../packages/mcp-rks/src/shared/commit-and-embed.mjs');

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-escape-'));
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  // Base commit so commitAndEmbed's `git diff HEAD~1..HEAD` has a parent to diff.
  git(['commit', '--allow-empty', '-m', 'base'], dir);
  return dir;
}

function stage(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  git(['add', '-A'], dir);
}

describe('commitAndEmbed — shell-safe commit message', () => {
  let dir;
  beforeEach(() => { dir = initRepo(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('commits a message with backticks, $(...), quotes, and newlines byte-for-byte (the observed failure mode)', async () => {
    stage(dir, 'f.txt', 'x');
    const msg = [
      'fix(mcp-contract): remove stray `import { afterEach } from "vitest"`',
      '',
      'Reason had backticks and $(echo nope) and a \'single\' and "double" quote.',
      '',
      '#off-rail-work',
    ].join('\n');

    const { commitId } = await commitAndEmbed(dir, msg);
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);

    // %B prints the raw commit message (git appends one trailing newline).
    const got = git(['log', '-1', '--format=%B'], dir).replace(/\n$/, '');
    expect(got).toBe(msg);
  }, 30_000);

  it('does NOT evaluate command substitution in the message (proves no shell)', async () => {
    const sentinel = path.join(dir, 'PWNED');
    stage(dir, 'f.txt', 'y');
    const msg = `chore: command-substitution probe $(touch ${sentinel}) and \`touch ${sentinel}\``;

    await commitAndEmbed(dir, msg);

    expect(fs.existsSync(sentinel)).toBe(false); // no shell eval → no side-effect file
    const got = git(['log', '-1', '--format=%B'], dir);
    expect(got).toContain('$(touch'); // substitution text preserved literally
  }, 30_000);

  it('happy path: plain message commits and preserves the Co-Authored-By trailer', async () => {
    stage(dir, 'f.txt', 'z');
    const msg = 'feat: plain ordinary message\n\nCo-Authored-By: Claude <noreply@anthropic.com>';

    const { commitId } = await commitAndEmbed(dir, msg);
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);

    const got = git(['log', '-1', '--format=%B'], dir);
    expect(got).toContain('Co-Authored-By: Claude <noreply@anthropic.com>');
  }, 30_000);

  it('source no longer shells out the message (no execSync git commit -m)', () => {
    const src = fs.readFileSync(
      new URL('../../packages/mcp-rks/src/shared/commit-and-embed.mjs', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/execSync\([`'"]git commit -m/);
    // Commits via execFileSync (no shell) with the message on stdin (-F -).
    expect(src).toMatch(/execFileSync\(\s*['"]git['"],\s*\[\s*['"]commit['"]/);
    expect(src).toMatch(/['"]-F['"]\s*,\s*['"]-['"]/);
  });
});
