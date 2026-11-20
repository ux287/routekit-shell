import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createResearchAgent,
  isWithinProjectRoot,
  verifySnippets,
  detectNamedPaths,
} from "../../../packages/mcp-rks/src/agents/research.mjs";
import { createPlannerAgent } from "../../../packages/mcp-rks/src/agents/planner.mjs";

// Layout under one temp parent (os.tmpdir() itself sits behind /var -> /private/var on macOS):
//   <parent>/proj                                         <- projectRoot
//   <parent>/proj/x.md, <parent>/proj/..dotted.md          <- in-root files
//   <parent>/proj/inlink.md   -> <parent>/proj/x.md         in-root link, in-root target
//   <parent>/proj/outlink.md  -> <parent>/outside/secret.md in-root link, out-of-root target
//   <parent>/proj/outdir      -> <parent>/outside           in-root directory link, out-of-root target
//   <parent>/proj/dangling.md -> <parent>/nope.md           target does not exist
//   <parent>/rootlink         -> <parent>/proj              symlinked project root
const IN_ROOT = "IN_ROOT_SENTINEL_a81e";
const DOTTED = "DOTTED_SENTINEL_3d07";
const OUTSIDE = "OUTSIDE_SENTINEL_e5b9";
const BLOCKED = "Path traversal blocked";

let parent;
let root;
let rootLink;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "rks-root-symlink-"));
  root = path.join(parent, "proj");
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: "t" }));
  fs.writeFileSync(path.join(root, "x.md"), IN_ROOT);
  fs.writeFileSync(path.join(root, "..dotted.md"), DOTTED);
  fs.mkdirSync(path.join(parent, "outside"));
  fs.writeFileSync(path.join(parent, "outside", "secret.md"), OUTSIDE);
  fs.symlinkSync(path.join(root, "x.md"), path.join(root, "inlink.md"));
  fs.symlinkSync(path.join(parent, "outside", "secret.md"), path.join(root, "outlink.md"));
  fs.symlinkSync(path.join(parent, "outside"), path.join(root, "outdir"), "dir");
  fs.symlinkSync(path.join(parent, "nope.md"), path.join(root, "dangling.md"));
  rootLink = path.join(parent, "rootlink");
  fs.symlinkSync(root, rootLink, "dir");
});

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

// A fresh agent per call, so no per-attempt read budget is shared between cases.
const researchReadFile = (projectRoot = root) =>
  createResearchAgent({ projectId: "t", query: "q", projectRoot }).tools.find((t) => t.name === "read_file");
const plannerReadFile = () =>
  createPlannerAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root }).tools.find((t) => t.name === "read_file");
const verbatimShortCircuit = (rel) => {
  const cfg = createResearchAgent({ projectId: "t", query: `read ${rel} verbatim`, projectRoot: root });
  return typeof cfg.shortCircuit === "function" ? cfg.shortCircuit : undefined;
};
const within = (projectRoot, p) => {
  let r;
  expect(() => { r = isWithinProjectRoot(projectRoot, p); }).not.toThrow();
  return r;
};

describe("isWithinProjectRoot symlink containment", () => {
  it("admits a missing in-root path without throwing", () => {
    expect(within(root, "notes/missing.md")).toBe(true);
  });

  it("refuses a missing path beneath an out-pointing directory link without throwing", () => {
    expect(within(root, "outdir/new.md")).toBe(false);
  });

  it("refuses a dangling symlink without throwing", () => {
    expect(within(root, "dangling.md")).toBe(false);
  });

  it("refuses an out-pointing file link and admits an in-root file link", () => {
    expect(within(root, "outlink.md")).toBe(false);
    expect(within(root, "inlink.md")).toBe(true);
  });

  it("admits in-root files when the project root is reached through a symlink", async () => {
    expect(within(rootLink, "x.md")).toBe(true);
    const res = await researchReadFile(rootLink).execute({ path: "x.md" });
    expect(JSON.stringify(res)).toContain(IN_ROOT);
    expect(JSON.stringify(res)).not.toContain(BLOCKED);
  });

  it("does not throw for a nonexistent project root, admits an in-root target and refuses an escaping target", () => {
    // parent sits under os.tmpdir(), which is behind /var -> /private/var on macOS.
    const missingRoot = path.join(parent, "no-such-root");
    expect(within(missingRoot, "a.md")).toBe(true);
    expect(within(missingRoot, "../escape.md")).toBe(false);
  });
});

describe("research read_file symlink containment", () => {
  it("refuses an in-root file link to an out-of-root file", async () => {
    const res = await researchReadFile().execute({ path: "outlink.md" });
    expect(JSON.stringify(res)).toContain(BLOCKED);
    expect(JSON.stringify(res)).not.toContain(OUTSIDE);
  });

  it("refuses a path through an out-pointing directory link", async () => {
    const res = await researchReadFile().execute({ path: "outdir/secret.md" });
    expect(JSON.stringify(res)).toContain(BLOCKED);
    expect(JSON.stringify(res)).not.toContain(OUTSIDE);
  });

  it("reads an in-root file link to an in-root file", async () => {
    const res = await researchReadFile().execute({ path: "inlink.md" });
    expect(JSON.stringify(res)).toContain(IN_ROOT);
    expect(JSON.stringify(res)).not.toContain(BLOCKED);
  });

  it("reports File not found for a missing in-root path", async () => {
    const res = await researchReadFile().execute({ path: "notes/missing.md" });
    expect(JSON.stringify(res)).toContain("File not found");
    expect(JSON.stringify(res)).not.toContain(BLOCKED);
  });

  it("refuses a dangling symlink", async () => {
    const res = await researchReadFile().execute({ path: "dangling.md" });
    expect(JSON.stringify(res)).toContain(BLOCKED);
  });
});

describe("planner read_file symlink containment", () => {
  it("refuses an in-root file link to an out-of-root file", async () => {
    const res = await plannerReadFile().execute({ path: "outlink.md" });
    expect(JSON.stringify(res)).toContain(BLOCKED);
    expect(JSON.stringify(res)).not.toContain(OUTSIDE);
  });

  it("refuses a path through an out-pointing directory link", async () => {
    const res = await plannerReadFile().execute({ path: "outdir/secret.md" });
    expect(JSON.stringify(res)).toContain(BLOCKED);
    expect(JSON.stringify(res)).not.toContain(OUTSIDE);
  });

  it("reads an in-root file link to an in-root file", async () => {
    const res = await plannerReadFile().execute({ path: "inlink.md" });
    expect(JSON.stringify(res)).toContain(IN_ROOT);
    expect(JSON.stringify(res)).not.toContain(BLOCKED);
  });

  it("reports File not found for a missing in-root path", async () => {
    const res = await plannerReadFile().execute({ path: "notes/missing.md" });
    expect(JSON.stringify(res)).toContain("File not found");
    expect(JSON.stringify(res)).not.toContain(BLOCKED);
  });
});

describe("verbatim short-circuit symlink containment", () => {
  it("returns null for an in-root file link to an out-of-root file", async () => {
    const sc = verbatimShortCircuit("outlink.md");
    expect(typeof sc).toBe("function");
    expect(await sc()).toBeNull();
  });

  it("returns null for a path through an out-pointing directory link", async () => {
    const sc = verbatimShortCircuit("outdir/secret.md");
    expect(typeof sc).toBe("function");
    expect(await sc()).toBeNull();
  });

  it("returns the content of an in-root file link to an in-root file", async () => {
    const sc = verbatimShortCircuit("inlink.md");
    expect(typeof sc).toBe("function");
    const res = await sc();
    expect(res).not.toBeNull();
    expect(res.ok).toBe(true);
    expect(res.answer).toBe(IN_ROOT);
  });
});

describe("verifySnippets symlink containment", () => {
  const one = (file, snippet) => verifySnippets([{ file, snippet }], root)[0];

  it("does not verify a snippet cited through an out-pointing file link", () => {
    const out = one("outlink.md", OUTSIDE);
    expect(out.verbatim).toBe(false);
    expect("snippet" in out).toBe(false);
  });

  it("does not verify a snippet cited through an out-pointing directory link", () => {
    const out = one("outdir/secret.md", OUTSIDE);
    expect(out.verbatim).toBe(false);
    expect("snippet" in out).toBe(false);
  });

  it("verifies a snippet cited through an in-root file link", () => {
    expect(one("inlink.md", IN_ROOT).verbatim).toBe(true);
  });

  it("verifies a snippet in an in-root file named ..dotted.md", () => {
    expect(one("..dotted.md", DOTTED).verbatim).toBe(true);
  });
});

describe("named path symlink containment", () => {
  it("detectNamedPaths drops an out-pointing directory link path and keeps a missing in-root path", () => {
    const found = detectNamedPaths("see outdir/secret.md and notes/missing.md", root);
    expect(found.find((e) => e.path === "outdir/secret.md")).toBeUndefined();
    expect(found.find((e) => e.path === "notes/missing.md")).toEqual({ path: "notes/missing.md", exists: false });
  });

  it("supplied namedPaths drop a path through an out-pointing directory link", () => {
    // Positive control: a supplied in-root existing path IS listed.
    const control = createResearchAgent({ projectId: "t", query: "q", projectRoot: root, namedPaths: ["x.md"] });
    expect(control.userMessage).toMatch(/Named paths \(exist on disk\)[^\n]*x\.md/);
    const agent = createResearchAgent({ projectId: "t", query: "q", projectRoot: root, namedPaths: ["outdir/secret.md"] });
    expect(agent.userMessage).not.toContain("outdir/secret.md");
  });
});
