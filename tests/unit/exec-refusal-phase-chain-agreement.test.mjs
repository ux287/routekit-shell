/**
 * Witness for backlog.fix.exec-refusal-phase-reset-chain-desync.
 * A pre-mutation refused rks_exec must leave a (chain state, story phase) pair whose
 * documented next tool is admitted AND passes its phase gate; the refusal text must name
 * only admitted tools; the note must not be left dirty (or the change must be reported).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { recoverExecFailure } from "../../packages/mcp-rks/src/server/exec.mjs";
import {
  checkStateAllowed,
  transitionOnResult,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { PHASE_GATE_EXEC } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXEC_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../packages/mcp-rks/src/server/exec.mjs"),
  "utf8",
);

// Chain state a pre-mutation throw leaves (server.mjs throw-path resultKey).
const stateAfterThrow = (key) => transitionOnResult("story", "executing", key);

describe("refused exec: chain state and story phase agree", () => {
  it("refusal text names only tools admitted from the post-refusal chain state", () => {
    const m = EXEC_SRC.match(/rks\.exec: Story phase is[^`]*`/);
    expect(m).not.toBeNull();
    const tools = [...new Set(m[0].match(/rks_[a-z_]+/g) || [])];
    for (const key of ["exec.error", "exec.no_actions"]) {
      const state = stateAfterThrow(key);
      for (const t of tools) {
        expect(checkStateAllowed("story", state, t).allowed, `${t} from ${state}`).toBe(true);
      }
    }
  });

  it("ok:false path is not regressed: exec.failed -> test-failed admits rks_refine", () => {
    expect(transitionOnResult("story", "executing", "exec.failed")).toBe("test-failed");
    expect(checkStateAllowed("story", "test-failed", "rks_refine").allowed).toBe(true);
  });

  // Build adds, per the chosen design and the story's testRequirements:
  // - temp git project fixture: story at PHASE_GATE_EXEC, drive runExecTool to a pre-mutation
  //   refusal, assert the (chain state, on-disk phase) pair and that the documented next tool
  //   is admitted and passes its phase gate (traders-73 sequence must not recur);
  // - git status --porcelain shows no dirty story note, or the result reports the pending change;
  // - every spawnSync carries an explicit timeout option.
  it("a refused exec leaves the chain at refining, the partner of phase arch-approved", () => {
    for (const key of ["exec.error", "exec.no_actions"]) {
      expect(stateAfterThrow(key)).toBe("refining");
    }
    expect(checkStateAllowed("story", "refining", "rks_plan").allowed).toBe(true);
    expect(checkStateAllowed("story", "refining", "rks_plan_ready").allowed).toBe(true);
    expect(checkStateAllowed("story", "refining", "rks_exec_abort").allowed).toBe(true);
    expect(checkStateAllowed("story", "refining", "rks_exec").allowed).toBe(false);
  });

  it("PHASE_GATE_EXEC is executing", () => {
    expect(PHASE_GATE_EXEC).toBe("executing");
  });
});

describe("the throw path itself: phase reset is performed AND reported", () => {
  function tempStory(phase) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "exec-refusal-"));
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    const id = "backlog.fix.probe";
    fs.writeFileSync(
      path.join(root, "notes", `${id}.md`),
      `---\nid: "${id}"\ntitle: "probe"\nphase: "${phase}"\n---\n\n## body\n`,
    );
    return { root, id };
  }
  const phaseOf = (root, id) =>
    (fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8").match(/^phase:\s*"?([a-z-]+)"?/m) || [])[1];

  it("a pre-mutation throw (no branch/backup/guardrails) resets executing -> arch-approved and says so", async () => {
    const { root, id } = tempStory("executing");
    try {
      const reset = await recoverExecFailure({ projectRoot: root, storyId: id }, new Error("Cannot proceed with uncommitted changes"));
      expect(reset).toBe(true);
      expect(phaseOf(root, id)).toBe("arch-approved");
      // Together with the chain landing in refining (above), this is the agreeing pair.
      expect(stateAfterThrow("exec.error")).toBe("refining");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no reset is reported when the phase was not executing", async () => {
    const { root, id } = tempStory("arch-approved");
    try {
      expect(await recoverExecFailure({ projectRoot: root, storyId: id }, new Error("x"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runExecTool names the uncommitted phase reset and the next tool in the thrown error (AC3)", () => {
    const i = EXEC_SRC.indexOf("const phaseReset = await recoverExecFailure(ctx, err);");
    expect(i, "the throw path must capture recoverExecFailure's result").toBeGreaterThan(-1);
    const window = EXEC_SRC.slice(i, i + 900);
    expect(window).toMatch(/phase reset executing → arch-approved/);
    expect(window).toMatch(/next: rks_plan/);
  });
});
