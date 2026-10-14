/**
 * Governance handler family (S9b of research.2026.10.05.server-mjs-safe-decomposition).
 *
 * Bodies moved verbatim from server.mjs. Handler contract: see ./registry.mjs. No body reads ctx.
 * The seven schema consts arrive as the second argument. getDendronContext, assertNotesDir,
 * notePathFromFilename, commitDendronWriteResult and reconcileActiveScopeOnInit stay defined in
 * server.mjs and arrive as the third.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  resolveNotesDir,
  readNoteRaw,
  writeNoteRaw,
  formatWithFrontmatter,
  parseFrontmatter,
  canonicalIdFromFilename,
} from "../../dendron.mjs";
import { splitNoteFrontmatter, spliceNoteFrontmatter } from "../../shared/frontmatter.mjs";
import { getCurrentBranch } from "../exec.mjs";
import { loadContext, getBranchConfig } from "../project.mjs";
import { runGitCheckout } from "../git-tools.mjs";
import { guardrailsOff, guardrailsOn, guardrailsAbort, getSessionHistory, commitAndPushNote } from "../guardrails-audit.mjs";
import { repairPhaseToIntegrated } from "../../workflow/auto-phase.mjs";
import { coAuthorTrailer, CO_AUTHOR_REJECTED_WARNING } from "../../shared/commit-attribution.mjs";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { TOOL_NAME as GOVERNOR_INIT_TOOL, handleGovernorInit } from "../../tools/governor-init.mjs";
import { TOOL_NAME as ARCH_VERDICT_TOOL, computeArchVerdict, noteSubjectDigest, noteLegacySubjectDigest, ARCH_MAX_ROUNDS } from "../../workflow/arch-verdict.mjs";
import { setProjectRoot, detectOrphanedGuardrails } from "../../shared/governor-token.mjs";
import { findCreateTargetNoAuthorableBlockIssues } from "../plan-ready.mjs";

export function registerGovernanceHandlers({ registerHandler }, {
  guardrailsOffSchema,
  guardrailsOnSchema,
  guardrailsAbortSchema,
  guardrailsStatusSchema,
  phaseRepairSchema,
  archVerdictSchema,
  governorInitSchema,
}, {
  getDendronContext,
  assertNotesDir,
  notePathFromFilename,
  commitDendronWriteResult,
  reconcileActiveScopeOnInit,
}) {
  registerHandler("rks_guardrails_off", async (cleanArgs, ctx) => {
    const input = guardrailsOffSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await guardrailsOff(projectRoot, input.reason, input.scope || "all", input.problemId, input.projectId);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_guardrails_on", async (cleanArgs, ctx) => {
    const input = guardrailsOnSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await guardrailsOn(
      projectRoot,
      {
        ...(input.enforcementOverride ? { enforcementOverride: input.enforcementOverride } : {}),
        ...(input.coAuthor ? { coAuthor: input.coAuthor } : {}),
        ...(input.restoreFromTemplate === true ? { restoreFromTemplate: true } : {}),
      },
      input.projectId,
    );
    // ARCH R9: report a rejected coAuthor; never refuse here, a refusal would leave guardrails off.
    if (input.coAuthor !== undefined && coAuthorTrailer(input.coAuthor) === "") {
      console.error(CO_AUTHOR_REJECTED_WARNING);
      return { content: [{ type: "text", text: JSON.stringify({ ...res, coAuthorRejected: true, coAuthorWarning: CO_AUTHOR_REJECTED_WARNING }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_guardrails_abort", async (cleanArgs, ctx) => {
    const input = guardrailsAbortSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = await guardrailsAbort(projectRoot, { discardPreExisting: input.discardPreExisting === true }, input.projectId);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_guardrails_status", async (cleanArgs, ctx) => {
    const input = guardrailsStatusSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const res = getSessionHistory(projectRoot, input.limit || 10);
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  registerHandler("rks_phase_repair", async (cleanArgs, ctx) => {
    const input = phaseRepairSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    // The integration branch is where a shipped story's commit must be reachable FROM. Taken
    // from branch topology rather than assumed, so a 2-branch project and a 3-branch project
    // are both answered against their own integration branch.
    const branchConfig = getBranchConfig(context.record, context.projectJson);
    const res = await repairPhaseToIntegrated(projectRoot, input.storyId, input.projectId, {
      integrationBranch: branchConfig.integration,
    });
    // Persist the phase write. repairPhaseToIntegrated is git-free BY DESIGN (pinned in
    // offrail-phase-repair-evidence-bound.test.mjs); this caller owns persistence, as guardrailsOn
    // does with commitAndPushNote after reconcileToIntegrated. Refusals and already_advanced
    // (repaired !== true) make no git call at all.
    if (res.repaired === true) {
      const integrationBranch = branchConfig.integration;
      // ARCH Q2: commit + push ONLY when the integration branch is checked out. On any other
      // branch (or detached HEAD, which reads as "") the commit would land somewhere other than
      // the branch being pushed, so make no commit and volunteer why.
      const branchProbe = spawnSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
      const currentBranch = branchProbe.status === 0 ? (branchProbe.stdout || "").trim() : "";
      if (currentBranch !== "" && currentBranch === integrationBranch) {
        const notePath = path.join(resolveNotesDir(projectRoot), `${input.storyId}.md`);
        // No `Story: <id>` line and no `feat(exec): ` subject: either would mint its own
        // phase-repair evidence. Every field of res.note is the helper's observed git outcome.
        res.note = commitAndPushNote(
          projectRoot,
          notePath,
          integrationBranch,
          `chore(story): advance ${input.storyId} to integrated (rks_phase_repair)`,
        );
      } else {
        res.note = { ok: false, skipped: true, reason: "not_on_integration_branch", currentBranch, integrationBranch };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
  });

  // --- ARCH verdict (computed, never asserted) ---
  registerHandler(ARCH_VERDICT_TOOL, async (cleanArgs, ctx) => {
    const input = archVerdictSchema.parse(cleanArgs);
    const { notesDir, projectRoot } = getDendronContext();
    assertNotesDir(notesDir);
    const notePath = notePathFromFilename(notesDir, input.storyId);
    if (!fs.existsSync(notePath)) throw new McpError(ErrorCode.InvalidParams, `Note not found`);

    // Retain the WHOLE parse result AND the raw bytes, not just .data. The coalesced
    // write below writes only what it is handed — unlike updateField/updateFieldDirect,
    // which re-serialise the whole note. Keeping only .data here would leave no body in
    // scope at the write site and destroy the note. The raw text is retained because
    // the write rejoins the body VERBATIM; see the write site below.
    const rawNote = readNoteRaw(notePath);
    const parsed = parseFrontmatter(rawNote);
    const before = parsed?.data || {};

    // Refuse, do not coerce. computeArchVerdict's Number.isFinite fallback is
    // correct for a total pure function; the defect was that the caller handed it
    // a value needing the fallback — a corrupt arch_round became NaN, fell back to
    // 0, and silently restarted the round counter, re-freezing the ledger and
    // discarding the recorded round. Absent / null / "" still mean round 0.
    const rawRound = before.arch_round;
    if (rawRound !== undefined && rawRound !== null && rawRound !== "") {
      const isScalar = typeof rawRound === "string" || typeof rawRound === "number";
      if (!isScalar || !Number.isFinite(Number(rawRound))) {
        return { content: [{ type: "text", text: JSON.stringify({
          ok: false,
          error: "invalid_arch_round",
          field: "arch_round",
          value: rawRound,
          storyId: input.storyId,
          detail: "arch_round must be a finite numeric scalar. Refusing rather than coercing to 0, which would silently restart the round counter and re-freeze the ledger.",
        }, null, 2) }] };
      }
    }

    // The subject is digested from the note ALREADY READ above — body plus the two
    // reviewable frontmatter fields. Nothing arch-owned and nothing time-varying
    // reaches it: the frontmatter side by construction (subjectDigest is handed three
    // parameters and the arch fields are not among them), and the BODY side by
    // subjectDigest subtracting the ARCH-owned `## ARCH Guidance` section, which
    // governor-arch.md step 3(b) requires ARCH to rewrite on every pass.
    //
    // The body side was NOT sound before backlog.fix.arch-guidance-write-self-rebases-ledger:
    // ARCH's own mandated narrative write changed the digested body, so the next call
    // rebased, `round` was permanently 1 on the mandated path, and the deferred channel
    // and round cap were unreachable. Two things hold that closed, and BOTH are load
    // bearing — the digest-side subtraction above, and the byte-stable rejoin at the
    // write site below. Either one alone leaves the subject unstable across a pass.
    //
    // The parsed-note -> digest mapping lives in ONE exported helper (noteSubjectDigest)
    // that the guardrails-off story gate also calls, so the gate's arch_subject
    // comparison cannot drift from what is recorded here.
    const currentSubject = noteSubjectDigest(parsed);
    // Comparison-only: an arch_subject recorded under the pre-canonicalization digest
    // matches this, so it is not read as an amendment; only currentSubject is recorded
    // (backlog.fix.arch-subject-digest-guidance-boundary-whitespace).
    const legacySubject = noteLegacySubjectDigest(parsed);

    const computed = computeArchVerdict({
      priorLedger: Array.isArray(before.arch_ledger) ? before.arch_ledger : [],
      priorRound: Number(before.arch_round || 0),
      submitted: input.findings,
      recordedSubject: typeof before.arch_subject === "string" ? before.arch_subject : undefined,
      currentSubject,
      legacySubject,
      priorTotalRounds: before.arch_total_rounds,
      priorRoundFindings: before.arch_round_findings,
    });

    // PLAN-READY CREATE GATE (backlog.fix.arch-verdict-enforces-plan-ready-create-gate).
    // ARCH must never approve a story that rks_plan_ready would block with
    // create_target_no_authorable_block, so the handler runs plan_ready's OWN exported
    // predicate on the note — one validator, two callers, no possible disagreement.
    // Scope is that ONE check: no other plan_ready check affects the ARCH verdict.
    //
    // Recomputed from the note on EVERY call and never handed to computeArchVerdict nor
    // written to arch_ledger / arch_deferred, so round-1 freezing cannot defer a gate
    // issue and the round cap cannot discard one: it refuses at every round, including
    // at and past ARCH_MAX_ROUNDS (`capped` keeps its meaning). Deliberately NOT wrapped
    // in a try/catch — a predicate failure surfaces as a tool error before the write,
    // rather than assembling a pass inside a catch (fail closed).
    const gateIssues = findCreateTargetNoAuthorableBlockIssues({
      frontmatter: before,
      body: parsed?.content || "",
      projectRoot,
    }).map(({ check, file, suggestion }) => ({ check, file, suggestion }));
    const finalVerdict = gateIssues.length > 0 ? "needs-revision" : computed.verdict;
    const findingsCount = computed.blocking.length + gateIssues.length;

    const skipCommit = cleanArgs.skipCommit === true;
    const noteId = before.id || canonicalIdFromFilename(input.storyId);
    const nextFm = {
      ...before,
      id: noteId,
      // Both replaced primitives bumped this (dendron.mjs:395, :484). Omitting it
      // would silently stop the note advancing its mtime field.
      updated: Date.now(),
      arch_ledger: computed.ledger,
      arch_deferred: computed.deferred,
      arch_round: String(computed.round),
      arch_findings_count: String(findingsCount),
      arch_verdict: finalVerdict,
      arch_subject: computed.subject ?? currentSubject,
      arch_total_rounds: String(computed.totalRounds),
      arch_round_findings: computed.roundFindings.map(String),
    };
    // Phase advances when and ONLY when the FINAL (gated) verdict is approved.
    if (finalVerdict === "approved") nextFm.phase = "arch-approved";
    // ...and RETRACTS when a needs-revision verdict lands on a story still at
    // arch-approved (backlog.fix.arch-verdict-never-retracts-arch-approved). Without this
    // a rebased ledger that recomputes needs-revision left phase: arch-approved beside
    // arch_verdict: needs-revision, and the phase-keyed guardrails-off gate admitted a
    // story ARCH had just refused. Retraction is arch-approved -> ready ONLY: draft and
    // ready keep their phase, and planned / executing / executed are mid-build and are
    // deliberately NOT demoted.
    const retractsPhase = finalVerdict !== "approved" && before.phase === "arch-approved";
    if (retractsPhase) nextFm.phase = "ready";
    // The phase the note must hold after the write, under EITHER verdict. The read-back
    // below compares against this, not against the verdict-scoped intent.
    const expectedPhase = nextFm.phase;

    // ONE write or none. The six sequential updateField calls this replaces could
    // fail mid-sequence and leave the note holding a state the monotone ledger
    // forbids — ledger written, verdict not — with no rollback. writeNoteRaw swaps
    // atomically, so a throw here leaves the note byte-identical.
    //
    // BYTE-STABLE BODY. formatWithFrontmatter strips authored leading whitespace
    // (shared/frontmatter.mjs `replace(/^\s+/, "")`), so routing the body through it
    // emits bytes that are not the bytes digested a few lines above — making the
    // recorded arch_subject a digest of a document that no longer exists on disk, and
    // rebasing the NEXT call even when ARCH wrote no guidance at all. Observed: a body
    // authored with two leading newlines came back with one. So the frontmatter is
    // re-serialised and the body is rejoined VERBATIM from the raw text read above.
    // Only when the note carries no frontmatter at all is there no raw body to
    // preserve, and the format path is the correct fallback.
    //
    // backlog.fix.dendron-update-field-rewrites-untouched-frontmatter — and the frontmatter is
    // SPLICED, not re-serialised: only updated / arch_* / phase (when approved, or when a
    // needs-revision verdict retracts arch-approved) / id (when absent) are rewritten, so an untouched unquoted date is never shifted or re-quoted.
    const split = splitNoteFrontmatter(rawNote);
    const _archUpdates = Object.fromEntries(
      Object.keys(nextFm)
        .filter((k) => k === "updated" || k.startsWith("arch_") || (k === "phase" && (finalVerdict === "approved" || retractsPhase)) || (k === "id" && !before.id))
        .map((k) => [k, nextFm[k]]),
    );
    const nextRaw =
      split.frontmatter === null
        ? formatWithFrontmatter(nextFm, parsed?.content || "")
        : spliceNoteFrontmatter(rawNote, _archUpdates);
    try {
      writeNoteRaw(notePath, nextRaw, skipCommit ? {} : { skipEmbed: true });
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        error: "write_failed",
        detail: err?.message || String(err),
        storyId: input.storyId,
      }, null, 2) }] };
    }

    // Evidence-bound reporting: every value below is READ BACK off the note
    // after writing, never echoed from what we intended to write. See
    // notes/design.evidence-bound-reporting-invariant.md.
    const after = parseFrontmatter(readNoteRaw(notePath))?.data || {};
    const asArray = (v) => (Array.isArray(v) ? v.map(String) : []);
    const observed = {
      arch_verdict: after.arch_verdict,
      arch_round: String(after.arch_round ?? ""),
      arch_findings_count: String(after.arch_findings_count ?? ""),
      arch_ledger: asArray(after.arch_ledger),
      arch_deferred: asArray(after.arch_deferred),
      arch_total_rounds: String(after.arch_total_rounds ?? ""),
      arch_round_findings: asArray(after.arch_round_findings),
      phase: after.phase,
    };
    const mismatches = [];
    // Compared against the FINAL gated verdict and the combined count, i.e. what was
    // written — comparing against computed.verdict would flag every gate refusal.
    if (observed.arch_verdict !== finalVerdict) mismatches.push("arch_verdict");
    if (observed.arch_round !== String(computed.round)) mismatches.push("arch_round");
    if (observed.arch_findings_count !== String(findingsCount)) mismatches.push("arch_findings_count");
    if (JSON.stringify(observed.arch_ledger) !== JSON.stringify(computed.ledger.map(String))) mismatches.push("arch_ledger");
    if (JSON.stringify(observed.arch_deferred) !== JSON.stringify(computed.deferred.map(String))) mismatches.push("arch_deferred");
    // The advisory fields are read back and compared like every other written field. A
    // field exempted from this list is silently accepted at whatever value landed on
    // disk, which is the failure mode this whole read-back block exists to prevent.
    if (observed.arch_total_rounds !== String(computed.totalRounds)) mismatches.push("arch_total_rounds");
    if (JSON.stringify(observed.arch_round_findings) !== JSON.stringify(computed.roundFindings.map(String))) mismatches.push("arch_round_findings");
    // Phase is verified under BOTH verdicts. Scoping this check to `approved` made a stale
    // arch-approved on a needs-revision verdict structurally invisible to the verifier.
    if (observed.phase !== expectedPhase) mismatches.push("phase");

    if (mismatches.length > 0) {
      return { content: [{ type: "text", text: JSON.stringify({
        ok: false,
        error: "read_back_mismatch",
        mismatches,
        observed,
        storyId: input.storyId,
      }, null, 2) }] };
    }

    // path and id satisfy commitDendronWriteResult's documented innerResult
    // contract (server.mjs:504). They are inputs to the commit, not status
    // claims, so they carry no evidence-bound reporting hazard; every status
    // field below is still sourced from observed.*.
    const inner = {
      ok: true,
      path: path.relative(notesDir, notePath),
      id: noteId,
      storyId: input.storyId,
      verdict: observed.arch_verdict,
      round: computed.round,
      capped: computed.capped,
      rebased: computed.rebased,
      maxRounds: ARCH_MAX_ROUNDS,
      // Surfaced beside maxRounds precisely because this is where the wrong inference is
      // made: `round: 1, maxRounds: 3` reads as "one review so far" when the story may
      // have had several. totalRounds is the number that answers that question.
      totalRounds: Number(observed.arch_total_rounds),
      roundFindings: observed.arch_round_findings.map(Number),
      blocking: observed.arch_ledger,
      deferred: observed.arch_deferred,
      phase: observed.phase,
      findingsCount: Number(observed.arch_findings_count),
      // Plan-ready create-gate issues: recomputed from the note, never ledgered, always
      // blocking, cleared only by amending the story. [] when the gate passes.
      gateIssues,
    };
    const wrapped = await commitDendronWriteResult({ tool: ARCH_VERDICT_TOOL, innerResult: inner, skipCommit });
    return { content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }] };
  });

  // --- Governor session tools ---
  registerHandler(GOVERNOR_INIT_TOOL, async (cleanArgs, ctx) => {
    const input = governorInitSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;

    // Set project root for governor session persistence
    setProjectRoot(projectRoot);

    // Detect orphaned guardrails (hooks.bak with no off-rail owner). Fail closed on the
    // off-rail record; the outcome (kept + reason, or restored + provenance) is reported
    // on the init response as orphanGuardrails.
    const orphanGuardrails = detectOrphanedGuardrails({ outcome: true, projectId: input.projectId, caller: "rks_governor_init" });

    const result = handleGovernorInit(input);

    // Reconcile .rks/active-scope.json. That file is current-flow state, owned by
    // packages/mcp-rks/src/server/guardrails-audit.mjs (SCOPE_FILE), and is the
    // live write scope of an off-rail build. Decided only now — after orphan
    // detection and after init, so the init mode is known — and removed only
    // when genuinely orphaned. The outcome is reported in the response.
    const scopeReconcile = reconcileActiveScopeOnInit({ projectRoot, initResult: result });
    if (result && typeof result === "object") {
      result.scopeFileRemoved = scopeReconcile.removed;
      result.scopeFileReconcile = { removed: scopeReconcile.removed, reason: scopeReconcile.reason };
      result.orphanGuardrails = orphanGuardrails;
    }

    // Branch validation for story flows: ensure we're on base branch
    // before refine/research waste cycles on the wrong branch.
    if (result.ok && input.problemId) {
      const baseBranch = context.projectJson?.baseBranch || "staging";
      const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false });
      if (currentBranch && currentBranch !== baseBranch && !currentBranch.startsWith("rks/")) {
        try {
          const checkout = await runGitCheckout({ projectRoot, branch: baseBranch });
          if (checkout.ok) {
            result.branchCorrected = { from: currentBranch, to: baseBranch };
            result.message += ` (auto-checkout: ${currentBranch} → ${baseBranch})`;
            getTelemetryCollector().emit('governor.branch.corrected', input.projectId, {
              from: currentBranch,
              to: baseBranch,
              problemId: input.problemId,
            });
          }
        } catch { /* checkout failed — plan preflight will catch it */ }
      }
      result.branch = currentBranch === baseBranch ? baseBranch
        : (result.branchCorrected?.to || currentBranch);
      result.baseBranch = baseBranch;
    }

    // Emit session creation telemetry
    if (result.ok && result.message?.includes('initialized')) {
      try {
        getTelemetryCollector().emit('governor.session.created', input.projectId, {
          flowType: result.flowType,
          problemId: input.problemId || null,
        });
      } catch { /* telemetry is best-effort */ }
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
