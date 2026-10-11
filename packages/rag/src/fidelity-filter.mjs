/**
 * Fidelity gradient filter for provenance control.
 * Transforms RAG results based on requested fidelity level.
 */

export const FIDELITY_LEVELS = {
  L0_METADATA: 0,
  L1_ABSTRACTED: 1,
  L2_REDACTED: 2,
  L3_FULL: 3
};

// Default fidelity by source class (can be overridden by capability token)
export const DEFAULT_FIDELITY = {
  public: FIDELITY_LEVELS.L3_FULL,
  project: FIDELITY_LEVELS.L2_REDACTED,
  client: FIDELITY_LEVELS.L1_ABSTRACTED,
  sensitive: FIDELITY_LEVELS.L0_METADATA,
  legal: FIDELITY_LEVELS.L0_METADATA
};

// Redaction settings
const REDACTED_PREVIEW_LENGTH = 200;
// Matches a literal credential assignment. Explicit compound alternatives (api_key, access_token,
// …) close the \b gap where a bare `key`/`token` root is glued to a prefix (`apikey=`), WITHOUT a
// greedy `[\w-]*` prefix that would wrongly catch `monkey=`/`donkey=`. Requires `[:=]` + a value, so
// prose like "the key to success" is never redacted.
const REDACTION_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|password|secret|key|token|credential)\s*[:=]\s*\S+/gi;

/**
 * Recursively redact literal secret values from EVERY string reachable in a value — top-level
 * strings, array elements, and nested-object strings — leaving non-strings, numbers, null, and
 * structure intact. This is the single guarantee that no returned RAG field at ANY fidelity tier
 * can echo a credential (the scrub previously covered only `text`/`preview`). Idempotent: a value
 * already containing `[REDACTED]` is unchanged. Safe on `path`/`id`: a real file path never matches
 * REDACTION_PATTERN, so the downstream stale-file existence filter is unaffected.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function scrubSecrets(value) {
  if (typeof value === "string") return value.replace(REDACTION_PATTERN, "[REDACTED]");
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v);
    return out;
  }
  if (value && typeof value === "object") {
    // backlog.fix.rag-query-arrow-tags-serialization — DROP, do not enumerate and do not pass
    // through. The old generic-object branch ran Object.entries() over any class instance, which is
    // what materialized an Arrow Vector's private internals into the emitted payload. Passing such a
    // value through untouched is not the fix either: JSON.stringify would enumerate the same own
    // enumerable props at the transport boundary, AND any secret string it carries would arrive
    // unscrubbed — closing the enumeration hole by opening a scrub bypass. A non-plain instance has
    // no legitimate place in a RAG result: every column is decoded at the read boundary before it
    // gets here, so reaching this branch means something escaped that contract.
    return null;
  }
  return value;
}

/**
 * Apply fidelity filter to a single RAG result.
 * @param {Object} result - RAG match with text, path, score, source_class
 * @param {number} fidelity - Requested fidelity level (0-3)
 * @returns {Object} Filtered result
 */
export function applyFidelity(result, fidelity = FIDELITY_LEVELS.L2_REDACTED) {
  const { text, path, score, source_class, id, ...rest } = result;

  // Every tier routes its returned object through scrubSecrets(), so NO field — content, preview,
  // summary, or any ...rest metadata / array element — can echo a literal credential. This is the
  // single, deep enforcement point for the "secrets never appear at any tier" invariant.

  // L0: Metadata only
  if (fidelity === FIDELITY_LEVELS.L0_METADATA) {
    return scrubSecrets({
      id,
      path,
      score,
      source_class,
      fidelity: 'L0',
      // No text content at all
      text: null,
      preview: null,
      ...rest
    });
  }

  // L1: Abstracted (placeholder - full implementation needs LLM call)
  if (fidelity === FIDELITY_LEVELS.L1_ABSTRACTED) {
    return scrubSecrets({
      id,
      path,
      score,
      source_class,
      fidelity: 'L1',
      text: null,
      // For now, just use a generic description. Full impl needs summarization.
      summary: `Content from ${path} (${source_class} source, ${(text || '').length} chars)`,
      ...rest
    });
  }

  // L2: Redacted preview (length-capped; scrubSecrets applies the secret scrub across all fields)
  if (fidelity === FIDELITY_LEVELS.L2_REDACTED) {
    let preview = (text || '').slice(0, REDACTED_PREVIEW_LENGTH);
    if ((text || '').length > REDACTED_PREVIEW_LENGTH) {
      preview += '...';
    }
    return scrubSecrets({
      id,
      path,
      score,
      source_class,
      fidelity: 'L2',
      text: null,
      preview,
      fullLength: (text || '').length,
      ...rest
    });
  }

  // L3: Full CONTENT fidelity over an owned corpus — scrubSecrets still removes any literal
  // credential from text AND every other returned field.
  return scrubSecrets({
    id,
    path,
    score,
    source_class,
    fidelity: 'L3',
    text,
    ...rest
  });
}

/**
 * Determine effective fidelity level for a source class.
 * @param {string} source_class - Source classification
 * @param {number} requested - Requested fidelity level
 * @param {Object} overrides - Optional per-class overrides from capability token
 * @returns {number} Effective fidelity level (may be lower than requested)
 */
export function getEffectiveFidelity(source_class, requested, overrides = {}) {
  // Check for explicit override
  if (overrides[source_class] !== undefined) {
    return Math.min(requested, overrides[source_class]);
  }
  // Use default ceiling for source class
  const ceiling = DEFAULT_FIDELITY[source_class] ?? FIDELITY_LEVELS.L2_REDACTED;
  return Math.min(requested, ceiling);
}

/**
 * Filter an array of RAG results by fidelity.
 * @param {Array} results - Array of RAG matches
 * @param {number} fidelity - Requested fidelity level
 * @param {Object} options - { overrides, telemetryFn }
 * @returns {Array} Filtered results
 */
export function filterByFidelity(results, fidelity = FIDELITY_LEVELS.L2_REDACTED, options = {}) {
  const { overrides = {}, telemetryFn } = options;

  return results.map(result => {
    const effectiveFidelity = getEffectiveFidelity(
      result.source_class || 'project',
      fidelity,
      overrides
    );

    // Emit telemetry if provided
    if (telemetryFn && effectiveFidelity < fidelity) {
      telemetryFn('rag.fidelity.degraded', {
        path: result.path,
        requested: fidelity,
        effective: effectiveFidelity,
        source_class: result.source_class
      });
    }

    return applyFidelity(result, effectiveFidelity);
  });
}

export default { FIDELITY_LEVELS, DEFAULT_FIDELITY, applyFidelity, getEffectiveFidelity, filterByFidelity };
