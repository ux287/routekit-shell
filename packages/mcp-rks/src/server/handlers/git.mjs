/**
 * Git primitives family handlers — moved verbatim from server.mjs (S6 of
 * research.2026.10.05.server-mjs-safe-decomposition).
 * Relative imports resolve to the same module files server.mjs imports (invariant I3); the
 * seven lazy git-tools imports stay lazy and are re-pathed to ../git-tools.mjs, the same file.
 * Schema consts stay in server.mjs (TOOL_ARG_SCHEMAS and the schema-drift guard reference
 * them) and are passed in at registration. rks_git_preflight registers under the imported
 * TOOL_NAME constant, the same one ListTools advertises.
 * Handler contract: see ./registry.mjs. Three handlers (rks_stash, rks_git_commit,
 * rks_git_push) read ctx.governorToken — the request token server.mjs strips from args — and
 * call chain-state helpers imported from shared/governor-token.mjs, per the registry contract.
 * No other handler reads ctx.
 */
import { z } from "zod";
import { loadContext, getBranchConfig } from "../project.mjs";
import { runGitBranch, runGitCommit, runResolveConflict, runGitCheckout, runBranchRepair } from "../git-tools.mjs";
import { runGitPush } from "../../tools/git-push.mjs";
import { runGitPreflight, TOOL_NAME as GIT_PREFLIGHT_TOOL } from "../../tools/git-preflight.mjs";
import { coAuthorTrailer, CO_AUTHOR_REJECTED_WARNING } from "../../shared/commit-attribution.mjs";
import { validateToken, advanceStateOnResult, setPendingStash, clearPendingStash } from "../../shared/governor-token.mjs";

export function registerGitHandlers({ registerHandler }, {
  stashSchema,
  restoreSchema,
  resetSchema,
  revertSchema,
  tagSchema,
  cherryPickSchema,
  gitBranchSchema,
  checkoutSchema,
  branchRepairSchema,
  gitCommitSchema,
  gitPushSchema,
}) {
  registerHandler("rks_stash", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = stashSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runGitStash } = await import("../git-tools.mjs");
    const stashProjectRoot = context.record.root;
    const res = await runGitStash({
      projectRoot: stashProjectRoot,
      action: input.action,
      message: input.message,
      stashIndex: input.stashIndex,
      includeUntracked: input.includeUntracked
    });
    // Track pending stash for auto-pop guarantee when governor session ends
    if (_governorToken && validateToken(_governorToken)) {
      if (input.action === 'save' || input.action === 'push') {
        setPendingStash(_governorToken, async () => {
          const { runGitStash: popStash } = await import("../git-tools.mjs");
          return popStash({ projectRoot: stashProjectRoot, action: 'pop' });
        });
      } else if (input.action === 'pop' || input.action === 'drop') {
        clearPendingStash(_governorToken);
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_restore", async (cleanArgs, ctx) => {
    const input = restoreSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runGitRestore } = await import("../git-tools.mjs");
    const res = await runGitRestore({
      projectRoot: context.record.root,
      files: input.files,
      staged: input.staged,
      source: input.source
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_reset", async (cleanArgs, ctx) => {
    const input = resetSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runGitReset } = await import("../git-tools.mjs");
    const res = await runGitReset({
      projectRoot: context.record.root,
      mode: input.mode,
      target: input.target,
      confirm: input.confirm
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_revert", async (cleanArgs, ctx) => {
    const input = revertSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runGitRevert } = await import("../git-tools.mjs");
    const res = await runGitRevert({
      projectRoot: context.record.root,
      commit: input.commit,
      noCommit: input.noCommit
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_tag", async (cleanArgs, ctx) => {
    const input = tagSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runGitTag } = await import("../git-tools.mjs");
    const branchConfig = getBranchConfig(context.record, context.projectJson);
    const res = await runGitTag({
      projectRoot: context.record.root,
      action: input.action,
      name: input.name,
      message: input.message,
      commit: input.commit,
      pattern: input.pattern,
      productionBranch: branchConfig.production || 'main'
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_cherry_pick", async (cleanArgs, ctx) => {
    const input = cherryPickSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runGitCherryPick } = await import("../git-tools.mjs");
    const res = await runGitCherryPick({
      projectRoot: context.record.root,
      commit: input.commit,
      noCommit: input.noCommit,
      abort: input.abort
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_git_branch", async (cleanArgs, ctx) => {
    const input = gitBranchSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const baseBranch = context.projectJson?.baseBranch || "staging";
    const res = await runGitBranch({ projectRoot, name: input.name, type: input.type, baseBranch });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_checkout", async (cleanArgs, ctx) => {
    const input = checkoutSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runGitCheckout({ projectRoot, branch: input.branch, force: input.force });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_branch_repair", async (cleanArgs, ctx) => {
    const input = branchRepairSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runBranchRepair({ projectRoot, ...input });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_git_commit", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = gitCommitSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    // Explicit tool-layer opt-in: an OMITTED files keeps the documented all-changes behaviour;
    // files: [] is rejected. stageAll is not in gitCommitSchema, so callers cannot inject it
    // (backlog.fix.git-commit-broad-add-fallback).
    const commitRes = await runGitCommit({ projectRoot, ...input, stageAll: input.files === undefined });
    const coAuthorRejected = input.coAuthor !== undefined && coAuthorTrailer(input.coAuthor) === "";
    if (coAuthorRejected) console.error(CO_AUTHOR_REJECTED_WARNING);
    const res = coAuthorRejected
      ? { ...commitRes, coAuthorRejected: true, coAuthorWarning: CO_AUTHOR_REJECTED_WARNING }
      : commitRes;
    // Advance ship flow state: init → committed
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = res.ok ? 'git_commit.ok' : 'git_commit.error';
      advanceStateOnResult(_governorToken, resultKey);
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_git_push", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = gitPushSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = runGitPush(projectRoot, { branch: input.branch });
    // Advance ship flow state: committed stays committed after push
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = res.ok ? 'git_push.ok' : 'git_push.error';
      advanceStateOnResult(_governorToken, resultKey);
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler(GIT_PREFLIGHT_TOOL, async (cleanArgs, ctx) => {
    const context = await loadContext(cleanArgs.projectId);
    const projectRoot = context.record.root;
    const res = runGitPreflight(projectRoot, {
      expectedBranch: cleanArgs.expectedBranch,
      autoStash: cleanArgs.autoStash,
      cleanWorktrees: cleanArgs.cleanWorktrees ?? true,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_resolve_conflict", async (cleanArgs, ctx) => {
    const input = z.object({ projectId: z.string(), strategy: z.enum(["ours", "theirs", "abort"]).optional(), files: z.array(z.string()).optional() }).parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runResolveConflict({ projectRoot, strategy: input.strategy || "theirs", files: input.files || [] });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });
}
