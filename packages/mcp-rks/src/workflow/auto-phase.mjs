/**
 * Auto-Phase Module
 * Automatic phase transitions after successful operations.
 * Uses state-machine.mjs for validation and dendron.mjs for updates.
 *
 * Story 1 (backlog.feat.phase-machine-foundation): with PHASE_MACHINE in place
 * and OPERATION_TRANSITIONS.<op>.from as an array (multi-source), advancePhase
 * delegates from-phase validation entirely to validateTransition(story, expected.to).
 * It does NOT read expected.from directly or duplicate the from-phase check —
 * validateTransition is the single source of truth for transition validation.
 * The integrity test suite pins this delegation by source-grep + mock-throw.
 */
import { validateTransition } from "./state-machine.mjs";
import { resolveNotesDir, updateField, parseFrontmatter } from "../dendron.mjs";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { OPERATION_TRANSITIONS, PHASE_MACHINE } from "./phases.mjs";
import fs from "fs";
import path from "path";
// execFileSync, not execSync: the story id reaches git as an argv element, never through a
// shell, so a dot or a shell metacharacter in a note name cannot be interpreted.
import { execFileSync } from "node:child_process";

/**
 * Resolve a v1 legacy operation name to its v2 equivalent.
 *
 * Behavior contract:
 *   - If `operationName` is a recognized v2 op (key in OPERATION_TRANSITIONS),
 *     return it unchanged.
 *   - Else if `operationName` is in PHASE_MACHINE.legacyAcceptedOperations,
 *     return the v2 mapping.
 *   - Else return null.
 *
 * R1.3e wired this helper into `advancePhase` so any caller passing a v1 op
 * name flows through legacyAcceptedOperations. Today's legacy map values
 * (plan, exec, ship, cycle_complete) are all also OPERATION_TRANSITIONS keys
 * — pass-through is a no-op. The mapping becomes load-bearing in R1.4 when
 * the v1 transition rows are retired from PHASE_MACHINE.transitions.
 */
export function resolveOperation(operationName) {
  if (OPERATION_TRANSITIONS[operationName]) return operationName;
  const legacyMap = PHASE_MACHINE.legacyAcceptedOperations || {};
  if (legacyMap[operationName]) return legacyMap[operationName];
  return null;
}

/**
 * Advance story phase after a successful operation.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} problemId - Story/problem identifier
 * @param {string} operation - Operation type: 'plan' | 'exec' | 'ship'
 * @param {string} projectId - Project identifier for telemetry
 * @returns {Promise<{ok: boolean, from?: string, to?: string, error?: string}>}
 */
export async function advancePhase(projectRoot, problemId, operation, projectId = "unknown") {
  const collector = ensureTelemetryStorage(projectRoot);
  // R1.3e: route the caller-supplied op name through resolveOperation so v1 legacy
  // names get translated to their v2 equivalents via PHASE_MACHINE.legacyAcceptedOperations.
  // Today's legacy names are all also OPERATION_TRANSITIONS keys, so this is a no-op
  // pass-through until R1.4 retires the v1 rows.
  const resolvedOperation = resolveOperation(operation);
  if (!resolvedOperation) {
    return { ok: false, error: `Unknown operation: ${operation}` };
  }
  const expected = OPERATION_TRANSITIONS[resolvedOperation];

  try {
    // Load current story phase
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);

    if (!fs.existsSync(storyPath)) {
      // Story might have been moved (e.g., to z_implemented)
      // This is OK for ship operations
      if (operation === "ship") {
        return { ok: true, from: "executed", to: "integrated", note: "Story already moved" };
      }
      return { ok: false, error: `Story not found: ${problemId}` };
    }

    const content = fs.readFileSync(storyPath, "utf8");
    const { data: frontmatter } = parseFrontmatter(content);
    const currentPhase = frontmatter.phase || "draft";

    // Validate transition
    const validation = await validateTransition(
      { phase: currentPhase, ...frontmatter },
      expected.to
    );

    if (!validation.valid) {
      collector.emit("auto_phase.invalid", projectId, {
        problemId,
        operation,
        from: currentPhase,
        to: expected.to,
        error: validation.error
      });
      return {
        ok: false,
        from: currentPhase,
        to: expected.to,
        error: validation.error || `Cannot transition ${currentPhase}→${expected.to}`
      };
    }

    // Update phase
    updateField(notesDir, problemId, "phase", expected.to);

    collector.emit("auto_phase.transition", projectId, {
      problemId,
      operation,
      from: currentPhase,
      to: expected.to
    });

    return { ok: true, from: currentPhase, to: expected.to };
  } catch (error) {
    collector.emit("auto_phase.error", projectId, {
      problemId,
      operation,
      error: error.message
    });
    return { ok: false, error: error.message };
  }
}

/**
 * Reconcile a story stuck at 'executing' up to 'executed' before an on-rail ship.
 *
 * Root cause this addresses: rks_exec is supposed to fire exec_end (executing →
 * executed), but when it doesn't complete the story reaches ship still at 'executing'.
 * The ship path then attempts the single executed → integrated hop, which
 * validateTransition rejects as "Invalid transition: executing → integrated" — the
 * merge succeeds but the phase stays stuck and rks_release never sees the story as
 * releasable (releasedStories: []).
 *
 * This is a CONDITIONAL PRE-STEP: it fires ONLY when the story is at 'executing',
 * delegating the legitimate executing → executed hop to advancePhase('exec_end').
 * A story already at 'executed' (the normal happy path) is a no-op — the caller's
 * subsequent advancePhase(...,'ship') then does the single executed → integrated hop
 * exactly as before. It NEVER reads a transition's .from/expected.from — it delegates
 * entirely to advancePhase, walking only the existing legitimate gateless hops.
 *
 * Exported so the off-rail phase-reconciliation path (guardrails-audit cycle_complete)
 * can reuse the same walk.
 *
 * @returns {Promise<{ok:boolean, reconciled:boolean, from?:string, to?:string, error?:string}>}
 */
export async function reconcileExecutingBeforeShip(projectRoot, problemId, projectId = "unknown") {
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);
    if (!fs.existsSync(storyPath)) {
      // Story already moved (e.g. to z_implemented) — nothing to reconcile; let ship handle it.
      return { ok: true, reconciled: false };
    }
    const content = fs.readFileSync(storyPath, "utf8");
    const { data: frontmatter } = parseFrontmatter(content);
    const currentPhase = frontmatter.phase || "draft";
    if (currentPhase !== "executing") {
      // Happy path (already 'executed') or any other phase — no pre-step needed.
      return { ok: true, reconciled: false, from: currentPhase };
    }
    // Delegate the executing → executed hop to advancePhase('exec_end').
    const result = await advancePhase(projectRoot, problemId, "exec_end", projectId);
    return { ...result, reconciled: result.ok };
  } catch (error) {
    return { ok: false, reconciled: false, error: error.message };
  }
}

// The sanctioned OFF-RAIL phase ladder (mirrors the guardrails_off / guardrails_on ops in
// phases.mjs): arch-approved --guardrails_off--> executing --guardrails_on.commit--> executed
// --guardrails_on.merge--> integrated. Each `op` is a real OPERATION_TRANSITIONS key whose
// `.to` is the next phase; reconcileToIntegrated delegates each hop to advancePhase.
const OFF_RAIL_LADDER = [
  { from: "arch-approved", op: "guardrails_off" }, // -> executing
  { from: "executing", op: "guardrails_on.commit" }, // -> executed
  { from: "executed", op: "guardrails_on.merge" }, // -> integrated
];

/**
 * Walk an OFF-RAIL story from its CURRENT phase up to 'integrated' along the off-rail ladder,
 * delegating each hop to advancePhase. The off-rail flow never runs rks_exec, so guardrails_on's
 * cycle_complete is the only place these phases advance — without this, off-rail-shipped stories
 * stay stuck at 'arch-approved' and rks_release reports releasedStories:[] forever.
 *
 * Phase-indexed (walks only the remaining hops from the story's current phase) and
 * delegation-only (never writes phase raw, never reads a transition's `.from` — the
 * phase-machine-integrity pin). Best-effort / fail-safe: already-integrated is a no-op, a
 * phase with no ladder step stops cleanly, and it NEVER throws — a phase-advance failure must
 * not undo a merge+push that already succeeded.
 *
 * @returns {Promise<{ok:boolean, advanced:boolean, from?:string, to?:string, error?:string}>}
 */
export async function reconcileToIntegrated(projectRoot, problemId, projectId = "unknown") {
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);
    if (!fs.existsSync(storyPath)) return { ok: true, advanced: false };
    let advanced = false;
    // Bounded by the ladder length — one hop per iteration; re-read the phase each time.
    for (let i = 0; i <= OFF_RAIL_LADDER.length; i++) {
      const { data } = parseFrontmatter(fs.readFileSync(storyPath, "utf8"));
      const phase = data.phase || "draft";
      if (phase === "integrated") return { ok: true, advanced, to: "integrated" };
      const step = OFF_RAIL_LADDER.find((s) => s.from === phase);
      if (!step) return { ok: true, advanced, from: phase, note: "no off-rail ladder step from this phase" };
      const r = await advancePhase(projectRoot, problemId, step.op, projectId);
      if (!r.ok) return { ok: false, advanced, from: phase, error: r.error };
      advanced = true;
    }
    return { ok: false, advanced, error: "off-rail ladder did not converge on integrated" };
  } catch (error) {
    return { ok: false, advanced: false, error: error.message };
  }
}

/**
 * Is a commit carrying THIS story's trailer reachable from `ref`?
 *
 * backlog.fix.phase-advance-suppression-terminal-and-remedy-inoperative. This is the evidence
 * the repair rests on, and it is deliberately NOT a copy of the probe at `review.mjs`, which
 * this story's QA measured as unsafe to reuse for an ADMISSION decision, for two reasons:
 *
 *  1. `--fixed-strings` appears nowhere in `packages/mcp-rks/src`, so that probe's `--grep` is
 *     an unanchored REGEX. Dots are wildcards, and — worse — a story id that is a strict prefix
 *     of a longer id matches the longer id's trailer as a substring. `foo.bar` would be admitted
 *     by `foo.bar.baz`'s commit. Fixed-strings alone does not fix that, so the candidate set is
 *     re-verified line-exactly below.
 *  2. `isDiffPartialForStory` returns `true` from its catch. That is fail-SAFE for the question
 *     "is this diff partial" and fail-OPEN for "may this story advance". This returns null on
 *     any git failure, and the caller refuses.
 *
 * @returns {{sha: string}|null} The first matching commit, or null for no evidence.
 * @throws {Error} If git itself fails. The caller must NOT treat a throw as "no evidence".
 */
function findStoryTrailerCommit(projectRoot, problemId, ref) {
  const trailer = `Story: ${problemId}`;
  // NO CANDIDATE CAP. `-n 50` bounded the MATCHES, not the history walked, and the
  // fixed-string grep matches a longer id too — `Story: foo` is a substring of
  // `Story: foo.child`. Fifty newer sibling-id commits therefore hid the real one, and the
  // caller reported no_merged_commit_for_story: a false absence, on an ADMISSION decision.
  // Every candidate reachable from `ref` is line-exact checked before absence is reported.
  //
  // ONE git call, not one per candidate. The body travels with the hash, so an unbounded
  // candidate set costs one process rather than N. The separators are the ASCII unit and
  // record separators, which cannot occur in a commit message read back by git.
  const raw = execFileSync(
    "git",
    ["log", "--format=%H%x1f%B%x1e", "--fixed-strings", `--grep=${trailer}`, ref],
    { cwd: projectRoot, encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
  );

  for (const record of raw.split("\x1e")) {
    const sep = record.indexOf("\x1f");
    if (sep === -1) continue;
    const sha = record.slice(0, sep).trim();
    const body = record.slice(sep + 1);
    // Line-EXACT. A substring test is what admits the longer sibling id.
    if (sha && body.split("\n").some((line) => line.trim() === trailer)) return { sha };
  }
  return null;
}

/**
 * Advance a story to `integrated` AFTER a suppressed ship, on the evidence of a merged commit.
 *
 * WHY THIS EXISTS. `resolvePhaseAdvanceSuppression` can refuse to advance a phase while the
 * off-rail ship has already committed, merged and pushed. Before this, that state was terminal:
 * `reconcileToIntegrated`'s single call site is the arm the suppression skips, `guardrails-audit`
 * never calls `advancePhase`, and the story agent's `advance_phase` admits only plan/exec/ship —
 * `ship` legal only from `executed`. A story whose code was on `main` kept a phase saying it was
 * never built, with no sanctioned way forward.
 *
 * WHAT IT MAY NOT DO. Advancing a story whose code did NOT merge is worse than a stale phase, so
 * every exit below is a REFUSAL unless positive evidence is in hand:
 *   - no trailer commit reachable from the integration branch  → refuse, naming the missing evidence
 *   - the git probe itself failed                              → refuse. NOT "no evidence" —
 *                                                                 an unreadable repository is not
 *                                                                 proof a story did not ship
 *   - the phase has no off-rail ladder entry                   → refuse, NAMING the phase, rather
 *                                                                 than the silent clean stop
 *                                                                 reconcileToIntegrated makes
 *   - already integrated                                       → explicit no-op, NOT a repair
 *
 * It asserts nothing false. `phases.mjs` declares a second sanctioned ladder out of `arch-approved`
 * — guardrails_off → guardrails_on.commit → guardrails_on.merge — and for a story that genuinely
 * went off-rail all three DID happen; the trailer commit is what makes them true. It adds no
 * transition, and deliberately does not reinstate the manual `reset_to_integrated` edge that
 * `phases.mjs` records as having existed and been removed.
 *
 * @returns {Promise<{ok:boolean, repaired:boolean, reason?:string, from?:string, to?:string, evidence?:object, error?:string}>}
 */
export async function repairPhaseToIntegrated(
  projectRoot,
  problemId,
  projectId = "unknown",
  { integrationBranch = "staging" } = {},
) {
  const notesDir = resolveNotesDir(projectRoot);
  const storyPath = path.join(notesDir, `${problemId}.md`);
  if (!fs.existsSync(storyPath)) {
    return { ok: false, repaired: false, reason: "story_not_found", error: `No note at ${problemId}` };
  }

  const { data } = parseFrontmatter(fs.readFileSync(storyPath, "utf8"));
  const phase = data.phase || "draft";

  if (phase === "integrated" || phase === "released") {
    // Reported as what it is. Calling this a successful repair would be the same class of
    // false status the story exists to remove.
    return { ok: true, repaired: false, reason: "already_advanced", from: phase };
  }

  if (!OFF_RAIL_LADDER.some((s) => s.from === phase)) {
    return {
      ok: false,
      repaired: false,
      reason: "phase_not_on_off_rail_ladder",
      from: phase,
      error:
        `Story is at '${phase}', which has no off-rail ladder entry. The ladder admits ` +
        `${OFF_RAIL_LADDER.map((s) => s.from).join(", ")}. This is a refusal rather than a silent stop.`,
    };
  }

  let evidence;
  try {
    evidence = findStoryTrailerCommit(projectRoot, problemId, integrationBranch);
  } catch (error) {
    return {
      ok: false,
      repaired: false,
      reason: "evidence_unreadable",
      from: phase,
      error: `Could not read git history on '${integrationBranch}': ${error.message}`,
    };
  }

  if (!evidence) {
    return {
      ok: false,
      repaired: false,
      reason: "no_merged_commit_for_story",
      from: phase,
      error:
        `No commit carrying the trailer 'Story: ${problemId}' is reachable from ` +
        `'${integrationBranch}'. The phase is not advanced, because there is no evidence the ` +
        `implementation merged.`,
    };
  }

  const result = await reconcileToIntegrated(projectRoot, problemId, projectId);
  return {
    ...result,
    repaired: result.ok === true && result.advanced === true,
    from: phase,
    evidence: { commit: evidence.sha, branch: integrationBranch, trailer: `Story: ${problemId}` },
  };
}

/**
 * Get the expected phase transition for an operation.
 * Useful for validation and display purposes.
 */
export function getExpectedTransition(operation) {
  return OPERATION_TRANSITIONS[operation] || null;
}
