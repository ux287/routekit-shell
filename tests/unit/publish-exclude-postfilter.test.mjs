import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { generateIncludeArgs, applyExclude } from "../../packages/mcp-rks/src/server/publish.mjs";

// Coverage for the post-filter exclude denylist added to generateIncludeArgs.
// `git archive` has no --exclude, so applyExclude runs over the include set we resolve
// ourselves. Must: drop .bak cruft + the private ux287 publisher, filter across ALL
// three return branches (glob-resolved, literal fast-path, listHeadFiles-null fallback),
// and be a strict no-op when exclude is absent/empty (back-compat for the 4 existing
// publish tests).

const GIT_TIMEOUT = 30000;
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("applyExclude — post-filter denylist (unit)", () => {
  it("back-compat: absent exclude returns the input unchanged (same reference)", () => {
    const paths = ["a.js", "b/c.js"];
    expect(applyExclude(paths, undefined)).toBe(paths);
  });

  it("back-compat: empty exclude returns the input unchanged (same reference)", () => {
    const paths = ["a.js", "b/c.js"];
    expect(applyExclude(paths, [])).toBe(paths);
  });

  it("drops files matching a glob denylist pattern", () => {
    const paths = ["packages/cli/bin/x.js", "packages/cli/bin/x.js.bak.123", "notes/a.md"];
    expect(applyExclude(paths, ["**/*.bak.*"])).toEqual(["packages/cli/bin/x.js", "notes/a.md"]);
  });

  it("drops a single-file literal exclude", () => {
    const paths = ["scripts/a.mjs", "scripts/publish-to-ux287.mjs"];
    expect(applyExclude(paths, ["scripts/publish-to-ux287.mjs"])).toEqual(["scripts/a.mjs"]);
  });

  it("plain **/*.bak matches .bak but not .bak.<n> (that needs **/*.bak.*)", () => {
    const paths = ["x/y.bak", "x/y.bak.99"];
    expect(applyExclude(paths, ["**/*.bak"])).toEqual(["x/y.bak.99"]);
    expect(applyExclude(paths, ["**/*.bak", "**/*.bak.*"])).toEqual([]);
  });
});

describe("generateIncludeArgs — exclude applied across all return branches", () => {
  let repo;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "rks-exclude-"));
    const files = [
      "packages/cli/bin/routekit.js",
      "packages/cli/bin/routekit.js.bak.1755987109",
      "packages/cli/src/hub-rebuild.js.bak.1755992519",
      "scripts/rag/init.mjs",
      "scripts/publish-to-ux287.mjs",
      "notes/canon.a.md",
      "README.md",
    ];
    for (const f of files) {
      const p = join(repo, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "x\n");
    }
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@rks.dev"]);
    git(repo, ["config", "user.name", "t"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "fixture"]);
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("GLOB branch: excludes drop .bak + ux287 tooling from the resolved set", () => {
    const profile = {
      include: ["packages/**", "scripts/**", "notes/canon.**"],
      exclude: ["**/*.bak", "**/*.bak.*", "scripts/publish-to-ux287.mjs"],
    };
    const sel = generateIncludeArgs(profile, repo);
    expect(sel).toContain("packages/cli/bin/routekit.js");
    expect(sel).toContain("scripts/rag/init.mjs");
    expect(sel).toContain("notes/canon.a.md");
    expect(sel).not.toContain("packages/cli/bin/routekit.js.bak.1755987109");
    expect(sel).not.toContain("packages/cli/src/hub-rebuild.js.bak.1755992519");
    expect(sel).not.toContain("scripts/publish-to-ux287.mjs");
  });

  it("BACK-COMPAT: without exclude, glob resolution is unchanged (still includes the .bak)", () => {
    const profile = { include: ["packages/**"] };
    const sel = generateIncludeArgs(profile, repo);
    expect(sel).toContain("packages/cli/bin/routekit.js.bak.1755987109");
  });

  it("LITERAL fast-path branch (no glob in include): exclude still filters", () => {
    const profile = {
      include: ["scripts/publish-to-ux287.mjs", "README.md"],
      exclude: ["scripts/publish-to-ux287.mjs"],
    };
    const sel = generateIncludeArgs(profile, repo);
    expect(sel).toEqual(["README.md"]);
  });

  it("listHeadFiles-null fallback branch (glob include, no projectRoot): exclude still filters", () => {
    const profile = {
      include: ["packages/**", "scripts/publish-to-ux287.mjs"],
      exclude: ["scripts/publish-to-ux287.mjs"],
    };
    const sel = generateIncludeArgs(profile); // no projectRoot → fallback returns patterns minus excludes
    expect(sel).toContain("packages/**");
    expect(sel).not.toContain("scripts/publish-to-ux287.mjs");
  });

  it("SNAPSHOT GUARD: resolved rks-public-style set has zero .bak and no ux287 publisher", () => {
    const profile = {
      include: ["packages/**", "scripts/**", "templates/**"],
      exclude: ["**/*.bak", "**/*.bak.*", "**/*.orig", "**/*~", "scripts/publish-to-ux287.mjs"],
    };
    const sel = generateIncludeArgs(profile, repo);
    expect(sel.some((f) => /\.bak(\.|$)/.test(f))).toBe(false);
    expect(sel).not.toContain("scripts/publish-to-ux287.mjs");
  });
});

// Regression for two publish() archive-integration bugs found during the FIRST real
// rks-public publish (both dormant while the only profile was the tiny docs-only one):
//   (1) publish() fed generateExcludeArgs (--exclude flags) to `git archive`, which has NO
//       --exclude option — so it errored the moment a profile defined `exclude`.
//   (2) the archive spawnSync had no maxBuffer, so a multi-MB snapshot tar overflowed the
//       ~1MB default and failed silently (empty stderr, null status).
describe("publish() archive spawn — regression guards", () => {
  const SRC = readFileSync(
    fileURLToPath(new URL("../../packages/mcp-rks/src/server/publish.mjs", import.meta.url)),
    "utf8",
  );
  const i = SRC.indexOf('["archive", "--format=tar"');
  const archiveRegion = SRC.slice(i, i + 400); // the spawnSync call + its options object

  it("locates the git-archive spawn", () => {
    expect(i).toBeGreaterThan(-1);
  });

  it("does NOT pass exclude flags to git archive (exclude is a post-filter, not --exclude)", () => {
    expect(archiveRegion).not.toMatch(/excludeArgs/);
    expect(archiveRegion).not.toMatch(/--exclude/);
  });

  it("sets a large maxBuffer on the archive spawn (the 1MB default overflows a real snapshot)", () => {
    expect(archiveRegion).toMatch(/maxBuffer/);
  });
});
