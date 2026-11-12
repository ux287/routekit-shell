// backlog.feat.remote-inbox-owner-review
// Owner-side review of remote-lane inbox notes. Reads notes at a git ref (the remote worktree's
// branch) without checking it out; accept copies one into the current branch under a name
// outside inbox., discard records the decision. Never writes into the remote worktree.
//
// Every git call is execFileSync argv (no shell) with a timeout. The source branch is resolved
// only as refs/heads/<branch>, so a caller-supplied name can never be read as a git option.
//
// Decision ledger: ONE file at .rks/state/inbox-decisions.json (gitignored), shared by accept and
// discard, keyed by (branch, filename, blob). blob is the note's blob sha at the branch tip, so a
// note the remote rewrites after a decision is listed again. accept writes its entry ONLY after
// its commit is observed; discard writes only the ledger and never commits.
//
// Accepted content is untrusted (remote clients browse the web): accept never executes or
// interprets it. It copies the bytes and rewrites the frontmatter id.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveNotesDir } from "../dendron.mjs";
import { spliceNoteFrontmatter, splitNoteFrontmatter } from "./frontmatter.mjs";
import { commitAndEmbedNote } from "./commit-and-embed-note.mjs";
import { isValidNoteName } from "./wikilinks.mjs";

export const INBOX_PREFIX = "inbox.";
export const INBOX_DECISIONS_PATH = path.join(".rks", "state", "inbox-decisions.json");
export const INBOX_REVIEW_TOOL = "rks_inbox_review";

const GIT_TIMEOUT_MS = 30_000;

/** inbox.<actor>.<rest> -> actor, or null when the name is not an inbox note. */
export function inboxActor(filename) {
  if (typeof filename !== "string" || !filename.startsWith(INBOX_PREFIX)) return null;
  const rest = filename.slice(INBOX_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return rest.slice(0, dot);
}

/** An accepted note must leave the reserved inbox. namespace so it embeds. */
export function validateAcceptTarget(targetFilename) {
  if (typeof targetFilename !== "string" || !targetFilename.trim()) return { ok: false, reason: "target_missing" };
  if (targetFilename.startsWith(INBOX_PREFIX)) return { ok: false, reason: "target_in_inbox" };
  return { ok: true };
}

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(cwd, args) {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function currentBranchOf(projectRoot) {
  const out = tryGit(projectRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return out ? out.trim() || null : null;
}

/** The notes directory as a git path (forward slashes) relative to projectRoot. */
function notesGitDir(projectRoot, notesDir) {
  const rel = path.relative(projectRoot, notesDir || resolveNotesDir(projectRoot));
  return rel.split(path.sep).join("/");
}

/** Resolve a LOCAL branch tip, or null. refs/heads/ prefix: never parsed as an option. */
function resolveBranchTip(projectRoot, branch) {
  if (typeof branch !== "string" || !branch.trim() || /\s/.test(branch)) return null;
  const out = tryGit(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  return out ? out.trim() || null : null;
}

/**
 * Map filename (without .md) -> blob sha for every `<notesDir>/*.md` directly under the notes
 * directory at `rev`. Read-only (ls-tree).
 */
function notesAtRev(projectRoot, rev, notesRel) {
  const out = tryGit(projectRoot, ["ls-tree", "-z", rev, "--", `${notesRel}/`]);
  const map = new Map();
  if (!out) return map;
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [, type, sha] = rec.slice(0, tab).split(" ");
    const p = rec.slice(tab + 1);
    if (type !== "blob" || !p.endsWith(".md")) continue;
    const base = p.slice(notesRel.length + 1);
    if (base.includes("/")) continue;
    map.set(base.slice(0, -3), sha);
  }
  return map;
}

function firstHeading(raw) {
  const { body } = splitNoteFrontmatter(raw);
  const m = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(body ?? raw);
  return m ? m[1].trim() : null;
}

// ── Decision ledger ─────────────────────────────────────────────────────────────────────────────

function ledgerPath(projectRoot) {
  return path.join(projectRoot, INBOX_DECISIONS_PATH);
}

/** { ok: true, decisions } or { ok: false, error } when the file exists but cannot be read. */
export function readInboxDecisions(projectRoot) {
  const p = ledgerPath(projectRoot);
  if (!fs.existsSync(p)) return { ok: true, decisions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || !Array.isArray(parsed.decisions)) return { ok: false, error: "inbox-decisions.json has no decisions array" };
    return { ok: true, decisions: parsed.decisions };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Upsert one entry keyed by (branch, filename, blob). Atomic write (tmp + rename). */
function recordDecision(projectRoot, entry) {
  const current = readInboxDecisions(projectRoot);
  if (!current.ok) return { ok: false, error: current.error };
  const decisions = current.decisions.filter(
    (d) => !(d.branch === entry.branch && d.filename === entry.filename && d.blob === entry.blob),
  );
  decisions.push(entry);
  const p = ledgerPath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, decisions }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function isDecided(decisions, branch, filename, blob) {
  return decisions.some((d) => d.branch === branch && d.filename === filename && d.blob === blob);
}

const refuse = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

/**
 * Resolve the source note: branch tip, the note's blob at the tip and the commit that produced
 * that blob. Returns { ok: true, tip, blob, notesRel, gitPath } or a refusal.
 */
function resolveSource(projectRoot, notesDir, branch, filename) {
  if (!isValidNoteName(filename)) return refuse("malformed_name", "filename must be a Dendron note name without .md");
  if (!inboxActor(filename)) return refuse("not_inbox_note", `Not an inbox note: ${filename} (expected inbox.<actor>.<rest>)`);
  const tip = resolveBranchTip(projectRoot, branch);
  if (!tip) return refuse("branch_not_found", `No local branch named ${JSON.stringify(branch)}`);
  const notesRel = notesGitDir(projectRoot, notesDir);
  const gitPath = `${notesRel}/${filename}.md`;
  const blob = notesAtRev(projectRoot, tip, notesRel).get(filename);
  if (!blob) return refuse("source_not_found", `${gitPath} is not present at ${branch}`);
  return { ok: true, tip, blob, notesRel, gitPath };
}

/** The commit on `tip` that last wrote `gitPath` (for an unrewritten note, the adding commit). */
function lastCommitFor(projectRoot, tip, gitPath, { added = false } = {}) {
  const args = ["log", "-n", "1", "--format=%H"];
  if (added) args.push("--diff-filter=A");
  args.push(tip, "--", gitPath);
  const out = tryGit(projectRoot, args);
  return out ? out.trim() || null : null;
}

// ── list ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every notes/inbox.<actor>.*.md at the branch tip that is not on the current branch and not
 * matched by a ledger entry for the same (branch, filename, blob). Read-only: ls-tree / log /
 * cat-file on the ref; no checkout; the ledger is only read.
 */
export function listInboxNotes({ projectRoot, notesDir, branch }) {
  const tip = resolveBranchTip(projectRoot, branch);
  if (!tip) return refuse("branch_not_found", `No local branch named ${JSON.stringify(branch)}`, { branch });
  const notesRel = notesGitDir(projectRoot, notesDir);
  const atBranch = notesAtRev(projectRoot, tip, notesRel);
  const onCurrent = notesAtRev(projectRoot, "HEAD", notesRel);
  const ledger = readInboxDecisions(projectRoot);
  const decisions = ledger.ok ? ledger.decisions : [];
  const notes = [];
  for (const [filename, blob] of [...atBranch.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const actor = inboxActor(filename);
    if (!actor) continue;
    if (onCurrent.has(filename)) continue;
    if (isDecided(decisions, branch, filename, blob)) continue;
    const gitPath = `${notesRel}/${filename}.md`;
    const raw = tryGit(projectRoot, ["cat-file", "blob", blob]) ?? "";
    notes.push({
      filename,
      actor,
      commit: lastCommitFor(projectRoot, tip, gitPath, { added: true }),
      blob,
      heading: firstHeading(raw),
    });
  }
  const result = { ok: true, action: "list", branch, tip, currentBranch: currentBranchOf(projectRoot), notes };
  if (!ledger.ok) result.ledgerWarning = `decision ledger unreadable, not applied: ${ledger.error}`;
  return result;
}

// ── accept ──────────────────────────────────────────────────────────────────────────────────────

function removeWrittenTarget(projectRoot, absTarget, relTarget) {
  // Unstage first (commitAndEmbedNote may have run `git add`), then remove the file.
  tryGit(projectRoot, ["rm", "--cached", "-q", "--ignore-unmatch", "--", relTarget]);
  try {
    if (fs.existsSync(absTarget)) fs.unlinkSync(absTarget);
  } catch { /* best-effort */ }
}

/**
 * Copy one inbox note from `branch` onto the CURRENT branch as <notesDir>/<targetFilename>.md,
 * rewriting the frontmatter id, and commit it with an Inbox-Source-* provenance body.
 *
 * Refusals (nothing written, no commit): target_missing, target_in_inbox, malformed_name,
 * not_inbox_note, filename_missing, not_on_working_branch, source_is_current_branch,
 * branch_not_found, source_not_found, target_exists, source_frontmatter_unreadable,
 * ledger_unreadable. A commit that is not observed (hook failure, protected branch, nothing
 * staged) returns commit_not_observed, removes the written file and writes no ledger entry.
 */
export async function acceptInboxNote({ projectRoot, notesDir, branch, filename, targetFilename, workingBranch, commitNote = commitAndEmbedNote }) {
  const target = validateAcceptTarget(targetFilename);
  if (!target.ok) return refuse(target.reason, target.reason === "target_in_inbox"
    ? "targetFilename must not start with inbox. (an inbox note never embeds)"
    : "targetFilename is required");
  if (!isValidNoteName(targetFilename)) return refuse("malformed_name", "targetFilename must be a Dendron note name without .md");
  if (typeof filename !== "string" || !filename.trim()) return refuse("filename_missing", "filename is required");
  if (!inboxActor(filename)) return refuse("not_inbox_note", `Not an inbox note: ${filename} (expected inbox.<actor>.<rest>)`);

  const currentBranch = currentBranchOf(projectRoot);
  if (!workingBranch || currentBranch !== workingBranch) {
    return refuse("not_on_working_branch", `accept writes only on the working branch '${workingBranch}'; current branch is '${currentBranch}'`, { currentBranch, workingBranch });
  }
  if (branch === currentBranch) {
    return refuse("source_is_current_branch", `branch '${branch}' is the current branch; accept imports from a remote worktree branch`, { currentBranch });
  }

  const source = resolveSource(projectRoot, notesDir, branch, filename);
  if (!source.ok) return source;

  const resolvedNotesDir = notesDir || resolveNotesDir(projectRoot);
  const absTarget = path.join(resolvedNotesDir, `${targetFilename}.md`);
  const relTarget = path.relative(projectRoot, absTarget);
  const targetGitPath = `${source.notesRel}/${targetFilename}.md`;
  if (fs.existsSync(absTarget) || notesAtRev(projectRoot, "HEAD", source.notesRel).has(targetFilename)) {
    return refuse("target_exists", `${targetGitPath} already exists on the current branch`);
  }

  const ledger = readInboxDecisions(projectRoot);
  if (!ledger.ok) return refuse("ledger_unreadable", `decision ledger unreadable: ${ledger.error}`);

  let raw;
  try {
    raw = runGit(projectRoot, ["cat-file", "blob", source.blob]);
  } catch (err) {
    return refuse("source_not_found", `cannot read ${source.gitPath} at ${branch}: ${err?.message || String(err)}`);
  }
  const rewritten = spliceNoteFrontmatter(raw, { id: targetFilename });
  if (rewritten === null) return refuse("source_frontmatter_unreadable", `${source.gitPath} at ${branch} has no frontmatter block`);

  const sourceCommit = lastCommitFor(projectRoot, source.tip, source.gitPath) || source.tip;
  const commitMessage = [
    `docs(notes): accept ${filename} as ${targetFilename}`,
    "",
    `Inbox-Source-Branch: ${branch}`,
    `Inbox-Source-Commit: ${sourceCommit}`,
    `Inbox-Source-File: ${filename}`,
  ].join("\n");

  try {
    fs.mkdirSync(path.dirname(absTarget), { recursive: true });
    fs.writeFileSync(absTarget, rewritten, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") return refuse("target_exists", `${targetGitPath} already exists on the current branch`);
    return refuse("write_failed", err?.message || String(err));
  }

  let commitResult;
  try {
    commitResult = await commitNote({ projectRoot, notePath: relTarget, commitMessage, provenanceTool: INBOX_REVIEW_TOOL });
  } catch (err) {
    commitResult = { ok: false, commitOk: false, commitError: err?.message || String(err) };
  }

  // Observation: a returned commit id that git reads back as HEAD, carrying the target path.
  const commitId = commitResult?.commitOk === true ? commitResult.commitId : null;
  const head = tryGit(projectRoot, ["rev-parse", "HEAD"])?.trim() || null;
  const observed = Boolean(commitId) && head === commitId &&
    Boolean(tryGit(projectRoot, ["ls-tree", "--name-only", commitId, "--", targetGitPath])?.trim());
  if (!observed) {
    removeWrittenTarget(projectRoot, absTarget, relTarget);
    return refuse("commit_not_observed", commitResult?.commitError || "the accept commit was not observed", {
      writeOk: false,
      commitOk: false,
      ...(commitResult?.commitError ? { commitError: commitResult.commitError } : {}),
    });
  }

  const entry = {
    branch,
    filename,
    blob: source.blob,
    decision: "accept",
    targetFilename,
    commit: commitId,
    at: new Date().toISOString(),
  };
  const recorded = recordDecision(projectRoot, entry);
  const result = {
    ok: true,
    action: "accept",
    branch,
    filename,
    targetFilename,
    notePath: targetGitPath,
    sourceCommit,
    sourceTip: source.tip,
    blob: source.blob,
    commit: commitId,
    writeOk: true,
    commitOk: true,
  };
  if (commitResult.ragEmbedWarning !== undefined) result.ragEmbedWarning = commitResult.ragEmbedWarning;
  if (!recorded.ok) result.ledgerWarning = `committed, but the decision ledger was not written: ${recorded.error}`;
  return result;
}

// ── discard ─────────────────────────────────────────────────────────────────────────────────────

/** Record a discard decision for (branch, filename, blob). Writes ONLY the ledger. */
export function discardInboxNote({ projectRoot, notesDir, branch, filename }) {
  if (typeof filename !== "string" || !filename.trim()) return refuse("filename_missing", "filename is required");
  const source = resolveSource(projectRoot, notesDir, branch, filename);
  if (!source.ok) return source;
  const entry = { branch, filename, blob: source.blob, decision: "discard", at: new Date().toISOString() };
  const recorded = recordDecision(projectRoot, entry);
  if (!recorded.ok) return refuse("ledger_unreadable", `decision ledger not written: ${recorded.error}`);
  return { ok: true, action: "discard", branch, filename, blob: source.blob, ledger: INBOX_DECISIONS_PATH };
}
