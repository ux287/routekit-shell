/**
 * credential-presence.mjs — single-source LLM-credential-presence authority (system tier)
 *
 * ONE definition of "is there a usable LLM credential?" consumed by BOTH the hook layer (via
 * hook-output.mjs) and the MCP server (packages/mcp-rks/src/llm/credential-preflight.mjs), so the
 * keyless-mode decision can never drift between them (INV-5, single-source / no-drift).
 *
 * Dependency-free (no imports) on purpose so any hook or the server can import it with zero
 * coupling.
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

/**
 * True when at least one recognized LLM credential key is present (non-empty) in env.
 * FAIL-CLOSED: on any error/ambiguity returns TRUE (treat as credentialed / governed).
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function hasLlmCredential(env = process.env) {
  try {
    if (!env || typeof env !== "object") return true; // ambiguous → governed
    return RECOGNIZED_CREDENTIAL_KEYS.some((k) => {
      const v = env[k];
      return typeof v === "string" && v.trim() !== "";
    });
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
