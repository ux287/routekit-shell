/**
 * Witness for backlog.fix.cycle-complete-ungated-hard-reset — the opt-in reaches every caller.
 *
 * THE DEFECT: `runCycleComplete` performed `git reset --hard origin/<working>` unconditionally.
 * It computed how many unpushed commits it was about to destroy, formatted
 * `Warning: N local commit(s) ... will be lost`, returned that string as an informational field on
 * an `ok: true` payload — and reset anyway. On 2026-08-21 it destroyed ~30 unpushed commits in
 * this repository.
 *
 * The gate itself is exercised against a real repository in
 * tests/integration/cycle-complete-destructive-gate.test.mjs. THIS file pins the part a
 * behavioural test cannot see: that the opt-in is actually threaded through all four production
 * callers, and that none of them hardcodes it to `true`.
 *
 * That matters because the gate is only as good as its weakest caller. `rks_guardrails_on`'s
 * auto-ship is the one CLAUDE.md tells every off-rail build to finish with, so a fix that gates
 * `rks_ship` but leaves the auto-ship opted-in would leave the primary hazard wide open while
 * looking fixed.
 *
 * Source-level assertions are deliberate here: the four call sites are the invariant, and a
 * runtime test that mocked them would prove nothing about the real wiring.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const read = (rel) => fs.readFileSync(path.resolve(REPO, rel), "utf8");

const GIT_SHIP = read("packages/mcp-rks/src/server/git/git-ship.mjs");
const SERVER = read("packages/mcp-rks/src/server.mjs");
const STORY_SHIP = read("packages/mcp-rks/src/server/story-ship.mjs");
const GUARDRAILS = read("packages/mcp-rks/src/server/guardrails-audit.mjs");

describe("runCycleComplete's signature carries the opt-in, defaulting to refuse", () => {
  it("declares discardLocalCommits with a false default", () => {
    // Default-false is the whole posture. A default of `true`, or an undefined-is-truthy check,
    // would reinstate destructive-by-default while appearing to have a gate.
    expect(GIT_SHIP).toContain(
      "export async function runCycleComplete({ projectRoot, projectId, discardLocalCommits = false }) {",
    );
  });

  it("the gate sits BEFORE the reset, not after it", () => {
    const gateIdx = GIT_SHIP.indexOf("if (localCommitsDiscarded > 0 && discardLocalCommits !== true) {");
    const resetIdx = GIT_SHIP.indexOf("runGit(projectRoot, ['reset', '--hard', `origin/${working}`]);");
    expect(gateIdx, "gate not found").toBeGreaterThan(-1);
    expect(resetIdx, "reset not found").toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(resetIdx);
  });

  it("the divergence computation still precedes the gate — it is the gate's input", () => {
    // The story forbids relocating this block; the gate consumes what it already computed.
    const divergenceIdx = GIT_SHIP.indexOf("divergenceWarning = `Warning: ${ahead} local commit(s)");
    const gateIdx = GIT_SHIP.indexOf("if (localCommitsDiscarded > 0 && discardLocalCommits !== true) {");
    expect(divergenceIdx).toBeGreaterThan(-1);
    expect(divergenceIdx).toBeLessThan(gateIdx);
  });

  it("there is still exactly ONE hard-reset-to-origin in the file", () => {
    // A second, ungated reset path would defeat the gate entirely. This is the bypass check.
    const resets = GIT_SHIP.split("['reset', '--hard', `origin/${working}`]").length - 1;
    expect(resets).toBe(1);
  });
});

describe("all four production callers thread the opt-in", () => {
  it("caller 1 — rks_cycle_complete handler (server.mjs)", () => {
    expect(SERVER).toContain("discardLocalCommits: input.discardLocalCommits === true");
  });

  it("caller 2 — runShip (git-ship.mjs)", () => {
    expect(GIT_SHIP).toContain(
      "const cycleResult = await runCycleComplete({ projectRoot, projectId, discardLocalCommits });",
    );
  });

  it("caller 3 — runStoryShipTool (story-ship.mjs)", () => {
    expect(STORY_SHIP).toContain(
      "const cycleResult = await runCycleComplete({ projectRoot, projectId, discardLocalCommits });",
    );
    expect(STORY_SHIP).toContain(
      "export async function runStoryShipTool({ projectId, problemId, discardLocalCommits = false }) {",
    );
  });

  it("caller 4 — the rks_guardrails_on auto-ship (guardrails-audit.mjs)", () => {
    expect(GUARDRAILS).toContain(
      "const cycleResult = await runCycleComplete({ projectRoot, discardLocalCommits: false });",
    );
  });

  it("NO caller hardcodes the opt-in to true", () => {
    // The single assertion this whole file exists for. A caller passing `discardLocalCommits: true`
    // has opted itself in on the user's behalf, which is the defect wearing a gate.
    //
    // Scoped to CALL SITES, not raw file text: the literal legitimately appears in the refusal
    // `hint` ("re-run with discardLocalCommits: true") and in JSDoc, and a whole-file substring
    // check reds on that prose. Matching the actual argument object is the real invariant.
    for (const [name, src] of [
      ["git-ship.mjs", GIT_SHIP],
      ["server.mjs", SERVER],
      ["story-ship.mjs", STORY_SHIP],
      ["guardrails-audit.mjs", GUARDRAILS],
    ]) {
      const callArgs = [...src.matchAll(/await runCycleComplete\(\{([\s\S]{0,900}?)\}\)/g)]
        .map((m) => m[1]);
      expect(callArgs.length, `${name}: no call site found`).toBeGreaterThan(0);
      for (const args of callArgs) {
        expect(args, `${name} call site must not hardcode the opt-in`)
          .not.toMatch(/discardLocalCommits\s*:\s*true/);
      }
    }
  });

  it("no runCycleComplete call site is left unthreaded", () => {
    // Positive control on the completeness of the list above: every invocation in production
    // source must mention the opt-in. Catches a fifth caller added later.
    for (const [name, src] of [
      ["git-ship.mjs", GIT_SHIP],
      ["server.mjs", SERVER],
      ["story-ship.mjs", STORY_SHIP],
      ["guardrails-audit.mjs", GUARDRAILS],
    ]) {
      const calls = src.split("await runCycleComplete(").length - 1;
      expect(calls, `${name}: expected at least one call site`).toBeGreaterThan(0);
      const threaded = src.split(/await runCycleComplete\(\{[^}]*discardLocalCommits/g).length - 1;
      expect(threaded, `${name}: ${calls} call site(s), ${threaded} threaded`).toBe(calls);
    }
  });
});

describe("the MCP schema exposes the opt-in on BOTH sides", () => {
  // tests/integration/mcp-schema-drift-guard.spec.mjs diffs the zod schema against the advertised
  // inputSchema bidirectionally. Changing one side only is a hard red there; these two assertions
  // fail faster and say why.
  it("zod side — optional, described", () => {
    expect(SERVER).toContain(
      'discardLocalCommits: z.boolean().optional().describe("Required to discard unpushed local commits on the working branch")',
    );
  });

  it("advertised side — same field, same optionality", () => {
    expect(SERVER).toContain(
      'discardLocalCommits: { type: "boolean", description: "Required to discard unpushed local commits on the working branch" },',
    );
  });

  it("it is NOT in required[] — absent must mean refuse, not error", () => {
    // If it were required, every caller would have to state a destructive intent it does not have,
    // and the safe default would be unreachable.
    const idx = SERVER.indexOf('name: "rks_cycle_complete"');
    expect(idx).toBeGreaterThan(-1);
    const block = SERVER.slice(idx, idx + 900);
    expect(block).toContain('required: ["projectId"],');
    expect(block).not.toContain('required: ["projectId", "discardLocalCommits"]');
  });
});
