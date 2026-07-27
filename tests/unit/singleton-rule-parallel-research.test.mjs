import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Documentation-contract test for the CLAUDE.md Singleton Rule. Mirrors the
// existing precedent (tests/unit/verbosity-override-flags.test.mjs) of asserting
// on CLAUDE.md prose. Locks in the Research-parallel / pipeline-serial asymmetry
// so the rule cannot silently regress to the old blanket "never run two
// Governors in parallel" wording. Prose assertions only — the rule is a
// Dispatcher-behavior contract, NOT coded/runtime-enforced.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_MD = readFileSync(join(__dirname, "../../CLAUDE.md"), "utf-8");

// Isolate the Singleton Rule section (from its heading to the next H2).
function singletonSection(src) {
  const start = src.indexOf("## Singleton Rule");
  if (start === -1) return "";
  const rest = src.slice(start + "## Singleton Rule".length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("CLAUDE.md Singleton Rule — parallel Research, serial everything else", () => {
  const section = singletonSection(CLAUDE_MD);

  it("has a Singleton Rule section", () => {
    expect(CLAUDE_MD).toContain("## Singleton Rule");
    expect(section.length).toBeGreaterThan(0);
  });

  it("allows Research (read-only) Governors to run in parallel", () => {
    expect(section).toMatch(/Research[\s\S]{0,120}parallel/i);
    expect(section).toMatch(/read-only/i);
  });

  it("keeps all other Governors serial and exclusive", () => {
    expect(section).toMatch(/serial/i);
    // The pipeline/build/exec governors are named as the ones that stay serial.
    expect(section).toMatch(/PO[\s\S]*QA[\s\S]*ARCH[\s\S]*Build/i);
    expect(section).toMatch(/mutat/i); // rationale: they mutate shared state
  });

  it("does NOT retain the old blanket 'never run two Governors in parallel' rule", () => {
    // The old wording was: "Never run two Governors in parallel. Always wait for
    // each Governor to complete before launching the next." The new asymmetry
    // must replace it — a blanket ban would contradict parallel Research.
    expect(CLAUDE_MD).not.toMatch(/Never run two Governors in parallel\.\s*Always wait for each Governor/);
  });

  it("states the rule is a Dispatcher-behavior contract, not coded enforcement", () => {
    expect(section).toMatch(/not a coded|not enforce|Dispatcher-behavior contract/i);
  });
});
