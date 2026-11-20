import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "../../..");
const SELF = relative(ROOT, HERE).split("\\").join("/");

const RETIRED = [
  "packages/rag/src/benchmark.mjs",
  "packages/rag/src/metrics.mjs",
  "tests/rag/benchmark.test.mjs",
  "tests/rag/benchmark-queries.json",
];

// Literals are assembled so this file never matches its own sweep even if SELF exclusion regresses.
const FORBIDDEN = [
  ["@routekit/rag", "/benchmark"].join(""),
  ["@routekit/rag", "/metrics"].join(""),
  ["run", "Benchmark"].join(""),
  ["BENCHMARK", "_SYNTHETIC"].join(""),
  ["tests/rag", "/benchmark"].join(""),
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".tmp", ".rks", ".routekit"]);
const TEXT_EXT = /\.(mjs|cjs|js|ts|tsx|jsx|json|ya?ml|md)$/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (TEXT_EXT.test(name)) out.push(abs);
  }
  return out;
}

function sweepFiles() {
  const files = [];
  for (const d of ["packages", "tests", "scripts", ".github"]) {
    const abs = join(ROOT, d);
    if (existsSync(abs)) walk(abs, files);
  }
  for (const name of readdirSync(ROOT)) {
    if (/^vitest\.config\..*$/.test(name) || name === "package.json") files.push(join(ROOT, name));
  }
  return files.filter((f) => relative(ROOT, f).split("\\").join("/") !== SELF);
}

describe("retire legacy RAG benchmark", () => {
  it("the four retired files no longer exist", () => {
    for (const rel of RETIRED) {
      expect(existsSync(join(ROOT, rel)), rel).toBe(false);
    }
  });

  it("the answer-quality eval files are intact", async () => {
    const cases = join(ROOT, "tests/rag/answer-quality-cases.json");
    expect(existsSync(cases)).toBe(true);
    expect(() => JSON.parse(readFileSync(cases, "utf8"))).not.toThrow();
    const evaluator = join(ROOT, "packages/rag/src/answer-evaluator.mjs");
    expect(existsSync(evaluator)).toBe(true);
    await expect(import(pathToFileURL(evaluator).href)).resolves.toBeTypeOf("object");
  });

  it("no reference to the retired modules remains, with a positive control", () => {
    const files = sweepFiles();
    const offenders = [];
    let controlHits = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (src.includes("@routekit/rag")) controlHits++;
      for (const lit of FORBIDDEN) {
        if (src.includes(lit)) offenders.push(`${relative(ROOT, f)}: ${lit}`);
      }
    }
    expect(controlHits, "positive control: the sweep must see @routekit/rag somewhere").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("the barrel imports and the benchmark subpath does not resolve", async () => {
    const barrel = await import("@routekit/rag");
    expect(barrel).toBeTypeOf("object");
    const sub = ["@routekit/rag", "benchmark"].join("/");
    await expect(import(/* @vite-ignore */ sub)).rejects.toThrow();
  });

  it("the results note is marked retired and no longer instructs a benchmark run", () => {
    const note = readFileSync(join(ROOT, "notes/design.rag-benchmark-results.md"), "utf8");
    expect(note).toMatch(/retired/i);
    expect(note).toContain("backlog.chore.retire-legacy-rag-benchmark");
    expect(note).not.toContain("src/rag/benchmark.mjs");
    expect(note).not.toContain("benchmark.test.mjs");
  });
});
