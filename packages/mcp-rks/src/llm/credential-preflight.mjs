/**
 * Startup credential preflight + env-source provenance.
 *
 * Pure, unit-testable module (no process.exit / no console / no process.env reliance): every
 * function takes an INJECTED env object plus explicit shell-snapshot / ordered-.env-source
 * arguments. The bin entry (bin/mcp-rks.mjs) owns the fail-fast (console.error + process.exit).
 *
 * Provider inference is imported from clients.mjs (single source of truth) — never reimplemented
 * here — so the preflight and loadEnv() always agree on the resolved provider.
 *
 * Motivation (Bug 8): dotenv loads first-wins across the runtime + main .env files with no log of
 * which source supplied each key, so a shell-env export (e.g. ~/.zshenv ANTHROPIC_API_KEY, expired)
 * silently shadows the project .env and surfaces far downstream as an opaque auth error.
 */
import { inferProvider } from "./clients.mjs";

// The credential keys the preflight recognizes for validation + provenance. (BRAVE_SEARCH_API_KEY /
// GITHUB_TOKEN gate optional features and are intentionally out of scope for the core preflight.)
export const RECOGNIZED_CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

// The single provider-appropriate credential key required to make LLM calls.
const PROVIDER_REQUIRED_KEY = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Resolve the provider (via the shared clients.mjs inferProvider) and the single required key.
 * Returns { provider, requiredKey, present }. provider is null when none can be resolved;
 * requiredKey is null for an unresolvable/unknown provider.
 */
export function resolveRequiredCredential(env = {}) {
  const provider = inferProvider(env);
  const requiredKey = provider ? (PROVIDER_REQUIRED_KEY[provider] || null) : null;
  const present = requiredKey ? Boolean(env[requiredKey]) : false;
  return { provider, requiredKey, present };
}

/**
 * Throw a value-free Error when the resolved provider's required credential is absent, or when no
 * provider/credential can be resolved at all. Returns { provider, requiredKey } on success.
 * Never includes any credential VALUE in the message — only key names + provider strings.
 */
export function checkRequiredCredential(env = {}) {
  const { provider, requiredKey, present } = resolveRequiredCredential(env);
  if (!provider) {
    throw new Error(
      "No LLM provider/credential could be resolved: set ROUTEKIT_LLM_PROVIDER, or provide " +
        "ANTHROPIC_API_KEY or OPENAI_API_KEY."
    );
  }
  if (requiredKey && !present) {
    throw new Error(
      `Missing required credential ${requiredKey} for resolved provider '${provider}'.`
    );
  }
  return { provider, requiredKey };
}

/**
 * Attribute the source of each recognized credential key that is present.
 *
 * @param {Record<string, boolean>} shellSnapshot - keys present in process.env BEFORE dotenv ran
 *        (the ambient/shell keys). Presence only — never values.
 * @param {Array<{ path: string, parsed: Record<string, any> }>} orderedEnvSources - the .env
 *        sources in first-wins order (runtime-project .env before main-project .env).
 * @param {string[]} [recognizedKeys] - keys to attribute (defaults to RECOGNIZED_CREDENTIAL_KEYS).
 * @returns {Array<{ key: string, source: string }>} one entry per present recognized key, source =
 *        'shell environment' when in the shell snapshot, else the first .env path that supplied it.
 */
export function resolveSources(shellSnapshot = {}, orderedEnvSources = [], recognizedKeys = RECOGNIZED_CREDENTIAL_KEYS) {
  const results = [];
  for (const key of recognizedKeys) {
    if (shellSnapshot && Object.prototype.hasOwnProperty.call(shellSnapshot, key) && shellSnapshot[key]) {
      // Shell/ambient key — reported explicitly, making a ~/.zshenv shadow visible even when a
      // project .env also declares the key (first-wins ⇒ the shell value is what's actually used).
      results.push({ key, source: "shell environment" });
      continue;
    }
    // Not in the shell snapshot — attribute to the FIRST ordered .env source that supplied it.
    const supplier = orderedEnvSources.find(
      (s) => s && s.parsed && Object.prototype.hasOwnProperty.call(s.parsed, key)
    );
    if (supplier) {
      results.push({ key, source: supplier.path });
    }
  }
  return results;
}

/**
 * Format provenance log lines from resolveSources() output. Key NAME + source only — never a value.
 */
export function formatProvenanceLines(sources = []) {
  return sources.map(({ key, source }) => `[preflight] credential ${key} ← ${source}`);
}
