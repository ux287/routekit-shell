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
 * backlog.fix.dendron-writes-no-auto-commit
 */
import path from "node:path";
import { execSync } from "node:child_process";
import { writeNoteRaw, resolveNotesDir, frontmatterDefaults, formatWithFrontmatter } from "../dendron.mjs";
import { commitAndEmbed } from "./commit-and-embed.mjs";

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

async function commitAndEmbedNoteGeneral({ projectRoot, notePath, commitMessage, skipCommit, skipEmbed }) {
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

  if (skipCommit) {
    return { ok: true, writeOk: true, commitOk: false, notePath: relPath, skipped: true };
  }

  try {
    execSync(`git add ${JSON.stringify(relPath)}`, { cwd: projectRoot, stdio: "pipe" });
  } catch {
    // git add may fail if the file does not exist (or is outside the repo). Treat
    // as idempotent — no work to commit. Bubble write-failed conditions through
    // their original return paths instead.
    return { ok: true, writeOk: true, commitOk: false, notePath: relPath, idempotent: true };
  }

  // Idempotence: if nothing is staged for this path, skip the commit.
  let staged;
  try {
    staged = execSync(`git diff --cached --name-only -- ${JSON.stringify(relPath)}`, { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    staged = "";
  }
  if (!staged) {
    return { ok: true, writeOk: true, commitOk: false, notePath: relPath, idempotent: true };
  }

  if (skipEmbed) {
    // Bypass commitAndEmbed (which runs runRagEmbed) — do a raw git commit.
    try {
      execSync(`git commit -m ${JSON.stringify(commitMessage)}`, { cwd: projectRoot, stdio: "pipe" });
    } catch (err) {
      return { ok: false, writeOk: true, commitOk: false, commitError: `commit failed: ${err.message || String(err)}`, notePath: relPath };
    }
    const commitId = execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();
    return { ok: true, writeOk: true, commitOk: true, commitId, notePath: relPath };
  }

  let commitResult;
  try {
    commitResult = await commitAndEmbed(projectRoot, commitMessage);
  } catch (err) {
    return { ok: false, writeOk: true, commitOk: false, commitError: `commit failed: ${err.message || String(err)}`, notePath: relPath };
  }

  const result = { ok: true, writeOk: true, commitOk: true, commitId: commitResult.commitId, notePath: relPath };
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
  if (typeof content !== "string") {
    return { ok: false, error: "commitAndEmbedNote: content must be a string" };
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
    execSync(`git add ${JSON.stringify(relPath)}`, { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    return { ok: false, error: `git add failed: ${err.message || String(err)}`, notePath: relPath };
  }

  const message = `docs(memory): save ${slug}`;
  let commitResult;
  try {
    commitResult = await commitAndEmbed(projectRoot, message);
  } catch (err) {
    return { ok: false, error: `commit failed: ${err.message || String(err)}`, notePath: relPath };
  }

  const result = { ok: true, notePath: relPath, commitId: commitResult.commitId };
  if (commitResult.ragEmbedWarning !== undefined) {
    result.ragEmbedWarning = commitResult.ragEmbedWarning;
  }
  return result;
}
