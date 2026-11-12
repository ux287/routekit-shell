/**
 * Governance handler family (S9b of research.2026.10.05.server-mjs-safe-decomposition).
 *
 * Bodies moved verbatim from server.mjs. Handler contract: see ./registry.mjs. No body reads ctx,
 * with sanctioned exceptions: the rks_governor_end handler reads ctx.governorToken, the caller's
 * own token (backlog.feat.governor-session-end, D17); rks_guardrails_off reads ctx.governorToken
 * (the off-rail lease conversion) and ctx.clientName, and rks_governor_init reads ctx.clientName
 * (attribution) — backlog.feat.project-lease-actor-attribution §5/§6. Nothing else on ctx.
 *
 * Project lease (backlog.feat.project-lease-actor-attribution §5, §5a, §5c): the three guardrails
 * handlers read and write the lease through the governor-token session root
 * (getSessionProjectRoot), never loadContext(...).record.root, so init and these handlers consult
 * one store. On the memory store exactly one key is added, lease: { store: "memory", degraded:
 * "no_project_root" }. On the disk store the response is the underlying result exactly, except that
 * a lease write refused by lock contention is volunteered
 * (backlog.fix.project-lease-release-runs-unlocked-on-contention):
 *   - leaseRelease: { released: false, contended: true, ... } is added to an ok rks_guardrails_on /
 *     rks_guardrails_abort result only when releaseOffRail returned contended: true;
 *   - leaseRollback: { reverted: false, contended: true, ... } is added to the non-ok
 *     rks_guardrails_off response only when revertOffRail returned contended: true.
 * A contended release cannot occur on the memory store, which takes no lock.
 * The eight schema consts arrive as the second argument. getDendronContext, assertNotesDir,
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
import { guardrailsOff, guardrailsOn, guardrailsAbort, getSessionHistory, commitAndPushNote, summarizeGuardrailsOnResponse, guardrailsOnMustInline } from "../guardrails-audit.mjs";
import { buildToolResponse } from "../response-detail.mjs";
import { repairPhaseToIntegrated } from "../../workflow/auto-phase.mjs";
import { archiveShippedStory } from "../story-ship.mjs";
import { coAuthorTrailer, CO_AUTHOR_REJECTED_WARNING } from "../../shared/commit-attribution.mjs";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { TOOL_NAME as GOVERNOR_INIT_TOOL, handleGovernorInit } from "../../tools/governor-init.mjs";
import { TOOL_NAME as GOVERNOR_END_TOOL, handleGovernorEnd } from "../../tools/governor-end.mjs";
import { TOOL_NAME as ARCH_VERDICT_TOOL, computeArchVerdict, noteSubjectDigest, noteV1SubjectDigest, noteLegacySubjectDigest, notePreCarveOutSubjectDigest, ARCH_MAX_ROUNDS } from "../../workflow/arch-verdict.mjs";
import { setProjectRoot, detectOrphanedGuardrails, validateToken, getSession, isSessionTerminal, getSessionProjectRoot } from "../../shared/governor-token.mjs";
import { convertToOffRail, revertOffRail, releaseOffRail, resolveAttribution, MEMORY_DEGRADATION, LEASE_MAX_AGE_MS } from "../../shared/project-lease.mjs";
import { findCreateTargetNoAuthorableBlockIssues } from "../plan-ready.mjs";
import { resolveInitCredential } from "../../llm/claude-cli/subscription-status.mjs";
import { tokenGateBypass } from "../../shared/token-gate-bypass.mjs";
import { envLane } from "../../shared/lane-policy.mjs";

// backlog.feat.project-lease-actor-attribution §5c: on the memory store, exactly one key is added,
// lease. Derived from the store the lease operation reported, never from a separate root check. On
// the disk store the underlying result is returned unchanged, except that a contended release or
// rollback is volunteered as leaseRelease / leaseRollback by the two helpers below
// (backlog.fix.project-lease-release-runs-unlocked-on-contention).
const withLeaseDegradation = (res, store) => (store === "memory" && res && typeof res === "object"
  ? { ...res, lease: { ...MEMORY_DEGRADATION } }
  : res);

// The lease result is volunteered under `key` only when it reports contended: true; otherwise res is
// returned unchanged. The guardrails result stands either way (guardrails really changed state).
const withContendedLease = (res, key, leaseResult) => (leaseResult && leaseResult.contended === true && res && typeof res === "object"
  ? { ...res, [key]: { ...leaseResult } }
  : res);
// An ok rks_guardrails_on / rks_guardrails_abort: volunteer a contended off-rail release, then the
// memory-store degradation key.
const withOffRailRelease = (res, release) => withLeaseDegradation(withContendedLease(res, "leaseRelease", release), release?.store);

// backlog.fix.phase-repair-records-unreviewed-remainder. The status repairPhaseToIntegrated
// (workflow/auto-phase.mjs REVIEW_RECORD_TRUNCATED) gives a persisted truncated-review record. Held
// as a literal, not imported: this module's import set mirrors server.mjs's (GV-TR14).
const REVIEW_RECORD_TRUNCATED = "truncated_review";
const truncatedRecordOf = (res) => (res && res.reviewRecord && res.reviewRecord.status === REVIEW_RECORD_TRUNCATED ? res.reviewRecord : null);
// Delete the record file repairPhaseToIntegrated read, at the relative path it reported. Never throws.
const deleteReviewRecordFile = (projectRoot, record) => {
  try {
    const rel = typeof record.recordFile === "string" ? record.recordFile : "";
    const stateDir = path.join(projectRoot, ".rks", "state", "truncated-review");
    const abs = path.resolve(projectRoot, rel);
    if (rel === "" || path.dirname(abs) !== stateDir) return { deleted: false, error: "record path is outside the truncated-review state directory" };
    fs.rmSync(abs, { force: true });
    return { deleted: !fs.existsSync(abs) };
  } catch (err) {
    return { deleted: false, error: err?.message || String(err) };
  }
};
// The flat frontmatter fields rks_phase_repair writes for a truncated-review record. Scalars and string arrays only; partialFiles entries are
// "<path>:<lastIncludedLine>". review_advance marks the advance as an operator acceptance.
const REVIEW_ADVANCE_OPERATOR_ACCEPTANCE = "operator_acceptance_via_rks_phase_repair";
const reviewRecordFields = (record, evidence) => {
  const fields = {
    review_record: REVIEW_RECORD_TRUNCATED,
    review_never_reviewed_files: Array.isArray(record.unseenFiles) ? record.unseenFiles.map(String) : [],
    review_partial_file: typeof record.partialFile === "string" ? record.partialFile : null,
    review_partial_file_last_line: Number.isFinite(record.partialFileLastIncludedLine) ? record.partialFileLastIncludedLine : null,
    review_partial_files: Array.isArray(record.partialFiles) ? record.partialFiles.map(String) : [],
    review_suppression_reason: typeof record.reason === "string" ? record.reason : null,
    review_original_chars: Number.isFinite(record.originalChars) ? record.originalChars : null,
    review_included_chars: Number.isFinite(record.includedChars) ? record.includedChars : null,
    review_reviewed_range: record.reviewedFrom || record.reviewedTo ? `${record.reviewedFrom ?? ""}..${record.reviewedTo ?? ""}` : null,
    review_advance: REVIEW_ADVANCE_OPERATOR_ACCEPTANCE,
    review_evidence_commit: typeof evidence?.commit === "string" ? evidence.commit : null,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
};
// One write through writeNoteRaw (atomic swap), splicing only the review_* keys. Never throws.
const writeReviewRecordFrontmatter = (notesDir, storyId, record, evidence) => {
  try {
    const notePath = path.join(notesDir, `${storyId}.md`);
    const fields = reviewRecordFields(record, evidence);
    const next = spliceNoteFrontmatter(readNoteRaw(notePath), fields);
    if (next === null) return { ok: false, error: "story note has no frontmatter block" };
    writeNoteRaw(notePath, next, { skipEmbed: true });
    return { ok: true, fields: Object.keys(fields) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};
// The commit message body. Empty without a record, so the no-record message is the subject alone.
// Carries neither a `Story: <id>` line nor a `feat(exec): ` subject (either would mint evidence).
const reviewRecordCommitBody = (record, evidence) => {
  if (!record) return "";
  const list = (xs) => (xs.length > 0 ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  const fields = reviewRecordFields(record, evidence);
  return (
    "\n\nAdvanced by operator acceptance through rks_phase_repair" +
    (fields.review_evidence_commit ? ` on evidence commit ${fields.review_evidence_commit}` : "") +
    ". The ship review diff was truncated, so part of this change was never reviewed.\n" +
    (fields.review_suppression_reason ? `Suppression reason: ${fields.review_suppression_reason}\n` : "") +
    `Never reviewed files:\n${list(fields.review_never_reviewed_files)}\n` +
    `Partially reviewed files (path:last reviewed line):\n${list(fields.review_partial_files)}`
  );
};
// Telemetry for every repaired call; names the same files and reason as res.reviewRecord. Never throws.
const emitPhaseRepairReviewRecord = (projectId, storyId, res) => {
  try {
    const record = truncatedRecordOf(res);
    getTelemetryCollector().emit("phase.repair.review_record", projectId, {
      storyId,
      reviewRecord: res.reviewRecord?.status ?? "absent",
      ...(record
        ? {
          neverReviewedFiles: Array.isArray(record.unseenFiles) ? [...record.unseenFiles] : [],
          partialFile: record.partialFile ?? null,
          partialFiles: Array.isArray(record.partialFiles) ? [...record.partialFiles] : [],
          suppressionReason: record.reason ?? null,
          advance: REVIEW_ADVANCE_OPERATOR_ACCEPTANCE,
          frontmatterWritten: res.reviewRecordWrite?.ok === true,
          recordCleared: res.reviewRecordCleared?.deleted === true,
        }
        : {}),
      evidenceCommit: res.evidence?.commit ?? null,
      noteCommitted: res.note?.ok === true,
    });
  } catch { /* telemetry is never allowed to fail the repair */ }
};

// §5a: a caller token is valid for conversion only when it names a live, non-terminal session of
// this project. Absent, unknown, expired, terminal and other-project tokens all read as null.
const callerTokenValidForConversion = (token, projectId) => {
  if (typeof token !== "string" || token === "" || !validateToken(token)) return null;
  const session = getSession(token);
  if (!session || session.projectId !== projectId || isSessionTerminal(token)) return null;
  if (Date.now() - (session.lastActivity || session.createdAt || 0) > LEASE_MAX_AGE_MS) return null;
  return token;
};

export function registerGovernanceHandlers({ registerHandler }, {
  guardrailsOffSchema,
  guardrailsOnSchema,
  guardrailsAbortSchema,
  guardrailsStatusSchema,
  phaseRepairSchema,
  archVerdictSchema,
  governorInitSchema,
  governorEndSchema,
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
    // backlog.feat.project-lease-actor-attribution §5/§5a: take the project's exclusive off-rail
    // lease BEFORE guardrailsOff. The caller's holder is converted, or (no valid caller token and no
    // live holder) an anonymous off-rail holder is created; any other live holder refuses.
    const leaseRoot = getSessionProjectRoot();
    const attribution = resolveAttribution({ clientName: ctx.clientName });
    const conversion = convertToOffRail({
      projectRoot: leaseRoot,
      projectId: input.projectId,
      token: callerTokenValidForConversion(ctx.governorToken, input.projectId),
      problemId: input.problemId ?? null,
      runId: attribution.runId,
      actor: attribution.actor,
      via: attribution.via,
      client: attribution.client,
    });
    if (!conversion.ok) {
      const refusal = {
        ok: false,
        reason: conversion.reason,
        holder: conversion.holder,
        requested: conversion.requested,
        message: conversion.reason === "project_leased"
          ? `Project ${input.projectId} is leased by another live Governor (${conversion.holder?.flowType ?? "off-rail"} flow${conversion.holder?.problemId ? ` for ${conversion.holder.problemId}` : ""}, since ${conversion.holder?.since ?? "unknown"}). Guardrails were NOT turned off.`
          : `Project ${input.projectId} lease acquisition is in progress in another process. Guardrails were NOT turned off; retry.`,
      };
      return { content: [{ type: "text", text: JSON.stringify(withLeaseDegradation(refusal, conversion.store), null, 2) }], isError: true };
    }
    // backlog.fix.project-lease-executing-holder-and-offrail-retry D2: a holder that was already
    // off-rail before this call (a retried rks_guardrails_off) is restored to its prior off-rail
    // state on rollback, never cleared: the project is still off-rail (hooks in hooks.bak).
    const rollBack = () => revertOffRail({
      projectRoot: leaseRoot,
      projectId: input.projectId,
      holderKey: conversion.holderKey,
      created: conversion.created,
      ...(conversion.alreadyOffRail === true ? { prior: conversion.prior } : {}),
    });
    let res;
    try {
      res = await guardrailsOff(projectRoot, input.reason, input.scope || "all", input.problemId, input.projectId);
    } catch (err) {
      rollBack();
      throw err;
    }
    // A rollback refused by lock contention is volunteered as leaseRollback: the project may stay
    // leased for up to the conversion grace.
    const rollback = !res || res.ok !== true ? rollBack() : null;
    const out = withContendedLease(res, "leaseRollback", rollback);
    return { content: [{ type: "text", text: JSON.stringify(withLeaseDegradation(out, conversion.store), null, 2) }] };
  });

  registerHandler("rks_guardrails_on", async (cleanArgs, ctx) => {
    const input = guardrailsOnSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const rawRes = await guardrailsOn(
      projectRoot,
      {
        ...(input.enforcementOverride ? { enforcementOverride: input.enforcementOverride } : {}),
        ...(input.coAuthor ? { coAuthor: input.coAuthor } : {}),
        ...(input.restoreFromTemplate === true ? { restoreFromTemplate: true } : {}),
      },
      input.projectId,
    );
    // backlog.feat.project-lease-actor-attribution §5/§5a: an ok guardrailsOn releases the project's
    // off-rail holder (per project, token or not); a non-ok one leaves it held (still off-rail).
    // §5c: the memory-store key rides in the payload, so it survives every detail level.
    const res = rawRes && rawRes.ok === true
      ? withOffRailRelease(rawRes, releaseOffRail({ projectRoot: getSessionProjectRoot(), projectId: input.projectId, reason: "guardrails_on" }))
      : rawRes;
    // ARCH R9: report a rejected coAuthor; never refuse here, a refusal would leave guardrails off.
    if (input.coAuthor !== undefined && coAuthorTrailer(input.coAuthor) === "") {
      console.error(CO_AUTHOR_REJECTED_WARNING);
      return buildToolResponse({ projectRoot, tool: "rks_guardrails_on", payload: { ...res, coAuthorRejected: true, coAuthorWarning: CO_AUTHOR_REJECTED_WARNING }, detail: input.detail, summarize: summarizeGuardrailsOnResponse, mustInline: guardrailsOnMustInline });
    }
    return buildToolResponse({ projectRoot, tool: "rks_guardrails_on", payload: res, detail: input.detail, summarize: summarizeGuardrailsOnResponse, mustInline: guardrailsOnMustInline });
  });

  registerHandler("rks_guardrails_abort", async (cleanArgs, ctx) => {
    const input = guardrailsAbortSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    const projectRoot = context.record.root;
    const rawRes = await guardrailsAbort(projectRoot, { discardPreExisting: input.discardPreExisting === true }, input.projectId);
    // backlog.feat.project-lease-actor-attribution §5/§5a: same per-project release as rks_guardrails_on.
    const res = rawRes && rawRes.ok === true
      ? withOffRailRelease(rawRes, releaseOffRail({ projectRoot: getSessionProjectRoot(), projectId: input.projectId, reason: "guardrails_abort" }))
      : rawRes;
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
      // backlog.fix.phase-repair-records-unreviewed-remainder: a story whose ship review was
      // truncated carries what was never reviewed onto its frontmatter BEFORE the archive rename,
      // so the z_implemented note keeps it. Only a truncated-review record writes; no record
      // writes nothing, and nothing here ever writes a field claiming the change was reviewed.
      const record = truncatedRecordOf(res);
      if (record) res.reviewRecordWrite = writeReviewRecordFrontmatter(resolveNotesDir(projectRoot), input.storyId, record, res.evidence);
      // ARCH Q2: commit + push ONLY when the integration branch is checked out. On any other
      // branch (or detached HEAD, which reads as "") the commit would land somewhere other than
      // the branch being pushed, so make no commit and volunteer why.
      const branchProbe = spawnSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
      const currentBranch = branchProbe.status === 0 ? (branchProbe.stdout || "").trim() : "";
      if (currentBranch !== "" && currentBranch === integrationBranch) {
        const notesDir = resolveNotesDir(projectRoot);
        let notePath = path.join(notesDir, `${input.storyId}.md`);
        // backlog.fix.offrail-ship-and-phase-repair-skip-archive: a repair that reached integrated
        // archives the story (status implemented, z_implemented rename) exactly as rks_story_ship
        // does, and the rename rides in this same commit. `repaired` alone is ok && advanced, so
        // `to` is checked as well. res.archive is the helper's observed filesystem outcome.
        if (res.to === "integrated") {
          res.archive = archiveShippedStory({ projectRoot, notesDir, problemId: input.storyId });
          notePath = [res.archive.oldPath, res.archive.newPath];
        }
        // No `Story: <id>` line and no `feat(exec): ` subject: either would mint its own
        // phase-repair evidence. Every field of res.note is the helper's observed git outcome.
        res.note = commitAndPushNote(
          projectRoot,
          notePath,
          integrationBranch,
          `chore(story): advance ${input.storyId} to integrated (rks_phase_repair)` + reviewRecordCommitBody(record, res.evidence),
        );
        // Record lifecycle (ARCH round-2 item 10): delete only once the frontmatter write AND the
        // note commit both succeeded. Any failure leaves the record file untouched.
        if (record && res.reviewRecordWrite?.ok === true && res.note?.ok === true && res.note?.skipped !== true) {
          res.reviewRecordCleared = deleteReviewRecordFile(projectRoot, record);
        }
      } else {
        res.note = { ok: false, skipped: true, reason: "not_on_integration_branch", currentBranch, integrationBranch };
      }
      emitPhaseRepairReviewRecord(input.projectId, input.storyId, res);
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
    // Comparison-only: an arch_subject recorded before refine-owned content was carved out of
    // the digest matches this (backlog.fix.arch-subject-digest-excludes-refine-context-sections).
    const preCarveOutSubject = notePreCarveOutSubjectDigest(parsed);
    // Comparison-only, for an UNVERSIONED arch_subject (no current arch_subject_version): the
    // version-1 digest, i.e. the current digest before whitespace normalisation
    // (backlog.fix.arch-subject-digest-whitespace-robust). A version-2 recording is compared
    // against currentSubject only; computeArchVerdict branches on recordedVersion.
    const v1Subject = noteV1SubjectDigest(parsed);

    const computed = computeArchVerdict({
      priorLedger: Array.isArray(before.arch_ledger) ? before.arch_ledger : [],
      priorRound: Number(before.arch_round || 0),
      submitted: input.findings,
      recordedSubject: typeof before.arch_subject === "string" ? before.arch_subject : undefined,
      currentSubject,
      legacySubject,
      preCarveOutSubject,
      recordedVersion: before.arch_subject_version,
      v1Subject,
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
      // The fingerprint version travels with the digest it describes, on EVERY verdict. Written
      // only when computeArchVerdict reports one (null leaves the field untouched), so a version
      // is never stamped onto a digest it does not describe.
      ...(computed.subjectVersion !== null && computed.subjectVersion !== undefined
        ? { arch_subject_version: String(computed.subjectVersion) }
        : {}),
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
      arch_subject: after.arch_subject,
      arch_subject_version: after.arch_subject_version === undefined || after.arch_subject_version === null
        ? after.arch_subject_version
        : String(after.arch_subject_version),
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
    // The recorded digest and its version are read back too: compared against the exact value
    // written, and the version only when one was written (computed.subjectVersion non-null).
    const writtenSubjectVersion = computed.subjectVersion !== null && computed.subjectVersion !== undefined
      ? String(computed.subjectVersion)
      : null;
    if (observed.arch_subject !== (computed.subject ?? currentSubject)) mismatches.push("arch_subject");
    if (writtenSubjectVersion !== null && observed.arch_subject_version !== writtenSubjectVersion) mismatches.push("arch_subject_version");

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
      // From the read-back, never from the intended value. A numeric-looking version reports as
      // a number (2); anything else as observed, or null when absent.
      subjectVersion: observed.arch_subject_version === undefined || observed.arch_subject_version === null
        ? null
        : (Number.isFinite(Number(observed.arch_subject_version)) && observed.arch_subject_version.trim() !== ""
          ? Number(observed.arch_subject_version)
          : observed.arch_subject_version),
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

    // backlog.feat.project-lease-actor-attribution §6: client attribution from the MCP client info.
    const result = handleGovernorInit(input, { clientName: ctx.clientName ?? null });

    // A lease refusal created no session: nothing to reconcile, and it is never ok-shaped (AC15).
    if (result && result.ok === false && (result.reason === "project_leased" || result.reason === "lease_contended")) {
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
    }

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
      // Credential state and per-flow capability admission (fails closed to refuse). With no API
      // key and RKS_SUBSCRIPTION_CREDENTIAL on, this probes through the shared claude -p probe
      // cache and writes .rks/state/llm-backend.json, which the hooks read for their posture.
      const initCredential = await resolveInitCredential({ projectRoot });
      result.credential = initCredential.credential;
      result.capabilities = initCredential.capabilities;
      // backlog.fix.remote-lane-init-capabilities-overstate-admission: the remote lane admits no
      // tool any listed flow needs, so every flow is reported blocked by the lane (same flow keys),
      // and the server owner's credential state is not disclosed to a remote principal. The lane is
      // the enforcement lane (envLane), never the init input `via`.
      if (envLane() === "remote") {
        result.credential = "not_applicable";
        result.capabilities = Object.fromEntries(
          Object.keys(initCredential.capabilities || {}).map((flow) => [flow, { blocked: "remote_lane" }]),
        );
      }
      // backlog.feat.token-gate-bypass-visible AC5: whether this process enforces the protected-tool
      // token gate, from the same env observation the gate uses.
      const gate = tokenGateBypass(process.env);
      result.tokenGate = gate.active ? { enforced: false, bypassVars: gate.vars } : { enforced: true };
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

  // backlog.feat.governor-session-end: a Governor ends its OWN session as its last call. The only
  // ctx read in this module (D17): the caller's token, which server.mjs strips from cleanArgs.
  registerHandler(GOVERNOR_END_TOOL, async (cleanArgs, ctx) => {
    const input = governorEndSchema.parse(cleanArgs);
    const context = await loadContext(input.projectId);
    // Set project root so validateToken can rehydrate a session persisted on disk.
    setProjectRoot(context.record.root);
    const result = handleGovernorEnd(input, ctx.governorToken);
    // D19: emitted only for an observed end; best-effort, mirroring governor.session.created.
    if (result.ended === true) {
      try {
        getTelemetryCollector().emit('governor.session.ended', input.projectId, {
          flowType: result.flowType,
          state: result.state,
        });
      } catch { /* telemetry is best-effort */ }
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
