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

// backlog.feat.landing-gate-combined-tree-test — source-text helpers for the landing wiring.
/** The trimmed source line that opens the innermost block enclosing `idx` (e.g. "if (cond) {"). */
function enclosingBlockHead(text, idx) {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return text.slice(text.lastIndexOf("\n", i) + 1, i + 1).trim();
      depth--;
    }
  }
  return null;
}
/** The block opened by the first "{" at or after `openIdx`, from that brace to its match. */
function blockFrom(text, openIdx) {
  const start = text.indexOf("{", openIdx);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
/**
 * The refusal exit after a landing call: the call's result is bound with const, tested with
 * `if (!<name>.ok) {`, and the first return inside that block starts with `exit`. `to` bounds the
 * search so the exit is proven to precede the next delivery call.
 */
function refusalReturn(text, callIdx, to) {
  const region = text.slice(text.lastIndexOf("\n", callIdx) + 1, to);
  const m = region.match(/const (\w+) = (?:prepareLandingCandidate|verifyTargetUnmoved)\(/);
  expect(m).not.toBeNull();
  const guard = region.indexOf(`if (!${m[1]}.ok) {`);
  expect(guard).toBeGreaterThan(-1);
  const block = blockFrom(region, guard);
  expect(block).not.toBeNull();
  const ret = block.search(/\breturn\b/);
  expect(ret).toBeGreaterThan(-1);
  return { block, ret: block.slice(ret) };
}

describe("landing candidate is prepared before the gate and verified before delivery", () => {
  it("story-ship — guarded prepare, gate, verify, then both delivering arms", () => {
    const tool = STORY_SHIP.indexOf("export async function runStoryShipTool");
    const coverage = STORY_SHIP.indexOf("evaluateCoverageRecordGate(", tool);
    const prep = STORY_SHIP.indexOf("prepareLandingCandidate(", tool);
    const gate = STORY_SHIP.indexOf("runFullSuiteGate(", tool);
    expect(coverage).toBeGreaterThan(tool);
    expect(prep).toBeGreaterThan(coverage);
    expect(prep).toBeLessThan(gate);
    const head = enclosingBlockHead(STORY_SHIP, prep);
    expect(head.startsWith("if (")).toBe(true);
    expect(head).toContain("landingGateEnabled(");
    expect(head).toContain("deliveredEvidence");
    const verify = STORY_SHIP.indexOf("verifyTargetUnmoved(", gate);
    const delivered = STORY_SHIP.indexOf("if (deliveredEvidence) {", gate);
    const branch = STORY_SHIP.indexOf("if (workingBranchIsLocal) {", gate);
    const localArm = STORY_SHIP.indexOf("localMerge(projectRoot, currentBranch, working)", gate);
    const deliver = STORY_SHIP.indexOf("deliverFeatureBranch({", gate);
    expect(verify).toBeGreaterThan(gate);
    expect(verify).toBeLessThan(delivered);
    expect(delivered).toBeLessThan(branch);
    expect(branch).toBeLessThan(localArm);
    expect(localArm).toBeLessThan(deliver);
    // exactly one prepare and one verify in the tool
    expect(STORY_SHIP.indexOf("prepareLandingCandidate(", prep + 1)).toBe(-1);
    expect(STORY_SHIP.indexOf("verifyTargetUnmoved(", verify + 1)).toBe(-1);
  });

  it("guardrails gate beta — guarded prepare, gate, verify, then both deliverFeatureBranch calls; gate alpha unchanged", () => {
    const block = AUDIT.indexOf("if (touchedTotal > 0 && !options.skipAutoShip) {");
    const alpha = AUDIT.indexOf("const gateAlpha = await runOffRailEnforcementGate({", block);
    const beta = AUDIT.indexOf("const gateBeta = await runOffRailEnforcementGate({", block);
    expect(alpha).toBeGreaterThan(block);
    expect(beta).toBeGreaterThan(alpha);
    const prep = AUDIT.indexOf("prepareLandingCandidate(", beta);
    const betaGate = AUDIT.indexOf("runFullSuiteGate(", beta);
    expect(prep).toBeGreaterThan(beta);
    expect(prep).toBeLessThan(betaGate);
    const head = enclosingBlockHead(AUDIT, prep);
    expect(head.startsWith("if (")).toBe(true);
    expect(head).toContain("landingGateEnabled(");
    const verify = AUDIT.indexOf("verifyTargetUnmoved(", betaGate);
    const betaNext = AUDIT.indexOf("if (isThreeBranch) {", beta);
    expect(verify).toBeGreaterThan(betaGate);
    expect(verify).toBeLessThan(betaNext);
    const deliveries = [];
    for (let i = AUDIT.indexOf("deliverFeatureBranch({", beta); i !== -1; i = AUDIT.indexOf("deliverFeatureBranch({", i + 1)) deliveries.push(i);
    expect(deliveries.length).toBe(2);
    for (const d of deliveries) expect(d).toBeGreaterThan(verify);
    // gate alpha: no landing preparation or verification anywhere before gate beta
    const alphaRegion = AUDIT.slice(block, beta);
    expect(alphaRegion).not.toContain("prepareLandingCandidate(");
    expect(alphaRegion).not.toContain("verifyTargetUnmoved(");
    expect(AUDIT.indexOf("prepareLandingCandidate(", prep + 1)).toBe(-1);
  });

  it("rks_ship — fetch-first guarded prepare, gate, verify inside localMergeAndPushTarget and before the no-remote merge", () => {
    const fn = GIT_SHIP.indexOf("export async function runShip");
    const lsRemote = GIT_SHIP.indexOf('"ls-remote"', fn);
    const prDecision = GIT_SHIP.indexOf("prDecision = resolveShipPullRequestMode(", fn);
    const prep = GIT_SHIP.indexOf("prepareLandingCandidate(", fn);
    const gate = GIT_SHIP.indexOf("runFullSuiteGate(", fn);
    expect(lsRemote).toBeGreaterThan(fn);
    expect(prDecision).toBeGreaterThan(lsRemote);
    expect(prep).toBeGreaterThan(prDecision);
    expect(gate).toBeGreaterThan(prep);
    const head = enclosingBlockHead(GIT_SHIP, prep);
    expect(head.startsWith("if (")).toBe(true);
    expect(head).toContain("landingGateEnabled(");
    expect(head).toContain("landsLocally");
    // in that block, before the prepare: the fetch of the target's refspec and the origin landing target
    const blockStart = GIT_SHIP.lastIndexOf(head, prep);
    const beforePrep = GIT_SHIP.slice(blockStart, prep);
    expect(beforePrep).toContain('"fetch", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`');
    expect(beforePrep).toContain("`origin/${targetBranch}`");

    // remote local-merge arm: verify after the function's own fetch, before its checkout and merges
    const lm = GIT_SHIP.indexOf("function localMergeAndPushTarget(");
    const body = GIT_SHIP.slice(lm, fn);
    const fetch = body.indexOf('"fetch"');
    const lmVerify = body.indexOf("verifyTargetUnmoved(");
    expect(fetch).toBeGreaterThan(-1);
    expect(lmVerify).toBeGreaterThan(fetch);
    expect(lmVerify).toBeLessThan(body.indexOf('["checkout", targetBranch]'));
    expect(lmVerify).toBeLessThan(body.indexOf('"--ff-only"'));
    expect(lmVerify).toBeLessThan(body.indexOf('"merge", "--no-ff"'));
    expect(body.slice(lmVerify, body.indexOf("\n", lmVerify))).toContain("localBranch: targetBranch");
    expect(GIT_SHIP.indexOf("localMergeAndPushTarget({ projectRoot, featureBranch, targetBranch, landing })", fn)).toBeGreaterThan(gate);

    // no-remote arm: verify before the checkoutTarget spawn and the --no-ff merge
    const noRemote = GIT_SHIP.indexOf(`const checkoutTarget = ${SPAWN}("git", ["checkout", targetBranch]`, fn);
    const stagingMerge = GIT_SHIP.indexOf("runStagingMerge(", fn);
    const nrVerify = GIT_SHIP.lastIndexOf("verifyTargetUnmoved(", noRemote);
    expect(noRemote).toBeGreaterThan(stagingMerge);
    expect(nrVerify).toBeGreaterThan(stagingMerge);
    expect(nrVerify).toBeLessThan(noRemote);
    expect(GIT_SHIP.indexOf('"merge", "--no-ff", featureBranch', noRemote)).toBeGreaterThan(noRemote);
  });

  it("rks_ship PR arm runs no landing preparation or verification", () => {
    const fn = GIT_SHIP.indexOf("export async function runShip");
    const pr = GIT_SHIP.indexOf("runGitPR(", fn);
    const mergePush = GIT_SHIP.indexOf('steps.push({ step: "merge", ...mergeResult });', pr);
    expect(pr).toBeGreaterThan(fn);
    expect(mergePush).toBeGreaterThan(GIT_SHIP.indexOf("runStagingMerge(", pr));
    const region = GIT_SHIP.slice(pr, mergePush);
    expect(region).not.toContain("prepareLandingCandidate(");
    expect(region).not.toContain("verifyTargetUnmoved(");
    // landsLocally, evaluated from its own source expression, is false only for the PR arm
    const m = GIT_SHIP.slice(fn).match(/const landsLocally = ([^;\n]+);/);
    expect(m).not.toBeNull();
    const landsLocally = new Function("targetExistsOnRemote", "prDecision", `return (${m[1]});`);
    expect(landsLocally(true, { mode: "pr" })).toBe(false);
    expect(landsLocally(true, { mode: "local" })).toBe(true);
    expect(landsLocally(false, null)).toBe(true);
  });

  it("every gate call passes extraTestPaths from the shared loadStoryTestFiles", () => {
    const beta = AUDIT.indexOf("const gateBeta = await runOffRailEnforcementGate({");
    const calls = [
      ["story-ship", STORY_SHIP, STORY_SHIP.indexOf("runFullSuiteGate(", STORY_SHIP.indexOf("export async function runStoryShipTool"))],
      ["guardrails-audit beta", AUDIT, AUDIT.indexOf("runFullSuiteGate(", beta)],
      ["git-ship", GIT_SHIP, GIT_SHIP.indexOf("runFullSuiteGate(", GIT_SHIP.indexOf("export async function runShip"))],
    ];
    for (const [name, text, call] of calls) {
      expect(call, name).toBeGreaterThan(-1);
      const line = text.slice(call, text.indexOf("\n", call));
      expect(line, name).toContain("extraTestPaths: loadStoryTestFiles(");
    }
    const importRe = /import \{[^}]*\bloadStoryTestFiles\b[^}]*\} from ["'](?:\.\.\/)+shared\/story-test-files\.mjs["']/;
    for (const [name, text] of [["story-ship", STORY_SHIP], ["guardrails-audit", AUDIT], ["git-ship", GIT_SHIP]]) {
      expect(text, name).toMatch(importRe);
    }
    expect(AUDIT).not.toContain("function loadStoryTestFiles");
    expect(src("packages/mcp-rks/src/shared/story-test-files.mjs")).toContain("export function loadStoryTestFiles(");
  });

  it("a refused preparation or a moved target exits before delivery on every in-scope arm", () => {
    // story-ship: both refusals exit through buildShipFailure with their own failedStep
    const tool = STORY_SHIP.indexOf("export async function runStoryShipTool");
    const sGate = STORY_SHIP.indexOf("runFullSuiteGate(", tool);
    const sPrep = refusalReturn(STORY_SHIP, STORY_SHIP.indexOf("prepareLandingCandidate(", tool), sGate);
    expect(sPrep.ret.startsWith("return buildShipFailure(")).toBe(true);
    expect(sPrep.ret.slice(0, 400)).toContain("failedStep: 'landing_candidate'");
    const sDelivered = STORY_SHIP.indexOf("if (deliveredEvidence) {", sGate);
    const sVerify = refusalReturn(STORY_SHIP, STORY_SHIP.indexOf("verifyTargetUnmoved(", sGate), sDelivered);
    expect(sVerify.ret.startsWith("return buildShipFailure(")).toBe(true);
    expect(sVerify.ret.slice(0, 400)).toContain("failedStep: 'landing_verify'");

    // guardrails gate beta: both refusals halt and finalize before the isThreeBranch split
    const beta = AUDIT.indexOf("const gateBeta = await runOffRailEnforcementGate({");
    const aGate = AUDIT.indexOf("runFullSuiteGate(", beta);
    const aNext = AUDIT.indexOf("if (isThreeBranch) {", beta);
    for (const [call, to, haltedAt] of [
      [AUDIT.indexOf("prepareLandingCandidate(", beta), aGate, "landing_candidate"],
      [AUDIT.indexOf("verifyTargetUnmoved(", aGate), aNext, "landing_verify"],
    ]) {
      const r = refusalReturn(AUDIT, call, to);
      expect(r.block).toContain(`response.haltedAt = "${haltedAt}";`);
      expect(r.block).toContain("response.recoveryBranch = branchName;");
      expect(r.ret.startsWith("return finalizeShipOutcome(response);")).toBe(true);
    }

    // rks_ship: the prepare block, localMergeAndPushTarget and the no-remote arm
    const fn = GIT_SHIP.indexOf("export async function runShip");
    const gGate = GIT_SHIP.indexOf("runFullSuiteGate(", fn);
    const gPrep = refusalReturn(GIT_SHIP, GIT_SHIP.indexOf("prepareLandingCandidate(", fn), gGate);
    expect(gPrep.ret).toMatch(/^return \{ ok: false/);
    expect(gPrep.ret.slice(0, 400)).toContain('failedStep: "landing_candidate"');
    // the fetch before the prepare also refuses with landing_candidate
    const prepBlockHead = enclosingBlockHead(GIT_SHIP, GIT_SHIP.indexOf("prepareLandingCandidate(", fn));
    const prepBlock = blockFrom(GIT_SHIP, GIT_SHIP.lastIndexOf(prepBlockHead, GIT_SHIP.indexOf("prepareLandingCandidate(", fn)));
    const fetchFail = prepBlock.slice(0, prepBlock.indexOf("prepareLandingCandidate("));
    expect(fetchFail).toMatch(/return \{ ok: false[^\n]*failedStep: "landing_candidate"/);

    const lm = GIT_SHIP.indexOf("function localMergeAndPushTarget(");
    const lmCheckout = GIT_SHIP.indexOf('["checkout", targetBranch]', lm);
    const lmVerify = refusalReturn(GIT_SHIP, GIT_SHIP.indexOf("verifyTargetUnmoved(", lm), lmCheckout);
    expect(lmVerify.ret).toMatch(/^return \{ ok: false, step: "landing_verify"/);
    // runShip's existing !local.ok exit reports local.step as failedStep before any further delivery
    const localCall = GIT_SHIP.indexOf("const local = localMergeAndPushTarget(", fn);
    const localFail = GIT_SHIP.indexOf("if (!local.ok) {", localCall);
    expect(localFail).toBeGreaterThan(localCall);
    expect(blockFrom(GIT_SHIP, localFail)).toContain("failedStep: local.step");

    const noRemote = GIT_SHIP.indexOf(`const checkoutTarget = ${SPAWN}("git", ["checkout", targetBranch]`, fn);
    const nrVerify = refusalReturn(GIT_SHIP, GIT_SHIP.lastIndexOf("verifyTargetUnmoved(", noRemote), noRemote);
    expect(nrVerify.ret).toMatch(/^return \{ ok: false/);
    expect(nrVerify.ret.slice(0, 400)).toContain('failedStep: "landing_verify"');
  });

  it("rks_ship PR arm pushes and logs the landing skip record before the gate", () => {
    const fn = GIT_SHIP.indexOf("export async function runShip");
    const lands = GIT_SHIP.indexOf("const landsLocally = ", fn);
    const skip = GIT_SHIP.indexOf("landingSkipRecord(", fn);
    const gate = GIT_SHIP.indexOf("runFullSuiteGate(", fn);
    expect(lands).toBeGreaterThan(fn);
    expect(skip).toBeGreaterThan(lands);
    expect(skip).toBeLessThan(gate);
    const m = GIT_SHIP.slice(GIT_SHIP.lastIndexOf("\n", skip), skip).match(/const (\w+) = $/);
    expect(m).not.toBeNull();
    const guard = GIT_SHIP.indexOf(`if (${m[1]}) {`, skip);
    expect(guard).toBeGreaterThan(skip);
    expect(guard).toBeLessThan(gate);
    const block = blockFrom(GIT_SHIP, guard);
    expect(block).toContain(`steps.push(${m[1]});`);
    expect(block).toMatch(new RegExp(`collector\\.emit\\("ship\\.step\\.completed", projectId, ${m[1]}\\)`));
    expect(block).toContain("console.error(");
    expect(block).toContain("landing gate skipped");
    expect(block).not.toContain("prepareLandingCandidate(");
    expect(block).not.toContain("verifyTargetUnmoved(");
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
