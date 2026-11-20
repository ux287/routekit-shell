import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createResearchAgent } from "../../../packages/mcp-rks/src/agents/research.mjs";
import { createPlannerAgent } from "../../../packages/mcp-rks/src/agents/planner.mjs";

// Layout under one temp parent:
//   <parent>/proj        <- projectRoot
//   <parent>/proj-evil   <- sibling sharing the root's basename prefix
//   <parent>/outside     <- sibling NOT sharing the prefix
const IN_ROOT = "IN_ROOT_SENTINEL_7f3a";
const DOTTED = "DOTTED_SENTINEL_51c2";
const EVIL = "EVIL_SIBLING_SENTINEL_9b0e";
const OUTSIDE = "OUTSIDE_SENTINEL_c44d";

let parent;
let root;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "rks-root-contain-"));
  root = path.join(parent, "proj");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: "t" }));
  fs.writeFileSync(path.join(root, "x.md"), IN_ROOT);
  fs.writeFileSync(path.join(root, "..dotted.md"), DOTTED);
  fs.mkdirSync(path.join(parent, "proj-evil"));
  fs.writeFileSync(path.join(parent, "proj-evil", "x.md"), EVIL);
  fs.mkdirSync(path.join(parent, "outside"));
  fs.writeFileSync(path.join(parent, "outside", "x.md"), OUTSIDE);
});

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

// A fresh agent per call, so no per-attempt read budget is shared between cases.
const researchReadFile = () =>
  createResearchAgent({ projectId: "t", query: "q", projectRoot: root }).tools.find((t) => t.name === "read_file");
const plannerReadFile = () =>
  createPlannerAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root }).tools.find((t) => t.name === "read_file");

// The verbatim short-circuit is config.shortCircuit, defined only when the query matches the
// verbatim regex. Only the natural `read <rel> verbatim` form is built
// (backlog.fix.research-agent-verbatim-regex-double-escape). The in-root test is the positive
// control proving the branch is reached.
const verbatimShortCircuit = (rel) => {
  const cfg = createResearchAgent({ projectId: "t", query: `read ${rel} verbatim`, projectRoot: root });
  return typeof cfg.shortCircuit === "function" ? cfg.shortCircuit : undefined;
};

describe("research agent read_file root containment", () => {
  it("refuses a sibling directory that shares the root name prefix", async () => {
    const res = await researchReadFile().execute({ path: "../proj-evil/x.md" });
    expect(JSON.stringify(res)).toContain("Path traversal blocked");
    expect(JSON.stringify(res)).not.toContain(EVIL);
  });

  it("refuses a dot-dot traversal to a non-prefix directory", async () => {
    const res = await researchReadFile().execute({ path: "../outside/x.md" });
    expect(JSON.stringify(res)).toContain("Path traversal blocked");
    expect(JSON.stringify(res)).not.toContain(OUTSIDE);
  });

  it("reads an ordinary in-root file", async () => {
    const res = await researchReadFile().execute({ path: "x.md" });
    expect(JSON.stringify(res)).toContain(IN_ROOT);
    expect(JSON.stringify(res)).not.toContain("Path traversal blocked");
  });

  it("reads an in-root file whose name begins with two dots", async () => {
    const res = await researchReadFile().execute({ path: "..dotted.md" });
    expect(JSON.stringify(res)).toContain(DOTTED);
    expect(JSON.stringify(res)).not.toContain("Path traversal blocked");
  });
});

describe("research agent verbatim short-circuit root containment", () => {
  it("returns an in-root file through the verbatim short-circuit", async () => {
    const sc = verbatimShortCircuit("x.md");
    expect(typeof sc).toBe("function");
    const res = await sc();
    expect(res).not.toBeNull();
    expect(res.answer).toBe(IN_ROOT);
  });

  it("does not return a prefix-sibling file through the verbatim short-circuit", async () => {
    const sc = verbatimShortCircuit("../proj-evil/x.md");
    expect(typeof sc).toBe("function");
    const res = await sc();
    expect(res).toBeNull();
  });
});

describe("planner agent read_file root containment", () => {
  it("refuses a sibling directory that shares the root name prefix", async () => {
    const res = await plannerReadFile().execute({ path: "../proj-evil/x.md" });
    expect(JSON.stringify(res)).toContain("Path traversal blocked");
    expect(JSON.stringify(res)).not.toContain(EVIL);
  });

  it("refuses a dot-dot traversal to a non-prefix directory", async () => {
    const res = await plannerReadFile().execute({ path: "../outside/x.md" });
    expect(JSON.stringify(res)).toContain("Path traversal blocked");
    expect(JSON.stringify(res)).not.toContain(OUTSIDE);
  });

  it("reads an ordinary in-root file", async () => {
    const res = await plannerReadFile().execute({ path: "x.md" });
    expect(JSON.stringify(res)).toContain(IN_ROOT);
    expect(JSON.stringify(res)).not.toContain("Path traversal blocked");
  });
});
