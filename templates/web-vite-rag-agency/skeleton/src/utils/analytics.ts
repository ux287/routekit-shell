export function track(event: string, payload: Record<string, unknown> = {}) {
  if (import.meta.env.DEV) {
    console.log(`[analytics] ${event}`, payload);
  }
}
