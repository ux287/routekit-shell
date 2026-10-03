/**
 * Witness for backlog.fix.workspace-member-names-missing-from-declared-set.
 *
 * THE DEFECT: `readPackageDependenciesForFile` walks from a file to the repo root and merges
 * each manifest's `dependencies` and `devDependencies` — but nothing reads the root
 * `workspaces` key. A workspace member is resolvable by bare specifier WITHOUT appearing in
 * any dependencies map; that is what workspaces mean. So a file with NO manifest between it
 * and the root — anything under `tests/`, for instance — saw a declared set omitting every
 * sibling package, and each intra-workspace import was reported `import_not_declared`. A child
 * project hit this on rks 0.48.0, 0.50.0 and 0.50.3 while two green test files imported the
 * flagged specifier the whole time.
 *
 * WHY THE FIXTURE SHAPE IS LOAD-BEARING: every pre-existing workspace case in this suite uses
 * the importing file `packages/cli/src/index.mjs`. The walk finds THAT member's own manifest,
 * so those cases pass with the defect fully intact — they are not witnesses. The fixture below
 * asserts its own shape first: zero manifests strictly between the importing file and the root.
 * If it is ever relocated under `packages/`, the precondition fails loudly rather than the
 * suite passing vacuously.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  readPackageDependenciesForFile,
  readWorkspaceMemberNames,
} from "../../packages/mcp-rks/src/server/planner-prompts.mjs";
import { makeTempDir } from "../helpers/tmp.mjs";

const IMPORTING_FILE = "tests/unit/cli-analytics-wiring.test.mjs";
const roots = [];

function makeRoot() {
  const r = makeTempDir("workspace_member_declaration");
  roots.push(r);
  return r;
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  return p;
}

/** Manifests STRICTLY between the importing file and the root — the fixture-shape invariant. */
function manifestsBetweenFileAndRoot(root, rel) {
  const found = [];
  const rootResolved = path.resolve(root);
  let dir = path.dirname(path.resolve(root, rel));
  while (dir.startsWith(rootResolved) && dir !== rootResolved && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) found.push(dir);
    dir = path.dirname(dir);
  }
  return found;
}

let root;

beforeEach(() => {
  root = makeRoot();
  write(root, "package.json", {
    name: "growth-root",
    private: true,
    workspaces: ["packages/*"],
    devDependencies: { vitest: "^1.0.0" },
  });
  write(root, "packages/sources/package.json", { name: "@growth/sources", version: "1.0.0" });
  write(root, "packages/cli/package.json", { name: "@growth/cli", version: "1.0.0" });
  write(root, IMPORTING_FILE, "import { buildRegistry } from '@growth/sources';\n");
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe("fixture shape — the precondition that keeps this witness non-vacuous", () => {
  it("has ZERO manifests strictly between the importing file and the root", () => {
    expect(manifestsBetweenFileAndRoot(root, IMPORTING_FILE)).toEqual([]);
    // Positive control: the helper does find one when there IS one, so an empty result above
    // is an observation rather than a broken walker.
    expect(manifestsBetweenFileAndRoot(root, "packages/sources/src/index.mjs")).toHaveLength(1);
  });
});

describe("workspace member names join the declared set", () => {
  it("a bare specifier naming a workspace member is declared, from a file with no local manifest", () => {
    const declared = readPackageDependenciesForFile(root, IMPORTING_FILE);
    // Key PRESENCE is the contract — plan-quality builds `new Set(Object.keys(d))` and never
    // reads the value, so asserting a version would pass for any sentinel.
    expect(Object.keys(declared)).toContain("@growth/sources");
    expect(Object.keys(declared)).toContain("@growth/cli");
    // Root-hoisted devDependency still visible — union, not replacement.
    expect(Object.keys(declared)).toContain("vitest");
  });

  it("expands a glob to EVERY member, not just the first match", () => {
    const names = readWorkspaceMemberNames(root);
    const missing = ["@growth/sources", "@growth/cli"].filter((n) => !names.includes(n));
    expect(missing).toEqual([]);
  });

  it("reads the member's DECLARED name, never the directory name", () => {
    const r = makeRoot();
    write(r, "package.json", { name: "root", private: true, workspaces: ["packages/*"] });
    write(r, "packages/srcs/package.json", { name: "@growth/renamed-sources", version: "1.0.0" });
    write(r, IMPORTING_FILE, "import x from '@growth/renamed-sources';\n");
    const names = readWorkspaceMemberNames(r);
    // A basename heuristic cannot produce this name — it appears nowhere in the path.
    expect(names).toContain("@growth/renamed-sources");
    // ...and must NOT invent the directory-derived one.
    expect(names).not.toContain("@growth/srcs");
  });

  it("handles the object form of workspaces as well as the array form", () => {
    const r = makeRoot();
    write(r, "package.json", { name: "root", private: true, workspaces: { packages: ["packages/*"] } });
    write(r, "packages/sources/package.json", { name: "@growth/sources", version: "1.0.0" });
    write(r, IMPORTING_FILE, "import x from '@growth/sources';\n");
    expect(readWorkspaceMemberNames(r)).toContain("@growth/sources");
  });

  it("refuses a non-terminal wildcard rather than returning a wrong set", () => {
    // REGRESSION: the first implementation sliced base at the FIRST `*`, so `packages/*/lib`
    // enumerated every child of `packages/` and returned members that pattern never matched —
    // under a comment claiming it returned none. Unsupported must mean empty, not a guess.
    const r = makeRoot();
    write(r, "package.json", { name: "root", private: true, workspaces: ["packages/*/lib"] });
    write(r, "packages/foo/package.json", { name: "@growth/foo", version: "1.0.0" });
    write(r, "packages/foo/lib/package.json", { name: "@growth/foo-lib", version: "1.0.0" });
    expect(readWorkspaceMemberNames(r)).toEqual([]);
  });

  it("refuses a bare wildcard rather than enumerating the whole repo", () => {
    const failures = [];
    for (const pattern of ["*", "**"]) {
      const r = makeRoot();
      write(r, "package.json", { name: "root", private: true, workspaces: [pattern] });
      write(r, "packages/foo/package.json", { name: "@growth/foo", version: "1.0.0" });
      write(r, "somewhere/package.json", { name: "@growth/stray", version: "1.0.0" });
      const names = readWorkspaceMemberNames(r);
      if (names.length !== 0) failures.push(`${pattern} returned ${JSON.stringify(names)}`);
    }
    expect(failures).toEqual([]);
  });

  it("accepts a literal (non-glob) workspace path", () => {
    const r = makeRoot();
    write(r, "package.json", { name: "root", private: true, workspaces: ["packages/sources"] });
    write(r, "packages/sources/package.json", { name: "@growth/sources", version: "1.0.0" });
    expect(readWorkspaceMemberNames(r)).toEqual(["@growth/sources"]);
  });
});

describe("the check stays LIVE — reconciled, not disabled", () => {
  it("a specifier that is neither a member nor a dependency is NOT declared", () => {
    const declared = readPackageDependenciesForFile(root, IMPORTING_FILE);
    expect(Object.keys(declared)).not.toContain("left-pad");
  });

  it("a real dependency entry keeps its version rather than being overwritten by the sentinel", () => {
    const r = makeRoot();
    write(r, "package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
      dependencies: { "@growth/sources": "^2.3.4" },
    });
    write(r, "packages/sources/package.json", { name: "@growth/sources", version: "1.0.0" });
    write(r, IMPORTING_FILE, "import x from '@growth/sources';\n");
    expect(readPackageDependenciesForFile(r, IMPORTING_FILE)["@growth/sources"]).toBe("^2.3.4");
  });
});

describe("degradation — malformed input never throws", () => {
  it("survives malformed workspaces values, bad JSON, and nameless or absent members", () => {
    const failures = [];
    const cases = [
      ["workspaces is a string", { name: "r", workspaces: "packages/*" }],
      ["workspaces is a number", { name: "r", workspaces: 7 }],
      ["workspaces is null", { name: "r", workspaces: null }],
      ["object form without packages", { name: "r", workspaces: { nohoist: ["x"] } }],
      ["glob base does not exist", { name: "r", workspaces: ["nope/*"] }],
      ["no workspaces key at all", { name: "r" }],
    ];
    for (const [label, manifest] of cases) {
      const r = makeRoot();
      write(r, "package.json", manifest);
      write(r, IMPORTING_FILE, "import x from '@growth/sources';\n");
      try {
        const names = readWorkspaceMemberNames(r);
        if (!Array.isArray(names)) failures.push(`${label}: did not return an array`);
      } catch (err) {
        failures.push(`${label}: threw ${err.message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("survives an invalid-JSON root manifest and a nameless or malformed member", () => {
    const failures = [];

    const bad = makeRoot();
    write(bad, "package.json", "{ this is not json");
    write(bad, IMPORTING_FILE, "import x from '@growth/sources';\n");
    try {
      expect(readWorkspaceMemberNames(bad)).toEqual([]);
    } catch (err) {
      failures.push(`invalid root JSON: ${err.message}`);
    }

    const nameless = makeRoot();
    write(nameless, "package.json", { name: "r", workspaces: ["packages/*"] });
    write(nameless, "packages/anon/package.json", { version: "1.0.0" });
    write(nameless, "packages/broken/package.json", "{ nope");
    write(nameless, "packages/good/package.json", { name: "@growth/good", version: "1.0.0" });
    try {
      const names = readWorkspaceMemberNames(nameless);
      // A malformed sibling must not suppress a valid one.
      if (!names.includes("@growth/good")) failures.push("valid sibling was suppressed");
      if (names.some((n) => typeof n !== "string" || !n)) failures.push("emitted an empty name");
    } catch (err) {
      failures.push(`nameless/malformed member: ${err.message}`);
    }

    expect(failures).toEqual([]);
  });
});
