/**
 * Ordered registry of project.json schema migrations.
 *
 * Each entry: { fromVersion: number, toVersion: number, apply: (meta) => meta }
 *
 * Contract:
 *   - Entries are sorted ascending by fromVersion.
 *   - toVersion === fromVersion + 1 (no leaps).
 *   - apply() is pure: takes the current metadata shape, returns the migrated
 *     shape. It must NOT touch disk — migrate-config.mjs orchestrates the
 *     load → walk → save sequence.
 *
 * Baseline: the canonical SCHEMA_VERSION in metadata.js is 1. Absent
 * schemaVersion is treated as 1 (the current state IS the baseline). The
 * first real migration added here will be { fromVersion: 1, toVersion: 2 }.
 */
export const migrations = [
  // Add migrations here in ascending fromVersion order, e.g.:
  // {
  //   fromVersion: 1,
  //   toVersion: 2,
  //   apply: (meta) => ({ ...meta, newField: 'default' }),
  // },
];
