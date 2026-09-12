/**
 * credential-presence.mjs — single-source LLM-credential-presence authority (system tier)
 *
 * ONE definition of "is there a usable LLM credential?" consumed by BOTH the hook layer (via
 * hook-output.mjs) and the MCP server (packages/mcp-rks/src/llm/credential-preflight.mjs), so the
 * keyless-mode decision can never drift between them (INV-5, single-source / no-drift).
 *
 * Node-builtin-only (no third-party imports) on purpose so any hook or the server can import it with
 * zero coupling. `node:fs`/`node:path` are required to read `.env` — see below.
 *
 * WHY `.env` IS READ HERE: hook scripts are separate node processes spawned fresh by Claude Code.
 * They inherit only Claude Code's shell environment and never call `dotenv.config()`, while the MCP
 * server DOES load `.env` at startup (packages/mcp-rks/bin/mcp-rks.mjs). So a key present in `.env`
 * but not exported was visible to the server and invisible to hooks — hooks then declared keyless and
 * told agents "the Research Agent is unavailable" while research was answering normally. Reading
 * `.env` here closes that split. The lookup is BOUNDED to the project dir with NO upward walk: an
 * ancestor's `.env` must never silently credential a child project.
 * (backlog.fix.hook-credential-presence-dotenv)
 *
 * Activation keys off credential-KEY absence, NOT provider resolution: on a bare public-mirror
 * clone `inferProvider({})` returns null, so a provider-based predicate would report "has
 * credential" and keyless mode would NEVER activate for the very fresh-clone audience it targets.
 * Keyless ⇔ no recognized credential key is present.
 *
 * FAIL-CLOSED: any thrown/ambiguous read is treated as key-PRESENT (governed) — hasLlmCredential
 * returns true / isKeyless returns false — so ambiguity never opens the relaxed keyless path.
 */

// The credential keys whose presence means "an LLM call is possible". Mirrors the server preflight's
// RECOGNIZED_CREDENTIAL_KEYS; kept dependency-free here so it can be the single source both consume.
// (BRAVE_SEARCH_API_KEY / GITHUB_TOKEN gate optional features and are intentionally out of scope.)
export const RECOGNIZED_CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

import fs from "node:fs";
import path from "node:path";

/**
 * Look for a recognized credential in `<projectDir>/.env` — that file ONLY, no upward walk.
 *
 * Returns a three-valued verdict rather than a boolean, because the two failure modes must be
 * treated OPPOSITELY:
 *   "absent"    — the file genuinely is not there (ENOENT). Definitive. A bare clone with no key
 *                 must stay keyless, so this must NOT be conflated with an error.
 *   "ambiguous" — the file exists but could not be read or parsed (EISDIR, EACCES, malformed).
 *                 Fail-closed: the caller treats this as credential-PRESENT, because keyless is the
 *                 more permissive posture and ambiguity must never unlock it.
 *   "present"   — a recognized key is set to a non-empty value.
 *
 * Never returns, logs, or otherwise exposes the credential VALUE — only the verdict.
 *
 * @param {string} projectDir
 * @returns {"present"|"absent"|"ambiguous"}
 */
function credentialStateFromDotenv(projectDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDir, ".env"), "utf8");
  } catch (err) {
    // ENOENT is the ONLY definitive "no credential here" signal. Everything else — a directory
    // named .env, a permissions error, an I/O fault — is ambiguous and fails closed.
    return err && err.code === "ENOENT" ? "absent" : "ambiguous";
  }

  try {
    for (const line of raw.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      if (!RECOGNIZED_CREDENTIAL_KEYS.includes(m[1])) continue;
      // Strip surrounding quotes and any trailing comment on an unquoted value.
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      } else {
        v = v.split("#")[0].trim();
      }
      if (v !== "") return "present";
    }
    return "absent";
  } catch {
    return "ambiguous"; // unparseable content → governed
  }
}

/**
 * True when at least one recognized LLM credential key is present (non-empty) in env.
 * FAIL-CLOSED: on any error/ambiguity returns TRUE (treat as credentialed / governed).
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function hasLlmCredential(env = process.env) {
  try {
    if (!env || typeof env !== "object") return true; // ambiguous → governed

    const inEnv = RECOGNIZED_CREDENTIAL_KEYS.some((k) => {
      const v = env[k];
      return typeof v === "string" && v.trim() !== "";
    });
    if (inEnv) return true;

    // Not exported — fall back to the project's .env, which hook subprocesses never load.
    //
    // Which project? CLAUDE_PROJECT_DIR when supplied (Claude Code sets it for every hook), else the
    // cwd — but the cwd fallback applies ONLY when evaluating the real ambient environment. A caller
    // that passes a synthetic env object is asking "is THIS env credentialed?", and answering that
    // from a file on disk would make the function impure and leak repo state into unit tests:
    // isKeyless({}) must stay true regardless of what .env the runner happens to sit next to.
    const explicitDir =
      typeof env.CLAUDE_PROJECT_DIR === "string" && env.CLAUDE_PROJECT_DIR.trim() !== ""
        ? env.CLAUDE_PROJECT_DIR
        : null;
    const projectDir = explicitDir ?? (env === process.env ? process.cwd() : null);
    if (projectDir === null) return false; // synthetic env, no project named → evaluate as given

    const state = credentialStateFromDotenv(projectDir);
    if (state === "present") return true;
    if (state === "ambiguous") return true; // fail-closed: unreadable .env → governed
    return false; // "absent" is definitive — genuinely keyless
  } catch {
    return true; // fail-closed: ambiguous read → treat as credentialed (governed)
  }
}

/**
 * True ONLY when NO usable LLM credential is present — the keyless-mode activation predicate.
 * FAIL-CLOSED: any error/ambiguity → false (governed, NOT keyless).
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function isKeyless(env = process.env) {
  return !hasLlmCredential(env);
}
