/**
 * commitAndEmbedNote — atomic write → commit → embed for a single Dendron note.
 *
 * Two call shapes:
 *
 *   1. LEGACY (memory): { projectRoot, slug, content, title?, desc? }
 *      Writes notes/memories.<slug>.md, commits as `docs(memory): save <slug>`.
 *      Used by the /memory skill. Backward-compatible.
 *
 *   2. GENERAL (all dendron writes): { projectRoot, notePath, commitMessage,
 *      skipCommit?, skipEmbed? }
 *      Assumes the note is already on disk at `notePath` (the dendron tool
 *      handler called writeNoteRaw with {skipEmbed: true} first). This call
 *      stages → commits → embeds. Idempotent: if the working tree is clean
 *      for that path, no commit is created.
 *
 * Sequence (commit STRICTLY before embed):
 *   - (legacy only) writeNoteRaw(notePath, content, { skipEmbed: true })
 *   - git add <notePath>
 *   - git commit -m <message>  (skipped if nothing staged for that path)
 *   - runRagEmbed of the committed file (skipped if skipEmbed: true)
 *
 * Return envelope (general form): { ok, writeOk, commitOk, commitError?,
 * commitId?, notePath, ragEmbedWarning?, idempotent? }. Legacy form preserves
 * the original { ok, notePath, commitId, ragEmbedWarning?, error? } shape.
 *
 * Branch policy (backlog.fix.hook-memory-skill-contradiction): both forms refuse to
 * commit while the current branch is one of getProtectedBranches(projectRoot) — the
 * same topology-derived set rks_git_commit refuses on. branch-policy.yaml
 * (block_direct_commits_to) is NOT consulted. The general form checks AFTER its
 * skipCommit short-circuit; the legacy form checks BEFORE writing anything.
 *
 * No shell: every git call that carries a path, slug or message uses execFileSync argv.
 *
 * backlog.fix.dendron-writes-no-auto-commit
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeNoteRaw, resolveNotesDir, frontmatterDefaults, formatWithFrontmatter } from "../dendron.mjs";
import { commitAndEmbed } from "./commit-and-embed.mjs";
import { assertNotOnProtectedBranch } from "../server/branch-protection.mjs";

/**
 * The memory slug ALLOWLIST. One rule for both entry points (the legacy helper form
 * and the rks_memory_save tool, which delegates here). The slug becomes a single path
 * segment under `memories.`, so no separators, no leading dot, no `..`, and no shell
 * metacharacters or whitespace.
 */
export const MEMORY_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidMemorySlug(slug) {
  return typeof slug === "string" && MEMORY_SLUG_RE.test(slug) && !slug.includes("..");
}

/** Current branch name, or null when detached / not a repo / unreadable. */
function readCurrentBranch(projectRoot) {
  try {
    const out = execFileSync("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Returns an error string when the current branch is protected, else null.
 * Delegates to assertNotOnProtectedBranch so the protected set and the message are
 * exactly those rks_git_commit uses.
 */
function protectedBranchError(projectRoot) {
  const branch = readCurrentBranch(projectRoot);
  if (!branch) return null;
  try {
    assertNotOnProtectedBranch(projectRoot, branch, "commit");
    return null;
  } catch (err) {
    return err?.message || `refusing to commit on protected branch '${branch}'`;
  }
}

/**
 * What the commit at HEAD actually contains, read back from git.
 *
 * The raw skipEmbed branch does not route through commitAndEmbed, so it has no
 * committedPaths of its own; without this it would report a scoped commit carrying no
 * evidence that it was scoped.
 */
function readCommittedPaths(projectRoot) {
  try {
    return execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], { cwd: projectRoot, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function commitAndEmbedNote(args = {}) {
  // Detection: legacy memory form is signaled by `slug` (the primary
  // identifier), OR by `content` without `notePath` (a missing-slug caller
  // who still meant the memory form). The general form requires `notePath` +
  // `commitMessage` and never carries either `slug` or `content`.
  if (args.slug !== undefined || (args.content !== undefined && args.notePath === undefined)) {
    return commitAndEmbedNoteLegacyMemory(args);
  }
  return commitAndEmbedNoteGeneral(args);
}

async function commitAndEmbedNoteGeneral({ projectRoot, notePath, commitMessage, skipCommit, skipEmbed, extraStagePaths }) {
  if (!projectRoot || typeof projectRoot !== "string") {
    return { ok: false, writeOk: false, commitOk: false, commitError: "projectRoot is required" };
  }
  if (!notePath || typeof notePath !== "string") {
    return { ok: false, writeOk: false, commitOk: false, commitError: "notePath is required" };
  }
  if (!commitMessage || typeof commitMessage !== "string") {
    return { ok: false, writeOk: false, commitOk: false, commitError: "commitMessage is required" };
  }
  const relPath = path.isAbsolute(notePath) ? path.relative(projectRoot, notePath) : notePath;

  // THE WRITE SET, not "the file". A rename legitimately touches two paths, and the
  // caller declares them via extraStagePaths — which were staged upstream but invisible
  // here, so both the pre-check and the commit saw only relPath. The scope of a dendron
  // commit is the tool's own declared write set.
  const writeSet = [relPath];
  if (Array.isArray(extraStagePaths)) {
    for (const extra of extraStagePaths) {
      const rel = path.isAbsolute(extra) ? path.relative(projectRoot, extra) : extra;
      if (rel && !writeSet.includes(rel)) writeSet.push(rel);
    }
  }

  if (skipCommit) {
    return { ok: true, writeOk: true, commitOk: false, notePath: relPath, skipped: true };
  }

  // Protected-branch refusal: AFTER the skipCommit short-circuit, BEFORE any git call.
  // The note is already on disk (the handler wrote it), so writeOk stays true.
  const branchError = protectedBranchError(projectRoot);
  if (branchError) {
    return { ok: false, writeOk: true, commitOk: false, commitError: branchError, notePath: relPath };
  }

  try {
    execFileSync("git", ["add", "--", relPath], { cwd: projectRoot, stdio: "pipe" });
  } catch {
    // git add may fail if the file does not exist (or is outside the repo). Treat
    // as idempotent — no work to commit. Bubble write-failed conditions through
    // their original return paths instead.
    return { ok: true, writeOk: true, commitOk: false, notePath: relPath, idempotent: true };
  }

  // Idempotence: if nothing is staged for this path, skip the commit.
  let staged;
  try {
    staged = execFileSync("git", ["diff", "--cached", "--name-only", "--", ...writeSet], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    staged = "";
  }
  if (!staged) {
    return { ok: true, writeOk: true, commitOk: false, notePath: relPath, idempotent: true };
  }

  if (skipEmbed) {
    // Bypass commitAndEmbed (which runs runRagEmbed) — do a raw git commit.
    try {
      // A trailing `-- <writeSet>` scopes it; anything else staged stays staged.
      execFileSync("git", ["commit", "-m", commitMessage, "--", ...writeSet], { cwd: projectRoot, stdio: "pipe" });
    } catch (err) {
      return { ok: false, writeOk: true, commitOk: false, commitError: `commit failed: ${err.message || String(err)}`, notePath: relPath };
    }
    const commitId = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
    return { ok: true, writeOk: true, commitOk: true, commitId, notePath: relPath, committedPaths: readCommittedPaths(projectRoot) };
  }

  let commitResult;
  try {
    commitResult = await commitAndEmbed(projectRoot, commitMessage, { pathspec: writeSet });
  } catch (err) {
    return { ok: false, writeOk: true, commitOk: false, commitError: `commit failed: ${err.message || String(err)}`, notePath: relPath };
  }

  const result = { ok: true, writeOk: true, commitOk: true, commitId: commitResult.commitId, notePath: relPath, committedPaths: commitResult.committedPaths };
  if (commitResult.ragEmbedWarning !== undefined) {
    result.ragEmbedWarning = commitResult.ragEmbedWarning;
  }
  return result;
}

async function commitAndEmbedNoteLegacyMemory({ projectRoot, slug, content, title, desc } = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    return { ok: false, error: "commitAndEmbedNote: projectRoot is required" };
  }
  if (!slug || typeof slug !== "string") {
    return { ok: false, error: "commitAndEmbedNote: slug is required" };
  }
  // Allowlist BEFORE any write: a refused slug writes no file and makes no commit.
  if (!isValidMemorySlug(slug)) {
    return {
      ok: false,
      error: `commitAndEmbedNote: invalid slug ${JSON.stringify(slug)} — must match ${MEMORY_SLUG_RE} and contain no '..'`,
    };
  }
  if (typeof content !== "string") {
    return { ok: false, error: "commitAndEmbedNote: content must be a string" };
  }
  // Protected-branch refusal BEFORE writing: no file, no staged path, no commit.
  const branchError = protectedBranchError(projectRoot);
  if (branchError) {
    return { ok: false, error: branchError };
  }

  const notesDir = resolveNotesDir(projectRoot);
  const noteId = `memories.${slug}`;
  const notePath = path.join(notesDir, `${noteId}.md`);
  const relPath = path.relative(projectRoot, notePath);

  const fm = frontmatterDefaults({ id: noteId, title: title || slug, desc: desc || "" });
  const noteContent = formatWithFrontmatter(fm, content);

  try {
    writeNoteRaw(notePath, noteContent, { skipEmbed: true });
  } catch (err) {
    return { ok: false, error: `write failed: ${err.message || String(err)}` };
  }

  try {
    execFileSync("git", ["add", "--", relPath], { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    return { ok: false, error: `git add failed: ${err.message || String(err)}`, notePath: relPath };
  }

  const message = `docs(memory): save ${slug}`;
  let commitResult;
  try {
    commitResult = await commitAndEmbed(projectRoot, message, { pathspec: [relPath] });
  } catch (err) {
    return { ok: false, error: `commit failed: ${err.message || String(err)}`, notePath: relPath };
  }

  const result = { ok: true, notePath: relPath, commitId: commitResult.commitId, committedPaths: commitResult.committedPaths };
  if (commitResult.ragEmbedWarning !== undefined) {
    result.ragEmbedWarning = commitResult.ragEmbedWarning;
  }
  return result;
}
