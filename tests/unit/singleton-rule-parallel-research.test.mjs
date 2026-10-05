import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Documentation-contract test for the CLAUDE.md Singleton Rule.
//
// backlog.fix.singleton-rule-false-parallel-research-premise. This file
// previously pinned a carve-out permitting parallel Research Governors, on the
// rationale that they "do not mutate dendron/session state". That rationale is
// false: every Governor's first call is rks_governor_init, which reads and
// overwrites a process-global session pointer and can end a session another
// Governor is still using. The carve-out is withdrawn and these assertions now
// pin the blanket serial rule.
//
// WHAT A GREEN RUN HERE DOES AND DOES NOT EVIDENCE. This test reads CLAUDE.md
// and matches regexes against it. Green proves only that CLAUDE.md SAYS the
// corrected thing. It does NOT evidence that the process-global session defect
// is real, and it does NOT evidence that the Dispatcher obeys the rule —
// nothing enforces it at runtime, as the section itself states. That gap is
// exactly how the withdrawn claim held a green check for its entire life: a
// prose test cannot distinguish a true rationale from a false one. The partial
// mitigation is that the section must cite its two source files BY PATH and
// those paths are asserted to exist, which makes the claim checkable rather
// than merely present.
//
// POLARITY IS CARRIED BY ABSENCE ASSERTIONS, NEVER BY PROXIMITY. The regex this
// file used to rely on — /Research[\s\S]{0,120}parallel/i — matched "Research
// Governors may NOT run in parallel" exactly as readily as the permission it was
// written to pin. Proximity regexes are presence checks. The load-bearing
// assertions below are the negative ones.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const CLAUDE_MD = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf-8");

// Isolate the Singleton Rule section (from its heading to the next H2).
function singletonSection(src) {
  const start = src.indexOf("## Singleton Rule");
  if (start === -1) return "";
  const rest = src.slice(start + "## Singleton Rule".length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("CLAUDE.md Singleton Rule — every Governor serial, Research included", () => {
  const section = singletonSection(CLAUDE_MD);

  it("has a Singleton Rule section", () => {
    expect(CLAUDE_MD).toContain("## Singleton Rule");
    expect(section.length).toBeGreaterThan(0);
  });

  it("makes no claim that any Governor leaves session or dendron state unmutated", () => {
    // Pinned regexes rather than a prose description of the shape. The corrected
    // section describes the shared session as mutable, which none of these match.
    expect(section).not.toMatch(/(do|does)\s+not\s+mutate[\s\S]{0,80}(session|dendron)/i);
    expect(section).not.toMatch(/(session|dendron)[\s\S]{0,80}(do|does)\s+not\s+mutate/i);
    expect(section).not.toMatch(/mutates?\s+no\s+[\s\S]{0,40}(session|dendron|shared)/i);
  });

  it("states ALL Governors run serial and names Research as included", () => {
    // PAIRED — both halves required, and they are not the same kind of check.
    // The positive half is a PRESENCE check: it binds "Research" to the WORD
    // serial, not to the CONTRACT, so "Research Governors are exempt from the
    // serial rule." satisfies it while granting the exemption this story
    // withdraws. The negative half is what carries polarity.
    expect(section).toMatch(/Research[^.]{0,60}(included|serial|exclusive)/i);
    expect(section).not.toMatch(/Research[^.]{0,80}(exempt|except|excluded|unless|carve)/i);
  });

  it("withdraws the parallel allowance", () => {
    expect(section).not.toMatch(/may run in parallel/i);
    expect(section).not.toMatch(/run in parallel with each other/i);
  });

  it("no longer carves Research out of the rule", () => {
    // The antecedent-less remnant left behind if only the first paragraph of the
    // section is replaced instead of the whole section.
    expect(section).not.toContain("Every other Governor");
  });

  it("states the verified rationale — the process-global session pointer", () => {
    expect(section).toMatch(/rks_governor_init/);
    expect(section).toMatch(/process-global|module-global/i);
    expect(section).toMatch(/session/i);
  });

  it("cites both source files by path", () => {
    expect(section).toContain("packages/mcp-rks/src/shared/governor-token.mjs");
    expect(section).toContain("packages/mcp-rks/src/tools/governor-init.mjs");
  });

  it("cites source paths that exist on disk", () => {
    // Makes the citation checkable rather than merely present. Deliberately
    // asserts NOTHING about the symbols, line numbers or internal content of
    // these files — backlog.fix.governor-session-identity-process-global is
    // expected to change their internals, and such a pin would redden when it
    // lands.
    expect(existsSync(join(REPO_ROOT, "packages/mcp-rks/src/shared/governor-token.mjs"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "packages/mcp-rks/src/tools/governor-init.mjs"))).toBe(true);
  });

  it("names the code fix and calls the serial rule a correctness requirement", () => {
    expect(section).toContain("backlog.fix.governor-session-identity-process-global");
    expect(section).toMatch(/correctness requirement/i);
  });

  // backlog.fix.mirror-ci-green-unship-doc-integrity-tests — AC5. notes/backlog.* is on no
  // include pattern in publish-profiles.yaml, so the published tree carries no backlog notes at
  // all and this cross-link cannot resolve there. CONDITION-SCOPED on the NAMESPACE's presence,
  // which distinguishes "the mirror has no backlog notes" from "the cross-linked note is
  // genuinely missing" — the second still fails, upstream, exactly as before.
  it.skipIf(!existsSync(join(REPO_ROOT, "notes/backlog.fix.governor-session-identity-process-global.md")) &&
            !existsSync(join(REPO_ROOT, "notes/backlog.z_implemented.fix.governor-session-identity-process-global.md")) &&
            !existsSync(join(REPO_ROOT, "notes/backlog.problems.md")))(
    "cross-links a story note that exists on disk under either name", () => {
    // Shipping a story renames its note into the backlog.z_implemented
    // namespace, so asserting only the pre-ship path would redden the moment the
    // cross-linked fix ships. Accepting either path is site-count independent —
    // it asserts neither the number nor the set of rename sites.
    const preShip = join(REPO_ROOT, "notes/backlog.fix.governor-session-identity-process-global.md");
    const shipped = join(REPO_ROOT, "notes/backlog.z_implemented.fix.governor-session-identity-process-global.md");
    expect(existsSync(preShip) || existsSync(shipped)).toBe(true);
  });

  it("states the rule is a Dispatcher-behavior contract, not coded enforcement", () => {
    expect(section).toMatch(/not a coded|not enforce|Dispatcher-behavior contract/i);
  });

  it("permits parallel Governor dispatch nowhere in CLAUDE.md", () => {
    // Whole-file, not section-scoped. The unrelated vitest rule at "No parallel
    // instances" is the only other occurrence of the word and is left untouched.
    expect(CLAUDE_MD).not.toMatch(/Governors may run in parallel/i);
  });
});
