import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CLAUDE_MD = fs.readFileSync(path.resolve("CLAUDE.md"), "utf8");

describe("CLAUDE.md — Dispatcher Read Boundary Rule", () => {
  it("states off-rail reads are scoped to allowedFiles only", () => {
    expect(CLAUDE_MD).toMatch(/allowedFiles/);
    expect(CLAUDE_MD).toMatch(/off-rail.*session|off-rail.*scope|active-scope\.json/i);
  });

  it("states reads outside allowedFiles route to Research Governor", () => {
    expect(CLAUDE_MD).toMatch(/outside.*allowedFiles|outside that list/i);
    expect(CLAUDE_MD).toMatch(/rks_governor_init.*flowType.*open|flowType.*open.*rks_governor_init/);
    expect(CLAUDE_MD).toMatch(/rks_agent_research/);
  });

  it("states the Dispatcher must never read files directly to investigate internals", () => {
    expect(CLAUDE_MD).toMatch(/Dispatcher must never read files directly/i);
  });

  it("states the harness session-output exception and that it is not a general escape hatch", () => {
    // backlog.fix.harness-session-read-allowance-followup. The rule otherwise
    // reads as "route ALL non-trivial reads through the Research Governor",
    // which is no longer true for output the session itself produced.
    expect(CLAUDE_MD).toMatch(/session's own output|harness session-output/i);
    expect(CLAUDE_MD).toMatch(/tasks|scratchpad|tool-results/);
    // Verbatim, NOT a loose /general escape hatch/ — the surrounding section
    // already contains "as a general escape hatch" describing a different
    // misuse, so a looser regex would pass without this exception existing.
    expect(CLAUDE_MD).toContain("not a general escape hatch");
  });

  it("contains research paper naming convention with date pattern", () => {
    expect(CLAUDE_MD).toMatch(/research\.YYYY\.MM\.DD/);
  });

  it("distinguishes research paper vs inline answer based on durability", () => {
    expect(CLAUDE_MD).toMatch(/ephemeral|point-in-time/i);
    expect(CLAUDE_MD).toMatch(/inline/i);
    expect(CLAUDE_MD).toMatch(/research paper|notes\//i);
  });

  it("rule appears near Behavioral Rules or Hook Redirects section", () => {
    const behavioralIdx = CLAUDE_MD.indexOf("## Behavioral Rules");
    const hookIdx = CLAUDE_MD.indexOf("## Hook Redirects Are Mandatory");
    const ruleIdx = CLAUDE_MD.indexOf("## Dispatcher Read Boundary Rule");
    expect(ruleIdx).toBeGreaterThan(-1);
    // Rule must appear between Behavioral Rules and Hook Redirects (or just before Hook Redirects)
    expect(ruleIdx).toBeGreaterThan(behavioralIdx);
    expect(ruleIdx).toBeLessThan(hookIdx);
  });

  it("rule is self-contained — contains both the what and the handoff instruction", () => {
    const ruleStart = CLAUDE_MD.indexOf("## Dispatcher Read Boundary Rule");
    const hookStart = CLAUDE_MD.indexOf("## Hook Redirects Are Mandatory");
    const ruleSection = CLAUDE_MD.slice(ruleStart, hookStart);

    // Contains the blocking condition
    expect(ruleSection).toMatch(/allowedFiles/);
    // Contains the handoff instruction (exact next call)
    expect(ruleSection).toMatch(/rks_governor_init/);
    expect(ruleSection).toMatch(/rks_agent_research/);
    // Contains the path forward reinforcement
    expect(ruleSection).toMatch(/path forward|Research Governor/i);
  });

  // backlog.fix.dispatcher-read-boundary-git-provenance (G2). Git-diff branch
  // membership was removed as a provenance grant in session-state.mjs; the
  // section must now describe the five carve-outs that actually remain.
  it("enumerates the five MAY-read carve-outs", () => {
    const ruleStart = CLAUDE_MD.indexOf("## Dispatcher Read Boundary Rule");
    const hookStart = CLAUDE_MD.indexOf("## Hook Redirects Are Mandatory");
    const ruleSection = CLAUDE_MD.slice(ruleStart, hookStart);

    expect(ruleSection).toMatch(/five/i);
    // 1 — off-rail allowedFiles
    expect(ruleSection).toMatch(/allowedFiles/);
    // 2 — current plan targetFiles
    expect(ruleSection).toMatch(/targetFiles/);
    // 3 — this session's own harness output
    expect(ruleSection).toMatch(/harness output/i);
    // 4 — runtime/config allowlist
    expect(ruleSection).toMatch(/runtime_paths|read-policy\.yaml/);
    // 5 — this session's own writes, write-ledger TTL
    expect(ruleSection).toMatch(/write-ledger/i);
    // …and everything else routes to the Research Governor
    expect(ruleSection).toContain(
      "Every other project file routes to the Research Governor",
    );
  });

  it("states files merely touched on the current branch are NOT directly readable", () => {
    const ruleStart = CLAUDE_MD.indexOf("## Dispatcher Read Boundary Rule");
    const hookStart = CLAUDE_MD.indexOf("## Hook Redirects Are Mandatory");
    const ruleSection = CLAUDE_MD.slice(ruleStart, hookStart);

    expect(ruleSection).toContain(
      "Files merely touched on the current branch are NOT directly readable",
    );
    expect(ruleSection).toMatch(/[Bb]ranch membership is not a read grant/);
  });
});
