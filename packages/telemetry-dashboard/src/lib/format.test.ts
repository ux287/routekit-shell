import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatLocalDatetime } from './format';

describe('formatLocalDatetime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats a UTC ISO timestamp using the detected timezone', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ timeZone: 'America/New_York' }),
    } as Intl.DateTimeFormat);

    const result = formatLocalDatetime('2024-06-15T14:00:00.000Z');
    // In America/New_York, 14:00 UTC = 10:00 AM EDT
    expect(result).toContain('2024');
    expect(result).toContain('10');
  });

  it('uses the timezone reported by Intl.DateTimeFormat', () => {
    const nyFormat = { resolvedOptions: () => ({ timeZone: 'America/New_York' }) } as Intl.DateTimeFormat;
    const laFormat = { resolvedOptions: () => ({ timeZone: 'America/Los_Angeles' }) } as Intl.DateTimeFormat;

    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValueOnce(nyFormat);
    const nyResult = formatLocalDatetime('2024-06-15T20:00:00.000Z');

    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValueOnce(laFormat);
    const laResult = formatLocalDatetime('2024-06-15T20:00:00.000Z');

    // Both format the same timestamp but in different zones — should differ
    expect(nyResult).not.toBe(laResult);
  });

  it('returns a non-empty string for a valid ISO timestamp', () => {
    const result = formatLocalDatetime('2024-01-01T00:00:00.000Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not hardcode a timezone — reads from Intl.DateTimeFormat', () => {
    const calls: string[] = [];
    const mockFormat = {
      resolvedOptions: () => {
        calls.push('resolvedOptions');
        return { timeZone: 'Europe/London' };
      },
    } as Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue(mockFormat);

    formatLocalDatetime('2024-03-10T12:00:00.000Z');
    expect(calls).toContain('resolvedOptions');
  });
});
