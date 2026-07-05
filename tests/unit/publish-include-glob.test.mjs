import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  generateIncludeArgs,
  generateExcludeArgs,
} from "../../packages/mcp-rks/src/server/publish.mjs";

// FUNCTIONAL coverage for the include-allowlist glob fix: assert the RESULTING FILE
// SET produced against a real fixture git repo, not argv shape (the pre-existing
// publish.test.mjs only checked argv). `**` globs must resolve to the right files;
// literal paths and directory prefixes must keep working; excludes must still filter.

const GIT_TIMEOUT = 30000;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

let repo;

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "rks-publish-glob-"));
  const files = [
    "notes/canon.what-is-rks.md",
    "notes/canon.phase-machine.md",
    "notes/how-to.publish.md",
    "notes/backlog.feat.secret-work.md", // must NOT be selected by a canon glob
    "notes/research.private.md",
    "packages/cli/bin/routekit.js",
    "packages/mcp-rks/src/server.mjs",
    "scripts/rag/init.mjs",
    "README.md",
    "LICENSE",
    ".env", // secret — must be excludable / never allowlisted
  ];
  for (const f of files) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `content of ${f}\n`);
  }
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@rks.dev"]);
  git(dir, ["config", "user.name", "rks test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}

// Run the real git archive path (exclude flags before HEAD, resolved include
// pathspecs after) and return the sorted list of files in the produced archive.
function archivedFiles(profile) {
  const excludeArgs = generateExcludeArgs(profile);
  const includeArgs = generateIncludeArgs(profile, repo);
  const res = spawnSync(
    "git",
    ["archive", "--format=tar", ...excludeArgs, "HEAD", ...includeArgs],
    { cwd: repo, encoding: "buffer", timeout: GIT_TIMEOUT },
  );
  if (res.status !== 0) throw new Error(`git archive failed: ${res.stderr}`);
  const list = spawnSync("tar", ["-tf", "-"], {
    input: res.stdout,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT,
  });
  // Keep files only; git archive emits directory entries (trailing "/") too.
  return list.stdout.split("\n").filter(Boolean).filter((f) => !f.endsWith("/")).sort();
}

describe("publish include-allowlist glob expansion (functional, offline)", () => {
  beforeAll(() => {
    repo = makeFixtureRepo();
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("AC1/AC7: `notes/canon.**` selects canon files and does NOT bleed into backlog/how-to siblings", () => {
    const specs = generateIncludeArgs({ include: ["notes/canon.**"] }, repo).sort();
    expect(specs).toEqual(["notes/canon.phase-machine.md", "notes/canon.what-is-rks.md"]);
    expect(specs).not.toContain("notes/backlog.feat.secret-work.md");
    expect(specs).not.toContain("notes/how-to.publish.md");

    const files = archivedFiles({ include: ["notes/canon.**"] });
    expect(files).toEqual(["notes/canon.phase-machine.md", "notes/canon.what-is-rks.md"]);
  });

  it("AC2: directory prefixes include their full subtree (no regression)", () => {
    const files = archivedFiles({ include: ["packages/", "scripts/"] });
    expect(files).toContain("packages/cli/bin/routekit.js");
    expect(files).toContain("packages/mcp-rks/src/server.mjs");
    expect(files).toContain("scripts/rag/init.mjs");
    expect(files).not.toContain("README.md");
    expect(files).not.toContain("notes/canon.what-is-rks.md");
  });

  it("AC3: literal file paths are included exactly (no regression)", () => {
    const files = archivedFiles({ include: ["README.md", "LICENSE"] });
    expect(files).toEqual(["LICENSE", "README.md"]);
  });

  it("AC4: an include entry matching nothing yields an empty selection and does not crash", () => {
    expect(generateIncludeArgs({ include: ["notes/nonexistent.**"] }, repo)).toEqual([]);
    expect(() => generateIncludeArgs({ include: ["notes/nope.**"] }, repo)).not.toThrow();
  });

  it("AC5: exclude-only profiles are unaffected by the include change", () => {
    // This story only touches include resolution; generateExcludeArgs is untouched.
    expect(generateExcludeArgs({ exclude: ["CLAUDE.md", ".rks/"] })).toEqual([
      "--exclude=CLAUDE.md",
      "--exclude=.rks/",
    ]);
    // An exclude-only profile produces no include pathspecs, so the archive restriction stays off.
    expect(generateIncludeArgs({ exclude: ["CLAUDE.md"] }, repo)).toEqual([]);
  });

  // NOTE discovered during this build: `git archive` has NO `--exclude` option on stock git,
  // so generateExcludeArgs is a PRE-EXISTING dead path (no live profile uses exclude; existing
  // tests only asserted argv shape). It is separate from this include-glob story. The include
  // ALLOWLIST is the real, privacy-safe filter. This test verifies the include side end-to-end
  // plus arg composition; the dead exclude-application path is flagged for the rks-public-profile
  // story (which will filter via the allowlist, not excludes).
  it("AC6: include globs expand and compose alongside exclude-arg generation", () => {
    const profile = { include: ["notes/canon.**", "README.md"], exclude: [".env"] };
    const includeArgs = generateIncludeArgs(profile, repo).sort();
    expect(includeArgs).toEqual([
      "README.md",
      "notes/canon.phase-machine.md",
      "notes/canon.what-is-rks.md",
    ]);
    expect(generateExcludeArgs(profile)).toEqual(["--exclude=.env"]);
    // Include side selects exactly the allowlisted files end-to-end.
    const files = archivedFiles({ include: ["notes/canon.**", "README.md"] });
    expect(files).toEqual([
      "README.md",
      "notes/canon.phase-machine.md",
      "notes/canon.what-is-rks.md",
    ]);
  });

  it("mixed glob + directory prefix + literal resolve together; secrets/private notes stay out", () => {
    const files = archivedFiles({ include: ["notes/canon.**", "packages/", "README.md"] });
    expect(files).toContain("notes/canon.what-is-rks.md");
    expect(files).toContain("packages/mcp-rks/src/server.mjs");
    expect(files).toContain("README.md");
    expect(files).not.toContain("notes/backlog.feat.secret-work.md");
    expect(files).not.toContain("notes/research.private.md");
    expect(files).not.toContain(".env");
  });

  it("back-compat: without projectRoot, patterns are returned unchanged", () => {
    expect(generateIncludeArgs({ include: ["notes/canon.**", "README.md"] })).toEqual([
      "notes/canon.**",
      "README.md",
    ]);
  });
});
