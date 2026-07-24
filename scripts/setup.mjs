#!/usr/bin/env node
/**
 * `npm run setup` — turnkey onboarding for a fresh rks clone.
 *
 * After `npm install`, this single command makes the first editor-chat productive
 * with zero further CLI thinking:
 *   1. create .env from .env.example and capture your Anthropic API key
 *   2. create .mcp.json from .mcp.json.example (wires the rks/rks-gov MCP servers)
 *   3. link the `routekit` CLI (npm run dev:link) and register this project in the
 *      local rks registry (routekit project attach) so rag/rks commands can resolve it
 *   4. build the knowledge graph (routekit rag init + rag embed) so the agent is
 *      grounded on first chat — you never have to invoke RAG yourself
 *
 * Idempotent: it never clobbers an existing .env, an existing non-empty API key, or
 * an existing .mcp.json. Re-running is always safe.
 *
 * Structure: the pure file logic (ensureEnv / ensureMcpJson / readProjectId) is
 * exported and side-effect-free so it can be unit-tested in a temp dir. The
 * subprocess steps (dev:link, rag init/embed) run through an INJECTABLE runner so
 * tests can assert intent without spawning anything.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

const ANTHROPIC_KEY_SET = /^\s*ANTHROPIC_API_KEY=\S/m;
const ANTHROPIC_KEY_LINE = /^\s*ANTHROPIC_API_KEY=.*$/m;
const OPENAI_KEY_SET = /^\s*OPENAI_API_KEY=\S/m;

/**
 * Create/preserve .env. Pure + testable — never spawns.
 * @param root project root
 * @param key  API key to write when CREATING from template (interactive path); null/undefined = no key
 * Returns { hasKey, action }. If .env already exists it is preserved BYTE-FOR-BYTE.
 */
export function ensureEnv(root, { key = null, log = () => {} } = {}) {
  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    const hasKey = ANTHROPIC_KEY_SET.test(content) || OPENAI_KEY_SET.test(content);
    log(
      hasKey
        ? "✓ .env already configured — keeping it."
        : "✓ .env exists but has no API key — add ANTHROPIC_API_KEY to it.",
    );
    return { hasKey, action: "preserved" }; // do not touch an existing .env
  }
  copyFileSync(join(root, ".env.example"), envPath);
  if (key) {
    const withKey = readFileSync(envPath, "utf8").replace(ANTHROPIC_KEY_LINE, `ANTHROPIC_API_KEY=${key}`);
    writeFileSync(envPath, withKey);
    log("✓ Created .env with your Anthropic key.");
    return { hasKey: true, action: "created-with-key" };
  }
  log("✓ Created .env from template. → set ANTHROPIC_API_KEY in .env");
  return { hasKey: false, action: "created-no-key" };
}

/** Create/preserve .mcp.json from the template. Pure + testable. */
export function ensureMcpJson(root, { log = () => {} } = {}) {
  const mcpPath = join(root, ".mcp.json");
  if (existsSync(mcpPath)) {
    log("✓ .mcp.json already present — keeping it.");
    return { action: "preserved" };
  }
  copyFileSync(join(root, ".mcp.json.example"), mcpPath);
  log("✓ Created .mcp.json from template.");
  return { action: "created" };
}

/** Read the projectId from .rks/project.json (falls back to routekit-shell). */
export function readProjectId(root) {
  try {
    return JSON.parse(readFileSync(join(root, ".rks", "project.json"), "utf8")).id || "routekit-shell";
  } catch {
    return "routekit-shell";
  }
}

/** Default runner — real subprocess with a hard timeout. Throws on non-zero exit. */
function defaultRunner(cmd, args, { cwd }) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", timeout: 600000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` exited with ${r.status}`);
  return r;
}

/** Captured git reader — returns { stdout, status } and NEVER throws. Separate from the
 *  stdio:"inherit" runner (which cannot capture output). Used for read-only git queries. */
function defaultGitCapture(args, { cwd }) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
  return { stdout: r.stdout || "", status: r.status ?? 1 };
}

/**
 * Decide whether to disable push to `origin` on a fresh clone. Pure + exported for tests.
 * Private shell repo names end with `-core` (…/routekit-shell) → KEEP push.
 * The public mirror (…/routekit-shell) does NOT end with `-core` → DISABLE push (pull-only).
 * NOTE: the bare `-core` literal is deliberately NOT the contiguous string
 * `routekit-shell`, so publish.mjs's identity rewrite (which turns `routekit-shell`
 * → `routekit-shell` in the shipped public setup.mjs) leaves this `.endsWith("-core")` check
 * intact — the public artifact behaves identically to the dev tree.
 */
export function shouldDisablePush(originUrl) {
  if (!originUrl) return false;
  const repoPath = String(originUrl).trim().replace(/\.git$/, "");
  return !repoPath.endsWith("-core");
}

/** Interactive key prompt (real). Returns the trimmed key, or null if skipped. */
function defaultPromptKey() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Paste your Anthropic API key (sk-ant-…), or press Enter to skip: ", (answer) => {
      rl.close();
      resolve((answer || "").trim() || null);
    });
  });
}

/**
 * Orchestrate onboarding. All side-effects are injectable for testing:
 *  - promptKey(): only called when .env is ABSENT and we're interactive
 *  - runner(cmd, args, {cwd}): records/executes the dev:link + rag steps
 */
export async function runSetup({
  root = process.cwd(),
  promptKey = defaultPromptKey,
  runner = defaultRunner,
  gitCapture = defaultGitCapture,
  log = console.log,
  // Warnings go through their own channel so the health gate below cannot be mistaken for progress
  // chatter — the whole failure this guards against was a problem that never announced itself.
  warn = (msg) => log(`\n⚠️  ${msg}`),
  isTTY = Boolean(process.stdin.isTTY),
} = {}) {
  const creatingEnv = !existsSync(join(root, ".env"));
  const key = creatingEnv && isTTY ? await promptKey() : null;

  const env = ensureEnv(root, { key, log });
  const mcp = ensureMcpJson(root, { log });

  if (!env.hasKey) {
    // Warn-only gate: the entire spawn phase below (dev:link, add-existing, rag init/embed, git
    // posture, health check) is KEY-FREE — none of it consumes the API key. The credential is
    // only genuinely required later, at MCP server boot. So build the knowledge graph now
    // regardless, and warn that LLM-backed tools will need a key before the first chat, rather
    // than skipping the work that never needed one. (No early return.)
    warn(
      "No API key set yet — building the knowledge graph anyway; RAG indexing is key-free.\n" +
        "     You can rebuild the index any time with `npm run rag:embed` — no key required.\n" +
        "     LLM-backed agent tools and the rks MCP server DO need a credential: add\n" +
        "     ANTHROPIC_API_KEY=sk-ant-… (or OPENAI_API_KEY) to .env before your first chat.",
    );
  }

  const projectId = readProjectId(root);
  log("\nLinking the routekit CLI, registering the project, and building the knowledge graph…");
  runner("npm", ["run", "dev:link"], { cwd: root });
  // Register this clone in the local rks registry (projects/index.jsonl) BEFORE rag init.
  // The registry is gitignored, so a fresh clone has no entry and `rag init` would fail with
  // "Project not found". Use `add-existing` — a pure registry upsert (idempotent, safe to
  // re-run). NOT `attach`: on a self-hosting clone (projectRoot === shellRoot) attach's
  // ensureGovernorArtifacts self-copies .claude/skills/<name> onto itself and ENOENTs after
  // it rm's the source. `add-existing` writes only {id, root, path} — all rag init needs.
  runner("routekit", ["project", "add-existing", "--id", projectId, "--stack", "routekit-shell", "--path", root], { cwd: root });
  runner("routekit", ["rag", "init", projectId], { cwd: root });
  runner("routekit", ["rag", "embed", projectId], { cwd: root });

  // --- git posture: land the clone on local `staging`, and pull-only the public mirror ---
  // Read-only queries use the captured reader (defaultRunner is stdio:"inherit" and cannot
  // capture output); mutations go through the recorded runner. Non-destructive: a dirty
  // tree or a missing origin/staging degrades to guidance rather than a data-loss reset.
  const originUrl = gitCapture(["remote", "get-url", "origin"], { cwd: root }).stdout.trim();
  if (originUrl && shouldDisablePush(originUrl)) {
    runner("git", ["remote", "set-url", "--push", "origin", "no_push"], { cwd: root });
    log("✓ Disabled push to the public mirror (pull-only). Re-enable with: git remote set-url --push origin <url>");
  }
  const dirty = gitCapture(["status", "--porcelain"], { cwd: root }).stdout.trim();
  const hasRemoteStaging = gitCapture(["ls-remote", "--heads", "origin", "staging"], { cwd: root }).stdout.trim();
  if (!hasRemoteStaging) {
    log("→ origin/staging not found — staying on the current branch.");
  } else if (dirty) {
    // backlog.fix.shell-self-sync-skill-wipe-health-gate: this used to read as a neutral aside, and
    // it is not one — it means setup did NOT land you on a working branch, and if you were pinned to
    // a tag you are still on a detached HEAD. On the UAT box the tree was dirty *because* the skills
    // had been deleted, so the one signal that could have surfaced the problem was itself suppressed
    // by it. Say plainly what did not happen.
    warn(
      "Uncommitted changes present — setup did NOT switch you to the staging branch.\n" +
        "     You are still on whatever ref you started on. To land on the working branch:\n" +
        `       git stash && ${landOnStagingCommand({ hasRemoteStaging: Boolean(hasRemoteStaging) })}`,
    );
  } else {
    runner("git", ["fetch", "origin", "staging"], { cwd: root });
    runner("git", ["checkout", "-B", "staging", "--track", "origin/staging"], { cwd: root });
    log("✓ Checked out local staging (the working branch).");
  }

  // --- health gate: the two things that were silently broken on the clean-machine UAT box ---
  const health = await checkCloneHealth(root, { gitCapture, runner, log, warn, hasRemoteStaging: Boolean(hasRemoteStaging) });

  log(
    `\n✅ Setup complete. Next steps:\n` +
      `   1. Reload your editor window so the rks MCP server picks up the new config.\n` +
      `   2. Verify the server is connected — run \`/mcp\` and confirm \`rks\` shows connected.\n` +
      `   3. Ask the chat to run \`rks_preflight\` to confirm the workspace is healthy.\n` +
      `   4. Then start: \`/rks-onboard\` (guided first run) or \`/po "build me …"\`.`,
  );
  return { ok: true, ranSpawns: true, env, mcp, projectId, health };
}

/**
 * backlog.fix.shell-self-sync-skill-wipe-health-gate
 *
 * Two failures survived a whole clean-machine UAT round because nothing ever looked for them:
 *
 *   1. All 17 distributable skills were gone. `npm run setup` did not restore them (it does not
 *      touch .claude/skills), `rks_preflight` reported 7/7 green, and rks routed nothing.
 *   2. HEAD was detached — the state the README's own "pin to a tag for stability" advice puts you
 *      in — and setup's land-on-staging step is skipped whenever the tree is dirty, which it was,
 *      *because of* (1).
 *
 * Skills heal FROM GIT, never from `routekit project sync`. That is not a stylistic preference: a
 * self-targeted sync is what DELETED them, so "repair by syncing" is a loop that re-breaks what it
 * just fixed. The skills are tracked, so `git checkout HEAD -- .claude/skills` is the honest restore
 * — and it works on a detached HEAD and a dirty tree, which is exactly the state this runs in.
 */
/**
 * backlog.fix.clean-machine-honesty: the command that actually WORKS on the clone you are standing in.
 *
 * v0.27.2's health gate told a detached user to run:
 *     git checkout -B staging --track origin/staging
 * On a PUBLIC MIRROR clone that fails outright —
 *     fatal: 'origin/staging' is not a commit and a branch 'staging' cannot be created from it
 * — because the mirror publishes only `origin/main` and tags. `staging` is a -core branch and is not
 * mirrored, so there is no `origin/staging` to track.
 *
 * So the fix that DETECTED the problem prescribed a cure that fails in the exact environment it was
 * most likely to run in: a fresh clone of the public mirror. That is worse than saying nothing —
 * a user who follows the instructions gets an error and no idea which half to distrust.
 *
 * setup already knows both facts (it probes for origin/staging, and it disables push on a mirror);
 * the warning just wasn't asking.
 */
export function landOnStagingCommand({ hasRemoteStaging }) {
  return hasRemoteStaging
    ? "git checkout -B staging --track origin/staging"
    : "git checkout -B staging";
}

export async function checkCloneHealth(root, { gitCapture, runner, log, warn, hasRemoteStaging }) {
  const result = { detachedHead: false, missingSkills: [], healed: false };

  const branch = (gitCapture(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })?.stdout || "").trim();
  // `rev-parse --abbrev-ref HEAD` SUCCEEDS when detached and returns the literal string "HEAD" —
  // which is why every truthiness check in this codebase read a detached clone as healthy.
  if (branch === "HEAD") {
    result.detachedHead = true;
    const described = (gitCapture(["describe", "--tags", "--always"], { cwd: root })?.stdout || "").trim();
    warn(
      `HEAD is DETACHED (at ${described || "an unnamed commit"}).\n` +
        "     You are on a commit, not a branch — anything you commit here belongs to no branch and\n" +
        "     is easy to lose. Pinning to a tag does this; it is fine for running rks, but you cannot\n" +
        "     develop from it. To land on the working branch:\n" +
        `       ${landOnStagingCommand({ hasRemoteStaging: Boolean(hasRemoteStaging) })}`,
    );
  }

  // Resolved against `root` at call time rather than by a static relative import: setup.mjs is
  // copied and identity-rewritten by publish.mjs (and by the test that guards that rewrite), so a
  // `../packages/…` import breaks the moment the file moves. Still ONE list — this is the same
  // reader every other caller uses, just located honestly. A clone that cannot provide it is not a
  // shell we can check; say so rather than crashing setup over a health check.
  let loadSkillsManifest, findMissingSkills;
  try {
    ({ loadSkillsManifest, findMissingSkills } = await import(
      pathToFileURL(join(root, "packages", "mcp-rks", "src", "shared", "skills-manifest.mjs")).href
    ));
  } catch {
    warn("Could not load the skills-manifest reader — skipping the core-skills check.");
    return result;
  }

  const manifest = loadSkillsManifest(root);
  if (!manifest.ok) {
    warn(`Could not read .routekit/skills-manifest.json (${manifest.reason}) — skipping the core-skills check.`);
    return result;
  }
  const missing = findMissingSkills(root, manifest.skills);
  result.missingSkills = missing;
  if (missing.length === 0) {
    log(`✓ Core skills present (${manifest.skills.length}/${manifest.skills.length}).`);
    return result;
  }

  warn(
    `${missing.length} core skill(s) are MISSING from .claude/skills: ${missing.join(", ")}\n` +
      "     Without them rks cannot route work — no /build, no /ship, no /research.\n" +
      "     Restoring them from git…",
  );
  try {
    runner("git", ["checkout", "HEAD", "--", ".claude/skills"], { cwd: root });
    const stillMissing = findMissingSkills(root, manifest.skills);
    result.missingSkills = stillMissing;
    result.healed = stillMissing.length === 0;
    if (result.healed) {
      log("✓ Restored the missing skills from git.");
    } else {
      warn(
        `Restore incomplete — still missing: ${stillMissing.join(", ")}.\n` +
          "     These are not in the current commit. Check out a ref that has them, or re-clone.",
      );
    }
  } catch (err) {
    warn(
      `Could not restore skills from git: ${err?.message || err}\n` +
        "     Restore them by hand: git checkout HEAD -- .claude/skills\n" +
        "     Do NOT use `routekit project sync` — a self-targeted sync is what deletes them.",
    );
  }
  return result;
}

// CLI entry — only when run directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup({ root: process.cwd() })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\n✗ setup failed: ${err.message}`);
      process.exit(1);
    });
}
