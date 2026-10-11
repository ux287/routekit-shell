import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getBranchConfig } from "../../packages/mcp-rks/src/server/project.mjs";
import { checkStateAllowed } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

// backlog.fix.project-get-omits-resolved-branch-config
const SERVER = readFileSync(path.resolve("packages/mcp-rks/src/server.mjs"), "utf8");
const SHIP = readFileSync(path.resolve(".rks/prompts/governor-ship.md"), "utf8");

// rks_project_get handler: from its dispatch condition to the next dispatch condition.
function projectGetHandler() {
  const start = SERVER.indexOf('if (tool === "rks_project_get") {');
  expect(start, "rks_project_get handler missing").toBeGreaterThanOrEqual(0);
  const next = SERVER.indexOf("if (tool === ", start + 1);
  return next === -1 ? SERVER.slice(start) : SERVER.slice(start, next);
}

// Workflow section: from the ## Workflow heading to the next level 1-2 heading.
function workflow() {
  const start = SHIP.search(/^## Workflow\b/m);
  expect(start, "Workflow heading missing").toBeGreaterThanOrEqual(0);
  const rest = SHIP.slice(start);
  const nl = rest.indexOf("\n");
  const body = rest.slice(nl + 1);
  const next = body.search(/^#{1,2}\s/m);
  return rest.slice(0, nl + 1) + (next === -1 ? body : body.slice(0, next));
}

// Step 0.7: from its line-start marker to the next line-start marker "1. ".
function step07() {
  const wf = workflow();
  const start = wf.search(/^0\.7\.\s/m);
  expect(start, "step 0.7 missing").toBeGreaterThanOrEqual(0);
  const rest = wf.slice(start);
  const end = rest.search(/^1\.\s/m);
  expect(end, "step 1 after 0.7 missing").toBeGreaterThan(0);
  return rest.slice(0, end);
}

const DEFAULTS = { working: "staging", integration: "staging", production: "main" };

describe("getBranchConfig resolution (the value rks_project_get exposes)", () => {
  it("returns the defaults when nothing is configured", () => {
    expect(getBranchConfig({}, {})).toEqual(DEFAULTS);
    expect(getBranchConfig(undefined, undefined)).toEqual(DEFAULTS);
  });
  it("derives working and integration from projectJson.baseBranch", () => {
    expect(getBranchConfig({}, { baseBranch: "dev" })).toEqual({ working: "dev", integration: "dev", production: "main" });
  });
  it("explicit branches override per key", () => {
    expect(getBranchConfig({}, { branches: { working: "dev" } })).toEqual({ ...DEFAULTS, working: "dev" });
  });
});

describe("rks_project_get handler exposes resolved branches", () => {
  it("adds branches from getBranchConfig(context.record, context.projectJson)", () => {
    expect(projectGetHandler()).toMatch(/branches:\s*getBranchConfig\(\s*context\.record\s*,\s*context\.projectJson\s*\)/);
  });
  it("keeps registry, projectJson and kg unchanged (additive)", () => {
    const h = projectGetHandler();
    expect(h).toMatch(/registry:\s*context\.record\b/);
    expect(h).toMatch(/projectJson:\s*context\.projectJson\b/);
    expect(h).toMatch(/kg:\s*context\.kg\b/);
  });
  it("getBranchConfig is imported from ./server/project.mjs", () => {
    expect(SERVER).toMatch(/import\s*\{[^}]*\bgetBranchConfig\b[^}]*\}\s*from\s*["']\.\/server\/project\.mjs["']/);
  });
});

describe("governor-ship.md step 0.7 reads the server-resolved branches", () => {
  it("reads branches.working and branches.integration from the top-level server-resolved branches field", () => {
    const s = step07();
    expect(s).toContain("rks_project_get");
    expect(s).toContain("branches.working");
    expect(s).toContain("branches.integration");
    expect(s).toMatch(/top-level\s+`?branches`?/i);
    expect(s).toMatch(/server-resolved|getBranchConfig/i);
  });
  it("fails closed when branches.working or branches.integration is absent", () => {
    const s = step07();
    expect(s).toMatch(/absent|missing/i);
    expect(s).toMatch(/failed/);
    expect(s).toMatch(/(never|not|do not)\s+infer/i);
  });
  it("confirms skipPRAndMerge against branches.working", () => {
    expect(step07()).toMatch(/skipPRAndMerge[^\n]*branches\.working/);
  });
  it("keeps the topology rule", () => {
    const s = step07();
    expect(s).toMatch(/working !== integration[^\n]*3-branch/);
    expect(s).toMatch(/working === integration[^\n]*2-branch/);
  });
  it("passes the project under the key the rks_project_get schema requires (id)", () => {
    const call = step07().match(/rks_project_get\(\{([^}]*)\}\)/);
    expect(call, "step 0.7 rks_project_get call missing").not.toBeNull();
    const keys = call[1].split(",").map((p) => p.split(":")[0].trim());
    expect(keys).toContain("id");
    expect(keys).not.toContain("projectId");
  });
  it("calls only rks_project_get, which ship init admits", () => {
    const calls = [...new Set([...step07().matchAll(/\b(rks_[a-z_]+)\(/g)].map((m) => m[1]))];
    expect(calls).toEqual(["rks_project_get"]);
    for (const tool of calls) {
      expect(checkStateAllowed("ship", "init", tool).allowed, tool).toBe(true);
    }
  });
  it("keeps Workflow numbering 0 / 0.5 / 0.6 / 0.7 / 1", () => {
    const markers = [...workflow().matchAll(/^(\d+(?:\.\d+)?)\.\s/gm)].map((m) => m[1]);
    const firstOne = markers.indexOf("1");
    expect(firstOne).toBeGreaterThan(0);
    expect(markers.slice(0, firstOne + 1)).toEqual(["0", "0.5", "0.6", "0.7", "1"]);
  });
});
