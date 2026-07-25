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
const REDACTION_PATTERN = /\b(?:password|secret|key|token|credential)\s*[:=]\s*\S+/gi;

/**
 * Apply fidelity filter to a single RAG result.
 * @param {Object} result - RAG match with text, path, score, source_class
 * @param {number} fidelity - Requested fidelity level (0-3)
 * @returns {Object} Filtered result
 */
export function applyFidelity(result, fidelity = FIDELITY_LEVELS.L2_REDACTED) {
  const { text, path, score, source_class, id, ...rest } = result;

  // L0: Metadata only
  if (fidelity === FIDELITY_LEVELS.L0_METADATA) {
    return {
      id,
      path,
      score,
      source_class,
      fidelity: 'L0',
      // No text content at all
      text: null,
      preview: null,
      ...rest
    };
  }

  // L1: Abstracted (placeholder - full implementation needs LLM call)
  if (fidelity === FIDELITY_LEVELS.L1_ABSTRACTED) {
    return {
      id,
      path,
      score,
      source_class,
      fidelity: 'L1',
      text: null,
      // For now, just use a generic description. Full impl needs summarization.
      summary: `Content from ${path} (${source_class} source, ${(text || '').length} chars)`,
      ...rest
    };
  }

  // L2: Redacted preview
  if (fidelity === FIDELITY_LEVELS.L2_REDACTED) {
    let preview = (text || '').slice(0, REDACTED_PREVIEW_LENGTH);
    // Apply redaction patterns
    preview = preview.replace(REDACTION_PATTERN, '[REDACTED]');
    if ((text || '').length > REDACTED_PREVIEW_LENGTH) {
      preview += '...';
    }
    return {
      id,
      path,
      score,
      source_class,
      fidelity: 'L2',
      text: null,
      preview,
      fullLength: (text || '').length,
      ...rest
    };
  }

  // L3: Full text
  return {
    id,
    path,
    score,
    source_class,
    fidelity: 'L3',
    text,
    ...rest
  };
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
