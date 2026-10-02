/**
 * ONE normalization for GitHub's statusCheckRollup, reached by every consumer.
 *
 * backlog.fix.gh-checkrun-statuscontext-vocabulary-conflation. `gh pr view --json
 * statusCheckRollup` returns a heterogeneous array of TWO different GraphQL types with
 * DISJOINT vocabularies:
 *
 *   CheckRun      — `status` (QUEUED | IN_PROGRESS | COMPLETED) plus `conclusion`
 *                   (SUCCESS | FAILURE | ...). No `state`.
 *   StatusContext — `state` (EXPECTED | PENDING | SUCCESS | FAILURE | ERROR) only.
 *                   No `status`, and NO `conclusion` at all.
 *
 * Every consumer collapsed them with `status: c.status || c.state`, which produces a value
 * from one vocabulary read with the other's rules. Two opposite failures followed:
 *
 *   - A GREEN StatusContext normalised to `status: "SUCCESS"`, and a completeness filter
 *     asking `status !== "COMPLETED"` therefore read it as PERPETUALLY RUNNING. That is why
 *     rks_story_ship could not merge a PR in this repo, and why guardrails-off became
 *     load-bearing by accident rather than by design.
 *   - `every(c => c.conclusion === "SUCCESS" || c.status === "COMPLETED")` let a
 *     COMPLETED-FAILURE CheckRun read as PASSED, because the second disjunct is true of any
 *     finished run regardless of its outcome.
 *
 * The fix is not either filter — it is the SHAPE. Completeness and success are derived here,
 * once, per vocabulary, and exposed as booleans so no caller has to know which type it holds.
 * `status` and `conclusion` are preserved verbatim for display and for existing assertions.
 *
 * `__typename` arrives WITHOUT being requested (confirmed against a captured `gh pr view
 * --json statusCheckRollup` payload). Do NOT add it to any `--json` field list — it is not a
 * valid top-level field there and passing it breaks the invocation.
 *
 * NOT unified with the other GitHub vocabularies in this repo, deliberately:
 *   - `gh run list` WORKFLOW RUNS (lowercase `status`/`conclusion`, `databaseId`/`headSha`)
 *     drive the release CI gate in server/git/git-release.mjs.
 *   - The REST check-runs shape in server/ci-polling.mjs feeds server/story-ship.mjs.
 * Both are different APIs with different field sets. Converging them would break their tests
 * and conflate a third and fourth vocabulary with these two.
 */

const CHECK_RUN_COMPLETED = "COMPLETED";
const SUCCESS = "SUCCESS";
// A StatusContext is settled unless it is still waiting. EXPECTED means a required context
// has been declared but never reported — pending, not passed.
const STATUS_CONTEXT_PENDING = new Set(["PENDING", "EXPECTED"]);

function isCheckRun(c) {
  if (c?.__typename === "CheckRun") return true;
  if (c?.__typename === "StatusContext") return false;
  // Fall back to field presence rather than guessing: only a CheckRun carries `status`.
  return typeof c?.status === "string";
}

/**
 * Normalize one rollup entry.
 * @returns {{name: string|undefined, status: string|undefined, conclusion: string|undefined,
 *            completed: boolean, passed: boolean}}
 */
export function normalizeRollupCheck(c) {
  const name = c?.name || c?.context;
  if (isCheckRun(c)) {
    const status = c?.status;
    const conclusion = c?.conclusion;
    return {
      name,
      status,
      conclusion,
      completed: status === CHECK_RUN_COMPLETED,
      // A finished run is only a PASS on its conclusion. `completed` is not success.
      passed: conclusion === SUCCESS,
    };
  }
  const state = c?.state;
  return {
    name,
    // Preserved for display. Callers must read `completed`/`passed`, never compare this
    // against a CheckRun literal — that comparison is the defect.
    status: state,
    conclusion: undefined,
    completed: typeof state === "string" && !STATUS_CONTEXT_PENDING.has(state),
    passed: state === SUCCESS,
  };
}

/** Normalize a whole `statusCheckRollup` array. A missing rollup is an empty set, not a throw. */
export function normalizeCheckRollup(rollup) {
  return (Array.isArray(rollup) ? rollup : []).map(normalizeRollupCheck);
}

/** Every check finished AND succeeded. An empty rollup means no CI is configured, not failure. */
export function allChecksPassed(checks) {
  const list = Array.isArray(checks) ? checks : [];
  return list.length === 0 || list.every((c) => c.completed && c.passed);
}
