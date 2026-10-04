/**
 * Witness for backlog.fix.phase-advance-suppression-terminal-and-remedy-inoperative.
 *
 * The review gate can refuse to advance a phase while the off-rail ship has ALREADY committed,
 * merged and pushed. Before this story that state was terminal: `reconcileToIntegrated`'s single
 * call site is the arm the suppression skips, `guardrails-audit.mjs` never calls `advancePhase`,
 * and the story agent's `advance_phase` admits only plan/exec/ship — `ship` legal only from
 * `executed`. A story whose code was on `main` kept a phase saying it was never built.
 *
 * And the gate's own remedy could not clear it. Both coverage branches carried a string telling
 * the operator to set `advancePhaseOnUnassessedAC: true`, which is read at rule 5 — BELOW both
 * of their returns. A gate emitting a false instruction for recovering from its own decision, in
 * a system whose discipline is that status must be sourced from observation.
 *
 * THE HARD PART IS THE REFUSALS, not the advance. A repair that advances a story whose code did
 * not merge is worse than a stale phase, so the cases below spend more effort on what it must
 * refuse than on what it must do — including the two shapes QA measured as unsafe to inherit
 * from the existing probe at review.mjs: an unanchored regex that admits a longer sibling id,
 * and a catch that returns a permissive value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// PASS-THROUGH recorder, not a stub. Every call still reaches the real git, so the cases
// below are the same measurements they would be unmocked; the wrapper only records what
// the SUT asked for. This is how the timeout and candidate-bound requirements are asserted
// behaviourally rather than by reading source text.
const { recordedCalls } = vi.hoisted(() => ({ recordedCalls: [] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: (...args) => {
      recordedCalls.push(args);
      return actual.execFileSync(...args);
    },
  };
});

import { execFileSync } from "node:child_process";
import {
  repairPhaseToIntegrated,
  reconcileToIntegrated,
} from "../../packages/mcp-rks/src/workflow/auto-phase.mjs";

const TIMEOUT = 20_000;
const g = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-phase-repair-"));
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  g(root, ["init", "-b", "staging"]);
  g(root, ["config", "user.email", "t@t"]);
  g(root, ["config", "user.name", "t"]);
  g(root, ["config", "commit.gpgsign", "false"]);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeStory(id, phase) {
  const p = path.join(root, "notes", `${id}.md`);
  fs.writeFileSync(p, `---\nid: "${id}"\ntitle: "T"\ncreated: 1\nupdated: 2\nphase: "${phase}"\n---\n\n## Problem\n\nbody\n`);
  return p;
}

/** A commit carrying the off-rail `Story:` trailer, the evidence the repair rests on. */
function commitWithTrailer(storyId, file = "src.mjs") {
  fs.writeFileSync(path.join(root, file), `// ${Math.random()}\n`);
  g(root, ["add", "-A"]);
  g(root, ["commit", "-m", `feat(off-rail): work\n\nSession: abc\nStory: ${storyId}`]);
  return g(root, ["rev-parse", "HEAD"]).trim();
}

const phaseOf = (id) =>
  /phase:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(root, "notes", `${id}.md`), "utf8"))?.[1];

const repair = (id, opts) => repairPhaseToIntegrated(root, id, "p", { integrationBranch: "staging", ...opts });

describe("the repair advances only on evidence", () => {
  it("advances a suppressed story whose trailer commit is reachable", async () => {
    const id = "backlog.fix.shipped-but-suppressed";
    writeStory(id, "arch-approved");
    const sha = commitWithTrailer(id);

    const res = await repair(id);

    expect(res.ok).toBe(true);
    expect(res.repaired).toBe(true);
    expect(res.from).toBe("arch-approved");
    expect(res.evidence.commit).toBe(sha);
    expect(phaseOf(id)).toBe("integrated");
  });

  it("does not require a new commit or a second off-rail session", async () => {
    // The repair must be takeable from the state the suppressed ship leaves behind.
    const id = "backlog.fix.no-fabrication";
    writeStory(id, "arch-approved");
    commitWithTrailer(id);
    const head = g(root, ["rev-parse", "HEAD"]).trim();

    await repair(id);

    expect(g(root, ["rev-parse", "HEAD"]).trim()).toBe(head); // no commit created
    // The story note IS modified — writing the phase is the whole job. What must NOT happen is
    // any other file changing, which is what a "fabricate a code change to re-ship" repair would
    // look like.
    // Compared on paths, not on porcelain status codes — the leading status column is stripped
    // by trim() on the first line only, which would make a literal comparison position-dependent.
    const dirtyPaths = g(root, ["status", "--porcelain"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3));
    expect(dirtyPaths).toEqual([`notes/${id}.md`]);
  });
});

describe("the repair REFUSES without evidence", () => {
  it("refuses when no commit carries the story's trailer, and names the missing evidence", async () => {
    const id = "backlog.fix.never-shipped";
    writeStory(id, "arch-approved");
    commitWithTrailer("backlog.fix.a-different-story"); // positive control — history is not empty

    const res = await repair(id);

    expect(res.ok).toBe(false);
    expect(res.repaired).toBe(false);
    expect(res.reason).toBe("no_merged_commit_for_story");
    expect(res.error).toContain(`Story: ${id}`);
    expect(phaseOf(id)).toBe("arch-approved"); // untouched
  });

  it("REFUSES a story id that is a strict PREFIX of a shipped sibling", async () => {
    // The sharpest case. `--grep` without --fixed-strings is an unanchored regex, and even WITH
    // fixed-strings a substring test admits `Story: foo.bar` from `Story: foo.bar.baz`. Only a
    // line-exact comparison refuses here, which is why the implementation re-verifies candidates.
    const shipped = "backlog.fix.parent.child";
    const prefix = "backlog.fix.parent";
    writeStory(prefix, "arch-approved");
    writeStory(shipped, "arch-approved");
    commitWithTrailer(shipped);

    expect((await repair(shipped)).repaired).toBe(true); // positive control — the real one advances

    const res = await repair(prefix);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_merged_commit_for_story");
    expect(phaseOf(prefix)).toBe("arch-approved");
  });

  it("REFUSES a regex-metacharacter id rather than matching it as a pattern", async () => {
    // Dots are wildcards in an unanchored grep, so `a.b` would match a literal `aXb` trailer.
    writeStory("backlog.fix.a.b", "arch-approved");
    fs.writeFileSync(path.join(root, "s.mjs"), "x\n");
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "feat: other\n\nStory: backlog.fix.aXb"]);

    const res = await repair("backlog.fix.a.b");
    expect(res.reason).toBe("no_merged_commit_for_story");
  });

  it("REFUSES on an unreadable git history rather than treating it as absence", async () => {
    // The inverted-safety case. isDiffPartialForStory returns TRUE from its catch — fail-safe for
    // its own question, fail-OPEN for an admission decision. A missing branch must not read as
    // "this story never shipped".
    const id = "backlog.fix.bad-ref";
    writeStory(id, "arch-approved");
    commitWithTrailer(id); // the evidence EXISTS; only the ref is wrong

    const res = await repair(id, { integrationBranch: "no-such-branch" });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("evidence_unreadable");
    expect(res.reason).not.toBe("no_merged_commit_for_story");
    expect(phaseOf(id)).toBe("arch-approved");
  });

  it("refuses a phase with no ladder entry, NAMING the phase", async () => {
    // reconcileToIntegrated stops cleanly and silently here. A repair must say why.
    const id = "backlog.fix.too-early";
    writeStory(id, "ready");
    commitWithTrailer(id);

    const res = await repair(id);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("phase_not_on_off_rail_ladder");
    expect(res.error).toContain("ready");
    expect(phaseOf(id)).toBe("ready");
  });

  it("refuses a story that does not exist", async () => {
    const res = await repair("backlog.fix.no-such-note");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("story_not_found");
  });
});

describe("an already-advanced story is a no-op, not a repair", () => {
  it.each(["integrated", "released"])("reports %s as already_advanced with repaired false", async (phase) => {
    // Reporting this as a successful repair would be the same class of false status the story
    // exists to remove.
    const id = `backlog.fix.already-${phase}`;
    writeStory(id, phase);
    commitWithTrailer(id);

    const res = await repair(id);

    expect(res.ok).toBe(true);
    expect(res.repaired).toBe(false);
    expect(res.reason).toBe("already_advanced");
    expect(phaseOf(id)).toBe(phase);
  });
});

describe("the candidate set is not capped, so a false absence cannot be reported", () => {
  const CASE_TIMEOUT = 120_000;

  /** N newer commits whose trailers are LONGER ids the fixed-string grep also matches. */
  const decoyCommits = (id, n) => {
    for (let i = 1; i <= n; i++) {
      g(root, ["commit", "--allow-empty", "-m", `chore: decoy ${i}\n\nStory: ${id}.child-${i}`]);
    }
  };

  it(
    "finds the real evidence behind 55 newer sibling-id commits",
    async () => {
      const id = "backlog.fix.buried-evidence";
      writeStory(id, "arch-approved");
      const sha = commitWithTrailer(id);
      decoyCommits(id, 55);

      const res = await repair(id);

      expect(res.ok).toBe(true);
      expect(res.repaired).toBe(true);
      expect(res.evidence.commit).toBe(sha);
      expect(phaseOf(id)).toBe("integrated");
    },
    CASE_TIMEOUT,
  );

  it(
    "still refuses when 55 sibling-id commits exist and the real one does not",
    async () => {
      const id = "backlog.fix.only-siblings";
      writeStory(id, "arch-approved");
      g(root, ["add", "-A"]);
      g(root, ["commit", "-m", "chore: base"]);
      decoyCommits(id, 55);

      const res = await repair(id);

      expect(res.ok).toBe(false);
      expect(res.repaired).toBe(false);
      expect(res.reason).toBe("no_merged_commit_for_story");
      expect(res.error).toContain(`Story: ${id}`);
      expect(phaseOf(id)).toBe("arch-approved");
    },
    CASE_TIMEOUT,
  );
});

describe("evidence reachable only through a merge is still evidence", () => {
  it("admits a trailer commit reachable only through a merge's second parent", async () => {
    const id = "backlog.fix.merged-feature";
    writeStory(id, "arch-approved");
    // The note is committed on staging FIRST, so switching branches never removes it from
    // the working tree — the SUT reads the note there, and only the ref comes from git.
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "chore: base"]);

    g(root, ["checkout", "-b", "feature"]);
    g(root, ["commit", "--allow-empty", "-m", `feat: work\n\nStory: ${id}`]);
    const sha = g(root, ["rev-parse", "HEAD"]).trim();

    g(root, ["checkout", "staging"]);
    g(root, ["commit", "--allow-empty", "-m", "chore: staging moved on"]);
    g(root, ["merge", "--no-ff", "--no-edit", "feature"]);

    // Positive control for the shape of the fixture: reachable, but NOT on the first-parent
    // spine. A lookup passing --first-parent would miss it.
    expect(g(root, ["rev-list", "staging"]).split("\n")).toContain(sha);
    expect(g(root, ["rev-list", "--first-parent", "staging"]).split("\n")).not.toContain(sha);

    const res = await repair(id);

    expect(res.repaired).toBe(true);
    expect(res.evidence.commit).toBe(sha);
    expect(phaseOf(id)).toBe("integrated");
  });

  it("REFUSES evidence that sits on an unmerged branch, and admits it on that branch", async () => {
    const id = "backlog.fix.unmerged-feature";
    writeStory(id, "arch-approved");
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "chore: base"]);

    g(root, ["checkout", "-b", "feature"]);
    g(root, ["commit", "--allow-empty", "-m", `feat: work\n\nStory: ${id}`]);
    const sha = g(root, ["rev-parse", "HEAD"]).trim();
    g(root, ["checkout", "staging"]);

    const refused = await repair(id);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("no_merged_commit_for_story");
    expect(phaseOf(id)).toBe("arch-approved");

    // Positive control — the same evidence IS admitted from the branch that contains it,
    // so the refusal above measures reachability rather than a broken lookup.
    const admitted = await repair(id, { integrationBranch: "feature" });
    expect(admitted.repaired).toBe(true);
    expect(admitted.evidence.commit).toBe(sha);
  });
});

describe("the lookup's git invocations, as recorded", () => {
  it("carry an explicit timeout, keep --fixed-strings, and bound no candidate count", async () => {
    const id = "backlog.fix.recorded-invocations";
    writeStory(id, "arch-approved");
    commitWithTrailer(id);

    // Cleared AFTER fixture setup, so only the SUT's own calls are measured.
    recordedCalls.length = 0;
    const res = await repair(id);
    expect(res.repaired).toBe(true);

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const [cmd, args, options] of recordedCalls) {
      expect(cmd).toBe("git");
      expect(options, `options for git ${args.join(" ")}`).toBeTruthy();
      expect(Number.isFinite(options.timeout), `timeout for git ${args.join(" ")}`).toBe(true);
      expect(options.timeout).toBeGreaterThan(0);
    }

    const logCalls = recordedCalls.filter(([, args]) => args[0] === "log");
    expect(logCalls.length).toBeGreaterThan(0);
    for (const [, args] of logCalls) {
      expect(args).toContain("--fixed-strings");
      expect(args).not.toContain("--first-parent");
      // No candidate cap in any form: -n, --max-count, or a bare -<number>.
      expect(args).not.toContain("-n");
      expect(args.some((a) => a === "--max-count" || /^--max-count=/.test(a))).toBe(false);
      expect(args.some((a) => /^-\d+$/.test(a))).toBe(false);
    }
  });
});

describe("reconcileToIntegrated is unchanged", () => {
  it("still stops cleanly on a phase with no ladder step", async () => {
    // The repair wraps it; it must not have altered it. This is the behaviour the repair
    // deliberately converts into a NAMED refusal at its own layer, leaving the underlying
    // best-effort contract intact for the ship path that depends on it.
    const id = "backlog.fix.reconcile-untouched";
    writeStory(id, "ready");

    const res = await reconcileToIntegrated(root, id, "p");

    expect(res.ok).toBe(true);
    expect(res.advanced).toBe(false);
    expect(phaseOf(id)).toBe("ready");
  });
});
