/**
 * backlog.fix.exec-note-scope-and-backup-durability — TR9.
 *
 * THE DEFECT: a failed `exec_end` phase advance was only console.error'd, while
 * exec went on to return ok:true. So an exec whose story phase had been reverted
 * underneath it — by the very stash this story fixes — reported a completely
 * clean run, and the caller shipped a story the backlog still recorded as
 * unbuilt.
 *
 * Assertions here are on the RETURNED VALUE, never on console.error output.
 * Asserting on stderr would pass against the defective implementation, which
 * also wrote to stderr — that is the whole point.
 *
 * `advanceExecEndPhase` takes an injected advance function, so no subprocess is
 * spawned and this file raises no unit-tier purity concerns.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { advanceExecEndPhase } from "../../packages/mcp-rks/src/server/exec.mjs";

const ROOT = "/tmp/project";
const PROBLEM = "backlog.fix.demo";

describe("TR9 — an exec_end failure is surfaced, not swallowed", () => {
  it("returns a phaseError when advancePhase reports ok:false", async () => {
    const advance = async () => ({ ok: false, error: 'Invalid transition: arch-approved → executed' });

    const result = await advanceExecEndPhase(ROOT, PROBLEM, advance);

    expect(result).not.toBeNull();
    expect(result.op).toBe("exec_end");
    expect(result.problemId).toBe(PROBLEM);
    expect(result.error).toContain("Invalid transition");
  });

  it("returns a phaseError when advancePhase throws", async () => {
    const advance = async () => { throw new Error("note not found on disk"); };

    const result = await advanceExecEndPhase(ROOT, PROBLEM, advance);

    expect(result).not.toBeNull();
    expect(result.op).toBe("exec_end");
    expect(result.error).toContain("note not found");
  });

  it("still reports a failure when advancePhase returns ok:false with no error text", async () => {
    // A bare {ok:false} must not degrade into a null/undefined error the caller
    // then renders as "undefined" — the same class of defect as the rollback
    // logger printing 'Rollback failed: undefined'.
    const advance = async () => ({ ok: false });

    const result = await advanceExecEndPhase(ROOT, PROBLEM, advance);

    expect(result).not.toBeNull();
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).not.toContain("undefined");
  });

  it("returns null on success", async () => {
    const advance = async () => ({ ok: true, from: "executing", to: "executed" });

    const result = await advanceExecEndPhase(ROOT, PROBLEM, advance);

    expect(result).toBeNull();
  });

  it("returns null when there is no story to advance", async () => {
    let called = false;
    const advance = async () => { called = true; return { ok: true }; };

    const result = await advanceExecEndPhase(ROOT, null, advance);

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

describe("TR9 — exec's result carries the failure", () => {
  it("runExecTool spreads phaseError into the returned object", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "packages/mcp-rks/src/server/exec.mjs"),
      "utf8",
    );
    // The extracted helper's outcome must be assigned and then surfaced on the
    // result — an exec that computes phaseError and drops it is the same defect.
    expect(src).toContain("await advanceExecEndPhase(projectRoot, problemId)");
    expect(src).toMatch(/\.\.\.\(phaseError\s*\?\s*\{\s*phaseError/);
    // The old swallow: a bare console.error on the failure branch with no
    // corresponding return value.
    expect(src).not.toMatch(/console\.error\(`\[rks\.exec\] Failed to update phase: \$\{result\.error\}`\)/);
  });
});
