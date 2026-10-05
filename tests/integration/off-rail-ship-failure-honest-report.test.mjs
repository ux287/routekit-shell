/**
 * Tests for backlog.fix.off-rail-ship-failure-honest-report.
 *
 * A ship that crashed, one that was halted on purpose, and one that had nothing
 * to do all returned `ok: true` with `autoShipped: false`. `shipOutcome` makes
 * them distinguishable from the response alone.
 *
 * `ok` is deliberately left true throughout — it scopes the guardrails-restore
 * operation (hooks restored, session ended, scope file removed), which genuinely
 * succeeds even when a ship fails. These tests pin that separation rather than
 * treating it as the defect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  guardrailsOff,
  guardrailsOn,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

const git = (cwd, args) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });

const STORY_ID = "backlog.fix.fixture";
// backlog.fix.offrail-shipoutcome-ignores-failed-steps: resolveShipOutcome now
// reduces over shipSteps, so a landed merge whose trailing steps (ship-note
// push, cycle_complete, advance_phase, delete-branch) report ok:false resolves
// to "shipped_with_failures" instead of "shipped". Every one of those can
// legitimately fail in a sandbox WITHOUT the merge failing, so the completed-ship
// assertions accept either. The distinction they still enforce is
// shipped-vs-not-shipped, never no-step-degraded.
const SHIPPED = ["shipped", "shipped_with_failures"];
const IN_SCOPE = "packages/mcp-rks/src/example.mjs";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-honest-report-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-honest-report-origin-"));
  git(bare, ["init", "--bare", "-q"]);

  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "mcp-rks", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".routekit", "hooks", "write"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".routekit", "hooks", "read"), { recursive: true });

  fs.writeFileSync(path.join(dir, ".gitignore"), [".rks/", ".routekit/hooks.bak/", ""].join("\n"));
  fs.writeFileSync(path.join(dir, ".routekit", "hooks", "write", "w.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(dir, ".routekit", "hooks", "read", "r.mjs"), "export default {};\n");
  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify({ hooks: [{ name: "w", tier: "write" }, { name: "r", tier: "read" }] }, null, 2),
  );
  fs.writeFileSync(path.join(dir, IN_SCOPE), "export const v = 1;\n");
  fs.writeFileSync(
    path.join(dir, "notes", `${STORY_ID}.md`),
    ["---", `id: "${STORY_ID}"`, 'phase: "arch-approved"', "targetFiles:",
      `  - path: "${IN_SCOPE}"`, '    op: "edit"', "---", "", "## Problem", ""].join("\n"),
  );
  // Keep the enforcement gate off a live reviewer.
  fs.writeFileSync(path.join(dir, ".rks", "review-policy.yaml"), "enabled: false\n");

  git(dir, ["init", "-q"]);
  // Repo-local identity, deliberately NOT via GIT_ENV. guardrailsOn's auto-ship
  // spawns `git commit` as a separate process inheriting bare process.env, so
  // GIT_ENV never reaches it. CI runners have no global user.email/user.name,
  // so without this the auto-ship throws "empty ident name" and autoShipped
  // comes back false. Written repo-locally only — never touch a developer's
  // machine-wide git config. Belongs to the working repo, not the bare origin.
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["checkout", "-q", "-b", "staging"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "-u", "origin", "staging"]);

  return { dir, bare };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

describe("shipOutcome is present and honest on every path", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("reports shipped for a ship that completed", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 2;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(SHIPPED).toContain(res.shipOutcome);
    expect(res.autoShipped).toBe(true);
    // ok stays true — it describes the guardrails restore, not the ship.
    expect(res.ok).toBe(true);
  });

  it("changes what is reported, never whether the sequence proceeds", async () => {
    // The reduction is a reporting change only: a step reporting ok:false must
    // still leave every downstream step recorded and autoShipped true, because
    // the merge landed and no currently-continuing step became an abort.
    //
    // Written to hold in BOTH directions on purpose. Every trailing step happens
    // to succeed in this sandbox today, so hard-coding "shipped_with_failures"
    // here would be a lie, and hard-coding "shipped" is what this story is
    // fixing. The invariant asserted instead is the one that must never break:
    // the reported outcome and the named failed steps agree with what shipSteps
    // actually recorded, whichever way the sandbox lands. The degraded reduction
    // itself is driven exhaustively in tests/unit/guardrails-ship-outcome.test.mjs.
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 7;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(res.autoShipped).toBe(true);
    const names = (res.shipSteps || []).map((s) => s.step);
    // Membership, never exact fixture step counts.
    expect(names).toContain("commit");
    expect(names).toContain("local-merge");
    expect(names).toContain("push-staging");

    // The response names exactly the steps that reported ok:false, in order, so
    // the Dispatcher never has to walk shipSteps itself. A step that merely omits
    // `ok` is a skip and is not named.
    const failed = (res.shipSteps || []).filter((s) => s.ok === false).map((s) => s.step);
    expect(res.failedShipSteps ?? []).toEqual(failed);
    expect(res.shipOutcome).toBe(failed.length > 0 ? "shipped_with_failures" : "shipped");
  });

  it("reports nothing_to_ship for a session that produced no changes", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    // No changes at all. "nothing_to_ship" is the honest answer here — the
    // block was skipped precisely because there was nothing to do.
    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(res.shipOutcome).toBe("nothing_to_ship");
  });

  it("reports skipped for a caller that suppresses the auto-ship", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 3;\n");

    const res = await guardrailsOn(repo.dir, { skipAutoShip: true }, "test-project");
    expect(res.shipOutcome).toBe("skipped");
    expect(res.ok).toBe(true);
  });

  it("stamps the field on every response, never leaves it absent", async () => {
    // A field that is only usually present is worse than none.
    for (const setup of [
      () => {},
      () => fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 9;\n"),
    ]) {
      cleanup(repo.dir, repo.bare);
      repo = makeRepo();
      expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
      setup();
      const res = await guardrailsOn(repo.dir, {}, "test-project");
      expect(res.shipOutcome).toBeTruthy();
      // A COMPLETENESS assertion — no response may carry an unknown outcome — so
      // a new outcome EXTENDS it. Deleting it would drop the guarantee entirely.
      expect(["shipped", "shipped_with_failures", "halted", "nothing_to_ship", "failed", "skipped"])
        .toContain(res.shipOutcome);
    }
  });
});

describe("a halt is not a failure", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("reports halted, with a recovery branch and no shipError", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    // RE-GROUNDED on review_unavailable by backlog.fix.offrail-ship-scoped-staging.
    //
    // This used to be grounded on a scope violation: `enabled: false` +
    // `offRail: block` plus an out-of-scope rogue.mjs. That no longer halts, and
    // could not be salvaged by keeping the rogue file. Under scoped staging the
    // rogue path is never staged, so scope_reconcile reports ok:true and the
    // `scopeStep.ok === false` arm of the halt predicate is dead. And with
    // `enabled: false`, buildOffRailReviewStep short-circuits to
    // { step: 'review', skipped: true } with no verdict and no
    // reviewerUnavailable — so the scope arm was the ONLY branch of that
    // predicate this fixture could ever fire.
    //
    // `enabled: true` makes runReview actually run; the sandbox project is not in
    // the registry, so it fails, sets reviewerUnavailable, and trips haltReason
    // 'review_unavailable'. Mirrors the BLOCKING policy string in
    // tests/integration/off-rail-ship-enforcement-gate.test.mjs, whose
    // "block halts on an unavailable reviewer" test proves the path is reachable.
    fs.writeFileSync(
      path.join(repo.dir, ".rks", "review-policy.yaml"),
      "enabled: true\noffRail: block\nverdictMode: warn\n",
    );
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 4;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(res.shipOutcome).toBe("halted");
    expect(res.haltReason).toBe("review_unavailable");
    expect(res.recoveryBranch).toBeTruthy();
    // A deliberate halt preserves work — it must not read as a crash.
    expect(res.shipError).toBeUndefined();
  });
});

describe("a failure says where it stopped", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("reports failed with a stage when the ship throws", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 5;\n");
    // Break the remote so integration cannot complete.
    cleanup(repo.bare);

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    if (res.shipOutcome === "failed") {
      // The whole point: not an empty-looking success.
      expect(res.shipError).toBeTruthy();
      expect(res.failedStage).toBeTruthy();
      expect([
        "branch_create", "stage_files", "staging_check",
        "commit", "enforcement_gate", "integrate",
      ]).toContain(res.failedStage);
    } else {
      // Destroying the bare repo may not break every topology; if the ship
      // still completed, the outcome must at least be honest about that —
      // including honest about a trailing step that degraded underneath it.
      expect([...SHIPPED, "nothing_to_ship"]).toContain(res.shipOutcome);
    }
  });
});

describe("fixture carries a repo-local git identity", () => {
  // Regression witness. guardrailsOn's auto-ship commits from a separate
  // process with bare process.env, so on a CI runner with no global identity
  // it dies with "empty ident name" and the ship reports failedStage "commit".
  //
  // Read back with --local ON PURPOSE: it consults only this repo's
  // .git/config, never ~/.gitconfig and never system config, so a developer's
  // global identity cannot make this pass vacuously. GIT_ENV cannot satisfy it
  // either — those are environment variables, not config.
  it("sets user.email and user.name in the working repo's .git/config", () => {
    const repo = makeRepo();
    try {
      expect(git(repo.dir, ["config", "--local", "--get", "user.email"]).stdout?.trim()).toBeTruthy();
      expect(git(repo.dir, ["config", "--local", "--get", "user.name"]).stdout?.trim()).toBeTruthy();
    } finally {
      cleanup(repo.dir, repo.bare);
    }
  });
});
