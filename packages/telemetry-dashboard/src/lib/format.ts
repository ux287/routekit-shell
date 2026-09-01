/**
 * Format a UTC ISO timestamp string using the browser's local timezone.
 * Uses Intl.DateTimeFormat to detect the timezone — no hardcoded strings.
 */
export function formatLocalDatetime(ts: string): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date(ts).toLocaleString(undefined, { timeZone: timezone });
}
