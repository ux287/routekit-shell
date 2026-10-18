import { describe, it, expect } from "vitest";
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

  it("step 0.5 calls at least one tool, and does not call rks_git_state unless ship init admits it", () => {
    const s05 = step("0.5");
    expect(toolsCalled(s05).length).toBeGreaterThan(0);
    if (toolsCalled(s05).includes("rks_git_state")) {
      expect(checkStateAllowed("ship", "init", "rks_git_state").allowed).toBe(true);
    }
  });

  it("every tool step 0.6 reads a response from is a tool step 0.5 calls", () => {
    const obtained = toolsCalled(step("0.5"));
    for (const tool of toolsNamed(step("0.6"))) {
      expect(obtained, `step 0.6 reads ${tool}, which step 0.5 never calls`).toContain(tool);
    }
  });
});
