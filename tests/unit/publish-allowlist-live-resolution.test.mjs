/**
 * Witness for backlog.fix.publish-allowlist-public-notes-namespace.
 *
 * THIS TEST CARRIES THE LEGAL GATE FOR THE PUBLIC MIRROR.
 *
 * `tests/unit/publish-rks-public-profile.test.mjs` resolves the live profile against a
 * SYNTHETIC fixture repo — it proves the profile's shape, not what actually ships. This file
 * resolves the live profile against the REAL repository, so its assertions are about the real
 * manifest `git archive` would receive.
 *
 * WHY THAT MATTERS: presentation decks must never reach the public mirror. The deck SOURCE was
 * already excluded — but the deck COPY was embedded verbatim in test files that the broad
 * `tests/**` include allowlists and nothing excluded. Reasoning about globs did not catch that;
 * resolving the actual set does.
 *
 * TWO ASSERTION LAYERS, NOT INTERCHANGEABLE — read before adding an assertion here.
 *   `publish.mjs` adds a GLOB-FREE include to the resolved set AS THE PATTERN STRING, with no
 *   check against the HEAD tree. So `expect(sel).toContain("CLA.md")` passes even if CLA.md
 *   does not exist — it is the config echoed back, testing nothing. Therefore:
 *     - GLOB patterns  → assert over the RESOLVED SET. They really resolve against git ls-tree.
 *     - LITERAL paths  → assert config membership AND `existsSync`. Never resolved-set alone.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILES_PATH = path.join(REPO_ROOT, ".routekit/publish-profiles.yaml");

const config = yaml.load(fs.readFileSync(PROFILES_PATH, "utf8"));
const profile = config.profiles["rks-public"];
const resolved = generateIncludeArgs(profile, REPO_ROOT);

const NINE_HOW_TO = [
  "notes/how-to.story-lifecycle.md",
  "notes/how-to.write-backlog-stories.md",
  "notes/how-to.test-tiers.e2e-invocation.md",
  "notes/how-to.project-attach.md",
  "notes/how-to.child-project-kickoff.md",
  "notes/how-to.golden-path.md",
  "notes/how-to.rks.md",
  "notes/how-to.branch-topology.md",
  "notes/how-to.dendron-note-creation.md",
];

describe("THE LEGAL GATE — no presentation, deck or marketing content resolves", () => {
  it("the resolved manifest contains ZERO matches, with no permitted exception", () => {
    // Deliberately allowance-free. An earlier draft carried a named allowance prefix for the
    // whitepaper skill; that was replaced by an exclusion, because a tripwire with a permitted
    // exception is a standing hole in the one assertion carrying this story's justification —
    // the next "just one more allowance" edit widens it silently.
    //
    // IF THIS GOES RED: STOP AND SURFACE IT. Widening the regex, adding an allowance, or
    // deleting this assertion are all FAILURES. The sanctioned move is to exclude the offender
    // or to establish, on the record, that it genuinely belongs on a public mirror.
    const offenders = resolved.filter((p) => /presentation|deck|slide|marketing|whitepaper/i.test(p));
    expect(offenders, `these would reach the public mirror:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the specific deck-copy carriers are gone", () => {
    // These embedded verbatim slide copy, deck titles, origin-story beats including a named
    // person, and the titles of five unpublished private notes.
    for (const bad of [
      "tests/unit/presentation-what-is-rks.test.mjs",
      "tests/unit/presentation-how-rks-works.test.mjs",
      "tests/unit/presentation-rks-for-product-and-design.test.mjs",
      "tests/unit/presentation-building-a-product-knowledge-graph.test.mjs",
      "tests/unit/dashboard-nav-shell.test.mjs",
      "tests/unit/marketing-site-scaffold.test.mjs",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, bad)), `${bad} must exist for this to mean anything`).toBe(true);
      expect(resolved).not.toContain(bad);
    }
  });

  it("the client-engagement fixture carriers are gone", () => {
    // Planner fixture strings naming a client engagement. Their own paths do NOT match the
    // tripwire regex, so nothing automated catches them — only this explicit assertion does.
    for (const bad of [
      "tests/unit/planner-note-step-degeneracy.test.mjs",
      "tests/unit/planner-dropped-step-diagnostics.test.mjs",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, bad))).toBe(true);
      expect(resolved).not.toContain(bad);
    }
  });

  it("a file wrongly accused in review is NOT excluded", () => {
    // planner-structural-degeneracy-real.test.mjs was named as an offender in review and is
    // not one — it carries only generic fixture paths. Excluding it would drop a real
    // regression test from the mirror for no benefit. This pins that it stays.
    expect(resolved).toContain("tests/unit/planner-structural-degeneracy-real.test.mjs");
  });
});

describe("the note namespaces that actually ship", () => {
  it("notes/public.** resolves — the library that previously shipped nothing", () => {
    const publicNotes = resolved.filter((p) => p.startsWith("notes/public."));
    expect(publicNotes.length).toBeGreaterThan(0);
    expect(resolved).toContain("notes/public.canon.what-is-rks.md");
  });

  it("the retired namespaces resolve to nothing", () => {
    // canon.* is superseded by public.canon.*; research.public.* can never match a note under
    // the documented research.YYYY.MM.DD.* convention; agents.* is a vestige of when agent
    // prompts lived in the vault.
    for (const prefix of ["notes/canon.", "notes/research.public.", "notes/agents."]) {
      expect(resolved.filter((p) => p.startsWith(prefix))).toEqual([]);
    }
  });

  it("exactly the nine audited how-to files are allowlisted, and each exists", () => {
    // LITERAL paths: config membership + existsSync. A resolved-set assertion here would be
    // vacuous — publish.mjs echoes glob-free entries back without touching the HEAD tree.
    const configured = profile.include.filter((p) => p.startsWith("notes/how-to."));
    expect(configured.sort()).toEqual([...NINE_HOW_TO].sort());
    for (const p of NINE_HOW_TO) {
      expect(fs.existsSync(path.join(REPO_ROOT, p)), `${p} is allowlisted but absent`).toBe(true);
    }
  });

  it("the how-to files that failed the audit do not ship", () => {
    for (const bad of [
      "notes/how-to.publish-blog-to-ux287.md",
      "notes/how-to.getting-started.md",
      "notes/how-to.agent-operations.2-research.md",
      "notes/how-to.guardrails.md",
      "notes/how-to.surgical-install.md",
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, bad)), `${bad} must exist for this to mean anything`).toBe(true);
      expect(resolved).not.toContain(bad);
    }
  });
});

describe("structural constraints on the profile itself", () => {
  it("no glob-free include entry is a DIRECTORY", () => {
    // publish.mjs adds a glob-free include as the pattern string and applyExclude tests that
    // string, not its members. git archive then expands a directory pathspec recursively —
    // every file under it bypassing the exclude filter entirely. Single files are safe.
    const globFree = profile.include.filter((p) => !p.includes("*"));
    const dirs = globFree.filter((p) => {
      const abs = path.join(REPO_ROOT, p);
      return fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    });
    expect(dirs, `glob-free DIRECTORY entries bypass applyExclude: ${dirs.join(", ")}`).toEqual([]);
  });

  it("the dead notes-public profile is gone and rks-public is the only one", () => {
    expect(Object.keys(config.profiles)).toEqual(["rks-public"]);
  });

  it("the remote's arming flag is a literal boolean — arming state is config, not a test pin", () => {
    // Deliberately NOT an arming assertion, matching the precedent in
    // tests/unit/publish-rks-public-profile.test.mjs:85-97. Pinning enabled: false
    // encoded a transient operational posture as a permanent invariant and reddened
    // CI the moment the mirror was legitimately armed. What must hold is that the
    // flag is a LITERAL BOOLEAN - publish.mjs blocks on any other value rather than
    // coercing it, so a string "true" would silently look armed.
    expect(typeof config.remotes["rks-public"].enabled).toBe("boolean");
  });
});
