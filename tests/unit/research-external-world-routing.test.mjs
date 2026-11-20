/**
 * backlog.feat.research-external-world-routing
 *
 * `/research` query mode sent EVERY question to `rks_agent_research`, which retrieves over this
 * project's own corpus. For an outside-world question — third-party pricing, another vendor's
 * API, statutes — that index cannot hold the answer, so it could only return a confident
 * non-answer while carrying the authority of a governed research result. That is worse than an
 * obviously-unsourced answer, because the governance stamp suppresses the reader's doubt.
 *
 * Observed live: a session answered a cost-estimation question from memory, was challenged, and
 * routed the correction to `/research` — whose document mode then filed a paper about external
 * legal and pricing material into THIS project's notes/. Both halves are fixed here: the tool
 * routing, and the filing destination.
 *
 * Both target files are vendored to child projects, so these assertions also protect what
 * children receive.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL = path.join(ROOT, ".claude/skills/research/SKILL.md");
const PROMPT = path.join(ROOT, ".rks/prompts/governor-research.md");

const skillSrc = () => fs.readFileSync(SKILL, "utf8");
const promptSrc = () => fs.readFileSync(PROMPT, "utf8");

describe("research SKILL.md — query mode can reach external research", () => {
  it("names rks_agent_external_research at all", () => {
    // Pre-fix this was zero across the entire .claude/skills tree — query mode had no route
    // to the external tool whatsoever.
    expect(skillSrc()).toContain("rks_agent_external_research");
  });

  it("both query-mode sites carry the routing distinction", () => {
    // There are TWO query-mode sites: the Mode Detection summary and the Query Mode
    // Instructions dispatch. Editing only one leaves the other prescribing the old behaviour,
    // so they are asserted together and are mutually constraining.
    const src = skillSrc();
    const detectionIdx = src.indexOf("## Mode Detection");
    const instructionsIdx = src.indexOf("## Query Mode Instructions");
    const docModeIdx = src.indexOf("## Document Mode Instructions");
    expect(detectionIdx).toBeGreaterThan(-1);
    expect(instructionsIdx).toBeGreaterThan(detectionIdx);
    expect(docModeIdx).toBeGreaterThan(instructionsIdx);

    const detection = src.slice(detectionIdx, instructionsIdx);
    const instructions = src.slice(instructionsIdx, docModeIdx);

    expect(detection, "Mode Detection lacks the external route").toContain("rks_agent_external_research");
    expect(instructions, "Query Mode Instructions lacks the external route").toContain("rks_agent_external_research");
  });

  it("keeps rks_agent_research as the INTERNAL route rather than replacing it", () => {
    // The fix is a distinction, not a swap. Losing the internal route would break every
    // codebase question, which is the common case.
    expect(skillSrc()).toContain("rks_agent_research({");
  });

  it("states that an ungrounded external answer must not be presented as grounded", () => {
    const src = skillSrc();
    expect(src).toMatch(/not grounded/i);
  });
});

describe("research SKILL.md — external papers are not filed in this project's backlog", () => {
  it("document mode names the research.external namespace", () => {
    expect(skillSrc()).toContain("research.external");
  });

  it("document mode says a different project's paper is handed off, not filed here", () => {
    expect(skillSrc()).toMatch(/hand it off|hand-off/i);
  });
});

describe("governor-research.md — external papers are filed separately", () => {
  it("routes external-subject papers to research.external and hands off other projects'", () => {
    const src = promptSrc();
    expect(src).toContain("research.external");
    expect(src).toMatch(/do not file it here/i);
  });
});
describe("the Tool Reliability block is untouched", () => {
  // v0.43.0 asserts this block byte-identical across five governor prompts. These edits sit
  // strictly above it; if any byte inside it moved, the parity suite would red — this is the
  // local early warning so the cause is obvious rather than surfacing as a parity failure in
  // an unrelated file.
  it("still contains exactly one Tool Reliability heading", () => {
    const count = promptSrc().split("## Tool Reliability").length - 1;
    expect(count).toBe(1);
  });

  it("no new ## heading was introduced inside the block", () => {
    const src = promptSrc();
    const start = src.indexOf("## Tool Reliability");
    const rest = src.slice(start).split("\n");
    // The block ends at the next line-initial "## "; the first one after the heading must be
    // the Rules section that has always followed it.
    const nextHeading = rest.slice(1).find((l) => l.startsWith("## "));
    expect(nextHeading).toBe("## Rules");
  });

  it("the three retirement pointers survive", () => {
    const src = promptSrc();
    expect(src).toContain("Retired by: backlog.fix.exhaustive-search-dotdir-silent-zero");
    expect(src).toContain("Retired by: backlog.fix.research-agent-output-contract");
    expect(src).toContain("Retired by: backlog.fix.yaml-frontmatter-quoting");
  });
});

describe("placeholders are not unified across the two files", () => {
  it("SKILL.md keeps its source-project token and the prompt keeps __PROJECT_ID__", () => {
    // "Cross-file parity" must not be read as unifying placeholders — they are resolved by
    // different mechanisms at different times, and swapping either breaks substitution.
    //
    // backlog.fix.published-tests-upstream-coupled — AC9. skillSrc() reads the REAL
    // .claude/skills/research/SKILL.md, and normalizeExportIdentity rewrites
    // .claude/skills/**/*.md in the published snapshot. Pinning __RKS_SOURCE_PROJECT__ here
    // was therefore true upstream and FALSE on the mirror. The skill's token is now derived
    // from its own Replace clause — the sentinel upstream, the resolved identity in the
    // snapshot — so the thing this test is actually about (the two files do NOT share one
    // placeholder) is asserted in both topologies rather than only one.
    const clause = skillSrc().match(/Replace __PROJECT_ID__ with ([A-Za-z0-9_-]+)/);
    expect(clause, "research SKILL.md no longer names its source-project substitution").not.toBeNull();
    const skillToken = clause[1];

    // TWO DISTINCT PLACEHOLDERS — unifying them is the regression this guards.
    expect(skillToken).not.toBe("__PROJECT_ID__");
    // The skill USES the token it names, rather than only mentioning it in the clause.
    expect(skillSrc().split(skillToken).length - 1).toBeGreaterThanOrEqual(2);

    // .rks/prompts/ is NOT one of the identity-rewritten classes, so both assertions below
    // are stable in either topology and are left exactly as they were.
    expect(promptSrc()).toContain("__PROJECT_ID__");
    expect(promptSrc()).not.toContain("__RKS_SOURCE_PROJECT__");
  });
});
