import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import yaml from "js-yaml";
import { generateIncludeArgs } from "../../packages/mcp-rks/src/server/publish.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PROFILES_PATH = join(ROOT, ".routekit/publish-profiles.yaml");
const config = yaml.load(readFileSync(PROFILES_PATH, "utf-8"));

const GIT_TIMEOUT = 30000;
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("rks-public publish profile — config (allowlist-only, privacy by omission)", () => {
  const rksPublic = config.profiles?.["rks-public"];

  it("defines an rks-public profile with an include allowlist and a post-filter exclude denylist", () => {
    expect(rksPublic).toBeTruthy();
    expect(Array.isArray(rksPublic.include)).toBe(true);
    expect(rksPublic.include.length).toBeGreaterThan(0);
    // The exclude is a REAL post-filter applied over the resolved include set (applyExclude
    // in publish.mjs) — NOT a dead git-archive --exclude. It drops .bak cruft + private tooling.
    expect(Array.isArray(rksPublic.exclude)).toBe(true);
    expect(rksPublic.exclude).toContain("**/*.bak");
    expect(rksPublic.exclude).toContain("**/*.bak.*");
    expect(rksPublic.exclude).toContain("scripts/publish-to-ux287.mjs");
  });

  it("allowlists the framework, harness, dev, and public docs a clone needs", () => {
    const inc = rksPublic.include;
    for (const p of [
      "packages/**",
      "scripts/**",
      "templates/**",
      "CLAUDE.md",
      ".claude/skills/**",
      ".claude/agents/**",
      ".rks/prompts/**",
      ".routekit/hooks/**",
      "tests/**",
      ".github/workflows/**",
      "package.json",
      "routekit/kg.yaml",
      "notes/canon.**",
      "notes/playbooks.**",
      "README.md",
      "LICENSE",
      ".env.example",
    ]) {
      expect(inc).toContain(p);
    }
  });

  it("never bare-lists .rks/ .claude/ .routekit/ .env (which would leak runtime state / RAG index / secrets)", () => {
    const inc = rksPublic.include;
    for (const bad of [
      ".rks/",
      ".rks/**",
      ".claude/",
      ".claude/**",
      ".routekit/",
      ".routekit/**",
      "routekit/**",
      "projects/**",
      ".env",
      ".envrc",
      ".mcp.json",
    ]) {
      expect(inc).not.toContain(bad);
    }
  });

  it("the rks-public remote (routekit-shell) resolves to the rks-public profile", () => {
    const remote = config.remotes?.["rks-public"];
    expect(remote).toBeTruthy();
    expect(remote.url).toContain("routekit-shell.git");
    expect(remote.profile).toBe("rks-public");
    expect(remote.branch).toBe("main");
  });
});

describe("rks-public profile — functional selection/omission against a fixture repo", () => {
  let repo;
  const rksPublicProfile = config.profiles["rks-public"];

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "rks-public-fixture-"));
    const files = [
      // --- public / MUST ship ---
      "packages/mcp-rks/src/server.mjs",
      "scripts/rag/init.mjs",
      "templates/base/vitest.config.unit.mjs",
      "src/router.js",
      "config/rag.config.yaml",
      "guardrails/policy.json",
      "CLAUDE.md",
      ".claude/skills/build/SKILL.md",
      ".claude/agents/governor.md",
      ".claude/settings.json",
      ".rks/prompts/governor-po.md",
      ".rks/project.json",
      ".routekit/hooks/read/redirect-read-to-agent.mjs",
      ".routekit/hooks-manifest.json",
      ".routekit/architecture-policy.yaml",
      "tests/unit/example.test.mjs",
      ".github/workflows/ci.yml",
      "package.json",
      "routekit/kg.yaml",
      "README.md",
      "LICENSE",
      ".env.example",
      "notes/canon.what-is-rks.md",
      "notes/how-to.release.md",
      "notes/research.public.overview.md",
      "notes/playbooks.lifecycle.md",
      // --- private / MUST NOT ship (kept out by omission) ---
      ".env",
      ".envrc",
      ".mcp.json",
      ".rks/rag/routekit-shell-core.lancedb/data.lance",
      ".rks/active-scope.json",
      ".rks/sessions/s1.json",
      "routekit/rag/index.lance",
      "routekit/project.json",
      "projects/index.jsonl",
      "notes/backlog.feat.secret-work.md",
      "notes/backlog.z_implemented.feat.done.md",
      "notes/research.2026.01.01.private-thinking.md",
      "notes/design.arch.internal.md",
      "notes/drafts.ideas.wip.md",
    ];
    for (const f of files) {
      const p = join(repo, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `x ${f}\n`);
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

  it("SELECTS the framework, harness, dev, and public docs", () => {
    const sel = generateIncludeArgs(rksPublicProfile, repo);
    for (const p of [
      "packages/mcp-rks/src/server.mjs",
      "scripts/rag/init.mjs",
      "src/router.js",
      ".claude/skills/build/SKILL.md",
      ".claude/agents/governor.md",
      ".rks/prompts/governor-po.md",
      ".routekit/hooks/read/redirect-read-to-agent.mjs",
      "tests/unit/example.test.mjs",
      ".github/workflows/ci.yml",
      "routekit/kg.yaml",
      "notes/canon.what-is-rks.md",
      "notes/research.public.overview.md",
      "notes/playbooks.lifecycle.md",
      "README.md",
      ".env.example",
    ]) {
      expect(sel).toContain(p);
    }
  });

  it("OMITS secrets, the RAG index, runtime state, the registry, and private notes", () => {
    const sel = generateIncludeArgs(rksPublicProfile, repo);
    for (const bad of [
      ".env",
      ".envrc",
      ".mcp.json",
      ".rks/rag/routekit-shell-core.lancedb/data.lance",
      ".rks/active-scope.json",
      ".rks/sessions/s1.json",
      "routekit/rag/index.lance",
      "routekit/project.json",
      "projects/index.jsonl",
      "notes/backlog.feat.secret-work.md",
      "notes/backlog.z_implemented.feat.done.md",
      "notes/research.2026.01.01.private-thinking.md",
      "notes/design.arch.internal.md",
      "notes/drafts.ideas.wip.md",
    ]) {
      expect(sel).not.toContain(bad);
    }
  });

  it(".env.example ships but .env does not — the secret boundary holds", () => {
    const sel = generateIncludeArgs(rksPublicProfile, repo);
    expect(sel).toContain(".env.example");
    expect(sel).not.toContain(".env");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.shell-self-sync-skill-wipe-health-gate — the manifest MUST reach the mirror
// ══════════════════════════════════════════════════════════════════════════════════
//
// preflight's core_skills check reads .routekit/skills-manifest.json. If that file does not SHIP,
// the check silently degrades to a no-op on a mirror clone — and a mirror clone is exactly the
// machine the skill wipe was discovered on. The fix would have re-broken itself on the one box that
// mattered.
//
// This is not a hypothetical oversight: the include list is an ALLOWLIST, `.routekit/hooks-manifest.json`
// is enumerated by NAME, and the only other `.routekit` glob is `*.yaml`. A new `.json` matches
// NOTHING unless it is named here.
describe("rks-public profile — skills-manifest.json ships (preflight needs it on a mirror clone)", () => {
  const rksPublic = config.profiles?.["rks-public"];

  it("names .routekit/skills-manifest.json in the include allowlist", () => {
    expect(rksPublic.include).toContain(".routekit/skills-manifest.json");
  });

  it("no existing glob would have caught it (this is why it must be named)", () => {
    // POSITIVE CONTROL for the assertion above: prove the file genuinely needs an explicit entry, so
    // a future reader does not "simplify" it away believing `.routekit/*.yaml` or `.routekit/**`
    // already covers it.
    const globs = rksPublic.include.filter((p) => p.startsWith(".routekit/") && p.includes("*"));
    for (const g of globs) {
      expect(g.endsWith(".yaml") || g.includes("hooks/") || g.includes("agents/") || g.includes("git-hooks/")).toBe(true);
    }
    // …and the sibling manifest is likewise named explicitly, not glob-matched.
    expect(rksPublic.include).toContain(".routekit/hooks-manifest.json");
  });
});
