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
});
