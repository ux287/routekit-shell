/**
 * backlog.fix.rag-config-loader-root-fallback — repo-root resolution.
 *
 * The defect was DORMANT: findRepoRoot's last stage was
 *   return path.resolve(startDir, "../../../..")
 * — four upward hops from a three-deep module, landing on the repository's PARENT. In this
 * workspace the marker walk succeeds at hop 3 (root package.json declares "workspaces"), so
 * the fallback is never reached and an in-repo test proves nothing.
 *
 * So every fallback-path case here ARMS the defect: it drives resolution from a synthetic
 * fixture tree where no ancestor within the 10-hop bound carries a matching marker. QA ruled
 * for THROW (option b) over a corrected hop count, so those cases assert an explicit error.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs \
 *     tests/unit/rag-config-loader-repo-root.test.mjs tests/unit/rag-tools.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const LOADER_SRC = path.join(REPO_ROOT, "packages", "rag", "src", "rag-config-loader.mjs");
const REAL_LOADER_DIR = path.dirname(LOADER_SRC);

/** macOS os.tmpdir() is a /var symlink into /private/var; path.resolve does not follow it. */
const real = (p) => fs.realpathSync(p);

const tempDirs = [];
function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-root-"));
  tempDirs.push(dir);
  return real(dir);
}

/**
 * Build a fixture tree and copy the loader into it, so the copied module's own __dirname is
 * the fixture directory and module-load-time resolution runs for real.
 * @returns {{root: string, moduleDir: string, modulePath: string}}
 */
function makeFixture(relSegments, { consumerPackageJson = null } = {}) {
  const root = makeTempRoot();
  const moduleDir = path.join(root, ...relSegments);
  fs.mkdirSync(moduleDir, { recursive: true });

  if (consumerPackageJson) {
    fs.writeFileSync(
      path.join(root, consumerPackageJson.dir, "package.json"),
      JSON.stringify(consumerPackageJson.contents, null, 2),
    );
  }

  const modulePath = path.join(moduleDir, "rag-config-loader.mjs");
  // The loader statically imports only node builtins, so it loads standalone.
  fs.copyFileSync(LOADER_SRC, modulePath);
  return { root, moduleDir, modulePath };
}

let savedRepoRootEnv;

beforeEach(() => {
  savedRepoRootEnv = process.env.ROUTEKIT_REPO_ROOT;
});

afterEach(() => {
  if (savedRepoRootEnv === undefined) delete process.env.ROUTEKIT_REPO_ROOT;
  else process.env.ROUTEKIT_REPO_ROOT = savedRepoRootEnv;

  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

/** Every walk/throw case MUST prove the env short-circuit is genuinely disarmed. */
function disarmEnv() {
  delete process.env.ROUTEKIT_REPO_ROOT;
  expect(process.env.ROUTEKIT_REPO_ROOT).toBeUndefined();
}

describe("findRepoRoot — the dormant fixed-depth fallback is gone", () => {
  it("ARMS THE DEFECT: a no-marker three-deep fixture throws instead of returning the tree's parent", async () => {
    disarmEnv();
    const { root, moduleDir, modulePath } = makeFixture(["pkgroot", "rag", "src"]);

    // Module-load-time resolution: the copied module's repoRoot is computed on import,
    // so a marker-less layout must fail eagerly at import.
    await expect(import(pathToFileURL(modulePath).href)).rejects.toThrow(
      /Could not locate the repository root/,
    );

    // And the old behaviour is specifically excluded: four hops from <root>/pkgroot/rag/src
    // is <root>'s PARENT (os.tmpdir()). Under the old code this test fails by returning it.
    const { findRepoRoot } = await import(pathToFileURL(LOADER_SRC).href);
    let returned = null;
    try {
      returned = findRepoRoot(moduleDir);
    } catch { /* expected */ }
    expect(returned).toBeNull();
    expect(returned).not.toBe(real(path.dirname(root)));
    expect(returned).not.toBe(root);
  });

  it("OSS-DISTRIBUTION LAYOUT: a node_modules/@routekit/rag/src shape at a different depth throws", async () => {
    disarmEnv();
    const { root, moduleDir } = makeFixture(
      ["consumer-app", "node_modules", "@routekit", "rag", "src"],
      {
        // A real package.json that is NOT a routekit-shell root — the walk must reject it.
        consumerPackageJson: {
          dir: "consumer-app",
          contents: { name: "some-consumer-app", version: "1.0.0", private: true },
        },
      },
    );

    const { findRepoRoot } = await import(pathToFileURL(LOADER_SRC).href);
    expect(() => findRepoRoot(moduleDir)).toThrow(/Could not locate the repository root/);

    // Depth-independence: none of the plausible-looking ancestors may be returned.
    for (const candidate of [
      path.join(root, "consumer-app"),
      path.join(root, "consumer-app", "node_modules"),
      path.join(root, "consumer-app", "node_modules", "@routekit"),
      root,
    ]) {
      let returned = null;
      try {
        returned = findRepoRoot(moduleDir);
      } catch { /* expected */ }
      expect(returned).not.toBe(candidate);
    }
  });

  it("HAPPY-PATH INVARIANCE: resolving from the real packages/rag/src still returns the repo root", async () => {
    disarmEnv();
    const { findRepoRoot } = await import(pathToFileURL(LOADER_SRC).href);

    const resolved = real(findRepoRoot(REAL_LOADER_DIR));
    expect(resolved).toBe(real(REPO_ROOT));

    // ...and it really was the marker walk that found it.
    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(resolved, "package.json"), "utf8"),
    );
    expect(Boolean(rootPkg.workspaces) || String(rootPkg.name).startsWith("routekit-shell")).toBe(
      true,
    );
  });

  it("ERROR MESSAGE CONTRACT: names the start dir, the markers, and the ROUTEKIT_REPO_ROOT remedy", async () => {
    disarmEnv();
    const { moduleDir } = makeFixture(["pkgroot", "rag", "src"]);
    const { findRepoRoot } = await import(pathToFileURL(LOADER_SRC).href);

    let message = "";
    try {
      findRepoRoot(moduleDir);
    } catch (e) {
      message = e.message;
    }

    expect(message).toContain(moduleDir);
    expect(message).toContain("workspaces");
    expect(message).toContain("routekit-shell");
    expect(message).toContain("ROUTEKIT_REPO_ROOT");
  });
});

describe("findRepoRoot — ROUTEKIT_REPO_ROOT escape hatch (contrasting pair)", () => {
  it("SET: returns the value verbatim, with no walk and no throw, even at a no-marker fixture", async () => {
    const { moduleDir } = makeFixture(["pkgroot", "rag", "src"]);
    const { findRepoRoot } = await import(pathToFileURL(LOADER_SRC).href);

    // Deliberately a non-existent, non-normalized path: proves it is returned VERBATIM
    // without filesystem work or realpath normalization.
    const sentinel = path.join(os.tmpdir(), "definitely-not-a-real-repo-root-sentinel");
    process.env.ROUTEKIT_REPO_ROOT = sentinel;

    expect(findRepoRoot(moduleDir)).toBe(sentinel);
  });

  it("UNSET: the very same fixture throws — proving the short-circuit was the cause", async () => {
    const { moduleDir } = makeFixture(["pkgroot", "rag", "src"]);
    const { findRepoRoot } = await import(pathToFileURL(LOADER_SRC).href);

    disarmEnv();
    expect(() => findRepoRoot(moduleDir)).toThrow(/Could not locate the repository root/);
  });

  it("MODULE-CACHE CORRECTNESS: two consecutive load-time cases on unique paths differ in outcome", async () => {
    // Case A — env set at load time: the copied module imports cleanly.
    const a = makeFixture(["pkgroot", "rag", "src"]);
    process.env.ROUTEKIT_REPO_ROOT = REPO_ROOT;
    const modA = await import(pathToFileURL(a.modulePath).href);
    expect(typeof modA.getRagPathsFor).toBe("function");

    // Case B — env unset, a DIFFERENT temp path (distinct file URL => distinct ESM module,
    // so the frozen module-load-time repoRoot of case A cannot leak in).
    const b = makeFixture(["pkgroot", "rag", "src"]);
    expect(b.modulePath).not.toBe(a.modulePath);
    disarmEnv();
    await expect(import(pathToFileURL(b.modulePath).href)).rejects.toThrow(
      /Could not locate the repository root/,
    );
  });
});

describe("rag-config-loader — source and export-surface contracts", () => {
  it("NO UNVALIDATED FIXED DEPTH REMAINS in the source", () => {
    const src = fs.readFileSync(LOADER_SRC, "utf8");

    // The four-hop literal must be gone from executable code. It survives only inside the
    // explanatory comment, so strip comments before asserting.
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(withoutComments).not.toContain("../../../..");
    expect(withoutComments).not.toContain("../../..");
  });

  it("EXPORT SURFACE: getRagPathsFor and getRagConfigFor unchanged, findRepoRoot added", async () => {
    process.env.ROUTEKIT_REPO_ROOT = REPO_ROOT;
    const mod = await import(pathToFileURL(LOADER_SRC).href);

    expect(typeof mod.getRagPathsFor).toBe("function");
    expect(typeof mod.getRagConfigFor).toBe("function");
    expect(typeof mod.findRepoRoot).toBe("function");
    expect(mod.findRepoRoot.length).toBe(1); // takes startDir
  });

  it("BARREL UNCHANGED: findRepoRoot is not exported from packages/rag/src/index.mjs", () => {
    const barrel = fs.readFileSync(
      path.join(REPO_ROOT, "packages", "rag", "src", "index.mjs"),
      "utf8",
    );
    expect(barrel).not.toContain("findRepoRoot");
    expect(barrel).not.toContain("rag-config-loader");
  });

  it("BLAST RADIUS: all four consumers still import the same bindings from ./rag-config-loader.mjs", () => {
    const ragSrc = path.join(REPO_ROOT, "packages", "rag", "src");
    const expected = {
      "embed.mjs": ["getRagPathsFor"],
      "query.mjs": ["getRagPathsFor"],
      "tools.mjs": ["getRagPathsFor"],
      "init.mjs": ["getRagConfigFor", "getRagPathsFor"],
    };

    for (const [file, bindings] of Object.entries(expected)) {
      const src = fs.readFileSync(path.join(ragSrc, file), "utf8");
      const importLine = src
        .split("\n")
        .find((l) => l.includes("rag-config-loader.mjs") && l.includes("import"));
      expect(importLine, `${file} must import from ./rag-config-loader.mjs`).toBeTruthy();
      expect(importLine).toMatch(/["']\.\/rag-config-loader\.mjs["']/);
      for (const binding of bindings) {
        expect(importLine, `${file} must still bind ${binding}`).toContain(binding);
      }
    }
  });
});

describe("rag-config-loader — live-path invariance", () => {
  it("LIVE PATH: getRagPathsFor derives paths that all stay under the repo root", async () => {
    process.env.ROUTEKIT_REPO_ROOT = REPO_ROOT;
    const { getRagPathsFor } = await import(pathToFileURL(LOADER_SRC).href);

    const paths = await getRagPathsFor(REPO_ROOT);

    for (const key of ["unified", "notes", "code", "kg"]) {
      expect(paths, `missing ${key}`).toHaveProperty(key);
      const resolved = path.resolve(String(paths[key]));
      const rel = path.relative(real(REPO_ROOT), real(path.dirname(resolved)));
      // Derivation only — never escapes above the repo root.
      expect(rel.startsWith(".."), `${key} escaped the repo root: ${resolved}`).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
    }
  });
});
