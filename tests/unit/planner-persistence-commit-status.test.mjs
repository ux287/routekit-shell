/**
 * backlog.fix.exec-note-scope-and-backup-durability — TR8.
 *
 * THE DEFECT: the phase-write commit sat inside an EMPTY catch. `spawnSync` does
 * not throw on a non-zero exit, so that catch could never fire — a failed commit
 * was indistinguishable from a successful one, and the caller reported success.
 *
 * Why it matters here: `ensureExecStartPhase` verifies the phase write reached
 * DISK, not GIT. The exec backup stash resets the worktree to HEAD, so a phase
 * write that never got committed is precisely what disappears. A silently failed
 * commit is therefore the difference between a story surviving exec and not.
 *
 * A happy-path-only test is VACUOUS for this defect: the pre-fix code passes it.
 *
 * No subprocess is spawned — the spawn is injected — so this file raises no
 * unit-tier purity concerns.
 */
import { describe, it, expect } from "vitest";
import { commitPhaseWrite } from "../../packages/mcp-rks/src/server/planner-persistence.mjs";

const ROOT = "/tmp/project";
const PROBLEM = "backlog.fix.demo";

/** Records calls and replays queued results. Never touches a real repo. */
function stubSpawn(results) {
  const calls = [];
  const queue = [...results];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return queue.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

describe("TR8 — commitPhaseWrite inspects spawnSync status", () => {
  it("reports committed:false when `git commit` exits non-zero", () => {
    // spawnSync RETURNS this; it does not throw. The old empty catch never fired.
    const spawn = stubSpawn([
      { status: 0, stdout: "", stderr: "" },
      { status: 1, stdout: "", stderr: "nothing to commit, working tree clean" },
    ]);

    const result = commitPhaseWrite(ROOT, PROBLEM, "executing", spawn);

    expect(result.committed).toBe(false);
    expect(result.commitError).toBeTruthy();
    expect(result.commitError.status).toBe(1);
    expect(result.commitError.command).toContain("git commit");
    expect(result.commitError.stderr).toContain("nothing to commit");
  });

  it("reports committed:false when `git add` exits non-zero, and does not attempt the commit", () => {
    const spawn = stubSpawn([{ status: 128, stdout: "", stderr: "fatal: pathspec did not match" }]);

    const result = commitPhaseWrite(ROOT, PROBLEM, "executing", spawn);

    expect(result.committed).toBe(false);
    expect(result.commitError.status).toBe(128);
    expect(result.commitError.command).toContain("git add");
    expect(result.commitError.stderr).toContain("fatal:");
    // A failed stage must short-circuit — committing after it would be wrong.
    expect(spawn.calls).toHaveLength(1);
  });

  it("reports committed:true when both commands succeed", () => {
    const spawn = stubSpawn([
      { status: 0, stdout: "", stderr: "" },
      { status: 0, stdout: "[staging abc1234] docs(backlog)", stderr: "" },
    ]);

    const result = commitPhaseWrite(ROOT, PROBLEM, "executing", spawn);

    expect(result.committed).toBe(true);
    expect(result.commitError).toBeNull();
    expect(spawn.calls).toHaveLength(2);
    expect(spawn.calls[0].args).toEqual(["add", `notes/${PROBLEM}.md`]);
    expect(spawn.calls[1].args[0]).toBe("commit");
    expect(spawn.calls[1].args[2]).toContain(`mark ${PROBLEM} as executing`);
  });

  it("treats a null status (spawn failure) as a failed commit, not a success", () => {
    // spawnSync returns status:null when the process is killed or fails to spawn.
    const spawn = stubSpawn([{ status: null, stdout: "", stderr: "" }]);

    const result = commitPhaseWrite(ROOT, PROBLEM, "executing", spawn);

    expect(result.committed).toBe(false);
  });
});

describe("TR8 — the caller surfaces the outcome", () => {
  it("persistAndFinalize routes the phase commit through commitPhaseWrite", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "packages/mcp-rks/src/server/planner-persistence.mjs"),
      "utf8",
    );
    // The outcome must reach phaseWrite, not be discarded.
    expect(src).toContain("commitPhaseWrite(projectRoot, normalizedProblem, res.to)");
    expect(src).toMatch(/phaseWrite\s*=\s*\{[^}]*committed/);
    // The old inline form — a bare `git add` + `git commit` pair whose results
    // were dropped into an empty catch — must no longer appear in the caller.
    // (Scoped to the phase-write path; unrelated empty catches elsewhere in this
    // module are out of scope for this story.)
    expect(src).not.toMatch(/spawnSync\("git",\s*\[\s*"add",\s*`notes\/\$\{normalizedProblem\}\.md`/);
  });
});
