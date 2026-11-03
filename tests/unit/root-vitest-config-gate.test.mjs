/**
 * backlog.fix.root-vitest-setupfiles-gate: the bare root vitest run, observed.
 *
 * vitest 2.1.9 resolves a root config by trying "vitest.config" with the extensions
 * .ts, .mts, .cts, .js, .mjs, .cjs in that order. Before this story vitest.config.mts sat
 * beside vitest.config.mjs and won; it did not extend vitest.config.base.mjs, so a bare
 * run loaded no tests/setup.mjs. This file asserts the repaired state by observation:
 *
 *   1. a real bare run, scoped to one probe file, refuses: non-zero exit, refusal text;
 *   2. scripts/vitest-runner.mjs with no --config inherits that refusal;
 *   3. the explicit workflow route (vitest.config.workflow.mjs) is not refused;
 *   4. exactly one root vitest.config.<ext> exists, and no vite/workspace/projects config;
 *   5. tests/setup.mjs executed in THIS unit-tier worker;
 *   6. the refusal is declared on the root config only, never on the base or a tier;
 *   7. no workflow step and no package.json script runs vitest without --config.
 *
 * Every spawned vitest run names exactly one file, and every spawn call carries an
 * explicit timeout option on the same line, as subprocess-timeout-convention and the
 * unit-tier-purity spawn detector require. The e2e config is imported, never spawned.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { REFUSAL_TAG } from "../_helpers/refuse-bare-root-run.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VITEST_BIN = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const PROBE = "tests/fixtures/setup-sentinel-probe.test.mjs";
const SMOKE = "tests/integration/release-smoke.workflow.test.mjs";
const GUARD = "tests/_helpers/refuse-bare-root-run.mjs";
const SPAWN_TIMEOUT_MS = 45_000;
const CASE_TIMEOUT_MS = 60_000;
const TIER_COMMANDS = ["npm run test:unit", "npm run test:mock", "npm run test:e2e"];
// An "<n> passed" count. vitest 2.1.9 formats summary counts in getStateString
// (dist/chunks/utils.DNoFbBUZ.js:106-119): "no tests" for an empty list, otherwise
// "<n> failed | <n> passed | <n> skipped (<total>)". Only an executed, passing test file
// yields an "<n> passed" count. Positive control: describe 1, the base-config probe run.
const PASSED_COUNT = /\b\d+ passed\b/;

function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }
  for (const key of ["ROUTEKIT_VITEST_JSON_OUTPUT", "RKS_RELEASE_SMOKE_REQUIRE_DB", "ROUTEKIT_PROJECT_ROOT", "FORCE_COLOR"]) {
    delete env[key];
  }
  env.NO_COLOR = "1";
  return { ...env, ...overrides };
}

// stdout + stderr, ANSI-stripped so no assertion depends on colour support.
function runNode(args, envOverrides = {}) {
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env: childEnv(envOverrides), encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  return { status: r.status, signal: r.signal, error: r.error, out: stripVTControlCharacters(`${r.stdout ?? ""}\n${r.stderr ?? ""}`) };
}

// Minimal glob matcher for the include shapes these configs use: a double-star segment,
// a single star, and literals.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      re += "(?:.*/)?";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (globs, rel) => globs.some((g) => globToRegExp(g).test(rel));

describe("1. a bare root run refuses (the decisive gate)", () => {
  let bare;
  beforeAll(() => {
    bare = runNode([VITEST_BIN, "run", PROBE]);
  }, CASE_TIMEOUT_MS);

  it("the spawn ran to completion (no spawn error, no timeout kill)", () => {
    expect(bare.error, String(bare.error)).toBeUndefined();
    expect(bare.signal).toBeNull();
  });

  it("exits non-zero", () => {
    expect(bare.status).not.toBe(0);
  });

  it("prints the refusal, naming all three tier commands", () => {
    expect(bare.out).toContain(REFUSAL_TAG);
    for (const cmd of TIER_COMMANDS) expect(bare.out).toContain(cmd);
  });

  it("reports no passed test: the probe never executed", () => {
    // vitest 2.1.9 calls globalSetup (cli-api.DqsSTaIi.js:10816) before pool.runTests (:10818)
    // inside one try block, so the throw skips execution. Whether a summary is printed after
    // that, and in which form, is deliberately NOT asserted: absent, "no tests" or a
    // count-less "(1)" all lack an "<n> passed" count. A probe that executed and FAILED
    // would lack REFUSAL_TAG, which only the globalSetup throws.
    expect(bare.out).not.toMatch(PASSED_COUNT);
  });

  it("control: the same probe passes under a config that loads tests/setup.mjs and has no globalSetup", () => {
    // vitest.config.base.mjs declares no include, so --dir scopes discovery to tests/fixtures.
    const r = runNode([VITEST_BIN, "run", "--config", "vitest.config.base.mjs", "--dir", "tests/fixtures", PROBE]);
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.out).not.toContain(REFUSAL_TAG);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(PASSED_COUNT);
  }, CASE_TIMEOUT_MS);
});

describe("2. scripts/vitest-runner.mjs with no --config inherits the refusal", () => {
  it("exits non-zero and prints the refusal", () => {
    const r = runNode(["scripts/vitest-runner.mjs", "--timeout", "40000", PROBE]);
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(REFUSAL_TAG);
  }, CASE_TIMEOUT_MS);
});

describe("3. the explicit workflow route is not refused", () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-root-gate-"));
  });
  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("vitest.config.workflow.mjs collects the release-smoke file without the refusal", () => {
    // ROUTEKIT_PROJECT_ROOT points at an EMPTY temp dir, so the smoke file finds no LanceDB
    // and self-skips (its shouldSkip guard; RKS_RELEASE_SMOKE_REQUIRE_DB is stripped) whatever
    // is embedded locally: fast and deterministic. Collection is read from the json reporter
    // (one testResults entry per file, name = file.filepath; index.DsZFoqi9.js:4334, :4381),
    // never from console summary text. Exit status is not asserted.
    const reportPath = path.join(tmp, "workflow-report.json");
    const r = runNode(
      [VITEST_BIN, "run", "--config", "vitest.config.workflow.mjs", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`, SMOKE],
      { ROUTEKIT_PROJECT_ROOT: tmp },
    );
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.out).not.toContain(REFUSAL_TAG);
    expect(fs.existsSync(reportPath), r.out).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const names = (report.testResults ?? []).map((t) => String(t.name).split(path.sep).join("/"));
    expect(names.some((n) => n.endsWith(SMOKE)), names.join(", ")).toBe(true);
  }, CASE_TIMEOUT_MS);
});

describe("4. exactly one root vitest config", () => {
  const rootEntries = fs.readdirSync(REPO_ROOT);

  it("vitest.config.mts is gone", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "vitest.config.mts"))).toBe(false);
  });

  it("vitest.config.mjs is the only root vitest.config.<ext>", () => {
    const configs = rootEntries.filter((n) => /^vitest\.config\.(?:ts|mts|cts|js|mjs|cjs)$/.test(n)).sort();
    expect(configs).toEqual(["vitest.config.mjs"]);
  });

  it("no root vite.config, vitest.workspace or vitest.projects file", () => {
    const shadows = rootEntries.filter((n) => /^(?:vite\.config|vitest\.workspace|vitest\.projects)\./.test(n));
    expect(shadows).toEqual([]);
  });
});

describe("5. tests/setup.mjs executed in this unit-tier worker", () => {
  it("the setup sentinel is set", () => {
    expect(globalThis.__RKS_SETUP_LOADED__).toBe(true);
  });
});

describe("6. the refusal is declared on the root config only", () => {
  let cfg;
  beforeAll(async () => {
    const [root, base, unit, mock, e2e, workflow] = await Promise.all([
      import("../../vitest.config.mjs").then((m) => m.default),
      import("../../vitest.config.base.mjs").then((m) => m.default),
      import("../../vitest.config.unit.mjs").then((m) => m.default),
      import("../../vitest.config.mock.mjs").then((m) => m.default),
      import("../../vitest.config.e2e.mjs").then((m) => m.default),
      import("../../vitest.config.workflow.mjs").then((m) => m.default),
    ]);
    cfg = { root, base, unit, mock, e2e, workflow };
  }, CASE_TIMEOUT_MS);

  it("the root config imports without throwing and lists the guard as its globalSetup", () => {
    expect(cfg.root.test?.globalSetup).toEqual([GUARD]);
  });

  it.each(["base", "unit", "mock", "e2e", "workflow"])("%s declares no globalSetup", (name) => {
    expect(cfg[name].test?.globalSetup ?? []).toEqual([]);
  });

  it.each(["root", "unit", "mock", "e2e", "workflow"])("%s resolves setupFiles to include tests/setup.mjs", (name) => {
    expect(cfg[name].test?.setupFiles ?? []).toContain("tests/setup.mjs");
  });

  it("the workflow config extends the base and collects only workflow-driven files", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "vitest.config.workflow.mjs"), "utf8");
    expect(src).toMatch(/import\s+base\s+from\s+["']\.\/vitest\.config\.base\.mjs["']/);
    expect(src).toMatch(/mergeConfig\s*\(\s*base/);
    expect(cfg.workflow.test?.include).toEqual(["tests/integration/**/*.workflow.test.*"]);
    expect(matchesAny(cfg.workflow.test.include, SMOKE)).toBe(true);
  });

  it("the root include collects the probe and no tier include does", () => {
    expect(matchesAny(cfg.unit.test.include, "tests/unit/root-vitest-config-gate.test.mjs")).toBe(true);
    expect(matchesAny(cfg.root.test.include, PROBE)).toBe(true);
    for (const name of ["unit", "mock", "e2e", "workflow"]) {
      expect(matchesAny(cfg[name].test?.include ?? [], PROBE), `${name} collects the probe`).toBe(false);
    }
  });

  it("the root include matches neither the guard module nor packages/mcp-rks/__tests__ (G2)", () => {
    expect(matchesAny(cfg.root.test.include, GUARD)).toBe(false);
    expect(matchesAny(cfg.root.test.include, "packages/mcp-rks/__tests__/x.test.mjs")).toBe(false);
  });

  it("the root include and exclude are unchanged (Option A rejected)", () => {
    expect(cfg.root.test.include).toEqual(["tests/**/*.test.*", "tests/**/*.spec.*"]);
    expect(cfg.root.test.exclude).toEqual(["tests/.tmp/**"]);
  });
});

describe("7. no supported invocation relies on the bare root config", () => {
  it("the release-smoke assert step uses the workflow config", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "release-smoke.yml"), "utf8");
    expect(src).toContain("npx vitest run --config vitest.config.workflow.mjs tests/integration/release-smoke.workflow.test.mjs");
  });

  it("every vitest run line under .github/workflows passes --config", () => {
    const dir = path.join(REPO_ROOT, ".github", "workflows");
    const offenders = [];
    for (const name of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      fs.readFileSync(path.join(dir, name), "utf8").split("\n").forEach((line, i) => {
        if (/\bvitest run\b/.test(line) && !/--config\b/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every package.json script that runs vitest passes --config", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const offenders = Object.entries(pkg.scripts ?? {})
      .filter(([, cmd]) => /vitest/.test(cmd) && !/--config\b/.test(cmd))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
