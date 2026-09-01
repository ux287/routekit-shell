/**
 * Tests for backlog.fix.off-rail-ship-enforcement-gate — behavioral.
 *
 * The off-rail auto-ship path committed and pushed with no code review and no
 * re-check of the session's write scope, while the on-rail rks_story_ship path
 * enforced both. This suite drives BOTH gate call sites:
 *
 *   gate alpha — the empty-index path. The session committed mid-run, so
 *     `git add -A` stages nothing, yet real work is about to be pushed directly
 *     (or reported as shipped on a 3-branch project).
 *   gate beta — the main path, after commitAndEmbed and before the merge/push.
 *
 * POSTURE IS ADVISORY BY DEFAULT, DELIBERATELY. The tests that assert a finding
 * is recorded *and the ship still completes* are the counterintuitive ones, and
 * they are the point: off-rail is the documented escape hatch, and the on-rail
 * gate already fails closed, so making both fail closed would leave a user with
 * no reviewer credential unable to ship by either route. The defect being fixed
 * is silence, not permissiveness.
 *
 * The halt discriminator is git state on the WORKING branch — not HEAD, which
 * deliberately sits on the disposable off-rail branch at a gate-beta halt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// Each case drives a real git repo through guardrailsOff → guardrailsOn,
// including branch creation, merge and push to a bare origin. That runs 3-7s,
// well past vitest's 5s default, so raise it for this file rather than letting
// a slow-but-passing test read as a failure.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import {
  guardrailsOff,
  guardrailsOn,
  buildOffRailReviewStep,
  buildScopeReconcileStep,
  readCommitManifest,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
import {
  computeFinalVerdict,
  redactReview,
} from "../../packages/mcp-rks/src/server/review.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });
}

const STORY_ID = "backlog.fix.fixture";
const IN_SCOPE = "packages/mcp-rks/src/example.mjs";

function writePolicy(dir, body) {
  fs.writeFileSync(path.join(dir, ".rks", "review-policy.yaml"), body);
}

/**
 * A fixture repo with a tracked .routekit/hooks tree (so guardrailsOff has
 * something to relocate) and a story note scoping writes to one file.
 */
function makeRepo({ threeBranch = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-offrail-gate-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-offrail-gate-origin-"));
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
    [
      "---", `id: "${STORY_ID}"`, 'phase: "arch-approved"', "targetFiles:",
      `  - path: "${IN_SCOPE}"`, '    op: "edit"', "---", "", "## Problem", "",
    ].join("\n"),
  );

  if (threeBranch) {
    fs.writeFileSync(
      path.join(dir, ".rks", "project.json"),
      JSON.stringify({ branches: { working: "dev", integration: "staging" } }, null, 2),
    );
  }

  git(dir, ["init", "-q"]);
  // Repo-local identity, deliberately NOT via GIT_ENV. guardrailsOn's auto-ship
  // spawns `git commit --cleanup=verbatim -F -` as a separate process that
  // inherits bare process.env, so GIT_ENV above never reaches it. A CI runner
  // has no global user.email/user.name, so without this the auto-ship throws
  // "empty ident name" and the ship reports failedStage: "commit". Written
  // repo-locally only — the fixture must never mutate a developer's machine.
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["checkout", "-q", "-b", threeBranch ? "dev" : "staging"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "-u", "origin", threeBranch ? "dev" : "staging"]);

  return { dir, bare, branch: threeBranch ? "dev" : "staging" };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const tip = (dir, ref) => git(dir, ["rev-parse", ref]).stdout.trim();
// NOTE the `|| []`: it erases absent-vs-empty, which is exactly what made a CI
// failure here read as `expected [] to have a length of 1` with no clue that the
// ship had thrown. Assertions below check shipOutcome FIRST so the real cause
// surfaces; keep it that way.
const stepNames = (res) => (res.shipSteps || []).map((s) => s.step);

/**
 * Fail with the actual outcome rather than an empty-array mystery.
 *
 * The claim is that the ship did NOT error — not that no step degraded.
 * backlog.fix.offrail-shipoutcome-ignores-failed-steps made resolveShipOutcome
 * reduce over shipSteps, so a trailing delete-branch, cycle_complete,
 * advance_phase or ship-note reporting ok:false against a bare origin resolves a
 * landed merge to "shipped_with_failures". Both spellings are a completed ship;
 * shipError and failedStage staying undefined is what this pins. The matcher is
 * inside toEqual on purpose so a failure still prints the ACTUAL outcome.
 */
const expectShipped = (res) =>
  expect({
    shipOutcome: res.shipOutcome,
    shipError: res.shipError,
    failedStage: res.failedStage,
  }).toEqual({
    shipOutcome: expect.stringMatching(/^shipped(_with_failures)?$/),
    shipError: undefined,
    failedStage: undefined,
  });
const stepFor = (res, name) => (res.shipSteps || []).find((s) => s.step === name);

/** Drives gate beta: uncommitted session work reaches `git add -A`. */
async function runBetaSession(repo, { policy, extra = () => {}, options = {} } = {}) {
  const off = await guardrailsOff(repo.dir, "test", "all", STORY_ID, "test-project");
  expect(off.ok).toBe(true);
  writePolicy(repo.dir, policy);
  fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 2;\n");
  extra(repo);
  return guardrailsOn(repo.dir, options, "test-project");
}

/** Drives gate alpha: the session commits mid-run, so the index ends up empty. */
async function runAlphaSession(repo, { policy, extra = () => {}, options = {} } = {}) {
  const off = await guardrailsOff(repo.dir, "test", "all", STORY_ID, "test-project");
  expect(off.ok).toBe(true);
  writePolicy(repo.dir, policy);
  fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 3;\n");
  extra(repo);
  // Exclude .routekit: while the session is off-rail the hook tiers live in the
  // gitignored hooks.bak, so a bare `git add -A` here would commit their
  // DELETION — and the restore during guardrailsOn would then re-dirty the tree
  // and route us to gate beta instead of the empty-index path we want to drive.
  git(repo.dir, ["add", "-A", "--", ".", ":(exclude).routekit"]);
  git(repo.dir, ["commit", "-q", "-m", "feat: committed mid-session"]);
  return guardrailsOn(repo.dir, options, "test-project");
}

const ADVISORY = "enabled: true\noffRail: advisory\nverdictMode: warn\n";
const BLOCKING = "enabled: true\noffRail: block\nverdictMode: warn\n";
const DISABLED = "enabled: false\n";

describe("off-rail enforcement gate — always runs, always records", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("appends exactly one review and one scope_reconcile step at gate beta", async () => {
    const res = await runBetaSession(repo, { policy: ADVISORY });
    expect(res.ok).toBe(true);
    expectShipped(res);
    expect(stepNames(res).filter((s) => s === "review")).toHaveLength(1);
    expect(stepNames(res).filter((s) => s === "scope_reconcile")).toHaveLength(1);
  });

  it("appends exactly one review and one scope_reconcile step at gate alpha", async () => {
    const res = await runAlphaSession(repo, { policy: ADVISORY });
    expect(res.ok).toBe(true);
    expect(stepNames(res).filter((s) => s === "review")).toHaveLength(1);
    expect(stepNames(res).filter((s) => s === "scope_reconcile")).toHaveLength(1);
  });

  it("records the steps AFTER the commit step, not interleaved before it", async () => {
    const res = await runBetaSession(repo, { policy: ADVISORY });
    const names = stepNames(res);
    expect(names.indexOf("commit")).toBeGreaterThan(-1);
    expect(names.indexOf("review")).toBeGreaterThan(names.indexOf("commit"));
  });
});

describe("hermeticity levers — a skipped review is never a halt", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("skips with policy_disabled when the fixture policy disables review", async () => {
    // Proves the gate loads the policy with the OFF-RAIL root. runReview
    // resolves its own root from the registry and would never see this file.
    const res = await runBetaSession(repo, { policy: DISABLED });
    expect(res.ok).toBe(true);
    expect(stepFor(res, "review")).toMatchObject({ skipped: true, reason: "policy_disabled" });
    expect(res.autoShipped).toBe(true);
  });

  it("skips with no_project_context for a bare guardrailsOn call", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", STORY_ID, "test-project");
    expect(off.ok).toBe(true);
    writePolicy(repo.dir, ADVISORY);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 9;\n");
    // projectId defaults to "unknown"; runReview would throw in loadContext.
    const res = await guardrailsOn(repo.dir);
    expect(res.ok).toBe(true);
    expect(stepFor(res, "review")).toMatchObject({ skipped: true, reason: "no_project_context" });
    expect(res.autoShipped).toBe(true);
    expect(res.shipError).toBeUndefined();
  });

  it("never halts on a skipped review, even under the block posture", async () => {
    const res = await runBetaSession(repo, { policy: "enabled: false\noffRail: block\n" });
    expect(res.autoShipped).toBe(true);
    expect(res.haltReason).toBeUndefined();
  });

  it("converts an unresolvable project into an unavailable verdict, not a throw", async () => {
    // "test-project" is not in the registry, so runReview's loadContext throws.
    // The gate must catch it rather than let it reach the auto-ship catch.
    const res = await runBetaSession(repo, { policy: ADVISORY });
    expect(res.ok).toBe(true);
    expect(res.shipError).toBeUndefined();
    const review = stepFor(res, "review");
    expect(review.verdict).not.toBe("pass");
    expect(res.autoShipped).toBe(true);
  });
});

describe("advisory posture — records, never halts", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("ships despite an unavailable reviewer — the deliberate divergence from on-rail", async () => {
    const before = tip(repo.dir, repo.branch);
    const res = await runBetaSession(repo, { policy: ADVISORY });

    expect(res.autoShipped).toBe(true);
    expect(stepFor(res, "commit")?.commitId).toBeTruthy();
    // The reviewer could not run, and the gate says so — but under advisory that
    // is recorded, not enforced. On-rail this same condition halts.
    expect(stepFor(res, "review").verdict).not.toBe("pass");
    expect(res.haltReason).toBeUndefined();
    // The working branch actually advanced.
    expect(tip(repo.dir, repo.branch)).not.toBe(before);
  });

  it("ships despite out-of-scope changes, listing every one it left behind", async () => {
    // INVERTED by backlog.fix.offrail-ship-scoped-staging. The out-of-scope paths
    // are no longer STAGED, so scope_reconcile — a post-hoc audit of the commit —
    // has nothing left to flag. The enumeration moved from `violations` (after the
    // commit, too late to matter) to `unstagedOutOfScope` (before it, describing
    // what was deliberately left alone). The ship still completes either way.
    const res = await runBetaSession(repo, {
      policy: DISABLED,
      extra: (r) => {
        fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n");
        fs.writeFileSync(path.join(r.dir, "rogue-two.mjs"), "2\n");
        fs.writeFileSync(path.join(r.dir, "rogue-three.mjs"), "3\n");
      },
    });
    expect(res.autoShipped).toBe(true);
    const scope = stepFor(res, "scope_reconcile");
    expect(scope.ok).toBe(true);
    expect(scope.violations).toEqual([]);
    expect([...res.unstagedOutOfScope].sort()).toEqual(
      expect.arrayContaining(["rogue-one.mjs", "rogue-two.mjs", "rogue-three.mjs"]),
    );
  });

  it("LEAVES the out-of-scope files out of the commit and in the worktree", async () => {
    // INVERTED by backlog.fix.offrail-ship-scoped-staging, and asserted against the
    // committed tree AND the worktree. The old expectation (sweep everything in,
    // report the violation afterwards) is what put a foreign untracked note inside
    // story commit f8ff97b1. The premise that filtering strands work is false:
    // `git checkout` carries uncommitted changes across a switch and `git branch -D`
    // does not touch the worktree.
    const res = await runBetaSession(repo, {
      policy: DISABLED,
      extra: (r) => fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n"),
    });
    expect(res.autoShipped).toBe(true);
    const sha = git(repo.dir, ["log", "--grep=#off-rail-work", "-1", "--format=%H"]).stdout.trim();
    expect(sha).toBeTruthy();
    const files = git(repo.dir, ["show", "--name-only", "--format=", sha]).stdout;
    expect(files).not.toContain("rogue-one.mjs");
    expect(files).toContain(IN_SCOPE);
    // Not committed anywhere — and not lost either.
    expect(fs.readFileSync(path.join(repo.dir, "rogue-one.mjs"), "utf8")).toBe("1\n");
    expect(git(repo.dir, ["status", "--porcelain"]).stdout).toContain("rogue-one.mjs");
  });

  it("marks scope_reconcile skipped when the session had no scope", async () => {
    // A read-only session (no problemId) has no allowedFiles — it must not
    // flag every changed file as a violation.
    const off = await guardrailsOff(repo.dir, "test", "all", null, "test-project");
    if (!off.ok) return; // gate may require a problemId; nothing to assert
    writePolicy(repo.dir, DISABLED);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 4;\n");
    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(stepFor(res, "scope_reconcile")).toMatchObject({ skipped: true, reason: "no_scope" });
  });
});

describe("block posture — halts before integration, strands nothing", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("halts at gate beta on a scope violation and leaves the working branch untouched", async () => {
    const before = tip(repo.dir, repo.branch);
    const res = await runBetaSession(repo, {
      policy: BLOCKING,
      extra: (r) => fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n"),
    });

    expect(res.autoShipped).toBe(false);
    expect(res.haltedAt).toBe("gate_beta");
    expect(["scope_violation", "review_unavailable"]).toContain(res.haltReason);
    expect(res.recoveryBranch).toMatch(/^off-rail\//);

    // The working branch never advanced…
    expect(tip(repo.dir, repo.branch)).toBe(before);
    // …the commit survives on the off-rail branch…
    const branches = git(repo.dir, ["branch", "--list", res.recoveryBranch]).stdout;
    expect(branches.trim()).not.toBe("");
    const ahead = git(repo.dir, ["rev-list", "--count", `${repo.branch}..${res.recoveryBranch}`]).stdout.trim();
    expect(Number(ahead)).toBeGreaterThanOrEqual(1);
    // …and no integration step ran.
    for (const s of ["local_merge", "delete-branch", "push-staging", "cycle_complete", "ship-note"]) {
      expect(stepNames(res)).not.toContain(s);
    }
    // The commit step IS present — the commit is what makes the diff reviewable.
    expect(stepNames(res)).toContain("commit");
  });

  it("halts at gate alpha and leaves the commits local and unpushed", async () => {
    const originBefore = tip(repo.bare, repo.branch);
    const res = await runAlphaSession(repo, {
      policy: BLOCKING,
      extra: (r) => fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n"),
    });

    expect(res.autoShipped).toBe(false);
    expect(res.haltedAt).toBe("gate_alpha");
    expect(res.recoveryBranch).toBe(repo.branch);
    // Nothing was pushed.
    expect(tip(repo.bare, repo.branch)).toBe(originBefore);
    const ahead = git(repo.dir, ["rev-list", "--count", `origin/${repo.branch}..${repo.branch}`]).stdout.trim();
    expect(Number(ahead)).toBeGreaterThan(0);
  });

  it("ships the identical fixture under advisory — pinning the posture asymmetry", async () => {
    const res = await runBetaSession(repo, {
      policy: ADVISORY,
      extra: (r) => fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n"),
    });
    expect(res.autoShipped).toBe(true);
    expect(res.haltReason).toBeUndefined();
  });
});

describe("enforcement override — permitted, but never silent", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("completes the ship and records the override with its reason", async () => {
    const res = await runBetaSession(repo, {
      policy: BLOCKING,
      extra: (r) => fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n"),
      options: { enforcementOverride: { enabled: true, reason: "hotfix: CI is dark" } },
    });

    expect(res.autoShipped).toBe(true);
    expect(res.haltReason).toBeUndefined();
    const override = stepFor(res, "enforcement_override");
    expect(override).toBeTruthy();
    expect(override.reason).toBe("hotfix: CI is dark");
    expect(res.enforcementOverride).toMatchObject({ applied: true, reason: "hotfix: CI is dark" });
  });

  it("does not record an override step when the posture is advisory", async () => {
    const res = await runBetaSession(repo, {
      policy: ADVISORY,
      options: { enforcementOverride: { enabled: true, reason: "unnecessary" } },
    });
    expect(stepFor(res, "enforcement_override")).toBeUndefined();
  });
});

describe("skipAutoShip callers reach neither check", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("produces no review and no scope_reconcile step", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", STORY_ID, "test-project");
    expect(off.ok).toBe(true);
    writePolicy(repo.dir, BLOCKING);
    fs.writeFileSync(path.join(repo.dir, IN_SCOPE), "export const v = 7;\n");

    const res = await guardrailsOn(repo.dir, { skipAutoShip: true }, "test-project");
    expect(res.ok).toBe(true);
    expect(stepNames(res)).not.toContain("review");
    expect(stepNames(res)).not.toContain("scope_reconcile");
    expect(res.haltReason).toBeUndefined();
  });
});

describe("three-branch local-only exit is gated", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo({ threeBranch: true }); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("cannot report autoShipped without both enforcement steps", async () => {
    const res = await runAlphaSession(repo, { policy: DISABLED });
    if (res.autoShipped === true) {
      expect(stepNames(res)).toContain("review");
      expect(stepNames(res)).toContain("scope_reconcile");
    }
    expect(res.ok).toBe(true);
  });
});

describe("fixture carries a repo-local git identity", () => {
  // Regression witness for the CI failure in staging run 31663568259, where
  // guardrailsOn's auto-ship died with "empty ident name" on a runner that has
  // no global git config.
  //
  // These read with --local ON PURPOSE. --local consults only the fixture's
  // .git/config — never ~/.gitconfig, never system config — so a developer's
  // global identity cannot make these pass vacuously. That is exactly the hole
  // that let the defect reach CI in the first place. GIT_ENV's GIT_AUTHOR_*
  // vars cannot satisfy them either: those are environment, not config.
  const localIdentity = (dir) => ({
    email: git(dir, ["config", "--local", "--get", "user.email"]).stdout?.trim(),
    name: git(dir, ["config", "--local", "--get", "user.name"]).stdout?.trim(),
  });

  it("sets user.email and user.name in .git/config on the 2-branch fixture", () => {
    const repo = makeRepo();
    try {
      const { email, name } = localIdentity(repo.dir);
      expect(email).toBeTruthy();
      expect(name).toBeTruthy();
    } finally {
      cleanup(repo.dir, repo.bare);
    }
  });

  it("sets user.email and user.name in .git/config on the 3-branch fixture", () => {
    const repo = makeRepo({ threeBranch: true });
    try {
      const { email, name } = localIdentity(repo.dir);
      expect(email).toBeTruthy();
      expect(name).toBeTruthy();
    } finally {
      cleanup(repo.dir, repo.bare);
    }
  });

  it("never writes git config globally and keeps GIT_ENV intact", () => {
    const src = fs.readFileSync(new URL(import.meta.url), "utf8");
    // Assembled so the forbidden literal never appears verbatim in this file —
    // otherwise this assertion would trip on its own source and fail always.
    const FORBIDDEN = ["--", "global"].join("");
    expect(src).not.toContain(FORBIDDEN);
    // The repo-local config is additive. GIT_ENV still backs the git() helper.
    expect(src).toContain("GIT_AUTHOR_NAME");
    expect(src).toContain("GIT_COMMITTER_EMAIL");
    expect(src).toContain("env: GIT_ENV");
  });
});

describe("downgrade legibility survives the whole consumer chain", () => {
  // backlog.fix.review-verdict-downgrade-legibility.
  //
  // The chain is runReview -> redactReview -> buildOffRailReviewStep -> gate
  // response. The MIDDLE link is the one nobody would think to test: redactReview
  // shallow-spreads and replaces only `findings`, so the new fields survive it by
  // construction today — but a refactor into a field allowlist would drop them
  // silently, mid-chain, with the unit tests on either side still green. That is
  // what this block exists to catch.
  //
  // The gate's own reviewer cannot run in a fixture repo (no credential, and the
  // fixture project is not in the registry), so the chain is driven from the real
  // computeFinalVerdict through the real redactReview and the real step builder,
  // and the live gate assertions below cover the response end.

  const POLICY = {
    verdictMode: "warn",
    blockCategories: ["enforcement_modification", "security_issue"],
  };
  const SECRET_LINE = 'const apiKey = "EXAMPLE-NOT-A-REAL-KEY";';

  /** The result object runReview assembles around computeFinalVerdict's return. */
  function runReviewShapedResult({ findings, llmVerdict, policy }) {
    const { verdict, downgradedFrom, downgradeReason } = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict,
      policy,
    });
    return {
      ok: true,
      verdict,
      downgradedFrom,
      downgradeReason,
      summary: `Review complete: ${findings.length} finding(s)`,
      findings,
    };
  }

  const softBlockResult = () =>
    runReviewShapedResult({
      findings: [
        { severity: "block", category: "ac_coverage", message: "AC 3 unmet", line: SECRET_LINE },
      ],
      llmVerdict: "block",
      policy: POLICY,
    });

  it("carries the downgrade record end to end, through redaction, into the ship step", () => {
    const result = softBlockResult();
    expect(result.verdict).toBe("warn");
    expect(result.downgradedFrom).toBe("block");

    const redacted = redactReview(result);
    // Redaction still does its job…
    expect(JSON.stringify(redacted)).not.toContain("EXAMPLE-NOT-A-REAL-KEY");
    // …and the explanation is not collateral damage.
    expect(redacted.downgradedFrom).toBe("block");
    expect(redacted.downgradeReason).toBe(result.downgradeReason);

    const step = buildOffRailReviewStep(redacted);
    expect(step.verdict).toBe("warn");
    expect(step.downgradedFrom).toBe("block");
    expect(step.downgradeReason).toContain("ac_coverage");
    expect(step.downgradeReason).toContain("blockCategories");
    expect(JSON.stringify(step)).not.toContain("EXAMPLE-NOT-A-REAL-KEY");
  });

  it("keeps a genuine warn free of downgrade keys across the same chain", () => {
    const genuine = runReviewShapedResult({
      findings: [{ severity: "warn", category: "anti_patterns", message: "console.log" }],
      llmVerdict: "warn",
      policy: POLICY,
    });
    const step = buildOffRailReviewStep(redactReview(genuine));
    expect(step.verdict).toBe("warn");
    expect(Object.keys(step)).not.toContain("downgradedFrom");
    expect(Object.keys(step)).not.toContain("downgradeReason");
  });

  it("does not move the halt discriminator: only a 'block' step verdict halts", () => {
    // haltReason is 'review_block' when and only when the step verdict is
    // 'block'. A downgraded warn reports its downgrade AND still does not halt.
    const downgraded = buildOffRailReviewStep(redactReview(softBlockResult()));
    expect(downgraded.downgradedFrom).toBe("block");
    expect(downgraded.verdict).not.toBe("block");

    const hard = runReviewShapedResult({
      findings: [{ severity: "block", category: "security_issue", message: "credential" }],
      llmVerdict: "block",
      policy: POLICY,
    });
    const hardStep = buildOffRailReviewStep(redactReview(hard));
    expect(hardStep.verdict).toBe("block");
    expect(hardStep.downgradedFrom).toBeUndefined();
  });
});

describe("the live gate response is unchanged where no downgrade happened", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("adds no downgrade keys to an unavailable-reviewer review step, and still ships", async () => {
    const res = await runBetaSession(repo, { policy: ADVISORY });
    expect(res.ok).toBe(true);
    const review = stepFor(res, "review");
    expect(review.verdict).not.toBe("pass");
    expect(review.downgradedFrom).toBeUndefined();
    expect(review.downgradeReason).toBeUndefined();
    // Advisory records, never halts — unchanged by this story.
    expect(res.haltReason).toBeUndefined();
    expect(res.autoShipped).toBe(true);
  });

  it("adds no downgrade keys to a skipped review step", async () => {
    const res = await runBetaSession(repo, { policy: DISABLED });
    const review = stepFor(res, "review");
    expect(review).toEqual({ step: "review", skipped: true, reason: "policy_disabled" });
    expect(res.autoShipped).toBe(true);
  });

  it("leaves the block-posture halt reason exactly as it was", async () => {
    const res = await runBetaSession(repo, { policy: BLOCKING });
    // The reviewer cannot run in the fixture, so the halt is review_unavailable —
    // the pre-existing behaviour. Recording downgrades must not perturb it.
    expect(res.autoShipped).toBe(false);
    expect(["review_unavailable", "scope_violation"]).toContain(res.haltReason);
    expect(stepFor(res, "review").downgradedFrom).toBeUndefined();
  });
});

describe("violations is a real observation — reachable end to end, not by construction", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("CATCHES a path that reached the commit without being staged by the ship", async () => {
    // THE ANTI-VACUITY FIXTURE, and the whole point of the story.
    //
    // The ship stages with `git add -- <stagePaths>` (guardrails-audit.mjs), which
    // ADDS to the index rather than replacing it. A path already staged before
    // guardrails_on therefore rides into the commit without ever passing through
    // buildShipScope — outside allowedFiles, not a ship artifact, and previously
    // invisible in every report: absent from unstagedPaths because it was never
    // partitioned, and absent from violations because the reconcile input was
    // pre-filtered by allowedFiles.
    //
    // The rogue path deliberately contains none of hook/sync/drift, so a
    // non-empty violations array cannot redden the shipSteps purity pin in
    // tests/unit/guardrails-on-hook-sync-ordering.test.mjs.
    const res = await runBetaSession(repo, {
      policy: ADVISORY,
      extra: (r) => {
        fs.writeFileSync(path.join(r.dir, "smuggled.mjs"), "export const x = 1;\n");
        git(r.dir, ["add", "--", "smuggled.mjs"]);
      },
    });

    expectShipped(res);
    const scope = stepFor(res, "scope_reconcile");
    // The leak is REAL — assert it actually reached the ship's OWN commit, or the
    // assertion below could pass for the wrong reason. Read res.commitId, not
    // HEAD: after a successful ship HEAD is the ship-NOTE commit, which is a
    // different commit entirely.
    expect(res.commitId).toBeTruthy();
    const committed = git(repo.dir, ["show", "--name-only", "--format=", res.commitId]).stdout
      .split("\n").map((l) => l.trim()).filter(Boolean);
    expect(committed).toContain("smuggled.mjs");
    // …and it is now NAMED, which is what changed.
    expect(scope.violations).toContain("smuggled.mjs");
    expect(scope.ok).toBe(false);
    expect(res.scopeViolations).toBeGreaterThan(0);
  });

  it("keeps the shipSteps purity pin green even with a non-empty violations array", async () => {
    const res = await runBetaSession(repo, {
      policy: ADVISORY,
      extra: (r) => {
        fs.writeFileSync(path.join(r.dir, "smuggled.mjs"), "export const x = 1;\n");
        git(r.dir, ["add", "--", "smuggled.mjs"]);
      },
    });
    expect(stepFor(res, "scope_reconcile").violations.length).toBeGreaterThan(0);
    for (const step of res.shipSteps || []) {
      expect(JSON.stringify(step)).not.toMatch(/hook|sync|drift/i);
    }
  });

  it("reports the scope reconcile as UNEVALUATED at gate alpha, not as clean", async () => {
    // Gate alpha has no commit of its own to read, so it makes no containment
    // claim rather than manufacturing a clean one from the intent set.
    const res = await runAlphaSession(repo, { policy: ADVISORY });
    const scope = stepFor(res, "scope_reconcile");
    expect(scope.evaluated).toBe(false);
    expect(scope.reason).toBe("no_commit");
    expect("ok" in scope).toBe(false);
    // And it is NOT treated as a ship failure — no commit means nothing falsified.
    expect(res.failedShipSteps || []).not.toContain("scope_reconcile");
  });
});

describe("a manifest that cannot be read is never reported as a clean commit", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("DRIVES a real git failure — a bogus SHA yields error, not an empty manifest", () => {
    // The load-bearing half. A non-zero `git diff-tree` exit with empty stdout is
    // otherwise byte-identical to a commit that touched nothing, which is exactly
    // the silence this story removes.
    const bogus = readCommitManifest(repo.dir, "0000000000000000000000000000000000000000");
    expect(bogus.paths).toBeUndefined();
    expect(typeof bogus.error).toBe("string");
    expect(bogus.error.length).toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL — the same helper reads a real commit's manifest", () => {
    // Without this the assertion above could pass because the helper always errors.
    const head = git(repo.dir, ["rev-parse", "HEAD"]).stdout.trim();
    const real = readCommitManifest(repo.dir, head);
    expect(real.error).toBeUndefined();
    expect(Array.isArray(real.paths)).toBe(true);
    expect(real.paths.length).toBeGreaterThan(0);
  });

  it("composes into the unevaluated manifest_unreadable step, carrying the git cause", () => {
    const failed = readCommitManifest(repo.dir, "0000000000000000000000000000000000000000");
    const step = buildScopeReconcileStep({
      allowedFiles: [IN_SCOPE],
      unevaluated: { reason: "manifest_unreadable", error: failed.error },
    });
    expect(step.evaluated).toBe(false);
    expect(step.reason).toBe("manifest_unreadable");
    expect("ok" in step).toBe(false);
    expect(step.error).toBe(failed.error);
    // Distinguishable from a genuinely clean commit by field value, not absence.
    const clean = buildScopeReconcileStep({ changedFiles: [], allowedFiles: [IN_SCOPE] });
    expect(clean).not.toEqual(step);
    expect(clean.ok).toBe(true);
  });
});
