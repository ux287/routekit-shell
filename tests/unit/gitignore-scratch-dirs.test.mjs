/**
 * Witness for backlog.fix.clean-machine-honesty (D3) — rks must not dirty its own tree.
 *
 * rks generates `.tmp-replan-<id>` scratch dirs itself. They were not gitignored, so the exec
 * DIRTY_TREE guard — rks's own precondition — tripped over rks's own garbage. Worse, the
 * guardrails-off auto-ship SWEPT THEM INTO COMMITS: commit eca9c0ea carries three of them, and an
 * earlier session had to untrack the same class of artifact.
 *
 * Driven through the REAL `git check-ignore` against the REAL .gitignore, not a source-text grep of
 * the file's contents — what matters is what git actually does with the path.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TIMEOUT = 20_000;

/** `git check-ignore` exits 0 when the path IS ignored, 1 when it is not. */
function isIgnored(relPath) {
  const r = spawnSync("git", ["check-ignore", "-q", relPath], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return r.status === 0;
}

describe("rks's own scratch dirs are gitignored", () => {
  it("ignores .tmp-replan-<id> (the dirs auto-ship committed by accident, twice)", () => {
    // NOTE the paths here are deliberately ones git does not already TRACK. `git check-ignore` reports
    // the ignore RULE, and a rule never applies to a file already in the index — so asserting on the
    // three dirs that commit eca9c0ea swept in would test their tracked-ness, not this .gitignore
    // entry. Those three are untracked separately; what must hold forever is the rule.
    expect(isIgnored(".tmp-replan-1700000000000-abcdef0123456/")).toBe(true);
    expect(isIgnored(".tmp-replan-anything/some/nested/file.json")).toBe(true);
    expect(isIgnored(".tmp-replan-x/.rks/telemetry/events.jsonl")).toBe(true);
  });

  it("still ignores the sibling .tmp-e2e-* (no regression)", () => {
    expect(isIgnored(".tmp-e2e-abc123/")).toBe(true);
  });

  it("still ignores the .rks runtime artifacts", () => {
    expect(isIgnored(".rks/exports/")).toBe(true);
    expect(isIgnored(".rks/test-runner-debug.json")).toBe(true);
  });

  // POSITIVE CONTROL. Without this, "everything is ignored" would also satisfy the assertions above —
  // a `*` in .gitignore would pass every test in this file and break the repo.
  it("NEGATIVE CONTROL: ordinary source paths are NOT ignored", () => {
    expect(isIgnored("packages/mcp-rks/src/server/exec.mjs")).toBe(false);
    expect(isIgnored("README.md")).toBe(false);
    expect(isIgnored("tests/unit/gitignore-scratch-dirs.test.mjs")).toBe(false);
  });

  it("NEGATIVE CONTROL: the .rks files rks NEEDS tracked are not ignored", () => {
    expect(isIgnored(".rks/project.json")).toBe(false);
    expect(isIgnored(".rks/prompts/governor-po.md")).toBe(false);
  });
});
