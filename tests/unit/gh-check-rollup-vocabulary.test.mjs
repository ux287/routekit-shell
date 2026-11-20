/**
 * Witness for backlog.fix.gh-checkrun-statuscontext-vocabulary-conflation.
 *
 * `gh pr view --json statusCheckRollup` returns a heterogeneous array of TWO GraphQL types with
 * DISJOINT vocabularies. CheckRun carries `status` + `conclusion` and no `state`; StatusContext
 * carries `state` only, with no `status` and NO `conclusion`. Every consumer collapsed them with
 * `status: c.status || c.state`, producing a value from one vocabulary read with the other's
 * rules — and the two failures point in OPPOSITE directions:
 *
 *   A. A green StatusContext normalised to `status: "SUCCESS"`, so a filter asking
 *      `status !== "COMPLETED"` read it as perpetually running. rks_story_ship could not merge
 *      a PR in this repo, which is why guardrails-off became load-bearing by accident.
 *   B. `every(c => c.conclusion === "SUCCESS" || c.status === "COMPLETED")` let a
 *      COMPLETED-FAILURE read as passed, because the second disjunct is true of any finished run.
 *
 * BOTH directions are asserted here. Asserting only one is how a defect with a mirror image
 * survives — which is exactly what happened.
 *
 * FIXTURE FIDELITY, stated rather than glossed: the StatusContext shape is modelled on a real
 * captured `gh pr view --json statusCheckRollup` payload. The CheckRun shape is corroborated
 * from the GraphQL schema and the gh CLI issue tracker but was NOT observed in a captured
 * payload. Neither fixture is a hybrid — a hybrid carrying both vocabularies' fields would prove
 * nothing about either.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as shared from "../../packages/mcp-rks/src/shared/check-rollup.mjs";
import * as ghTools from "../../packages/mcp-rks/src/server/gh-tools.mjs";
import * as shipAgent from "../../packages/mcp-rks/src/agents/ship.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SRC = path.join(REPO_ROOT, "packages", "mcp-rks", "src");

// Real shapes. A CheckRun has NO `state`; a StatusContext has NO `status` and NO `conclusion`.
const checkRun = (conclusion, status = "COMPLETED") => ({
  __typename: "CheckRun",
  name: "unit-tests",
  status,
  conclusion,
});
const statusContext = (state) => ({
  __typename: "StatusContext",
  context: "vercel",
  state,
  targetUrl: "https://example.invalid",
});

describe("fixtures are honest about the two vocabularies", () => {
  it("neither fixture is a hybrid", () => {
    const cr = checkRun("SUCCESS");
    const sc = statusContext("SUCCESS");
    const wrong = [];
    if (Object.hasOwn(cr, "state")) wrong.push("CheckRun fixture carries `state`");
    if (Object.hasOwn(sc, "status")) wrong.push("StatusContext fixture carries `status`");
    if (Object.hasOwn(sc, "conclusion")) wrong.push("StatusContext fixture carries `conclusion`");
    expect(wrong).toEqual([]);
  });
});

describe("both directions, from real shapes", () => {
  it("a green StatusContext is COMPLETED and PASSED — direction A", () => {
    // Pre-fix this normalised to status "SUCCESS", which `status !== "COMPLETED"` read as
    // still-running. That is the merge blocker.
    const [c] = shared.normalizeCheckRollup([statusContext("SUCCESS")]);
    expect(c.completed).toBe(true);
    expect(c.passed).toBe(true);
    expect(shared.allChecksPassed([c])).toBe(true);
  });

  it("a COMPLETED-FAILURE CheckRun is completed but NOT passed — direction B", () => {
    // Pre-fix `c.status === "COMPLETED"` made this read as passed.
    const [c] = shared.normalizeCheckRollup([checkRun("FAILURE")]);
    expect(c.completed).toBe(true);
    expect(c.passed).toBe(false);
    expect(shared.allChecksPassed([c])).toBe(false);
  });

  it("classifies every state across both vocabularies", () => {
    const table = [
      [statusContext("PENDING"), false, false],
      [statusContext("EXPECTED"), false, false],
      [statusContext("FAILURE"), true, false],
      [statusContext("ERROR"), true, false],
      [statusContext("SUCCESS"), true, true],
      [checkRun(null, "QUEUED"), false, false],
      [checkRun(null, "IN_PROGRESS"), false, false],
      [checkRun("SUCCESS"), true, true],
      [checkRun("TIMED_OUT"), true, false],
      [checkRun("CANCELLED"), true, false],
    ];
    const wrong = [];
    for (const [raw, completed, passed] of table) {
      const c = shared.normalizeRollupCheck(raw);
      const label = `${raw.__typename}:${raw.status ?? raw.state}:${raw.conclusion ?? "-"}`;
      if (c.completed !== completed) wrong.push(`${label} completed=${c.completed}`);
      if (c.passed !== passed) wrong.push(`${label} passed=${c.passed}`);
    }
    expect(wrong).toEqual([]);
  });

  it("a mixed rollup passes only when EVERY entry finished and succeeded", () => {
    expect(shared.allChecksPassed(shared.normalizeCheckRollup([
      statusContext("SUCCESS"), checkRun("SUCCESS"),
    ]))).toBe(true);
    expect(shared.allChecksPassed(shared.normalizeCheckRollup([
      statusContext("SUCCESS"), checkRun("FAILURE"),
    ]))).toBe(false);
    expect(shared.allChecksPassed(shared.normalizeCheckRollup([
      statusContext("PENDING"), checkRun("SUCCESS"),
    ]))).toBe(false);
  });

  it("an empty or missing rollup means no CI configured, not failure", () => {
    expect(shared.normalizeCheckRollup(undefined)).toEqual([]);
    expect(shared.normalizeCheckRollup(null)).toEqual([]);
    expect(shared.allChecksPassed([])).toBe(true);
  });
});

describe("ONE derivation, reached by every consumer", () => {
  it("gh-tools and ship reach the SAME function objects", () => {
    // Identity, not equivalence. This holds only because both re-export VERBATIM; a wrapper
    // would look correct and break it.
    expect(ghTools.normalizeCheckRollup).toBe(shared.normalizeCheckRollup);
    expect(ghTools.allChecksPassed).toBe(shared.allChecksPassed);
    expect(shipAgent.normalizeCheckRollup).toBe(shared.normalizeCheckRollup);
    expect(shipAgent.allChecksPassed).toBe(shared.allChecksPassed);
  });

  it("no consumer declares its own private normalization any more", () => {
    const files = [
      "server/gh-tools.mjs",
      "agents/ship.mjs",
      "server/git/git-release.mjs",
    ];
    const sources = files.map((rel) => [rel, fs.readFileSync(path.join(SRC, rel), "utf8")]);
    // Positive control — the sweep actually read something.
    const empties = sources.filter(([, src]) => src.length === 0);
    expect(empties).toEqual([]);

    const offenders = [];
    for (const [rel, src] of sources) {
      if (/c\.status\s*\|\|\s*c\.state/.test(src)) offenders.push(`${rel}: private vocabulary collapse`);
      if (/conclusion\s*===\s*['"]SUCCESS['"]\s*\|\|/.test(src)) offenders.push(`${rel}: private allChecksPassed disjunction`);
    }
    expect(offenders).toEqual([]);
  });

  it("neither --json field list requests __typename", () => {
    // __typename arrives WITHOUT being requested. It is not a valid top-level --json field for
    // `gh pr view`, so adding it breaks the invocation. Asserted as absence within each list.
    const lists = [
      ["server/gh-tools.mjs", /--json",\s*\n?\s*"([^"]*statusCheckRollup[^"]*)"/],
      ["agents/ship.mjs", /'--json',\s*'([^']*statusCheckRollup[^']*)'/],
    ];
    const offenders = [];
    for (const [rel, re] of lists) {
      const src = fs.readFileSync(path.join(SRC, rel), "utf8");
      const m = src.match(re);
      if (!m) { offenders.push(`${rel}: could not locate the --json field list`); continue; }
      if (m[1].includes("__typename")) offenders.push(`${rel}: field list requests __typename`);
    }
    expect(offenders).toEqual([]);
  });
});
