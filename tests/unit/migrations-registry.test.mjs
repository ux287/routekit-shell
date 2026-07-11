/**
 * Tests for the migrations registry contract at
 * packages/cli/src/project/migrations/index.mjs.
 *
 * Registry invariants:
 *   - `migrations` is a named export, an Array.
 *   - Each entry shape: { fromVersion: number, toVersion: number, apply: function }
 *   - Entries are contiguous and ascending: toVersion === fromVersion + 1.
 *   - First migration (when one exists) must be { fromVersion: 1, toVersion: 2 }
 *     (no synthetic 0→1).
 */
import { describe, it, expect } from 'vitest';
import { migrations } from '../../packages/cli/src/project/migrations/index.mjs';

describe('migrations registry — contract', () => {
  it('exports `migrations` as an Array', () => {
    expect(Array.isArray(migrations)).toBe(true);
  });

  it('every entry has the shape { fromVersion, toVersion, apply }', () => {
    for (const m of migrations) {
      expect(typeof m.fromVersion).toBe('number');
      expect(typeof m.toVersion).toBe('number');
      expect(typeof m.apply).toBe('function');
    }
  });

  it('toVersion === fromVersion + 1 for every entry (no leaps)', () => {
    for (const m of migrations) {
      expect(m.toVersion).toBe(m.fromVersion + 1);
    }
  });

  it('entries are contiguous and ascending (no gaps)', () => {
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].fromVersion).toBe(migrations[i - 1].toVersion);
    }
  });

  it('when at least one migration exists, the first entry is { fromVersion: 1, toVersion: 2 } (baseline=1, no synthetic 0→1)', () => {
    if (migrations.length === 0) {
      // No migrations yet — contract is satisfied vacuously.
      return;
    }
    expect(migrations[0].fromVersion).toBe(1);
    expect(migrations[0].toVersion).toBe(2);
  });
});
