import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkStateAllowed } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

// backlog.fix.ship-prompt-instructs-inadmissible-git-state: every tool the Ship prompt's
// pre-commit Workflow steps (0.5 to 0.7) instruct must be admitted by the ship flow's init
// chain state, and step 0.6 may only read a response that step 0.5 actually obtains.
const SRC = readFileSync(path.resolve(".rks/prompts/governor-ship.md"), "utf8");

// A Workflow step runs from its "N. **" line to the next numbered step, heading or bold
// paragraph line; located by label, never by a fixed slice.
function step(label) {
  const re = new RegExp("^" + label.split(".").join("\\.") + "\\.\\s+\\*\\*", "m");
  const start = SRC.search(re);
  expect(start, `Workflow step ${label} missing`).toBeGreaterThanOrEqual(0);
  const rest = SRC.slice(start);
  const nl = rest.indexOf("\n");
  const body = rest.slice(nl + 1);
  const next = body.search(/^(\d+(\.\d+)?\.\s+\*\*|#{1,3}\s|\*\*)/m);
  return rest.slice(0, nl + 1) + (next === -1 ? body : body.slice(0, next));
}

// Tools a step CALLS: an rks_ name immediately followed by an opening parenthesis.
function toolsCalled(text) {
  return [...text.matchAll(/\b(rks_[a-z_]+)\s*\(/g)].map((m) => m[1]);
}

// Tools a step merely NAMES, called or not.
function toolsNamed(text) {
  return [...text.matchAll(/\b(rks_[a-z_]+)\b/g)].map((m) => m[1]);
}

describe("governor-ship.md pre-commit Workflow steps use tools the ship init state admits", () => {
  it("every tool called in steps 0.5, 0.6 and 0.7 is admitted by checkStateAllowed('ship', 'init', tool)", () => {
    const called = ["0.5", "0.6", "0.7"].flatMap((l) => toolsCalled(step(l)));
    // Positive control: step 0.7 calls rks_project_get, so an empty list means the extractor is blind.
    expect(called.length).toBeGreaterThan(0);
    for (const tool of called) {
      expect(checkStateAllowed("ship", "init", tool).allowed, `${tool} refused in ship init`).toBe(true);
    }
  });

  // backlog.fix.ship-flow-deterministic-no-llm (AC1): step 0.5 moves to the deterministic
  // rks_git_state, which ship init now admits — unconditionally, no longer "unless".
  it("step 0.5 calls rks_git_state, and ship init admits it", () => {
    const s05 = step("0.5");
    expect(toolsCalled(s05)).toContain("rks_git_state");
    expect(checkStateAllowed("ship", "init", "rks_git_state").allowed).toBe(true);
  });

  it("every tool step 0.6 reads a response from is a tool step 0.5 calls", () => {
    const obtained = toolsCalled(step("0.5"));
    for (const tool of toolsNamed(step("0.6"))) {
      expect(obtained, `step 0.6 reads ${tool}, which step 0.5 never calls`).toContain(tool);
    }
  });

  it("steps 0.5 and 0.6 read only rks_git_state fields, none of the old git-agent data.* fields", () => {
    const text = step("0.5") + step("0.6");
    for (const old of ["data.branch", "data.dirty", "data.files", "data.ahead"]) {
      expect(text, old).not.toContain(old);
    }
    for (const field of ["currentBranch", "isClean", "uncommittedFiles", "aheadBy", "upstream"]) {
      expect(text, field).toContain(field);
    }
    expect(step("0.6")).toContain("currentBranch");
  });

  it("step 0.5 decides nothing to ship only from isClean true AND upstream non-null AND aheadBy 0, not from recommendations", () => {
    const s05 = step("0.5");
    const decision = s05.split("\n").filter((l) => l.includes("nothing to ship") && l.includes("return"));
    expect(decision).toHaveLength(1);
    expect(decision[0]).toMatch(/`isClean` is true AND `upstream` is non-null AND `aheadBy` is 0/);
    expect(decision[0]).not.toMatch(/recommendations/);
  });
});

describe("governor-ship.md calls no LLM-backed rks_agent_* tool (backlog.fix.ship-flow-deterministic-no-llm AC1)", () => {
  const AGENT_CALL = /\b(rks_agent_[a-z_]+)\(/g;
  const agentCalls = (text) => [...text.matchAll(AGENT_CALL)].map((m) => m[1]);

  it("the whole prompt has zero rks_agent_*( call tokens", () => {
    expect(agentCalls(SRC)).toEqual([]);
  });

  it("positive control: a synthetic call is found; list-style control: a list mention is not", () => {
    expect(agentCalls("Call rks_agent_git( projectId )")).toEqual(["rks_agent_git"]);
    expect(agentCalls("  - rks_agent_run (Path 1 only)")).toEqual([]);
  });

  it("the 3-branch step 1.5 calls rks_git_merge with targetBranch and deleteBranch true, and no rks_agent_git", () => {
    const start = SRC.indexOf("**3-branch path**");
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf("**Both paths:**", start);
    const section = SRC.slice(start, end);
    const call = section.match(/rks_git_merge\(\{([^}]*)\}\)/);
    expect(call, "3-branch step 1.5 rks_git_merge call").not.toBeNull();
    expect(call[1]).toMatch(/\btargetBranch\s*:/);
    expect(call[1]).toMatch(/\bdeleteBranch\s*:\s*true\b/);
    expect(section).not.toContain("rks_agent_git");
  });

  it("AC9: step 4 and the pipeline Rules line state what happens when skipPRAndMerge is true", () => {
    const s4 = step("4");
    expect(s4).toMatch(/skipPRAndMerge is true[^\n]*`committed`/);
    expect(s4).toMatch(/skipPRAndMerge is false[^\n]*after the merge succeeded/);
    expect(s4).toMatch(/Report `shipped` only from an observed rks_cycle_complete result/);
    const rule = SRC.split("\n").find((l) => l.startsWith("- For pipeline path:"));
    expect(rule).toBeDefined();
    expect(rule).toMatch(/skipPRAndMerge is true/);
    expect(rule).toMatch(/committed/);
    expect(rule).not.toMatch(/always call rks_cycle_complete after merge succeeds/);
  });
});

// backlog.fix.ship-governor-2branch-pr-merge-wrong-tool-args: the 2-branch steps 2 and 3 call the
// staging PR / staging merge tools with only keys their input schemas declare, and each tool is
// admitted in the ship state the chain is in when the step runs.
describe("governor-ship.md 2-branch steps 2 and 3 call rks_staging_pr / rks_staging_merge with schema keys", () => {
  const section = (() => {
    const start = SRC.indexOf("**2-branch path**");
    expect(start, "2-branch section").toBeGreaterThan(-1);
    const end = SRC.indexOf("**3-branch path**", start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
  })();
  // A step inside the 2-branch section, from its "N. **" line to the next numbered step.
  const stepIn = (label) => {
    const re = new RegExp("^" + label + "\\.\\s+\\*\\*", "m");
    const at = section.search(re);
    expect(at, `2-branch step ${label}`).toBeGreaterThanOrEqual(0);
    const rest = section.slice(at);
    const nl = rest.indexOf("\n");
    const body = rest.slice(nl + 1);
    const next = body.search(/^\d+(\.\d+)?\.\s+\*\*/m);
    return rest.slice(0, nl + 1) + (next === -1 ? body : body.slice(0, next));
  };
  // Every { ... } argument list passed to `tool(` in text, as arrays of key names.
  const callArgs = (text, tool) =>
    [...text.matchAll(new RegExp("\\b" + tool + "\\(\\{([^}]*)\\}\\)", "g"))].map((m) =>
      m[1].split(",").map((a) => a.split(":")[0].trim()).filter(Boolean));
  // The first call to `tool` after `phrase` in text.
  const callAfter = (text, phrase, tool) => {
    const at = text.indexOf(phrase);
    expect(at, `"${phrase}" in step`).toBeGreaterThan(-1);
    return callArgs(text.slice(at), tool)[0];
  };
  const notSchemaKeys = (keys, schema) => keys.filter((k) => k !== "_governorToken" && !Object.prototype.hasOwnProperty.call(schema.shape, k));

  let TOOL_ARG_SCHEMAS;
  beforeAll(async () => {
    ({ TOOL_ARG_SCHEMAS } = await import("../../packages/mcp-rks/src/server.mjs"));
  });

  it("no rks_staging_pr call anywhere in the prompt passes storyId", () => {
    const all = callArgs(SRC, "rks_staging_pr");
    expect(all.length).toBeGreaterThan(0);
    for (const keys of all) expect(keys).not.toContain("storyId");
  });

  it("step 2 passes problemId on the pipeline path and reason on the Research and Ad-hoc paths", () => {
    const s2 = stepIn("2");
    expect(toolsCalled(s2)).toEqual(expect.arrayContaining(["rks_staging_pr"]));
    const pipeline = callAfter(s2, "pipeline path", "rks_staging_pr");
    expect(pipeline).toContain("problemId");
    expect(pipeline).not.toContain("reason");
    for (const p of ["Research path", "Ad-hoc path"]) {
      const keys = callAfter(s2, p, "rks_staging_pr");
      expect(keys, p).toContain("reason");
      expect(keys, p).not.toContain("problemId");
    }
  });

  it("step 3 calls rks_staging_merge, never rks_git_merge, with no prNumber and no strategy", () => {
    const s3 = stepIn("3");
    const called = toolsCalled(s3);
    expect(called.length).toBeGreaterThan(0);
    expect(new Set(called)).toEqual(new Set(["rks_staging_merge"]));
    const calls = callArgs(s3, "rks_staging_merge");
    expect(calls.length).toBeGreaterThan(0);
    for (const keys of calls) {
      expect(keys).not.toContain("prNumber");
      expect(keys).not.toContain("strategy");
    }
    expect(callAfter(s3, "pipeline path", "rks_staging_merge")).toContain("problemId");
    expect(callAfter(s3, "Research and Ad-hoc paths", "rks_staging_merge")).toContain("reason");
  });

  it("every key steps 2 and 3 pass (excluding _governorToken) is a key of the tool's schema .shape", () => {
    const pr = TOOL_ARG_SCHEMAS.rks_staging_pr;
    const merge = TOOL_ARG_SCHEMAS.rks_staging_merge;
    expect(pr?.shape).toBeTypeOf("object");
    expect(merge?.shape).toBeTypeOf("object");
    const prCalls = callArgs(stepIn("2"), "rks_staging_pr");
    const mergeCalls = callArgs(stepIn("3"), "rks_staging_merge");
    expect(prCalls.length).toBeGreaterThan(0);
    expect(mergeCalls.length).toBeGreaterThan(0);
    for (const keys of prCalls) expect(notSchemaKeys(keys, pr), keys.join(",")).toEqual([]);
    for (const keys of mergeCalls) expect(notSchemaKeys(keys, merge), keys.join(",")).toEqual([]);
    // Positive control: a synthetic storyId key is reported as not a schema key.
    expect(notSchemaKeys(["projectId", "storyId", "_governorToken"], pr)).toEqual(["storyId"]);
    expect(notSchemaKeys(["projectId", "storyId", "strategy"], merge)).toEqual(["storyId", "strategy"]);
  });

  it("each step's tool is admitted in the state the chain is in when the step runs", () => {
    expect(checkStateAllowed("ship", "committed", "rks_staging_pr").allowed).toBe(true);
    expect(checkStateAllowed("ship", "pr_created", "rks_staging_merge").allowed).toBe(true);
    expect(checkStateAllowed("ship", "init", "rks_staging_merge").allowed).toBe(false);
    expect(checkStateAllowed("ship", "committed", "rks_staging_merge").allowed).toBe(false);
  });
});
