/**
 * Content-assertion tests for the conversational first-run onboarder
 * (backlog.feat.conversational-first-run-onboarder).
 *
 * The onboarder is a Dispatcher-prompt (CLAUDE.md) behavior, so these are durable
 * phrase/behavior assertions (fs.readFileSync + toContain/toMatch) — no fixed-window
 * slicing and no long exact-prose pins, so the owner keeps control of the exact copy.
 * Mirrors tests/unit/verbosity-override-flags.test.mjs.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

// Extract just the "## Onboarder Auto-Trigger" section so the hard-exclusion (no gh-issues)
// check is scoped to the onboarder, not the whole file (CLAUDE.md may mention github/CI elsewhere).
function onboarderSection() {
  const md = read("CLAUDE.md");
  const heading = "## Onboarder Auto-Trigger";
  const start = md.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const rest = md.slice(start + heading.length);
  const nextH2 = rest.indexOf("\n## ");
  return nextH2 === -1 ? rest : rest.slice(0, nextH2);
}

describe("conversational first-run onboarder — CLAUDE.md A/B fork", () => {
  it("presents the two top-level paths (A: work on rks, B: set up your own project)", () => {
    const s = onboarderSection();
    expect(s).toMatch(/A\)[^\n]*rks itself/i);
    expect(s).toMatch(/B\)[^\n]*your own project/i);
  });

  it("has all four leaves: A-contribute, A-own-fork, B-new, B-existing", () => {
    const s = onboarderSection();
    expect(s).toMatch(/contribute|build features/i);           // A-contribute
    expect(s).toMatch(/make your own rks|your (own )?fork/i);   // A-own-fork
    expect(s).toMatch(/brand-new|new project/i);               // B-new
    expect(s).toMatch(/existing repo/i);                       // B-existing
  });

  it("carries a light AGPL-3.0 heads-up with the hosted/network-service nuance", () => {
    const s = onboarderSection();
    expect(s).toContain("AGPL-3.0");
    expect(s).toMatch(/hosted|network service/i);
  });

  it("routes B-new to `routekit project init` and B-existing to `routekit project attach`", () => {
    const s = onboarderSection();
    expect(s).toContain("routekit project init");
    expect(s).toContain("routekit project attach");
  });

  it("does NOT send a user's separate repo to add-existing (that is self-host/re-register only)", () => {
    const s = onboarderSection();
    // add-existing may be named, but only to warn it off for a user's own repo
    if (s.includes("add-existing")) {
      expect(s).toMatch(/do not use `?add-existing`?|not[^\n]*add-existing|add-existing[^\n]*(self-host|re-register)/i);
    }
  });

  it("HARD EXCLUSION: no GitHub-issues / issue-reporting language in the onboarder section", () => {
    const s = onboarderSection();
    expect(s).not.toMatch(/issue|github/i);
  });

  it("mentions a REAL /rks-onboard skip flag (--skip-tour or --bounce), no invented flags", () => {
    const s = onboarderSection();
    expect(s).toMatch(/\/rks-onboard --(skip-tour|bounce)\b/);
  });

  it("stays gated on the existing first-run signal (completedAt / dismissed), not a second always-on prompt", () => {
    const s = onboarderSection();
    expect(s).toContain("completedAt");
    expect(s).toContain("dismissed");
  });
});

describe("conversational first-run onboarder — docs", () => {
  it("README documents init (new), attach (existing external), and add-existing (self-host/re-register)", () => {
    const r = read("README.md");
    expect(r).toContain("routekit project init");
    expect(r).toContain("routekit project attach");
    expect(r).toContain("routekit project add-existing");
  });

  it("how-to.child-project-kickoff explains rks_init vs rks_project_init and new-vs-existing", () => {
    const h = read("notes/how-to.child-project-kickoff.md");
    expect(h).toContain("rks_init");
    expect(h).toContain("rks_project_init");
    expect(h).toMatch(/brand-new|new project/i);
    expect(h).toMatch(/existing repo/i);
  });

  // NOTE: the originating note (notes/scratch.2026.07.03.uat-chat-thread.md) is gitignored
  // (`.gitignore: notes/scratch.*`) — ephemeral, not committed, absent in CI — so its
  // forward back-link cannot be a CI assertion. The durable provenance lives in the tracked
  // story cross-links (this story ↔ backlog.feat.init-false-success-wrong-root-fix), and the
  // back-link scope in practice is ideas.*/uat-reports.*, not scratch.*.
});
