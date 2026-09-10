import { execSync, execFileSync } from 'node:child_process';
import { runRagEmbed } from '@routekit/rag';

/**
 * Commits staged changes then re-embeds only the changed files into the RAG index.
 * Callers must stage files before calling.
 *
 * `options.pathspec` — OPTIONAL and ADDITIVE. When supplied, only those paths are
 * committed; everything else staged in the index is left staged and uncommitted. When
 * omitted, behaviour is byte-identical to before, because three live callers
 * (`server/git/git-workflow.mjs` twice, `server/guardrails-audit.mjs`) are ship and
 * mark-implemented paths whose intent genuinely IS to commit the whole staged change
 * set. Narrowing them would be a different defect, not a fix.
 *
 * @param {object} [options]
 * @param {string[]} [options.pathspec] Repo-relative paths to scope the commit to.
 * @returns {Promise<{commitId: string, committedPaths: string[], ragEmbedSkipped?: boolean, ragEmbedWarning?: string}>}
 */
export async function commitAndEmbed(projectRoot, message, options = {}) {
  const pathspec = Array.isArray(options.pathspec) ? options.pathspec.filter(Boolean) : [];
  // Pass the commit message via stdin (-F -) using execFileSync (no shell), so a
  // message containing backticks, $(...), $VARS, or quotes is committed verbatim
  // with zero shell interpretation. The previous `execSync(\`git commit -m ...\`)`
  // shelled out, so JSON.stringify's double-quotes did not stop /bin/sh from
  // interpreting backticks/command-substitution — breaking the auto-ship commit.
  // --cleanup=verbatim: commit the message EXACTLY as given — no whitespace/comment
  // normalization. This preserves byte-for-byte content and, importantly, keeps the
  // `#off-rail-work` marker line (git would otherwise treat leading-`#` lines as
  // comments under the default cleanup mode and strip them).
  //
  // A trailing `-- <paths>` makes this a PARTIAL commit: git commits those paths from
  // the index and leaves every other staged entry staged. That is the point — a note
  // write was absorbing whatever else the caller happened to have staged.
  execFileSync('git', ['commit', '--cleanup=verbatim', '-F', '-', ...(pathspec.length ? ['--', ...pathspec] : [])], {
    cwd: projectRoot,
    input: message,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const commitId = execSync('git rev-parse HEAD', {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();

  // READ BACK FROM GIT, never echoed from `pathspec`. A caller must be able to tell from
  // the return value alone what the commit actually contained — reporting the paths we
  // asked for would report intent, and intent is exactly what was wrong before.
  const changedFiles = execSync('git diff --name-only HEAD~1..HEAD', {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);

  // Suppress the embed under test. runRagEmbed loads a real transformer model
  // and writes LanceDB — minutes of work per call — and several suites drive
  // commitAndEmbed through real git, paying that on every ship test.
  //
  // Deliberately the SAME env pair already used to guard the detached spawn in
  // dendron.mjs, not a new flag. vitest sets VITEST itself, so no CI or vitest
  // config change is needed. Note RKS_SKIP_BACKGROUND_EMBED now also suppresses
  // this FOREGROUND embed; that is intended, despite the name.
  //
  // The guard belongs HERE, in the caller, and NOT inside runRagEmbed:
  // runRagEmbed is the public @routekit/rag API also driven by the embed CLI
  // and the rks_rag_embed MCP tool, so a VITEST check there would turn that
  // tool into a silent no-op — and it would redden the suites that mock
  // @lancedb/lancedb underneath and drive the real function.
  //
  // Scoped to the embed ONLY. The commit above is load-bearing: it still runs
  // and still throws on failure.
  const skipEmbed = Boolean(process.env.VITEST || process.env.RKS_SKIP_BACKGROUND_EMBED);

  let ragEmbedWarning;
  if (!skipEmbed) {
    try {
      const result = await runRagEmbed(projectRoot, { files: changedFiles });
      if (result && result.ok === false) {
        ragEmbedWarning = result.error ?? 'runRagEmbed returned ok: false';
      }
    } catch (err) {
      ragEmbedWarning = err?.message ?? String(err);
    }
  }

  const ret = { commitId, committedPaths: changedFiles };
  if (skipEmbed) ret.ragEmbedSkipped = true;
  if (ragEmbedWarning !== undefined) ret.ragEmbedWarning = ragEmbedWarning;
  return ret;
}
