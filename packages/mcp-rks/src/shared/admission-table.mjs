// backlog.feat.admission-decision-table-decide
//
// The admission decision for every MCP tools/call, held as data (ADMISSION_TABLE) and evaluated by
// one pure function (decide). Source: notes/research.2026.11.17.state-machines-and-decision-function.md
// §3 and §5 item 4.
//
// CHAIN_MACHINE (governor-state.mjs, M1) answers "which state comes next". This table answers "is
// this call admitted". The per-state tool lists that used to be the `allowed` Sets inside
// CHAIN_MACHINE live here as the chain rows. getStates().allowed, checkStateAllowed,
// classifyChainRefusal, STATE_BYPASS_TOOLS and READ_ONLY_EXEMPT_TOOLS (governor-state.mjs) and
// COMMON_TOOLS, UNPROTECTED_TOOLS, isProtectedTool, checkAllowedTool and checkToolArgs
// (governor-token.mjs) are projections of it.
//
// EVALUATION IS PER STAGE. server.mjs calls decide once per stage, at the positions the separate
// checks held before this table existed, because two things between them cannot move into one pure
// call: runPreflight (not an admission layer) sits between the lane gate and the research
// self-bootstrap, and the bootstrap creates the session every later layer reads.
//   lane      - above preflight. decideLane (lane-policy.mjs) is the single named lane predicate.
//   bootstrap - the tokenless rks_agent_research self-bootstrap, one named row.
//   session   - after the bootstrap: lease, chain, args, token and route layers.
//
// COMBINING RULE, within one stage: collect every matching row; PRIORITY deny > route > allow; deny
// rows of different layers resolve by the layer rank lane > lease > chain > args > token; then by
// row id, so the winner never depends on row order. No matching row is deny with matchedRule null.
//
// decide is PURE. Token validity, lease status, the session snapshot and the lane policy are
// computed by the server and passed in; decide never writes a session, the lease store or a note.
// The side effects a decision names (the bootstrap session, lastActivity, toolCallCounts,
// chain.violation, advanceState, the auto-route) are performed by server.mjs and by
// applyChainAdmissionEffects in governor-token.mjs.
//
// IMPORT DIRECTION. This module imports lane-policy.mjs and nothing from governor-state.mjs or
// governor-token.mjs, which both import it. So the flow/state check of validateAdmissionTable takes
// the machine as an argument: this module validates the row shape at its own load, and
// governor-state.mjs validates the rows against CHAIN_MACHINE at its load.
//
// ROW COLUMNS. Every row carries id, stage, layer, effect, reason and remedy (action is optional;
// only the bootstrap row sets it). The match columns are optional, and an absent column matches
// anything:
//   tools          - the call's tool is one of these names
//   flowType/state - the session's flow (an unrecognised flowType reads as story, as getStates does)
//                    and its chain state
//   tokenPresent, tokenValid, tokenGateArmed, leaseRefused, sessionLive, commonTool, protectedTool,
//   chainAdmitted  - boolean facts of the input (see factsOf)
//   if             - named predicates (PREDICATES) that must all hold; a leading '!' negates one
//   complementOf   - row ids of the same stage; the row matches only when none of them matches
//   detail         - (args rows) the predicate whose result carries the refusal text
//   admitsInState  - marks the rows whose tools a state admits (chainAdmitted reads them)
//
// The principal input is accepted and passed through; no row reads it yet (paper story 5).
import { decideLane } from "./lane-policy.mjs";

export const EFFECTS = Object.freeze(["allow", "deny", "route"]);
export const STAGES = Object.freeze(["lane", "bootstrap", "session"]);
export const LAYERS = Object.freeze(["lane", "token", "lease", "chain", "args", "route"]);
const PRIORITY = Object.freeze({ deny: 3, route: 2, allow: 1 });
const LAYER_RANK = Object.freeze({ lane: 5, lease: 4, chain: 3, args: 2, token: 1, route: 0 });
const FACT_COLUMNS = Object.freeze(["tokenPresent", "tokenValid", "tokenGateArmed", "leaseRefused", "sessionLive", "commonTool", "protectedTool", "chainAdmitted"]);
const ROW_KEYS = new Set(["id", "stage", "layer", "effect", "reason", "remedy", "action", "tools", "flowType", "state", "if", "complementOf", "detail", "admitsInState", ...FACT_COLUMNS]);

// ── Tool lists (moved here from governor-token.mjs and governor-state.mjs) ──

/**
 * Tools always allowed regardless of flow type (governor-token.mjs COMMON_TOOLS).
 */
export const COMMON_TOOL_NAMES = Object.freeze([
  'rks_governor_init',
  // backlog.feat.governor-session-end: a Governor ends its own session as its last call, from any
  // flow and any state, so the end call can never be a chain violation.
  'rks_governor_end',
  'rks_project_get',
  'rks_guardrails_on',
  'rks_guardrails_abort',
  'rks_guardrails_off',
  'rks_guardrails_status',
  // backlog.fix.phase-advance-suppression-terminal-and-remedy-inoperative. Common rather than
  // flow-scoped because the condition it repairs is produced by a ship that has already ENDED
  // its session — the repair legitimately runs with no live session at all, so binding it to a
  // flow would make it unreachable in exactly the state it exists for.
  'rks_phase_repair',
  'rks_agent_visual',
  // Onboarding/setup utilities — callable in any flow (mirror UNPROTECTED_TOOLS so an active
  // session can reach them; without this the chain gate returns chain_violation).
  'rks_onboarder',
  'rks_templates_list',
  // rks_ship removed — Build Governors must not call ship directly
]);

/**
 * Tools that do NOT require a Governor session token (governor-token.mjs UNPROTECTED_TOOLS).
 * Bootstrap, onboarding, and infrastructure tools that are safe to call
 * without a Governor session. Workflow tools (plan, exec, refine, ship)
 * are intentionally NOT here — they require a token so the state machine
 * can enforce sequencing.
 *
 * rks_ship and rks_story_ship are protected: a call without a live token is
 * refused, and a tokened call is gated by the session's state machine.
 */
export const UNPROTECTED_TOOL_NAMES = Object.freeze([
  'rks_governor_init',
  // backlog.feat.governor-session-end (D8, D15): unprotected so a token that is no longer live
  // reaches the handler and gets ok: true, ended: false, instead of an unauthorized rejection. It
  // can only end the session whose token the caller presents.
  'rks_governor_end',
  'rks_guardrails_on',
  'rks_guardrails_abort', // discard-exit sibling of guardrails_on — endable without a fresh token
  'rks_guardrails_status',
  // rks_guardrails_off is now PROTECTED — blocked by state machine (not in any flow)
  // rks_phase_repair is unprotected for the same reason it is COMMON: the suppressed ship that
  // creates its condition has already ended the session, so requiring a token would mean opening
  // a NEW session purely to repair bookkeeping — the "fabricate a second off-rail session"
  // outcome the story forbids. Its own refusals are the guard: it advances nothing without a
  // merged commit carrying the story's trailer.
  'rks_phase_repair',
  'rks_project_get',
  'rks_preflight',
  'rks_telemetry_query',
  'rks_telemetry_report',
  'rks_telemetry_export', // read-only export/redact of telemetry; called directly by /telemetry-export (like query/report)
  'rks_channel_preview', // read-only, local: lists what a channel publish would do; no write, no egress
  // Token-free memory save, called directly by the /memory skill. Safe ONLY because it can write
  // nothing but notes/memories.<slug>.md (no path input; slug allowlisted in commitAndEmbedNote)
  // and commitAndEmbedNote refuses on protected branches. backlog.fix.hook-memory-skill-contradiction
  'rks_memory_save',
  // Infrastructure/onboarding tools — setup/utility, not workflow-gated
  'rks_init',
  'rks_interview',
  'rks_onboarder',
  'rks_templates_list',
  'rks_story_create',
  'rks_rag_init',
  'rks_rag_embed',
  'rks_rag_query',
  'rks_rag_compact',
  // Recovery tools — must be callable to abort a stuck exec
  'rks_exec_abort',
]);

/**
 * Tools that bypass the per-state check in every flow (governor-state.mjs STATE_BYPASS_TOOLS).
 */
export const STATE_BYPASS_TOOL_NAMES = Object.freeze([
  'rks_governor_init',
  'rks_guardrails_on',
  // rks_guardrails_off intentionally NOT here — Governors must not disable guardrails.
  // It is also excluded from COMMON_TOOLS. The state machine blocks it in every state.
  'rks_guardrails_status',
  // backlog.fix.phase-advance-suppression-terminal-and-remedy-inoperative — bypasses the
  // state check for the same reason it is COMMON and UNPROTECTED. It mutates only a phase
  // field, on evidence of a commit it verifies itself, and the state it repairs is one where
  // the session that produced it is already gone.
  'rks_phase_repair',
  // rks_stash mutates the working tree, unlike the three above. It is admitted here rather
  // than to COMMON_TOOLS deliberately: STATE_BYPASS_TOOLS is consulted inside
  // checkStateAllowed, which checkAllowedTool reaches only AFTER its session lookup has
  // refused a token with no live session. Session presence is therefore a structural
  // precondition of admission, which is what guarantees setPendingStash's
  // governorSessions.get(token) hits and the endSession auto-pop can fire. COMMON_TOOLS
  // returns before that lookup and would make the guarantee silently optional. In this table
  // that precondition is the sessionLive column of the session.chain.state-bypass row.
  'rks_stash',
]);

// ── Read-only exemption (backlog.fix.governor-state-allowlist-gaps) ──
// Registered tools that only observe — no writes, no git mutation, no egress — admitted in
// every state of every flow and never moving the chain. Kept distinct from STATE_BYPASS_TOOLS
// (which holds the mutating rks_stash) and COMMON_TOOLS so membership here is itself the
// claim "read-only". Add a tool only with evidence its handler writes nothing:
//   rks_git_state         — git status/rev-parse reads (server/handlers/project-meta.mjs)
//   rks_publish_profiles  — existsSync/readFileSync of .routekit/publish-profiles.yaml
//                           (server/publish.mjs loadPublishProfiles). rks_publish, which
//                           actually publishes, is NOT here and stays refused.
export const READ_ONLY_EXEMPT_TOOL_NAMES = Object.freeze([
  'rks_git_state',
  'rks_publish_profiles',
]);

function refuseSetMutation() {
  throw new TypeError("admission: this Set is a read-only view of the admission table");
}

/**
 * backlog.feat.admission-table-review-hardening: a Set whose add, delete and clear throw, so a
 * derived view cannot drift from the rows it was built from. Populated as a plain Set first (the Set
 * constructor calls this.add while it consumes the iterable), then the three mutators are shadowed
 * on the instance and the instance is frozen. Reads (has, size, iteration order, spread,
 * instanceof Set) are a plain Set's.
 * @param {Iterable<string>} values
 * @returns {Set<string>}
 */
export function readOnlySet(values) {
  const set = new Set(values);
  for (const method of ["add", "delete", "clear"]) {
    Object.defineProperty(set, method, { value: refuseSetMutation, writable: false, enumerable: false, configurable: false });
  }
  return Object.freeze(set);
}

/**
 * Dendron namespace enforcement map.
 * Maps flowType to allowed note namespaces for write operations.
 * 'open' flow (PO + Research) can write to all note namespaces.
 * 'story' flow (Build) can only write to backlog.* (for phase transitions).
 * Frozen, with read-only Set values (readOnlySet), so namespaceAllowlistRefusal cannot drift.
 */
export const NAMESPACE_ALLOWLIST = Object.freeze({
  open: null,  // null = all namespaces allowed
  story: readOnlySet(['backlog']),
  qa: readOnlySet(['qa', 'backlog']),
});

/** Dendron tools that perform write operations */
export const DENDRON_WRITE_TOOLS = new Set([
  'dendron_create_note',
  'dendron_edit_note',
  'dendron_update_field',
  'dendron_update_fields',
  // backlog.feat.dendron-rename-note-wikilinks: roster parity. It carries { from, to }, not
  // `filename`, so the namespace check (guarded by a non-empty filename) never refuses it.
  'dendron_rename_note',
]);

// ── Per-state admission (the former CHAIN_MACHINE `allowed` Sets) ────
//
// One list per flow and state, in the insertion order the Sets had: checkStateAllowed's refusal
// text joins them in this order. Every state of every CHAIN_MACHINE flow has exactly one list
// (governor-state.mjs checks it at load). A tool listed here with no transitions entry in
// CHAIN_MACHINE self-loops; admitting a tool and moving the chain are separate edits.
const CHAIN_STATE_TOOLS = {
  story: {
    init: [
      'rks_refine',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_agent_dendron',
      'rks_project_get',
      'rks_preflight',
      'rks_analyze',
      'rks_exhaustive_search',
      // Hook chain misconfig fix: wherever the rks_agent_dendron wrapper is
      // allowed, the underlying dendron tools must also be allowed — the
      // wrapper internally invokes the same calls, so denying them at the
      // chain level while permitting the wrapper is a contradiction users
      // hit cold (3 separate workarounds during the v1→v2 phase machine arc).
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
    ],
    refining: [
      'rks_refine',
      'rks_refine_apply',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_plan',
      'rks_plan_ready',
      'rks_preflight',
      'rks_analyze',
      'rks_project_get',
      // Dendron tools for decompose path
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
      // backlog.fix.governor-phase-state-desync-and-recovery
      //
      // rks_exec_abort is THE registered recovery for a story stranded at phase `executing`
      // — exec.mjs says so verbatim in its own error text. But its allowlist membership was
      // confined to the exec-side states, so from `refining` it was blocked too. In the
      // observed wedge that meant all three exits were shut at once: rks_exec blocked by
      // state, rks_plan blocked by phase, rks_exec_abort blocked by state. The registered
      // recovery existing but being unreachable is worse than no recovery at all, because
      // the error text names a tool the caller is then refused.
      'rks_exec_abort',
    ],
    'decompose-gated': [
      'rks_refine_apply',
      'rks_plan',
      'rks_project_get',
    ],
    planning: [
      'rks_plan_review',
      'rks_agent_git',
      'rks_project_get',
      // The recovery pair. Deliberately minimal: both EXIT to `refining` via `transitions` below,
      // so `planning` stays genuinely transient rather than becoming a general-purpose state. One
      // hop restores the full toolkit — `refining` already permits rks_exhaustive_search,
      // rks_plan_ready and all four dendron_* tools.
      'rks_refine',
      'rks_refine_apply',
    ],
    planned: [
      'rks_exec',
      'rks_plan_review',
      'rks_agent_git',
      'rks_project_get',
      // Recovery tools — re-plan / refine from planned (exec throws now route to refining, not here)
      'rks_refine',
      'rks_plan',
      'rks_agent_research',
      'rks_agent_external_research',
      // backlog.fix.planned-state-readonly-regression-and-search-admission
      //
      // Admitted so a plan can be VERIFIED before it executes. Previously the only state
      // allowing rks_exhaustive_search was `refining`, and the only route from `refining`
      // back to `planned` is a re-plan — which produces a DIFFERENT plan hash. So the plan
      // that actually landed could never be the plan that was inspected: byte-level checking
      // of the executing plan was structurally impossible, not merely awkward.
      //
      // Deliberately NOT given a transitions entry below. getNextState returns
      // `transitions?.[tool] || currentState`, so an allowed tool with no mapping self-loops
      // — which is exactly the read-only semantics wanted here. `child_active` is the
      // standing precedent: it already holds rks_exhaustive_search and rks_exec in one
      // allowed set and self-loops its research tool rather than demoting it.
      'rks_exhaustive_search',
    ],
    executing: [
      'rks_exec_abort',
      'rks_agent_git',
      'rks_project_get',
      'rks_exec',    // Allow retry from executing state
    ],
    'approval-pending': [
      'rks_approve',
      'rks_agent_git',
      'rks_project_get',
    ],
    diverged: [
      'rks_refine',
      'rks_refine_apply',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
    ],
    'test-failed': [
      'rks_refine',
      'rks_refine_apply',
      'rks_exec_abort',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
      // backlog.fix.governor-state-tool-admission-gaps (Instance 1)
      //
      // Admitted so the state an exec failure lands in can read the tree it just failed
      // against, matching `planned` and `executed`. READ-ONLY: deliberately given NO
      // transitions entry below, so getNextState self-loops in `test-failed`.
      'rks_exhaustive_search',
      // rks_exec is deliberately NOT admitted here (decision recorded per the story).
      // The sanctioned recovery path stays test-failed → refining → planning → planned →
      // executing. Admitting rks_exec would let a Governor re-run the SAME plan without
      // refining it — a possible flaky-test re-run, but equally an unbounded retry of a plan
      // that cannot pass, with no refinement in between. The story's Decisions do not choose
      // the re-run behaviour, so the conservative choice is kept. If it is ever admitted it
      // must be paired with `rks_exec: 'executing'` in transitions, not left to self-loop.
    ],
    executed: [
      'rks_ship',
      'rks_story_ship',
      'rks_agent_git',
      'rks_project_get',
      'rks_exhaustive_search',
      'dendron_read_note',
    ],
    shipping: [
      'rks_agent_git',
      'rks_project_get',
    ],
    decomposing: [
      'rks_refine',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
      'dendron_read_note',
    ],
    child_active: [
      'rks_refine',
      'rks_refine_apply',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_plan',
      'rks_plan_ready',
      'rks_plan_review',
      'rks_exec',
      'rks_exec_abort',
      'rks_ship',
      'rks_preflight',
      'rks_analyze',
      'rks_project_get',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
    ],
    shipped: [
      'rks_project_get',
    ],
    escalated: [
      'rks_exec_abort',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
      'dendron_read_note',
    ],
    failed: [
      'rks_project_get',
    ],
  },
  qa: {
    init: [
      'rks_governor_init',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
      'rks_preflight',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
    ],
    researching: [
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_agent_run',
      'rks_exhaustive_search',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
      'rks_project_get',
    ],
    qa_testing: [
      'rks_agent_git',
      'rks_agent_run',
      'rks_project_get',
      'dendron_read_note',
    ],
    qa_assessing: [
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_update_field',
      'dendron_update_fields',
      'rks_project_get',
    ],
    qa_reporting: [
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_update_field',
      'dendron_update_fields',
      'rks_project_get',
    ],
    shipped: [
      'rks_project_get',
    ],
    failed: [
      'rks_project_get',
    ],
  },
  open: {
    init: [
      'rks_agent_research',
      'rks_agent_external_research',
      // rks_fetch_raw: research-governor toolbox member, mirrors external_research
      // across all open-flow states (parity). PROTECTED — needs this per-state entry.
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_recovery',
      'rks_agent_git',
      'rks_agent_dendron',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      // Hook chain misconfig fix: dendron_update_field was the lone underlying
      // dendron tool missing here even though the wrapper is allowed. Worked
      // around 3x during the v1→v2 arc by routing through rks_agent_dendron.
      'dendron_update_field',
      'dendron_update_fields',
      // backlog.feat.dendron-rename-note-wikilinks: admitted exactly where dendron_edit_note
      // is admitted AND advances to `writing` (init and writing). No init transitions entry:
      // the init edge set is pinned (governor-state.test.mjs AC9), so here it self-loops like
      // dendron_update_field; `writing` carries its writing transition.
      'dendron_rename_note',
      // backlog.feat.remote-inbox-owner-review: admitted in open init and writing; NO init
      // transitions entry (the init edge set is pinned), so it self-loops here.
      'rks_inbox_review',
      // backlog.feat.remote-surface-lane: read-only retrieval, admitted in open init and
      // writing with NO transitions entry, so it self-loops (the init edge set is pinned).
      'rks_rag_query',
      'rks_arch_verdict',
      'rks_project_get',
      'rks_preflight',
    ],
    researching: [
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      // backlog.fix.open-flow-research-note-creation: governor-research.md step 2
      // MANDATES dendron_create_note, but this state denied it, so the documented
      // research chain was not executable without an rks_governor_init re-init.
      //
      // The open flow is ONE table serving TWO prompts. governor-po.md:39 also inits
      // open, and for the PO chain this denial WAS the gate that forces concern
      // separation and the test-file scan. So the state check may not adjudicate
      // alone: the backlog gate in governor-token.mjs (checkToolArgs, run by
      // checkAllowedTool with the call's args) rejects a `backlog.*` create until the
      // session has entered test-file-scanning (the session flag advanceState sets,
      // backlog.feat.dendron-write-arg-checks-close-bypasses), while permitting
      // design.*/research.*/notes.*.
      // checkStateAllowed() receives only three strings and cannot see tool args,
      // which is why the discriminator cannot live in this file.
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
      'rks_arch_verdict',
      'rks_project_get',
    ],
    'concern-separating': [
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      // Same rationale as researching above. dendron_edit_note and
      // dendron_update_field are restored to match researching: without them the
      // follow-up frontmatter write on a freshly created paper was equally
      // unreachable from this state.
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
      'rks_arch_verdict',
      'rks_project_get',
      // backlog.fix.governor-state-tool-admission-gaps (Instance 2, Layer 3). See the
      // rationale block on `writing` below. READ-ONLY self-loop: no transitions entry.
      'rks_plan_ready',
    ],
    'test-file-scanning': [
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      // Hook chain misconfig fix: previously denied both the wrapper and the
      // underlying dendron tools, leaving POs stranded when their step-1d
      // research transitioned them into this state (observed during the canon
      // sweep PO attempt). Symmetry rule: wrapper + all 4 underlying allowed.
      'rks_agent_dendron',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
      'rks_arch_verdict',
      'rks_project_get',
      // backlog.fix.governor-state-tool-admission-gaps (Instance 2, Layer 3). See the
      // rationale block on `writing` below. READ-ONLY self-loop: no transitions entry.
      'rks_plan_ready',
    ],
    writing: [
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'dendron_update_fields',
      // backlog.feat.dendron-rename-note-wikilinks (see init above).
      'dendron_rename_note',
      // backlog.feat.remote-inbox-owner-review (see init above).
      'rks_inbox_review',
      'rks_arch_verdict',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_project_get',
      // backlog.fix.governor-state-tool-admission-gaps (Instance 2, Layer 3).
      //
      // rks_plan_ready is admitted in exactly three open states: 'concern-separating',
      // 'test-file-scanning' and `writing`. Readiness is checked against a story that already
      // has targetFiles: PO checks it after authoring (writing), ARCH checks it while assessing,
      // and the Research Governor reaches concern-separating on its second research call.
      // NOT admitted at `init`/`researching` (no story under assessment yet), nor at `review`
      // or `failed` (terminal states — their semantics are unchanged).
      //
      // READ-ONLY: deliberately given NO transitions entry in any of the three states, so the
      // probe self-loops and never advances the PO/ARCH chain. Admission is decided here alone;
      // OPEN_FLOW_TOOLS (governor-token.mjs) also lists it, but that set only chooses redirect
      // text and admits nothing. The server handler runs
      // the probe with readOnly for any non-story session, so no phase write is reachable here.
      'rks_plan_ready',
      // backlog.feat.remote-surface-lane: read-only retrieval, self-loop, no transitions entry.
      'rks_rag_query',
    ],
    review: [
      'rks_project_get',
    ],
    failed: [
      'rks_project_get',
    ],
  },
  ship: {
    init: [
      'rks_git_commit',
      'rks_git_state',
      'rks_agent_git',
      'rks_project_get',
    ],
    committed: [
      'rks_git_push',
      'rks_staging_pr',
      // backlog.fix.ship-flow-deterministic-no-llm: the 3-branch feature-branch local merge
      // (prompt step 1.5) goes committed -> merging; a working-branch ship (skipPRAndMerge)
      // completes from committed. runCycleComplete refuses off the working branch here,
      // because the rks_cycle_complete handler passes requireWorkingBranch for this state.
      'rks_git_merge',
      'rks_cycle_complete',
      'rks_agent_git',
      'rks_project_get',
    ],
    pr_created: [
      'rks_git_merge',
      'rks_staging_merge',
      'rks_agent_git',
      'rks_project_get',
    ],
    merging: [
      'rks_cycle_complete',
      'rks_agent_git',
      'rks_project_get',
    ],
    shipped: [
      'rks_project_get',
    ],
    failed: [
      'rks_project_get',
    ],
  },
  ops: {
    init: [
      'rks_agent_run',
      'rks_agent_research',
      'rks_exhaustive_search',
      'rks_agent_recovery',
      'rks_agent_git',
      'rks_project_get',
      'rks_preflight',
      'rks_release',
      // Governed working -> integration promotion (3-branch). Mirrors rks_release:
      // init -> executing, executing self-loop.
      'rks_promote',
      // Governed publish of a clean, strictly-ahead, notes-only integration branch.
      // The handler forces strategy 'push-only' under a token. No transition (self-loop).
      'rks_sync_staging',
      'rks_tag',
    ],
    executing: [
      'rks_agent_run',
      'rks_agent_research',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_project_get',
      'rks_release',
      'rks_promote',
      'rks_sync_staging',
      'rks_tag',
    ],
    done: [
      'rks_project_get',
    ],
  },
};

// ── Named predicates ────────────────────────────────────────────────
//
// Referenced from rows by name (the `if` and `detail` columns). Each takes the decide input
// { principal, tool, args, session, context } and reads it only.

/** Lane stage: decideLane (lane-policy.mjs) refuses the call. */
export function laneRefuses({ tool, args, context = {} } = {}) {
  return decideLane({
    lane: context.lane,
    policy: context.policy,
    tool,
    args,
    tokenValid: context.tokenValid,
    bootProjectId: context.bootProjectId,
    env: context.env,
  }) !== null;
}

/**
 * Lane stage: a remote-lane call that SUPPLIED a token which is not a live remote session
 * (backlog.feat.remote-surface-lane-isolation, Decision 3b). decideRemote exempts rks_governor_init
 * from its own token check, so this is the refusal for that one admitted tool.
 */
export function remoteTokenRejected({ context = {} } = {}) {
  return context.lane === "remote" && context.tokenPresent === true && context.tokenValid !== true;
}

/** Bootstrap stage: the call carries a projectId argument. */
export function hasProjectId({ args } = {}) {
  return Boolean(args?.projectId);
}

/** Args: a dendron write tool called with an argument object (the DENDRON_WRITE_TOOLS case). */
export function isDendronWriteCall({ tool, args } = {}) {
  return Boolean(args) && typeof args === "object" && DENDRON_WRITE_TOOLS.has(tool);
}

/**
 * Args: the NAMESPACE_ALLOWLIST case. A dendron write whose filename namespace the session's flow
 * may not write. Returns the refusal detail or null.
 */
export function namespaceAllowlistRefusal(input = {}) {
  const { args, session } = input;
  if (!session || !isDendronWriteCall(input)) return null;
  const filename = args.filename;
  if (typeof filename !== "string" || !filename) return null;
  const namespace = filename.split('.')[0];
  const allowed = NAMESPACE_ALLOWLIST[session.flowType];
  if (allowed && !allowed.has(namespace)) {
    return {
      error: 'namespace_violation',
      violationKind: 'namespace',
      message: `Namespace '${namespace}' is not allowed for '${session.flowType}' flow. Allowed: ${[...allowed].join(', ')}.`,
    };
  }
  return null;
}

/**
 * Args: the open-flow PO backlog gate, enforced by namespace because the state check cannot see
 * args. NAMESPACE_ALLOWLIST maps open -> null (all namespaces), which is right for the Research
 * Governor but would also let a PO Governor create a backlog.* story without the mandatory
 * concern-separation and test-file-scan steps. backlog.feat.dendron-write-arg-checks-close-bypasses:
 * keyed to the chain TRAVERSED (the flag advanceState sets on entering test-file-scanning), not to
 * the current state, because init -> dendron_create_note/dendron_edit_note -> writing reaches
 * a state that admits dendron_create_note without any research call. Scoped to
 * dendron_create_note: editing or updating an existing backlog note is not story creation.
 */
export function openBacklogCreateRefusal(input = {}) {
  const { tool, args, session } = input;
  if (!session || !isDendronWriteCall(input)) return null;
  const filename = args.filename;
  if (typeof filename !== "string" || !filename) return null;
  const namespace = filename.split('.')[0];
  // backlog.fix.open-flow-research-session-backlog-create-gate: a session that declared
  // role 'research' at init is refused backlog.* creates however far its chain has advanced,
  // independent of openBacklogCreateAdmitted. Create-only, like the PO gate below.
  // backlog.fix.research-role-z-archive-create-gate: z_archive.* creates are refused the same
  // way, matching the research agent's own DENIED_NAMESPACES (agents/research.mjs).
  if (
    tool === 'dendron_create_note' &&
    session.flowType === 'open' &&
    session.role === 'research' &&
    (namespace === 'backlog' || namespace === 'z_archive')
  ) {
    const reason = namespace === 'backlog'
      ? 'a Research Governor session never creates backlog.* stories (story creation belongs to the PO Governor)'
      : 'a Research Governor session never creates z_archive.* notes (archiving is not research output)';
    return {
      error: 'namespace_violation',
      violationKind: 'namespace',
      message: `Namespace '${namespace}' is not allowed for an open-flow session with role 'research': ${reason}. Research notes (design.*, research.*, notes.*) are permitted here.`,
    };
  }
  if (
    tool === 'dendron_create_note' &&
    session.flowType === 'open' &&
    namespace === 'backlog' &&
    session.openBacklogCreateAdmitted !== true
  ) {
    return {
      error: 'namespace_violation',
      violationKind: 'namespace',
      message: `Namespace 'backlog' is not allowed from open-flow state '${session.state}': this session has not traversed the PO research chain (init -> researching -> concern-separating -> test-file-scanning via rks_agent_research) required before creating a story. Research notes (design.*, research.*, notes.*) are permitted here.`,
    };
  }
  return null;
}

/**
 * Args: the proto-story guard. Only open flow (PO) or QA flow can set phase to 'ready'.
 * backlog.feat.dendron-update-fields-multi-field: the multi-field tool carries the same
 * write as `fields.phase`, so it is guarded identically — skipping it would be a bypass.
 */
export function protoStoryGuardRefusal(input = {}) {
  const { tool, args, session } = input;
  if (!session || !isDendronWriteCall(input)) return null;
  const setsPhaseReady =
    (tool === 'dendron_update_field' && args.field === 'phase' && args.value === 'ready') ||
    (tool === 'dendron_update_fields' &&
      args.fields && typeof args.fields === 'object' && args.fields.phase === 'ready');
  if (setsPhaseReady && session.flowType !== 'open' && session.flowType !== 'qa') {
    return {
      error: 'proto_story_guard',
      violationKind: 'proto_story_guard',
      message: `Only PO (open flow) or QA sessions can set phase to 'ready'. Current flow: '${session.flowType}'.`,
    };
  }
  return null;
}

/** Every predicate a row may name. validateAdmissionTable resolves row references against it. */
export const PREDICATES = Object.freeze({
  laneRefuses,
  remoteTokenRejected,
  hasProjectId,
  isDendronWriteCall,
  namespaceAllowlistRefusal,
  openBacklogCreateRefusal,
  protoStoryGuardRefusal,
});

// ── Rows ────────────────────────────────────────────────────────────

const LANE_ROWS = [
  {
    id: "lane.policy-refusal", stage: "lane", layer: "lane", effect: "deny",
    if: ["laneRefuses"],
    reason: "lane_refused",
    remedy: "The decideLane refusal body names the reason and its remedy.",
  },
  {
    id: "lane.remote-token-required", stage: "lane", layer: "lane", effect: "deny",
    if: ["!laneRefuses", "remoteTokenRejected"],
    reason: "remote_token_required",
    remedy: "Call rks_governor_init (open flow) without a _governorToken, or with a token minted in the remote lane.",
  },
  {
    id: "lane.admit", stage: "lane", layer: "lane", effect: "allow",
    complementOf: ["lane.policy-refusal", "lane.remote-token-required"],
    reason: "lane_admits",
    remedy: null,
  },
];

// The self-bootstrap anomaly (corpus case ide-tokenless:rks_agent_research) is PRESERVED as exactly
// this one row, so a later story can change it as a single row edit. It lives in its own stage so no
// session-stage token or route row can outrank it; the passthrough row is its exact complement, so
// no bootstrap-stage input falls to the default deny.
const BOOTSTRAP_ROWS = [
  {
    id: "bootstrap.open.research-self-bootstrap", stage: "bootstrap", layer: "token", effect: "allow",
    tools: ["rks_agent_research"],
    tokenPresent: false,
    tokenGateArmed: true,
    if: ["hasProjectId"],
    action: "bootstrap_session",
    reason: "research_self_bootstrap",
    remedy: null,
  },
  {
    id: "bootstrap.passthrough", stage: "bootstrap", layer: "token", effect: "allow",
    complementOf: ["bootstrap.open.research-self-bootstrap"],
    reason: "no_bootstrap",
    remedy: null,
  },
];

// Shared columns. IN_MAP: a valid token whose session is in the server's session map. LIVE: the same,
// calling a tool outside COMMON_TOOLS (the COMMON_TOOLS early return precedes the session lookup, so
// no refusal row applies to a COMMON tool).
const IN_MAP = { tokenValid: true, sessionLive: true };
const LIVE = { ...IN_MAP, commonTool: false };
const REFUSAL_REMEDY = "Call rks_governor_init({ projectId }) and pass the returned token as _governorToken, with projectId, on this call";

const CHAIN_STATE_ROWS = Object.entries(CHAIN_STATE_TOOLS).flatMap(([flowType, states]) =>
  Object.entries(states).map(([state, tools]) => ({
    id: `session.chain.${flowType}.${state}`, stage: "session", layer: "chain", effect: "allow",
    ...IN_MAP, flowType, state, tools, admitsInState: true,
    reason: "chain_state_admits",
    remedy: null,
  })),
);

const SESSION_ROWS = [
  // Lease: re-verified for a PROTECTED tool with a valid token, before the chain is consulted, so a
  // refused call leaves the chain state untouched. Outranks every chain and args deny.
  {
    id: "session.lease.lost", stage: "session", layer: "lease", effect: "deny",
    tokenValid: true, protectedTool: true, leaseRefused: true,
    reason: "lease_lost",
    remedy: "Wait for the Governor holding the project to end and retry, or end this session with rks_governor_end.",
  },
  // Chain. A COMMON tool is admitted with or without a session. Where the session's state also admits
  // it, the state's own row is the match (so every per-state row is reachable, including terminal
  // states whose only tool is rks_project_get); the outcome is the same allow, and
  // applyChainAdmissionEffects applies no effect to a COMMON tool either way.
  {
    id: "session.chain.common", stage: "session", layer: "chain", effect: "allow",
    tokenValid: true, chainAdmitted: false, tools: COMMON_TOOL_NAMES,
    reason: "common_tool",
    remedy: null,
  },
  {
    id: "session.chain.no-session", stage: "session", layer: "chain", effect: "deny",
    tokenValid: true, commonTool: false, sessionLive: false,
    reason: "unauthorized",
    remedy: "Call rks_governor_init first.",
  },
  {
    id: "session.chain.state-bypass", stage: "session", layer: "chain", effect: "allow",
    ...IN_MAP, tools: STATE_BYPASS_TOOL_NAMES, admitsInState: true,
    reason: "state_bypass_tool",
    remedy: null,
  },
  {
    id: "session.chain.read-only-exempt", stage: "session", layer: "chain", effect: "allow",
    ...IN_MAP, tools: READ_ONLY_EXEMPT_TOOL_NAMES, admitsInState: true,
    reason: "read_only_exempt_tool",
    remedy: null,
  },
  ...CHAIN_STATE_ROWS,
  {
    id: "session.chain.state-refused", stage: "session", layer: "chain", effect: "deny",
    ...LIVE, chainAdmitted: false,
    reason: "chain_violation",
    remedy: "Reach a chain state that admits the tool, or abort and re-enter the flow.",
  },
  // Args: run only once the state has admitted the call (a state refusal still wins). The three
  // rows are mutually exclusive by their negated predicates, mirroring the first-failure order the
  // checks had inside checkToolArgs.
  {
    id: "session.args.namespace-allowlist", stage: "session", layer: "args", effect: "deny",
    ...LIVE, chainAdmitted: true,
    if: ["isDendronWriteCall", "namespaceAllowlistRefusal"],
    detail: "namespaceAllowlistRefusal",
    reason: "namespace_violation",
    remedy: "Write only to a namespace the session's flow admits.",
  },
  {
    id: "session.args.open-backlog-create", stage: "session", layer: "args", effect: "deny",
    ...LIVE, chainAdmitted: true,
    if: ["isDendronWriteCall", "!namespaceAllowlistRefusal", "openBacklogCreateRefusal"],
    detail: "openBacklogCreateRefusal",
    reason: "namespace_violation",
    remedy: "Traverse the PO research chain into test-file-scanning before creating a backlog story.",
  },
  {
    id: "session.args.proto-story-guard", stage: "session", layer: "args", effect: "deny",
    ...LIVE, chainAdmitted: true,
    if: ["isDendronWriteCall", "!namespaceAllowlistRefusal", "!openBacklogCreateRefusal", "protoStoryGuardRefusal"],
    detail: "protoStoryGuardRefusal",
    reason: "proto_story_guard",
    remedy: "Set phase 'ready' from a PO (open flow) or QA session.",
  },
  // Token and route: no valid token. With a valid token no token row matches (requireToken returns
  // null for a valid token), so the chain rows above decide every tokened call.
  {
    id: "session.token.unprotected", stage: "session", layer: "token", effect: "allow",
    tokenValid: false, tools: UNPROTECTED_TOOL_NAMES,
    reason: "unprotected_tool",
    remedy: null,
  },
  {
    id: "session.token.gate-bypassed", stage: "session", layer: "token", effect: "allow",
    tokenValid: false, protectedTool: true, tokenGateArmed: false,
    reason: "token_gate_bypassed",
    remedy: null,
  },
  {
    id: "session.token.supplied-invalid", stage: "session", layer: "token", effect: "deny",
    tokenValid: false, protectedTool: true, tokenGateArmed: true, tokenPresent: true,
    reason: "unauthorized",
    remedy: REFUSAL_REMEDY,
  },
  {
    id: "session.route.tokenless", stage: "session", layer: "route", effect: "route",
    tokenValid: false, protectedTool: true, tokenGateArmed: true, tokenPresent: false,
    reason: "unauthorized",
    remedy: REFUSAL_REMEDY,
  },
];

function freezeRow(row) {
  for (const key of ["tools", "if", "complementOf"]) {
    if (Array.isArray(row[key])) Object.freeze(row[key]);
  }
  return Object.freeze(row);
}

export const ADMISSION_TABLE = Object.freeze([...LANE_ROWS, ...BOOTSTRAP_ROWS, ...SESSION_ROWS].map(freezeRow));

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate a table shaped like ADMISSION_TABLE. Pure: reads only. Throws an Error naming the row on
 * a duplicate or missing id, an unknown stage, layer or effect, an unknown key, a non-boolean fact
 * column, an unknown predicate name, a complementOf id that is not a row of the same stage, or a
 * complementOf cycle (a self-reference included).
 *
 * With `machine` (a CHAIN_MACHINE-shaped object) it also checks every flowType and state a row
 * names against it, and that every state of every flow has exactly one per-state chain row.
 * @param {object[]} table
 * @param {Record<string, { states: object }>} [machine]
 */
export function validateAdmissionTable(table, machine) {
  if (!Array.isArray(table)) throw new Error("ADMISSION_TABLE: table is not an array");
  const ids = new Map();
  for (const row of table) {
    if (!row || typeof row !== "object") throw new Error("ADMISSION_TABLE: a row is not an object");
    if (typeof row.id !== "string" || row.id === "") throw new Error("ADMISSION_TABLE: a row has no string id");
    if (ids.has(row.id)) throw new Error(`ADMISSION_TABLE: duplicate row id '${row.id}'`);
    ids.set(row.id, row);
  }
  for (const row of table) {
    const where = `ADMISSION_TABLE row '${row.id}'`;
    for (const key of Object.keys(row)) {
      if (!ROW_KEYS.has(key)) throw new Error(`${where}: unknown key '${key}'`);
    }
    if (!STAGES.includes(row.stage)) throw new Error(`${where}: unknown stage '${row.stage}'`);
    if (!LAYERS.includes(row.layer)) throw new Error(`${where}: unknown layer '${row.layer}'`);
    if (!EFFECTS.includes(row.effect)) throw new Error(`${where}: unknown effect '${row.effect}'`);
    for (const col of FACT_COLUMNS) {
      if (row[col] !== undefined && typeof row[col] !== "boolean") throw new Error(`${where}: ${col} is not a boolean`);
    }
    if (row.tools !== undefined && !(Array.isArray(row.tools) && row.tools.every((t) => typeof t === "string"))) {
      throw new Error(`${where}: tools is not an array of tool names`);
    }
    for (const ref of row.if ?? []) {
      const name = typeof ref === "string" ? ref.replace(/^!/, "") : ref;
      if (!Object.hasOwn(PREDICATES, name)) throw new Error(`${where}: unknown predicate '${name}'`);
    }
    if (row.detail !== undefined && !Object.hasOwn(PREDICATES, row.detail)) {
      throw new Error(`${where}: unknown predicate '${row.detail}'`);
    }
    for (const other of row.complementOf ?? []) {
      if (ids.get(other)?.stage !== row.stage) throw new Error(`${where}: complementOf '${other}' is not a row of stage '${row.stage}'`);
    }
    if (machine) {
      if (row.flowType !== undefined && !Object.hasOwn(machine, row.flowType)) {
        throw new Error(`${where}: unknown flowType '${row.flowType}'`);
      }
      if (row.state !== undefined) {
        const flows = row.flowType !== undefined ? [row.flowType] : Object.keys(machine);
        if (!flows.some((f) => Object.hasOwn(machine[f]?.states ?? {}, row.state))) {
          throw new Error(`${where}: unknown state '${row.state}'${row.flowType !== undefined ? ` in flow '${row.flowType}'` : ''}`);
        }
      }
    }
  }
  // backlog.feat.admission-table-review-hardening: the complementOf graph must be acyclic. In a cycle,
  // rowMatches reads the partner it is still computing as no match, so the decision would depend on
  // which row of the cycle evaluateRows visits first. Every complementOf id is a row by now.
  const settled = new Set();
  const visit = (row, trail) => {
    if (settled.has(row.id)) return;
    const at = trail.indexOf(row.id);
    if (at !== -1) {
      throw new Error(`ADMISSION_TABLE row '${row.id}': complementOf cycle ${[...trail.slice(at), row.id].join(" -> ")}`);
    }
    for (const other of row.complementOf ?? []) visit(ids.get(other), [...trail, row.id]);
    settled.add(row.id);
  };
  for (const row of table) visit(row, []);
  if (machine) {
    for (const [flow, def] of Object.entries(machine)) {
      for (const state of Object.keys(def?.states ?? {})) {
        const n = table.filter((r) => r.admitsInState === true && r.flowType === flow && r.state === state).length;
        if (n !== 1) throw new Error(`ADMISSION_TABLE: flow '${flow}', state '${state}' has ${n} per-state chain rows (expected 1)`);
      }
    }
  }
}

// Load-time validation of the row shape (the flow/state check runs in governor-state.mjs).
validateAdmissionTable(ADMISSION_TABLE);

// ── Evaluation ──────────────────────────────────────────────────────

function indexRows(rows) {
  const byStage = new Map();
  const byId = new Map();
  const flows = new Set();
  for (const row of rows) {
    if (!byStage.has(row.stage)) byStage.set(row.stage, []);
    byStage.get(row.stage).push(row);
    byId.set(row.id, row);
    if (row.flowType !== undefined) flows.add(row.flowType);
  }
  return { rows, byStage, byId, flows };
}

const TABLE_INDEX = indexRows(ADMISSION_TABLE);

// An unrecognised flowType (including undefined) reads as the story flow, as getStates does.
function resolveFlow(index, flowType) {
  return typeof flowType === "string" && index.flows.has(flowType) ? flowType : "story";
}

function stateAdmits(index, flow, state, tool) {
  return index.rows.some((r) =>
    r.admitsInState === true && r.stage === "session" &&
    (r.flowType === undefined || r.flowType === flow) &&
    (r.state === undefined || r.state === state) &&
    Array.isArray(r.tools) && r.tools.includes(tool));
}

/** The boolean fact columns of one input. */
function factsOf(input, index) {
  const { tool, session, context } = input;
  const ctx = context ?? {};
  const sessionLive = session !== null && session !== undefined;
  const flow = resolveFlow(index, session?.flowType);
  return {
    flow,
    tokenPresent: ctx.tokenPresent === true,
    tokenValid: ctx.tokenValid === true,
    tokenGateArmed: ctx.tokenGateArmed === true,
    leaseRefused: ctx.leaseRefused === true,
    sessionLive,
    commonTool: COMMON_TOOL_NAMES.includes(tool),
    protectedTool: !UNPROTECTED_TOOL_NAMES.includes(tool),
    chainAdmitted: sessionLive && stateAdmits(index, flow, session.state, tool),
  };
}

function predicateHolds(env, ref) {
  const negated = ref.startsWith("!");
  const name = negated ? ref.slice(1) : ref;
  if (!env.predicates.has(name)) {
    const fn = PREDICATES[name];
    if (typeof fn !== "function" || !Object.hasOwn(PREDICATES, name)) throw new Error(`admission: unknown predicate '${name}'`);
    env.predicates.set(name, Boolean(fn(env.input)));
  }
  return env.predicates.get(name) !== negated;
}

function rowMatches(row, env) {
  if (env.memo.has(row)) return env.memo.get(row);
  env.memo.set(row, false); // defence in depth: validateAdmissionTable rejects complementOf cycles
  const { input, facts } = env;
  let ok = true;
  if (row.tools !== undefined && !row.tools.includes(input.tool)) ok = false;
  if (ok && row.flowType !== undefined && (!facts.sessionLive || facts.flow !== row.flowType)) ok = false;
  if (ok && row.state !== undefined && (!facts.sessionLive || input.session.state !== row.state)) ok = false;
  for (const col of FACT_COLUMNS) {
    if (ok && row[col] !== undefined && facts[col] !== row[col]) ok = false;
  }
  for (const ref of row.if ?? []) {
    if (ok && !predicateHolds(env, ref)) ok = false;
  }
  for (const id of row.complementOf ?? []) {
    const other = env.index.byId.get(id);
    if (ok && other && rowMatches(other, env)) ok = false;
  }
  env.memo.set(row, ok);
  return ok;
}

// Total order over the matching rows of one stage: effect priority, then layer rank, then row id.
function outranks(a, b) {
  if (PRIORITY[a.effect] !== PRIORITY[b.effect]) return PRIORITY[a.effect] > PRIORITY[b.effect];
  if (LAYER_RANK[a.layer] !== LAYER_RANK[b.layer]) return LAYER_RANK[a.layer] > LAYER_RANK[b.layer];
  return a.id < b.id;
}

/**
 * Evaluate a caller-supplied rows array (decide delegates to it with ADMISSION_TABLE). Only the
 * rows of input.context.stage are considered.
 * @returns {{ effect: 'allow'|'deny'|'route', reason: string|null, layer: string|null, remedy: string|null, matchedRule: string|null, action?: string }}
 */
export function evaluateRows(rows, input = {}) {
  const index = rows === ADMISSION_TABLE ? TABLE_INDEX : indexRows(rows);
  const env = { input, index, facts: factsOf(input, index), memo: new Map(), predicates: new Map() };
  let winner = null;
  for (const row of index.byStage.get(input?.context?.stage) ?? []) {
    if (rowMatches(row, env) && (winner === null || outranks(row, winner))) winner = row;
  }
  if (winner === null) {
    return { effect: "deny", reason: "no_matching_rule", layer: null, remedy: null, matchedRule: null };
  }
  const result = { effect: winner.effect, reason: winner.reason ?? null, layer: winner.layer, remedy: winner.remedy ?? null, matchedRule: winner.id };
  return winner.action ? { ...result, action: winner.action } : result;
}

/**
 * The admission decision for one stage of one tools/call. Pure.
 * @param {{ principal?: object|null, tool: string, args?: object, session?: object|null,
 *   context: { stage: 'lane'|'bootstrap'|'session', lane?: string, policy?: object, env?: object,
 *     bootProjectId?: string, tokenPresent?: boolean, tokenValid?: boolean, tokenGateArmed?: boolean,
 *     leaseRefused?: boolean } }} input - `session` is the in-map session (null when none).
 */
export function decide({ principal = null, tool, args, session = null, context = {} } = {}) {
  return evaluateRows(ADMISSION_TABLE, { principal, tool, args, session, context });
}

// ── Projections ─────────────────────────────────────────────────────

/**
 * The tools a flow's state admits (its per-state chain row), in row order, or null when the state
 * has no row. An unrecognised flowType reads as story.
 * @returns {readonly string[] | null}
 */
export function chainStateTools(flowType, state, rows = ADMISSION_TABLE) {
  const index = rows === ADMISSION_TABLE ? TABLE_INDEX : indexRows(rows);
  const flow = resolveFlow(index, flowType);
  const row = rows.find((r) => r.admitsInState === true && r.flowType === flow && r.state === state);
  return row ? row.tools : null;
}

/**
 * The args refusal the table's args rows make for a call, or null: { error, violationKind,
 * message, matchedRule }. Evaluates only the rows' argument predicates (not the chain columns),
 * for callers that check the arguments of an already-admitted call (checkToolArgs).
 */
export function argsRefusal({ tool, args, session } = {}) {
  const input = { tool, args, session };
  const env = { input, predicates: new Map() };
  for (const row of ADMISSION_TABLE) {
    if (row.layer !== "args" || row.effect !== "deny") continue;
    if ((row.if ?? []).every((ref) => predicateHolds(env, ref))) {
      return { ...PREDICATES[row.detail](input), matchedRule: row.id };
    }
  }
  return null;
}
