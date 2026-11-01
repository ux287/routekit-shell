/**
 * Planner/exec handler family (S8 of research.2026.10.05.server-mjs-safe-decomposition).
 *
 * Bodies moved verbatim from server.mjs. Handler contract: see ./registry.mjs.
 * rks_plan names its second parameter handlerCtx because its body declares a local `ctx`.
 * Pending-plan helpers stay in server.mjs and arrive as the third argument.
 */
import fs from "fs";
import path from "path";
import { execSync, spawnSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveNotesDir, readNote, updateField } from "../../dendron.mjs";
import { runAnalyzeTool, runPlanTool, findLatestRunDir } from "../planner.mjs";
import { reviewPlan, resolvedPlanIdentity, describePlanContents, isStatePreservingCall, buildPlanReviewArgs, formatPlanReviewBlockLog } from "../plan-quality.mjs";
import { runExecTool, runApplyTool, runExecAbortTool } from "../exec.mjs";
import { loadContext, simulateGuardrailPolicy, slugify, getBranchConfig, getWorkflowConfig } from "../project.mjs";
import { ensureExecStartPhase } from "../exec-start-durability.mjs";
import { LOADED_RKS_VERSION, readDiskRksVersion, checkGitReadiness, ragKeylessPreflightMessage } from "../preflight.mjs";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { validateStory } from "../story-validator-v2.mjs";
import { classifyMarkerFailure, buildPlanReviewFailureResponse } from "../failure-classification.mjs";
import { validateToken, advanceStateOnResult, getSession, setProjectRoot } from "../../shared/governor-token.mjs";
import { runRefineTool, runRefineApplyTool } from "../refine.mjs";
import { runPlanReadyTool, isPlanReadyReadOnly } from "../plan-ready.mjs";

export function registerPlannerHandlers({ registerHandler }, {
  analyzeSchema,
  planSchema,
  planReviewSchema,
  validateStorySchema,
  planReadySchema,
  execSchema,
  applySchema,
  guardrailSimSchema,
  refineSchema,
  refineApplySchema,
}, {
  pendingPlans,
  getPollHintMs,
  getPendingPlanPath,
  writePendingPlanMarker,
  isProcessAlive,
  readPendingPlanMarker,
  removePendingPlanMarker,
}) {
  registerHandler("rks_analyze", async (cleanArgs, ctx) => {
    const input = analyzeSchema.parse(cleanArgs);
    const res = await runAnalyzeTool(input);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_plan", async (cleanArgs, handlerCtx) => {
    const tool = handlerCtx.tool;
    const _governorToken = handlerCtx.governorToken;
    const input = planSchema.parse(cleanArgs);
    // Accept maxRefinements (number of refinements to attempt). Default: 2
    const maxRefinements = (cleanArgs && typeof cleanArgs.maxRefinements === "number") ? cleanArgs.maxRefinements : 2;
    input.maxRefinements = (input.maxRefinements !== undefined) ? input.maxRefinements : maxRefinements;

    // ── Pre-spawn readiness gate (backlog.fix.rks-plan.not-ready-short-circuit) ──────
    // A story that is not ready to plan must NOT spawn the detached worker (which would die
    // with worker_crashed). Reuse runPlanReadyTool — the same predicate rks_plan_ready uses —
    // as the single source of truth, and return a structured `not_ready` result instead. Only
    // applies to story-based plans (skip ad-hoc task plans with no problemId). RKS_SKIP_READINESS=1
    // bypasses the gate; a readiness-check exception is tolerated so planning is never blocked
    // by a gate error (defense-in-depth with the in-worker gate, which still catches the rest).
    if (input.problemId && process.env.RKS_SKIP_READINESS !== "1") {
      try {
        const readyCtx = await loadContext(input.projectId);
        const readiness = await runPlanReadyTool({
          projectId: input.projectId,
          problemId: input.problemId,
          projectRoot: readyCtx.record.root,
        });
        if (readiness && readiness.ready === false) {
          return { content: [{ type: "text", text: JSON.stringify({
            ok: false,
            status: "not_ready",
            projectId: input.projectId,
            problemId: input.problemId,
            issues: readiness.issues || [],
            warnings: readiness.warnings || [],
            message: "Story is not ready to plan — no worker was spawned. Resolve the issues below, then re-run rks_plan.",
            requiredNext: `rks_plan_ready { "projectId": "${input.projectId}", "problemId": "${input.problemId}" }`,
          }, null, 2) }] };
        }
      } catch { /* readiness check failed — do not block; let planning proceed */ }
    }

    // ── Async plan: kick off in background, return immediately ──────
    // The MCP SDK has a 60-second client-side request timeout.
    // runPlanTool makes LLM calls that take > 60s, causing "Connection closed".
    // Solution: start planning in background, return a ticket, poll via rks_plan_review.
    //
    // Sync fallback: when RKS_SKIP_LLM=1 or RKS_SKIP_PREFLIGHT=1 (test/CI),
    // the LLM call is skipped and the whole operation is fast — run synchronously.
    const _syncPlan = process.env.RKS_SKIP_LLM === "1" || process.env.RKS_SKIP_PREFLIGHT === "1";

    if (_syncPlan) {
      // Synchronous path for tests/CI
      const res = await runPlanTool(input);
      // Commit the phase change that runPlanTool already wrote to disk.
      // Do NOT call advancePhase — runPlanTool handles phase advancement internally.
      if (res.ok && res.problemId) {
        try {
          const context = await loadContext(input.projectId);
          execSync(`git add notes/${res.problemId}.md && git commit -m "chore(backlog): advance ${res.problemId} to planned"`, {
            cwd: context.record.root, stdio: "pipe"
          });
          res.phaseCommitted = true;
        } catch { /* Non-fatal: runPlanTool may have already committed */ }
      }
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'plan.ok' : 'plan.failed';
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
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    // Async path for production — detached child process
    // The MCP server process can be killed/restarted by Claude Code during
    // Task agent lifecycle. A background Promise would die with the server.
    // Instead, spawn a detached worker process that survives server restarts
    // and writes results to disk. plan_review checks disk + worker liveness.
    const planKey = `${input.projectId}:${input.problemId || input.task || "plan"}`;
    const startedAt = Date.now();

    const ctx = await loadContext(input.projectId);

    // Write plan params to temp file for the worker to read
    const paramsFile = path.join(ctx.record.root, ".rks", `plan-params-${startedAt}.json`);
    const markerPath = getPendingPlanPath(ctx.record.root);
    try {
      const dir = path.dirname(paramsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(paramsFile, JSON.stringify({
        input,
        _markerPath: markerPath,
      }, null, 2));
    } catch (err) {
      throw new McpError(ErrorCode.InternalError, `Failed to write plan params: ${err.message}`);
    }

    // Spawn detached worker
    const workerScript = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', 'bin', 'plan-worker.mjs'
    );
    // Capture the worker's stderr. It was `'ignore'`, so every `[planner]` and
    // `[plan-worker]` diagnostic was discarded by the OS — including the one line
    // that would have explained a silent phase-write failure. That turned a
    // deterministic bug into a multi-session investigation.
    //
    // The run folder does not exist yet at spawn time, so the log is keyed by
    // startedAt under a stable directory. Failure to open it must NEVER stop a
    // plan: fall back to 'ignore' and carry on.
    const workerLogPath = path.join(ctx.record.root, '.rks', 'plan-logs', `${startedAt}.log`);
    let workerLogFd = null;
    try {
      fs.mkdirSync(path.dirname(workerLogPath), { recursive: true });
      workerLogFd = fs.openSync(workerLogPath, 'a');
    } catch (err) {
      console.error(`[rks.plan] worker log unavailable (${err?.message}); continuing without capture`);
      workerLogFd = null;
    }

    const child = spawn('node', [workerScript, paramsFile], {
      detached: true,
      stdio: ['ignore', 'ignore', workerLogFd ?? 'ignore'],
      // The worker resolves its project root from this env var; pass the planned
      // project's root so a child is never resolved to the install dir.
      env: { ...process.env, ROUTEKIT_PROJECT_ROOT: ctx.record.root },
      cwd: ctx.record.root,
    });
    // The child holds its own dup of the fd; the parent's copy is dead weight.
    if (workerLogFd !== null) { try { fs.closeSync(workerLogFd); } catch { /* best-effort */ } }

    // Guard: spawn failure
    if (!child.pid) {
      try { fs.unlinkSync(paramsFile); } catch { /* best-effort */ }
      throw new McpError(ErrorCode.InternalError, "Failed to spawn plan worker process");
    }

    // Brief error listener before unref (catches async spawn errors)
    child.on('error', (err) => {
      try {
        if (fs.existsSync(markerPath)) {
          const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
          fs.writeFileSync(markerPath, JSON.stringify({
            ...marker, done: true, ok: false,
            error: `Worker spawn error: ${err.message}`,
            completedAt: Date.now(),
          }, null, 2));
        }
      } catch { /* best-effort */ }
    });
    child.unref();

    // Write marker with WORKER PID (not server PID)
    writePendingPlanMarker(ctx.record.root, {
      planKey, projectId: input.projectId, problemId: input.problemId,
      startedAt, pid: child.pid, workerLogPath: workerLogFd !== null ? workerLogPath : null,
    });

    return { content: [{ type: "text", text: JSON.stringify({
      ok: true,
      status: "planning",
      planKey,
      workerPid: child.pid,
      projectId: input.projectId,
      problemId: input.problemId || null,
      message: "Plan generation started in detached worker. Poll with rks_plan_review to get the result.",
      requiredNext: `rks_plan_review { "projectId": "${input.projectId}" }`,
    }, null, 2) }] };
  });

  registerHandler("rks_plan_review", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = planReviewSchema.parse(cleanArgs);

    // ── Check for pending async plan ────────────────────────────────
    // Find any pending plan for this project (by projectId prefix match).
    let pendingEntry = null;
    let pendingKey = null;
    for (const [key, val] of pendingPlans) {
      if (key.startsWith(input.projectId + ":")) {
        pendingEntry = val;
        pendingKey = key;
        break;
      }
    }

    // If no in-memory entry, check disk marker (detached worker or legacy server)
    if (!pendingEntry) {
      try {
        const ctx = await loadContext(input.projectId);
        const marker = readPendingPlanMarker(ctx.record.root);
        if (marker && marker.projectId === input.projectId) {
          const elapsed = Math.round((Date.now() - marker.startedAt) / 1000);

          // Case 1: Worker explicitly signaled completion (done flag)
          if (marker.done === true && marker.ok === true) {
            // PARENT-SIDE DURABILITY NET. The planner runs in a DETACHED worker whose
            // stderr we only started capturing today; if its arch-approved → executing
            // write failed there, nothing surfaced it — rks_exec then refused the story
            // forever, and rks_plan_ready's stale-executing self-heal undid any hand-set
            // value. Land the transition here, in the server's own known-good context,
            // and VERIFY it on disk rather than trusting a return value.
            // Idempotent: a worker that already landed it makes this a no-op.
            if (marker.problemId) {
              const phaseRes = await ensureExecStartPhase({
                projectRoot: ctx.record.root,
                problemId: marker.problemId,
                projectId: input.projectId,
                allowNoopWhenExecuting: true,
              });
              if (!phaseRes.ok) {
                removePendingPlanMarker(ctx.record.root);
                return { content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "phase_write_failed",
                  projectId: input.projectId,
                  problemId: marker.problemId,
                  phaseWrite: {
                    attempted: phaseRes.attempted, from: phaseRes.from ?? null,
                    to: phaseRes.to, observed: phaseRes.observed ?? null, error: phaseRes.error,
                  },
                  workerPhaseWrite: marker.phaseWrite ?? null,
                  workerLogPath: marker.workerLogPath ?? null,
                  message: `Plan completed and is on disk, but the story phase could not be advanced to 'executing': ${phaseRes.error}. rks_exec will refuse this story until that is resolved.`,
                }, null, 2) }] };
              }
            }
            // Plan completed — remove marker and fall through to disk review path
            removePendingPlanMarker(ctx.record.root);
            // (falls through to disk review below)
          } else if (marker.done === true && marker.ok === false) {
            // Plan failed — remove marker and return failure
            removePendingPlanMarker(ctx.record.root);
            if (_governorToken && validateToken(_governorToken)) {
              advanceStateOnResult(_governorToken, 'plan.failed');
            }
            // Propagate structured error context from marker (readiness issues,
            // workflow hints) so the Governor can act on them (e.g., loop back to refine).
            // F3: classify the failure so the operator learns WHY, not just THAT, it failed.
            //   worker_crashed   — uncaught worker exception (marker.failureClass stamped)
            //   story_unplannable — create_file_complexity / AC-cap reject
            //   output_invalid    — note_only / has_note_steps / quality_failed
            // `reason` is the discriminator within the shared "refinement_required" status.
            // SSOT: the classifier and its operator message live in
            // server/failure-classification.mjs. This site previously re-derived the class
            // inline AND had no `structural` message branch, so a structural marker — which
            // DOES carry a stamped class — fell through to the worker-crashed message and
            // told the operator to re-run a plan that deterministically cannot succeed.
            // The payload (incl. uncoveredTargets / droppedSteps / workerLogPath and a
            // reason-matched message) is built by a pure helper so it is testable.
            const failureResponse = buildPlanReviewFailureResponse(marker, elapsed, classifyMarkerFailure(marker));
            return { content: [{ type: "text", text: JSON.stringify(failureResponse, null, 2) }] };
          }
          // Case 2: Worker still alive (no done flag yet)
          else if (marker.pid && isProcessAlive(marker.pid)) {
            const pollHintMs = getPollHintMs(elapsed);
            return { content: [{ type: "text", text: JSON.stringify({
              ok: true,
              status: "planning",
              elapsedSeconds: elapsed,
              workerPid: marker.pid,
              recommendedNextPollMs: pollHintMs,
              message: `Plan is still generating (${elapsed}s elapsed). Poll again in ~${pollHintMs / 1000}s.`,
            }, null, 2) }] };
          }
          // Case 3: No done flag + worker dead — check disk for plan.json
          else {
            const slug = input.label ? slugify(input.label) : (input.problemId ? slugify(input.problemId) : null);
            const runDir = findLatestRunDir(ctx.record.root, slug);
            const planPath = runDir ? path.join(runDir, "plan.json") : null;
            if (planPath && fs.existsSync(planPath)) {
              // Plan completed on disk — remove marker and fall through
              removePendingPlanMarker(ctx.record.root);
            } else {
              // Worker is dead and no plan.json — orphaned
              removePendingPlanMarker(ctx.record.root);
              if (_governorToken && validateToken(_governorToken)) {
                advanceStateOnResult(_governorToken, 'plan.failed');
              }
              return { content: [{ type: "text", text: JSON.stringify({
                ok: false,
                status: "failed",
                elapsedSeconds: elapsed,
                orphanedPlan: true,
                message: `Plan worker (pid: ${marker.pid || 'unknown'}) died without completing. Re-run rks_plan.`,
              }, null, 2) }] };
            }
          }
        }
      } catch { /* best-effort — fall through to disk review */ }
    }

    if (pendingEntry && !pendingEntry.done) {
      // Plan still running — tell caller to poll again
      const elapsed = Math.round((Date.now() - pendingEntry.startedAt) / 1000);
      const pollHintMs = getPollHintMs(elapsed);
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        status: "planning",
        elapsedSeconds: elapsed,
        recommendedNextPollMs: pollHintMs,
        message: `Plan is still generating (${elapsed}s elapsed). Poll again in ~${pollHintMs / 1000}s.`,
      }, null, 2) }] };
    }

    if (pendingEntry?.done) {
      // Plan completed — return result and clean up
      pendingPlans.delete(pendingKey);

      if (pendingEntry.error) {
        // Governor state: plan.failed
        if (_governorToken && validateToken(_governorToken)) {
          const resultTransition = advanceStateOnResult(_governorToken, 'plan.failed');
          if (resultTransition?.transitioned) {
            try {
              getTelemetryCollector().emit('governor.state.transition', input.projectId, {
                tool: 'rks_plan', resultKey: 'plan.failed',
                from: resultTransition.previousState,
                to: resultTransition.newState,
                trigger: 'tool_result',
              });
            } catch { /* telemetry is best-effort */ }
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({
          ok: false,
          status: "failed",
          error: pendingEntry.error,
          message: "Plan generation failed",
        }, null, 2) }] };
      }

      const res = pendingEntry.result;
      // Governor state: plan.ok or plan.failed based on result
      if (_governorToken && validateToken(_governorToken)) {
        const resultKey = res.ok ? 'plan.ok' : 'plan.failed';
        const resultTransition = advanceStateOnResult(_governorToken, resultKey);
        if (resultTransition?.transitioned) {
          res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
          try {
            getTelemetryCollector().emit('governor.state.transition', input.projectId, {
              tool: 'rks_plan', resultKey,
              from: resultTransition.previousState,
              to: resultTransition.newState,
              trigger: 'tool_result',
            });
          } catch { /* telemetry is best-effort */ }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    // ── No pending plan — review plan from disk ──
    // This path handles two cases:
    //   1. Direct plan_review call (no async plan was started)
    //   2. Server restarted after async plan completed (pendingPlans lost)
    // In case 2, the plan result is on disk and the session was rehydrated.
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    // Set project root for session persistence (may not have been set if server restarted)
    setProjectRoot(projectRoot);
    // Derive slug from label or problemId (problemId uses same slugify as planner.mjs:1266)
    const slug = input.label ? slugify(input.label) : (input.problemId ? slugify(input.problemId) : null);
    const runDir = findLatestRunDir(projectRoot, slug);
    if (!runDir) {
      // Transition governor state to plan.failed so it's not stuck in 'planning'
      if (_governorToken && validateToken(_governorToken)) {
        advanceStateOnResult(_governorToken, 'plan.failed');
      }
      const hint = slug
        ? `No plan found for '${slug}'. The plan may not have completed — re-run rks_plan.`
        : "No plans found. Run rks_plan first.";
      throw new McpError(ErrorCode.InvalidParams, hint);
    }
    const planPath = path.join(runDir, "plan.json");
    if (!fs.existsSync(planPath)) {
      // Transition governor state to plan.failed so it's not stuck in 'planning'
      if (_governorToken && validateToken(_governorToken)) {
        advanceStateOnResult(_governorToken, 'plan.failed');
      }
      throw new McpError(ErrorCode.InvalidParams,
        `Plan generation was interrupted (no plan.json in ${path.basename(runDir)}). Re-run rks_plan.`);
    }
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    // Read the story's declared targetFiles up front so reviewPlan can validate target
    // coverage (backlog.fix.plan-review-validates-target-coverage). Best-effort: a plan
    // missing a covering step for any declared target (esp. op:create) is rejected; if the
    // note can't be read, the coverage check no-ops.
    let reviewTargetFiles;
    // backlog.fix.plan-review-per-file-block-count-shortfall: note0 and the read error are
    // hoisted so the story body reaches reviewPlan's authored-block check, and an unreadable
    // note with a problemId is recorded as a skip rather than looking like a label-only call.
    let note0 = null;
    let noteReadError = null;
    if (input.problemId) {
      try {
        note0 = readNote(resolveNotesDir(projectRoot), input.problemId);
        reviewTargetFiles = note0?.targetFiles;
      } catch (err) { noteReadError = err; /* coverage check no-ops without targetFiles */ }
    }
    const review = await reviewPlan(buildPlanReviewArgs({
      projectRoot, plan, note: note0, targetFiles: reviewTargetFiles,
      problemId: input.problemId || null, noteReadError,
    }));
    const blockLogLine = formatPlanReviewBlockLog({
      problemId: input.problemId || null,
      unplannedBlocks: review.unplannedBlocks,
      unattributedBlocks: review.unattributedBlocks,
      authoredBlockCheckSkipped: review.authoredBlockCheckSkipped,
    });
    if (blockLogLine) console.error(blockLogLine);

    // backlog.fix.planned-state-plan-contents-disclosure: say WHICH plan this is and WHAT it
    // will do. Strictly additive — no existing field is changed — and attached regardless of
    // review.ok, because a caller debugging a failing review needs the identity just as much.
    review.resolved = resolvedPlanIdentity({
      planPath, runDir, slug,
      problemId: input.problemId || null,
      identifiedBy: input.label ? 'label' : (input.problemId ? 'problemId' : 'latest'),
    });
    review.plan = describePlanContents(plan);

    // Advance governor state if a valid token is present (handles server restart recovery)
    if (_governorToken && validateToken(_governorToken)) {
      const resultKey = review.ok ? 'plan.ok' : 'plan.failed';
      const resultTransition = advanceStateOnResult(_governorToken, resultKey);
      if (resultTransition?.transitioned) {
        review._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
        try {
          getTelemetryCollector().emit('governor.state.transition', input.projectId, {
            tool: 'rks_plan', resultKey,
            from: resultTransition.previousState,
            to: resultTransition.newState,
            trigger: 'tool_result_disk_recovery',
          });
        } catch { /* telemetry is best-effort */ }
      }
    }

    // Advance story phase to "planned" if review passed and phase is still "ready"
    // This is the safety net for when the plan worker's phase commit failed
    if (review.ok && input.problemId) {
      try {
        const notesDir = resolveNotesDir(projectRoot);
        const note = readNote(notesDir, input.problemId);
        if (note.phase === 'ready') {
          updateField(notesDir, input.problemId, "phase", "planned");
          // Scoped auto-commit of just the note file
          const noteRelPath = `notes/${input.problemId}.md`;
          spawnSync("git", ["add", noteRelPath], { cwd: projectRoot, encoding: "utf8" });
          const commitMsg = `docs(backlog): mark ${input.problemId} as planned`;
          const commitResult = spawnSync("git", ["commit", "-m", commitMsg], { cwd: projectRoot, encoding: "utf8" });
          if (commitResult.status === 0) {
            console.error(`[rks.plan_review] auto-committed phase change for ${input.problemId}`);
          }
          getTelemetryCollector().emit("story.phase.changed", input.projectId, {
            storyId: input.problemId,
            from: "ready",
            to: "planned",
            reason: "plan_review_safety_net",
          });
        }
      } catch (phaseErr) {
        console.error(`[rks.plan_review] phase advancement failed: ${phaseErr?.message}`);
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(review, null, 2) }] };
  });

  registerHandler("rks_preflight", async (cleanArgs, ctx) => {
    const input = z.object({ projectId: z.string() }).parse(cleanArgs);
    const checks = [];

    // Check 1: Project attached
    let record = null;
    let projectJson = null;
    try {
      const context = await loadContext(input.projectId);
      record = context.record;
      projectJson = context.projectJson;
    } catch (e) {
      // Project not found - record stays null
    }
    checks.push({
      name: "project_attached",
      passed: !!record,
      hint: record ? null : "Run rks_init first"
    });

    // Check 2: Notes directory
    const notesDir = record ? path.join(record.root, "notes") : null;
    const notesExist = notesDir && fs.existsSync(notesDir);
    checks.push({
      name: "notes_directory",
      passed: !!notesExist,
      hint: notesExist ? null : "Create notes/ directory"
    });

    // Check 3: RAG initialized
    const ragPath = record ? path.join(record.root, ".rks/rag") : null;
    const ragExists = ragPath && fs.existsSync(ragPath);
    checks.push({
      name: "rag_initialized",
      passed: !!ragExists,
      hint: ragExists ? null : "Run rks_rag_embed to initialize RAG index"
    });

    // Check 4: API key. When the RAG index is present but no key is set, retrieval is still
    // fully usable (keyless local embedder + LanceDB) — only answer synthesis and governed
    // workflows need the key. Say so via the shared keyless-messaging seam, rather than the bare
    // "set your key" hint implying RAG is dead. (Decision is pure/unit-drivable in preflight.mjs.)
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const keyless = ragKeylessPreflightMessage({ ragInitialized: !!ragExists, hasApiKey });
    checks.push({
      name: "api_key",
      passed: hasApiKey,
      detail: keyless.message,
      hint: hasApiKey ? null : (keyless.hint || "Set ANTHROPIC_API_KEY in .env")
    });

    // Check 5: git readiness — validity, not mere presence. Validates that
    // origin is real (not a YOUR-ORG/YOUR-REPO placeholder) AND reachable, that
    // the configured working branch is checked out, and that a baseline commit
    // exists. Previously this passed on ANY non-empty `git remote get-url origin`,
    // so a fresh project with a placeholder remote and no branch/baseline read
    // GREEN while build/ship/push would fail (the 2026-06-22 UAT false-green).
    if (record) {
      for (const c of checkGitReadiness({ projectRoot: record.root, projectJson })) {
        checks.push(c);
      }
    } else {
      checks.push({
        name: "github_remote",
        passed: false,
        detail: null,
        hint: "Project not attached — run rks_init first",
      });
    }

    const allPassed = checks.every(c => c.passed);

    // Build workflow info from branch topology config
    let workflowInfo = null;
    if (record) {
      const branchConfig = getBranchConfig(record, projectJson);
      const workflowConfig = getWorkflowConfig(record, projectJson);
      const isCustomWorkflow = branchConfig.working !== branchConfig.integration;

      workflowInfo = {
        workingBranch: branchConfig.working,
        integrationBranch: branchConfig.integration,
        productionBranch: branchConfig.production,
        workflow: isCustomWorkflow
          ? "plan → exec → promote → ship"
          : "plan → exec → ship",
        notes: []
      };

      if (workflowConfig.workingBranchLocal) {
        workflowInfo.notes.push(`Working branch (${branchConfig.working}) is local-only`);
      }
      if (!workflowConfig.autoMergeIntegration) {
        workflowInfo.notes.push("Auto-merge disabled: call rks_promote from an ops Governor session (/ops skill) to control when builds trigger");
      }
      if (isCustomWorkflow) {
        workflowInfo.notes.push(`Use rks_promote from an ops Governor session (/ops skill) to merge ${branchConfig.working} → ${branchConfig.integration}`);
      }
    }

    // backlog.fix.clean-machine-honesty: report the version we are RUNNING (module-load), beside the
    // version on DISK. This line used to call readRksVersion(), which re-read package.json — so it
    // announced the disk version next to a checks array produced by whatever code Node had loaded
    // at startup. After a `git checkout <newtag>` without a server restart, those are different
    // builds, and the field was confidently naming the wrong one.
    return { content: [{ type: "text", text: JSON.stringify({ ok: allPassed, rksVersion: LOADED_RKS_VERSION, diskRksVersion: readDiskRksVersion(), checks, workflowInfo }, null, 2) }] };
  });

  registerHandler("rks_validate_story", async (cleanArgs, ctx) => {
    const input = validateStorySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const result = await validateStory({ projectId: input.projectId, problemId: input.problemId, projectRoot: context.record.root });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_plan_ready", async (cleanArgs, ctx) => {
    const _governorToken = ctx.governorToken;
    const input = planReadySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    // backlog.fix.governor-state-tool-admission-gaps: a non-story caller (open/qa/ship/ops
    // flow) gets the read-only probe — no stale-executing phase write. No token or an
    // invalid token yields session = null and keeps the default healing path.
    const session = _governorToken && validateToken(_governorToken) ? getSession(_governorToken) : null;
    const result = await runPlanReadyTool({
      projectId: input.projectId,
      problemId: input.problemId,
      projectRoot,
      readOnly: isPlanReadyReadOnly(session),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  registerHandler("rks_exec", async (cleanArgs, ctx) => {
    const tool = ctx.tool;
    const _governorToken = ctx.governorToken;
    const input = execSchema.parse(cleanArgs);
    let res;
    try {
      res = await runExecTool(input);
    } catch (err) {
      // If exec throws before touching any files (e.g. note-step gate, pre-exec validation),
      // roll chain state back to refining (phase is reset to arch-approved) so rks_plan / rks_plan_ready / rks_exec_abort are accessible.
      if (_governorToken && validateToken(_governorToken)) {
        const isPreExecRejection = err instanceof McpError && err.message?.includes('note step');
        const resultKey = isPreExecRejection ? 'exec.no_actions' : 'exec.error';
        advanceStateOnResult(_governorToken, resultKey);
      }
      throw err;  // re-throw so MCP framework surfaces the error to the caller
    }
    // Governor state machine: advance state based on exec result.
    //
    // backlog.fix.planned-state-plan-contents-disclosure: a DRY RUN must not move the chain
    // on this path either. A dry run returns ok:true, so without this guard resultKey is
    // 'exec.ok' and the session advances exactly as if the plan had been applied — leaving
    // the entry-transition guard above a half-fix that silently did nothing.
    if (_governorToken && validateToken(_governorToken) && !isStatePreservingCall(tool, cleanArgs)) {
      const resultKey = res.ok ? 'exec.ok' : 'exec.failed';
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
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_exec_abort", async (cleanArgs, ctx) => {
    const res = await runExecAbortTool(cleanArgs);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_apply", async (cleanArgs, ctx) => {
    const input = applySchema.parse(cleanArgs);
    const res = await runApplyTool(input);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_guardrails_simulate", async (cleanArgs, ctx) => {
    const input = guardrailSimSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const result = simulateGuardrailPolicy(projectRoot, input.label || "");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  registerHandler("rks_approve", async (cleanArgs, ctx) => {
    const projectId = cleanArgs?.projectId || ctx.args?.projectId;
    const planId = cleanArgs?.planId || ctx.args?.planId;
    const confirm = (cleanArgs?.confirm !== undefined) ? cleanArgs.confirm : ctx.args?.confirm;
    const reason = cleanArgs?.reason || ctx.args?.reason;
    if (!projectId || !planId || typeof confirm !== "boolean") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "rks_approve: required params projectId, planId, confirm"
      );
    }
    const context = await loadContext(projectId);
    const { approve } = await import("../approve.mjs");
    const res = await approve({
      projectRoot: context.record.root,
      planId,
      confirm,
      reason,
    });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_story_create", async (cleanArgs, ctx) => {
    const STORY_TEMPLATES = {
      "react-component": {
        targetFiles: [
          { path: "src/components/${name}.tsx", op: "create", desc: "${name} component" },
          { path: "src/components/${name}.test.tsx", op: "create", desc: "${name} unit tests" },
        ],
        content: `## Problem

Describe what problem this component solves.

## Goal

A reusable \${name} component that...

## Target Files

- src/components/\${name}.tsx
- src/components/\${name}.test.tsx

## Acceptance Criteria

- [ ] Component renders correctly
- [ ] Props are properly typed
- [ ] Unit tests cover main scenarios
- [ ] Accessibility considerations addressed`
      },
      "api-endpoint": {
        targetFiles: [
          { path: "src/api/${name}.ts", op: "create", desc: "${name} API endpoint" },
          { path: "src/api/${name}.test.ts", op: "create", desc: "${name} integration tests" },
        ],
        content: `## Problem

Describe the API need.

## Goal

A RESTful endpoint for \${name} operations.

## Target Files

- src/api/\${name}.ts
- src/api/\${name}.test.ts

## Acceptance Criteria

- [ ] Endpoint handles GET/POST/PUT/DELETE as needed
- [ ] Input validation implemented
- [ ] Error responses follow API conventions
- [ ] Integration tests verify behavior`
      },
      "cli-command": {
        targetFiles: [
          { path: "packages/cli/src/commands/${name}.mjs", op: "create", desc: "${name} CLI command" },
        ],
        content: `## Problem

Describe the CLI need.

## Goal

A CLI command \`rks \${name}\` that...

## Target Files

- packages/cli/src/commands/\${name}.mjs

## Acceptance Criteria

- [ ] Command registered in CLI
- [ ] Help text describes usage
- [ ] Options/flags implemented
- [ ] Error handling for invalid inputs`
      }
    };

    const input = z.object({
      projectId: z.string(),
      name: z.string(),
      title: z.string().optional(),
      desc: z.string().optional(),
      template: z.string().optional(),
    }).parse(cleanArgs);

    const context = await loadContext(input.projectId);
    const notesDir = path.join(context.record.root, "notes");

    // Build filename
    const filename = `backlog.feat.${input.name}`;
    const notePath = path.join(notesDir, `${filename}.md`);

    if (fs.existsSync(notePath)) {
      throw new McpError(ErrorCode.InvalidRequest, `Story already exists: ${filename}`);
    }

    // Get template or use default
    const template = input.template ? STORY_TEMPLATES[input.template] : null;

    // Substitute variables in template
    const substitute = (str) => str.replace(/\$\{name\}/g, input.name);
    const substituteTarget = (t) => typeof t === 'object' ? { ...t, path: substitute(t.path), desc: substitute(t.desc) } : substitute(t);

    // Build frontmatter
    const frontmatter = {
      id: filename,
      title: input.title || `Add ${input.name}`,
      desc: input.desc || `Story for ${input.name}`,
      created: Date.now(),
      updated: Date.now(),
      status: "not-implemented",
      targetFiles: template ? template.targetFiles.map(substituteTarget) : [],
      phase: "draft",
    };

    // Build body content
    let body = template ? substitute(template.content) : `## Problem

Describe the problem clearly and concisely.

## Goal

Describe the desired outcome.

## Target Files

- (add target files)

## Acceptance Criteria

- [ ] (clear, testable criteria)`;

    // Write the note
    const content = `---
${Object.entries(frontmatter).map(([k, v]) => {
        if (Array.isArray(v)) {
          if (v.length === 0) return `${k}:`;
          if (typeof v[0] === 'object') {
            return `${k}:\n${v.map(item => {
              return Object.entries(item).map(([ik, iv], idx) =>
                `  ${idx === 0 ? '- ' : '  '}${ik}: "${iv}"`
              ).join('\n');
            }).join('\n')}`;
          }
          return `${k}:\n${v.map(item => `  - "${item}"`).join('\n')}`;
        }
        return `${k}: ${typeof v === 'string' ? `"${v}"` : v}`;
      }).join('\n')}
---

${body}
`;
    fs.writeFileSync(notePath, content, "utf8");

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          filename,
          path: path.relative(context.record.root, notePath),
          template: input.template || null,
          targetFiles: frontmatter.targetFiles,
        }, null, 2),
      }],
    };
  });

  registerHandler("rks_refine", async (cleanArgs, ctx) => {
    const input = refineSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runRefineTool({ projectRoot, ...input });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_refine_apply", async (cleanArgs, ctx) => {
    const tool = ctx.tool;
    const _governorToken = ctx.governorToken;
    const input = refineApplySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await runRefineApplyTool({ projectRoot, ...input });
    // Phase 3: detect decomposition and update governor state
    if (_governorToken && validateToken(_governorToken) && res.decomposed) {
      // Transition to decomposing state
      const resultTransition = advanceStateOnResult(_governorToken, 'refine_apply.decomposed');
      if (resultTransition?.transitioned) {
        res._governorState = { from: resultTransition.previousState, to: resultTransition.newState };
        try {
          getTelemetryCollector().emit('governor.state.transition', input.projectId, {
            tool, resultKey: 'refine_apply.decomposed',
            from: resultTransition.previousState,
            to: resultTransition.newState,
            trigger: 'decompose',
            childCount: res.children?.length || 0,
          });
        } catch { /* telemetry is best-effort */ }
      }
      // Set up child queue if children were created
      if (res.children?.length) {
        const { setChildQueue } = await import("../../shared/governor-token.mjs");
        setChildQueue(_governorToken, res.children);
      }
    }

    // backlog.fix.build-governor-self-heal: EMIT THE ESCALATION.
    //
    // `advanceStateOnResult` was reachable ONLY on `res.decomposed`, so a refine that changed
    // nothing never emitted a result key at all — and the state machine's `refine_apply.noop`
    // entry would have been unreachable dead code no matter where we put it. The signal has to
    // actually be sent, or the Governor stays in `refining` and re-plans forever.
    // backlog.fix.refine-inapplicable-status: a DISTINCT key for the new status.
    // Emitting 'refine_apply.noop' for it would increment the consecutive-no-op
    // streak; emitting nothing at all would leave the streak neither incremented
    // NOR cleared, so a later genuine no-op would still count as the second. The
    // reset branch in governor-token.mjs fires on any key that is not
    // 'refine_apply.noop', which is what makes a distinct key sufficient here.
    if (_governorToken && validateToken(_governorToken)
        && (res.status === "refine_noop" || res.status === "refine_inapplicable")) {
      const resultKeyForStatus = res.status === "refine_inapplicable"
        ? 'refine_apply.inapplicable'
        : 'refine_apply.noop';
      const resultTransition = advanceStateOnResult(_governorToken, resultKeyForStatus);
      // backlog.fix.refine-noop-escalation-false-positive: this used to be gated on
      // `resultTransition?.transitioned`, which suppressed BOTH the response field and the
      // telemetry emit whenever state did not change. A first no-op now deliberately SELF-LOOPS
      // (refining -> refining), so `transitioned` is false on exactly the case a caller most
      // needs to see — the counter ticked, the run continues, and nothing was reported. Report
      // on any non-null result instead; `transitioned` is still surfaced so a caller can tell a
      // self-loop from a real move. Scoped to this block only: the other advanceStateOnResult
      // call sites in this file keep their original guard.
      if (resultTransition) {
        res._governorState = {
          from: resultTransition.previousState,
          to: resultTransition.newState,
          transitioned: resultTransition.transitioned,
          // The key that actually drove the table lookup. On a repeat this is
          // 'refine_apply.noop_repeated', so the response cannot claim the wrong key.
          resultKey: resultTransition.effectiveResultKey,
        };
        try {
          getTelemetryCollector().emit('governor.state.transition', input.projectId, {
            tool, resultKey: resultTransition.effectiveResultKey,
            from: resultTransition.previousState,
            to: resultTransition.newState,
            transitioned: resultTransition.transitioned,
            trigger: res.status,
          });
        } catch { /* telemetry is best-effort */ }
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_ready", async (cleanArgs, ctx) => {
    const rksReadySchema = z.object({
      projectId: z.string(),
      problemId: z.string(),
    });
    const input = rksReadySchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const { runRksReadyTool } = await import("../refine.mjs");
    const res = await runRksReadyTool({ projectRoot, problemId: input.problemId, projectId: input.projectId });
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_review", async (cleanArgs, ctx) => {
    const input = z.object({
      projectId: z.string(),
      problemId: z.string().optional(),
      targetBranch: z.string().optional(),
    }).parse(cleanArgs);
    const { runReview } = await import('../review.mjs');
    const result = await runReview({
      projectId: input.projectId,
      problemId: input.problemId,
      targetBranch: input.targetBranch || 'staging',
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
