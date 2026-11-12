/**
 * Zero-dangle guard — backlog.feat.telemetry-package-extraction.
 *
 * The telemetry subsystem moved OUT of packages/mcp-rks/src/server/telemetry/ and INTO
 * packages/telemetry/src/ (the @routekit/telemetry package). That directory was referenced by
 * *string* across ~45 files (import specifiers, dynamic import() args, vi.mock targets, source-file
 * reads, package.json/CI, split-arg path.join). This test converts that hazard into an enforced
 * invariant: any FUNCTIONAL surviving reference to the old server/telemetry/* module paths fails the
 * suite loudly, naming the file and line. Mirrors tests/unit/rag-scripts-absorbed-no-dangle.test.mjs
 * and IMPROVES on it (the RAG guard missed a split-arg path.join form that caused a real regression).
 *
 * SCOPE — FUNCTIONAL references only (the forms that actually break at runtime):
 *   - static import specifiers        from '.../server/telemetry/<mod>.mjs'
 *   - dynamic import() args           import(... 'server/telemetry/<mod>.mjs' ...)
 *   - vitest mock targets             vi.mock('.../server/telemetry/<mod>.mjs')
 *   - source-file reads               readFileSync/readSource/resolve('.../server/telemetry/<mod>.mjs')
 *   - node CLI / spawn argv           node .../server/telemetry/<mod>.mjs   ["server/telemetry/<mod>.mjs"]
 *   - split-arg path.join             path.join(root, 'server', 'telemetry', '<mod>.mjs')
 *
 * DELIBERATELY NOT flagged (asserted below):
 *   - the SIBLING module packages/mcp-rks/src/server/telemetry.mjs (recordTelemetry — NOT part of this
 *     extraction, referenced by the onboarder tests). The guard anchors on the DIRECTORY form
 *     'server/telemetry/<mod>.mjs' (trailing slash) so 'server/telemetry.mjs' (dot) never matches.
 *   - templates/**, notes/**, z_archive, comment/docstring mentions, and the guard's own file.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globby } from "globby";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SELF = "tests/unit/telemetry-absorbed-no-dangle.test.mjs";

// Anchor on `telemetry/<KNOWN-MODULE>.mjs` — NOT the "server/" prefix. Host consumers reference the
// moved code in TWO relative shapes: server/telemetry/<mod>.mjs (full path in vi.mock/file-read) AND
// ./telemetry/<mod>.mjs or ../telemetry/<mod>.mjs (relative import from files inside server/). Both
// resolve to the (now-deleted) directory; both must be caught. Restricting to the 14 KNOWN module
// names keeps it precise:
//   - the correct new imports `@routekit/telemetry/<mod>` carry NO `.mjs` → never matched;
//   - the new file location `packages/telemetry/src/<mod>.mjs` is `telemetry/src/<mod>.mjs` → no match;
//   - the sibling `server/telemetry.mjs` (recordTelemetry, out of scope) has no `telemetry/<mod>` → no match;
//   - the unrelated `scripts/telemetry/dashboard.mjs` (dashboard ∉ the 14 modules) → no match.
const MODS = "index|types|collector|storage|query|cost|cost-report|redact|export|commit-story-index|reports|audit|analysis|digest";
const A = `telemetry/(?:${MODS})\\.mjs`; // the module anchor

const FUNCTIONAL_PATTERNS = [
  ["static-import", new RegExp(`\\bfrom\\s*['"\`][^'"\`]*${A}['"\`]`)],
  ["dynamic-import", new RegExp(`\\bimport\\s*\\([^)]*['"\`][^'"\`]*${A}`)],
  ["vi-mock", new RegExp(`\\bvi\\.mock\\s*\\(\\s*['"\`][^'"\`]*${A}['"\`]`)],
  ["file-read", new RegExp(`\\b(?:readFileSync|readSource|readFile|existsSync|resolve)\\s*\\([^)]*['"\`][^'"\`]*${A}`)],
  ["node-invocation", new RegExp(`\\bnode\\s+[^\\s'"\`]*${A}`)],
  ["spawn-argv", new RegExp(`\\[\\s*['"\`][^'"\`]*${A}['"\`]`)],
  // split-arg path.join: 'server','telemetry','<mod>.mjs' — trailing comma after 'telemetry' means a
  // following segment (the DIRECTORY form). The sibling path.join(...,'server','telemetry.mjs') has
  // 'telemetry.mjs' as the literal, which does NOT match the exact 'telemetry' token → not flagged.
  ["split-arg", /['"`]server['"`]\s*,\s*['"`]telemetry['"`]\s*,/],
];

/** Return the functional-form labels a single line matches (empty = clean / non-functional). */
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
        "**/z_archive*/**",
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

describe("telemetry subsystem absorbed — zero functional dangling references", () => {
  it("no FUNCTIONAL reference to the old server/telemetry/*.mjs module paths survives anywhere", () => {
    expect(
      violations,
      `Dangling functional reference(s) to the moved telemetry subsystem — repoint to @routekit/telemetry ` +
        `(barrel) or a declared subpath, or packages/telemetry/src/* for a source-file read:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("guard precision — no false positives, no false negatives", () => {
  it("does NOT flag the SIBLING module server/telemetry.mjs (recordTelemetry — out of scope)", () => {
    expect(functionalDangleKinds(`import { recordTelemetry } from "../server/telemetry.mjs";`)).toEqual([]);
    expect(functionalDangleKinds(`vi.mock("../../packages/mcp-rks/src/server/telemetry.mjs", () => ({}));`)).toEqual([]);
    expect(functionalDangleKinds(`path.join(root, "server", "telemetry.mjs")`)).toEqual([]);
  });

  it("does NOT flag the CORRECT new imports (@routekit/telemetry bare specifier + new file location)", () => {
    expect(functionalDangleKinds(`import { getTelemetryCollector } from "@routekit/telemetry";`)).toEqual([]);
    expect(functionalDangleKinds(`import { calculateCost } from "@routekit/telemetry/cost";`)).toEqual([]);
    expect(functionalDangleKinds(`const m = await import("@routekit/telemetry/analysis");`)).toEqual([]);
    expect(functionalDangleKinds(`const src = readSource("packages/telemetry/src/types.mjs");`)).toEqual([]);
    // the unrelated scripts/telemetry/dashboard.mjs (dashboard ∉ the 14 modules) is not a dangle
    expect(functionalDangleKinds(`import { x } from "../../scripts/telemetry/dashboard.mjs";`)).toEqual([]);
  });

  it("does NOT match comment / prose mentions of the moved modules", () => {
    expect(functionalDangleKinds(` * moved from server/telemetry/index.mjs into the package`)).toEqual([]);
    expect(functionalDangleKinds(`// the old server/telemetry/collector.mjs collector`)).toEqual([]);
    expect(functionalDangleKinds(`describe("server/telemetry/query.mjs — behavior", () => {`)).toEqual([]);
  });

  it("DOES flag every functional form (guard is not vacuously green)", () => {
    expect(functionalDangleKinds(`import { x } from "../server/telemetry/collector.mjs";`)).toContain("static-import");
    expect(functionalDangleKinds(`const m = await import("../../src/server/telemetry/query.mjs");`)).toContain("dynamic-import");
    expect(functionalDangleKinds(`vi.mock("packages/mcp-rks/src/server/telemetry/index.mjs", () => ({}));`)).toContain("vi-mock");
    expect(functionalDangleKinds(`const src = readSource("packages/mcp-rks/src/server/telemetry/types.mjs");`)).toContain("file-read");
    expect(functionalDangleKinds(`const p = path.resolve("packages/mcp-rks/src/server/telemetry/types.mjs");`)).toContain("file-read");
    expect(functionalDangleKinds(`  spawn(node, ["server/telemetry/index.mjs"], {})`)).toContain("spawn-argv");
    expect(functionalDangleKinds(`path.join(ROOT, "server", "telemetry", "index.mjs")`)).toContain("split-arg");
    // the RELATIVE ../telemetry/ shape (imports from files inside server/) — the blind spot that
    // both the governed exhaustive search AND the first-pass grep missed — MUST be caught.
    expect(functionalDangleKinds(`import { getTelemetryCollector } from "../telemetry/index.mjs";`)).toContain("static-import");
    expect(functionalDangleKinds(`const { generateCostReport } = await import("./telemetry/cost-report.mjs");`)).toContain("dynamic-import");
  });

  it("excludes templates/** and notes/** at the file level (durable source check)", () => {
    const self = fs.readFileSync(path.join(REPO_ROOT, SELF), "utf8");
    expect(self).toContain('"templates/**"');
    expect(self).toContain('"notes/**"');
  });
});
