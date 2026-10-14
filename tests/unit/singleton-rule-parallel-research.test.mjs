import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Documentation-contract test for the Singleton Rule — CLAUDE.md, the seven
// Governor-launching skills, and the Research Governor prompt's step 3.
//
// backlog.feat.restore-parallel-research-governors. The serial-only rule this file
// used to pin rested on a process-global session: every rks_governor_init could
// reset or end another Governor's session. backlog.fix.governor-session-identity-process-global
// (released 0.59.11) gave each problemId-less (open-flow) init its own token and
// session, so the rule now PERMITS Research Governors to run concurrently with each
// other and with PO/ARCH Governors on distinct notes, and keeps Build, exec, ship,
// ops, QA and off-rail work EXCLUSIVE.
//
// WHAT A GREEN RUN HERE DOES AND DOES NOT EVIDENCE. These assertions read prose.
// Green proves only that the documents SAY the contract; it does not evidence that
// sessions are isolated (tests/unit/governor-session-multi-caller.test.mjs does) and
// it does not evidence that the Dispatcher obeys the rule — nothing enforces it at
// runtime, as the section itself states. The section must cite its two source files
// BY PATH and those paths are asserted to exist, which keeps the claim checkable.
//
// POLARITY IS CARRIED BY ABSENCE ASSERTIONS, NEVER BY PROXIMITY. A proximity regex
// such as /Build[\s\S]{0,120}parallel/ matches "Build may run in parallel" exactly as
// readily as "Build never runs in parallel". The EXCLUSION is therefore pinned by
// negative assertions over every sentence of the section: no sentence that grants
// concurrency ("may/can run concurrently/in parallel with") names an excluded type.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf-8");
const CLAUDE_MD = read("CLAUDE.md");

const HEADING = "## Singleton Rule";

// Isolate the Singleton Rule section (from its heading line to the next H2).
function singletonSection(src) {
  const start = src.indexOf(`\n${HEADING}\n`);
  if (start === -1) return "";
  const rest = src.slice(start + HEADING.length + 2);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

// Split prose into sentences. Version numbers ("0.59.11") and file extensions
// (".mjs") keep their dots because the split requires a dot followed by whitespace.
function sentences(text) {
  return text
    .replace(/\*\*/g, "")
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EXCLUDED = /\b(Build|exec|ship|ops|QA|off-rail|guardrails-off)\b/i;
const GRANT = /\b(may|can|could|are allowed to|is allowed to)\s+(run|be (run|launched|dispatched))\s+(concurrently|in parallel)\b/i;
const PARALLEL_WITH = /\b(concurrently|in parallel)\s+with\b/i;

// A sentence that grants concurrency must not name an excluded Governor type.
function grantingSentencesNamingExcluded(text) {
  return sentences(text).filter(
    (s) => (GRANT.test(s) || PARALLEL_WITH.test(s)) && EXCLUDED.test(s),
  );
}

describe("CLAUDE.md Singleton Rule — parallel open-flow Governors, exclusive story/ship/off-rail work", () => {
  const section = singletonSection(CLAUDE_MD);

  it("has exactly one Singleton Rule section", () => {
    expect(CLAUDE_MD.split(`\n${HEADING}\n`).length - 1).toBe(1);
    expect(section.length).toBeGreaterThan(0);
  });

  it("permits Research Governors to run concurrently with each other and with PO and ARCH Governors on distinct notes", () => {
    const paragraphs = section.split(/\n\s*\n/);
    const allowance = paragraphs.find(
      (p) => /Research Governors may run concurrently with each other/i.test(p),
    );
    expect(allowance, "allowance paragraph").toBeTruthy();
    expect(allowance).toMatch(/\bPO\b/);
    expect(allowance).toMatch(/\bARCH\b/);
    // The condition sits in the SAME paragraph as the grant.
    expect(allowance).toMatch(/distinct note filename|distinct (note|topic)/i);
  });

  it("names Build, exec, ship, ops, QA and off-rail (guardrails-off) work as running alone", () => {
    const exclusion = sentences(section).find((s) => /run alone/i.test(s));
    expect(exclusion, "exclusion sentence").toBeTruthy();
    for (const kind of ["Build", "exec", "ship", "ops", "QA", "off-rail", "guardrails-off"]) {
      expect(exclusion).toContain(kind);
    }
    expect(section).toMatch(/Never launch any Governor/);
  });

  it("states the exclusion reasons", () => {
    expect(section).toMatch(/branch and worktree mutation/i);
    expect(section).toMatch(/base-branch checkout/i);
    expect(section).toContain(".rks/active-scope.json");
    expect(section).toContain("backlog.fix.governor-init-deletes-live-offrail-scope");
    // The off-rail exclusion is grounded on reasons that hold after the sibling fix lands.
    expect(section).toContain("hooks.bak");
    expect(section).toMatch(/off-rail exclusion stands/i);
  });

  it("grants concurrency to none of Build, QA, exec, ship, ops or off-rail work", () => {
    expect(grantingSentencesNamingExcluded(section)).toEqual([]);
    // Positive control: the helper does flag a granting sentence naming an excluded type.
    expect(grantingSentencesNamingExcluded("Build Governors may run concurrently with Research Governors.")).toHaveLength(1);
    expect(grantingSentencesNamingExcluded("Research may run in parallel with QA.")).toHaveLength(1);
  });

  it("drops the stale shared-session premise", () => {
    expect(section).not.toContain("share one mutable session");
    expect(section).not.toContain("until that story is integrated");
    expect(section).not.toContain("strictly serial and exclusive");
    expect(section).not.toMatch(/can reset, or end outright/i);
    expect(section).not.toMatch(/rks_governor_init[^.]*\bcan\s+(reset|end)\b/i);
    expect(section).not.toMatch(/\bcan\s+(reset|end)[^.]*session another Governor/i);
  });

  it("cites the session-identity fix together with release 0.59.11", () => {
    const cite = sentences(section).find((s) =>
      s.includes("backlog.fix.governor-session-identity-process-global"),
    );
    expect(cite, "sentence citing the fix").toBeTruthy();
    expect(cite).toContain("0.59.11");
  });

  it("cites both session-resolution source files by path, and both exist on disk", () => {
    for (const p of [
      "packages/mcp-rks/src/shared/governor-token.mjs",
      "packages/mcp-rks/src/tools/governor-init.mjs",
    ]) {
      expect(section).toContain(p);
      expect(existsSync(join(REPO_ROOT, p))).toBe(true);
    }
  });

  it("states the rule is a Dispatcher-behavior contract, not coded enforcement", () => {
    expect(section).toContain("Dispatcher-behavior contract");
    expect(section).toMatch(/not a coded concurrency cap|nothing in the MCP server enforces it/i);
  });

  it("CLAUDE.md no longer offers the process-global pointer as a reason", () => {
    expect(CLAUDE_MD).not.toContain("process-global session pointer that the Singleton Rule exists to protect");
  });
});

const OPEN_FLOW_SKILLS = ["research", "arch", "pipeline"];
const ALONE_SKILLS = { build: "Build", qa: "QA", ship: "Ship", ops: "Ops" };
const ALL_SKILLS = [...OPEN_FLOW_SKILLS, ...Object.keys(ALONE_SKILLS)];
const skill = (name) => read(`.claude/skills/${name}/SKILL.md`);

describe("Governor-launching skills state the Singleton Rule inline", () => {
  it.each(ALL_SKILLS)("%s/SKILL.md drops the unconditional serial-only sentence", (name) => {
    const body = skill(name);
    expect(body).not.toContain(
      "Never run two Governors in parallel. Always wait for each to complete before launching the next.",
    );
    expect(body).not.toContain("Never run two Governors in parallel.");
  });

  it.each(OPEN_FLOW_SKILLS)("%s/SKILL.md states the open-flow allowance and the exclusion inline", (name) => {
    const body = skill(name);
    expect(body).toMatch(/Research, PO and ARCH Governors[^.]*may run concurrently with each other/);
    expect(body).toMatch(/distinct note filename/);
    for (const kind of ["Build", "exec", "ship", "ops", "QA", "off-rail", "guardrails-off"]) {
      expect(body).toContain(kind);
    }
    expect(grantingSentencesNamingExcluded(body)).toEqual([]);
  });

  it.each(Object.entries(ALONE_SKILLS))("%s/SKILL.md states its Governor runs alone", (name, label) => {
    const body = skill(name);
    expect(body).toContain(`The ${label} Governor runs alone.`);
    expect(body).toMatch(/Never launch any other Governor of any type, Research included/);
    expect(grantingSentencesNamingExcluded(body)).toEqual([]);
  });

  it("arch/SKILL.md keeps 'Singleton Rule' and 'two Governors in parallel'", () => {
    const body = skill("arch");
    expect(body).toContain("Singleton Rule");
    expect(body).toContain("two Governors in parallel");
  });

  it.each(ALL_SKILLS)("%s/SKILL.md Singleton Rule section carries no project id", (name) => {
    const body = skill(name);
    const section = singletonSection(body.startsWith("\n") ? body : `\n${body}`);
    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toContain("routekit-shell");
  });
});

describe("Research Governor prompt — embed-lock refusal is non-fatal", () => {
  const prompt = read(".rks/prompts/governor-research.md");
  const step3 = (() => {
    const start = prompt.indexOf("\n3. mcp__rks__rks_rag_embed");
    const end = prompt.indexOf("\n## ", start);
    return start === -1 || end === -1 ? "" : prompt.slice(start, end);
  })();

  it("step 3 retries an 'Embed already in progress' refusal once, then reports and completes", () => {
    expect(step3.length).toBeGreaterThan(0);
    expect(step3).toContain("Embed already in progress");
    expect(step3).toMatch(/NON-FATAL/i);
    expect(step3).toMatch(/Retry the same call once/);
    expect(step3).toMatch(/record the refusal in the return payload/);
    expect(step3).toMatch(/complete normally/);
  });

  it("any other embed error still STOPs, and the Rules line is unchanged", () => {
    expect(step3).toMatch(/Any other rks_rag_embed error still STOPs/);
    expect(prompt).toContain("- Error → STOP. Return { status: 'failed', error, summary }.");
  });
});
