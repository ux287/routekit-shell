/**
 * backlog.feat.project-adopt-verb — `routekit project adopt`.
 *
 * adopt COMPOSES add-existing + upgrade + the two manual steps (restart the child's MCP server,
 * re-run rks_preflight). It replaces a four-step sequence that had no front door and two silent
 * traps: the registry written belongs to the CLI's install location rather than the cwd, and the
 * upgrade compares against whichever shell backs that CLI.
 *
 * The refusals are the load-bearing part. Both are computable from inputs alone and therefore run
 * BEFORE the registry write — adopt's first mutation — so a refused adopt leaves zero state. These
 * tests assert that ordering, not merely the refusal.
 *
 * Uses the injected-deps seam from tests/unit/project-upgrade-dispatch.test.mjs. Registry writes are
 * REAL against a temp SHELL_ROOT, because "the path adopt printed is the file it wrote" cannot be
 * proven with a mocked writer. No subprocess is spawned.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/project-adopt.test.mjs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleProjectCommand } from "../../packages/cli/src/cli/project.js";

let shellRoot;
let childRoot;
let logs;
let errors;
let logSpy;
let errSpy;

const registryPath = () => path.join(shellRoot, "projects", "index.jsonl");
const registryRows = () =>
  existsSync(registryPath())
    ? readFileSync(registryPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** A directory that looks like an rks shell root. */
function makeShellRoot(version = "0.37.0") {
  const d = mkdtempSync(path.join(os.tmpdir(), "adopt-shell-"));
  writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "routekit-shell-core", version }));
  return d;
}

/** A bootstrapped child: .rks/project.json with an id and a kgFile, so --stack is inferable. */
function makeChild({ pinned = false, stack = null } = {}) {
  const d = mkdtempSync(path.join(os.tmpdir(), "adopt-child-"));
  mkdirSync(path.join(d, ".rks"), { recursive: true });
  mkdirSync(path.join(d, "routekit"), { recursive: true });
  writeFileSync(path.join(d, "routekit", "kg.yaml"), "stack: base\n");
  const cfg = { id: "fixture-child", rksVersion: "0.20.34", kgFile: "routekit/kg.yaml" };
  if (pinned) cfg.pinned = true;
  if (stack) cfg.stack = stack;
  writeFileSync(path.join(d, ".rks", "project.json"), JSON.stringify(cfg, null, 2));
  return d;
}

function okReport(over = {}) {
  return {
    ok: true,
    projectId: "fixture-child",
    from: "0.20.34",
    to: "0.37.0",
    shellRoot,
    boundary: "minor",
    gated: false,
    dryRun: false,
    backupPath: null,
    reconciled: [],
    migrationsApplied: [],
    preserved: [],
    stampAdvanced: true,
    restartRequired: true,
    warnings: [],
    ...over,
  };
}

function makeDeps(over = {}) {
  return { processExit: vi.fn(), upgradeProject: vi.fn(() => okReport()), ...over };
}

const adopt = (kv, deps) => handleProjectCommand({ sub: "adopt", kv, SHELL_ROOT: shellRoot }, deps);
const out = () => logs.join("\n");
const err = () => errors.join("\n");

beforeEach(() => {
  shellRoot = makeShellRoot();
  childRoot = makeChild();
  logs = [];
  errors = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  errSpy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const d of [shellRoot, childRoot]) if (d) rmSync(d, { recursive: true, force: true });
});

describe("project adopt — dispatch and arguments", () => {
  it("is dispatched by the sequential if-chain and completes against a bootstrapped child", async () => {
    // Positive behavioral assertion only. handleProjectCommand's chain ends in an IMPLICIT
    // fallthrough — there is no unknown-subcommand branch — so there is nothing to assert about
    // "not falling through".
    const deps = makeDeps();
    await adopt({ id: "fixture-child", path: childRoot }, deps);
    expect(deps.processExit).toHaveBeenCalledWith(0);
    expect(registryRows().map((r) => r.id)).toContain("fixture-child");
  });

  it("refuses without --id or --path, naming the verb, and writes zero registry rows", async () => {
    const deps = makeDeps();
    await adopt({ id: "fixture-child" }, deps);
    expect(err()).toContain("routekit project adopt --id <id> --path <path>");
    expect(deps.processExit).toHaveBeenCalledWith(1);
    expect(registryRows()).toHaveLength(0);
  });
});

describe("project adopt — disclosure", () => {
  it("prints the resolved shell root and its version BEFORE the first mutation", async () => {
    let mutatedAtLogCount = null;
    const deps = makeDeps({
      upgradeProject: vi.fn(() => {
        mutatedAtLogCount ??= logs.length;
        return okReport();
      }),
    });
    await adopt({ id: "fixture-child", path: childRoot }, deps);

    const shellLineIdx = logs.findIndex((l) => l.includes(shellRoot) && l.includes("0.37.0"));
    expect(shellLineIdx).toBeGreaterThanOrEqual(0);
    // Ordering, not mere presence: the disclosure must precede the mutating call.
    expect(shellLineIdx).toBeLessThan(mutatedAtLogCount);
  });

  it("the registry path it PRINTS is the file the row was actually written to", async () => {
    await adopt({ id: "fixture-child", path: childRoot }, makeDeps());
    const printed = logs.find((l) => l.startsWith("Registered in shell registry:"))?.split(": ")[1];
    expect(printed).toBe(registryPath());
    // Read the row back from the PRINTED path — asserting something was printed is insufficient.
    const rows = readFileSync(printed, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.map((r) => r.id)).toContain("fixture-child");
  });
});

describe("project adopt — composition", () => {
  it("registers BEFORE upgrading (invocation order, not just both called)", async () => {
    let rowsWhenUpgradeRan = null;
    const deps = makeDeps({
      upgradeProject: vi.fn(() => {
        rowsWhenUpgradeRan = registryRows().length;
        return okReport();
      }),
    });
    await adopt({ id: "fixture-child", path: childRoot }, deps);
    expect(deps.upgradeProject).toHaveBeenCalled();
    expect(rowsWhenUpgradeRan).toBe(1);
  });

  it("emits the MCP-restart instruction and the rks_preflight verification step", async () => {
    await adopt({ id: "fixture-child", path: childRoot }, makeDeps());
    expect(out()).toMatch(/restart the rks MCP server/);
    expect(out()).toMatch(/rks_preflight/);
  });

  it("still prints the restart instruction when the composed upgrade is a boundary-'none' no-op", async () => {
    // The trap this guards: upgradeProject reports restartRequired falsy on 'none', but adopt may
    // still have just repointed the registry. A user who skips the restart sees stale behavior with
    // nothing telling them why.
    const deps = makeDeps({
      upgradeProject: vi.fn(() =>
        okReport({ boundary: "none", restartRequired: false, warnings: ["Already at 0.37.0 — nothing to do."] }),
      ),
    });
    await adopt({ id: "fixture-child", path: childRoot }, deps);
    expect(out()).toMatch(/restart the rks MCP server/);
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it("is idempotent: a second run exits 0, leaves exactly one row, and still prints the guidance", async () => {
    await adopt({ id: "fixture-child", path: childRoot }, makeDeps());
    logs.length = 0;
    const deps = makeDeps();
    await adopt({ id: "fixture-child", path: childRoot }, deps);

    expect(deps.processExit).toHaveBeenCalledWith(0);
    expect(registryRows().filter((r) => r.id === "fixture-child")).toHaveLength(1);
    expect(out()).toContain(shellRoot);
    expect(out()).toContain(registryPath());
    expect(out()).toMatch(/restart the rks MCP server/);
  });
});

describe("project adopt — pinned refusal", () => {
  it("refuses a pinned child, names --force-repin, and mutates NOTHING", async () => {
    const pinnedChild = makeChild({ pinned: true });
    const before = readFileSync(path.join(pinnedChild, ".rks", "project.json"), "utf8");
    const deps = makeDeps();
    try {
      await adopt({ id: "fixture-child", path: pinnedChild }, deps);

      expect(deps.processExit).toHaveBeenCalledWith(1);
      expect(err()).toMatch(/pinned/);
      expect(err()).toContain("--force-repin");
      // Zero partial state: no registry row, child config byte-identical, upgrade never reached.
      expect(registryRows()).toHaveLength(0);
      expect(readFileSync(path.join(pinnedChild, ".rks", "project.json"), "utf8")).toBe(before);
      expect(deps.upgradeProject).not.toHaveBeenCalled();
    } finally {
      rmSync(pinnedChild, { recursive: true, force: true });
    }
  });

  it("--force-repin proceeds and prints an explicit override notice", async () => {
    const pinnedChild = makeChild({ pinned: true });
    const deps = makeDeps();
    try {
      await adopt({ id: "fixture-child", path: pinnedChild, "force-repin": true }, deps);
      expect(deps.processExit).toHaveBeenCalledWith(0);
      expect(out()).toMatch(/Overriding pinned/);
      expect(deps.upgradeProject).toHaveBeenCalled();
    } finally {
      rmSync(pinnedChild, { recursive: true, force: true });
    }
  });
});

describe("project adopt — self-target refusal", () => {
  // Proven by dev+ino via sameDirectory(), so these variants must all be caught. String equality
  // would let every one of them through.
  const variants = [
    ["exact path", (root) => root],
    ["trailing slash", (root) => `${root}${path.sep}`],
    ["'..' segment", (root) => path.join(root, "subdir", "..")],
  ];

  for (const [label, mangle] of variants) {
    it(`refuses adopting the shell into itself — ${label}`, async () => {
      mkdirSync(path.join(shellRoot, "subdir"), { recursive: true });
      const deps = makeDeps();
      await adopt({ id: "self", path: mangle(shellRoot) }, deps);

      expect(deps.processExit).toHaveBeenCalledWith(1);
      expect(err()).toMatch(/not one of its own children/);
      expect(registryRows()).toHaveLength(0);
      expect(deps.upgradeProject).not.toHaveBeenCalled();
    });
  }
});

describe("project adopt — stack inference", () => {
  it("infers the stack from the child's kg when --stack is omitted", async () => {
    await adopt({ id: "fixture-child", path: childRoot }, makeDeps());
    expect(registryRows().find((r) => r.id === "fixture-child").stack).toBe("base");
  });

  it("prefers an explicit .rks/project.json stack over the kg value", async () => {
    const stacked = makeChild({ stack: "app.web.react.spa" });
    try {
      await adopt({ id: "fixture-child", path: stacked }, makeDeps());
      expect(registryRows().find((r) => r.id === "fixture-child").stack).toBe("app.web.react.spa");
    } finally {
      rmSync(stacked, { recursive: true, force: true });
    }
  });

  it("requires --stack on a NOT-bootstrapped path and writes zero rows", async () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), "adopt-bare-"));
    const deps = makeDeps();
    try {
      await adopt({ id: "bare", path: bare }, deps);
      expect(deps.processExit).toHaveBeenCalledWith(1);
      expect(err()).toMatch(/--stack is required/);
      expect(err()).toMatch(/routekit project attach/); // names the other remedy too
      expect(registryRows()).toHaveLength(0);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
