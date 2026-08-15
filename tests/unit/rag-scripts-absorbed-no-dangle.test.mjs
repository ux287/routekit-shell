/**
 * Zero-dangle guard — backlog.feat.rag-package-absorb-scripts-stage3.
 *
 * Stage 3 moved the RAG pipeline (embed/query/init/utils/benchmark-chunker) OUT of scripts/rag/ and
 * INTO packages/rag/src/. That path is referenced by *string* across ~30 files (import specifiers,
 * dynamic import() args, spawn/exec argv, package.json script values, CI workflow run steps, a
 * deployed hook, a guardrail corePattern). A prior naive `git mv` (c4899502) died with ~13 residual
 * failures precisely because a handful of those string sites were missed. This test converts that
 * hazard into an enforced invariant: any FUNCTIONAL surviving reference to the five relocated
 * modules fails the suite loudly, naming the file and line.
 *
 * SCOPE — FUNCTIONAL references only (the forms that actually break at runtime):
 *   - static import specifiers:  from '.../scripts/rag/<mod>.mjs'
 *   - dynamic import() args:      import(... 'scripts/rag/<mod>.mjs' ...)
 *   - node CLI / npm script / CI: node .../scripts/rag/<mod>.mjs
 *   - spawn/exec argv arrays:     ["scripts/rag/<mod>.mjs"]
 *   - guardrail corePattern:      'scripts/rag/'  (bare dir literal)
 *
 * DELIBERATELY NOT flagged (asserted below):
 *   - templates/** — template-scaffolded projects legitimately keep their OWN scripts/rag/ layout.
 *   - notes/**, .git — history / prose, not runtime.
 *   - the synthetic classifier input 'scripts/rag/query.js' (a .js path, not a relocated .mjs module).
 *   - comment / docstring mentions (e.g. rag-columns.mjs, query-intent.mjs) — non-functional.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globby } from "globby";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SELF = "tests/unit/rag-scripts-absorbed-no-dangle.test.mjs";

const MODULES = "embed|query|init|utils|benchmark-chunker";

// One matcher per FUNCTIONAL form. Each returns a label when the line contains a functional
// reference to a relocated scripts/rag/<module>.mjs. Comment/label string mentions do NOT match any.
const FUNCTIONAL_PATTERNS = [
  ["static-import", new RegExp(`\\bfrom\\s*['"\`][^'"\`]*scripts/rag/(?:${MODULES})\\.mjs['"\`]`)],
  ["dynamic-import", new RegExp(`\\bimport\\s*\\([^)]*['"\`][^'"\`]*scripts/rag/(?:${MODULES})\\.mjs`)],
  ["node-invocation", new RegExp(`\\bnode\\s+[^\\s'"\`]*scripts/rag/(?:${MODULES})\\.mjs`)],
  ["spawn-argv", new RegExp(`\\[\\s*['"\`]scripts/rag/(?:${MODULES})\\.mjs['"\`]`)],
  ["core-pattern", new RegExp(`['"\`]scripts/rag/['"\`]`)],
];

/**
 * Return the functional-form labels a single line matches (empty array = clean / non-functional).
 * @param {string} line
 * @returns {string[]}
 */
export function functionalDangleKinds(line) {
  return FUNCTIONAL_PATTERNS.filter(([, re]) => re.test(line)).map(([label]) => label);
}

let violations = [];

beforeAll(async () => {
  const files = await globby(
    [
      "packages/**/*.{mjs,js,ts,json}",
      "scripts/**/*.{mjs,js}",
      "src/**/*.{mjs,js,ts}",
      "tests/**/*.{mjs,js,json}",
      ".github/**/*.{yml,yaml}",
      ".routekit/hooks/**/*.mjs",
      "package.json",
    ],
    {
      cwd: REPO_ROOT,
      gitignore: false,
      ignore: [
        "**/node_modules/**",
        "templates/**",
        "notes/**",
        "**/.rks/**",
        "**/hooks.bak/**",
        "**/dist/**",
        "**/coverage/**",
        SELF,
      ],
    },
  );

  const found = [];
  for (const rel of files.sort()) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const kinds = functionalDangleKinds(lines[i]);
      if (kinds.length) found.push(`${rel}:${i + 1} [${kinds.join(",")}] ${lines[i].trim().slice(0, 100)}`);
    }
  }
  violations = found;
}, 30_000);

describe("RAG scripts absorbed — zero functional dangling references", () => {
  it("no FUNCTIONAL reference to the five relocated scripts/rag/*.mjs modules survives anywhere", () => {
    expect(
      violations,
      `Dangling functional reference(s) to relocated scripts/rag modules — repoint to packages/rag/src/* ` +
        `(or the @routekit/rag/* barrel for import specifiers):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("guard precision — no false positives, no false negatives", () => {
  it("does NOT flag a template path (template projects keep their own scripts/rag/ layout)", () => {
    expect(functionalDangleKinds(`import { embed } from '../templates/app-web/scripts/rag/embed.mjs';`)).toContain(
      "static-import",
    );
    // ...but the guard EXCLUDES templates/** at the file level, so no template file is ever scanned.
    // Assert the exclusion is present in the ignore list of this very file (durable source check).
    const self = fs.readFileSync(path.join(REPO_ROOT, SELF), "utf8");
    expect(self).toContain('"templates/**"');
    expect(self).toContain('"notes/**"');
  });

  it("does NOT match the synthetic classifier input 'scripts/rag/query.js' (.js, not a relocated module)", () => {
    expect(functionalDangleKinds(`const input = "scripts/rag/query.js";`)).toEqual([]);
    expect(functionalDangleKinds(`import x from "../../scripts/rag/query.js";`)).toEqual([]);
  });

  it("does NOT match comment / prose mentions of the relocated modules", () => {
    expect(functionalDangleKinds(` * (scripts/rag/embed.mjs) and BOTH readers (scripts/rag/query.mjs CLI, and`)).toEqual([]);
    expect(functionalDangleKinds(`// relocated from scripts/rag/ INTO packages/rag/src/`)).toEqual([]);
    expect(functionalDangleKinds(`describe("scripts/rag/query.mjs — behavior", () => {`)).toEqual([]);
  });

  it("DOES flag each functional form (guard is not vacuously green)", () => {
    expect(functionalDangleKinds(`import { embed } from '../../scripts/rag/embed.mjs';`)).toContain("static-import");
    expect(functionalDangleKinds(`const m = await import("../../scripts/rag/embed.mjs");`)).toContain("dynamic-import");
    expect(functionalDangleKinds(`  "rag:embed": "node scripts/rag/embed.mjs",`)).toContain("node-invocation");
    expect(functionalDangleKinds(`  const proc = spawn(node, ["scripts/rag/embed.mjs"], {`)).toContain("spawn-argv");
    expect(functionalDangleKinds(`  'scripts/rag/',`)).toContain("core-pattern");
  });
});
