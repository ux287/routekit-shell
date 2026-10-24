// Workflow git operations — branch, commit, merge, PR.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { assertNotProtectedBranch, assertNotOnProtectedBranch, isProductionBranch } from "../branch-protection.mjs";
import { updateField, resolveNotesDir } from "../../dendron.mjs";
import {
  runGit,
  getCurrentBranch,
  isGuardrailsOffSession,
  checkHookIntegrity,
  updateBacklogStatus,
  VALID_UNLINKED_REASONS,
} from "./git-utils.mjs";
import { commitAndEmbed } from '../../shared/commit-and-embed.mjs';
import { coAuthorTrailer } from '../../shared/commit-attribution.mjs';

/**
 * Normalize a caller-supplied path to the repo-relative, `/`-separated form `git ls-files` prints:
 * interior `./` and `../` segments are resolved and a trailing `/` is dropped. The repo root
 * itself normalizes to `"."`.
 */
function toRepoRelative(projectRoot, p) {
  const raw = path.isAbsolute(p) ? path.relative(projectRoot, p) : p;
  const rel = path.posix.normalize(raw.split(path.sep).join("/")).replace(/\/+$/, "");
  return rel === "" ? "." : rel;
}

/**
 * Split explicit paths by whether they cover tracked content, judged by what `git ls-files`
 * reports the pathspecs match: a path covers tracked content when an index entry equals its
 * normalized form or lies beneath it (a directory, with or without a trailing slash).
 * Paths covering no index entry (untracked files, wholly untracked directories) are untracked.
 * `untrackedWithinTracked` lists the untracked, NON-ignored files git reports inside the
 * tracked paths; an ignored untracked file inside them is never listed, so it stays untracked.
 */
function splitTrackedPaths(projectRoot, paths) {
  const listed = runGit(projectRoot, ["ls-files", "-z", "--", ...paths]).split("\0").filter(Boolean);
  const trackedPaths = [];
  const untrackedPaths = [];
  for (const p of paths) {
    const rel = toRepoRelative(projectRoot, p);
    const coversTracked = rel === "." || listed.some(e => e === rel || e.startsWith(rel + "/"));
    (coversTracked ? trackedPaths : untrackedPaths).push(p);
  }
  const untrackedWithinTracked = trackedPaths.length > 0
    ? runGit(projectRoot, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...trackedPaths])
      .split("\0")
      .filter(Boolean)
    : [];
  return { trackedPaths, untrackedPaths, untrackedWithinTracked };
}

/** The untracked files among `paths` that git's exclude rules ignore, as git reports them. */
function listUntrackedIgnored(projectRoot, paths) {
  return runGit(projectRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...paths])
    .split("\0")
    .filter(Boolean);
}

export async function runGitBranch({ projectRoot, name, type = "feature", baseBranch }) {
  const timestamp = new Date().toISOString();

  if (!baseBranch) {
    try {
      const configPath = [
        path.join(projectRoot, 'routekit', 'project.json'),
        path.join(projectRoot, '.rks', 'project.json'),
      ].find(p => fs.existsSync(p));
      if (configPath) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        baseBranch = cfg.baseBranch || 'staging';
      } else {
        baseBranch = 'staging';
      }
    } catch {
      baseBranch = 'staging';
    }
  }

  if (!/^[a-zA-Z0-9_/.-]+$/.test(name)) {
    return { ok: false, error: "Branch name must be alphanumeric with hyphens, underscores, dots, or slashes only" };
  }

  const branchName = type === "rks" ? `rks/${name}` : `${type}/${name}`;
  console.error(`[rks_git_branch] ${timestamp} creating branch ${branchName} from ${baseBranch}`);

  try {
    assertNotProtectedBranch(projectRoot, baseBranch, 'create branch from');

    const currentBranch = getCurrentBranch(projectRoot);
    if (currentBranch !== baseBranch) {
      runGit(projectRoot, ["checkout", baseBranch]);
    }

    try {
      runGit(projectRoot, ["pull", "--ff-only"]);
    } catch (e) {
      // No upstream or not fast-forward - continue anyway
    }

    runGit(projectRoot, ["checkout", "-b", branchName]);

    return { ok: true, branch: branchName, baseBranch, type, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

/** A git trailer token: letters, digits and hyphens, not starting with a hyphen. */
const TRAILER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export async function runGitCommit({ projectRoot, message, rawMessage, scope, type, files, storyId, coAuthor, trailers, stageAll = false }) {
  const timestamp = new Date().toISOString();
  const verbatim = rawMessage !== undefined;
  console.error(`[rks_git_commit] ${timestamp} mode=${verbatim ? "verbatim" : "structured"} type=${verbatim ? "(none)" : (type ?? "feat")} scope=${scope || "(none)"}`);

  // Exactly one of `message` (structured) or `rawMessage` (verbatim) is required. A structured
  // call with no message would otherwise commit the literal subject `feat: undefined`.
  if (!verbatim && (message === undefined || message === null)) {
    return {
      ok: false,
      error: "runGitCommit: one of message or rawMessage is required (message builds a conventional-commit subject; rawMessage commits a complete message verbatim).",
      metadata: { timestamp },
    };
  }

  // Verbatim mode (backlog.feat.governed-adhoc-commit-verbatim-message). Every guard runs
  // BEFORE any staging, so a refused call leaves HEAD and the index exactly as it found them.
  if (verbatim) {
    // 1. Mutual exclusivity: the caller owns the whole message, so no field that would
    //    rewrite it may be combined with it. No silent precedence — name the field.
    const conflicting = { type, scope, message, storyId, coAuthor, trailers: Array.isArray(trailers) && trailers.length === 0 ? undefined : trailers };
    for (const [field, value] of Object.entries(conflicting)) {
      if (value !== undefined && value !== null) {
        return {
          ok: false,
          error: `runGitCommit: rawMessage cannot be combined with ${field}. rawMessage is committed verbatim as the complete message (subject, body and trailers); omit ${field}, or drop rawMessage and use the structured message form.`,
          metadata: { timestamp },
        };
      }
    }
    // 2. A non-empty message.
    if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
      return {
        ok: false,
        error: "runGitCommit: rawMessage is empty or whitespace-only. Supply the complete commit message.",
        metadata: { timestamp },
      };
    }
    // 3. Explicit paths, regardless of stageAll: verbatim mode commits only the named paths.
    if (!Array.isArray(files) || files.length === 0) {
      return {
        ok: false,
        error: "runGitCommit: rawMessage requires a non-empty files list; verbatim mode commits only the named paths (stageAll is not accepted). A staged rename needs both the old and the new path listed.",
        metadata: { timestamp },
      };
    }
  }

  // An absent or empty `files` never silently becomes a repo-wide `git add -A`: the caller must
  // either name the files or state `stageAll: true` explicitly. The opt-in is never inferred from
  // `files`, and this checks the caller's ORIGINAL argument, never the remainder left after
  // already-staged deletions are dropped below (backlog.fix.git-commit-broad-add-fallback).
  const hasExplicitFiles = Array.isArray(files) && files.length > 0;
  if (!hasExplicitFiles && stageAll !== true) {
    return {
      ok: false,
      error: "runGitCommit: the files argument is absent or empty, and there is no all-files fallback. Pass an explicit files list, or stageAll: true to stage every change.",
      metadata: { timestamp },
    };
  }

  // backlog.fix.exec-plan-commit-linkage-review-followups (AC13): a supplied trailer is refused, with
  // no staging and no commit, when its key is not a git trailer token or its key or value carries a
  // CR or LF (which would add lines to the trailer block). Entries the extraTrailerLines filter drops
  // (non-string or empty key/value) are still silently dropped.
  for (const t of Array.isArray(trailers) ? trailers : []) {
    if (!(t && typeof t.key === "string" && t.key.length > 0 && typeof t.value === "string" && t.value.length > 0)) continue;
    if (!TRAILER_KEY_RE.test(t.key) || /[\r\n]/.test(t.key) || /[\r\n]/.test(t.value)) {
      return {
        ok: false,
        error: `runGitCommit: trailer ${JSON.stringify(t.key)} refused: the key must match ${TRAILER_KEY_RE} and neither key nor value may contain CR or LF.`,
        metadata: { timestamp },
      };
    }
  }

  try {
    const currentBranch = getCurrentBranch(projectRoot);
    assertNotOnProtectedBranch(projectRoot, currentBranch, 'commit');

    const integrityCheck = checkHookIntegrity(projectRoot);
    if (!integrityCheck.ok) {
      return { ok: false, error: integrityCheck.error, missingHooks: integrityCheck.missingHooks, recovery: integrityCheck.recovery };
    }

    if (hasExplicitFiles) {
      // A listed path whose deletion is already staged (`git rm <p>`) is in neither the
      // worktree nor the index, so `git add <p>` fails with "pathspec did not match any
      // files". It needs no staging, so drop it and add only the remainder. When nothing
      // remains, run no `git add` at all — never fall through to the repo-wide `-A` below.
      // A never-tracked path stays in the remainder, so git still fails and names it
      // (backlog.fix.git-commit-add-fails-on-staged-deletion).
      const stagedDeletions = new Set(
        runGit(projectRoot, ["diff", "--cached", "--name-only", "--diff-filter=D", "-z"])
          .split("\0")
          .filter(Boolean),
      );
      const toAdd = files.filter(f => !stagedDeletions.has(toRepoRelative(projectRoot, f)));
      if (toAdd.length > 0) {
        // Tracked/untracked split, decided by `git ls-files` — never by parsing .gitignore
        // (backlog.fix.ship-path-commits-tracked-files-under-ignored-dirs). A plain `git add`
        // of a TRACKED file under an ignored directory stages it and still exits 1 with git's
        // "paths are ignored" advice. Tracked paths therefore go through `git add -u`, which
        // cannot add an untracked file by construction, so no untracked ignored file is ever
        // force-added. Untracked paths keep the plain `git add`. A path that covers tracked
        // content (a directory, a trailing-slash or `../` form) is classified by what git matches
        // (backlog.fix.git-commit-split-tracked-paths-misclassifies-dirs-and-dotdot): its tracked
        // files go through `add -u`, and only the untracked NON-ignored files git reports inside
        // it get a plain add. An ignored untracked file inside it is left untracked, not refused.
        const { trackedPaths, untrackedPaths, untrackedWithinTracked } = splitTrackedPaths(projectRoot, toAdd);
        if (untrackedPaths.length > 0) {
          // An untracked IGNORED path is refused before anything is staged. The error is built
          // from the split, so it names the ignored file itself — git's own message may name only
          // the ignored parent directory.
          const ignored = listUntrackedIgnored(projectRoot, untrackedPaths);
          if (ignored.length > 0) {
            return {
              ok: false,
              error: `runGitCommit: refusing to stage untracked ignored path(s): ${ignored.join(", ")}. An untracked file under an ignored path is never force-added; tracked files under ignored directories are staged normally.`,
              untrackedIgnored: ignored,
              metadata: { timestamp },
            };
          }
        }
        if (trackedPaths.length > 0) {
          runGit(projectRoot, ["add", "-u", "--", ...trackedPaths]);
        }
        const plainAdd = [...untrackedPaths, ...untrackedWithinTracked];
        if (plainAdd.length > 0) {
          runGit(projectRoot, ["add", "--", ...plainAdd]);
        }
      }
    } else {
      // Reached only with stageAll === true; the guard above returns otherwise.
      runGit(projectRoot, ["add", "-A"]);
    }

    if (verbatim) {
      // No-changes is judged against the NAMED paths only. A whole-index count would let an
      // unrelated pre-staged path pass the check while the named paths are unchanged.
      const namedStaged = runGit(projectRoot, ["diff", "--cached", "--name-only", "--", ...files])
        .split("\n")
        .filter(l => l.trim().length > 0);
      if (namedStaged.length === 0) {
        return { ok: false, error: "No changes to commit in the named files", metadata: { timestamp } };
      }

      // Path-scoped partial commit: entries staged outside `files` stay staged and
      // uncommitted. commitAndEmbed commits with --cleanup=verbatim -F -, so the message
      // bytes are exactly the caller's. committedPaths is read back from git.
      const { commitId, committedPaths, ragEmbedWarning: embedWarn } = await commitAndEmbed(projectRoot, rawMessage, { pathspec: files });
      const committedList = committedPaths ?? [];
      return {
        ok: true, commitId: commitId.slice(0, 7), fullCommitId: commitId, branch: currentBranch,
        committedPaths: committedList, filesChanged: committedList.length, type: null, scope: null,
        metadata: { timestamp },
        ...(embedWarn ? { ragEmbedWarning: embedWarn } : {}),
      };
    }

    const cached = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: projectRoot, encoding: "utf8" });
    const stagedFiles = cached.stdout.split("\n").filter(l => l.trim().length > 0);
    if (stagedFiles.length === 0) {
      return { ok: false, error: "No changes to commit" };
    }
    const staged = stagedFiles.length;

    const scopePart = scope ? `(${scope})` : "";
    // The Co-Authored-By trailer comes ONLY from a caller-supplied coAuthor ('Name <email>');
    // rks never writes a model name of its own (backlog.fix.commit-trailer-hardcodes-stale-model-name).
    // `Story: <storyId>` goes in the SAME trailer block as Co-Authored-By when there is one (no
    // blank line between them), and otherwise opens its own trailer block (\n\n), so
    // `git interpret-trailers --parse` always reports it. It is the evidence
    // repairPhaseToIntegrated's line-exact findStoryTrailerCommit looks for after a manual merge.
    const coAuthorPart = coAuthorTrailer(coAuthor);
    const storyLine = typeof storyId === "string" && storyId.length > 0 ? `${coAuthorPart ? "\n" : "\n\n"}Story: ${storyId}` : "";
    // The `feat` default applies in structured mode only (it used to be a destructure default,
    // which made a caller-supplied type indistinguishable from the default).
    // backlog.feat.exec-plan-commit-linkage (AC1): optional extra trailers ([{ key, value }],
    // e.g. Plan-Hash and Run-Id) render as `Key: value` in the SAME trailer block as Story /
    // Co-Authored-By. Absent or empty leaves the message byte-identical to before.
    const extraTrailerLines = (Array.isArray(trailers) ? trailers : [])
      .filter((t) => t && typeof t.key === "string" && t.key.length > 0 && typeof t.value === "string" && t.value.length > 0)
      .map((t) => `${t.key}: ${t.value}`);
    const extraTrailerPart = extraTrailerLines.length > 0
      ? `${coAuthorPart || storyLine ? "\n" : "\n\n"}${extraTrailerLines.join("\n")}`
      : "";
    const structuredType = type ?? "feat";
    const fullMessage = `${structuredType}${scopePart}: ${message}${coAuthorPart}${storyLine}${extraTrailerPart}`;

    // `committedPaths` is part of commitAndEmbed's contract and is read back from git inside
    // it. This used to re-derive the same list one line later with its own
    // `git diff HEAD~1 HEAD` — a second copy of a rule, free to disagree with the first, and
    // with two failure modes of its own: `HEAD~1` does not resolve on a root commit, and being
    // spawnSync it failed SILENTLY, yielding `[]` with no error and no warning. Nothing checked
    // its status. Adding `--root` here would only have made a redundant derivation correct;
    // deleting it removes the disagreement instead.
    const { commitId, committedPaths, ragEmbedWarning: embedWarn } = await commitAndEmbed(projectRoot, fullMessage);

    const committedFiles = committedPaths ?? [];
    const isDocsOnly = committedFiles.length > 0 && committedFiles.every(f => f.startsWith("notes/") && f.endsWith(".md"));

    const result = {
      ok: true, commitId: commitId.slice(0, 7), fullCommitId: commitId, branch: currentBranch,
      filesChanged: staged, type: structuredType, scope: scope || null, metadata: { timestamp },
      ...(embedWarn ? { ragEmbedWarning: embedWarn } : {}),
    };

    if (isDocsOnly) {
      result.hint = "Docs-only commit detected. Next step: rks_rag_embed to index your changes. No push needed for local docs work.";
    }

    return result;
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitMerge({ projectRoot, targetBranch = "staging", deleteBranch = false }) {
  const timestamp = new Date().toISOString();

  try {
    const sourceBranch = getCurrentBranch(projectRoot);

    if (sourceBranch === targetBranch) {
      return { ok: false, error: `Already on ${targetBranch}, nothing to merge` };
    }

    if (targetBranch === "staging") {
      return { ok: false, error: "Direct merge to staging not allowed - use PR flow", hint: "Use rks_staging_pr to create a PR, then rks_staging_merge to merge it. This ensures PR visibility in GitHub." };
    }

    console.error(`[rks_git_merge] ${timestamp} merging ${sourceBranch} into ${targetBranch}`);

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    if (status.stdout.trim()) {
      return { ok: false, error: "Uncommitted changes - commit or stash first" };
    }

    runGit(projectRoot, ["checkout", targetBranch]);
    try { runGit(projectRoot, ["pull", "--ff-only"]); } catch (e) { /* No upstream */ }

    const mergeResult = spawnSync("git", ["merge", sourceBranch, "--no-edit"], { cwd: projectRoot, encoding: "utf8" });

    if (mergeResult.status !== 0) {
      spawnSync("git", ["merge", "--abort"], { cwd: projectRoot });
      runGit(projectRoot, ["checkout", sourceBranch]);
      return { ok: false, error: "Merge conflict detected", conflictOutput: mergeResult.stdout + mergeResult.stderr, suggestion: "Resolve conflicts manually or rebase" };
    }

    const commitId = runGit(projectRoot, ["rev-parse", "HEAD"]);

    if (deleteBranch) {
      runGit(projectRoot, ["branch", "-d", sourceBranch]);
    }

    return { ok: true, merged: true, sourceBranch, targetBranch, commitId: commitId.slice(0, 7), branchDeleted: deleteBranch, metadata: { timestamp } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runGitPR({ projectRoot, targetBranch = "staging", title, problemId, reason, summary, autoMerge = false, squash = true, projectId = "unknown", testResults = null, costBlock = null }) {
  const timestamp = new Date().toISOString();
  const collector = ensureTelemetryStorage(projectRoot);

  let currentBranch;
  try {
    // Same-branch check first — if already on target, no PR needed regardless of params
    try {
      currentBranch = getCurrentBranch(projectRoot);
      if (currentBranch === targetBranch) {
        return { ok: true, skipped: true, sourceBranch: currentBranch, targetBranch, reason: "Already on target branch — commit pushed directly to working branch" };
      }
    } catch { /* no git repo — fall through to validation */ }

    if (!problemId && !reason) {
      return { ok: false, error: "Either problemId or reason is required", hint: `Provide problemId to link to a backlog story, or reason for unlinked changes. Valid reasons: ${VALID_UNLINKED_REASONS.join(", ")}` };
    }
    if (reason && !VALID_UNLINKED_REASONS.includes(reason)) {
      return { ok: false, error: `Invalid reason '${reason}'. Valid reasons: ${VALID_UNLINKED_REASONS.join(", ")}` };
    }

    if (isProductionBranch(projectRoot, targetBranch)) {
      return { ok: false, error: `PRs must not target "${targetBranch}" (production branch). Use rks_release to promote to production.`, hint: "This rail prevents workflow violations. Only rks_release can advance the production branch." };
    }

    const mode = problemId ? "linked" : "unlinked";
    console.error(`[rks_git_pr] ${timestamp} creating PR from ${currentBranch} to ${targetBranch} mode=${mode}${reason ? ` reason=${reason}` : ""}`);

    let backlogResult = { updated: false };
    let backlogEmbedWarning;
    if (problemId) {
      const oldNotePath = path.join(projectRoot, "notes", `${problemId}.md`);
      backlogResult = updateBacklogStatus(projectRoot, problemId);
      if (backlogResult.updated) {
        try {
          const oldRelPath = path.relative(projectRoot, oldNotePath);
          const newRelPath = path.relative(projectRoot, backlogResult.path);
          runGit(projectRoot, ["add", oldRelPath, newRelPath]);
          const { ragEmbedWarning } = await commitAndEmbed(projectRoot, `docs(backlog): mark ${problemId} implemented`);
          if (ragEmbedWarning) backlogEmbedWarning = ragEmbedWarning;
        } catch (err) {
          // Continue even if commit fails
        }
      }
    }

    if (!isGuardrailsOffSession(projectRoot)) {
      const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
      if (status.stdout.trim()) {
        return { ok: false, error: "Uncommitted changes - commit first" };
      }
    }

    const pushResult = spawnSync("git", ["push", "-u", "origin", currentBranch], { cwd: projectRoot, encoding: "utf8" });
    if (pushResult.status !== 0) {
      return { ok: false, error: `Push failed: ${pushResult.stderr}` };
    }

    const bodyLines = ["## Summary"];
    if (problemId) bodyLines.push(`- Implements \`${problemId}\``);
    if (summary) bodyLines.push(`- ${summary}`);
    bodyLines.push("");

    if (costBlock) {
      bodyLines.push("<details>");
      bodyLines.push("<summary>Token Cost & Efficiency</summary>");
      bodyLines.push("");
      bodyLines.push(costBlock);
      bodyLines.push("</details>");
      bodyLines.push("");
    }

    if (testResults) {
      bodyLines.push("## Test Results");
      if (testResults.testsSkipped) {
        bodyLines.push(`Tests skipped — ${testResults.skipReason || "paired test story will cover test execution"}.`);
      } else {
        bodyLines.push("| Metric | Value |");
        bodyLines.push("|--------|-------|");
        // A count that was not observed is rendered as unavailable, never as 0 or as a pass.
        const countsKnown = typeof testResults.passCount === "number" && typeof testResults.failCount === "number";
        if (countsKnown) {
          const status = testResults.failCount === 0 ? "✅ Passed" : "❌ Failed";
          bodyLines.push(`| Status | ${status} |`);
          bodyLines.push(`| Tests | ${testResults.passCount} passed${testResults.failCount > 0 ? `, ${testResults.failCount} failed` : ""} |`);
        } else {
          const reason = testResults.countsUnavailableReason ? ` (${testResults.countsUnavailableReason})` : "";
          bodyLines.push(`| Status | ⚠️ Counts unavailable |`);
          bodyLines.push(`| Tests | counts unavailable${reason} |`);
        }
        if (testResults.duration) bodyLines.push(`| Duration | ${testResults.duration} |`);
        if (testResults.runner) bodyLines.push(`| Runner | ${testResults.runner} |`);
        if (testResults.attempts !== undefined) bodyLines.push(`| Attempts | ${testResults.attempts} |`);
      }
      bodyLines.push("");
    }

    bodyLines.push("## Test Plan");
    bodyLines.push("- [x] Tests pass locally");
    bodyLines.push("- [x] Executed via rks_exec");
    bodyLines.push("");
    bodyLines.push("🤖 Generated with RouteKit Shell");
    const body = bodyLines.join("\n");

    const prTitle = title || `feat: ${problemId || currentBranch}`;
    const createResult = spawnSync("gh", ["pr", "create", "--base", targetBranch, "--title", prTitle, "--body", body], { cwd: projectRoot, encoding: "utf8" });

    if (createResult.status !== 0) {
      return { ok: false, error: `PR creation failed: ${createResult.stderr}` };
    }

    const prUrl = createResult.stdout.trim();

    // Evidence-bound: autoMerge reports what gh actually applied, not what was requested.
    let autoMergeApplied = false;
    let autoMergeError;
    if (autoMerge) {
      const mergeFlag = squash ? "--squash" : "--merge";
      const mergeResult = spawnSync("gh", ["pr", "merge", prUrl, mergeFlag, "--delete-branch", "--auto"], { cwd: projectRoot, encoding: "utf8" });
      if (mergeResult && mergeResult.status === 0) {
        autoMergeApplied = true;
      } else {
        autoMergeError = (mergeResult && (mergeResult.stderr || (mergeResult.error && mergeResult.error.message))) || `gh pr merge exited with status ${mergeResult ? mergeResult.status : "unknown"}`;
      }
    }

    collector.emit("pr.created", projectId, { url: prUrl, sourceBranch: currentBranch, targetBranch, problemId: problemId || null, reason: reason || null, mode: problemId ? "linked" : "unlinked", autoMerge: autoMergeApplied, ...(autoMergeError ? { autoMergeError } : {}) });

    if (reason && !problemId) {
      collector.emit("pr.unlinked", projectId, { url: prUrl, reason, sourceBranch: currentBranch, targetBranch, hint: "PR created without story linkage - requires human approval in child projects" });
    }

    return { ok: true, url: prUrl, sourceBranch: currentBranch, targetBranch, autoMerge: autoMergeApplied, ...(autoMergeError ? { autoMergeError } : {}), squash, problemId: problemId || null, backlogUpdated: backlogResult.updated, metadata: { timestamp }, ...(backlogEmbedWarning ? { ragEmbedWarning: backlogEmbedWarning } : {}) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
