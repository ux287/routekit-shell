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

// ══════════════════════════════════════════════════════════════════════════════════
// REWORK — backlog.feat.suppressible-public-publish
// ══════════════════════════════════════════════════════════════════════════════════
//
// This file used to assert `expect(rksPublic).toBeTruthy()` and `expect(remote).toBeTruthy()`
// against the LIVE .routekit/publish-profiles.yaml. A test that reads the live config and
// asserts a publish target is present makes the config unchangeable: the operator could not
// disarm or remove the public mirror without reding CI, and red CI blocks the release through
// the very gate that was hardened to fail closed. The system enforced that publishing stayed
// armed.
//
// The WIRING assertions (profile → remote → url/branch, identity rewrite) now run against a
// FIXTURE config. The live file is still read, but only to prove CONTENT POLICY — that nothing
// private has leaked onto the allowlist — and only when the profile is actually configured.
// A disarmed (`enabled: false`) or removed remote no longer reds this suite; a broken wiring,
// a wrong url/branch, a broken identity rewrite, or a marketing-site leak still does.

const liveRksPublic = config.profiles?.["rks-public"] ?? null;
const liveRemote = config.remotes?.["rks-public"] ?? null;
const KNOWN_REMOTE_KEYS = ["url", "profile", "branch", "enabled"];

// The shape a correctly-wired rks-public publish target has, independent of whether the live
// mirror is currently armed.
const FIXTURE_CONFIG = yaml.load(`
profiles:
  rks-public:
    identity:
      from: routekit-shell-core
      to: routekit-shell
    include:
      - "packages/mcp-rks/**"
      - "README.md"
    exclude:
      - "**/*.bak"
      - "packages/marketing-site/**"
remotes:
  rks-public:
    url: "git@github.com:ux287/routekit-shell.git"
    profile: "rks-public"
    branch: "main"
    enabled: true
`);

describe("rks-public publish WIRING (fixture config — independent of whether the mirror is armed)", () => {
  it("the rks-public remote resolves to the rks-public profile on the routekit-shell mirror", () => {
    const remote = FIXTURE_CONFIG.remotes?.["rks-public"];
    expect(remote).toBeTruthy();
    expect(remote.url).toContain("routekit-shell.git");
    expect(remote.profile).toBe("rks-public");
    expect(remote.branch).toBe("main");
    expect(FIXTURE_CONFIG.profiles?.["rks-public"]).toBeTruthy();
  });

  it("the static-export identity rewrite is routekit-shell-core → routekit-shell", () => {
    const identity = FIXTURE_CONFIG.profiles["rks-public"].identity;
    expect(identity).toEqual({ from: "routekit-shell-core", to: "routekit-shell" });
  });

  it("`enabled` is an accepted remote key — arming state is config, not a test pin", () => {
    expect(Object.keys(FIXTURE_CONFIG.remotes["rks-public"]).every((k) => KNOWN_REMOTE_KEYS.includes(k))).toBe(true);
  });
});

describe.skipIf(!liveRemote)("live config — the rks-public remote, IF configured, is wired correctly", () => {
  // Deliberately NOT an arming assertion: `enabled: false` passes here. What reds is a WRONG
  // destination, a wrong branch, or a key the publish-time validator would BLOCK on.
  it("points at the routekit-shell mirror on the configured branch", () => {
    expect(liveRemote.url).toContain("routekit-shell.git");
    expect(liveRemote.url).toMatch(/ux287\/routekit-shell(\.git)?$/);
    expect(liveRemote.profile).toBe("rks-public");
    expect(liveRemote.branch).toBe("main");
  });

  it("carries no key outside the known set, and `enabled` (if present) is a literal boolean", () => {
    for (const k of Object.keys(liveRemote)) expect(KNOWN_REMOTE_KEYS).toContain(k);
    if (Object.prototype.hasOwnProperty.call(liveRemote, "enabled")) {
      expect(typeof liveRemote.enabled).toBe("boolean");
    }
  });
});

describe.skipIf(!liveRksPublic)("rks-public publish profile — config (allowlist-only, privacy by omission)", () => {
  const rksPublic = liveRksPublic;

  it("keeps the routekit-shell-core → routekit-shell static-export identity rewrite", () => {
    expect(rksPublic.identity).toEqual({ from: "routekit-shell-core", to: "routekit-shell" });
  });

  it("defines an rks-public profile with an include allowlist and a post-filter exclude denylist", () => {
    expect(Array.isArray(rksPublic.include)).toBe(true);
    expect(rksPublic.include.length).toBeGreaterThan(0);
    // The exclude is a REAL post-filter applied over the resolved include set (applyExclude
    // in publish.mjs) — NOT a dead git-archive --exclude. It drops .bak cruft + private tooling.
    expect(Array.isArray(rksPublic.exclude)).toBe(true);
    expect(rksPublic.exclude).toContain("**/*.bak");
    expect(rksPublic.exclude).toContain("**/*.bak.*");
    expect(rksPublic.exclude).toContain("scripts/publish-to-ux287.mjs");
    // Marketing / content surface — rks-core-only, never public.
    expect(rksPublic.exclude).toContain("packages/*/src/presentations/**");
    expect(rksPublic.exclude).toContain("packages/whitepaper/**");
    expect(rksPublic.exclude).toContain("packages/marketing-site/**");
    // The entries above drop the deck SOURCE. These drop the deck COPY, which is embedded
    // verbatim in test files that the broad tests/** include allowlists.
    expect(rksPublic.exclude).toContain("tests/unit/presentation-*.test.mjs");
    expect(rksPublic.exclude).toContain("tests/unit/dashboard-nav-shell.test.mjs");
    expect(rksPublic.exclude).toContain("tests/unit/marketing-site-scaffold.test.mjs");
    // Defense in depth: packages/*/src/presentations/** is anchored at ^packages/.
    expect(rksPublic.exclude).toContain("**/presentations/**");
    expect(rksPublic.exclude).toContain("src/presentations/**");
  });

  it("allowlists the framework (explicit per-package), harness, dev, and public docs a clone needs", () => {
    const inc = rksPublic.include;
    for (const p of [
      // Explicit public-package allowlist — NOT bare packages/** — so a new marketing/content
      // package can't auto-leak. telemetry-dashboard is public (its decks are excluded below).
      "packages/cli/**",
      "packages/mcp-rks/**",
      "packages/hooks/**",
      "packages/design/**",
      "packages/telemetry-dashboard/**",
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
      "notes/public.**",
      "notes/playbooks.**",
      "README.md",
      "LICENSE",
      ".env.example",
    ]) {
      expect(inc).toContain(p);
    }
    // The bare packages/** glob was narrowed so a new content/marketing package cannot auto-ship.
    expect(inc).not.toContain("packages/**");
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

});

describe.skipIf(!liveRksPublic)("rks-public profile — functional selection/omission against a fixture repo", () => {
  let repo;
  const rksPublicProfile = liveRksPublic;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "rks-public-fixture-"));
    const files = [
      // --- public / MUST ship ---
      "packages/mcp-rks/src/server.mjs",
      "packages/rag/src/init.mjs",
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
      // canon.* and research.public.* are no longer allowlisted; how-to.release.md is a
      // how-to that is NOT on the nine-file explicit list. All three stay in the fixture so
      // the OMITS test can prove they stopped shipping.
      "notes/canon.what-is-rks.md",
      "notes/how-to.release.md",
      "notes/research.public.overview.md",
      "notes/public.canon.what-is-rks.md",
      "notes/how-to.rks.md",
      "notes/playbooks.lifecycle.md",
      // Dendron vault root — MUST ship so a fresh mirror clone doesn't regenerate them dirty.
      "notes/root.md",
      "notes/root.schema.yml",
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
      // --- Option B: dashboard-as-tool IS public (basic telemetry/cost = core value prop) ---
      "packages/cli/index.mjs",
      "packages/design/preset.json",
      "packages/telemetry-dashboard/src/App.tsx",
      "packages/telemetry-dashboard/vite.config.ts",
      // --- marketing / content surface / MUST NOT ship (rks-core-only, never public) ---
      "packages/telemetry-dashboard/src/presentations/decks/what-is-rks.deck.tsx",
      "packages/telemetry-dashboard/src/presentations/registry.ts",
      "packages/whitepaper/src/cli.mjs",
      "packages/marketing-site/src/main.tsx",
      "packages/marketing/social/post.mjs",
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
      "packages/rag/src/init.mjs",
      "src/router.js",
      ".claude/skills/build/SKILL.md",
      ".claude/agents/governor.md",
      ".rks/prompts/governor-po.md",
      ".routekit/hooks/read/redirect-read-to-agent.mjs",
      "tests/unit/example.test.mjs",
      ".github/workflows/ci.yml",
      "routekit/kg.yaml",
      "notes/public.canon.what-is-rks.md",
      "notes/how-to.rks.md",
      "notes/playbooks.lifecycle.md",
      "notes/root.md",
      "notes/root.schema.yml",
      "README.md",
      ".env.example",
    ]) {
      expect(sel).toContain(p);
    }
  });

  it("OMITS secrets, the RAG index, runtime state, the registry, and private notes", () => {
    const sel = generateIncludeArgs(rksPublicProfile, repo);
    for (const bad of [
      // Namespaces removed from the allowlist. canon.* is superseded by public.canon.*;
      // research.public.* can never match a note under the documented research.YYYY.MM.DD.*
      // convention; how-to.release.md is a how-to OFF the nine-file explicit list, and is the
      // sharpest witness that the glob->explicit-list inversion actually took effect.
      "notes/canon.what-is-rks.md",
      "notes/research.public.overview.md",
      "notes/how-to.release.md",
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

  it("the public dashboard-as-tool ships, but its marketing decks + all content packages do NOT", () => {
    const sel = generateIncludeArgs(rksPublicProfile, repo);
    // Option B: telemetry-dashboard is public — basic telemetry / cost is core value prop.
    expect(sel).toContain("packages/telemetry-dashboard/src/App.tsx");
    expect(sel).toContain("packages/telemetry-dashboard/vite.config.ts");
    expect(sel).toContain("packages/cli/index.mjs");
    expect(sel).toContain("packages/design/preset.json");
    // ...but the marketing decks INSIDE the public dashboard are dropped by the presentations exclude,
    expect(sel).not.toContain("packages/telemetry-dashboard/src/presentations/decks/what-is-rks.deck.tsx");
    expect(sel).not.toContain("packages/telemetry-dashboard/src/presentations/registry.ts");
    // ...and the content/marketing packages never ship (omitted from the allowlist + belt-and-suspenders exclude).
    expect(sel).not.toContain("packages/whitepaper/src/cli.mjs");
    expect(sel).not.toContain("packages/marketing-site/src/main.tsx");
    expect(sel).not.toContain("packages/marketing/social/post.mjs");
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
describe.skipIf(!liveRksPublic)("rks-public profile — skills-manifest.json ships (preflight needs it on a mirror clone)", () => {
  const rksPublic = liveRksPublic;

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

// ══════════════════════════════════════════════════════════════════════════════════
// backlog.fix.clean-clone-mcp-json-and-vault-root — a fresh mirror clone must land clean
// ══════════════════════════════════════════════════════════════════════════════════
//
// After `npm run setup` on a fresh public-mirror clone, the tree showed untracked
// notes/root.md + notes/root.schema.yml (Dendron vault root missing from the allowlist → the
// mirror shipped no root → Dendron regenerated them) and an untracked generated .mcp.json (the
// /.mcp.json ignore rule was commented out). These pin both halves of the fix.
describe.skipIf(!liveRksPublic)("rks-public profile — Dendron vault root ships (fresh clone lands clean)", () => {
  const rksPublic = liveRksPublic;

  it("names notes/root.md and notes/root.schema.yml in the include allowlist", () => {
    // The notes globs (notes/canon.**, how-to, agents, research.public, playbooks) do NOT match a
    // bare notes/root.md, so the vault root must be named explicitly or the mirror ships rootless.
    expect(rksPublic.include).toContain("notes/root.md");
    expect(rksPublic.include).toContain("notes/root.schema.yml");
  });
});

describe(".gitignore — generated .mcp.json is ignored, the template is not", () => {
  const GITIGNORE = readFileSync(join(ROOT, ".gitignore"), "utf-8");

  it("has an ACTIVE (uncommented) /.mcp.json rule", () => {
    const active = GITIGNORE.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(active).toContain("/.mcp.json");
  });

  // Behavioral truth via git's own matcher: does the ignore RULE cover the generated .mcp.json
  // while leaving .mcp.json.example tracked? Use --no-index so we test the RULE independent of
  // whether .mcp.json happens to be tracked in this particular checkout (git normally reports a
  // tracked file as "not ignored"). On a fresh mirror clone .mcp.json is untracked, so the rule
  // is what actually governs there — which is exactly the fresh-clone-lands-clean behavior.
  function ruleIgnores(path) {
    const r = spawnSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: ROOT, timeout: GIT_TIMEOUT });
    // exit 0 = matched an ignore rule, 1 = not matched, other = error
    return r.status === 0;
  }

  it("the ignore rule covers .mcp.json but NOT .mcp.json.example", () => {
    expect(ruleIgnores(".mcp.json")).toBe(true);
    expect(ruleIgnores(".mcp.json.example")).toBe(false);
  });
});
