/**
 * backlog.fix.story-ship-false-success — behavioural coverage.
 *
 * Covers the parts of the honest-outcome fix that can be driven against real
 * modules and a real git fixture: the residual-dirty computation behind the
 * clean-tree claim, and runCycleComplete's actual return shape.
 *
 * COVERAGE LIMIT, stated rather than implied: driving runStoryShipTool
 * end-to-end to read story_ship.success / story_ship.failed off the collector
 * is NOT done here. That entry point needs a registered project, a merged
 * feature branch and a live telemetry collector. The reduction that decides
 * both channels is proven by direct call in tests/unit/ship-ok-reduction.test.mjs,
 * and the wiring from that reduction to each channel is pinned there too — but
 * the emitted events themselves are not observed. See the story's follow-ups.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { getUncommittedFiles } from "../../packages/mcp-rks/src/utils/git.mjs";
import { runCycleComplete } from "../../packages/mcp-rks/src/server/git/git-ship.mjs";

const GIT_TIMEOUT = 15000;

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT });
}

function initRepo(dir) {
  // backlog.fix.test-fixture-repo-containment: status-checked. `git()` returns the spawnSync
  // result and every caller here discarded it, so a failed init left the rest of this function —
  // and every test using the fixture — operating on whatever repository encloses `dir`. That is
  // the mechanism by which this suite hard-reset the developer's own repo.
  const init = git(dir, ["init", "-b", "staging"]);
  if (init.status !== 0) {
    throw new Error(
      `fixture git init failed in ${dir} (status ${init.status}): ` +
        `${init.stderr || init.stdout || "no output"}`,
    );
  }
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// original\n");
  fs.writeFileSync(path.join(dir, "notes", "backlog.fix.demo.md"), "---\nphase: executed\n---\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fixture(prefix) {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  initRepo(dir);
  return dir;
}

/**
 * The residual-dirty computation ship uses for its clean-tree claim. Imported
 * helper, same options — not a re-implementation of the filter policy.
 */
function residualDirty(projectRoot) {
  return getUncommittedFiles(projectRoot, { filterRks: true }).filter(f => !f.startsWith("notes/"));
}

describe("the clean-tree claim reflects the real tree", () => {
  it("reports clean when the tree is clean", () => {
    const root = fixture("honest-clean");
    expect(residualDirty(root)).toEqual([]);
  });

  it("reports DIRTY when a tracked file is modified", () => {
    // The old message asserted a clean tree unconditionally, so this case
    // produced a confident false statement.
    const root = fixture("honest-dirty");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// modified\n");

    const dirty = residualDirty(root);
    expect(dirty).toContain("src/app.mjs");
    expect(dirty.length).toBeGreaterThan(0);
  });

  it("does not count notes/ churn as dirty — matching ship's own preflight policy", () => {
    // notes/ is governor-managed and excluded from ship's dirty check, so the
    // clean-tree claim must use the same policy or it would contradict the
    // preflight that let the ship start.
    const root = fixture("honest-notes");
    fs.writeFileSync(path.join(root, "notes", "backlog.fix.demo.md"), "---\nphase: integrated\n---\nchanged\n");

    expect(residualDirty(root)).toEqual([]);
  });

  it("an untracked source file counts as dirty", () => {
    const root = fixture("honest-untracked");
    fs.writeFileSync(path.join(root, "src", "new.mjs"), "// new\n");

    expect(residualDirty(root)).toContain("src/new.mjs");
  });
});

describe("runCycleComplete's real return shape", () => {
  it("reports no cleanliness of its own, and proves it ran non-trivially", async () => {
    // The earlier form of this test asserted only `result.clean === undefined`,
    // which is STRUCTURALLY vacuous: runCycleComplete has two exits and NEITHER
    // returns a `clean` field, so no execution could ever fail it. `result.ok`
    // and `result.branch` are near-trivial too — branch is set from config
    // regardless of whether work occurred.
    //
    // deletedBranch is the real witness: it initialises to null and is assigned
    // only when a branch is actually removed. Asserting on it proves the run
    // reached the cleanup path rather than short-circuiting.
    const root = fixture("cycle-shape");
    const stale = "rks/stale-feature";
    git(root, ["branch", stale]);
    expect((git(root, ["branch", "--list", stale]).stdout || "").trim()).toContain(stale);

    const result = await runCycleComplete({ projectRoot: root, projectId: "routekit-shell-core" });

    expect(result).toBeTruthy();
    expect(result.ok).toBe(true);
    // Non-trivial execution: the run surfaced branch state it had to look up.
    expect(result).toHaveProperty("previousBranch");
    // The claim under test — ship cannot delegate cleanliness to this result.
    expect(result.clean).toBeUndefined();
    expect(Object.keys(result)).not.toContain("clean");
  });
});

describe("the cycle-complete agent no longer self-reports cleanliness", () => {
  it("gitClean is gone from the agent's output contract", async () => {
    // It was an optional field the model filled in from its own narration, with
    // nothing binding it to the check_git_state tool result — so it could report
    // a clean tree on a dirty one. The honest tool remains.
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "packages/mcp-rks/src/agents/cycle-complete.mjs"),
      "utf8",
    );
    expect(src).not.toMatch(/gitClean:\s*z\.boolean/);
    expect(src).not.toContain('"gitClean": true/false');
    // The real check survives and still computes from git.
    expect(src).toContain("git', ['status', '--porcelain']");
    expect(src).toContain("const clean = lines.length === 0");
  });
});
