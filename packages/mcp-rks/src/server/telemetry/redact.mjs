/**
 * Redaction core for shareable telemetry exports.
 *
 * Pure, dependency-free, standalone-importable so the deferred opt-in "share anonymous
 * usage data" uploader (notes/ideas.2026.07.05.telemetry-anon-share-mothership.md) can
 * reuse the EXACT same scrubbing before any bytes leave the machine. Over-redaction is a
 * feature here: a shared UAT/gh-issue artifact must never leak a secret, so we prefer to
 * mask a benign id than risk a live token.
 *
 * Scrubs:
 *  - Anthropic keys (sk-ant-…), OpenAI-style keys (sk-…), GitHub tokens (ghp_…, github_pat_…)
 *  - Authorization: Bearer <token>
 *  - v4 UUIDs (governor/session tokens — masked everywhere, incl. event ids)
 *  - values under secret-looking KEYS (*_API_KEY / *_SECRET / *_TOKEN / password / authorization / sessionId / _governorToken)
 *  - absolute filesystem paths (rewritten repo-relative when under projectRoot, else a <path> placeholder)
 */

const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const GH_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g;
const GH_PAT = /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9]{20,}\b/g; // generic sk- key (after sk-ant- handled)
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const UUID_V4 = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HOME_PATH = /(?:\/Users|\/home)\/[^/\s"']+\/[^\s"']*/g;

// Key names whose VALUE must be masked wholesale, regardless of value shape.
const SECRET_KEY = /(?:_?api[_-]?key|secret|password|passwd|authorization|bearer|access[_-]?token|refresh[_-]?token|_governortoken|session[_-]?id|sessiontoken|token)$/i;

export const REDACTED = "[REDACTED]";

/**
 * Redact secret substrings from a string. Also rewrites absolute paths under `projectRoot`
 * to repo-relative form, and other home-dir absolute paths to a <path> placeholder.
 * @param {string} str
 * @param {string} [projectRoot] absolute project root, rewritten to "." when present
 */
export function redactString(str, projectRoot) {
  if (typeof str !== "string" || str.length === 0) return str;
  let out = str;
  // Project-root paths → repo-relative (do this before generic path scrubbing).
  if (projectRoot && typeof projectRoot === "string") {
    out = out.split(projectRoot).join(".");
  }
  out = out
    .replace(ANTHROPIC_KEY, "[REDACTED-ANTHROPIC-KEY]")
    .replace(GH_TOKEN, "[REDACTED-GH-TOKEN]")
    .replace(GH_PAT, "[REDACTED-GH-TOKEN]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(OPENAI_KEY, "[REDACTED-KEY]")
    .replace(UUID_V4, "[REDACTED-UUID]")
    .replace(HOME_PATH, "<path>");
  return out;
}

/** True when a key name indicates its value is a secret to mask wholesale. */
export function isSecretKey(key) {
  return typeof key === "string" && SECRET_KEY.test(key);
}

/**
 * Recursively redact a value (string / array / object). Secret-named keys have their value
 * masked to [REDACTED]; every string (incl. nested) is scrubbed via redactString. Numbers,
 * booleans and null pass through. Pure — returns a new value, never mutates the input.
 * @param {*} value
 * @param {object} [opts] { projectRoot }
 */
export function redactValue(value, opts = {}) {
  const { projectRoot } = opts;
  if (value == null) return value;
  if (typeof value === "string") return redactString(value, projectRoot);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, opts));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? REDACTED : redactValue(v, opts);
    }
    return out;
  }
  return value;
}

/** Redact a single telemetry event object. Thin wrapper over redactValue for readability. */
export function redactEvent(event, opts = {}) {
  return redactValue(event, opts);
}
