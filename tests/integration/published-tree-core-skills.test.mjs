/**
 * backlog.fix.preflight-core-skills-not-distributed — AC: empirical published-tree check.
 *
 * A clean clone of the public mirror reported `core_skills 17/18 present — MISSING: whitepaper`
 * and told the user to run `git checkout HEAD -- .claude/skills`, which cannot work: that path
 * was never in the mirror's HEAD. `.claude/skills/whitepaper/**` and `packages/whitepaper/**` are
 * excluded from the archive as a unit.
 *
 * This test builds the REAL archive publish.mjs builds and drives the REAL exported check against
 * the extracted tree. Asserting "the manifest no longer lists whitepaper" would NOT satisfy this —
 * see the anti-vacuity assertions at the end, which require the opposite.
 *
 * INTEGRATION TIER — spawns git and tar. Every spawnSync passes an explicit timeout.
 *
 * THIS TEST VALIDATES HEAD, NOT THE WORKING TREE. `git archive HEAD` reads the committed tree, so
 * the skills-manifest.json change is only witnessed after it is committed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";
import { checkGitReadiness } from "../../packages/mcp-rks/src/server/preflight.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILES_PATH = path.join(REPO_ROOT, ".routekit/publish-profiles.yaml");
const profile = yaml.load(fs.readFileSync(PROFILES_PATH, "utf8"))?.profiles?.["rks-public"];

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-published-skills-"));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!profile)("core_skills on the real published tree", () => {
  it("passes on a clean mirror clone, and never tells the user to git checkout", () => {
    const includeArgs = generateIncludeArgs(profile, REPO_ROOT);

    const tar = path.join(tmp, "pub.tar");
    const ar = spawnSync(
      "git",
      ["archive", "--format=tar", "-o", tar, "HEAD", ...includeArgs],
      { cwd: REPO_ROOT, timeout: 60_000, encoding: "utf8" },
    );
    // Surface stderr verbatim: a glob-free include matching nothing hard-fails here with
    // `fatal: pathspec ... did not match any files`. That is profile/tree drift, not this defect.
    expect(ar.error, `git archive process error: ${ar.error}`).toBeUndefined();
    expect(ar.status, `git archive failed:\n${ar.stderr ?? ""}`).toBe(0);

    const out = path.join(tmp, "tree");
    fs.mkdirSync(out, { recursive: true });
    const un = spawnSync("tar", ["-xf", tar, "-C", out], { timeout: 60_000, encoding: "utf8" });
    expect(un.error, `tar process error: ${un.error}`).toBeUndefined();
    expect(un.status, `tar extract failed:\n${un.stderr ?? ""}`).toBe(0);

    // REQUIRED. checkGitReadiness returns early when the tree is not a git repo and never pushes
    // core_skills at all, so without this the assertions below would pass through a path that
    // never exercises the fix. No commit is needed — only the hasGitRepo gate matters.
    // Deliberately NO `origin` remote: github_remote then takes the absent-pushUrl branch and
    // never reaches its `git ls-remote` network call.
    const gi = spawnSync("git", ["init"], { cwd: out, timeout: 60_000, encoding: "utf8" });
    expect(gi.status, `git init failed:\n${gi.stderr ?? ""}`).toBe(0);

    const checks = checkGitReadiness({ projectRoot: out, projectJson: {}, timeoutMs: 15_000 });
    const check = checks.find((c) => c.name === "core_skills");

    // The check must have been EMITTED. A silently absent check is not a pass.
    expect(check, "core_skills was not emitted — the early-return gate was hit").toBeTruthy();
    expect(check.passed, `core_skills failed on the published tree: ${check.detail}`).toBe(true);

    // The defect: an instruction that cannot work in the context it is shown in.
    expect(check.hint ?? "").not.toContain("git checkout");
    // And it must not read as a deficit.
    expect(check.detail).not.toMatch(/\b17\s*\/\s*18\b/);
    expect(check.detail).not.toMatch(/MISSING/i);

    // ANTI-VACUITY 1: preflight greens whenever loadSkillsManifest FAILS. An extracted tree merely
    // lacking the manifest would report passed === true with the fix entirely absent.
    expect(check.detail).not.toMatch(/no manifest/i);

    // POSITIVE CONTROL: this is the published shape, not an accidental full copy.
    expect(fs.existsSync(path.join(out, ".claude/skills/build/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, ".claude/skills/whitepaper/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(out, "packages/whitepaper"))).toBe(false);

    // ANTI-VACUITY 2: the pass must come from CLASSIFICATION, not from whitepaper having been
    // dropped from the manifest. The extracted manifest must still declare it.
    const extractedManifest = JSON.parse(
      fs.readFileSync(path.join(out, ".routekit/skills-manifest.json"), "utf8"),
    );
    expect(extractedManifest.skills).toContain("whitepaper");
  }, 300_000);
});
