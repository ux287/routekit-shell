/**
 * backlog.feat.full-suite-regression-gate — source-order wiring proof that the full-suite
 * gate dominates every delivering exit of the three ship paths. These source-order checks are
 * the wiring proof; no behavioural proof of ordering is claimed beyond them.
 *
 * Full-source indexOf on durable literals, no fixed-size slice.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFullSuiteGate, fullSuiteGateApplies } from "../../packages/mcp-rks/src/exec/full-suite-gate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const STORY_SHIP = src("packages/mcp-rks/src/server/story-ship.mjs");
const AUDIT = src("packages/mcp-rks/src/server/guardrails-audit.mjs");
const GIT_SHIP = src("packages/mcp-rks/src/server/git/git-ship.mjs");

// Built from fragments so the literal is not itself read as a spawn call by the unit-tier
// purity guard (tests/unit/unit-tier-purity.test.mjs).
const SPAWN = "spawn" + "Sync";

describe("full-suite gate runs before every delivery", () => {
  it("story-ship: gate after the review catch and before the workingBranchIsLocal branch", () => {
    const tool = STORY_SHIP.indexOf("export async function runStoryShipTool");
    expect(tool).toBeGreaterThan(-1);
    const reviewCatch = STORY_SHIP.indexOf("} catch (reviewErr) {", tool);
    const branch = STORY_SHIP.indexOf("if (workingBranchIsLocal) {", tool);
    expect(reviewCatch).toBeGreaterThan(tool);
    expect(branch).toBeGreaterThan(reviewCatch);
    const gate = STORY_SHIP.indexOf("runFullSuiteGate(", tool);
    expect(gate).toBeGreaterThan(STORY_SHIP.indexOf("preflight_dirty_tree", tool));
    expect(gate).toBeGreaterThan(reviewCatch);
    expect(gate).toBeLessThan(branch);
    // dominance: both delivering arms sit after the branch point
    expect(gate).toBeLessThan(STORY_SHIP.indexOf("localMerge(projectRoot, currentBranch, working)", tool));
    expect(gate).toBeLessThan(STORY_SHIP.indexOf("deliverFeatureBranch({", tool));
  });

  it("story-ship: a blocked gate exits through buildShipFailure with failedStep full_suite_gate", () => {
    const tool = STORY_SHIP.indexOf("export async function runStoryShipTool");
    const gate = STORY_SHIP.indexOf("runFullSuiteGate(", tool);
    const branch = STORY_SHIP.indexOf("if (workingBranchIsLocal) {", tool);
    const region = STORY_SHIP.slice(gate, branch);
    const exit = region.indexOf("return buildShipFailure(");
    expect(exit).toBeGreaterThan(-1);
    const payload = region.slice(exit, exit + 400);
    expect(payload).toContain("worktreeBranch: currentBranch");
    expect(payload).toContain("baseBranch: working");
    expect(payload).toContain("failedStep: 'full_suite_gate'");
    expect(region).not.toMatch(/ok:\s*false/);
  });

  it("guardrails auto-ship: a gate dominates the direct push and both deliverFeatureBranch calls", () => {
    const block = AUDIT.indexOf("if (touchedTotal > 0 && !options.skipAutoShip) {");
    expect(block).toBeGreaterThan(-1);
    const staging = AUDIT.indexOf("if (stagingCheck.status === 0) {", block);
    const alpha = AUDIT.indexOf("const gateAlpha = await runOffRailEnforcementGate({", block);
    const beta = AUDIT.indexOf("const gateBeta = await runOffRailEnforcementGate({", block);
    expect(staging).toBeGreaterThan(block);
    expect(alpha).toBeGreaterThan(staging);
    expect(beta).toBeGreaterThan(alpha);
    const alphaNext = AUDIT.indexOf("if (isThreeBranch) {", alpha);
    const betaNext = AUDIT.indexOf("if (isThreeBranch) {", beta);
    expect(alphaNext).toBeGreaterThan(alpha);
    expect(betaNext).toBeGreaterThan(beta);
    const firstGate = AUDIT.indexOf("runFullSuiteGate(", block);
    expect(firstGate).toBeGreaterThan(block);
    const gateBetween = (start, end) => {
      const g = AUDIT.indexOf("runFullSuiteGate(", start);
      return g > start && g < end;
    };
    // (a) one gate before the empty-index split dominates every exit
    const optionA = firstGate < staging;
    // (b) one gate per path, each before that path's isThreeBranch split
    const optionB = gateBetween(alpha, alphaNext) && gateBetween(beta, betaNext);
    expect(optionA || optionB).toBe(true);
    // the direct push and both deliveries follow a gate on their own path
    const directPush = AUDIT.indexOf(`${SPAWN}("git", ["push", "origin", gitState.branch]`, block);
    expect(directPush).toBeGreaterThan(alphaNext);
    const deliveries = [];
    for (let i = AUDIT.indexOf("deliverFeatureBranch({", beta); i !== -1; i = AUDIT.indexOf("deliverFeatureBranch({", i + 1)) deliveries.push(i);
    expect(deliveries.length).toBe(2);
    for (const d of deliveries) expect(d).toBeGreaterThan(betaNext);
  });

  it("guardrails auto-ship: no gate in the skipAutoShip else-branch; a block records a full_suite_gate halt", () => {
    const block = AUDIT.indexOf("if (touchedTotal > 0 && !options.skipAutoShip) {");
    const suppressed = AUDIT.indexOf("if (options.skipAutoShip) response.autoShipSuppressed = true;", block);
    expect(suppressed).toBeGreaterThan(block);
    expect(AUDIT.indexOf("runFullSuiteGate(", suppressed)).toBe(-1);
    expect(AUDIT.indexOf("runFullSuiteGate(")).toBeGreaterThan(block);
    expect(AUDIT).toContain('response.haltedAt = "full_suite_gate";');
  });

  it("rks_ship: gate after the commit if/else closes and before if (alreadyOnFeatureBranch) {", () => {
    const fn = GIT_SHIP.indexOf("export async function runShip");
    expect(fn).toBeGreaterThan(-1);
    const committed = GIT_SHIP.indexOf('reason: "already_committed"', fn);
    expect(committed).toBeGreaterThan(fn);
    const close = GIT_SHIP.indexOf("\n    }\n", committed);
    const gate = GIT_SHIP.indexOf("runFullSuiteGate(", committed);
    const guard = GIT_SHIP.indexOf("if (alreadyOnFeatureBranch) {", committed);
    const pushSpawn = GIT_SHIP.indexOf(`${SPAWN}("git", ["push", "-u", "origin", currentBranch]`, committed);
    expect(close).toBeGreaterThan(committed);
    expect(gate).toBeGreaterThan(close);
    expect(gate).toBeLessThan(guard);
    expect(gate).toBeLessThan(pushSpawn);
    const region = GIT_SHIP.slice(gate, guard);
    expect(region).toContain('failedStep: "full_suite_gate"');
    expect(region).toMatch(/return \{ ok: false/);
  });
});

describe("an inert gate adds nothing to any ship path", () => {
  let root;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("every step push and result field for the gate is guarded by fullSuiteGateApplies", () => {
    for (const [name, text] of [["story-ship", STORY_SHIP], ["guardrails-audit", AUDIT], ["git-ship", GIT_SHIP]]) {
      const calls = [];
      for (let i = text.indexOf("runFullSuiteGate("); i !== -1; i = text.indexOf("runFullSuiteGate(", i + 1)) calls.push(i);
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls) {
        const guard = text.indexOf("if (fullSuiteGateApplies(", call);
        const step = text.indexOf("fullSuiteGateStep(", call);
        const lineEnd = text.indexOf("\n", call);
        // the very next statement after the call is the applies() guard, and the step
        // record is pushed only inside it
        expect(text.slice(lineEnd, guard).trim(), name).toBe("");
        expect(step, name).toBeGreaterThan(guard);
      }
    }
  });

  it("not_configured, disabled and project_json_unreadable results do not apply", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "full-suite-gate-wiring-"));
    const runTests = () => { throw new Error("must not run"); };
    expect(fullSuiteGateApplies(runFullSuiteGate(root, { runTests }))).toBe(false);
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ fullSuiteGate: { enabled: false } }));
    expect(fullSuiteGateApplies(runFullSuiteGate(root, { runTests }))).toBe(false);
    const origError = console.error;
    console.error = () => {};
    try {
      fs.writeFileSync(path.join(root, ".rks", "project.json"), "{ nope");
      expect(fullSuiteGateApplies(runFullSuiteGate(root, { runTests }))).toBe(false);
    } finally {
      console.error = origError;
    }
  });
});
