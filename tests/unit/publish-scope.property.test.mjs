import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import yaml from "js-yaml";
import { generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";

/**
 * backlog.feat.rag-boundary-deep-scrub-property-tests
 *
 * Property lock for the publish scope / privacy-by-omission contract — generalizes the example-based
 * publish-rks-public-profile.test.mjs. Uses the REAL rks-public profile against a fixture repo.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const config = yaml.load(readFileSync(join(ROOT, ".routekit/publish-profiles.yaml"), "utf-8"));
const rksPublic = config.profiles["rks-public"];

// Files that MUST ship (match an include glob, not an exclude) and files that MUST NOT (private
// classes kept out purely by omission from the allowlist).
const PUBLIC_FILES = [
  "packages/mcp-rks/src/server.mjs",
  "scripts/rag/init.mjs",
  "README.md",
  "CLAUDE.md",
  ".env.example",
  "notes/canon.what-is-rks.md",
  "notes/playbooks.lifecycle.md",
];
const PRIVATE_FILES = [
  ".env",
  ".mcp.json",
  ".rks/rag/routekit-shell-core.lancedb/data.lance",
  ".rks/active-scope.json",
  "projects/index.jsonl",
  "routekit/project.json",
  "notes/backlog.feat.secret-work.md",
  "notes/research.2026.01.01.private-thinking.md",
];
// Real repo files that match NO include glob — must be omitted purely by not being on the allowlist.
const NON_ALLOWLISTED_FILES = ["unlisted-junk.xyz", "random-top-level.dat"];

let repo;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "rks-publish-prop-"));
  for (const f of [...PUBLIC_FILES, ...PRIVATE_FILES, ...NON_ALLOWLISTED_FILES]) {
    const p = join(repo, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `x ${f}\n`);
  }
  const git = (args) => spawnSync("git", args, { cwd: repo, encoding: "utf-8", timeout: 30000 });
  git(["init", "-q"]);
  git(["config", "user.email", "t@rks.dev"]);
  git(["config", "user.name", "t"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
});
afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("publish scope — privacy-by-omission invariants", () => {
  it("PRIVATE classes (.env, RAG index, registry, runtime state, private notes) NEVER ship", () => {
    const sel = generateIncludeArgs(rksPublic, repo);
    for (const p of PRIVATE_FILES) {
      expect(sel, `private file must not ship: ${p}`).not.toContain(p);
    }
  });

  it("SOUND + COMPLETE: allowlisted public files ship; private and non-allowlisted files do not", () => {
    const sel = generateIncludeArgs(rksPublic, repo);
    // completeness — every allowlisted public fixture file is selected
    for (const p of PUBLIC_FILES) expect(sel, `public file must ship: ${p}`).toContain(p);
    // soundness — a REAL repo file that matches no include glob is omitted (nothing outside the
    // allowlist ships), and no private-class file leaks
    for (const p of NON_ALLOWLISTED_FILES) expect(sel, `non-allowlisted file must not ship: ${p}`).not.toContain(p);
    for (const p of PRIVATE_FILES) expect(sel, `private file must not ship: ${p}`).not.toContain(p);
  });

  it("PROPERTY: excluding ANY shipped file removes it — exclude post-filter always wins over include", () => {
    const shipped = generateIncludeArgs(rksPublic, repo);
    expect(shipped.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...shipped), (target) => {
        const profile = { ...rksPublic, exclude: [...(rksPublic.exclude || []), target] };
        const sel = generateIncludeArgs(profile, repo);
        return !sel.includes(target);
      }),
    );
  });

  it("PROPERTY: no private file ships regardless of which extra include globs are added, as long as it stays off the allowlist", () => {
    // Adding unrelated include globs must never pull a private-class file in (it only ships if an
    // include names it — which the real profile never does).
    fc.assert(
      fc.property(
        fc.subarray(["docs/**", "examples/**", "*.md", "assets/**"], { minLength: 0 }),
        (extraIncludes) => {
          const profile = { ...rksPublic, include: [...rksPublic.include, ...extraIncludes] };
          const sel = generateIncludeArgs(profile, repo);
          return PRIVATE_FILES.every((p) => !sel.includes(p));
        },
      ),
    );
  });
});
