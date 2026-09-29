/**
 * Tests for backlog.fix.off-rail-commit-reports-committed-file-count.
 *
 * `guardrailsOn` used to detect changes BEFORE restoring the hook tiers. While a
 * session is off-rail the write/read tiers are physically relocated to the
 * gitignored .routekit/hooks.bak/, so every tracked file under .routekit/hooks/
 * is absent from the worktree and `git diff --name-only` reports it as a
 * DELETION. Those phantoms inflated the count that gates auto-ship, stamps
 * "Files: N" into the commit body, and is reported to the caller, the session log
 * and telemetry — observed as changesDetected: 35 against a 5-file commit.
 *
 * THE FIXTURE PRECONDITION IS THE WHOLE TEST. The repo must have files under
 * .routekit/hooks/ TRACKED AND COMMITTED TO HEAD before guardrailsOff runs, and
 * .gitignore must cover .rks/ and .routekit/hooks.bak/. Without a real tracked
 * hooks tree there are no phantoms and the regression cannot reproduce — which is
 * exactly why the pre-existing witnesses stayed green through the defect.
 *
 * These assertions target the GATE and the remote, not the reported number, so a
 * display-only patch cannot satisfy them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real guardrailsOff → guardrailsOn cycles against a git repo with a bare
// origin. The off-rail enforcement gate added a policy load and a dynamic import
// to that path, pushing the shipping cases past vitest's 5s default.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  guardrailsOff,
  guardrailsOn,
  guardrailsAbort,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** All git calls carry an explicit timeout — story policy for the integration tier. */
function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });
}

const HOOK_TIERS = { write: ["enforce-a.mjs", "enforce-b.mjs"], read: ["redirect-c.mjs"] };

/**
 * A repo whose .routekit/hooks/ tree is tracked in HEAD — the precondition that
 * makes phantom deletions observable at all.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-offrail-count-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-offrail-origin-"));

  git(bare, ["init", "--bare", "-q"]);

  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  // Off-rail enforcement gate loads .rks/review-policy.yaml with this root;
  // disable review so these sessions never reach a live reviewer. (projectId
  // "test-project" is not in the registry, so runReview's own lookup would
  // throw — the gate catches that, but skipping outright is cleaner.)
  fs.writeFileSync(
    path.join(dir, ".rks", "review-policy.yaml"),
    "# Fixture: keep the off-rail enforcement gate from calling a live reviewer.\nenabled: false\n",
  );
  fs.mkdirSync(path.join(dir, "packages", "mcp-rks", "src"), { recursive: true });

  // .rks/ and hooks.bak/ must be ignored or the session's own bookkeeping and the
  // relocated copies would themselves show up and mask what we are measuring.
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    [".rks/", ".routekit/hooks.bak/", ""].join("\n")
  );

  for (const [tier, files] of Object.entries(HOOK_TIERS)) {
    const tierDir = path.join(dir, ".routekit", "hooks", tier);
    fs.mkdirSync(tierDir, { recursive: true });
    for (const f of files) {
      fs.writeFileSync(path.join(tierDir, f), `// ${tier}/${f}\nexport default {};\n`);
    }
  }
  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify(
      {
        hooks: Object.entries(HOOK_TIERS).flatMap(([tier, files]) =>
          files.map((f) => ({ name: f.replace(".mjs", ""), tier }))
        ),
      },
      null,
      2
    )
  );

  fs.writeFileSync(path.join(dir, "packages", "mcp-rks", "src", "example.mjs"), "export const v = 1;\n");
  fs.writeFileSync(
    path.join(dir, "notes", "backlog.fix.fixture.md"),
    ['---', 'id: "backlog.fix.fixture"', 'phase: "arch-approved"', 'targetFiles:', '  - path: "packages/mcp-rks/src/example.mjs"', '    op: "edit"', '---', '', '## Problem', ''].join("\n")
  );

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
  git(dir, ["commit", "-q", "-m", "chore: baseline with tracked hooks"]);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "-u", "origin", "staging"]);

  return { dir, bare };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function originTip(bare) {
  return git(bare, ["rev-parse", "staging"]).stdout.trim();
}

function trackedHookFilesPresent(dir) {
  return Object.entries(HOOK_TIERS).every(([tier, files]) =>
    files.every((f) => fs.existsSync(path.join(dir, ".routekit", "hooks", tier, f)))
  );
}

describe("off-rail change count reflects the post-restore, committable set", () => {
  let repo = null;

  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("relocates the tracked hook tiers while off-rail (fixture precondition holds)", async () => {
    // If this fails, every other test here is vacuous.
    expect(trackedHookFilesPresent(repo.dir)).toBe(true);
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    expect(trackedHookFilesPresent(repo.dir)).toBe(false);

    // …and git sees those tracked files as deletions right now. That is the
    // phantom source the fix must not count.
    const diff = git(repo.dir, ["diff", "--name-only"]).stdout;
    expect(diff).toMatch(/\.routekit\/hooks\//);
  });

  it("reports zero changes for a session that touched nothing", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);
    // Pre-fix this was one phantom deletion per tracked hook file.
    expect(on.changesDetected).toBe(0);
    expect(on.changedFiles).toEqual([]);
  });

  it("does not open the auto-ship gate on a phantom-only delta", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);
    expect(on.autoShipped).toBe(false);

    // No temp branch churn left behind.
    const branches = git(repo.dir, ["branch", "--list"]).stdout;
    expect(branches).not.toMatch(/off-rail\//);
  });

  it("creates no off-rail commit when the session changed nothing, even with unpushed commits present", async () => {
    // COUNTERPART CASE. backlog.fix.offrail-ship-scoped-staging introduced a
    // SECOND way for the index to end up empty — a session whose entire change
    // set fell outside allowedFiles — and the two must stay distinguishable. This
    // is the GENUINE case (the session authored nothing at all) and its
    // expectations are unchanged by that story; the new one is pinned in
    // tests/integration/off-rail-scoped-staging.test.mjs and is observably
    // different, carrying a non-empty unstagedOutOfScope enumeration.
    //
    // An unpushed commit that has nothing to do with the session. Pre-fix, the
    // phantom count opened the auto-ship gate, which then found aheadCount > 0.
    fs.writeFileSync(path.join(repo.dir, "unrelated.txt"), "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);
    const tipBefore = originTip(repo.bare);

    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);

    // The session authored nothing, so no off-rail commit and no branch churn.
    expect(on.changesDetected).toBe(0);
    expect(git(repo.dir, ["log", "--grep=#off-rail-work", "--format=%H"]).stdout.trim()).toBe("");
    expect(git(repo.dir, ["branch", "--list"]).stdout).not.toMatch(/off-rail\//);

    // The deferred half, now settled. This used to read "deliberately not
    // asserted: guardrailsOn may still push the pre-existing unpushed commit via
    // the separate no-changes aheadCount path" — that was the distinct defect
    // backlog.fix.offrail-autoship-else-branch-false-ship closed. The no-changes
    // path now reports the ahead commits as unpushedCommits and pushes nothing,
    // so the outcome is nothing_to_ship rather than a false "shipped".
    expect(originTip(repo.bare)).toBe(tipBefore);
    expect(on.autoShipped).toBe(false);
    expect(on.shipOutcome).toBe("nothing_to_ship");
    expect(on.unpushedCommits).toBe(1);
  });

  it("still counts and ships genuine session work", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    fs.writeFileSync(
      path.join(repo.dir, "packages", "mcp-rks", "src", "example.mjs"),
      "export const v = 2;\n"
    );

    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);
    expect(on.changesDetected).toBe(1);
    expect(on.changedFiles).toContain("packages/mcp-rks/src/example.mjs");
    // No hook path may appear — the restore made them identical to HEAD again.
    for (const f of on.changedFiles) {
      expect(f).not.toMatch(/^\.routekit\/hooks\//);
    }
  });

  it("stamps the commit body with the count that matches the diff", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    fs.writeFileSync(
      path.join(repo.dir, "packages", "mcp-rks", "src", "example.mjs"),
      "export const v = 3;\n"
    );
    fs.writeFileSync(path.join(repo.dir, "packages", "mcp-rks", "src", "added.mjs"), "export const w = 1;\n");

    // added.mjs is OUT of this fixture's scope (targetFiles is example.mjs only),
    // so under backlog.fix.offrail-ship-scoped-staging it is neither counted nor
    // committed. Every term below moved together — declared, changesDetected and
    // the real diff are all 1 — which is what AC 10 asks for: the stamp describes
    // the commit, not the worktree.
    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);
    expect(on.autoShipped).toBe(true);

    // The auto-ship local-merges the off-rail branch into staging, so HEAD is a
    // merge commit with no Files: line. Target the off-rail commit itself.
    const sha = git(repo.dir, ["log", "--grep=#off-rail-work", "-1", "--format=%H"]).stdout.trim();
    expect(sha).toBeTruthy();

    const body = git(repo.dir, ["log", "-1", "--format=%B", sha]).stdout;
    const declared = Number(body.match(/^Files:\s*(\d+)$/m)?.[1]);
    const actual = git(repo.dir, ["show", "--name-only", "--format=", sha])
      .stdout.split("\n").map((s) => s.trim()).filter(Boolean).length;

    expect(declared).toBe(on.changesDetected);
    expect(declared).toBe(actual);
  });

  it("reports an honest message when there is genuinely nothing to ship", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);
    // Must not assert work was committed and pushed when nothing was staged.
    if (on.message) {
      expect(on.message).not.toBe("Changes detected vs session start but already committed and pushed.");
    }
  });
});

describe("guardrailsAbort — same ordering, reporting only", () => {
  let repo = null;

  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("does not inflate changesDiscarded with phantom hook deletions", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const aborted = await guardrailsAbort(repo.dir, "test-project");
    expect(aborted.ok).toBe(true);
    expect(aborted.changesDiscarded).toBe(0);
  });

  it("still reports genuine discarded work", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    fs.writeFileSync(
      path.join(repo.dir, "packages", "mcp-rks", "src", "example.mjs"),
      "export const v = 99;\n"
    );

    const aborted = await guardrailsAbort(repo.dir, "test-project");
    expect(aborted.ok).toBe(true);
    expect(aborted.changesDiscarded).toBeGreaterThanOrEqual(1);
    // And the hooks are back where they belong.
    expect(trackedHookFilesPresent(repo.dir)).toBe(true);
  });
});

describe("fixture carries a repo-local git identity", () => {
  // Regression witness. guardrailsOn's auto-ship commits from a separate
  // process with bare process.env, so on a CI runner with no global identity
  // it dies with "empty ident name" and autoShipped comes back false.
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
