/**
 * Tests for backlog.fix.offrail-ship-scoped-staging — behavioral.
 *
 * The off-rail auto-ship staged with a bare `git add -A`, so every dirty and
 * untracked path in the worktree entered the story commit whether or not the
 * session touched it — including files that were untracked BEFORE the session
 * started. `scope_reconcile` only noticed afterwards, on a commit that already
 * existed: on commit f8ff97b1 it returned ok:false, named the path, and the merge
 * landed anyway.
 *
 * The fix is prevention at staging: stage the session's own write scope plus an
 * explicit session-artifact allowlist, leave everything else in the worktree, and
 * enumerate every path left behind on the response and in the session log.
 *
 * TWO PROPERTIES CARRY THIS SUITE, and they pull in opposite directions:
 *   - out-of-scope paths must not reach the commit; and
 *   - out-of-scope paths must not be LOST. The invariant this story replaced
 *     defended `git add -A` as a work-preservation guarantee. It is asserted here
 *     directly instead — the file is read back off disk after the merge and the
 *     branch delete, because `git checkout` carries uncommitted changes across a
 *     switch and `git branch -D` does not touch the worktree at all.
 *
 * The all-changes-out-of-scope case is the hazard this story CREATES: scoped
 * staging can now leave the index empty for a session that has uncommitted work,
 * which the empty-index branch was written to read as "already committed". Both
 * of its exits are covered below in both aheadCount shapes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// Each case drives a real git repo through guardrailsOff → guardrailsOn,
// including branch creation, merge and push to a bare origin. That runs well past
// vitest's 5s default, so raise it for this file rather than letting a
// slow-but-passing test read as a failure.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import {
  guardrailsOff,
  guardrailsOn,
  buildShipScope,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** Every subprocess spawn in this file carries an explicit timeout. */
function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });
}

const STORY_ID = "backlog.fix.fixture";
const IN_SCOPE = "packages/mcp-rks/src/example.mjs";
const NOTE = `notes/${STORY_ID}.md`;
// The system tier is never relocated to hooks.bak (scopeToDisabledTiers("all")
// moves read + write only), so a session edit to it survives the restore and is
// a stable witness for the `.routekit/hooks/` artifact allowlist.
const SYSTEM_HOOK = ".routekit/hooks/system/s.mjs";
const MANIFEST = ".routekit/hooks-manifest.json";

const SCOPE_FILE = ".rks/active-scope.json";
const SESSION_LOG = ".rks/guardrails-off-sessions.jsonl";

/** Disable review outright — the sandbox projectId is not in the registry. */
const NO_REVIEW = "enabled: false\n";

function storyNote(id, targetFiles) {
  const lines = ["---", `id: "${id}"`, 'phase: "arch-approved"'];
  if (targetFiles && targetFiles.length > 0) {
    lines.push("targetFiles:");
    for (const t of targetFiles) {
      lines.push(`  - path: "${t}"`, '    op: "edit"');
    }
  }
  lines.push("---", "", "## Problem", "");
  return lines.join("\n");
}

/**
 * A fixture repo with a tracked .routekit/hooks tree (so guardrailsOff has
 * something to relocate) and a story note scoping writes.
 *
 * `targetFiles` controls the session's allowedFiles. `ignoreRks: false` leaves
 * .rks/ tracked so the session-artifact allowlist is observable there.
 */
function makeRepo({
  targetFiles = [IN_SCOPE],
  ignoreRks = true,
  storyId = STORY_ID,
  frameworkProject = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-scoped-stage-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-scoped-stage-origin-"));
  git(bare, ["init", "--bare", "-q"]);

  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "packages", "mcp-rks", "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests", "unit"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests", "integration"), { recursive: true });
  for (const tier of ["write", "read", "system"]) {
    fs.mkdirSync(path.join(dir, ".routekit", "hooks", tier), { recursive: true });
  }

  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    [...(ignoreRks ? [".rks/"] : []), ".routekit/hooks.bak/", ""].join("\n"),
  );
  fs.writeFileSync(path.join(dir, ".routekit", "hooks", "write", "w.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(dir, ".routekit", "hooks", "read", "r.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(dir, SYSTEM_HOOK), "export default { v: 1 };\n");
  fs.writeFileSync(
    path.join(dir, MANIFEST),
    JSON.stringify(
      { hooks: [{ name: "w", tier: "write" }, { name: "r", tier: "read" }, { name: "s", tier: "system" }] },
      null,
      2,
    ),
  );
  // The gate loads .rks/review-policy.yaml with this root; keep it from reaching
  // a live reviewer (the sandbox projectId is not registered).
  fs.writeFileSync(path.join(dir, ".rks", "review-policy.yaml"), NO_REVIEW);
  // A problemId-less session is reachable ONLY for a framework project — the
  // phase gate in guardrailsOff refuses every other one with problemId_required.
  // That is the sole route to a genuinely null allowedFiles, so it is how the
  // scopeless fallback is exercised rather than by faking a scope file.
  if (frameworkProject) {
    fs.writeFileSync(
      path.join(dir, ".rks", "project.json"),
      JSON.stringify({ frameworkProject: true }, null, 2),
    );
  }
  fs.writeFileSync(path.join(dir, IN_SCOPE), "export const v = 1;\n");
  fs.writeFileSync(path.join(dir, "notes", `${storyId}.md`), storyNote(storyId, targetFiles));

  git(dir, ["init", "-q"]);
  // Repo-local identity, deliberately NOT via GIT_ENV: the auto-ship spawns
  // `git commit` as a separate process with bare process.env, and a CI runner has
  // no global user.name/user.email. Never touches a developer's machine config.
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["checkout", "-q", "-b", "staging"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "-u", "origin", "staging"]);

  return { dir, bare, branch: "staging", storyId };
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const originTip = (bare) => git(bare, ["rev-parse", "staging"]).stdout.trim();
const write = (repo, rel, body) => {
  const abs = path.join(repo.dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const read = (repo, rel) => fs.readFileSync(path.join(repo.dir, rel), "utf8");
const porcelain = (repo, ...pathspec) =>
  git(repo.dir, ["status", "--porcelain", ...(pathspec.length ? ["--", ...pathspec] : [])]).stdout;

/** The off-rail commit's file list, or null when no off-rail commit exists. */
function offRailCommitFiles(repo) {
  const sha = git(repo.dir, ["log", "--grep=#off-rail-work", "-1", "--format=%H"]).stdout.trim();
  if (!sha) return null;
  return {
    sha,
    files: git(repo.dir, ["show", "--name-only", "--format=", sha])
      .stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    body: git(repo.dir, ["log", "-1", "--format=%B", sha]).stdout,
  };
}

/** Fail with the actual outcome rather than an empty-array mystery. */
const expectShipped = (res) =>
  expect({ shipOutcome: res.shipOutcome, shipError: res.shipError, failedStage: res.failedStage })
    .toEqual({ shipOutcome: "shipped", shipError: undefined, failedStage: undefined });

function sessionLogEntries(repo) {
  const p = path.join(repo.dir, SESSION_LOG);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("scoped staging — only the session's own work reaches the commit", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("commits the in-scope file and leaves the out-of-scope file out of the commit", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "rogue\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const commit = offRailCommitFiles(repo);
    expect(commit).not.toBeNull();
    expect(commit.files).toContain(IN_SCOPE);
    expect(commit.files).not.toContain("rogue.mjs");
  });

  it("leaves the out-of-scope file in the worktree with its content intact", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "rogue-content\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    expect(read(repo, "rogue.mjs")).toBe("rogue-content\n");
    expect(porcelain(repo)).toContain("rogue.mjs");
  });

  it("does not attribute a file that was untracked BEFORE guardrails_off — the f8ff97b1 case", async () => {
    // The exact production shape: an untracked note that already existed in the
    // worktree, swept into a story commit that does not own it. `git ls-files
    // --others` has no baseline, so the session cannot tell it apart by age —
    // only by scope.
    write(repo, "notes/pre-existing.md", "written before the session\n");
    expect(porcelain(repo)).toContain("notes/pre-existing.md");

    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const commit = offRailCommitFiles(repo);
    expect(commit.files).toContain(IN_SCOPE);
    expect(commit.files).not.toContain("notes/pre-existing.md");
    expect(read(repo, "notes/pre-existing.md")).toBe("written before the session\n");
    expect(res.unstagedOutOfScope).toContain("notes/pre-existing.md");
  });

  it("resolves glob allowedFiles entries against real worktree paths", async () => {
    // A pattern handed to `git add` as a literal pathspec stages nothing at all.
    // Staging must resolve it with buildScopeReconcileStep's own semantics.
    cleanup(repo.dir, repo.bare);
    repo = makeRepo({ targetFiles: ["tests/unit/*"] });

    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, "tests/unit/a.test.mjs", "// a\n");
    write(repo, "tests/integration/b.test.mjs", "// b\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const commit = offRailCommitFiles(repo);
    expect(commit.files).toContain("tests/unit/a.test.mjs");
    expect(commit.files).not.toContain("tests/integration/b.test.mjs");
    expect(res.unstagedOutOfScope).toEqual(["tests/integration/b.test.mjs"]);
  });

  it("still stages correctly once the scope file has been deleted", async () => {
    // removeScopeFile() runs BEFORE staging, so a fresh readActiveScope() at the
    // staging site would return null and silently collapse this session into the
    // unscoped sweep — a failure that is invisible, because the ship still
    // succeeds and still looks correct. The snapshot captured before the delete
    // is what makes this pass.
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    expect(fs.existsSync(path.join(repo.dir, SCOPE_FILE))).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "rogue\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    // The scope file is gone by the time the ship finished…
    expect(fs.existsSync(path.join(repo.dir, SCOPE_FILE))).toBe(false);
    expect(res.scopeFileRemoved).toBe(true);
    // …and the staging was still scoped.
    expect(offRailCommitFiles(repo).files).not.toContain("rogue.mjs");
  });

  it("reports scope_reconcile clean, because the violating paths were never staged", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "rogue\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const scope = (res.shipSteps || []).find((s) => s.step === "scope_reconcile");
    // Output SHAPE unchanged — this story does not touch buildScopeReconcileStep.
    expect(Object.keys(scope).sort()).toEqual(["inScopeCount", "ok", "step", "violations"]);
    expect(scope.ok).toBe(true);
    expect(scope.violations).toEqual([]);
    expect(scope.inScopeCount).toBe(1);
  });

  it("keeps the no_scope shape for a session that never had a scope", async () => {
    cleanup(repo.dir, repo.bare);
    repo = makeRepo({ frameworkProject: true });
    const off = await guardrailsOff(repo.dir, "t", "all", null, "test-project");
    expect(off.ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    const scope = (res.shipSteps || []).find((s) => s.step === "scope_reconcile");
    expect(scope).toEqual({ step: "scope_reconcile", skipped: true, reason: "no_scope" });
  });
});

describe("session-artifact allowlist — the ship still commits what it owns", () => {
  let repo = null;
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("commits .routekit/hooks/ and the hooks manifest despite their absence from allowedFiles", async () => {
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, SYSTEM_HOOK, "export default { v: 2 };\n");
    write(repo, MANIFEST, JSON.stringify({ hooks: [{ name: "s", tier: "system" }] }, null, 2));

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const commit = offRailCommitFiles(repo);
    expect(commit.files).toEqual(expect.arrayContaining([IN_SCOPE, SYSTEM_HOOK, MANIFEST]));
    // "In the allowlist" is not enough — the hook tree must end CLEAN, or the
    // next ship inherits the churn.
    expect(porcelain(repo, ".routekit/hooks").trim()).toBe("");
    expect(res.unstagedOutOfScope).toEqual([]);
  });

  it("keeps hook paths out of the reported change count even though they are committed", async () => {
    // changedFiles stays the USER-WORK count: hook restore/deploy churn inflating
    // it is the defect backlog.fix.off-rail-commit-reports-committed-file-count
    // closed, and the artifact allowlist must not reopen it from the other side.
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, SYSTEM_HOOK, "export default { v: 2 };\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(res.changedFiles).toEqual([IN_SCOPE]);
    for (const f of res.changedFiles) expect(f).not.toMatch(/^\.routekit\/hooks\//);
  });

  it("commits the story note even though it is not in allowedFiles", async () => {
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    fs.appendFileSync(path.join(repo.dir, NOTE), "\nSession scratch.\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(offRailCommitFiles(repo).files).toContain(NOTE);
    expect(res.unstagedOutOfScope).toEqual([]);
  });

  it("commits the ship-OWNED .rks/ bookkeeping file when .rks/ is tracked", async () => {
    // RE-EXPRESSED, not deleted. This case used to write
    // `.rks/session-scratch.json` and assert it WAS committed — which passed only
    // because SHIP_ARTIFACT_PREFIXES carried a bare `".rks/"` prefix. That bare
    // prefix is exactly the a9093f0d leak and is now gone. The allowance itself is
    // still real and still required, so the case now asserts it against a path the
    // ship genuinely owns: the session log it writes itself during guardrailsOn.
    repo = makeRepo({ ignoreRks: false });
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(offRailCommitFiles(repo).files).toContain(SESSION_LOG);
    expect(res.unstagedOutOfScope).toEqual([]);
  });

  it("REGRESSION a9093f0d — a dirty .rks/prompts file is NOT swept into the commit", async () => {
    // The literal shape of the overage: the session for a9093f0d declared 5
    // allowedFiles and committed 9, four of them governor prompts under
    // `.rks/prompts/`. They were admitted by the bare `.rks/` prefix, staged (so
    // absent from unstagedPaths) and filtered out of the reconcile input (so
    // absent from violations) — invisible in BOTH reports.
    repo = makeRepo({ ignoreRks: false });
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, ".rks/prompts/governor-po.md", "# edited governor prompt\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(offRailCommitFiles(repo).files).not.toContain(".rks/prompts/governor-po.md");
    expect(res.unstagedOutOfScope).toContain(".rks/prompts/governor-po.md");
    // And the file is still on disk — left behind, not destroyed.
    expect(read(repo, ".rks/prompts/governor-po.md")).toContain("edited governor prompt");
  });

  it("a dirty .rks/project.json is likewise left unstaged and enumerated", async () => {
    repo = makeRepo({ ignoreRks: false });
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, ".rks/project.json", '{"projectId":"edited"}\n');

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(offRailCommitFiles(repo).files).not.toContain(".rks/project.json");
    expect(res.unstagedOutOfScope).toContain(".rks/project.json");
  });
});

describe("artifact admissions are disclosed, and the commit is fully accounted for", () => {
  let repo = null;
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("names ship-owned committed paths outside allowedFiles on the RESPONSE", async () => {
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, SYSTEM_HOOK, "export default { v: 2 };\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    // The hook IS committed (required) and IS named (previously invisible).
    expect(offRailCommitFiles(repo).files).toContain(SYSTEM_HOOK);
    expect(res.artifactAdmissions).toContain(SYSTEM_HOOK);
  });

  it("keeps artifact admissions OFF the shipSteps entry and out of violations", async () => {
    // The disclosure must not redden the shipSteps hook-purity pin in
    // tests/unit/guardrails-on-hook-sync-ordering.test.mjs, which filters every
    // shipStep with /hook|sync|drift/i and asserts zero matches.
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, SYSTEM_HOOK, "export default { v: 2 };\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    const scope = (res.shipSteps || []).find((s) => s.step === "scope_reconcile");
    expect(scope.violations).toEqual([]);
    expect(scope.ok).toBe(true);
    expect("artifactAdmissions" in scope).toBe(false);
    for (const step of res.shipSteps || []) {
      expect(JSON.stringify(step)).not.toMatch(/hook|sync|drift/i);
    }
  });

  it("PRESENCE CONVENTION — a scoped ship with nothing admitted reports [], not nothing", async () => {
    // backlog.fix.post-ship-review-findings-batch, Finding 3.
    //
    // Under the old `.length > 0` guard this case produced NO key at all, so a
    // consumer could not tell "scoped ship, nothing admitted" from "field not
    // produced" — the reason the partition test above had to carry a `|| []`.
    // Goes red if that guard is restored.
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    // Touch ONLY an in-scope file: nothing to admit as a session artifact.
    write(repo, IN_SCOPE, "export const v = 2;\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    // Key ABSENCE is what the old guard produced, and `toEqual([])` alone cannot
    // tell the two apart for an undefined value — the in-operator can.
    expect("artifactAdmissions" in res).toBe(true);
    expect(res.artifactAdmissions).toEqual([]);
  });

  it("ANTI-VACUITY — the empty case and a real admission are DIFFERENT results", async () => {
    // Without this, the case above would also pass against an implementation that
    // hardcoded `[]` on every ship, admissions or not.
    repo = makeRepo();
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, SYSTEM_HOOK, "export default { v: 2 };\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect("artifactAdmissions" in res).toBe(true);
    expect(res.artifactAdmissions.length).toBeGreaterThan(0);
    expect(res.artifactAdmissions).toContain(SYSTEM_HOOK);
  });

  it("THREE-SET PARTITION — every committed path is in exactly one report", async () => {
    repo = makeRepo({ ignoreRks: false });
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, SYSTEM_HOOK, "export default { v: 2 };\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const committed = offRailCommitFiles(repo).files;
    const scope = (res.shipSteps || []).find((s) => s.step === "scope_reconcile");
    // NO `|| []`. The field is present on every scoped ship now, so a defensive
    // default here would hide a regression: if the disclosure went missing this
    // line would silently substitute an empty set and the partition below would
    // still "hold", counting the admitted path as in-scope.
    const admitted = res.artifactAdmissions;
    // NAMED, and BEFORE the dereference below. Without it a missing disclosure
    // surfaces as `Cannot read properties of undefined (reading 'includes')` from
    // the filter — a TypeError that names neither the field nor the invariant.
    // The run is red either way; this decides whether the failure explains
    // itself. `violations` keeps its `|| []` because it is genuinely optional,
    // whereas an absent artifactAdmissions must never pass as an empty set.
    expect(Array.isArray(admitted),
      "artifactAdmissions is absent from a scoped ship — the presence convention is broken")
      .toBe(true);
    const violations = scope.violations || [];
    const inScope = committed.filter(
      (f) => !admitted.includes(f) && !violations.includes(f),
    );

    // Exhaustive: nothing committed is unaccounted for.
    expect([...inScope, ...admitted, ...violations].sort()).toEqual([...committed].sort());
    // Disjoint: nothing is double-counted.
    for (const f of admitted) expect(violations).not.toContain(f);
    for (const f of admitted) expect(inScope).not.toContain(f);
    // Anti-vacuity: the admitted set is genuinely non-empty here.
    expect(admitted.length).toBeGreaterThan(0);
    expect(inScope).toContain(IN_SCOPE);
  });
});

describe("scopeless fallback — the escape hatch does not wedge", () => {
  let repo = null;
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("sweeps everything when allowedFiles is null (no problemId)", async () => {
    repo = makeRepo({ frameworkProject: true });
    const off = await guardrailsOff(repo.dir, "t", "all", null, "test-project");
    expect(off.ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "rogue\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(res.autoShipped).toBe(true);

    const commit = offRailCommitFiles(repo);
    expect(commit.files).toEqual(expect.arrayContaining([IN_SCOPE, "rogue.mjs"]));
    // Nothing was withheld, so there is nothing to enumerate.
    expect(res.unstagedOutOfScope).toBeUndefined();
  });

  it("sweeps everything when the story declares no targetFiles", async () => {
    repo = makeRepo({ targetFiles: [] });
    const off = await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project");
    expect(off.ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "rogue\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect(res.autoShipped).toBe(true);
    expect(offRailCommitFiles(repo).files).toEqual(expect.arrayContaining([IN_SCOPE, "rogue.mjs"]));
  });

  it("buildShipScope reports no_scope for both null and an empty allowedFiles array", () => {
    repo = makeRepo();
    for (const allowedFiles of [null, undefined, []]) {
      expect(buildShipScope({ projectRoot: repo.dir, allowedFiles })).toEqual({
        scoped: false,
        reason: "no_scope",
        stagePaths: [],
        unstagedPaths: [],
      });
    }
  });
});

describe("enumeration — every path left behind, on the response and in the log", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("reports the COMPLETE unstaged set, not a count and not a sample", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue-one.mjs", "1\n");
    write(repo, "rogue-two.mjs", "2\n");
    write(repo, "rogue-three.mjs", "3\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);
    expect([...res.unstagedOutOfScope].sort())
      .toEqual(["rogue-one.mjs", "rogue-three.mjs", "rogue-two.mjs"]);
  });

  it("records the same paths in the session-log end entry", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue-one.mjs", "1\n");
    write(repo, "rogue-two.mjs", "2\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    const end = sessionLogEntries(repo).filter((e) => e.endedAt).pop();
    expect(end).toBeTruthy();
    expect([...end.unstagedOutOfScope].sort()).toEqual([...res.unstagedOutOfScope].sort());
    expect([...end.unstagedOutOfScope].sort()).toEqual(["rogue-one.mjs", "rogue-two.mjs"]);
  });

  it("counts and stamps only what was committed", async () => {
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue-one.mjs", "1\n");
    write(repo, "rogue-two.mjs", "2\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    expect(res.changesDetected).toBe(1);
    expect(res.changedFiles).toEqual([IN_SCOPE]);
    expect(res.newFiles).toEqual([]);

    const commit = offRailCommitFiles(repo);
    const declared = Number(commit.body.match(/^Files:\s*(\d+)$/m)?.[1]);
    expect(declared).toBe(res.changesDetected);
    expect(declared).toBe(commit.files.length);
  });
});

describe("work preservation — nothing is lost across the merge and the branch delete", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("leaves the out-of-scope file readable after the off-rail branch is merged and deleted", async () => {
    // This is the property the old `git add -A` source-scan invariant claimed to
    // protect, asserted directly. Its stated premise — that the unstaged
    // remainder sits on a branch the delete/merge destroys — is false: `git
    // checkout` carries uncommitted changes across a switch and `git branch -D`
    // does not touch the worktree.
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 2;\n");
    write(repo, "rogue.mjs", "IRREPLACEABLE\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expectShipped(res);

    // The merge happened and the temp branch is gone…
    expect(git(repo.dir, ["branch", "--list"]).stdout).not.toMatch(/off-rail\//);
    expect(git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim()).toBe("staging");
    expect(originTip(repo.bare)).toBe(git(repo.dir, ["rev-parse", "staging"]).stdout.trim());
    // …and the file the ship refused to own is still exactly where it was.
    expect(read(repo, "rogue.mjs")).toBe("IRREPLACEABLE\n");
  });
});

describe("all changes out of scope — an empty index that is NOT 'already committed'", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("does not direct-push or claim a ship when unrelated commits are ahead", async () => {
    // aheadCount > 0. Pre-scoped-staging this exit direct-pushed the unrelated
    // commits and set autoShipped:true with telemetry guardrails.direct_pushed —
    // a false `shipped` while the session's own work sat uncommitted. That is the
    // defect class backlog.fix.offrail-autoship-else-branch-false-ship closed.
    write(repo, "unrelated.txt", "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);
    const tipBefore = originTip(repo.bare);

    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, "rogue-one.mjs", "1\n");
    write(repo, "rogue-two.mjs", "2\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(res.ok).toBe(true);
    expect(res.shipOutcome).not.toBe("shipped");
    expect(res.autoShipped).not.toBe(true);
    // Nothing was pushed and no off-rail commit exists.
    expect(originTip(repo.bare)).toBe(tipBefore);
    expect(offRailCommitFiles(repo)).toBeNull();
    expect(git(repo.dir, ["branch", "--list"]).stdout).not.toMatch(/off-rail\//);
    // The work is reported, not silently dropped — and still on disk.
    expect([...res.unstagedOutOfScope].sort()).toEqual(["rogue-one.mjs", "rogue-two.mjs"]);
    expect(read(repo, "rogue-one.mjs")).toBe("1\n");
  });

  it("does not claim the changes were already committed and pushed when nothing is ahead", async () => {
    // aheadCount === 0. Asserted on the MESSAGE TEXT, not only on shipOutcome:
    // the literal claim is what is false while the work sits in the worktree.
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, "rogue-one.mjs", "1\n");

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(res.ok).toBe(true);
    expect(res.shipOutcome).not.toBe("shipped");
    expect(res.autoShipped).not.toBe(true);
    expect(res.message || "").not.toMatch(/already committed and pushed/i);
    expect(res.unstagedOutOfScope).toEqual(["rogue-one.mjs"]);
    expect(read(repo, "rogue-one.mjs")).toBe("1\n");
  });

  it("is observably different from a session that genuinely committed mid-run", async () => {
    // The counterpart case, pinned in
    // tests/integration/off-rail-post-restore-change-count.test.mjs. Both leave
    // the index empty; only one has work left behind, and the two responses must
    // not collapse into each other.
    expect((await guardrailsOff(repo.dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(repo, IN_SCOPE, "export const v = 9;\n");
    // Exclude .routekit: the tiers live in the gitignored hooks.bak right now, so
    // a bare sweep would commit their DELETION and re-dirty the tree at restore.
    git(repo.dir, ["add", "-A", "--", ".", ":(exclude).routekit"]);
    git(repo.dir, ["commit", "-q", "-m", "feat: committed mid-session"]);

    const res = await guardrailsOn(repo.dir, {}, "test-project");
    expect(res.ok).toBe(true);
    // Genuine already-committed work: nothing was withheld…
    expect(res.unstagedOutOfScope).toEqual([]);
    // …and the ahead-count path still runs for it, which is the whole point of
    // distinguishing the two causes.
    expect(res.message || "").toMatch(/Pushed \d+ off-rail commit/);
    expect(res.autoShipped).toBe(true);
  });
});
