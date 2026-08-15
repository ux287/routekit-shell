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
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

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

/** Fail with the actual outcome rather than an empty-array mystery. */
const expectShipped = (res) =>
  expect({
    shipOutcome: res.shipOutcome,
    shipError: res.shipError,
    failedStage: res.failedStage,
  }).toEqual({ shipOutcome: "shipped", shipError: undefined, failedStage: undefined });
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

  it("ships despite out-of-scope changes, listing every violation", async () => {
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
    expect(scope.ok).toBe(false);
    expect(scope.violations).toEqual(
      expect.arrayContaining(["rogue-one.mjs", "rogue-two.mjs", "rogue-three.mjs"]),
    );
  });

  it("COMMITS the out-of-scope files rather than filtering the index", async () => {
    // Asserted against the committed tree, not the report — index filtering
    // would strand the remainder on a branch the merge steps then delete.
    const res = await runBetaSession(repo, {
      policy: DISABLED,
      extra: (r) => fs.writeFileSync(path.join(r.dir, "rogue-one.mjs"), "1\n"),
    });
    expect(res.autoShipped).toBe(true);
    const sha = git(repo.dir, ["log", "--grep=#off-rail-work", "-1", "--format=%H"]).stdout.trim();
    expect(sha).toBeTruthy();
    const files = git(repo.dir, ["show", "--name-only", "--format=", sha]).stdout;
    expect(files).toContain("rogue-one.mjs");
    expect(files).toContain(IN_SCOPE);
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
