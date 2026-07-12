import { execSync, execFileSync } from 'node:child_process';
import { runRagEmbed } from '../rag/tools.mjs';

/**
 * Commits staged changes then re-embeds only the changed files into the RAG index.
 * Callers must stage files before calling. Options param is reserved for future extension.
 */
export async function commitAndEmbed(projectRoot, message, options = {}) {
  // Pass the commit message via stdin (-F -) using execFileSync (no shell), so a
  // message containing backticks, $(...), $VARS, or quotes is committed verbatim
  // with zero shell interpretation. The previous `execSync(\`git commit -m ...\`)`
  // shelled out, so JSON.stringify's double-quotes did not stop /bin/sh from
  // interpreting backticks/command-substitution — breaking the auto-ship commit.
  // --cleanup=verbatim: commit the message EXACTLY as given — no whitespace/comment
  // normalization. This preserves byte-for-byte content and, importantly, keeps the
  // `#off-rail-work` marker line (git would otherwise treat leading-`#` lines as
  // comments under the default cleanup mode and strip them).
  execFileSync('git', ['commit', '--cleanup=verbatim', '-F', '-'], {
    cwd: projectRoot,
    input: message,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const commitId = execSync('git rev-parse HEAD', {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();

  const changedFiles = execSync('git diff --name-only HEAD~1..HEAD', {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);

  let ragEmbedWarning;
  try {
    const result = await runRagEmbed(projectRoot, { files: changedFiles });
    if (result && result.ok === false) {
      ragEmbedWarning = result.error ?? 'runRagEmbed returned ok: false';
    }
  } catch (err) {
    ragEmbedWarning = err?.message ?? String(err);
  }

  const ret = { commitId };
  if (ragEmbedWarning !== undefined) ret.ragEmbedWarning = ragEmbedWarning;
  return ret;
}
