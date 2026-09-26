/**
 * THE single ship-delivery implementation, shared by both ship entry points.
 *
 * Before this module existed, `working !== integration` was computed independently in
 * six places and the 2-branch delivery mechanics were written out twice — once in
 * `guardrails-audit.mjs` (off-rail auto-ship) and once in `story-ship.mjs` (on-rail
 * rks_story_ship). The two implementations took OPPOSITE branches on the same false
 * predicate: off-rail local-merged and pushed the working branch, on-rail opened a PR.
 * `backlog.z_implemented.feat.guardrails-on-no-feature-branch-push` corrected one of
 * them on 2026-05-07 and scoped itself to a single file; the other was never brought
 * along and drifted unnoticed for 85 commits, because nothing exercised it.
 *
 * The rail distinction is about AUTHORIZATION and PROVENANCE — who may write which
 * paths, what the session token permits, what telemetry is emitted. It is NOT about
 * delivery. Delivery follows from topology alone, and therefore lives here.
 *
 * See notes/backlog.fix.ship-delivery-implemented-twice.md and
 * notes/research.2026.09.04.on-rail-vs-off-rail-ship-divergence.md.
 */
import { spawnSync } from "node:child_process";
import { localMerge } from "./local-merge.mjs";

/**
 * THE topology predicate for the whole server.
 *
 * `working !== integration` MUST NOT be recomputed anywhere else in
 * packages/mcp-rks/src. Independent copies of this expression are what allowed the two
 * ship-delivery implementations to drift apart unnoticed.
 *
 * Callers carrying a NON-topology disjunct must keep it: substitute this call for the
 * parenthesised comparison only, never for the whole expression. See git-ship.mjs's
 * `workflowConfig.workingBranchLocal ||` and story-ship.mjs's later promotion to `true`.
 */
export function isThreeBranchTopology(branchConfig) {
  return branchConfig.working !== branchConfig.integration;
}

/**
 * THE delivery implementation for both ship entry points.
 *
 * Rail-agnostic by construction: no governor/session token, no allowedFiles or scope
 * reconciliation, no phase writes, no rail-specific telemetry, no cost reporting.
 * Callers map the neutral `steps` records into their own step vocabulary.
 *
 * Neutral record kinds emitted: `local_merge`, `delete_branch`, `push_working`.
 *
 * `target` is REQUIRED and has NO DEFAULT. Each rail passes the branch it merges into
 * TODAY: off-rail passes `gitState.branch` — the branch the operator was on when
 * guardrails went off — and on-rail passes `working`. A `const target =
 * branchConfig.working;` here would silently retarget an escape hatch that can be
 * started from any branch. See FINDING A, option (i).
 *
 * @returns {{ ok: boolean, mode: string, target: string, steps: object[], error?: string }}
 */
export function deliverFeatureBranch({ projectRoot, featureBranch, branchConfig, target }) {
  // FAIL CLOSED. Without this guard an omitted `target` reaches local-merge.mjs:19 as
  // `git checkout undefined` — a confusing runtime failure instead of a refusal. A
  // TypeError, not an `{ ok: false }` record: nothing was attempted, so there is no
  // observed subprocess result to DERIVE an `ok` from, and minting one would be
  // intent-sourced status. This does NOT make a wiring defect look different from a real
  // delivery failure at every call site — see AC 13 for the measured per-rail outcome.
  // Nothing spawns before this.
  if (!target || typeof target !== "string") {
    throw new TypeError(
      "deliverFeatureBranch: `target` is required and must be a non-empty branch name",
    );
  }

  const threeBranch = isThreeBranchTopology(branchConfig);
  const steps = [];

  // 1. Merge. localMerge ALSO attempts `git branch -d <featureBranch>` internally
  //    (git/local-merge.mjs:29) and returns { ok: true, warning: "Merged but could not
  //    delete branch: ..." } (:31) when that delete fails — so a warning here is NOT a
  //    merge failure, and the branch may still exist. That is why step 3 re-checks
  //    rather than assuming the branch is gone.
  const merged = localMerge(projectRoot, featureBranch, target);
  steps.push({
    kind: "local_merge",
    ok: merged.ok,
    from: featureBranch,
    to: target,
    warning: merged.warning,
  });
  if (!merged.ok) {
    return { ok: false, mode: "local_merge_failed", target, steps, error: merged.error };
  }

  // 2. 3-branch: the working branch is local-only. NO delete record and NO push — that
  //    is exactly what off-rail does (merge, then three `three_branch_local_only` skips)
  //    and what on-rail does. Promotion to the integration branch stays the caller's
  //    concern.
  if (threeBranch) {
    return { ok: true, mode: "three_branch_local", target, steps };
  }

  // 3. 2-branch — delete the feature branch. Re-check with `branch --list` because
  //    localMerge's `-d` may have declined, then force-delete. `ok` is sourced from the
  //    OBSERVED post-state, never from having attempted it. A failed delete does NOT
  //    abort the push — the off-rail implementation fell through from its delete block to
  //    its push, and that behaviour is preserved.
  const stillListed = spawnSync("git", ["branch", "--list", featureBranch], {
    cwd: projectRoot, encoding: "utf8", timeout: 15_000,
  });
  if (!stillListed.stdout?.trim()) {
    steps.push({ kind: "delete_branch", ok: true, branch: featureBranch });
  } else {
    const forced = spawnSync("git", ["branch", "-D", featureBranch], {
      cwd: projectRoot, encoding: "utf8", timeout: 15_000,
    });
    steps.push(forced.status === 0
      ? { kind: "delete_branch", ok: true, branch: featureBranch }
      : {
        kind: "delete_branch", ok: false, branch: featureBranch,
        error: forced.stderr?.trim() || "git branch -D failed",
      });
  }

  // 4. 2-branch — push the delivery `target` to origin ONCE. No PR. `target` is the
  //    branch the CALLER passed — off-rail `gitState.branch`, on-rail `working`. This
  //    module never reads `branchConfig.working`.
  //    See notes/public.canon.build-path-analysis.md: "2-branch (local merge, no PR)".
  //    Without this the on-rail 2-branch path would never reach origin.
  const pushed = spawnSync("git", ["push", "origin", target], {
    cwd: projectRoot, encoding: "utf8", timeout: 120_000,
  });
  steps.push(pushed.status === 0
    ? { kind: "push_working", ok: true, branch: target, remote: "origin" }
    : {
      kind: "push_working", ok: false, branch: target, remote: "origin",
      error: pushed.stderr?.trim() || "git push failed",
    });

  // Terminal `ok` is DERIVED from the records above, never asserted. A constant
  // `ok: true` here would be intent-sourced status — the exact defect class named in
  // notes/design.evidence-bound-reporting-invariant.md (R1).
  const failed = steps.find((s) => s.ok === false);
  return failed
    ? { ok: false, mode: "two_branch_local", target, steps, error: failed.error }
    : { ok: true, mode: "two_branch_local", target, steps };
}
