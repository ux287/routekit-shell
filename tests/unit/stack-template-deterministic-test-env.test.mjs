import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { initProjectFromStack } from "../../packages/cli/src/project/init-stack.js";

// backlog.feat.stack-template-deterministic-test-env (ARCH Option A)
//
// The app.web.react.spa stack template must be a COMPLETE runnable node
// manifest: the full dependency set (incl. @vitejs/plugin-react, fixing UAT N1)
// + a jsdom-default vitest config + a child-safe cleanup/jest-dom setup, all
// living UNDER skeleton/ so the per-stack skeleton copy delivers them.
//
// The static checks (manifest completeness, config resolution, setup structure,
// base neutrality, scaffold precedence) run with only `vitest` available — the
// shell does NOT install the DOM toolchain. The LIVE out-of-the-box fitness
// (scaffold -> npm install -> render a DOM component) is a slow subprocess and
// is `it.skip`'d per the repo's slow-subprocess convention (cf.
// tests/project-bootstrap.test.mjs), authored with 120s timeouts so it
// satisfies tests/unit/subprocess-timeout-convention.test.mjs when un-skipped.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skeletonDir = path.join(repoRoot, "templates", "app.web.react.spa", "skeleton");
const pkgPath = path.join(skeletonDir, "package.json");
const stackConfigPath = path.join(skeletonDir, "vitest.config.base.mjs");
const setupPath = path.join(skeletonDir, "vitest.setup.mjs");
const baseConfigPath = path.join(repoRoot, "templates", "base", "vitest.config.base.mjs");

const resolveConfig = async (p) => {
  const mod = await import(pathToFileURL(p).href);
  return typeof mod.default === "function"
    ? await mod.default({ mode: "test", command: "serve" })
    : mod.default;
};

describe("app.web.react.spa manifest is complete & runnable (static, no install)", () => {
  let pkg;
  beforeAll(() => {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); // also proves valid JSON
  });

  it("declares @vitejs/plugin-react (fixes UAT N1 — vite.config.ts imports it)", () => {
    expect(pkg.devDependencies?.["@vitejs/plugin-react"]).toBeTypeOf("string");
  });

  it("declares the full DOM test toolchain", () => {
    for (const dep of ["vitest", "jsdom", "@testing-library/react", "@testing-library/jest-dom"]) {
      expect(pkg.devDependencies?.[dep], `missing devDependency ${dep}`).toBeTypeOf("string");
    }
  });

  it("defines a `test` script of `vitest run`", () => {
    expect(pkg.scripts?.test).toBe("vitest run");
  });

  it("added version ranges are non-empty and consistent with the existing react/vite", () => {
    for (const dep of [
      "@vitejs/plugin-react",
      "vitest",
      "jsdom",
      "@testing-library/react",
      "@testing-library/jest-dom",
    ]) {
      expect(pkg.devDependencies[dep], `${dep} range`).toMatch(/\d+\.\d+/);
    }
    expect(pkg.dependencies.react).toMatch(/18\./);
    expect(pkg.devDependencies.vite).toMatch(/5\./);
  });
});

describe("jsdom stack config + child-safe setup (static, resolved)", () => {
  it("the stack config defaults test.environment === 'jsdom'", async () => {
    const cfg = await resolveConfig(stackConfigPath);
    expect(cfg.test?.environment).toBe("jsdom");
  });

  it("the stack config references the child-safe ./vitest.setup.mjs (no shell-only path)", async () => {
    const cfg = await resolveConfig(stackConfigPath);
    const setupFiles = cfg.test?.setupFiles ?? [];
    const arr = Array.isArray(setupFiles) ? setupFiles : [setupFiles];
    expect(arr.some((s) => /vitest\.setup\.mjs$/.test(s))).toBe(true);
    expect(arr).not.toContain("tests/setup.mjs");
  });

  it("the setup file wires afterEach(cleanup) + jest-dom matchers, template-local", () => {
    // The shell does not install @testing-library/*, so the setup cannot be
    // imported here; assert its wiring structurally. The LIVE fitness (below)
    // proves the behavior in a real install.
    const src = fs.readFileSync(setupPath, "utf8");
    expect(src).toMatch(/@testing-library\/react/);
    expect(src).toMatch(/cleanup/);
    expect(src).toMatch(/@testing-library\/jest-dom/);
    expect(src).toMatch(/afterEach\s*\(/);
    expect(src).not.toMatch(/tests\/setup\.mjs/);
  });
});

describe("precedence + base neutrality", () => {
  it("the generic templates/base config stays stack-neutral (no jsdom)", async () => {
    const base = await resolveConfig(baseConfigPath);
    expect(base.test?.environment).not.toBe("jsdom");
  });

  it("a scaffolded child receives the skeleton's jsdom config at its root (skeleton wins)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-stack-precedence-"));
    try {
      await initProjectFromStack({
        shellRoot: repoRoot,
        id: "precedence-probe",
        stackId: "app.web.react.spa",
        targetPath: tmp,
      });
      const childConfig = path.join(tmp, "vitest.config.base.mjs");
      const childSetup = path.join(tmp, "vitest.setup.mjs");
      expect(fs.existsSync(childConfig), "child got vitest.config.base.mjs").toBe(true);
      expect(fs.existsSync(childSetup), "child got vitest.setup.mjs").toBe(true);
      // The delivered config is byte-identical to the skeleton's jsdom config
      // (resolved to jsdom above) — i.e. the child resolves environment:'jsdom',
      // NOT the generic node base ensureVitestRunner copies no-overwrite.
      expect(fs.readFileSync(childConfig, "utf8")).toBe(fs.readFileSync(stackConfigPath, "utf8"));
      expect(fs.readFileSync(childConfig, "utf8")).toMatch(/environment:\s*["']jsdom["']/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("out-of-the-box DOM fitness (live, slow subprocess)", () => {
  // Slow: a real `npm install` of react+vite+testing-library + a child vitest
  // run. Skipped in normal CI per the repo's slow-subprocess convention (cf.
  // tests/project-bootstrap.test.mjs `it.skip`). 120s timeouts so it satisfies
  // tests/unit/subprocess-timeout-convention.test.mjs when un-skipped.
  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("a freshly-scaffolded child renders a DOM component with NO per-file environment pragma", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-stack-fitness-"));
    try {
      await initProjectFromStack({
        shellRoot: repoRoot,
        id: "fitness-probe",
        stackId: "app.web.react.spa",
        targetPath: tmp,
      });
      const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(install.status, install.stderr).toBe(0);

      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "src", "smoke.test.tsx"),
        [
          'import { render, screen } from "@testing-library/react";',
          'import { test, expect } from "vitest";',
          'test("renders a DOM node", () => {',
          '  render(<div>hello-rks</div>);',
          '  expect(screen.getByText("hello-rks")).toBeInTheDocument();',
          "});",
          "",
        ].join("\n"),
      );
      const run = spawnSync("npm", ["test"], { cwd: tmp, encoding: "utf8", timeout: 120_000 });
      expect(run.status, run.stdout + run.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // skip-debt-tracked-in: backlog.fix.slow-subprocess-test-pattern
  it.skip("vite.config.ts config-load resolves @vitejs/plugin-react after install", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-stack-vite-"));
    try {
      await initProjectFromStack({
        shellRoot: repoRoot,
        id: "vite-probe",
        stackId: "app.web.react.spa",
        targetPath: tmp,
      });
      const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(install.status, install.stderr).toBe(0);
      const build = spawnSync("npx", ["vite", "build", "--logLevel", "silent"], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(build.status, build.stdout + build.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
