import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { recordIntervention } from "../shared/intervention-record.mjs";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { reviewPlan, computePlanHash, describeDryRunStep } from "./plan-quality.mjs";
import {
  ensureDir,
  loadContext,
  slugify,
  enforceGuardrail,
  loadProjectProtectedConfig,
  isProtectedPath,
} from "./project.mjs";
import { recordTelemetry, buildTelemetryMetrics } from "./telemetry.mjs";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { runRefineTool } from "./refine.mjs";
import { findFunctionSlice, replaceSlice } from "../llm/slices.mjs";
import {
  handleRunCommandStep,
  runProjectTests,
  testsRanFromVerification,
  loadCommandPolicy,
  classifyCommand,
  isCommandPolicyTarget,
  isGovernancePath,
  GOVERNANCE_PATH_PREFIXES,
  COMMAND_POLICY_RELATIVE_PATH,
  captureCommandPolicyState,
  compareCommandPolicyState,
  restoreCommandPolicyState,
  commandPolicyFromState,
} from "../exec/command-runner.mjs";
import { parseDeclaredEntry, evaluateDeclaredPostApply, formatDeclaredNotPassing } from "../exec/test-results.mjs";
import { isProcessRequirement, evaluateRequirementCoverage, buildRequirementCoverageRecord, isRequirementCoverageComplete } from "../exec/test-results.mjs";
import { resolveUnverifiedCoveragePolicy } from "../exec/requirement-coverage-policy.mjs";
import { resolveNotePath } from "../dendron-notes.mjs";
import { parseFrontmatter, spliceNoteFrontmatter } from "../shared/frontmatter.mjs";
import { isDeepStrictEqual } from "util";
import { VALID_STEP_TYPES } from "./planner.mjs";
import { createBackup, dropBackupStash, capturePartialDiff, cleanupWorkingTree, recordPlanPreImage, recordPlanPostWrite, beginWriteRecordAttempt, resolvePlanTarget, stampWriteRecordCompletion } from "../exec/backup.mjs";
import { runCheckedGit, runGit, getCurrentBranch, isWorkingTreeClean, hasGitRepo, findLatestRunDir, getUncommittedFiles, assertCleanWorkingTree, isRuntimeArtifact } from "../utils/git.mjs";
import { runGitPR, runGitCommit } from "./git-tools.mjs";
import { provenanceTrailerLine } from "../shared/commit-provenance.mjs";
import { assertNotProtectedBranch } from "./branch-protection.mjs";
import { generateFixPlan, applyFixPlan } from "./fix-planner.mjs";
import { applySearchReplace, applyCreateFile } from "./step-apply.mjs";
import { guardrailsOff, guardrailsOn } from "./guardrails-audit.mjs";
import { loadPlan } from "./plan-loader.mjs";
import { recordWrittenPath } from "../shared/session-state.mjs";
import { embedScopedFiles, computeGitAnchor } from "@routekit/rag";
import { loadStory } from "../shared/story-loader.mjs";
import { PHASE_GATE_EXEC } from "../workflow/phases.mjs";
import { storyChangedSinceArch } from "../workflow/arch-verdict.mjs";
import { advancePhase as advancePhaseImpl } from "../workflow/auto-phase.mjs";
import { ensureStoryOnRemote } from "./story-validator.mjs";
import {
  planHashFor,
  buildExecTrailers,
  buildPlanArchive,
  planArchiveRelPath,
  writePlanArchive,
  planArchiveWriteFailed,
  cleanupPlanArchive,
  checkPlanArchiveIgnored,
  emitTerminalOutcome,
} from "./exec-provenance.mjs";
// extractFrontmatterField replaced by loadStory from shared/story-loader.mjs
import { resolveNotesDir, updateField } from "../dendron.mjs";
import {
  MAX_RETRY_ATTEMPTS,
  computeImplicitDirs,
  isTestFile,
  isTestFixStory,
  runPreApplyBaseline,
  cleanupFeatureBranch,
  detectPerStepDivergence,
  computeUnexpectedFiles,
  DEPENDENCY_MANIFEST_FILES,
  planDeclaredOutputs,
  buildTestVerification,
  hashTestFiles,
  verifyTestFileIntegrity,
  rollback,
  deriveRolledBack,
  rollbackRecoveryGuidance,
} from "./test-runner.mjs";
import {
  ExecPhase,
  initExecState,
  saveExecState,
  loadExecState,
  updateExecPhase,
  markStepCompleted,
  markExecFailed,
  markExecComplete,
  findIncompleteRuns,
} from "../workflow/exec-state.mjs";

// MAX_RETRY_ATTEMPTS, computeImplicitDirs, isTestFile, isTestFixStory extracted to ./test-runner.mjs

// cleanupFeatureBranch extracted to ./test-runner.mjs

// detectPerStepDivergence extracted to ./test-runner.mjs

/**
 * backlog.fix.run-command-honest-and-usable (Defect B): the set exec stages and commits. The plan's
 * applied files, plus anything the dependency install derived, plus every output a run_command step
 * DECLARED it produces. The declared outputs come from the SAME planDeclaredOutputs the scope guard
 * (computeUnexpectedFiles) exempts, so a path exempted from the guard is always in the commit set:
 * an exempt-but-uncommitted file would be left dirty for ship's preflight to refuse.
 * Pure: no I/O, so the commit-set rule is drivable without the exec pipeline.
 */
export function computeCommitFiles({ appliedFiles = [], installDerived = new Set(), steps = [] } = {}) {
  return [...new Set([...appliedFiles, ...installDerived, ...planDeclaredOutputs(steps)])];
}

/**
 * backlog.fix.run-command-honest-and-usable (Defect A): THE reduction over a non-executed
 * run_command outcome. The thrown error's message, its structured `nonExecutedCommands` field and
 * the exec.run_command_skipped telemetry payload are all read off the one object this returns, so
 * the result surface and the telemetry channel cannot disagree (reduceShipOk discipline).
 */
export function reduceRunCommandSkip(result) {
  const entry = {
    command: result?.command ?? "",
    classification: result?.classification ?? null,
    reason: result?.reason ?? null,
    hint: result?.hint ?? null,
  };
  if (result?.refusedEntry) entry.refusedEntry = result.refusedEntry;
  const message =
    `run_command was NOT executed (${entry.reason}): ${entry.command} ` +
    `[classification: ${entry.classification}]. ${entry.hint ?? ""}`.trimEnd();
  return { nonExecutedCommands: [entry], event: entry, message };
}

/**
 * Advance the story to `executed` at the end of a green exec, and REPORT the
 * outcome to the caller instead of swallowing it.
 *
 * Extracted as a named export so the failure path is testable without driving
 * the whole exec pipeline. The previous inline form only console.error'd a
 * failed advance while exec went on to return ok:true — so an exec whose story
 * phase had been reverted underneath it still looked completely clean, and the
 * caller shipped a story the backlog still recorded as unbuilt.
 *
 * @param {(root: string, problemId: string, op: string, actor: string) => Promise<{ok: boolean, to?: string, error?: string}>} advance
 *        injectable for testing; defaults to the real advancePhase.
 * @returns {Promise<null | { op: string, problemId: string, error: string }>}
 *          null on success or when there is no story to advance.
 */
export async function advanceExecEndPhase(projectRoot, problemId, advancePhase = advancePhaseImpl) {
  if (!problemId) return null;
  try {
    const result = await advancePhase(projectRoot, problemId, "exec_end", "rks.exec");
    if (result?.ok) {
      console.error(`[rks.exec] Updated ${problemId} to phase: ${result.to}`);
      return null;
    }
    const error = result?.error || "advancePhase reported failure without an error";
    console.error(`[rks.exec] Failed to update phase: ${error}`);
    return { op: "exec_end", problemId, error };
  } catch (e) {
    const error = e?.message || String(e);
    console.error(`[rks.exec] Failed to update phase: ${error}`);
    return { op: "exec_end", problemId, error };
  }
}

/**
 * Default git runner for commitExecEndNote. Never throws: it reports the observed
 * exit status and output so the caller can decide, and carries a timeout so a hung
 * git (e.g. a blocking hook) cannot wedge exec.
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: string }}
 */
export function runNoteGit(projectRoot, args) {
  const r = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: 60_000 });
  return {
    status: r.status,
    stdout: (r.stdout || "").toString(),
    stderr: (r.stderr || "").toString(),
    ...(r.error ? { error: r.error.message || String(r.error) } : {}),
  };
}

/**
 * backlog.fix.exec-end-phase-write-left-uncommitted
 *
 * advanceExecEndPhase writes `phase: executed` to the story note AFTER exec's own
 * code commit, and that write is a disk write only. Left uncommitted, the dirty note
 * reaches story-ship's localMerge, whose `git checkout <working>` aborts with
 * "would be overwritten by checkout" whenever the working branch's copy differs.
 *
 * This commits ONLY the story's own note, on the feature branch, and only when
 * `shouldCommit && commitResult?.ok === true && !phaseError`: exec's own commit was
 * attempted and observed to succeed, and the phase write itself landed. The note is
 * deliberately NOT part of exec's commitFiles (that set is pinned by
 * tests/integration/exec-derived-files-commit.test.mjs).
 *
 * The commit uses `--only -- <note>`, so anything else already staged stays staged
 * and uncommitted — the note is the only path this commit can carry.
 *
 * @param {object} args
 * @param {(root: string, args: string[]) => {status: number|null, stdout?: string, stderr?: string, error?: string}} [args.git]
 *        injectable for testing; defaults to runNoteGit.
 * @returns {Promise<null | { ok: true, path: string, commitId: string|null, alreadyCommitted?: true }
 *                          | { ok: false, op: string, problemId: string, path: string, step: string, error: string }>}
 *          null when the gate is closed (no git call is made at all).
 */
export async function commitExecEndNote({ projectRoot, problemId, shouldCommit, commitResult, phaseError, git = runNoteGit }) {
  if (!problemId) return null;
  if (!(shouldCommit && commitResult?.ok === true && !phaseError)) return null;

  const notePath = path.relative(projectRoot, path.join(resolveNotesDir(projectRoot), `${problemId}.md`));
  // A vault outside this repo cannot be committed here, and cannot block this repo's checkout.
  if (!notePath || notePath.startsWith("..") || path.isAbsolute(notePath)) return null;

  const fail = (step, res, fallback) => {
    const observed = (res?.stderr || "").trim() || (res?.stdout || "").trim() || res?.error || "";
    const error = observed || fallback || `git ${step} exited with status ${res?.status}`;
    console.error(`[rks.exec] exec_end note commit failed at ${step}: ${error}`);
    return { ok: false, op: "exec_end_note_commit", problemId, path: notePath, step, error };
  };

  let res;
  try {
    res = git(projectRoot, ["add", "--", notePath]);
  } catch (e) {
    return fail("add", null, e?.message || String(e));
  }
  if (res?.status !== 0) return fail("add", res);

  // Nothing staged for the note means it is already clean at HEAD — an observed clean
  // tree for this path, not an assumed one. `diff --cached --quiet` exits 1 when it differs.
  try {
    res = git(projectRoot, ["diff", "--cached", "--quiet", "--", notePath]);
  } catch (e) {
    return fail("diff", null, e?.message || String(e));
  }
  if (res?.status === 0) {
    return { ok: true, path: notePath, commitId: null, alreadyCommitted: true };
  }
  if (res?.status !== 1) return fail("diff", res);

  try {
    res = git(projectRoot, ["commit", "-m", `chore(exec): record ${problemId} phase executed`, "-m", provenanceTrailerLine({ defaultTool: "rks_exec" }), "--only", "--", notePath]);
  } catch (e) {
    return fail("commit", null, e?.message || String(e));
  }
  if (res?.status !== 0) return fail("commit", res);

  let commitId = null;
  try {
    const head = git(projectRoot, ["rev-parse", "HEAD"]);
    if (head?.status === 0) commitId = (head.stdout || "").trim().slice(0, 7) || null;
  } catch { /* the commit itself was observed to succeed; the id is informational */ }
  console.error(`[rks.exec] Committed exec_end phase write for ${notePath}${commitId ? `: ${commitId}` : ""}`);
  return { ok: true, path: notePath, commitId };
}

/**
 * backlog.fix.exec-test-requirements-coverage-gate (Solution step 6): write the coverage record
 * onto the frontmatter of the story note as `requirementCoverageRecord`, through the shared frontmatter
 * splice writer (shared/frontmatter.mjs), then READ IT BACK with parseFrontmatter. The write is
 * reported as ok only when the read-back parses and deep-equals the record; any other outcome is
 * returned as { ok: false, error, detail } for the caller to volunteer as requirementCoverageWriteError.
 * Never throws.
 *
 * @param {{ notePath: string, record: object }} args
 * @returns {{ ok: true, path: string } | { ok: false, error: string, detail: string }}
 */
export function writeRequirementCoverageRecord({ notePath, record }) {
  try {
    const raw = fs.readFileSync(notePath, "utf8");
    const out = spliceNoteFrontmatter(raw, { requirementCoverageRecord: record });
    if (out === null) return { ok: false, error: "note_has_no_frontmatter", detail: `no frontmatter block in ${notePath}` };
    fs.writeFileSync(notePath, out);
    let readBack;
    try {
      readBack = parseFrontmatter(fs.readFileSync(notePath, "utf8")).data?.requirementCoverageRecord;
    } catch (e) {
      return { ok: false, error: "read_back_unparseable", detail: e?.message || String(e) };
    }
    if (!isDeepStrictEqual(readBack, record)) {
      return { ok: false, error: "read_back_mismatch", detail: `read back ${JSON.stringify(readBack ?? null).slice(0, 400)}` };
    }
    return { ok: true, path: notePath };
  } catch (e) {
    return { ok: false, error: "write_failed", detail: e?.message || String(e) };
  }
}

/** File name of the coverage-gate record inside the run folder. */
export const COVERAGE_GATE_RECORD_FILE = "coverage-gate.json";

/**
 * backlog.fix.exec-refuse-plan-without-requirement-coverage-map (Solution step 2): save a
 * coverage-gate refusal (the plan-admission refusal or a post-apply coverage-gate refusal) to
 * `coverage-gate.json` in the run folder, then READ IT BACK. The write is reported as ok only when
 * the read-back parses and deep-equals the record; any other outcome is returned as
 * { ok: false, error, detail } for the caller to volunteer as coverageGateWriteError. Never throws.
 *
 * @param {{ runDir: string, record: object }} args
 * @returns {{ ok: true, path: string } | { ok: false, error: string, detail: string }}
 */
export function writeCoverageGateRecord({ runDir, record }) {
  try {
    if (typeof runDir !== "string" || runDir.length === 0) {
      return { ok: false, error: "no_run_dir", detail: "no run folder to write the coverage-gate record into" };
    }
    const recordPath = path.join(runDir, COVERAGE_GATE_RECORD_FILE);
    const serialized = JSON.stringify(record, null, 2);
    fs.writeFileSync(recordPath, serialized + "\n");
    let readBack;
    try {
      readBack = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    } catch (e) {
      return { ok: false, error: "read_back_unparseable", detail: e?.message || String(e) };
    }
    // Compared with the JSON form of the record (undefined-valued keys are not written).
    if (!isDeepStrictEqual(readBack, JSON.parse(serialized))) {
      return { ok: false, error: "read_back_mismatch", detail: `read back ${JSON.stringify(readBack ?? null).slice(0, 400)}` };
    }
    return { ok: true, path: recordPath };
  } catch (e) {
    return { ok: false, error: "write_failed", detail: e?.message || String(e) };
  }
}

// parseTestCounts extracted to ./test-runner.mjs

// ensureStoryOnRemote extracted to ./story-validator.mjs

// applySearchReplace extracted to ./step-apply.mjs

// generateFixPlan and applyFixPlan extracted to ./fix-planner.mjs

/**
 * Decide whether to run `npm install` before the post-apply test phase: true when the applied plan
 * changed the root package.json (a dependency was added/changed) OR node_modules is missing — so a
 * just-declared dependency (e.g. a test runner like vitest) is resolvable when the tests run, inside
 * the governed flow with no off-rail detour. See backlog.fix.exec-post-apply-npm-install.
 * @param {string[]} appliedFiles - plan-written files (relative to projectRoot)
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function shouldInstallDeps(appliedFiles, projectRoot) {
  const touchedPackageJson = Array.isArray(appliedFiles) && appliedFiles.some(
    (f) => f === "package.json" || (typeof f === "string" && f.endsWith("/package.json"))
  );
  if (touchedPackageJson) return true;
  try {
    // node_modules missing but a package.json exists → deps were never installed; install them.
    // Require package.json — `npm install` is pointless/erroring without one (e.g. a bare dir).
    return fs.existsSync(path.join(projectRoot, "package.json"))
      && !fs.existsSync(path.join(projectRoot, "node_modules"));
  } catch {
    return false;
  }
}

async function checkForIncompletePreviousStory(projectRoot, currentLabel) {
  // Check for existing rks/* branches that aren't the current story
  const { execSync } = await import('child_process');
  try {
    const branches = execSync('git branch --list "rks/*"', { cwd: projectRoot, encoding: 'utf8' });
    const otherBranches = branches.split('\n')
      .map(b => b.trim().replace(/^\* /, ''))
      .filter(b => b && !b.includes(currentLabel || ''));

    if (otherBranches.length > 0) {
      return {
        blocked: true,
        reason: "incomplete_previous_story",
        message: `BLOCKED: Found unmerged feature branch(es) from previous story: ${otherBranches.join(', ')}`,
        branches: otherBranches,
        requiredAction: "Run rks_story_ship for the previous story first, then retry.",
        hint: "DO NOT 'optimize' by skipping steps. Complete one story fully before starting the next."
      };
    }
  } catch (e) {
    // git command failed, allow proceeding
  }
  return { blocked: false };
}

/**
 * backlog.fix.exec-rollback-strands-executing-phase
 *
 * Exits that are a RESUMABLE PAUSE, not a failure. These must NOT reset the phase: each one's own
 * prescribed remedy re-enters exec, which re-checks the `executing` gate (:319). Resetting here does
 * not un-stick the story — it wedges the very flow that was about to recover it.
 *   - needs_approval           — `rks_approve` re-enters exec.
 *   - incomplete_previous_story — "ship the previous story, THEN retry"; the retry re-enters exec.
 */
/**
 * backlog.fix.exec-working-tree-anchor-assertion
 *
 * Compare a caller-asserted working-tree anchor against the tree exec is about to modify.
 *
 * The PLAN side of verification is already sealed: plan.qualityReview.hash is written at plan
 * time and exec returns integrity_failed on drift. The TREE side was not. rks_exhaustive_search
 * returns a git anchor precisely so a result can be pinned, but rks_exec had no parameter to
 * assert it — so "I verified this anchor is in the tree, now execute against that tree" was
 * unexpressible. Failure was detected only at apply time by applySearchReplace not finding its
 * pattern, which is the opposite of pre-execution verification.
 *
 * Anchors are `@<sha>` or `@<sha>+dirty` (see computeGitAnchor). Six cases, decided at ARCH:
 *
 *   expected            actual              verdict
 *   ------------------  ------------------  -------------------------------------------------
 *   null/absent         anything            no assertion made — proceed, match null
 *   different sha       any                 REFUSE — different commit, full stop
 *   @sha                @sha                proceed, "exact"
 *   @sha                @sha+dirty          REFUSE — caller asserted a clean tree, tree is not
 *   @sha+dirty          @sha                proceed, "dirty-weak"
 *   @sha+dirty          @sha+dirty          proceed, "dirty-weak"
 *
 * `dirty-weak` rather than a plain match, deliberately: two dirty trees at one HEAD are NOT the
 * same tree, so this cannot honestly be called equality. But refusing it would make the
 * parameter unusable on this project's own default build path (guardrails-off, always dirty),
 * and a parameter nobody can call is dead code. The weakness is surfaced in a three-valued
 * field instead of being hidden inside a boolean.
 *
 * @param {string|null|undefined} expected
 * @param {string|null|undefined} actual
 * @returns {{ ok: boolean, match: 'exact'|'dirty-weak'|null, reason: string|null }}
 */
export function compareGitAnchors(expected, actual) {
  if (expected === null || expected === undefined || expected === "") {
    return { ok: true, match: null, reason: null };
  }
  if (!actual) {
    return { ok: false, match: null, reason: "working tree anchor could not be determined" };
  }
  const parse = (a) => {
    const s = String(a).replace(/^@/, "");
    const dirty = s.endsWith("+dirty");
    return { sha: dirty ? s.slice(0, -"+dirty".length) : s, dirty };
  };
  const e = parse(expected);
  const a = parse(actual);

  if (e.sha !== a.sha) {
    return { ok: false, match: null, reason: `expected commit ${e.sha}, working tree is at ${a.sha}` };
  }
  if (!e.dirty && a.dirty) {
    return { ok: false, match: null, reason: `expected a clean tree at ${e.sha}, working tree has uncommitted changes` };
  }
  if (!e.dirty && !a.dirty) {
    return { ok: true, match: "exact", reason: null };
  }
  // Expectation was already dirty — the caller knows it is not asserting byte equality.
  return { ok: true, match: "dirty-weak", reason: null };
}

const EXEC_PHASE_RESET_CARVE_OUTS = new Set(["needs_approval", "incomplete_previous_story"]);

/**
 * backlog.fix.exec-start-reset-story-changed-since-arch: refuse an arch-approved story whose content
 * changed after ARCH recorded arch_subject. FAIL CLOSED (evidence-bound reporting, R5): the phase-gate
 * catch in runExecToolInner re-throws only McpError and logs anything else, so every outcome other than
 * an observed `changed: false` becomes an McpError here. `check` is injectable for the forced-throw test.
 * Returns the observed check result (backlog.fix.precommands-arch-digest-binding), so the caller can
 * require `gated: true` before running story preCommands.
 */
export function assertStoryUnchangedSinceArch(story, problemId, check = storyChangedSinceArch) {
  let res;
  try {
    res = check({ data: story?.frontmatter || {}, content: typeof story?.body === "string" ? story.body : "" }, problemId);
  } catch (err) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `rks.exec: story_changed_since_arch check for ${problemId} could not run (${err?.message || err}); refusing (fail closed). Repair the note, then re-run /arch on ${problemId}.`
    );
  }
  if (!res || typeof res.changed !== "boolean") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `rks.exec: story_changed_since_arch check for ${problemId} returned no verdict; refusing (fail closed). Re-run /arch on ${problemId}.`
    );
  }
  if (res.changed) {
    throw new McpError(ErrorCode.InvalidRequest, `rks.exec: story_changed_since_arch. ${res.message}`);
  }
  return res;
}

/**
 * backlog.fix.precommands-arch-digest-binding: story preCommands run only under a gated, unchanged ARCH
 * approval. Throws an InvalidRequest McpError (fail closed; the phase-gate catch re-throws it) when the
 * resolved list is non-empty and the observed storyChangedSinceArch result is not gated true with changed
 * false. The refusal text is built only from observed values (R1): the recorded arch_verdict, whether
 * arch_subject was recorded, the recorded arch_subject_version and ungatedReason when present.
 */
export function assertPreCommandsArchGated(preCommands, archCheck, story, problemId) {
  if (!Array.isArray(preCommands) || preCommands.length === 0) return;
  if (archCheck && archCheck.gated === true && archCheck.changed === false) return;
  const label = (v) => (v === undefined || v === null ? "absent" : JSON.stringify(v));
  const recorded = archCheck?.recorded;
  const subjectState = recorded === undefined || recorded === null || recorded === "" ? "absent" : "recorded";
  const observed = [
    `arch_verdict ${label(story?.frontmatter?.arch_verdict)}`,
    `arch_subject ${subjectState}`,
    `arch_subject_version ${label(archCheck?.recordedVersion)}`,
  ];
  if (archCheck?.ungatedReason) observed.push(`ungatedReason ${archCheck.ungatedReason}`);
  throw new McpError(
    ErrorCode.InvalidRequest,
    `rks.exec: preCommands_require_gated_arch_approval. Story ${problemId} declares ${preCommands.length} preCommand(s), which run only under a gated, unchanged ARCH approval. Observed: ${observed.join(", ")}. Run /arch on ${problemId} so ARCH reviews the story including its preCommands and records a versioned arch_subject, then retry.`
  );
}

/** The two classifications under which a story preCommand may run (planApproved parity with run_command). */
const PRECOMMAND_RUNNABLE_CLASSIFICATIONS = new Set(["auto_execute", "execute_with_plan_approval"]);

/**
 * backlog.fix.story-precommands-shell-bypass: validate and classify a story's frontmatter preCommands
 * against the run_command policy, BEFORE any of them runs. Synchronous. Returns [] for an absent
 * value (undefined / null), normalises a single string to one entry, and returns
 * [{ command, classification }] for entries that classify auto_execute or execute_with_plan_approval.
 * Any other entry (not a non-empty string, shell_syntax_rejected, require_explicit_confirmation,
 * unknown) refuses the whole exec with an InvalidRequest McpError naming the storyId, the entry and
 * its classification. Nothing is spawned here.
 */
export function resolveStoryPreCommands(raw, { problemId, policy } = {}) {
  if (raw === undefined || raw === null) return [];
  if (!policy || typeof policy !== "object") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `rks.exec: preCommands of ${problemId} cannot be classified without a command policy; refusing (fail closed).`
    );
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const resolved = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `rks.exec: story ${problemId} has a preCommands entry that is not a non-empty string (${JSON.stringify(entry)}); refusing. ` +
          `Each preCommands entry must be a plain command string.`
      );
    }
    const classification = classifyCommand(entry, policy);
    if (!PRECOMMAND_RUNNABLE_CLASSIFICATIONS.has(classification)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `rks.exec: story ${problemId} preCommands entry "${entry}" classifies as ${classification} under the command policy; refusing. ` +
          `preCommands run as argv with no shell and only when the command policy admits them (auto_execute or execute_with_plan_approval).`
      );
    }
    resolved.push({ command: entry, classification });
  }
  return resolved;
}

/**
 * backlog.fix.story-precommands-shell-bypass: run resolved preCommands through handleRunCommandStep,
 * the run_command path (argv only, no shell), with planApproved true, the 120 s preCommand timeout
 * and the injected policy (options.policy) when given. A non-zero exit stays non-blocking.
 * ok is true only when the step executed and exited 0; a run-time skip is recorded as
 * { command, classification, ok: false, skipped: true, reason } with no exitCode.
 */
export async function runStoryPreCommands(entries, { projectRoot, policy } = {}) {
  const results = [];
  for (const entry of entries || []) {
    const command = typeof entry === "string" ? entry : entry?.command;
    const declared = typeof entry === "string" ? undefined : entry?.classification;
    try {
      console.error(`[rks.exec] preCommand: ${command}`);
      const result = await handleRunCommandStep(command, {
        projectRoot,
        planApproved: true,
        timeout: 120000,
        ...(policy && typeof policy === "object" ? { policy } : {}),
      });
      if (result.executed === true && result.exec) {
        const ok = result.exec.code === 0;
        results.push({
          command,
          classification: result.classification,
          ok,
          exitCode: result.exec.code,
          stdout: (result.exec.stdout || "").slice(0, 500),
          stderr: (result.exec.stderr || "").slice(0, 500),
          ...(result.exec.spawnError ? { spawnError: result.exec.spawnError } : {}),
        });
        if (ok) {
          console.error(`[rks.exec] preCommand succeeded: ${command}`);
        } else {
          console.warn(`[rks.exec] preCommand failed (exit ${result.exec.code}): ${command}`);
        }
      } else {
        results.push({
          command,
          classification: result.classification,
          ok: false,
          skipped: true,
          reason: result.reason,
        });
        console.warn(`[rks.exec] preCommand skipped (${result.reason}): ${command}`);
      }
    } catch (err) {
      console.error(`[rks.exec] preCommand error: ${err?.message}`);
      results.push({ command, classification: declared, ok: false, error: err?.message });
    }
  }
  return results;
}

export function isResumablePause(result) {
  return EXEC_PHASE_RESET_CARVE_OUTS.has(result?.reason) || EXEC_PHASE_RESET_CARVE_OUTS.has(result?.status);
}

/**
 * backlog.feat.exec-plan-commit-linkage (AC12): the collector the terminal-outcome seam writes to.
 * ctx.collector once runExecToolInner created it; else the project store when the project root is
 * known (exits before the collector exists, e.g. incomplete_previous_story); else null, and the
 * omission is logged rather than silent (a throw before loadContext returned has no store).
 */
export function resolveTerminalCollector(ctx) {
  if (ctx?.collector) return ctx.collector;
  if (ctx?.projectRoot) {
    try {
      return ensureTelemetryStorage(ctx.projectRoot);
    } catch (e) {
      console.error(`[rks.exec] terminal outcome not recorded: telemetry store for ${ctx.projectRoot} unavailable: ${e?.message ?? e}`);
      return null;
    }
  }
  console.error("[rks.exec] terminal outcome not recorded: no project root (exec failed before the project context loaded)");
  return null;
}

/**
 * backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed (AC11)
 *
 * Re-enable guardrails after an exec run and OBSERVE the outcome. Both exec call sites (the
 * per-step divergence early return and the post-apply+commit restore) route through here.
 * Only `res?.ok === true` counts as re-enabled; a thrown error or any other result is non-ok.
 * Emits exec.guardrails_on carrying `ok`, and on non-ok `reason` (e.g. hooks_backup_missing)
 * and `provenance` (the recorded hooks.bak removal, or an explicit null). Never throws.
 *
 * Injectable (guardrailsOn, collector) so the non-ok paths are testable without a live session.
 * Declared away from runExecTool: a witness test reads a fixed 900-character window there.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string, provenance: object|null}>}
 */
export async function reenableGuardrailsAfterExec({ guardrailsOn, collector, projectRoot, projectId, payload = {} }) {
  let res;
  let thrown = null;
  try {
    res = await guardrailsOn(projectRoot, { skipAutoShip: true }, projectId);
  } catch (e) {
    thrown = e;
  }
  let outcome;
  if (!thrown && res?.ok === true) {
    outcome = { ok: true };
  } else if (thrown) {
    outcome = { ok: false, reason: `guardrails_on_threw: ${thrown?.message || String(thrown)}`, provenance: null };
  } else {
    const reason = res?.reason ?? res?.error;
    outcome = {
      ok: false,
      reason: typeof reason === "string" && reason.length > 0 ? reason : "guardrails_on_not_ok",
      provenance: res?.provenance ?? null,
    };
  }
  try {
    if (collector) {
      collector.emit("exec.guardrails_on", projectId, { ...payload, ...outcome });
    }
  } catch { /* telemetry is best-effort */ }
  return outcome;
}

/** Human-readable warning for a non-ok guardrails re-enable (AC11). */
function guardrailsRestoreWarning(restore) {
  return `Guardrails were NOT re-enabled after exec (${restore?.reason || "unknown"}); hooks may still be off. ` +
    "Inspect guardrailsRestore.provenance and run rks_guardrails_on (restoreFromTemplate: true only if the backup is truly lost).";
}

/**
 * backlog.fix.command-policy-integrity-across-runs: the command policy state is captured once per
 * exec (ctx.commandPolicyBaseline) and checked wherever plan-influenced code has just run. Backup and
 * rollback exclude .routekit, so a change is RESTORED here, never left for rollback to miss.
 *
 * HEAD may be reset only on exec's own rks/ feature branch (exec names it rks/<slug>).
 */
function commandPolicyHeadResetAllowed(projectRoot) {
  try {
    return String(getCurrentBranch(projectRoot, { throwOnError: false }) || "").startsWith("rks/");
  } catch {
    return false;
  }
}

/**
 * Compare the current policy state with the baseline and restore the changed parts (only those in
 * `restorable` when given). changedParts, restored and restoreFailed are copied from the
 * compareCommandPolicyState / restoreCommandPolicyState return values only; unrevertedParts is the
 * changed parts that were not passed to the restore call.
 */
function checkCommandPolicyIntegrity(projectRoot, baseline, { allowHeadReset = false, restorable = null } = {}) {
  const cmp = compareCommandPolicyState(baseline, captureCommandPolicyState(projectRoot));
  if (!cmp.changed) {
    return { changed: false, changedParts: [...cmp.parts], restored: [], restoreFailed: [], unrevertedParts: [] };
  }
  const toRestore = Array.isArray(restorable) ? cmp.parts.filter((p) => restorable.includes(p)) : [...cmp.parts];
  const rs = toRestore.length > 0
    ? restoreCommandPolicyState(projectRoot, baseline, toRestore, allowHeadReset === true ? { allowHeadReset: true } : {})
    : { restored: [], failed: [] };
  return {
    changed: true,
    changedParts: [...cmp.parts],
    restored: [...(rs?.restored || [])],
    restoreFailed: (rs?.failed || []).map((f) => ({ part: f.part, error: f.error })),
    unrevertedParts: cmp.parts.filter((p) => !toRestore.includes(p)),
  };
}

/** Telemetry rule (i): one exec.command_policy_changed event per detected change, from the first check point. */
function emitCommandPolicyChanged(collector, projectId, correlationId, payload) {
  if (!collector) return;
  try {
    collector.emit("exec.command_policy_changed", projectId, { ...payload }, { correlationId });
  } catch { /* telemetry is best-effort */ }
}

/** "worktree, index" / "worktree (why)" rendering for log lines. */
function describePolicyParts(parts) {
  return (parts || []).map((p) => (typeof p === "string" ? p : `${p.part} (${p.error})`)).join(", ");
}

/**
 * The runExecTool exit seam. Runs on both the return and the throw path whenever a baseline was
 * captured, finalized or not:
 *   - not finalized: every changed part is restored (HEAD only on an rks/ branch); a would-be success
 *     becomes ok false / status command_policy_changed; any other result keeps its status;
 *   - finalized (the exec commit landed): worktree and index only, never HEAD, never ok/status; a
 *     hook-made policy commit is reported in unrevertedParts and left in place.
 * Emits no event when the result already carries command_policy_changed (an earlier check point
 * emitted it); otherwise one event with stage exit. Logs one console.error line per detected change.
 * Returns null when nothing changed, else { commandPolicyRestored } (also merged into a result).
 */
function settleCommandPolicyAtExit(ctx, { result = null, thrown = false } = {}) {
  const baseline = ctx?.commandPolicyBaseline;
  if (!baseline || !ctx.projectRoot) return null;
  const finalized = ctx.finalized === true;
  let check;
  try {
    check = checkCommandPolicyIntegrity(
      ctx.projectRoot,
      baseline,
      finalized ? { restorable: ["worktree", "index"] } : { allowHeadReset: commandPolicyHeadResetAllowed(ctx.projectRoot) },
    );
  } catch (e) {
    console.error(`[rks.exec] command policy exit check could not run: ${e?.message ?? e}`);
    return null;
  }
  if (!check.changed) return null;
  const commandPolicyRestored = {
    changedParts: check.changedParts,
    restored: check.restored,
    restoreFailed: check.restoreFailed,
    ...(finalized ? { unrevertedParts: check.unrevertedParts } : {}),
  };
  const alreadyReported = !thrown && result && typeof result === "object"
    && (result.status === "command_policy_changed" || result.error === "exec.command_policy_changed");
  if (!alreadyReported) {
    emitCommandPolicyChanged(ctx.collector, ctx.projectId, ctx.correlationId ?? null, {
      stage: "exit",
      ...commandPolicyRestored,
      problemId: ctx.storyId ?? null,
      runId: ctx.runId ?? null,
    });
  }
  console.error(
    `[rks.exec] command policy changed (exit${finalized ? ", finalized" : ""}): changed [${describePolicyParts(check.changedParts)}]; ` +
      `restored [${describePolicyParts(check.restored)}]; failed [${describePolicyParts(check.restoreFailed)}]; ` +
      `unreverted [${describePolicyParts(check.unrevertedParts)}]`
  );
  if (!thrown && result && typeof result === "object") {
    result.commandPolicyRestored = commandPolicyRestored;
    if (!finalized && result.ok !== false) {
      result.ok = false;
      result.status = "command_policy_changed";
    }
  }
  return { commandPolicyRestored };
}

/**
 * backlog.fix.exec-rollback-strands-executing-phase
 *
 * THE PROBLEM: a story is at phase `executing` on ENTRY to exec (the plan writer makes that hop; exec
 * only gates on it). So EVERY exit — throw or `ok:false` return — leaves it there unless something
 * puts it back. `resetStalePhaseToArchApproved` existed but was wired to 2 of ~12 exits, so a scope
 * violation, a quality gate, a divergence, or any thrown error stranded the story at `executing`.
 * `rks_plan` refuses that phase, so the re-plan the failure message tells you to run is IMPOSSIBLE:
 * a recoverable failure becomes terminal and the story has to be deleted and recreated. A real
 * clean-machine greenfield UAT hit exactly this.
 *
 * THE FIX IS A THREE-REGION RECOVERY, and the three regions are NOT interchangeable — two of them
 * destroy your work if you use the wrong one. ARCH found all three the hard way:
 *
 *   1. FINALIZED (the commit landed) → PHASE RESET ONLY. NEVER rollback().
 *      The tail (markExecComplete etc.) can still throw AFTER a green, committed exec. rollback()
 *      would `git branch -D` the branch holding that commit — destroying a successful build because
 *      a JSON write failed. Committed work is never rolled back.
 *
 *   2. POST-MUTATION (branchName || backupMeta || guardrailsSession) → rollback(), then reset.
 *      A branch exists, or a backup was taken, or guardrails are OFF. rollback() is what restores
 *      the branch, the backup and the guardrails. A bare reset here would leak all three.
 *
 *   3. PRE-MUTATION (none of the three) → BARE PHASE RESET ONLY. NEVER rollback().
 *      Nothing has been mutated yet — and rollback()'s Step 5 (`cleanupWorkingTree`) is UNGUARDED,
 *      so with no branch/backup/session it degenerates to exactly one action: WIPING THE TREE. On
 *      the dirty-tree precondition failure (:258) that tree is dirty with the USER'S OWN uncommitted
 *      work, by definition. Calling rollback() here would delete it.
 *
 * The predicate is evaluated on STATE, never on a line number: a new exit path classifies itself.
 * (A `mutated` flag set at branch creation would be WRONG — that block is conditional on `gitRepo`,
 * and createBackup/guardrailsOff/runApplyTool all still run when it is skipped.)
 */
async function runExecTool(params) {
  const ctx = {
    projectId: params.projectId,
    projectRoot: null,
    baseBranch: null,
    runDir: null,
    storyId: null,
    branchName: null,
    backupMeta: null,
    guardrailsSession: null,
    finalized: false,
    // backlog.feat.exec-plan-commit-linkage (AC12): populated by runExecToolInner for the seam.
    collector: null,
    correlationId: null,
    runId: null,
    planHash: null,
    execStartMs: null,
    terminalDetail: null,
    terminalEmitted: false,
    // backlog.fix.command-policy-integrity-across-runs: captured by runExecToolInner before preCommands.
    commandPolicyBaseline: null,
  };

  try {
    const result = await runExecToolInner(params, ctx);
    // backlog.fix.command-policy-integrity-across-runs: the exit-seam policy check, BEFORE the terminal
    // emit and the phase reset, so a result converted to command_policy_changed is emitted and reset.
    settleCommandPolicyAtExit(ctx, { result });
    // The single producer of exec.failed / exec.paused (no-op for a success result).
    await emitTerminalOutcome({ collector: result?.ok === false ? resolveTerminalCollector(ctx) : ctx.collector, projectId: ctx.projectId, ctx, result, isPause: isResumablePause });
    // Return-value inspection: a try/catch does not intercept `return`, and most of exec's failures
    // are returns, not throws. Idempotent — the reset no-ops unless the phase is actually `executing`.
    if (result?.ok === false && !isResumablePause(result)) {
      resetStalePhaseToArchApproved(ctx.projectRoot, ctx.storyId);
    }
    return result;
  } catch (err) {
    // backlog.fix.command-policy-integrity-across-runs: restore the policy before recovery, and carry
    // the observed outcome on the error itself (a frozen or non-object error is rethrown unchanged).
    const policyExit = settleCommandPolicyAtExit(ctx, { thrown: true });
    if (policyExit) {
      try {
        err.commandPolicyRestored = policyExit.commandPolicyRestored;
      } catch { /* not attachable: the error is rethrown as it is */ }
    }
    await emitTerminalOutcome({ collector: resolveTerminalCollector(ctx), projectId: ctx.projectId, ctx, err, isPause: isResumablePause });
    const phaseReset = await recoverExecFailure(ctx, err);
    // backlog.fix.exec-refusal-phase-reset-chain-desync (AC3): the reset is an uncommitted note
    // write, and the thrown error is the only channel the throw path has. Name it, so the note is
    // never dirty silently. The chain lands in `refining`; rks_plan commits and re-plans from it.
    if (phaseReset && err && typeof err.message === "string") {
      try {
        err.message += ` [rks.exec: story ${ctx.storyId} phase reset executing → arch-approved (uncommitted note change); chain is at refining — next: rks_plan]`;
      } catch { /* a frozen message is left as-is */ }
    }
    throw err;
  }
}

export async function recoverExecFailure(ctx, err) {
  const reason = err?.message ? `exec_threw: ${String(err.message).slice(0, 80)}` : "exec_threw";
  // backlog.fix.exec-write-record-attempt-scope (N2): set only in Region 2, from the OBSERVED rollback.
  let rollbackOutcome = null;
  try {
    if (ctx.finalized) {
      // Region 1 — the commit landed. Never destroy it.
    } else if (ctx.branchName || ctx.backupMeta || ctx.guardrailsSession) {
      // Region 2 — real mutations exist. rollback() restores branch + backup + guardrails.
      ctx.rollbackResult = await rollback(ctx.projectRoot, {
        runDir: ctx.runDir,
        branchName: ctx.branchName,
        baseBranch: ctx.baseBranch,
        backupMeta: ctx.backupMeta,
        guardrailsSession: ctx.guardrailsSession,
        projectId: ctx.projectId,
        reason,
        correlationId: ctx.correlationId ?? null,
      });
      rollbackOutcome = { rb: ctx.rollbackResult, rollbackErr: null };
    }
    // Region 3 — pre-mutation: fall through. Nothing to roll back, and rollback() would wipe the tree.
  } catch (rollbackErr) {
    console.error(`[rks.exec] rollback during failure recovery failed: ${rollbackErr?.message}`);
    rollbackOutcome = { rb: null, rollbackErr };
  }

  // N2: the thrown error is the throw path's only channel, so it carries the rollback outcome, derived
  // exactly as the return sites derive it. Regions 1 and 3 ran no rollback and attach nothing. A frozen
  // or non-object error is rethrown unchanged.
  if (rollbackOutcome && err && (typeof err === "object" || typeof err === "function")) {
    const { rb, rollbackErr } = rollbackOutcome;
    const rolledBack = rollbackErr ? false : deriveRolledBack(rb);
    const leftBehind = rollbackErr ? [] : (rb?.leftBehind ?? []);
    const recovery = rollbackRecoveryGuidance(rollbackErr ? null : rb);
    try {
      err.rolledBack = rolledBack;
      err.leftBehind = leftBehind;
      err.recovery = recovery;
      if (rollbackErr) {
        err.rollbackError = rollbackErr?.message ?? String(rollbackErr);
      } else {
        err.partialDiffPath = rb?.partialDiffPath ?? null;
      }
    } catch { /* not attachable: the error is rethrown as it is */ }
    if (typeof err.message === "string") {
      const paths = leftBehind.map((e) => (e && typeof e === "object" ? e.path : e)).filter(Boolean);
      const suffix = rolledBack
        ? " [rks.exec: rolled back]"
        : ` [rks.exec: rollback did NOT fully restore the tree; left behind: ${paths.length ? paths.join(", ") : "none"}; ${recovery ?? "no recovery guidance"}]`;
      try {
        err.message += suffix;
      } catch { /* a frozen message is left as-is */ }
    }
  }

  // Every region resets the phase — that is the whole point of the story.
  return resetStalePhaseToArchApproved(ctx.projectRoot, ctx.storyId);
}

async function runExecToolInner({ projectId, label, skipTests = false, autoCommit = false, dryRun = false, expectedAnchor = null }, ctx) {
  // backlog.fix.exec-working-tree-anchor-assertion: three-valued, not a boolean —
  // null (no assertion made) / "exact" / "dirty-weak". See compareGitAnchors.
  let anchorMatch = null;
  const slug = label ? slugify(label) : null;
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;
  const baseBranch = context.projectJson?.baseBranch || "staging";
  ctx.projectRoot = projectRoot;
  ctx.baseBranch = baseBranch;
  console.error("[debug-runExecTool] projectRoot:", projectRoot);

  // GUARDRAIL: Block if there are unmerged branches from previous stories
  const incompleteCheck = await checkForIncompletePreviousStory(projectRoot, label || '');
  if (incompleteCheck.blocked) {
    return {
      ok: false,
      error: incompleteCheck.message,
      reason: incompleteCheck.reason,
      branches: incompleteCheck.branches,
      requiredAction: incompleteCheck.requiredAction,
      hint: incompleteCheck.hint
    };
  }

  // GOVERNANCE: Hash test files before applying changes (for protection verification later)
  const testFileHashes = new Map();
  const testDirs = ['__tests__', 'tests', 'test'];
  for (const dir of testDirs) {
    const testPath = path.join(projectRoot, 'packages/mcp-rks/src', dir);
    if (fs.existsSync(testPath)) {
      const files = fs.readdirSync(testPath).filter(f => f.endsWith('.test.mjs') || f.endsWith('.spec.mjs'));
      for (const file of files) {
        const fullPath = path.join(testPath, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        testFileHashes.set(fullPath, createHash('sha256').update(content).digest('hex'));
      }
    }
  }
  if (testFileHashes.size > 0) {
    console.error(`[rks.exec] Hashed ${testFileHashes.size} test files for protection`);
  }

  // Load plan first (needed for dirty tree validation against plan targets)
  const { plan, runDir, runId, slug: selectedSlug } = loadPlan(projectRoot, slug);
  // The story id is what the phase reset needs. A throw BEFORE this point cannot be reset (we do not
  // yet know which story we are in) — that residual is accepted and recorded in the story.
  ctx.runDir = runDir;
  ctx.storyId = plan.problemId || null;
  // backlog.fix.exec-write-record-attempt-scope: every rks_exec call is a fresh attempt, so the plan
  // write record must describe this attempt only. The previous attempt's record and pre-images are
  // moved aside (never deleted). Runs before any branch, backup, guardrails or apply, so a throw here
  // lands in Region 3 (phase reset, no rollback) and no rollback can ever read a stale record.
  ctx.writeRecordAttemptId = randomUUID();
  beginWriteRecordAttempt(runDir, { attemptId: ctx.writeRecordAttemptId });

  // Auto-clean stale incomplete runs from previous sessions
  const incompleteRuns = findIncompleteRuns(projectRoot);
  for (const staleRun of incompleteRuns) {
    if (staleRun.runId !== runId) {
      console.error(`[rks.exec] Auto-cleaning stale exec run: ${staleRun.runId} (phase: ${staleRun.state.currentPhase})`);
      markExecFailed(staleRun.runDir, 'auto-cleanup', 'Stale run cleaned by new exec session');
    }
  }

  // Initialize exec state for this run
  const execState = initExecState({
    runId,
    storyId: plan.problemId || null,
    totalSteps: plan.steps?.length || 0,
    branchName: null, // Will be set after branch creation
  });
  saveExecState(runDir, execState);

  // Initialize telemetry collector with JSONL storage
  const collector = ensureTelemetryStorage(projectRoot);
  // A-prime: no startTimer. Every exec lifecycle event is emitted literally through
  // collector.emit, which is the one surface the global mock in tests/setup.mjs captures.
  const execStartMs = Date.now();
  const correlationId = collector.startCorrelation();
  const runIdValue = runDir ? path.basename(runDir) : null;
  // backlog.feat.exec-plan-commit-linkage (AC12): what the terminal-outcome seam in runExecTool reads.
  ctx.collector = collector;
  ctx.execStartMs = execStartMs;
  ctx.correlationId = correlationId;
  ctx.runId = runIdValue;
  ctx.planHash = planHashFor(plan);
  const planHashValue = ctx.planHash;

  // HOISTED out of the git-repo block below: this set is consumed by three
  // separate sites — the notes staging step, the final scope guard, and the
  // per-step divergence guard — none of which are inside that block.
  const storyProblemId = plan.problemId || null;
  const storyNoteExclusions = new Set();
  if (storyProblemId) storyNoteExclusions.add(`notes/${storyProblemId}.md`);

  if (hasGitRepo(projectRoot)) {
    // Exclude the current story's note file(s) from the dirty check — they are legitimately
    // modified by rks_refine snippet injection and should not block exec.
    const problemId = storyProblemId;
    if (problemId) {
      // Also exclude child story notes (e.g. notes/<problemId>.child-1.md).
      // NOTE the snapshot timing: this enumerates from a getUncommittedFiles
      // snapshot taken BEFORE any step is applied, so a child note that first
      // becomes dirty DURING exec is not a member.
      const allDirtyPre = getUncommittedFiles(projectRoot);
      for (const f of allDirtyPre) {
        if (f.startsWith(`notes/${problemId}.`) && f.endsWith('.md')) {
          storyNoteExclusions.add(f);
        }
      }
    }

    // Enhanced dirty tree check: reject ALL uncommitted changes to prevent bundling
    const allDirtyFiles = getUncommittedFiles(projectRoot);
    const excludedNotes = allDirtyFiles.filter(f => storyNoteExclusions.has(f));
    if (excludedNotes.length > 0) {
      try {
        collector.emit('exec.story_notes_excluded', projectId, { count: excludedNotes.length, files: excludedNotes, problemId });
      } catch (e) { /* telemetry is best-effort */ }
    }
    // Also exclude all notes/ files — they are governor-managed project metadata, never part of
    // exec commits (they travel via a separate git add notes/ step). In multi-story epic work,
    // many story notes sit dirty on staging while individual stories execute one at a time.
    // Exempt known runtime artifacts (lockfiles, rks-generated state) so an artifacts-only dirty
    // tree does not block exec — they are never part of plan commits. Specific patterns only (the
    // pattern list deliberately has no broad .routekit/ prefix, which would mask tracked guardrail
    // config). See backlog.fix.exec-dirty-tree-gate-exempts-generated-files.
    const dirtyFiles = allDirtyFiles.filter(f => !storyNoteExclusions.has(f) && !f.startsWith('notes/') && !isRuntimeArtifact(f));
    if (dirtyFiles.length > 0) {
      const planTargetFiles = new Set(
        (plan?.steps || []).flatMap(s => [s.target, s.path].filter(Boolean))
      );
      const unrelatedFiles = dirtyFiles.filter(f => !planTargetFiles.has(f));
      const planTargetFiles_dirty = dirtyFiles.filter(f => planTargetFiles.has(f));

      // Log telemetry for dirty tree detection
      try {
        collector.emit("exec.dirty_tree_detected", projectId, {
          totalDirtyFiles: dirtyFiles.length,
          unrelatedFiles: unrelatedFiles.length,
          planTargetFiles: planTargetFiles_dirty.length,
          fileList: dirtyFiles.slice(0, 10),
          slug: selectedSlug || "unknown"
        });
      } catch (e) { /* telemetry is best-effort */ }

      // Build comprehensive error message
      let errorMessage = `rks.exec: Cannot proceed with uncommitted changes in working tree (${dirtyFiles.length} file(s)):`;
      
      if (unrelatedFiles.length > 0) {
        const unrelatedList = unrelatedFiles.slice(0, 10).join('\n    ');
        const moreUnrelated = unrelatedFiles.length > 10 ? `\n    ... and ${unrelatedFiles.length - 10} more` : '';
        errorMessage += `\n\n  Unrelated files (${unrelatedFiles.length}):${moreUnrelated}\n    ${unrelatedList}`;
      }
      
      if (planTargetFiles_dirty.length > 0) {
        const targetList = planTargetFiles_dirty.slice(0, 5).join('\n    ');
        const moreTargets = planTargetFiles_dirty.length > 5 ? `\n    ... and ${planTargetFiles_dirty.length - 5} more` : '';
        errorMessage += `\n\n  Plan target files (${planTargetFiles_dirty.length}):${moreTargets}\n    ${targetList}`;
      }
      
      errorMessage += `\n\nRationale: rks.exec creates commits that should only contain plan-generated changes.\nPre-existing changes would be bundled into the commit without validation.\n\nTo proceed:\n  1. Save work-in-progress: rks_stash\n  2. Commit changes intentionally: rks_git_commit\n  3. Discard unwanted changes: git restore <files>`;
      
      ctx.terminalDetail = { reason: "dirty_tree", totalFiles: dirtyFiles.length, unrelatedFiles: unrelatedFiles.length, durationMs: Date.now() - execStartMs };
      throw new McpError(ErrorCode.InvalidRequest, errorMessage);
    }

    const currentBranch = getCurrentBranch(projectRoot);
    if (currentBranch !== baseBranch) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `rks.exec: expected to run from base branch "${baseBranch}" but you're on "${currentBranch}". Checkout the base branch and retry.`
      );
    }
  }

  // Load story testFiles for scoped test runs (before baseline so both call sites can use it)
  let storyTestFiles = null;
  let storyTargetFiles = null;
  // backlog.feat.exec-declared-red-baseline-tests: tests the story declares red at HEAD.
  let baselineRedTests = null;
  // backlog.fix.exec-test-requirements-coverage-gate: the testRequirements of the story, read in the
  // same story load as baselineRedTests. Non-empty turns on per-test collection and the gate.
  let storyTestRequirements = null;
  const earlyProblemId = plan?.problemId;
  if (earlyProblemId) {
    // Decision 10: a story-linked exec FAILS CLOSED when its note is missing or cannot be loaded.
    // It returns before the skip-tests branch, the baseline and any apply; no branch exists yet.
    let earlyStory = null;
    try {
      earlyStory = loadStory(projectRoot, earlyProblemId);
    } catch (loadErr) {
      // Classified by OBSERVING the resolved note path, never by matching the error text of the loader.
      const earlyNotePath = resolveNotePath(projectRoot, earlyProblemId);
      const loadDetail = loadErr?.message || String(loadErr);
      if (!earlyNotePath || !fs.existsSync(earlyNotePath)) {
        console.error(`[rks.exec] story_missing: no story note for ${earlyProblemId}; refusing before apply`);
        ctx.terminalDetail = { problemId: earlyProblemId, reason: "story_missing", stage: "story_load", durationMs: Date.now() - execStartMs };
        return {
          ok: false,
          status: "test_requirements_unverifiable",
          reason: "story_missing",
          problemId: earlyProblemId,
          message: `Story note for ${earlyProblemId} does not exist, so its testRequirements cannot be read. Nothing was applied and no branch was created.`,
          hint: "Restore the story note (or re-plan against the correct problemId), then re-run rks_plan and rks_exec.",
        };
      }
      console.error(`[rks.exec] story_unreadable: story note for ${earlyProblemId} could not be loaded (${loadDetail}); refusing before apply`);
      ctx.terminalDetail = { problemId: earlyProblemId, reason: "story_unreadable", stage: "story_load", detail: loadDetail, durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "test_requirements_unverifiable",
        reason: "story_unreadable",
        problemId: earlyProblemId,
        detail: loadDetail,
        message: `Story note for ${earlyProblemId} exists but could not be loaded, so its testRequirements cannot be read. Nothing was applied and no branch was created.`,
        hint: "Fix the note (for example its frontmatter), then re-run rks_plan and rks_exec.",
      };
    }
    const tf = earlyStory.frontmatter.testFiles;
    storyTestFiles = Array.isArray(tf) && tf.length > 0 ? tf : null;
    const brt = earlyStory.frontmatter.baselineRedTests;
    const brtList = typeof brt === "string" ? [brt] : brt;
    baselineRedTests = Array.isArray(brtList) && brtList.length > 0 ? brtList : null;
    const treq = earlyStory.frontmatter.testRequirements;
    const treqList = typeof treq === "string" ? [treq] : treq;
    storyTestRequirements = Array.isArray(treqList) && treqList.length > 0 ? treqList : null;
    storyTargetFiles = earlyStory.targetFiles || earlyStory.frontmatter?.targetFiles || null;
  }
  const hasTestRequirements = Array.isArray(storyTestRequirements) && storyTestRequirements.length > 0;
  // Only non-process requirements need an observed test (Solution step 1).
  const nonProcessRequirementCount = hasTestRequirements
    ? storyTestRequirements.filter((r) => !isProcessRequirement(r)).length
    : 0;

  // backlog.fix.exec-refuse-plan-without-requirement-coverage-map (Solution step 1): PLAN ADMISSION.
  // A story with at least one non-process testRequirement needs a requirementCoverage map naming a
  // test for every non-process index; without one the post-apply coverage gate can only report each
  // requirement unmapped, after the branch, the baseline and the apply. Refuse BEFORE all of them.
  // Guarded by nonProcessRequirementCount (not hasTestRequirements): a process-only story has no
  // index to map, yet isRequirementCoverageComplete reports a missing map as incomplete. Nothing is
  // applied and no branch exists yet, so there is no rollback and no phase reset (as at skip_tests).
  if (nonProcessRequirementCount > 0) {
    const planCoverage = isRequirementCoverageComplete(storyTestRequirements, plan.requirementCoverage);
    if (!planCoverage.complete) {
      const admissionReason = "plan_requirement_coverage_incomplete";
      const admissionStatus = "test_requirements_uncovered";
      const planRequirementCoverage = plan.requirementCoverage != null ? "incomplete" : "absent";
      const missingIndices = planCoverage.missingIndices;
      const uncoveredRequirements = missingIndices.map((index) => ({ index, text: storyTestRequirements[index], cause: "unmapped" }));
      const admissionRunId = path.basename(runDir);
      console.error(`[rks.exec] ${admissionReason}: plan requirementCoverage is ${planRequirementCoverage}; unmapped non-process testRequirement indices [${missingIndices.join(", ")}]; refusing before apply`);
      const admissionGateWrite = writeCoverageGateRecord({
        runDir,
        record: {
          status: admissionStatus,
          reason: admissionReason,
          adapter: null,
          stage: "plan_admission",
          runId: admissionRunId,
          recordedAt: new Date().toISOString(),
          planRequirementCoverage,
          missingIndices,
          uncoveredRequirements,
        },
      });
      if (!admissionGateWrite.ok) {
        console.error(`[rks.exec] coverage-gate record not written (${admissionGateWrite.error}): ${admissionGateWrite.detail}`);
      }
      ctx.terminalDetail = { problemId: earlyProblemId || null, reason: "plan_requirement_coverage_incomplete", status: admissionStatus, stage: "plan_admission", missingCount: missingIndices.length, durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "test_requirements_uncovered",
        reason: "plan_requirement_coverage_incomplete",
        problemId: earlyProblemId || null,
        planRequirementCoverage,
        missingIndices,
        uncoveredRequirements,
        runFolder: runDir,
        runId: admissionRunId,
        ...(admissionGateWrite.ok ? { coverageGateRecordPath: admissionGateWrite.path } : { coverageGateWriteError: { error: admissionGateWrite.error, detail: admissionGateWrite.detail } }),
        message: `The plan's requirementCoverage map is ${planRequirementCoverage}: ${missingIndices.length} non-process testRequirement(s) (indices ${missingIndices.join(", ")}) are mapped to no test. Nothing was applied and no branch was created.`,
        hint: "Give the story a complete requirementCoverage map, or re-run rks_plan so the plan carries one for every non-process testRequirement, then run rks_exec.",
      };
    }
  }

  // Run baseline tests (must pass before we touch anything)
  // Exception: test-fix stories are allowed to run when tests are failing
  const testFixMode = isTestFixStory(plan, storyTargetFiles);
  // Every baseline skip is VOLUNTEERED on the result (pending_ship / tests_exhausted), not only
  // logged. The skip branches come first so their reasons are fixed before the baseline runs.
  let baselineSkipped = false;
  let baselineSkipReason = null;
  let baselineAbsentPaths = [];
  let baselineTestPaths = null;
  // An explicit baselineRedTests declaration takes precedence over the inferred test-fix
  // exemption: the story then gets the declared-red proof instead of no baseline at all.
  const hasBaselineRedTests = Array.isArray(baselineRedTests) && baselineRedTests.length > 0;
  let baselineRed = null;

  if (skipTests) {
    console.error("[rks.exec] Skipping baseline tests (--skip-tests)");
    // backlog.fix.exec-test-requirements-coverage-gate (Solution step 4): skipTests means no
    // post-apply run, so no requirement can be observed. Refuse BEFORE anything is applied when
    // at least one non-process requirement exists (an all-process story is not refused). Nothing
    // is applied and no branch exists yet, so this returns like the baseline refusal below.
    if (nonProcessRequirementCount > 0) {
      console.error(`[rks.exec] test_requirements_unverifiable (skip_tests): ${nonProcessRequirementCount} testRequirement(s) need an observed passing test; refusing before apply`);
      ctx.terminalDetail = { problemId: earlyProblemId || null, reason: "skip_tests", status: "test_requirements_unverifiable", stage: "skip_tests", durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "test_requirements_unverifiable",
        reason: "skip_tests",
        problemId: earlyProblemId || null,
        nonProcessRequirementCount,
        message: `skipTests was set, but ${nonProcessRequirementCount} testRequirement(s) must each be covered by a test observed passing in the exec run itself. Nothing was applied.`,
        hint: "Re-run rks_exec without skipTests (run it from the base branch, after rks_plan if the plan changed).",
      };
    }
    baselineSkipped = true;
    baselineSkipReason = "skip_tests";
  } else if (hasBaselineRedTests) {
    console.error("[rks.exec] baselineRedTests declared - running declared-red baseline");
  } else if (testFixMode) {
    console.error("[rks.exec] Test-fix story detected - skipping baseline test check");
    baselineSkipped = true;
    baselineSkipReason = "test_fix_exemption";
  }
  if (!baselineSkipped) {
    console.error("[rks.exec] Running baseline tests...");
    const baseline = runPreApplyBaseline({ projectRoot, storyTestFiles, runDir, runTests: runProjectTests, baselineRedTests });
    if (!baseline.proceed) {
      // RETURNED, not thrown: nothing is applied and no branch exists yet, and an ok:false
      // return lands the governed chain in test-failed with a payload the Governor can read.
      // exec.failed is emitted by the terminal-outcome seam in runExecTool from this detail.
      ctx.terminalDetail = {
        problemId: plan.problemId || null,
        reason: baseline.refusal.reason,
        stage: "pre_apply_baseline",
        exitCode: baseline.refusal.exitCode,
        testPaths: baseline.refusal.testPaths,
        durationMs: Date.now() - execStartMs
      };
      return baseline.refusal;
    }
    ({ baselineSkipped, baselineSkipReason, baselineAbsentPaths, baselineTestPaths } = baseline);
    baselineRed = baseline.baselineRed || null;
    if (baselineSkipped) {
      console.error("[rks.exec] Baseline tests skipped:", baselineSkipReason);
    } else if (baselineRed) {
      console.error(`[rks.exec] Declared-red baseline proven (observed failing: ${baselineRed.observedFailing.length}, stale: ${baselineRed.stale.length})`);
    } else {
      console.error("[rks.exec] Baseline tests passed");
    }
  }
  const planPath = path.join(runDir, "plan.yaml");

  // Phase enforcement: a successful rks_plan advances the story to PHASE_GATE_EXEC
  // (v2: "executing" via the exec_start transition); rks_exec runs only from there.
  const problemId = plan?.problemId;
  let preCommands = [];
  // backlog.fix.story-precommands-shell-bypass: ONE command policy object per exec. It classifies the
  // preCommands, runs them, and governs the plan's run_command steps, so a policy file rewritten by
  // an executed preCommand cannot widen a later preCommand or run_command in this exec.
  const execCommandPolicy = loadCommandPolicy(projectRoot);
  if (problemId && !process.env.RKS_SKIP_PHASE_CHECK) {
    try {
      const story = loadStory(projectRoot, problemId);
      const currentPhase = story.frontmatter.phase || "draft";
      if (currentPhase !== PHASE_GATE_EXEC) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `rks.exec: Story phase is "${currentPhase}", expected "${PHASE_GATE_EXEC}" (a successful rks_plan leaves the story at "${PHASE_GATE_EXEC}"). Run/re-run rks_plan; if a prior exec was interrupted, recover with rks_exec_abort.`
        );
      }
      // backlog.fix.exec-start-reset-story-changed-since-arch: the story must still be the story ARCH
      // approved. Throws McpError only (fail closed), which the catch below re-throws.
      const archCheck = assertStoryUnchangedSinceArch(story, problemId);
      // Validate and classify preCommands from frontmatter before any side effect below. A refusal
      // is an McpError, which the catch below re-throws (it cannot be downgraded to a log line).
      preCommands = resolveStoryPreCommands(story.frontmatter.preCommands, { problemId, policy: execCommandPolicy });
      // backlog.fix.precommands-arch-digest-binding: a non-empty preCommands list runs only under a gated,
      // unchanged ARCH approval. Throws McpError only, which the catch below re-throws.
      assertPreCommandsArchGated(preCommands, archCheck, story, problemId);
    } catch (e) {
      if (e instanceof McpError) throw e;
      console.error(`[rks.exec] phase check failed: ${e?.message}`);
    }
  }

  console.error(
    `[rks.exec] project=${projectId} slug=${selectedSlug} run=${runDir}`
  );

  // Verify plan integrity if it was previously reviewed
  // Note: hash was computed BEFORE qualityReview was added, so exclude it
  if (plan.qualityReview?.hash) {
    const { qualityReview, ...planWithoutReview } = plan;
    const currentHash = computePlanHash(planWithoutReview);
    if (currentHash !== plan.qualityReview.hash) {
      ctx.terminalDetail = { problemId: plan.problemId || null, reason: "integrity_failed", durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "integrity_failed",
        message: "Plan modified after quality review. Re-run rks.plan.",
        expectedHash: plan.qualityReview.hash,
        actualHash: currentHash,
      };
    }
  }

  // backlog.fix.exec-working-tree-anchor-assertion: assert the tree is the one the caller
  // verified against.
  //
  // Ordered AFTER the plan-hash gate above, deliberately and pinned by test: if the plan itself
  // drifted, the premise of any tree assertion is already void, so integrity_failed is the
  // honest answer and must win. Positioned before branch creation (checkout -b, further down),
  // so a refusal here leaves the worktree untouched.
  if (expectedAnchor) {
    // computeGitAnchor shells out to git, so it can throw — no repo, git not on PATH, a
    // permissions error. An uncaught throw here would crash exec instead of refusing, turning
    // a verifiable "I cannot confirm the tree" into an opaque stack trace. Fail CLOSED: a null
    // anchor makes compareGitAnchors refuse, which is the right answer when an assertion was
    // requested and cannot be checked.
    let actualAnchor = null;
    try {
      actualAnchor = computeGitAnchor(projectRoot);
    } catch (e) {
      console.error(`[rks.exec] could not compute working-tree anchor: ${e?.message}`);
    }
    const verdict = compareGitAnchors(expectedAnchor, actualAnchor);
    if (!verdict.ok) {
      ctx.terminalDetail = { problemId: plan.problemId || null, reason: "anchor_mismatch", durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "anchor_mismatch",
        // NOT added to EXEC_PHASE_RESET_CARVE_OUTS: an unknown reason is already terminal
        // there, and a tree that is not the asserted tree is not a resumable pause.
        message: `Working tree does not match the asserted anchor: ${verdict.reason}. Re-verify against the current tree, then re-run rks_exec.`,
        expectedAnchor,
        actualAnchor,
        anchorMatch: verdict.match,
      };
    }
    anchorMatch = verdict.match;
  }

  // Run QA Agent review on planned tests (if test files exist in plan)
  const testSteps = (plan.steps || []).filter(s =>
    (s.path || s.target || '').match(/\.(test|spec)\.(mjs|js|ts)$/)
  );
  if (testSteps.length > 0 && !process.env.RKS_SKIP_QA_REVIEW) {
    const { runQaAgentReview } = await import('./qa-agent.mjs');
    const testCode = testSteps.map(s => s.content || '').join('\n\n');
    const implSteps = (plan.steps || []).filter(s =>
      !(s.path || s.target || '').match(/\.(test|spec)\.(mjs|js|ts)$/)
    );
    const implCode = implSteps.map(s => s.content || '').join('\n\n');

    const qaResult = await runQaAgentReview({
      plan,
      tddApplicable: plan.tddApplicable || 'unknown',
      testCode,
      implementationCode: implCode,
      projectId,
    });

    if (qaResult.blocked) {
      ctx.terminalDetail = { problemId: plan.problemId || null, reason: "qa_blocked", durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "qa_blocked",
        message: "QA Agent found exploitable gaps in planned tests",
        exploitableGaps: qaResult.exploitableGaps,
        missingTestCases: qaResult.missingTestCases,
        reasoning: qaResult.reasoning,
        hint: "Address the gaps and re-run rks_plan",
      };
    }

    if (qaResult.verdict === 'warn') {
      console.warn(`[rks.exec] QA Agent warnings: ${qaResult.reasoning}`);
    }
  }

  // Re-run quality check (target files may have changed on disk)
  const qualityRecheck = await reviewPlan({ projectRoot, plan });
  if (!qualityRecheck.ok) {
    ctx.terminalDetail = { problemId: plan.problemId || null, reason: "quality_failed", durationMs: Date.now() - execStartMs };
    return {
      ok: false,
      status: "quality_failed",
      message: "Plan failed quality check at execution time",
      errors: qualityRecheck.errors,
      warnings: qualityRecheck.warnings,
    };
  }

  // Safety net: reject plans containing non-executable steps.
  // The planner's validateStep + retry logic should prevent these from reaching exec,
  // but this guard catches any that slip through.
  const noteSteps = (plan.steps || []).filter(step => !VALID_STEP_TYPES.includes(step.action));
  if (noteSteps.length > 0) {
    const noteDetails = noteSteps.map(s => s.title || s.description || "Unnamed").join(", ");
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Plan contains ${noteSteps.length} non-executable step(s): ${noteDetails}. Run rks_refine to fix the story, then retry rks.plan.`
    );
  }

  // Dry-run mode: preview what would be applied without making changes

  // Dry-run mode: preview what would be applied without making changes
  if (dryRun) {
    console.error("[rks.exec] Dry-run mode - previewing changes without applying");
    // backlog.fix.planned-state-plan-contents-disclosure: shaping lives in describeDryRunStep
    // so it can be tested by behaviour rather than by scanning this file for token spellings.
    const wouldApply = (plan.steps || []).map((s, idx) => describeDryRunStep(s, idx));
    const filesAffected = [...new Set(wouldApply.filter(s => s.file).map(s => s.file))];
    return {
      ok: true,
      status: "dry_run",
      projectId,
      slug: selectedSlug,
      runFolder: runDir,
      stepsCount: plan.steps?.length || 0,
      filesAffected,
      wouldApply,
      message: "Dry-run complete. No files were modified and no branch was created.",
    };
  }

  // Check for guardrail-critical plans - require approval before execution
  const guardrailLevel = plan.guardrail?.id || plan.guardrail?.level || null;
  if (guardrailLevel === "guardrail-critical") {
    console.error("[rks.exec] Guardrail-critical plan detected, creating approval request...");

    // Compute plan hash for integrity verification
    const planContent = fs.readFileSync(planPath, "utf8");
    const planHash = createHash("sha256").update(planContent).digest("hex");

    // Build diff preview from plan steps
    const diff = (plan.steps || []).map((s) => ({
      file: s.path || s.target || null,
      action: s.action || null,
      preview: s.content ? String(s.content).slice(0, 500) : null,
    }));

    // Dry-run mode: return preview without creating approval or applying
    const dryRun = Boolean(typeof options !== "undefined" && options.dryRun);
    if (dryRun) {
      const wouldApply = diff.map((d) => ({
        step: null,
        action: d.action,
        file: d.file,
        diff: d.preview,
      }));
      return {
        status: "dry_run",
        wouldApply,
        warnings: [],
      };
    }

    // Create approval request file
    const approvalsDir = path.join(projectRoot, ".rks", "approvals");
    ensureDir(approvalsDir);
    const approvalFile = path.join(approvalsDir, `${runId}.json`);
    const approvalRequest = {
      planId: runId,
      planHash,
      planPath,
      status: "pending",
      createdAt: new Date().toISOString(),
      diff,
    };
    fs.writeFileSync(approvalFile, JSON.stringify(approvalRequest, null, 2), "utf8");
    console.error(`[rks.exec] Approval request created: ${approvalFile}`);

    // Return needs_approval response instead of throwing
    return {
      ok: false,
      status: "needs_approval",
      guardrail: "guardrail-critical",
      planId: runId,
      planHash,
      diff,
      approveCommand: `rks_approve({ projectId: "${projectId}", planId: "${runId}", confirm: true })`,
    };
  }

  // All precondition checks passed — emit exec.start
  try {
    collector.emit("exec.start", projectId, {
      problemId: plan.problemId || null,
      stepCount: plan.steps?.length || 0,
      planHash: plan.qualityReview?.hash || null,
      branchName: selectedSlug ? `rks/${selectedSlug}` : null,
      runId: runIdValue,
    }, { correlationId });
  } catch (e) { /* telemetry is best-effort */ }

  const guardrailExec = enforceGuardrail("rks.exec", {
    projectRoot,
    slug: selectedSlug,
  });

  let branchName = null;
  const gitRepo = hasGitRepo(projectRoot);
  if (gitRepo && selectedSlug) {
    branchName = `rks/${selectedSlug}`;
    ctx.branchName = branchName;

    // Stage ONLY this story's own note and its child notes, to carry to the
    // feature branch. This was previously `git add notes/` — unscoped, so it
    // staged every dirty note in the repo. Combined with the pathspec-less
    // backup stash below, that reverted sibling stories' notes along with this
    // one's, which is how a story's phase failed to survive exec.
    if (storyNoteExclusions.size > 0) {
      const notesToStage = Array.from(storyNoteExclusions).filter(rel =>
        fs.existsSync(path.join(projectRoot, rel))
      );
      if (notesToStage.length > 0) {
        runGit(projectRoot, ["add", "--", ...notesToStage]);
        console.error(`[rks.exec] staged ${notesToStage.length} story note file(s)`);
      }
    }

    // CRITICAL: Block if baseBranch is protected (main, or staging in 3-branch)
    assertNotProtectedBranch(projectRoot, baseBranch, 'create feature branch from');

    runGit(projectRoot, ["checkout", baseBranch]);

    // Auto-cleanup orphaned self-branch from a prior interrupted build
    const existingBranch = spawnSync("git", ["branch", "--list", branchName], { cwd: projectRoot, encoding: "utf8" });
    if (existingBranch.stdout.trim()) {
      console.error(`[rks.exec] Orphaned branch detected: ${branchName} — auto-cleaning`);
      const cleanup = cleanupFeatureBranch(projectRoot, branchName, baseBranch);
      if (cleanup.refused === true) {
        // backlog.fix.cleanup-feature-branch-unmerged-guard: the orphan carries commits not merged
        // into base (or the check could not run). Refuse; never present a force delete as routine.
        // ctx.branchName is deliberately left set: Region 2's rollback() refuses again and reports
        // the retained branch through its telemetry, receipt and console line.
        try {
          collector.emit("exec.orphaned_branch_refused", projectId, {
            branchName,
            baseBranch,
            refused: true,
            reason: cleanup.reason,
            unmergedCount: cleanup.unmergedCount ?? null,
            unmergedCommits: cleanup.unmergedCommits ?? [],
            checkoutOk: cleanup.checkoutOk,
            branchDeleteOk: cleanup.branchDeleteOk,
          });
        } catch (e) { /* telemetry is best-effort */ }
        const firstShas = (cleanup.unmergedCommits || []).slice(0, 5).map(sha => sha.slice(0, 12)).join(", ");
        const refusalError = cleanup.reason === "unmerged_commits"
          ? `Refused to auto-clean orphaned branch ${branchName}: it carries ${cleanup.unmergedCount} commit(s) not merged into ${baseBranch} (first: ${firstShas}). ` +
            `Inspect them with: git log ${baseBranch}..${branchName} — then ship the branch, rename it, or delete it deliberately before re-running rks_exec.`
          : `Refused to auto-clean orphaned branch ${branchName}: could not check it for commits not merged into ${baseBranch} (${cleanup.unmergedCheckError || "unknown error"}). ` +
            `Inspect it with: git log ${baseBranch}..${branchName} — then ship the branch, rename it, or delete it deliberately before re-running rks_exec.`;
        markExecFailed(runDir, "orphaned_branch_unmerged", refusalError);
        throw new McpError(ErrorCode.InvalidParams, refusalError);
      }
      if (!cleanup.checkoutOk || !cleanup.branchDeleteOk) {
        const cleanupError = `Failed to clean up orphaned branch ${branchName}: checkout=${cleanup.checkoutOk}, delete=${cleanup.branchDeleteOk}. Delete it manually with: git branch -D ${branchName}`;
        markExecFailed(runDir, "orphaned_branch_cleanup", cleanupError);
        throw new McpError(ErrorCode.InvalidParams, cleanupError);
      }
      // Recorded only after git confirmed the delete.
      saveExecState(runDir, { ...execState, orphanedBranchCleaned: branchName });
      try {
        collector.emit("exec.orphaned_branch_cleaned", projectId, { branchName, checkoutOk: cleanup.checkoutOk, branchDeleteOk: cleanup.branchDeleteOk });
      } catch (e) { /* telemetry is best-effort */ }
    }

    updateExecPhase(runDir, ExecPhase.CREATING_BRANCH, { branchName });
    try {
      runGit(projectRoot, ["checkout", "-b", branchName, baseBranch]);
      updateExecPhase(runDir, ExecPhase.APPLYING_STEPS, { branchName });
    } catch (error) {
      markExecFailed(runDir, "branch_creation", error.message);
      throw new McpError(ErrorCode.InternalError, error.message);
    }
  }

  // Create backup before apply for rollback on failure
  let backupMeta = null;
  try {
    // problemId is passed so the stash message carries story attribution — the
    // ISO timestamp alone identifies no run. This is for humans reading
    // `git stash list`; the machine handle is the SHA in backupMeta.stashSha.
    backupMeta = createBackup(projectRoot, storyProblemId);
    ctx.backupMeta = backupMeta;
    console.error(`[rks.exec] Backup created: ${backupMeta.type}${backupMeta.stashCreated ? ` (stash ${backupMeta.stashSha})` : ' (nothing to stash)'}`);
  } catch (err) {
    console.warn(`[rks.exec] Backup failed (continuing without): ${err.message}`);
  }

  // backlog.fix.command-policy-integrity-across-runs: capture the command policy state ONCE, after the
  // feature branch and the backup exist and before any preCommand runs. Every later check compares
  // against it. The policy object loaded earlier (execCommandPolicy) must equal what the captured
  // bytes parse to; otherwise the file was written after that load, and exec refuses before any
  // preCommand runs. No snapshot predates that write, so there is nothing to restore against: the
  // reported parts come from a compare that finds no difference and a restore of those (empty) parts.
  const commandPolicyBaseline = captureCommandPolicyState(projectRoot);
  ctx.commandPolicyBaseline = commandPolicyBaseline;
  if (!isDeepStrictEqual(execCommandPolicy, commandPolicyFromState(commandPolicyBaseline))) {
    const mismatch = compareCommandPolicyState(commandPolicyBaseline, captureCommandPolicyState(projectRoot));
    const mismatchRestore = restoreCommandPolicyState(projectRoot, commandPolicyBaseline, mismatch.parts, {});
    console.error(
      `[rks.exec] command policy mismatch at capture: ${COMMAND_POLICY_RELATIVE_PATH} was written after exec loaded it; ` +
        "refusing before any preCommand runs. The bytes now on disk are LEFT IN PLACE (rollback excludes .routekit and no earlier snapshot exists); inspect the file off-rail."
    );
    emitCommandPolicyChanged(collector, projectId, correlationId, {
      stage: "capture",
      changedParts: mismatch.parts,
      restored: mismatchRestore.restored,
      restoreFailed: mismatchRestore.failed,
      problemId: plan.problemId || null,
    });
    const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession: null, projectId, reason: 'command_policy_changed', correlationId });
    const policyRolledBack = deriveRolledBack(rb);
    return {
      ok: false,
      status: "command_policy_changed",
      error: "exec.command_policy_changed",
      stage: "capture",
      changedParts: mismatch.parts,
      restored: mismatchRestore.restored,
      restoreFailed: mismatchRestore.failed,
      rolledBack: policyRolledBack,
      leftBehind: rb?.leftBehind ?? [],
      recovery: rollbackRecoveryGuidance(rb),
      partialDiffPath: rb?.partialDiffPath ?? null,
      branchRetained: rb?.branchRetained ?? null,
      projectId,
      slug: selectedSlug,
      branch: branchName,
      runFolder: runDir,
      message: `${COMMAND_POLICY_RELATIVE_PATH} changed between exec's policy load and its state capture. Nothing was applied and no preCommand ran; the changed bytes were left on disk.`,
      hint: "Inspect the command policy off-rail, then re-run rks_plan and rks_exec.",
    };
  }

  // Run preCommands before applying file changes
  const preCommandResults = [];
  // Snapshot files BEFORE preCommands so their side effects are excluded from scope check
  const preCommandBaseline = new Set(getUncommittedFiles(projectRoot));

  // backlog.fix.exec-commit-set-protected-paths: the commit the exec branch started from, after the
  // branch exists and the backup was taken. The commit-boundary check before exec stages its commit
  // diffs <execBaseCommit>..HEAD, which is every commit a run_command made during apply. Null in a
  // non-git root or when no rks/ branch was created; the check is skipped then.
  ctx.execBaseCommit = null;
  if (gitRepo && branchName) {
    try {
      ctx.execBaseCommit = runGit(projectRoot, ["rev-parse", "HEAD"]) || null;
    } catch (err) {
      console.error(`[rks.exec] could not record the exec base commit: ${err.message}`);
    }
  }

  // Scope exemptions shared by BOTH guards: this story's own notes, plus
  // everything already dirty at this point.
  //
  // Captured HERE — after createBackup — deliberately. The backup has just
  // stashed all non-notes dirt, so what remains is notes-shaped by
  // construction. Moving this capture earlier, to a "genuinely pre-exec" point,
  // would exempt non-note dirt the stash was about to remove and punch a hole
  // in the very guard this change tightens.
  const scopeExemptions = new Set([...storyNoteExclusions, ...preCommandBaseline]);
  if (preCommands.length > 0) {
    console.error(`[rks.exec] Running ${preCommands.length} preCommand(s)...`);
    preCommandResults.push(...(await runStoryPreCommands(preCommands, { projectRoot, policy: execCommandPolicy })));
  }
  // Capture files generated by preCommands (e.g., package-lock.json from npm install)
  const postPreCommandFiles = new Set(getUncommittedFiles(projectRoot));
  const preCommandGeneratedFiles = new Set(
    [...postPreCommandFiles].filter(f => !preCommandBaseline.has(f))
  );
  if (preCommandGeneratedFiles.size > 0) {
    console.error(`[rks.exec] preCommand generated ${preCommandGeneratedFiles.size} file(s): ${[...preCommandGeneratedFiles].join(', ')}`);
  }

  // backlog.fix.command-policy-integrity-across-runs: a preCommand is code the story runs. A policy
  // change it made is restored FIRST (still on the rks/ branch, so a preCommand commit can be reset),
  // then rolled back; guardrails are not off yet, so no session is passed.
  const preCommandPolicyCheck = checkCommandPolicyIntegrity(projectRoot, commandPolicyBaseline, {
    allowHeadReset: commandPolicyHeadResetAllowed(projectRoot),
  });
  if (preCommandPolicyCheck.changed) {
    console.error(`[rks.exec] policy integrity: preCommands changed ${COMMAND_POLICY_RELATIVE_PATH} (${describePolicyParts(preCommandPolicyCheck.changedParts)}); restored [${describePolicyParts(preCommandPolicyCheck.restored)}], failed [${describePolicyParts(preCommandPolicyCheck.restoreFailed)}]. Rolling back...`);
    emitCommandPolicyChanged(collector, projectId, correlationId, {
      stage: "pre_commands",
      changedParts: preCommandPolicyCheck.changedParts,
      restored: preCommandPolicyCheck.restored,
      restoreFailed: preCommandPolicyCheck.restoreFailed,
      problemId: plan.problemId || null,
    });
    const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession: null, projectId, reason: 'command_policy_changed', correlationId });
    const policyRolledBack = deriveRolledBack(rb);
    return {
      ok: false,
      status: "command_policy_changed",
      error: "exec.command_policy_changed",
      stage: "pre_commands",
      changedParts: preCommandPolicyCheck.changedParts,
      restored: preCommandPolicyCheck.restored,
      restoreFailed: preCommandPolicyCheck.restoreFailed,
      rolledBack: policyRolledBack,
      leftBehind: rb?.leftBehind ?? [],
      recovery: rollbackRecoveryGuidance(rb),
      partialDiffPath: rb?.partialDiffPath ?? null,
      branchRetained: rb?.branchRetained ?? null,
      preCommandResults,
      projectId,
      slug: selectedSlug,
      branch: branchName,
      runFolder: runDir,
      message: `A story preCommand changed ${COMMAND_POLICY_RELATIVE_PATH}. No plan step was applied; the policy was restored where possible ${policyRolledBack ? "and the run rolled back." : "but rollback did NOT fully restore the tree; see recovery and leftBehind."}`,
      hint: "Remove the policy-changing preCommand from the story (edit the command policy off-rail if a change is intended), then re-run rks_plan and rks_exec.",
    };
  }

  // Toggle guardrails off for apply phase
  const planTargetFilesForScope = (plan.steps || []).map(s => s.target || s.path).filter(Boolean);
  let guardrailsSession = null;
  const offRailStartTime = Date.now();
  try {
    guardrailsSession = await guardrailsOff(
      projectRoot,
      `exec: applying plan ${selectedSlug}`,
      "all",
      plan.problemId || null,
      projectId
    );
    ctx.guardrailsSession = guardrailsSession;
    collector.emit("exec.guardrails_off", projectId, {
      problemId: plan.problemId || null,
      // Observability only: the declared run_command outputs are reported here, NOT unioned into
      // planTargetFilesForScope, which also feeds the Layer D pre-apply snapshot below.
      targetFiles: [...new Set([...planTargetFilesForScope, ...planDeclaredOutputs(plan.steps || [])])],
      branchName,
      planHash: plan.qualityReview?.hash || null,
      stepCount: plan.steps?.length || 0,
      correlationId,
    });
  } catch (e) {
    console.warn(`[rks.exec] guardrailsOff failed (continuing): ${e.message}`);
  }

  // Layer D input (backlog.fix.test-static-analysis-false-blocks): snapshot the PRE-APPLY
  // content of every test file the plan targets, so Layer D can derive each applied test
  // file's changed lines from an observed diff instead of analysing the whole file.
  const { capturePreApplyTestSnapshot, LAYER_D_TEST_FILE_PATTERN } = await import('./test-static-analysis.mjs');
  const preApplyTestSnapshot = capturePreApplyTestSnapshot(
    projectRoot,
    planTargetFilesForScope.filter(f => LAYER_D_TEST_FILE_PATTERN.test(f))
  );

  const applyResult = await runApplyTool({
    projectId,
    label: selectedSlug,
    _execContext: true,  // Signal we're in exec context
    // backlog.fix.story-precommands-shell-bypass: the same policy object the preCommands ran under.
    policy: execCommandPolicy,
    // backlog.fix.dependency-add-contract-executable: the per-step guard INSIDE runApplyTool needs
    // this to apply the same exemptions as the final guard. It is a local of runExecToolInner, so
    // runApplyTool could not see it — and silently never exempted what the final guard did.
    preCommandGeneratedFiles,
    // backlog.fix.command-policy-integrity-across-runs: the per-step policy check compares against
    // the state this exec captured, not one captured inside apply.
    commandPolicyBaseline,
    // Same class of defect, same fix: the per-step guard builds its own
    // modifiedFiles from the working tree, so it sees the dirty story note on
    // every step. Threading this into the final guard alone would make exec
    // bail on 'exec.diverged' before the final guard ever runs.
    scopeExemptions,
    // backlog.fix.exec-apply-stop-restores-base-branch-and-backup: the in-apply rollbacks need the
    // run's real branch, base branch and backup. guardrailsSession is NOT passed: guardrails are
    // re-enabled below, once, on the propagation path.
    branchName,
    baseBranch,
    backupMeta,
  });

  // Per-step divergence or command policy change detected inside runApplyTool — propagate immediately
  if (applyResult.error === "exec.diverged" || applyResult.error === "exec.command_policy_changed") {
    if (guardrailsSession?.ok) {
      const guardrailsRestore = await reenableGuardrailsAfterExec({
        guardrailsOn,
        collector,
        projectRoot,
        projectId,
        payload: { problemId: plan.problemId || null, path: applyResult.error === "exec.command_policy_changed" ? "command_policy_changed" : "divergence", correlationId },
      });
      if (guardrailsRestore.ok !== true) {
        console.warn(`[rks.exec] guardrailsOn failed on divergence path: ${guardrailsRestore.reason}`);
        applyResult.guardrailsRestore = guardrailsRestore;
        applyResult.guardrailsWarning = guardrailsRestoreWarning(guardrailsRestore);
      }
    }
    return applyResult;
  }

  let appliedFiles = applyResult.appliedFiles || [];
  let stepsApplied = applyResult.stepsApplied || 0;

  // NOTE: the scope guard used to run HERE. It now runs AFTER the dependency
  // install below — see "GOVERNANCE: Verify scope" further down. Running it here
  // meant it audited a tree exec was about to mutate: `npm install` rewrote
  // package-lock.json afterwards, and nothing re-checked, so the lockfile was
  // left dirty and uncommitted and ship's preflight refused the result.

  // GOVERNANCE: Verify test files unchanged (unless this is a test-fix story)
  if (!isTestFixStory(plan) && testFileHashes.size > 0) {
    for (const [filePath, originalHash] of testFileHashes) {
      if (fs.existsSync(filePath)) {
        const currentContent = fs.readFileSync(filePath, 'utf8');
        const currentHash = createHash('sha256').update(currentContent).digest('hex');
        if (currentHash !== originalHash) {
          console.error(`[rks.exec] TEST FILE MODIFIED: ${filePath}`);
          const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'test_file_modified', correlationId });
          return {
            ok: false,
            rolledBack: deriveRolledBack(rb),
            leftBehind: rb?.leftBehind ?? [],
            recovery: rollbackRecoveryGuidance(rb),
            partialDiffPath: rb.partialDiffPath,
            branchRetained: rb?.branchRetained ?? null,
            error: 'Test file modified without authorization',
            file: filePath,
            hint: 'Tests should not be modified unless the story explicitly targets them. ' + (deriveRolledBack(rb) ? 'Changes have been rolled back.' : 'Rollback did not fully restore the tree; see recovery.')
          };
        }
      }
    }
    console.error(`[rks.exec] Test file integrity verified (${testFileHashes.size} files unchanged)`);
  }

  // Layer D: Static analysis on test files before running tests
  // Same admission set as the pre-apply snapshot above (backlog.fix.layer-d-input-filter-omits-tsx-jsx-cjs-mts).
  const testFilesApplied = appliedFiles.filter(f => LAYER_D_TEST_FILE_PATTERN.test(f));
  // Always present on the success result, empty when nothing applies (ARCH R9,
  // decision 2026-10-03), so an absent report is never ambiguous.
  let staticAnalysis = { nonBlockingIssues: [], wholeFileFallbackFiles: [] };
  if (testFilesApplied.length > 0 && !process.env.RKS_SKIP_STATIC_ANALYSIS) {
    const { analyzeTestQuality, deriveChangedLinesForFiles, buildStaticAnalysisReport } = await import('./test-static-analysis.mjs');
    // Diff scoping: a critical finding blocks only on a line this run changed. A file
    // whose changed lines cannot be derived gets no set and is analysed whole-file
    // (fail closed) — and is reported as a fallback below.
    const { changedLinesByFile, wholeFileFallbackFiles } = deriveChangedLinesForFiles(
      projectRoot, testFilesApplied, preApplyTestSnapshot
    );
    const staticResult = analyzeTestQuality(projectRoot, testFilesApplied, changedLinesByFile);
    // console.warns each whole-file fallback and each non-blocking issue (file, line, type).
    staticAnalysis = buildStaticAnalysisReport(staticResult, wholeFileFallbackFiles);

    if (!staticResult.ok) {
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'static_analysis_failed', correlationId });
      // TWO receipts, deliberately. `rb.intervention` says the tree was
      // restored; the analyzer receipt says WHY the gate fired, and carries the
      // enriched issues — each with a line and a snippet, so the operator does
      // not have to grep the file to find what tripped it.
      const gateReceipt = recordIntervention(projectRoot, {
        kind: 'analyzer_gate',
        cause: 'static_analysis_failed',
        files: testFilesApplied,
        issues: staticResult.issues,
        warnings: staticResult.warnings,
      });
      return {
        ok: false,
        status: 'static_analysis_failed',
        message: 'Test quality issues detected by static analysis',
        issues: staticResult.issues,
        warnings: staticResult.warnings,
        summary: staticResult.summary,
        staticAnalysis,
        rolledBack: deriveRolledBack(rb),
        leftBehind: rb?.leftBehind ?? [],
        recovery: rollbackRecoveryGuidance(rb),
        partialDiffPath: rb.partialDiffPath,
        branchRetained: rb?.branchRetained ?? null,
        intervention: gateReceipt,
        rollbackIntervention: rb.intervention ?? null,
        hint: 'Fix the test quality issues and re-run rks_exec',
      };
    }

    // Log warnings but don't block
    if (staticResult.warnings.length > 0) {
      console.warn(`[rks.exec] Static analysis warnings: ${staticResult.warnings.length}`);
      for (const w of staticResult.warnings.slice(0, 3)) {
        console.warn(`  - ${w.file}: ${w.message}`);
      }
    }
  }

  // Install declared dependencies before running tests. A plan that adds a dependency (e.g. a test
  // runner like vitest) writes package.json, but nothing else installs it — so the post-apply test
  // phase would die on "Cannot find package ...". Run a bounded, best-effort `npm install` when the
  // plan touched package.json (or node_modules is missing), in the governed flow — no off-rail
  // detour. Non-fatal: a failed/slow install just lets the test phase surface the real error.
  // See backlog.fix.exec-post-apply-npm-install.
  // Files the install itself writes, so they can be BOTH exempted from the scope
  // guard and committed with the plan's own files. Previously the manifest set
  // was a guard exemption only — never merged into appliedFiles, never staged —
  // so a lockfile the install rewrote was recognised as derived, waved past the
  // guard, excluded from the commit, and then fatal to ship's preflight.
  const installDerived = new Set();
  if (shouldInstallDeps(appliedFiles, projectRoot)) {
    const installStart = Date.now();
    const preInstallDirty = new Set(getUncommittedFiles(projectRoot));
    console.error("[rks.exec] package.json changed (or node_modules missing) — installing dependencies before tests...");
    let installOk = false;
    try {
      const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: projectRoot, timeout: 180000, encoding: "utf8",
      });
      installOk = r.status === 0;
      if (installOk) {
        console.error("[rks.exec] dependencies installed.");
      } else {
        console.warn(`[rks.exec] npm install exited ${r.status ?? "(timeout/signal)"} — proceeding; the test phase will surface any unresolved dependency.\n${(r.stderr || "").slice(0, 500)}`);
      }
    } catch (e) {
      console.warn(`[rks.exec] npm install failed to spawn: ${e?.message} — proceeding to tests.`);
    }
    try { collector.emit("exec.deps_installed", projectId, { installed: true, ok: installOk, durationMs: Date.now() - installStart }); } catch { /* telemetry best-effort */ }

    // The install-window delta, INTERSECTED with the known dependency manifests.
    // The intersection is what keeps this narrow: an arbitrary file the install
    // happened to dirty is NOT swept in — only a manifest or lockfile is. This
    // is deliberately keyed on the delta rather than on the filename alone, so
    // a lockfile that was already dirty before exec keeps its existing
    // disposition instead of being silently adopted.
    for (const f of getUncommittedFiles(projectRoot)) {
      if (!preInstallDirty.has(f) && DEPENDENCY_MANIFEST_FILES.has(f)) installDerived.add(f);
    }
    if (installDerived.size > 0) {
      console.error(`[rks.exec] install wrote ${installDerived.size} derived file(s): ${[...installDerived].join(', ')}`);
    }
  }

  // GOVERNANCE: Verify scope - only expected files should be modified.
  //
  // RELOCATED (backlog.fix.exec-derived-files-commit): this runs AFTER the
  // dependency install, so it audits the POST-install tree rather than one exec
  // is about to mutate. It must stay ahead of the test loop below.
  //
  // backlog.fix.dependency-add-contract-executable: ONE rule, shared with the per-step guard inside
  // runApplyTool (which used to be a separate copy that silently disagreed with this one). A
  // `run_command` step has no target/path, so an `npm install` the plan was TOLD to emit wrote
  // package.json + package-lock.json straight into unexpectedFiles — and exec rolled back the plan
  // for following its own instructions. The rule exempts those writes only when the plan genuinely
  // declares a dependency-add step; a blanket filename pass would be a hole in this guard.
  const expectedFiles = new Set((plan.steps || []).map(s => s.target || s.path).filter(Boolean));
  const modifiedFiles = getUncommittedFiles(projectRoot);
  const unexpectedFiles = computeUnexpectedFiles({
    steps: plan.steps || [],
    modifiedFiles,
    expectedFiles,
    preCommandGeneratedFiles,
    // scopeExemptions is spread BY NAME. It carries the sibling story's
    // story-note and pre-exec-baseline exemptions; dropping it here would
    // silently revert that fix. Do NOT re-capture the baseline at this point —
    // the set is intentionally the one captured before any step ran.
    scopeExemptions: new Set([...scopeExemptions, ...installDerived]),
  });
  if (unexpectedFiles.length > 0) {
    console.error(`[rks.exec] SCOPE VIOLATION: Unexpected files modified: ${unexpectedFiles.join(', ')}`);
    const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'scope_violation', correlationId });
    return {
      ok: false,
      rolledBack: deriveRolledBack(rb),
      leftBehind: rb?.leftBehind ?? [],
      recovery: rollbackRecoveryGuidance(rb),
      partialDiffPath: rb.partialDiffPath,
      branchRetained: rb?.branchRetained ?? null,
      error: 'Scope violation - unexpected files modified',
      expectedFiles: [...expectedFiles],
      unexpectedFiles,
      hint: 'Plan modified files outside its declared scope. ' + (deriveRolledBack(rb) ? 'Changes have been rolled back.' : 'Rollback did not fully restore the tree; see recovery.')
    };
  }

  // Track attempts for retry logic
  let attemptNumber = 1;
  // backlog.feat.exec-plan-commit-linkage (AC3): fix plans the retry loop actually applied, in
  // attempt order, recorded in the plan archive beside the plan.
  const appliedFixPlans = [];
  let testsPassed = false;
  let testsSkipped = false;
  let lastVerification = null;
  // backlog.feat.exec-test-result-persistence: the test check, computed ONCE after the verification
  // loop and shared verbatim by run.json, exec.complete and the pending_ship return. null when tests
  // were skipped or never ran. Counts, exitCode and command are observed or null, never 0.
  let testVerification = null;
  // backlog.fix.exec-write-record-revert-and-containment-followups (d): the refusal applyFixPlan
  // returned in the test-retry loop, { attempt, error }, sourced only from fixResult.error. null
  // (and the result field absent) when no fix plan was refused.
  let fixApplyRefusal = null;
  let lastTestLogPath = null;
  const testStartTime = Date.now();

  // Declared-red post-apply proof: per-test entries make every verification run collect results,
  // and each declared id must be observed passed. The decision is evaluateDeclaredPostApply's.
  const baselineRedPerTest = hasBaselineRedTests && baselineRedTests.some(e => parseDeclaredEntry(e).testId);
  // backlog.fix.exec-test-requirements-coverage-gate (Solution step 3): a story with non-empty
  // testRequirements also collects per-test results, so the coverage gate can observe each
  // requirement test. A story with neither gets no collect option (argv unchanged, AC9).
  const verifyCollectOptions = (attempt) => (baselineRedPerTest || hasTestRequirements
    ? { collectTestResults: { reportDir: runDir, reportName: `verify-test-results-${attempt}.json` } }
    : {});
  let baselineRedPostApply = null;
  // The baselineRed record for a result: sourced only from observed runs, null when undeclared.
  const baselineRedResult = () => (hasBaselineRedTests
    ? { ...(baselineRed || { declared: baselineRedTests, granularity: null, runner: null, resultsSource: null, observedFailing: null, stale: null }), postApply: baselineRedPostApply }
    : null);

  // Set when a verification run selected zero test files (backlog.fix.exec-scoped-tests-integration-config-routing).
  let noTestsFoundPaths = null;
  let noTestsFoundLogPath = null;
  // Set when the verification run exited 0 but executed zero tests (a proven-empty run). Such a
  // run carries noTestsFound too, so it takes the same non-refinable exit below.
  let noTestsExecuted = false;
  // The run-folder copy of a passing verification's output; set only once the write is observed.
  let testsPassedLogPath = null;

  // Run verification tests after apply (with retry loop)
  if (!skipTests && appliedFiles.length > 0) {
    while (attemptNumber <= MAX_RETRY_ATTEMPTS + 1) {
      console.error(`[rks.exec] Running verification tests (attempt ${attemptNumber})...`);
      const verification = runProjectTests(projectRoot, { testPaths: storyTestFiles, ...verifyCollectOptions(attemptNumber) });
      lastVerification = verification;
      let declaredNotPassing = [];

      // The runner selected NO test files: nothing executed, so this is neither a pass nor a
      // failure a fix plan could repair. End the loop here — never reaching generateFixPlan —
      // and exit non-refinably below, naming the unmatched paths.
      if (verification.noTestsFound) {
        noTestsFoundPaths = Array.isArray(verification.noTestsFoundPaths) && verification.noTestsFoundPaths.length > 0
          ? verification.noTestsFoundPaths
          : (storyTestFiles || []);
        noTestsExecuted = verification.noTestsExecuted === true;
        console.error(noTestsExecuted
          ? `[rks.exec] Verification exited 0 but executed no tests (${verification.summary || "no tests executed"}) for: ${noTestsFoundPaths.join(", ")}`
          : `[rks.exec] Verification selected no test files for: ${noTestsFoundPaths.join(", ")}`);
        const logPath = path.join(runDir, "tests-no-tests-found.log");
        try {
          fs.writeFileSync(logPath, `${verification.summary || ""}\nunmatched: ${noTestsFoundPaths.join(", ")}\n${verification.output || ""}`);
          noTestsFoundLogPath = logPath;
        } catch (err) {
          console.warn(`[rks.exec] Failed to write no-tests-found log: ${err.message}`);
        }
        break;
      }

      if (verification.skipped) {
        console.error("[rks.exec] Verification tests skipped:", verification.reason);
        if (!hasBaselineRedTests) {
          testsSkipped = true;
          break;
        }
        // A skipped verification never proves a declared-red test now passes: it is a failed
        // attempt, on the same retry path as any other.
        ({ declaredNotPassing } = evaluateDeclaredPostApply({ entries: baselineRedTests, results: null, verificationSkipped: true }));
        baselineRedPostApply = { ran: true, attempts: attemptNumber, declaredPassed: [], declaredNotPassing };
      } else if (hasBaselineRedTests) {
        const postApply = evaluateDeclaredPostApply({ entries: baselineRedTests, results: verification.testResults, verificationSkipped: false });
        declaredNotPassing = postApply.declaredNotPassing;
        baselineRedPostApply = { ran: true, attempts: attemptNumber, declaredPassed: postApply.declaredPassed, declaredNotPassing };
      }

      if (verification.passed && declaredNotPassing.length === 0) {
        console.error(`[rks.exec] Verification tests passed (attempt ${attemptNumber})`);
        testsPassed = true;
        // The evidence behind testsPassed, kept in the run folder. A separate variable from
        // lastTestLogPath (the failure log); the path is recorded only once the file is observed.
        const passLogPath = path.join(runDir, "tests-passed.log");
        try {
          fs.writeFileSync(passLogPath, verification.output || "");
          if (fs.existsSync(passLogPath)) testsPassedLogPath = passLogPath;
        } catch (err) {
          console.warn(`[rks.exec] Failed to write passing test log: ${err.message}`);
        }
        updateExecPhase(runDir, ExecPhase.COMMITTING, { testsPassed: true });
        break;
      }

      // Tests failed - log the failure. A declared id that did not pass is named ahead of the
      // output, so the log and both handoffs (fix plan, refine) carry it.
      if (declaredNotPassing.length > 0) {
        console.error(`[rks.exec] Declared-red tests not passing: ${declaredNotPassing.map(d => `${d.id} (${d.outcome})`).join(", ")}`);
        verification.output = formatDeclaredNotPassing(declaredNotPassing, verification.output);
      }
      const testLogPath = path.join(runDir, attemptNumber === 1 ? "tests-failed.log" : `tests-failed-attempt-${attemptNumber}.log`);
      try {
        fs.writeFileSync(testLogPath, verification.output || "Tests failed (no output captured)");
        console.error(`[rks.exec] Test output written to ${testLogPath}`);
        lastTestLogPath = testLogPath;
      } catch (err) {
        console.warn(`[rks.exec] Failed to write test log: ${err.message}`);
      }

      // Check if we have retries left
      if (attemptNumber > MAX_RETRY_ATTEMPTS) {
        console.error(`[rks.exec] Max retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded. Giving up.`);
        break;
      }

      // Generate fix plan
      console.error(`[rks.exec] Tests failed, generating fix plan (retry ${attemptNumber} of ${MAX_RETRY_ATTEMPTS})...`);
      const fixPlan = await generateFixPlan({
        projectRoot,
        runDir,
        originalPlan: plan,
        appliedFiles,
        testOutput: verification.output || "",
        attemptNumber,
      });

      if (!fixPlan || !fixPlan.steps || fixPlan.steps.length === 0) {
        console.warn("[rks.exec] Fix plan generation failed or returned empty plan. Giving up.");
        break;
      }

      // Apply fix plan
      console.error(`[rks.exec] Applying fix plan (${fixPlan.steps.length} steps)...`);
      const fixResult = await applyFixPlan({
        projectId,
        projectRoot,
        plan: fixPlan,
        runDir,
        attemptNumber: attemptNumber + 1,
      });

      if (!fixResult.ok) {
        console.error(`[rks.exec] Fix plan apply failed: ${fixResult.error}`);
        fixApplyRefusal = { attempt: attemptNumber + 1, error: fixResult.error };
        break;
      }

      appliedFixPlans.push(fixPlan);

      // Track additional files modified by fix plan
      for (const f of fixResult.appliedFiles || []) {
        if (!appliedFiles.includes(f)) {
          appliedFiles.push(f);
        }
      }
      stepsApplied += fixResult.stepsApplied || 0;

      attemptNumber++;
    }

    testVerification = buildTestVerification({
      testsSkipped,
      testsPassed,
      lastVerification,
      durationMs: Date.now() - testStartTime,
      attempts: attemptNumber,
    });

    // Update run.json with attempt tracking
    const runJsonPath = path.join(runDir, "run.json");
    let runMeta = {};
    if (fs.existsSync(runJsonPath)) {
      try {
        runMeta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      } catch {
        runMeta = {};
      }
    }
    runMeta.attempts = attemptNumber;
    runMeta.testsPassed = testsPassed;
    runMeta.testsSkipped = testsSkipped;
    // Same variables the pending_ship return carries, so the persisted values equal the returned ones.
    runMeta.testVerification = testVerification;
    if (fixApplyRefusal) runMeta.fixApplyRefusal = fixApplyRefusal;
    runMeta.baselineSkipped = baselineSkipped;
    runMeta.baselineSkipReason = baselineSkipReason;
    if (testsPassed && testsPassedLogPath) {
      runMeta.paths = runMeta.paths || {};
      runMeta.paths.testsPassedLog = testsPassedLogPath;
    }
    if (!testsPassed && lastTestLogPath) {
      runMeta.paths = runMeta.paths || {};
      runMeta.paths.testsFailedLog = lastTestLogPath;
    }
    if (noTestsFoundPaths) {
      runMeta.noTestsFound = true;
      runMeta.noTestsFoundPaths = noTestsFoundPaths;
    }
    fs.writeFileSync(runJsonPath, JSON.stringify(runMeta, null, 2));

    // No test files selected: same rollback as the tests-failed exit below, but a distinct,
    // non-refinable outcome — no fix plan, no refine, and not reported as testsFailed.
    if (noTestsFoundPaths) {
      console.error(`[rks.exec] No test files found for ${noTestsFoundPaths.join(", ")}. Rolling back...`);
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'no_tests_found', correlationId });

      if (runDir) {
        const applyLogPath = path.join(runDir, "apply", "apply.log");
        try {
          ensureDir(path.dirname(applyLogPath));
          fs.appendFileSync(applyLogPath, `\n[rollback] ${new Date().toISOString()} - ${JSON.stringify(rb)}\n`);
        } catch (logErr) {
          console.warn(`[rks.exec] Failed to write rollback to apply.log: ${logErr.message}`);
        }
      }

      const problemId = plan.problemId || plan.problemPath?.replace(/^notes\//, "").replace(/\.md$/, "");
      resetStalePhaseToArchApproved(projectRoot, problemId);

      const rolledBack = deriveRolledBack(rb);
      ctx.terminalDetail = {
        noTestsFound: true,
        reason: "no_tests_found",
        noTestsFoundPaths,
        attempts: attemptNumber,
        stepsApplied,
        durationMs: Date.now() - execStartMs
      };
      return {
        ok: false,
        testsFailed: false,
        noTestsFound: true,
        reason: "no_tests_found",
        noTestsFoundPaths,
        noTestsExecuted,
        rolledBack,
        leftBehind: rb?.leftBehind ?? [],
        recovery: rollbackRecoveryGuidance(rb),
        partialDiffPath: rb?.partialDiffPath ?? null,
        projectId,
        slug: selectedSlug,
        branch: branchName,
        runFolder: runDir,
        runId: path.basename(runDir),
        stepsApplied,
        appliedFiles,
        attempts: attemptNumber,
        rollback: rb,
        refinementSuggestions: [],
        directive: "NO TEST FILES FOUND - NOT REFINABLE",
        hint: (noTestsExecuted
          ? `The test run exited 0 but executed zero tests for: ${noTestsFoundPaths.join(", ")}. `
          : `The test runner selected no test files for: ${noTestsFoundPaths.join(", ")}. `)
          + `Nothing was verified, so this is not a test failure and refining the story cannot fix it — `
          + `fix the testFiles paths or the runner config.${rolledBack ? " Rollback applied." : ""}`,
        noTestsFoundLog: noTestsFoundLogPath,
        baselineSkipped,
        baselineSkipReason,
        baselineAbsentPaths,
        baselineTestPaths,
        baselineRed: baselineRedResult(),
      };
    }

    // If tests still failing after retries, attempt rollback and return failure
    if (!testsPassed && !testsSkipped) {
      console.error(`[rks.exec] Tests failed after ${attemptNumber} attempts. Rolling back...`);
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'test_failure', correlationId });

      // Log rollback to apply.log
      if (runDir) {
        const applyLogPath = path.join(runDir, "apply", "apply.log");
        try {
          ensureDir(path.dirname(applyLogPath));
          fs.appendFileSync(applyLogPath, `\n[rollback] ${new Date().toISOString()} - ${JSON.stringify(rb)}\n`);
        } catch (logErr) {
          console.warn(`[rks.exec] Failed to write rollback to apply.log: ${logErr.message}`);
        }
      }

      const problemId = plan.problemId || plan.problemPath?.replace(/^notes\//, "").replace(/\.md$/, "");

      // Re-plannability: a test-failed rollback must NOT leave the story stranded at
      // 'executing' (excluded from PLANNABLE_PHASES) — that wedges every subsequent re-plan
      // with state_transition_failed. Reset to 'arch-approved' so the story is re-plannable.
      resetStalePhaseToArchApproved(projectRoot, problemId);

      // Attempt to get refinement suggestions
      let refinementSuggestions = null;
      if (problemId) {
        try {
          const refineResult = await runRefineTool({
            projectRoot,
            problemId,
            trigger: "test_failed",
            context: `Tests failed after ${attemptNumber} attempt(s)`,
            testOutput: lastVerification?.output || "",
            projectId,
          });
          if (refineResult?.ok && refineResult?.suggestions?.length > 0) {
            refinementSuggestions = refineResult.suggestions;
          }
        } catch (e) {
          console.error(`[exec] refinement analysis failed: ${e?.message}`);
        }
      }

      ctx.terminalDetail = {
        testsFailed: true,
        reason: "tests_exhausted",
        attempts: attemptNumber,
        stepsApplied,
        durationMs: Date.now() - execStartMs
      };
      return {
        ok: false,
        testsFailed: true,
        rolledBack: deriveRolledBack(rb),
        leftBehind: rb?.leftBehind ?? [],
        recovery: rollbackRecoveryGuidance(rb),
        partialDiffPath: rb.partialDiffPath,
        projectId,
        slug: selectedSlug,
        branch: branchName,
        runFolder: runDir,
        runId: path.basename(runDir),
        stepsApplied,
        appliedFiles,
        attempts: attemptNumber,
        rollback: rb,
        refinementSuggestions,
        ...(fixApplyRefusal ? { fixApplyRefusal } : {}),
        directive: "TESTS FAILED - FIX REQUIRED",
        requiredActions: [
          "1. Triage: Analyze failures in tests-failed*.log to identify root cause",
          "2. Fix: Apply fix (in current story or create blocking bug story)",
          "3. Re-test: Run rks_exec again to verify fix",
          "4. Loop: Repeat until all tests pass - do NOT ship until green"
        ],
        warning: "Do NOT ship until all tests pass. If fix requires a separate story, that story is part of THIS delivery package - both ship together.",
        hint: `Tests failed after ${attemptNumber} attempt(s). See tests-failed*.log for details.${deriveRolledBack(rb) ? " Rollback applied." : " Rollback did not fully restore the tree; see recovery."}`,
        testsFailedLog: lastTestLogPath || null,
        baselineSkipped,
        baselineSkipReason,
        baselineAbsentPaths,
        baselineTestPaths,
        baselineRed: baselineRedResult(),
      };
    }
  } else {
    // Verification did not run: postApply says so, and carries no declared* keys.
    baselineRedPostApply = { ran: false, notRunReason: skipTests ? "skip_tests" : "no_files_applied" };
    if (skipTests) {
      console.error("[rks.exec] Skipping verification tests (--skip-tests)");
      testsSkipped = true;
    }
  }

  // backlog.fix.exec-test-requirements-coverage-gate (Solution step 5): THE COVERAGE GATE.
  //
  // Runs after the verification loop and BEFORE anything is staged or committed. Every
  // non-process testRequirement must resolve, through the requirementCoverage map of the ORIGINAL plan
  // (a fix plan never replaces it), to exactly one test observed `passed` in the passing
  // post-apply run. A refusal rolls back and resets the phase like the test-failure exit above,
  // so the story stays re-plannable; nothing is committed and the phase is never advanced.
  // Neither the verdict of the exec QA agent nor any reviewer verdict is an input here.
  let requirementCoverageEvaluation = null;
  if (hasTestRequirements) {
    const coverageSkipReason = skipTests
      ? "skip_tests"
      : (!lastVerification ? "no_files_applied" : (testsSkipped ? "verification_skipped" : null));
    const coverageResults = lastVerification?.testResults || null;
    let coveragePolicy = null;
    if (!coverageSkipReason && !coverageResults?.available) {
      // The results-unavailable branch: the ONLY place the per-project waiver is consulted.
      coveragePolicy = resolveUnverifiedCoveragePolicy(projectRoot);
    }
    requirementCoverageEvaluation = evaluateRequirementCoverage({
      testRequirements: storyTestRequirements,
      requirementCoverage: plan.requirementCoverage,
      results: coverageResults,
      verificationSkipped: Boolean(coverageSkipReason),
      verificationSkipReason: coverageSkipReason,
      policy: coveragePolicy,
    });
    if (requirementCoverageEvaluation.outcome === "unverified") {
      console.error(`[rks.exec] testRequirementCoverage.acceptUnverified waiver used: per-test results unavailable (${requirementCoverageEvaluation.unverified.reason}); recording coverage as UNVERIFIED, not covered`);
    }
    if (!requirementCoverageEvaluation.ok) {
      const coverageStatus = requirementCoverageEvaluation.status;
      const coverageSummary = requirementCoverageEvaluation.outcome === "uncovered"
        ? requirementCoverageEvaluation.uncoveredRequirements.map((u) => "#" + u.index + " (" + u.cause + ")").join(", ")
        : requirementCoverageEvaluation.reason;
      console.error(`[rks.exec] ${coverageStatus}: ${coverageSummary}. Rolling back...`);
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: coverageStatus, correlationId });
      const coverageProblemId = plan.problemId || plan.problemPath?.replace(/^notes\//, "").replace(/\.md$/, "");
      // Re-plannability, as at the test-failure exit: never leave the story at 'executing'.
      resetStalePhaseToArchApproved(projectRoot, coverageProblemId);
      const coverageRolledBack = deriveRolledBack(rb);
      const replanHint = "The rollback returned the worktree to the base branch; re-plan with rks_plan (author or repair the mapped tests, or give the story a complete requirementCoverage map), then run rks_exec.";
      // backlog.fix.exec-refuse-plan-without-requirement-coverage-map (Solution step 2): save the
      // evaluation to the run folder before either refusal returns. Status and reason come from the
      // evaluation itself; a failed write is volunteered on the result as coverageGateWriteError.
      const coverageGateWrite = writeCoverageGateRecord({
        runDir,
        record: {
          status: coverageStatus,
          reason: requirementCoverageEvaluation.reason ?? coverageStatus,
          adapter: requirementCoverageEvaluation.adapter ?? null,
          stage: "coverage_gate",
          runId: path.basename(runDir),
          recordedAt: new Date().toISOString(),
          outcome: requirementCoverageEvaluation.outcome,
          ...(Array.isArray(requirementCoverageEvaluation.uncoveredRequirements) ? { uncoveredRequirements: requirementCoverageEvaluation.uncoveredRequirements } : {}),
          ...(requirementCoverageEvaluation.policyReason !== undefined ? { policyReason: requirementCoverageEvaluation.policyReason } : {}),
          ...(requirementCoverageEvaluation.field ? { field: requirementCoverageEvaluation.field, detail: requirementCoverageEvaluation.detail } : {}),
          ...(requirementCoverageEvaluation.policyDetail ? { policyDetail: requirementCoverageEvaluation.policyDetail } : {}),
        },
      });
      if (!coverageGateWrite.ok) {
        console.error(`[rks.exec] coverage-gate record not written (${coverageGateWrite.error}): ${coverageGateWrite.detail}`);
      }
      if (requirementCoverageEvaluation.outcome === "uncovered") {
        ctx.terminalDetail = { problemId: coverageProblemId || null, reason: "test_requirements_uncovered", stage: "coverage_gate", uncoveredCount: requirementCoverageEvaluation.uncoveredRequirements.length, durationMs: Date.now() - execStartMs };
        return {
          ok: false,
          status: "test_requirements_uncovered",
          reason: "test_requirements_uncovered",
          uncoveredRequirements: requirementCoverageEvaluation.uncoveredRequirements,
          adapter: requirementCoverageEvaluation.adapter,
          rolledBack: coverageRolledBack,
          leftBehind: rb?.leftBehind ?? [],
          recovery: rollbackRecoveryGuidance(rb),
          partialDiffPath: rb?.partialDiffPath ?? null,
          rollback: rb,
          projectId,
          slug: selectedSlug,
          branch: branchName,
          runFolder: runDir,
          runId: path.basename(runDir),
          stepsApplied,
          appliedFiles,
          attempts: attemptNumber,
          ...(coverageGateWrite.ok ? { coverageGateRecordPath: coverageGateWrite.path } : { coverageGateWriteError: { error: coverageGateWrite.error, detail: coverageGateWrite.detail } }),
          message: `${requirementCoverageEvaluation.uncoveredRequirements.length} testRequirement(s) are not covered by a test observed passing in this exec. Nothing was committed.`,
          hint: replanHint,
          baselineSkipped,
          baselineSkipReason,
          baselineRed: baselineRedResult(),
        };
      }
      const unverifiableAdapter = requirementCoverageEvaluation.adapter ? "adapter " + requirementCoverageEvaluation.adapter : "no result adapter";
      const unverifiableMessage = "Test-requirement coverage cannot be verified (" + requirementCoverageEvaluation.reason + ", " + unverifiableAdapter + "). Nothing was committed.";
      ctx.terminalDetail = { problemId: coverageProblemId || null, reason: "test_requirements_unverifiable", stage: "coverage_gate", unverifiableReason: requirementCoverageEvaluation.reason, durationMs: Date.now() - execStartMs };
      return {
        ok: false,
        status: "test_requirements_unverifiable",
        reason: requirementCoverageEvaluation.reason,
        adapter: requirementCoverageEvaluation.adapter,
        ...(requirementCoverageEvaluation.policyReason !== undefined ? { policyReason: requirementCoverageEvaluation.policyReason } : {}),
        ...(requirementCoverageEvaluation.field ? { field: requirementCoverageEvaluation.field, detail: requirementCoverageEvaluation.detail } : {}),
        ...(requirementCoverageEvaluation.policyDetail ? { policyDetail: requirementCoverageEvaluation.policyDetail } : {}),
        rolledBack: coverageRolledBack,
        leftBehind: rb?.leftBehind ?? [],
        recovery: rollbackRecoveryGuidance(rb),
        partialDiffPath: rb?.partialDiffPath ?? null,
        rollback: rb,
        projectId,
        slug: selectedSlug,
        branch: branchName,
        runFolder: runDir,
        runId: path.basename(runDir),
        stepsApplied,
        appliedFiles,
        attempts: attemptNumber,
        ...(coverageGateWrite.ok ? { coverageGateRecordPath: coverageGateWrite.path } : { coverageGateWriteError: { error: coverageGateWrite.error, detail: coverageGateWrite.detail } }),
        message: unverifiableMessage,
        hint: replanHint,
        baselineSkipped,
        baselineSkipReason,
        baselineRed: baselineRedResult(),
      };
    }
  }

  // The plan's own files PLUS anything the dependency install derived PLUS the
  // outputs run_command steps declared (computeCommitFiles). Staging the manifest
  // without its lockfile would leave a genuinely broken commit on the branch —
  // which is why this is fixed at the producer rather than by widening ship's
  // preflight filter to tolerate a dirty lockfile.
  // backlog.fix.command-policy-integrity-across-runs: the last check before anything is staged. The
  // dependency install, every test run and every fix-plan retry have run by now. Restore FIRST, while
  // still on the rks/ branch (rollback checks out the base branch and deletes this one), then roll back.
  const preCommitPolicyCheck = checkCommandPolicyIntegrity(projectRoot, commandPolicyBaseline, {
    allowHeadReset: commandPolicyHeadResetAllowed(projectRoot),
  });
  if (preCommitPolicyCheck.changed) {
    console.error(`[rks.exec] policy integrity: ${COMMAND_POLICY_RELATIVE_PATH} changed after apply (${describePolicyParts(preCommitPolicyCheck.changedParts)}); restored [${describePolicyParts(preCommitPolicyCheck.restored)}], failed [${describePolicyParts(preCommitPolicyCheck.restoreFailed)}]. Nothing is committed; rolling back...`);
    emitCommandPolicyChanged(collector, projectId, correlationId, {
      stage: "pre_commit",
      changedParts: preCommitPolicyCheck.changedParts,
      restored: preCommitPolicyCheck.restored,
      restoreFailed: preCommitPolicyCheck.restoreFailed,
      problemId: plan.problemId || null,
    });
    const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'command_policy_changed', correlationId });
    const policyRolledBack = deriveRolledBack(rb);
    return {
      ok: false,
      status: "command_policy_changed",
      error: "exec.command_policy_changed",
      stage: "pre_commit",
      changedParts: preCommitPolicyCheck.changedParts,
      restored: preCommitPolicyCheck.restored,
      restoreFailed: preCommitPolicyCheck.restoreFailed,
      rolledBack: policyRolledBack,
      leftBehind: rb?.leftBehind ?? [],
      recovery: rollbackRecoveryGuidance(rb),
      partialDiffPath: rb?.partialDiffPath ?? null,
      rollback: rb,
      projectId,
      slug: selectedSlug,
      branch: branchName,
      runFolder: runDir,
      runId: path.basename(runDir),
      stepsApplied,
      appliedFiles,
      attempts: attemptNumber,
      message: `${COMMAND_POLICY_RELATIVE_PATH} changed after apply (by a test run, the dependency install or a fix-plan retry). Nothing was staged or committed.`,
      hint: "Find the plan-written code that rewrites the command policy, re-plan without it, then re-run rks_plan and rks_exec.",
    };
  }

  const commitFiles = computeCommitFiles({ appliedFiles, installDerived, steps: plan.steps || [] });

  if (gitRepo && commitFiles.length) {
    try {
      runGit(projectRoot, ["add", ...commitFiles]);
    } catch (error) {
      console.error(`[rks.exec] git add failed: ${error.message}`);
    }
  } else if (!gitRepo) {
    console.error("[rks.exec] No git repo detected; files written without staging.");
  }

  // backlog.fix.exec-commit-set-protected-paths: THE COMMIT-BOUNDARY CHECK. Everything exec is about to
  // commit is the commits a run_command made during apply (<execBaseCommit>..HEAD) plus the index
  // (commitFiles were just staged; a run_command may have staged more). If any of it is a governance
  // path, nothing is committed. Placed after the pre-commit command-policy check (a policy change keeps
  // status command_policy_changed) and before the plan archive is written, so exec's own .rks/plans
  // archive is never in the checked set. protectedPaths comes only from git output, never from the plan.
  // The built-in floor and the command policy only (no operator patterns), per the ARCH ruling.
  // Skipped in a non-git root and when no exec base commit was recorded.
  if (gitRepo && ctx.execBaseCommit) {
    let boundaryPaths = null;
    let boundaryError = null;
    try {
      const splitZ = (out) => String(out || "").split("\0").map((f) => f.trim()).filter(Boolean);
      const committed = splitZ(runGit(projectRoot, ["diff", "--name-only", "-z", ctx.execBaseCommit, "HEAD"]));
      const staged = splitZ(runGit(projectRoot, ["diff", "--cached", "--name-only", "-z"]));
      boundaryPaths = [...new Set([...committed, ...staged])];
    } catch (err) {
      boundaryError = err.message;
    }
    const protectedPaths = boundaryPaths ? boundaryPaths.filter((f) => isGovernancePath(projectRoot, f)) : [];
    if (boundaryError || protectedPaths.length > 0) {
      console.error(
        boundaryError
          ? `[rks.exec] commit-boundary check could not read git state (${boundaryError}); failing closed. Nothing is committed; rolling back...`
          : `[rks.exec] commit-boundary check: governance path(s) in the commit set [${protectedPaths.join(", ")}]. Nothing is committed; rolling back...`
      );
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'commit_boundary_governance_path', correlationId });
      const protectedRolledBack = deriveRolledBack(rb);
      return {
        ok: false,
        status: "protected_path_in_commit",
        error: "exec.commit_boundary_governance_path",
        protectedPaths,
        boundaryError,
        rolledBack: protectedRolledBack,
        leftBehind: rb?.leftBehind ?? [],
        recovery: rollbackRecoveryGuidance(rb),
        partialDiffPath: rb?.partialDiffPath ?? null,
        rollback: rb,
        projectId,
        slug: selectedSlug,
        branch: branchName,
        runFolder: runDir,
        runId: path.basename(runDir),
        stepsApplied,
        appliedFiles,
        attempts: attemptNumber,
        message: boundaryError
          ? `The commit-boundary check could not read git state (${boundaryError}), so exec failed closed. Nothing was committed.`
          : `exec would have committed governance path(s): ${protectedPaths.join(", ")}. Nothing was committed; ${protectedRolledBack ? "the run was rolled back." : "rollback did NOT fully restore the tree; see recovery and leftBehind."}`,
        hint: "A plan cannot commit .routekit/, .rks/, .claude/, .git/ or the command policy. Re-plan without the step that writes, stages or commits them; make governance changes off-rail (guardrails-off).",
      };
    }
  }

  try {
    const timestamp = new Date().toISOString();
    const guardrailScenario = guardrailExec?.scenario?.id || plan.guardrail?.id || null;
    // Await the telemetry call to allow future async implementations and ensure errors are caught here.
    await recordTelemetry(projectRoot, {
      projectId,
      runId,
      slug: selectedSlug,
      branch: branchName,
      timestamp,
      metrics: buildTelemetryMetrics(plan, appliedFiles.length),
      guardrail: guardrailScenario ? { scenario: guardrailScenario, status: "pass" } : null,
      correlationId,
      runIdValue
    });
  } catch (error) {
    console.warn(`[rks.exec] telemetry recording failed: ${error.message}`);
  }

  // Commit changes only (no PR creation) if tests passed (or autoCommit with skipped tests) and we're on a feature branch
  let commitResult = null;
  // AC14: observed disposition of the plan archive, reported in the result and on exec.complete.
  let planArchive = { status: "not_attempted", path: null, error: null };
  const shouldCommit = (testsPassed || testsSkipped) && branchName && branchName.startsWith("rks/");
  if (shouldCommit) {
    console.error(`[rks.exec] Tests passed, committing changes for ${branchName} to ${baseBranch}`);

    // backlog.feat.exec-plan-commit-linkage (AC3/AC14): the plan archive rides in the exec commit
    // through its own list; commitFiles and its staging stay untouched. The archive is written only
    // when git reports its path NOT ignored; an ignored path or a failed check writes and stages
    // nothing (never a force add) and is reported, and the commit proceeds with the applied files.
    let planArchiveRel = null;
    if (commitFiles.length > 0) {
      const archiveRel = planArchiveRelPath(runIdValue);
      const ignoreCheck = checkPlanArchiveIgnored(projectRoot, archiveRel);
      if (ignoreCheck.status === "not_ignored") {
        // A throw from the archive write never escapes the commit block: it is reported as
        // write_failed, planArchiveRel stays null (the archive is not listed), and the commit
        // proceeds with commitFiles and the trailers.
        try {
          planArchiveRel = writePlanArchive(projectRoot, buildPlanArchive({ runId: runIdValue, plan, fixPlans: appliedFixPlans }));
          planArchive = { status: "staged", path: planArchiveRel, error: null };
        } catch (archiveErr) {
          planArchive = planArchiveWriteFailed(projectRoot, archiveRel, archiveErr);
        }
      } else {
        planArchive = { status: ignoreCheck.status, path: archiveRel, error: ignoreCheck.error };
        console.error(`[rks.exec] plan archive ${archiveRel} not committed: ${ignoreCheck.status}${ignoreCheck.error ? ` (${ignoreCheck.error})` : ""}`);
      }
    }
    const execCommitFiles = planArchiveRel ? [...commitFiles, planArchiveRel] : commitFiles;
    // Plan-Hash and Run-Id trailers, in the same trailer block as Story.
    const execTrailers = buildExecTrailers({ planHash: planHashFor(plan), runId: runIdValue });

    // First commit all staged changes
    try {
      commitResult = await runGitCommit({
        projectRoot,
        message: plan.problemId || selectedSlug,
        scope: "exec",
        type: "feat",
        files: execCommitFiles,
        storyId: plan.problemId,
        trailers: execTrailers,
      });
      if (commitResult.ok) {
        console.error(`[rks.exec] Committed changes: ${commitResult.commitId}`);
      } else {
        console.error(`[rks.exec] Commit skipped: ${commitResult.error}`);
      }
    } catch (err) {
      console.warn(`[rks.exec] Commit error: ${err.message}`);
      commitResult = { ok: false, error: err.message };
    }
    // Observed after the commit attempt: staged becomes committed only when the commit landed.
    if (planArchive.status === "staged") {
      planArchive = { ...planArchive, status: commitResult?.ok === true ? "committed" : "commit_failed" };
      // A failed commit leaves no archive behind: it is unstaged and removed, and the observed
      // outcome of those removal calls is reported as planArchive.cleanup.
      if (planArchive.status === "commit_failed") {
        planArchive = { ...planArchive, ...cleanupPlanArchive(projectRoot, planArchive.path) };
      }
    }
  }

  // Emit to new JSONL-based collector, AFTER the commit so it carries the observed SHA.
  // A-prime: exec.complete has exactly ONE producer, the literal collector.emit below.
  // backlog.fix.exec-pending-ship-reported-when-commit-failed: emitted only for a run whose commit
  // landed or that had no commit to make. A commit-failed run produces exec.failed (reason
  // commit_failed) from emitTerminalOutcome instead, never exec.complete.
  if (!shouldCommit || commitResult?.ok === true) {
    try {
      collector.emit("exec.complete", projectId, {
        problemId: plan.problemId || null,
        slug: selectedSlug,
        durationMs: Date.now() - execStartMs,
        filesChanged: [...appliedFiles],
        commitSha: commitResult?.fullCommitId || null,
        planHash: planHashValue,
        commitBranch: commitResult?.ok === true ? (commitResult.branch ?? null) : null,
        planArchive,
        testVerification,
        testsSkipped,
        baselineSkipped,
        baselineSkipReason,
        testsPassed,
        attempts: attemptNumber,
        runId: runIdValue,
      }, { correlationId });
    } catch (e) { /* telemetry is best-effort */ }
  }
  try { await collector.flush(); } catch (e) { console.warn(`[rks.exec] telemetry flush failed: ${e?.message}`); }

  // backlog.fix.exec-rollback-strands-executing-phase: THE FINALIZED BOUNDARY.
  //
  // Past this line there is DURABLE WORK that must never be destroyed, so a throw in the tail below
  // gets a phase reset and NOTHING else — no rollback(), which would `git branch -D` the branch
  // holding the commit we just made.
  //
  // Two arms, and both are load-bearing:
  //   - commitResult.ok === true  → a commit exists on rks/<slug>. (runGitCommit is wrapped in its
  //     own try/catch above that swallows failure into {ok:false}, so this is the exact signal.)
  //   - !shouldCommit → a green exec with no commit to make. Reaching here at all means tests passed
  //     or were skipped (the red-test path returned long ago), so the applied edits are GOOD. In a
  //     NON-GIT project createBackup takes the file-copy path, which means backupMeta is truthy and
  //     the post-mutation predicate would otherwise be TRUE — sending a tail throw into rollback()
  //     and restoring the backup OVER the green edits. This arm is what stops that.
  //
  // A FAILED commit leaves this false: nothing durable exists, so post-mutation rollback() is still
  // the right answer.
  if (!shouldCommit || commitResult?.ok === true) {
    ctx.finalized = true;
  }

  // Restore guardrails after apply+commit
  let guardrailsRestore = null;
  if (guardrailsSession?.ok) {
    guardrailsRestore = await reenableGuardrailsAfterExec({
      guardrailsOn,
      collector,
      projectRoot,
      projectId,
      payload: {
        problemId: plan.problemId || null,
        filesChanged: appliedFiles.length,
        testsPassed,
        durationMs: Date.now() - offRailStartTime,
        branchName,
        correlationId,
      },
    });
    if (guardrailsRestore.ok !== true) {
      console.warn(`[rks.exec] guardrailsOn failed (continuing): ${guardrailsRestore.reason}`);
    }
  }

  // backlog.fix.exec-pending-ship-reported-when-commit-failed: the commit was attempted and did NOT
  // land. The success status would tell the caller to ship a dirty tree that rks_story_ship's preflight
  // refuses, so this path reports a terminal failure instead. It sits after the guardrails restore
  // and BEFORE advanceExecEndPhase, so by construction it skips the exec_end phase write, the
  // coverage-record write, commitExecEndNote, the backup-stash drop, markExecComplete and the
  // scoped auto-embed. It never rolls back: the applied, test-green edits stay staged on the rks/
  // branch, and runExecTool resets the story from executing to arch-approved (ok false, not a pause).
  if (shouldCommit && commitResult?.ok !== true) {
    const commitError = commitResult?.error || "Unknown error";
    markExecFailed(runDir, "commit", commitError);

    // Observed, never the plan's intended list: what is staged right now, minus the notes/ story
    // note (it carries the phase reset and must stay out of the recovery stash).
    let uncommittedPaths = null;
    let uncommittedPathsError = null;
    const cachedRes = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: projectRoot, encoding: "utf8", timeout: 15000 });
    if (cachedRes.error || cachedRes.status !== 0) {
      uncommittedPathsError = String(cachedRes.error?.message || cachedRes.stderr || "").trim() || `git diff --cached exited ${cachedRes.status}`;
    } else {
      uncommittedPaths = String(cachedRes.stdout || "").split("\0").filter((p) => p && !p.startsWith("notes/"));
    }

    // backupStash.kept is OBSERVED at this point (plan steps and run_commands ran since
    // createBackup and can drop or clear stashes), by exact SHA identity. A failed read is kept null.
    let backupStash = { stashCreated: false, stashSha: null, kept: false };
    let stashNote = "No backup stash was created for this run.";
    if (backupMeta?.type === "git-stash" && backupMeta.stashCreated) {
      const stashSha = backupMeta.stashSha;
      const stashListRes = spawnSync("git", ["stash", "list", "--format=%H"], { cwd: projectRoot, encoding: "utf8", timeout: 15000 });
      if (stashListRes.error || stashListRes.status !== 0) {
        const keptError = String(stashListRes.error?.message || stashListRes.stderr || "").trim() || `git stash list exited ${stashListRes.status}`;
        backupStash = { stashCreated: true, stashSha, kept: null, keptError };
        console.warn(`[rks.exec] Backup stash ${stashSha} could not be verified (git stash list failed): ${keptError}`);
        stashNote = `Backup stash ${stashSha} (the PRE-exec state, not the applied work) could not be verified: git stash list failed (${keptError}). Check git stash list for ${stashSha} before relying on it as the pre-exec state.`;
      } else {
        const listedShas = String(stashListRes.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
        const kept = listedShas.includes(stashSha);
        backupStash = { stashCreated: true, stashSha, kept };
        stashNote = kept
          ? `Backup stash ${stashSha} holds the PRE-exec state (not the applied work) and was kept.`
          : `Backup stash ${stashSha} (the PRE-exec state) is no longer in git stash list: a plan step or run_command dropped or cleared it during the run.`;
      }
    }

    const shellQuote = (p) => "'" + String(p).split("'").join("'\\''") + "'";
    const recoveryStory = problemId || selectedSlug;
    const stashMessage = "rks exec commit_failed " + path.basename(runDir);
    const stashCommand = uncommittedPaths && uncommittedPaths.length > 0
      ? ["git", "stash", "push", "-m", shellQuote(stashMessage), "--", ...uncommittedPaths.map(shellQuote)].join(" ")
      : null;
    const recovery = {
      baseBranch,
      branch: branchName,
      uncommittedPaths,
      ...(uncommittedPathsError ? { uncommittedPathsError } : {}),
      ...(stashCommand ? { stashCommand } : {}),
      steps: [
        `Fix the cause named in commitError: ${commitError}`,
        stashCommand
          ? `Set the uncommitted edits aside, still on ${branchName}: ${stashCommand}`
          : `Set the uncommitted edits aside, still on ${branchName}, with git stash push -m "${stashMessage}" -- <each staged path outside notes/> (the staged paths could not be listed: ${uncommittedPathsError || "none were staged"})`,
        `Check out the base branch: git checkout ${baseBranch}`,
        `Re-run rks_plan then rks_exec for ${recoveryStory}. The story is at arch-approved, so it is plannable; exec writes the coverage record and commits.`,
        "Run rks_story_ship. It refuses until the steps above are done.",
      ],
    };
    const commitFailedMessage = `Exec commit failed: ${commitError}. The applied, test-green edits are still staged on ${branchName}; nothing was rolled back and the story is at arch-approved. ${stashNote}`;
    const commitFailedHint = `Do not run rks_story_ship yet: it refuses this dirty tree. Fix the commit failure, set the edits aside with git stash push (${stashCommand || "see recovery.steps"}), check out ${baseBranch} with git checkout ${baseBranch}, then re-run rks_plan and rks_exec for ${recoveryStory}. ${stashNote}`;

    ctx.terminalDetail = { problemId: plan.problemId || null, reason: "commit_failed", stage: "commit", durationMs: Date.now() - execStartMs };
    return {
      ok: false,
      status: "exec_commit_failed",
      error: "exec.commit_failed",
      commitAttempted: true,
      commitId: null,
      commitError,
      projectId,
      slug: selectedSlug,
      branch: branchName,
      runFolder: runDir,
      runId: path.basename(runDir),
      stepsApplied,
      appliedFiles,
      testsPassed,
      testsSkipped,
      attempts: attemptNumber,
      testVerification,
      ...(fixApplyRefusal ? { fixApplyRefusal } : {}),
      planArchive,
      backupStash,
      ...(guardrailsRestore && guardrailsRestore.ok !== true
        ? { guardrailsRestore, guardrailsWarning: guardrailsRestoreWarning(guardrailsRestore) }
        : {}),
      recovery,
      message: commitFailedMessage,
      hint: commitFailedHint,
    };
  }

  // R1.3 — rks_exec writer advances phase via the v2 op `exec_end`
  // (executing→executed). Since R1.3e the plan writer leaves the story at
  // `executing` and rks_exec gates on PHASE_GATE_EXEC === "executing" (see
  // workflow/phases.mjs), so exec_end's from:["executing"] matches the live
  // phase on completion. (Pre-gate-flip this advance silently failed: exec ran
  // at `planned` while exec_end requires `executing`.)
  // See advanceExecEndPhase: the failure is CARRIED INTO THE RESULT, not just
  // console.error'd. Swallowing it into stderr while returning ok:true is what
  // let a story whose phase had been reverted report a clean exec — the caller
  // then shipped a story the backlog still recorded as unbuilt.
  const phaseError = await advanceExecEndPhase(projectRoot, problemId);

  // backlog.fix.exec-test-requirements-coverage-gate (Solution step 6): the coverage record. Built
  // only once the exec commit is observed, so `commit` is the id of that commit, and written to the
  // story note BEFORE commitExecEndNote so the same note commit carries it beside the phase write.
  // No commit (or no commit id) means NO record (Decision 11): the result says it was withheld.
  // A failed phase write also withholds it, because the note commit is then never made and the
  // record would be left as an uncommitted note change.
  let requirementCoverageRecord = null;
  let requirementCoverageWithheld = null;
  let requirementCoverageWriteError = null;
  if (requirementCoverageEvaluation?.ok === true) {
    // The full sha names the exec commit unambiguously; the short commitId is only a fallback.
    const commitIdForRecord = commitResult?.fullCommitId || commitResult?.commitId;
    if (shouldCommit && commitResult?.ok === true && typeof commitIdForRecord === "string" && commitIdForRecord.length > 0) {
      if (phaseError) {
        requirementCoverageWithheld = "phase_error";
        console.error(`[rks.exec] requirementCoverageRecord withheld: the exec_end phase write failed (${phaseError.error}), so no note commit will carry it`);
      } else {
        requirementCoverageRecord = buildRequirementCoverageRecord({
          evaluation: requirementCoverageEvaluation,
          testRequirements: storyTestRequirements,
          runId: runIdValue,
          commit: commitIdForRecord,
        });
        const recordNotePath = path.join(resolveNotesDir(projectRoot), `${problemId}.md`);
        const recordWrite = writeRequirementCoverageRecord({ notePath: recordNotePath, record: requirementCoverageRecord });
        if (recordWrite.ok !== true) {
          requirementCoverageWriteError = { error: recordWrite.error, detail: recordWrite.detail, path: recordNotePath };
          console.error(`[rks.exec] requirementCoverageRecord write to ${recordNotePath} failed: ${recordWrite.error}: ${recordWrite.detail}`);
        } else {
          console.error(`[rks.exec] requirementCoverageRecord (${requirementCoverageRecord.verification}) written to ${recordNotePath}`);
        }
        const recordRunJsonPath = path.join(runDir, "run.json");
        try {
          let recordRunMeta = {};
          if (fs.existsSync(recordRunJsonPath)) {
            try { recordRunMeta = JSON.parse(fs.readFileSync(recordRunJsonPath, "utf8")); } catch { recordRunMeta = {}; }
          }
          recordRunMeta.requirementCoverageRecord = requirementCoverageRecord;
          fs.writeFileSync(recordRunJsonPath, JSON.stringify(recordRunMeta, null, 2));
        } catch (e) {
          console.error(`[rks.exec] requirementCoverageRecord write to run.json failed: ${e?.message}`);
        }
      }
    } else {
      requirementCoverageWithheld = "no_commit";
      console.error("[rks.exec] requirementCoverageRecord withheld: no commit was made, so there is no exec commit for the record to name (rks_story_ship will refuse the missing record)");
    }
  }

  // backlog.fix.exec-end-phase-write-left-uncommitted: make the exec_end write durable on the
  // feature branch. Gated inside commitExecEndNote on
  // shouldCommit && commitResult?.ok === true && !phaseError; a failed note commit is carried
  // into the result below as noteCommitError, never only logged.
  const noteCommit = await commitExecEndNote({ projectRoot, problemId, shouldCommit, commitResult, phaseError });
  const noteCommitError = noteCommit && noteCommit.ok !== true ? noteCommit : null;

  // Success path: drop the backup stash this run created. Until now only
  // rollback() ever resolved a backup, so every green exec orphaned its stash.
  // Drop is BY RECORDED SHA ONLY — see dropBackupStash.
  if (backupMeta?.type === "git-stash" && backupMeta.stashCreated) {
    try {
      const dropResult = dropBackupStash(projectRoot, backupMeta);
      if (dropResult.dropped) {
        console.error(`[rks.exec] Backup stash ${dropResult.ref} dropped after successful exec`);
      } else {
        console.warn(`[rks.exec] Backup stash not dropped (${dropResult.reason || dropResult.error}); left in place`);
      }
    } catch (e) {
      console.warn(`[rks.exec] Backup stash drop failed (non-fatal): ${e?.message}`);
    }
  }

  // Telemetry completion will be handled by the main success path below

  // Check if any applied files are test files — warn if none
  const appliedTestFiles = appliedFiles.filter(f => isTestFile(typeof f === "string" ? f : f.path || f.file || ""));
  const noNewTests = appliedTestFiles.length === 0;

  // Check testExempt from story frontmatter
  let storyTestExempt = false;
  if (problemId) {
    try {
      const storyData = loadStory(projectRoot, problemId);
      const testExemptVal = storyData.frontmatter.testExempt;
      storyTestExempt = testExemptVal === "true" || testExemptVal === true;
    } catch (e) { /* best-effort */ }
  }

  const testCoverageWarning = noNewTests && !storyTestExempt && !testsSkipped
    ? "No test files were added or modified in this plan. Consider adding tests for new functionality."
    : null;

  // Mark exec as complete. backlog.feat.exec-plan-commit-linkage (AC4): the full SHA and Plan-Hash
  // are recorded beside the short commitId by markExecComplete's single saveExecState
  // (backlog.fix.exec-plan-commit-linkage-review-followups AC1/AC2).
  markExecComplete(runDir, {
    testsPassed,
    commitId: commitResult?.commitId || null,
    fullCommitId: commitResult?.fullCommitId || null,
    planHash: planHashValue,
  });
  // backlog.fix.exec-write-record-attempt-retention: stamp this attempt's write record with the
  // commit, so retention can later prune it. Best-effort: the helper never throws and its return
  // never changes the exec result (a missing stamp only keeps the attempt unprunable).
  if (commitResult?.commitId) {
    try {
      stampWriteRecordCompletion(runDir, { commitId: commitResult.commitId, fullCommitId: commitResult?.fullCommitId || null });
    } catch { /* never throws; guarded anyway so the exec result cannot change */ }
  }

  // Scoped auto-embed: re-index only the files exec touched so subsequent
  // planner calls get accurate RAG content (closes op:create → op:edit gap).
  // Failure is non-fatal — exec result is returned regardless.
  if (appliedFiles.length > 0) {
    try {
      const embedResult = await embedScopedFiles(projectRoot, appliedFiles);
      if (!embedResult.ok) {
        console.warn(`[rks.exec] auto-embed warning: ${embedResult.error}`);
      } else {
        console.error(`[rks.exec] auto-embedded ${embedResult.filesEmbedded} file(s)`);
      }
    } catch (e) {
      console.warn(`[rks.exec] auto-embed failed (non-fatal): ${e?.message}`);
    }
  }

  // Build result
  const problemIdForShip = problemId || selectedSlug;
  const requiredNextStep = problemIdForShip
    ? `rks_story_ship { projectId: "${projectId}", problemId: "${problemIdForShip}" }`
    : `rks_story_ship { projectId: "${projectId}" }`;
  // backlog.fix.exec-pending-ship-reported-when-commit-failed: the commit outcome is reported from
  // observed state. A commit that was attempted and failed never reaches here (exec_commit_failed above).
  const commitSkippedReason = shouldCommit
    ? null
    : !gitRepo
      ? "not_a_git_repo"
      : !branchName
        ? "no_feature_branch"
        : !branchName.startsWith("rks/")
          ? "branch_not_rks"
          : "tests_not_passed";

  return {
    ok: true,
    projectId,
    slug: selectedSlug,
    branch: branchName,
    runFolder: runDir,
    runId: path.basename(runDir),
    stepsApplied,
    appliedFiles,
    staticAnalysis,
    preCommandResults: preCommandResults.length > 0 ? preCommandResults : undefined,
    // Observed, not intended: true only for a verification run that spawned and executed tests.
    testsRan: testsRanFromVerification(lastVerification),
    ...(testsPassedLogPath ? { testsPassedLog: testsPassedLogPath } : {}),
    testsPassed: testsPassed,
    testsSkipped: testsSkipped,
    attempts: attemptNumber,
    testVerification,
    ...(fixApplyRefusal ? { fixApplyRefusal } : {}),
    ...(testCoverageWarning ? { testCoverageWarning } : {}),
    ...(phaseError ? { phaseError, warnings: [`exec_end phase advance failed: ${phaseError.error}`] } : {}),
    // Mutually exclusive with phaseError: the note commit is never attempted when phaseError is set.
    ...(noteCommitError ? { noteCommitError, warnings: [`exec_end note commit failed: ${noteCommitError.error}`] } : {}),
    ...(noteCommit?.ok === true ? { noteCommit } : {}),
    // AC11: a non-ok guardrails re-enable is volunteered, never reported as re-enabled.
    ...(guardrailsRestore && guardrailsRestore.ok !== true
      ? { guardrailsRestore, guardrailsWarning: guardrailsRestoreWarning(guardrailsRestore) }
      : {}),
    planArchive,
    commitAttempted: Boolean(shouldCommit),
    commitId: commitResult?.commitId ?? null,
    fullCommitId: commitResult?.fullCommitId ?? null,
    ...(commitSkippedReason ? { commitSkippedReason } : {}),
    // backlog.fix.exec-test-requirements-coverage-gate: present only for a story with
    // testRequirements (AC9 stories get no new key). null when withheld, with the reason.
    ...(hasTestRequirements ? {
      requirementCoverage: requirementCoverageRecord,
      ...(requirementCoverageWithheld ? { requirementCoverageWithheld } : {}),
      ...(requirementCoverageWriteError ? { requirementCoverageWriteError } : {}),
    } : {}),
    status: 'pending_ship',
    baselineSkipped,
    baselineSkipReason,
    baselineAbsentPaths,
    baselineTestPaths,
    baselineRed: baselineRedResult(),
    requiredNext: requiredNextStep,
    message: `Exec complete. REQUIRED: Run ${requiredNextStep} to complete the story.`,
  };
}

async function runApplyTool({ projectId, label, _execContext = false, force = false,
  // OPTIONAL by necessity: rks_apply (server.mjs) calls this with neither. Defaulting to an
  // empty Set is also semantically right there — that path runs no preCommands.
  preCommandGeneratedFiles = new Set(),
  scopeExemptions = new Set(),
  // OPTIONAL: rks_exec passes the policy it loaded once per exec; rks_apply and the CLI pass none
  // and get the per-run snapshot load below.
  policy = undefined,
  // backlog.fix.command-policy-integrity-across-runs: OPTIONAL. rks_exec passes the policy state it
  // captured; rks_apply and force callers pass none and get a capture at the policy snapshot below.
  commandPolicyBaseline = null,
  // backlog.fix.exec-apply-stop-restores-base-branch-and-backup: OPTIONAL. rks_exec passes the
  // run's rks/ branch, its base branch and the createBackup result, so the two in-apply rollbacks
  // (command_policy_changed, per_step_divergence) return to the base branch, delete the rks/
  // branch and restore the backup like every other exec rollback site. rks_apply and force
  // callers pass none: they never create a branch, and never reach those rollbacks.
  branchName = null,
  baseBranch = null,
  backupMeta = null }) {
  // Reject direct calls unless force flag is set
  if (!_execContext && !force) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "rks.apply cannot be called directly. Use rks.exec instead. For testing: pass force=true"
    );
  }
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;
  const collector = ensureTelemetryStorage(projectRoot);
  const slug = label ? slugify(label) : null;
  const { plan, runDir, runMeta: initialRunMeta } = loadPlan(projectRoot, slug);
  // backlog.fix.exec-write-record-attempt-scope: a forced rks_apply is its own attempt, so it begins a
  // fresh write record (the previous one is moved aside, never deleted). Under exec the attempt has
  // already begun, and applyFixPlan's writes belong to it: no rotation there.
  if (!_execContext) {
    beginWriteRecordAttempt(runDir, { attemptId: randomUUID() });
  }
  let runMeta = initialRunMeta;
  const runJsonPath = path.join(runDir, "run.json");
  const correlationId = runMeta?.correlationId || null;

  const applyDir = path.join(runDir, "apply");
  ensureDir(applyDir);
  const applyLogPath = path.join(applyDir, "apply.log");
  const logLines = [];
  const writeLog = (line) => logLines.push(line);

  const appliedFiles = [];
  const stepsApplied = [];

  const getTargetPath = (step) => step?.target || step?.path || null;

  // Set at the policy snapshot below; read by the per-step check and by the catch at the end.
  let applyPolicyBaseline = null;

  const finalizeRunMeta = (outcome) => {
    const now = new Date().toISOString();
    const currentTimestamps = runMeta.timestamps || {};
    runMeta = {
      ...runMeta,
      timestamps: { ...currentTimestamps, appliedAt: now },
      telemetry: { ...(runMeta.telemetry || {}), outcome },
    };
    fs.writeFileSync(runJsonPath, JSON.stringify(runMeta, null, 2));
  };

  try {
    const protectedConfig = loadProjectProtectedConfig(projectRoot);
    const protectedPatterns = [
      ...(protectedConfig.protected || []),
      ...(protectedConfig.projectProtected || []),
    ];

    // Pre-flight: refuse, before any step applies, a plan file step that targets the command
    // policy. The policy in force cannot be changed by a plan (not even for the next run).
    //
    // backlog.fix.exec-commit-set-protected-paths: the same pre-flight refuses (a) a run_command
    // `produces` entry that is a governance path, checked on the RAW entry (planDeclaredOutputs drops
    // such entries silently, so its normalized set cannot be the check), and (b) a file step whose
    // target is a governance path (.routekit/, .rks/, .claude/, .git/, the command policy, or an
    // operator protected-files pattern), after the unchanged command-policy check. A target-less file
    // step fails closed here. Nothing has been written when any of these throws.
    for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex++) {
      const step = plan.steps[stepIndex];
      if (step && step.action === "run_command" && Array.isArray(step.produces)) {
        for (const entry of step.produces) {
          if (isGovernancePath(projectRoot, entry, protectedPatterns)) {
            const rule = isCommandPolicyTarget(projectRoot, entry)
              ? `the command policy file (${COMMAND_POLICY_RELATIVE_PATH})`
              : `a governance path (${GOVERNANCE_PATH_PREFIXES.join(", ")}, the command policy or a protected-files pattern)`;
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Plan step ${stepIndex} (run_command) declares produces entry ${JSON.stringify(entry)}, which is ${rule}. ` +
                `exec never stages or commits a governance path; make this change off-rail (guardrails-off).`
            );
          }
        }
      }
      if (!step || !step.action || step.action === "note" || step.action === "run_command") continue;
      const policyTarget = getTargetPath(step);
      if (isCommandPolicyTarget(projectRoot, policyTarget)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Plan step ${step.action} targets ${policyTarget}, which resolves to the command policy file ` +
            `(${COMMAND_POLICY_RELATIVE_PATH}). The command policy cannot be changed by a plan; ` +
            `edit it off-rail.`
        );
      }
      if (isGovernancePath(projectRoot, policyTarget, protectedPatterns)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Plan step ${stepIndex} (${step.action}) targets ${policyTarget ?? "(no target)"}, which is a governance path ` +
            `(${GOVERNANCE_PATH_PREFIXES.join(", ")}, the command policy or a protected-files pattern). ` +
            `A plan cannot write governance paths; make this change off-rail (guardrails-off).`
        );
      }
      // backlog.fix.exec-write-record-revert-and-containment-followups (c): containment for EVERY file
      // step before ANY step writes, after the governance checks (so their refusal wins for the same
      // step). The per-step resolvePlanTarget call in the write loop stays; this pass is additional.
      // A target-less step is left to the write loop's own "Step missing path/target" refusal.
      if (typeof policyTarget === "string" && policyTarget.trim()) {
        try {
          resolvePlanTarget(projectRoot, policyTarget);
        } catch (err) {
          throw new McpError(ErrorCode.InvalidParams, `Plan step ${step.action} refused: ${err.message} (pre-flight, step ${stepIndex})`);
        }
      }
    }

    // Snapshot the run_command policy ONCE, before any step applies, so neither a file step nor a
    // run_command side effect can widen what a later step of this apply may run. Frozen (tier
    // arrays included) so no step can alter it through a shared reference.
    const applyCommandPolicy = Object.freeze(
      Object.fromEntries(
        Object.entries((policy && typeof policy === "object" ? policy : loadCommandPolicy(projectRoot)) || {}).map(([tier, list]) => [
          tier,
          Array.isArray(list) ? Object.freeze([...list]) : list,
        ])
      )
    );

    // backlog.fix.command-policy-integrity-across-runs: the policy STATE this apply is checked against
    // after every step. rks_exec hands in the state it captured before preCommands.
    applyPolicyBaseline = commandPolicyBaseline && typeof commandPolicyBaseline === "object"
      ? commandPolicyBaseline
      : captureCommandPolicyState(projectRoot);

    // Compare after a step; on a change restore the policy and return the failure. Rollback is gated on
    // _execContext exactly as the divergence rollback is: a force caller (rks_apply) gets the policy
    // restore only, because rollback's working-tree cleanup would wipe the operator's uncommitted work.
    // HEAD is reset only in exec context on an rks/ branch; a force caller never moves HEAD.
    const commandPolicyChangeAfterStep = async (step) => {
      const stepIndex = plan.steps.indexOf(step);
      const check = checkCommandPolicyIntegrity(projectRoot, applyPolicyBaseline, {
        allowHeadReset: _execContext === true && commandPolicyHeadResetAllowed(projectRoot),
      });
      if (!check.changed) return null;
      console.error(`[rks_exec] policy integrity: step ${stepIndex} (${step.action}) changed ${COMMAND_POLICY_RELATIVE_PATH} (${describePolicyParts(check.changedParts)}); restored [${describePolicyParts(check.restored)}], failed [${describePolicyParts(check.restoreFailed)}]`);
      writeLog(`COMMAND POLICY CHANGED at step ${stepIndex}: changed [${check.changedParts.join(", ")}] restored [${check.restored.join(", ")}] failed [${describePolicyParts(check.restoreFailed)}]`);
      emitCommandPolicyChanged(collector, projectId, correlationId, {
        stage: "apply_step",
        stepIndex,
        changedParts: check.changedParts,
        restored: check.restored,
        restoreFailed: check.restoreFailed,
        problemId: plan.problemId || null,
      });
      let rolledBack = false;
      let partialDiffPath = null;
      let branchRetained = null;
      // A force caller (rks_apply) runs no rollback: nothing is claimed, nothing left behind is known.
      let leftBehind = [];
      let recovery = null;
      if (_execContext) {
        const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession: null, projectId, reason: 'command_policy_changed', correlationId });
        rolledBack = deriveRolledBack(rb);
        partialDiffPath = rb?.partialDiffPath ?? null;
        branchRetained = rb?.branchRetained ?? null;
        leftBehind = rb?.leftBehind ?? [];
        recovery = rollbackRecoveryGuidance(rb);
      }
      fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n`, "utf8");
      finalizeRunMeta("command_policy_changed");
      return {
        ok: false,
        error: "exec.command_policy_changed",
        stepIndex,
        step: step.action,
        ...(step.action === "run_command" ? { command: step.command } : {}),
        changedParts: check.changedParts,
        restored: check.restored,
        restoreFailed: check.restoreFailed,
        rolledBack,
        partialDiffPath,
        branchRetained,
        leftBehind,
        recovery,
      };
    };

    for (const step of plan.steps) {
      if (!step || !step.action) continue;
      const action = step.action;
      const target = getTargetPath(step);

      if (action === "note") {
        writeLog(`skip: ${action}`);
        continue;
      }

      if (action === "run_command") {
        const cmd = step.command;
        if (!cmd || !cmd.trim()) {
          writeLog(`skip: run_command (no command)`);
          // A malformed step is a declared step that cannot run: fail, never skip silently.
          throw new McpError(
            ErrorCode.InvalidParams,
            "Malformed run_command step: it has no command, so nothing was executed. " +
              "Give the step a non-empty command or remove it from the plan."
          );
        }

        try {
          const result = await handleRunCommandStep(cmd, {
            projectRoot,
            planApproved: true,
            timeout: 60000,
            policy: applyCommandPolicy,
          });

          if (result.executed) {
            writeLog(`run_command: ${cmd}`);
            writeLog(`  classification: ${result.classification}`);
            writeLog(`  exit_code: ${result.exec.code}`);
            if (result.exec.stdout) writeLog(`  stdout: ${result.exec.stdout.slice(0, 200)}`);
            if (result.exec.stderr) writeLog(`  stderr: ${result.exec.stderr.slice(0, 200)}`);

            if (result.exec.code !== 0) {
              throw new McpError(
                ErrorCode.InternalError,
                `run_command failed (exit ${result.exec.code}): ${cmd}`
              );
            }
            stepsApplied.push(action);
          } else {
            // A declared step that did not run fails the apply. The log line is written first
            // so the catch below persists it to apply.log before rethrowing.
            writeLog(`skip: run_command (${result.reason}): ${cmd}`);
            const skip = reduceRunCommandSkip(result);
            try {
              collector.emit("exec.run_command_skipped", projectId, { ...skip.event, correlationId });
            } catch { /* telemetry best-effort */ }
            throw new McpError(ErrorCode.InternalError, skip.message, {
              nonExecutedCommands: skip.nonExecutedCommands,
            });
          }
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw new McpError(ErrorCode.InternalError, `run_command error: ${err.message}`);
        }
        // backlog.fix.command-policy-integrity-across-runs: a run_command is the step most able to
        // change the policy (staging, unstaging, checking out or committing it, or any admitted script).
        const runCommandPolicyChange = await commandPolicyChangeAfterStep(step);
        if (runCommandPolicyChange) return runCommandPolicyChange;
        continue;
      }

      if (!target || typeof target !== "string" || !target.trim()) {
        throw new McpError(ErrorCode.InvalidParams, "Step missing path/target");
      }

      // backlog.fix.exec-write-record-hardening: the ONE shared resolver the write record also uses, so
      // the record and this writer describe the same file. An absolute target, or one that leaves the
      // project root (lexically or through a symlinked ancestor), is refused here, before any record
      // or write.
      let absPath;
      try {
        absPath = resolvePlanTarget(projectRoot, target);
      } catch (err) {
        throw new McpError(ErrorCode.InvalidParams, `Plan step ${action} refused: ${err.message}`);
      }

      if (isProtectedPath(target, protectedPatterns)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Attempted to edit protected file: ${target}. See .rks/protected-files.yml.`
        );
      }

      // backlog.fix.exec-rollback-orphans-created-files: a pre-image entry is on disk BEFORE each
      // plan-target write and the post-write hash is recorded AFTER it, through the one shared helper
      // applyFixPlan also uses, into the run's one write record. rollback() reverts the plan's
      // own protected-path writes from it. No runDir (standalone callers): a no-op.
      const recordBefore = () => recordPlanPreImage(projectRoot, runDir, target, { source: "plan" });
      const recordAfter = () => recordPlanPostWrite(projectRoot, runDir, target);

      if (action === "create_file") {
        recordBefore();
        applyCreateFile(absPath, step.content ?? "");
        recordAfter();
        writeLog(`wrote: ${target}`);
        appliedFiles.push(target);
        stepsApplied.push(action);
      } else if (action === "edit_file") {
        if (!fs.existsSync(absPath)) {
          throw new McpError(ErrorCode.InvalidParams, `Cannot edit missing file: ${target}`);
        }
        if (!step.content || !String(step.content).trim()) {
          throw new McpError(ErrorCode.InvalidParams, `edit_file step missing content for ${target}`);
        }
        const scope = step.scope || "file";
        if (!step.scope || scope === "file") {
          recordBefore();
          fs.writeFileSync(absPath, step.content, "utf8");
          recordAfter();
          writeLog(`wrote: ${target}`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else if (scope === "function" && step.targetId) {
          const sourceText = fs.readFileSync(absPath, "utf8");
          const slice = findFunctionSlice(sourceText, step.targetId);
          if (!slice) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Function ${step.targetId} not found or ambiguous in ${target}`
            );
          }
          const updated = replaceSlice(sourceText, slice, step.content);
          recordBefore();
          fs.writeFileSync(absPath, updated, "utf8");
          recordAfter();
          writeLog(`wrote function slice: ${target} (${step.targetId})`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Unsupported edit scope for ${target}: ${scope}`);
        }
      } else if (action === "delete_file") {
        if (fs.existsSync(absPath)) {
          recordBefore();
          fs.rmSync(absPath, { force: true });
          recordAfter();
          writeLog(`deleted: ${target}`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else {
          writeLog(`skip delete (missing): ${target}`);
        }
      } else if (action === "search_replace") {
        if (!Array.isArray(step.edits) || step.edits.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, `search_replace step missing edits for ${target}`);
        }
        recordBefore();
        const result = applySearchReplace(absPath, step.edits);
        recordAfter();
        writeLog(`search_replace: ${target} (${result.applied} edits)`);
        appliedFiles.push(target);
        stepsApplied.push(action);
      } else {
        writeLog(`skip unsupported action: ${action}`);
      }

      // backlog.fix.command-policy-integrity-across-runs: the same check after every file step.
      const fileStepPolicyChange = await commandPolicyChangeAfterStep(step);
      if (fileStepPolicyChange) return fileStepPolicyChange;

      // Per-step divergence detection (only in exec context, not force/test mode)
      if (_execContext) {
        const stepIndex = plan.steps.indexOf(step);
        const expectedFilesThrough = new Set(
          plan.steps.slice(0, stepIndex + 1).map(s => s.target || s.path).filter(Boolean)
        );
        const divergenceCheck = detectPerStepDivergence(
          projectRoot,
          expectedFilesThrough,
          preCommandGeneratedFiles,
          plan.steps || [],
          scopeExemptions,
        );
        if (divergenceCheck.diverged) {
          console.error(`[rks_exec] PER-STEP DIVERGENCE at step ${stepIndex}: ${divergenceCheck.unexpectedFiles.join(', ')}`);
          writeLog(`DIVERGENCE at step ${stepIndex}: unexpected files ${divergenceCheck.unexpectedFiles.join(', ')}`);
          collector.emit("exec.divergence_detected", projectId, {
            unexpectedFiles: divergenceCheck.unexpectedFiles,
            stepIndex,
            problemId: plan.problemId || null,
            branchName,
            correlationId,
          });

          const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession: null, projectId, reason: 'per_step_divergence', correlationId });

          fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n`, "utf8");
          finalizeRunMeta("diverged");

          return {
            ok: false,
            error: "exec.diverged",
            stepIndex,
            expectedFiles: divergenceCheck.expectedFiles,
            actualFiles: divergenceCheck.actualFiles,
            unexpectedFiles: divergenceCheck.unexpectedFiles,
            missingFiles: divergenceCheck.missingFiles,
            diffSummary: `Step ${stepIndex} modified unexpected files: ${divergenceCheck.unexpectedFiles.join(', ')}`,
            partialDiffPath: rb.partialDiffPath,
            branchRetained: rb?.branchRetained ?? null,
            // Derived from the observed rollback result, as on the command_policy_changed path.
            rolledBack: deriveRolledBack(rb),
            leftBehind: rb?.leftBehind ?? [],
            recovery: rollbackRecoveryGuidance(rb),
          };
        }
      } // end if (_execContext) divergence check
    }

    fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n`, "utf8");
    finalizeRunMeta("applied");

    // Write-ledger provenance for the files this apply just wrote.
    //
    // hasValidProvenance in packages/hooks/lib/session-state.mjs ALREADY has a write-ledger
    // branch — its own comment there says it is "the gate redirect-read-to-agent.mjs actually
    // fires" — but nothing on the exec side ever wrote to that ledger. The consequence was
    // that a Governor could not read back a file it had itself just created: the read hook
    // denied it with "No provenance for <path>".
    //
    // appliedFiles holds the RELATIVE form (every push site stores `target`; the absolute
    // form is derived separately into `absPath`), which is exactly the form
    // redirect-read-to-agent.mjs supplies after its path.relative() call. Both copies of
    // normalizePath canonicalize against the same project root, so the write and the read
    // compare equal.
    //
    // Best-effort, following the fetch-raw precedent: the ledger is advisory and a failure
    // here must never fail an otherwise-applied plan.
    for (const appliedPath of appliedFiles) {
      try {
        recordWrittenPath(appliedPath);
      } catch {
        /* advisory only */
      }
    }

    // Layer 3: Test coverage analysis
    const testFilesModified = appliedFiles.filter(isTestFile);
    const codeFilesModified = appliedFiles.filter(f => 
      !isTestFile(f) && f.match(/\.(js|mjs|ts)$/)
    );

    let testCoverageWarning = null;
    if (codeFilesModified.length > 0 && testFilesModified.length === 0) {
      testCoverageWarning = `Modified ${codeFilesModified.length} code file(s) but no test files were updated`;
      console.error(`[rks_exec] Warning: ${testCoverageWarning}`);
    }

    return {
      ok: true,
      projectId,
      slug: slug || runMeta.slug || path.basename(runDir).split("_").slice(1).join("_"),
      runId: path.basename(runDir),
      stepsApplied: stepsApplied.length,
      appliedFiles,
      testFilesModified,
      codeFilesModified: codeFilesModified.length,
      testCoverageWarning,
    };
  } catch (error) {
    fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n${error.message}\n`, "utf8");
    finalizeRunMeta("failed");
    // backlog.fix.command-policy-integrity-across-runs: a failing step (a run_command that rewrote the
    // policy and then exited non-zero) throws past the per-step check. A force caller has no exit seam
    // behind it, so restore the policy here (worktree and index only, never HEAD) and carry the outcome
    // on the error. In exec context runExecTool's exit seam does this.
    if (!_execContext && applyPolicyBaseline) {
      try {
        const check = checkCommandPolicyIntegrity(projectRoot, applyPolicyBaseline, { restorable: ["worktree", "index"] });
        if (check.changed) {
          console.error(`[rks_exec] policy integrity: failed apply changed ${COMMAND_POLICY_RELATIVE_PATH} (${describePolicyParts(check.changedParts)}); restored [${describePolicyParts(check.restored)}], failed [${describePolicyParts(check.restoreFailed)}]`);
          try {
            error.commandPolicyRestored = { changedParts: check.changedParts, restored: check.restored, restoreFailed: check.restoreFailed, unrevertedParts: check.unrevertedParts };
          } catch { /* not attachable */ }
        }
      } catch (policyErr) {
        console.error(`[rks_exec] policy integrity check after a failed apply could not run: ${policyErr?.message ?? policyErr}`);
      }
    }
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, error.message || String(error));
  }
}

/**
 * Reset a story stranded at 'executing' back to 'arch-approved' so it is re-plannable.
 * A test-failed rollback or aborted run must not leave the phase at 'executing' (excluded
 * from PLANNABLE_PHASES) — that wedges every re-plan with state_transition_failed. This is a
 * RESET, not a forward transition (advancePhase has no reverse edge out of 'executing'), so
 * the field is written directly. Best-effort no-op when the story isn't at 'executing' or
 * can't be loaded. Returns true iff a reset was applied.
 */
export function resetStalePhaseToArchApproved(projectRoot, storyId) {
  if (!storyId) return false;
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const story = loadStory(projectRoot, storyId);
    if (story?.frontmatter?.phase === PHASE_GATE_EXEC) {
      updateField(notesDir, storyId, "phase", "arch-approved");
      return true;
    }
  } catch {
    /* best-effort */
  }
  return false;
}

/**
 * Abort an incomplete exec run and clean up state.
 * Use this when exec fails mid-execution and leaves behind incomplete state.
 */
async function runExecAbortTool({ projectId, reason }) {
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;

  // Find incomplete exec run using same logic as exec detection
  const incompleteRuns = findIncompleteRuns(projectRoot);
  const incompleteRun = incompleteRuns.length > 0 ? {
    runId: incompleteRuns[0].runId,
    statePath: path.join(projectRoot, ".rks", "runs", incompleteRuns[0].runId, "exec-state.json"),
    phase: incompleteRuns[0].state.currentPhase,
    storyId: incompleteRuns[0].state.storyId,
    completedSteps: incompleteRuns[0].state.completedSteps?.length || 0,
  } : null;

  if (!incompleteRun) {
    // P0-2 RESET leg: there's no recoverable run record, but a story can still be stranded
    // at phase 'executing' (exec interrupted before/without a usable exec-state). Scan the
    // notes for executing stories and reset EXACTLY ONE back to 'arch-approved' so rks_plan
    // re-accepts it. 0 → unchanged no-op; >1 → refuse and list candidates (never guess which).
    const notesDir = resolveNotesDir(projectRoot);
    const stranded = [];
    try {
      if (fs.existsSync(notesDir)) {
        for (const file of fs.readdirSync(notesDir)) {
          if (!file.endsWith(".md")) continue;
          const content = fs.readFileSync(path.join(notesDir, file), "utf8");
          if (!/^phase:\s*["']?executing["']?\s*$/m.test(content)) continue;
          const idMatch = content.match(/^id:\s*["']?([^"'\n]+)["']?\s*$/m);
          stranded.push(idMatch ? idMatch[1].trim() : file.replace(/\.md$/, ""));
        }
      }
    } catch (e) { /* scan is best-effort */ }

    if (stranded.length === 0) {
      return {
        ok: false,
        error: "No incomplete exec run found",
        hint: "Nothing to abort. You can run rks_exec to start a new execution.",
      };
    }
    if (stranded.length > 1) {
      return {
        ok: false,
        error: "Multiple stories stranded at phase 'executing'",
        candidates: stranded,
        hint: `Ambiguous recovery: ${stranded.length} stories are at phase 'executing' (${stranded.join(", ")}). Abort will not guess which to reset — re-run rks_plan on the intended story, or resolve manually.`,
      };
    }

    // Exactly one stranded story — reset it to arch-approved (a reset, not a forward op,
    // so write the field directly, mirroring the planner-persistence re-plan reset).
    const storyId = stranded[0];
    updateField(notesDir, storyId, "phase", "arch-approved");
    // backlog.fix.exec-abort-cleanup-observed: report the phase OBSERVED on disk, not a literal.
    const observedPhase = readStoryPhaseFromDisk(projectRoot, storyId);
    const strandedOk = observedPhase === "arch-approved";
    try {
      const collector = ensureTelemetryStorage(projectRoot);
      collector.emit("exec.abort", projectId, { reason: reason || "manual", phase: "executing", storyId, recovery: "stranded_reset" });
    } catch (e) { /* telemetry is best-effort */ }
    if (!strandedOk) {
      return {
        ok: false,
        error: "Stranded story phase reset did not take effect",
        resetStory: storyId,
        phase: observedPhase,
        storyId,
        hint: `Story ${storyId} was stranded at 'executing'; the reset to 'arch-approved' was attempted but the note is observed at '${observedPhase}'. Set its phase manually.`,
      };
    }
    return {
      ok: strandedOk,
      resetStory: storyId,
      phase: observedPhase,
      storyId,
      requiredNext: `rks_plan { "projectId": "${projectId}", "problemId": "${storyId}" }`,
      hint: `Story ${storyId} was stranded at 'executing' with no recoverable run; reset to 'arch-approved'. Re-run rks_plan to re-drive it.`,
    };
  }

  // backlog.fix.exec-abort-cleanup-observed: every cleanup outcome below is sourced from a
  // return value or a post-step observation, never from intent, and `ok` is derived from them.
  const cleanup = {};
  const failedSteps = [];

  // a. Working tree — first, so the tree is clean before any checkout. The returned object is
  // carried verbatim; a throw is captured as { cleaned: false, error }.
  try {
    cleanup.workingTree = cleanupWorkingTree(projectRoot);
  } catch (e) {
    cleanup.workingTree = { cleaned: false, error: e?.message || String(e) };
  }
  if (cleanup.workingTree?.cleaned !== true) failedSteps.push("working_tree");

  // b. Branch step. Configured base branch (same expression runExecToolInner uses), never a
  // bare hardcoded "staging". The abort result reads only cleanupFeatureBranch's `checkoutOk`,
  // `branchDeleteOk` and `errors`, never the helper's `ok`.
  const baseBranch = context.projectJson?.baseBranch || "staging";
  const branchName = incompleteRuns[0].state.branchName || null;
  if (!branchName || branchName === baseBranch) {
    cleanup.branch = {
      skipped: true,
      reason: !branchName ? "no_branch_recorded" : "branch_is_base",
    };
  } else {
    const manualCommand = `git branch -D ${branchName}`;
    // NAC: never delete an rks/ branch carrying commits not reachable from base. The check
    // runs here, before cleanupFeatureBranch, and fails closed.
    const countRes = runNoteGit(projectRoot, ["rev-list", "--count", `${baseBranch}..${branchName}`]);
    const unmergedCount = countRes.status === 0 && /^\d+$/.test(countRes.stdout.trim())
      ? Number(countRes.stdout.trim())
      : null;
    if (unmergedCount === null || unmergedCount > 0) {
      // Keep the branch, but still restore the base branch; checkoutOk is the observed exit status.
      const checkoutRes = runNoteGit(projectRoot, ["checkout", baseBranch]);
      cleanup.checkoutOk = checkoutRes.status === 0;
      cleanup.branchDeleteOk = false;
      cleanup.branch = {
        kept: true,
        reason: unmergedCount === null ? "unmerged_check_failed" : "unmerged_commits",
        branchName,
        baseBranch,
        unmergedCount,
        manualCommand,
        ...(unmergedCount === null
          ? { error: (countRes.stderr || countRes.error || "").trim() || `rev-list exited ${countRes.status}` }
          : {}),
      };
      if (!cleanup.checkoutOk) {
        cleanup.branch.checkoutError = (checkoutRes.stderr || checkoutRes.error || "").trim() || `checkout exited ${checkoutRes.status}`;
        failedSteps.push("checkout");
      }
      failedSteps.push("branch_kept");
    } else {
      const fb = cleanupFeatureBranch(projectRoot, branchName, baseBranch);
      cleanup.checkoutOk = fb.checkoutOk === true;
      cleanup.branchDeleteOk = fb.branchDeleteOk === true;
      cleanup.errors = Array.isArray(fb.errors) ? fb.errors : [];
      cleanup.branch = { branchName, baseBranch, unmergedCount };
      if (!cleanup.checkoutOk) failedSteps.push("checkout");
      if (!cleanup.branchDeleteOk) {
        cleanup.branch.failedStep = "branch_delete";
        cleanup.branch.error = cleanup.errors.find((m) => /delete branch/i.test(m)) || cleanup.errors.join("; ") || "branch delete failed";
        cleanup.branch.manualCommand = manualCommand;
        failedSteps.push("branch_delete");
      }
    }
  }

  // c. State file — removed only when unlinkSync returned without throwing.
  try {
    fs.unlinkSync(incompleteRun.statePath);
    cleanup.stateRemoved = true;
  } catch (e) {
    cleanup.stateRemoved = false;
    cleanup.stateError = e?.message || String(e);
    failedSteps.push("state_file");
  }

  // Emit telemetry
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("exec.abort", projectId, {
      runId: incompleteRun.runId,
      reason: reason || "manual",
      phase: incompleteRun.phase,
      storyId: incompleteRun.storyId,
    });
  } catch (e) {
    // Telemetry is best-effort
  }

  // Also reset the story's lifecycle phase: an aborted run must not leave the story stranded
  // at 'executing' (excluded from PLANNABLE_PHASES), which would wedge re-plan. The no-record
  // leg above already does this; the run-record leg must too.
  // d. Phase — observed by re-reading the note from disk before and after the reset. The
  // function's boolean return is NOT evidence (it returns true after an unchecked updateField).
  cleanup.phaseBefore = readStoryPhaseFromDisk(projectRoot, incompleteRun.storyId);
  resetStalePhaseToArchApproved(projectRoot, incompleteRun.storyId);
  cleanup.phaseAfter = readStoryPhaseFromDisk(projectRoot, incompleteRun.storyId);
  cleanup.phaseReset = cleanup.phaseBefore === PHASE_GATE_EXEC && cleanup.phaseAfter === "arch-approved";
  if (cleanup.phaseBefore === PHASE_GATE_EXEC && cleanup.phaseAfter !== "arch-approved") failedSteps.push("phase_reset");

  // e. ok — derived only from the observed outcomes above.
  const ok = failedSteps.length === 0;

  return {
    ok,
    abortedRun: incompleteRun.runId,
    phase: incompleteRun.phase,
    storyId: incompleteRun.storyId,
    cleanup,
    ...(ok
      ? {
        requiredNext: `rks_plan { "projectId": "${projectId}" }`,
        hint: "Exec aborted. You can now retry with rks_plan or refine the story.",
      }
      : {
        failedSteps,
        error: `Exec abort cleanup incomplete: ${failedSteps.join(", ")}`,
        hint: `Exec run ${incompleteRun.runId} was aborted but cleanup did not fully succeed (${failedSteps.join(", ")}). Inspect result.cleanup${cleanup.branch?.manualCommand ? `; to remove the branch manually run: ${cleanup.branch.manualCommand}` : ""}.`,
      }),
  };
}

/**
 * Read a story note's phase from disk (no cache). Returns null when the note cannot be read.
 */
function readStoryPhaseFromDisk(projectRoot, storyId) {
  if (!storyId) return null;
  try {
    return loadStory(projectRoot, storyId)?.frontmatter?.phase ?? null;
  } catch {
    return null;
  }
}

export {
  runExecTool,
  runApplyTool,
  runExecAbortTool,
  cleanupFeatureBranch,
  runCheckedGit,
  getCurrentBranch,
  isWorkingTreeClean,
  hasGitRepo,
  runGit,
  getUncommittedFiles,
  assertCleanWorkingTree,
};
