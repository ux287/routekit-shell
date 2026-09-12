/**
 * backlog.fix.guardrails-on-syncs-hooks — instrumented ordering + fault injection.
 *
 * Companion to tests/integration/guardrails-on-syncs-hooks.test.mjs. That file owns
 * the DECISIVE end-to-end deploy proof against a real, unmocked sync. This file owns
 * the assertions that are only observable by instrumenting the sync entry point:
 *
 *   - the sync fires AFTER .routekit/hooks.bak is gone (ordering pinned directly)
 *   - offRailActive === false in the recorded call arguments
 *   - the read-only drift check runs even when changes.total === 0
 *   - the payload field is present on the no-changes return path
 *   - guardrailsAbort never invokes the sync
 *   - a throwing sync is loud but non-fatal
 *
 * These two concerns live in separate files on purpose: vi.mock is file-scoped, so
 * mocking the sync here would defeat the real deploy proof if they shared a file.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/guardrails-on-hook-sync-ordering.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These drive real guardrailsOff → guardrailsOn cycles against a git repo. The
// off-rail enforcement gate added a policy load and a dynamic import to that
// path, pushing the auto-ship cases past vitest's 5s default — they were already
// close. Raise it so a slow-but-passing test does not read as a failure.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// --- instrumentation state (module scope; clearMocks does NOT reset plain arrays) ---
const syncCalls = [];
const driftCalls = [];
let syncBehavior = "ok";

function rootFromProjectHooks(projectHooks) {
  // projectHooks is always <projectRoot>/.routekit/hooks
  return path.resolve(projectHooks, "..", "..");
}

vi.mock("../../scripts/sync-hooks.mjs", () => ({
  // Real semantics — the ordering assertion is only meaningful if this reflects
  // the actual on-disk state the production code would have observed.
  isOffRailActive: vi.fn((root) =>
    fs.existsSync(path.join(root, ".routekit", "hooks.bak")),
  ),
  syncAll: vi.fn((args) => {
    const root = rootFromProjectHooks(args.projectHooks);
    // THE ordering probe: capture hooks.bak existence at the moment of invocation.
    syncCalls.push({
      args: { ...args },
      hooksBakExistedAtCallTime: fs.existsSync(
        path.join(root, ".routekit", "hooks.bak"),
      ),
    });
    if (syncBehavior === "throw") {
      throw new Error("simulated sync failure");
    }
    return {
      projectSynced: ["write/probe-hook.mjs"],
      templateSynced: ["write/probe-hook.mjs"],
      skippedProject: Boolean(args.offRailActive),
    };
  }),
  checkDrift: vi.fn((src, dest) => {
    driftCalls.push({ fn: "checkDrift", src, dest });
    return { ok: true, issues: [], srcCount: 1, destCount: 1 };
  }),
  checkOrphans: vi.fn((src, dest) => {
    driftCalls.push({ fn: "checkOrphans", src, dest });
    return { ok: true, issues: [], destCount: 1 };
  }),
  syncHooks: vi.fn(() => []),
  listFilesRecursive: vi.fn(() => []),
}));

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true, url: "https://example.test/pr/1", number: 1 }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true }),
  runCycleComplete: vi.fn().mockResolvedValue({ ok: true, branch: "staging" }),
}));

vi.mock("../../packages/mcp-rks/src/shared/commit-and-embed.mjs", () => ({
  commitAndEmbed: vi.fn().mockResolvedValue({ commitId: "mockcommit123", ragEmbedWarning: null }),
}));

const { guardrailsOff, guardrailsOn, guardrailsAbort } = await import(
  "../../packages/mcp-rks/src/server/guardrails-audit.mjs"
);

const PROBLEM_ID = "test-hook-sync-story";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });
}

/**
 * Temp project carrying BOTH a canonical packages/hooks source and a deployed
 * .routekit/hooks tree, so the conditional sync can actually be reached.
 */
function makeTempProject({ withCanonicalHooks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-hook-sync-order-"));

  const hooksDir = path.join(dir, ".routekit", "hooks");
  fs.mkdirSync(path.join(hooksDir, "write"), { recursive: true });
  fs.mkdirSync(path.join(hooksDir, "read"), { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "write", "probe-hook.mjs"), "// deployed v1\n");
  fs.writeFileSync(path.join(hooksDir, "read", "probe-read-hook.mjs"), "// deployed read v1\n");

  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify({ "probe-hook": { tier: "write" }, "probe-read-hook": { tier: "read" } }, null, 2),
  );

  if (withCanonicalHooks) {
    const canonical = path.join(dir, "packages", "hooks", "write");
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(canonical, "probe-hook.mjs"), "// canonical v1\n");
  }

  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  // Off-rail enforcement gate loads .rks/review-policy.yaml with this root;
  // disable review so the bare guardrailsOn calls never reach a live reviewer.
  fs.writeFileSync(
    path.join(dir, ".rks", "review-policy.yaml"),
    "# Fixture: keep the off-rail enforcement gate from calling a live reviewer.\nenabled: false\n",
  );

  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(
    path.join(notesDir, `${PROBLEM_ID}.md`),
    [
      "---",
      `id: "${PROBLEM_ID}"`,
      'title: "hook sync ordering fixture"',
      'phase: "arch-approved"',
      "targetFiles:",
      '  - "packages/hooks/write/probe-hook.mjs"',
      "---",
      "",
    ].join("\n"),
  );

  git(["init", "-b", "staging"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);

  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/** Touch the canonical hook source so the sync gate opens. */
function editCanonicalHook(dir, contents) {
  fs.writeFileSync(path.join(dir, "packages", "hooks", "write", "probe-hook.mjs"), contents);
}

describe("guardrailsOn hook sync — ordering and fault injection", () => {
  let dir;

  beforeEach(() => {
    syncCalls.length = 0;
    driftCalls.length = 0;
    syncBehavior = "ok";
    dir = makeTempProject();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("fires the sync only AFTER .routekit/hooks.bak has been removed", async () => {
    await guardrailsOff(dir, "ordering probe", "all", PROBLEM_ID);

    // Sanity: guardrails-off really did move the tiers aside.
    expect(fs.existsSync(path.join(dir, ".routekit", "hooks.bak"))).toBe(true);

    editCanonicalHook(dir, "// canonical v2\n");
    const result = await guardrailsOn(dir, { skipAutoShip: true });

    expect(result.ok).toBe(true);
    expect(syncCalls).toHaveLength(1);

    // THE ordering assertion — pinned directly, not inferred from call order.
    // A sync placed before the restore would self-skip (or be overwritten by the
    // subsequent rename) while still satisfying any "sync ran" spy.
    expect(syncCalls[0].hooksBakExistedAtCallTime).toBe(false);
  });

  it("passes offRailActive === false in the recorded sync arguments", async () => {
    await guardrailsOff(dir, "offRailActive probe", "all", PROBLEM_ID);
    editCanonicalHook(dir, "// canonical v2\n");
    await guardrailsOn(dir, { skipAutoShip: true });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].args.offRailActive).toBe(false);
    // and the sync therefore did NOT take its self-skip branch
    expect(syncCalls[0].args.src).toContain(path.join("packages", "hooks"));
    expect(syncCalls[0].args.projectHooks).toContain(path.join(".routekit", "hooks"));
  });

  it("runs the read-only drift check when the auto-ship is suppressed (not nested in the gate)", async () => {
    await guardrailsOff(dir, "no-ship probe", "all", PROBLEM_ID);
    // deliberately touch nothing of our own

    // NOTE on why this uses skipAutoShip rather than a literally-empty session:
    // `changes` is computed BEFORE the tier restore, and guardrailsOff itself
    // moves .routekit/hooks/** into hooks.bak and writes .rks/ session files —
    // so changes.total is never 0 after a real guardrailsOff. skipAutoShip
    // closes the same gate (`changes.total > 0 && !options.skipAutoShip`) and
    // therefore proves the same thing: this code is not inside that gate.
    const result = await guardrailsOn(dir, { skipAutoShip: true });

    expect(result.ok).toBe(true);
    expect(result.autoShipped).toBe(false);

    // The check must have run despite there being nothing shipped. Code placed
    // inside the auto-ship gate would never execute on this path.
    expect(result.hookDeploy).toBeDefined();
    expect(result.hookDeploy.checked).toBe(true);
    expect(result.hookDeploy.drift).not.toBeNull();
    expect(driftCalls.length).toBeGreaterThan(0);

    // ...and no deploy occurred, because nothing touched the canonical source.
    expect(result.hookDeploy.synced).toBe(false);
    expect(syncCalls).toHaveLength(0);
  });

  it("carries the hookDeploy field on the no-ship return path", async () => {
    await guardrailsOff(dir, "payload on tail exit", "all", PROBLEM_ID);
    const result = await guardrailsOn(dir, { skipAutoShip: true });

    // This return is taken from the tail of the function, past the auto-ship
    // block entirely. A field assigned inside that block would be absent here.
    expect(result.message).toContain("No changes detected");
    expect(result.hookDeploy).toBeDefined();
    expect(result.hookDeploy).toHaveProperty("checked", true);
    expect(result.hookDeploy).toHaveProperty("skipped");
  });

  it("never invokes the sync during guardrailsAbort", async () => {
    await guardrailsOff(dir, "abort never syncs", "all", PROBLEM_ID);
    editCanonicalHook(dir, "// canonical v2 — should never deploy\n");

    const result = await guardrailsAbort(dir);
    expect(result.ok).toBe(true);

    // Syncing on abort would deploy pre-session drift as a side effect of a discard.
    expect(syncCalls).toHaveLength(0);
  });

  it("is loud but NON-FATAL when the sync throws", async () => {
    await guardrailsOff(dir, "fault injection", "all", PROBLEM_ID);
    editCanonicalHook(dir, "// canonical v2\n");
    syncBehavior = "throw";

    const result = await guardrailsOn(dir, { skipAutoShip: true });

    // 1. non-fatal: the restore contract still holds
    expect(result.ok).toBe(true);
    expect(result.hooksRestored).toBe(true);

    // 2. hooks are fully restored, not half-restored
    expect(fs.existsSync(path.join(dir, ".routekit", "hooks", "write"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".routekit", "hooks", "read"))).toBe(true);

    // 3. hooks.bak is gone
    expect(fs.existsSync(path.join(dir, ".routekit", "hooks.bak"))).toBe(false);

    // 4. LOUD: the failure is surfaced in the payload, not swallowed
    expect(result.hookDeploy.synced).toBe(false);
    expect(result.hookDeploy.error).toBeTruthy();
    expect(result.hookDeploy.error).toContain("simulated sync failure");
  });

  it("still completes the auto-ship when the sync throws", async () => {
    await guardrailsOff(dir, "fault injection with ship", "all", PROBLEM_ID);
    editCanonicalHook(dir, "// canonical v2\n");
    syncBehavior = "throw";

    const result = await guardrailsOn(dir);

    expect(result.ok).toBe(true);
    expect(result.hookDeploy.error).toContain("simulated sync failure");
    // the ship was attempted rather than aborted by the sync failure
    expect(result.changesDetected).toBeGreaterThan(0);
    expect(result).toHaveProperty("autoShipped");
  });

  it("reports a benign skip when the project has no canonical packages/hooks source", async () => {
    cleanup(dir);
    dir = makeTempProject({ withCanonicalHooks: false });

    await guardrailsOff(dir, "no canonical source", "all", PROBLEM_ID);
    fs.writeFileSync(path.join(dir, "README.md"), "# touched\n");
    const result = await guardrailsOn(dir, { skipAutoShip: true });

    expect(result.ok).toBe(true);
    expect(result.hookDeploy.skipped).toBe("no_canonical_hooks_source");
    expect(result.hookDeploy.error).toBeNull();
    expect(result.hookDeploy.checked).toBe(false);

    // Critically: nothing was called, so nothing could throw. This is the
    // regression shield for every pre-existing guardrailsOn fixture, none of
    // which has a packages/hooks/ directory.
    expect(syncCalls).toHaveLength(0);
    expect(driftCalls).toHaveLength(0);
  });

  it("does not represent the hook sync as a shipSteps entry", async () => {
    await guardrailsOff(dir, "shipSteps purity", "all", PROBLEM_ID);
    editCanonicalHook(dir, "// canonical v2\n");
    const result = await guardrailsOn(dir);

    // guardrails-on-three-branch.spec.mjs asserts every skipped shipSteps entry
    // has reason 'three_branch_local_only'. A skipped hook-sync step added there
    // would redden that live assertion on the most common path.
    const steps = result.shipSteps || [];
    const hookSteps = steps.filter((s) => /hook|sync|drift/i.test(JSON.stringify(s)));
    expect(hookSteps).toHaveLength(0);
  });
});
