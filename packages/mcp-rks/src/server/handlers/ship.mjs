/**
 * Ship / workflow family handlers — moved verbatim from server.mjs (S7 of
 * research.2026.10.05.server-mjs-safe-decomposition).
 * Relative imports resolve to the same module files server.mjs imports (invariant I3); the
 * three lazy imports stay lazy and are re-pathed to ../story-ship.mjs and ../git-tools.mjs,
 * the same files. Schema consts stay in server.mjs (TOOL_ARG_SCHEMAS and the schema-drift
 * guard reference them) and are passed in at registration; the inline schemas of
 * rks_story_ship, rks_sync_staging and rks_release stay inline.
 * Handler contract: see ./registry.mjs. Six handlers read ctx.governorToken (rks_story_ship,
 * rks_cycle_complete, rks_ship, rks_staging_pr, rks_git_merge, rks_sync_staging); rks_story_ship
 * and rks_ship also read ctx.tool for their telemetry payloads. Chain-state helpers are imported
 * from shared/governor-token.mjs, per the registry contract. No ctx extension.
 */
import { z } from "zod";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { loadContext, getBranchConfig } from "../project.mjs";
import { runGitMerge, runGitPR, runStagingMerge, runRelease, runSyncStaging, runShip } from "../git-tools.mjs";
import { validateToken, advanceStateOnResult, getSession, updateChildState, advanceToNextChild } from "../../shared/governor-token.mjs";

export function registerShipHandlers({ registerHandler }, {
  cycleCompleteSchema,
  promoteSchema,
  shipSchema,
  stagingPrSchema,
  gitMergeSchema,
  stagingMergeSchema,
}) {
  registerHandler("rks_story_ship", async (cleanArgs, ctx) => {
    const tool = ctx.tool;
    const _governorToken = ctx.governorToken;
    const input = z.object({ projectId: z.string(), problemId: z.string().optional() }).parse(cleanArgs);
    const { runStoryShipTool } = await import('../story-ship.mjs');
    const result = await runStoryShipTool({ projectId: input.projectId, problemId: input.problemId });
    // backlog.fix.story-ship-result-never-advances-chain: apply the OBSERVED result to the
    // governor chain, so a failed ship returns shipping -> executed (retryable) and a real
    // delivery reaches shipped. An idempotent result observed no delivery, so it maps to
    // ship.failed. A thrown error is reverted by the outer catch (revertStateOnFailure).
    // The payload is returned unchanged.
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = (result?.ok === true && result?.idempotent !== true) ? 'ship.ok' : 'ship.failed';
      const resultTransition = advanceStateOnResult(_governorToken, resultKey);
      if (resultTransition?.transitioned) {
        try {
          getTelemetryCollector().emit('governor.state.transition', input.projectId, {
            tool, resultKey,
            from: resultTransition.previousState,
            to: resultTransition.newState,
            trigger: 'tool_result',
          });
        } catch { /* telemetry is best-effort */ }
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_cycle_complete", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = cycleCompleteSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runCycleComplete } = await import("../git-tools.mjs");
    const res = await runCycleComplete({
      projectRoot: context.record.root,
      projectId: input.projectId,
      // backlog.fix.cycle-complete-ungated-hard-reset: pass the parsed opt-in through.
      // `context.record.root` is the developer's real repository root — this handler needs no
      // misconfiguration to reach the destructive reset, which is why the gate exists.
      discardLocalCommits: input.discardLocalCommits === true
    });
    // Advance ship flow state: merging → shipped
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = res.ok ? 'cycle_complete.ok' : 'cycle_complete.error';
      advanceStateOnResult(_governorToken, resultKey);
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_promote", async (cleanArgs, ctx) => {
    const input = promoteSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const { runPromote } = await import("../git-tools.mjs");
    const res = await runPromote({
      projectRoot: context.record.root,
      projectId: input.projectId,
      from: input.from,
      to: input.to,
      push: input.push
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_ship", async (cleanArgs, ctx) => {
    const tool = ctx.tool;
    const _governorToken = ctx.governorToken;
    const input = shipSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const res = await runShip({
      projectRoot: context.record.root,
      projectId: input.projectId,
      message: input.message,
      scope: input.scope,
      type: input.type,
      files: input.files,
      // Explicit tool-layer opt-in: an OMITTED files keeps the documented all-changes behaviour;
      // files: [] is rejected (backlog.fix.git-commit-broad-add-fallback).
      stageAll: input.files === undefined,
      branchName: input.branchName,
      branchType: input.branchType,
      prTitle: input.prTitle,
      problemId: input.problemId,
    });
    // Governor state machine: advance state based on ship result
    if (_governorToken && validateToken(_governorToken)) {
      const session = getSession(_governorToken);
      const resultKey = res.ok ? 'ship.ok' : 'ship.failed';

      // Phase 3: if in child_active and ship succeeded, advance child tracking
      if (session?.state === 'child_active' && res.ok) {
        updateChildState(_governorToken, 'complete');
        const next = advanceToNextChild(_governorToken);
        if (next?.allComplete) {
          // All children done — transition to shipped
          session.state = 'shipped';
          res._governorState = { from: 'child_active', to: 'shipped' };
          res._childComplete = { allComplete: true, total: next.total };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool, resultKey: 'children.all_complete',
              from: 'child_active', to: 'shipped',
              trigger: 'child_complete',
              childrenTotal: next.total,
            });
          } catch { /* telemetry is best-effort */ }
        } else if (next) {
          // More children — stay in child_active
          res._childComplete = { nextChildId: next.childId, index: next.index, total: next.total };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool, resultKey: 'child.complete',
              from: 'child_active', to: 'child_active',
              trigger: 'child_advance',
              nextChildId: next.childId,
              childIndex: next.index,
              childrenTotal: next.total,
            });
          } catch { /* telemetry is best-effort */ }
        }
      } else {
        const resultTransition = advanceStateOnResult(_governorToken, resultKey);
        if (resultTransition?.transitioned) {
          res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool, resultKey,
              from: resultTransition.previousState,
              to: resultTransition.newState,
              trigger: 'tool_result',
            });
          } catch { /* telemetry is best-effort */ }
        }
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_staging_pr", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = stagingPrSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    // Resolve targetBranch from project config if not explicitly provided
    const branchConfig = getBranchConfig(context.record, context.projectJson);
    const targetBranch = input.targetBranch || branchConfig.integration;
    const res = await runGitPR({ projectRoot, targetBranch, ...input, autoMerge: false });
    // Advance ship flow state: committed → pr_created
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = res.ok ? 'staging_pr.ok' : 'staging_pr.error';
      advanceStateOnResult(_governorToken, resultKey);
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_git_merge", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = gitMergeSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const targetBranch = input.targetBranch || context.projectJson?.baseBranch || "staging";
    const res = await runGitMerge({ projectRoot, targetBranch, deleteBranch: input.deleteBranch });
    // Advance ship flow state: pr_created → merging
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = res.ok ? 'git_merge.ok' : 'git_merge.error';
      advanceStateOnResult(_governorToken, resultKey);
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_sync_staging", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = z.object({ projectId: z.string(), strategy: z.enum(["rebase", "merge", "auto", "push-only"]).optional() }).parse(cleanArgs);
    // backlog.fix.governed-push-ahead-only-integration-branch: a governed caller may only
    // PUBLISH (push-only). The lock keys on the PRESENCE of the raw _governorToken, not on
    // validateToken, so a present-but-invalid token (e.g. under _skipTokenValidation) still
    // fails closed to push-only. A non-push-only strategy is refused before any git call.
    if (_governorToken) {
      if (input.strategy !== undefined && input.strategy !== "push-only") {
        const refusal = {
          ok: false,
          error: "strategy_not_allowed_under_governor",
          message: `rks_sync_staging with a governor token only runs strategy 'push-only'; '${input.strategy}' was refused. No git operation was performed.`,
          requestedStrategy: input.strategy,
          allowedStrategy: "push-only",
        };
        return { content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }] };
      }
    }
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const strategy = _governorToken ? "push-only" : (input.strategy || "auto");
    const res = await runSyncStaging({ projectRoot, strategy, projectRecord: context.record, projectJson: context.projectJson });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_staging_merge", async (cleanArgs, ctx) => {
    const input = stagingMergeSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runStagingMerge({ projectRoot, prNumber: input.prNumber, problemId: input.problemId, reason: input.reason });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_release", async (cleanArgs, ctx) => {
    const input = z.object({
      projectId: z.string(),
      version: z.enum(["patch", "minor", "major"]).optional(),
      changelog: z.string().optional(),
      // enabled is z.literal(true) so the override cannot default on; reason
      // is min(1) so a traceless override is rejected rather than accepted.
      // Same shape as guardrailsOnSchema's enforcementOverride.
      enforcementOverride: z.object({
        enabled: z.literal(true),
        reason: z.string().trim().min(1, "an enforcement override must state a reason"),
      }).optional(),
    }).parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runRelease({ projectRoot, version: input.version || "patch", changelog: input.changelog, projectId: input.projectId, projectRecord: context.record, projectJson: context.projectJson, enforcementOverride: input.enforcementOverride || null });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });
}
