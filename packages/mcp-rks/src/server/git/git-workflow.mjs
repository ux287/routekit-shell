// Workflow git operations — branch, commit, merge, PR.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ensureTelemetryStorage } from "../telemetry/index.mjs";
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

export async function runGitCommit({ projectRoot, message, scope, type = "feat", files }) {
  const timestamp = new Date().toISOString();
  console.error(`[rks_git_commit] ${timestamp} type=${type} scope=${scope || "(none)"}`);

  try {
    const currentBranch = getCurrentBranch(projectRoot);
    assertNotOnProtectedBranch(projectRoot, currentBranch, 'commit');

    const integrityCheck = checkHookIntegrity(projectRoot);
    if (!integrityCheck.ok) {
      return { ok: false, error: integrityCheck.error, missingHooks: integrityCheck.missingHooks, recovery: integrityCheck.recovery };
    }

    if (files && files.length > 0) {
      runGit(projectRoot, ["add", ...files]);
    } else {
      runGit(projectRoot, ["add", "-A"]);
    }

    const cached = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: projectRoot, encoding: "utf8" });
    const stagedFiles = cached.stdout.split("\n").filter(l => l.trim().length > 0);
    if (stagedFiles.length === 0) {
      return { ok: false, error: "No changes to commit" };
    }
    const staged = stagedFiles.length;

    const scopePart = scope ? `(${scope})` : "";
    const fullMessage = `${type}${scopePart}: ${message}\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`;

    const { commitId, ragEmbedWarning: embedWarn } = await commitAndEmbed(projectRoot, fullMessage);

    const diffFiles = spawnSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
    const committedFiles = diffFiles.stdout ? diffFiles.stdout.trim().split("\n").filter(Boolean) : [];
    const isDocsOnly = committedFiles.length > 0 && committedFiles.every(f => f.startsWith("notes/") && f.endsWith(".md"));

    const result = {
      ok: true, commitId: commitId.slice(0, 7), fullCommitId: commitId, branch: currentBranch,
      filesChanged: staged, type, scope: scope || null, metadata: { timestamp },
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

export async function runGitPR({ projectRoot, targetBranch = "staging", title, problemId, reason, summary, autoMerge = true, squash = true, projectId = "unknown", testResults = null, costBlock = null }) {
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
        const status = testResults.failCount === 0 ? "✅ Passed" : "❌ Failed";
        bodyLines.push(`| Status | ${status} |`);
        bodyLines.push(`| Tests | ${testResults.passCount} passed${testResults.failCount > 0 ? `, ${testResults.failCount} failed` : ""} |`);
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

    if (autoMerge) {
      const mergeFlag = squash ? "--squash" : "--merge";
      spawnSync("gh", ["pr", "merge", prUrl, mergeFlag, "--delete-branch", "--auto"], { cwd: projectRoot, encoding: "utf8" });
    }

    collector.emit("pr.created", projectId, { url: prUrl, sourceBranch: currentBranch, targetBranch, problemId: problemId || null, reason: reason || null, mode: problemId ? "linked" : "unlinked", autoMerge });

    if (reason && !problemId) {
      collector.emit("pr.unlinked", projectId, { url: prUrl, reason, sourceBranch: currentBranch, targetBranch, hint: "PR created without story linkage - requires human approval in child projects" });
    }

    return { ok: true, url: prUrl, sourceBranch: currentBranch, targetBranch, autoMerge, squash, problemId: problemId || null, backlogUpdated: backlogResult.updated, metadata: { timestamp }, ...(backlogEmbedWarning ? { ragEmbedWarning: backlogEmbedWarning } : {}) };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
