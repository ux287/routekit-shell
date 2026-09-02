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

/**
 * backlog.fix.rag-module-dangling-imports-mcp-agents — WIDENED GUARD.
 *
 * Everything above this point is an OLD-PATH detector: it knows the string `scripts/rag/<mod>.mjs`
 * and looks for it. That premise is why it could not see the defect this section exists for.
 * Three agents referenced `../server/rag.mjs` — a THIRD path, neither the old real location nor
 * the new one, valid at no point in the project's history. No relocation-keyed pattern can ever
 * match a path that was never right.
 *
 * So this guard is PREMISE-FREE: it does not know any wrong string. It extracts every reference
 * an agent module makes and asserts each one RESOLVES. A future move breaks the test instead of
 * the user, whatever the new or old paths happen to be.
 */
const AGENTS_DIR = "packages/mcp-rks/src/agents";

/** Every relative import specifier and every path.join(projectRoot, '<...>.mjs') argv target. */
function extractAgentReferences(src) {
  const out = [];
  // Must begin "./" or "../" — an ES relative specifier. A bare leading dot is NOT enough:
  // data paths like '.rks/project.json' start with a dot and are not modules.
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"`](\.\.?\/[^'"`]*)['"`]/g)) {
    out.push({ kind: "relative", spec: m[1] });
  }
  for (const m of src.matchAll(/path\.join\(\s*projectRoot\s*,\s*['"`]([^'"`]+\.mjs)['"`]/g)) {
    out.push({ kind: "argv", spec: m[1] });
  }
  return out;
}

/** True when the reference names something that exists on disk. */
function resolveAgentReference(fileAbs, ref, repoRoot) {
  const base =
    ref.kind === "argv"
      ? path.join(repoRoot, ref.spec)
      : path.resolve(path.dirname(fileAbs), ref.spec);
  return [base, `${base}.mjs`, `${base}.js`, path.join(base, "index.mjs"), path.join(base, "index.js")]
    .some((c) => fs.existsSync(c));
}

function agentFiles() {
  const dir = path.join(REPO_ROOT, AGENTS_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => path.join(dir, f));
}

describe("agent modules reference nothing that does not exist (premise-free)", () => {
  it("every reference under packages/mcp-rks/src/agents resolves", () => {
    const unresolved = [];
    for (const file of agentFiles()) {
      const src = fs.readFileSync(file, "utf8");
      for (const ref of extractAgentReferences(src)) {
        if (!resolveAgentReference(file, ref, REPO_ROOT)) {
          unresolved.push(`${path.relative(REPO_ROOT, file)} -> ${ref.spec} (${ref.kind})`);
        }
      }
    }
    expect(unresolved, `agent modules reference paths that do not exist:\n${unresolved.join("\n")}`).toEqual([]);
  });

  // NON-VACUITY BY EMPTY EXTRACTION. An extractor whose regex matched nothing would report zero
  // unresolved and sail past every negative control below. Floor applies to the RELATIVE arm only:
  // the argv arm legitimately extracts ZERO once this story lands, and a floor there would red a
  // correct tree.
  it("the extractor actually finds references (floor on the relative arm)", () => {
    const rel = agentFiles()
      .flatMap((f) => extractAgentReferences(fs.readFileSync(f, "utf8")))
      .filter((r) => r.kind === "relative");
    expect(rel.length).toBeGreaterThanOrEqual(10);
  });

  // NEGATIVE CONTROL — the exact line this story removed. Kept as a FIXTURE so the proof that this
  // guard would have caught the defect survives the defect's removal. This fixture necessarily
  // contains the old literal; that is required, and it must not be deleted to satisfy the
  // premise-freedom check below, whose scope is the extractor/resolver only.
  it("WOULD HAVE CAUGHT IT: the pre-fix line is reported unresolved", () => {
    const preFix = `  const ragMod = await import('../server/rag.mjs');`;
    const refs = extractAgentReferences(preFix);
    expect(refs).toHaveLength(1);
    const containing = path.join(REPO_ROOT, AGENTS_DIR, "story.mjs");
    expect(resolveAgentReference(containing, refs[0], REPO_ROOT)).toBe(false);
  });

  it("synthetic controls: fake paths flagged, real ones and bare specifiers not", () => {
    const containing = path.join(REPO_ROOT, AGENTS_DIR, "story.mjs");
    const fake = extractAgentReferences(`import x from './definitely-not-here.mjs';`)[0];
    expect(resolveAgentReference(containing, fake, REPO_ROOT)).toBe(false);

    const real = extractAgentReferences(`import { loadAgentConfig } from './config.mjs';`)[0];
    expect(resolveAgentReference(containing, real, REPO_ROOT)).toBe(true);

    const fakeArgv = extractAgentReferences(`path.join(projectRoot, 'packages/nope/missing.mjs')`)[0];
    expect(fakeArgv.kind).toBe("argv");
    expect(resolveAgentReference(containing, fakeArgv, REPO_ROOT)).toBe(false);

    // Bare package specifiers are out of scope by construction — only "." specifiers are captured.
    expect(extractAgentReferences(`import { runRagEmbed } from '@routekit/rag';`)).toEqual([]);
  });

  // PREMISE-FREEDOM. Scoped to the extractor and resolver IMPLEMENTATIONS — deliberately NOT a
  // whole-file self-read (the form used at :113-115 above), because the negative-control fixture
  // must contain the old literal. If either function ever learns a specific wrong string, this
  // guard has regressed into the old-path detector it was written to replace.
  it("the extractor and resolver know no specific wrong path", () => {
    const impl = extractAgentReferences.toString() + resolveAgentReference.toString();
    expect(impl).not.toContain("server/rag");
    expect(impl).not.toContain("scripts/rag");
  });
});
