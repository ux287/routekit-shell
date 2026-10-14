/**
 * backlog.fix.scaffold-ships-routekit-blind-gitignore — the CONTENT half.
 *
 * A base-stack child receives templates/base/skeleton/.gitignore, copied wholesale
 * by init-stack.js. That copy lands BEFORE bootstrap.mjs would seed the
 * RouteKit-aware templates/base/.gitignore, and the seed only fires when the
 * destination is absent — so the skeleton copy permanently wins. It shipped with
 * no .rks, .routekit or .dendron entries at all, which is why three child projects
 * started with a dirty tree and `git add -A` would have swept a LanceDB store,
 * embeddings, a fetch cache, telemetry and session state into a public repo.
 *
 * The two template files must now agree on the runtime namespace. Parity is
 * COMPUTED from both files at run time rather than checked against a hardcoded
 * roster, so a rule added to one and forgotten in the other is named rather than
 * silently tolerated.
 *
 * TIER: pure fs reads of files already in the repo — no spawn, no fixture. Per
 * tests/unit/README.md criteria 1 and 2 this belongs in the unit tier. (Note that
 * unit-tier-purity rule A would in fact tolerate a spawn carrying an explicit
 * timeout; the documented convention, not that enforcer, is the governing ground.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const BASE = join(ROOT, "templates/base/.gitignore");
const SKELETON = join(ROOT, "templates/base/skeleton/.gitignore");

/** Non-comment, non-blank rule lines. */
function rulesOf(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** The namespace this story governs. Everything else is generic and out of scope. */
const RUNTIME_PREFIXES = [".rks/", ".routekit/", ".dendron.", "notes/.dendron."];
const isRuntimeRule = (rule) => RUNTIME_PREFIXES.some((p) => rule.startsWith(p));
const runtimeSetOf = (path) => new Set(rulesOf(path).filter(isRuntimeRule));

describe("template .gitignore — runtime-namespace parity", () => {
  const baseSet = runtimeSetOf(BASE);
  const skeletonSet = runtimeSetOf(SKELETON);

  it("classifies at least 18 runtime rules in templates/base/.gitignore", () => {
    // ANTI-VACUITY. Two identically-empty sets are equal, so parity alone proves
    // nothing. This floor is what stops the parity assertion passing by
    // classifying nothing. It is a floor, not a ceiling — the sibling story
    // backlog.fix.upgrade-leaves-child-tree-dirty raises it to 19.
    expect(baseSet.size).toBeGreaterThanOrEqual(18);
  });

  it("the two files carry the identical runtime-rule set", () => {
    // Compared in both directions, and the failure names the offending entry and
    // the file that lacks it rather than printing two opaque sets.
    for (const rule of baseSet) {
      expect(skeletonSet.has(rule), `${rule} is in base/.gitignore but missing from skeleton/.gitignore`).toBe(true);
    }
    for (const rule of skeletonSet) {
      expect(baseSet.has(rule), `${rule} is in skeleton/.gitignore but missing from base/.gitignore`).toBe(true);
    }
  });

  it("carries the two rules this story adds", () => {
    // .rks/fetch-cache/ is written at packages/mcp-rks/src/agents/fetch-raw.mjs.
    // .routekit/context-state.json is already classified as a runtime artifact by
    // RKS_RUNTIME_ARTIFACT_PATTERNS, which the templates disagreed with.
    expect(rulesOf(BASE)).toContain(".rks/fetch-cache/");
    expect(rulesOf(BASE)).toContain(".routekit/context-state.json");
  });

  it("preserves all nineteen pre-existing generic skeleton rules", () => {
    // Asserted individually so a deletion is named. The story originally said
    // FIFTEEN — that was a count of dot-bearing lines and silently licensed
    // deleting node_modules/, dist/, build/ and coverage/.
    const rules = rulesOf(SKELETON);
    for (const rule of [
      "node_modules/", "dist/", "build/", "*.tsbuildinfo",
      ".turbo/", ".vite/", ".cache/", "coverage/",
      ".env", ".env.local", ".env.*.local",
      "*.log", "npm-debug.log*",
      ".DS_Store", "Thumbs.db",
      ".idea/", ".vscode/", "*.swp", "*.swo",
    ]) {
      expect(rules, `generic rule ${rule} was dropped`).toContain(rule);
    }
  });

  it("adds no catch-all to either file", () => {
    // A catch-all would ignore .rks/project.json and .rks/prompts/, which are
    // tracked project content. tests/unit/intervention-receipt-child-delivery.test.mjs
    // independently forbids this on the base file.
    for (const path of [BASE, SKELETON]) {
      const rules = rulesOf(path);
      for (const forbidden of [".rks/", ".rks/*", ".routekit/", ".routekit/*", "*"]) {
        expect(rules, `${path} must not contain the catch-all ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("leaves tracked config uncovered by the skeleton rules", () => {
    // A rules-classification assertion over the template text — neither path needs
    // to exist anywhere. The real git check-ignore proof lives in the integration
    // tier; this is the cheap text-level counterpart.
    const rules = rulesOf(SKELETON);
    const covers = (rule, path) => (rule.endsWith("/") ? path.startsWith(rule) : path === rule);
    for (const tracked of [".rks/project.json", ".rks/prompts/governor-qa.md"]) {
      for (const rule of rules) {
        expect(covers(rule, tracked), `${rule} must not cover tracked config ${tracked}`).toBe(false);
      }
    }
  });
});
