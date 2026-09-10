/**
 * Onboard skill discovery + rename (backlog.feat.fix-onboard-skill-discovery-and-rename).
 *
 * TURNKEY-CRITICAL fix: the onboarder skill was a FLAT file (.claude/skills/onboard.md), which
 * Claude Code never registers — it only discovers the DIRECTORY form .claude/skills/<name>/SKILL.md.
 * So `/onboard` was "Unknown command" in every clone. This migrates it to directory form and
 * renames it to /rks-onboard (+ /rks-welcome alias) to avoid the native `/team onboarder` collision.
 * The publish allowlist already ships `.claude/skills/**`, so the directory-form skill reaches clones.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const exists = (rel) => existsSync(join(ROOT, rel));

describe("onboard skill — discovery/layout (the load-bearing fix)", () => {
  it("rks-onboard exists in DIRECTORY form with name frontmatter (this is what makes it register)", () => {
    expect(exists(".claude/skills/rks-onboard/SKILL.md")).toBe(true);
    const s = read(".claude/skills/rks-onboard/SKILL.md");
    expect(s).toContain("name: skills-rks-onboard");
    expect(s).toContain("user-invocable: true");
  });

  it("rks-welcome alias exists in DIRECTORY form", () => {
    expect(exists(".claude/skills/rks-welcome/SKILL.md")).toBe(true);
    expect(read(".claude/skills/rks-welcome/SKILL.md")).toContain("name: skills-rks-welcome");
  });

  it("the old FLAT skill files are gone (they never registered → 'Unknown command')", () => {
    expect(exists(".claude/skills/onboard.md")).toBe(false);
    expect(exists(".claude/skills/welcome.md")).toBe(false);
  });
});

describe("onboard skill — behavior preserved (relocated + renamed only)", () => {
  it("rks-onboard still drives rks_onboarder with the same flags", () => {
    const s = read(".claude/skills/rks-onboard/SKILL.md");
    expect(s).toContain("rks_onboarder");
    for (const flag of ["--skip-tour", "--bounce", "--reset", "--stage"]) {
      expect(s).toContain(flag);
    }
  });

  it("rks-welcome points at rks-onboard (alias)", () => {
    expect(read(".claude/skills/rks-welcome/SKILL.md")).toContain("/rks-onboard");
  });
});

describe("onboard skill — no lingering old command refs (repo hygiene)", () => {
  // Catch the OLD bare command "/onboard" but NOT the legitimate "/onboarder" module/state-file
  // path (which contains "/onboard" as a substring), and NOT the new "/rks-onboard" (slash is
  // followed by "rks-", so it contains no "/onboard" substring at all). The negative lookahead
  // (?!er) excludes "/onboarder".
  const files = [
    "CLAUDE.md",
    "README.md",
    "notes/how-to.child-project-kickoff.md",
    "packages/mcp-rks/src/server/onboarder.mjs",
    "packages/mcp-rks/src/server.mjs",
  ];
  it.each(files)("%s carries no bare /onboard or /welcome command", (f) => {
    const c = read(f);
    expect(c).not.toMatch(/\/onboard(?!er)/);
    expect(c).not.toContain("/welcome");
  });
});

describe("onboard skill — SMOKE: the renamed skill actually ships to cloners", () => {
  const config = yaml.load(read(".routekit/publish-profiles.yaml"));
  const rksPublic = config.profiles?.["rks-public"];

  it("rks-public publish profile ships .claude/skills/** (directory-form skill reaches clones)", () => {
    expect(rksPublic?.include).toContain(".claude/skills/**");
  });

  it("the rks-onboard SKILL.md exists under that shipped path", () => {
    expect(exists(".claude/skills/rks-onboard/SKILL.md")).toBe(true);
  });
});
