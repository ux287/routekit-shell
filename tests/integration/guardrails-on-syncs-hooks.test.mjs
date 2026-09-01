/**
 * backlog.fix.guardrails-on-syncs-hooks — REAL end-to-end deploy proof.
 *
 * Defect register item A4: a hook change could not reach runtime by any agent
 * path. Guardrails ON, `npm run sync-hooks` is denied by the bash allowlist;
 * guardrails OFF, scripts/sync-hooks.mjs self-skips while .routekit/hooks.bak
 * exists. So `.routekit/hooks/**` only ever updated via `npm install` or a human
 * outside the agent loop — a story could ship green with its hook fix stranded.
 *
 * scripts/sync-hooks.mjs is DELIBERATELY NOT MOCKED in this file. The whole point
 * is that the deployed artifact carries the change. Asserting "the sync was
 * called" is insufficient: calling it at the wrong moment is a silent no-op, and
 * that silent no-op IS the defect. Ordering/fault-injection assertions that do
 * need a mock live in tests/unit/guardrails-on-hook-sync-ordering.test.mjs.
 *
 * Run:
 *   npx vitest run --config vitest.config.mock.mjs tests/integration/guardrails-on-syncs-hooks.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true, url: "https://example.test/pr/1", number: 1 }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true }),
  runCycleComplete: vi.fn().mockResolvedValue({ ok: true, branch: "staging" }),
}));

// Performs a REAL commit so the auto-ship-capture assertion can inspect actual
// git history, while still bypassing the RAG embed that the real helper runs.
vi.mock("../../packages/mcp-rks/src/shared/commit-and-embed.mjs", async () => {
  const { spawnSync: sp } = await import("node:child_process");
  return {
    commitAndEmbed: vi.fn(async (projectRoot, message) => {
      sp("git", ["commit", "-m", message], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
      const head = sp("git", ["rev-parse", "HEAD"], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
      return { commitId: (head.stdout || "").trim(), ragEmbedWarning: null };
    }),
  };
});

const { guardrailsOff, guardrailsOn, guardrailsAbort } = await import(
  "../../packages/mcp-rks/src/server/guardrails-audit.mjs"
);

const PROBLEM_ID = "test-hook-deploy-story";
const DEPLOYED_HOOK = path.join(".routekit", "hooks", "write", "probe-hook.mjs");
const CANONICAL_HOOK = path.join("packages", "hooks", "write", "probe-hook.mjs");

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

function makeTempProject({ withCanonicalHooks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-hook-deploy-"));

  // Deployed tree — tier subdirs match guardrailsOff's move targets.
  const hooksDir = path.join(dir, ".routekit", "hooks");
  fs.mkdirSync(path.join(hooksDir, "write"), { recursive: true });
  fs.mkdirSync(path.join(hooksDir, "read"), { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "write", "probe-hook.mjs"), "// v1\n");
  fs.writeFileSync(path.join(hooksDir, "read", "probe-read-hook.mjs"), "// read v1\n");

  fs.writeFileSync(
    path.join(dir, ".routekit", "hooks-manifest.json"),
    JSON.stringify(
      { "probe-hook": { tier: "write" }, "probe-read-hook": { tier: "read" } },
      null,
      2,
    ),
  );

  if (withCanonicalHooks) {
    // Canonical source — must match the deployed tree at t0 so the only drift
    // observed later is the one this test deliberately introduces.
    fs.mkdirSync(path.join(dir, "packages", "hooks", "write"), { recursive: true });
    fs.mkdirSync(path.join(dir, "packages", "hooks", "read"), { recursive: true });
    fs.writeFileSync(path.join(dir, CANONICAL_HOOK), "// v1\n");
    fs.writeFileSync(
      path.join(dir, "packages", "hooks", "read", "probe-read-hook.mjs"),
      "// read v1\n",
    );
  }

  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  // Off-rail enforcement gate loads .rks/review-policy.yaml with this root;
  // disable review so the bare guardrailsOn calls never reach a live reviewer.
  fs.writeFileSync(
    path.join(dir, ".rks", "review-policy.yaml"),
    "# Fixture: keep the off-rail enforcement gate from calling a live reviewer.\nenabled: false\n",
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");

  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(
    path.join(notesDir, `${PROBLEM_ID}.md`),
    [
      "---",
      `id: "${PROBLEM_ID}"`,
      'title: "hook deploy fixture"',
      'phase: "arch-approved"',
      "targetFiles:",
      '  - "packages/hooks/write/probe-hook.mjs"',
      '  - "packages/hooks/write/brand-new-hook.mjs"',
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

/** Byte-level snapshot of the whole deployed hook tree: relPath -> content. */
function snapshotDeployedTree(dir) {
  const root = path.join(dir, ".routekit", "hooks");
  const out = {};
  const walk = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else out[childRel] = fs.readFileSync(childAbs, "utf8");
    }
  };
  walk(root, "");
  return out;
}

describe("guardrailsOn deploys hook changes end-to-end", () => {
  let dir;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it(
    "DECISIVE: a session that edits packages/hooks/** leaves .routekit/hooks/** carrying the change",
    async () => {
      const sentinel = "SENTINEL_DEPLOY_PROOF_a4";

      await guardrailsOff(dir, "e2e deploy proof", "all", PROBLEM_ID);

      // Edit the canonical source, exactly as an off-rail hook fix would.
      fs.writeFileSync(path.join(dir, CANONICAL_HOOK), `// v2 ${sentinel}\n`);

      // Pre-condition: the deployed artifact does NOT yet carry the change.
      // (It is currently parked in hooks.bak while guardrails are off.)
      const deployedPath = path.join(dir, DEPLOYED_HOOK);

      const result = await guardrailsOn(dir, { skipAutoShip: true });
      expect(result.ok).toBe(true);

      // THE PROOF — byte-level read of the DEPLOYED ARTIFACT, not a spy.
      expect(fs.existsSync(deployedPath)).toBe(true);
      const deployed = fs.readFileSync(deployedPath, "utf8");
      expect(deployed).toContain(sentinel);
      expect(deployed).toBe(fs.readFileSync(path.join(dir, CANONICAL_HOOK), "utf8"));

      expect(result.hookDeploy.synced).toBe(true);
      expect(result.hookDeploy.error).toBeNull();
    },
    60_000,
  );

  it(
    "gate POSITIVE via changes.newFiles: a brand-new untracked hook is deployed too",
    async () => {
      await guardrailsOff(dir, "new-file gate", "all", PROBLEM_ID);

      // Untracked addition — surfaced by `git ls-files --others`, not `git diff`.
      const newCanonical = path.join(dir, "packages", "hooks", "write", "brand-new-hook.mjs");
      fs.writeFileSync(newCanonical, "// brand new NEWFILE_SENTINEL\n");

      const result = await guardrailsOn(dir, { skipAutoShip: true });
      expect(result.ok).toBe(true);
      expect(result.hookDeploy.synced).toBe(true);

      const deployedNew = path.join(dir, ".routekit", "hooks", "write", "brand-new-hook.mjs");
      expect(fs.existsSync(deployedNew)).toBe(true);
      expect(fs.readFileSync(deployedNew, "utf8")).toContain("NEWFILE_SENTINEL");
    },
    60_000,
  );

  it(
    "gate NEGATIVE: a session touching only non-hook paths leaves the deployed tree byte-identical",
    async () => {
      const before = snapshotDeployedTree(dir);
      expect(Object.keys(before).length).toBeGreaterThan(0);

      await guardrailsOff(dir, "non-hook session", "all", PROBLEM_ID);
      fs.writeFileSync(path.join(dir, "README.md"), "# touched, but not a hook\n");

      const result = await guardrailsOn(dir, { skipAutoShip: true });
      expect(result.ok).toBe(true);

      // No deploy: an unrelated story must not push someone else's pending drift.
      expect(result.hookDeploy.synced).toBe(false);
      expect(result.hookDeploy.skipped).toBe("session_did_not_touch_canonical_hooks");

      // ...but the read-only check still ran.
      expect(result.hookDeploy.checked).toBe(true);
      expect(result.hookDeploy.drift).not.toBeNull();

      expect(snapshotDeployedTree(dir)).toEqual(before);
    },
    60_000,
  );

  it(
    "ABORT never deploys, even when the session modified packages/hooks/**",
    async () => {
      const before = snapshotDeployedTree(dir);

      await guardrailsOff(dir, "abort must not deploy", "all", PROBLEM_ID);
      fs.writeFileSync(path.join(dir, CANONICAL_HOOK), "// v2 SHOULD_NEVER_DEPLOY\n");

      const result = await guardrailsAbort(dir);
      expect(result.ok).toBe(true);

      // Syncing on abort would deploy pre-session drift as a side effect of a discard.
      const after = snapshotDeployedTree(dir);
      expect(after).toEqual(before);
      for (const content of Object.values(after)) {
        expect(content).not.toContain("SHOULD_NEVER_DEPLOY");
      }
    },
    60_000,
  );

  it(
    "no-op project: no packages/hooks source completes cleanly with a benign skip",
    async () => {
      cleanup(dir);
      dir = makeTempProject({ withCanonicalHooks: false });

      const before = snapshotDeployedTree(dir);

      await guardrailsOff(dir, "attached child project shape", "all", PROBLEM_ID);
      fs.writeFileSync(path.join(dir, "README.md"), "# touched\n");

      const result = await guardrailsOn(dir, { skipAutoShip: true });

      expect(result.ok).toBe(true);
      expect(result.hookDeploy.skipped).toBe("no_canonical_hooks_source");
      expect(result.hookDeploy.error).toBeNull();
      expect(result.hookDeploy.synced).toBe(false);

      // Nothing fabricated, nothing written, nothing thrown.
      expect(snapshotDeployedTree(dir)).toEqual(before);
    },
    60_000,
  );

  it(
    "the drift check is reported on every path, including when the ship is suppressed",
    async () => {
      await guardrailsOff(dir, "drift always reported", "all", PROBLEM_ID);
      const result = await guardrailsOn(dir, { skipAutoShip: true });

      expect(result.ok).toBe(true);
      expect(result.autoShipped).toBe(false);
      expect(result.hookDeploy).toBeDefined();
      expect(result.hookDeploy.checked).toBe(true);
      expect(result.hookDeploy.drift).toMatchObject({
        ok: expect.any(Boolean),
        issues: expect.any(Array),
      });
      expect(typeof result.hookDeploy.drift.canonicalCount).toBe("number");
    },
    60_000,
  );

  it(
    "a real deploy is captured by the SAME auto-ship commit",
    async () => {
      await guardrailsOff(dir, "deploy captured by ship", "all", PROBLEM_ID);
      fs.writeFileSync(path.join(dir, CANONICAL_HOOK), "// v2 SHIPPED_SENTINEL\n");

      const result = await guardrailsOn(dir);
      expect(result.ok).toBe(true);
      expect(result.hookDeploy.synced).toBe(true);

      const commitStep = (result.shipSteps || []).find((s) => s.step === "commit");
      expect(commitStep).toBeDefined();
      expect(commitStep.commitId).toBeTruthy();

      // Assert against git itself, not just the worktree.
      const show = git(["show", "--name-only", "--pretty=format:", commitStep.commitId], dir);
      const files = String(show.stdout || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      expect(files).toContain(DEPLOYED_HOOK.split(path.sep).join("/"));

      // And the deploy is not left dirty in the worktree.
      const status = git(["status", "--porcelain", "--", ".routekit/hooks"], dir);
      expect(String(status.stdout || "").trim()).toBe("");
    },
    60_000,
  );

  it(
    "never represents the hook sync as a shipSteps entry",
    async () => {
      await guardrailsOff(dir, "shipSteps purity", "all", PROBLEM_ID);
      fs.writeFileSync(path.join(dir, CANONICAL_HOOK), "// v2\n");

      const result = await guardrailsOn(dir);

      // guardrails-on-three-branch.spec.mjs asserts the local-only skipped
      // shipSteps entries carry reason 'three_branch_local_only'; a skipped
      // hook-sync step there would redden that live assertion.
      //
      // Matched on the step NAME, not on a stringified step: the off-rail
      // enforcement gate's scope_reconcile entry legitimately lists changed
      // .routekit/hooks/ paths among its violations, which a JSON-wide regex
      // would flag as a hook-sync step.
      const steps = result.shipSteps || [];
      expect(steps.filter((s) => /hook|drift/i.test(String(s.step)))).toHaveLength(0);
      expect(result.hookDeploy).toBeDefined();
    },
    60_000,
  );
});
