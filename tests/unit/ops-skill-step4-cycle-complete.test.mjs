/**
 * backlog.fix.ops-skill-step4-cycle-complete-refused
 *
 * The Ops Governor prompt in .claude/skills/ops/SKILL.md must not instruct a call to
 * rks_cycle_complete, which the ops flow refuses (chain_violation) in every ops state.
 * Its Complete step returns the result instead, and its Rules forbid the call. The
 * server-side non-admission is unchanged and is re-asserted here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkStateAllowed, getStates } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const md = fs.readFileSync(path.join(REPO_ROOT, ".claude/skills/ops/SKILL.md"), "utf8");
const lines = md.split("\n");

// Text from a marker up to (not including) the next marker. Matched by indexOf, not by a
// line-anchored regex, because the prompt headings inside the skill are indented.
function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end);
}

const complete = between(md, "## Complete", "## Rules");
const rules = between(md, "## Rules", "# Task");

describe("ops SKILL.md Complete step does not call rks_cycle_complete", () => {
  it("finds the Complete and Rules sections (positive control)", () => {
    expect(complete.length).toBeGreaterThan(0);
    expect(complete).toContain("4.");
    expect(rules).toContain("NEVER call rks_plan, rks_exec, rks_refine");
    expect(rules).toContain("Error → STOP");
    expect(md).toContain("rks_promote(");
  });

  it("no line of the skill contains an rks_cycle_complete( call", () => {
    expect(lines.filter((l) => l.includes("rks_cycle_complete("))).toEqual([]);
  });

  it("the Complete step returns a complete-status result", () => {
    expect(complete).toContain("status: 'complete'");
    expect(complete).not.toContain("transition to done state");
  });

  it("the Complete step says rks_cycle_complete must not be called", () => {
    expect(complete).toMatch(/do not call rks_cycle_complete/i);
  });

  it("the Rules section has a NEVER line naming rks_cycle_complete", () => {
    const hit = rules.split("\n").filter((l) => l.includes("NEVER") && l.includes("rks_cycle_complete"));
    expect(hit.length).toBeGreaterThan(0);
  });

  it("every rks_promote( line keeps the sentinel projectId and the governor token", () => {
    const hit = lines.filter((l) => l.includes("rks_promote("));
    expect(hit.length).toBeGreaterThan(0);
    for (const l of hit) {
      expect(l).toContain("projectId: '__RKS_SOURCE_PROJECT__'");
      expect(l).toContain("_governorToken: TOKEN");
    }
  });

  it("every rks_sync_staging( line keeps the sentinel projectId and the governor token", () => {
    const hit = lines.filter((l) => l.includes("rks_sync_staging("));
    expect(hit.length).toBeGreaterThan(0);
    for (const l of hit) {
      expect(l).toContain("projectId: '__RKS_SOURCE_PROJECT__'");
      expect(l).toContain("_governorToken: TOKEN");
    }
  });
});

describe("ops flow still refuses rks_cycle_complete (governor-state.mjs unchanged)", () => {
  it("is refused in ops init and ops executing", () => {
    expect(checkStateAllowed("ops", "init", "rks_cycle_complete").allowed).toBe(false);
    expect(checkStateAllowed("ops", "executing", "rks_cycle_complete").allowed).toBe(false);
  });

  it("is refused in every ops state", () => {
    const states = Object.keys(getStates("ops"));
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(checkStateAllowed("ops", state, "rks_cycle_complete").allowed, `ops/${state}`).toBe(false);
    }
  });
});
