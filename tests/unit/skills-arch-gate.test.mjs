/**
 * Witness for backlog.fix.skills-arch-gate-omission.
 *
 * CLAUDE.md makes ARCH mandatory between QA and Build, but the skills that sequence
 * Governors (/pipeline, /build, /qa) went PO → QA → Build, so following a skill literally
 * routed a story to Build unreviewed — in this shell and in every child the skills ship to.
 *
 * The three files are named by LITERAL path on purpose: a directory-scoped scan of
 * .claude/skills has been observed to silently omit build/SKILL.md. Ordering uses indexOf on
 * durable tokens and full-source matches only — no fixed-window slices, no pinned prose.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PIPELINE = read(".claude/skills/pipeline/SKILL.md");
const BUILD = read(".claude/skills/build/SKILL.md");
const QA = read(".claude/skills/qa/SKILL.md");

const count = (src, needle) => src.split(needle).length - 1;
const frontmatter = (src) => src.slice(0, src.indexOf("\n---", 4));

/** The launch block that references `prompt`: from the nearest preceding subagent_type to the prompt reference. */
function launchBlock(src, prompt) {
  const at = src.indexOf(prompt);
  const start = src.lastIndexOf("subagent_type:", at);
  const end = src.indexOf("\n\n", at);
  return src.slice(start, end === -1 ? undefined : end);
}

const replaceClauses = (src) => [...src.matchAll(/Replace __PROJECT_ID__ with (\S+?)[.\s]/g)].map((m) => m[1]);

describe("/pipeline runs PO → QA → ARCH → Build", () => {
  it("references governor-arch.md exactly once, after QA and before Build", () => {
    expect(count(PIPELINE, ".rks/prompts/governor-arch.md")).toBe(1);
    const qa = PIPELINE.indexOf("governor-qa.md");
    const arch = PIPELINE.indexOf("governor-arch.md");
    const build = PIPELINE.indexOf("governor-build.md");
    expect(qa).toBeGreaterThan(-1);
    expect(arch).toBeGreaterThan(qa);
    expect(build).toBeGreaterThan(arch);
  });

  it("the ARCH block matches the /arch skill's launch convention", () => {
    const block = launchBlock(PIPELINE, "governor-arch.md");
    expect(block).toContain("subagent_type: governor");
    expect(block).toContain("max_turns: 15");
    expect(block).toContain("__PROJECT_ID__");
    expect(block).toContain("__STORY_IDS__");
  });

  it("ARCH is one launch over the full storyId list, not per story", () => {
    const heading = PIPELINE.slice(PIPELINE.lastIndexOf("**Step", PIPELINE.indexOf("governor-arch.md")));
    const headingLine = heading.slice(0, heading.indexOf("\n"));
    expect(headingLine).toMatch(/ARCH/);
    expect(headingLine).not.toMatch(/for each storyId/i);
    expect(headingLine).toMatch(/full storyId list/i);
  });

  it("declares four sequential Governor steps with Build as Step 4", () => {
    const steps = [...PIPELINE.matchAll(/\*\*Step (\d) — (\w+) Governor/g)].map((m) => [Number(m[1]), m[2]]);
    expect(steps).toEqual([[1, "PO"], [2, "QA"], [3, "ARCH"], [4, "Build"]]);
  });

  it("On Return handles both ARCH verdicts and never builds before approval", () => {
    const onReturn = PIPELINE.slice(PIPELINE.indexOf("## On Return"));
    expect(onReturn).toContain("approved");
    expect(onReturn).toContain("needs-revision");
    expect(onReturn).toMatch(/file\/line/);
    expect(onReturn).toMatch(/wait for user direction/i);
    expect(onReturn).toMatch(/never launched before ARCH returns `approved`/);
  });
});

describe("/build is ARCH-gated for every phase", () => {
  it("the phase branch names draft, ready and arch-approved; only arch-approved skips ARCH", () => {
    const branch = BUILD.slice(BUILD.indexOf("1. Check the story phase"), BUILD.indexOf("2. QA Governor"));
    const line = (phase) => branch.split("\n").find((l) => l.includes(`phase is \`${phase}\``)) || "";
    expect(line("draft")).toMatch(/ARCH/);
    expect(line("ready")).toMatch(/ARCH/);
    expect(line("arch-approved")).not.toMatch(/ARCH \(/);
    expect(line("arch-approved")).toMatch(/Build/);
  });

  it("launches ARCH before the Build Governor, with the /arch convention", () => {
    const arch = BUILD.indexOf("governor-arch.md");
    expect(arch).toBeGreaterThan(-1);
    expect(arch).toBeLessThan(BUILD.indexOf("governor-build.md"));
    const block = launchBlock(BUILD, "governor-arch.md");
    expect(block).toContain("subagent_type: governor");
    expect(block).toContain("max_turns: 15");
    expect(block).toContain("__PROJECT_ID__");
    expect(block).toContain("__STORY_IDS__");
  });

  it("the frontmatter description no longer says a ready story builds immediately", () => {
    const fm = frontmatter(BUILD);
    expect(fm).not.toMatch(/ready, builds immediately/);
    expect(fm).toMatch(/ARCH/);
  });
});

describe("/qa routes to ARCH, not Build", () => {
  const onReturn = QA.slice(QA.indexOf("## On Return"));

  it("the bare Build handoff is gone", () => {
    expect(QA).not.toContain("Proceed to /build");
  });

  it("On Return invokes /arch once with the full storyId list after the batch", () => {
    expect(onReturn).toContain("/arch");
    expect(onReturn).toMatch(/full storyId list/);
  });

  it("On Return says Build waits for ARCH approval", () => {
    expect(onReturn).toMatch(/not launched until ARCH returns `approved`/);
  });
});

describe("projectId token convention and clause scope", () => {
  it("each file uses one Replace-clause value throughout", () => {
    for (const [name, src] of [["pipeline", PIPELINE], ["build", BUILD], ["qa", QA]]) {
      const values = new Set(replaceClauses(src));
      expect(values.size, `${name} mixes Replace-clause values: ${[...values]}`).toBe(1);
    }
  });

  it("clause counts: pipeline 4, build 3, qa 1", () => {
    expect(replaceClauses(PIPELINE)).toHaveLength(4);
    expect(replaceClauses(BUILD)).toHaveLength(3);
    expect(replaceClauses(QA)).toHaveLength(1);
  });
});
