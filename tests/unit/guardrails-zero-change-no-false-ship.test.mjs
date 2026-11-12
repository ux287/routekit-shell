/**
 * Tests for backlog.fix.offrail-autoship-else-branch-false-ship.
 *
 * Two composing defects, both on the `changes.total === 0` path of guardrailsOn:
 *
 *   1. getChangedFilesSince interpolated `sinceCommit` into an execSync shell
 *      string and swallowed every failure into `{ total: 0, error }`. No caller
 *      read `.error`, so a hard git failure was byte-identical to a clean
 *      worktree — and total:0 routes into the else-branch below.
 *   2. That else-branch fetched nothing, counted `origin/<branch>..<branch>`
 *      against a possibly stale remote-tracking ref, PUSHED the result, and set
 *      autoShipped/pushedToStaging/pushedCommits — so a session that changed
 *      nothing reported `shipOutcome: "shipped"` while pushing commits it did
 *      not author.
 *
 * WHY THESE ASSERTIONS ARE BEHAVIOURAL. The ahead-count is built from an ARGV
 * ARRAY (`spawnSync("git", ["rev-list", "--count", …])`), not the shell string
 * the story prose renders, so a test grepping the source for `rev-list --count`
 * passes on ZERO matches — vacuously. ARCH hit exactly that trap. Everything
 * here is therefore proved by observing what git was actually invoked with:
 * a PATH-shimmed `git` records every invocation in order, and the bare origin's
 * tip is read directly to prove nothing was pushed.
 *
 * Every spawnSync carries an explicit `timeout:` — under pool "forks" a hung git
 * subprocess holds a fork slot and surfaces as a silent CI exit 124.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Real guardrailsOff → guardrailsOn cycles against a git repo with a bare origin,
// including a hook drift check and the enforcement gate's dynamic import.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { ensureTelemetryStorage } from "@routekit/telemetry";
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

/** Test-side git. Uses the ORIGINAL PATH snapshot, so the shim never intercepts it. */
function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });
}

const REAL_GIT = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 30_000 }).status === 0
  ? spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8", timeout: 30_000 }).stdout.trim()
  : "git";

const SESSION_LOG = ".rks/guardrails-off-sessions.jsonl";

/**
 * A fixture repo on branch `staging` with a bare origin, a tracked hook tree
 * (so the restore ordering behaves as in production) and an arch-approved story
 * note guardrailsOff requires.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-zerochange-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-zerochange-origin-"));

  git(bare, ["init", "--bare", "-q"]);

  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  // Keep the off-rail enforcement gate from reaching a live reviewer.
  fs.writeFileSync(
    path.join(dir, ".rks", "review-policy.yaml"),
    "# Fixture: no live reviewer.\nenabled: false\n",
  );
  fs.mkdirSync(path.join(dir, "packages", "mcp-rks", "src"), { recursive: true });

  fs.writeFileSync(path.join(dir, ".gitignore"), [".rks/", ".routekit/hooks.bak/", ""].join("\n"));

  for (const [tier, files] of Object.entries({ write: ["enforce-a.mjs"], read: ["redirect-c.mjs"] })) {
    const tierDir = path.join(dir, ".routekit", "hooks", tier);
    fs.mkdirSync(tierDir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(tierDir, f), `// ${tier}/${f}\nexport default {};\n`);
  }
  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify({ hooks: [{ name: "enforce-a", tier: "write" }, { name: "redirect-c", tier: "read" }] }, null, 2),
  );

  fs.writeFileSync(path.join(dir, "packages", "mcp-rks", "src", "example.mjs"), "export const v = 1;\n");
  fs.writeFileSync(
    path.join(dir, "notes", "backlog.fix.fixture.md"),
    [
      "---",
      'id: "backlog.fix.fixture"',
      'phase: "arch-approved"',
      "targetFiles:",
      '  - path: "packages/mcp-rks/src/example.mjs"',
      '    op: "edit"',
      "---",
      "",
      "## Problem",
      "",
    ].join("\n"),
  );

  git(dir, ["init", "-q"]);
  // Repo-local identity: the auto-ship commits from a separate process with bare
  // process.env, so GIT_ENV never reaches it and a CI runner has no global ident.
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

function originTip(bare) {
  return git(bare, ["rev-parse", "staging"]).stdout.trim();
}

/**
 * A `git` shim earlier on PATH that appends every invocation's argv to a log and
 * then execs the real git. `failDiffNameOnly` additionally makes
 * `git diff --name-only …` fail, which is how getChangedFilesSince's error path
 * is driven WITHOUT corrupting the session ref (guardrailsAbort must still be
 * able to `git reset --hard` to it).
 *
 * `git diff --cached --quiet` is deliberately NOT matched — that is the auto-ship
 * staging check, on a different path.
 */
function makeGitShim({ failDiffNameOnly = false } = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-gitshim-"));
  const logPath = path.join(binDir, "git-calls.log");
  fs.writeFileSync(logPath, "");
  const shim = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
    ...(failDiffNameOnly
      ? [
          'if [ "$1" = "diff" ] && [ "$2" = "--name-only" ]; then',
          '  echo "fatal: injected change-count failure" >&2',
          "  exit 128",
          "fi",
        ]
      : []),
    `exec ${JSON.stringify(REAL_GIT)} "$@"`,
    "",
  ].join("\n");
  const shimPath = path.join(binDir, "git");
  fs.writeFileSync(shimPath, shim);
  fs.chmodSync(shimPath, 0o755);

  return {
    binDir,
    /** Run `fn` with the shim first on PATH; always restores PATH. */
    async withShim(fn) {
      const prev = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prev}`;
      try {
        return await fn();
      } finally {
        process.env.PATH = prev;
      }
    },
    calls() {
      return fs.readFileSync(logPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    },
  };
}

function readSessionLog(dir) {
  const p = path.join(dir, SESSION_LOG);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Capture emitted telemetry through BOTH surfaces, because which one is live
 * depends on the tier config: tests/setup.mjs replaces `@routekit/telemetry`
 * with a stub whose `emit` is a vi.fn and whose `addListener` is an inert vi.fn,
 * while a config without that setup file yields the real collector, where
 * `addListener` works and `emit` has no `.mock`. Reading the union means this
 * test cannot pass vacuously in either tier.
 */
function captureTelemetry(collector) {
  const seen = [];
  let unsubscribe = null;
  if (typeof collector.addListener === "function") {
    unsubscribe = collector.addListener((event) => seen.push(event));
  }
  return {
    stop() { try { unsubscribe?.(); } catch { /* inert under the stub */ } },
    payloads(type) {
      const fromListener = seen
        .filter((e) => e && e.type === type)
        .map((e) => e.payload ?? e.data ?? e);
      const fromSpy = (collector.emit?.mock?.calls ?? [])
        .filter((c) => c[0] === type)
        .map((c) => c[2]);
      return [...fromListener, ...fromSpy];
    },
  };
}

describe("getChangedFilesSince — argv invocation, no shell", () => {
  let repo = null;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { if (repo) cleanup(repo.dir, repo.bare); repo = null; });

  it("treats a sinceCommit carrying shell metacharacters as a ref, not a command", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    // Rewrite the recorded session ref to something that, interpolated into a
    // shell string, would run a SECOND command. Passed as an argv element it is
    // merely an unknown revision.
    const logPath = path.join(repo.dir, SESSION_LOG);
    const entries = readSessionLog(repo.dir);
    const malicious = "HEAD; touch pwned";
    for (const e of entries) if (e.headCommit) e.headCommit = malicious;
    fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const on = await guardrailsOn(repo.dir, {}, "test-project");
    expect(on.ok).toBe(true);

    // THE assertion: the injected command never ran, anywhere it could have.
    expect(fs.existsSync(path.join(repo.dir, "pwned"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "pwned"))).toBe(false);

    // And the bogus ref registered as a FAILURE, not as a clean tree.
    expect(on.changeCountError).toBeTruthy();
  });

  it("distinguishes an errored change count from a genuinely clean worktree", async () => {
    // Clean run: total 0, no error.
    let off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    const clean = await guardrailsOn(repo.dir, {}, "test-project");
    expect(clean.ok).toBe(true);
    expect(clean.changesDetected).toBe(0);
    expect(clean.changeCountError).toBeUndefined();

    // Errored run: same total 0, but an error field that tells them apart.
    off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    const shim = makeGitShim({ failDiffNameOnly: true });
    let errored;
    try {
      errored = await shim.withShim(() => guardrailsOn(repo.dir, {}, "test-project"));
    } finally {
      cleanup(shim.binDir);
    }
    expect(errored.ok).toBe(true);
    expect(errored.changesDetected).toBe(0);
    expect(errored.changeCountError).toBeTruthy();
  });
});

describe("an uncomputable change count is a failure, never a ship", () => {
  let repo = null;
  let shim = null;
  beforeEach(() => { repo = makeRepo(); shim = makeGitShim({ failDiffNameOnly: true }); });
  afterEach(() => {
    if (repo) cleanup(repo.dir, repo.bare);
    if (shim) cleanup(shim.binDir);
    repo = null; shim = null;
  });

  it("surfaces the error on the response, in the session log and in telemetry", async () => {
    const collector = ensureTelemetryStorage(repo.dir);
    const telemetry = captureTelemetry(collector);
    let on;
    try {
      const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
      expect(off.ok).toBe(true);
      on = await shim.withShim(() => guardrailsOn(repo.dir, {}, "test-project"));
    } finally {
      telemetry.stop();
    }
    expect(on.changeCountError).toBeTruthy();

    const endEntry = readSessionLog(repo.dir).filter((e) => e.endedAt).pop();
    expect(endEntry).toBeTruthy();
    expect(endEntry.changeCountError).toBeTruthy();

    const payloads = telemetry.payloads("guardrails.on");
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.some((p) => p && p.changeCountError)).toBe(true);
  });

  it("resolves to shipOutcome failed — never shipped — and pushes nothing", async () => {
    // A pre-existing unpushed commit, so the pre-fix code had something to push.
    fs.writeFileSync(path.join(repo.dir, "unrelated.txt"), "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);

    const tipBefore = originTip(repo.bare);
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const on = await shim.withShim(() => guardrailsOn(repo.dir, {}, "test-project"));

    expect(on.shipOutcome).toBe("failed");
    expect(on.shipOutcome).not.toBe("shipped");
    expect(on.autoShipped).not.toBe(true);
    expect(on.shipError).toBeTruthy();

    // Nothing reached the remote, and no push was even attempted.
    expect(originTip(repo.bare)).toBe(tipBefore);
    expect(shim.calls().filter((c) => c.split(" ")[0] === "push")).toEqual([]);
  });

  it("guardrailsAbort reads the error too rather than reporting a clean discard", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const aborted = await shim.withShim(() => guardrailsAbort(repo.dir, "test-project"));
    expect(aborted.ok).toBe(true);
    expect(aborted.changeCountError).toBeTruthy();

    const endEntry = readSessionLog(repo.dir).filter((e) => e.aborted).pop();
    expect(endEntry).toBeTruthy();
    expect(endEntry.changeCountError).toBeTruthy();
  });
});

describe("the zero-change branch fetches, never pushes, and reports unpushedCommits", () => {
  let repo = null;
  let shim = null;
  beforeEach(() => { repo = makeRepo(); shim = makeGitShim(); });
  afterEach(() => {
    if (repo) cleanup(repo.dir, repo.bare);
    if (shim) cleanup(shim.binDir);
    repo = null; shim = null;
  });

  it("fetches the target branch BEFORE taking the ahead-count", async () => {
    fs.writeFileSync(path.join(repo.dir, "unrelated.txt"), "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);

    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    await shim.withShim(() => guardrailsOn(repo.dir, {}, "test-project"));

    const calls = shim.calls();
    // Match on argv shape, NOT on a source substring: the invocation is an argv
    // array in the source, so a source grep for "rev-list --count" finds nothing.
    const fetchIdx = calls.findIndex((c) => /^fetch\b.*\bstaging\b/.test(c));
    const countIdx = calls.findIndex((c) => /^rev-list\s+--count\s+origin\/staging\.\.staging/.test(c));

    expect(countIdx).toBeGreaterThanOrEqual(0); // the ahead-count still happens
    expect(fetchIdx).toBeGreaterThanOrEqual(0); // and a fetch happened at all
    expect(fetchIdx).toBeLessThan(countIdx);    // …before it
  });

  it("counts against the refreshed remote, so commits already on origin are not reported", async () => {
    // Commit B locally, then move the BARE repo to B directly. The local
    // remote-tracking ref origin/staging still points at A, so an unfetched
    // ahead-count says 1 when the true answer is 0.
    fs.writeFileSync(path.join(repo.dir, "already-remote.txt"), "already on origin\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: commit that origin already has"]);
    const fetchIntoBare = git(repo.bare, ["fetch", repo.dir, "staging:staging"]);
    expect(fetchIntoBare.status).toBe(0);

    // Precondition: without a fetch the count is stale and non-zero.
    const staleCount = git(repo.dir, ["rev-list", "--count", "origin/staging..staging"]).stdout.trim();
    expect(staleCount).toBe("1");

    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    const on = await guardrailsOn(repo.dir, {}, "test-project");

    expect(on.ok).toBe(true);
    expect(on.changesDetected).toBe(0);
    // The fetch refreshed origin/staging to B, so there is nothing ahead.
    expect(on.unpushedCommits).toBeUndefined();
    expect(on.shipOutcome).toBe("nothing_to_ship");
  });

  it("never invokes git push and leaves the remote untouched when commits are ahead", async () => {
    fs.writeFileSync(path.join(repo.dir, "unrelated.txt"), "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);

    const tipBefore = originTip(repo.bare);
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);

    const on = await shim.withShim(() => guardrailsOn(repo.dir, {}, "test-project"));
    expect(on.ok).toBe(true);
    expect(on.changesDetected).toBe(0);

    // No push attempted at all — not "attempted and failed".
    expect(shim.calls().filter((c) => c.split(" ")[0] === "push")).toEqual([]);
    expect(originTip(repo.bare)).toBe(tipBefore);
  });

  it("reports unpushedCommits and drops the ship-claiming fields", async () => {
    fs.writeFileSync(path.join(repo.dir, "unrelated.txt"), "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);

    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    const on = await guardrailsOn(repo.dir, {}, "test-project");

    expect(on.ok).toBe(true);
    expect(on.unpushedCommits).toBe(1);
    expect(on.autoShipped).toBe(false);
    expect(on.pushedToStaging).toBeUndefined();
    expect(on.pushedCommits).toBeUndefined();
    expect(on.shipOutcome).toBe("nothing_to_ship");
    expect(on.shipOutcome).not.toBe("shipped");
  });

  it("still reports nothing_to_ship when the session changed nothing and nothing is ahead", async () => {
    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    const on = await guardrailsOn(repo.dir, {}, "test-project");

    expect(on.ok).toBe(true);
    expect(on.changesDetected).toBe(0);
    expect(on.autoShipped).toBe(false);
    expect(on.unpushedCommits).toBeUndefined();
    expect(on.shipOutcome).toBe("nothing_to_ship");
  });

  it("survives an unreachable remote without claiming a ship or a push failure", async () => {
    // A recording remote that cannot be reached: the fetch fails, and any push
    // WOULD fail too. Pre-fix that surfaced as shipError "Failed to push … to
    // staging"; post-fix no push is attempted, so no such error exists.
    fs.writeFileSync(path.join(repo.dir, "unrelated.txt"), "not session work\n");
    git(repo.dir, ["add", "-A"]);
    git(repo.dir, ["commit", "-q", "-m", "chore: unrelated local commit"]);
    git(repo.dir, ["remote", "set-url", "origin", path.join(os.tmpdir(), "rks-nonexistent-origin-xyz")]);

    const off = await guardrailsOff(repo.dir, "test", "all", "backlog.fix.fixture", "test-project");
    expect(off.ok).toBe(true);
    const on = await shim.withShim(() => guardrailsOn(repo.dir, {}, "test-project"));

    expect(on.ok).toBe(true);
    expect(on.autoShipped).toBe(false);
    expect(on.shipOutcome).not.toBe("shipped");
    expect(on.shipError).toBeUndefined();
    expect(shim.calls().filter((c) => c.split(" ")[0] === "push")).toEqual([]);
    // The count was taken against a ref that could not be refreshed — say so.
    expect(on.aheadCountStale).toBe(true);
  });
});
