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
  log = console.log,
  isTTY = Boolean(process.stdin.isTTY),
} = {}) {
  const creatingEnv = !existsSync(join(root, ".env"));
  const key = creatingEnv && isTTY ? await promptKey() : null;

  const env = ensureEnv(root, { key, log });
  const mcp = ensureMcpJson(root, { log });

  if (!env.hasKey) {
    log(
      "\n→ Add your Anthropic key to .env (ANTHROPIC_API_KEY=sk-ant-…), then re-run `npm run setup` to build the knowledge graph.",
    );
    return { ok: true, ranSpawns: false, env, mcp };
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

  log(
    `\n✅ You're ready. Open the chat in your editor and try:\n` +
      `   /rks-onboard        — a guided first run\n` +
      `   /po "build me …"   — write your first story`,
  );
  return { ok: true, ranSpawns: true, env, mcp, projectId };
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
