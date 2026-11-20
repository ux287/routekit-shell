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
 * Keyless ⇔ no recognized credential key is present, and no ready subscription is opted in.
 *
 * SUBSCRIPTION STATE (backlog.feat.keyless-backend-aware-credential-presence): a machine with only
 * a Claude subscription login counts as credentialed for hook posture when the machine-local opt-in
 * RKS_SUBSCRIPTION_CREDENTIAL=1 is on AND the MCP server's probe status file
 * (<project>/.rks/state/llm-backend.json, written at every rks_governor_init) is fresh, ready and a
 * claude.ai login. Hooks cannot spawn `claude` cheaply, so they read the file. A stale file is
 * absent (posture falls back to keyless until the next Governor re-probes); an unreadable one is
 * ambiguous (governed). Capability admission — "can this flow actually run?" — is a SEPARATE,
 * server-side question that fails closed to refuse (llm/claude-cli/subscription-status.mjs).
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
 * Bounded `.env` lookup: read `<projectDir>/.env` — that file ONLY, no upward walk — and return
 * the stripped value of each requested key the file assigns.
 *
 * Generalised from the credential-only parser (backlog.feat.keyless-backend-aware-credential-presence)
 * so the subscription opt-in is read through the SAME bounded, no-upward-walk rules. The caller names
 * the keys it looks for; a key it did not ask for is never returned, so the opt-in can never be
 * counted as a credential and a credential can never turn the opt-in on.
 *
 * Returns a three-valued state, because the two failure modes must be treated OPPOSITELY:
 *   "absent"    — the file genuinely is not there (ENOENT). Definitive. A bare clone with no key
 *                 must stay keyless, so this must NOT be conflated with an error.
 *   "ambiguous" — the file exists but could not be read or parsed (EISDIR, EACCES, malformed).
 *   "read"      — the file was read; `values` holds the first non-empty assignment of each
 *                 requested key (surrounding quotes and an unquoted trailing comment stripped).
 *
 * @param {string} projectDir
 * @param {readonly string[]} keys
 * @returns {{ state: "absent"|"ambiguous"|"read", values: Record<string, string> }}
 */
function readDotenvKeys(projectDir, keys) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDir, ".env"), "utf8");
  } catch (err) {
    // ENOENT is the ONLY definitive "not here" signal. Everything else — a directory named .env,
    // a permissions error, an I/O fault — is ambiguous.
    return { state: err && err.code === "ENOENT" ? "absent" : "ambiguous", values: {} };
  }

  try {
    const values = {};
    for (const line of raw.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      if (!keys.includes(m[1])) continue;
      // Strip surrounding quotes and any trailing comment on an unquoted value.
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      } else {
        v = v.split("#")[0].trim();
      }
      if (v !== "" && !Object.prototype.hasOwnProperty.call(values, m[1])) values[m[1]] = v;
    }
    return { state: "read", values };
  } catch {
    return { state: "ambiguous", values: {} }; // unparseable content
  }
}

/**
 * Look for a recognized credential in `<projectDir>/.env` — that file ONLY, no upward walk.
 *
 *   "absent"    — no file (ENOENT), or a file holding no recognized key.
 *   "ambiguous" — unreadable or unparseable. Fail-closed: the caller treats this as
 *                 credential-PRESENT, because keyless is the more permissive posture and
 *                 ambiguity must never unlock it.
 *   "present"   — a recognized key is set to a non-empty value.
 *
 * Never returns, logs, or otherwise exposes the credential VALUE — only the verdict.
 *
 * @param {string} projectDir
 * @returns {"present"|"absent"|"ambiguous"}
 */
function credentialStateFromDotenv(projectDir) {
  const { state, values } = readDotenvKeys(projectDir, RECOGNIZED_CREDENTIAL_KEYS);
  if (state !== "read") return state;
  return RECOGNIZED_CREDENTIAL_KEYS.some((k) => typeof values[k] === "string" && values[k] !== "")
    ? "present"
    : "absent";
}

/**
 * The machine-local subscription opt-in (D-1): the ONLY switch that lets a ready Claude
 * subscription login count as a credential for hook posture. Read from the environment, then from
 * the project's gitignored .env. Never read from the committed, published project config.
 */
export const SUBSCRIPTION_OPT_IN_KEY = "RKS_SUBSCRIPTION_CREDENTIAL";

/** The server-written claude-cli probe status file, relative to the project dir (gitignored). */
export const SUBSCRIPTION_STATUS_FILE_SEGMENTS = Object.freeze([".rks", "state", "llm-backend.json"]);

// Upper bound on the ttlMs a status file may claim, so a corrupt or hand-edited file can never
// keep hook posture relaxed indefinitely. The server writes DEFAULT_PROBE_TTL_MS (10 minutes).
const MAX_STATUS_TTL_MS = 60 * 60_000;
// Tolerated clock skew for a probedAt slightly in the future; beyond it the stamp is not fresh.
const MAX_STATUS_SKEW_MS = 60_000;

/** CLAUDE_PROJECT_DIR when supplied, else the cwd — but the cwd ONLY for the real ambient env. */
function projectDirFor(env) {
  const explicitDir =
    typeof env.CLAUDE_PROJECT_DIR === "string" && env.CLAUDE_PROJECT_DIR.trim() !== ""
      ? env.CLAUDE_PROJECT_DIR
      : null;
  return explicitDir ?? (env === process.env ? process.cwd() : null);
}

/**
 * True ONLY when RKS_SUBSCRIPTION_CREDENTIAL is exactly "1". Read first from `env` (when env
 * defines the key at all, its value decides — as dotenv never overrides an existing variable),
 * then from `<CLAUDE_PROJECT_DIR>/.env` through the same bounded, no-upward-walk parser as the
 * credential keys. Absent, "", "true", "yes", "0", " 1" and every other value are OFF.
 * Fails closed to OFF: a non-object env, an unreadable .env or any thrown error is off. A synthetic
 * env without CLAUDE_PROJECT_DIR never reads the cwd.
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function isSubscriptionOptInOn(env = process.env) {
  try {
    if (!env || typeof env !== "object") return false;
    const inEnv = env[SUBSCRIPTION_OPT_IN_KEY];
    if (inEnv !== undefined) return inEnv === "1";
    const projectDir = projectDirFor(env);
    if (projectDir === null) return false;
    const { state, values } = readDotenvKeys(projectDir, [SUBSCRIPTION_OPT_IN_KEY]);
    return state === "read" && values[SUBSCRIPTION_OPT_IN_KEY] === "1";
  } catch {
    return false;
  }
}

/**
 * Classify the server-written probe status file under projectDir:
 *   "ready"     — fresh (probedAt + ttlMs later than now), ready === true, authMethod 'claude.ai'.
 *   "not_ready" — fresh, but not ready or not a claude.ai login.
 *   "absent"    — ENOENT, or stale (stale is treated as absent).
 *   "ambiguous" — exists but unreadable, unparseable, or with no usable probedAt / ttlMs.
 * @param {string} projectDir
 * @param {number} [nowMs=Date.now()]
 * @returns {"ready"|"not_ready"|"absent"|"ambiguous"}
 */
export function readSubscriptionStatusState(projectDir, nowMs = Date.now()) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDir, ...SUBSCRIPTION_STATUS_FILE_SEGMENTS), "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? "absent" : "ambiguous";
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return "ambiguous";
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "ambiguous";
  const { probedAt, ttlMs } = rec;
  if (!Number.isFinite(probedAt) || !Number.isFinite(ttlMs) || ttlMs < 0) return "ambiguous";
  if (probedAt > nowMs + MAX_STATUS_SKEW_MS) return "absent";
  if (!(probedAt + Math.min(ttlMs, MAX_STATUS_TTL_MS) > nowMs)) return "absent";
  return rec.ready === true && rec.authMethod === "claude.ai" ? "ready" : "not_ready";
}

/**
 * True when at least one recognized LLM credential key is present (non-empty) in env or the
 * project .env, OR when the subscription opt-in is on AND the server-written probe status file is
 * fresh, ready and a claude.ai login. This answers the hook-POSTURE question only. It is not a
 * capability admission and must never be used as an "is there an API key?" check.
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
    const projectDir = projectDirFor(env);
    if (projectDir === null) return false; // synthetic env, no project named → evaluate as given

    const state = credentialStateFromDotenv(projectDir);
    if (state === "present") return true;
    if (state === "ambiguous") return true; // fail-closed: unreadable .env → governed

    // Subscription arm (backlog.feat.keyless-backend-aware-credential-presence). Consulted ONLY
    // when the machine-local opt-in is on, so true-keyless behaviour (no key, opt-in off) is
    // unchanged. Fresh + ready + claude.ai → credentialed. Unreadable/unparseable → ambiguous →
    // governed. Stale, ENOENT or not-ready → keyless.
    if (isSubscriptionOptInOn(env)) {
      const status = readSubscriptionStatusState(projectDir);
      if (status === "ready") return true;
      if (status === "ambiguous") return true; // fail-closed
    }
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
