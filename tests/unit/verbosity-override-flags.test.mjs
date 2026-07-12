/**
 * Tests for per-invocation verbosity flags documentation in CLAUDE.md
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readClaudeMd() {
  return fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
}

describe("CLAUDE.md verbosity override flags documentation", () => {
  it("documents --silent, --heartbeat, and --verbose as recognized verbosity flags", () => {
    const content = readClaudeMd();
    expect(content).toContain("--silent");
    expect(content).toContain("--heartbeat");
    expect(content).toContain("--verbose");
  });

  it("states that the verbosity flag is passed through to the Governor sub-agent", () => {
    const content = readClaudeMd();
    // Must state the flag is communicated to the Governor (not stripped/consumed)
    expect(content).toMatch(/passes the flag|communicated.*Governor|Verbosity:.*mode/i);
  });

  it("documents the four-tier verbosity resolution order with per-invocation flag at tier 1", () => {
    const content = readClaudeMd();
    // Resolution order section must list all four tiers
    expect(content).toContain("Per-invocation flag");
    expect(content).toContain("skillDefaults");
    expect(content).toContain("SKILL.md");
    expect(content).toContain("fallback");
  });

  it("states that unknown flags (e.g. --debug) are NOT consumed as verbosity overrides", () => {
    const content = readClaudeMd();
    expect(content).toMatch(/unknown flag|not.*verbosity override|pass through.*unchanged/i);
  });

  it("includes example invocations for at least two skills", () => {
    const content = readClaudeMd();
    // Must include /research --silent and /build --heartbeat (or equivalent two-skill examples)
    expect(content).toContain("/research --silent");
    expect(content).toContain("/build --heartbeat");
  });
});
